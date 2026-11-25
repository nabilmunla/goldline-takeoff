// v0.16 group g2 (FEEDBACK items 28-33 in the panel and the Finishes Summary): the non-UI helpers the take-off
// panel and the Summary lay rooms out with (src/ui/takeoff/roomui.ts), the room parts' eyes (listops), and the
// figures they show for the ROOM-SPEC.md examples. Every test fails on 0.15.1 (no rooms, no roomui.ts).
// run: node --import tsx --test tests/v16-g2.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, type QtoModel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { linkableTo, setFinishCodeOps, newRoomOps } from '../src/engine/qto/roomops';
import { summarize, suggestCodes, portionLinkOps, rowPredicate, saveBreakdownOps, type FinRow } from '../src/engine/qto/finishes';
import { hiddenItemsOf } from '../src/engine/qto/listops';
import { roomLines, roomSelection, roomWarnings, openEdgeCount, linkChoices, groupKeys, groupKeyLabel, moveKey, summaryLines, sameBreakdown, rowPathLabel, roomIsBlank, atomText, boqLineText, roomLabel, DEFAULT_ROOM_NAME } from '../src/ui/takeoff/roomui';
import type { Op, Batch } from '../src/engine/types';

let seq = 0;
const batch = (ops: Op[], u = 'T'): Batch => { seq++; return { s: String(seq).padStart(10, '0') + '~' + u, w: 'w' + u, u, t: seq, o: ops } as Batch; };
const apply = (st: Store, ops: Op[], u = 'T') => { st.apply(batch(ops, u)); return st; };
const close = (a: unknown, b: number, msg = '', eps = 1e-9) => assert.ok(typeof a === 'number' && Math.abs(a - b) < eps, `${msg} ${a} != ${b}`);
const S = scaleFromRatio(100);
const P = (x: number) => x / S;
const J = JSON.stringify;
const rectPts = (x0: number, y0: number, w: number, h: number) => J([P(x0), P(y0), P(x0 + w), P(y0), P(x0 + w), P(y0 + h), P(x0), P(y0 + h)]);
const shape = (id: string, ti: string, k: 'poly' | 'line', p: string, sg?: (string | null)[]): Op[] => [[id, 'ti', ti], [id, 'dwg', 'd1'], [id, 'pg', 0], [id, 'k', k], [id, 'p', p], ...(sg ? [[id, 'sg', J(sg)] as Op] : [])];
const room = (id: string, name: string, f: Record<string, unknown> = {}, ord = 'a0'): Op[] => [[id, 'kind', 'room'], [id, 'name', name], [id, 'ord', ord], ...Object.entries(f).map(([k, v]) => [id, k, v] as Op)];
const door = (id: string, sh: string, x: number, y: number, ds = 'ds:d1'): Op[] => [[id, 'sh', sh], [id, 'x', P(x)], [id, 'y', P(y)], [id, 'k', 'door'], [id, 'door', ds]];
const opening = (id: string, sh: string, x: number, y: number, w: number, h: number, sill: number, tag = ''): Op[] => [[id, 'sh', sh], [id, 'x', P(x)], [id, 'y', P(y)], [id, 'k', 'open'], [id, 'w', w], [id, 'h', h], [id, 'sill', sill], ...(tag ? [[id, 'tag', tag] as Op] : [])];
const part = (id: string, rm: string, cat: string, f: Record<string, unknown> = {}, rk = 'add'): Op[] => [[id, 'kind', cat === 'wall' || cat === 'skirting' ? 'line' : 'area'], [id, 'name', String(f.name ?? 'Additional')], [id, 'rm', rm], [id, 'rk', rk], [id, 'rcat', cat], ...Object.entries(f).filter(([k]) => k !== 'name').map(([k, v]) => [id, k, v] as Op)];
const base: Op[] = [['pg:d1.0', 'sc', S], ['ds:d1', 'tag', 'D1'], ['ds:d1', 'sw', 0.9], ['ds:d1', 'sh', 2.1], ['ds:d2', 'tag', 'D2'], ['ds:d2', 'sw', 0.8], ['ds:d2', 'sh', 2.1]];
const bedroom = (id = 'ti:r1', x0 = 0, extra: Record<string, unknown> = {}, ord = 'a0'): Op[] => [
  ...room(id, 'Master Bedroom', { desc: 'Type A apartment', fc: 'FL-02', wc: 'PT-08', hw: 3, kc: 'SK-01', hs: 0.1, cc: 'CL-01', gc: 'SG-01', gm: 'all', ...extra }, ord),
  ...shape('sh:' + id.slice(3) + 'o', id, 'poly', rectPts(x0, 0, 5, 4)),
  ...door('op:' + id.slice(3) + 'd', 'sh:' + id.slice(3) + 'o', x0 + 1, 0),
  ...opening('op:' + id.slice(3) + 'w', 'sh:' + id.slice(3) + 'o', x0 + 2.5, 4, 1.5, 1.5, 0.9, 'W1'),
];
const wallpaper: Op[] = [...part('ti:wp', 'ti:r1', 'wall', { name: 'Wallpaper', fcode: 'WP-03', h: 2.9, bl: 0.1 }), ...shape('sh:wp', 'ti:wp', 'line', J([P(5), P(0), P(5), P(4)]))];
const line = (m: QtoModel, rid: string, key: string) => roomLines(m, rid).find((l) => l.key === key)!;

