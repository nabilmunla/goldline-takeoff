// Moving things the team shares to another folder (v0.13), without anybody losing a change:
//
// - the backups (People › Where things are kept › Backups): each project's backup folder copied to
//   the new place, then removed from the old one once every file is there;
// - the team folder itself (the accounts, their backups, the newest release): copied to the new
//   folder, then the old accounts say where they went (cfg `movedTo`, set by an administrator, and
//   `_accounts\moved.json` for when the old accounts are cleared away later). Every PC follows by
//   itself: at sign-in, or while signed in (the accounts are watched every 3 s). The projects stay
//   where they are: the take-off folder is written down as it was.
//
// The journals are never overwritten nor appended to in place: what the new folder lacks (by the
// stamp of each change) is written as a new journal file. A change that arrives twice is the same
// change (the store ignores a stamp it has seen), so copying again is always safe.
import { decodeLine } from './codec';
import { randomId } from './ids';
import { Store } from './store';
import { ACCOUNTS_FOLDER, CFG, appendOneOff, loadAccountStore, trustedGet, type Roots } from './accounts';
import { ACCOUNTS_BACKUP, BACKUPS, type BackupFs, type BackupKind } from './backups';
import { cmpVersion } from './version';
import { FORMAT, normFormat, formatFor } from './legacy';
import type { FsApi, Op, PresenceInfo } from './types';

export const MOVED_FILE = 'moved.json';
export const RELEASES = '_releases';

/** what file copying needs (the app adds a fast copy for big files and removing empty folders) */
export interface CopyFs extends BackupFs {
  copy?(src: string, dst: string): Promise<void>;
  rmdir?(path: string): Promise<void>;
}

/** a path as Windows compares them: no trailing separator, any case, / and \ alike */
export const normPath = (p: string) => p.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
export const samePath = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && normPath(a) === normPath(b);
/** b is a or inside it */
export const inside = (b: string, a: string) => samePath(a, b) || normPath(b).startsWith(normPath(a) + '\\');

/** the folders a path sits in, nearest first (as written: S:\a\b -> S:\a, S:\; \\srv\share\a -> \\srv\share) */
export function parentsOf(p: string): string[] {
  const out: string[] = [];
  let cur = p.trim().replace(/[\\/]+$/, '');
  const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.exec(cur)?.[0];
  for (let i = 0; i < 64; i++) {
    const k = Math.max(cur.lastIndexOf('\\'), cur.lastIndexOf('/'));
    if (k < 0) break;
    let up = cur.slice(0, k);
    if (unc && up.length < unc.length) break;
    if (/^[A-Za-z]:$/.test(up)) up += '\\';
    if (up === '') up = cur[0] === '/' ? '/' : up;
    if (!up || up === cur) break;
    out.push(up);
    if (up === '/' || /^[A-Za-z]:\\$/.test(up)) break;
    cur = up.replace(/[\\/]+$/, '') || up;
  }
  return out;
}

/**
 * Whether two folders are one and the same, or one inside the other, ON THE DISK: one folder can be
 * reached by several spellings (S:\Team and \\server\share\Team, a drive letter IT remapped, DFS), so
 * comparing the text is not enough before removing anything. A marker file is written in `a` and
 * looked for at `b` and the folders above it (and the other way round). Null: unrelated (or `a`
 * isn't there - nothing to lose in it). Throws when no marker can be written in `a`.
 */
export async function onDisk(fs: FsApi, a: string, b: string): Promise<'same' | 'b-in-a' | 'a-in-b' | null> {
  if (samePath(a, b)) return 'same';
  if (inside(b, a)) return 'b-in-a';
  if (inside(a, b)) return 'a-in-b';
  if (!(await fs.exists(a).catch(() => false))) return null;
  const look = async (marker: string, places: string[]) => {
    for (const p of places) if (await fs.exists(fs.join(p, marker)).catch(() => false)) return p;
    return null;
  };
  const name = '.gt-where-' + randomId(10) + '.tmp';
  await fs.writeAtomic(fs.join(a, name), 'gt');
  try {
    if (await look(name, [b])) return 'same';
    if (await look(name, parentsOf(b))) return 'b-in-a';
  } finally {
    await fs.remove(fs.join(a, name)).catch(() => {});
  }
  if (!(await fs.exists(b).catch(() => false))) return null;
  const name2 = '.gt-where-' + randomId(10) + '.tmp';
  try {
    await fs.writeAtomic(fs.join(b, name2), 'gt');
  } catch {
    return null;
  }
  try {
    if (await look(name2, parentsOf(a))) return 'a-in-b';
  } finally {
    await fs.remove(fs.join(b, name2)).catch(() => {});
  }
  return null;
}

