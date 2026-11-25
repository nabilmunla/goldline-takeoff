// Anonymous reports (electron/anon.cjs): what leaves the PC. Names and paths here are made up, in the
// shapes of the app's real log lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { scrub, anonymize } = require('../electron/anon.cjs');
const who = { user: 'jdoe', pc: 'DESKTOP-7Q2X' };

test('paths, file names, user and PC names come out of messages and logs', () => {
  const s = scrub(`Error: ENOENT open 'C:\\Users\\jdoe\\Desktop\\Tower B GA.pdf' at \\\\server\\Tenders\\T1\\x.pdf; /home/jdoe/a.pdf file:///D:/x/y.pdf "Sheet 3 - MEP.dwg" bill.xlsx on DESKTOP-7Q2X`, who);
  for (const bad of ['jdoe', 'Tower B', 'Tenders', 'Desktop', 'DESKTOP-7Q2X', 'bill.xlsx', 'MEP.dwg', 'x/y']) assert.ok(!s.includes(bad), bad + ' left in: ' + s);
  assert.ok(s.includes('<path>') && s.includes('<file>') && s.includes('<pc>'));
  assert.equal(scrub('at render (app://dist/assets/index.js:12:5)', who), 'at render (app://dist/assets/index.js:12:5)', 'code locations stay');
});

test('names and paths with spaces go whole; the app\'s own code locations stay', () => {
  const w = { user: 'jdoe', pc: 'DESKTOP-7Q2X', words: ['Tower B GA.pdf', 'Project Falcon'] };
  assert.equal(scrub('opened Tower B GA.pdf: 3 pages', w), 'opened <file>: 3 pages');
  assert.ok(!/Drawing|Rev 2/.test(scrub('opened Other Drawing Rev 2.pdf: 3 pages', w)), 'an unknown name with spaces');
  const p = scrub(`save failed: EPERM 'C:\\Users\\John Smith\\OneDrive - ACME Ltd\\Bids\\Project Falcon\\Take-off 3.pdf' at x`, w);
  for (const bad of ['Smith', 'ACME', 'Bids', 'Falcon', 'Take-off']) assert.ok(!p.includes(bad), bad + ' left in: ' + p);
  // (the setup's copy, a version the app downloaded itself, one under versions\)
  assert.equal(scrub('at load (C:\\Users\\John Smith\\AppData\\Local\\Programs\\Goldline Takeoff\\resources\\app\\electron\\main.cjs:12:5)', w), 'at load (<app>/electron\\main.cjs:12:5)');
  assert.equal(scrub('at load (C:\\Users\\John Smith\\AppData\\Local\\Goldline Takeoff\\app\\0.22.1\\electron\\main.cjs:12:5)', w), 'at load (<app>/electron\\main.cjs:12:5)');
  assert.equal(scrub('at load (C:\\Program Files\\Goldline Takeoff\\resources\\app\\versions\\0.21.0\\electron\\main.cjs:12:5)', w), 'at load (<app>/electron\\main.cjs:12:5)');
  for (const t of ['\\\\srv\\Tenders 2026\\x y.pdf', '/home/john smith/a.pdf', 'unquoted C:\\Users\\John Smith\\Desktop\\a b.pdf']) assert.ok(!/smith|Tenders|a b/i.test(scrub(t, w)), t);
});

test('a report keeps only what is needed; the time to the hour; the person\'s words as typed', () => {
  const rep = { kind: 'problem', app: 'Goldline Takeoff', version: '0.22.0', runtime: '44.10.2', windows: '10.0.22631', arch: 'x64', user: 'jdoe', pc: 'DESKTOP-7Q2X',
    host: 'DESKTOP-7Q2X', winUser: 'jdoe', appDir: 'C:\\x', settings: { dataRoot: 'S:\\Takeoffs' },
    memoryMB: { total: 16000, free: 4000 }, uptimeMin: 12, time: '2026-11-06T12:34:56.000Z', text: 'The area on sheet 3 is wrong (I am jdoe)',
    screenshot: 'x.png', log: Array.from({ length: 300 }, (_, i) => `line ${i} C:\\Users\\jdoe\\a.pdf`).join('\n') };
  const a = anonymize(rep, who);
  assert.deepEqual(Object.keys(a).sort(), ['app', 'arch', 'kind', 'log', 'memoryMB', 'runtime', 'text', 'time', 'uptimeMin', 'version', 'windows'].sort());
  assert.equal(a.time, '2026-11-06T12:00:00.000Z');
  assert.equal(a.text, 'The area on sheet 3 is wrong (I am <user>)');
  assert.equal(a.log.split('\n').length, 120);
  assert.ok(!JSON.stringify(a).includes('jdoe') && !JSON.stringify(a).includes('DESKTOP-7Q') && !JSON.stringify(a).includes('Takeoffs'));
  assert.equal(anonymize({ kind: 'weird' }).kind, 'crash', 'only two kinds');
});

