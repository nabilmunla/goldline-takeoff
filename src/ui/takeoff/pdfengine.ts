// The interface's handle on the PDF engines (v0.12.5: as the PDF Editor does it).
//   "draw" engine: previews and the sharp view of whatever is on screen
//   "geo"  engine: sheet text and snapping (so a slow preview never delays a snap)
//   "bg"   engine: the background preparation of every sheet (never delays what you look at)
// Each engine is a background process of its own (engine/pdfhost/host.ts) that reads a drawing
// from disk on demand - only what the pages it draws need. Nothing of a drawing passes through
// this window, a 350 MB bound set costs a few MB here, and a sheet that runs an engine out of
// memory takes down only that engine: the app starts a new one, and what was waiting asks again.
import { gt, type FileSrc } from '../api';

export type { FileSrc };
/** sent: when it went to the engine (0 while it waits for one to start) */
type Pending = { res: (v: any) => void; rej: (e: Error) => void; t: string; sent: number };

/**
 * Past its planned recycle point an engine is replaced at the next sheet change (WebAssembly memory
 * only grows; a fresh engine costs a fraction of a second there - the new sheet's page is read in
 * either). Each engine says its point with every answer (engine/pdfhost/host.ts RECYCLE: 1.4 to 3 GB
 * by the PC's memory, below its 4 GB ceiling; 600 MB up to 0.22, inside a 2 GB one); this until it has.
 */
const RECYCLE_MB = 1434;

/**
 * Engine hardening (as the PDF Editor 0.12):
 *  - an engine that went down (out of memory, a crash, killed) is started again quietly - the sheet
 *    comes back, nothing is lost - at most twice in 10 minutes; from the third the person is told
 *    (engineNotices: the take-off shows it), once in those 10 minutes
 *  - one that stops answering is replaced, and that is said and logged (HANG_MS below)
 *  - an idle engine that has grown big gives its memory back: replaced by a fresh one (IDLE_MS)
 */
/** each engine's restarts in the last 10 minutes (by name: kept when a take-off opens its engines afresh) */
const RESTART_WINDOW = 10 * 60_000;
const QUIET_RESTARTS = 2;
/** said once in RESTART_WINDOW per engine */
const toldAt = new Map<string, number>();
/** what the person should be told about the engines (the take-off shows it as a message) */
export const engineNotices = new Set<(text: string) => void>();
function notice(text: string) {
  try { gt().log('drawing engines: ' + text); } catch { /* no app (tests) */ }
  for (const f of engineNotices) { try { f(text); } catch { /* the listener's own error */ } }
}
const ENGINE_WORDS: Record<string, string> = { draw: 'drawing engine', geo: 'engine that reads sheet text and line work', bg: 'engine that prepares sheets in the background' };
const engineWords = (name: string) => ENGINE_WORDS[name] ?? 'drawing engine';
/** an idle engine past this gives its memory back (a fresh one is a fraction of a second away) */
const IDLE_BIG_MB = 600;
const IDLE_MS = 2 * 60_000;
const restartsOf = new Map<string, { planned: number[]; other: number[] }>();
function restarts(name: string) {
  let r = restartsOf.get(name);
  if (!r) restartsOf.set(name, (r = { planned: [], other: [] }));
  const old = Date.now() - RESTART_WINDOW;
  r.planned = r.planned.filter((t) => t > old);
  r.other = r.other.filter((t) => t > old);
  return r;
}

/**
 * An engine that has not answered anything for this long while calls wait on it is taken as stuck:
 * a call inside the PDF library that never returns (a damaged drawing) holds its only thread, so it
 * can't say so itself, and every sheet queued behind it would wait for ever. The call it is on fails
 * (that sheet says so), the engine is replaced and the calls behind it go to the new one. The
 * slowest real step (the snapping index of a monster sheet) takes seconds, not minutes.
 */
const HANG_MS = 3 * 60_000;

/**
 * One engine process, reached through a message port. If the engine fails inside (out of memory
 * on a heavy sheet, a crash in the PDF library) it ends, the app starts a new one and hands over
 * a new port: what was waiting is told to try again (`retry`), and the drawings are opened in the
 * new one when next needed. One that keeps failing (the app stops starting it) stops for good.
 */