// ------------------------------------------------------------------ journals
const LOG = /^[^\\/]+\.log$/;

async function journalLines(fs: FsApi, dir: string): Promise<Map<string, { line: string; s: string }[]>> {
  const out = new Map<string, { line: string; s: string }[]>();
  const jdir = fs.join(dir, 'journals');
  for (const e of await fs.list(jdir)) {
    if (e.isDir || !LOG.test(e.name)) continue;
    const t = await fs.readText(fs.join(jdir, e.name));
    if (t === null) continue;
    const lines: { line: string; s: string }[] = [];
    // whole lines only (a line still being written is copied the next time)
    for (const line of t.slice(0, t.lastIndexOf('\n') + 1).split('\n')) {
      if (!line.trim()) continue;
      const b = decodeLine(line);
      if (b) lines.push({ line, s: b.s });
    }
    out.set(e.name, lines);
  }
  return out;
}

/**
 * Every change in `from`'s journals that `to` doesn't have yet, written into `to`: a journal file
 * the new folder doesn't have at all keeps its name (its owner goes on writing it there), the rest
 * goes into one new file. Never changes a file that is there.
 */
export async function syncJournals(fs: FsApi, from: string, to: string): Promise<{ changes: number; files: number }> {
  const src = await journalLines(fs, from);
  const dst = await journalLines(fs, to);
  const have = new Set<string>();
  for (const lines of dst.values()) for (const l of lines) have.add(l.s);
  await fs.mkdirp(fs.join(to, 'journals'));
  let changes = 0;
  let files = 0;
  const rest: string[] = [];
  for (const [name, lines] of src) {
    const missing = lines.filter((l) => !have.has(l.s));
    if (!missing.length) continue;
    for (const l of missing) have.add(l.s);
    changes += missing.length;
    if (!dst.has(name)) {
      await fs.append(fs.join(to, 'journals', name), missing.map((l) => l.line + '\n').join(''));
      files++;
    } else rest.push(...missing.map((l) => l.line + '\n'));
  }
  if (rest.length) {
    await fs.append(fs.join(to, 'journals', 'j_moved_' + Date.now().toString(36) + '_' + randomId(6) + '.log'), rest.join(''));
    files++;
  }
  return { changes, files };
}

// ------------------------------------------------------------------ files
async function copyFile(fs: CopyFs, src: string, dst: string): Promise<number> {
  if (fs.copy) {
    await fs.copy(src, dst);
    const st = fs.stat ? await fs.stat(dst).catch(() => null) : null;
    return (st as { size?: number } | null)?.size ?? 0;
  }
  const b = await fs.readBytes(src);
  if (!b) throw new Error('missing: ' + src);
  await fs.writeBytes(dst, b);
  return b.length;
}

type Seen = Map<string, { size: number; mtime: number } | null>;
const statOf = async (fs: CopyFs, p: string) => {
  if (!fs.stat) return null;
  const st = (await fs.stat(p).catch(() => null)) as { size?: number; mtime: number } | null;
  return st ? { size: st.size ?? -1, mtime: st.mtime } : null;
};

/**
 * A folder copied into another (made as needed); a file already in the target is left as it is
 * (it is the newer one: written there after the change of place). `seen` records each file as it
 * was when copied, so removing the old one can tell whether it changed since.
 */
