// THE OLD STARTER (resources\app\boot.cjs of a PC set up before Goldline Takeoff - 0.22.0 and
// before). Kept in every release unchanged, BOOT_REV 3: 0.22.0's updater and update helper require
// electron/boot.cjs in a release and copy it over the PC's only when its BOOT_REV is higher (never,
// so the PCs keep theirs), and a one-folder copy takes it as its starter. Goldline Takeoff itself
// starts with electron/start.cjs (setup installs); on these PCs main.cjs hands over to a newer
// downloaded copy (starter.cjs). tools/legacy-release.cjs refuses a bridge release without this file.
//
// Goldline Takeoff starter (resources\app\boot.cjs): starts the version named in current.json, or
// the one before it if that version can't start (a bad update falls back by itself).
// The app itself is in versions\<version>\. An update replaces this file only when it brings a
// higher BOOT_REV (the old updater) - it must stay small, careful and standalone (no other files).
//
// A version is passed over when:
//   - current.json lists it as `bad` (this PC went back from it),
//   - its main process failed to load (it is marked `failed` in boot-state.json and the app starts
//     again in a clean process with the next version: the failed one may have left half its set-up
//     behind in this one),
//   - it never reached its first screen in 3 starts (`starts` without `ok`).
// If every version is passed over, they are tried anyway, newest first.
'use strict';
const BOOT_REV = 3;
const fs = require('fs');
const path = require('path');

const base = __dirname;
const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };
const startable = (v) => typeof v === 'string' && /^[\w.-]+$/.test(v) && !v.startsWith('.')
  && ['package.json', 'electron/main.cjs', 'electron/preload.cjs', 'dist/index.html'].every((f) => exists(path.join(base, 'versions', v, f)));

/** JSON written by the app or by hand: a byte-order mark, or UTF-16 (PowerShell 5 "Out-File") */
function readJson(file) {
  try {
    const buf = fs.readFileSync(file);
    let t;
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) t = buf.subarray(2).toString('utf16le');
    else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))); b.swap16(); t = b.toString('utf16le'); }
    else if (buf.length >= 2 && buf[1] === 0 && buf[0] !== 0) t = buf.toString('utf16le');
    else t = buf.toString('utf8');
    const j = JSON.parse(t.replace(/^﻿/, ''));
    return j && typeof j === 'object' ? j : {};
  } catch (_) {
    return {};
  }
}
function writeJson(file, obj) {
  try {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, file);
  } catch (_) { /* a read-only app folder: start anyway */ }
}

/** "0.9.5" < "0.10.2"; "0.13.0-rc1" < "0.13.0" (as updater.cjs) */
function cmpVersion(a, b) {
  const split = (v) => {
    const s = String(v).trim();
    const dash = s.indexOf('-');
    return { nums: (dash < 0 ? s : s.slice(0, dash)).split('.').map((x) => parseInt(x, 10) || 0), pre: dash < 0 ? '' : s.slice(dash + 1) };
  };
  const A = split(a), B = split(b);
  for (let i = 0; i < Math.max(A.nums.length, B.nums.length); i++) {
    const d = (A.nums[i] || 0) - (B.nums[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  const c = A.pre.localeCompare(B.pre, undefined, { numeric: true });
  if (c) return c < 0 ? -1 : 1;
  return A.pre < B.pre ? -1 : 1;
}

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : ''; };
const skipped = argOf('boot-skip').split(',').filter(Boolean);
const curFile = path.join(base, 'current.json');
const stateFile = path.join(base, 'boot-state.json');
const cur = readJson(curFile);
const state = readJson(stateFile);
const bad = new Set([].concat(cur.bad || []).filter((v) => typeof v === 'string'));
const installed = (() => { try { return fs.readdirSync(path.join(base, 'versions')).filter(startable).sort((a, b) => cmpVersion(b, a)); } catch (_) { return []; } })();
const order = [...new Set([cur.version, cur.previous, ...installed])].filter((v) => startable(v) && !skipped.includes(v));
const doubtful = (v) => {
  const s = state[v] || {};
  return bad.has(v) || (!s.ok && (!!s.failed || (s.starts || 0) >= 3));
};
const good = order.filter((v) => !doubtful(v));
const pick = good.length ? good : order;
const tried = decodeURIComponent(argOf('boot-tried')).split('\n').filter(Boolean);
const noRelaunch = process.env.GT_NO_RELAUNCH === '1';

let started = false;
for (const v of pick) {
  const s = state[v] || {};
  if (!s.ok) { state[v] = { ...s, starts: (s.starts || 0) + 1 }; writeJson(stateFile, state); }
  try {
    process.env.GT_BOOT_TRIED = tried.join(',');
    require(path.join(base, 'versions', v, 'electron', 'main.cjs'));
    started = true;
    break;
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 200);
    tried.push(v + ': ' + why);
    state[v] = { ...(state[v] || {}), failed: why, ok: false };
    writeJson(stateFile, state);
    if (noRelaunch) continue; // tests: the next one in this process
    // the next version in a clean process (this one may hold what the failed one set up)
    const rest = pick.slice(pick.indexOf(v) + 1);
    if (!rest.length) break;
    try {
      const { app } = require('electron');
      // the failed version may have taken the one-window lock: the next start must get it
      try { app.releaseSingleInstanceLock(); } catch (_) { /* not taken */ }
      const args = process.argv.slice(1).filter((a) => !a.startsWith('--boot-skip=') && !a.startsWith('--boot-tried='));
      app.relaunch({ args: [...args, '--boot-skip=' + [...skipped, v].join(','), '--boot-tried=' + encodeURIComponent(tried.join('\n'))] });
      app.exit(0);
      started = true; // the next start takes over
      break;
    } catch (_) { /* no relaunch possible: try the next one here */ }
  }
}
if (!started) {
  const { app, dialog } = require('electron');
  app.whenReady().then(() => {
    dialog.showErrorBox('Goldline Takeoff can\'t start', 'None of the installed versions could start.\n\n' + (tried.join('\n') || 'No version found in ' + path.join(base, 'versions')) + '\n\nAsk IT to install Goldline Takeoff again.');
    app.quit();
  });
}
module.exports = { BOOT_REV };