test('room lines in the take-off list: Master Bedroom (ROOM-SPEC 9) - Floor, Wall › Wallpaper, Skirting, Ceiling › Shadow gap, codes, quantities, heights, +', () => {
  const m = buildQtoModel(apply(new Store(), [...base, ...bedroom(), ...wallpaper]), null);
  const ls = roomLines(m, 'ti:r1');
  assert.deepEqual(ls.map((l) => [l.key, l.depth, l.label, l.code, l.unit]), [
    ['floor', 0, 'Floor finish', 'FL-02', 'm²'],
    // (v0.18 the panel's order: skirting before the walls)
    ['skirting', 0, 'Skirting', 'SK-01', 'm'],
    ['wall', 0, 'Wall finish', 'PT-08', 'm²'],
    ['ti:wp', 1, 'Wallpaper', 'WP-03', 'm²'],
    ['ceiling', 0, 'Ceiling finish', 'CL-01', 'm²'],
    ['gap', 1, 'Shadow gap', 'SG-01', 'm'],
  ]);
  close(line(m, 'ti:r1', 'floor').qty, 20);
  close(line(m, 'ti:r1', 'wall').qty, 36.55);
  close(line(m, 'ti:r1', 'ti:wp').qty, 11.6);
  close(line(m, 'ti:r1', 'skirting').qty, 17.1);
  close(line(m, 'ti:r1', 'ceiling').qty, 20);
  close(line(m, 'ti:r1', 'gap').qty, 18);
  // heights / modes as the list shows them; + only on the four main finishes; the wallpaper is its own take-off
  assert.equal(line(m, 'ti:r1', 'wall').detail, 'h 3.00');
  assert.equal(line(m, 'ti:r1', 'skirting').detail, 'h 0.10');
  assert.equal(line(m, 'ti:r1', 'ti:wp').detail, 'deduct ✓');
  assert.equal(line(m, 'ti:r1', 'gap').detail, 'perimeter');
  assert.deepEqual(ls.filter((l) => l.plus).map((l) => l.plus), ['floor', 'skirting', 'wall', 'ceiling']);
  assert.equal(line(m, 'ti:r1', 'ti:wp').part, 'ti:wp');
  assert.equal(line(m, 'ti:r1', 'ti:wp').role, 'add');
  // deduct off: the main wall finish is 48.15 again and the line says "on top"
  const m2 = buildQtoModel(apply(new Store(), [...base, ...bedroom(), ...wallpaper, ['ti:wp', 'rded', false]]), null);
  close(line(m2, 'ti:r1', 'wall').qty, 48.15);
  assert.equal(line(m2, 'ti:r1', 'ti:wp').detail, 'on top');
  // the row label
  assert.equal(roomLabel(m.fin.roomById.get('ti:r1')!), 'Master Bedroom — Type A apartment');
});