export async function copyTree(fs: CopyFs, src: string, dst: string, skip?: (name: string) => boolean, seen?: Seen): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  await fs.mkdirp(dst);
  for (const e of await fs.list(src)) {
    if (skip?.(e.name) || /\.tmp$/i.test(e.name)) continue;
    const s = fs.join(src, e.name);
    const d = fs.join(dst, e.name);
    if (e.isDir) {
      const r = await copyTree(fs, s, d, skip, seen);
      files += r.files;
      bytes += r.bytes;
    } else if (!(await fs.exists(d))) {
      const before = await statOf(fs, s);
      bytes += await copyFile(fs, s, d);
      seen?.set(s, before);
      files++;
    }
  }
  return { files, bytes };
}

/**
 * A folder's files removed where the same file is in `copy` - and only if it is still what was
 * copied (a PC that hadn't heard of the new place yet may have written it again since), or, for a
 * file that was in `copy` already, if that one is at least as new. What isn't safe to remove stays.
 */
async function removeCopied(fs: CopyFs, src: string, copy: string, skip?: (name: string) => boolean, seen?: Seen): Promise<{ removed: number; kept: number }> {
  let removed = 0;
  let kept = 0;
  for (const e of await fs.list(src)) {
    if (skip?.(e.name)) continue;
    const s = fs.join(src, e.name);
    const d = fs.join(copy, e.name);
    if (e.isDir) {
      const r = await removeCopied(fs, s, d, skip, seen);
      removed += r.removed;
      kept += r.kept;
      continue;
    }
    if (!(await fs.exists(d))) { kept++; continue; }
    const now = await statOf(fs, s);
    let ok = true;
    if (now) {
      if (seen?.has(s)) {
        const was = seen.get(s);
        ok = !was || (was.size === now.size && was.mtime === now.mtime);
      } else {
        const there = await statOf(fs, d);
        ok = !there || there.mtime >= now.mtime;
      }
    }
    if (ok) { await fs.remove(s); removed++; } else kept++;
  }
  if (!kept) await fs.rmdir?.(src).catch(() => {});
  return { removed, kept };
}

// ------------------------------------------------------------------ backups
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json\.gz$/;
/**
 * What a folder in a backups folder holds the backups of - never a live accounts or project folder
 * (journals, project.json), whatever its name.
 */
const kindOfSet = async (fs: FsApi, dir: string, name: string): Promise<BackupKind | null> => {
  if ((await fs.exists(fs.join(dir, 'journals')).catch(() => true)) || (await fs.exists(fs.join(dir, 'project.json')).catch(() => true))) return null;
  let about: { kind?: string } | null = null;
  try { about = JSON.parse((await fs.readText(fs.join(dir, 'about.json'))) ?? 'null'); } catch { about = null; }
  if (about && (about.kind === 'qto' || about.kind === 'accounts')) return name === ACCOUNTS_BACKUP && about.kind !== 'accounts' ? null : (about.kind as BackupKind);
  if (name !== ACCOUNTS_BACKUP) return null;
  const days = (await fs.list(dir).catch(() => [])).some((e) => !e.isDir && DAY_FILE.test(e.name));
  return days ? 'accounts' : null;
};

/** how many backup folders of these kinds are in a backups folder (to say what moving means) */
export async function countBackupSets(fs: FsApi, base: string, kinds: BackupKind[]): Promise<number> {
  let n = 0;
  for (const e of await fs.list(base).catch(() => [])) {
    if (!e.isDir) continue;
    const k = await kindOfSet(fs, fs.join(base, e.name), e.name);
    if (k && kinds.includes(k)) n++;
  }
  return n;
}

/**
 * The backups of these kinds moved from one backups folder to another: each project's folder is
 * copied, and removed from the old place only once every one of its files is in the new one.
 * The two folders are compared on the disk first: the same folder by another name moves nothing.
 */
