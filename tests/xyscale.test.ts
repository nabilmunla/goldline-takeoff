// v0.12.5 separate scales across (X) and up-down (Y) - the PDF Editor's split scale in the take-off:
// a long section drawn with exaggerated heights, a sheet printed stretched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel, scaleAt } from '../src/engine/qto/model';
import { scaleFromRatio, yRatio, segLengthY, pathLengthY, polyLengthY, pathArea, scaleText, arcPoints, type Pt } from '../src/engine/qto/geometry';
import type { Op } from '../src/engine/types';

let stamp = 0;
function storeWith(ops: Op[]): Store {
  const s = new Store();
  s.apply({ s: String(++stamp).padStart(10, '0') + '~t', w: 't', u: 'nabil', t: 0, o: ops, a: 'nabil' });
  return s;
}
const J = (v: unknown) => JSON.stringify(v);
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const S100 = scaleFromRatio(100), S50 = scaleFromRatio(50), S20 = scaleFromRatio(20);

test('geometry: Y counted by the ratio of the scales; arcs become parts of ellipses', () => {
  assert.equal(yRatio(S100, null), 1);
  assert.equal(yRatio(S100, S100), 1);
  close(yRatio(S100, S50), 0.5);
  close(segLengthY([0, 0], [3, 4], 0, 1), 5);
  close(segLengthY([0, 0], [3, 4], 0, 2), Math.hypot(3, 8));
  // a whole circle of radius 10 with Y doubled: an ellipse with half-axes 10 and 20 (Ramanujan)
  const a = 10, b = 20;
  const h = ((a - b) / (a + b)) ** 2;
  const ellipse = Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  const circle: Pt[] = [[-10, 0], [10, 0]];
  close(pathLengthY(circle, [1, 1], true, 2), ellipse, 1e-3);
  close(pathLengthY(circle, [1, 1], true, 1), 2 * Math.PI * 10, 1e-9);
  // areas: the plain area times the ratio (the stretch is affine) - circle and square
  close(pathArea(circle, [1, 1]) * 2, Math.PI * 10 * 20, 1e-9);
  close(polyLengthY([[0, 0], [10, 0], [10, 5], [0, 5]], true, 3), 10 + 15 + 10 + 15);
  // what the sheet shows
  assert.equal(scaleText(S100, '1:100'), '1:100');
  assert.equal(scaleText(S100, '1:100', S100, '1:100'), '1:100');
  assert.equal(scaleText(S100, '1:100', S20, '1:20'), 'X 1:100 · Y 1:20');
  assert.equal(scaleText(S100, '', S20, ''), 'X 1:100 · Y 1:20');
  assert.equal(scaleText(null, ''), '');
});

test('a sheet with its own up-down scale: areas, lengths, perimeters and cut-outs measure true', () => {
  const s = storeWith([
    // a long section: 1:100 across, heights drawn at 1:20
    ['pg:d1.0', 'sc', S100], ['pg:d1.0', 'scl', '1:100'], ['pg:d1.0', 'scy', S20], ['pg:d1.0', 'scyl', '1:20'],
    ['ti:a', 'kind', 'area'], ['ti:a', 'name', 'Wall face'],
    ['ti:l', 'kind', 'line'], ['ti:l', 'name', 'Skirting'],
    // 10 m across (10 / S100 pt), 3 m high (3 / S20 pt)
    ['sh:1', 'ti', 'ti:a'], ['sh:1', 'dwg', 'd1'], ['sh:1', 'pg', 0], ['sh:1', 'k', 'poly'], ['sh:1', 'p', J([100, 100, 100 + 10 / S100, 100, 100 + 10 / S100, 100 + 3 / S20, 100, 100 + 3 / S20])],
    // a door 1 m x 2.1 m cut out of it
    ['sh:1', 'holes', J([[150, 100 + 3 / S20 - 2.1 / S20, 150 + 1 / S100, 100 + 3 / S20 - 2.1 / S20, 150 + 1 / S100, 100 + 3 / S20, 150, 100 + 3 / S20]])],
    // a diagonal: 4 m across and 3 m up = 5 m
    ['sh:2', 'ti', 'ti:l'], ['sh:2', 'dwg', 'd1'], ['sh:2', 'pg', 0], ['sh:2', 'k', 'line'], ['sh:2', 'p', J([100, 500, 100 + 4 / S100, 500 + 3 / S20])],
  ]);
  const m = buildQtoModel(s, null);
  const here = scaleAt(m, 'd1', 0, [10, 10]);
  close(here.sc!, S100);
  close(here.scy!, S20);
  close(here.ry, 0.2); // (a sheet point up-down is a fifth of one across: 1:20 against 1:100)
  assert.equal(here.labelY, '1:20');
  close(m.qty.get('ti:a')!.area, 10 * 3 - 1 * 2.1, 1e-6);
  close(m.qty.get('ti:l')!.len, 5, 1e-6);
});

