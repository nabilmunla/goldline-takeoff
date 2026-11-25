// Sync repros from the v0.12.1 deep bug hunt (each prints OK/BUG lines; "all checks passed" at the end).
// shared helpers for the hunt scripts (temp folders stay under ./work)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ProjectSession } from '../../src/engine/session';
import type { FsApi } from '../../src/engine/types';

const require = createRequire(import.meta.url);
export const nodefs: FsApi = require('../../electron/nodefs.cjs');
const WORK = tmpdir();
export const tmp = () => mkdtempSync(join(WORK, 'gt-repro-'));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** a share as one PC sees it: reads and writes can be switched off separately */
export function flaky(base: FsApi) {
  const st = { down: false, appendDown: false, readsDown: false };
  const err = () => Object.assign(new Error('network path not found'), { code: 'ENETUNREACH' });
  const g = <T extends (...a: any[]) => any>(f: T, kind: 'r' | 'w' | 'o'): T =>
    (async (...a: any[]) => {
      if (st.down || (kind === 'w' && st.appendDown) || (kind === 'r' && st.readsDown)) throw err();
      return f(...a);
    }) as T;
  const fs: FsApi = {
    join: base.join,
    mkdirp: g(base.mkdirp, 'o'), mkdirExcl: base.mkdirExcl ? g(base.mkdirExcl, 'o') : undefined,
    list: g(base.list, 'r'), readText: g(base.readText, 'r'), readFrom: g(base.readFrom, 'r'),
    append: g(base.append, 'w'), writeAtomic: g(base.writeAtomic, 'o'), remove: g(base.remove, 'o'), exists: g(base.exists, 'r'),
  };
  return { fs, st };
}

export async function open(o: {
  dir: string; user: string; account?: string; host?: string; localDir?: string; fs?: FsApi; localFs?: FsApi;
  dataFormat?: number; appVersion?: string; readOnly?: boolean; now?: () => number;
}) {
  const s = new ProjectSession({
    fs: o.fs ?? nodefs, localFs: o.localFs ?? nodefs, projectDir: o.dir, localDir: o.localDir ?? tmp(), user: o.user,
    account: o.account ?? o.user.toLowerCase(), host: o.host ?? 'PC-' + o.user, pollMs: 3600000, fullScanMs: 0, heartbeatMs: 3600000,
    dataFormat: o.dataFormat, appVersion: o.appVersion, readOnly: o.readOnly, now: o.now,
  });
  await s.open();
  return s;
}

export async function drain(s: ProjectSession, ms = 5000) {
  for (let i = 0; i < ms / 50 && s.pendingCount; i++) await sleep(50);
}

let fails = 0;
export function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'OK  ' : 'BUG '} ${name}: ${detail}`);
  if (!ok) fails++;
}
export function done() {
  console.log(fails ? `\n${fails} defect check(s) failed` : '\nall checks passed');
}