export async function moveBackupSets(fs: CopyFs, from: string, to: string, kinds: BackupKind[], onProgress?: (done: number, total: number) => void): Promise<{ moved: number; files: number; bytes: number; left: number; error?: string }> {
  await fs.mkdirp(to);
  const rel = await onDisk(fs, from, to);
  if (rel === 'same') return { moved: 0, files: 0, bytes: 0, left: 0 };
  if (rel) throw new Error('The new backups folder can’t be inside the old one (or the other way round).');
  const sets: string[] = [];
  for (const e of await fs.list(from)) {
    if (!e.isDir) continue;
    const k = await kindOfSet(fs, fs.join(from, e.name), e.name);
    if (k && kinds.includes(k)) sets.push(e.name);
  }
  let moved = 0, files = 0, bytes = 0, left = 0;
  let error: string | undefined;
  const skip = (n: string) => n === 'clock.txt';
  for (let i = 0; i < sets.length; i++) {
    onProgress?.(i, sets.length);
    const s = fs.join(from, sets[i]);
    const d = fs.join(to, sets[i]);
    const seen: Seen = new Map();
    try {
      const c = await copyTree(fs, s, d, skip, seen);
      files += c.files;
      bytes += c.bytes;
    } catch (e: any) {
      // this project's backups stay where they are, whole; the next ones are still tried
      error ??= String(e?.message ?? e);
      left++;
      continue;
    }
    const r = await removeCopied(fs, s, d, skip, seen).catch(() => ({ removed: 0, kept: 1 }));
    if (r.kept) left++;
    else {
      await fs.remove(fs.join(s, 'clock.txt')).catch(() => {});
      await fs.rmdir?.(s).catch(() => {});
      moved++;
    }
  }
  onProgress?.(sets.length, sets.length);
  return { moved, files, bytes, left, error };
}

// ------------------------------------------------------------------ the team folder
export interface MovedNote { /** FORMAT.moved, or the earlier spelling (legacy.ts formatFor) */ format: string; to: string; id: string; at: number; by: string }
/**
 * What the old accounts' project.json becomes when their copy is cleared away: the same id, no
 * changes, and where they went. An older app sees accounts with nobody in them (it can't offer
 * "set up accounts" to whoever comes along); this one follows `moved.to`.
 */
interface AccountsMeta { format?: unknown; id?: string; moved?: { to: string; at: number; by: string } }

/** the accounts' project.json; null when there is none (a file that can't be read is an error) */
async function accountsMeta(fs: FsApi, root: string): Promise<AccountsMeta | null> {
  const t = await fs.readText(fs.join(root, ACCOUNTS_FOLDER, 'project.json'));
  if (t === null) return null;
  try { return JSON.parse(t.replace(/^\uFEFF/, '')) as AccountsMeta; } catch { return {}; }
}
async function accountsId(fs: FsApi, root: string): Promise<string | null> {
  try {
    const m = await accountsMeta(fs, root);
    return typeof m?.id === 'string' && !m.moved ? m.id : null;
  } catch {
    return null;
  }
}
/** accounts that were moved away and cleared (or never there): what is left is only a pointer */
async function cleared(fs: FsApi, root: string, meta: AccountsMeta | null): Promise<boolean> {
  if (meta?.moved) return true;
  if (meta) return false;
  const logs = (await fs.list(fs.join(root, ACCOUNTS_FOLDER, 'journals'))).filter((e) => !e.isDir && e.name.endsWith('.log'));
  return logs.length === 0;
}

/** the old folder still holds the accounts (not yet cleared down to a pointer) */
export async function stillHoldsAccounts(fs: FsApi, root: string): Promise<boolean> {
  try {
    const m = await accountsMeta(fs, root);
    return !!m && !m.moved;
  } catch {
    return false;
  }
}

/** where the team folder's accounts went already (an administrator's word), if anywhere else */
export function movedAlready(store: Store, root: string): string | null {
  const v = trustedGet(store, CFG, 'movedTo');
  return typeof v === 'string' && v.trim() && !samePath(v, root) ? v.trim() : null;
}