class EngineClient {
  private port: MessagePort | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private waiting: unknown[] = [];
  /** changes each time a new engine takes over: what was open in the old one is gone */
  gen = 0;
  /** how big its engine's memory has grown (MB) */
  heap = 0;
  /** its planned recycle point (MB) */
  recycleAt = RECYCLE_MB;
  dead: string | null = null;
  /** which start of the engines this is: a port of an earlier one's engine is not taken */
  token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  ready: Promise<void>;
  private readyRes!: () => void;
  /** how long an engine may stay silent with calls waiting on it (tests shorten it) */
  hangMs = HANG_MS;
  /** when the engine last answered anything (or took over) */
  private lastHeard = 0;
  private watch: ReturnType<typeof setInterval> | null = null;
  /** how long it may sit idle and big before it gives its memory back (tests shorten it) */
  idleMs = IDLE_MS;
  idleBigMB = IDLE_BIG_MB;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(public name: string) {
    this.ready = new Promise((r) => (this.readyRes = r));
  }

  attach(port: MessagePort, restarted: boolean, code: number) {
    this.port?.close();
    const log = restarts(this.name);
    if (restarted) {
      this.gen++;
      this.heap = 0;
      // a fresh engine in place of one whose memory had grown (asked for here, or the engine near
      // its ceiling): nothing failed - what was waiting is asked again, not counted as a failure
      const planned = code === 75;
      (planned ? log.planned : log.other).push(Date.now());
      if (!planned) this.wentDown(code, log.other.length);
      // the engine that had these is gone: asked again (in the new one)
      const why = planned ? 'a fresh engine took over' : code === 70 ? 'the drawing engine ran out of memory or failed' : 'the drawing engine stopped (' + code + ')';
      for (const p of this.pending.values()) p.rej(Object.assign(new Error('The drawing engine was restarted (' + why + ')'), { retry: true, planned }));
      this.pending.clear();
    }
    this.port = port;
    this.lastHeard = Date.now();
    port.onmessage = (e) => this.reply(e.data);
    port.start();
    // (the engine's planned restarts lately: it waits longer before the next - host.ts minUp)
    port.postMessage({ id: 0, t: 'config', recycles: log.planned.length });
    for (const m of this.waiting) {
      const p = this.pending.get((m as { id: number }).id);
      // (one told just above to ask again - the engine it waited for went down - is not sent as well:
      // it would be done for nothing, and the call that took the engine down run twice - sweep B 15)
      if (!p) continue;
      p.sent = this.lastHeard;
      port.postMessage(m);
    }
    this.waiting = [];
    if (this.pending.size) this.watchOn();
    else this.idleOn();
    this.readyRes();
  }

  /** the engine went down and a new one took over: quietly up to QUIET_RESTARTS in 10 minutes, then said */
  private wentDown(code: number, n: number) {
    const why = code === 70 ? 'out of memory or failed inside' : code ? 'stopped (exit ' + code + ')' : 'stopped';
    try { gt().log(`pdf engine ${this.name} ${why}: started again (${n} in the last 10 minutes)`); } catch { /* no app (tests) */ }
    if (n <= QUIET_RESTARTS) return;
    const at = toldAt.get(this.name) ?? 0;
    if (Date.now() - at < RESTART_WINDOW) return;
    toldAt.set(this.name, Date.now());
    notice(`The ${engineWords(this.name)} stopped ${n} times in the last 10 minutes and was started again each time - nothing was lost. If it keeps happening on one sheet, that drawing may be too heavy for this PC or damaged: open it in a PDF reader, save a copy and use that.`);
  }

