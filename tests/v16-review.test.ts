// v0.16.0 fresh-eyes review: findings that lost or changed quantities, each with the test that failed first.
// run: node --import tsx --test tests/v16-review.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, type QtoModel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { roomTree } from '../src/engine/qto/rooms';
import { linkToRoomOps } from '../src/engine/qto/roomops';
import { codeTotals } from '../src/engine/qto/finishes';
import type { Op, Batch } from '../src/engine/types';

let seq = 0;
const batch = (ops: Op[], u = 'T'): Batch => { seq++; return { s: String(seq).padStart(10, '0') + '~' + u, w: 'w' + u, u, t: seq, o: ops } as Batch; };
const apply = (st: Store, ops: Op[], u = 'T') => { st.apply(batch(ops, u)); return st; };
const close = (a: unknown, b: number, msg = '', eps = 1e-9) => assert.ok(typeof a === 'number' && Math.abs(a - b) < eps, `${msg} ${a} != ${b}`);
const S = scaleFromRatio(100);
const P = (x: number) => x / S;
const J = JSON.stringify;
const rectPts = (x0: number, y0: number, w: number, h: number) => J([P(x0), P(y0), P(x0 + w), P(y0), P(x0 + w), P(y0 + h), P(x0), P(y0 + h)]);
const shape = (id: string, ti: string, k: 'poly' | 'line', p: string, dwg = 'd1'): Op[] => [[id, 'ti', ti], [id, 'dwg', dwg], [id, 'pg', 0], [id, 'k', k], [id, 'p', p]];
const fq = (m: QtoModel, rid: string, key: string) => m.fin.qty.get(rid)!.byKey.get(key);

// A room whose main wall finish / skirting is not set up (no code, no height) - e.g. a corridor where the
// walls are measured as their own take-offs. Linking a coded take-off to its Wall / Skirting, or adding an
// additional wall finish with the "+", must not make that quantity disappear from the room and from the
// Finishes Summary (it is taken out of the summary as a take-off of its own the moment it is linked).
test('room without a main wall finish / skirting: linked take-offs and additional finishes still count', () => {
  const st = apply(new Store(), [
    ['pg:d1.0', 'sc', S],
    ['ti:r', 'kind', 'room'], ['ti:r', 'name', 'Corridor'], ['ti:r', 'ord', 'a0'], ['ti:r', 'fc', 'FL-01'],
    ...shape('sh:r', 'ti:r', 'poly', rectPts(0, 0, 5, 4)),
    // wall tiles measured as an area (coded), and a skirting length (coded)
    ['ti:wt', 'kind', 'area'], ['ti:wt', 'name', 'Wall tiles'], ['ti:wt', 'ord', 'b0'], ['ti:wt', 'fcode', 'WT-01'], ...shape('sh:wt', 'ti:wt', 'poly', rectPts(10, 0, 3, 2)),
    ['ti:sk', 'kind', 'line'], ['ti:sk', 'name', 'Skirting run'], ['ti:sk', 'ord', 'b1'], ['ti:sk', 'fcode', 'SK-09'], ...shape('sh:sk', 'ti:sk', 'line', J([P(10), P(5), P(14), P(5)])),
    // an additional wall finish (the + next to Wall): a feature wall 4.00 m long, 2.00 high
    ['ti:fw', 'kind', 'line'], ['ti:fw', 'name', 'Feature wall'], ['ti:fw', 'rm', 'ti:r'], ['ti:fw', 'rk', 'add'], ['ti:fw', 'rcat', 'wall'], ['ti:fw', 'fcode', 'FW-01'], ['ti:fw', 'h', 2], ['ti:fw', 'bl', 0],
    ...shape('sh:fw', 'ti:fw', 'line', J([P(5), P(0), P(5), P(4)])),
  ]);
  let m = buildQtoModel(st, null);
  const before = codeTotals(m);
  const tot = (code: string) => before.find((c) => c.code === code)?.total;
  close(tot('WT-01'), 6, 'wall tiles in the summary before linking');
  close(tot('SK-09'), 4, 'skirting run in the summary before linking');
  close(fq(m, 'ti:r', 'ti:fw')?.qty, 8, 'the additional feature wall: 4.00 × 2.00');
  for (const [ti, to] of [['ti:wt', 'wall'], ['ti:sk', 'skirting']] as const) {
    const r = linkToRoomOps(m, ti, 'ti:r', to);
    assert.ok('ops' in r, JSON.stringify(r));
    apply(st, r.ops);
    m = buildQtoModel(st, null);
  }
  const after = codeTotals(m);
  const tot2 = (code: string) => after.find((c) => c.code === code)?.total;
  close(tot2('WT-01'), 6, 'wall tiles linked to the room: still in the summary');
  close(tot2('SK-09'), 4, 'skirting run linked to the room: still in the summary');
  close(tot2('FW-01'), 8, 'the additional feature wall: in the summary');
  // and in the room's tree (the take-off list), under Wall / Skirting
  const t = roomTree(m.fin.qty.get('ti:r')!);
  assert.deepEqual(t.wall?.children.map((c) => c.f.key).sort(), ['ti:fw', 'ti:wt']);
  assert.deepEqual(t.skirting?.children.map((c) => c.f.key), ['ti:sk']);
  // no main wall / skirting of its own: nothing filed for them (no "Wall finish has no code")
  assert.equal(fq(m, 'ti:r', 'wall'), undefined);
  assert.equal(fq(m, 'ti:r', 'skirting'), undefined);
  assert.ok(!m.fin.uncoded.some((a) => a.room === 'ti:r' && /^(Wall finish|Skirting) /.test(a.reason ?? '')), JSON.stringify(m.fin.uncoded.map((a) => a.reason)));
});
