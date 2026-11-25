// Electron "fuses" on the app's exe: it can't be run as plain Node (ELECTRON_RUN_AS_NODE), take
// NODE_OPTIONS, or be opened to a debugger (--inspect). Settings in the exe itself, not in the app's
// files, so they hold for every version the app updates itself to.
// node installer/fuses.mjs <exe>
import { flipFuses, FuseVersion, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
const exe = process.argv[2];
await flipFuses(exe, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
});
const wire = await getCurrentFuseWire(exe);
const off = (k) => wire[k] === 48; // '0' = disabled
if (!off(FuseV1Options.RunAsNode) || !off(FuseV1Options.EnableNodeOptionsEnvironmentVariable) || !off(FuseV1Options.EnableNodeCliInspectArguments)) {
  console.error('fuses not set', wire);
  process.exit(1);
}
console.log('fuses set:', exe);
