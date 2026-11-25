// Goldline Takeoff - Electron main process.
// Command line options (used by the test launchers):
//   --profile=<name>   separate local data on this PC (run two copies side by side)
//   --as=<name>        display name to use for this copy
//   --data=<folder>    shared data folder to use
//   --dev              developer tools (F12) allowed; otherwise they are off for everyone
//
// defaults.json next to Goldline Takeoff.exe (set once by whoever installs the app):
//   { "dataRoot": "S:\\Projects\\Takeoff" }   the shared folder offered on first start
//
// Where things are: the app the setup installed in resources\app (started by electron/start.cjs), or
// on a PC set up before Goldline Takeoff in resources\app\versions\<version>\ (started by the old
// resources\app\boot.cjs); newer versions the app downloaded itself in
// %LOCALAPPDATA%\Goldline Takeoff\app\<version> (starter.cjs, updater.cjs); this PC's data (settings,
// the queue of changes not yet on the share, logs, drawing copies) in
// %LOCALAPPDATA%\Goldline Takeoff\data\profile-<name> - never in a roaming profile, which may itself be on a server
// (what an earlier version kept in another folder is copied there once: datafolder.cjs).
'use strict';
// Started by the OLD starter (a PC set up before Goldline Takeoff: it loads this file directly):
// a newer copy the person downloaded runs instead of this one (starter.cjs) - before anything here
// takes the single-instance lock or sets anything up. (Started through start.cjs: done already.)
if (!global.__gtBoot && require('./starter.cjs').start({ builtinDir: require('path').join(__dirname, '..'), fromMain: true }) !== 'self') return;
// file reads and writes run on a small pool of threads (4) in each process; a drawing server that
// stops answering mid-read holds a thread until Windows gives up. With more threads (the window
// inherits this) the project's own saving never waits behind stuck drawing reads.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '24';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const VERSION = require('../package.json').version;
const legacy = require('./legacy.cjs');
/** how this copy was started (starter.cjs): built in, or downloaded into the person's store */
const BOOT = global.__gtBoot;
/** this version's folder, and (a PC set up before Goldline Takeoff) the app folder above versions\<v> */
const APP_DIR = path.join(__dirname, '..');
const BASE_DIR = legacy.baseOf(APP_DIR);

function arg(name) {
  const p = process.argv.find((a) => a.startsWith('--' + name + '='));
  return p ? p.slice(name.length + 3).replace(/^"|"$/g, '') : null;
}

const profile = (arg('profile') || 'default').replace(/[^\w-]/g, '');
// developer tools only with --dev (no environment variable switches them on). The packaged exe also
// has Electron's "fuses" set so it can't be run as plain Node or opened to a debugger (--inspect);
// none of this is a lock against someone who can already change the shared folder with Explorer:
// that is what the folder permissions are for.
const DEV = process.argv.includes('--dev');

/**
 * defaults.json next to the exe (portable app), or in the app folder. Written by hand, so read
 * forgivingly: a byte-order mark, or single backslashes in a Windows path ("S:\Tenders").
 */
const defaultsProblems = [];
function readDefaults() {
  // (a downloaded copy runs from the person's store: the installed app's folders are looked in too)
  const installed = [BOOT.builtinDir, BOOT.legacy && BOOT.legacy.base].filter(Boolean);
  for (const dir of [...new Set([path.dirname(process.execPath), BASE_DIR, APP_DIR, ...installed])]) {
    const file = path.join(dir, 'defaults.json');
    let text;
    try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch (_) { continue; }
    for (const t of [text, text.replace(/\\(?![\\"\/bfnrtu])/g, '\\\\')]) {
      try {
        const j = JSON.parse(t);
        if (j && typeof j === 'object') return j;
      } catch (_) { /* try the repaired text */ }
    }
    defaultsProblems.push(file + ': not readable (check it is plain JSON like {"dataRoot": "X:\\\\Folder"})');
  }
  return {};
}

// this PC's data under Local AppData (Windows), not the roaming profile - in a folder of its own
// (...\Goldline Takeoff\data), apart from the store of downloaded copies (...\Goldline Takeoff\app).
// What an earlier version of the app kept elsewhere comes along (copied, never moved: datafolder.cjs).
const LOCAL_ROOT = process.platform === 'win32' && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA : app.getPath('appData');
const userData = path.join(LOCAL_ROOT, 'Goldline Takeoff', 'data', 'profile-' + profile);
const dataMigration = require('./datafolder.cjs').migrateDataFolder({ newDir: userData, localRoot: LOCAL_ROOT, roamingRoot: app.getPath('appData'), profile });
app.setPath('userData', userData);

// one window per PC user. A start that follows a failed one (the starter or this file started again
// with --boot-skip) waits a moment for that process to be gone.
let gotLock = app.requestSingleInstanceLock();
if (!gotLock && process.argv.some((a) => a.startsWith('--boot-skip=') || a.startsWith('--boot-tried='))) {
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 20 && !gotLock; i++) { Atomics.wait(nap, 0, 0, 250); gotLock = app.requestSingleInstanceLock(); }
}
if (!gotLock) {
  try { BOOT.notAStart(); } catch (_) { /* */ }
  app.quit();
  return;
}

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
// The settings as last read or written whole in this run. A settings file that can't be read for a
// moment (antivirus holding it, the profile on a server that is away) or that is damaged must never
// turn into "a brand-new PC": the next write would then wipe the shared folder and everything else.
let lastGoodSettings = null;
/**
 * The last save failed: settings.json still holds the settings from before it. Until a save works this
 * run goes on with what it was told - read from the file instead, a shared folder just chosen went back
 * to the old one at once.
 */
let unsaved = false;
/** said once, on the first screen: the settings file was damaged (what was done about it) */
let settingsNote = null;
let settingsBadSeen = false;
const asSettings = (text) => {
  const j = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not a settings object');
  return j;
};
/** the copy kept next to it at every good write (settings.json.bak), if it reads */
function backupSettings() {
  try { return asSettings(fs.readFileSync(settingsPath() + '.bak', 'utf8')); } catch (_) { return null; }
}
/** settings.json could not be used: kept aside once (with a line in the log), the last good settings go on */
function damagedSettings(why, text) {
  const good = lastGoodSettings || backupSettings();
  if (!settingsBadSeen) {
    settingsBadSeen = true;
    let kept = '';
    if (text !== null) {
      kept = 'settings.json.bad-' + new Date().toISOString().replace(/[:.]/g, '-');
      try { fs.writeFileSync(path.join(path.dirname(settingsPath()), kept), text); } catch (_) { kept = ''; }
    }
    log('settings.json ' + why + (kept ? '; kept as ' + kept : '') + (good ? '; the last good settings are used' : '; nothing to fall back on: the settings start again'));
    settingsNote = 'This PC’s settings file could not be read' + (kept ? ' (it is kept as ' + kept + ' in the app’s data folder)' : '') + '. '
      + (good ? 'The last good copy of the settings is used.' : 'The settings start again: choose the shared folder again if it is asked for.');
  }
  return { ...(good || {}) };
}
function readSettings() {
  if (unsaved && lastGoodSettings) return { ...lastGoodSettings };
  let text;
  try {
    text = fs.readFileSync(settingsPath(), 'utf8');
  } catch (e) {
    // no file at all: a new PC (or settings never saved) - unless this run had them a moment ago
    if (e && e.code === 'ENOENT') return { ...(lastGoodSettings || {}) };
    return damagedSettings('could not be read (' + (e && e.code ? e.code : e && e.message) + ')', null);
  }
  try {
    lastGoodSettings = asSettings(text);
    return { ...lastGoodSettings };
  } catch (e) {
    return damagedSettings('is damaged (' + (e && e.message) + ')', text);
  }
}
/**
 * Never throws: false when the file could not be written (disk full, the profile on a server that is
 * away, antivirus holding it). A failed write must not skip what follows it - in the window's close
 * handler that is the last flush of the open project (BH-003) - and this run goes on with the new
 * settings in memory.
 */
function writeSettings(s) {
  lastGoodSettings = { ...s };
  try {
    // write then rename: a crash half way never leaves a broken settings file (and a lost shared folder)
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    const tmp = settingsPath() + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    try { fs.renameSync(tmp, settingsPath()); } catch (_) { fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2)); try { fs.unlinkSync(tmp); } catch (__) { /* leave it */ } }
    // a copy of the last good one, for the day settings.json is found damaged
    try { fs.copyFileSync(settingsPath(), settingsPath() + '.bak'); } catch (_) { /* the main file is written */ }
    unsaved = false;
    return true;
  } catch (e) {
    unsaved = true;
    log('settings could not be saved: ' + (e && e.message ? e.message : e));
    return false;
  }
}

// app.log is the one log of the app. Past LOG_MAX it starts again (the one before kept as
// app.old.log), checked every LOG_CHECK lines - a stat per line would cost more than the line.
const LOG_MAX = 10 * 1024 * 1024;
const LOG_CHECK = 200;
let logLines = 0;
function log(line) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'app.log');
    if (logLines++ % LOG_CHECK === 0) {
      try { if (fs.statSync(file).size > LOG_MAX) fs.renameSync(file, path.join(dir, 'app.old.log')); } catch (_) { /* no log yet */ }
    }
    fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\n');
  } catch (_) { /* never let logging break the app */ }
}
/** the last `bytes` of a file as text (the first, cut line left out); null when there is no file */
function tailOf(file, bytes) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    const t = buf.toString('utf8');
    return n < size ? t.slice(t.indexOf('\n') + 1) : t;
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* closed */ } }
  }
}
process.on('uncaughtException', (e) => log('main uncaught: ' + (e && e.stack ? e.stack : e)));
process.on('unhandledRejection', (e) => log('main unhandled rejection: ' + (e && e.stack ? e.stack : e)));

