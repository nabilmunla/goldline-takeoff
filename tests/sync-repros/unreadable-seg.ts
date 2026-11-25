// One journal file that can't be read right now (EACCES/EIO/locked longer than nodefs' ~0.25 s of retries):
// the whole open fails, and for an open session the full scan stops at that file every time, so the files
// sorted after it are never scanned (closing writers' last changes, damaged-line retries).
// run (from the app folder): npx tsx tests/sync-repros/unreadable-seg.ts
import { createProject } from '../../src/engine/projects';
import { ProjectSession } from '../../src/engine/session';
import type { FsApi } from '../../src/engine/types';
import { nodefs, tmp, open, drain, check, done, sleep } from './lib';

const data = tmp();
const { dir } = await createProject(nodefs, data, 'U', 'Setup', 'PC0', [['e1', 'qty', 1]]);
// Aaron's journal (sorts first) becomes unreadable
const aaron = await open({ dir, user: 'Aaron' });
aaron.commit([['e9', 'note', 'from aaron']]);
await drain(aaron);
const bad = aaron.currentSegment;
await aaron.close();
let locked = false;
const fs: FsApi = { ...nodefs, readFrom: async (p, o, m) => { if (locked && p.endsWith(bad)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return nodefs.readFrom(p, o, m); } };
const b = new ProjectSession({ fs, localFs: nodefs, projectDir: dir, localDir: tmp(), user: 'Ahmed', account: 'ahmed', host: 'PC2', pollMs: 3600000, fullScanMs: 0, heartbeatMs: 3600000 });
await b.open();
locked = true;
const n = await open({ dir, user: 'Nabil' });
n.commit([['e1', 'qty', 4242]], 'last rate');
await n.close();
for (let i = 0; i < 4; i++) { await sleep(300); await b.tick(); }
check('unreadable journal, open session', b.store.get('e1', 'qty') === 4242,
  `Ahmed after Nabil closed: e1.qty=${b.store.get('e1', 'qty')}, status ${b.getStatus().state} (${b.getStatus().lastError})`);
let err = '';
const c = new ProjectSession({ fs, localFs: nodefs, projectDir: dir, localDir: tmp(), user: 'Rami', account: 'rami', host: 'PC3', pollMs: 3600000, fullScanMs: 0, heartbeatMs: 3600000 });
await c.open().catch((e) => { err = String(e.message); });
check('unreadable journal, opening', !err, `Rami opens the project: ${err ? 'fails: ' + err : 'ok'}`);
await b.close();
done();
