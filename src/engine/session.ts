// ProjectSession: one open project in one running app instance.
//
// Writing:  every change is (1) applied on screen immediately, (2) appended to a
//           local outbox on this PC, (3) appended to this instance's OWN journal
//           file in the shared project folder. Nobody else ever writes that file.
//           If the share is unreachable, changes wait in the outbox and are sent
//           when it comes back - even after an app restart.
// Reading:  every ~1 s the session reads the small presence files to learn which
//           journals grew, and reads only the new bytes. Every 10 s it does a full
//           scan as a safety net.
import { Clock } from './hlc';
import { encodeLine, splitBytes } from './codec';
import { crc32hex } from './crc32';
import { randomId, safeName, colorFor } from './ids';
import { Store, type Overwrite } from './store';
import type { Batch, FsApi, Op, PresenceInfo, ProjectMeta, SyncStatus, Value } from './types';

export interface SessionOptions {
  fs: FsApi;
  /** Local (this PC) file access for the outbox. May be the same object as fs. */
  localFs: FsApi;
  /** Absolute path of the project folder on the share */
  projectDir: string;
  /** Absolute path of this instance's local data folder */
  localDir: string;
  user: string;
  /** signed-in account username, stamped on every change */
  account?: string;
  host: string;
  /** view only: commit() refuses every change (viewers, or no edit access) */
  readOnly?: boolean;
  /** this app's version: written next to the data format mark, so an older app can say which version it needs */
  appVersion?: string;
  /** the data format this app writes (see engine/version.ts); left out: no check (tests) */
  dataFormat?: number;
  /** what opening the project marks it with (default: dataFormat); higher formats are marked by needFormat */
  markFormat?: number;
  pollMs?: number;
  fullScanMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  /** take over this person's changes queued on this PC (default: when not read-only) - also when
   *  the window is View only: they were made before and must still reach the share */
  adoptQueued?: boolean;
  /** a short background session (finishing a link request): nobody is shown this person in the
   *  project - its presence file only says how far its journal got (as a closed session's does) */
  quiet?: boolean;
}

export interface ConflictNotice {
  eid: string;
  field: string;
  byUser: string;
  value: Value;
  yourValue: Value;
}

type Listener<T> = (x: T) => void;

const MAX_READ = 8 * 1024 * 1024;
/** a journal line longer than this is split into several batches when written */
const MAX_BATCH_CHARS = 2 * 1024 * 1024;
const CONFLICT_WINDOW_MS = 20000;
/** fields whose simultaneous changes are merged by the model, not lost: no "replaced" notice
 *  (a take-off's openings list: each opening added also has its own field, dd:<id>) */
const MERGED_FIELDS = new Set(['ded']);
const PRESENCE_STALE_MS = 12000;
/** presence files nobody has updated for this long (a crashed app) are removed */
const PRESENCE_DEAD_MS = 10 * 60 * 1000;
/** journal files this process is appending to (two sessions of one project must not share one) */
const SEGS_IN_USE = new Set<string>();
/** the fields of a drawn shape's outline: corners, arcs, cut-outs - put back together or not at all */
const GEOM = new Set(['p', 'b', 'holes']);
/** shapes (sh:) whose outline someone else changed in any part since: none of it is put back */
function geomConflicts(ops: Op[], changedSince: (op: Op) => boolean): Set<string> {
  const out = new Set<string>();
  for (const op of ops) if (op[0].startsWith('sh:') && GEOM.has(op[1]) && changedSince(op)) out.add(op[0]);
  return out;
}
/** a clock that never jumps (scheduling, presence ages); the wall clock is only for stamps */
const mono = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** a value as every other PC will read it back from the journal (NaN, Infinity, -0, undefined -> null / 0) */
function normValue(v: Value): Value {
  if (typeof v === 'number') return Number.isFinite(v) ? (Object.is(v, -0) ? 0 : v) : null;
  return v === undefined ? null : v;
}
const shortHash = (s: string) => crc32hex(s.toLowerCase()).slice(0, 6);
/** journal file names (a presence file is read from the share: never follow anything else) */
const SEG_RE = /^j_[A-Za-z0-9_-]+\.log$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface UndoEntry {
  redo: Op[];
  undo: Op[];
  stamp: string;
  label: string;
  /** entities this change created: undone by moving them to the recycle bin, not by blanking them */
  created?: string[];
}

export class ProjectSession {
  readonly store = new Store();
  readonly writer: string;
  /** the project is in a newer data format than this app writes (the version that wrote it): open view-only */
  newerApp: string | null = null;
  readonly color: string;
  meta!: ProjectMeta;

  private fs: FsApi;
  private local: FsApi;
  private clock: Clock;
  private now: () => number;
  private pollMs: number;
  private fullScanMs: number;
  private heartbeatMs: number;

  private journalsDir: string;
  private presenceDir: string;
  private segName = '';
  private segBytes = 0;
  private outboxPath = '';
  /**
   * This PC's own journal file for this project (reused by its later sessions) and, kept on this PC
   * next to the outbox, how far it wrote it: see open(). Empty while the session writes a file of
   * the moment (after a torn line, a failed write).
   */
  private markName = '';
  private markPath = '';
  private markQueued = false;

