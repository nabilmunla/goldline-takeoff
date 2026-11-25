// The layout of a PC set up before Goldline Takeoff (0.22.0
// and before), read and marked the way its starter expects - nothing else of the old update system
// is left in the app (it updates from GitHub only: updater.cjs; tools/legacy-release.cjs still
// writes the one release those PCs take from the old _releases folder):
//   resources\app\package.json     main: boot.cjs (the old starter - an update never replaces it)
//   resources\app\boot.cjs         starts versions\<current>, or the one before if that can't start
//   resources\app\current.json     { version, previous, bad: [versions this PC went back from] }
//   resources\app\boot-state.json  { <version>: { starts, ok, failed } }
//   resources\app\versions\<v>\    one folder per version
// The old starter passes a version over when it never reached its first screen in 3 starts, so the
// version it starts must be marked "ok" whichever copy then runs (starter.cjs hands over to a newer
// copy in the person's own store). A folder only IT may change (Program Files): every write here
// fails quietly and the old starter goes on as it is.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cmpVersion } = require('./versions.cjs');

/** where the versions live: resources\app (above versions\<v>), or appDir itself (not this layout) */
function baseOf(appDir) {
  return path.basename(path.dirname(appDir)) === 'versions' ? path.dirname(path.dirname(appDir)) : appDir;
}
/** appDir is a version started by the old starter (versions\<v> next to boot.cjs + current.json) */
function isLegacy(appDir) {
  const base = baseOf(appDir);
  return base !== appDir && fs.existsSync(path.join(base, 'boot.cjs'));
}

/** a JSON file written by hand too: a byte-order mark, or UTF-16 (PowerShell 5 "Out-File") */
function parseLoose(buf) {
  let t;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) t = buf.subarray(2).toString('utf16le');
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))); b.swap16(); t = b.toString('utf16le'); }
  else if (buf.length >= 2 && buf[1] === 0 && buf[0] !== 0) t = buf.toString('utf16le');
  else t = buf.toString('utf8');
  return JSON.parse(t.replace(/^﻿/, ''));
}
function readObj(file) {
  try { const j = parseLoose(fs.readFileSync(file)); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch (_) { return null; }
}
function writeJsonAtomic(file, obj) {
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (_) { /* */ } throw e; }
}
const readCurrent = (base) => readObj(path.join(base, 'current.json'));
const readState = (base) => readObj(path.join(base, 'boot-state.json')) || {};
const badList = (cur) => [].concat((cur && cur.bad) || []).filter((v) => typeof v === 'string');

/** the version reached its first screen: the old starter never passes it over. true = written now */
function markHealthy(appDir, version) {
  const base = baseOf(appDir);
  if (base === appDir) return false;
  try {
    const st = readState(base);
    if (st[version] && st[version].ok && !st[version].failed) return false;
    st[version] = { ...(st[version] || {}), ok: true, failed: null };
    writeJsonAtomic(path.join(base, 'boot-state.json'), st);
    return true;
  } catch (_) { return false; /* a folder only IT may change */ }
}
/** the version could not start (its main process failed): the old starter passes it over next time */
function markFailed(appDir, version, why) {
  const base = baseOf(appDir);
  if (base === appDir) return false;
  try {
    const st = readState(base);
    st[version] = { ...(st[version] || {}), failed: String(why || 'failed').slice(0, 300), ok: false };
    writeJsonAtomic(path.join(base, 'boot-state.json'), st);
    return true;
  } catch (_) { return false; }
}
/** the version before this one in the old layout, if it is installed and can start */
function previousOf(appDir, running) {
  const base = baseOf(appDir);
  if (base === appDir) return null;
  const cur = readCurrent(base);
  const p = cur && cur.version === running ? cur.previous : null;
  return typeof p === 'string' && p && fs.existsSync(path.join(base, 'versions', p, 'electron', 'main.cjs')) ? p : null;
}
/** go back to the version before (the old starter starts it next); false if there is none or the folder can't be written */
function rollback(appDir, running) {
  const base = baseOf(appDir);
  if (base === appDir) return false;
  const cur = readCurrent(base);
  if (!cur || cur.version !== running) return false;
  const prev = previousOf(appDir, running);
  if (!prev || prev === running) return false;
  try {
    writeJsonAtomic(path.join(base, 'current.json'), { version: prev, previous: null, bad: [...new Set([...badList(cur), running])], at: Date.now() });
    return prev;
  } catch (_) { return false; }
}

/**
 * What the old starter (boot.cjs, on a PC set up before Goldline Takeoff) put in the environment: the
 * versions it could not start. Its variable is found by the SHA-256 of its name - the name itself is
 * not in this source. '' when there is none.
 */
const OLD_BOOT_TRIED = '72c7c455575bf3ddb0189ec6d324b852abd7c0d6f0a84c37b2698e0a8092a26b';
function oldBootTried() {
  for (const k of Object.keys(process.env)) {
    if (crypto.createHash('sha256').update(k.toUpperCase()).digest('hex') === OLD_BOOT_TRIED) return process.env[k] || '';
  }
  return '';
}

/**
 * The taskbar id the shortcuts of a PC set up before Goldline Takeoff carry (it must match the app's own
 * or Windows shows a second icon next to the pinned one). Put together here, not spelled out: it names
 * the product those PCs were set up as.
 */
const OLD_AUMID = ['ae', 'gc' + 'c', 'estimation'].join('.');

/**
 * 0.23.1 (PC check): a PC set up before Goldline Takeoff still showed its desktop / Start menu shortcut by the
 * old name. Renamed to "Goldline Takeoff" - only shortcuts with one of the old names (known here by the SHA-256
 * of the name, lower case) that point at this very exe, and only where no "Goldline Takeoff" shortcut is
 * already. The ones every user shares (installed for everyone) need admin rights: left as they are, quietly.
 * Pinned taskbar icons are not touched (renaming those unpins them). Returns what was renamed.
 */
const OLD_LINKS = new Set(['bc36f69536ef5384d2ba234c1200679d228c3b943b2a9f4a8ffae97170a11781', '1fc9bc17072f02c1c7885e005d47be02e7d609b2215b9881c69ee9bc4cdcc6ac']);
const NEW_LINK = 'Goldline Takeoff.lnk';
function renameOldShortcuts(dirs, exe, readLink) {
  const done = [];
  const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  for (const dir of dirs) {
    if (!dir) continue;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      if (!/\.lnk$/i.test(n)) continue;
      const stem = n.slice(0, -4).trim().toLowerCase();
      if (!OLD_LINKS.has(crypto.createHash('sha256').update(stem).digest('hex'))) continue;
      const from = path.join(dir, n), to = path.join(dir, NEW_LINK);
      try {
        if (fs.existsSync(to)) continue;
        const target = (readLink(from) || {}).target;
        if (!same(target, exe)) continue;
        fs.renameSync(from, to);
        done.push(to);
      } catch (_) { /* (shared shortcuts: no rights - left as they are) */ }
    }
  }
  return done;
}

module.exports = { OLD_AUMID, renameOldShortcuts, oldBootTried, baseOf, isLegacy, parseLoose, readCurrent, readState, badList, markHealthy, markFailed, previousOf, rollback, cmpVersion };
