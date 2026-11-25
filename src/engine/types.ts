// Core types shared by the sync engine, the BOQ model and the UI.
// The engine never touches Node or Electron directly: all file access goes
// through FsApi, so the same code runs in the app, in tests and in stress runs.

export type Value = string | number | boolean | null;

/** One field change: [entityId, field, value] */
export type Op = [string, string, Value];

/**
 * A batch is one atomic line in a journal file. All ops in a batch share one
 * stamp and are applied all-or-nothing (the line either passes its checksum or
 * is ignored entirely).
 */
export interface Batch {
  /** Hybrid-logical-clock stamp, unique per writer, sortable as a string */
  s: string;
  /** Writer (one running app instance) */
  w: string;
  /** User display name */
  u: string;
  /** Writer's wall-clock time (ms) - informational only, never used for ordering */
  t: number;
  /** Field changes */
  o: Op[];
  /** Optional label, e.g. "Undo", "Created project" */
  m?: string;
  /** Signed-in account (username) that made the change */
  a?: string;
}

export interface FsStat {
  name: string;
  isDir: boolean;
}

export interface ReadResult {
  size: number;
  data: Uint8Array;
}

export interface FsApi {
  join(...parts: string[]): string;
  mkdirp(path: string): Promise<void>;
  /** create one folder, false if it exists already (optional: older bridges don't have it) */
  mkdirExcl?(path: string): Promise<boolean>;
  list(dir: string): Promise<FsStat[]>;
  readText(path: string): Promise<string | null>;
  /** Opens the file fresh (bypasses stale metadata caches), reads from offset. null if missing. */
  readFrom(path: string, offset: number, maxBytes: number): Promise<ReadResult | null>;
  /** Open for append, write, flush to disk/server, close. */
  append(path: string, text: string): Promise<void>;
  /** Write to temp file then rename over target (falls back to direct write). */
  writeAtomic(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface Cell {
  v: Value;
  /** stamp of the batch that set it */
  s: string;
  /** user who set it */
  u: string;
  /** writer who set it */
  w: string;
  /** wall time (informational) */
  t: number;
  /** account username */
  a?: string;
}

export interface HistEntry {
  s: string;
  u: string;
  w: string;
  t: number;
  f: string;
  v: Value;
  m?: string;
  a?: string;
  /** true if this change is the one currently in effect */
  live?: boolean;
}

export interface ProjectMeta {
  /** as written in the file: an id of today (engine/legacy.ts FORMAT) or one an earlier version wrote - read it with formatOf() */
  format: string;
  formatVersion: number;
  id: string;
  name: string;
  created: number;
  createdBy: string;
  /** account username of the owner (projects created from v0.4 on) */
  owner?: string;
}

export interface PresenceInfo {
  w: string;
  u: string;
  a?: string;
  host: string;
  color: string;
  seq: number;
  ts: number;
  /** current journal segment and bytes written - lets others read only what changed */
  seg: string | null;
  size: number;
  /** written once more when the session closes (its last size): read it, don't show the person */
  gone?: boolean;
  /** selected row */
  sel: string | null;
  /** selected column */
  col: string | null;
  /** currently typing in a cell */
  editing: boolean;
  /** item open in the details panel (soft "working on this" warning) */
  detail: string | null;
  /** take-off: sheet being looked at (dwg id + '.' + page) and pointer position on it (sheet points) */
  sheet?: string | null;
  cx?: number | null;
  cy?: number | null;
}

export type SyncState = 'connecting' | 'online' | 'saving' | 'offline';

export interface SyncStatus {
  state: SyncState;
  pending: number;
  lastError: string | null;
  lastSyncAt: number;
  corruptLines: number;
  segments: number;
}
