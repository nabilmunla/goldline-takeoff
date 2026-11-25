// Pre-release hunt, ritual run 3 (0.15.0): the new background paths against the old ones.
// run: node --import tsx --test tests/ritual15-app.test.ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ProjectSession } from '../src/engine/session';
import { createProject, readProjectStore } from '../src/engine/projects';
import { buildModel } from '../src/engine/boq';
import { demoBoqOps } from './helpers/demoboq';
import type { FsApi } from '../src/engine/types';

const require = createRequire(import.meta.url);
const nodefs: FsApi = require('../electron/nodefs.cjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'gt-r3-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OPEN: ProjectSession[] = [];
after(async () => { for (const s of OPEN.splice(0)) await s.close().catch(() => {}); });
function session(dir: string, account: string, localDir: string, o: { quiet?: boolean; host?: string } = {}) {
  const s = new ProjectSession({
    fs: nodefs, localFs: nodefs, projectDir: dir, localDir, user: account, account, host: o.host ?? 'PC-' + account,
    pollMs: 3600000, fullScanMs: 0, heartbeatMs: 3600000, quiet: o.quiet, adoptQueued: true,
  });
  OPEN.push(s);
  return s;
}
const drain = async (s: ProjectSession) => { for (let i = 0; i < 250 && s.pendingCount; i++) await sleep(20); };
const journals = (dir: string) => readdirSync(join(dir, 'journals')).filter((f) => f.endsWith('.log'));

async function setup() {
  const root = tmp();
  const e = await createProject(nodefs, root, 'Harbour Villas BOQ', 'Ahmed', 'PC1', demoBoqOps(), 'ahmed');
  const q = await createProject(nodefs, root, 'Harbour – blockwork', 'Sam Carter', 'PC2', [], 'omar', 'takeoff');
  const item = [...buildModel(await readProjectStore(nodefs, e.dir)).byId.values()].find((n) => n.type === 'item')!;
  return { root, e, q, itemId: item.id };
}

test('the link agent\'s quiet session and the window\'s session of one project at once: each writes its own file, nothing lost, later sessions go on in this PC\'s file', async () => {
  const { e, itemId } = await setup();
  const pc = tmp();
  // the window first, then the agent's quiet session of the same project in the same app
  const win = session(e.dir, 'ahmed', pc);
  await win.open();
  win.commit([[itemId, 'note', 10]], 'Rate');
  const bg = session(e.dir, 'ahmed', pc, { quiet: true });
  await bg.open();
  bg.commit([['qto:x', 'name', 'X']], 'Linked', { recordUndo: false });
  win.commit([[itemId, 'qty', 5]], 'Qty');
  await drain(win); await drain(bg);
  assert.equal(new Set(journals(e.dir)).size, journals(e.dir).length);
  assert.ok(journals(e.dir).length >= 2, 'two files while both write: ' + journals(e.dir).join(', '));
  await bg.close();
  win.commit([[itemId, 'note', 11]], 'Rate');
  await drain(win);
  await win.close();
  // another PC reads everything
  const other = session(e.dir, 'nabil', tmp());
  await other.open();
  assert.equal(other.store.get(itemId, 'note'), 11);
  assert.equal(other.store.get(itemId, 'qty'), 5);
  assert.equal(other.store.get('qto:x', 'name'), 'X');
  // the PC's next session (the agent's, or the window's) reuses its own journal - no new file per session
  const before = journals(e.dir).length;
  const next = session(e.dir, 'ahmed', pc, { quiet: true });
  await next.open();
  next.commit([[itemId, 'note', 12]], 'Rate', { recordUndo: false });
  await drain(next);
  await next.close();
  assert.equal(journals(e.dir).length, before, 'no new journal file for a later session of this PC');
  await sleep(50);
  await other.tick();
  assert.equal(other.store.get(itemId, 'note'), 12);
  // and the quiet sessions never showed anybody in the project
  for (const f of readdirSync(join(e.dir, 'presence'))) {
    const p = JSON.parse(readFileSync(join(e.dir, 'presence', f), 'utf8'));
    if (p.a === 'ahmed' && p.w === next.writer) assert.equal(p.gone, true);
  }
});

test('a journal file of this PC cut short while a quiet session had it (a restore on the server) is never appended to below where others read', async () => {
  const { e, itemId } = await setup();
  const pc = tmp();
  const bg = session(e.dir, 'ahmed', pc, { quiet: true });
  await bg.open();
  for (let i = 0; i < 5; i++) bg.commit([[itemId, 'note', 100 + i]], 'Rate', { recordUndo: false });
  await drain(bg);
  await bg.close();
  const other = session(e.dir, 'nabil', tmp());
  await other.open();
  assert.equal(other.store.get(itemId, 'note'), 104);
  // the server's copy of the folder is put back from earlier in the day: Ahmed's file is shorter
  const mine = journals(e.dir).find((f) => f.startsWith('j_ahmed_'))!;
  const full = readFileSync(join(e.dir, 'journals', mine), 'utf8');
  writeFileSync(join(e.dir, 'journals', mine), full.slice(0, full.indexOf('\n') + 1));
  // the window opens the estimate next: its change must reach the PC that read the longer file
  const win = session(e.dir, 'ahmed', pc);
  await win.open();
  win.commit([[itemId, 'note', 555]], 'Rate');
  await drain(win);
  await other.tick();
  await other.tick();
  assert.equal(other.store.get(itemId, 'note'), 555);
  assert.ok(existsSync(join(e.dir, 'journals', mine)));
});

test('door tags: separators never tell tags apart except between two numbers - D1.1 and D11 are two doors', async () => {
  const { doorTagKey } = await import('../src/engine/qto/model');
  const { planDoorImport, applyDoorPlanOps } = await import('../src/engine/qto/ops');
  // the same door written another way still matches (what 0.15 set out to do)
  for (const [a, b] of [['D-11', 'D11'], ['d 11', 'D11'], ['FD_01', 'FD01'], ['D-A0101-A', 'DA0101A'], ['D.11', 'D11'], ['D1-1', 'D1.1'], ['D 1 / 1', 'D1.1'], [' D11 ', 'D11']]) {
    assert.equal(doorTagKey(a), doorTagKey(b), `${a} = ${b}`);
  }
  // numbers kept apart by a separator are other doors (a type and its variant: D1.1 ... D1.12, D11, D11.2)
  for (const [a, b] of [['D1.1', 'D11'], ['D1.12', 'D11.2'], ['D1-1', 'D11'], ['D2/1', 'D21']]) {
    assert.notEqual(doorTagKey(a), doorTagKey(b), `${a} is not ${b}`);
  }
  // a schedule with both: every door comes in (D11 and D11.2 were left out as "twice in the file")
  const m = { doors: [], doorsGone: new Map(), openings: [] } as any;
  const plan = planDoorImport(m, [{ tag: 'D1.1', w: 900, h: 2100 }, { tag: 'D11', w: 1800, h: 2400 }, { tag: 'D1.12', w: 1000, h: 2100 }, { tag: 'D11.2', w: 1200, h: 2200 }] as any);
  assert.deepEqual(plan.dupes, []);
  assert.equal(applyDoorPlanOps(m, plan).added, 4);
});

test('count by tag: D1.1 and D11 on a sheet are two tags (not one count)', async () => {
  const { findTags, tagKey } = await import('../src/engine/qto/autocount');
  assert.equal(tagKey('d-01'), tagKey('D 01'));
  assert.notEqual(tagKey('D1.1'), tagKey('D11'));
  const w = (t: string, x: number) => ({ t, x0: x, y0: 0, x1: x + 20, y1: 8 });
  const words = [w('D1.1', 0), w('D11', 100), w('D11', 200), w('D1.1', 300), w('D1.12', 400), w('D11.2', 500)];
  assert.equal(findTags(words, 'D11', 'exact').length, 2, 'D11 exactly: the two D11 marks only');
  assert.equal(findTags(words, 'D1.1', 'exact').length, 2);
  const groups = new Set(findTags(words, 'D', 'starts').map((f) => tagKey(f.text)));
  assert.equal(groups.size, 4, 'one count take-off per tag: ' + [...groups].join(', '));
});

test('a settings save that fails while the file still reads: this run goes on with what it was told (BH-003 as meant)', async () => {
  const loadMain = require('./harness/main.cjs');
  const ud = join(tmp(), 'userData');
  mkdirSync(ud, { recursive: true });
  const sp = join(ud, 'settings.json');
  writeFileSync(sp, JSON.stringify({ dataRoot: '\\\\srv\\tenders', lastUsername: 'nabil', theme: 'dark' }, null, 2));
  // the save can't be written (stands in for a full disk): its temporary file can't be made
  const blocker = sp + '.' + process.pid + '.tmp';
  mkdirSync(blocker);
  const M = loadMain(ud);
  assert.equal((await M.invoke('app:info')).dataRoot, '\\\\srv\\tenders');
  assert.equal(await M.invoke('settings:set', { dataRoot: 'S:\\Tenders' }), false, 'the save says it failed');
  const i = await M.invoke('app:info');
  assert.equal(i.dataRoot, 'S:\\Tenders', 'the shared folder just chosen is the one in use (the file still has the old one)');
  assert.equal(i.lastUsername, 'nabil');
  // the next save that works writes it all
  rmSync(blocker, { recursive: true, force: true });
  assert.equal(await M.invoke('settings:set', { theme: 'light' }), true);
  const now = JSON.parse(readFileSync(sp, 'utf8'));
  assert.equal(now.dataRoot, 'S:\\Tenders');
  assert.equal(now.theme, 'light');
  assert.equal((await M.invoke('app:info')).theme, 'light');
});

test('a wall drawn with a door placed half way, continued, split, tagged and duplicated: undo all the way back and redo all the way forward, the same quantities at every step', async () => {
  const { buildQtoModel } = await import('../src/engine/qto/model');
  const { scaleFromRatio } = await import('../src/engine/qto/geometry');
  const { shapeOps, openingOps, replacePointsOps, splitLineOps, reassignOpeningsOps, newShapesIn, setSegTagsOps, duplicateItemOps } = await import('../src/engine/qto/ops');
  const root = tmp();
  const q = await createProject(nodefs, root, 'Harbour – blockwork', 'Sam Carter', 'PC2', [], 'omar', 'takeoff');
  const s = session(q.dir, 'omar', tmp());
  await s.open();
  const S = scaleFromRatio(100), P = (m: number) => m / S;
  s.commit([
    ['pg:d1.0', 'sc', S],
    ['ti:w', 'kind', 'wall'], ['ti:w', 'name', 'Blockwork 200'], ['ti:w', 'ord', 'a0'], ['ti:w', 'h', 3], ['ti:w', 'd', 0.2],
    ['ds:a', 'tag', 'D01'], ['ds:a', 'sw', 1.0], ['ds:a', 'sh', 2.2], ['ds:a', 'ord', 'a0'],
  ], 'Set up', { recordUndo: false });
  const model = () => buildQtoModel(s.store, null);
  const qty = () => {
    const m = model();
    const all = [...m.qty.entries()].filter(([id]) => id.startsWith('ti:')).map(([id, x]) => [id === 'ti:w' ? 'w' : 'copy', Math.round(x.area * 1e6) / 1e6, x.doors, x.lcnt, Math.round(x.llen * 1e6) / 1e6, [...x.byTag.keys()].join(',')]);
    return JSON.stringify([m.shapes.length, m.openings.length, all.sort()]);
  };
  const steps: string[] = [qty()];
  const A: [number, number] = [100, 100], B: [number, number] = [100 + P(10), 100], C: [number, number] = [100 + P(10), 100 + P(6)];
  // 1. the wall so far is saved when D is pressed on it
  const w = shapeOps('ti:w', 'd1', 0, 'line', [A, B], 'omar');
  s.commit(w.ops, 'Measured wall'); steps.push(qty());
  // 2. the door on it
  s.commit(openingOps({ sh: w.id, x: 100 + P(4), y: 100, k: 'door', door: 'ds:a', tag: '', w: null, h: null, lint: true }).ops, 'Door'); steps.push(qty());
  // 3. drawing goes on from there: the same wall, one more corner
  s.commit(replacePointsOps(model().shapes.find((x) => x.id === w.id)!, [A, B, C]), 'Continued line'); steps.push(qty());
  // 4. split at the corner: the door goes onto the part it is on
  const sp = splitLineOps(model().shapes.find((x) => x.id === w.id)!, 1, 'omar')!;
  const gone = sp.ops.filter((o) => o[0].startsWith('sh:') && o[1] === 'del' && o[2] === true).map((o) => o[0]);
  s.commit([...sp.ops, ...reassignOpeningsOps(model().openingsByShape, gone, newShapesIn(sp.ops))], 'Split at the corner'); steps.push(qty());
  // 5. a segment tag on the second part
  const part = model().shapes.find((x) => x.id === sp.id)!;
  s.commit(setSegTagsOps(part, [0], 'T1'), 'Tagged'); steps.push(qty());
  // 6. duplicated with its shapes
  const d = duplicateItemOps(model(), 'ti:w', 'omar', { links: true, shapes: true })!;
  s.commit(d.ops, 'Duplicated take-off'); steps.push(qty());
  assert.equal(new Set(steps).size, steps.length, 'every step changes something: ' + steps.join('\n'));
  for (let i = steps.length - 2; i >= 0; i--) {
    const u = s.undo();
    assert.ok(u && !u.refused && u.skipped === 0, `undo to step ${i}: ${JSON.stringify(u)}`);
    assert.equal(qty(), steps[i], `after undo, as at step ${i}`);
  }
  for (let i = 1; i < steps.length; i++) {
    const r = s.redo();
    assert.ok(r && r.skipped === 0, `redo to step ${i}: ${JSON.stringify(r)}`);
    assert.equal(qty(), steps[i], `after redo, as at step ${i}`);
  }
  // and the shared folder agrees with the screen
  await drain(s);
  assert.equal(JSON.stringify(buildQtoModel(await readProjectStore(nodefs, q.dir), null).qty.get('ti:w')?.area), JSON.stringify(model().qty.get('ti:w')?.area));
});

test('beam steel linked to a BOQ line in MT (metric tonnes, as most BOQs here write it) reaches it in tonnes, not kg', async () => {
  const { unitFactor, unitMismatch, measureForUnit } = await import('../src/engine/qto/units');
  for (const u of ['MT', 'M.T.', 'Mt', 'tn', 'Tonne', 'tons', 'T']) {
    assert.equal(unitFactor(u, 'kg'), 0.001, u + ': kg -> t');
    assert.equal(unitMismatch(u, 'kg'), false, u + ': steel to it is no mismatch');
  }
  for (const u of ['tn', 'Tonne', 'tons', 'T']) assert.equal(measureForUnit(u), 'kg', u + ' is a weight');
  assert.equal(unitFactor('kg', 'kg'), 1);
  // "Mt" is metres on some BOQs: a length linked to it is not converted, and a link made on it is not
  // guessed to be steel
  assert.equal(unitFactor('Mt', 'len'), 1);
  assert.equal(measureForUnit('Mt'), null);
  assert.equal(unitFactor('t', 'vol'), 1);
  assert.equal(unitMismatch('t', 'vol'), true, 'concrete volume linked to a tonnes line is flagged');
});

test('the drawing area measured: a fit on the guessed size is made again, and a sheet\'s remembered view is never overwritten by the placeholder', async () => {
  const { measureStep } = await import('../src/ui/takeoff/viewlogic');
  const at = (o: Partial<Parameters<typeof measureStep>[0]>) => measureStep({ real: true, sized: false, remembered: false, fitOnGuess: false, viewSet: false, ...o });
  // the first measure, nothing set up yet and nothing remembered: fitted on the real size
  assert.equal(at({}), 'fit');
  // the sheet's view was set up first - a fit on the guessed 800 x 600: fitted again on the real size
  assert.equal(at({ remembered: true, fitOnGuess: true, viewSet: true }), 'fit');
  // the measure comes before a sheet seen before has its view back: the placeholder on screen is not
  // stored over the remembered view (the effect restores it next). Before: stored - the sheet then opened
  // at 0.3 in the top left corner (e2e-xyscale's second sheet, 29.492 m instead of 13.233 m)
  assert.equal(at({ remembered: true }), 'wait');
  // a sheet whose remembered view is on screen: later measures keep it as it is (no jump)
  assert.equal(at({ remembered: true, viewSet: true }), 'keep');
  assert.equal(at({ sized: true, remembered: true, viewSet: true }), 'keep');
  // an area not laid out yet (0 x 0) is not a measure: nothing fitted to it
  assert.equal(at({ real: false }), 'wait');
  assert.equal(at({ real: false, viewSet: true, remembered: true, fitOnGuess: true }), 'keep');
});