/** can the accounts move into this folder? (null: yes; else why not) */
export async function checkNewTeamFolder(fs: FsApi, from: string, to: string, roots?: Roots): Promise<string | null> {
  if (!to.trim()) return 'Choose a folder.';
  if (samePath(from, to)) return 'That is the team folder already.';
  for (const sub of [ACCOUNTS_FOLDER, BACKUPS, RELEASES, '_reports']) if (inside(to, fs.join(from, sub))) return `The new folder can’t be inside ${sub}.`;
  if (!(await fs.exists(to))) return 'That folder can’t be reached from this PC.';
  let rel: Awaited<ReturnType<typeof onDisk>>;
  try {
    rel = await onDisk(fs, from, to);
  } catch {
    return 'This PC can’t write in the team folder, so it can’t move it.';
  }
  if (rel === 'same') return 'That is the team folder already (under another name).';
  if (rel === 'b-in-a') {
    for (const sub of [ACCOUNTS_FOLDER, BACKUPS, RELEASES, '_reports']) {
      const r = await onDisk(fs, fs.join(from, sub), to).catch(() => null);
      if (r === 'same' || r === 'b-in-a') return `The new folder can’t be inside ${sub}.`;
    }
  }
  // never where backups are kept: the live accounts would sit among their own backups
  for (const b of [roots?.bak.team]) {
    if (!b) continue;
    const r = samePath(b, to) || inside(to, b) ? 'same' : await onDisk(fs, b, to).catch(() => null);
    if (r === 'same' || r === 'b-in-a') return 'The team folder can’t go in a backups folder. Choose a folder of its own.';
  }
  const mine = await accountsId(fs, from);
  let meta: AccountsMeta | null = null;
  try { meta = await accountsMeta(fs, to); } catch { return 'The accounts in that folder can’t be read.'; }
  const theirs = typeof meta?.id === 'string' ? meta.id : null;
  if (theirs && theirs !== mine) return 'That folder has accounts of its own already (another team folder). Choose an empty folder.';
  return null;
}

export interface MoveTeamOpts {
  fs: CopyFs;
  from: string;
  to: string;
  /** the old team folder as every PC can reach it (\\server\share\…: the projects stay there) */
  pinAs?: string;
  /** where things are now (projects stay where they are) */
  roots: Roots;
  by: { username: string; name: string };
  host: string;
  /** the live accounts of the old folder */
  oldStore: Store;
  /** the change in the old accounts that sends everybody to the new folder; false: not written */
  commitOld: (ops: Op[], label: string) => boolean;
  step?: (text: string) => void;
}

/**
 * Copies what the team folder holds for the team (the accounts, their backups unless they are kept
 * elsewhere, the newest release) into the new folder, then points the old accounts at it.
 * Can be run again after a failure part way (nothing there is overwritten).
 */
