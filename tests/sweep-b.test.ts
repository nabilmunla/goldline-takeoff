// Sweep B (release candidate 0.23.0): each finding found real has its test here, written to fail first.
// The ids pinned below were made by the version before (0.22.0): this version must make the same ones.
// run: npx tsx --test tests/sweep-b.test.ts
import './stub-window';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/engine/store';
import { buildQtoModel } from '../src/engine/qto/model';
import { sheetIdFor, pageSheetId, newRevisionOps } from '../src/engine/qto/revisions';
import { doorRowsOps } from '../src/engine/qto/ops';
import { tabTarget } from '../src/ui/takeoff/Sheets16';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectSession } from '../src/engine/session';
import { initAccounts, accountsDir, rootsOf } from '../src/engine/accounts';
import { moveTeamFolder, clearOldTeamFolder, MOVED_FILE, type CopyFs } from '../src/engine/teamfolder';
import { writeBackup, readBackup, backupDirOf } from '../src/engine/backups';
import { sha256Hex, LEGACY_FORMATS, FORMAT, formatOf, formatFor } from '../src/engine/legacy';
import { createProject, listProjects } from '../src/engine/projects';
import type { Op, FsApi } from '../src/engine/types';

const require = createRequire(import.meta.url);
const nodefs: CopyFs & FsApi = require('../electron/nodefs.cjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'gt-sweepb-'));
/** the ids as 0.22.0 spelled them (put together: they name the product it was) */
const EARLIER = (rest: string) => ['g', 'c', 'c'].join('') + '-' + rest;

let stamp = 0;
const add = (s: Store, ops: Op[], who = 'qs1') => s.apply({ s: String(++stamp).padStart(10, '0') + '~t', w: 't-' + who, u: who, t: 0, o: ops, a: who });
const J = (v: unknown) => JSON.stringify(v);

// ---------------------------------------------------------------- 32 / rename: ids made from a file or a tag
test('32: sheet, page-sheet, revision and door-row ids are the ones the version before made', () => {
  // (computed by 0.22.0's own revisions.ts / ops.ts)
  assert.equal(sheetIdFor('S:\\Drawings\\A-101.pdf', '\\\\server\\share\\Drawings\\A-101.pdf'), 'dwg:fa098bfda32c0f97a');
  assert.equal(sheetIdFor('S:\\Drawings\\Set.pdf', '', 2), 'dwg:fc79cb875ebd7a4d3');
  assert.deepEqual([0, 1, 2, 3].map((k) => pageSheetId('dwg:abc123', k)), ['dwg:pf98abe2829ed06f7', 'dwg:p8e8d8ebe5eea3661', 'dwg:p1784df04c7e367db', 'dwg:p6083ef92b0e4574d']);
  assert.deepEqual(doorRowsOps({ doors: [], doorsGone: new Map() } as any, [{ tag: 'D-01' }, { tag: 'D02A' }]).ids, ['ds:t3e078c276320976d', 'ds:t66ae5f67f0fad0f2']);
  const d: any = { id: 'dwg:x1', path: 'S:\\Drawings\\A-101.pdf', unc: '', hash: 'abc', size: 10, mtime: 5, pages: 1, name: 'A-101.pdf', rev: 'A', revs: [] };
  const rops = newRevisionOps({ shapesByPage: new Map(), shapes: [] } as any, d, { path: 'S:\\Drawings\\A-101 B.pdf', size: 11, mtime: 6 } as any, { user: 'u', unc: () => '', rev: 'B', issue: '' } as any);
  assert.ok(rops.some((o) => o[0] === 'rv:fe9c5a8b02a2954b4'), 'the earlier revision record has the id 0.22.0 gave it');
});

test('32: a bound set split on a PC still on the version before - shapes and tabs left on the set find its page sheets', () => {
  const d = 'dwg:abc123';
  const p = ['dwg:pf98abe2829ed06f7', 'dwg:p8e8d8ebe5eea3661', 'dwg:p1784df04c7e367db', 'dwg:p6083ef92b0e4574d'];
  const st = new Store();
  add(st, [[d, 'name', 'Set.pdf'], [d, 'path', 'S:\\Set.pdf'], [d, 'pages', 4], ['ti:a', 'kind', 'count'], ['ti:a', 'name', 'Doors']]);
  // the split as 0.22.0 wrote it (its page sheets' ids; the set itself removed)
  add(st, [...p.flatMap((id, k): Op[] => [[id, 'name', 'Set.pdf'], [id, 'path', 'S:\\Set.pdf'], [id, 'pages', 1], [id, 'fp', k], [id, 'fpn', 4]]), [d, 'del', true]]);
  // a PC that had not seen the split yet: a viewport on page 3 of the set
  add(st, [['sr:v', 'dwg', d], ['sr:v', 'pg', 2], ['sr:v', 'r', J([0, 0, 50, 50])], ['sr:v', 'sc', 1], ['sr:v', 'scl', '1:100']], 'qs2');
  const m = buildQtoModel(st, null);
  assert.deepEqual(m.regions.map((x) => [x.dwg, x.pg]), [[p[2], 0]], 'onto the page\'s sheet, not out of sight with the set');
  assert.deepEqual(tabTarget(m, { dwg: d, pg: 3 }), { dwg: p[3], pg: 0 }, 'a tab on the set goes to its page\'s sheet');
});

// ---------------------------------------------------------------- rename: format ids written in a team folder of 0.22.0
async function team(earlier: boolean) {
  const root = tmp();
  await initAccounts(nodefs, root, 'PC1', { username: 'nabil', name: 'Nabil', password: 'admin-pass-1' });
  const pj = join(accountsDir(nodefs, root), 'project.json');
  // a team folder 0.22.0 set up: its accounts carry that version's id
  if (earlier) writeFileSync(pj, JSON.stringify({ ...JSON.parse(readFileSync(pj, 'utf8')), format: EARLIER('estimation-accounts') }, null, 2));
  const s = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: accountsDir(nodefs, root), localDir: tmp(), user: 'Nabil', account: 'nabil', host: 'PC1', pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 });
  await s.open();
  return { root, s };
}

