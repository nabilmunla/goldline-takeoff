// Multi-process stress test: N simulated users edit the same project at once,
// one of them crashes mid-way (with the share "down" and a torn line left in its
// journal) and restarts. At the end every copy must be identical, and every
// change anyone made must be present.
//
// usage: stress <folder> [users=4] [opsPerUser=300]
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject } from '../src/engine/projects';
import { demoBoqOps } from './helpers/demoboq';
import { ProjectSession } from '../src/engine/session';
import { buildQtoModel } from '../src/engine/qto/model';
import type { FsApi } from '../src/engine/types';

const require = createRequire(import.meta.url);
const nodefs: FsApi = require('../electron/nodefs.cjs');
const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const root = process.argv[2] || mkdtempSync(join(tmpdir(), 'gtstress-'));
const users = Number(process.argv[3] || 4);
const ops = Number(process.argv[4] || 300);
const pace = Number(process.argv[5] || 40);
const workerFile = process.env.STRESS_WORKER || join(here, 'stress-worker.ts');
const execArgv = workerFile.endsWith('.ts') ? ['--import', 'tsx'] : [];

async function main() {
  const t0 = Date.now();
  const dataRoot = join(root, 'stress-' + Date.now().toString(36));
  await nodefs.mkdirp(dataRoot); // (a project is only created on a folder that is there)
  const qto = process.env.STRESS_KIND === 'qto';
  // take-off: 5 sheets at 1:100, two users per sheet
  const qtoOps: any[] = [];
  for (let d = 0; d < Math.ceil(users / 2); d++) qtoOps.push(['dwg:d' + d, 'name', 'Sheet ' + d + '.pdf'], ['dwg:d' + d, 'path', 'S:\\drawings\\sheet' + d + '.pdf'], ['pg:dwg:d' + d + '.0', 'sc', 0.0352778]);
  const { dir: projectDir } = await createProject(nodefs, dataRoot, 'Stress Test', 'Setup', 'STRESS', qto ? qtoOps : demoBoqOps(), undefined, qto ? 'takeoff' : 'takeoff');
  console.log(`project: ${projectDir}\nusers: ${users}, edits each: ${ops}, pause between edits up to ${pace} ms, user 1 crashes at edit ${Math.floor(ops / 2)}`);
  const allStamps: string[] = [];
  const kids: any[] = [];

  const spawn = (k: number, startAt: number, localDir: string): Promise<any> =>
    new Promise((resolve) => {
      const cfg = { projectDir, localDir, user: 'User' + (k + 1), ops, crashAt: k === 0 && startAt === 0 ? Math.floor(ops / 2) : -1, startAt, pace };
      const child = fork(workerFile, [JSON.stringify(cfg)], { execArgv, stdio: 'inherit' });
      child.on('message', (m: any) => {
        if (m.type === 'crashed') {
          allStamps.push(...m.stamps);
          console.log(`User${k + 1} crashed after ${m.at} edits (5 edits only in local outbox, torn line in journal) - restarting`);
          child.on('exit', () => resolve(spawn(k, m.at, localDir)));
        } else if (m.type === 'done') {
          allStamps.push(...m.stamps);
          console.log(`User${k + 1} finished (opened project in ${m.openMs} ms)`);
          resolve(child);
        }
      });
      child.on('exit', (code) => { if (code && code !== 3 && code !== 0) { console.error('worker failed', code); process.exit(1); } });
    });

  for (let k = 0; k < users; k++) kids.push(spawn(k, 0, mkdtempSync(join(tmpdir(), 'gtstress-local-'))));
  const children = await Promise.all(kids);
  console.log(`all edits done in ${((Date.now() - t0) / 1000).toFixed(1)} s - waiting for everyone to converge`);

  const ask = (c: any): Promise<any> => new Promise((res) => { c.once('message', res); c.send({ type: 'fp' }); });
  let fps: any[] = [];
  let agreed = false;
  for (let round = 0; round < 60; round++) {
    await sleep(1000);
    fps = await Promise.all(children.map(ask));
    if (fps.every((f) => f.pending === 0 && f.fp === fps[0].fp)) { agreed = true; break; }
  }
  // fresh reader: what someone opening the project now would see
  const fresh: ProjectSession = new ProjectSession({ fs: nodefs, localFs: nodefs, projectDir, localDir: mkdtempSync(join(tmpdir(), 'gtstress-fresh-')), user: 'Auditor', host: 'STRESS', pollMs: 60000, fullScanMs: 0, heartbeatMs: 60000 });
  const t1 = Date.now();
  await fresh.open();
  const freshOpen = Date.now() - t1;
  const missing = allStamps.filter((s) => !fresh.store.hasBatch(s));
  let freshFp = fresh.store.fingerprint();
  if (qto) {
    const m = buildQtoModel(fresh.store, null);
    let total = 0;
    for (const q of m.qty.values()) total += q.area;
    freshFp += ' area=' + total.toFixed(3);
    console.log(`take-off result: ${m.items.length} take-offs, ${m.shapes.length} shapes, ${m.links.length} links, ${m.notes.length} notes, total area ${total.toFixed(1)} m²`);
  }
  await fresh.close();
  for (const c of children) c.send({ type: 'stop' });

  const lat = fps.flatMap((f) => f.latencies).sort((a: number, b: number) => a - b);
  const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : NaN);
  const jdir = join(projectDir, 'journals');
  const files = readdirSync(jdir);
  const bytes = files.reduce((a, f) => a + statSync(join(jdir, f)).size, 0);
  const ok = agreed && fps.every((f) => f.fp === freshFp) && missing.length === 0;
  console.log('---');
  console.log(`changes committed: ${allStamps.length}`);
  console.log(`all copies identical: ${agreed && fps.every((f) => f.fp === freshFp) ? 'YES' : 'NO'}  (${freshFp})`);
  console.log(`changes lost: ${missing.length}`);
  console.log(`journal files: ${files.length}, total size: ${(bytes / 1024).toFixed(0)} KB, corrupt lines skipped: ${fresh.getStatus().corruptLines}`);
  console.log(`time for a change to reach others: median ${(pct(0.5) / 1000).toFixed(2)} s, 95% within ${(pct(0.95) / 1000).toFixed(2)} s (n=${lat.length})`);
  console.log(`fresh open of project: ${freshOpen} ms`);
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  setTimeout(() => process.exit(ok ? 0 : 1), 1500);
}
main().catch((e) => { console.error(e); process.exit(1); });
