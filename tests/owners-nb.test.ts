// 0.23.2 (DeepSeek #15): a new portion link (its own code only, nb) looked at the rooms of another code's
// "(vertical)" part too - their outlines counted as changed, and the link was refused as view only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapesChanged } from '../src/engine/qto/owners';

test('a new portion link of one code changes only the rooms of that code', () => {
  const atoms = [
    { id: 'a1', key: 'wp-01', base: undefined, unit: 'm2', room: 'ti:ra', src: [], g: {} },
    { id: 'a2', key: 'wp-01 (vertical)', base: 'wp-01', unit: 'm2', room: 'ti:rb', src: [], g: {} },
  ];
  const m: any = {
    shapes: [{ id: 'sh:a', ti: 'ti:ra', k: 'poly', dwg: 'd1', pg: 0 }, { id: 'sh:b', ti: 'ti:rb', k: 'poly', dwg: 'd1', pg: 0 }],
    openings: [],
    links: [],
    itemById: new Map([['ti:ra', { id: 'ti:ra', kind: 'room' }], ['ti:rb', { id: 'ti:rb', kind: 'room' }]]),
    fin: { atoms, atomById: new Map(atoms.map((a) => [a.id, a])), linkById: new Map() },
  };
  const ops: any = [['fl:x', 'code', 'WP-01'], ['fl:x', 'unit', 'm2'], ['fl:x', 'g', '[]'], ['fl:x', 'flt', null], ['fl:x', 'to', 'b:1'], ['fl:x', 'nb', true]];
  assert.deepEqual(shapesChanged(m, ops).map((s) => s.id), ['sh:a']);
  // an older link (no nb) still covers the vertical part as before
  assert.deepEqual(shapesChanged(m, ops.filter((o: any) => o[1] !== 'nb')).map((s) => s.id).sort(), ['sh:a', 'sh:b']);
});
