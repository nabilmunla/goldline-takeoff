// Daily backups of every project, and of the accounts.
//
// Each project's backups live in a folder of their own, next to the projects of its kind:
//
//   <root>\_backups\<project folder>__<project id>\
//       about.json              name, id, kind, where the project is, the last backup (small: the list reads it)
//       2026-10-25.json.gz      the whole project on that day (values only, ~ a tenth of the journals)
//
//   <team folder>\_backups\_accounts\   the accounts folder, the same way
//
// An administrator can put them elsewhere (v0.13, People › Where things are kept): one folder for
// the take-offs' and the accounts' backups (QS PCs write those, so in a split setup it must be a
// folder they can reach). The backups then go straight
// into that folder (`base`), with the same folders inside.
//
// One file per day: written when the project is opened (if there is none for today yet), every
// couple of hours while it is open and changing, and when it is closed after a change. Whoever has
// the project open writes it, so a project several people work in is backed up by whoever closes
// it last. Kept: every day of the last two weeks, one a week for two months, one a month for a year.
//
// A backup is never put back over a project: it is restored as a new project (nothing is lost,
// whatever went wrong), which an administrator can then share.
import { gzip, gzipSync, gunzipSync, strToU8, strFromU8 } from 'fflate';
import { randomId, safeName } from './ids';
import { crc32hex } from './crc32';
import { Store } from './store';
import { isPurged } from './boq';
import { accountsDir, appendOneOff, isGuarded, loadAccountStore } from './accounts';
import type { FsApi, Op, ProjectMeta, Value } from './types';
import { entsToOps } from './codec';
import { FORMAT, normFormat, formatFor } from './legacy';

export type BackupKind = 'qto' | 'accounts';

/** the engine's FsApi plus whole-file bytes (gt().files in the app, nodefs in tests) */
export interface BackupFs extends FsApi {
  readBytes(path: string): Promise<Uint8Array | null>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  /** size and modified time (the time the shared folder stamped on it) */
  stat?(path: string): Promise<{ mtime: number } | null>;
}

export interface BackupFile {
  format: string;
  v: 1;
  kind: BackupKind;
  projectId: string;
  projectName: string;
  /** the project's folder name and full path when this was written */
  folder: string;
  dir: string;
  day: string;
  at: number;
  by: string;
  host: string;
  app: string;
  /** newest change in it (the same stamp means nothing changed) */
  top: string;
  ents: [string, [string, Value][]][];
  /**
   * accounts only: every change as it was made (who, when) - restoring keeps who was an
   * administrator when, so earlier "removed for good" stay removed
   */
  lines?: string[];
  /** a backup made by hand: what it was made for ("Before rolling back to 2026-11-02") */
  note?: string;
}

export interface BackupAbout {
  kind: BackupKind;
  projectId: string;
  projectName: string;
  folder: string;
  dir: string;
  lastDay: string;
  lastAt: number;
  lastBy: string;
}

export interface BackupDay {
  /** the day (YYYY-MM-DD); a backup made by hand: the day and time (YYYY-MM-DD HH:MM:SS) */
  day: string;
  file: string;
  /** made by hand (Back up now, or before a roll back): never removed by the daily clean-up */
  manual?: boolean;
}

export interface BackupSet {
  /** folder of this project's backups */
  dir: string;
  /** every folder its days are in (the backups folder was changed and not all were moved) */
  dirs?: string[];
  about: BackupAbout | null;
  days: BackupDay[];
}

export const BACKUPS = '_backups';
export const ACCOUNTS_BACKUP = '_accounts';
export const backupsRoot = (fs: FsApi, root: string, base?: string | null) => (base ? base : fs.join(root, BACKUPS));
/**
 * <folder>__<id>__<hash of the full folder name>: a project copied in Explorer has the same id and
 * (its first 40 characters) the same name - it must not share the original's backups
 */
