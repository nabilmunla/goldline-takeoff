// Bridge between the interface and the PC: file access + a few app services.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const nodefs = require('./nodefs.cjs');
const path = require('path');

// PDF engines (background processes, v0.12.5): their message ports go to the page as they arrive
ipcRenderer.on('pdf:port', (e, info) => { window.postMessage({ type: 'gt-pdf-port', ...info }, '*', e.ports); });
ipcRenderer.on('pdf:gaveUp', (_e, info) => { window.postMessage({ type: 'gt-pdf-gaveup', ...info }, '*'); });
const fetchProgress = new Map();
let fetchSeq = 0;
ipcRenderer.on('pdf:progress', (_e, id, done, total) => { const f = fetchProgress.get(id); if (f) { try { f(done, total); } catch (_) { /* the page's own error */ } } });
/** errors from the app process without Electron's "Error invoking remote method ..." in front */
const plain = (e) => { throw new Error(String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); };

contextBridge.exposeInMainWorld('gt', {
  fs: {
    join: (...p) => nodefs.join(...p),
    mkdirp: (p) => nodefs.mkdirp(p),
    mkdirExcl: (p) => nodefs.mkdirExcl(p),
    list: (d) => nodefs.list(d),
    readText: (p) => nodefs.readText(p),
    readFrom: async (p, o, m) => {
      const r = await nodefs.readFrom(p, o, m);
      return r && { size: r.size, data: new Uint8Array(r.data) };
    },
    append: (p, t) => nodefs.append(p, t),
    writeAtomic: (p, t) => nodefs.writeAtomic(p, t),
    remove: (p) => nodefs.remove(p),
    exists: (p) => nodefs.exists(p),
  },
  files: {
    stat: (p) => nodefs.stat(p),
    readBytes: async (p) => {
      const b = await nodefs.readBytes(p);
      return b && new Uint8Array(b);
    },
    writeBytes: (p, data, under) => nodefs.writeBytes(p, Buffer.from(data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data), under ? String(under) : undefined),
    listPdfs: (dir) => nodefs.listPdfs(dir),
    copy: (src, dst) => nodefs.copy(String(src), String(dst)),
    rmdir: (p) => nodefs.rmdir(String(p)),
    /** a file shipped inside the app (e.g. the PDF engine) */
    appFile: async (rel) => {
      const dist = path.join(__dirname, '..', 'dist');
      const p = path.resolve(dist, String(rel));
      if (p !== dist && !p.startsWith(dist + path.sep)) return null; // only inside the app's own files
      const b = await nodefs.readBytes(p);
      return b && new Uint8Array(b);
    },
  },
  pdf: {
    start: (names, token) => ipcRenderer.invoke('pdf:start', Array.isArray(names) ? names.map(String) : [], token == null ? '' : String(token)),
    restart: (name) => ipcRenderer.invoke('pdf:restart', String(name)),
    stop: (names) => ipcRenderer.invoke('pdf:stop', Array.isArray(names) ? names.map(String) : []),
    fetch: (src, cache, mode, onProgress, onStart) => {
      const id = ++fetchSeq + '-' + Date.now();
      if (typeof onProgress === 'function') fetchProgress.set(id, onProgress);
      if (typeof onStart === 'function') { try { onStart(id); } catch (_) { /* the page's own error */ } }
      return ipcRenderer.invoke('pdf:fetch', id, String(src), String(cache), String(mode)).catch(plain).finally(() => fetchProgress.delete(id));
    },
    heavy: (src, outBase, mode, pages, bg) => ipcRenderer.invoke('pdf:heavy', src && { path: String(src.path) }, String(outBase), String(mode), Array.isArray(pages) ? pages.map(Number) : [], !!bg).catch(plain),
    drop: (p) => ipcRenderer.invoke('pdf:drop', String(p)),
    cancel: (id) => ipcRenderer.invoke('pdf:cancel', String(id)),
    setAside: (p) => ipcRenderer.invoke('pdf:setAside', String(p)),
    touch: (p) => ipcRenderer.invoke('pdf:touch', String(p)),
  },
  info: () => ipcRenderer.invoke('app:info'),
  pickPdfs: (opts) => ipcRenderer.invoke('dialog:pickPdfs', opts),
  pickDir: (opts) => ipcRenderer.invoke('dialog:pickDir', opts),
  saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  drives: () => ipcRenderer.invoke('app:drives'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickFolder: (start) => ipcRenderer.invoke('dialog:pickFolder', start),
  pickFiles: (opts) => ipcRenderer.invoke('dialog:pickFiles', opts),
  setTheme: (mode) => ipcRenderer.invoke('win:theme', mode),
  onClosing: (cb) => ipcRenderer.on('app:closing', () => cb()),
  closed: () => ipcRenderer.send('app:closed'),
  closeHold: () => ipcRenderer.send('app:close-hold'),
  closeCancelled: () => ipcRenderer.send('app:close-cancelled'),
  closeResume: () => ipcRenderer.send('app:close-resume'),
  healthy: () => ipcRenderer.send('app:healthy'),
  restart: () => ipcRenderer.send('app:restart'),
  log: (line) => ipcRenderer.send('log', String(line)),
  win: { content: () => ipcRenderer.invoke('win:content') },
  // updates from GitHub (electron/updater.cjs): the window only asks; what is fetched, checked and
  // where it goes is decided in the main process
  update: {
    get: () => ipcRenderer.invoke('update:get'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    cancel: () => ipcRenderer.invoke('update:cancel'),
    later: () => ipcRenderer.invoke('update:later'),
    restart: () => ipcRenderer.invoke('update:restart'),
    openPage: () => ipcRenderer.invoke('update:openPage'),
    onState: (cb) => {
      const h = (_e, s) => { try { cb(s); } catch (_) { /* the page's own error */ } };
      ipcRenderer.on('update:state', h);
      return () => ipcRenderer.removeListener('update:state', h);
    },
  },
  report: () => ipcRenderer.invoke('app:report'),
  // the anonymous user count and the report sent to the developer (electron/privacy.cjs): nothing is
  // sent unless the build names a receiver; the report is posted only as the preview showed it
  count: { get: () => ipcRenderer.invoke('count:get'), set: (on) => ipcRenderer.invoke('count:set', !!on) },
  webReport: {
    available: () => ipcRenderer.invoke('report:available'),
    preview: (text, ctx) => ipcRenderer.invoke('report:preview', String(text || ''), ctx && typeof ctx === 'object' ? ctx : {}),
    send: (shown) => ipcRenderer.invoke('report:send', String(shown || '')),
  },
  clipboard: (text) => { ipcRenderer.send('clipboard:write', String(text)); return true; },
});
