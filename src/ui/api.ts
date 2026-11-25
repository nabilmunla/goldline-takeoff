import type { FsApi } from '../engine/types';

export interface AppInfo {
  version: string;
  user: string;
  winUser: string;
  host: string;
  profile: string;
  dataRoot: string | null;
  localDir: string;
  platform: string;
  theme: 'system' | 'light' | 'dark';
  lastUsername: string | null;
  /** where the accounts' backups were kept when last signed in on this PC (to restore them from) */
  accBackups?: string | null;
  /** the team folder those accounts' backups belong to (0.23.1; not offered for another folder) */
  accBackupsFor?: string | null;
  /** the window crashed and was reloaded just before this start */
  recovered?: { at: number; reason: string } | null;
  /** this PC's settings file was found damaged at this start: what was done about it (said once) */
  settingsNote?: string | null;
}

/** updates from GitHub (electron/updater.cjs): what the main process knows, sent on every change */
export interface UpdateSnapshot {
  state: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'installing' | 'ready' | 'setup' | 'error' | 'unreachable' | 'empty';
  /** this copy's version */
  version: string;
  /** the newer version on offer (or downloaded, or needing the setup) */
  available?: string;
  notes?: string[];
  /** download size in bytes; pct 0..1 while downloading */
  size?: number;
  pct?: number;
  err?: string;
  /** a word on the offer (it did not work on this PC before) */
  note?: string;
  /** the card should open by itself (a background check never pushes one the person put off) */
  show?: boolean;
  /** when GitHub was last asked (ms) */
  checked: number;
  /** the release page (a version that needs the setup) */
  page: string;
  source: string;
}

export interface CountState { available: boolean; ask: boolean; on: boolean }

export interface ReportInfo {
  version: string;
  electron: string;
  os: string;
  host: string;
  winUser: string;
  profile: string;
  appDir: string;
  localDir: string;
  memoryMB: number;
  uptimeMin: number;
  settings: Record<string, unknown>;
  log: string;
}

export interface FileStat {
  size: number;
  mtime: number;
  isDir: boolean;
}

export interface PdfFound {
  path: string;
  rel: string;
  size: number;
  mtime: number;
  /** only on a last entry: the folder could not be listed whole (why) */
  truncated?: string;
}

export interface FilesApi {
  stat(path: string): Promise<FileStat | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
  /** `under`: only make the file's folders below this folder, and only if it is there (files on the share) */
  writeBytes(path: string, data: Uint8Array, under?: string): Promise<void>;
  listPdfs(dir: string): Promise<PdfFound[]>;
  appFile(rel: string): Promise<Uint8Array | null>;
  /** a whole file copied (temp + rename) */
  copy(src: string, dst: string): Promise<void>;
  /** an empty folder removed (one with anything in it stays) */
  rmdir(path: string): Promise<void>;
}

/** a drawing as the PDF engines read it: a file, or a file plus changes after its first `size` bytes */
export interface FileSrc { path: string; size?: number; delta?: string; mtime?: number }

/** a drawing read once through (fingerprinted; a copy made on this PC when asked) */
export interface Fetched {
  /** SHA-256 of the bytes read */
  hash: string;
  size: number;
  mtime: number;
  /** where this PC's copy is now ('' when none was made) */
  file: string;
}

export interface HeavyAnswer {
  result: { pages: number[]; strokesIn?: number; strokesOut?: number; delta?: string; base?: number; full?: string; ms: number } | null;
  error: string;
}

export interface PdfApi {
  /** start (again) the named engines: each answers on a port that arrives as a 'gt-pdf-port' message */
  start(names: string[], token?: string): Promise<boolean>;
  /** a fresh engine in place of this one (its memory has grown large) */
  restart(name: string): Promise<boolean>;
  /** these engines are not needed for now: their processes end */
  stop(names: string[]): Promise<boolean>;
  /**
   * Read a drawing through once: its fingerprint, and (mode 'keep') this PC's copy by fingerprint
   * in `<cache>/pdf`, (mode 'temp') a copy in `<cache>/tmp` to be dropped after, ('hash') no copy.
   */
  fetch(src: string, cache: string, mode: 'keep' | 'temp' | 'hash' | 'replace', onProgress?: (done: number, total: number) => void, onStart?: (id: string) => void): Promise<Fetched>;
  /**
   * monster sheets' line work simplified (see engine/pdfhost/heavy.ts), one at a time; `bg`: for the
   * background preparation - the sheet on screen's go first
   */
  heavy(src: FileSrc, outBase: string, mode: 'check' | 'force', pages?: number[], bg?: boolean): Promise<HeavyAnswer>;
  /** a temp copy made by fetch is not needed any more */
  drop(path: string): Promise<boolean>;
  /** a read given up on (its id from fetch's onStart): stopped */
  cancel(id: string): Promise<boolean>;
  /** this PC's copy found damaged: set aside (<copy>.bad, kept a day) */
  setAside(path: string): Promise<boolean>;
  /** a file in this PC's drawing cache was used now (the cache trims what was used longest ago) */
  touch?(path: string): Promise<boolean>;
}