export const backupDirOf = (fs: FsApi, root: string, kind: BackupKind, folder: string, id: string, base?: string | null) =>
  fs.join(backupsRoot(fs, root, base), kind === 'accounts' ? ACCOUNTS_BACKUP : safeName(folder) + '__' + safeName(id) + '__' + crc32hex(folder.toLowerCase()).slice(0, 6));
const dayNum = (d: string) => Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000);

const pad = (n: number) => String(n).padStart(2, '0');
/** this PC's date: a backup belongs to the day people worked on it */
export const dayOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json\.gz$/;
/** a backup made by hand: m-2026-11-18-142530.json.gz */
const MANUAL_FILE = /^m-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})\.json\.gz$/;
/** how many hand-made backups a project keeps (the oldest go first) */
export const MANUAL_KEEP = 40;
type PurgeCheck = (username: string, stamp: string) => boolean;

/** the whole project as it stands (values only); a purge counts only if an administrator made it */
/** `like`: the project's own project.json - a backup of a project the earlier version made (or made in a team folder
 *  of that version) carries that version's format id, so a PC gone back to it can still restore it (legacy.ts) */
export function makeBackup(store: Store, info: Omit<BackupFile, 'format' | 'v' | 'ents' | 'top' | 'day'>, admins?: PurgeCheck, like?: { format?: unknown } | null): BackupFile {
  const ents: BackupFile['ents'] = [];
  for (const [id, ent] of store.ents) {
    const fields: [string, Value][] = [];
    for (const [f, c] of ent) {
      if (c.v === null || c.v === undefined) continue;
      // a purge counts only when an administrator did it (as on the screen)
      if (f === 'purged' && admins && !(c.a && admins(c.a, c.s))) continue;
      fields.push([f, c.v]);
    }
    if (fields.length) ents.push([id, fields]);
  }
  return { format: formatFor(FORMAT.backup, like), v: 1, ...info, day: dayOf(info.at), top: store.top, ents };
}

export const encodeBackup = (b: BackupFile) => gzipSync(strToU8(JSON.stringify(b)), { level: 6 });
/** the same, packed off the window's thread where it can be (a big project takes a few tenths of a second) */
export const encodeBackupAsync = (b: BackupFile): Promise<Uint8Array> => {
  const data = strToU8(JSON.stringify(b));
  return new Promise<Uint8Array>((res) => {
    try {
      gzip(data, { level: 6 }, (err, out) => res(err || !out ? gzipSync(data, { level: 6 }) : out));
    } catch {
      res(gzipSync(data, { level: 6 }));
    }
  });
};

export function decodeBackup(bytes: Uint8Array): BackupFile {
  const b = JSON.parse(strFromU8(gunzipSync(bytes))) as BackupFile;
  if (!b || typeof b !== 'object' || normFormat(b.format) !== FORMAT.backup || !Array.isArray(b.ents)) throw new Error('This is not a Goldline Takeoff backup file.');
  // every entry [id, [[field, value], ...]]: a damaged one is said here, not as an error deep in a restore
  const ok = (e: unknown) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && Array.isArray(e[1])
    && e[1].every((f: unknown) => Array.isArray(f) && f.length === 2 && typeof f[0] === 'string');
  if (!b.ents.every(ok)) throw new Error('This backup file is damaged (some of its entries can\'t be read): choose another day.');
  return b;
}

export function storeFromBackup(b: BackupFile): Store {
  const st = new Store();
  const ops: Op[] = [];
  ops.push(...entsToOps(b.ents));
  // accounts kept without their journal lines (an earlier version's backups): the snapshot is put back as made by
  // its first administrator, so who is an administrator counts again - it was nobody, and the right
  // administrator's name and password were refused (0.23.2, DeepSeek #1)
  const a = b.kind === 'accounts' && !b.lines?.length ? restoreAuthor(b.ents) : '';
  st.apply({ s: '0000000000000-0000-backup', w: 'backup', u: b.by, t: b.at, o: ops, ...(a ? { a } : {}) });
  return st;
}