  /** nothing waiting on it: once idle for idleMs, an engine that has grown big gives its memory back */
  private idleOn() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.dead || !this.port || this.pending.size || this.heap <= this.idleBigMB) return;
      this.replace(`idle ${Math.round(this.idleMs / 1000)} s at ${this.heap} MB: its memory given back`);
    }, this.idleMs);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  /** while calls wait on the engine: is it still answering? */
  private watchOn() {
    if (this.watch) return;
    this.watch = setInterval(() => this.checkHung(), Math.max(5, Math.min(15_000, this.hangMs / 4)));
  }
  private watchOff() {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
  }
  private checkHung() {
    if (!this.pending.size || this.dead) { this.watchOff(); return; }
    // no engine just now (one is starting): nothing to wait for yet
    if (!this.port) return;
    // the engine answers in order: the oldest call sent is the one it is on
    let oldest: [number, Pending] | null = null;
    for (const e of this.pending) if (e[1].sent) { oldest = e; break; }
    if (!oldest) return;
    const silent = Date.now() - Math.max(this.lastHeard, oldest[1].sent);
    if (silent < this.hangMs) return;
    const [id, p] = oldest;
    this.pending.delete(id);
    const mins = Math.max(1, Math.round(this.hangMs / 60_000));
    p.rej(Object.assign(new Error(`The drawing engine stopped answering on this sheet (nothing for ${mins} minute${mins > 1 ? 's' : ''}), so a fresh one was started. If it happens again on this sheet, the drawing may be damaged: open it in a PDF reader, save a copy and use that.`), { hung: true }));
    this.lastHeard = Date.now();
    // (said wherever the call came from - a background step's failure is not shown on any sheet)
    notice(`The ${engineWords(this.name)} stopped answering (${Math.round(silent / 1000)} s on ${p.t === 'snapIndex' ? 'the line work of a sheet' : p.t === 'render' ? 'drawing a sheet' : p.t === 'open' ? 'opening a sheet' : 'a sheet'}), so a fresh one was started. What waited behind it carries on.`);
    this.replace('no answer for ' + Math.round(silent / 1000) + ' s (' + p.t + ')');
  }

  private reply(m: any) {
    this.lastHeard = Date.now();
    if (typeof m?.heap === 'number') this.heap = m.heap;
    if (typeof m?.recycle === 'number' && m.recycle > 0) this.recycleAt = m.recycle;
    const p = this.pending.get(m?.id);
    if (!p) return;
    if (m.ok) { this.pending.delete(m.id); if (!this.pending.size) this.idleOn(); p.res(m); return; }
    if (m.fatal) {
      // the engine is broken and ends now: this call (and those queued behind it) wait for the new
      // one, then are asked again; new calls wait too (not sent to the broken one)
      console.warn('pdf engine ' + this.name + ' failed, a new one is starting:', m.error);
      this.port?.close();
      this.port = null;
      return;
    }
    this.pending.delete(m.id);
    if (!this.pending.size) this.idleOn();
    p.rej(Object.assign(new Error(m.error), { superseded: !!m.superseded }));
  }

  /** the app stopped starting this engine: calls fail at once with this */
  fail(why: string) {
    this.dead = why;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const p of this.pending.values()) p.rej(new Error('The drawing engine keeps stopping (' + why + '). Close the take-off and open it again; if it happens again on this sheet, it may need more memory than this PC has.'));
    this.pending.clear();
    this.waiting = [];
    this.watchOff();
  }

  /** a fresh engine in place of this one (planned: its memory has grown) */
  replace(why: string) {
    const line = 'pdf engine ' + this.name + ': ' + why + ' - starting a fresh one';
    console.info(line);
    try { gt().log(line); } catch { /* no app (tests) */ }
    this.port?.close();
    this.port = null;
    gt().pdf.restart(this.name).catch(() => {});
  }

  /** nothing waiting on it */
  get idle() {
    return this.pending.size === 0;
  }

  call(t: string, payload: Record<string, unknown> = {}): Promise<any> {
    if (this.dead) return Promise.reject(new Error('The drawing engine stopped (' + this.dead + '). Close the take-off and open it again.'));
    const id = ++this.seq;
    const msg = { id, t, ...payload };
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej, t, sent: this.port ? Date.now() : 0 });
      if (this.port) this.port.postMessage(msg);
      else this.waiting.push(msg);
      this.watchOn();
    });
  }
}

const clients = new Map<string, EngineClient>();
function client(name: string): EngineClient {
  let c = clients.get(name);
  if (!c) { c = new EngineClient(name); clients.set(name, c); }
  return c;
}
// ports for the engines come from the app (main process), through the preload
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || !e.data) return;
  if (e.data.type === 'gt-pdf-port' && e.ports[0]) {
    const c = clients.get(String(e.data.name));
    if (c && String(e.data.token ?? '') === c.token) c.attach(e.ports[0], !!e.data.restarted, Number(e.data.code) || 0);
    else e.ports[0].close();
  } else if (e.data.type === 'gt-pdf-gaveup') {
    const c = clients.get(String(e.data.name));
    if (c && String(e.data.token ?? '') === c.token) c.fail('exit ' + e.data.code);
  }
});

export interface PageSize {
  w: number;
  h: number;
}

export interface Snapped {
  x: number;
  y: number;
  k: 'end' | 'mid' | 'on';
}

