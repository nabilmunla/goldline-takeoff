// v0.16.1 door counters: doors not on a wall (cores, partitions) counted with the Count tool into the door schedule.
// Expected figures written from the rules (doorcount.ts header), not read back from the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, itemQty, measuresFor, needsFormat16 } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { doorCounterOps, doorCountOps, doorCountRefusal, DOOR_COUNTER_NAME } from '../src/engine/qto/doorcount';
import type { Op, Batch } from '../src/engine/types';

let seq = 0;
const batch = (ops: Op[], u = 'T'): Batch => { seq++; return { s: String(seq).padStart(10, '0') + '~' + u, w: 'w' + u, u, t: seq, o: ops } as Batch; };
const apply = (st: Store, ops: Op[], u = 'T') => { st.apply(batch(ops, u)); return st; };
const S = scaleFromRatio(100); // metres per sheet point
const P = (x: number) => x / S; // metres -> sheet points
const J = JSON.stringify;
const base: Op[] = [['pg:d1.0', 'sc', S], ['ds:d1', 'tag', 'D1'], ['ds:d1', 'sw', 0.9], ['ds:d1', 'sh', 2.1], ['ds:d2', 'tag', 'D2'], ['ds:d2', 'sw', 0.8], ['ds:d2', 'sh', 2.1]];
const pt = (id: string, ti: string, x: number, y: number, door?: string, m?: number): Op[] => [[id, 'ti', ti], [id, 'dwg', 'd1'], [id, 'pg', 0], [id, 'k', 'pt'], [id, 'p', J([P(x), P(y)])], ...(door ? [[id, 'door', door] as Op] : []), ...(m ? [[id, 'm', m] as Op] : [])];
const counter = (id: string, f: Record<string, unknown> = {}): Op[] => [[id, 'kind', 'count'], [id, 'name', DOOR_COUNTER_NAME], [id, 'dc', true], [id, 'ord', 'a0'], ...Object.entries(f).map(([k, v]) => [id, k, v] as Op)];

test('door counter points count in the door schedule per tag, × their repeat; Times is not applied', () => {
  const st = apply(new Store(), [...base, ...counter('ti:dc', { x: 5 }), ...pt('sh:1', 'ti:dc', 1, 1, 'ds:d1'), ...pt('sh:2', 'ti:dc', 4, 1, 'ds:d1', 2), ...pt('sh:3', 'ti:dc', 8, 1, 'ds:d2')]);
  const m = buildQtoModel(st, null);
  assert.equal(m.doorCount.get('ds:d1'), 3); // 1 + 1 × 2
  assert.equal(m.doorCount.get('ds:d2'), 1);
  assert.equal(itemQty(m, m.itemById.get('ti:dc')!).cnt, 4); // the counter's own row: 4 doors, Times 5 not applied
  assert.deepEqual(measuresFor(m.itemById.get('ti:dc')!), ['cnt']);
});

test('doors on walls and in the counter add up; a private counter and an ordinary count do not reach the schedule', () => {
  const wall: Op[] = [['ti:w', 'kind', 'wall'], ['ti:w', 'name', 'Blockwork'], ['ti:w', 'ord', 'a1'], ['sh:w', 'ti', 'ti:w'], ['sh:w', 'dwg', 'd1'], ['sh:w', 'pg', 0], ['sh:w', 'k', 'line'], ['sh:w', 'p', J([P(0), P(10), P(10), P(10)])],
    ['op:a', 'sh', 'sh:w'], ['op:a', 'x', P(3)], ['op:a', 'y', P(10)], ['op:a', 'k', 'door'], ['op:a', 'door', 'ds:d1']];
  const st = apply(new Store(), [...base, ...wall, ...counter('ti:dc'), ...pt('sh:1', 'ti:dc', 1, 1, 'ds:d1'),
    ...counter('ti:p', { priv: true, owner: 'T' }), ...pt('sh:2', 'ti:p', 2, 2, 'ds:d1'),
    ['ti:c', 'kind', 'count'], ['ti:c', 'name', 'Sockets'], ['ti:c', 'ord', 'a2'], ...pt('sh:3', 'ti:c', 3, 3, 'ds:d1')]);
  const m = buildQtoModel(st, null);
  assert.equal(m.doorCount.get('ds:d1'), 2); // 1 on the wall + 1 in the shared counter
});