/** the first active administrator in an accounts backup's entries ('' if none) */
function restoreAuthor(ents: BackupFile['ents']): string {
  for (const [id, fields] of ents) {
    if (!id.startsWith('user:')) continue;
    const f = new Map(fields as [string, Value][]);
    if (f.get('role') === 'admin' && f.get('active') !== false) return id.slice(5);
  }
  return '';
}

/**
 * Which day files to keep: every day of the last 14, the newest of each week for 8 weeks, the newest
 * of each month for 12 months, and always the newest of all.
 */
export function keepDays(days: string[], today: string): Set<string> {
  const n = dayNum;
  const t = n(today);
  const sorted = [...new Set(days)].sort().reverse();
  const keep = new Set<string>();
  if (sorted.length) keep.add(sorted[0]);
  const weeks = new Set<number>();
  const months = new Set<string>();
  for (const d of sorted) {
    const age = t - n(d);
    if (age < 14) keep.add(d);
    const wk = Math.floor((n(d) + 3) / 7); // weeks from Monday to Sunday
    if (age < 7 * 8 && !weeks.has(wk)) { weeks.add(wk); keep.add(d); }
    const mo = d.slice(0, 7);
    if (age < 366 && !months.has(mo)) { months.add(mo); keep.add(d); }
  }
  return keep;
}

export async function listBackupDays(fs: FsApi, dir: string, o: { manual?: boolean } = {}): Promise<BackupDay[]> {
  const out: BackupDay[] = [];
  for (const e of await fs.list(dir)) {
    if (e.isDir) continue;
    const m = DAY_FILE.exec(e.name);
    if (m) { out.push({ day: m[1], file: fs.join(dir, e.name) }); continue; }
    const h = o.manual && MANUAL_FILE.exec(e.name);
    if (h) out.push({ day: `${h[1]} ${h[2]}:${h[3]}:${h[4]}`, file: fs.join(dir, e.name), manual: true });
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : -1));
}

export interface WriteBackupOpts {
  fs: BackupFs;
  /** the root the project belongs to (estimation folder, take-off folder, team folder) */
  root: string;
  /** the backups folder an administrator chose (else <root>\_backups) */
  base?: string | null;
  kind: BackupKind;
  projectDir: string;
  folder: string;
  projectId: string;
  projectName: string;
  store: Store;
  by: string;
  host: string;
  app: string;
  admins?: PurgeCheck;
  now?: number;
  /** drop old days (once a day is enough) */
  prune?: boolean;
  /** accounts: the journal lines as they are (see BackupFile.lines) */
  lines?: string[];
  /** the project's own project.json (its format id says how the backup's is written: makeBackup) */
  like?: { format?: unknown } | null;
}

/**
 * What a PC's date allows, when the shared folder's own clock can't be asked (see writeBackup): a
 * PC whose date is before the newest backup never writes (it would overwrite a real earlier day);
 * old days are only removed when the date looks right (not months past the newest backup: a PC
 * with its clock a year ahead must not wipe the history). Files dated more than a day ahead are
 * never counted as the newest; no file dated after today is ever removed.
 */
export function clockCheck(days: string[], today: string): { write: boolean; prune: boolean; why?: string } {
  const t = dayNum(today);
  const valid = days.filter((d) => dayNum(d) <= t + 1).sort();
  const newest = valid[valid.length - 1];
  if (newest && dayNum(newest) > t) return { write: false, prune: false, why: `this PC's date (${today}) is before the newest backup (${newest})` };
  if (newest && t - dayNum(newest) > 62) return { write: true, prune: false, why: `the newest backup is ${t - dayNum(newest)} days old: no old ones removed today` };
  return { write: true, prune: true };
}

/**
 * this PC's clock minus the shared folder's (ms), from the time the folder stamps on a small file
 * written now; null when that can't be told (no stat, the file couldn't be written)
 */