/** where to read a drawing again if its file is gone (after an engine restart) */
export type Again = () => Promise<FileSrc | null>;

/** a call asked again in a new engine after its engine went: twice at most when it failed (a planned
 *  fresh engine - its memory had grown - is no failure of the call: asked again, a few times at most) */
const retrying = async <T>(f: () => Promise<T>): Promise<T> => {
  let failed = 0;
  for (let k = 0; ; k++) {
    try { return await f(); } catch (e: any) {
      if (!e?.retry) throw e;
      if (e.planned && k < 4) continue;
      if (++failed < 2) continue;
      throw Object.assign(new Error('This sheet could not be shown: the drawing engine ran out of memory on it twice.'), { heavy: true });
    }
  }
};

/** pictures for the interface: raw pixels from an engine -> ImageBitmap */
const toBitmap = (r: { px: Uint8ClampedArray; w: number; h: number }) => createImageBitmap(new ImageData(r.px as unknown as Uint8ClampedArray<ArrayBuffer>, r.w, r.h));

export class PdfEngine {
  private draw: EngineClient;
  private geo: EngineClient | null;
  /** page sizes of each open drawing */
  private open = new Map<string, Promise<PageSize[]>>();
  /** drawing -> engine generation it is open in */
  private inDraw = new Map<string, { gen: number; p: Promise<any> }>();
  private inGeo = new Map<string, { gen: number; p: Promise<any> }>();
  /** what each open drawing is read from */
  private srcs = new Map<string, FileSrc>();
  private agains = new Map<string, Again>();
  private snapReady = new Map<string, { gen: number; p: Promise<number> }>();
  /** opened most recently last; the oldest ones are closed to keep memory in check */
  private lru: string[] = [];
  /** drawings that were pictures, not PDFs (key -> kind) */
  readonly converted = new Map<string, string>();

  /** draw / geo: the engines' names ('bg' alone: rendering only - the background preparation) */
  constructor(draw: string, geo: string | null) {
    this.draw = client(draw);
    this.geo = geo ? client(geo) : null;
  }

  /** an engine that kept failing: a new one is made the next time a take-off opens */
  get dead() {
    return !!(this.draw.dead || this.geo?.dead);
  }

  /** the engines (tests reach them: how it recovers when an engine fails inside) */
  get clients() {
    return { draw: this.draw, geo: this.geo };
  }

  /** Open a drawing (each engine reads it from disk on demand). Same key twice = no work. */
  load(key: string, src: FileSrc, again?: Again): Promise<PageSize[]> {
    let p = this.open.get(key);
    if (p) {
      this.touch(key);
      return p;
    }
    this.srcs.set(key, src);
    if (again) this.agains.set(key, again);
    // a new sheet: an engine past its planned recycle point is replaced now, at a natural pause
    for (const w of [this.draw, this.geo]) if (w && w.idle && w.heap > w.recycleAt) w.replace('memory ' + w.heap + ' MB, past ' + w.recycleAt + ' MB');
    p = retrying(() => this.openIn(this.draw, this.inDraw, key)).then((r) => r.pages as PageSize[]);
    const mine = p;
    p.catch(() => { if (this.open.get(key) === mine) this.forget(key); });
    this.open.set(key, p);
    this.touch(key);
    return p;
  }

  /** open `key` in an engine (once per engine generation) */
  private openIn(w: EngineClient, where: Map<string, { gen: number; p: Promise<any> }>, key: string): Promise<any> {
    const have = where.get(key);
    if (have && have.gen === w.gen) return have.p;
    const gen = w.gen;
    const p = (async () => {
      const src = this.srcs.get(key);
      if (!src) throw new Error('drawing not open');
      await w.ready;
      const gone = (e: any) => /ENOENT|no such file/i.test(String(e?.message ?? e))
        ? new Error("This PC's copy of the drawing has gone (the drawing cache was cleaned up) and it could not be read again from the server as it was. Open the sheet again.")
        : e;
      try {
        return await w.call('open', { key, file: src });
      } catch (e: any) {
        // the file it was read from is gone (this PC's copy trimmed, a temp copy dropped): read again
        const a = this.agains.get(key);
        // (an engine that hung on this drawing: reading it again would not help)
        if (e?.retry || e?.hung) throw e;
        if (!a) throw gone(e);
        const again = await a().catch(() => null);
        if (!again) throw gone(e);
        this.srcs.set(key, again);
        return await w.call('open', { key, file: again }).catch((e2: any) => { throw e2?.retry ? e2 : gone(e2); });
      }
    })();
    const entry = { gen, p };
    where.set(key, entry);
    p.catch(() => { if (where.get(key) === entry) where.delete(key); });
    return p;
  }