export async function moveTeamFolder(o: MoveTeamOpts): Promise<{ changes: number; backups: number; release: boolean; releaseNote: string | null }> {
  const { fs, from, to } = o;
  const already = movedAlready(o.oldStore, from);
  if (already) throw new Error(`The team folder has been moved to ${already} already. Move it from there.`);
  const why = await checkNewTeamFolder(fs, from, to, o.roots);
  if (why) throw new Error(why);
  const pin = o.pinAs || from;
  const oldAcc = fs.join(from, ACCOUNTS_FOLDER);
  const newAcc = fs.join(to, ACCOUNTS_FOLDER);
  const id = await accountsId(fs, from);
  if (!id) throw new Error('The accounts folder of the team folder can’t be read.');
  // 1. the accounts: what describes them (over a pointer left by an earlier move away), then every change
  o.step?.('Copying the accounts…');
  await fs.mkdirp(fs.join(newAcc, 'journals'));
  await fs.mkdirp(fs.join(newAcc, 'presence'));
  const there = await accountsMeta(fs, to);
  if (!there || there.moved) await fs.writeAtomic(fs.join(newAcc, 'project.json'), (await fs.readText(fs.join(oldAcc, 'project.json')))!);
  await fs.remove(fs.join(newAcc, MOVED_FILE)).catch(() => {});
  const first = await syncJournals(fs, oldAcc, newAcc);
  // 2. in the new place: the projects stay where they are; where it came from (to clear it later)
  const { store } = await loadAccountStore(fs, to);
  const ops: Op[] = [];
  if (samePath(o.roots.qto, from) && !trustedGet(store, CFG, 'qtoRoot')) ops.push([CFG, 'qtoRoot', pin]);
  ops.push([CFG, 'movedFrom', pin]);
  await appendOneOff(fs, newAcc, o.by.name, o.by.username, o.host, ops, `Team folder moved here from ${pin}`, store);
  // 3. the accounts' backups (when they are kept in the team folder)
  let backups = 0;
  if (!o.roots.bak.team) {
    o.step?.('Copying the accounts’ backups…');
    const src = fs.join(from, BACKUPS, ACCOUNTS_BACKUP);
    if (await fs.exists(src)) backups = (await copyTree(fs, src, fs.join(to, BACKUPS, ACCOUNTS_BACKUP), (n) => n === 'clock.txt')).files;
  }
  // 4. the newest release, so updates and the setup work from the new folder. A copy that fails stops
  // the move here, before anyone is sent there: every PC would otherwise end up in a folder with no
  // release to update from (BH-008). Run again once it is put right (nothing copied is overwritten).
  // A latest.json that can't be read is no release in the old folder either: the move goes on, and
  // says so.
  let release = false;
  let releaseNote: string | null = null;
  const latestText = await fs.readText(fs.join(from, RELEASES, 'latest.json')).catch(() => null);
  let j: { version?: string; folder?: string; setup?: { file?: string } } | null = null;
  if (latestText) {
    try { j = JSON.parse(latestText.replace(/^\uFEFF/, '')); } catch { j = null; }
    if (!j || typeof j !== 'object') {
      j = null;
      releaseNote = `No release was copied: ${fs.join(from, RELEASES, 'latest.json')} can’t be read. Put the newest release in the new team folder’s ${RELEASES} folder by hand.`;
    }
  } else releaseNote = `No release was copied: the old team folder has none (no ${RELEASES} folder with a latest.json).`;
  if (latestText && j) {
    o.step?.('Copying the newest release…');
    try {
      const rel = fs.join(to, RELEASES);
      await fs.mkdirp(rel);
      let theirs: { version?: string } | null = null;
      try { theirs = JSON.parse(((await fs.readText(fs.join(rel, 'latest.json'))) ?? 'null').replace(/^\uFEFF/, '')); } catch { theirs = null; }
      const newer = !theirs?.version || (typeof j.version === 'string' && cmpVersion(j.version, theirs.version) > 0);
      if (newer) {
        if (typeof j.folder === 'string' && /^[\w.-]+$/.test(j.folder)) await copyTree(fs, fs.join(from, RELEASES, j.folder), fs.join(rel, j.folder));
        const setup = j.setup && typeof j.setup.file === 'string' && /^[\w .()-]+\.exe$/i.test(j.setup.file) ? j.setup.file : null;
        if (setup && !(await fs.exists(fs.join(rel, setup))) && (await fs.exists(fs.join(from, RELEASES, setup)))) await copyFile(fs, fs.join(from, RELEASES, setup), fs.join(rel, setup));
        // latest.json last: a release is only offered once its files are all there
        await fs.writeAtomic(fs.join(rel, 'latest.json'), latestText);
      }
      release = true;
    } catch (e: any) {
      throw new Error(`The newest release could not be copied to the new folder (${String(e?.message ?? e)}). Nobody was moved: check that this PC can write there and that the disk has room, then move again (what is copied already is kept).`);
    }
  }
  // 5. what changed in the old accounts meanwhile, then everybody is sent on
  o.step?.('Sending everybody to the new folder…');
  const again = await syncJournals(fs, oldAcc, newAcc);
  if (!o.commitOld([[CFG, 'movedTo', to]], `Team folder moved to ${to}`)) {
    throw new Error('The old accounts could not be changed from this PC (view only, or a newer version wrote them). Nothing was moved: the new folder only has a copy.');
  }
  // (spelled as the old folder's accounts are: PCs still on the earlier version follow only that spelling)
  const note: MovedNote = { format: formatFor(FORMAT.moved, await accountsMeta(fs, from)), to, id, at: Date.now(), by: o.by.username };
  await fs.writeAtomic(fs.join(oldAcc, MOVED_FILE), JSON.stringify(note, null, 1));
  // the new folder says it sends nobody anywhere - stamped after the old folder's "moved to", so
  // copying the old changes over later never makes it point at itself
  const now = await loadAccountStore(fs, to);
  const top = [o.oldStore.top, now.store.top].sort().pop() ?? '';
  await appendOneOff(fs, newAcc, o.by.name, o.by.username, o.host, [[CFG, 'movedTo', null]], 'Team folder moved here', { top } as Store);
  return { changes: first.changes + again.changes, backups, release, releaseNote: release ? null : releaseNote };
}