export async function clockSkew(fs: BackupFs, dir: string): Promise<number | null> {
  if (!fs.stat) return null;
  const p = fs.join(dir, 'clock.txt');
  try {
    const before = Date.now();
    await fs.writeAtomic(p, new Date(before).toISOString());
    const st = await fs.stat(p);
    const after = Date.now();
    if (!st || !Number.isFinite(st.mtime)) return null;
    // the folder stamped it between before and after (as this PC counts)
    if (st.mtime < before - 1000) return before - st.mtime;
    if (st.mtime > after + 1000) return after - st.mtime;
    return 0;
  } catch {
    return null;
  }
}

/** write today's backup of a project (replaces an earlier one of today) */
export async function writeBackup(o: WriteBackupOpts): Promise<{ file: string; bytes: number; pruned: number; skew: number | null }> {
  const fs = o.fs;
  const dir = backupDirOf(fs, o.root, o.kind, o.folder, o.projectId, o.base);
  // never make the shared folder itself again where it has gone (a dropped drive, a moved folder) -
  // nor a backups folder an administrator chose
  if (o.base ? !(await fs.exists(o.base)) : !(await fs.exists(o.root))) throw new Error(`not written: the ${o.base ? 'backups' : 'shared'} folder is not reachable`);
  await fs.mkdirp(dir);
  // the day a backup belongs to comes from the shared folder's clock (the time it stamps on a file
  // written now): the same for every PC, also one whose own clock is days off
  const skew = await clockSkew(fs, dir);
  const at = (o.now ?? Date.now()) - (skew !== null && Math.abs(skew) > 60_000 ? skew : 0);
  const existing = await listBackupDays(fs, dir);
  const clock = clockCheck(existing.map((d) => d.day), dayOf(at));
  if (!clock.write) throw new Error('not written: ' + clock.why);
  const b = makeBackup(o.store, { kind: o.kind, projectId: o.projectId, projectName: o.projectName, folder: o.folder, dir: o.projectDir, at, by: o.by, host: o.host, app: o.app }, o.admins, o.like);
  if (o.lines?.length) b.lines = o.lines;
  const bytes = await encodeBackupAsync(b);
  const file = fs.join(dir, b.day + '.json.gz');
  await fs.writeBytes(file, bytes);
  const about: BackupAbout = { kind: o.kind, projectId: o.projectId, projectName: o.projectName, folder: o.folder, dir: o.projectDir, lastDay: b.day, lastAt: at, lastBy: o.by };
  await fs.writeAtomic(fs.join(dir, 'about.json'), JSON.stringify(about, null, 1));
  let pruned = 0;
  if (o.prune && clock.prune) {
    const days = await listBackupDays(fs, dir);
    const t = dayNum(b.day);
    const keep = keepDays(days.map((d) => d.day).filter((d) => dayNum(d) <= t), b.day);
    for (const d of days) {
      if (keep.has(d.day) || dayNum(d.day) > t) continue;
      await fs.remove(d.file).catch(() => {});
      pruned++;
    }
  }
  return { file, bytes: bytes.length, pruned, skew };
}

/**
 * A backup made by hand (Back up now, and the one made before a roll back): its own file with the time in its
 * name, so the daily backup never replaces it; the daily clean-up leaves it alone. The last MANUAL_KEEP are kept.
 */
