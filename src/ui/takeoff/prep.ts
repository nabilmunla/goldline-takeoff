// Prepares every sheet of a take-off project in the background: reads each PDF
// once, records its fingerprint and renders its preview + thumbnail into the
// project folder. Whoever has the project open does it (any PC, any role), one
// sheet at a time, on its own PDF engine, so it never slows down what you are
// looking at. After that, every sheet opens at once for everyone.
import type { Drawing } from '../../engine/qto/model';
import type { Op } from '../../engine/types';
import { bgEngine, releaseBg } from './pdfengine';
import { loadDrawing, preview, hasSharedPreview, siblingFingerprints } from './drawings';

// (v0.16: a page of a bound set is prepared as its page of the file - and the set's other pages with it,
//  from the one read of the file)
const prepKey = (hash: string, fp: number | undefined) => hash + '#' + (fp ?? 0);

export interface PrepState {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  failed: number;
  /** why the last one failed */
  why?: string;
}

export class SheetPrep {
  private stopped = false;
  private paused = false;
  private kick: (() => void) | null = null;
  state: PrepState = { running: false, done: 0, total: 0, current: null, failed: 0 };

  constructor(
    private opts: {
      drawings: () => Drawing[];
      localDir: string;
      projectDir: string;
      /** record a fingerprint (null when the user can't edit) */
      commit: ((ops: Op[]) => void) | null;
      /** the user is busy opening a sheet: wait */
      busy: () => boolean;
      onState: (s: PrepState) => void;
      onPrepared: (d: Drawing) => void;
    },
  ) {}

  stop() {
    this.stopped = true;
    this.kick?.();
  }
  setPaused(p: boolean) {
    this.paused = p;
    this.kick?.();
  }
  /** new drawings were added: look again */
  poke() {
    this.kick?.();
  }

  private set(p: Partial<PrepState>) {
    this.state = { ...this.state, ...p };
    this.opts.onState(this.state);
  }

  private wait(ms: number) {
    return new Promise<void>((r) => {
      const t = setTimeout(() => { this.kick = null; r(); }, ms);
      this.kick = () => { clearTimeout(t); this.kick = null; r(); };
    });
  }

  async run() {
    await this.wait(2500); // let the sheet you opened go first
    // (the engine is a background process of its own: started only once there is a sheet to prepare)
    let engine: Awaited<ReturnType<typeof bgEngine>> | null = null;
    const tried = new Set<string>();
    // fingerprints known to have a shared preview: asked of the server once each, not on every pass
    const prepared = new Set<string>();
    // sheets asked about already (id + fingerprint): one still waiting its turn is not asked again on every
    // pass - with N sheets that was about N²/2 looks at the server (BH-050). The one whose turn it is is
    // asked once more first: another PC may have prepared it meanwhile (then it is not read here at all).
    const asked = new Set<string>();
    while (!this.stopped) {
      if (this.paused || this.opts.busy()) {
        // paused: its engine (a background process, maybe a GB after heavy sheets) is let go meanwhile
        if (this.paused && engine) { releaseBg(engine); engine = null; }
        await this.wait(1500);
        continue;
      }
      const all = this.opts.drawings();
      let next: Drawing | null = null;
      let nextAsked = false;
      let done = 0;
      for (const d of all) {
        if (d.hash && prepared.has(prepKey(d.hash, d.fp))) { done++; continue; }
        const k = d.id + d.hash;
        if (tried.has(k)) continue;
        if (d.hash && !asked.has(k)) {
          asked.add(k);
          if (await hasSharedPreview(this.opts.projectDir, d.hash, d.fp ?? 0)) { prepared.add(prepKey(d.hash, d.fp)); done++; continue; }
          if (!next) { next = d; nextAsked = true; }
          continue;
        }
        if (!next) next = d;
      }
      // its turn, on an answer from an earlier pass: asked again (then looked at all again - nothing else is asked)
      if (next?.hash && !nextAsked && (await hasSharedPreview(this.opts.projectDir, next.hash, next.fp ?? 0))) { prepared.add(prepKey(next.hash, next.fp)); continue; }
      this.set({ total: all.length, done });
      if (!next) {
        this.set({ running: false, current: null });
        // nothing left to prepare: its engine (a background process) is let go until there is again
        if (engine) { releaseBg(engine); engine = null; }
        await this.wait(30000);
        continue;
      }
      if (!engine) engine = await bgEngine().catch(() => null);
      if (!engine) return;
      tried.add(next.id + next.hash);
      this.set({ running: true, current: next.title || next.name });
      let openKey: string | null = null;
      let dispose: (() => void) | undefined;
      try {
        const r = await loadDrawing(next, this.opts.localDir, engine, { cache: false, bg: true });
        if ('missing' in r) {
          this.set({ failed: this.state.failed + 1, why: r.replaced ? 'the file was replaced' : 'file not found' });
        } else {
          openKey = r.key;
          dispose = r.dispose;
          if (r.ops.length && this.opts.commit) this.opts.commit([...r.ops, ...siblingFingerprints(all, next, r.ops)]);
          // every page (a set bound in one PDF), the first one first; a page of a bound set: its page, and
          // those of the set's other pages in the project
          const cur = next;
          const same = (e: Drawing) => e.fp !== undefined && (e.hash ? e.hash === r.key : e.path === cur.path);
          // (a page past the end of the file now there - a shorter revision of the set: nothing to prepare;
          // asking for it marked the sheet failed with a raw TypeError - 0.23.2, DeepSeek #2)
          const want = cur.fp !== undefined
            ? (cur.fp < r.pages.length ? [cur.fp] : []).concat([...new Set(all.filter(same).map((e) => e.fp!))].filter((x) => x !== cur.fp && x < r.pages.length).sort((a, b) => a - b))
            : Array.from({ length: Math.min(r.pages.length, 60) }, (_, i) => i);
          for (let j = 0; j < want.length && !this.stopped; j++) {
            const pg = want[j];
            if (j > 0 && (this.paused || this.opts.busy())) break;
            if (!(await hasSharedPreview(this.opts.projectDir, r.key, pg))) {
              const bmp = await preview(engine, r.key, pg, r.pages[pg], this.opts.localDir, this.opts.projectDir, undefined, { awaitSave: true });
              bmp.close();
            }
            if (cur.fp !== undefined) prepared.add(prepKey(r.key, pg));
          }
          prepared.add(prepKey(r.key, cur.fp));
          this.opts.onPrepared(next);
        }
      } catch (e: any) {
        this.set({ failed: this.state.failed + 1, why: String(e?.message ?? e).replace(/\.$/, '').slice(0, 140) });
      } finally {
        // closed whatever happened: a sheet that fails half-way must not stay open in the background
        if (openKey) engine.close(openKey);
        // (its temp copy too - after the engine let go of it)
        if (dispose) setTimeout(dispose, 1500);
      }
      await this.wait(150);
    }
  }
}
