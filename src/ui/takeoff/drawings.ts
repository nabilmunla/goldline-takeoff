// Drawings stay where the documents were received (often a read-only drive).
// The take-off project only remembers where each PDF is and a fingerprint of its
// contents (SHA-256), so it can tell when a file moved or was replaced by a revision.
//
// Speed: each PC keeps a copy of every PDF it has opened, by fingerprint, so a big
// drawing crosses the network once per PC per revision. Rendered previews are kept
// on this PC and in the take-off project folder, so whoever opens a sheet first pays
// for its preview and everyone else gets it at once.
//
// Massive drawings (v0.12.5, as the PDF Editor does it): a drawing is never read whole into the
// window. The app process reads it through once - fingerprint and this PC's copy in one pass - and
// the PDF engines (background processes) read that copy on demand, only what the pages they draw
// need. Monster sheets (millions of separate little strokes) get their line work simplified once
// per PC (heavy.ts), kept beside the copy as changes after it.
import { gt, type FileStat, type PdfFound, type FileSrc, type Fetched } from '../api';
import type { Drawing } from '../../engine/qto/model';
import type { Op } from '../../engine/types';
import { readSetPage, readSet, type PageScan, type SetPage } from '../../engine/qto/revisions';
import { crc32hex } from '../../engine/crc32';
import { randomId } from '../../engine/ids';
import { imgWorker, type PdfEngine, type PageSize } from './pdfengine';
import { fileKind, asPdf } from './imagepdf';

const sep = (p: string) => (p.includes('\\') ? '\\' : '/');
const join = (...parts: string[]) => gt().fs.join(...parts);

export function baseName(p: string) {
  return p.split(/[\\/]/).pop() ?? p;
}
function dirName(p: string) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

export { sheetFromFile, groupFromRel } from '../../engine/qto/revisions';

/** X:\\foo -> \\\\server\\share\\foo when X: is a mapped network drive on this PC */
export function toUnc(path: string, drives: Record<string, string>): string {
  const m = path.match(/^([A-Za-z]:)(.*)$/);
  if (!m) return path.startsWith('\\\\') ? path : '';
  const share = drives[m[1].toUpperCase()];
  return share ? share.replace(/\\+$/, '') + m[2] : '';
}

/** \\\\server\\share\\foo -> X:\\foo when this PC maps that share to a letter */
export function fromUnc(unc: string, drives: Record<string, string>): string {
  if (!unc.startsWith('\\\\')) return '';
  for (const [letter, share] of Object.entries(drives)) {
    const s = share.replace(/\\+$/, '');
    if (unc.toLowerCase().startsWith(s.toLowerCase() + '\\') || unc.toLowerCase() === s.toLowerCase()) return letter + unc.slice(s.length);
  }
  return '';
}

// asked again after a while, and at once while it is empty (at sign-in Windows may not have
// reconnected the network drives yet: an empty answer must not stick for the whole session)
let drivesCache: { at: number; p: Promise<Record<string, string>> } | null = null;
export function drives(): Promise<Record<string, string>> {
  const now = Date.now();
  if (!drivesCache || now - drivesCache.at > 5 * 60000) {
    const p = gt().drives().catch(() => ({}));
    drivesCache = { at: now, p };
    p.then((r) => { if (!Object.keys(r).length && drivesCache?.p === p) drivesCache = null; });
  }
  return drivesCache.p;
}

