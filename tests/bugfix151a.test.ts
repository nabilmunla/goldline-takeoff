// 0.15.1 fixes from DeepSeek's 0.15.0 bug log (BUG-LOG-0.15.0.md), group A: the window's close and
// size (BH-036, BH-037), accounts (BH-038, BH-039), the journal-segment mark (BH-040) and the take-off's
// background preparation (BH-050). Each test failed on 0.15.0.
// The window stand-in first: it must be in place before anything from src/ui is loaded.
import { calls } from './harness/window';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectSession } from '../src/engine/session';
import { createProject, listProjects } from '../src/engine/projects';
import { encodeStamp } from '../src/engine/hlc';
import { Store } from '../src/engine/store';
import { trustedGet, adminAtFn, listAccounts, type Account } from '../src/engine/accounts';
import { PeopleTab, AccessDialog } from '../src/ui/People';
import { SheetPrep } from '../src/ui/takeoff/prep';
import type { Batch, FsApi, Op } from '../src/engine/types';

const require = createRequire(import.meta.url);
const nodefs = require('../electron/nodefs.cjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'gt151a-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const win: any = (globalThis as any).window;

// ================================================================ the shell (electron/main.cjs)
/** main.cjs with a window: the harness's own loader never makes one (its whenReady never ends) */
function loadShell(userData: string) {
  const listeners = new Map<string, (...a: any[]) => void>();
  const winEvents = new Map<string, (...a: any[]) => void>();
  const sent: unknown[][] = [];
  const screen = { x: -8, y: -8, width: 1936, height: 1056 };
  const w = {
    maximized: false,
    normal: { x: 120, y: 80, width: 1280, height: 800 },
    closes: [] as boolean[], // per close(): was it held (preventDefault)?
    isDestroyed: () => false,
    isMaximized() { return this.maximized; },
    isMinimized: () => false,
    maximize() { this.maximized = true; },
    getBounds() { return this.maximized ? { ...screen } : { ...this.normal }; },
    getNormalBounds() { return { ...this.normal }; },
    on: (n: string, f: any) => { winEvents.set(n, f); },
    once: () => {},
    loadFile: () => {},
    show: () => {}, focus: () => {}, restore: () => {},
    close() { const e = { held: false, preventDefault() { this.held = true; } }; winEvents.get('close')!(e); this.closes.push(e.held); },
    webContents: { on: () => {}, send: (...a: unknown[]) => sent.push(a), setWindowOpenHandler: () => {}, toggleDevTools: () => {}, closeDevTools: () => {} },
  };
  const app = {
    getPath: (k: string) => (k === 'userData' ? userData : join(userData, '..', k)),
    setPath: () => {}, requestSingleInstanceLock: () => true, releaseSingleInstanceLock: () => {},
    whenReady: () => Promise.resolve(), on: () => {}, quit: () => {}, exit: () => {}, relaunch: () => {},
    setAppUserModelId: () => {}, isPackaged: false, getAppMetrics: () => [],
  };
  const electron = {
    app, BrowserWindow: function () { return w; },
    ipcMain: { handle: () => {}, on: (n: string, f: any) => listeners.set(n, f) },
    dialog: {}, Menu: { setApplicationMenu() {} }, shell: {}, clipboard: {},
  };
  const M = Module as any;
  const was = M._load;
  M._load = function (req: string, ...rest: unknown[]) { return req === 'electron' ? electron : was.call(this, req, ...rest); };
  const mainPath = require.resolve('../electron/main.cjs');
  delete require.cache[mainPath];
  try { require(mainPath); } finally { M._load = was; }
  return { w, listeners, sent, send: (n: string) => listeners.get(n)!({}) };
}
const newProfile = () => { const d = join(tmp(), 'userData'); mkdirSync(d, { recursive: true }); return d; };

test('BH-036: after the window asked first ("Not sent yet" -> Close anyway) a close that stalls is still forced after 6 s', async (t) => {
  const S = loadShell(newProfile());
  await sleep(0); // createWindow (whenReady)
  t.mock.timers.enable({ apis: ['setTimeout'] });
  S.w.close(); // the X
  assert.deepEqual(S.w.closes, [true], 'held: the open project flushes first');
  assert.ok(S.sent.some((m) => m[0] === 'app:closing'));
  S.send('app:close-hold'); // "Not sent yet" is on the screen: no forced close meanwhile
  t.mock.timers.tick(60_000);
  assert.equal(S.w.closes.length, 1, 'nothing forced while the question is open');
  // "Close anyway": the window goes on to close - and its session.close() never ends (a share that stalls)
  assert.ok(S.listeners.has('app:close-resume'), 'the window can say it goes on closing');
  S.send('app:close-resume');
  t.mock.timers.tick(3_000);
  S.w.close(); // "Closing…" stays up: another click on X - no second flush, the deadline stands
  assert.equal(S.sent.filter((m) => m[0] === 'app:closing').length, 1);
  t.mock.timers.tick(2_900);
  assert.deepEqual(S.w.closes, [true, true]);
  t.mock.timers.tick(200);
  assert.deepEqual(S.w.closes, [true, true, false], 'closed 6 s after the answer, as a close that asked nothing is');
});

test('BH-036: "Keep the app open" still keeps it open; a later close is bounded as usual', async (t) => {
  const S = loadShell(newProfile());
  await sleep(0);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  S.w.close();
  S.send('app:close-hold');
  S.send('app:close-cancelled');
  S.send('app:close-resume'); // (a late one, after the answer "keep it open"): nothing
  t.mock.timers.tick(60_000);
  assert.equal(S.w.closes.length, 1, 'still open');
  S.w.close();
  t.mock.timers.tick(6_100);
  assert.deepEqual(S.w.closes, [true, true, false]);
});

test('BH-037: closed while maximized - the size kept is the window\'s own (normal) size, not the screen\'s', async () => {
  const ud = newProfile();
  const S = loadShell(ud);
  await sleep(0);
  S.w.maximize();
  S.w.close();
  const s = JSON.parse(readFileSync(join(ud, 'settings.json'), 'utf8'));
  assert.equal(s.maximized, true);
  assert.equal(s.width, 1280, 'not the maximized width');
  assert.equal(s.height, 800);
  // and not maximized: as before
  const ud2 = newProfile();
  const S2 = loadShell(ud2);
  await sleep(0);
  S2.w.normal = { x: 10, y: 10, width: 1500, height: 950 };
  S2.w.close();
  const s2 = JSON.parse(readFileSync(join(ud2, 'settings.json'), 'utf8'));
  assert.deepEqual([s2.width, s2.height, s2.maximized], [1500, 950, false]);
});

// ================================================================ accounts
const batch = (t: number, by: string, o: Op[]): Batch => ({ s: encodeStamp(t, 0, by + '~pc'), w: by + '~pc', u: by, t, o, a: by });

test('BH-038: a change that arrives late and changes no value still counts in "who was an administrator when"', () => {
  const setup = batch(1000, 'boss', [['user:boss', 'name', 'Boss'], ['user:boss', 'role', 'admin'], ['user:boss', 'active', true]]);
  const people = batch(1500, 'boss', [['user:u', 'name', 'Usman'], ['user:u', 'role', 'estimator'], ['user:u', 'active', true], ['user:x', 'name', 'Xavier'], ['user:x', 'role', 'estimator'], ['user:x', 'active', true], ['proj:P', 'owner', 'boss']]);
  const promote = batch(3000, 'boss', [['user:u', 'role', 'admin']]); // read late (its journal comes last)
  const share = batch(4000, 'u', [['proj:P', 'u:x', 'edit']]); // u, an administrator then, shares P with x
  const demote = batch(5000, 'boss', [['user:u', 'role', 'estimator']]);
  // what every PC that read them in time order has
  const ref = new Store();
  for (const b of [setup, people, promote, share, demote]) ref.apply(b);
  assert.equal(trustedGet(ref, 'proj:P', 'u:x'), 'edit');
  // this PC: the promotion comes last
  const st = new Store();
  for (const b of [setup, people, share, demote]) st.apply(b);
  assert.equal(trustedGet(st, 'proj:P', 'u:x'), undefined, 'not (yet) known that u was an administrator then');
  const wasAdmin = adminAtFn(st);
  assert.equal(wasAdmin('u', share.s), false);
  const ver = st.version;
  st.apply(promote); // loses to the demotion: no value changes
  assert.equal(st.version, ver, '(the counter the answers were kept against does not move)');
  assert.equal(trustedGet(st, 'proj:P', 'u:x'), 'edit', 'the same answer as every other PC');
  assert.equal(wasAdmin('u', share.s), true, 'u was an administrator when sharing');
  assert.deepEqual(listAccounts(st).map((a) => [a.username, a.role]), listAccounts(ref).map((a) => [a.username, a.role]));
});

/** the People page's accounts session as the page uses it: view only on this PC (a newer app wrote them) */
function lockedAuth(store: Store, me: string) {
  const committed: Op[][] = [];
  const accounts: any = { store, readOnly: true, newerApp: '0.16.0', onChange: () => () => {}, commit: (ops: Op[]) => { committed.push(ops); return null; } };
  const account = listAccounts(store).find((a) => a.username === me) as Account;
  const roots = { team: '/srv/team', qto: '/srv/team', bak: { team: null, prev: { team: [] } } };
  return { auth: { account, accounts, admins: new Set([me]), wasAdmin: () => true, isAdmin: true, roots } as any, committed };
}
function accountsStore() {
  const st = new Store();
  st.apply(batch(1000, 'boss', [['user:boss', 'name', 'Boss'], ['user:boss', 'role', 'admin'], ['user:boss', 'active', true], ['user:boss', 'pw', 'x']]));
  st.apply(batch(1500, 'boss', [['user:ahmed', 'name', 'Sara Khan'], ['user:ahmed', 'role', 'estimator'], ['user:ahmed', 'active', true], ['user:ahmed', 'pw', 'x'], ['user:old', 'name', 'Old Leaver'], ['user:old', 'role', 'estimator'], ['user:old', 'active', false], ['proj:P', 'owner', 'boss'], ['proj:P', 'name', 'Tower']]));
  return st;
}
/** the opening tags of the elements matching `re` */
const tags = (html: string, re: RegExp) => [...html.matchAll(/<(select|input|button)\b[^>]*>(?:[^<]*)/g)].map((m) => m[0]).filter((x) => re.test(x));

test('BH-039: the People page offers nothing that would only look done when the accounts are view only here', () => {
  const { auth } = lockedAuth(accountsStore(), 'boss');
  const html = renderToStaticMarkup(createElement(PeopleTab, { auth, projects: [] }));
  const ahmed = html.slice(html.indexOf('data-user="ahmed"'), html.indexOf('</tr>', html.indexOf('data-user="ahmed"')));
  const old = html.slice(html.indexOf('data-user="old"'), html.indexOf('</tr>', html.indexOf('data-user="old"')));
  assert.ok(ahmed && old);
  for (const [who, row] of [['ahmed', ahmed], ['old', old]] as const) {
    const ctl = tags(row, /^<(select|input type="checkbox"|button class="btn)/);
    assert.ok(ctl.length >= 2, who + ': ' + ctl.join(' | '));
    for (const c of ctl) assert.match(c, /disabled=""/, `${who}: ${c}`);
  }
  assert.match(ahmed, /Rename/);
  assert.match(old, /Reactivate/);
});

test('BH-039: the Access dialog says so, and its choices are off, when the accounts are view only here', () => {
  const st = accountsStore();
  const { auth } = lockedAuth(st, 'boss');
  const project = { dir: '/srv/team/Projects/Tower', folder: 'Tower', meta: { id: 'P', name: 'Tower', created: 1, format: 'takeoff' }, activeUsers: [] } as any;
  const html = renderToStaticMarkup(createElement(AccessDialog, { auth, project, onClose: () => {} }));
  const ctl = tags(html, /^<(select|button)/).filter((c) => !/>Done/.test(c));
  assert.ok(ctl.length >= 4, ctl.join(' | '));
  for (const c of ctl) assert.match(c, /disabled=""/, c);
  assert.match(html, /view only on this PC/);
});

// ================================================================ sync: the journal-segment mark
const OPEN: ProjectSession[] = [];
after(async () => { for (const s of OPEN.splice(0)) await s.close().catch(() => {}); });
async function session(dir: string, user: string, o: { localDir?: string; host?: string; fs?: FsApi } = {}) {
  const s = new ProjectSession({
    fs: (o.fs ?? nodefs) as FsApi, localFs: nodefs as FsApi, projectDir: dir, localDir: o.localDir ?? tmp(), user,
    account: user.toLowerCase(), host: o.host ?? 'PC-' + user, pollMs: 3600000, fullScanMs: 0, heartbeatMs: 3600000,
  });
  await s.open();
  OPEN.push(s);
  return s;
}
async function drain(s: ProjectSession, ms = 5000) {
  for (let i = 0; i < ms / 20 && s.pendingCount; i++) await sleep(20);
}

test('BH-040: after a torn last line (a crash mid-write) the PC goes on in a new journal file - and its later sessions keep that one', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'G', 'Setup', 'PC0', [['e1', 'qty', 1]]);
  const wLocal = tmp();
  const w = await session(dir, 'Nabil', { localDir: wLocal, host: 'PC-N' });
  w.commit([['e1', 'qty', 2]]);
  await drain(w);
  const seg = w.currentSegment;
  await w.close();
  appendFileSync(join(dir, 'journals', seg), '{"s":"0000000000.0000.nabil@PC-N~ab","o":[["e1","q'); // half a line: the power went
  const files0 = readdirSync(join(dir, 'journals')).length;
  const w2 = await session(dir, 'Nabil', { localDir: wLocal, host: 'PC-N' });
  assert.notEqual(w2.currentSegment, seg, 'never written after half a line');
  w2.commit([['e1', 'qty', 3]]);
  await drain(w2);
  const seg2 = w2.currentSegment;
  await w2.close();
  for (let n = 4; n <= 6; n++) {
    const wn = await session(dir, 'Nabil', { localDir: wLocal, host: 'PC-N' });
    assert.equal(wn.currentSegment, seg2, `start ${n - 1}: the same file as the session before (not a new one at every start)`);
    wn.commit([['e1', 'qty', n]]);
    await drain(wn);
    await wn.close();
  }
  assert.equal(readdirSync(join(dir, 'journals')).length, files0 + 1, 'one new file in all');
  const r = await session(dir, 'Ahmed');
  assert.equal(r.store.get('e1', 'qty'), 6, 'everything reached the others');
  await r.close();
});

test('BH-040: a write that failed half-way moves the PC to a new file, and that is the file its next session goes on in', async () => {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'G', 'Setup', 'PC0', [['e1', 'qty', 1]]);
  const wLocal = tmp();
  let tear = 0;
  // the share takes half the line, then the connection drops
  const torn: FsApi = { ...nodefs, append: async (p: string, t: string) => { if (tear > 0) { tear--; await nodefs.append(p, t.slice(0, 20)); throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }); } return nodefs.append(p, t); } } as any;
  const w = await session(dir, 'Nabil', { localDir: wLocal, host: 'PC-N', fs: torn });
  w.commit([['e1', 'qty', 2]]);
  await drain(w);
  const seg = w.currentSegment;
  tear = 1;
  w.commit([['e1', 'qty', 3]]);
  await drain(w, 8000);
  const seg2 = w.currentSegment;
  assert.notEqual(seg2, seg);
  await w.close();
  const files = readdirSync(join(dir, 'journals')).length;
  for (let n = 4; n <= 5; n++) {
    const wn = await session(dir, 'Nabil', { localDir: wLocal, host: 'PC-N' });
    assert.equal(wn.currentSegment, seg2, 'the file it went on in');
    wn.commit([['e1', 'qty', n]]);
    await drain(wn);
    await wn.close();
  }
  assert.equal(readdirSync(join(dir, 'journals')).length, files, 'no new file');
  const r = await session(dir, 'Ahmed');
  assert.equal(r.store.get('e1', 'qty'), 5);
  await r.close();
});