test('rename: the earlier spellings written here are the ones 0.22.0 reads (each one\'s SHA-256 is its legacy key)', () => {
  for (const [rest, id] of [['takeoff', FORMAT.takeoff], ['estimation-accounts', FORMAT.accounts], ['backup', FORMAT.backup], ['moved', FORMAT.moved]] as const) {
    assert.equal(LEGACY_FORMATS[sha256Hex(EARLIER(rest))], id, rest);
  }
});

test('rename: a take-off made in a team folder of 0.22.0 is spelled its way (PCs on it list only those); a new team folder gets today\'s', async () => {
  for (const earlier of [true, false]) {
    const { root, s } = await team(earlier);
    const { dir } = await createProject(nodefs, root, 'Tower', 'Nabil', 'PC1', [], 'nabil', formatFor(FORMAT.takeoff, s.meta));
    await s.close();
    assert.equal(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).format, earlier ? EARLIER('takeoff') : FORMAT.takeoff);
    assert.deepEqual((await listProjects(nodefs, root, Date.now(), FORMAT.takeoff)).map((p) => p.meta.name), ['Tower'], 'listed here either way');
    assert.equal(formatFor(FORMAT.hub, s.meta), FORMAT.hub, '(the BOQ hub is new: one spelling)');
  }
});

test('rename: in a team folder of 0.22.0 the moved-folder note and the pointer left behind are spelled its way (PCs on it follow them)', async () => {
  for (const earlier of [true, false]) {
    const { root, s } = await team(earlier);
    const to = tmp();
    await moveTeamFolder({ fs: nodefs, from: root, to, roots: rootsOf(s.store, root), by: { username: 'nabil', name: 'Nabil' }, host: 'PC1', oldStore: s.store, commitOld: (ops, label) => !!s.commit(ops, label) });
    await s.close();
    const note = () => JSON.parse(readFileSync(join(accountsDir(nodefs, root), MOVED_FILE), 'utf8'));
    assert.equal(note().format, earlier ? EARLIER('moved') : FORMAT.moved, 'the note at the move');
    await clearOldTeamFolder(nodefs, root, to, backupDirOf(nodefs, to, 'accounts', '', ''));
    assert.equal(note().format, earlier ? EARLIER('moved') : FORMAT.moved, 'the note once cleared');
    const ptr = JSON.parse(readFileSync(join(accountsDir(nodefs, root), 'project.json'), 'utf8'));
    assert.equal(ptr.format, earlier ? EARLIER('estimation-accounts') : FORMAT.accounts, 'the pointer');
  }
});