export async function writeManualBackup(o: WriteBackupOpts & { note?: string }): Promise<{ file: string; bytes: number }> {
  const fs = o.fs;
  const dir = backupDirOf(fs, o.root, o.kind, o.folder, o.projectId, o.base);
  if (o.base ? !(await fs.exists(o.base)) : !(await fs.exists(o.root))) throw new Error(`not written: the ${o.base ? 'backups' : 'shared'} folder is not reachable`);
  await fs.mkdirp(dir);
  const skew = await clockSkew(fs, dir);
  const at = (o.now ?? Date.now()) - (skew !== null && Math.abs(skew) > 60_000 ? skew : 0);
  const b = makeBackup(o.store, { kind: o.kind, projectId: o.projectId, projectName: o.projectName, folder: o.folder, dir: o.projectDir, at, by: o.by, host: o.host, app: o.app }, o.admins, o.like);
  if (o.note) b.note = o.note;
  if (o.lines?.length) b.lines = o.lines;
  const bytes = await encodeBackupAsync(b);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const nameAt = (t: number) => { const d = new Date(t); return `m-${dayOf(t)}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.json.gz`; };
  // two in the same second: the next free second (the name is the time). The name is claimed first - whoever's
  // mark is first in its claim file has it, and looks again that it is still free: two PCs at the same second both
  // took it and the second replaced the first (0.23.2, DeepSeek #20)
  const mark = randomId(10);
  let t = at, claim = '';
  for (let k = 0; k < 120; k++, t += 1000) {
    const name = nameAt(t);
    if (await fs.exists(fs.join(dir, name))) continue;
    const c = fs.join(dir, '.claim-' + name);
    try {
      await fs.append(c, mark + '\n');
      if (((await fs.readText(c)) ?? '').split('\n')[0] !== mark) continue;
    } catch { break; } // (a folder that takes no claim file: as before)
    if (await fs.exists(fs.join(dir, name))) { await fs.remove(c).catch(() => {}); continue; }
    claim = c;
    break;
  }
  const file = fs.join(dir, nameAt(t));
  try { await fs.writeBytes(file, bytes); } finally { if (claim) await fs.remove(claim).catch(() => {}); }
  const about: BackupAbout = { kind: o.kind, projectId: o.projectId, projectName: o.projectName, folder: o.folder, dir: o.projectDir, lastDay: b.day, lastAt: at, lastBy: o.by };
  await fs.writeAtomic(fs.join(dir, 'about.json'), JSON.stringify(about, null, 1));
  const manual = (await listBackupDays(fs, dir, { manual: true })).filter((x) => x.manual);
  for (const x of manual.slice(MANUAL_KEEP)) await fs.remove(x.file).catch(() => {});
  return { file, bytes: bytes.length };
}

/** fields a roll back leaves as they are: the data format marks and the BOQ the take-off pulls from */
const KEEP_ON_ROLLBACK = new Set(['project\u0000fmt', 'project\u0000fmtBy', 'project\u0000hub', 'project\u0000hubName', 'project\u0000brev', 'project\u0000rev', 'project\u0000creator']);

/**
 * A project taken back to a backup, as ONE change on top of what is there (nothing is rewritten or removed
 * from the journals: the roll back itself can be undone, and every later change is still in the history).
 * Values that differ come back; what was added since is deleted (`del`) and its fields emptied.
 * `skip`: entity id prefixes left alone (a take-off on a BOQ hub: its `b:` copy comes from the hub).
 */
export function rollbackOps(current: Store, b: BackupFile, o: { skip?: string[] } = {}): Op[] {
  const target = storeFromBackup(b);
  const skipped = (id: string) => (o.skip ?? []).some((p) => id.startsWith(p));
  const ops: Op[] = [];
  for (const [id, ent] of target.ents) {
    if (skipped(id)) continue;
    for (const [f, c] of ent) {
      if (KEEP_ON_ROLLBACK.has(id + '\u0000' + f)) continue;
      if ((current.get(id, f) ?? null) !== (c.v ?? null)) ops.push([id, f, c.v]);
    }
    const cur = current.ents.get(id);
    if (cur) for (const f of cur.keys()) if (!ent.has(f) && !KEEP_ON_ROLLBACK.has(id + '\u0000' + f) && (cur.get(f)?.v ?? null) !== null) ops.push([id, f, null]);
  }
  for (const [id, ent] of current.ents) {
    if (target.ents.has(id) || skipped(id) || id === 'project') continue;
    let any = false;
    for (const [f, c] of ent) if (f !== 'del' && (c.v ?? null) !== null) { ops.push([id, f, null]); any = true; }
    if (any || ent.get('del')?.v !== true) ops.push([id, 'del', true]);
  }
  ops.push(['project', 'rolledBack', `${b.day}`]);
  return ops;
}

