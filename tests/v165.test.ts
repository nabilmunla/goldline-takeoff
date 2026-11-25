// v0.16.5 (Nabil, 9 Nov): an additional wall finish drawn as an area - wooden cladding of an odd shape on an
// elevation drawing: its m² as drawn (any sheet), on top of the wall finish or taken off it. Bulkheads removed right
// after they are made (the panel's × was never shown) is UI: e2e-v16-g2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, needsFormat165, type QtoModel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { roomWorking } from '../src/engine/qto/rooms';
import { addFinishOps, wallAreaOps, duplicateRoomOps, removeFinishOps } from '../src/engine/qto/roomops';
import { summarize } from '../src/engine/qto/finishes';
import type { Op, Batch } from '../src/engine/types';

let seq = 0;
const batch = (ops: Op[], u = 'T'): Batch => { seq++; return { s: String(seq).padStart(10, '0') + '~' + u, w: 'w' + u, u, t: seq, o: ops } as Batch; };
const apply = (st: Store, ops: Op[], u = 'T') => { st.apply(batch(ops, u)); return st; };
const close = (a: unknown, b: number, msg = '', eps = 1e-6) => assert.ok(typeof a === 'number' && Math.abs(a - b) < eps, `${msg} ${a} != ${b}`);
const S = scaleFromRatio(100);
const S50 = scaleFromRatio(50);
const J = JSON.stringify;
const rect = (s: number, x0: number, y0: number, w: number, h: number) => J([x0 / s, y0 / s, (x0 + w) / s, y0 / s, (x0 + w) / s, (y0 + h) / s, x0 / s, (y0 + h) / s]);
const shape = (id: string, ti: string, k: 'poly' | 'line', p: string, dwg = 'd1'): Op[] => [[id, 'ti', ti], [id, 'dwg', dwg], [id, 'pg', 0], [id, 'k', k], [id, 'p', p]];
const room = (id: string, f: Record<string, unknown> = {}): Op[] => [[id, 'kind', 'room'], [id, 'name', 'Lobby'], [id, 'ord', 'a0'], ...Object.entries(f).map(([k, v]) => [id, k, v] as Op)];
const part = (id: string, rm: string, cat: string, kind: 'line' | 'area', f: Record<string, unknown> = {}): Op[] => [[id, 'kind', kind], [id, 'name', String(f.name ?? 'Part')], [id, 'rm', rm], [id, 'rk', 'add'], [id, 'rcat', cat], ...Object.entries(f).filter(([k]) => k !== 'name').map(([k, v]) => [id, k, v] as Op)];
/** the plan at 1:100 (d1), the elevation at 1:50 (d2) */
const base: Op[] = [['pg:d1.0', 'sc', S], ['pg:d2.0', 'sc', S50]];
const qty = (m: QtoModel, key: string, rid = 'ti:r') => m.fin.qty.get(rid)!.byKey.get(key);
/** a 6 × 4 room (P 20), wall finish PT-01 from the skirting (0.10) to 3.10: 20 × 3.00 = 60 m² */
const r = (f: Record<string, unknown> = {}) => [...base, ...room('ti:r', { wc: 'PT-01', hw: 3.1, hs: 0.1, ...f }), ...shape('sh:r', 'ti:r', 'poly', rect(S, 0, 0, 6, 4))];
/** cladding drawn on the elevation (d2, 1:50): a 2.00 × 2.50 panel and a 1.00 × 0.50 one */
const clad = (f: Record<string, unknown> = {}): Op[] => [...part('ti:c', 'ti:r', 'wall', 'area', { name: 'Wooden cladding', fcode: 'WD-01', wa: true, ...f }),
  ...shape('sh:c1', 'ti:c', 'poly', rect(S50, 10, 10, 2, 2.5), 'd2'), ...shape('sh:c2', 'ti:c', 'poly', rect(S50, 20, 10, 1, 0.5), 'd2')];
const build = (ops: Op[]) => buildQtoModel(apply(new Store(), ops), null);

test('an additional wall drawn as an area: its m² as drawn on the elevation, taken off the wall finish', () => {
  const m = build([...r(), ...clad()]);
  const c = qty(m, 'ti:c')!;
  close(c.qty, 5.5, 'cladding 5.00 + 0.50');
  assert.equal(c.code, 'WD-01');
  assert.equal(c.unit, 'm²');
  close(qty(m, 'wall')!.qty, 60 - 5.5, 'wall finish less the cladding');
  const fl = m.fin.qty.get('ti:r')!.flags;
  assert.ok(!fl.includes('outsideRoom') && !fl.includes('offOutline') && !fl.includes('notDrawn'), 'drawn on another sheet: not flagged - ' + fl.join(','));
  const w = roomWorking(m, 'ti:r').join('\n');
  assert.match(w, /5\.00 \+ 0\.50 \(areas drawn\)/);
  assert.match(w, /Wooden cladding.*deducted\) 5\.50/);
  const rows = summarize(m).rows.map((x) => x.code + '|' + x.unit);
  assert.ok(rows.includes('WD-01|m²') && rows.includes('PT-01|m²'), rows.join(', '));
});