test('rename: a backup of a project 0.22.0 made is written its way (a PC gone back to it can restore it); read here either way', async () => {
  for (const earlier of [true, false]) {
    const root = tmp();
    const st = new Store();
    add(st, [['project', 'name', 'Tower'], ['e1', 'qty', 3]]);
    const like = { format: earlier ? EARLIER('takeoff') : FORMAT.takeoff };
    const r = await writeBackup({ fs: nodefs, root, kind: 'qto', projectDir: join(root, 'Projects', 'Tower'), folder: 'Tower', projectId: 'p1', projectName: 'Tower', store: st, by: 'nabil', host: 'PC1', app: '0.23.0', like } as any);
    const b = await readBackup(nodefs, r.file);
    assert.equal(b.format, earlier ? EARLIER('backup') : FORMAT.backup);
    assert.equal(formatOf(b), FORMAT.backup);
  }
});

// ---------------------------------------------------------------- 1, 2: a write whose rename is blocked
test('1, 2: a file whose replace stays blocked is never written over in place: the call fails, the file is as it was', async () => {
  const fsp = require('node:fs').promises;
  const dir = tmp();
  for (const how of ['writeAtomic', 'writeBytes'] as const) {
    const p = join(dir, how === 'writeAtomic' ? 'project.json' : '2026-11-18.json.gz');
    writeFileSync(p, 'the good copy');
    const orig = fsp.rename, origWrite = fsp.writeFile;
    let inPlace = 0;
    // (antivirus or a share lock holding the file; a direct write to it is cut short - the disk full)
    fsp.rename = async (a: string, b: string) => { if (String(b) === p) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); return orig(a, b); };
    fsp.writeFile = async (f: any, d: any, o?: any) => { if (String(f) === p) { inPlace++; await origWrite(f, ''); throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); } return origWrite(f, d, o); };
    try {
      const run = how === 'writeAtomic' ? nodefs.writeAtomic(p, 'new') : (nodefs as any).writeBytes(p, new Uint8Array([1, 2, 3]));
      await assert.rejects(run, /EPERM/, how);
    } finally { fsp.rename = orig; fsp.writeFile = origWrite; }
    assert.equal(inPlace, 0, how + ': no write in place');
    assert.equal(readFileSync(p, 'utf8'), 'the good copy', how);
    assert.deepEqual(require('node:fs').readdirSync(dir).filter((f: string) => f.endsWith('.tmp')), [], how + ': no temp file left');
  }
});

// ---------------------------------------------------------------- 34: a project closed while its backup keeper is still opening
test('34: closed while the keeper is still looking for today\'s backup: no "at open" backup after the close', async () => {
  const { BackupKeeper } = await import('../src/engine/backups');
  const root = tmp();
  let gate: () => void = () => {};
  const slow = new Promise<void>((r) => (gate = r));
  const fs = { ...nodefs, list: async (d: string) => { await slow; return nodefs.list(d); } };
  const st = new Store();
  add(st, [['project', 'name', 'Tower'], ['e1', 'qty', 1]]);
  const lines: string[] = [];
  const k = new BackupKeeper({ fs: fs as any, root, kind: 'qto', projectDir: join(root, 'Projects', 'Tower'), folder: 'Tower', projectId: 'p1', projectName: 'Tower', by: 'nabil', host: 'PC1', app: '0.23.0', session: { store: st }, log: (l) => lines.push(l) });
  const opening = k.opened();
  const closing = k.closing();
  gate();
  await opening;
  await closing;
  assert.equal(lines.filter((l) => /^backup at open/.test(l)).length, 0, lines.join('\n'));
  assert.equal(lines.filter((l) => /^backup at close/.test(l)).length, 1, lines.join('\n'));
});

