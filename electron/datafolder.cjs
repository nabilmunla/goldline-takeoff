// This PC's data folder: where it is now, and how what an earlier version of the app kept elsewhere
// comes along - settings (the shared folder chosen), changes not yet on the shared folder (the outbox),
// remembered views and View-only switches (Local Storage), logs. Never moved, never deleted: the earlier
// folder stays as it was, so a version that is started again after a go-back still finds its own data.
//
//   %LOCALAPPDATA%\Goldline Takeoff\data\profile-<name>      (this version; ...\Goldline Takeoff\app is
//                                                              the store of downloaded copies: apart)
//
// The earlier folder (a product folder of another name, in Local or in roaming AppData) is found by the
// SHA-256 of its lower-cased name - the name itself is not in this source. Used by main.cjs before the
// app is ready; takes its places as arguments so a test can run it on a fake tree.
//
// Once (marker `migrated.json` in the new folder): everything except caches and locks is COPIED over.
// A top-level entry that could not be copied at all is copied at a later start, as long as the new folder
// has none of its own yet (never into one the app already uses: a half old, half new Local Storage).
// The drawing cache (qto-cache: this PC's copies of drawings, the simplified monster sheets) is MOVED in
// one rename on the same disk - copying gigabytes before the first window is not an option, and fetching
// and simplifying every drawing again is what the cache is there to spare. A version started again after
// a go-back fetches its own again. (Moving fails - another disk, in use: it is left, fetched again.)
// The outbox is not part of that copy; it is taken over by sweepOutbox(), which runs at every start while
// the earlier folder is there (a version that went back and made changes of its own is covered too):
//   - each queue file (*.log) of the earlier outbox is first claimed (renamed *.log.taking: an earlier
//     version still running writes its next change into a new *.log, taken at the next start - never
//     into a file already copied), then copied into the new outbox (the session that opens that project
//     takes it over from there and sends it, exactly as it would its own queue) - copied again if it
//     grew meanwhile (a write that was under way),
//   - then renamed *.log.moved, so a version that runs from the earlier folder again never sends it a
//     second time (and this one never takes it a second time). A claim left by a crash is taken next time.
// A change that is sent twice anyway (a crash between the copy and the rename) is the same change: the
// store ignores a stamp it has seen.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** SHA-256 of the lower-cased name of the product folder an earlier version used */
const OLD_FOLDERS = ['1fc9bc17072f02c1c7885e005d47be02e7d609b2215b9881c69ee9bc4cdcc6ac'];
const MARKER = 'migrated.json';
const MOVED = '.moved';
const TAKING = '.taking';
/** a lock file of a running app (Chromium's LevelDB LOCK, its singleton files): never copied - made again */
const LOCKS = new Set(['lock', 'lockfile', 'singletonlock', 'singletoncookie', 'singletonsocket']);
/** moved, not copied (see above) */
const MOVE = ['qto-cache'];
/** caches (fetched again) and locks of a running app: not worth copying */
const SKIP = new Set(['outbox', 'qto-cache', 'cache', 'code cache', 'gpucache', 'dawncache', 'dawngraphitecache', 'dawnwebgpucache', 'grshadercache', 'shadercache',
  'crashpad', 'blob_storage', 'network', 'service worker', 'shared dictionary', 'component_crx_cache', 'lockfile', 'singletonlock', 'singletoncookie', 'singletonsocket']);

function findOldRoot(base) {
  let names;
  try { names = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of names) if (e.isDirectory() && OLD_FOLDERS.includes(sha(e.name.toLowerCase()))) return path.join(base, e.name);
  return null;
}

/** where an earlier version kept this profile (Local AppData first, then the roaming profile), or null */
function findOldProfile({ localRoot, roamingRoot, profile }) {
  for (const base of [...new Set([localRoot, roamingRoot].filter(Boolean))]) {
    const root = findOldRoot(base);
    const dir = root && path.join(root, 'profile-' + profile);
    if (dir && fs.existsSync(dir)) return dir;
  }
  return null;
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; } }