test('room lines: Bathroom - no skirting (shown empty, "none"), Waterproofing › Horizontal / Vertical never added together', () => {
  const m = buildQtoModel(apply(new Store(), [...base,
    ...room('ti:b', 'Bathroom', { wc: 'WT-01', hw: 2.7, fc: 'FT-01', pc: 'WP-01', pm: 'up', pu: 0.3 }),
    ...shape('sh:b', 'ti:b', 'poly', rectPts(0, 0, 2.5, 2)), ...door('op:bd', 'sh:b', 1, 0, 'ds:d2')]), null);
  const ls = roomLines(m, 'ti:b');
  assert.deepEqual(ls.map((l) => l.key), ['floor', 'skirting', 'wall', 'ceiling', 'wp', 'wph', 'wpv']);
  close(line(m, 'ti:b', 'wall').qty, 22.62);
  assert.equal(line(m, 'ti:b', 'skirting').qty, null);
  assert.equal(line(m, 'ti:b', 'skirting').detail, 'none');
  const wp = line(m, 'ti:b', 'wp');
  assert.deepEqual([wp.code, wp.qty, wp.detail, wp.role], ['WP-01', null, 'upturn 0.30', 'wp']);
  close(line(m, 'ti:b', 'wph').qty, 5);
  close(line(m, 'ti:b', 'wpv').qty, 2.46);
  assert.deepEqual([line(m, 'ti:b', 'wph').code, line(m, 'ti:b', 'wpv').code, line(m, 'ti:b', 'wph').depth], ['WP-01 (horizontal)', 'WP-01 (vertical)', 1]);
  // full wall height to 1.80
  const m2 = buildQtoModel(apply(new Store(), [...base, ...room('ti:b', 'Bathroom', { wc: 'WT-01', hw: 2.7, pc: 'WP-01', pm: 'full', pl: 1.8 }), ...shape('sh:b', 'ti:b', 'poly', rectPts(0, 0, 2.5, 2)), ...door('op:bd', 'sh:b', 1, 0, 'ds:d2')]), null);
  assert.equal(line(m2, 'ti:b', 'wp').detail, 'to 1.80');
  close(line(m2, 'ti:b', 'wpv').qty, 9 * 1.8 - 0.8 * 1.8);
});

test('room lines: Kitchen with an open edge (P = 10), ten typical apartments (Times 10)', () => {
  const m = buildQtoModel(apply(new Store(), [...base, ...room('ti:k', 'Kitchen', { fc: 'FT-02', wc: 'TL-01', hw: 0.6, kc: 'SK-02', hs: 0.1 }), ...shape('sh:k', 'ti:k', 'poly', rectPts(0, 0, 4, 3), ['~o', null, null, null])]), null);
  assert.equal(openEdgeCount(m, 'ti:k'), 1);
  close(m.fin.qty.get('ti:k')!.P, 10); close(m.fin.qty.get('ti:k')!.open, 4);
  close(line(m, 'ti:k', 'floor').qty, 12);
  close(line(m, 'ti:k', 'skirting').qty, 10);
  close(line(m, 'ti:k', 'wall').qty, 10 * 0.5);
  const t = buildQtoModel(apply(new Store(), [...base, ...bedroom('ti:r1', 0, { x: 10 })]), null);
  close(line(t, 'ti:r1', 'floor').qty, 200); close(line(t, 'ti:r1', 'skirting').qty, 171); close(line(t, 'ti:r1', 'wall').qty, 481.5);
});