// ---------------------------------------------------------------- 7: a backup file whose entries are damaged
test('7: a backup whose entries are damaged is refused when it is read, with a message that says so', async () => {
  const { decodeBackup } = await import('../src/engine/backups');
  const { gzipSync, strToU8 } = await import('fflate');
  const file = (ents: unknown) => gzipSync(strToU8(JSON.stringify({ format: FORMAT.backup, v: 1, kind: 'qto', projectId: 'p', projectName: 'P', at: 1, by: 'x', day: '2026-11-18', top: '', ents })));
  assert.equal(decodeBackup(file([['e1', [['qty', 3]]]])).ents.length, 1);
  for (const bad of [[['e1', 'qty']], [[7, [['qty', 3]]]], [['e1', [[3, 3]]]], [['e1', [['qty']]]], ['e1']]) {
    assert.throws(() => decodeBackup(file(bad)), /damaged/, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- 6: the consultant's column widths in the filled copy
test('6: widening our columns keeps every column entry of the consultant\'s sheet exactly as written', async () => {
  const { widenCols } = await import('../src/engine/boqfill');
  const paired = '<col min="1" max="1" width="30.5" customWidth="1"></col>';
  const other = '<col  max="3" min="2" width="12" style="4"/>';
  const xml = `<worksheet><sheetPr/><cols>${paired}${other}<col min="9" max="9" width="8"/></cols><sheetData/></worksheet>`;
  const out = widenCols(xml, ['D', 'E'], 14);
  assert.ok(out.includes(paired), out);
  assert.ok(out.includes(other), out);
  const cols = /<cols>([\s\S]*)<\/cols>/.exec(out)![1];
  const mins = [...cols.matchAll(/<col\b[^>]*?\bmin="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(mins, [1, 2, 4, 5, 9], 'in column order, ours inserted between');
  assert.equal(widenCols(xml, ['B'], 14), xml, 'a column the sheet sizes already: nothing changed');
});

// ---------------------------------------------------------------- 12: two problem reports sent at once
test('12: two reports sent at once each post their own text, and neither loses its file to the other', async () => {
  const reports = require('../electron/reports.cjs');
  const dir = tmp();
  const posted: string[] = [];
  const run = async (args: string[]) => {
    await new Promise((r) => setTimeout(r, 30)); // (the worker starts, then reads the file)
    posted.push(readFileSync(args[2], 'utf8'));
    return { ok: true };
  };
  const r = reports.create({ version: '0.23.0', appName: 'Goldline Takeoff', endpoint: 'https://reports.invalid/x', readSettings: () => ({}), logTail: () => '', run, dir: () => dir });
  const a = r.preview('first report', {});
  const sa = r.send(a);
  const b = r.preview('second report', {});
  const sb = r.send(b);
  assert.deepEqual([(await sa).state, (await sb).state], ['sent', 'sent']);
  assert.equal(posted.length, 2);
  assert.ok(posted.some((t) => t.includes('first report')) && posted.some((t) => t.includes('second report')), posted.join('\n---\n'));
  assert.deepEqual(require('node:fs').readdirSync(dir).filter((f: string) => f.includes('report')), [], 'no file left');
});

// ---------------------------------------------------------------- 17: a project closed from two places at once
test('17: close() called twice at once closes once, and the second call ends when the close has ended', async () => {
  const share = tmp();
  const { dir } = await createProject(nodefs, share, 'P', 'QS', 'PC1', [['e1', 'qty', 1]], 'qs1', FORMAT.takeoff);
  let slowAppend = false;
  const presence: string[] = [];
  const fs: FsApi = {
    ...nodefs,
    append: async (p: string, t: string) => { if (slowAppend && p.startsWith(share)) await new Promise((r) => setTimeout(r, 300)); return nodefs.append(p, t); },
    writeAtomic: async (p: string, t: string) => { if (/[\\/]presence[\\/]/.test(p)) presence.push(t); return nodefs.writeAtomic(p, t); },
  };
  const s = new ProjectSession({ fs, localFs: nodefs, projectDir: dir, localDir: tmp(), user: 'QS', account: 'qs1', host: 'PC1', pollMs: 3600000, fullScanMs: 0, heartbeatMs: 3600000, dataFormat: 1 });
  await s.open();
  slowAppend = true;
  s.commit([['e1', 'qty', 2]], 'edit');
  presence.length = 0;
  const order: string[] = [];
  const a = s.close().then(() => order.push('first'));
  const b = s.close().then(() => order.push('second'));
  await Promise.all([a, b]);
  assert.equal(presence.filter((t) => JSON.parse(t).gone).length, 1, 'one last word, not two');
  assert.deepEqual(order, ['first', 'second']);
  const later = s.close();
  await later;
});

// ---------------------------------------------------------------- 8: a take-off restored while the accounts can't be written
test('8: restoring a take-off when the accounts can\'t be changed here makes nothing (not a copy nobody owns or sees)', async () => {
  const { restoreTakeoff } = await import('../src/engine/restore');
  const root = tmp();
  const st = new Store();
  add(st, [['project', 'name', 'Tower'], ['e1', 'qty', 3]]);
  const { file } = await writeBackup({ fs: nodefs, root, kind: 'qto', projectDir: join(root, 'Projects', 'Tower'), folder: 'Tower', projectId: 'p1', projectName: 'Tower', store: st, by: 'nabil', host: 'PC1', app: '0.23.0' } as any);
  const projects = () => (require('node:fs').existsSync(join(root, 'Projects')) ? require('node:fs').readdirSync(join(root, 'Projects')) : []);
  const committed: Op[][] = [];
  const accounts = (readOnly: boolean, commits = true) => ({ store: new Store(), readOnly, newerApp: readOnly ? '0.24.0' : null, meta: { format: FORMAT.accounts }, commit: (ops: Op[]) => { committed.push(ops); return commits ? {} : null; } });
  const go = (a: ReturnType<typeof accounts>, name: string) => restoreTakeoff({ fs: nodefs, bfs: nodefs as any, root, file, name, me: { name: 'Nabil', username: 'nabil' }, host: 'PC1', accounts: a });
  await assert.rejects(go(accounts(true), 'Tower (restored)'), /newer Goldline Takeoff \(0\.24\.0\)[\s\S]*nothing was restored/);
  assert.deepEqual(projects(), [], 'nothing made');
  // the accounts refuse the change after all (closed meanwhile): said, not "you own it"
  await assert.rejects(go(accounts(false, false), 'Tower (restored 2)'), /could not be shared/);
  // and the normal case: made, owned, shared
  committed.length = 0;
  const r = await go(accounts(false), 'Tower (restored 3)');
  assert.equal(JSON.parse(readFileSync(join(r.dir, 'project.json'), 'utf8')).owner, 'nabil');
  assert.ok(committed[0].some((o) => o[1] === 'everyone'), 'shared with everyone (the original was not in the accounts)');
});

// ---------------------------------------------------------------- 22: a bound set of thousands of pages brought in
test('22: planning the import of a 4,000-page bound set takes well under a second (each number counted once, not per page)', async () => {
  const { planImport } = await import('../src/engine/qto/revisions');
  const n = 4000;
  const pages = Array.from({ length: n }, (_, i) => ({ sheet: 'AR-' + (10000 + i), title: 'Sheet ' + i, pre: '' }));
  pages[7] = { ...pages[7], sheet: 'AR-10008' }; // one number misread: on two pages, trusted on neither
  const p = 'S:\\Set.pdf';
  const t = performance.now();
  const rows = planImport([{ path: p, rel: 'Set.pdf', size: 1, mtime: 2 } as any], { drawings: [], revisions: new Map() } as any, () => '', new Map([[p, { n, pages } as any]]));
  const ms = performance.now() - t;
  assert.equal(rows.length, n);
  assert.deepEqual([rows[7].sheet, rows[8].sheet, rows[9].sheet], ['', '', 'AR-10009']);
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
});