/** a tree copied without overwriting anything already there; files that can't be read are counted, not fatal */
function copyTree(from, to, skip, out, top = '') {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip && skip.has(e.name.toLowerCase())) continue;
    if (LOCKS.has(e.name.toLowerCase())) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    try {
      if (e.isDirectory()) copyTree(a, b, null, out, top || e.name);
      else if (e.isFile() && !fs.existsSync(b)) { fs.copyFileSync(a, b); out.files++; }
    } catch (err) {
      out.failed.push(e.name + ': ' + (err && err.message || err));
      if (out.failedTop && !out.failedTop.includes(top || e.name)) out.failedTop.push(top || e.name);
    }
  }
}

const sameFile = (a, b) => { try { return fs.statSync(a).size === fs.statSync(b).size && fs.readFileSync(a).equals(fs.readFileSync(b)); } catch (_) { return false; } };

/**
 * The earlier outbox taken over: queue files copied across, then marked as taken. Safe to run at every
 * start. Returns { taken: files taken over now, waiting: files that could not be (tried again next start) }.
 */
function sweepOutbox(oldDir, newDir) {
  const res = { taken: 0, waiting: 0 };
  const from = path.join(oldDir, 'outbox'), to = path.join(newDir, 'outbox');
  let dirs;
  try { dirs = fs.readdirSync(from, { withFileTypes: true }); } catch (_) { return res; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const a = path.join(from, d.name), b = path.join(to, d.name);
    let files;
    try { files = fs.readdirSync(a, { withFileTypes: true }).filter((e) => e.isFile()); } catch (_) { res.waiting++; continue; }
    const logs = files.filter((e) => e.name.endsWith('.log') || e.name.endsWith('.log' + TAKING));
    if (!logs.length) continue;
    try { fs.mkdirSync(b, { recursive: true }); } catch (_) { res.waiting++; continue; }
    // which project the queue belongs to (sign-in sends what is left even before the project is opened)
    const tgt = path.join(b, 'target.json');
    if (files.some((e) => e.name === 'target.json') && !fs.existsSync(tgt)) { try { fs.copyFileSync(path.join(a, 'target.json'), tgt); } catch (_) { /* the log is what counts */ } }
    for (const e of logs) {
      const name = e.name.endsWith(TAKING) ? e.name.slice(0, -TAKING.length) : e.name;
      const orig = path.join(a, name), src = orig + TAKING;
      // claimed first: what an earlier version still running appends from now on goes into a new file
      if (src !== path.join(a, e.name)) { try { fs.renameSync(orig, src); } catch (_) { res.waiting++; continue; } }
      try {
        let dst = path.join(b, name);
        if (fs.existsSync(dst) && !sameFile(src, dst)) {
          // a file of that name is there already, with other things in it: the queue keeps its own name
          dst = path.join(b, name.replace(/\.log$/, '') + '~earlier-' + sha(fs.readFileSync(src)).slice(0, 8) + '.log');
        }
        if (!fs.existsSync(dst)) {
          // (written whole and renamed: a half-copied queue is never named *.log in the new outbox;
          // copied again while the file grew under the copy - a write that was already under way)
          const tmp = dst + '.part';
          for (let k = 0; ; k++) {
            const before = fs.statSync(src).size;
            fs.copyFileSync(src, tmp);
            if (fs.statSync(src).size === before && fs.statSync(tmp).size === before) break;
            if (k >= 4) throw new Error('still growing');
          }
          fs.renameSync(tmp, dst);
        }
        fs.renameSync(src, orig + MOVED);
        res.taken++;
      } catch (_) {
        // not taken: offered again (to this version at its next start, to the earlier one as its queue)
        if (!fs.existsSync(orig)) { try { fs.renameSync(src, orig); } catch (_e) { /* the claim is taken next time */ } }
        res.waiting++;
      }
    }
  }
  return res;
}

/**
 * Brings the data of an earlier version into newDir (once) and takes over its unsent changes (until
 * they are). Never throws: a problem is returned in `note` and tried again at the next start.
 * Returns { from, copied, outbox: { taken, waiting }, note } - from is null when there is no earlier folder.
 */
