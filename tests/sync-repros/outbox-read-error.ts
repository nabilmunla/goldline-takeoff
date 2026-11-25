// adoptOutboxes: an old outbox file that can't be READ at that moment (locked by a scanner, EBUSY after
// the retries) is treated like an empty one and deleted.
// run (from the app folder): npx tsx tests/sync-repros/outbox-read-error.ts
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, readProjectStore } from '../../src/engine/projects';
import type { FsApi } from '../../src/engine/types';
import { nodefs, tmp, open, flaky, drain, check, done } from './lib';

const data = tmp();
const { dir } = await createProject(nodefs, data, 'O', 'Setup', 'PC0', [['e1', 'qty', 1]]);
const local = tmp();
const f = flaky(nodefs);
const a = await open({ dir, user: 'Nabil', account: 'nabil', host: 'PC1', localDir: local, fs: f.fs });
f.st.down = true;
a.commit([['e1', 'qty', 4242]], 'offline');
await a.close();
const ob = join(local, 'outbox', readdirSync(join(local, 'outbox'))[0]);
const file = readdirSync(ob).find((x) => x.endsWith('.log'))!;
console.log('left in the outbox:', file, JSON.stringify(readFileSync(join(ob, file), 'utf8').slice(0, 60)) + '...');
// next start: the file is locked for a moment (EBUSY even after nodefs' 3 retries)
let busy = 1;
const localFs: FsApi = {
  ...nodefs,
  readText: async (p) => {
    if (p.endsWith(file) && busy-- > 0) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return nodefs.readText(p);
  },
};
const a2 = await open({ dir, user: 'Nabil', account: 'nabil', host: 'PC1', localDir: local, localFs });
await drain(a2);
await a2.close();
const share = await readProjectStore(nodefs, dir);
check('outbox read error', existsSync(join(ob, file)) || share.get('e1', 'qty') === 4242,
  `old outbox file still there: ${existsSync(join(ob, file))}; share e1.qty=${share.get('e1', 'qty')} (expected the file kept for next time, or 4242 sent)`);
done();