/**
 * Where the accounts of this folder went, if they moved: the administrators' word in the accounts
 * (cfg `movedTo`), or - once the old accounts were cleared away (nothing but a pointer left) - the
 * pointer. `ok` once the new folder is there with the same accounts.
 */
export async function movedTarget(fs: FsApi, root: string, store: Store | null): Promise<{ to: string; ok: boolean; why?: string; cleared: boolean } | null> {
  const meta = await accountsMeta(fs, root);
  let id: string | null = typeof meta?.id === 'string' ? meta.id : null;
  let to: string | null = store ? movedAlready(store, root) : null;
  const isCleared = await cleared(fs, root, meta);
  if (!to && isCleared) {
    if (meta?.moved && typeof meta.moved.to === 'string') to = meta.moved.to;
    else {
      try {
        const n = JSON.parse((await fs.readText(fs.join(root, ACCOUNTS_FOLDER, MOVED_FILE))) ?? 'null') as MovedNote | null;
        if (normFormat(n?.format) === FORMAT.moved && typeof n?.to === 'string') { to = n.to; id ??= n.id; }
      } catch { /* no note */ }
    }
  }
  if (!to || samePath(to, root)) return null;
  if (!(await fs.exists(to).catch(() => false))) return { to, ok: false, why: 'this PC can’t reach it', cleared: isCleared };
  // the folder it went to was itself moved on and cleared since (A -> B -> C, then B cleared: B is a
  // pointer now): its pointer is followed, for the same accounts only, a few moves at most and never
  // back to a folder already passed (BH-009)
  let dest: string = to;
  const passed = [root];
  for (let hop = 0; hop < 4; hop++) {
    const m: AccountsMeta | null = await accountsMeta(fs, dest).catch(() => null);
    const next: string | null = m?.moved && typeof m.moved.to === 'string' ? m.moved.to : null;
    if (!next || (id && m?.id !== id) || [...passed, dest].some((p) => samePath(p, next))) break;
    passed.push(dest);
    dest = next;
    if (!(await fs.exists(dest).catch(() => false))) return { to: dest, ok: false, why: 'this PC can’t reach it', cleared: isCleared };
  }
  const theirs = await accountsId(fs, dest);
  if (!theirs) return { to: dest, ok: false, why: 'the accounts aren’t there (yet)', cleared: isCleared };
  if (id && theirs !== id) return { to: dest, ok: false, why: 'the accounts there are another team’s', cleared: isCleared };
  return { to: dest, ok: true, cleared: isCleared };
}

/** who is signed in to (or has a project of) these accounts right now, by their presence files */
export async function whoIsThere(fs: FsApi, root: string, now = Date.now()): Promise<{ name: string; host: string }[]> {
  const out: { name: string; host: string }[] = [];
  const dir = fs.join(root, ACCOUNTS_FOLDER, 'presence');
  for (const e of await fs.list(dir).catch(() => [])) {
    if (e.isDir || !e.name.endsWith('.json')) continue;
    try {
      const p = JSON.parse((await fs.readText(fs.join(dir, e.name))) ?? 'null') as PresenceInfo | null;
      // heartbeats every 6 s: two minutes of silence (or a closing one) is somebody who left
      if (p && !p.gone && Math.abs(now - p.ts) < 120_000) out.push({ name: p.u, host: p.host });
    } catch { /* half written: next time */ }
  }
  return out;
}