  isOpen(key: string) {
    return this.open.has(key);
  }

  private touch(key: string) {
    this.lru = [...this.lru.filter((k) => k !== key), key];
    while (this.lru.length > 6) this.close(this.lru.shift()!);
  }

  private forget(key: string) {
    this.open.delete(key);
    this.srcs.delete(key);
    this.agains.delete(key);
    this.converted.delete(key);
    this.lru = this.lru.filter((k) => k !== key);
    this.snapReady.forEach((_, k) => k.startsWith(key + '#') && this.snapReady.delete(k));
  }

  close(key: string) {
    if (!this.open.has(key)) return;
    this.forget(key);
    const d = this.inDraw.get(key);
    this.inDraw.delete(key);
    if (d && d.gen === this.draw.gen) this.draw.call('close', { key }).catch(() => {});
    const g = this.inGeo.get(key);
    this.inGeo.delete(key);
    if (g && this.geo && g.gen === this.geo.gen) this.geo.call('close', { key }).catch(() => {});
  }

  private async ensureGeo(key: string): Promise<void> {
    const geo = this.geo;
    if (!geo) throw new Error('no geometry engine');
    const opened = this.open.get(key);
    if (!opened) throw new Error('drawing not open');
    await opened;
    await this.openIn(geo, this.inGeo, key);
  }

  /**
   * Render part of a page. scale = device pixels per sheet point; x, y, w, h in device
   * pixels of the whole page at that scale. A newer request in the same slot cancels
   * a queued older one (rejected with .superseded).
   */
  async render(key: string, pg: number, scale: number, x: number, y: number, w: number, h: number, opts: { slot?: string; quality?: 0 | 1 } = {}): Promise<{ bmp: ImageBitmap; ms: number }> {
    const p = this.open.get(key);
    if (!p) throw new Error('drawing not open');
    // (v0.16.4 a drawing being drawn stays open: a sheet window showing it is not closed under it by other
    // sheets opened elsewhere)
    if (this.lru[this.lru.length - 1] !== key) this.touch(key);
    await p;
    const r = await retrying(async () => {
      await this.openIn(this.draw, this.inDraw, key);
      return this.draw.call('render', { key, pg, scale, x, y, w, h, slot: opts.slot, quality: opts.quality ?? 1 });
    });
    return { bmp: await toBitmap(r), ms: r.ms };
  }

  /** ImageBitmap -> WebP bytes (in a worker of this window) */
  encode(bmp: ImageBitmap, quality = 0.88): Promise<Uint8Array> {
    return imgWorker('encode', { bmp, quality }, [bmp]).then((r) => new Uint8Array(r.data));
  }

  async text(key: string, pg: number): Promise<string> {
    return retrying(async () => {
      await this.ensureGeo(key);
      return (await this.geo!.call('text', { key, pg })).text;
    });
  }

  /** the words of a page with their boxes (sheet points): auto-count by tag */
  async words(key: string, pg: number): Promise<{ t: string; x0: number; y0: number; x1: number; y1: number }[]> {
    return retrying(async () => {
      await this.ensureGeo(key);
      return (await this.geo!.call('words', { key, pg })).words;
    });
  }

  /** builds the snapping index for a page (once per engine); resolves with the number of line pieces */
  prepareSnap(key: string, pg: number): Promise<number> {
    const k = key + '#' + pg;
    const have = this.snapReady.get(k);
    if (have && this.geo && have.gen === this.geo.gen) return have.p;
    const gen = this.geo?.gen ?? 0;
    const p = retrying(async () => {
      await this.ensureGeo(key);
      return (await this.geo!.call('snapIndex', { key, pg })).n as number;
    });
    const entry = { gen, p };
    this.snapReady.set(k, entry);
    p.catch(() => { if (this.snapReady.get(k) === entry) this.snapReady.delete(k); });
    return p;
  }

  snapReadyNow(key: string, pg: number) {
    const e = this.snapReady.get(key + '#' + pg);
    return !!e && !!this.geo && e.gen === this.geo.gen;
  }