/** Individually picked files -> PdfFound (group = the folder they are in) */
export async function statPicked(paths: string[]): Promise<PdfFound[]> {
  const out: PdfFound[] = [];
  for (const p of paths) {
    const st = await gt().files.stat(p);
    if (!st || st.isDir) continue;
    const parent = dirName(p);
    const parentName = baseName(parent);
    const grand = baseName(dirName(parent));
    const folder = /^(pdf|pdfs|cad)$/i.test(parentName) ? grand : parentName;
    out.push({ path: p, rel: folder + sep(p) + baseName(p), size: st.size, mtime: st.mtime });
  }
  return out;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Reads of drawings on the server, at most two at a time and never waited on for ever: a server
 * that stops answering mid-read leaves the sheet with a message (and the rest of the app working).
 */
type Slot = { at: number; what: string; free: (why?: 'give way' | 'too long') => void };
type Pool = { max: number; busy: Set<Slot>; queue: (() => void)[] };
// what you open has its own two; the background preparation one (it never makes you wait)
const FRONT: Pool = { max: 2, busy: new Set(), queue: [] };
const BACK: Pool = { max: 1, busy: new Set(), queue: [] };
const SLOW_MS = 60000;
/** a read busy this long when another sheet is wanted is left to finish on its own (a server not answering) */
const GIVE_WAY_MS = 4000;
async function onServer<T>(what: string, f: () => Promise<T>, ms = SLOW_MS, pool = FRONT, giveUp?: (why: 'give way' | 'too long') => void): Promise<T> {
  if (pool.busy.size >= pool.max) {
    const oldest = [...pool.busy].sort((a, b) => a.at - b.at)[0];
    if (pool === FRONT && oldest && performance.now() - oldest.at > GIVE_WAY_MS) { gt().log(`reading ${what}: ${oldest.what} gives way`); oldest.free('give way'); }
    else await new Promise<void>((r) => pool.queue.push(r));
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  // the slot is given back when the read ends or is given up on (a read stuck for good keeps
  // nothing else waiting); a read given up on may be stopped (v0.12.5: one nobody waits for no
  // longer runs on, reading a whole big drawing)
  let freed = false;
  let ended = false;
  const slot: Slot = { at: performance.now(), what, free: (why) => { if (freed) return; freed = true; pool.busy.delete(slot); pool.queue.shift()?.(); if (why && !ended) giveUp?.(why); } };
  pool.busy.add(slot);
  try {
    const work = f();
    work.finally(() => { ended = true; slot.free(); }).catch(() => {});
    return await Promise.race([work, new Promise<never>((_, rej) => { timer = setTimeout(() => { slot.free('too long'); rej(new Error(`The server did not answer reading ${what} (${Math.round(ms / 1000)} s). Check the network, then open the sheet again.`)); }, ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface Located {
  path: string;
  stat: FileStat;
}

/** Where is this drawing now? Its own path, the same share by another drive letter, or nowhere. */
export async function locate(d: Pick<Drawing, 'path' | 'unc'>, bg = false): Promise<Located | null> {
  const f = gt().files;
  const dr = await drives();
  const tries: string[] = [];
  if (d.unc) {
    // the share it was brought in from comes first: on this PC its drive letter may be another
    // share altogether (X: is the tender drive here, the archive there)
    const local = fromUnc(d.unc, dr);
    if (local) tries.push(local);
    tries.push(d.unc);
    const here = toUnc(d.path, dr);
    if (!/^[A-Za-z]:/.test(d.path) || !here || here.toLowerCase() === d.unc.toLowerCase()) tries.push(d.path);
    else if (!Object.keys(dr).length) tries.push(d.path);
  } else tries.push(d.path);
  for (const p of tries) {
    if (!p) continue;
    const st = await onServer(baseName(p), () => f.stat(p), 30000, bg ? BACK : FRONT).catch(() => null);
    if (st && !st.isDir) return { path: p, stat: st };
  }
  return null;
}

export interface Loaded {
  /** fingerprint of the bytes now on screen */
  key: string;
  pages: PageSize[];
  /** where it was read from */
  path: string;
  /** what the engines read: this PC's copy (with its simplified line work, a picture made a PDF) */
  src: FileSrc;
  /** this PC's copy as it is (what monster pages are simplified from) */
  file: string;
  /** the file is not the one that was measured (a revision?) */
  changed: boolean;
  /** first time this drawing was opened by anyone: record its fingerprint */
  ops: Op[];
  fromCache: boolean;
  /** the file is no longer where it was (deleted, moved): this PC's copy is shown */
  gone?: boolean;
  /** the file there now will not open (damaged, not a PDF): this PC's copy of the measured one is shown */
  bad?: string;
  /** pages whose line work was simplified on this PC (monster sheets) */
  simplified?: number[];
  /** a copy made only for this use (the background preparation): let go of it when done */
  dispose?: () => void;
}

const cacheDir = (localDir: string, ...p: string[]) => join(localDir, 'qto-cache', ...p);

/** what may slow an opening down, told as it happens ("Reading… 45 %") */
export type Progress = (text: string) => void;

/** drawings at least this big are looked at for monster pages (none smaller can hold one) */
const HEAVY_MIN = 30e6;
/** the look, once per drawing per PC (the background preparation and the sheet may ask at once) */
const heavyJobs = new Map<string, { p: Promise<HeavyRecord>; bg: boolean; ask: () => void }>();

interface HeavyRecord { v: 1; pages: number[]; strokesIn?: number; strokesOut?: number; delta?: string; base?: number; full?: string; at: number; error?: string; tries?: number }

async function readHeavy(localDir: string, key: string): Promise<HeavyRecord | null> {
  const t = await gt().fs.readText(cacheDir(localDir, 'heavy', key + '.json')).catch(() => null);
  if (!t) return null;
  try { const r = JSON.parse(t); return r && r.v === 1 && Array.isArray(r.pages) ? r : null; } catch { return null; }
}

/** the file as the engines should read it: with its simplified line work, if it has any */
async function srcFromRecord(localDir: string, key: string, file: string, size: number, r: HeavyRecord): Promise<FileSrc | null> {
  if (!r.pages.length) return { path: file };
  // (used now: the cache trims what was used longest ago)
  const used = (p: string) => { gt().pdf.touch?.(p).catch(() => {}); gt().pdf.touch?.(cacheDir(localDir, 'heavy', key + '.json')).catch(() => {}); };
  if (r.delta && r.base === size) {
    const d = cacheDir(localDir, 'heavy', r.delta);
    if (await gt().fs.exists(d).catch(() => false)) { used(d); return { path: file, size: r.base, delta: d }; }
  }
  if (r.full) {
    const f = cacheDir(localDir, 'heavy', r.full);
    if (await gt().fs.exists(f).catch(() => false)) { used(f); return { path: f }; }
  }
  return null; // its files are gone: look again
}

/** a check that failed (stopped, not enough memory, the disk full) is tried again at the next opening,
 *  then - failing again - after this long */
const RETRY_FAILED_MS = 3600000;

/**
 * A drawing of 30 MB or more is looked at once on this PC: pages of millions of separate little
 * strokes (they run a drawing engine out of memory) get their line work simplified - drawn the same.
 * `force`: pages that did take the engines down, simplified with a lower bar - every one of them, or
 * it says so. `bg`: asked for by the background preparation (waits behind the sheet on screen's).
 */
export async function heavySrc(localDir: string, key: string, file: string, size: number, progress?: Progress, force?: number[], bg = false): Promise<{ src: FileSrc; pages: number[] }> {
  // (looked at before - or simplified on request, a small file too: the record says so)
  const known = await readHeavy(localDir, key);
  const fresh = known && !(known.error && ((known.tries ?? 1) < 2 || Date.now() - known.at > RETRY_FAILED_MS));
  if (known && fresh && !force?.length) {
    const src = await srcFromRecord(localDir, key, file, size, known);
    if (src) return { src, pages: known.pages };
  }
  if (!force?.length && size < HEAVY_MIN) return { src: { path: file }, pages: [] };
  const job = key + (force?.length ? '#' + force.join(',') : '');
  let have = heavyJobs.get(job);
  if (have && have.bg && !bg) {
    // asked for by the background preparation, now wanted for the sheet on screen: it goes first
    have.bg = false;
    have.ask();
  }
  let p = have?.p;
  // (joined: say what it waits for - not the reading it did before)
  if (p) progress?.(force?.length ? 'Simplifying the line work of this sheet…' : 'Checking this big drawing (once on this PC)…');
  if (!p) {
    const base = cacheDir(localDir, 'heavy', key);
    const pages = force?.length ? [...new Set([...(known?.pages ?? []), ...force])] : undefined;
    const ask = (asBg: boolean) => gt().pdf.heavy({ path: file }, base, force?.length ? 'force' : 'check', pages, asBg);
    // (one job for everyone who asks at once; it gives the record - each caller makes its own source
    // from its own copy: the background preparation's is a temp copy that goes when it is done)
    p = (async () => {
      progress?.(force?.length ? 'Simplifying the line work of this sheet…' : 'Checking this big drawing (once on this PC)…');
      await gt().fs.mkdirp(cacheDir(localDir, 'heavy'));
      const a = await ask(bg);
      const r = a.result;
      if (!r) gt().log('heavy check of ' + key.slice(0, 12) + ' failed: ' + a.error);
      else if (r.pages.length) gt().log(`simplified the line work of ${r.pages.length} page(s) of ${key.slice(0, 12)}: ${r.strokesIn} strokes -> ${r.strokesOut}, ${Math.round(r.ms / 100) / 10} s`);
      if (force?.length) {
        // every page asked for, or it says which could not be (the toast must not claim it was done)
        const missed = force.filter((pg) => !r?.pages.includes(pg));
        if (missed.length) throw new Error(a.error ? 'The line work could not be simplified (' + a.error + ').' : "This sheet's drawing can't be simplified (it isn't made of separate line pieces, or it uses transparency).");
      }
      const rec: HeavyRecord = r
        ? { v: 1, pages: r.pages, strokesIn: r.strokesIn, strokesOut: r.strokesOut, delta: r.delta ? baseName(r.delta) : undefined, base: r.base, full: r.full ? baseName(r.full) : undefined, at: Date.now() }
        : known && !known.error ? known : { v: 1, pages: [], at: Date.now(), error: a.error || 'failed', tries: (known?.error ? known.tries ?? 1 : 0) + 1 };
      // (a failed check is kept with its error: looked at again after an hour, not at every opening)
      await gt().fs.writeAtomic(cacheDir(localDir, 'heavy', key + '.json'), JSON.stringify(rec)).catch(() => {});
      return rec;
    })();
    // (main joins the same job asked for again: only its order changes)
    heavyJobs.set(job, { p, bg, ask: () => { ask(false).catch(() => {}); } });
    p.finally(() => heavyJobs.delete(job)).catch(() => {});
  }
  const rec = await p;
  return { src: (await srcFromRecord(localDir, key, file, size, rec)) ?? { path: file }, pages: rec.pages };
}

/**
 * A local file (this PC's copy) made ready for the engines: a picture named .pdf becomes a PDF
 * (kept beside the copies), a monster sheet gets its line work simplified; then opened.
 */
async function openLocal(engine: PdfEngine, key: string, file: string, size: number, localDir: string, progress?: Progress, bg = false, again?: () => Promise<{ file: string; size: number } | null>): Promise<{ pages: PageSize[]; src: FileSrc; simplified: number[] }> {
  const head = await gt().fs.readFrom(file, 0, 1024);
  if (!head) throw Object.assign(new Error('gone'), { gone: true });
  const kind = fileKind(head.data);
  if (kind !== 'pdf') {
    if (!['png', 'jpeg', 'gif', 'bmp', 'webp'].includes(kind) || !head.size) await asPdf(head.data); // says what it is instead
    const conv = cacheDir(localDir, 'conv', key + '.pdf');
    if (!(await gt().fs.exists(conv).catch(() => false))) {
      progress?.('Turning this picture into a sheet…');
      const b = await gt().files.readBytes(file);
      if (!b) throw Object.assign(new Error('gone'), { gone: true });
      const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      const r = await imgWorker('asPdf', { data: buf }, [buf]);
      await gt().files.writeBytes(conv, new Uint8Array(r.pdf));
    }
    const pages = await engine.load(key, { path: conv });
    engine.converted.set(key, kind);
    return { pages, src: { path: conv }, simplified: [] };
  }
  const h = await heavySrc(localDir, key, file, size, progress, undefined, bg);
  // read again after an engine restart if the copy has gone meanwhile (trimmed, dropped): made again
  // from the server when it still has those bytes
  const reget = again ? async () => { const g = await again(); return g ? (await heavySrc(localDir, key, g.file, g.size, undefined, undefined, bg)).src : null; } : undefined;
  const pages = await engine.load(key, h.src, reget);
  return { pages, src: h.src, simplified: h.pages };
}

/** reads from the server for this PC's copy, by path: one at a time per file */
interface KeepRead { p: Promise<Fetched>; says: Set<Progress>; wants: Set<() => boolean>; fid: string; handedOver: boolean; done: Fetched | null; stopped: boolean; tooLong?: boolean }
const keepReads = new Map<string, KeepRead>();
/** how long one read of a drawing may take before it is given up (tests shorten it) */
export const readLimits = { ms: 30 * 60000 };
/** the background preparation's reads for a temp copy, by path: one the sheet on screen takes over */
const tempReads = new Map<string, KeepRead>();

/** drawings whose file itself will not open (not this PC's copy of it): this session */
const brokenAtSource = new Set<string>();

/** two file dates the same (to the millisecond: one may have been kept with a fraction of one) */
export const sameTime = (a: number | null | undefined, b: number | null | undefined) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1;

/** an error that says the file itself is bad (not that an engine stopped, or the file was held) */
export const damagedCopy = (e: unknown) => /not a PDF or is damaged|could not be read|This file is empty|This is not a PDF|Could not open the PDF \(error [13]\)/.test(String((e as Error)?.message ?? e));

const pct = (done: number, total: number) => (total > 0 ? ' ' + Math.min(99, Math.floor((done / total) * 100)) + ' %' : '');

/**
 * Get a drawing on screen, as fast as possible:
 * unchanged file + copy on this PC -> the local copy; otherwise read it from the server once
 * (its fingerprint and this PC's copy in one pass), then the copy.
 */
export async function loadDrawing(d: Pick<Drawing, 'id' | 'path' | 'unc' | 'hash' | 'size' | 'mtime'> & { fp?: number }, localDir: string, engine: PdfEngine, opts: { cache?: boolean; exact?: boolean; known?: string[]; bg?: boolean; progress?: Progress; wanted?: () => boolean } = {}): Promise<Loaded | { missing: true; replaced?: boolean }> {
  const files = gt().files;
  const loc = await locate(d, opts.bg);
  // (dates within a millisecond: 0.12.5's first builds kept them to a fraction of one)
  const same = !!loc && !!d.hash && loc.stat.size === d.size && sameTime(loc.stat.mtime, d.mtime);
  // an earlier revision (compare, view) must be exactly those bytes: this PC's copy by fingerprint
  // first - its path may hold a newer file now ("use the new version" kept the same path)
  const cp = d.hash ? cacheDir(localDir, 'pdf', d.hash + '.pdf') : '';
  /** the copy is bad: set aside (kept a day - it may be the only one) so a good one can take its place */
  let replaceCopy = false;
  const setAside = async () => {
    replaceCopy = true;
    await gt().pdf.setAside(cp).catch(() => false);
  };
  // made again from the server if this PC's copy goes while the sheet is open (trimmed): only if the
  // server still has exactly those bytes
  const again = d.hash && loc && opts.cache !== false ? async () => {
    const g = await onServer(baseName(loc.path), () => gt().pdf.fetch(loc.path, cacheDir(localDir), 'keep'), 30 * 60000, FRONT).catch(() => null);
    return g && g.hash === d.hash ? { file: g.file, size: g.size } : null;
  } : undefined;
  const fromCache = async (path: string, gone: boolean): Promise<Loaded | null> => {
    const st = await files.stat(cp).catch(() => null);
    if (!st || st.isDir) return null;
    // a copy cut short (disk full, the PC switched off while writing) is not trusted: read the server's
    // (never when it is the only one there is: an earlier revision, a file gone from the server)
    if (d.size && st.size !== d.size && !opts.exact && loc) { await setAside(); return null; }
    try {
      const o = await openLocal(engine, d.hash, cp, st.size, localDir, opts.progress, opts.bg, again);
      // (used now: the cache trims the copies opened longest ago - it went by when they were made)
      gt().pdf.touch?.(cp).catch(() => {});
      return { key: d.hash, pages: o.pages, src: o.src, file: cp, path, changed: false, ops: [], fromCache: true, gone, simplified: o.simplified };
    } catch (e: any) {
      if (e?.gone) return null;
      // only a copy the PDF engine finds damaged is replaced - never because an engine stopped, the
      // file was held by another program, or the sheet is too heavy (v0.12.5 review: an engine that
      // had stopped for good made every sheet clicked lose this PC's copy - for an earlier revision
      // or a file gone from the server, the only one)
      if (!damagedCopy(e) || opts.exact || !loc || brokenAtSource.has(d.hash)) throw e;
      await setAside();
      return null;
    }
  };
  if (d.hash && (same || !loc || opts.exact)) {
    const c = await fromCache(loc?.path ?? cp, !loc);
    if (c) return c;
  }
  if (!loc) return { missing: true };
  // read through once: the fingerprint, and this PC's copy (the background preparation: a copy only
  // while it is used - it would fill the cache with every sheet of the project)
  let mode: 'temp' | 'keep' | 'replace' = opts.cache === false ? 'temp' : replaceCopy ? 'replace' : 'keep';
  const name = baseName(loc.path);
  const wanted = () => opts.wanted?.() !== false;
  // the same file already being read for this PC's copy (the sheet clicked again, the background
  // preparation on it): that read is waited for - one read, one copy (v0.12.5 review: three at once)
  let r = mode !== 'replace' ? keepReads.get(loc.path) : undefined;
  // (one that has finished only if the file is still as it read it; never one being stopped)
  if (r?.stopped || (r?.done && (r.done.size !== loc.stat.size || !sameTime(r.done.mtime, loc.stat.mtime)))) r = undefined;
  if (r) mode = 'keep';
  else {
    const entry: KeepRead = { p: null!, says: new Set(), wants: new Set(), fid: '', handedOver: false, done: null, stopped: false };
    r = entry;
    const one = (m: string) => onServer(name, () => entry.handedOver ? Promise.reject(new Error('handed over')) : gt().pdf.fetch(loc.path, cacheDir(localDir), m as 'keep', (done, total) => {
      if (total > 20e6) for (const f of entry.says) f('Reading ' + name + ' from the server…' + pct(done, total));
    }, (id) => (entry.fid = id)), readLimits.ms, opts.bg ? BACK : FRONT, (why) => {
      // (giving way to a newer sheet: stopped only once nobody waits for it any more - a sheet on
      // screen still waiting goes on being read, only no longer holding up the others)
      const stop = why === 'too long' || ![...entry.wants].some((w) => w());
      gt().log(`read of ${name} ${why === 'too long' ? 'took too long' : 'gave way to a newer sheet'}: ${stop ? 'stopped' : 'goes on'} (${entry.wants.size} waiting)`);
      // ("too long" is the server's fault, not a newer sheet's: whoever still waits gets the message, not a
      // fresh read from byte 0 - 0.23.2, DeepSeek #0: it read again for ever)
      if (why === 'too long') entry.tooLong = true;
      if (entry.fid && stop) { entry.stopped = true; gt().pdf.cancel(entry.fid).catch(() => {}); }
    });
    entry.p = (async () => {
      try { return await one(mode); } catch (e: any) {
        // saved over while it was read: read again, once
        if (!/changed while it was being read/.test(String(e?.message ?? e))) throw e;
        return await one(mode);
      }
    })();
    const reads = mode === 'temp' ? tempReads : keepReads;
    // the background preparation reading the same file for a temp copy: it stops, and takes this
    // read's copy instead (one read of a 350 MB set, not two)
    if (mode !== 'temp') { const t = tempReads.get(loc.path); if (t) { gt().log('the preparation\'s read of ' + name + ' handed over to the sheet on screen'); t.handedOver = true; if (t.fid) gt().pdf.cancel(t.fid).catch(() => {}); } }
    reads.set(loc.path, entry);
    // (a read that worked stays joinable a little while: the preparation it took over from comes for it)
    const drop = () => { if (reads.get(loc.path) === entry) reads.delete(loc.path); };
    entry.p.then((g) => { entry.done = g; setTimeout(drop, mode === 'temp' ? 0 : 30000); }, drop);
  }
  if (opts.progress) r.says.add(opts.progress);
  r.wants.add(wanted);
  const mine = r;
  let again2 = false;
  const got = await r.p.catch((e) => {
    // stopped for nobody waiting - and asked for again meanwhile (a slow server, a quick re-click)
    if (mine.stopped && !mine.tooLong && wanted()) { again2 = true; return null; }
    const k = mine.handedOver ? keepReads.get(loc.path) : undefined;
    if (k) { mode = 'keep'; k.wants.add(wanted); return k.p.finally(() => k.wants.delete(wanted)); }
    if (/ENOENT|no such file/i.test(String(e?.message ?? e))) return null;
    throw e;
  }).finally(() => { if (opts.progress) mine.says.delete(opts.progress); mine.wants.delete(wanted); });
  if (again2) return loadDrawing(d, localDir, engine, opts);
  if (!got) return { missing: true };
  // (read through: what may take a while now is the opening)
  if (got.size > 20e6) opts.progress?.('Opening ' + name + '…');
  const key = got.hash;
  const dispose = mode === 'temp' ? () => { gt().pdf.drop(got.file).catch(() => {}); } : undefined;
  // the file there is another revision we know (the sheet was taken back to an earlier one, "make
  // current"): this PC's copy of the current revision is what is shown, not the file at the path
  if (d.hash && key !== d.hash && opts.known?.includes(key)) {
    const c = await fromCache(loc.path, false);
    if (c) { dispose?.(); return c; }
  }
  if (opts.exact && d.hash && key !== d.hash) { dispose?.(); return { missing: true, replaced: true }; }
  let o;
  try {
    o = await openLocal(engine, key, got.file, got.size, localDir, opts.progress, opts.bg, mode === 'temp' ? undefined : async () => {
      const g = await onServer(name, () => gt().pdf.fetch(loc.path, cacheDir(localDir), 'keep'), 30 * 60000, FRONT).catch(() => null);
      return g && g.hash === key ? { file: g.file, size: g.size } : null;
    });
  } catch (e) {
    dispose?.();
    // the copy just read from the server will not open either: the file itself is broken - not read
    // again from the server at every click (this PC's copy was never the problem)
    if (replaceCopy && key === d.hash && damagedCopy(e)) { brokenAtSource.add(key); gt().fs.remove(cp + '.bad').catch(() => {}); }
    // the file at the path was replaced by one that will not open (damaged, not a PDF): the version
    // that was measured, from this PC's copy, rather than nothing (the take-offs stay visible)
    if (d.hash && key !== d.hash && damagedCopy(e)) {
      const c = await fromCache(loc.path, false).catch(() => null);
      if (c) return { ...c, bad: String((e as Error)?.message ?? e) };
    }
    throw e;
  }
  // a good copy is in place: the bad one set aside is not needed
  if (replaceCopy && got.file === cp) gt().fs.remove(cp + '.bad').catch(() => {});
  const ops: Op[] = [];
  let changed = false;
  if (!d.hash) {
    // (a page of a bound set is a sheet of one page, whatever the file has: v0.16)
    ops.push([d.id, 'hash', key], [d.id, 'size', got.size], [d.id, 'mtime', got.mtime], [d.id, 'pages', d.fp !== undefined ? 1 : o.pages.length]);
  } else if (key === d.hash) {
    // touched but identical (copied again, re-saved): just remember the new date
    if (got.size !== d.size || !sameTime(got.mtime, d.mtime)) ops.push([d.id, 'size', got.size], [d.id, 'mtime', got.mtime]);
  } else changed = true;
  return { key, pages: o.pages, src: o.src, file: got.file, path: loc.path, changed, ops, fromCache: false, simplified: o.simplified, dispose };
}

/**
 * v0.16: the other pages of a bound set that nobody has opened yet get the fingerprint just read for one of them
 * (the same file, as it was brought in): otherwise each would read the whole set from the server again.
 */
export function siblingFingerprints(drawings: Drawing[], d: Pick<Drawing, 'id' | 'path' | 'unc'> & { fp?: number }, ops: Op[]): Op[] {
  if (d.fp === undefined) return [];
  const hash = ops.find((o) => o[0] === d.id && o[1] === 'hash')?.[2];
  const size = ops.find((o) => o[0] === d.id && o[1] === 'size')?.[2];
  const mtime = ops.find((o) => o[0] === d.id && o[1] === 'mtime')?.[2];
  if (typeof hash !== 'string' || typeof size !== 'number' || typeof mtime !== 'number') return [];
  const same = (a: string, b: string) => !!a && !!b && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
  const out: Op[] = [];
  for (const e of drawings) {
    if (e.id === d.id || e.hash || e.fp === undefined || !(same(e.unc, d.unc) || same(e.path, d.path))) continue;
    if (e.size !== size || !sameTime(e.mtime, mtime)) continue;
    out.push([e.id, 'hash', hash], [e.id, 'size', size], [e.id, 'mtime', mtime], [e.id, 'pages', 1]);
  }
  return out;
}

/**
 * v0.16: how many pages a file has and, for a bound set of several, each page's sheet number and title from its
 * title block. The PDF engine reads the file where it is, only what it needs (the page tree; the words of each page
 * of a set) - nothing is copied. A file that will not open: one page (it comes in as it is).
 * v0.23: read across the set (revisions.ts readSet - the PDF Editor 0.13's reading): no sheet numbers from the
 * pages of a bill of quantities or a specification, a title for every sheet, a set whose numbers repeat found.
 * Each page's words are reduced as they come (a few hundred candidates and title lines kept, not the words).
 */
export async function scanPdf(engine: PdfEngine, path: string, f: { size: number; mtime: number }, alive: () => boolean = () => true, onPage?: (done: number, of: number) => void): Promise<PageScan> {
  const key = 'scan-' + crc32hex(path.toLowerCase() + '|' + f.size + '|' + f.mtime);
  try {
    const pages = await engine.load(key, { path });
    if (pages.length <= 1 || !alive()) return { n: Math.max(1, pages.length) };
    const read: SetPage[] = [];
    for (let i = 0; i < pages.length && alive(); i++) {
      const words = await engine.words(key, i).catch(() => []);
      read.push(readSetPage(i, words, pages[i]));
      onPage?.(i + 1, pages.length);
    }
    return { n: pages.length, pages: readSet(read) };
  } catch {
    return { n: 1 };
  } finally {
    engine.close(key);
  }
}

/** the fingerprint of a file (read through once, nothing kept) */
export async function fingerprint(path: string, localDir: string): Promise<string | null> {
  const r = await onServer(baseName(path), () => gt().pdf.fetch(path, cacheDir(localDir), 'hash'), 30 * 60000).catch(() => null);
  return r?.hash ?? null;
}

/** is there already a shared preview of this sheet? */
export function hasSharedPreview(projectDir: string, key: string, pg: number): Promise<boolean> {
  return gt().fs.exists(join(projectDir, 'previews', key + '-' + pg + '.webp')).catch(() => false);
}

/**
 * Keep this PC's drawing cache under a size limit: the copies opened longest ago go first.
 * (They come back from the server the next time they are opened.)
 */
export async function trimCache(localDir: string, maxBytes = 3 * 1024 ** 3): Promise<void> {
  const fs = gt().fs;
  // copies set aside as damaged (kept in case they were the only one): gone after a day
  for (const e of await fs.list(cacheDir(localDir, 'pdf')).catch(() => [])) {
    if (!e.name.endsWith('.bad')) continue;
    const p = join(cacheDir(localDir, 'pdf'), e.name);
    const st = await gt().files.stat(p).catch(() => null);
    if (st && Date.now() - st.mtime > 86400000) await fs.remove(p).catch(() => {});
  }
  // temp copies left by a preparation that was stopped (the app closed): gone after a day
  for (const e of await fs.list(cacheDir(localDir, 'tmp')).catch(() => [])) {
    const p = join(cacheDir(localDir, 'tmp'), e.name);
    const st = await gt().files.stat(p).catch(() => null);
    if (st && Date.now() - st.mtime > 86400000) await fs.remove(p).catch(() => {});
  }
  for (const sub of ['pdf', 'prev', 'heavy', 'conv']) {
    const dir = cacheDir(localDir, sub);
    const ents = await fs.list(dir).catch(() => []);
    const files: { p: string; size: number; mtime: number }[] = [];
    for (const e of ents) {
      if (e.isDir) continue;
      const p = join(dir, e.name);
      const st = await gt().files.stat(p).catch(() => null);
      if (!st) continue;
      // half-written (the app closed, a check stopped for the sheet on screen's): gone after an hour
      if (/\.(part|tmp)$/.test(e.name)) { if (Date.now() - st.mtime > 3600000) await fs.remove(p).catch(() => {}); continue; }
      files.push({ p, size: st.size, mtime: st.mtime });
    }
    // (each a group: a monster sheet's record and the files it names go together)
    let groups: { paths: string[]; size: number; mtime: number }[] = files.map((f) => ({ paths: [f.p], size: f.size, mtime: f.mtime }));
    if (sub === 'heavy') groups = await heavyGroups(dir, files);
    let total = groups.reduce((a, g) => a + g.size, 0);
    // (heavy: a simplified set can be big - one of 600 MB was trimmed at every start, at 1/6 of the limit)
    const limit = sub === 'pdf' ? maxBytes : sub === 'conv' ? maxBytes / 6 : maxBytes / 3;
    groups.sort((a, b) => a.mtime - b.mtime);
    // the oldest used first - never the one used last, however big (it would only be made again)
    for (const g of groups.slice(0, -1)) {
      if (total <= limit) break;
      for (const p of g.paths) await fs.remove(p).catch(() => {});
      total -= g.size;
    }
  }
}

/** monster sheets' records with the files they name, used last as the newest of them; files no record
 *  names (an earlier simplification of the sheet) go after an hour */
async function heavyGroups(dir: string, files: { p: string; size: number; mtime: number }[]): Promise<{ paths: string[]; size: number; mtime: number }[]> {
  const byPath = new Map(files.map((f) => [f.p, f]));
  const named = new Set<string>();
  const out: { paths: string[]; size: number; mtime: number }[] = [];
  for (const f of files) {
    if (!f.p.endsWith('.json')) continue;
    // (a damaged record is no record: it stopped the whole trim - 0.23.2, DeepSeek #25)
    const r = await gt().fs.readText(f.p).then((t) => { try { return t ? (JSON.parse(t) as HeavyRecord) : null; } catch { return null; } }, () => null);
    const g = { paths: [f.p], size: f.size, mtime: f.mtime };
    for (const n of [r?.delta, r?.full]) {
      const x = n ? byPath.get(join(dir, n)) : undefined;
      if (x) { named.add(x.p); g.paths.push(x.p); g.size += x.size; g.mtime = Math.max(g.mtime, x.mtime); }
    }
    out.push(g);
  }
  for (const f of files) {
    if (f.p.endsWith('.json') || named.has(f.p)) continue;
    if (Date.now() - f.mtime > 3600000) await gt().fs.remove(f.p).catch(() => {});
  }
  return out;
}

const PREVIEW_MAX = 4096;

const previewSaves = new Set<Promise<void>>();
/** sheet pictures still being saved (the app waits a few seconds for them when it closes) */
export const previewsSaving = () => previewSaves.size;
export const previewsSaved = () => Promise.all([...previewSaves]).then(() => {});

export const previewScale = (p: PageSize) => Math.min(PREVIEW_MAX / Math.max(p.w, p.h), 2);

/**
 * The whole sheet as one picture (shown instantly, sharpened on zoom).
 * Order: this PC's copy -> the project's shared copy -> render it (and share it).
 */
export async function preview(engine: PdfEngine, key: string, pg: number, page: PageSize, localDir: string, projectDir: string, onRendered?: (ms: number) => void, opts: { awaitSave?: boolean } = {}): Promise<ImageBitmap> {
  const files = gt().files;
  const name = key + '-' + pg + '.webp';
  const local = cacheDir(localDir, 'prev', name);
  const shared = join(projectDir, 'previews', name);
  for (const p of [local, shared]) {
    const b = await files.readBytes(p).catch(() => null);
    if (b && b.length > 100) {
      try {
        const bmp = await createImageBitmap(new Blob([b as BlobPart], { type: 'image/webp' }));
        if (p === shared) files.writeBytes(local, b).catch(() => {});
        else {
          // made on this PC before the project had it: share it (and its thumbnail)
          const share = (async () => {
            if (await gt().fs.exists(shared).catch(() => true)) return;
            await files.writeBytes(shared, b, projectDir);
            const copy = await createImageBitmap(bmp);
            await makeThumb(copy, key, pg, projectDir);
            copy.close();
          })().catch(() => {});
          if (opts.awaitSave) await share;
        }
        return bmp;
      } catch { /* damaged cache: render again */ }
    }
  }
  const s = previewScale(page);
  const w = Math.round(page.w * s), h = Math.round(page.h * s);
  const { bmp, ms } = await engine.render(key, pg, s, 0, 0, w, h, { quality: 1 });
  onRendered?.(ms);
  // keep it: thumbnail first, then the WebP (encoding hands the copy to the worker)
  const copy = await createImageBitmap(bmp);
  const saved = (async () => {
    await makeThumb(copy, key, pg, projectDir).catch(() => {});
    const webp = await engine.encode(copy);
    await files.writeBytes(local, webp).catch(() => {});
    if (!(await gt().fs.exists(shared).catch(() => true))) await files.writeBytes(shared, webp, projectDir).catch(() => {});
  })().catch(() => {});
  // (the app closing waits a moment for it: a monster sheet's picture took half a minute to draw)
  previewSaves.add(saved);
  saved.finally(() => previewSaves.delete(saved));
  if (opts.awaitSave) await saved;
  return bmp;
}

/** Small picture for the drawing list, kept in the project folder for everyone. */
async function makeThumb(src: ImageBitmap, key: string, pg: number, projectDir: string) {
  const p = join(projectDir, 'thumbs', key + '-' + pg + '.webp');
  if (await gt().fs.exists(p)) return;
  const W = 320;
  const H = Math.round((src.height / src.width) * W);
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, W, H);
  const blob = await c.convertToBlob({ type: 'image/webp', quality: 0.8 });
  await gt().files.writeBytes(p, new Uint8Array(await blob.arrayBuffer()), projectDir);
}

const thumbMem = new Map<string, Promise<string | null>>();
/** object URL of a drawing's thumbnail, if anyone has opened it */
export function thumbUrl(projectDir: string, hash: string, pg = 0): Promise<string | null> {
  const k = projectDir + '|' + hash + '|' + pg;
  let p = thumbMem.get(k);
  if (!p) {
    p = gt().files.readBytes(join(projectDir, 'thumbs', hash + '-' + pg + '.webp'))
      .then((b) => (b ? URL.createObjectURL(new Blob([b as BlobPart], { type: 'image/webp' })) : null))
      .catch(() => null);
    p.then((u) => { if (!u) thumbMem.delete(k); }); // not made yet: ask again next time
    thumbMem.set(k, p);
  }
  return p;
}
