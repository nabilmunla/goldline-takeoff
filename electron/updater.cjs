// Updates from Goldline Takeoff's GitHub releases, without any helper program (Rev Radar's design).
//
// Where: package.json "updateFeed" (https://github.com/nabilmunla/goldline-takeoff - feed.cjs), for
// every copy, however it was installed. The old <shared folder>\_releases is not read any more: the
// first Goldline Takeoff version reached the PCs through it once (the bridge, tools/legacy-release.cjs).
// GT_UPDATE_FEED points the tests at a feed of their own (never the packaged app).
// Trust: latest.json must carry the publisher's signature (updsig.cjs, Ed25519, the public key in
// the app); the package must match the SHA-256 it signed and the size it announced.
//
// How: the feed is read in update-worker.cjs, a process of its own with a time limit, so a PC
// without internet just gets "not reachable" - no waiting, no pop-ups. A new version is announced
// and only downloaded when the person says so; the copy is checked (SHA-256), unpacked into
// %LOCALAPPDATA%\Goldline Takeoff\app\<version> (versions.cjs: scripts and pages only - no program)
// and the next start runs it (starter.cjs): "Restart now" closes the app the normal way and starts
// the exe again. The same for a copy installed for everyone (Program Files): the store is the
// person's own, so no admin rights and no helper. Nothing the running app uses is touched. A version
// with a new Electron runtime needs the setup: the card says so and opens the release page.
'use strict';
const { app, utilityProcess, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const V = require('./versions.cjs');
const feed = require('./feed.cjs');
const { verifyLatest } = require('./updsig.cjs');

const dev = !app.isPackaged;
const envNum = (k, d) => (dev && Number(process.env[k])) || d;
const CHECK_TIMEOUT = envNum('GT_UPDATE_TIMEOUT', 15000);
const STALL_TIMEOUT = envNum('GT_UPDATE_STALL', 60000);
const INSTALL_TIMEOUT = 120000;
const EVERY = 4 * 3600 * 1000;
const FIRST = envNum('GT_UPDATE_FIRST', 20000);
const PRODUCT = 'Goldline Takeoff';

function create({ version, readSettings, writeSettings, log, send }) {
  const boot = global.__gtBoot || {};
  const store = boot.store || require('./starter.cjs').storeDir();
  const builtinDir = boot.builtinDir || path.join(__dirname, '..');
  const runtime = process.versions.electron;
  const pkg = V.readJson(path.join(__dirname, '..', 'package.json')) || {};
  const source = () => feed.source(pkg, !dev);
  const list = () => { try { return V.candidates(builtinDir, store, runtime); } catch (_) { return []; } };
  /** the copy to go back to: the newest one older than this */
  const previous = () => list().find((c) => V.newer(version, c.version)) || null;

  /** idle | checking | none | available | downloading | installing | ready | setup | error | unreachable | empty */
  let st = { state: 'idle' };
  let latest = null; // { version, notes, kind, pkg }
  let worker = null;
  let laterFor = '';
  let timer = null;

  function snapshot() {
    const s = readSettings();
    const prev = previous();
    return {
      ...st,
      version,
      builtin: boot.builtin !== false,
      source: source(),
      /** the page people can download a version from by hand */
      page: feed.releasePage(source(), st.state === 'setup' && st.available ? st.available : ''),
      checked: s.updateChecked || 0,
      previous: prev ? prev.version : '',
      /** the version on the card is one this PC went back from (offered only when asked) */
      left: !!st.available && skipList().includes(st.available),
    };
  }
  function set(patch) {
    st = { ...st, ...patch };
    send('update:state', snapshot());
  }

  /** worker processes that never ended (a connection that hangs - not even a kill gets through) */
  const stuck = new Set();
  /** run update-worker.cjs; resolves with its last message (or a timeout) */
  function runWorker(args, { timeout, onMessage } = {}) {
    return new Promise((resolve) => {
      let proc;
      try {
        proc = utilityProcess.fork(path.join(__dirname, 'update-worker.cjs'), args, { serviceName: 'Goldline Takeoff updates', stdio: 'ignore' });
      } catch (e) { resolve({ ok: false, reach: 'unreachable', err: String(e.message || e) }); return; }
      worker = proc;
      let result = null, done = false, exited = false, t = null;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (worker === proc) worker = null;
        if (!exited) {
          try { proc.kill(); } catch (_) { /* gone */ }
          stuck.add(proc); // until its exit comes (if ever)
        }
        resolve(r);
      };
      const arm = () => { clearTimeout(t); t = setTimeout(() => finish({ ok: false, reach: 'unreachable', err: 'timeout' }), timeout); };
      arm();
      proc.on('message', (m) => {
        if (onMessage && m && m.progress !== undefined) { arm(); onMessage(m); return; }
        result = m;
        if (m && (m.ok !== undefined || m.done)) finish(m);
      });
      proc.on('exit', () => { exited = true; stuck.delete(proc); finish(result || { ok: false, reach: 'unreachable', err: 'stopped' }); });
    });
  }

  /** versions this PC went back from (or that failed to start here): not offered again by themselves */
  function skipList() {
    const s = readSettings();
    const gone = Array.isArray(s.skipUpdates) ? s.skipUpdates.map(String) : [];
    let aside = [];
    try { aside = fs.readdirSync(store).filter((n) => V.VERSION_NAME.test(n) && fs.existsSync(path.join(store, n, 'bad.json'))); } catch (_) { /* none */ }
    return [...new Set([...gone, ...aside])];
  }
  function clearSkips() {
    const s = readSettings();
    if (s.skipUpdates) { delete s.skipUpdates; writeSettings(s); }
  }

  function validate(j) {
    if (!j || typeof j !== 'object' || typeof j.version !== 'string' || !V.VERSION_NAME.test(j.version)) return 'latest.json has no valid version';
    if (j.product !== PRODUCT) return `the update feed holds another program's latest.json (${String(j.product).slice(0, 40)})`;
    const okPkg = (p) => p && typeof p.file === 'string' && /^[0-9a-f]{64}$/i.test(String(p.sha256 || '')) && Number(p.size) > 0;
    if (!okPkg(j.app) && !okPkg(j.setup)) return 'latest.json lists no complete package';
    return '';
  }
  const notesOf = (n) => (Array.isArray(n) ? n : typeof n === 'string' ? n.split(/\r?\n/) : []).map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 12);

  /** one number per look: an answer that comes after a newer look or a download is old */
  let lookGen = 0;
  let checking = false;
  let fetching = false;
  let askedMeanwhile = false;
  async function check(manual) {
    const src = source();
    if (checking && manual && !fetching && !['downloading', 'installing'].includes(st.state)) { askedMeanwhile = true; set({ state: 'checking', err: '' }); return snapshot(); }
    if (checking || fetching || ['downloading', 'installing'].includes(st.state)) return snapshot();
    if (stuck.size) {
      // the last look never ended (a connection that doesn't answer): not again while it hangs
      log('update check: skipped - an earlier one is still waiting for an answer');
      if (manual) set({ state: 'unreachable', err: 'stuck', show: false });
      return snapshot();
    }
    checking = true;
    try { return await look(manual, src); } finally { checking = false; }
  }

  async function look(manual, src) {
    const before = st;
    const my = ++lookGen;
    // (a check by itself in the background changes nothing on screen until it has a result)
    if (manual) set({ state: 'checking', err: '' });
    askedMeanwhile = false;
    let asked = st;
    const r = await runWorker(['check', src], { timeout: CHECK_TIMEOUT });
    if (askedMeanwhile) { manual = true; askedMeanwhile = false; asked = st; }
    if (my !== lookGen || fetching || ['downloading', 'installing'].includes(st.state)) return snapshot();
    try { writeSettings({ ...readSettings(), updateChecked: Date.now() }); } catch (_) { /* */ }
    const keep = () => before.state === 'ready' || (!manual && ['available', 'setup'].includes(before.state));
    if (!r.ok) {
      log('update check: ' + (r.reach || '') + ' ' + (r.err || ''));
      // a downloaded version, or an offer on the card, stays when GitHub can't be reached right now
      if (keep()) { if (st === asked) set({ ...before }); return snapshot(); }
      set({ state: r.reach === 'empty' ? 'empty' : r.reach === 'bad' ? 'error' : 'unreachable', err: r.err || '', show: false });
      return snapshot();
    }
    // only what the publisher signed: a latest.json changed anywhere on the way is refused
    const sig = verifyLatest(r.latest);
    if (!sig.latest) {
      log('update refused: ' + sig.err);
      if (keep()) { if (st === asked) set({ ...before }); return snapshot(); }
      set({ state: 'error', err: sig.err + ' - not installed.', show: !!manual });
      return snapshot();
    }
    const j = sig.latest;
    const bad = validate(j);
    if (bad) { log('update check: ' + bad); set({ state: 'error', err: bad, show: !!manual }); return snapshot(); }
    if (!V.newer(j.version, version)) { latest = null; set({ state: 'none', err: '', available: '', note: '', show: false }); return snapshot(); }
    // a new runtime (Electron) comes only with the whole setup; otherwise just the app part
    const full = !!(j.runtime && j.runtime !== runtime) || !j.app;
    const p = full ? null : j.app;
    latest = {
      version: j.version,
      notes: notesOf(j.notes),
      kind: full ? 'full' : 'app',
      pkg: p ? { file: path.basename(String(p.file)), sha256: String(p.sha256 || '').toLowerCase(), size: Number(p.size) || 0 } : null,
    };
    const skipped = skipList().includes(latest.version);
    const show = !!manual || (laterFor !== latest.version && !skipped);
    const base = { available: latest.version, notes: latest.notes, kind: latest.kind, size: latest.pkg ? latest.pkg.size : 0, err: '', note: '' };
    if (full) {
      if (skipped && !manual) { set({ state: 'none', err: '', available: '', show: false }); return snapshot(); }
      set({ ...base, state: 'setup', show });
      return snapshot();
    }
    if (!latest.pkg || !/^[0-9a-f]{64}$/.test(latest.pkg.sha256)) { set({ state: 'error', err: 'latest.json lists no package for this update', show: !!manual }); return snapshot(); }
    // already here (downloaded earlier)?
    if (list().some((c) => !c.builtin && c.version === latest.version)) {
      if (skipped && !manual) { set({ state: 'none', err: '', available: '', show: false }); return snapshot(); }
      set({ ...base, state: 'ready', show });
      return snapshot();
    }
    // went back from it / set aside here before: not shown by itself; offered only when asked for
    if (skipped && !manual) { set({ state: 'none', err: '', available: '', show: false }); return snapshot(); }
    const aside = fs.existsSync(path.join(store, latest.version, 'bad.json'));
    set({ ...base, state: 'available', note: skipped ? `${latest.version} did not work on this PC before. Update tries it once more.` : '', show: show || aside });
    return snapshot();
  }

  let cancelled = false;
  async function download() {
    // (taken at once, before anything is awaited: two presses must not start two copies into one file)
    if (fetching || !latest || latest.kind !== 'app' || !latest.pkg || ['downloading', 'installing'].includes(st.state)) return snapshot();
    fetching = true;
    lookGen++; // (a check running now is answered for the card before this)
    try {
      return await fetchUpdate();
    } catch (e) {
      log('update download: ' + (e && e.stack || e));
      set({ state: 'error', err: 'The update did not work (' + (e.code || e.message || e) + '). Nothing was changed.', show: true });
      return snapshot();
    } finally { fetching = false; }
  }
  async function fetchUpdate() {
    const v = latest.version, p = latest.pkg;
    // (the release of this very version: one published meanwhile can't hand over another file)
    const src = feed.fileUrl(source(), v, p.file);
    const dl = path.join(store, 'downloads');
    const dst = path.join(dl, 'app-v' + v + '.zip');
    const part = dst + '.part';
    try { await fsp.mkdir(dl, { recursive: true }); await fsp.rm(part, { force: true }); } catch (e) { set({ state: 'error', err: 'Could not write to ' + dl + ': ' + (e.code || e.message), show: true }); return snapshot(); }
    cancelled = false;
    set({ state: 'downloading', pct: 0, err: '', show: true });
    const r = await runWorker(['copy', src, part, String(p.size)], {
      timeout: STALL_TIMEOUT,
      onMessage: (m) => set({ pct: p.size ? Math.min(1, m.progress / p.size) : 0 }),
    });
    if (!r.done) {
      await fsp.rm(part, { force: true }).catch(() => {});
      if (cancelled) { cancelled = false; set({ state: 'available', pct: 0, err: '', show: false }); return snapshot(); }
      log('update download failed: ' + (r.err || ''));
      const why = { timeout: 'The download stopped (no answer for a minute).', ENOENT: "The update file isn't in the release (any more).", 'bigger than announced': 'The download is not the file that was published (bigger than announced). Nothing was changed.', ENOSPC: "This PC's disk is full." }[r.err];
      set({ state: 'error', err: why || 'Could not download the update (' + (r.err || 'unknown') + '). Nothing was changed.', show: true });
      return snapshot();
    }
    if (String(r.sha).toLowerCase() !== p.sha256 || (p.size && Number(r.bytes) !== p.size)) {
      await fsp.rm(part, { force: true }).catch(() => {});
      log('update download: checksum mismatch');
      set({ state: 'error', err: 'The downloaded update is damaged (checksum mismatch). Nothing was changed.', show: true });
      return snapshot();
    }
    try {
      await fsp.rm(dst, { force: true }).catch(() => {});
      // (Windows: the antivirus may still hold the fresh file for a moment)
      for (let k = 0; ; k++) {
        try { await fsp.rename(part, dst); break; } catch (e) {
          if (k >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
          await new Promise((res) => setTimeout(res, 250 * (k + 1)));
        }
      }
    } catch (e) {
      await fsp.rm(part, { force: true }).catch(() => {});
      log('update download: could not put it in place: ' + (e.code || e.message));
      set({ state: 'error', err: 'Could not put the update in place (' + (e.code || e.message) + ').', show: true });
      return snapshot();
    }
    set({ state: 'installing', pct: 1 });
    // (a copy set aside before is replaced by this fresh one; the worker checks the SHA-256 again)
    const u = await runWorker(['install', dst, store, v, runtime, p.sha256], { timeout: INSTALL_TIMEOUT });
    await fsp.rm(dst, { force: true }).catch(() => {});
    if (!u.ok) {
      log('update unpack failed: ' + (u.err || ''));
      set({ state: 'error', err: 'Could not unpack the update: ' + (u.err || 'unknown') + '. Nothing was changed.', show: true });
      return snapshot();
    }
    try { writeSettings({ ...readSettings(), updateNotes: { version: v, notes: latest.notes } }); } catch (_) { /* */ }
    log('update: ' + v + ' ready in ' + u.dir);
    // (Update pressed is a new choice: a "go back" made before no longer keeps the old version)
    if (V.pinned(store)) V.pin(store, '');
    set({ state: 'ready', err: '', note: '', show: true });
    return snapshot();
  }

  function cancel() {
    if (worker && st.state === 'downloading') cancelled = true;
    if (worker) { try { worker.kill(); } catch (_) { /* gone */ } }
    return snapshot();
  }
  function later() {
    if (latest) laterFor = latest.version;
    set({ show: false });
  }

  /** "Restart now": the next start runs the newest copy (a "go back" choice is undone) */
  function restartForUpdate() {
    if (st.state !== 'ready') return false;
    if (V.pinned(store)) V.pin(store, '');
    clearSkips();
    return true;
  }
  /** go back to the copy before this one (from the next start), and don't offer this version by itself again */
  function goBack() {
    const prev = previous();
    if (!prev) return '';
    V.pin(store, prev.version);
    const s = readSettings();
    s.skipUpdates = [...new Set([...(Array.isArray(s.skipUpdates) ? s.skipUpdates.map(String) : []), version])].slice(-10);
    writeSettings(s);
    return prev.version;
  }
  /** the newest version on this PC again */
  function useNewest() {
    V.pin(store, '');
    clearSkips();
    return true;
  }

  /** once the first screen showed: remember the version; old copies cleared (never the one running) */
  function afterStart() {
    const s = readSettings();
    if (s.lastRunVersion !== version) { try { writeSettings({ ...readSettings(), lastRunVersion: version }); } catch (_) { /* */ } }
    setTimeout(() => { try { V.tidy(store, version); } catch (e) { log('update tidy: ' + e); } }, 5000);
  }

  /** checks by themselves: the installed app (and tests with their own feed) - a development run only when asked */
  function start() {
    if (dev && !process.env.GT_UPDATE_FEED) return;
    setTimeout(() => void check(false).catch((e) => log('update check: ' + e)), FIRST);
    timer = setInterval(() => void check(false).catch((e) => log('update check: ' + e)), EVERY);
    try { powerMonitor.on('resume', () => setTimeout(() => void check(false).catch(() => {}), 60000)); } catch (_) { /* n/a */ }
  }
  function stop() { clearInterval(timer); cancel(); }

  return { snapshot, check, download, cancel, later, restartForUpdate, goBack, useNewest, previous, afterStart, start, stop, store };
}

module.exports = { create, PRODUCT };
