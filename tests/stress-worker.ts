// One simulated user hammering a project. Run by stress.ts as a child process.
import { createRequire } from 'node:module';
import { generateKeyBetween } from 'fractional-indexing';
import { ProjectSession } from '../src/engine/session';
import { buildModel } from '../src/engine/boq';
import { randomId } from '../src/engine/ids';
import type { FsApi, Op } from '../src/engine/types';

const require = createRequire(import.meta.url);
const nodefs: FsApi = require('../electron/nodefs.cjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Cfg { projectDir: string; localDir: string; user: string; ops: number; crashAt: number; startAt: number; pace: number }
const cfg: Cfg = JSON.parse(process.argv[2]);

const state = { down: false };
const fs: FsApi = {
  ...nodefs,
  append: async (p, t) => { if (state.down) throw Object.assign(new Error('share unreachable'), { code: 'ENETUNREACH' }); return nodefs.append(p, t); },
};

const latencies: number[] = [];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

async function main() {
  const s = new ProjectSession({ fs, localFs: nodefs, projectDir: cfg.projectDir, localDir: cfg.localDir, user: cfg.user, host: 'STRESS', pollMs: cfg.pace > 200 ? 1000 : 300, fullScanMs: cfg.pace > 200 ? 10000 : 3000, heartbeatMs: cfg.pace > 200 ? 3000 : 1000 });
  const t0 = Date.now();
  await s.open();
  const openMs = Date.now() - t0;
  // measure how long other users' changes take to reach us
  const seenAt = Date.now();
  s.onChange(() => {
    const now = Date.now();
    for (const [, h] of s.store.hist) {
      const last = h[h.length - 1];
      if (last && last.w !== s.writer && last.t > seenAt && !(last as any)._m) {
        (last as any)._m = 1;
        latencies.push(now - last.t);
      }
    }
  });
  const stamps: string[] = [];
  for (let i = cfg.startAt; i < cfg.ops; i++) {
    const m = buildModel(s.store);
    const items = [...m.byId.values()].filter((n) => n.type === 'item');
    const groups = [...m.byId.values()].filter((n) => n.type === 'group' && n.depth === 1);
    const r = Math.random();
    let ops: Op[] = [];
    if (r < 0.4) ops = [[pick(items).id, 'rate', Math.round(Math.random() * 100000) / 100]];
    else if (r < 0.7) ops = [[pick(items).id, 'qty', Math.round(Math.random() * 1000)]];
    else if (r < 0.8) ops = [[pick(items).id, 'desc', cfg.user + ' edit ' + i + ' ✓ مختبر']];
    else if (r < 0.9) {
      const g = pick(groups);
      const last = g.children[g.children.length - 1];
      const id = 'i' + randomId(10);
      ops = [[id, 'type', 'item'], [id, 'parent', g.id], [id, 'ord', generateKeyBetween(last?.ord || null, null)], [id, 'desc', 'New by ' + cfg.user], [id, 'unit', 'm2'], [id, 'qty', 10], [id, 'rate', 5]];
    } else if (r < 0.92) ops = [[pick(items).id, 'del', true]];
    else if (r < 0.96) {
      // 0.21: tender settings, an item's own markup, a % of tender line - merged like every other field
      const q = Math.random();
      const it = pick(items).id;
      if (q < 0.3) ops = [['project', 'tOh', Math.round(Math.random() * 1000) / 100], ['project', 'tProfit', Math.round(Math.random() * 2000) / 100]];
      else if (q < 0.5) ops = [['project', 'tMode', 'final'], ['project', 'tFinal', Math.round(Math.random() * 1e8)]];
      else if (q < 0.8) ops = Math.random() < 0.5 ? [['mk:' + it, 'del', null], ['mk:' + it, 'm', 'pct'], ['mk:' + it, 'p', Math.round(Math.random() * 50)]] : [['mk:' + it, 'del', true]];
      else { const l = 'ln:' + randomId(10); ops = [[l, 'it', it], [l, 'k', 'pct'], [l, 'q', 0.5], [l, 'ref', 'tender'], [l, 'ord', 'z0'], [l, 'ty', 'S']]; }
    } else {
      const u = s.undo();
      if (u) { await sleep(Math.random() * cfg.pace); continue; }
      ops = [[pick(items).id, 'rate', 1]];
    }
    const b = s.commit(ops);
    if (b) stamps.push(b.s);
    if (i === cfg.crashAt) {
      // share drops, a few more edits land only in the local outbox, then the app dies
      state.down = true;
      for (let k = 0; k < 5; k++) {
        const b2 = s.commit([[pick(items).id, 'qty', 4242 + k]]);
        if (b2) stamps.push(b2.s);
      }
      await (s as any).localChain;
      // leave a torn half-line in the journal like a power cut mid-write would
      await nodefs.append(nodefs.join(cfg.projectDir, 'journals', s.currentSegment), '3f2a91c0 {"s":"0mzz');
      process.send!({ type: 'crashed', stamps, at: i + 1 });
      s.kill();
      process.exit(3);
    }
    await sleep(Math.random() * cfg.pace);
  }
  process.send!({ type: 'done', stamps, openMs });
  // keep syncing and answer fingerprint requests
  process.on('message', async (msg: any) => {
    if (msg.type === 'fp') {
      await s.tick();
      process.send!({ type: 'fp', fp: s.store.fingerprint(), pending: s.pendingCount, latencies });
    } else if (msg.type === 'stop') {
      await s.close();
      process.exit(0);
    }
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
