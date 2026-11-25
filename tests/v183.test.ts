// v0.18.3 - the DeepSeek hunt on 0.18.1 (12-13 Nov 2026): BUG-001..BUG-007 fixed. Figures worked out by hand above
// each check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, itemQty, measuresFor, IMAGE_FILE_RE, type QtoModel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { memberTypeOps, openingOps, duplicateItemOps, shapeOverrideOps } from '../src/engine/qto/ops';
import { ownership } from '../src/engine/qto/owners';
import { DOOR_COUNTER_NAME } from '../src/engine/qto/doorcount';
import type { Op } from '../src/engine/types';

let stamp = 0;
const storeWith = (ops: Op[]) => { const s = new Store(); s.apply({ s: String(++stamp).padStart(10, '0') + '~t', w: 't', u: 'n', t: 0, o: ops, a: 'n' }); return s; };
const J = (v: unknown) => JSON.stringify(v);
const close = (a: number, b: number, msg = '', eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg} ${a} != ${b}`);
const S = scaleFromRatio(100);
const P = (m: number) => m / S;
const base: Op[] = [['pg:d1.0', 'sc', S]];
const sh = (id: string, ti: string, k: 'poly' | 'line' | 'pt', pts: number[], f: Record<string, unknown> = {}): Op[] => [[id, 'ti', ti], [id, 'dwg', 'd1'], [id, 'pg', 0], [id, 'k', k], [id, 'p', J(pts.map(P))], ...Object.entries(f).map(([k, v]) => [id, k, v] as Op)];
const item = (id: string, kind: string, f: Record<string, unknown> = {}): Op[] => [[id, 'kind', kind], [id, 'name', id], [id, 'ord', 'a0'], ...Object.entries(f).map(([k, v]) => [id, k, v] as Op)];
const build = (ops: Op[]): QtoModel => buildQtoModel(storeWith(ops), null);
const q = (ops: Op[], id: string) => { const m = build(ops); return itemQty(m, m.itemById.get(id)!); };

test('BUG-001 a retaining wall gets its blinding and polythene: its strip grown by the projection, and past its two ends', () => {
  const ops: Op[] = [...base, ...memberTypeOps('rt', { name: 'RW1', w: 0.3, d: null, r: null, color: '#111' }, 'rt:1').ops,
    ...item('ti:w', 'wall', { sk: 'rw', h: 3, bt: 'rt:1', bln: true, pe: true }), ...sh('sh:w', 'ti:w', 'line', [0, 0, 10, 0])];
  const r = q(ops, 'ti:w');
  // (10 + 2 × 0.05) × (0.30 + 2 × 0.05) = 10.1 × 0.4 = 4.04 m² ; × 0.05 = 0.202 m³
  close(r.pea, 4.04); close(r.blv, 0.202);
  assert.ok(measuresFor(build(ops).itemById.get('ti:w')!).includes('blv') && measuresFor(build(ops).itemById.get('ti:w')!).includes('pea'));
  // an L-shaped wall 10 + 5: strips 10 × 0.4 + 5 × 0.4 = 6, the two ends 2 × 0.05 × 0.4 = 0.04
  const l = [...ops.filter((o) => o[0] !== 'sh:w'), ...sh('sh:w', 'ti:w', 'line', [0, 0, 10, 0, 10, 5])];
  close(q(l, 'ti:w').pea, 6.04);
  // a closed wall (a ring): no ends
  const ring = [...ops.filter((o) => o[0] !== 'sh:w'), ...sh('sh:w', 'ti:w', 'line', [0, 0, 10, 0, 10, 5, 0, 5, 0, 0])];
  close(q(ring, 'ti:w').pea, 30 * 0.4);
  // not ticked: none
  const r0 = q(ops.filter((o) => o[1] !== 'bln' && o[1] !== 'pe'), 'ti:w');
  assert.equal(r0.blv + r0.pea, 0);
});

test('BUG-002 a duplicated door counter keeps its doors (the copy counts the doors it shows)', () => {
  const ops: Op[] = [...base, ['ds:d1', 'tag', 'D1'], ['ds:d1', 'sw', 0.9], ['ds:d1', 'sh', 2.1],
    ['ti:dc', 'kind', 'count'], ['ti:dc', 'name', DOOR_COUNTER_NAME], ['ti:dc', 'dc', true], ['ti:dc', 'ord', 'a0'],
    ...sh('sh:1', 'ti:dc', 'pt', [1, 1], { door: 'ds:d1' })];
  const m = build(ops);
  assert.equal(m.doorCount.get('ds:d1'), 1);
  const d = duplicateItemOps(m, 'ti:dc', 'nabil', { links: false, shapes: true })!;
  const m2 = build([...ops, ...d.ops]);
  assert.equal(m2.doorCount.get('ds:d1'), 2, 'the copy\'s door is counted too');
  assert.ok(m2.shapes.filter((s) => s.ti !== 'ti:dc' && s.k === 'pt').every((s) => s.door === 'ds:d1'));
});

test('BUG-003 a false ceiling set above the room height: flagged, not measured, the soffit stays', () => {
  // a 5 × 4 room, 3.00 to the soffit; a full-room false ceiling typed at 3.40
  const room: Op[] = [...base, ['ti:r', 'kind', 'room'], ['ti:r', 'name', 'Bedroom'], ['ti:r', 'ord', 'a0'], ['ti:r', 'cs', true], ['ti:r', 'cc', 'PT-05'], ['ti:r', 'rmh', 3],
    ...sh('sh:r', 'ti:r', 'poly', [0, 0, 5, 0, 5, 4, 0, 4]),
    ['ti:fc', 'kind', 'area'], ['ti:fc', 'name', 'False ceiling'], ['ti:fc', 'rm', 'ti:r'], ['ti:fc', 'rk', 'add'], ['ti:fc', 'rcat', 'ceiling'], ['ti:fc', 'fcode', 'GF-01'], ['ti:fc', 'full', true], ['ti:fc', 'lv', 3.4]];
  const m = build(room);
  const rq = m.fin.qty.get('ti:r')!;
  assert.ok(rq.flags.includes('fcAbove'), 'flagged: ' + rq.flags.join(','));
  close(rq.byKey.get('ceiling')!.qty, 20, 'the soffit stays 5 × 4');
  close(rq.byKey.get('ti:fc')?.qty ?? 0, 0, 'the false ceiling above it: 0');
  // at 2.70 (under the slab): as before - all covered, no flag
  // (a field written twice in one batch keeps the first value: the level replaced, not added)
  const ok = build(room.map((o) => (o[0] === 'ti:fc' && o[1] === 'lv' ? ['ti:fc', 'lv', 2.7] as Op : o))).fin.qty.get('ti:r')!;
  assert.ok(!ok.flags.includes('fcAbove'));
  close(ok.byKey.get('ceiling')!.qty, 0); close(ok.byKey.get('ti:fc')!.qty, 20);
});

test('BUG-005 an image record whose file is a path is not read (only the names the app gives)', () => {
  for (const ok of ['imlx3k9abc12.png', 'im123.JPG', 'a-b_c.webp']) assert.ok(IMAGE_FILE_RE.test(ok), ok);
  for (const bad of ['..\\..\\Windows\\win.ini', '../x.png', 'C:\\x.png', '\\\\server\\s\\x.png', 'x.png\\..\\y.png', 'a/b.png', 'x.exe', '']) assert.ok(!IMAGE_FILE_RE.test(bad), bad);
  const ops: Op[] = [...base, ['im:1', 'dwg', 'd1'], ['im:1', 'pg', 0], ['im:1', 'x0', 0], ['im:1', 'y0', 0], ['im:1', 'x1', 10], ['im:1', 'y1', 10], ['im:1', 'file', '..\\..\\..\\Windows\\win.ini'], ['im:1', 'pub', true],
    ['im:2', 'dwg', 'd1'], ['im:2', 'pg', 0], ['im:2', 'x0', 0], ['im:2', 'y0', 0], ['im:2', 'x1', 10], ['im:2', 'y1', 10], ['im:2', 'file', 'imabc.png'], ['im:2', 'pub', true]];
  assert.deepEqual(build(ops).images.map((i) => i.id), ['im:2']);
});

test('BUG-006 an element\'s own figures on someone else\'s shape: refused (or joint owner) like any change', () => {
  const ops: Op[] = [...base, ...memberTypeOps('ct', { name: 'C1', w: 0.5, d: 0.5, r: 100, color: '#111' }, 'ct:1').ops,
    ...item('ti:c', 'count', { sk: 'col', bt: 'ct:1', h: 3 }), ...sh('sh:c', 'ti:c', 'pt', [1, 1], { by: 'ahmed' })];
  const m = build(ops);
  const s = m.shapes.find((x) => x.id === 'sh:c')!;
  for (const f of [{ xw: 0.8 }, { xh: 4 }, { xr: 200 }] as const) {
    const o = shapeOverrideOps([s], f as Parameters<typeof shapeOverrideOps>[1]);
    const locked = ownership(m, o, 'nabil', false);
    assert.equal(locked.locked.length, 1, 'refused without "edit other people\'s shapes": ' + JSON.stringify(f));
    const joint = ownership(m, o, 'nabil', true);
    assert.ok(joint.locked.length === 0 && joint.ops.some((e) => e[0] === 'sh:c' && e[1] === 'co:nabil'), 'joint owner with it: ' + JSON.stringify(f));
  }
  // his own: no question
  assert.equal(ownership(m, shapeOverrideOps([s], { xw: 0.8 }), 'ahmed', false).locked.length, 0);
});

test('BUG-007 a wall takes off only the part of an opening within its height (as a plain length)', () => {
  const ops: Op[] = [...base, ...item('ti:w', 'wall', { h: 2.5, d: 0.2 }), ...sh('sh:w', 'ti:w', 'line', [0, 0, 2, 0]),
    ...item('ti:l', 'line', { h: 2.5 }), ...sh('sh:l', 'ti:l', 'line', [0, 5, 2, 5])];
  const op = (s: string, y: number, sill: number | null) => { const o = openingOps({ sh: s, x: P(1), y: P(y), k: 'open', door: null, tag: '', w: 1, h: 3, lint: false, sill }); return 'ops' in o ? o.ops : []; };
  // 1.00 × 3.00 from the floor in 2.50: 2.50 off - wall 5.00 − 2.50 = 2.50, the same as the length
  const all = [...ops, ...op('sh:w', 0, null), ...op('sh:l', 5, null)];
  const w = q(all, 'ti:w'), l = q(all, 'ti:l');
  close(w.dedArea, 2.5); close(w.area, 2.5); close(l.area, 2.5);
  // (a wall's openings stand on the floor: no sill is asked for them)
  // within the wall: as before (1 × 2 = 2)
  const small = openingOps({ sh: 'sh:w', x: P(1), y: 0, k: 'open', door: null, tag: '', w: 1, h: 2, lint: false, sill: null });
  close(q([...ops, ...('ops' in small ? small.ops : [])], 'ti:w').dedArea, 2);
});
