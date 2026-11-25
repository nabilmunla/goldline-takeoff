// The reading PC's clock is set back (NTP correction, someone fixes a fast clock): the 'full scan' safety net
// (and the re-reading of damaged lines) stops until the clock has caught up again.
// The last changes someone sends while closing the app are only found by the full scan (close() does not
// announce them in the presence file and then removes it), so they don't arrive.
// run (from the app folder): npx tsx tests/sync-repros/clock-back.ts
import { createProject } from '../../src/engine/projects';
import { ProjectSession } from '../../src/engine/session';
import { nodefs, tmp, open, drain, check, done, sleep } from './lib';

for (const jump of [0, 3600_000]) {
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'K', 'Setup', 'PC0', [['e1', 'qty', 1]]);
  let skew = 0;
  const b = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir: dir, localDir: tmp(), user: 'Ahmed', account: 'ahmed', host: 'PC2', pollMs: 3600000, fullScanMs: 1000, heartbeatMs: 3600000, now: () => Date.now() + skew });
  await b.open();
  await b.tick();
  skew -= jump; // Ahmed's clock goes back
  const a = await open({ dir, user: 'Nabil' });
  await b.tick(); // Ahmed sees Nabil in the project
  a.commit([['e1', 'qty', 4242]], 'last rate before going home');
  await a.close();
  for (let i = 0; i < 6; i++) { await sleep(500); await b.tick(); }
  check(`clock back ${jump / 60000} min`, b.store.get('e1', 'qty') === 4242,
    `Ahmed's screen 3 s after Nabil closed: e1.qty=${b.store.get('e1', 'qty')} (expected 4242)`);
  await b.close();
}
done();