/**
 * The old copy of the accounts cleared away once everybody has moved (what is still only there is
 * brought over first): its project.json becomes a pointer to the new folder (same id, no changes),
 * so a PC that has been off since still finds its way and an older app can't set up new accounts
 * there. The accounts' backups made there join the ones made since (`accBackups`).
 */
export async function clearOldTeamFolder(fs: CopyFs, old: string, cur: string, accBackups: string): Promise<{ changes: number; removed: number; left: number }> {
  const oldAcc = fs.join(old, ACCOUNTS_FOLDER);
  const curAcc = fs.join(cur, ACCOUNTS_FOLDER);
  const a = await accountsMeta(fs, old);
  const b = await accountsId(fs, cur);
  if (!b) throw new Error('The accounts here can’t be read.');
  if (a?.id && a.id !== b) throw new Error('The old folder holds another team’s accounts: nothing removed.');
  if ((await onDisk(fs, old, cur)) === 'same') throw new Error('The old folder is this team folder (under another name): nothing removed.');
  let { changes } = await syncJournals(fs, oldAcc, curAcc);
  // the pointer first: from here on nobody can sign in there, whatever happens next
  await fs.writeAtomic(fs.join(oldAcc, 'project.json'), JSON.stringify({ format: formatFor(FORMAT.accounts, a), formatVersion: 1, id: b, name: 'Accounts (moved)', moved: { to: cur, at: Date.now(), by: '' } }, null, 2));
  const note: MovedNote = { format: formatFor(FORMAT.moved, a), to: cur, id: b, at: Date.now(), by: '' };
  await fs.writeAtomic(fs.join(oldAcc, MOVED_FILE), JSON.stringify(note, null, 1));
  // Anything written there in between is copied, and a journal file is removed only while it is still
  // exactly what the copy read (same size before and after it): a PC still writing there (an older
  // version, an outbox sent on reconnecting) must not lose a change between the last copy and the
  // removal (BH-012). Whatever grew meanwhile is copied again in the next round; a file still
  // changing after three rounds is left (counted: someone is still at work there).
  const jd = fs.join(oldAcc, 'journals');
  const sizes = async () => {
    const m = new Map<string, number>();
    for (const e of await fs.list(jd).catch(() => [])) {
      if (!e.isDir) m.set(e.name, (await fs.readFrom(fs.join(jd, e.name), 0, 0).catch(() => null))?.size ?? -1);
    }
    return m;
  };
  let removed = 0;
  let left = 0;
  for (let round = 0; round < 3; round++) {
    const before = await sizes();
    changes += (await syncJournals(fs, oldAcc, curAcc)).changes;
    for (const [n, size] of await sizes()) {
      if (size < 0 || before.get(n) !== size) continue;
      try { await fs.remove(fs.join(jd, n)); removed++; } catch { /* in use: counted below */ }
    }
    if (!(await fs.list(jd).catch(() => [])).some((e) => !e.isDir)) break;
  }
  for (const e of await fs.list(jd).catch(() => [])) if (!e.isDir) left++;
  await fs.rmdir?.(jd).catch(() => {});
  // who was there: nothing to keep
  const pd = fs.join(oldAcc, 'presence');
  for (const e of await fs.list(pd)) {
    if (e.isDir) continue;
    try { await fs.remove(fs.join(pd, e.name)); removed++; } catch { left++; }
  }
  await fs.rmdir?.(pd).catch(() => {});
  // the accounts' backups made there: kept with the ones made since (wherever those are now)
  const ob = fs.join(old, BACKUPS, ACCOUNTS_BACKUP);
  if ((await fs.exists(ob)) && (await onDisk(fs, ob, accBackups).catch(() => 'same')) === null) {
    const skip = (n: string) => n === 'clock.txt';
    const seen: Seen = new Map();
    await copyTree(fs, ob, accBackups, skip, seen);
    const r = await removeCopied(fs, ob, accBackups, skip, seen);
    removed += r.removed;
    if (!r.kept) { await fs.remove(fs.join(ob, 'clock.txt')).catch(() => {}); await fs.rmdir?.(ob).catch(() => {}); }
  }
  return { changes, removed, left };
}
