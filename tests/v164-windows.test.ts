// v0.16.4 sheet tabs in their own windows: the tab rules (plain functions the screen runs) and the drop test of a
// tab dragged back onto the main window's tabs. The windows themselves: tests/e2e-v164.mjs.
import './stub-window';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTab, closeTab, floatTab, mainTabOf, overStrip, MAX_TABS, type SheetTab } from '../src/ui/takeoff/Sheets16';

const seq = () => { let n = 0; return () => 't' + ++n; };

test('a tab into its own window and back: only its fl changes, nothing else of it', () => {
  const tabs: SheetTab[] = [{ id: 'a', dwg: 'd1', pg: 0 }, { id: 'b', dwg: 'd2', pg: 3 }];
  const out = floatTab(tabs, 'b', true);
  assert.deepEqual(out[1], { id: 'b', dwg: 'd2', pg: 3, fl: true });
  assert.equal(out[0], tabs[0]);
  assert.deepEqual(floatTab(out, 'b', false)[1], { id: 'b', dwg: 'd2', pg: 3 });
});

test("the main window's tab: the current one when it is there, else the one used last there", () => {
  const tabs: SheetTab[] = [{ id: 'a', dwg: 'd1', pg: 0 }, { id: 'b', dwg: 'd2', pg: 0, fl: true }, { id: 'c', dwg: 'd3', pg: 0 }];
  assert.equal(mainTabOf(tabs, ['a', 'c', 'b'], 'c'), 'c');
  // the current one is in its own window: the main window keeps the one used last there
  assert.equal(mainTabOf(tabs, ['c', 'a', 'b'], 'b'), 'a');
  // nothing used yet: its first
  assert.equal(mainTabOf(tabs, [], 'b'), 'a');
  // every tab away: none
  assert.equal(mainTabOf(floatTab(floatTab(tabs, 'a', true), 'c', true), ['a'], 'b'), null);
});

test('a new tab past the limit closes the docked one used longest ago - never one in its own window', () => {
  const id = seq();
  let tabs: SheetTab[] = [];
  let used: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < MAX_TABS; i++) ({ tabs, used, cur } = openTab(tabs, used, { dwg: 'd' + i, pg: 0 }, id));
  // the oldest two are in windows of their own
  tabs = floatTab(floatTab(tabs, tabs[0].id, true), tabs[1].id, true);
  const away = [tabs[0].id, tabs[1].id];
  ({ tabs, used, cur } = openTab(tabs, used, { dwg: 'new', pg: 0 }, id));
  assert.equal(tabs.length, MAX_TABS);
  for (const a of away) assert.ok(tabs.some((t) => t.id === a), 'a tab in its own window stays');
  assert.ok(!tabs.some((t) => t.dwg === 'd2'), 'the oldest docked tab went');
  assert.equal(tabs.find((t) => t.id === cur)?.dwg, 'new');
});

test('closing the current tab: the one used last before it comes up', () => {
  const tabs: SheetTab[] = [{ id: 'a', dwg: 'd1', pg: 0 }, { id: 'b', dwg: 'd2', pg: 0, fl: true }, { id: 'c', dwg: 'd3', pg: 0 }];
  assert.equal(closeTab(tabs, ['a', 'b', 'c'], 'c', 'c').cur, 'b');
  assert.equal(closeTab(tabs, ['b', 'c', 'a'], 'b', 'a').cur, 'a');
});

test('a tab let go over the main tabs (screen points, a little room above and below)', () => {
  const r = { x: 100, y: 200, w: 600, h: 30 };
  assert.ok(overStrip({ x: 300, y: 215 }, r));
  assert.ok(overStrip({ x: 300, y: 180 }, r), 'just above');
  assert.ok(overStrip({ x: 300, y: 250 }, r), 'just below');
  assert.ok(!overStrip({ x: 300, y: 300 }, r), 'on the drawing below: no');
  assert.ok(!overStrip({ x: 90, y: 215 }, r), 'left of it: no');
  assert.ok(!overStrip({ x: 300, y: 215 }, null), 'the main window not found: no');
});

test('fresh-eyes review: every tab in its own window - an 11th tab never closes one of them', () => {
  const id = seq();
  let tabs: SheetTab[] = [];
  let used: string[] = [];
  for (let i = 0; i < MAX_TABS; i++) ({ tabs, used } = openTab(tabs, used, { dwg: 'd' + i, pg: 0 }, id));
  for (const t of [...tabs]) tabs = floatTab(tabs, t.id, true);
  const r = openTab(tabs, used, { dwg: 'new', pg: 0 }, id);
  assert.equal(r.tabs.length, MAX_TABS + 1);
  assert.equal(r.tabs.filter((t) => t.fl).length, MAX_TABS);
});
