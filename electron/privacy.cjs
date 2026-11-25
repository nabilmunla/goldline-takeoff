// What the app's main process wires for the two things that can leave the PC (outbound.cjs): the
// anonymous user count (counter.cjs) and the problem report sent to the developer (reports.cjs).
// Both need a receiver named in package.json ("countEndpoint", "reportEndpoint"); empty = nothing is
// sent, there is no pop-up and no switch. Both requests are made from the update worker's process.
'use strict';
const path = require('path');

const JOB_TIMEOUT = Number(process.env.GT_REPORT_TIMEOUT) || 20000;
const COUNT_TIMEOUT = 15000;

/** one job in the update worker's process, with a time limit (no internet: it just ends) */
function runJob(utilityProcess, name, args, timeout) {
  return new Promise((resolve) => {
    let proc;
    try { proc = utilityProcess.fork(path.join(__dirname, 'update-worker.cjs'), args, { serviceName: name, stdio: 'ignore' }); } catch (e) { resolve({ ok: false, err: String((e && e.message) || e) }); return; }
    let result = null, fin = false;
    const finish = (r) => { if (fin) return; fin = true; clearTimeout(t); try { proc.kill(); } catch (_) { /* gone */ } resolve(r); };
    const t = setTimeout(() => finish({ ok: false, err: 'timeout' }), timeout);
    proc.on('message', (m) => { result = m; if (m && m.ok !== undefined) finish(m); });
    proc.on('exit', () => finish(result || { ok: false, err: 'stopped' }));
  });
}

/** { app, ipcMain, utilityProcess } from electron; the rest is main.cjs's */
function wire({ app, ipcMain, utilityProcess, version, appName, readSettings, writeSettings, log, logTail }) {
  const outbound = require('./outbound.cjs');
  const pkg = require('../package.json');

  const reports = require('./reports.cjs').create({
    version, appName, readSettings, logTail,
    endpoint: outbound.endpoint('report', pkg, app.isPackaged),
    dir: () => app.getPath('userData'),
    run: (args) => runJob(utilityProcess, appName + ' report', args, JOB_TIMEOUT),
  });
  ipcMain.handle('report:available', () => reports.available());
  ipcMain.handle('report:preview', (_e, text, ctx) => reports.preview(String(text || ''), ctx));
  ipcMain.handle('report:send', (_e, shown) => reports.send(shown));

  const counter = require('./counter.cjs').create({
    endpoint: outbound.endpoint('count', pkg, app.isPackaged), version, readSettings, writeSettings, log,
    run: (args) => runJob(utilityProcess, appName + ' count', args, COUNT_TIMEOUT),
  });
  const tick = () => void counter.tick().catch((e) => log('user count: ' + e));
  ipcMain.handle('count:get', () => counter.state());
  ipcMain.handle('count:set', (_e, on) => { const st = counter.set(!!on); if (st.on) setTimeout(tick, 3000).unref?.(); return st; });
  app.whenReady().then(() => {
    counter.init();
    // (no receiver set: no timers at all; the timers never keep the process alive on their own)
    if (!outbound.endpoint('count', pkg, app.isPackaged)) return;
    setTimeout(tick, Number(process.env.GT_COUNT_FIRST) || 60000).unref?.();
    setInterval(tick, 3600 * 1000).unref?.();
  });
  return { reports, counter };
}

module.exports = { wire, runJob };