test("a door counter's own BOQ link is ignored (its doors go through the schedule: never twice)", () => {
  const st = apply(new Store(), [...base, ...counter('ti:dc'), ...pt('sh:1', 'ti:dc', 1, 1, 'ds:d1'), ['b:L1', 'bt', 'item'], ['b:L1', 'unit', 'nr'], ['b:L1', 'desc', 'Doors'],
    ['lk:1', 'ti', 'ti:dc'], ['lk:1', 'to', 'b:L1'], ['lk:1', 'q', 'cnt'], ['lk:2', 'ti', 'ds:d1'], ['lk:2', 'to', 'b:L1'], ['lk:2', 'q', 'cnt']]);
  const m = buildQtoModel(st, null);
  assert.equal(m.boqQty.get('L1')?.total, 1);
});

test('deducted from an area at each door\'s schedule size; dmin keeps small ones in', () => {
  const area: Op[] = [['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Core paint'], ['ti:a', 'ord', 'a1'], ['ti:a', 'ded', J(['ti:dc'])], ['sh:a', 'ti', 'ti:a'], ['sh:a', 'dwg', 'd1'], ['sh:a', 'pg', 0], ['sh:a', 'k', 'poly'], ['sh:a', 'p', J([P(0), P(0), P(10), P(0), P(10), P(10), P(0), P(10)])]];
  const st = apply(new Store(), [...base, ...area, ...counter('ti:dc'), ...pt('sh:1', 'ti:dc', 1, 1, 'ds:d1'), ...pt('sh:2', 'ti:dc', 4, 1, 'ds:d2', 2)]);
  let m = buildQtoModel(st, null);
  const want = 0.9 * 2.1 + 2 * 0.8 * 2.1; // 1.89 + 3.36 = 5.25
  assert.ok(Math.abs(itemQty(m, m.itemById.get('ti:a')!).dedArea - want) < 1e-9);
  assert.ok(Math.abs(itemQty(m, m.itemById.get('ti:a')!).area - (100 - want)) < 1e-9);
  apply(st, [['ti:a', 'dmin', 1.8]]); // D2 (1.68 m²) stays in, D1 (1.89 m²) comes off
  m = buildQtoModel(st, null);
  assert.ok(Math.abs(itemQty(m, m.itemById.get('ti:a')!).dedArea - 1.89) < 1e-9);
  assert.equal(itemQty(m, m.itemById.get('ti:a')!).keptOpenings, 2);
});

test('the same door twice at one place is refused: on a wall, or counted already', () => {
  const wall: Op[] = [['ti:w', 'kind', 'wall'], ['ti:w', 'name', 'Blockwork'], ['ti:w', 'ord', 'a1'], ['sh:w', 'ti', 'ti:w'], ['sh:w', 'dwg', 'd1'], ['sh:w', 'pg', 0], ['sh:w', 'k', 'line'], ['sh:w', 'p', J([P(0), P(10), P(10), P(10)])],
    ['op:a', 'sh', 'sh:w'], ['op:a', 'x', P(3)], ['op:a', 'y', P(10)], ['op:a', 'k', 'door'], ['op:a', 'door', 'ds:d1']];
  const st = apply(new Store(), [...base, ...wall, ...counter('ti:dc'), ...pt('sh:1', 'ti:dc', 6, 6, 'ds:d1')]);
  const m = buildQtoModel(st, null);
  assert.match(doorCountRefusal(m, 'd1', 0, [P(3.3), P(10)], 'ds:d1') ?? '', /on the wall/); // 0.3 m from the wall door
  assert.match(doorCountRefusal(m, 'd1', 0, [P(6.2), P(6)], 'ds:d1') ?? '', /already counted/);
  assert.equal(doorCountRefusal(m, 'd1', 0, [P(6.2), P(6)], 'ds:d2'), null); // another door type: fine
  assert.equal(doorCountRefusal(m, 'd1', 0, [P(4), P(10)], 'ds:d1'), null); // 1 m away: another door
});

test('the counter is found or made once; ops mark format 4', () => {
  const st = apply(new Store(), [...base]);
  let m = buildQtoModel(st, null);
  const a = doorCounterOps(m, 'T', '');
  assert.ok(a.ops.some((o) => o[1] === 'dc' && o[2] === true) && a.ops.some((o) => o[1] === 'name' && o[2] === DOOR_COUNTER_NAME));
  apply(st, a.ops);
  m = buildQtoModel(st, null);
  assert.deepEqual(doorCounterOps(m, 'T', '').ops, []); // the existing one
  const d = doorCountOps(a.id, 'd1', 0, [1, 1], 'ds:d1', 'T');
  assert.ok(needsFormat16(d.ops as [string, string, unknown][]) && needsFormat16(a.ops as [string, string, unknown][]));
  apply(st, d.ops);
  assert.equal(buildQtoModel(st, null).doorCount.get('ds:d1'), 1);
});
