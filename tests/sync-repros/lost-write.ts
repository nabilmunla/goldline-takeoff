// A send that the share reports as done but that did not (fully) land: the next send sees the file is
// not the size it should be, starts a new journal file - and never sends the missing lines again.
// run (from the app folder): npx tsx tests/sync-repros/lost-write.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, readProjectStore } from '../../src/engine/projects';
import type { FsApi } from '../../src/engine/types';
import { nodefs, tmp, open, drain, check, done } from './lib';

for (const mode of ['short', 'lost', 'glued'] as const) {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'L', 'Setup', 'PC0', [['e1', 'qty', 1]]);
  const st = { fault: false };
  // 'short': the write call returns fine but only part of the text is on the share (a short write on a full
  // share / quota); 'lost': the append is acknowledged but the bytes never reach the file
  const fs: FsApi = {
    ...nodefs,
    append: async (p, text) => {
      if (st.fault && p.includes('journals')) {
        st.fault = false;
        if (mode === 'short') return nodefs.append(p, text.slice(0, Math.floor(text.length / 2)));
        // 'glued': half a line from an earlier, timed-out append of this PC lands just before this one
        // (after the size check) - the case the comment in pump() means to guard against
        if (mode === 'glued') { await nodefs.append(p, '3f2a91c0 {"s":"0mzz'); return nodefs.append(p, text); }
        return;
      }
      return nodefs.append(p, text);
    },
  };
  const local = tmp();
  const a = await open({ dir, user: 'Nabil', fs, localDir: local });
  await drain(a);
  st.fault = true;
  a.commit([['e1', 'qty', 4242]], 'rate');
  await drain(a);
  // later, another edit: the session notices the file is not the size it wrote and moves to a new file
  a.commit([['e2', 'qty', 7]], 'next');
  await drain(a);
  await a.tick();
  const outbox = join(local, 'outbox', readdirSync(join(local, 'outbox'))[0]);
  const obBytes = readdirSync(outbox).filter((f) => f.endsWith('.log')).reduce((n, f) => n + statSync(join(outbox, f)).size, 0);
  const share = await readProjectStore(nodefs, dir);
  check(`lost-write (${mode})`, share.get('e1', 'qty') === 4242,
    `Nabil's screen e1.qty=${a.store.get('e1', 'qty')}, pending=${a.pendingCount}, outbox bytes=${obBytes}; on the share e1.qty=${share.get('e1', 'qty')} e2.qty=${share.get('e2', 'qty')}; segments: ${readdirSync(join(dir, 'journals')).length}`);
  await a.close();
  const b = await open({ dir, user: 'Ahmed' });
  check(`lost-write (${mode}) other PC`, b.store.get('e1', 'qty') === 4242, `Ahmed sees e1.qty=${b.store.get('e1', 'qty')}`);
  await b.close();
}
done();