test('an area on top (not deducted): the wall finish stays; Times applies to both', () => {
  const m = build([...r({ x: 2 }), ...clad({ rded: false })]);
  close(qty(m, 'ti:c')!.qty, 11, 'cladding × 2');
  close(qty(m, 'wall')!.qty, 120, 'wall finish × 2, untouched');
});

test('an area with no main wall finish: it counts on its own', () => {
  const m = build([...base, ...room('ti:r', {}), ...shape('sh:r', 'ti:r', 'poly', rect(S, 0, 0, 6, 4)), ...clad()]);
  close(qty(m, 'ti:c')!.qty, 5.5);
  assert.equal(qty(m, 'wall'), undefined);
});

test('not drawn yet: flagged like any additional finish; its height / bottom level play no part', () => {
  const m = build([...r(), ...part('ti:c', 'ti:r', 'wall', 'area', { wa: true, h: 1.2, bl: 0.9 })]);
  close(qty(m, 'ti:c')!.qty, 0);
  close(qty(m, 'wall')!.qty, 60);
  assert.ok(m.fin.qty.get('ti:r')!.flags.includes('notDrawn'));
});

test('made as an area: an area take-off, wa marked, named cladding; format 6 marked by it', async () => {
  const m = build(r());
  const a = addFinishOps(m, 'T', 'ti:r', 'wall', { wa: true })!;
  const f = new Map(a.ops.map((o) => [o[1], o[2]]));
  assert.equal(f.get('kind'), 'area');
  assert.equal(f.get('wa'), true);
  assert.equal(f.get('name'), 'Wall cladding');
  assert.ok(needsFormat165(a.ops as [string, string, unknown][]));
  const plain = addFinishOps(m, 'T', 'ti:r', 'wall')!;
  assert.equal(new Map(plain.ops.map((o) => [o[1], o[2]])).get('kind'), 'line');
  assert.ok(!needsFormat165(plain.ops as [string, string, unknown][]));
  // (a floor never gets it)
  assert.ok(!addFinishOps(m, 'T', 'ti:r', 'floor', { wa: true })!.ops.some((o) => o[1] === 'wa'));
  const { FORMAT_V165, DATA_FORMAT } = await import('../src/engine/version');
  assert.equal(FORMAT_V165, 6);
  assert.ok(DATA_FORMAT >= 6);
});

test('switched along the walls <-> as an area while nothing is drawn; not once drawn; walls only', () => {
  const st = apply(new Store(), [...r(), ...part('ti:w', 'ti:r', 'wall', 'line'), ...part('ti:k', 'ti:r', 'skirting', 'line')]);
  let m = buildQtoModel(st, null);
  const on = wallAreaOps(m, 'ti:w', true);
  assert.ok(Array.isArray(on), JSON.stringify(on));
  apply(st, on as Op[]);
  m = buildQtoModel(st, null);
  assert.equal(m.fin.partById.get('ti:w')!.wa, true);
  assert.equal(m.itemById.get('ti:w')!.kind, 'area');
  assert.deepEqual(wallAreaOps(m, 'ti:w', true), [], 'already');
  assert.ok('error' in (wallAreaOps(m, 'ti:k', true) as object), 'skirting: no');
  apply(st, shape('sh:x', 'ti:w', 'poly', rect(S50, 0, 0, 1, 1), 'd2'));
  m = buildQtoModel(st, null);
  const back = wallAreaOps(m, 'ti:w', false);
  assert.ok('error' in (back as object), 'drawn: remove it first');
  apply(st, removeFinishOps(m, 'ti:w'));
  assert.ok(!buildQtoModel(st, null).fin.partById.has('ti:w'));
});

test('a room copied: its cladding is still an area', () => {
  const st = apply(new Store(), [...r(), ...clad()]);
  const m = buildQtoModel(st, null);
  const d = duplicateRoomOps(m, 'ti:r', 'T', { shapes: true })!;
  apply(st, d.ops);
  const m2 = buildQtoModel(st, null);
  const cp = (m2.fin.partsByRoom.get(d.id) ?? []).find((p) => p.cat === 'wall' && p.rk === 'add')!;
  assert.ok(cp && cp.wa && m2.itemById.get(cp.id)!.kind === 'area');
  close(qty(m2, cp.id, d.id)!.qty, 5.5, 'copy', 1e-4);
});

