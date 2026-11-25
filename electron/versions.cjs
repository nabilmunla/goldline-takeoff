// Which copy of Goldline Takeoff's app files runs, and the store of downloaded ones (Rev Radar's
// design).
//
// The setup installs the program with its app files ("built in": resources\app, or on a PC set up
// before Goldline Takeoff, resources\app\versions\<v> - see starter.cjs). Updates are downloaded by
// the app itself into the person's own folder - %LOCALAPPDATA%\Goldline Takeoff\app\<version> - and
// the next start runs the newest good copy. No helper program is ever started (company antivirus
// blocks programs started from AppData: only scripts, pages and pictures are put there; the exe
// stays where the setup put it). The same for a copy installed for everyone (Program Files): the
// store is the person's own, so no admin rights are needed.
//
// A copy in the store counts once ready.json is in it (written last, after the download was
// checked and unpacked) and it was made for this Electron runtime. A copy that never got its
// window up twice in a row, or failed to load, is set aside (bad.json) and the next one runs.
// Plain Node (no Electron): used by starter.cjs, updater.cjs, update-worker.cjs and the tests.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; } };
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const t = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(t, JSON.stringify(v, null, 2));
  fs.renameSync(t, p);
}

/** "0.9.5" < "0.10.2"; "0.13.0-rc1" < "0.13.0" (the rule of the app's version numbers) */
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
/** a > b */
const newer = (a, b) => cmpVersion(a, b) > 0;
/** 1.2.3 or 1.2.3-rc1: no leading zeros, small letters only (one folder per version) */
const VERSION_NAME = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9a-z.]+)?$/;
/** starts that never got a window, before a copy is set aside */
const MAX_FAILED_STARTS = 2;
/** a file an app package may hold: package.json, dist\..., electron\*.cjs (as releases always had) */
function appFile(name) {
  const n = String(name || '');
  if (!n || n.startsWith('/') || /^[a-z]:/i.test(n) || n.includes('\0') || n.split('/').some((s) => s === '..' || s === '.' || s === '')) return false;
  return n === 'package.json' || /^dist\/[\w./@ -]+$/.test(n) || /^electron\/[\w.-]+\.cjs$/.test(n);
}

/**
 * Every copy that could run: the built-in one and the good ones in the store (newest first).
 * builtinDir: what the setup installed; store: the downloaded copies; runtime: process.versions.electron.
 */
function candidates(builtinDir, store, runtime) {
  const out = [];
  const b = readJson(path.join(builtinDir, 'package.json'));
  if (b && b.version) out.push({ version: String(b.version), dir: builtinDir, builtin: true });
  let names = [];
  try { names = store ? fs.readdirSync(store) : []; } catch (_) { /* nothing downloaded yet */ }
  for (const n of names) {
    if (!VERSION_NAME.test(n)) continue;
    const d = path.join(store, n);
    const ready = readJson(path.join(d, 'ready.json'));
    const pk = readJson(path.join(d, 'package.json'));
    if (!ready || !pk || ready.version !== n || pk.version !== n) continue;
    if (ready.runtime && runtime && ready.runtime !== runtime) continue; // made for another Electron
    if (!fs.existsSync(path.join(d, 'electron', 'main.cjs'))) continue;
    if (fs.existsSync(path.join(d, 'bad.json'))) continue;
    out.push({ version: n, dir: d, builtin: false });
  }
  // newest first; the built-in copy wins a tie (it came with the setup)
  out.sort((a, c) => (newer(a.version, c.version) ? -1 : newer(c.version, a.version) ? 1 : a.builtin ? -1 : 1));
  return out;
}

/** the person's choice (Go back): { use: '<version>' } in the store */
const choiceFile = (store) => path.join(store, 'choice.json');
function pinned(store) {
  const c = readJson(choiceFile(store));
  return c && typeof c.use === 'string' ? c.use : '';
}
function pin(store, version) {
  if (version) writeJson(choiceFile(store), { use: String(version), at: Date.now() });
  else fs.rmSync(choiceFile(store), { force: true });
}