test('the same scale given both ways is one scale; a sheet without scy is as before', () => {
  const m = buildQtoModel(storeWith([['pg:d1.0', 'sc', S100], ['pg:d1.0', 'scy', S100]]), null);
  assert.equal(scaleAt(m, 'd1', 0, [0, 0]).ry, 1);
  const n = buildQtoModel(storeWith([['pg:d1.0', 'sc', S100]]), null);
  const h = scaleAt(n, 'd1', 0, [0, 0]);
  assert.equal(h.ry, 1);
  assert.equal(h.scy, S100);
  // no scale: none either way
  const o = scaleAt(buildQtoModel(storeWith([]), null), 'd1', 0, [0, 0]);
  assert.equal(o.sc, null);
  assert.equal(o.scy, null);
});

test('a viewport with its own up-down scale: a length piece by piece across its edge', () => {
  const s = storeWith([
    ['pg:d1.0', 'sc', S100],
    ['sr:r1', 'dwg', 'd1'], ['sr:r1', 'pg', 0], ['sr:r1', 'r', J([500, 0, 1500, 1000])], ['sr:r1', 'sc', S50], ['sr:r1', 'scl', '1:50'], ['sr:r1', 'scy', S20], ['sr:r1', 'scyl', '1:20'],
    ['ti:l', 'kind', 'line'], ['ti:l', 'name', 'Edge'],
    // 300 pt across outside (1:100) then 100 pt up inside (Y 1:20)
    ['sh:1', 'ti', 'ti:l'], ['sh:1', 'dwg', 'd1'], ['sh:1', 'pg', 0], ['sh:1', 'k', 'line'], ['sh:1', 'p', J([200, 100, 500 + 200, 100, 700, 200])],
  ]);
  const m = buildQtoModel(s, null);
  // 300 pt at 1:100 + 200 pt at 1:50 (across, in the viewport) + 100 pt at 1:20 (up, in the viewport)
  close(m.qty.get('ti:l')!.len, 300 * S100 + 200 * S50 + 100 * S20, 1e-9);
  assert.equal(scaleAt(m, 'd1', 0, [600, 50]).labelY, '1:20');
});

test('an arc across a viewport edge: every chord counted (the first one was missed before 0.12.5)', () => {
  // a half circle, radius 100 pt, from (470, 200) to (470, 400) bulging to the right: the viewport
  // starts at x = 500, so most of the arc is inside (1:50), its two ends outside (1:100)
  const a: Pt = [470, 200], b: Pt = [470, 400];
  const s = storeWith([
    ['pg:d1.0', 'sc', S100],
    ['sr:r1', 'dwg', 'd1'], ['sr:r1', 'pg', 0], ['sr:r1', 'r', J([500, 0, 1500, 1000])], ['sr:r1', 'sc', S50],
    ['ti:l', 'kind', 'line'], ['ti:l', 'name', 'Arc'],
    ['sh:1', 'ti', 'ti:l'], ['sh:1', 'dwg', 'd1'], ['sh:1', 'pg', 0], ['sh:1', 'k', 'line'], ['sh:1', 'p', J([...a, ...b])], ['sh:1', 'b', J([1])],
  ]);
  const m = buildQtoModel(s, null);
  const pts = [a, ...arcPoints(a, b, 1)];
  assert.ok(pts.some((p) => p[0] > 560), 'the arc bulges into the viewport');
  // the true lengths: inside, the arc where x > 500 (cos θ = 30 / 100 either side of 0); outside the rest
  const th = Math.acos(30 / 100);
  const want = 2 * th * 100 * S50 + (Math.PI - 2 * th) * 100 * S100;
  const got = m.qty.get('ti:l')!.len;
  assert.ok(Math.abs(got - want) / want < 1e-3, `${got} vs ${want}`);
});

