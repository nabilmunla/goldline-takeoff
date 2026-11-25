// 0.15.1 fixes for DeepSeek's 0.15.0 bug log (BUG-LOG-0.15.0.md), group B: BH-042, BH-043, BH-048,
// BH-049, BH-051, BH-053. Each test states what must hold now; it failed on 0.15.0.
// (BH-044 / BH-045 are keyboard handling in the window: tests/e2e-bugfix151b.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeXlsx } from '../src/engine/xlsxwrite';
import { readXlsx } from '../src/engine/xlsx';
import { analyseDoorSchedule, doorRows } from '../src/engine/qto/doorsched';
import { Store } from '../src/engine/store';
import { buildQtoModel } from '../src/engine/qto/model';
import { scaleFromRatio } from '../src/engine/qto/geometry';
import { beamTypeOps } from '../src/engine/qto/ops';
import { exportQto } from '../src/engine/qto/export';
import { buildModel } from '../src/engine/boq';
import * as imagepdf from '../src/ui/takeoff/imagepdf';
import type { Op } from '../src/engine/types';

let seq = 0;
const apply = (st: Store, ops: Op[]) => { seq++; st.apply({ s: String(seq).padStart(10, '0') + '~b', w: 'w', u: 'T', t: seq, o: ops }); return st; };
const close = (a: unknown, b: number, eps = 1e-9) => assert.ok(typeof a === 'number' && Math.abs(a - b) < eps, `${a} != ${b}`);

// ---------------------------------------------------------------- BH-042
test('BH-042: a door schedule in mm under "(cm)" headings is read in mm; cm sizes stay cm; m under "(cm)" stays m', () => {
  const wb = readXlsx(writeXlsx([{ name: 'Door Schedule', rows: [
    ['Tag', 'Width (cm)', 'Height (cm)'],
    ['D1', 900, 2100], // mm typed under the cm headings: was a 9 m x 21 m door
    ['D2', '1000', '2200'],
    ['D3', 90, 210], // centimetres, as the heading says
    ['RS1', 600, 450], // a 6 m roller shutter in centimetres: still 6 m
    ['D4', 0.9, 2.1], // metres under the cm heading: was a 9 mm door
    ['D5', 1000, 2000], // mm with no size over 2000 (0.23.2, DeepSeek #16: was a 10 m x 20 m opening)
    ['D6', 800, 1800], // a low mm door
  ] }]));
  const r = doorRows(wb, analyseDoorSchedule(wb)!);
  assert.deepEqual(r.map((x) => [x.tag, x.sw, x.sh]), [['D1', 0.9, 2.1], ['D2', 1, 2.2], ['D3', 0.9, 2.1], ['RS1', 6, 4.5], ['D4', 0.9, 2.1], ['D5', 1, 2], ['D6', 0.8, 1.8]]);
});

// ---------------------------------------------------------------- BH-043
test('BH-043: the Segments sheet gives every figure of a row x the shape\'s repeat, and adds up to the take-off', () => {
  const S100 = scaleFromRatio(100);
  const P = (m: number) => m / S100;
  const J = JSON.stringify;
  const st = apply(new Store(), [
    ['pg:d1.0', 'sc', S100],
    ['ti:w', 'kind', 'wall'], ['ti:w', 'name', 'Block 200'], ['ti:w', 'ord', 'a0'], ['ti:w', 'h', 3], ['ti:w', 'd', 0.2],
    ['sh:w1', 'ti', 'ti:w'], ['sh:w1', 'dwg', 'd1'], ['sh:w1', 'pg', 0], ['sh:w1', 'k', 'line'], ['sh:w1', 'p', J([100, 100, 100 + P(10), 100, 100 + P(10), 100 + P(6)])],
    ['sh:w1', 'm', 3], // typical floors: drawn once, 3 times
    ...beamTypeOps({ name: 'B1', w: 0.3, d: 0.6, r: 120, color: '#123456' }, 'bt:b1').ops,
    ['ti:b', 'kind', 'beam'], ['ti:b', 'name', 'Beams'], ['ti:b', 'ord', 'a1'], ['ti:b', 'bt', 'bt:b1'],
    ['sh:b1', 'ti', 'ti:b'], ['sh:b1', 'dwg', 'd1'], ['sh:b1', 'pg', 0], ['sh:b1', 'k', 'line'], ['sh:b1', 'p', J([0, 0, P(5), 0])], ['sh:b1', 'm', 2],
  ]);
  const m = buildQtoModel(st, null);
  const seg = readXlsx(exportQto(m, { project: 'T', by: 'me', when: new Date(0) })).sheet('Segments');
  const head = seg.rows.get(4)!.map((c) => c?.v);
  const col = (h: string) => head.indexOf(h);
  const rows = [...seg.rows.entries()].filter(([r]) => r > 4).map(([, row]) => row);
  const sum = (kind: string, h: string) => rows.filter((row) => row[3]?.v === kind).reduce((a, row) => a + Number(row[col(h)]?.v ?? 0), 0);
  // the wall: 16 m x 3 repeats = 48 m; 48 x 3 m high = 144 m² (the take-off's own gross area)
  close(sum('Wall', 'Length (m)'), 48);
  close(sum('Wall', 'Wall area (m²)'), 144);
  close(m.qty.get('ti:w')!.gross, 144);
  // the beam: 5 m x 2 = 10 m, and the concrete beside it on the same basis: 10 x 0.3 x 0.6
  close(sum('Beam', 'Length (m)'), 10);
  close(sum('Beam', 'Concrete (m³)'), 10 * 0.3 * 0.6);
  close(m.qty.get('ti:b')!.len, 10);
});

