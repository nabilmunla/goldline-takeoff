// Daily backups of what is open (see engine/backups.ts): started when a project or the accounts
// open, finished when they close. A backup that can't be written never gets in the way.
import { splitBytes } from '../engine/codec';
import { gt } from './api';
import { BackupKeeper, type BackupKind } from '../engine/backups';
import type { CopyFs } from '../engine/teamfolder';
import { backupBase, type Roots } from '../engine/accounts';
import type { ProjectSession } from '../engine/session';

export const backupFs = (): CopyFs => {
  const g = gt();
  return {
    ...g.fs, readBytes: (p) => g.files.readBytes(p), writeBytes: (p, d) => g.files.writeBytes(p, d), stat: (p) => g.files.stat(p),
    copy: g.files.copy ? (a, b) => g.files.copy(a, b) : undefined,
    rmdir: g.files.rmdir ? (p) => g.files.rmdir(p) : undefined,
  };
};

/** the backups folders as the administrators set them now (kept up to date by the signed-in window) */
let roots: Roots | null = null;
export function setBackupRoots(r: Roots | null) { roots = r; }

const folderName = (dir: string) => dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir;

/** the sessions open in this window (to know whether anything is still waiting to be sent) */
export const openSessions = new Set<ProjectSession>();
export const pendingTotal = () => [...openSessions].reduce((a, s) => a + s.pendingCount, 0);
/**
 * A session of this project open in this window (the estimate on screen, a take-off on screen or
 * linked to the estimate on screen): background work writes through it rather than opening a second
 * one. One that can write is preferred; one that can't (View only, view access) is still returned,
 * so nothing goes around what the screen shows.
 */
export function liveSession(projectId: string): ProjectSession | null {
  let ro: ProjectSession | null = null;
  for (const s of openSessions) {
    if (s.meta?.id !== projectId) continue;
    if (!s.readOnly) return s;
    ro ??= s;
  }
  return ro;
}

export function keepBackedUp(s: ProjectSession, o: {
  kind: BackupKind;
  root: string;
  projectDir: string;
  by: string;
  host: string;
  app: string;
  admins?: (username: string, stamp: string) => boolean;
}): BackupKeeper {
  openSessions.add(s);
  const k = new BackupKeeper({
    fs: backupFs(),
    root: o.root,
    kind: o.kind,
    projectDir: o.projectDir,
    folder: folderName(o.projectDir),
    projectId: s.meta.id,
    projectName: s.meta.name,
    by: o.by,
    host: o.host,
    app: o.app,
    admins: o.admins,
    session: s,
    baseOf: () => (roots ? backupBase(roots, o.kind) : undefined),
    log: (l) => { try { gt().log(l); } catch { /* ignore */ } },
    // the accounts keep their history as it was made (who was an administrator when)
    lines: o.kind === 'accounts' ? () => journalLines(o.projectDir) : undefined,
  });
  void k.opened().catch(() => {});
  return k;
}

/** close a session, then write its backup - never longer than `ms` in all */
export async function closeWithBackup(s: ProjectSession, k: BackupKeeper | null, ms = 4500): Promise<void> {
  // (the time the close took comes off the backup's: the close waited first and the backup still had the whole 4.5 s,
  // past the app's 6 s close window - 0.23.2, DeepSeek #43. The close itself always finishes: it keeps the work.)
  const t0 = Date.now();
  await s.close();
  openSessions.delete(s);
  const left = Math.max(400, ms - (Date.now() - t0));
  if (k) await Promise.race([k.closing(), new Promise((r) => setTimeout(r, left))]).catch(() => {});
}

/** every complete line of a synced folder's journals (small folders only: the accounts) */
export async function journalLines(dir: string): Promise<string[]> {
  const fs = gt().fs;
  const jdir = fs.join(dir, 'journals');
  const out: string[] = [];
  for (const e of await fs.list(jdir)) {
    if (e.isDir || !e.name.endsWith('.log')) continue;
    // a journal that can't be read now: no backup this time (one without it could leave out
    // the first administrator); the next try reads them all again
    const t = await fs.readText(fs.join(jdir, e.name));
    if (t === null) throw new Error(`could not read ${e.name}`);
    const end = t.lastIndexOf('\n');
    for (const line of t.slice(0, end + 1).split('\n')) if (line.trim()) out.push(line + '\n');
  }
  return out;
}

