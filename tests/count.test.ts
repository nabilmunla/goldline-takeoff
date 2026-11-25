// The anonymous user count (electron/counter.cjs + the pop-up's words in src/ui/counttext.ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as T from '../src/ui/counttext';
const require = createRequire(import.meta.url);
const { create, osName } = require('../electron/counter.cjs');

test('the pop-up and Settings > Privacy say the shared text, word for word', () => {
  const md = fs.readFileSync('tests/fixtures/user-counter-popup.md', 'utf8').replace(/\r/g, '');
  assert.equal(/^Title: (.+)$/m.exec(md)![1], T.COUNT_TITLE);
  const body = md.split('Body:\n')[1].split('\nButtons:')[0].trim().split(/\n\s*\n/).map((x) => x.trim());
  assert.deepEqual(body, T.COUNT_BODY);
  const buttons = [...(/^Buttons: (.+)$/m.exec(md)![1]).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(buttons, [T.COUNT_KEEP, T.COUNT_OFF]);
  assert.equal(/^Switch label: (.+)$/m.exec(md)![1], T.COUNT_SWITCH);
  assert.equal(/^Hint under it: (.+)$/m.exec(md)![1], T.COUNT_HINT);
});

/** a counter with its settings in memory and the worker job recorded */
function rig(endpoint: string, settings: Record<string, unknown> = {}, ok = true) {
  let s: Record<string, unknown> = { ...settings };
  const runs: string[][] = [];
  let t = Date.parse('2026-11-17T09:00:00Z');
  const c = create({ endpoint, version: '0.22.0', readSettings: () => ({ ...s }), writeSettings: (x: Record<string, unknown>) => { s = { ...x }; }, run: async (a: string[]) => { runs.push(a); return ok ? { ok: true } : { ok: false, err: 'ENOTFOUND' }; }, platform: 'win32', now: () => t });
  return { c, runs, s: () => s, later: (h: number) => { t += h * 3600e3; } };
}

test('no receiver (this build): no pop-up, no switch, no number, nothing sent', async () => {
  const r = rig('');
  assert.deepEqual(r.c.init(), { available: false, ask: false, on: false });
  assert.deepEqual(r.c.set(true), { available: false, ask: false, on: false });
  assert.equal(await r.c.tick(), false);
  assert.deepEqual(r.runs, []);
  assert.deepEqual(r.s(), {});
});

test('a random number on first start; nothing sent before the pop-up is answered', async () => {
  const r = rig('https://rx.example.workers.dev');
  assert.deepEqual(r.c.init(), { available: true, ask: true, on: false });
  const id = r.s().countId as string;
  assert.match(id, /^[0-9a-f]{32}$/);
  const other = rig('https://rx.example.workers.dev');
  other.c.init();
  assert.notEqual(other.s().countId, id, 'each install its own number (random, nothing of the PC in it)');
  r.later(30);
  assert.equal(await r.c.tick(), false);
  assert.deepEqual(r.runs, [], 'not answered yet');
  r.c.init();
  assert.equal(r.s().countId, id, 'the number stays (an update keeps the settings)');
});

test('"Keep it on": one ping a day with exactly the number, the version and the OS', async () => {
  const r = rig('https://rx.example.workers.dev');
  r.c.init();
  const id = r.s().countId;
  assert.deepEqual(r.c.set(true), { available: true, ask: false, on: true });
  assert.equal(await r.c.tick(), true);
  assert.equal(await r.c.tick(), false, 'twice the same day: once');
  r.later(5);
  assert.equal(await r.c.tick(), false);
  r.later(24);
  assert.equal(await r.c.tick(), true, 'the next day: again');
  assert.deepEqual(r.runs, [['count', 'https://rx.example.workers.dev', id, '0.22.0', 'Windows'], ['count', 'https://rx.example.workers.dev', id, '0.22.0', 'Windows']]);
  assert.equal(osName('linux'), 'Linux');
});

test('a copy that already has settings (the update that adds the count) is asked once', () => {
  const r = rig('https://rx.example.workers.dev', { theme: 'dark', dataRoot: 'S:\\x' });
  assert.deepEqual(r.c.state(), { available: true, ask: true, on: false });
  r.c.set(false);
  assert.deepEqual(r.c.state(), { available: true, ask: false, on: false });
  assert.equal(r.s().theme, 'dark', 'the other settings are kept');
});

test('no internet: tried again later, quietly', async () => {
  const r = rig('https://rx.example.workers.dev', {}, false);
  r.c.init(); r.c.set(true);
  assert.equal(await r.c.tick(), false);
  assert.equal(r.s().countDay, undefined);
  assert.equal(r.runs.length, 1);
});

test('"Turn it off": the number is deleted and nothing is ever sent', async () => {
  const r = rig('https://rx.example.workers.dev');
  r.c.init();
  assert.deepEqual(r.c.set(false), { available: true, ask: false, on: false });
  assert.equal(r.s().countId, undefined);
  r.c.init();
  assert.equal(r.s().countId, undefined, 'not made again at the next start');
  r.later(48);
  assert.equal(await r.c.tick(), false);
  assert.deepEqual(r.runs, []);
  // turned on again in Settings: a new number
  r.c.set(true);
  assert.match(r.s().countId as string, /^[0-9a-f]{32}$/);
});

test('turned off while a ping is on its way: nothing is written back, no number comes back', async () => {
  let s: Record<string, unknown> = {};
  let release: (v: unknown) => void = () => {};
  const c = create({ endpoint: 'https://rx.example.workers.dev', version: '0.22.0', readSettings: () => ({ ...s }), writeSettings: (x: Record<string, unknown>) => { s = { ...x }; }, run: () => new Promise((r) => { release = r; }), platform: 'linux' });
  c.init(); c.set(true);
  const p = c.tick();
  c.set(false);
  release({ ok: true });
  await p;
  assert.equal(s.countDay, undefined);
  assert.equal(s.countId, undefined);
  assert.equal(s.count, 'off');
});