export interface GtBridge {
  fs: FsApi;
  files: FilesApi;
  pdf: PdfApi;
  pickPdfs(opts?: { title?: string }): Promise<string[]>;
  pickDir(opts?: { title?: string; start?: string | null; remember?: boolean; create?: boolean }): Promise<string | null>;
  saveFile(opts: { title?: string; name: string; dir?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  openPath(p: string): Promise<string>;
  /** mapped network drives on this PC: 'X:' -> '\\\\server\\share' */
  drives(): Promise<Record<string, string>>;
  info(): Promise<AppInfo>;
  setSettings(patch: Record<string, unknown>): Promise<boolean>;
  pickFolder(start?: string | null): Promise<string | null>;
  /** absolute paths of the chosen files (empty if cancelled) */
  pickFiles(opts?: { title?: string }): Promise<string[]>;
  setTheme(mode: 'light' | 'dark'): Promise<boolean>;
  onClosing(cb: () => void): void;
  closed(): void;
  /** the window asks before closing: no forced close meanwhile */
  closeHold?(): void;
  /** the answer was "keep the app open" */
  closeCancelled?(): void;
  /** after asking, the window goes on closing: the forced close is armed again */
  closeResume?(): void;
  /** the first screen showed: this version starts properly on this PC */
  healthy?(): void;
  /** close (the normal way) and start again: after an update whose close was called off */
  restart?(): void;
  log(line: string): void;
  /** v0.16.4 the main window's drawing area on the screen (DIP), for a sheet tab dragged back in */
  win?: { content(): Promise<{ x: number; y: number; width: number; height: number } | null> };
  update: {
    get(): Promise<UpdateSnapshot>;
    /** ask GitHub now (the card shows the answer) */
    check(): Promise<UpdateSnapshot>;
    /** download, check (SHA-256 against the signed latest.json) and unpack the offered version */
    download(): Promise<UpdateSnapshot>;
    cancel(): Promise<UpdateSnapshot>;
    later(): Promise<boolean>;
    /** close the normal way (the open project sends its last changes) and start the new version */
    restart(): Promise<boolean>;
    /** the release page in the browser (a version that needs the setup) */
    openPage(): Promise<boolean>;
    onState(cb: (s: UpdateSnapshot) => void): () => void;
  };
  report(): Promise<ReportInfo>;
  /** the anonymous user count (electron/counter.cjs): available = a receiver is set; ask = the pop-up isn't answered yet */
  count: { get(): Promise<CountState>; set(on: boolean): Promise<CountState> };
  /** the problem report sent to the developer (electron/reports.cjs): only with a receiver; send() posts exactly what preview() returned */
  webReport: {
    available(): Promise<boolean>;
    preview(text: string, ctx: { screen: string; errors: string[]; words: string[] }): Promise<string>;
    send(shown: string): Promise<{ state: 'sent' | 'failed' | 'local' | 'changed'; err: string }>;
  };
  clipboard(text: string): boolean;
}

declare global {
  interface Window {
    gt: GtBridge;
  }
}

export const gt = (): GtBridge => window.gt;

/** the last errors of this window, for a problem report */
export const recentErrors: string[] = [];
const keepError = (t: string) => { recentErrors.push(new Date().toISOString() + ' ' + t.slice(0, 2000)); if (recentErrors.length > 30) recentErrors.shift(); };
window.addEventListener('error', (e) => {
  const t = String(e.error?.stack ?? e.message);
  keepError(t);
  try { window.gt?.log(t); } catch { /* ignore */ }
});
window.addEventListener('unhandledrejection', (e) => {
  const t = 'unhandled: ' + String((e.reason as any)?.stack ?? e.reason);
  keepError(t);
  try { window.gt?.log(t); } catch { /* ignore */ }
});