/** every project's backups under a root (projects that are gone included) */
export async function listBackups(fs: FsApi, root: string, chosen?: string | null): Promise<BackupSet[]> {
  const base = backupsRoot(fs, root, chosen);
  const out: BackupSet[] = [];
  for (const e of await fs.list(base)) {
    if (!e.isDir) continue;
    const dir = fs.join(base, e.name);
    let about: BackupAbout | null = null;
    try { about = JSON.parse((await fs.readText(fs.join(dir, 'about.json'))) ?? 'null'); } catch { about = null; }
    const days = await listBackupDays(fs, dir, { manual: true });
    if (days.length) out.push({ dir, about, days });
  }
  out.sort((a, b) => (b.about?.lastAt ?? 0) - (a.about?.lastAt ?? 0));
  return out;
}

/**
 * The backups of the same projects found in several backups folders (the chosen one first, then
 * the usual one), as one list: a day in the first folder wins over the same day in a later one.
 */
export function mergeBackupSets(lists: BackupSet[][]): BackupSet[] {
  const key = (s: BackupSet) => s.dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop()!.toLowerCase();
  const by = new Map<string, BackupSet>();
  for (const list of lists) {
    for (const s of list) {
      const k = key(s);
      const cur = by.get(k);
      if (!cur) { by.set(k, { ...s, dirs: [s.dir] }); continue; }
      const have = new Set(cur.days.map((d) => d.day));
      cur.days = [...cur.days, ...s.days.filter((d) => !have.has(d.day))].sort((a, b) => (a.day < b.day ? 1 : -1));
      cur.dirs!.push(s.dir);
      if ((s.about?.lastAt ?? 0) > (cur.about?.lastAt ?? 0)) cur.about = s.about;
    }
  }
  return [...by.values()].sort((a, b) => (b.about?.lastAt ?? 0) - (a.about?.lastAt ?? 0));
}

export async function readBackup(fs: BackupFs, file: string): Promise<BackupFile> {
  const bytes = await fs.readBytes(file);
  if (!bytes) throw new Error('The backup file is missing.');
  return decodeBackup(bytes);
}

/**
 * Everything needed to start a new project as a copy: all its values, except rows removed for good
 * (and what was under a removed heading: those would come back as unfiled rows) and the project's
 * name and its old link to an estimate.
 */
function copyOps(src: Store): Op[] {
  const ops: Op[] = [];
  const hi = { fmt: 0, stamp: '', by: null as string | null };
  for (const h of src.hist.get('project') ?? []) if (h.f === 'fmt' && typeof h.v === 'number' && h.v > hi.fmt) { hi.fmt = h.v; hi.stamp = h.s; }
  for (const h of src.hist.get('project') ?? []) if (h.f === 'fmtBy' && h.s === hi.stamp && typeof h.v === 'string') hi.by = h.v;
  const gone = new Map<string, boolean>();
  const underPurged = (id: string, guard = 0): boolean => {
    const k = gone.get(id);
    if (k !== undefined) return k;
    const p = src.get(id, 'parent');
    const g = isPurged(src, id) || (typeof p === 'string' && guard < 64 && src.ents.has(p) ? underPurged(p, guard + 1) : false);
    gone.set(id, g);
    return g;
  };
  for (const [id, ent] of src.ents) {
    if (underPurged(id)) continue;
    for (const [f, c] of ent) {
      if (c.v === null || c.v === undefined || f === 'purged') continue;
      // (a copy is a project of its own: not in the old estimate's group, not on the original's BOQ hub - its BOQ copy
      //  stays, and an administrator can make it updatable on its own)
      if (id === 'project' && (f === 'name' || f === 'est' || f === 'estName' || f === 'hub' || f === 'hubName' || f === 'brev')) continue;
      // the highest data-format mark the source ever had counts, not the cell's last value (a later,
      // lower mark from an offline PC must not open the copy to an older app)
      if (id === 'project' && (f === 'fmt' || f === 'fmtBy') && hi.stamp) {
        ops.push([id, f, f === 'fmt' ? hi.fmt : hi.by ?? c.v]);
        continue;
      }
      ops.push([id, f, c.v]);
    }
  }
  return ops;
}