test('an up-down scale marks the take-off for newer apps only when one is set: 0.12.4 PCs are not locked out of the rest', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createRequire } = await import('node:module');
  const { ProjectSession } = await import('../src/engine/session');
  const { createProject } = await import('../src/engine/projects');
  const { DATA_FORMAT, BASE_FORMAT, FORMAT_XY_SCALES } = await import('../src/engine/version');
  const nodefs = createRequire(import.meta.url)('../electron/nodefs.cjs');
  const tmp = () => mkdtempSync(join(tmpdir(), 'gtxy-'));
  const open = async (dir: string, user: string, appVersion: string, dataFormat: number, markFormat?: number) => {
    const s = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: dir, localDir: tmp(), user, account: user.toLowerCase(), host: 'PC-' + user, pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000, appVersion, dataFormat, markFormat });
    await s.open();
    return s;
  };
  assert.ok(DATA_FORMAT >= FORMAT_XY_SCALES);
  const { dir } = await createProject(nodefs, tmp(), 'Sections', 'Omar', 'PC1', []);
  // 0.12.5 opens and works without an up-down scale: still format 1
  const a = await open(dir, 'Omar', '0.12.5', DATA_FORMAT, BASE_FORMAT);
  a.commit([['pg:d.0', 'sc', S100]]);
  assert.equal(a.formatSeen().fmt, 1);
  await a.close();
  // 0.12.4 (format 1) can still work in it
  const old = await open(dir, 'Rami', '0.12.4', 1);
  assert.equal(old.readOnly, false);
  await old.close();
  // an up-down scale set: marked format 2 - and 0.12.4 opens it view only
  const b = await open(dir, 'Omar', '0.12.5', DATA_FORMAT, BASE_FORMAT);
  b.needFormat(FORMAT_XY_SCALES);
  b.commit([['pg:d.0', 'scy', S20], ['pg:d.0', 'scyl', '1:20']]);
  b.needFormat(FORMAT_XY_SCALES); // (once is enough)
  assert.equal(b.formatSeen().fmt, 2);
  await b.close();
  const old2 = await open(dir, 'Rami', '0.12.4', 1);
  assert.equal(old2.readOnly, true);
  assert.equal(old2.newerApp, '0.12.5');
  await old2.close();
  // 0.12.5 itself works on in it
  const c = await open(dir, 'Omar', '0.12.5', DATA_FORMAT, BASE_FORMAT);
  assert.equal(c.readOnly, false);
  await c.close();
});

test('across changed alone keeps the old up-down scale in scy0: an up-down scale set at the same time wins', () => {
  const pg = 'pg:d1.0';
  const base: Op[] = [['dwg:d1', 'name', 'S-1.pdf'], [pg, 'sc', S100], [pg, 'scl', '1:100']];
  const S200 = scaleFromRatio(200), S5 = scaleFromRatio(5);
  // A: across 1:200 on a sheet with one scale - the up-down one (1:100) kept in scy0
  const a: Op[] = [[pg, 'sc', S200], [pg, 'scl', '1:200'], [pg, 'scy0', S100], [pg, 'scyl0', '1:100']];
  // B, at the same moment: up-down 1:5
  const b: Op[] = [[pg, 'scy', S5], [pg, 'scyl', '1:5']];
  for (const order of [[a, b], [b, a]]) {
    const s = new Store();
    let n = 0;
    for (const o of [base, ...order]) s.apply({ s: String(++stamp).padStart(10, '0') + '~' + ++n, w: 't', u: 'x', t: 0, o, a: 'x' });
    const m = buildQtoModel(s, null);
    const h = scaleAt(m, 'd1', 0, [10, 10]);
    close(h.sc!, S200);
    close(h.scy!, S5);
    assert.equal(h.labelY, '1:5');
  }
  // only A: across 1:200, up-down still 1:100
  const s = new Store();
  for (const o of [base, a]) s.apply({ s: String(++stamp).padStart(10, '0') + '~a', w: 't', u: 'x', t: 0, o, a: 'x' });
  const h = scaleAt(buildQtoModel(s, null), 'd1', 0, [10, 10]);
  close(h.sc!, S200);
  close(h.scy!, S100);
  assert.equal(h.labelY, '1:100');
});
