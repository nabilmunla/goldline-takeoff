// Data-format lock: ways an older app (format 1) ends up writing into a project a newer app (format 2) has marked.
// run (from the app folder): npx tsx tests/sync-repros/fmt-lock.ts
import { createProject, readProjectStore } from '../../src/engine/projects';
import { nodefs, tmp, open, flaky, drain, check, done, sleep } from './lib';

// A. the mark is a last-writer-wins value: an older app's fmt=1 written later beats the newer app's fmt=2
{
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'A', 'Setup', 'PC0', [['e1', 'desc', 'x']]);
  // the newer app opens the project; its first send fails (share drops for a moment)
  const nf = flaky(nodefs);
  nf.st.appendDown = true;
  const n = await open({ dir, user: 'New', fs: nf.fs, dataFormat: 2, appVersion: '0.14.0' });
  await sleep(50);
  // meanwhile an older app opens it: no mark on the share yet, so it writes fmt=1
  const o = await open({ dir, user: 'Old', dataFormat: 1, appVersion: '0.12.1' });
  await drain(o);
  await o.close();
  // the newer app's share comes back: its fmt=2 (stamped earlier) arrives
  nf.st.appendDown = false;
  await (n as any).pump();
  await drain(n);
  const st = await readProjectStore(nodefs, dir);
  const o2 = await open({ dir, user: 'Old2', dataFormat: 1, appVersion: '0.12.1' });
  check('A. newer mark lost to a later older mark', o2.readOnly === true,
    `share fmt=${st.get('project', 'fmt')} fmtBy=${st.get('project', 'fmtBy')}; a fresh 0.12.1 opens readOnly=${o2.readOnly} (expected true: 0.14.0 has written format 2 here)`);
  const b = o2.commit([['e1', 'desc', 'written by the old app']]);
  check('A2. older app writes', b === null, `old app commit ${b ? 'accepted' : 'refused'}`);
  await drain(o2);
  await o2.close();
  await n.close();
}

// B. an older app that was already open when the newer app marked the project keeps writing
{
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'B', 'Setup', 'PC0', [['e1', 'desc', 'x']]);
  const o = await open({ dir, user: 'Old', dataFormat: 1, appVersion: '0.12.1' });
  await drain(o);
  const n = await open({ dir, user: 'New', dataFormat: 2, appVersion: '0.14.0' });
  await drain(n);
  await o.tick();
  const seen = o.store.get('project', 'fmt');
  const b = o.commit([['e1', 'desc', 'old app after the mark']]);
  check('B. already-open older app after the mark', b === null && o.readOnly,
    `old session sees fmt=${seen}, newerApp=${o.newerApp}, readOnly=${o.readOnly}, commit ${b ? 'accepted' : 'refused'}`);
  await drain(o);
  await o.close(); await n.close();
}

// C. rollback on one PC: 0.14 (format 2) left edits in this PC's outbox (share down, app crashed),
//    the PC goes back to 0.12.1 (the rollback dialog promises they are "sent from the other version")
{
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'C', 'Setup', 'PC0', [['e1', 'desc', 'x']]);
  const local = tmp();
  const nf = flaky(nodefs);
  nf.st.appendDown = true;
  const n = await open({ dir, user: 'Nabil', account: 'nabil', host: 'PC1', localDir: local, fs: nf.fs, dataFormat: 2, appVersion: '0.14.0' });
  n.commit([['e1', 'desc', 'format-2 edit']]);
  await (n as any).localChain;
  n.kill();
  const o = await open({ dir, user: 'Nabil', account: 'nabil', host: 'PC1', localDir: local, dataFormat: 1, appVersion: '0.12.1' });
  await drain(o);
  const st = await readProjectStore(nodefs, dir);
  check('C. older app opening with a newer app\'s queued edits', o.readOnly === true,
    `0.12.1 readOnly=${o.readOnly}, newerApp=${o.newerApp}; share now: fmt=${st.get('project', 'fmt')} fmtBy=${st.get('project', 'fmtBy')} e1.desc=${st.get('e1', 'desc')}`);
  await o.close();
  const o3 = await open({ dir, user: 'Rami', dataFormat: 1, appVersion: '0.12.1' });
  check('C2. mark after that', o3.readOnly === true, `another 0.12.1 PC opens readOnly=${o3.readOnly} (fmt on share ${st.get('project', 'fmt')})`);
  await o3.close();
}
done();
