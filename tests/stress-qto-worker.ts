// One simulated QS hammering a take-off project. Run by stress.ts (STRESS_KIND=qto).
// Users work two to a sheet: user k measures on sheet floor(k/2).
import { createRequire } from 'node:module';
import { ProjectSession } from '../src/engine/session';
import { buildQtoModel } from '../src/engine/qto/model';
import { newItemOps, shapeOps, moveShapesOps, vertexOps, linkOps, noteOps } from '../src/engine/qto/ops';
import type { FsApi, Op } from '../src/engine/types';

const require = createRequire(import.meta.url);
const nodefs: FsApi = require('../electron/nodefs.cjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Cfg { projectDir: string; localDir: string; user: string; ops: number; crashAt: number; startAt: number; pace: number }
const cfg: Cfg = JSON.parse(process.argv[2]);
const state = { down: false };
const fs: FsApi = { ...nodefs, append: async (p, t) => { if (state.down) throw Object.assign(new Error('share unreachable'), { code: 'ENETUNREACH' }); return nodefs.append(p, t); } };
const latencies: number[] = [];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

async function main() {
  const s = new ProjectSession({ fs, localFs: nodefs, projectDir: cfg.projectDir, localDir: cfg.localDir, user: cfg.user, host: 'STRESS', pollMs: cfg.pace > 200 ? 1000 : 300, fullScanMs: cfg.pace > 200 ? 10000 : 3000, heartbeatMs: cfg.pace > 200 ? 3000 : 1000 });
  const t0 = Date.now();
  await s.open();
  const openMs = Date.now() - t0;
  const seenAt = Date.now();
  s.onChange(() => {
    const now = Date.now();
    for (const [, h] of s.store.hist) {
      const last = h[h.length - 1];
      if (last && last.w !== s.writer && last.t > seenAt && !(last as any)._m) { (last as any)._m = 1; latencies.push(now - last.t); }
    }
  });
  const k = Number(cfg.user.replace(/\D/g, '')) - 1;
  const dwg = 'dwg:d' + Math.floor(k / 2);
  const me = cfg.user.toLowerCase();
  const stamps: string[] = [];
  let myItem: string | null = null;
  for (let i = cfg.startAt; i < cfg.ops; i++) {
    const m = buildQtoModel(s.store, null);
    myItem = m.items.find((it) => it.owner === me && it.kind === 'area')?.id ?? null;
    const mine = (m.shapesByPage.get(dwg.slice(0) + '.0') ?? []);
    const r = Math.random();
    let ops: Op[] = [];
    if (!myItem) {
      const n = newItemOps(m, me, 'area');
      ops = [...n.ops, [n.id, 'name', 'Tiles by ' + cfg.user]];
    } else if (r < 0.55 || !mine.length) {
      const x = rnd(100, 3000), y = rnd(100, 2000), w = rnd(20, 200), h = rnd(20, 200);
      ops = shapeOps(myItem, dwg, 0, 'poly', [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], me).ops;
    } else if (r < 0.7) {
      ops = moveShapesOps([pick(mine)], rnd(-5, 5), rnd(-5, 5));
    } else if (r < 0.82) {
      const sh = pick(mine);
      ops = vertexOps(sh, 0, Math.floor(Math.random() * sh.pts.length), [sh.pts[0][0] + rnd(-3, 3), sh.pts[0][1] + rnd(-3, 3)]);
    } else if (r < 0.88) {
      ops = linkOps(myItem, 'b:item' + Math.floor(rnd(1, 30)), 'area').ops;
    } else if (r < 0.93) {
      ops = noteOps({ on: myItem, text: 'note ' + i + ' by ' + cfg.user, to: 'est', by: me, byName: cfg.user }).ops;
    } else if (r < 0.97) {
      ops = [[pick(mine).id, 'del', true]];
    } else {
      const u = s.undo();
      if (u) { await sleep(Math.random() * cfg.pace); continue; }
      ops = [[myItem, 'waste', Math.round(rnd(0, 10))]];
    }
    const b = s.commit(ops);
    if (b) stamps.push(b.s);
    if (i === cfg.crashAt) {
      state.down = true;
      for (let q = 0; q < 5; q++) {
        const b2 = s.commit(shapeOps(myItem!, dwg, 0, 'pt', [[10 + q, 10]], me).ops);
        if (b2) stamps.push(b2.s);
      }
      await (s as any).localChain;
      await nodefs.append(nodefs.join(cfg.projectDir, 'journals', s.currentSegment), '3f2a91c0 {"s":"0mzz');
      process.send!({ type: 'crashed', stamps, at: i + 1 });
      s.kill();
      process.exit(3);
    }
    await sleep(Math.random() * cfg.pace);
  }
  process.send!({ type: 'done', stamps, openMs });
  process.on('message', async (msg: any) => {
    if (msg.type === 'fp') {
      await s.tick();
      const m = buildQtoModel(s.store, null);
      let total = 0;
      for (const q of m.qty.values()) total += q.area;
      process.send!({ type: 'fp', fp: s.store.fingerprint() + ' area=' + total.toFixed(3), pending: s.pendingCount, latencies });
    } else if (msg.type === 'stop') {
      await s.close();
      process.exit(0);
    }
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