// ---------------------------------------------------------------- BH-048
test('BH-051: the F1 list names every take-off tool key, and the shape modes as modes', () => {
  const src = readFileSync(new URL('../src/ui/takeoff/TakeoffView.tsx', import.meta.url), 'utf8');
  const tools = src.slice(src.indexOf('const TOOLS'), src.indexOf('];', src.indexOf('const TOOLS')));
  const keys = [...tools.matchAll(/key: '([A-Z])'/g)].map((x) => x[1]);
  assert.equal(keys.length, 12); // (v0.16 g1: + Room F)
  // (Help.tsx is read as text: it pulls in the window's api, which needs a window)
  const help = readFileSync(new URL('../src/ui/Help.tsx', import.meta.url), 'utf8');
  const sec0 = help.slice(help.indexOf("id: 'qto'"));
  // (v0.16: the take-off's keys are one table, keymap.ts - the F1 list and the tool bar "?" are made from it)
  const sec = /QTO_KEY_ROWS/.test(sec0.slice(0, 200)) ? readFileSync(new URL('../src/ui/takeoff/keymap.ts', import.meta.url), 'utf8') : sec0;
  const qto = [...sec.matchAll(/\{ keys: \[([^\]]*)\], what: '([^']*)' \}/g)].map((x) => ({ keys: [...x[1].matchAll(/'([^']*)'/g)].map((y) => y[1]), what: x[2] }));
  assert.ok(qto.length > 10);
  const listed = new Set(qto.flatMap((i) => i.keys));
  for (const k of [...keys, 'P', 'R', 'O', 'D', 'T']) assert.ok(listed.has(k), `${k} is in the list`);
  const modes = qto.find((i) => i.keys.includes('R'))!;
  assert.ok(!modes.keys.includes('V') && /how the next shape is drawn/i.test(modes.what), modes.what);
});

// ---------------------------------------------------------------- BH-053
test('BH-053: a picture is grey only when every pixel is (a small coloured mark is found wherever it is)', () => {
  const isGrey = (imagepdf as Record<string, unknown>).isGrey as ((px: Uint8ClampedArray) => boolean) | undefined;
  assert.equal(typeof isGrey, 'function');
  const W = 700, H = 20; // 700 = 7 x 100: one in seven pixels was looked at, always in the same columns
  const px = new Uint8ClampedArray(W * H * 4).fill(200);
  assert.equal(isGrey!(px), true);
  // a red mark 3 x 3 px between the sampled columns (x = 3..5)
  for (let y = 5; y < 8; y++) for (let x = 3; x < 6; x++) { const i = (y * W + x) * 4; px[i] = 220; px[i + 1] = 30; px[i + 2] = 30; }
  assert.equal(isGrey!(px), false);
  // one pixel is enough, the last one too
  const one = new Uint8ClampedArray(W * H * 4).fill(90);
  one[one.length - 3] = 91;
  assert.equal(isGrey!(one), false);
});