/** Ops that start a new project from a backup: everything in it, not its take-off links or the link to an estimate. */
export function restoreOps(b: BackupFile): Op[] {
  const store = storeFromBackup(b);
  const ops = copyOps(store);
  ops.push(['project', 'restoredFrom', `${b.projectName} · backup of ${b.day}`]);
  return ops;
}

/**
 * The accounts folder made again from a backup (when it is missing: a shared folder with projects
 * but no accounts). Everything comes back as it was on that day: people, passwords, access, folders.
 */
export async function restoreAccounts(fs: FsApi, dataRoot: string, host: string, b: BackupFile, by: string): Promise<void> {
  if (b.kind !== 'accounts') throw new Error('This backup is not of the accounts.');
  // refused only when there are accounts to sign in to: an accounts folder whose project.json is
  // still there but whose changes are gone (journals deleted, quarantined, half restored) holds
  // nobody - that is exactly when a backup is needed (BH-007)
  const cur = await loadAccountStore(fs, dataRoot);
  if (cur.exists && cur.store.top) throw new Error('The accounts are there already: sign in instead.');
  const dir = accountsDir(fs, dataRoot);
  await fs.mkdirp(fs.join(dir, 'journals'));
  await fs.mkdirp(fs.join(dir, 'presence'));
  if (b.lines?.length) {
    // every change as it was made (same stamps, same authors): who was an administrator when stays known
    await fs.append(fs.join(dir, 'journals', 'j_restored_' + Date.now().toString(36) + '_' + randomId(4) + '.log'), b.lines.join(''));
  } else {
    // (written as made by the backup's first administrator, the changes only administrators may make first: they
    // all land in the first change, which makes that person an administrator again - DeepSeek #1)
    const all = entsToOps(b.ents);
    const author = restoreAuthor(b.ents) || 'restore';
    const rank = (o: Op) => (o[0] === 'user:' + author ? 0 : isGuarded(o[0], o[1]) ? 1 : 2);
    const ops: Op[] = all.map((o, i) => [o, i] as const).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map((x) => x[0]);
    for (let k = 0; k < ops.length; k += 4000) await appendOneOff(fs, dir, by, author, host, ops.slice(k, k + 4000), `Accounts restored from the backup of ${b.day}`);
  }
  const meta: ProjectMeta = { format: formatFor(FORMAT.accounts, b), formatVersion: 1, id: b.projectId || 'accounts-' + randomId(8), name: 'Accounts', created: Date.now(), createdBy: 'restore' };
  if (!(await fs.exists(fs.join(dir, 'project.json')))) await fs.writeAtomic(fs.join(dir, 'project.json'), JSON.stringify(meta, null, 2));
}

/**
 * Keeps one open project backed up: today's file when it is opened (if there is none yet), again
 * every couple of hours while it changes, and when it is closed after a change. Never throws:
 * a backup that can't be written must not get in the way of the work (it says so in the log).
 */
export class BackupKeeper {
  private lastCount = -1;
  private lastDay = '';
  private lastAt = 0;
  private prunedDay = '';
  private busy: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  lastError: string | null = null;
  written = 0;

