// Updates: the parts that touch the network (GitHub's releases - feed.cjs) or unpack a download run
// here, in a process of their own that only lives for the one job. A connection that hangs (no
// internet, a proxy that doesn't answer) can only stall this process - the app stops it after a
// time limit and carries on. (Rev Radar's update worker.)
//   check <web address>                              -> { ok, latest } | { ok: false, reach, err }
//   copy <url> <dst> <size>                          -> { progress } ..., { done, sha } | { ok: false, err }
//   install <zip> <store> <version> <runtime> <sha>  -> { ok, dir } | { ok: false, err }
//   post <endpoint> <file>                           -> { ok } | { ok: false, err }: the problem report the
//                                     person pressed Send on (reports.cjs; the file holds exactly what the preview showed)
//   count <endpoint> <id> <version> <os>             -> { ok } | { ok: false, err }: the once-a-day user
//                                     count's ping (counter.cjs; its shape: outbound.cjs countRequest)
// Nothing here decides what is trusted: the app checks latest.json's signature and the package's
// SHA-256 (updater.cjs) before it asks for the install.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const V = require('./versions.cjs');
const feed = require('./feed.cjs');

const port = process.parentPort;
const send = (m) => { try { port.postMessage(m); } catch (_) { /* parent gone */ } };
const [cmd, a, b, c, d, e] = process.argv.slice(2);
const done = (code) => setTimeout(() => process.exit(code), 50);

// Electron's own network stack where this process has it (the PC's proxy settings), else Node's
function get(url) {
  let f = null;
  try { const { net } = require('electron'); if (net && typeof net.fetch === 'function') f = (u) => net.fetch(u, { redirect: 'follow', cache: 'no-store' }); } catch (_) { /* not here */ }
  if (!f) f = (u) => fetch(u, { redirect: 'follow', cache: 'no-store', headers: { 'User-Agent': 'Goldline Takeoff updates' } });
  return f(url);
}
async function checkWeb(src) {
  let res;
  try { res = await get(feed.latestUrl(src)); } catch (err) { return send({ ok: false, reach: 'unreachable', err: String((err && (err.code || err.message)) || err) }); }
  // (no release yet - or none with a latest.json)
  if (res.status === 404) return send({ ok: false, reach: 'empty', err: 'HTTP 404' });
  if (!res.ok) return send({ ok: false, reach: 'unreachable', err: 'HTTP ' + res.status });
  try {
    const txt = await res.text();
    if (txt.length > 1 << 20) throw new Error('too long');
    send({ ok: true, latest: JSON.parse(txt.replace(/^﻿/, '')) });
  } catch (err) {
    send({ ok: false, reach: 'bad', err: 'latest.json is not valid: ' + (err.message || err) });
  }
}
async function copyWeb(url, dst, size) {
  const total = Number(size) || 0;
  let n = 0, last = 0;
  const hash = crypto.createHash('sha256');
  const fail = (err) => { send({ ok: false, err }); done(1); };
  let res;
  try { res = await get(url); } catch (err) { return fail(String((err && (err.code || err.message)) || err)); }
  if (res.status === 404) return fail('ENOENT');
  if (!res.ok || !res.body) return fail('HTTP ' + res.status);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const w = fs.createWriteStream(dst);
  let failed = false;
  w.on('error', (err) => { failed = true; fail(err.code || String(err.message || err)); });
  try {
    const rd = res.body.getReader();
    for (;;) {
      const { done: end, value } = await rd.read();
      if (end || failed) break;
      const chunk = Buffer.from(value);
      n += chunk.length;
      // (more than latest.json said: not the file it signed - stopped)
      if (total && n > total) { try { rd.cancel(); } catch (_) { /* */ } w.destroy(); return fail('bigger than announced'); }
      hash.update(chunk);
      if (!w.write(chunk)) await new Promise((r) => w.once('drain', r));
      const now = Date.now();
      if (now - last > 200) { last = now; send({ progress: n, total }); }
    }
  } catch (err) { w.destroy(); return fail(String((err && (err.code || err.message)) || err)); }
  if (failed) return;
  w.end(() => {
    send({ progress: n, total });
    send({ done: true, bytes: n, sha: hash.digest('hex') });
    done(0);
  });
}

// ---------------------------------------------------------------- what the person agreed to send (outbound.cjs)
async function post(endpoint, file) {
  const out = require('./outbound.cjs');
  let body;
  try { body = fs.readFileSync(file, 'utf8'); } catch (err) { return send({ ok: false, err: err.code || String(err.message || err) }); }
  const req = out.reportRequest(endpoint, body);
  try {
    const res = await out.fetcher()(req.url, req.init);
    send(res.ok ? { ok: true, status: res.status } : { ok: false, err: 'HTTP ' + res.status });
  } catch (err) { send({ ok: false, err: String((err && (err.code || err.message)) || err) }); }
}
async function count(endpoint, id, version, osName) {
  const out = require('./outbound.cjs');
  const req = out.countRequest(endpoint, { id, version, os: osName });
  try {
    const res = await out.fetcher()(req.url, req.init);
    send(res.ok ? { ok: true, status: res.status } : { ok: false, err: 'HTTP ' + res.status });
  } catch (err) { send({ ok: false, err: String((err && (err.code || err.message)) || err) }); }
}

function install(zip, store, version, runtime, sha) {
  try {
    // (checked again here, on the very file unpacked: nothing may have changed it since the download)
    V.checkPackage(zip, sha);
    const dir = V.installPackage(zip, store, version, runtime, sha);
    send({ ok: true, dir });
  } catch (err) {
    send({ ok: false, err: String(err.message || err) });
  }
}

if (cmd === 'check' && feed.isWeb(a)) checkWeb(a).finally(() => done(0));
else if (cmd === 'copy' && feed.isWeb(a)) copyWeb(a, b, c);
else if (cmd === 'post') post(a, b).finally(() => done(0));
else if (cmd === 'count') count(a, b, c, d).finally(() => done(0));
else if (cmd === 'install') { install(a, b, c, d, e); done(0); }
else { send({ ok: false, err: 'unknown command' }); done(2); }