test('what the properties panel shows for the selection: a room, an additional finish (its room), a manual ceiling area (the ceiling)', () => {
  const m = buildQtoModel(apply(new Store(), [...base, ...bedroom(), ...wallpaper, ['ti:r1', 'cm', 'manual'], ...part('ti:ce', 'ti:r1', 'ceiling', { name: 'Ceiling areas' }, 'ceil'),
    ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Screed'], ['ti:a', 'ord', 'b0']]), null);
  const it = (id: string) => m.itemById.get(id)!;
  assert.deepEqual(roomSelection(m, new Set(['ti:r1']), [it('ti:r1')]), { room: 'ti:r1', focus: null });
  // (a room's own finishes are not rows of the list: picked, they leave the list's take-offs empty)
  assert.deepEqual(roomSelection(m, new Set(['ti:wp']), []), { room: 'ti:r1', focus: 'ti:wp' });
  assert.deepEqual(roomSelection(m, new Set(['ti:ce']), []), { room: 'ti:r1', focus: 'ceiling' });
  assert.equal(roomSelection(m, new Set(['ti:a']), [it('ti:a')]), null);
  assert.equal(roomSelection(m, new Set(['ti:a', 'ti:r1']), [it('ti:r1'), it('ti:a')]), null);
  // the manual ceiling line carries its area take-off (clicking it selects those shapes)
  const ce = roomLines(m, 'ti:r1').find((l) => l.key === 'ceiling')!;
  assert.deepEqual([ce.part, ce.detail], ['ti:ce', 'Manual']);
});

test('room warnings: deductions larger than a finish, a linked take-off with another Times, a door on an open edge, finishes with no code', () => {
  const over = buildQtoModel(apply(new Store(), [...base, ...room('ti:r', 'Store', { fc: 'FL-01', cc: 'CL-01' }), ...shape('sh:r', 'ti:r', 'poly', rectPts(0, 0, 2, 2)),
    ...part('ti:f1', 'ti:r', 'floor', { fcode: 'FL-09', full: true }), ...part('ti:f2', 'ti:r', 'floor', { fcode: 'FL-08' }), ...shape('sh:f2', 'ti:f2', 'poly', rectPts(0, 0, 1, 1))]), null);
  assert.ok(roomWarnings(over, 'ti:r').some((w) => /Deductions are larger/.test(w)));
  assert.ok(roomLines(over, 'ti:r').find((l) => l.key === 'floor')!.over);
  const times = buildQtoModel(apply(new Store(), [...base, ...bedroom('ti:r1', 0, { x: 10 }),
    ['ti:fl', 'kind', 'area'], ['ti:fl', 'name', 'Marble border'], ['ti:fl', 'fcode', 'MB-01'], ['ti:fl', 'rm', 'ti:r1'], ['ti:fl', 'rk', 'link'], ['ti:fl', 'rcat', 'floor'], ...shape('sh:fl', 'ti:fl', 'poly', rectPts(0, 0, 1, 2))]), null);
  assert.ok(roomWarnings(times, 'ti:r1').some((w) => /own Times/.test(w)));
  const fl = roomLines(times, 'ti:r1').find((l) => l.key === 'ti:fl')!;
  assert.deepEqual([fl.role, fl.depth, fl.part, fl.detail], ['link', 1, 'ti:fl', 'deduct ✓']);
  const onOpen = buildQtoModel(apply(new Store(), [...base, ...room('ti:k', 'Kitchen', { hw: 3 }), ...shape('sh:k', 'ti:k', 'poly', rectPts(0, 0, 4, 3), ['~o', null, null, null]), ...door('op:kd', 'sh:k', 1, 0)]), null);
  const w = roomWarnings(onOpen, 'ti:k');
  assert.ok(w.some((x) => /open edge/.test(x)), w.join(' | '));
  // no codes at all: Wall finish (height only) has none -> "has no code"
  assert.ok(w.some((x) => /no code/.test(x)), w.join(' | '));
  assert.deepEqual(roomWarnings(buildQtoModel(apply(new Store(), [...base, ...bedroom()]), null), 'ti:r1'), []);
});

test('Link to room: only the categories a take-off fits (area -> Floor / Wall / Ceiling, length -> Wall / Skirting), the room\'s additional finishes too', () => {
  const m = buildQtoModel(apply(new Store(), [...base, ...bedroom(), ...wallpaper, ...part('ti:ac', 'ti:r1', 'ceiling', { name: 'Antifungal paint', fcode: 'AF-01', full: true }),
    ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Marble'], ['ti:l', 'kind', 'line'], ['ti:l', 'name', 'Border'], ['ti:c', 'kind', 'count'], ['ti:c', 'name', 'Lights']]), null);
  const it = (id: string) => m.itemById.get(id)!;
  assert.deepEqual(linkChoices(m, 'ti:r1', [it('ti:a')], linkableTo).map((c) => c.to), ['floor', 'wall', 'ceiling', 'ti:ac', 'ti:wp']);
  assert.deepEqual(linkChoices(m, 'ti:r1', [it('ti:l')], linkableTo).map((c) => c.to), ['wall', 'skirting', 'ti:wp']);
  assert.deepEqual(linkChoices(m, 'ti:r1', [it('ti:a'), it('ti:l')], linkableTo).map((c) => c.to), ['wall', 'ti:wp']);
  assert.deepEqual(linkChoices(m, 'ti:r1', [it('ti:c')], linkableTo), []);
  assert.equal(linkChoices(m, 'ti:r1', [it('ti:a')], linkableTo).find((c) => c.to === 'ti:ac')!.label, 'Antifungal paint (additional ceiling finish)');
});

test('the Summary\'s grouping levels: as deep as the headings go, then finish type, room name, description; chips reordered', () => {
  const st = apply(new Store(), [['hd:gf', 'name', 'Ground floor'], ['hd:gf', 'ord', 'a0'], ['hd:ga', 'name', 'Block A'], ['hd:ga', 'par', 'hd:gf'], ['hd:ga', 'ord', 'a0']]);
  const m = buildQtoModel(st, null);
  assert.deepEqual(groupKeys(m).map((k) => k.k), ['h0', 'h1', 'head', 'type', 'room', 'desc']);
  assert.equal(groupKeyLabel(m, 'h1'), 'Heading level 2');
  const flat = buildQtoModel(apply(new Store(), [['hd:gf', 'name', 'Ground floor'], ['hd:gf', 'ord', 'a0']]), null);
  assert.deepEqual(groupKeys(flat).map((k) => k.label), ['Heading', 'Finish type', 'Room name', 'Description']);
  assert.deepEqual(groupKeys(buildQtoModel(new Store(), null)).map((k) => k.k), ['type', 'room', 'desc']);
  assert.deepEqual(moveKey(['h0', 'type', 'room'], 2, 0), ['room', 'h0', 'type']);
  assert.deepEqual(moveKey(['h0', 'type', 'room'], 0, 2), ['type', 'room', 'h0']);
  assert.deepEqual(moveKey(['h0'], 3, 0), ['h0']);
});

/** two floors: PT-08 in a bedroom on each, a living room on the ground floor */
const twoFloors = (): Op[] => [...base, ['hd:gf', 'name', 'Ground floor'], ['hd:gf', 'ord', 'a0'], ['hd:ff', 'name', 'First floor'], ['hd:ff', 'ord', 'a1'],
  ...bedroom('ti:r1', 0, { par: 'hd:gf' }), ...bedroom('ti:r2', 10, { par: 'hd:ff' }, 'a1'),
  ...room('ti:liv', 'Living', { desc: 'Type A apartment', wc: 'pt-08', hw: 3, par: 'hd:gf' }, 'a2'), ...shape('sh:liv', 'ti:liv', 'poly', rectPts(20, 0, 3, 3))];
const find = (rows: FinRow[], ...path: string[]): FinRow => {
  let list = rows, r: FinRow | undefined;
  for (const p of path) { r = list.find((x) => x.label === p); assert.ok(r, 'row ' + p + ' in ' + list.map((x) => x.label).join(', ')); list = r!.children; }
  return r!;
};

test('the Summary table lines: rows with subtotals open down to the rooms; closed rows hide theirs; the path label of a portion', () => {
  const m = buildQtoModel(apply(new Store(), twoFloors()), null);
  const s = summarize(m, ['h0', 'type']);
  const pt = find(s.rows, 'PT-08 (m²)');
  close(pt.qty, 48.15 * 2 + 36);
  close(find(s.rows, 'PT-08 (m²)', 'Ground floor').qty, 48.15 + 36);
  // every group row shows; the bottom level opens to its rooms only when asked
  let ls = summaryLines(s, new Set(), new Set(), m.fin.atomById);
  assert.ok(ls.every((l) => l.t === 'row'));
  const gfWall = find(s.rows, 'PT-08 (m²)', 'Ground floor', 'Wall');
  ls = summaryLines(s, new Set(), new Set([gfWall.id]), m.fin.atomById);
  const atoms = ls.filter((l) => l.t === 'atom');
  assert.deepEqual(atoms.map((l) => (l.t === 'atom' ? atomText(l.a).main : '')), ['Living — Type A apartment', 'Master Bedroom — Type A apartment']);
  assert.equal(atoms[0].depth, 3);
  // a closed code row hides everything under it
  ls = summaryLines(s, new Set([pt.id]), new Set([gfWall.id]), m.fin.atomById);
  assert.equal(ls.filter((l) => l.t === 'row' && l.row.key === 'pt-08').length, 1);
  assert.equal(rowPathLabel(s.rows, gfWall), 'PT-08 › Ground floor › Wall');
  assert.equal(rowPathLabel(s.rows, pt), 'PT-08');
  // search: "living" leaves the living room only; filters by type
  const q = summarize(m, ['room'], { q: 'living' });
  assert.deepEqual(find(q.rows, 'PT-08 (m²)').children.map((r) => r.label), ['Living']);
  assert.deepEqual(summarize(m, [], { types: ['Skirting'] }).rows.map((r) => r.code), ['SK-01']);
});

test('saved breakdowns: the one that is this view (same levels and filters, in any order) is picked', () => {
  const st = apply(new Store(), twoFloors());
  let m = buildQtoModel(st, null);
  const b = saveBreakdownOps(m, { name: 'By floor', by: ['h0', 'type'], filter: { types: ['Wall', 'Floor'] } });
  apply(st, b.ops);
  m = buildQtoModel(st, null);
  assert.equal(sameBreakdown(m.fin.breakdowns, ['h0', 'type'], { types: ['Floor', 'Wall'] })?.name, 'By floor');
  assert.equal(sameBreakdown(m.fin.breakdowns, ['type', 'h0'], { types: ['Floor', 'Wall'] }), null);
  assert.equal(sameBreakdown(m.fin.breakdowns, ['h0', 'type'], {}), null);
});

test('a portion linked from a row shows its BOQ line; the code box\'s list ignores case; one code for several take-offs', () => {
  const st = apply(new Store(), [...twoFloors(), ['b:L1', 'bt', 'item'], ['b:L1', 'ref', 'A.1'], ['b:L1', 'desc', 'Emulsion paint to walls'], ['b:L1', 'unit', 'm2'], ['b:L1', 'ord', 'a0'],
    ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Columns paint'], ['ti:a', 'ord', 'c0'], ['ti:b', 'kind', 'line'], ['ti:b', 'name', 'Border'], ['ti:b', 'ord', 'c1']]);
  let m = buildQtoModel(st, null);
  const gf = find(summarize(m, ['h0']).rows, 'PT-08 (m²)', 'Ground floor');
  const r = portionLinkOps(m, rowPredicate(gf), 'b:L1');
  assert.ok(r.ok);
  apply(st, r.ops);
  m = buildQtoModel(st, null);
  assert.equal(boqLineText(m, 'b:L1'), 'A.1 Emulsion paint to walls');
  assert.equal(boqLineText(m, 'b:gone'), '(line removed)');
  // "pt" -> PT-08 (the first spelling kept: the living room wrote pt-08 later)
  assert.deepEqual(suggestCodes(m, 'pt').map((c) => c.code), ['PT-08']);
  assert.deepEqual(suggestCodes(m, 'SK').map((c) => c.code), ['SK-01']);
  apply(st, setFinishCodeOps(m, ['ti:a', 'ti:b', 'ti:r1'], 'sk-01'));
  m = buildQtoModel(st, null);
  assert.deepEqual([m.itemById.get('ti:a')!.fcode, m.itemById.get('ti:b')!.fcode, m.itemById.get('ti:r1')!.fcode], ['SK-01', 'SK-01', ''], 'rooms keep theirs: one code per finish');
});

test('a room\'s own finishes (not rows of the list) are hidden with their room or by their own eye', () => {
  const m = buildQtoModel(apply(new Store(), [...base, ...bedroom(), ...wallpaper]), null);
  const none = hiddenItemsOf(m.itemTree, { items: new Set(), heads: new Set() }, m.roomParts);
  assert.equal(none.size, 0);
  assert.ok(hiddenItemsOf(m.itemTree, { items: new Set(['ti:r1']), heads: new Set() }, m.roomParts).has('ti:wp'));
  const own = hiddenItemsOf(m.itemTree, { items: new Set(['ti:wp']), heads: new Set() }, m.roomParts);
  assert.ok(own.has('ti:wp') && !own.has('ti:r1'));
  // (without the parts given: as before)
  assert.ok(!hiddenItemsOf(m.itemTree, { items: new Set(['ti:r1']), heads: new Set() }).has('ti:wp'));
});

test('a new room: "Room N" until named, nothing set (naming it may bring the last room of that name\'s settings)', () => {
  const st = apply(new Store(), [...base, ...bedroom()]);
  const m = buildQtoModel(st, null);
  const r = newRoomOps(m, 'nabil', { name: '' });
  apply(st, r.ops);
  const m2 = buildQtoModel(st, null);
  const nr = m2.fin.roomById.get(r.id)!;
  assert.ok(DEFAULT_ROOM_NAME.test(nr.name), nr.name);
  assert.ok(roomIsBlank(nr));
  assert.ok(!roomIsBlank(m2.fin.roomById.get('ti:r1')!));
});