let win = null;
let allowClose = false;
let crashes = [];
let recovered = null;
let relaunchAfterClose = false;
let closing = false;
let closeTimer = null;
// the starter could not start a newer version and started this one (boot.cjs)
const bootTried = (() => { const a = arg('boot-tried'); try { return a ? decodeURIComponent(a).split('\n').join(', ') : process.env.GT_BOOT_TRIED || legacy.oldBootTried(); } catch (_) { return process.env.GT_BOOT_TRIED || legacy.oldBootTried(); } })();
let bootNote = bootTried ? 'the newest version could not start (' + bootTried.split(':')[0] + '); this is ' + VERSION : null;
if (bootNote) log('boot fallback: ' + bootTried);
if (dataMigration.note) log('data folder: ' + dataMigration.note + (dataMigration.from ? ' (from ' + dataMigration.from + ')' : ''));
/** this version's start failed after it loaded: note it (the starter passes it over) and start again */
let restarting = false;
function failedStart(why) {
  log('start failed: ' + why);
  if (restarting) return;
  restarting = true;
  // a downloaded copy is set aside (the next start runs the one before); on a PC set up before
  // Goldline Takeoff the old starter is told this version failed (it starts the version before)
  let how = '';
  try { how = BOOT.failed(String(why).split('\n')[0]); } catch (_) { /* */ }
  if (how && process.env.GT_NO_RELAUNCH !== '1') {
    try { app.releaseSingleInstanceLock(); } catch (_) { /* not taken */ }
    if (how === 'legacy') {
      const args = process.argv.slice(1).filter((a) => !a.startsWith('--boot-skip='));
      const skip = (arg('boot-skip') || '').split(',').filter(Boolean);
      app.relaunch({ args: [...args, '--boot-skip=' + [...skip, BOOT.legacy.version].join(',')] });
    } else app.relaunch();
  }
  app.exit(1);
}
// the first screen showed (the window says so): a good version. If it never does, the person is
// offered the version before (or a newer one) - a window that stays blank must not be the end of it.
let healthy = false;
let watchdog = null;

const TITLEBAR = {
  light: { color: '#09302f', symbolColor: '#ffffff', height: 44 },
  dark: { color: '#051a19', symbolColor: '#e8eeec', height: 44 },
};

/** the drawing's own window while it is open (v0.16.2) */
// v0.16.4 sheet tabs in their own windows (one per sheet tab, as many as wanted)
/** the sheet windows open, with the sheet each was opened for (where it was is kept per sheet) */
const sheetChildren = new Map();
/** frame name -> open maximised (decided where the window's place is decided) */
const sheetMax = new Map();
const onScreen = (b) => {
  const { screen } = require('electron');
  return screen.getAllDisplays().some((d) => b.x + 80 > d.workArea.x && b.x + 80 < d.workArea.x + d.workArea.width && b.y + 20 > d.workArea.y && b.y + 20 < d.workArea.y + d.workArea.height);
};
const goodBox = (b) => !!b && b.width > 300 && b.height > 200 && typeof b.x === 'number' && typeof b.y === 'number';
/** where a sheet's window opens: where the tab was dropped, else where that sheet's window was, else the size of
 *  the last one moved along a little (a window per screen is moved there once and stays) */