test('BH-041: the link agent\'s listing (every 2 minutes, in the background) reads each project\'s description, not who is in it', async () => {
  const data = tmp();
  for (const n of ['Tower', 'Villa', 'Mall']) await createProject(nodefs, data, n, 'Nabil', 'PC0', [['e1', 'qty', 1]]);
  const w = await session(join(data, 'Projects', 'Villa'), 'Nabil'); // someone in one of them
  for (let i = 0; i < 100 && !readdirSync(join(data, 'Projects', 'Villa', 'presence')).length; i++) await sleep(20);
  const seen: string[] = [];
  const counting: FsApi = { ...nodefs, list: (d: string) => { seen.push(d); return nodefs.list(d); }, readText: (p: string) => { seen.push(p); return nodefs.readText(p); } } as any;
  const full = await listProjects(counting, data);
  assert.ok(seen.some((p) => /presence/.test(p)), '(the start screen\'s list does read them: it shows who is in)');
  assert.deepEqual(full.find((p) => p.meta.name === 'Villa')!.activeUsers, ['Nabil']);
  seen.length = 0;
  const agent = await listProjects(counting, data, Date.now(), 'takeoff', { presence: false });
  assert.deepEqual(seen.filter((p) => /presence/.test(p)), [], 'no presence folder listed or read');
  assert.deepEqual(agent.map((p) => [p.dir, p.meta.id]), full.map((p) => [p.dir, p.meta.id]), 'the same projects, in the same order');
  assert.equal(seen.length, 1 + 3, 'one listing of the folder + one description per project');
  await w.close();
});

