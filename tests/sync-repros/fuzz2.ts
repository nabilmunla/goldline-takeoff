// Extended copy of tests/fuzz-sync.test.ts with more fault types.
// run: FUZZ_SEEDS=1,2,3 FAULTS=late,crashmid,reopen,closeoff,back,zero npx tsx tests/sync-repros/fuzz2.ts
// FAULTS (comma list, default all but 'zero' and 'lost'):
//   late      an append that reports an error although every byte landed (timeout after the write)
//   crashmid  the app dies while an append is half way (half the bytes land, no error seen)
//   reopen    a session is closed (not awaited) and the same PC opens the project again at once
//   closeoff  "Close anyway" while the share is down, then started again
//   back      the PC clock jumps back by minutes (NTP correction)
//   zero      a reader sees the right size but the last bytes still zero (SMB data not visible yet)
//   lost      an append that is acknowledged but never lands
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectSession } from '../../src/engine/session';
import { createProject, readProjectStore } from '../../src/engine/projects';
import { splitBytes } from '../../src/engine/codec';
import type { Batch, FsApi, Op, Value } from '../../src/engine/types';
import type { Store } from '../../src/engine/store';
import { nodefs, tmp, sleep } from './lib';

process.on('unhandledRejection', (e: any) => { console.log('UNHANDLED', e?.stack?.split('\n').slice(0, 6).join(' | ')); });

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOST: string[] = [];
const FAULTS = new Set((process.env.FAULTS ?? 'late,crashmid,reopen,closeoff,back').split(',').filter(Boolean));

function faultyShare(base: FsApi, r: () => number) {
  const st = { offline: false, tearNext: false, lateNext: false, lostNext: false, zeroNext: false, crashMid: null as null | (() => void) };
  const guard = () => { if (st.offline) { const e: any = new Error('EIO: share not reachable'); e.code = 'EIO'; throw e; } };
  const fs: FsApi = {
    join: base.join,
    mkdirp: async (p) => { guard(); return base.mkdirp(p); },
    mkdirExcl: base.mkdirExcl ? async (p) => { guard(); return base.mkdirExcl!(p); } : undefined,
    list: async (d) => { guard(); return base.list(d); },
    readText: async (p) => { guard(); return base.readText(p); },
    readFrom: async (p, o, m) => {
      guard();
      const res = await base.readFrom(p, o, m);
      if (res && st.zeroNext && res.data.length > 2 && p.includes('journals')) {
        st.zeroNext = false;
        const d = new Uint8Array(res.data);
        const k = 1 + Math.floor(r() * Math.min(40, d.length - 1));
        d.fill(0, d.length - k);
        return { size: res.size, data: d };
      }
      return res;
    },
    append: async (p, text) => {
      guard();
      if (p.includes('journals')) {
        if (st.crashMid) {
          const kill = st.crashMid; st.crashMid = null;
          await base.append(p, text.slice(0, Math.max(1, Math.floor(text.length / 2))));
          kill();
          return new Promise<void>(() => {}); // the process is gone: this call never returns
        }
        if (st.tearNext) {
          st.tearNext = false;
          await base.append(p, text.slice(0, Math.max(1, Math.floor(text.length / 2))));
          const e: any = new Error('ECONNRESET: write torn'); e.code = 'ECONNRESET'; throw e;
        }
        if (st.lateNext) {
          st.lateNext = false;
          await base.append(p, text);
          const e: any = new Error('ETIMEDOUT: no answer'); e.code = 'ETIMEDOUT'; throw e;
        }
        if (st.lostNext) { st.lostNext = false; LOST.push(...text.split('\n').filter(Boolean).map((l) => JSON.parse(l.slice(9)).s)); return; }
      }
      return base.append(p, text);
    },
    writeAtomic: async (p, t) => { guard(); return base.writeAtomic(p, t); },
    remove: async (p) => { guard(); return base.remove(p); },
    exists: async (p) => { guard(); return base.exists(p); },
  };
  return { fs, st };
}

interface Writer { name: string; share: ReturnType<typeof faultyShare>; localDir: string; skew: number; s: ProjectSession | null; closing: Promise<void>[] }

const vals = (st: Store) => {
  const out = new Map<string, Value>();
  for (const [id, ent] of st.ents) for (const [f, c] of ent) if (id !== 'project' || (f !== 'app' && f !== 'fmt' && f !== 'fmtBy')) out.set(id + '.' + f, c.v ?? null);
  return out;
};

