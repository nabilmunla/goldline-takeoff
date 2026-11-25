// The changes a session sends while closing are not announced in its presence file (close() sets closing,
// writePresence/writePresenceSoon then return early) and the presence file is removed: other PCs only
// find them with the next full scan (5 s, up to 60 s in a project with many journal files).
// run (from the app folder): npx tsx tests/sync-repros/close-announce.ts
import { createProject } from '../../src/engine/projects';
import { ProjectSession } from '../../src/engine/session';
import { nodefs, tmp, open, check, done, sleep } from './lib';

const data = tmp();
const { dir } = await createProject(nodefs, data, 'K', 'Setup', 'PC0', [['e1', 'qty', 1]]);
// a project with a long history: full scans every 60 s (fullScanMs 5000 + 55 s for > 100 journal files)
const b = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: dir, localDir: tmp(), user: 'Ahmed', account: 'ahmed', host: 'PC2', pollMs: 3600000, fullScanMs: 60000, heartbeatMs: 3600000 });
await b.open();
const a = await open({ dir, user: 'Nabil' });
a.commit([['e1', 'qty', 10]], 'a rate');
await sleep(600); // sent and announced
await b.tick();
const seen1 = b.store.get('e1', 'qty');
a.commit([['e1', 'qty', 4242]], 'last rate, then closes');
await a.close();
for (let i = 0; i < 8; i++) { await sleep(1000); await b.tick(); }
check('last change before close', b.store.get('e1', 'qty') === 4242,
  `Ahmed polling every second: saw the earlier change (${seen1}); 8 s after Nabil closed: e1.qty=${b.store.get('e1', 'qty')} (4242 arrives only with the next full scan)`);
await b.close();
done();