// ================================================================ take-off: background preparation
test('BH-050: preparing sheets asks the server about each sheet\'s shared preview about once, not on every pass', async () => {
  const projectDir = tmp();
  const N = 16;
  const drawings = Array.from({ length: N }, (_, i) => ({ id: 'dw' + i, name: 'A-' + (100 + i) + '.pdf', title: 'A-' + (100 + i), path: join(projectDir, 'gone', 'A-' + (100 + i) + '.pdf'), unc: '', hash: 'h' + i.toString(36).padStart(8, '0'), size: 1000, mtime: 1 })) as any[];
  // a sheet's preview made by another PC while this one works through the queue: skipped, not read
  const late = drawings[9];
  const statted: string[] = [];
  const was = { exists: win.gt.fs.exists, stat: win.gt.files.stat, start: win.gt.pdf.start };
  let probes = 0;
  win.gt.fs.exists = (p: string) => { if (p.includes('previews')) probes++; return was.exists(p); };
  win.gt.files.stat = (p: string) => {
    statted.push(p);
    if (p === drawings[2].path) { mkdirSync(join(projectDir, 'previews'), { recursive: true }); writeFileSync(join(projectDir, 'previews', late.hash + '-0.webp'), 'x'); }
    return was.stat(p);
  };
  // the background engine: there (nothing is asked of it - every file here is missing)
  const ports: MessagePort[] = [];
  win.gt.pdf.start = async (names: string[], token: string) => {
    for (const name of names) { const { port1, port2 } = new MessageChannel(); ports.push(port1 as any); win.postMessage({ type: 'gt-pdf-port', name, restarted: false, code: 0, token }, '*', [port2]); }
    return true;
  };
  // (the engine start's own two-minute "did not start" timer would keep this test process alive)
  const realTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (f: any, ms?: number, ...a: any[]) => { const h: any = realTimeout(f, ms, ...a); if ((ms ?? 0) >= 60_000) h.unref?.(); return h; };
  let prep: SheetPrep | null = null;
  try {
    const states: any[] = [];
    prep = new SheetPrep({ drawings: () => drawings, localDir: tmp(), projectDir, commit: null, busy: () => false, onState: (s) => states.push(s), onPrepared: () => {} });
    const run = prep.run();
    for (let i = 0; i < 200 && !(prep.state.failed >= N - 1 && !prep.state.running); i++) await sleep(50);
    prep.stop();
    await run;
    assert.equal(prep.state.failed, N - 1, 'every missing sheet tried once');
    assert.ok(!statted.some((p) => p === late.path), 'the sheet another PC prepared meanwhile is not read again');
    assert.equal(prep.state.done, 1);
    assert.ok(probes <= 2 * N + 2, `about two looks per sheet, not one per sheet per pass: ${probes} for ${N} sheets`);
  } finally {
    prep?.stop();
    globalThis.setTimeout = realTimeout;
    Object.assign(win.gt.fs, { exists: was.exists });
    Object.assign(win.gt.files, { stat: was.stat });
    win.gt.pdf.start = was.start;
    for (const p of ports) p.close();
  }
  void calls;
});