// ---------------- bulkheads: the underside from the ceiling they run along (Nabil, 9 Nov)
/** a 6 × 4 soffit at 3.20 (GYP-01), a false ceiling 4 × 4 at 2.70 (FC-01) on its left, a raised one 2 × 4 at 3.00 */
const soff = (f: Record<string, unknown> = {}): Op[] => [...base, ...room('ti:r', { cc: 'GYP-01', ch: 3.2, cs: true, ...f }), ...shape('sh:r', 'ti:r', 'poly', rect(S, 0, 0, 6, 4)),
  ...part('ti:fc', 'ti:r', 'ceiling', 'area', { name: 'False ceiling', fcode: 'FC-01', lv: 2.7 }), ...shape('sh:fc', 'ti:fc', 'poly', rect(S, 0, 0, 4, 4)),
  ...part('ti:hc', 'ti:r', 'ceiling', 'area', { name: 'Raised ceiling', fcode: 'FC-02', lv: 3.0 }), ...shape('sh:hc', 'ti:hc', 'poly', rect(S, 4, 0, 2, 4))];
const line = (id: string, ti: string, pts: number[]): Op[] => shape(id, ti, 'line', J(pts.map((v) => v / S)));
const bh = (f: Record<string, unknown> = {}, pts = [4, 0, 4, 4]): Op[] => [...part('ti:b', 'ti:r', 'ceiling', 'line', { name: 'Bulkhead', ak: 'bh', ...f }), ...line('sh:b', 'ti:b', pts)];

test('a bulkhead along a false ceiling\'s edge: its underside is that ceiling\'s height (and its finish) - nothing to type', () => {
  const m = build([...soff(), ...bh()]);
  const b = qty(m, 'ti:b')!;
  close(b.qty, 4);
  assert.equal(b.code, 'FC-01 (bulkhead 500 mm)', 'soffit 3.20 - false ceiling 2.70; the false ceiling\'s finish');
  assert.equal(b.note, undefined);
  assert.match(roomWorking(m, 'ti:r').join('\n'), /underside 2\.70 - False ceiling/);
});

test('its top another ceiling of the room: the drop up to that one', () => {
  // (the line between the false ceiling and the raised one: it rises from 2.70 to 3.00)
  const m = build([...soff(), ...bh({ bp: 'ti:hc' })]);
  assert.equal(qty(m, 'ti:b')!.code, 'FC-01 (bulkhead 300 mm)');
});

test('an underside typed wins; not along any ceiling: it asks for one', () => {
  // (typed: the top's code, as in 0.16.4 - a 0.16.4 bulkhead keeps its code and the links made on it)
  assert.equal(qty(build([...soff(), ...bh({ bh: 2.4 })]), 'ti:b')!.code, 'GYP-01 (bulkhead 800 mm)');
  assert.equal(qty(build([...soff(), ...bh({ fcode: 'BH-01' })]), 'ti:b')!.code, 'BH-01 (bulkhead 500 mm)', 'its own code first');
  const m = build([...soff(), ...bh({}, [1, 1, 3, 1])]);
  const b = qty(m, 'ti:b')!;
  assert.equal(b.code, '');
  assert.match(b.note ?? '', /Not along a ceiling with a height/);
});

test('picked on the room\'s outline where the false ceiling meets the wall: still the false ceiling\'s', () => {
  // (the left wall: the room's edge and the false ceiling's)
  assert.equal(qty(build([...soff(), ...bh({}, [0, 0, 0, 4])]), 'ti:b')!.code, 'FC-01 (bulkhead 500 mm)');
});

test('pieces along ceilings of different heights: said (one bulkhead per drop)', () => {
  const m = build([...soff(), ...part('ti:fc2', 'ti:r', 'ceiling', 'area', { name: 'Low ceiling', lv: 2.4 }), ...shape('sh:fc2', 'ti:fc2', 'poly', rect(S, 0, 4, 4, 1)),
    ...bh({}, [4, 0, 4, 4]), ...line('sh:b2', 'ti:b', [0, 5, 4, 5])]);
  assert.match(qty(m, 'ti:b')!.note ?? '', /different heights/);
});

test('no soffit: the room\'s ceiling is the top, a false ceiling under it the underside', () => {
  const m = build([...base, ...room('ti:r', { cc: 'GYP-01', ch: 3.0 }), ...shape('sh:r', 'ti:r', 'poly', rect(S, 0, 0, 6, 4)),
    ...part('ti:fc', 'ti:r', 'ceiling', 'area', { name: 'False ceiling', fcode: 'FC-01', lv: 2.6 }), ...shape('sh:fc', 'ti:fc', 'poly', rect(S, 0, 0, 4, 4)), ...bh()]);
  assert.equal(qty(m, 'ti:b')!.code, 'FC-01 (bulkhead 400 mm)');
});