function sheetBounds(sheet, features) {
  const s = readSettings();
  const last = goodBox(s.sheetWin) ? s.sheetWin : null;
  const size = { width: last?.width ?? 1200, height: last?.height ?? 860 };
  const f = Object.fromEntries(String(features || '').split(',').map((x) => x.split('=').map((y) => y.trim())).filter((x) => x.length === 2));
  const at = { x: Number(f.left), y: Number(f.top) };
  if (Number.isFinite(at.x) && Number.isFinite(at.y)) {
    // (the drop point: the window's tab strip under the pointer)
    const b = { x: Math.round(at.x - 120), y: Math.round(at.y - 16), ...size };
    if (onScreen(b)) return { b, max: false };
  }
  const mine = s.sheetWins && typeof s.sheetWins === 'object' ? s.sheetWins[sheet] : null;
  if (goodBox(mine) && onScreen(mine)) return { b: { x: mine.x, y: mine.y, width: mine.width, height: mine.height }, max: !!mine.maximized };
  if (last && onScreen(last)) {
    const n = sheetChildren.size;
    const b = { x: last.x + 28 * n, y: last.y + 28 * n, ...size };
    return { b: onScreen(b) ? b : { x: last.x, y: last.y, ...size }, max: false };
  }
  return { b: null, max: false };
}
function keepSheetBounds(child, sheet) {
  try {
    if (child.isDestroyed()) return;
    const s = readSettings();
    const max = child.isMaximized();
    // (maximised: the size it comes back to - the main window does the same, BH-037)
    const b = max && typeof child.getNormalBounds === 'function' ? child.getNormalBounds() : child.getBounds();
    const wins = { ...(s.sheetWins && typeof s.sheetWins === 'object' ? s.sheetWins : {}) };
    delete wins[sheet];
    wins[sheet] = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: max };
    // (the 40 sheets moved last)
    const keys = Object.keys(wins);
    for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete wins[k];
    writeSettings({ ...s, sheetWins: wins, sheetWin: max ? s.sheetWin : { x: b.x, y: b.y, width: b.width, height: b.height } });
  } catch (_) { /* best effort */ }
}
/** every sheet window's place kept (the app quits, the page reloads: they are destroyed, which says nothing) */
const keepAllSheetBounds = () => { for (const [c, sheet] of sheetChildren) keepSheetBounds(c, sheet); };
const closeSheetWindows = () => { keepAllSheetBounds(); for (const c of [...sheetChildren.keys()]) if (!c.isDestroyed()) c.destroy(); sheetChildren.clear(); };

function createWindow() {
  const s = readSettings();
  win = new BrowserWindow({
    width: s.width || 1440,
    height: s.height || 900,
    minWidth: 980,
    minHeight: 600,
    show: false,
    title: 'Goldline Takeoff',
    backgroundColor: '#09302f',
    icon: path.join(__dirname, '..', 'dist', 'icon256.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLEBAR.light,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  if (s.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // never navigate away or open external pages inside the app
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    // v0.16.4 a sheet tab in its own window: an empty page the app fills itself (the same app and project,
    // nothing loaded in it); a normal window - moved, resized, snapped like any other
    if (typeof frameName === 'string' && frameName.startsWith('gt-sheet-') && (url === 'about:blank' || url === '')) {
      const sheet = frameName.slice(frameName.indexOf('|') + 1);
      const { b, max } = sheetBounds(sheet, features);
      sheetMax.set(frameName, max);
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...(b ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: 1200, height: 860 }),
          minWidth: 640, minHeight: 420, show: true, title: 'Goldline Takeoff - sheet', autoHideMenuBar: true,
          backgroundColor: '#09302f', icon: path.join(__dirname, '..', 'dist', 'icon256.png'),
        },
      };
    }
    return { action: 'deny' };
  });
  // (the page loads again - a reload after a crash, a restart: the sheets' windows belonged to the page before)
  win.webContents.on('did-start-loading', closeSheetWindows);
  win.webContents.on('did-create-window', (child, d) => {
    if (typeof d.frameName !== 'string' || !d.frameName.startsWith('gt-sheet-')) { child.destroy(); return; }
    const sheet = d.frameName.slice(d.frameName.indexOf('|') + 1);
    sheetChildren.set(child, sheet);
    child.setMenu(null);
    if (sheetMax.get(d.frameName)) child.maximize();
    sheetMax.delete(d.frameName);
    child.webContents.on('will-navigate', (e) => e.preventDefault());
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (!DEV) child.webContents.on('devtools-opened', () => child.webContents.closeDevTools());
    // the main window minimised or behind them: the sheet windows still draw (same page, same timers)
    win?.webContents.setBackgroundThrottling(false);
    child.on('close', () => keepSheetBounds(child, sheet));
    child.on('closed', () => {
      sheetChildren.delete(child);
      if (!sheetChildren.size && win && !win.isDestroyed()) win.webContents.setBackgroundThrottling(true);
    });
  });
  // (the main window closes: the sheet windows' places kept, then they go with it - one listener, not one each)
  win.on('close', keepAllSheetBounds);
  win.on('closed', closeSheetWindows);
  // developer tools only for development: anyone could otherwise run code inside the app
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && DEV) win.webContents.toggleDevTools();
  });
  if (!DEV) win.webContents.on('devtools-opened', () => win.webContents.closeDevTools());
  // a crashed window comes back by itself (changes are safe in the outbox on this PC)
  win.webContents.on('render-process-gone', (_e, d) => {
    log('renderer gone: ' + JSON.stringify(d));
    // (v0.16.3 the drawing's own window was part of that page: it went with it - closed, not left blank)
    closeSheetWindows();
    windowGone('stopped');
    if (!d || d.reason === 'clean-exit') return;
    const t = Date.now();
    // out of memory (a huge drawing) or killed from outside says nothing about the version
    const versionFault = !['oom', 'killed'].includes(d.reason);
    if (versionFault) {
      crashes = crashes.filter((c) => t - c < 120000);
      crashes.push(t);
    }
    if (crashes.length > 3) {
      log('window crashed 4 times in 2 minutes');
      crashes = [];
      offerRollback('keeps stopping');
    }
    recovered = { at: t, reason: d.reason };
    setTimeout(() => { if (win && !win.isDestroyed() && !restarting) win.webContents.reload(); }, 400);
  });
  // a window loaded again (after a crash, an update) starts its own engines: the old ones and their
  // reads from the server go
  win.webContents.on('did-start-navigation', (e, url, inPlace, isMain) => {
    const d = e && typeof e === 'object' && 'isMainFrame' in e ? e : { isMainFrame: isMain, isSameDocument: inPlace };
    if (d.isMainFrame && !d.isSameDocument) windowGone('was loaded again');
  });
  win.webContents.on('did-finish-load', () => {
    // a window that came back (crashed while asking "Not sent yet") can be closed again
    if (closing && !allowClose) { closing = false; if (closeTimer) clearTimeout(closeTimer); closeTimer = null; }
    if (healthy || watchdog || BASE_DIR === APP_DIR) return;
    watchdog = setTimeout(() => { if (!healthy) offerRollback('did not start properly'); }, Number(process.env.GT_HEALTH_MS) || 90000);
  });
  win.webContents.on('unresponsive', () => log('window not responding'));
  win.webContents.on('responsive', () => log('window responding again'));

  win.on('close', (e) => {
    // (writeSettings never throws: a size that can't be saved must not skip the flush below)
    try {
      // the window's own size, also when it is closed maximized (getBounds is the screen's then, and the
      // window would come back as big as the screen when restored - BH-037)
      const b = win.getNormalBounds();
      writeSettings({ ...readSettings(), width: b.width, height: b.height, maximized: win.isMaximized() });
    } catch (err) { log('window size not saved: ' + (err && err.message ? err.message : err)); }
    if (allowClose) return;
    // let the open project flush its last changes first
    e.preventDefault();
    if (closing) return; // already on its way (a second click on X)
    closing = true;
    win.webContents.send('app:closing');
    closeTimer = setTimeout(forceClose, CLOSE_MS);
  });
  win.on('closed', () => { win = null; });
  // Windows is shutting down or signing out: send what can be sent now (the rest stays on this PC)
  win.on('session-end', () => { log('Windows session ending'); try { win.webContents.send('app:closing'); } catch (_) { /* gone */ } });
}

