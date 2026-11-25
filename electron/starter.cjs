// Which copy of the app runs: the one the setup installed ("built in"), or a newer one the app
// downloaded itself into the person's store (%LOCALAPPDATA%\Goldline Takeoff\app\<version>, see
// versions.cjs). Rev Radar's boot, made callable from two places:
//
//   - electron/start.cjs (package.json "main" of a copy installed by the Goldline Takeoff setup):
//     start({ builtinDir: resources\app }) - the chosen copy's main.cjs is loaded here.
//   - the top of main.cjs, when nothing ran this first: a PC set up before Goldline Takeoff, whose
//     OLD starter (resources\app\boot.cjs, 0.22.0 - an update can't replace it) loaded
//     resources\app\versions\<v>\electron\main.cjs directly. start({ builtinDir: versions\<v>,
//     fromMain: true }): if that copy is the one to run, 'self' comes back and main.cjs goes on;
//     else the newer store copy's main.cjs is loaded here (the hand-over) and main.cjs stops.
//     The old starter still sees the version it started reach its first screen (legacy.cjs marks
//     it "ok" whichever copy runs), so it never falls back to 0.22.0 because of the hand-over.
//
// global.__gtBoot is the contract with every main.cjs, built-in or downloaded - keep it stable (a
// starter already on a PC - versions\<v> of an old-layout PC, resources\app of a setup install - is
// only replaced by a setup, so a newer main.cjs must not rely on anything more than this):
//   { version, dir, builtin, builtinVersion, builtinDir, store, installDir, legacy: { base, version } | null,
//     started(), notAStart(), failed(why) -> 'relaunch' | 'legacy' | '' }
// A store copy that fails to load, or never gets its window up (twice), is set aside and the next
// one runs; the built-in copy is the last resort. Nothing in the install folder is ever written
// (besides the old starter's own boot-state.json on an old-layout PC, where it can be written).
'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const V = require('./versions.cjs');
const L = require('./legacy.cjs');

/** the person's store of downloaded copies (GT_APP_STORE: tests only - never the packaged app) */
function storeDir() {
  const dev = !app.isPackaged;
  if (dev && process.env.GT_APP_STORE) return process.env.GT_APP_STORE;
  // (a development run keeps its downloads apart: it never picks up an installed copy's)
  if (dev) return path.join(os.tmpdir(), 'Goldline Takeoff (development)', 'app');
  return process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Goldline Takeoff', 'app')
    : path.join(app.getPath('appData'), 'Goldline Takeoff', 'app');
}

function start({ builtinDir, fromMain = false }) {
  if (global.__gtBoot) return 'self';
  const dev = !app.isPackaged;
  const noRelaunch = dev && (process.env.GT_BOOT_NO_RELAUNCH === '1' || process.env.GT_NO_RELAUNCH === '1');
  const installDir = (dev && process.env.GT_INSTALL_DIR) || path.dirname(process.execPath);
  const store = storeDir();
  const runtime = process.versions.electron;
  const note = (line) => {
    try { fs.mkdirSync(store, { recursive: true }); fs.appendFileSync(path.join(store, 'boot.log'), new Date().toISOString() + ' ' + line + '\n'); } catch (_) { /* never stop the start */ }
  };
  const builtinVersion = String((V.readJson(path.join(builtinDir, 'package.json')) || {}).version || '');
  // started by the old starter (resources\app\versions\<v>): the version it knows by its folder's name
  const legacy = L.isLegacy(builtinDir) ? { base: L.baseOf(builtinDir), version: path.basename(builtinDir) } : null;

  // the setup ran since the last start: what it installed runs (see versions.setupRan)
  try { const r = V.setupRan(store, installDir, builtinVersion); if (r) note(r); } catch (e) { note('setup check: ' + (e && e.message || e)); }
  let pick = null;
  const passed = new Set();
  const choose = () => { try { return V.choose(builtinDir, store, runtime); } catch (e) { note('choose: ' + (e && e.stack || e)); return null; } };
  pick = choose();
  // a store copy that failed to come up before is set aside here (and the next one is taken)
  let undo = null;
  while (pick && !pick.builtin) {
    if (passed.has(pick.dir)) { pick = null; break; } // (could not even be set aside: the built-in copy)
    passed.add(pick.dir);
    const dir = pick.dir, before = V.readJson(path.join(dir, 'starts.json'));
    if (V.beginStart(dir)) { undo = () => V.undoStart(dir, before); break; }
    note('set aside ' + pick.version + ' (its window did not come up)');
    pick = choose();
  }
  if (!pick) pick = { version: builtinVersion, dir: builtinDir, builtin: true };

  let watchdog = null;
  global.__gtBoot = {
    version: pick.version,
    dir: pick.dir,
    builtin: pick.builtin,
    builtinVersion,
    builtinDir,
    store,
    installDir,
    legacy,
    /** the first screen showed: this copy works (and the old starter's version too) */
    started() {
      clearTimeout(watchdog);
      if (!pick.builtin) V.startedOk(pick.dir);
      if (legacy) L.markHealthy(builtinDir, legacy.version);
    },
    /** not a start after all: another Goldline Takeoff already runs (single-instance lock) */
    notAStart() { clearTimeout(watchdog); if (undo) undo(); },
    /**
     * the running copy failed after it loaded (no window could be made): a store copy is set aside
     * ('relaunch': the next start runs the next one); the old layout's version is marked failed
     * ('legacy': the old starter starts the version before); else nothing to fall back to ('')
     */
    failed(why) {
      clearTimeout(watchdog);
      if (!pick.builtin) { V.setAside(pick.dir, 'it failed to start: ' + why); note('set aside ' + pick.version + ': ' + why); return 'relaunch'; }
      if (legacy && L.markFailed(builtinDir, legacy.version, why)) return 'legacy';
      return '';
    },
  };
  if (pick.builtin && fromMain) return 'self';
  if (!pick.builtin) {
    note('starting ' + pick.version + (legacy ? ' (handed over by ' + legacy.version + ')' : ''));
    // a copy that loads but never gets its window up (fails once Electron is ready...) would leave an
    // invisible process holding the single-instance lock: it counts as a failed start and starts again
    const ms = (dev && Number(process.env.GT_BOOT_WATCHDOG)) || 90000;
    watchdog = setTimeout(() => {
      note(pick.version + ': no window after ' + Math.round(ms / 1000) + ' s');
      if (!noRelaunch) app.relaunch();
      app.exit(0);
    }, ms);
    try {
      require(path.join(pick.dir, 'electron', 'main.cjs'));
    } catch (e) {
      // a downloaded copy that doesn't even load: set aside, and a clean start runs the next one
      // (never thrown on to the old starter: it would mark its own version failed)
      clearTimeout(watchdog);
      note('could not load ' + pick.version + ': ' + (e && e.stack || e));
      V.setAside(pick.dir, 'it could not be loaded: ' + (e && e.message || e));
      if (!noRelaunch) app.relaunch();
      app.exit(0);
    }
    return 'handed-over';
  }
  require(path.join(builtinDir, 'electron', 'main.cjs'));
  return 'self';
}

module.exports = { start, storeDir };
