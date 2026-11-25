// Adversarial sync fuzz: several writers on one project folder making random changes, undoing and
// redoing, with clocks minutes apart, the share dropping out for some of them, appends torn half
// way, apps killed without closing (their unsent edits only in the PC's outbox) and started again.
// At the end, with everyone back online: every PC must hold exactly the same values, equal to a
// fresh read of the folder, and equal to "the latest stamped write of every field" over every
// change any session ever made - nothing lost, nothing invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ProjectSession } from '../src/engine/session';
import { createProject, readProjectStore } from '../src/engine/projects';
import { splitBytes } from '../src/engine/codec';
import type { Batch, FsApi, Op, Value } from '../src/engine/types';
import type { Store } from '../src/engine/store';

const require = createRequire(import.meta.url);
const nodefs: FsApi = require('../electron/nodefs.cjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'gtfuzz-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** the share as one PC sees it: can be offline, can tear the next append half way */
function faultyShare(base: FsApi) {
  const st = { offline: false, tearNext: false };
  const guard = () => { if (st.offline) { const e: any = new Error('EIO: share not reachable'); e.code = 'EIO'; throw e; } };
  const fs: FsApi = {
    join: base.join,
    mkdirp: async (p) => { guard(); return base.mkdirp(p); },
    mkdirExcl: base.mkdirExcl ? async (p) => { guard(); return base.mkdirExcl!(p); } : undefined,
    list: async (d) => { guard(); return base.list(d); },
    readText: async (p) => { guard(); return base.readText(p); },
    readFrom: async (p, o, m) => { guard(); return base.readFrom(p, o, m); },
    append: async (p, text) => {
      guard();
      if (st.tearNext) {
        st.tearNext = false;
        const cut = Math.max(1, Math.floor(text.length / 2));
        await base.append(p, text.slice(0, cut));
        const e: any = new Error('ECONNRESET: write torn'); e.code = 'ECONNRESET'; throw e;
      }
      return base.append(p, text);
    },
    writeAtomic: async (p, t) => { guard(); return base.writeAtomic(p, t); },
    remove: async (p) => { guard(); return base.remove(p); },
    exists: async (p) => { guard(); return base.exists(p); },
  };
  return { fs, st };
}

interface Writer {
  name: string;
  share: ReturnType<typeof faultyShare>;
  localDir: string;
  skew: number;
  s: ProjectSession | null;
}

const vals = (st: Store) => {
  const out = new Map<string, Value>();
  for (const [id, ent] of st.ents) for (const [f, c] of ent) if (id !== 'project' || f !== 'app') out.set(id + '.' + f, c.v ?? null);
  return out;
};

export async function run(seed: number, steps: number) {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'Fuzz', 'Setup', 'PC0', [['e0', 'a', 1]]);
  // every batch any session wrote itself (commit, undo, redo, adopted outbox) - the truth
  const own = new Map<string, Batch>();
  const watch = (s: ProjectSession) => {
    const apply = s.store.apply.bind(s.store);
    s.store.apply = (b: Batch) => { if (b.w === s.writer) own.set(b.s, b); return apply(b); };
  };
  const writers: Writer[] = ['Nabil', 'Ahmed', 'Rami'].map((name, i) => ({ name, share: faultyShare(nodefs), localDir: tmp(), skew: [-95000, 0, 310000][i], s: null }));
  const open = async (w: Writer) => {
    const s = new ProjectSession({ fs: w.share.fs, localFs: nodefs, projectDir: dir, localDir: w.localDir, user: w.name, account: w.name.toLowerCase(), host: 'PC-' + w.name, pollMs: 3600000, fullScanMs: 0, heartbeatMs: 3600000, now: () => Date.now() + w.skew });
    watch(s);
    await s.open();
    w.s = s;
  };
  for (const w of writers) await open(w);
  const ents = Array.from({ length: 12 }, (_, i) => 'e' + i);
  const fields = ['a', 'b', 'c', 'del'];
  const value = (): Value => { const k = r(); return k < 0.4 ? Math.round(r() * 1e6) / 100 : k < 0.7 ? 'v' + Math.floor(r() * 50) : k < 0.85 ? null : k < 0.95 ? true : -0; };
  let crashes = 0, tears = 0, outages = 0;
  const log = process.env.FUZZ_LOG ? (m: string) => console.error(`[${seed}:${Date.now() % 100000}] ${m}`) : () => {};
  for (let i = 0; i < steps; i++) {
    if (i % 20 === 0) log(`step ${i}`);
    const w = pick(writers);
    const s = w.s!;
    const k = r();
    if (k < 0.5) {
      const ops: Op[] = [];
      const n = 1 + Math.floor(r() * 4);
      for (let j = 0; j < n; j++) ops.push([pick(ents), pick(fields), value()]);
      s.commit(ops, 'fuzz');
    } else if (k < 0.62) s.undo();
    else if (k < 0.68) s.redo();
    else if (k < 0.85) await s.tick();
    else if (k < 0.89) { w.share.st.offline = !w.share.st.offline; if (w.share.st.offline) outages++; }
    else if (k < 0.93) { w.share.st.tearNext = true; tears++; }
    else if (k < 0.96) {
      // the app dies: whatever reached the outbox on this PC survives, the session doesn't
      await (s as any).localChain;
      s.kill();
      crashes++;
      // started again (a share that is down when the app starts is a "can't open" message, tested elsewhere)
      w.share.st.offline = false;
      await open(w);
    } else await sleep(5);
  }
  log('steps done');
  // everyone back online; let the queues drain and everybody read everything
  for (const w of writers) { w.share.st.offline = false; w.share.st.tearNext = false; }
  for (let round = 0; round < 40; round++) {
    await Promise.all(writers.map((w) => (w.s as any).pump()));
    for (const w of writers) await w.s!.tick();
    if (writers.every((w) => w.s!.pendingCount === 0)) break;
    await sleep(300);
  }
  for (const w of writers) { await w.s!.tick(); await w.s!.tick(); }
  // expected: per field, the value of the latest-stamped write any session made
  const best = new Map<string, { s: string; v: Value }>();
  const setup = await readProjectStore(nodefs, dir);
  const consider = (b: Batch) => { for (const [e, f, v] of b.o) { const key = e + '.' + f; const c = best.get(key); if (!c || b.s > c.s) best.set(key, { s: b.s, v }); } };
  for (const b of own.values()) consider(b);
  // plus the project's creation batch (written before any session)
  for (const e of readdirSync(join(dir, 'journals'))) {
    if (!e.endsWith('_init.log')) continue;
    for (const b of splitBytes(new Uint8Array(readFileSync(join(dir, 'journals', e)))).batches) consider(b);
  }
  const expect = new Map<string, Value>();
  for (const [k, c] of best) if (!k.startsWith('project.app')) expect.set(k, c.v === undefined ? null : c.v);
  const fresh = vals(setup);
  const diff = (a: Map<string, Value>, b: Map<string, Value>) => {
    const out: string[] = [];
    for (const k of new Set([...a.keys(), ...b.keys()])) if ((a.get(k) ?? null) !== (b.get(k) ?? null)) out.push(`${k}: ${JSON.stringify(a.get(k))} vs ${JSON.stringify(b.get(k))}`);
    return out;
  };
  const lost = diff(expect, fresh);
  assert.deepEqual(lost, [], `seed ${seed}: the folder differs from every write made (${lost.length}): ${lost.slice(0, 5).join('; ')}`);
  for (const w of writers) {
    const d = diff(fresh, vals(w.s!.store));
    assert.deepEqual(d, [], `seed ${seed}: ${w.name}'s screen differs from the folder: ${d.slice(0, 5).join('; ')}`);
  }
  for (const w of writers) await w.s!.close();
  return { own: own.size, crashes, tears, outages };
}

const SEEDS = process.env.FUZZ_SEEDS ? process.env.FUZZ_SEEDS.split(',').map(Number) : [1, 2, 3, 4, 5, 6];
for (const seed of SEEDS) {
  test(`sync fuzz, seed ${seed}: nothing lost, everyone the same`, { timeout: 240000 }, async () => {
    const r = await run(seed, 260);
    assert.ok(r.own > 50, JSON.stringify(r));
  });
}