/**
 * How many of this person's changes wait on this PC for projects that are not open (left there by a
 * project closed while the shared folder was out of reach) - asked about when the app closes.
 */
export async function leftoverCount(o: { localDir: string; account: string; isOpen: (projectDir: string) => boolean }): Promise<number> {
  const fs = gt().fs;
  const root = fs.join(o.localDir, 'outbox');
  const stamps = new Set<string>();
  for (const e of await fs.list(root).catch(() => [])) {
    if (!e.isDir) continue;
    const dir = fs.join(root, e.name);
    let target: { projectDir?: string } | null = null;
    try { target = JSON.parse((await fs.readText(fs.join(dir, 'target.json'))) ?? 'null'); } catch { target = null; }
    if (!target?.projectDir || o.isOpen(target.projectDir)) continue;
    for (const f of await fs.list(dir).catch(() => [])) {
      if (f.isDir || !f.name.endsWith('.log')) continue;
      const t = await fs.readText(fs.join(dir, f.name)).catch(() => null);
      if (!t || !t.includes('\n')) continue;
      for (const b of splitBytes(new TextEncoder().encode(t.slice(0, t.lastIndexOf('\n') + 1))).batches) if (!b.a || b.a === o.account) stamps.add(b.s);
    }
  }
  return stamps.size;
}

/**
 * Changes left on this PC by a session that ended while the shared folder was out of reach (the
 * app closed, the PC restarted): sent at sign-in, without waiting for each project to be opened
 * again. Only queues of this person, to projects they may still edit; one project at a time, in the
 * background.
 */
export async function sendLeftovers(o: {
  localDir: string;
  user: string;
  account: string;
  host: string;
  appVersion: string;
  dataFormat: number;
  /** what opening a project marks it with (see engine/version.ts BASE_FORMAT) */
  markFormat?: number;
  canEdit: (meta: { id: string; name: string; format?: string; owner?: string; createdBy?: string }) => boolean;
  isOpen: (projectDir: string) => boolean;
  log: (line: string) => void;
}): Promise<number> {
  const fs = gt().fs;
  const root = fs.join(o.localDir, 'outbox');
  let sent = 0;
  for (const e of await fs.list(root).catch(() => [])) {
    if (!e.isDir) continue;
    const dir = fs.join(root, e.name);
    const files = (await fs.list(dir).catch(() => [])).filter((f) => !f.isDir && f.name.endsWith('.log'));
    // only queues holding this person's changes (another account's wait for that person)
    let waiting = false;
    for (const f of files) {
      const t = await fs.readText(fs.join(dir, f.name)).catch(() => null);
      if (!t || !t.includes('\n')) continue;
      const { batches } = splitBytes(new TextEncoder().encode(t.slice(0, t.lastIndexOf('\n') + 1)));
      if (batches.some((b) => !b.a || b.a === o.account)) { waiting = true; break; }
    }
    if (!waiting) continue;
    let target: { projectDir?: string } | null = null;
    try { target = JSON.parse((await fs.readText(fs.join(dir, 'target.json'))) ?? 'null'); } catch { target = null; }
    const pd = target?.projectDir;
    if (!pd || o.isOpen(pd)) continue;
    let meta: any = null;
    try { meta = JSON.parse((await fs.readText(fs.join(pd, 'project.json'))) ?? 'null'); } catch { meta = null; }
    if (!meta?.id || !o.canEdit(meta)) continue;
    const { ProjectSession } = await import('../engine/session');
    const s = new ProjectSession({ fs, localFs: fs, projectDir: pd, localDir: o.localDir, user: o.user, account: o.account, host: o.host, appVersion: o.appVersion, dataFormat: o.dataFormat, markFormat: o.markFormat });
    try {
      await s.open();
      const n = s.pendingCount;
      for (let i = 0; i < 50 && s.pendingCount; i++) await new Promise((r) => setTimeout(r, 100));
      if (n) { sent += n - s.pendingCount; o.log(`sent ${n - s.pendingCount} change(s) left on this PC for ${meta.name}`); }
    } catch (err: any) {
      o.log(`could not send the changes left for ${pd}: ${err?.message ?? err}`);
    } finally {
      await s.close().catch(() => {});
    }
  }
  return sent;
}