function migrateDataFolder({ newDir, localRoot, roamingRoot, profile }) {
  const out = { from: null, copied: false, outbox: { taken: 0, waiting: 0 }, note: '' };
  try {
    let state = readJson(path.join(newDir, MARKER));
    if (!state || typeof state.from !== 'string') {
      const old = findOldProfile({ localRoot, roamingRoot, profile });
      if (!old || path.resolve(old) === path.resolve(newDir)) return out;
      const c = { files: 0, failed: [], failedTop: [] };
      fs.mkdirSync(newDir, { recursive: true });
      copyTree(old, newDir, SKIP, c);
      // without its settings (the shared folder chosen) a PC would start as a new one: not marked, so tried again
      if (isFile(path.join(old, 'settings.json')) && !isFile(path.join(newDir, 'settings.json'))) { out.note = 'the settings could not be copied: ' + c.failed.join('; '); return out; }
      const moved = [];
      for (const n of MOVE) {
        const a = path.join(old, n), b = path.join(newDir, n);
        try { if (fs.existsSync(a) && !fs.existsSync(b)) { fs.renameSync(a, b); moved.push(n); } } catch (_) { /* another disk, or in use: fetched again */ }
      }
      // a top-level folder copied only in part is taken out again (all or nothing: a Local Storage with files
      // missing is a damaged one) and tried again at later starts, while the new folder has none (see above)
      for (const n of c.failedTop) { const b = path.join(newDir, n); try { if (n.toLowerCase() !== 'settings.json' && fs.statSync(b).isDirectory()) fs.rmSync(b, { recursive: true, force: true }); } catch (_) { /* not there */ } }
      const retry = c.failedTop.filter((n) => !fs.existsSync(path.join(newDir, n)));
      state = { from: old, at: new Date().toISOString(), files: c.files, failed: c.failed.slice(0, 20), moved, retry, tries: 0 };
      fs.writeFileSync(path.join(newDir, MARKER), JSON.stringify(state, null, 1));
      out.copied = true;
      out.note = `copied ${c.files} file(s) from the data folder of an earlier version` + (c.failed.length ? `; ${c.failed.length} could not be copied` : '') + (moved.length ? '; its drawing cache moved over' : '');
    } else if (Array.isArray(state.retry) && state.retry.length && (state.tries || 0) < 10 && fs.existsSync(state.from)) {
      const c = { files: 0, failed: [], failedTop: [] };
      const left = [];
      for (const n of state.retry) {
        const a = path.join(state.from, String(n)), b = path.join(newDir, String(n));
        // (only into nothing: never mixed into what this version has made of its own since)
        if (fs.existsSync(b) || !fs.existsSync(a)) continue;
        const before = c.failed.length;
        try { if (fs.statSync(a).isDirectory()) copyTree(a, b, null, c, String(n)); else { fs.copyFileSync(a, b); c.files++; } } catch (e) { c.failed.push(n + ': ' + (e && e.message || e)); }
        if (c.failed.length > before) { try { fs.rmSync(b, { recursive: true, force: true }); } catch (_) { /* */ } left.push(n); }
      }
      state = { ...state, retry: left, tries: (state.tries || 0) + 1 };
      try { fs.writeFileSync(path.join(newDir, MARKER), JSON.stringify(state, null, 1)); } catch (_) { /* tried again next start */ }
      if (c.files) out.note = `copied ${c.files} more file(s) from the data folder of an earlier version`;
    }
    out.from = state.from;
    if (fs.existsSync(state.from)) {
      out.outbox = sweepOutbox(state.from, newDir);
      if (out.outbox.taken) out.note += (out.note ? '; ' : '') + `took over ${out.outbox.taken} queue file(s) of changes not yet sent`;
      if (out.outbox.waiting) out.note += (out.note ? '; ' : '') + `${out.outbox.waiting} queue file(s) of the earlier folder could not be taken over yet`;
    }
  } catch (e) { out.note = 'moving the data of an earlier version failed: ' + (e && e.message || e); }
  return out;
}

module.exports = { migrateDataFolder, sweepOutbox, findOldProfile, OLD_FOLDERS, MARKER, MOVED };