export async function run(seed: number, steps: number) {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'Fuzz', 'Setup', 'PC0', [['e0', 'a', 1]]);
  const own = new Map<string, Batch>();
  const watch = (s: ProjectSession) => {
    const apply = s.store.apply.bind(s.store);
    s.store.apply = (b: Batch) => { if (b.w === s.writer) own.set(b.s, b); return apply(b); };
  };
  const writers: Writer[] = ['Nabil', 'Ahmed', 'Rami'].map((name, i) => ({ name, share: faultyShare(nodefs, r), localDir: tmp(), skew: [-95000, 0, 310000][i], s: null, closing: [] }));
  const open = async (w: Writer) => {
    const s = new ProjectSession({ fs: w.share.fs, localFs: nodefs, projectDir: dir, localDir: w.localDir, user: w.name, account: w.name.toLowerCase(), host: 'PC-' + w.name, pollMs: 3600000, fullScanMs: 0, heartbeatMs: 3600000, now: () => Date.now() + w.skew, dataFormat: 1, appVersion: '0.12.1' });
    watch(s);
    await s.open();
    w.s = s;
  };
  for (const w of writers) await open(w);
  const ents = Array.from({ length: 12 }, (_, i) => 'e' + i);
  const fields = ['a', 'b', 'c', 'del'];
  const value = (): Value => { const k = r(); return k < 0.4 ? Math.round(r() * 1e6) / 100 : k < 0.7 ? 'v' + Math.floor(r() * 50) : k < 0.85 ? null : k < 0.95 ? true : -0; };
  const counts: Record<string, number> = {};
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  const log = process.env.FUZZ_LOG ? (m: string) => console.error(`[${seed}] ${m}`) : () => {};
  for (let i = 0; i < steps; i++) {
    const w = pick(writers);
    const s = w.s!;
    const k = r();
    if (k < 0.45) {
      const ops: Op[] = [];
      const n = 1 + Math.floor(r() * 4);
      for (let j = 0; j < n; j++) ops.push([pick(ents), pick(fields), value()]);
      s.commit(ops, 'fuzz');
    } else if (k < 0.55) s.undo();
    else if (k < 0.6) s.redo();
    else if (k < 0.74) await s.tick();
    else if (k < 0.78) { w.share.st.offline = !w.share.st.offline; bump('outage'); }
    else if (k < 0.81) { w.share.st.tearNext = true; bump('tear'); }
    else if (k < 0.83) {
      await (s as any).localChain; s.kill(); bump('crash');
      w.share.st.offline = false; await open(w);
    } else if (k < 0.85 && FAULTS.has('late')) { w.share.st.lateNext = true; bump('late'); }
    else if (k < 0.87 && FAULTS.has('lost')) { w.share.st.lostNext = true; bump('lost'); }
    else if (k < 0.89 && FAULTS.has('crashmid')) {
      // the next send is cut half way and the app dies with it
      w.share.st.offline = false;
      const sess = s;
      let killed = false;
      w.share.st.crashMid = () => { killed = true; sess.kill(); };
      sess.commit([[pick(ents), pick(fields), value()]], 'fuzz');
      for (let j = 0; j < 40 && !killed; j++) await sleep(10);
      if (!killed) { w.share.st.crashMid = null; continue; }
      await (sess as any).localChain;
      bump('crashmid');
      await open(w);
    } else if (k < 0.91 && FAULTS.has('reopen')) {
      w.closing.push(s.close()); bump('reopen');
      w.share.st.offline = false;
      await open(w);
    } else if (k < 0.93 && FAULTS.has('closeoff')) {
      w.share.st.offline = true; await s.close(); bump('closeoff');
      w.share.st.offline = false; await open(w);
    } else if (k < 0.95 && FAULTS.has('back')) { w.skew -= Math.floor(r() * 600000); bump('back'); }
    else if (k < 0.97 && FAULTS.has('zero')) { pick(writers.filter((x) => x !== w)).share.st.zeroNext = true; bump('zero'); }
    else await sleep(5);
  }
  for (const w of writers) { w.share.st.offline = false; w.share.st.tearNext = false; w.share.st.lateNext = false; w.share.st.lostNext = false; w.share.st.zeroNext = false; }
  for (const w of writers) await Promise.all(w.closing);
  for (let round = 0; round < 40; round++) {
    await Promise.all(writers.map((w) => (w.s as any).pump()));
    for (const w of writers) await w.s!.tick();
    if (writers.every((w) => w.s!.pendingCount === 0)) break;
    await sleep(300);
  }
  for (const w of writers) { await w.s!.tick(); await w.s!.tick(); }
  const best = new Map<string, { s: string; v: Value }>();
  const setup = await readProjectStore(nodefs, dir);
  const consider = (b: Batch) => { for (const [e, f, v] of b.o) { const key = e + '.' + f; const c = best.get(key); if (!c || b.s > c.s) best.set(key, { s: b.s, v }); } };
  for (const b of own.values()) consider(b);
  for (const e of readdirSync(join(dir, 'journals'))) {
    if (!e.endsWith('_init.log')) continue;
    for (const b of splitBytes(new Uint8Array(readFileSync(join(dir, 'journals', e)))).batches) consider(b);
  }
  const expect = new Map<string, Value>();
  for (const [k, c] of best) if (!k.startsWith('project.app') && !k.startsWith('project.fmt')) expect.set(k, c.v === undefined ? null : c.v);
  const fresh = vals(setup);
  const diff = (a: Map<string, Value>, b: Map<string, Value>) => {
    const out: string[] = [];
    for (const k of new Set([...a.keys(), ...b.keys()])) if ((a.get(k) ?? null) !== (b.get(k) ?? null)) out.push(`${k}: ${JSON.stringify(a.get(k))} vs ${JSON.stringify(b.get(k))}`);
    return out;
  };
  const problems: string[] = [];
  if (LOST.length) { const onShare = LOST.filter((x) => setup.hasBatch(x)).length; console.log(`  lost appends carried ${LOST.length} batches; on the share in the end: ${onShare}; still the latest value of some field: ${LOST.filter((x) => !setup.hasBatch(x) && [...best.values()].some((c) => c.s === x)).length}`); LOST.length = 0; }
  const lost = diff(expect, fresh);
  if (lost.length) problems.push(`folder differs from every write made (${lost.length}): ${lost.slice(0, 4).join('; ')}`);
  for (const w of writers) {
    const d = diff(fresh, vals(w.s!.store));
    if (d.length) problems.push(`${w.name}'s screen differs from the folder (${d.length}): ${d.slice(0, 4).join('; ')}`);
  }
  if (process.env.DEBUG && problems.length) {
    for (const w of writers) {
      const d = diff(fresh, vals(w.s!.store));
      for (const line of d.slice(0, 2)) {
        const key = line.split(':')[0];
        const [e, f] = key.split('.');
        const c = setup.cell(e, f)!;
        console.log(`  ${w.name} misses ${key}=${JSON.stringify(c.v)} stamp ${c.s} by ${c.w}; has ${JSON.stringify(w.s!.store.cell(e, f))}`);
        for (const n of readdirSync(join(dir, 'journals'))) {
          const buf = new Uint8Array(readFileSync(join(dir, 'journals', n)));
          const txt = Buffer.from(buf).toString('utf8');
          const at = txt.indexOf(c.s);
          if (at >= 0) {
            const startLine = txt.lastIndexOf('\n', at) + 1;
            console.log(`    on share in ${n} (size ${buf.length}) line at byte ${Buffer.byteLength(txt.slice(0, startLine))}; ${w.name}'s seg state: ${JSON.stringify((w.s as any).segs.get(n))}; current seg ${w.s!.currentSegment}`);
          }
        }
        console.log(`    ${w.name} hasBatch=${w.s!.store.hasBatch(c.s)} segs known=${(w.s as any).segs.size} files=${readdirSync(join(dir, 'journals')).length}`);
      }
    }
  }
  for (const w of writers) await w.s!.close();
  return { own: own.size, counts, problems };
}

const SEEDS = (process.env.FUZZ_SEEDS ?? '1,2,3,4,5,6').split(',').map(Number);
const STEPS = Number(process.env.FUZZ_STEPS ?? 260);
let bad = 0;
for (const seed of SEEDS) {
  const t = Date.now();
  try {
    const res = await run(seed, STEPS);
    if (res.problems.length) bad++;
    console.log(`seed ${seed} ${res.problems.length ? 'FAIL' : 'ok'} (${Date.now() - t} ms) own=${res.own} ${JSON.stringify(res.counts)}${res.problems.length ? '\n   ' + res.problems.join('\n   ') : ''}`);
  } catch (e: any) {
    bad++;
    console.log(`seed ${seed} ERROR ${e?.stack?.split('\n').slice(0, 5).join(' | ')}`);
  }
}
console.log(`${bad} of ${SEEDS.length} seeds failed`);
process.exit(0);