/** the copy to run now: the pinned one if it is still there, else the newest */
function choose(builtinDir, store, runtime) {
  const list = candidates(builtinDir, store, runtime);
  const want = pinned(store);
  return (want && list.find((c) => c.version === want)) || list[0] || null;
}

/**
 * The setup was run since the last start (its install.json is new): what it installed is what runs.
 * A "go back" choice made before is dropped, and downloaded copies as new as the installed one or
 * newer go (GitHub offers a newer version again - asking first). So an older setup run on purpose,
 * to go back, really goes back. Returns what was done, for the log ('' = nothing).
 */
function setupRan(store, installDir, builtinVersion) {
  const ii = readJson(path.join(installDir, 'install.json'));
  if (!ii || !ii.installed) return '';
  const seenFile = path.join(store, 'setup-seen.json');
  const seen = readJson(seenFile);
  if (seen && seen.installed === ii.installed) return '';
  const done = [];
  if (pinned(store)) { pin(store, ''); done.push('choice dropped'); }
  let names = [];
  try { names = fs.readdirSync(store); } catch (_) { /* nothing downloaded */ }
  for (const n of names) {
    if (VERSION_NAME.test(n) && !newer(builtinVersion, n)) {
      try { fs.rmSync(path.join(store, n), { recursive: true, force: true }); done.push('removed ' + n); } catch (e) { done.push('could not remove ' + n + ': ' + (e.code || e.message)); }
    }
  }
  try { writeJson(seenFile, { installed: ii.installed, version: ii.version || builtinVersion, at: Date.now() }); } catch (_) { /* read-only: done again next time */ }
  return 'setup ' + (ii.version || builtinVersion) + ' installed' + (done.length ? ': ' + done.join(', ') : '');
}

// ---------------------------------------------------------------- starting a store copy
// starter.cjs counts a start before it loads a store copy; main.cjs clears the count once the
// window has shown its first screen. A copy whose starts keep failing is set aside.
const startsFile = (dir) => path.join(dir, 'starts.json');
/** before loading: count this start. false: this copy failed too often - it is set aside now */
function beginStart(dir) {
  const s = readJson(startsFile(dir));
  const n = (s && Number(s.n)) || 0;
  if (n >= MAX_FAILED_STARTS) { setAside(dir, `its window did not come up ${n} times`); return false; }
  try { writeJson(startsFile(dir), { n: n + 1, at: Date.now() }); } catch (_) { /* a read-only store: just run it */ }
  return true;
}
/** this process turned out not to be a start (another Goldline Takeoff already runs): the count goes back */
function undoStart(dir, before) { try { if (before) writeJson(startsFile(dir), before); else fs.rmSync(startsFile(dir), { force: true }); } catch (_) { /* */ } }
function startedOk(dir) { try { fs.rmSync(startsFile(dir), { force: true }); } catch (_) { /* */ } }
function setAside(dir, why) { try { writeJson(path.join(dir, 'bad.json'), { why: String(why).slice(0, 500), at: Date.now() }); } catch (_) { /* */ } }

// ---------------------------------------------------------------- unpacking a downloaded copy
/** one file of an app package is never this big (the biggest, the PDF engine, is ~10 MB) */
const MAX_ENTRY = 256 * 1024 * 1024;
/**
 * Unzip (stored / deflated entries - what the release tool writes) into dst, which must not exist.
 * Only the app's own files (appFile), kept inside dst. Returns the number of files.
 */
function unzip(zipPath, dst) {
  const buf = fs.readFileSync(zipPath);
  // end of central directory: searched from the end (a comment may follow it)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let n = 0;
  const root = path.resolve(dst);
  const seen = new Set();
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip (central directory)');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl).replace(/\\/g, '/');
    p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    if (!appFile(name)) throw new Error('the package holds a file the app does not take: ' + name);
    if (seen.has(name.toLowerCase())) throw new Error('damaged zip (' + name + ' twice)');
    seen.add(name.toLowerCase());
    if (usize > MAX_ENTRY) throw new Error('damaged zip (' + name + ' is too big)');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('damaged zip (entry)');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) throw new Error('damaged zip (' + name + ' cut short)');
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) }) : null;
    if (!data) throw new Error('unsupported zip method ' + method);
    if (data.length !== usize) throw new Error('damaged zip (size of ' + name + ')');
    const out = path.resolve(root, name);
    if (!out.startsWith(root + path.sep)) throw new Error('bad path in zip: ' + name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    n++;
  }
  return n;
}