/** a folder there and answering within ms (a server that doesn't answer must not hold the window) */
function reachable(dir, ms) {
  return Promise.race([fs.promises.stat(dir).then((st) => st.isDirectory(), () => false), new Promise((r) => setTimeout(() => r(false), ms))]);
}
ipcMain.handle('app:info', async () => {
  const s = readSettings();
  let defaultData = arg('data') || s.dataRoot || null;
  if (!defaultData) {
    const d = readDefaults().dataRoot;
    for (const p of defaultsProblems.splice(0)) log('defaults.json ' + p);
    if (typeof d === 'string' && d.trim()) {
      // (the setup writes \\server\share\...: off the office network, the first start doesn't wait for it)
      if (await reachable(d.trim(), 4000)) defaultData = d.trim();
      else log('defaults.json: ' + d.trim() + ' not reachable now');
    }
  }
  const rec = recovered ?? (bootNote ? { at: Date.now(), reason: bootNote } : null);
  recovered = null;
  bootNote = null;
  // (said once: the first screen shows it)
  const sNote = settingsNote;
  settingsNote = null;
  return {
    version: VERSION,
    user: arg('as') || s.displayName || os.userInfo().username,
    winUser: os.userInfo().username,
    host: os.hostname(),
    profile,
    dataRoot: defaultData,
    localDir: app.getPath('userData'),
    platform: process.platform,
    theme: s.theme || 'system',
    lastUsername: s.lastUsername || null,
    accBackups: typeof s.accBackups === 'string' ? s.accBackups : null,
    accBackupsFor: typeof s.accBackupsFor === 'string' ? s.accBackupsFor : null,
    recovered: rec,
    settingsNote: sNote,
  };
});