test('the app\'s own log lines that name a sheet, a project or a backup file (made-up names, the real shapes)', () => {
  const w = { user: 'jdoe', pc: 'DESKTOP-7Q2X', words: ['Falcon Tower'] };
  const log = [
    '2026-11-09T08:20:25.760Z renderer: sheet A-101 Level 1 Plan ready in 120 ms (local copy)',
    '2026-11-09T08:21:25.760Z renderer: read of S-204 Roof Framing took too long: stopped (3 waiting)',
    '2026-11-09T08:21:26.760Z renderer: read of S-204 Roof Framing gave way to a newer sheet: goes on (2 waiting)',
    '2026-11-09T08:21:27.760Z renderer: reading E-001 Legend: M-301 Ducts gives way',
    '2026-11-09T08:22:25.760Z renderer: the preparation\'s read of M-301 Ducts handed over to the sheet on screen',
    '2026-11-09T09:26:57.475Z renderer: sent 3 change(s) left on this PC for Harbour Villas Phase 2',
    '2026-11-09T09:26:58.475Z renderer: could not send the changes left for Harbour Villas Phase 2: EBUSY',
    '2026-11-09T09:27:00.475Z renderer: backup auto: Harbour Villas Phase 2_2026-11-09.json (12 KB, 2 old removed)',
    '2026-11-09T09:28:00.475Z renderer: BOQ hub: cannot open \'D:\\Shared\\Harbour Villas\\boq.xlsx\'',
    '2026-11-09T13:02:12.474Z [pdf 1] Cannot enlarge memory, requested 2147491840 bytes, but the limit is 2147483648 bytes!',
  ].join('\n');
  const s = scrub(log, w);
  for (const bad of ['A-101', 'Level 1', 'Roof Framing', 'Legend', 'Ducts', 'Harbour', 'Phase 2', 'Shared', 'boq.xlsx', 'Falcon']) assert.ok(!s.includes(bad), bad + ' left in: ' + s);
  assert.ok(s.includes('sheet <file> ready in 120 ms (local copy)'), s);
  assert.ok(s.includes('read of <file> took too long: stopped (3 waiting)'), s);
  assert.ok(s.includes('backup auto: <file> (12 KB, 2 old removed)'), s);
  assert.ok(s.includes('Cannot enlarge memory, requested 2147491840 bytes') && s.includes('2026-11-09T08:20:25.760Z'), 'what the line says stays: ' + s);
});

test('long file names with brackets in the log go whole; a year is not a name', () => {
  const w = { user: 'jdoe', pc: 'DESKTOP-7Q2X', words: ['2026', 'QS', 'Falcon Tower'] };
  const log = [
    '2026-11-09T08:20:25.760Z renderer: opened PRJ0441-ABC-SP-P09-CO-XYZ-ARC-WIR-001641[0]_WIR for Completion for 2nd Coat plaster prior to Primer Application for Facade works at Building C1-010 (P08).pdf: 3 pages, 10.2 MB',
    '2026-11-09T09:26:57.475Z renderer: opened PRJ0441-ABC-SP-P08-CO-XYZ-ARC-WIR-002809[0]_WIR for  Primer Application prior to proceed with Balcony Waterproofing at Falcon Tower.pdf: 12 pages, 39.5 MB',
    '2026-11-09T10:32:43.460Z renderer: Site Visit Photos (Week 12) - Level 5.pdf: 9 pages, 9.4 MB',
    '2026-11-09T13:02:12.474Z [pdf 1] Cannot enlarge memory, requested 2147491840 bytes, but the limit is 2147483648 bytes!',
  ].join('\n');
  const s = scrub(log, w);
  for (const bad of ['PRJ0441', 'WIR', 'Completion', 'Balcony', 'Falcon', 'Site Visit', 'Week 12', 'Level 5']) assert.ok(!s.includes(bad), bad + ' left in: ' + s);
  assert.equal((s.match(/<file>/g) || []).length, 3, s);
  assert.ok(s.startsWith('2026-11-09T08:20:25.760Z') && s.includes('2026-11-09T13:02:12.474Z'), 'the times keep their year: ' + s);
});

test('Linux: the app\'s place goes, its code locations stay; files under /run/media and /opt go', () => {
  assert.equal(scrub('at load (/opt/goldline-takeoff/resources/app/electron/main.cjs:12:5)', who), 'at load (<app>/electron/main.cjs:12:5)');
  assert.equal(scrub('at load (/tmp/.mount_GoldliAb12Cd/resources/app/electron/main.cjs:3:1)', who), 'at load (<app>/electron/main.cjs:3:1)');
  for (const t of ["ENOENT '/run/media/jdoe/USB Key/Tower B.pdf'", 'saved /opt/jobs/Falcon/x.pdf', "/media/jdoe/Disk/Bids/a.pdf"]) assert.ok(!/jdoe|Tower|Falcon|Bids/.test(scrub(t, who)), t + ' -> ' + scrub(t, who));
});

test('what the person typed: their user and PC names and the names this PC knows are private come out; the rest as typed', () => {
  const w = { user: 'jdoe', pc: 'DESKTOP-7Q2X', words: ['Harbour Villas', 'Maria Kowalski'] };
  const a = anonymize({ kind: 'problem', text: 'Area wrong on sheet 3 of Harbour Villas (Maria Kowalski, jdoe on DESKTOP-7Q2X); rate 12.5 per m2' }, w);
  assert.equal(a.text, 'Area wrong on sheet 3 of <name> (<name>, <user> on <pc>); rate 12.5 per m2');
});
