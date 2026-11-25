// Loads electron/main.cjs with a fake 'electron' module and hands back its ipcMain handlers, so the
// real pdf:fetch / pdf:drop / pdf:heavy code can be driven from a plain Node test (from the v0.12.5
// review, debug run 1).
//   const H = require('./harness/main.cjs')(userDataDir)
//   await H.invoke('pdf:fetch', id, src, cache, mode)
'use strict';
const Module = require('module');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

module.exports = function load(userData, opts = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const sent = [];
  const forks = [];
  const fakeWin = {
    isDestroyed: () => false,
    webContents: { send: (...a) => sent.push(a), postMessage: (...a) => sent.push(a) },
  };
  const app = {
    getPath: (k) => (k === 'userData' ? userData : path.join(userData, '..', k)),
    setPath: () => {},
    requestSingleInstanceLock: () => true,
    releaseSingleInstanceLock: () => {},
    whenReady: () => new Promise(() => {}),
    on: () => {},
    quit: () => {},
    exit: () => {},
    relaunch: () => {},
    isPackaged: false,
    getAppMetrics: () => [],
  };
  const electron = {
    app,
    BrowserWindow: function () { return fakeWin; },
    ipcMain: { handle: (n, f) => handlers.set(n, f), on: (n, f) => listeners.set(n, f) },
    dialog: {}, Menu: { setApplicationMenu() {} }, shell: {}, clipboard: {},
    utilityProcess: {
      fork: (file, args, o) => {
        const p = new EventEmitter();
        p.file = file; p.args = args; p.killed = false;
        p.postMessage = () => {};
        p.kill = () => { p.killed = true; setImmediate(() => p.emit('exit', null)); return true; };
        forks.push(p);
        if (opts.onFork) opts.onFork(p);
        return p;
      },
    },
    MessageChannelMain: function () { return { port1: {}, port2: {} }; },
  };
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') return electron;
    return origLoad.apply(this, arguments);
  };
  const mainPath = path.join(__dirname, '..', '..', 'electron', 'main.cjs');
  delete require.cache[mainPath];
  // (kept: the handlers require('electron') again when they run)
  require(mainPath);
  const ev = { sender: { send: (...a) => sent.push(a) } };
  return {
    handlers, listeners, sent, forks, fakeWin,
    invoke: (name, ...args) => Promise.resolve(handlers.get(name)(ev, ...args)),
  };
};