  async snap(key: string, pg: number, x: number, y: number, r: number): Promise<Snapped | null> {
    return (await this.snapNear(key, pg, x, y, r, false)).hit;
  }

  /** v0.18.1 the snap, and (near) the drawing's lines within r of the pointer: [ax, ay, bx, by, ...] */
  async snapNear(key: string, pg: number, x: number, y: number, r: number, near = true): Promise<{ hit: Snapped | null; near: number[] }> {
    const e = this.snapReady.get(key + '#' + pg);
    if (!e || !this.geo) return { hit: null, near: [] };
    // the geometry engine was restarted since: its index is built again (no snapping meanwhile)
    if (e.gen !== this.geo.gen) { this.prepareSnap(key, pg).catch(() => {}); return { hit: null, near: [] }; }
    await e.p;
    const res = await this.geo.call('snap', { key, pg, x, y, r, near }).catch(() => ({ hit: null, near: [] }));
    return { hit: res.hit ?? null, near: res.near ?? [] };
  }
}

// ---------------------------------------------------------------- the picture worker (this window)
// WebP previews and pictures named .pdf turned into PDFs: browser work (canvas), no PDF engine needed.
let iw: Worker | null = null;
let iwSeq = 0;
const iwPending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
export function imgWorker(t: string, payload: Record<string, unknown>, transfer: Transferable[] = []): Promise<any> {
  if (!iw) {
    const w = new Worker(new URL('./imgworker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const p = iwPending.get(e.data?.id);
      if (!p) return;
      iwPending.delete(e.data.id);
      if (e.data.ok) p.res(e.data);
      else p.rej(new Error(e.data.error));
    };
    w.onerror = (e) => {
      for (const p of iwPending.values()) p.rej(new Error(e.message || 'the picture worker stopped'));
      iwPending.clear();
      if (iw === w) iw = null;
      try { w.terminate(); } catch { /* gone */ }
    };
    iw = w;
  }
  const id = ++iwSeq;
  return new Promise((res, rej) => {
    iwPending.set(id, { res, rej });
    iw!.postMessage({ id, t, ...payload }, transfer);
  });
}

let engine: Promise<PdfEngine> | null = null;
let engineNow: PdfEngine | null = null;
let bg: Promise<PdfEngine> | null = null;
let bgNow: PdfEngine | null = null;

// (tests reach the engines from the window: how it recovers when an engine fails inside)
(globalThis as any).__gtPdf = { engine: () => engineNow?.clients, bg: () => bgNow?.clients };

async function started(names: string[]): Promise<void> {
  // fresh engines (anything a reloaded window had open in the old ones is gone)
  for (const n of names) { clients.get(n)?.fail('replaced'); clients.delete(n); client(n); }
  // (one start for the names together: they share its token)
  const token = client(names[0]).token;
  for (const n of names) client(n).token = token;
  await gt().pdf.start(names, token);
  // an engine that has not answered after two minutes is said so (antivirus checking a new program
  // the first time can take a while; a normal start takes a second)
  await Promise.race([
    Promise.all(names.map((n) => client(n).ready)),
    new Promise((_, rej) => setTimeout(() => rej(new Error('The PDF engine did not start within two minutes. Close Goldline Takeoff and open it again; if it happens again, your antivirus may be holding the program\'s files.')), 120000)),
  ]);
}

/** One engine pair for the whole app, started the first time a drawing is opened (new ones if it kept failing). */
export function pdfEngine(): Promise<PdfEngine> {
  if (engineNow?.dead) { engine = null; engineNow = null; }
  if (!engine) {
    engine = started(['draw', 'geo']).then(() => (engineNow = new PdfEngine('draw', 'geo')));
    engine.catch(() => (engine = null));
  }
  return engine;
}

/** the background engine is not needed for now (every sheet prepared): its process ends */
export function releaseBg(e: PdfEngine) {
  if (bgNow !== e) return;
  bg = null;
  bgNow = null;
  clients.get('bg')?.fail('let go');
  clients.delete('bg');
  gt().pdf.stop(['bg']).catch(() => {});
}

/** A separate, render-only engine for preparing sheets in the background (never delays what you look at). */
export function bgEngine(): Promise<PdfEngine> {
  if (bgNow?.dead) { bg = null; bgNow = null; }
  if (!bg) {
    bg = started(['bg']).then(() => (bgNow = new PdfEngine('bg', null)));
    bg.catch(() => (bg = null));
  }
  return bg;
}
