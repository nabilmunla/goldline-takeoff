// What leaves the PC besides updates (electron/outbound.cjs, reports.cjs, the update worker's "post" and
// "count"): only to the receiver named in package.json, which is empty in this build - then nothing is sent at all
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const out = require('../electron/outbound.cjs');
const reportsMod = require('../electron/reports.cjs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

test('this build names no receiver (nothing sent); setting the two package.json fields is the only switch-on', () => {
  assert.equal(pkg.reportEndpoint, '');
  assert.equal(pkg.countEndpoint, '');
  const keep = { r: process.env.GT_REPORT_ENDPOINT, c: process.env.GT_COUNT_ENDPOINT };
  delete process.env.GT_REPORT_ENDPOINT; delete process.env.GT_COUNT_ENDPOINT;
  try {
    assert.equal(out.endpoint('report', pkg), '');
    assert.equal(out.endpoint('count', pkg), '');
    assert.equal(out.endpoint('report', { reportEndpoint: 'not an address' }), '');
    assert.equal(out.endpoint('report', { reportEndpoint: 'https://r.example.workers.dev' }), 'https://r.example.workers.dev');
    assert.equal(out.endpoint('count', { countEndpoint: 'https://r.example.workers.dev' }), 'https://r.example.workers.dev');
    // (the test variables point at a local receiver - and are ignored by the packaged app)
    process.env.GT_REPORT_ENDPOINT = 'http://127.0.0.1:1';
    assert.equal(out.endpoint('report', pkg), 'http://127.0.0.1:1');
    assert.equal(out.endpoint('report', pkg, true), '');
  } finally { if (keep.r !== undefined) process.env.GT_REPORT_ENDPOINT = keep.r; if (keep.c !== undefined) process.env.GT_COUNT_ENDPOINT = keep.c; }
});

test('the release package.json carries the two fields (a switched-on source is a switched-on release)', () => {
  const { appPackage } = require('../tools/make-payload.cjs');
  const p = appPackage({ ...pkg, reportEndpoint: 'https://r.example.workers.dev', countEndpoint: 'https://r.example.workers.dev' }, '44.0.0');
  assert.equal(p.reportEndpoint, 'https://r.example.workers.dev');
  assert.equal(p.countEndpoint, 'https://r.example.workers.dev');
  const none = appPackage(pkg, '44.0.0');
  assert.equal(none.reportEndpoint, '');
  assert.equal(none.countEndpoint, '');
});

test('a report is posted to /report, marked as this app\'s', () => {
  for (const e of ['https://r.example.workers.dev', 'https://r.example.workers.dev/', 'https://r.example.workers.dev/report']) {
    const r = out.reportRequest(e, { kind: 'problem', app: 'Goldline Takeoff' });
    assert.equal(r.url, 'https://r.example.workers.dev/report');
    assert.equal(r.init.method, 'POST');
    assert.equal(r.init.headers['x-report-client'], 'goldline-takeoff');
    assert.equal(JSON.parse(r.init.body).app, 'Goldline Takeoff');
  }
});

test('the user count\'s ping: POST /count, exactly three keys, at most 200 bytes', () => {
  for (const e of ['https://r.example.workers.dev', 'https://r.example.workers.dev/count']) {
    const r = out.countRequest(e, { id: 'a'.repeat(32), version: '0.22.0', os: 'Windows', extra: 'never' });
    assert.equal(r.url, 'https://r.example.workers.dev/count');
    assert.equal(r.init.method, 'POST');
    assert.equal(r.init.headers['x-report-client'], 'goldline-takeoff');
    // (the receiver's shape: exactly {"id":"<32 lowercase hex>","v":"d.d.d","os":"win|linux|mac"}, 200 bytes at most)
    assert.equal(r.init.body, '{"id":"' + 'a'.repeat(32) + '","v":"0.22.0","os":"win"}');
    assert.deepEqual(Object.keys(JSON.parse(r.init.body)), ['id', 'v', 'os']);
    assert.ok(Buffer.byteLength(r.init.body) <= 200);
    const lin = JSON.parse(out.countRequest(e, { id: 'B'.repeat(32), version: '0.22.0', os: 'Linux' }).init.body);
    assert.equal(lin.os, 'linux');
    assert.equal(lin.id, 'b'.repeat(32));
  }
  assert.equal(JSON.parse(out.countRequest('https://r.example.workers.dev', { id: 'c'.repeat(32), version: '0.22.0-beta', os: 'Mac' }).init.body).v, '0.22.0');
  assert.equal(JSON.parse(out.countRequest('https://r.example.workers.dev', { id: 'c'.repeat(32), version: '1.0.0', os: 'Mac' }).init.body).os, 'mac');
});

/** a local receiver: what reaches it */
async function receiver(status = 200) {
  const got: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { got.push({ url: req.url || '', headers: req.headers, body: b }); res.writeHead(status); res.end('ok'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { got, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((r) => server.close(r)) };
}
const worker = (args: string[]) => new Promise<{ code: number; msgs: string }>((res) => {
  const p = spawn(process.execPath, ['electron/update-worker.cjs', ...args], { stdio: 'ignore' });
  p.on('exit', (c) => res({ code: c ?? 1, msgs: '' }));
});

test('the update worker sends the ping; no internet = it just ends', async () => {
  const rx = await receiver();
  try {
    assert.equal((await worker(['count', rx.url, 'b'.repeat(32), '0.22.0', 'Linux'])).code, 0);
    assert.equal(rx.got.length, 1);
    assert.equal(rx.got[0].url, '/count');
    assert.equal(rx.got[0].headers['x-report-client'], 'goldline-takeoff');
    assert.equal(rx.got[0].body, '{"id":"' + 'b'.repeat(32) + '","v":"0.22.0","os":"linux"}');
  } finally { await rx.close(); }
  const t = Date.now();
  assert.equal((await worker(['count', 'http://127.0.0.1:9', 'b'.repeat(32), '0.22.0', 'Linux'])).code, 0);
  assert.ok(Date.now() - t < 10000);
});

// ------------------------------------------------------------------ the report to the developer (reports.cjs)
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gt-rep-'));
const LOG = [
  '2026-11-09T08:20:25.760Z renderer: sheet A-101 Level 1 Plan ready in 120 ms (local copy)',
  '2026-11-09T09:26:57.475Z renderer: sent 3 change(s) left on this PC for Harbour Villas Phase 2',
  '2026-11-09T09:28:00.475Z renderer: BOQ hub: cannot open \'D:\\Shared\\Harbour Villas\\boq.xlsx\'',
].join('\n');
function makeReports(endpoint: string, dir: string, run: (a: string[]) => Promise<{ ok: boolean; err?: string }>, settings: Record<string, unknown> = {}) {
  return reportsMod.create({ version: '0.22.0', appName: 'Goldline Takeoff', endpoint, readSettings: () => settings, logTail: () => LOG, run, dir: () => dir });
}
const SETTINGS = { dataRoot: 'S:\\Takeoffs\\Harbour Villas', lastUsername: 'maria.k', displayName: 'Maria Kowalski', lastPdfDir: 'D:\\Drawings\\Harbour Villas\\Level 1' };

test('no receiver: no preview, nothing posted, no file written', async () => {
  const dir = tmp();
  const runs: string[][] = [];
  const r = makeReports('', dir, async (a) => { runs.push(a); return { ok: true }; }, SETTINGS);
  assert.equal(r.available(), false);
  assert.equal(r.preview('it froze', { screen: 'project', errors: [], words: [] }), '');
  assert.deepEqual(await r.send('anything'), { state: 'local', err: '' });
  assert.deepEqual(runs, []);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('the preview is exactly what is posted - and carries no host, Windows user, app folder, paths, project or file names', async () => {
  const rx = await receiver();
  const dir = tmp();
  try {
    const me = os.userInfo().username;
    const r = makeReports(rx.url, dir, async (a) => (await worker(a)).code === 0 ? { ok: rx.got.length > 0 } : { ok: false, err: 'worker' }, SETTINGS);
    const ctx = { screen: 'project', errors: ['2026-11-09T08:00:00Z TypeError: cannot read x of C:\\Users\\maria\\Harbour Villas\\a.pdf'], words: ['Maria Kowalski', 'maria.k', 'Harbour Villas Phase 2', 'S:\\Takeoffs\\Harbour Villas'] };
    const shown = r.preview(`Area on sheet 3 is wrong. Reported by ${me.length >= 3 ? me : 'nobody'}`, ctx);
    const j = JSON.parse(shown);
    assert.equal(j.app, 'Goldline Takeoff');
    assert.equal(j.kind, 'problem');
    assert.equal(j.where, 'project');
    for (const k of ['host', 'winUser', 'appDir', 'localDir', 'settings', 'profile', 'user', 'pc', 'project']) assert.ok(!(k in j), k + ' must not be in the report');
    for (const bad of ['Harbour', 'Phase 2', 'Kowalski', 'maria', 'Takeoffs', 'A-101', 'Level 1', 'boq.xlsx', 'Shared', 'C:\\', 'D:\\', ...(me.length >= 3 ? [me] : []), ...(os.hostname().length >= 3 ? [os.hostname()] : [])]) assert.ok(!shown.includes(bad), bad + ' left in the preview: ' + shown);
    // a changed text needs a new preview
    assert.equal((await r.send(shown.replace('wrong', 'right'))).state, 'changed');
    assert.equal(rx.got.length, 0);
    const res = await r.send(shown);
    assert.deepEqual(res, { state: 'sent', err: '' });
    assert.equal(rx.got.length, 1);
    assert.equal(rx.got[0].url, '/report');
    assert.equal(rx.got[0].headers['x-report-client'], 'goldline-takeoff');
    assert.equal(rx.got[0].body, shown, 'what the receiver got is what the preview showed, byte for byte');
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing is kept on this PC');
  } finally { await rx.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no internet or a refusing receiver: it says so, nothing is kept, and a second Send tries again', async () => {
  const dir = tmp();
  try {
    let n = 0;
    const r = makeReports('http://127.0.0.1:9', dir, async () => (++n === 1 ? { ok: false, err: 'ECONNREFUSED' } : { ok: true }), SETTINGS);
    const shown = r.preview('hello', { screen: 'start', errors: [], words: [] });
    const a = await r.send(shown);
    assert.equal(a.state, 'failed');
    assert.match(a.err, /ECONNREFUSED/);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal((await r.send(shown)).state, 'sent');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const rx = await receiver(413);
  try {
    assert.equal((await worker(['post', rx.url, path.join(os.tmpdir(), 'gt-no-such-file.json')])).code, 0);
    assert.equal(rx.got.length, 0, 'a file that is not there posts nothing');
  } finally { await rx.close(); }
});

test('the words the settings know are private (folders, names) go from the log; plain folders are not taken for names', () => {
  const w = reportsMod.settingsWords(SETTINGS) as string[];
  for (const x of ['Harbour Villas', 'Level 1', 'maria.k', 'Maria Kowalski', 'Kowalski']) assert.ok(w.includes(x) || w.some((y) => y.includes(x)), x + ' in ' + JSON.stringify(w));
  for (const x of ['Takeoffs', 'S:', 'D:']) assert.ok(!w.includes(x), x + ' is no name');
});