// ---------- updates: from GitHub only, signed; no helper program (updater.cjs, starter.cjs) ----------
// (every window: a drawing's own window has the title bar's pill too)
const toWindow = (ch, v) => { for (const w of BrowserWindow.getAllWindows()) { try { if (!w.isDestroyed()) w.webContents.send(ch, v); } catch (_) { /* closing */ } } };
const updater = require('./updater.cjs').create({ version: VERSION, readSettings, writeSettings, log, send: toWindow });
ipcMain.handle('update:get', () => updater.snapshot());
ipcMain.handle('update:check', () => updater.check(true));
ipcMain.handle('update:download', () => updater.download());
ipcMain.handle('update:cancel', () => updater.cancel());
ipcMain.handle('update:later', () => { updater.later(); return true; });
/** "Restart now": the window closes the normal way (the open project sends its last changes), then the app starts again */
ipcMain.handle('update:restart', () => {
  if (!updater.restartForUpdate()) return false;
  log('update: restarting into ' + (updater.snapshot().available || 'the new version'));
  relaunchAfterClose = process.env.GT_NO_RELAUNCH !== '1';
  setTimeout(() => { if (win && !win.isDestroyed()) win.close(); }, 50);
  return true;
});
/** the release page (a version that needs the setup): in the browser - nothing is downloaded or started from here */
ipcMain.handle('update:openPage', () => {
  const u = updater.snapshot().page;
  // (tests' own feed is plain http on this PC: recorded by the test, never in the packaged app)
  if (u && (/^https:\/\//.test(u) || (!app.isPackaged && /^http:\/\/127\.0\.0\.1[:/]/.test(u)))) void shell.openExternal(u);
  return true;
});

ipcMain.on('app:healthy', () => {
  if (healthy) return;
  healthy = true;
  if (watchdog) clearTimeout(watchdog);
  // the first screen showed: this copy works (a downloaded one's start count is cleared; on a PC set
  // up before Goldline Takeoff the old starter's version is marked as starting properly)
  try { BOOT.started(); } catch (e) { log('boot: ' + e.message); }
  if (BOOT.legacy) log('started by the old starter (' + BOOT.legacy.version + ')' + (BOOT.builtin ? '' : ': handed over to ' + VERSION + ' from ' + BOOT.store));
  updater.afterStart();
});

// v0.16.4 the main window's drawing area on the screen (a sheet window's tab dragged back onto the tab strip)
ipcMain.handle('win:content', () => (win && !win.isDestroyed() ? win.getContentBounds() : null));

ipcMain.on('clipboard:write', (_e, text) => { try { clipboard.writeText(String(text)); } catch (e) { log('clipboard: ' + e.message); } });

// ---------- problem report: what is needed to look into a problem from another PC ----------
/** the end of the app's log: the last 400 lines */
function logTailText() {
  // read from the end of the file (never the whole log: it can be large, and this
  // runs in the app's main process - the window would stop answering while it is read); just after
  // the log started again, the end of the one before comes first
  const TAIL = 256 * 1024;
  const dir = path.join(app.getPath('userData'), 'logs');
  let t = tailOf(path.join(dir, 'app.log'), TAIL);
  if (t === null || (t.length < TAIL && t.split('\n').length < 400)) {
    const old = tailOf(path.join(dir, 'app.old.log'), TAIL - (t ? t.length : 0));
    if (old) t = old + (t || '');
  }
  return t === null ? '(no log yet)' : t.split(/\r?\n/).slice(-400).join('\n');
}
// (this one goes to the team's own shared folder, or the clipboard - never to the web: that is the
// anonymised report in reports.cjs. The count's random number is not part of it: it stays unlinked.)
ipcMain.handle('app:report', () => {
  const tail = logTailText();
  const m = process.memoryUsage();
  const { countId, countDay, ...settings } = readSettings();
  return {
    version: VERSION, electron: process.versions.electron, os: `${os.type()} ${os.release()} ${os.arch()}`,
    host: os.hostname(), winUser: os.userInfo().username, profile, appDir: APP_DIR, localDir: app.getPath('userData'),
    memoryMB: Math.round(m.rss / 1e6), uptimeMin: Math.round(process.uptime() / 60), settings, log: tail,
  };
});
// ---------- what may leave the PC (privacy.cjs): the anonymous user count and the problem report sent to the developer ----------
// (both need a receiver named in package.json - empty in this build: nothing is sent, no pop-up)
require('./privacy.cjs').wire({ app, ipcMain, utilityProcess: require('electron').utilityProcess, version: VERSION, appName: 'Goldline Takeoff', readSettings, writeSettings, log, logTail: logTailText });
ipcMain.handle('settings:set', (_e, patch) => writeSettings({ ...readSettings(), ...patch }));
ipcMain.handle('dialog:pickFolder', async (_e, start) => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the shared data folder', defaultPath: start || undefined, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:pickFiles', async (_e, opts) => {
  const s = readSettings();
  const r = await dialog.showOpenDialog(win, {
    title: (opts && opts.title) || 'Choose the BOQ files',
    defaultPath: s.lastImportDir || undefined,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Excel workbooks', extensions: ['xlsx', 'xlsm'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths.length) return [];
  writeSettings({ ...readSettings(), lastImportDir: path.dirname(r.filePaths[0]) });
  return r.filePaths;
});
ipcMain.handle('dialog:pickPdfs', async (_e, opts) => {
  const s = readSettings();
  const r = await dialog.showOpenDialog(win, {
    title: (opts && opts.title) || 'Choose drawings',
    defaultPath: s.lastPdfDir || undefined,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF drawings', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePaths.length) return [];
  writeSettings({ ...readSettings(), lastPdfDir: path.dirname(r.filePaths[0]) });
  return r.filePaths;
});
ipcMain.handle('dialog:pickDir', async (_e, opts) => {
  const s = readSettings();
  const r = await dialog.showOpenDialog(win, {
    title: (opts && opts.title) || 'Choose a folder',
    defaultPath: (opts && opts.start) || s.lastPdfDir || undefined,
    properties: opts && opts.create ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  if (opts && opts.remember) writeSettings({ ...readSettings(), lastPdfDir: r.filePaths[0] });
  return r.filePaths[0];
});
ipcMain.handle('dialog:saveFile', async (_e, opts) => {
  const s = readSettings();
  const r = await dialog.showSaveDialog(win, {
    title: (opts && opts.title) || 'Save',
    // (v0.16.2 dir: start in that folder, e.g. next to the consultant's file for its filled copy)
    defaultPath: path.join((opts && typeof opts.dir === 'string' && opts.dir) || s.lastSaveDir || app.getPath('documents'), (opts && opts.name) || 'export'),
    filters: (opts && opts.filters) || [],
  });
  if (r.canceled || !r.filePath) return null;
  writeSettings({ ...readSettings(), lastSaveDir: path.dirname(r.filePath) });
  return r.filePath;
});
// Opening a file with its own program: only documents and folders. A path comes from shared data
// (a drawing's path written by someone else): it must never start a program or a script.
const OPENABLE = /\.(pdf|xlsx|xlsm|xls|csv|txt|docx|doc|png|jpe?g|tiff?|dwg|dxf)$/i;
ipcMain.handle('shell:openPath', async (_e, p) => {
  if (typeof p !== 'string' || !p || p.includes('\0')) return 'not allowed';
  const full = path.resolve(p);
  let st = null;
  try { st = fs.statSync(full); } catch (_) { return 'not found'; }
  if (st.isDirectory()) return shell.openPath(full);
  if (!OPENABLE.test(full)) { log('refused to open ' + full); return 'This kind of file is not opened from Goldline Takeoff.'; }
  return shell.openPath(full);
});

// Mapped network drives (X: -> \\server\share), so a drawing can be found again from
// a PC where the same share sits on another letter.
let drives = {};
function readDrives() {
  if (process.platform !== 'win32') return;
  // Windows' own net.exe by its full path (a bare 'net' is looked for in the current folder first)
  const net = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'net.exe');
  require('child_process').execFile(net, ['use'], { windowsHide: true, timeout: 8000 }, (err, out) => {
    if (err || !out) return;
    const m = {};
    for (const line of String(out).split(/\r?\n/)) {
      const r = line.match(/\s([A-Za-z]):\s+(\\\\[^\s].*?)(?:\s{2,}|$)/);
      if (r) m[r[1].toUpperCase() + ':'] = r[2].trim();
    }
    drives = m;
  });
}
ipcMain.handle('app:drives', () => drives);

ipcMain.handle('win:theme', (_e, mode) => {
  if (win && process.platform !== 'darwin') {
    try { win.setTitleBarOverlay(mode === 'dark' ? TITLEBAR.dark : TITLEBAR.light); } catch (_) { /* not supported */ }
  }
  return true;
});
/**
 * A version that keeps crashing, or whose window never showed its first screen: offer the version
 * before (a copy in the person's store, the installed one, or on a PC set up before Goldline Takeoff
 * the version the old starter had before); without one, a newer release from GitHub; else say so.
 */
let offering = false;
async function offerRollback(what) {
  if (offering || restarting) return;
  offering = true;
  const restartNow = () => {
    relaunchAfterClose = process.env.GT_NO_RELAUNCH !== '1';
    allowClose = true;
    relaunchOnce();
    app.quit();
  };
  try {
    const parent = win && !win.isDestroyed() ? win : undefined;
    const fromStore = updater.previous();
    const prev = fromStore ? fromStore.version : legacy.previousOf(APP_DIR, VERSION);
    if (prev) {
      const choice = dialog.showMessageBoxSync(parent, {
        type: 'warning', buttons: ['Go back to ' + prev, 'Stay on ' + VERSION], defaultId: 0, cancelId: 1,
        title: 'Goldline Takeoff', message: 'This version of Goldline Takeoff (' + VERSION + ') ' + what + ' on this PC.',
        detail: 'Go back to version ' + prev + '? Your work is kept: changes not yet on the shared folder stay on this PC and are sent when a version that can write the project runs again.',
      });
      if (choice === 0) {
        const v = fromStore ? updater.goBack() : legacy.rollback(APP_DIR, VERSION);
        if (v) { log('going back to ' + v); restartNow(); return; }
        dialog.showMessageBoxSync(parent, { type: 'error', title: 'Goldline Takeoff', message: 'Could not go back to ' + prev + '.', detail: 'The app folder can only be changed by an administrator. Ask IT.' });
      }
      return;
    }
    // no version before: a newer one on GitHub may be the fix
    let s = updater.snapshot();
    if (!['available', 'ready'].includes(s.state)) s = await updater.check(true);
    if (s.state === 'available' || s.state === 'ready') {
      const choice = dialog.showMessageBoxSync(parent, {
        type: 'warning', buttons: ['Install ' + s.available, 'Not now'], defaultId: 0, cancelId: 1,
        title: 'Goldline Takeoff', message: 'This version of Goldline Takeoff (' + VERSION + ') ' + what + ' on this PC.',
        detail: 'Version ' + s.available + ' is out. Install it now? The app starts again.',
      });
      if (choice === 0) {
        if (s.state === 'available') s = await updater.download();
        if (s.state === 'ready' && updater.restartForUpdate()) { log(`updating ${VERSION} -> ${s.available} after: ${what}`); restartNow(); return; }
        dialog.showMessageBoxSync(parent, { type: 'error', title: 'Goldline Takeoff', message: 'The update could not be installed.', detail: s.err || '' });
      }
      return;
    }
    dialog.showMessageBoxSync(parent, {
      type: 'warning', title: 'Goldline Takeoff', message: 'Goldline Takeoff (' + VERSION + ') ' + what + ' on this PC.',
      detail: 'It will try again. If this goes on, restart the PC; if it still happens, send IT the problem report (it is kept in ' + path.join(app.getPath('userData'), 'logs') + ').',
    });
  } catch (e) {
    log('offer rollback: ' + e.message);
  } finally {
    offering = false;
  }
}

/** a close is never held longer than this once the window goes on with it (its changes are safe in the outbox) */
const CLOSE_MS = 6000;
function forceClose() {
  closeTimer = null;
  allowClose = true;
  relaunchOnce();
  if (win && !win.isDestroyed()) win.close();
}
function relaunchOnce() {
  if (!relaunchAfterClose) return;
  relaunchAfterClose = false;
  app.relaunch();
}
// the window asks first (changes not yet on the shared folder): no forced close meanwhile
ipcMain.on('app:close-hold', () => {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = null;
  // the question must be seen: a minimised window comes up
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});
// ...and the answer was "keep the app open"
ipcMain.on('app:close-cancelled', () => { if (closeTimer) clearTimeout(closeTimer); closeTimer = null; closing = false; relaunchAfterClose = false; });
// ...or the window goes on closing ("Close anyway", the changes left here sent): bounded again, as a close
// that asked nothing is - a share that stalls the last writes must not leave "Closing…" up for good (BH-036)
ipcMain.on('app:close-resume', () => {
  if (!closing || allowClose || closeTimer) return;
  closeTimer = setTimeout(forceClose, CLOSE_MS);
});
ipcMain.on('app:restart', () => {
  relaunchAfterClose = process.env.GT_NO_RELAUNCH !== '1';
  if (win && !win.isDestroyed()) win.close();
});
ipcMain.on('app:closed', () => {
  allowClose = true;
  relaunchOnce();
  if (win && !win.isDestroyed()) win.close();
});
ipcMain.on('log', (_e, line) => log('renderer: ' + line));

// ---------------------------------------------------------------- PDF engines (v0.12.5)
// Drawings are drawn by PDF engines that are background processes of their own (as in the PDF
// Editor): they read a drawing from disk on demand - nothing of it passes through the window - and
// a sheet that runs one out of memory takes down only that engine: it is started again, the window
// gets a new port and asks again. draw + geo for the sheet on screen, bg for the background
// preparation of every sheet.
const ENGINE_DIR = path.join(APP_DIR, 'dist', 'engine');
const ENGINE_KEEP = { draw: 2, geo: 1, bg: 1 };
const engines = new Map(); // name -> { proc, born, name }
const engineDeaths = new Map();
let enginesQuitting = false;
function spawnEngine(name, restarted, code, token) {
  const { utilityProcess } = require('electron');
  const proc = utilityProcess.fork(path.join(ENGINE_DIR, 'pdf-host.mjs'), [ENGINE_DIR, String(ENGINE_KEEP[name] || 1)], { serviceName: 'Goldline Takeoff drawing engine (' + name + ')', stdio: 'pipe' });
  const e = { proc, born: Date.now(), name, token: token || '' };
  engines.set(name, e);
  const out = (b) => String(b).split('\n').filter(Boolean).forEach((l) => log('[pdf ' + name + '] ' + l));
  proc.stdout?.on('data', out);
  proc.stderr?.on('data', out);
  proc.on('message', (m) => { if (m && m.type === 'failed') log('pdf engine ' + name + ' failed to start: ' + m.error); });
  proc.on('exit', (c) => {
    if (engines.get(name) !== e) return; // replaced on purpose
    log('pdf engine ' + name + ' exited ' + c);
    if (enginesQuitting || !win || win.isDestroyed()) { engines.delete(name); return; }
    // crash loop guard: an engine that keeps dying young (5 times in 2 minutes, each within 20 s of
    // starting: damaged files, antivirus, no memory left) is not started again - the window is told,
    // so calls fail with a message instead of waiting. (70: a sheet too heavy for it - it answered that
    // call with its error first; the window stops asking for that sheet after two. Not counted:
    // paging through heavy sheets must not switch the engine off.)
    const now = Date.now();
    const young = (engineDeaths.get(name) || []).filter((t) => now - t < 120000);
    if (now - e.born < 20000 && c !== 70 && c !== 75) young.push(now);
    engineDeaths.set(name, young);
    if (young.length >= 5) {
      engines.delete(name);
      engineDeaths.delete(name);
      log('pdf engine ' + name + ' keeps stopping (exit ' + c + '): not started again');
      try { win.webContents.send('pdf:gaveUp', { name, code: c, token: e.token }); } catch (_) { /* window gone */ }
      return;
    }
    const wait = now - e.born < 3000 ? 1500 : 0;
    setTimeout(() => { if (!enginesQuitting && win && !win.isDestroyed() && engines.get(name) === e) spawnEngine(name, true, c, e.token); }, wait);
  });
  connectEngine(name, restarted, code);
}
function connectEngine(name, restarted, code) {
  const e = engines.get(name);
  if (!e || !win || win.isDestroyed()) return;
  const { MessageChannelMain } = require('electron');
  const { port1, port2 } = new MessageChannelMain();
  e.proc.postMessage({ type: 'port' }, [port1]);
  // (the token: which start of the window's engines this one belongs to - a port from an engine of an
  // earlier start, still on its way, is not taken for the new one's)
  win.webContents.postMessage('pdf:port', { name, restarted: !!restarted, code: code ?? 0, token: e.token }, [port2]);
}
function stopEngine(name) {
  const e = engines.get(name);
  if (!e) return;
  engines.delete(name);
  try { e.proc.kill(); } catch (_) { /* gone */ }
}
/** (re)start the named engines: a window that started again had nothing open in the old ones */
ipcMain.handle('pdf:start', (_e, names, token) => {
  for (const n of Array.isArray(names) ? names : []) {
    if (!Object.prototype.hasOwnProperty.call(ENGINE_KEEP, n)) continue;
    stopEngine(n);
    engineDeaths.delete(n);
    spawnEngine(n, false, 0, typeof token === 'string' ? token.slice(0, 64) : '');
  }
  return true;
});
/** a fresh engine in place of one whose memory has grown large (WebAssembly memory never shrinks) */
ipcMain.handle('pdf:restart', (_e, name) => {
  const old = engines.get(name);
  if (!old) return false;
  stopEngine(name);
  spawnEngine(name, true, 75, old.token);
  return true;
});
/** engines not needed for now (the background one when every sheet is prepared) */
ipcMain.handle('pdf:stop', (_e, names) => {
  for (const n of Array.isArray(names) ? names : []) { stopEngine(String(n)); engineDeaths.delete(String(n)); }
  return true;
});
app.on('before-quit', () => { enginesQuitting = true; for (const n of [...engines.keys()]) stopEngine(n); });
/** the window went (crashed, reloaded): its engines and its reads from the server are not needed */
function windowGone(why) {
  for (const n of [...engines.keys()]) stopEngine(n);
  for (const f of [...fetchCancels.values()]) f.cancel('the window ' + why);
}

/** the drawing copies on this PC: only under this PC's data folder */
function inCache(dir) {
  const d = path.resolve(String(dir || ''));
  const root = path.join(path.resolve(app.getPath('userData')), 'qto-cache');
  const win32 = process.platform === 'win32';
  const a = win32 ? d.toLowerCase() : d, r = win32 ? root.toLowerCase() : root;
  return a === r || a.startsWith(r + path.sep) ? d : null;
}

/**
 * Read a drawing through once: its fingerprint (SHA-256) and, if asked, this PC's copy - in one
 * pass, never whole in memory (a 350 MB set from the server: once over the network, a few MB here).
 * mode 'keep': <cache>\pdf\<fingerprint>.pdf; 'temp': <cache>\tmp\... (the caller drops it after);
 * 'hash': no copy. A server that stops answering for a minute ends it with a message.
 */
const fetchCancels = new Map();
const tmpMade = new Set();
ipcMain.handle('pdf:fetch', (ev, id, src, cache, mode) => new Promise((resolve, reject) => {
  const crypto = require('crypto');
  const dir = inCache(cache);
  if (!dir) return reject(new Error('not a drawing cache folder'));
  // 'replace': as 'keep', but this PC's copy is put in place even when one of that size is there (it
  // was found damaged)
  const copy = mode === 'keep' || mode === 'temp' || mode === 'replace';
  const name = path.basename(String(src));
  let fd = null, out = null, part = null, rs = null, done = false, timer = null, last = 0;
  const finish = (err, val) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    fetchCancels.delete(id);
    // the stream closes the file itself (after a read still under way): closed here only without one
    // (closed twice, the number could already be another file's - v0.12.5 review)
    if (rs) { try { rs.destroy(); } catch (_) { /* */ } } else if (fd !== null) fs.close(fd, () => {});
    fd = null;
    const end = () => { if (err) { if (part) fs.rm(part, { force: true }, () => {}); reject(err); } else resolve(val); };
    if (out) { const o = out; out = null; o.end(end); } else end();
  };
  // a server that stops answering (no data for a minute) ends it with a message
  const stall = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error(`The server did not answer reading ${name} (60 s). Check the network, then open the sheet again.`)), 60000); };
  fetchCancels.set(id, { cancel: (why) => finish(new Error('Reading ' + name + ' was stopped (' + why + ').')) });
  stall();
  // (never synchronous: a network drive that has gone away would freeze the whole app. Only a plain
  // file: opening a pipe named .pdf would wait for a writer for ever - and keep the app from closing)
  const notFile = () => finish(new Error(name + ' is not a drawing file (it is a folder, a device or a pipe).'));
  fs.stat(String(src), (err0, st0) => {
    if (err0) return finish(err0);
    if (done) return;
    if (!st0.isFile()) return notFile();
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);
    fs.open(String(src), flags, (err, h) => {
      if (err) return finish(err);
      if (done) { fs.close(h, () => {}); return; }
      fd = h;
      fs.fstat(fd, (err2, st) => {
        if (err2) return finish(err2);
        if (done) return;
        if (!st.isFile()) return notFile();
        try {
          if (copy) {
            // (made once per cache folder - again if it was removed meanwhile)
            if (!tmpMade.has(dir)) { fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true }); tmpMade.add(dir); }
            part = path.join(dir, 'tmp', Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '.part');
            out = fs.createWriteStream(part);
            out.on('error', (e) => { if (e && e.code === 'ENOENT') tmpMade.delete(dir); finish(e && e.code === 'ENOSPC' ? new Error('This PC\'s disk is full: the drawing could not be copied to it.') : e); });
          }
        } catch (e) { return finish(e); }
        const hash = crypto.createHash('sha256');
        let got = 0;
        rs = fs.createReadStream(null, { fd, autoClose: false, highWaterMark: 1 << 20 });
        rs.on('data', (b) => {
          // a program named as a drawing (a path in shared data pointing at an .exe, or an exe renamed .pdf):
          // never copied onto this PC - a program written into AppData is what antivirus stops
          if (got === 0 && b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return finish(new Error(name + ' is a program, not a drawing: it is not read or copied.'));
          hash.update(b);
          got += b.length;
          stall();
          if (out && !out.write(b)) { rs.pause(); out.once('drain', () => rs.resume()); }
          const now = Date.now();
          if (now - last > 250) { last = now; try { ev.sender.send('pdf:progress', id, got, st.size); } catch (_) { /* window gone */ } }
        });
        rs.on('error', (e) => finish(e));
        rs.on('end', () => fs.fstat(fd, (err3, st2) => {
          if (done) return;
          // saved over while it was read (same file, new bytes): what was read is a mix of the two
          if (err3 || st2.size !== st.size || st2.mtimeMs !== st.mtimeMs || got !== st.size) return finish(Object.assign(new Error(name + ' changed while it was being read (saved again meanwhile). Open the sheet again.'), { code: 'ECHANGED' }));
          // (whole milliseconds: kept with the drawing in the take-off and compared next time)
          const meta = { hash: hash.digest('hex'), size: got, mtime: Math.round(st.mtimeMs) };
          if (!copy) return finish(null, { ...meta, file: '' });
          const o = out;
          out = null;
          o.end(async () => {
            if (done) return;
            // (never synchronous here: a disk busy with a 350 MB copy - antivirus scanning it - would
            // hold up the whole app's main process meanwhile)
            const fsp = fs.promises;
            try {
              if (mode === 'temp') { const f = part; part = null; return finish(null, { ...meta, file: f }); }
              await fsp.mkdir(path.join(dir, 'pdf'), { recursive: true });
              if (done) return;
              const final = path.join(dir, 'pdf', meta.hash + '.pdf');
              const have = await fsp.stat(final).catch(() => null);
              if (done) return;
              if (have && have.size === got && mode !== 'replace') { fs.rm(part, { force: true }, () => {}); part = null; return finish(null, { ...meta, file: final }); }
              const moved = await fsp.rename(part, final).then(() => true, () => false);
              if (!moved) {
                // (the old copy is held by an engine reading it: this one is used where it is)
                const f = part; part = null; return finish(null, { ...meta, file: f });
              }
              part = null;
              finish(null, { ...meta, file: final });
            } catch (e) { finish(e); }
          });
        }));
      });
    });
  });
}));
/** a read from the server given up on (nobody waits for it any more): stopped */
ipcMain.handle('pdf:cancel', (_e, id) => {
  const f = fetchCancels.get(String(id));
  if (!f) return false;
  f.cancel('given up on');
  return true;
});
/** this PC's copy of a drawing found damaged: set aside (kept a day - it may be the only one) */
ipcMain.handle('pdf:setAside', (_e, p) => {
  const f = path.resolve(String(p || ''));
  const dir = inCache(path.dirname(path.dirname(f)));
  if (!dir || path.basename(path.dirname(f)) !== 'pdf' || !/^[0-9a-f]{64}\.pdf$/.test(path.basename(f))) return false;
  return new Promise((resolve) => fs.rename(f, f + '.bad', (err) => resolve(!err)));
});
/** a file in this PC's drawing cache was used now (trimming goes by when each was used last) */
ipcMain.handle('pdf:touch', (_e, p) => {
  const f = path.resolve(String(p || ''));
  if (!inCache(path.dirname(path.dirname(f)))) return false;
  const now = new Date();
  return new Promise((resolve) => fs.utimes(f, now, now, (err) => resolve(!err)));
});
/** a temp copy made by pdf:fetch is not needed any more */
ipcMain.handle('pdf:drop', (_e, p) => {
  const f = path.resolve(String(p || ''));
  const dir = inCache(path.dirname(path.dirname(f)));
  if (!dir || path.basename(path.dirname(f)) !== 'tmp' || !f.endsWith('.part')) return false;
  fs.rm(f, { force: true }, () => {});
  return true;
});

/**
 * Monster sheets (engine/pdfhost/heavy.ts): a one-off background process looks at a big drawing and
 * simplifies pages of millions of separate little strokes - one job at a time (each can take a lot of
 * memory for a while), never longer than 10 minutes.
 */
const heavyQueue = [];
let heavyRun = null;
function heavyNext() {
  if (heavyRun || !heavyQueue.length) return;
  const i = heavyQueue.findIndex((j) => !j.bg);
  const job = heavyQueue.splice(i >= 0 ? i : 0, 1)[0];
  const { utilityProcess } = require('electron');
  const proc = utilityProcess.fork(path.join(ENGINE_DIR, 'heavy.mjs'), job.args, { serviceName: 'Goldline Takeoff drawing check', stdio: 'pipe' });
  const run = { job, proc, paused: false };
  heavyRun = run;
  const t0 = Date.now();
  let over = false;
  const end = (v) => {
    if (over) return;
    over = true;
    clearTimeout(limit);
    if (heavyRun === run) heavyRun = null;
    if (v) { heavyJobs.delete(job.key); job.resolve(v); } else heavyQueue.unshift(job); // stopped for the sheet on screen's: again after
    heavyNext();
  };
  const limit = setTimeout(() => { try { proc.kill(); } catch (_) { /* */ } end({ result: null, error: 'it took too long' }); }, 10 * 60000);
  const out = (b) => String(b).split('\n').filter(Boolean).forEach((l) => log('[pdf check] ' + l));
  proc.stdout?.on('data', out);
  proc.stderr?.on('data', out);
  proc.on('message', (m) => { if (m && m.type === 'done') { log(`pdf check ${path.basename(job.base).slice(0, 12)} (${job.mode}): ${m.error || JSON.stringify(m.result)} in ${Date.now() - t0} ms`); end({ result: m.result, error: m.error || '' }); } });
  proc.on('exit', (c) => end(run.paused ? null : { result: null, error: 'the check stopped (' + c + ')' + (c === 70 || c === null ? ' - not enough memory?' : '') }));
}
const heavyJobs = new Map();
ipcMain.handle('pdf:heavy', (_e, src, outBase, mode, pages, bg) => {
  const base = path.resolve(String(outBase || ''));
  if (!inCache(path.dirname(base)) || !src || typeof src.path !== 'string') return { result: null, error: 'bad request' };
  const m = mode === 'force' ? 'force' : 'check';
  const pg = Array.isArray(pages) ? pages.filter((n) => Number.isInteger(n) && n >= 0) : [];
  const key = [base, m, pg.join(',')].join('|');
  let job = heavyJobs.get(key);
  if (!job) {
    job = { key, base, mode: m, bg: !!bg, args: [JSON.stringify({ path: src.path }), base, m, JSON.stringify(pg)] };
    job.done = new Promise((r) => (job.resolve = r));
    heavyJobs.set(key, job);
    heavyQueue.push(job);
  } else if (!bg) job.bg = false; // the sheet on screen asks for it too: it goes first now
  // the sheet on screen's job does not wait for a background one: that one is stopped, done after
  if (!job.bg && heavyRun && heavyRun.job.bg && heavyRun.job !== job) { heavyRun.paused = true; try { heavyRun.proc.kill(); } catch (_) { /* */ } }
  heavyNext();
  return job.done;
});

app.on('second-instance', () => {
  // started again while this one is closing ("Close anyway", sending the last changes): it starts
  // again once the close is done, instead of the new start quitting and leaving nothing running
  if (closing || allowClose) {
    relaunchAfterClose = process.env.GT_NO_RELAUNCH !== '1';
    log('started again while closing: will start again after the close');
    // the closing window ("Closing…", or its question) comes up so the start isn't met with nothing
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    return;
  }
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

if (process.platform === 'win32') app.setAppUserModelId(BOOT.legacy ? legacy.OLD_AUMID : 'app.goldline.takeoff');

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  readDrives();
  try {
    createWindow();
  } catch (e) {
    // no window means nothing to see and no way to update: start again with the version before
    failedStart('the window could not be made: ' + (e && e.stack ? e.stack : e));
    return;
  }
  updater.start();
  // a PC set up before Goldline Takeoff: its shortcuts take the new name (once they have it, nothing to do)
  if (process.platform === 'win32' && BOOT.legacy) {
    const t = setTimeout(() => {
      try {
        const progs = (base) => base && path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
        const dirs = [app.getPath('desktop'), progs(app.getPath('appData')), process.env.PUBLIC && path.join(process.env.PUBLIC, 'Desktop'), progs(process.env.ProgramData)];
        const done = legacy.renameOldShortcuts(dirs, process.execPath, (p) => { try { return shell.readShortcutLink(p); } catch (_) { return null; } });
        if (done.length) log('shortcuts renamed: ' + done.join(', '));
      } catch (_) { /* never in the way */ }
    }, 8000);
    if (t.unref) t.unref();
  }
});
app.on('will-quit', () => updater.stop());
app.on('window-all-closed', () => app.quit());