  private pending: string[] = [];
  private pumping = false;
  private localChain: Promise<void> = Promise.resolve();
  /**
   * per journal file: bytes read so far; lines that couldn't be read when first seen (a write still
   * landing: tried again a few times, only those bytes); size of a torn tail (a write that never
   * finished: not read again until the file changes)
   */
  private segs = new Map<string, { consumed: number; bad?: [number, number][]; badTries?: number; tornAt?: number }>();
  private lastFullScan = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private hbTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private closing = false;
  private ticking = false;

  private status: SyncStatus = { state: 'connecting', pending: 0, lastError: null, lastSyncAt: 0, corruptLines: 0, segments: 0 };
  private focus: Pick<PresenceInfo, 'sel' | 'col' | 'editing' | 'detail' | 'sheet' | 'cx' | 'cy'> = { sel: null, col: null, editing: false, detail: null };
  private presSeq = 0;
  private presDirty = true;
  private presWriting = false;
  private others = new Map<string, { info: PresenceInfo; lastSeq: number; changedAt: number; seenAt: number; file: string }>();

  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];

  private changeL = new Set<Listener<Set<string>>>();
  private statusL = new Set<Listener<SyncStatus>>();
  private presenceL = new Set<Listener<PresenceInfo[]>>();
  private conflictL = new Set<Listener<ConflictNotice>>();

  constructor(private opts: SessionOptions) {
    this.fs = opts.fs;
    this.local = opts.localFs;
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 1000;
    this.fullScanMs = opts.fullScanMs ?? 5000;
    this.heartbeatMs = opts.heartbeatMs ?? 3000;
    this.writer = safeName(opts.user) + '@' + safeName(opts.host) + '~' + randomId(6);
    this.color = colorFor(opts.user);
    this.clock = new Clock(this.writer, this.now);
    this.journalsDir = this.fs.join(opts.projectDir, 'journals');
    this.presenceDir = this.fs.join(opts.projectDir, 'presence');
  }

  // ---------- events ----------
  onChange(f: Listener<Set<string>>) { this.changeL.add(f); return () => this.changeL.delete(f); }
  onStatus(f: Listener<SyncStatus>) { this.statusL.add(f); f(this.status); return () => this.statusL.delete(f); }
  onPresence(f: Listener<PresenceInfo[]>) { this.presenceL.add(f); return () => this.presenceL.delete(f); }
  onConflict(f: Listener<ConflictNotice>) { this.conflictL.add(f); return () => this.conflictL.delete(f); }
  getStatus() { return this.status; }

  private emitChange(ids: Set<string>) { if (ids.size) for (const f of this.changeL) f(ids); }
  private setStatus(p: Partial<SyncStatus>) {
    this.status = { ...this.status, ...p, pending: this.pending.length, segments: this.segs.size };
    for (const f of this.statusL) f(this.status);
  }

  // ---------- open / close ----------
  async open(): Promise<void> {
    try {
      await this.openInner();
    } catch (e) {
      // a failed open leaves nothing claimed: this PC's journal file is free for the next try
      if (this.segName) SEGS_IN_USE.delete(this.fs.join(this.journalsDir, this.segName));
      throw e;
    }
  }

  private async openInner(): Promise<void> {
    const metaText = await this.fs.readText(this.fs.join(this.opts.projectDir, 'project.json'));
    if (!metaText) throw new Error('project.json not found in ' + this.opts.projectDir);
    let meta: unknown;
    try { meta = JSON.parse(metaText); } catch { meta = null; }
    if (!meta || typeof meta !== 'object' || typeof (meta as ProjectMeta).id !== 'string' || !(meta as ProjectMeta).id) {
      throw new Error(`This project's description file (project.json in ${this.opts.projectDir}) is damaged, so it can't be opened. Its journals are untouched: an administrator can restore project.json from a backup.`);
    }
    this.meta = meta as ProjectMeta;
    await this.fs.mkdirp(this.journalsDir);
    await this.fs.mkdirp(this.presenceDir);
    // The outbox is per project FOLDER (a copied folder has the same id but is another project),
    // per PC (a roaming profile can be shared by two PCs) and per session (two sessions never
    // empty each other's queue).
    const obDir = this.local.join(this.opts.localDir, 'outbox', safeName(this.meta.id) + '_' + shortHash(this.opts.projectDir.replace(/[\\/]+$/, '')));
    await this.local.mkdirp(obDir);
    // which project this queue belongs to: so the app can send what was left here even before
    // that project is opened again (sign-in flushes every queue of this PC)
    // (also when the window starts View only: the person may turn it off and work)
    if (this.opts.adoptQueued ?? !this.opts.readOnly) await this.local.writeAtomic(this.local.join(obDir, 'target.json'), JSON.stringify({ projectDir: this.opts.projectDir, id: this.meta.id, format: this.meta.format })).catch(() => {});
    const hostKey = safeName(this.opts.host).slice(0, 24);
    this.outboxPath = this.local.join(obDir, hostKey + '~' + this.writer.slice(this.writer.lastIndexOf('~') + 1) + '.log');
    // one journal file per person and PC, reused by their later sessions (not a new file per sign-in)
    const fixed = 'j_' + safeName(this.opts.account || this.opts.user).slice(0, 24) + '_' + hostKey + '_' + shortHash(this.opts.localDir) + '.log';
    // How far this PC's earlier sessions wrote it, kept on this PC. Other PCs read a journal from where
    // they got to, so a file that is now shorter than that (deleted, emptied or replaced by an older
    // copy while this app was closed) must never be written again from the start: what is appended
    // there would sit below where the others read from, unseen. This PC then goes on in a file of a
    // new name, and its later sessions use that one (BH-013).
    this.markPath = this.local.join(obDir, 'seg-' + fixed + '.json');
    const mark = await this.readMark();
    this.segName = mark && mark.name !== fixed && SEG_RE.test(mark.name) ? mark.name : fixed;
    this.markName = this.segName;
    const segPath = this.fs.join(this.journalsDir, this.segName);
    if (SEGS_IN_USE.has(segPath)) { this.segName = ''; this.newSegment(); this.markName = ''; }
    else SEGS_IN_USE.add(segPath);

    // 1. Everything already on the share (my own journal file too: earlier sessions wrote it)
    await this.fullScan(true);
    {
      const mine = this.segs.get(this.segName);
      const r = await this.fs.readFrom(this.fs.join(this.journalsDir, this.segName), mine?.consumed ?? 0, 1).catch(() => null);
      const wrote = this.markName && mark?.name === this.markName ? mark.size : 0;
      // a torn last line (crash mid-write): never append after it, start a new file
      if (r && r.size > (mine?.consumed ?? 0)) this.newSegment();
      else if (wrote > (r?.size ?? 0)) {
        // gone, or shorter than this PC left it: a new name from now on
        SEGS_IN_USE.delete(this.fs.join(this.journalsDir, this.segName));
        this.segName = fixed.replace(/\.log$/, '_' + this.now().toString(36) + '.log');
        SEGS_IN_USE.add(this.fs.join(this.journalsDir, this.segName));
        this.markName = this.segName;
        this.segBytes = 0;
      } else this.segBytes = r?.size ?? 0;
      if (this.markName === this.segName) this.saveMark();
    }
    // 2. Anything this PC wrote but never got onto the share (crash / network loss) - also what a
    // newer version on this PC queued (after going back to this one): it is sent as it was made
    await this.adoptOutboxes(obDir);
    // a project written in a newer data format (the highest mark ever made counts): view only
    const own = this.opts.markFormat ?? this.opts.dataFormat;
    this.checkFormat();
    if (own && !this.opts.readOnly && this.formatSeen().fmt < own) {
      this.commit([['project', 'fmt', own], ['project', 'fmtBy', this.opts.appVersion ?? null]], undefined, { recordUndo: false });
    }
    this.setStatus({ state: 'online', lastSyncAt: this.now() });
    this.pump();
    this.writePresence();
    this.schedule();
    this.heartbeat();
  }

  /**
   * Edits queued on this PC by earlier sessions (crash, share down) are taken over by this one:
   * written into its own outbox, queued for the share, and the old files removed. Edits made under
   * another account stay where they are, for that person's next session; a view-only session
   * takes none. A torn last line in an old outbox is dropped (only complete, checked lines move).
   */
  private async adoptOutboxes(obDir: string) {
    const files: string[] = [];
    // the outbox of versions before 0.10 (one file per project id)
    const legacy = this.local.join(this.opts.localDir, 'outbox', this.meta.id + '.log');
    if (await this.local.exists(legacy)) files.push(legacy);
    // every queue in this project's outbox folder (this PC's own data since 0.12: a PC renamed since
    // still sends what it left). Also one of a session still closing: what it can't send stays
    // queued here, sent twice at worst (the same stamp counts once)
    for (const e of await this.local.list(obDir).catch(() => [])) {
      const p = this.local.join(obDir, e.name);
      if (!e.isDir && e.name.endsWith('.log') && p !== this.outboxPath) files.push(p);
    }
    const changed = new Set<string>();
    for (const f of files) {
      // a queue that can't be read now stays for the next time (never removed unread)
      let text: string | null;
      try { text = await this.local.readText(f); } catch { continue; }
      if (!text) { await this.local.remove(f).catch(() => {}); continue; }
      const { batches } = splitBytes(new TextEncoder().encode(text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1)));
      const take: string[] = [], keep: string[] = [];
      for (const b of batches) {
        const mine = (this.opts.adoptQueued ?? !this.opts.readOnly) && (!b.a || !this.opts.account || b.a === this.opts.account);
        (mine ? take : keep).push(encodeLine(b));
        if (!mine) continue;
        this.clock.observe(b.s);
        const r = this.store.apply(b);
        r.changed.forEach((x) => changed.add(x));
        this.pending.push(encodeLine(b));
      }
      if (take.length) await this.local.append(this.outboxPath, take.join(''));
      if (keep.length) await this.local.writeAtomic(f, keep.join(''));
      else await this.local.remove(f).catch(() => {});
    }
    if (changed.size) this.emitChange(changed);
  }

  /** the highest data format any app has marked this project with, and which app (max wins: a
   *  lower mark written later, by an older app, never lowers it) */
  formatSeen(): { fmt: number; by: string | null } {
    let fmt = 0, stamp = '';
    for (const h of this.store.hist.get('project') ?? []) {
      if (h.f === 'fmt' && typeof h.v === 'number' && h.v > fmt) { fmt = h.v; stamp = h.s; }
    }
    let by: string | null = null;
    for (const h of this.store.hist.get('project') ?? []) if (h.f === 'fmtBy' && h.s === stamp && typeof h.v === 'string') by = h.v;
    return { fmt, by };
  }

  /**
   * This project now holds something older apps would misread (format `fmt`): it is marked, so they
   * open it view only. Never lowered (the highest mark ever made counts, an undo included).
   */
  needFormat(fmt: number): void {
    if (this.opts.readOnly || this.formatSeen().fmt >= fmt) return;
    this.commit([['project', 'fmt', fmt], ['project', 'fmtBy', this.opts.appVersion ?? null]], undefined, { recordUndo: false });
  }

  /** a newer data format (seen at open, or arriving while open): view only from now on */
  private checkFormat() {
    const own = this.opts.dataFormat;
    if (!own || this.newerApp) return;
    const s = this.formatSeen();
    if (s.fmt > own) {
      this.newerApp = s.by || 'a newer version';
      this.opts.readOnly = true;
      this.setStatus({});
    }
  }

  /** a second call (the closer and the view going away both close it) waits for the first - sweep B 17 */
  close(): Promise<void> {
    this.closeRun ??= this.closeOnce();
    return this.closeRun;
  }
  private closeRun: Promise<void> | null = null;
  private async closeOnce(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.hbTimer) clearTimeout(this.hbTimer);
    if (this.presSoon) clearTimeout(this.presSoon);
    // give pending writes a short chance to land (they stay in the outbox regardless)
    for (let i = 0; i < 30 && (this.pending.length || this.pumping); i++) {
      if (!this.pumping) this.pump();
      await sleep(100);
    }
    this.closed = true;
    if (!this.pumping) SEGS_IN_USE.delete(this.fs.join(this.journalsDir, this.segName));
    await this.localChain;
    if (!this.pending.length) await this.local.remove(this.outboxPath).catch(() => {});
    for (let i = 0; i < 30 && this.presWriting; i++) await sleep(50);
    // the last word: how far this journal got (others read the last lines now, not at their next
    // full scan); marked gone, so nobody is shown as here. Readers remove it later.
    try {
      if (this.segBytes > 0) {
        const info: PresenceInfo = { w: this.writer, u: this.opts.user, a: this.opts.account, host: this.opts.host, color: this.color, seq: ++this.presSeq, ts: this.now(), seg: this.segName, size: this.segBytes, ...this.focus, gone: true };
        await this.fs.writeAtomic(this.presencePath(), JSON.stringify(info));
      } else {
        await this.fs.remove(this.presencePath());
      }
    } catch { /* ignore */ }
  }

  /** Test helper: stop without flushing or cleanup (simulates a crash) */
  kill(): void {
    this.closed = true;
    SEGS_IN_USE.delete(this.fs.join(this.journalsDir, this.segName));
    if (this.presSoon) clearTimeout(this.presSoon);
    if (this.timer) clearTimeout(this.timer);
    if (this.hbTimer) clearTimeout(this.hbTimer);
  }

  /** how far this PC wrote its own journal file of this project (see open) */
  private async readMark(): Promise<{ name: string; size: number } | null> {
    try {
      const j = JSON.parse((await this.local.readText(this.markPath)) ?? 'null');
      return j && typeof j.name === 'string' && Number.isFinite(j.size) ? { name: j.name, size: Number(j.size) } : null;
    } catch {
      return null;
    }
  }
  /** written after the write that made it grow (one at a time: the latest size is what is written) */
  private saveMark() {
    if (this.markQueued || !this.markName || this.segName !== this.markName) return;
    this.markQueued = true;
    this.localChain = this.localChain
      .then(async () => {
        this.markQueued = false;
        if (this.segName !== this.markName) return;
        await this.local.writeAtomic(this.markPath, JSON.stringify({ name: this.markName, size: this.segBytes }));
      })
      .catch(() => { this.markQueued = false; });
  }

  private newSegment() {
    if (this.segName) SEGS_IN_USE.delete(this.fs.join(this.journalsDir, this.segName));
    this.segName = 'j_' + safeName(this.opts.account || this.opts.user).slice(0, 24) + '_' + this.now().toString(36) + '_' + randomId(6) + '.log';
    SEGS_IN_USE.add(this.fs.join(this.journalsDir, this.segName));
    this.segBytes = 0;
    // the session that keeps this PC's mark: it follows to the new file (else the mark keeps naming the
    // file left - after a torn line every later start would leave it again for yet another new file, BH-040).
    // Written with the next append (at open: at once).
    if (this.markName) this.markName = this.segName;
  }

  get currentSegment() { return this.segName; }
  get projectDir() { return this.opts.projectDir; }
  get pendingCount() { return this.pending.length; }

  // ---------- writing ----------
  /** Apply a change locally and queue it for the share. Returns the batch. */
  get readOnly(): boolean { return !!this.opts.readOnly; }
  /** Access can change while the project is open (an admin shares or un-shares it). */
  setReadOnly(v: boolean) { this.opts.readOnly = v || !!this.newerApp; }

  commit(ops: Op[], label?: string, opts: { recordUndo?: boolean } = {}): Batch | null {
    if (this.closed || this.opts.readOnly) return null;
    // de-duplicate fields within the batch (last one wins); values exactly as others will read them
    const m = new Map<string, Op>();
    for (const op of ops) m.set(op[0] + '\u0000' + op[1], [op[0], op[1], normValue(op[2])]);
    const clean = [...m.values()];
    if (!clean.length) return null;

    const undoOps: Op[] = clean.map(([e, f]) => [e, f, this.store.get(e, f) ?? null]);
    const created = [...new Set(clean.map((o) => o[0]))].filter((e) => !this.store.ents.has(e));
    // a very big change goes in several journal lines (no reader has to swallow one huge line)
    const parts: Op[][] = [];
    let cur: Op[] = [], size = 0;
    for (const op of clean) {
      const n = op[0].length + op[1].length + (typeof op[2] === 'string' ? op[2].length : 12) + 8;
      if (cur.length && size + n > MAX_BATCH_CHARS) { parts.push(cur); cur = []; size = 0; }
      cur.push(op);
      size += n;
    }
    parts.push(cur);
    const changed = new Set<string>();
    let first: Batch | null = null, b: Batch | null = null;
    for (const part of parts) {
      b = { s: this.clock.tick(), w: this.writer, u: this.opts.user, t: this.now(), o: part };
      if (label) b.m = label;
      if (this.opts.account) b.a = this.opts.account;
      first ??= b;
      this.store.apply(b).changed.forEach((x) => changed.add(x));
      const line = encodeLine(b);
      this.pending.push(line);
      this.localChain = this.localChain.then(() => this.local.append(this.outboxPath, line)).catch((e) => {
        this.setStatus({ lastError: 'Local outbox: ' + String(e?.message ?? e) });
      });
    }
    if (opts.recordUndo !== false) {
      this.undoStack.push({ redo: clean, undo: undoOps, stamp: first!.s, label: label ?? 'Edit', created: created.length ? created : undefined });
      if (this.undoStack.length > 500) this.undoStack.shift();
      this.redoStack = [];
    }
    this.setStatus({ state: this.status.state === 'offline' ? 'offline' : 'saving' });
    this.emitChange(changed);
    this.pump();
    return b;
  }

  canUndo() { return this.undoStack.length > 0; }
  /** the step on top of the undo list: an "Undo" button in a message undoes exactly that step */
  undoMark(): object | null { return this.undoStack[this.undoStack.length - 1] ?? null; }
  /** undo, but only if `mark` is still the last step ('moved' when something else was done since) */
  undoIfTop(mark: object | null | undefined): { skipped: number; refused?: boolean } | 'moved' | null {
    if (!mark || this.undoStack[this.undoStack.length - 1] !== mark) return 'moved';
    return this.undo();
  }
  canRedo() { return this.redoStack.length > 0; }

  /**
   * Undo my last change. Fields someone else has changed since are left alone. Something this
   * change created goes to the recycle bin (restorable), and stays if someone else has worked on it.
   */
  undo(): { skipped: number; refused?: boolean } | null {
    if (this.closed || this.opts.readOnly) return null;
    const e = this.undoStack.pop();
    if (!e) return null;
    const created = new Set(e.created ?? []);
    const touchedByOthers = (id: string) => [...(this.store.ents.get(id)?.values() ?? [])].some((c) => c.s > e.stamp && c.w !== this.writer);
    const kept = new Set([...created].filter(touchedByOthers));
    // a change that replaced things with new ones (a split, a join: originals deleted, parts made),
    // one of whose parts someone else has worked on since: undoing the rest would bring the
    // original back beside that part (counted twice). Nothing is undone then.
    const replaced = e.redo.some((op) => op[1] === 'del' && op[2] === true && !created.has(op[0]));
    if (kept.size && replaced) return { skipped: kept.size, refused: true };
    const ops: Op[] = [];
    let skipped = 0;
    // anything else this change made goes to the recycle bin - unless someone has worked on it since
    for (const id of created) { if (kept.has(id)) skipped++; else ops.push([id, 'del', true]); }
    // a field is put back unless it now holds something else than this change left there
    // (someone changed it since). Comparing values, not stamps, so undoing several of your
    // own changes to the same field in a row works. A drawn shape's outline (corners, arcs,
    // cut-outs) goes back whole or not at all.
    const did = new Map(e.redo.map((o) => [o[0] + '\u0000' + o[1], o[2]]));
    const changedSince = (op: Op) => {
      const c = this.store.cell(op[0], op[1]);
      const k = op[0] + '\u0000' + op[1];
      return !!c && c.s !== e.stamp && did.has(k) && c.v !== did.get(k);
    };
    const blockedGeom = geomConflicts(e.undo.filter((op) => !created.has(op[0])), changedSince);
    for (const op of e.undo) {
      if (created.has(op[0])) continue;
      if (changedSince(op) || (GEOM.has(op[1]) && blockedGeom.has(op[0]))) { skipped++; continue; }
      ops.push(op);
    }
    const b = ops.length ? this.commit(ops, 'Undo', { recordUndo: false }) : null;
    if (b) this.redoStack.push({ redo: e.redo, undo: e.undo, stamp: b.s, label: e.label, created: e.created });
    else if (ops.length) this.undoStack.push(e); // not written (closed / view only): keep it
    return { skipped };
  }

  redo(): { skipped: number } | null {
    if (this.closed || this.opts.readOnly) return null;
    const e = this.redoStack.pop();
    if (!e) return null;
    const ops: Op[] = [];
    const created = new Set(e.created ?? []);
    for (const id of created) ops.push([id, 'del', null]);
    const was = new Map(e.undo.map((o) => [o[0] + '\u0000' + o[1], o[2]]));
    const changedSince = (op: Op) => {
      const c = this.store.cell(op[0], op[1]);
      const k = op[0] + '\u0000' + op[1];
      return !!c && c.s !== e.stamp && was.has(k) && c.v !== was.get(k);
    };
    const blockedGeom = geomConflicts(e.redo.filter((op) => !created.has(op[0])), changedSince);
    let skipped = 0;
    for (const op of e.redo) {
      if (created.has(op[0])) continue;
      if (changedSince(op) || (GEOM.has(op[1]) && blockedGeom.has(op[0]))) { skipped++; continue; }
      ops.push(op);
    }
    const b = ops.length ? this.commit(ops, 'Redo', { recordUndo: false }) : null;
    if (b) this.undoStack.push({ redo: e.redo, undo: e.undo, stamp: b.s, label: e.label, created: e.created });
    else if (ops.length) this.redoStack.push(e);
    return { skipped };
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    let backoff = 1000;
    try {
      while (this.pending.length && !this.closed) {
        const n = Math.min(this.pending.length, 200);
        const chunk = this.pending.slice(0, n).join('');
        try {
          // the file must end where this session's last line ended: anything else (an append of an
          // earlier session of this PC that landed late, half a line) and a line written now would
          // be glued to it - start a fresh file instead
          const path = this.fs.join(this.journalsDir, this.segName);
          const probe = await this.fs.readFrom(path, this.segBytes, 1);
          // (a file of this session that is gone from the share: a new one, never writing at 0 of
          // a name others have read past)
          if (probe ? probe.size !== this.segBytes : this.segBytes > 0) { this.newSegment(); continue; }
          const bytes = new TextEncoder().encode(chunk).length;
          await this.fs.append(path, chunk);
          // what landed: the file must now end exactly after these lines. Not all there (a write the
          // share said was done), or more (a late piece of an earlier write glued on): the same lines
          // again in a fresh file - a line that did land is read once (same stamp)
          const after = await this.fs.readFrom(path, this.segBytes + bytes, 1);
          if (!after || after.size !== this.segBytes + bytes) { this.newSegment(); continue; }
          this.pending.splice(0, n);
          this.segBytes += bytes;
          this.saveMark();
          backoff = 1000;
          this.presDirty = true;
          this.writePresenceSoon(); // tell others promptly that this journal grew
          this.setStatus({ state: this.pending.length ? 'saving' : 'online', lastError: null, lastSyncAt: this.now() });
        } catch (e: any) {
          // A failed append may have left a partial line. Never write after it:
          // start a fresh journal segment for the retry.
          this.newSegment();
          this.setStatus({ state: 'offline', lastError: String(e?.message ?? e) });
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 10000);
        }
      }
    } finally {
      this.pumping = false;
      // closed while a write was still on its way: only now may another session use this file
      if (this.closed) SEGS_IN_USE.delete(this.fs.join(this.journalsDir, this.segName));
    }
    if (!this.pending.length) {
      this.writePresence();
      this.localChain = this.localChain
        .then(async () => {
          if (!this.pending.length) await this.local.writeAtomic(this.outboxPath, '');
        })
        .catch(() => {});
    }
  }

  // ---------- reading ----------
  private schedule() {
    if (this.closed || this.closing) return;
    this.timer = setTimeout(async () => {
      await this.tick();
      this.schedule();
    }, this.pollMs);
  }

  /** One sync cycle. Public so tests can drive it. */
  async tick(): Promise<void> {
    if (this.ticking || this.closed || this.closing) return;
    this.ticking = true;
    const changed = new Set<string>();
    const overwrites: Overwrite[] = [];
    try {
      const pres = await this.readPresence();
      for (const p of pres) {
        if (!p.seg || p.w === this.writer || !SEG_RE.test(p.seg)) continue;
        const known = this.segs.get(p.seg);
        if (!known || p.size > known.consumed) await this.readSeg(p.seg, changed, overwrites);
      }
      // the full scan opens every journal file: with a long history, less often (the presence
      // files above bring active writers' changes within a second anyway)
      const every = this.fullScanMs + (this.segs.size > 100 ? Math.min(55000, (this.segs.size - 100) * 20) : 0);
      if (mono() - this.lastFullScan >= every) await this.fullScan(false, changed, overwrites);
      this.checkFormat();
      if (this.status.state === 'offline' && !this.pending.length) this.setStatus({ state: 'online' });
      else this.setStatus({ lastSyncAt: this.now() });
    } catch (e: any) {
      this.setStatus({ state: 'offline', lastError: String(e?.message ?? e) });
    } finally {
      // what was applied before an error must still reach the screen (and its conflict notices)
      this.afterApply(changed, overwrites);
      this.ticking = false;
    }
  }

  private async fullScan(initial: boolean, changed = new Set<string>(), overwrites: Overwrite[] = []) {
    this.lastFullScan = mono();
    const ents = await this.fs.list(this.journalsDir);
    const names = ents.filter((e) => !e.isDir && e.name.endsWith('.log')).map((e) => e.name).sort();
    // one file that can't be read (a permission, a lock) must not stop the others: it is tried
    // again next time; only when none can be read is the share out of reach
    let failed = 0, lastErr: unknown = null;
    for (const n of names) {
      if (n === this.segName && !initial) continue;
      try { await this.readSeg(n, changed, overwrites); } catch (e) { failed++; lastErr = e; }
    }
    if (failed && failed >= names.length) throw lastErr;
    if (failed) this.setStatus({ lastError: `${failed} journal file${failed > 1 ? 's' : ''} could not be read: ${String((lastErr as any)?.message ?? lastErr)}` });
    // lines that were unreadable when first read (a write still landing): read them again a few times
    if (!initial) {
      for (const [n, st] of this.segs) {
        if (!st.bad?.length) continue;
        // a line still unreadable after the first 20 scans (a write landing very late on a slow share)
        // is tried now and then from there on (every 12th scan), never given up: the read position has
        // moved past it, so nothing else would ever read it again (BH-015)
        st.badTries = (st.badTries ?? 0) + 1;
        if (st.badTries > 20 && st.badTries % 12 !== 0) continue;
        const still: [number, number][] = [];
        for (const [a, b] of st.bad) {
          const r = await this.fs.readFrom(this.fs.join(this.journalsDir, n), a, b - a).catch(() => null);
          if (!r) { still.push([a, b]); continue; }
          const sp = splitBytes(r.data);
          for (const x of sp.batches) this.applyRead(x, changed, overwrites);
          if (sp.bad) still.push([a, b]);
        }
        st.bad = still.length ? still : undefined;
        if (!st.bad) st.badTries = 0;
      }
    }
    if (initial) this.emitChange(changed);
  }

  private applyRead(b: Batch, changed: Set<string>, overwrites: Overwrite[]) {
    this.clock.observe(b.s);
    const res = this.store.apply(b);
    res.changed.forEach((x) => changed.add(x));
    if (b.w !== this.writer) overwrites.push(...res.overwrites);
  }

  private async readSeg(name: string, changed: Set<string>, overwrites: Overwrite[]) {
    let st = this.segs.get(name);
    if (!st) {
      st = { consumed: 0 };
      this.segs.set(name, st);
    }
    const path = this.fs.join(this.journalsDir, name);
    // a torn tail seen before: only its size is checked until the file changes
    if (st.tornAt !== undefined) {
      const probe = await this.fs.readFrom(path, st.consumed, 1);
      if (!probe || probe.size === st.tornAt) return;
      st.tornAt = undefined;
    }
    let max = MAX_READ;
    for (;;) {
      const r = await this.fs.readFrom(path, st.consumed, max);
      // the file is shorter than what was read of it: it was replaced (an older copy put back, emptied
      // and written again). Read again from the start - a line read twice counts once (same stamp)
      if (r && r.size < st.consumed) {
        st.consumed = 0;
        st.bad = undefined;
        st.badTries = 0;
        st.tornAt = undefined;
        continue;
      }
      if (!r || !r.data.length) return;
      const { batches, consumed, badRanges } = splitBytes(r.data);
      // one line longer than the read window (written by an older version): read a bigger window
      if (consumed === 0 && r.data.length >= max && max < 512 * 1024 * 1024) { max *= 4; continue; }
      if (badRanges.length) {
        this.status.corruptLines += badRanges.length;
        const base = st.consumed;
        st.bad = [...(st.bad ?? []), ...badRanges.map(([a, b]) => [base + a, base + b] as [number, number])].slice(-200);
        st.badTries = 0;
      }
      for (const b of batches) this.applyRead(b, changed, overwrites);
      st.consumed += consumed;
      // what is left after the last full line: a write still landing, or one that never will
      if (r.data.length < max && consumed < r.data.length) st.tornAt = r.size;
      // a "line" bigger than the largest window (damaged, or not ours): left alone until the file changes,
      // not read again every second
      else if (consumed === 0 && r.data.length >= max) st.tornAt = r.size;
      if (consumed === 0 || r.data.length < max) return;
      max = MAX_READ;
    }
  }

  private afterApply(changed: Set<string>, overwrites: Overwrite[]) {
    const t = this.now();
    for (const o of overwrites) {
      if (o.prev.w === this.writer && o.next.w !== this.writer && t - o.prev.t < CONFLICT_WINDOW_MS && o.prev.v !== o.next.v && !MERGED_FIELDS.has(o.field)) {
        const n: ConflictNotice = { eid: o.eid, field: o.field, byUser: o.next.u, value: o.next.v, yourValue: o.prev.v };
        for (const f of this.conflictL) f(n);
      }
    }
    this.emitChange(changed);
  }

  // ---------- presence ----------
  private presencePath() {
    // the whole writer id matters (two sessions of one person on one PC): name + a hash of it
    return this.fs.join(this.presenceDir, safeName(this.opts.user).slice(0, 24) + '-' + crc32hex(this.writer) + '.json');
  }

  setFocus(f: Partial<Pick<PresenceInfo, 'sel' | 'col' | 'editing' | 'detail' | 'sheet' | 'cx' | 'cy'>>) {
    const next = { ...this.focus, ...f };
    if (JSON.stringify(next) === JSON.stringify(this.focus)) return;
    this.focus = next;
    this.presDirty = true;
    this.writePresenceSoon();
  }

  private presSoon: ReturnType<typeof setTimeout> | null = null;
  private writePresenceSoon() {
    if (this.presSoon || this.closed || this.closing) return;
    this.presSoon = setTimeout(() => {
      this.presSoon = null;
      this.writePresence();
    }, 250);
  }

  private heartbeat() {
    if (this.closed || this.closing) return;
    this.hbTimer = setTimeout(() => {
      this.presDirty = true;
      this.writePresence();
      this.heartbeat();
    }, this.heartbeatMs);
  }

  private async writePresence() {
    if (this.closed || this.closing || this.presWriting || !this.presDirty) return;
    this.presWriting = true;
    this.presDirty = false;
    try {
      const info: PresenceInfo = {
        w: this.writer, u: this.opts.user, a: this.opts.account, host: this.opts.host, color: this.color,
        seq: ++this.presSeq, ts: this.now(),
        seg: this.segBytes > 0 ? this.segName : null, size: this.segBytes,
        ...this.focus,
        ...(this.opts.quiet ? { gone: true } : {}),
      };
      await this.fs.writeAtomic(this.presencePath(), JSON.stringify(info));
    } catch {
      this.presDirty = true;
    } finally {
      this.presWriting = false;
    }
  }

  private async readPresence(): Promise<PresenceInfo[]> {
    const ents = await this.fs.list(this.presenceDir);
    // an empty list because the folder is gone (the shared drive dropped, the folder was moved)
    // is not "nobody here": the screen must say the server is out of reach
    if (!ents.length && !(await this.fs.exists(this.opts.projectDir))) throw new Error('The project folder is not reachable.');
    const t = mono();
    const wall = this.now();
    const seen = new Set<string>();
    for (const e of ents) {
      if (e.isDir || !e.name.endsWith('.json')) continue;
      const txt = await this.fs.readText(this.fs.join(this.presenceDir, e.name)).catch(() => null);
      if (!txt) continue;
      let info: PresenceInfo;
      try { info = JSON.parse(txt); } catch { continue; }
      if (!info || info.w === this.writer) continue;
      seen.add(info.w);
      const prev = this.others.get(info.w);
      const file = this.fs.join(this.presenceDir, e.name);
      if (!prev) {
        // first sight: trust its clock roughly, then rely on seq changes ("not seen changing" is
        // -Infinity: the monotonic clock starts near 0 when the window opens)
        const fresh = !info.gone && Math.abs(wall - info.ts) < 60000;
        this.others.set(info.w, { info, lastSeq: info.seq, changedAt: fresh ? t : -Infinity, seenAt: t, file });
      } else if (info.seq !== prev.lastSeq) {
        this.others.set(info.w, { info, lastSeq: info.seq, changedAt: info.gone ? -Infinity : t, seenAt: prev.seenAt, file });
      } else {
        prev.info = info;
      }
    }
    for (const k of [...this.others.keys()]) if (!seen.has(k)) this.others.delete(k);
    // presence files of apps that crashed long ago: remove them (anyone may)
    for (const [w, x] of this.others) {
      if (t - Math.max(x.changedAt, x.seenAt) > PRESENCE_DEAD_MS) { this.fs.remove(x.file).catch(() => {}); this.others.delete(w); }
    }
    const list = this.activeUsers();
    for (const f of this.presenceL) f(list);
    return [...this.others.values()].map((x) => x.info);
  }

  activeUsers(): PresenceInfo[] {
    const t = mono();
    return [...this.others.values()].filter((x) => t - x.changedAt < PRESENCE_STALE_MS).map((x) => x.info);
  }
}