/** the downloaded file is the one latest.json signed (size and SHA-256), else throws */
function checkPackage(zipPath, sha256, size) {
  const buf = fs.readFileSync(zipPath);
  if (size && buf.length !== Number(size)) throw new Error('the package is not the size that was published');
  const got = require('crypto').createHash('sha256').update(buf).digest('hex');
  if (!/^[0-9a-f]{64}$/i.test(String(sha256 || '')) || got !== String(sha256).toLowerCase()) throw new Error('the package does not match its published checksum');
}

/**
 * Put a downloaded, checked package into the store as <store>/<version>: unpacked next to it,
 * checked (its package.json says that version, the main files are there), ready.json written last,
 * then moved into place. A copy already there for that version is replaced.
 */
function installPackage(zipPath, store, version, runtime, sha256) {
  if (!VERSION_NAME.test(version)) throw new Error('bad version ' + version);
  fs.mkdirSync(store, { recursive: true });
  const dst = path.join(store, version);
  const part = dst + '.part-' + process.pid;
  fs.rmSync(part, { recursive: true, force: true });
  try {
    unzip(zipPath, part);
    const pk = readJson(path.join(part, 'package.json'));
    if (!pk || pk.version !== version) throw new Error(`the package holds version ${pk && pk.version}, expected ${version}`);
    for (const f of ['electron/main.cjs', 'electron/preload.cjs', 'dist/index.html']) if (!fs.existsSync(path.join(part, f))) throw new Error('the package is incomplete (no ' + f + ')');
    writeJson(path.join(part, 'ready.json'), { version, runtime, sha256, at: Date.now() });
    fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(part, dst);
  } catch (e) {
    fs.rmSync(part, { recursive: true, force: true });
    throw e;
  }
  return dst;
}

/**
 * Old copies go: kept are the one running, the newest one older than it (to go back to), the
 * pinned one and anything newer than the running one. Unfinished unpacks and old downloads go.
 * Nothing outside the store is ever touched (the setup's own files stay as they are).
 */
function tidy(store, running) {
  let names = [];
  try { names = fs.readdirSync(store); } catch (_) { return; }
  const versions = names.filter((n) => VERSION_NAME.test(n));
  const good = (v) => fs.existsSync(path.join(store, v, 'ready.json')) && !fs.existsSync(path.join(store, v, 'bad.json'));
  const older = versions.filter((v) => newer(running, v) && good(v)).sort((a, b) => (newer(a, b) ? -1 : 1));
  const keep = new Set([running, pinned(store), older[0]].filter(Boolean));
  for (const n of names) {
    const d = path.join(store, n);
    if (/\.part-\d+$/.test(n)) {
      // (another start may be unpacking right now: only old ones)
      try { if (Date.now() - fs.statSync(d).mtimeMs > 30 * 60 * 1000) fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* */ }
      continue;
    }
    if (!VERSION_NAME.test(n) || keep.has(n) || newer(n, running)) continue;
    fs.rmSync(d, { recursive: true, force: true });
  }
  // downloads: unpacked ones are not needed again
  const dl = path.join(store, 'downloads');
  try {
    for (const f of fs.readdirSync(dl)) {
      const m = /^app-v(.+)\.zip(\.part)?$/.exec(f);
      if (!m || m[2] || fs.existsSync(path.join(store, m[1], 'ready.json'))) fs.rmSync(path.join(dl, f), { force: true });
    }
  } catch (_) { /* none */ }
}

module.exports = {
  readJson, writeJson, cmpVersion, newer, VERSION_NAME, appFile, candidates, choose, pinned, pin, setupRan,
  beginStart, undoStart, startedOk, setAside, unzip, checkPackage, installPackage, tidy, MAX_FAILED_STARTS,
};
