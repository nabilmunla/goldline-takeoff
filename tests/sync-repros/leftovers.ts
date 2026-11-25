// Changes left in this PC's outbox from an earlier run (share down, app closed) - sendLeftovers at sign-in
// and the session's own adoption.
// run (from the app folder): npx tsx tests/sync-repros/leftovers.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, readProjectStore } from '../../src/engine/projects';
import { nodefs, tmp, open, flaky, drain, check, done, sleep } from './lib';

const logs: string[] = [];
(globalThis as any).window = { gt: { fs: nodefs, log: (l: string) => logs.push(l) }, addEventListener() {} };
const { sendLeftovers } = await import('../../src/ui/backup');

async function leaveOffline(dir: string, local: string, host: string, account: string, ops: any[]) {
  const f = flaky(nodefs);
  const s = await open({ dir, user: account, account, host, localDir: local, fs: f.fs, dataFormat: 1, appVersion: '0.12.1' });
  await drain(s);
  f.st.down = true;
  s.commit(ops, 'offline edit');
  await (s as any).localChain;
  await s.close(); // "Close anyway": kept in the outbox
}
const signIn = (local: string, host: string, account: string) => sendLeftovers({
  localDir: local, user: account, account, host, appVersion: '0.12.1', dataFormat: 1,
  canEdit: () => true, isOpen: () => false, log: (l) => logs.push(l),
});

// R. the PC is renamed (IT re-images / renames it) after the app closed with unsent changes
{
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'R', 'Setup', 'PC0', [['e1', 'qty', 1]]);
  const local = tmp();
  await leaveOffline(dir, local, 'PC-17', 'nabil', [['e1', 'qty', 4242]]);
  logs.length = 0;
  for (let i = 0; i < 3; i++) await signIn(local, 'PC-18', 'nabil');
  const s = await open({ dir, user: 'nabil', account: 'nabil', host: 'PC-18', localDir: local, dataFormat: 1 });
  await drain(s);
  await s.close();
  const share = await readProjectStore(nodefs, dir);
  const ob = join(local, 'outbox', readdirSync(join(local, 'outbox'))[0]);
  const left = readdirSync(ob).filter((f) => f.endsWith('.log') && readFileSync(join(ob, f), 'utf8').includes('\n'));
  check('R. PC renamed', share.get('e1', 'qty') === 4242,
    `after 3 sign-ins and opening the project: share e1.qty=${share.get('e1', 'qty')}; still waiting on this PC: ${left.join(',')}; sendLeftovers log: ${JSON.stringify(logs)}`);
}

// S. another account's leftovers on a shared PC: every sign-in of Sara opens that project as Sara
{
  const data = tmp();
  const { dir } = await createProject(nodefs, data, 'S', 'Setup', 'PC0', [['e1', 'qty', 1]]);
  const local = tmp();
  await leaveOffline(dir, local, 'PC1', 'nabil', [['e1', 'qty', 99]]);
  const before = readdirSync(join(dir, 'journals')).length;
  const n = await signIn(local, 'PC1', 'sara');
  const st = await readProjectStore(nodefs, dir);
  const sara = [...st.hist.values()].flat().filter((h) => h.a === 'sara');
  check('S. Sara\'s sign-in and Nabil\'s leftovers', sara.length === 0,
    `sent=${n}; journals ${before} -> ${readdirSync(join(dir, 'journals')).length}; changes written as sara: ${JSON.stringify(sara.map((h) => h.f + '=' + h.v))}`);
}
done();
