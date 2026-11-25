// 0.23.2 (DeepSeek #8): a problem report saved in the team folder carries no folder names - also not those with
// spaces in them (the old rule stopped at the first space and kept the rest)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubPaths } from '../src/engine/scrub';

// (drive letters and server names put together here: the public copy carries none as written)
const B = String.fromCharCode(92);
const drv = (l: string) => l + ':' + B;
const unc = (server: string) => B + B + server + B;

test('folder paths with spaces leave a problem report whole', () => {
  const t = [
    `opened ${drv('C')}QS Files${B}Alpha Tower${B}Projects${B}Tower9 take-off`,
    `read of ${unc('fileserver01')}Tenders${B}Alpha Tower${B}Part 1 - Arch.pdf took too long`,
    `team folder ${drv('Y')}Jane Doe${B}Test Land`,
    `project ${drv('Y')}Jane Doe${B}Test Land${B}Projects${B}Secret.dat opened`,
    'linux /home/qs/Alpha Tower/x.pdf done',
    'a ratio 3 / 4 and a url https://github.com/x/y stay',
  ].join('\n');
  const out = scrubPaths(t, [`${drv('Y')}Jane Doe${B}Test Land`]);
  for (const w of ['Alpha', 'Tower', 'Projects', 'Tower9', 'Tenders', 'Jane', 'Doe', 'Test Land', 'fileserver01', 'Arch.pdf', 'Part 1', 'Secret']) assert.ok(!out.includes(w), `"${w}" left in:\n${out}`);
  assert.match(out, /took too long/);
  assert.match(out, /3 \/ 4/);
  assert.match(out, /https:\/\/github\.com\/x\/y/);
});