  constructor(private o: Omit<WriteBackupOpts, 'store' | 'now' | 'prune' | 'lines'> & {
    session: { store: Store; readOnly?: boolean; newerApp?: string | null; meta?: { format?: unknown } };
    /** the backups folder as it is now (an administrator may change it while the project is open) */
    baseOf?: () => string | null | undefined;
    /** accounts: the journal lines to keep as they are */
    lines?: () => Promise<string[]>;
    log?: (line: string) => void;
    now?: () => number;
    /** how often to look while open (ms) */
    every?: number;
  }) {}

  private now() { return this.o.now ? this.o.now() : Date.now(); }
  private base() { return this.o.baseOf ? this.o.baseOf() : this.o.base; }

  private skip() {
    // an older app doesn't write a project a newer one has changed - not even its backup; someone
    // who only looks at a project changes nothing (and may not be allowed to write next to it)
    return !!this.o.session.newerApp || !!this.o.session.readOnly || !this.o.session.store.top;
  }

  private write(why: string) {
    const run = async () => {
      if (this.skip()) return;
      const now = this.now();
      const day = dayOf(now);
      try {
        // the name it has now (it may have been renamed while open)
        const live = this.o.session.store.get('project', 'name');
        const projectName = typeof live === 'string' && live.trim() ? live : this.o.projectName;
        const count = this.o.session.store.batchCount;
        const lines = this.o.lines ? await this.o.lines() : undefined;
        const r = await writeBackup({ ...this.o, base: this.base(), projectName, store: this.o.session.store, now, prune: this.prunedDay !== day, lines, like: this.o.like ?? this.o.session.meta });
        this.prunedDay = day;
        this.lastCount = count;
        this.lastDay = day;
        this.lastAt = now;
        this.written++;
        this.lastError = null;
        this.o.log?.(`backup ${why}: ${r.file} (${Math.round(r.bytes / 1024)} KB${r.pruned ? ', ' + r.pruned + ' old removed' : ''}${r.skew && Math.abs(r.skew) > 60_000 ? `, this PC's clock is ${Math.round(r.skew / 60000)} min off the shared folder's` : ''})`);
      } catch (e: any) {
        this.lastError = String(e?.message ?? e);
        this.o.log?.(`backup ${why} failed: ${this.lastError}`);
      }
    };
    this.busy = this.busy.then(run, run);
    return this.busy;
  }

  /** after the project has opened */
  async opened() {
    if (this.skip()) return;
    const dir = backupDirOf(this.o.fs, this.o.root, this.o.kind, this.o.folder, this.o.projectId, this.base());
    const today = dayOf(this.now());
    const days = await listBackupDays(this.o.fs, dir).catch(() => []);
    // closed meanwhile: its own backup at close is the last word (sweep B 34)
    if (this.closed) return;
    if (days.some((d) => d.day === today)) {
      // there is one for today already: the next one only once something changes
      this.lastCount = this.o.session.store.batchCount;
      this.lastDay = today;
      this.lastAt = this.now();
    } else {
      await this.write('at open');
    }
    const every = this.o.every ?? 2 * 3600 * 1000;
    if (!this.closed) this.timer = setInterval(() => { void this.tick(); }, Math.min(every, 15 * 60 * 1000));
  }

  /** any change since the last backup - an old one arriving late from a PC that was offline too */
  private changed() {
    return this.o.session.store.batchCount !== this.lastCount;
  }

  /** while open: a new day, or changes and a while since the last one */
  async tick() {
    if (this.skip() || this.closed) return;
    const now = this.now();
    const every = this.o.every ?? 2 * 3600 * 1000;
    if (dayOf(now) !== this.lastDay && this.changed()) return this.write('new day');
    if (this.changed() && now - this.lastAt >= every) return this.write('while open');
  }

  /** when the project closes (after its last changes were sent); a second call waits for the first */
  async closing() {
    if (this.closed) return this.closed;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.closed = this.busy.then(() => (this.skip() || !this.changed() ? undefined : this.write('at close')));
    return this.closed;
  }
  private closed: Promise<unknown> | null = null;
}
