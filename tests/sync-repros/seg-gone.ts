// The writer's journal file is gone from the share (moved/quarantined/restored folder): pump()'s size check
// treats "no file" as "the size I expect", appends at offset 0, and readers that had read the old file
// (they wait for bytes past their old offset) never see that change.
// run (from the app folder): npx tsx tests/sync-repros/seg-gone.ts
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createProject } from '../../src/engine/projects';
import { nodefs, tmp, open, drain, check, done } from './lib';

const data = tmp();
const { dir } = await createProject(nodefs, data, 'G', 'Setup', 'PC0', [['e1', 'qty', 1]]);
const a = await open({ dir, user: 'Nabil' });
const b = await open({ dir, user: 'Ahmed' });
a.commit([['e1', 'desc', 'a fairly long description so the file is bigger than the next line ' + 'x'.repeat(300)]]);
await drain(a);
await b.tick();
rmSync(join(dir, 'journals', a.currentSegment));
a.commit([['e1', 'qty', 4242]]);
await drain(a);
for (let i = 0; i < 3; i++) await b.tick();
a.commit([['e2', 'qty', 7]]);
await drain(a);
for (let i = 0; i < 3; i++) await b.tick();
const c = await open({ dir, user: 'Rami' });
check('journal file gone', b.store.get('e1', 'qty') === 4242,
  `Ahmed (was reading the old file): e1.qty=${b.store.get('e1', 'qty')} e2.qty=${b.store.get('e2', 'qty')}; Rami (opened after): e1.qty=${c.store.get('e1', 'qty')}`);
await a.close(); await b.close(); await c.close();
done();
