// What leaves the PC besides updates - the only two kinds of request Goldline Takeoff makes, both to
// the developer's own small receiver (a Cloudflare worker, told apart by x-report-client):
//   - a problem report, anonymised first (anon.cjs), only when the person presses Send - reports.cjs
//   - the once-a-day user count: a random number, the version, the OS - counter.cjs
// Where: package.json "reportEndpoint" / "countEndpoint" (the receiver's address; /report and /count
// are added). EMPTY = nothing is ever sent, no pop-up, no switch. Putting the address in those two
// fields is all it takes to switch both on. Both requests are made from the update worker's process
// (update-worker.cjs) with a time limit; no internet = nothing happens.
// (x-report-client: a web page can't send a custom header without asking first, so a site can't make
// its visitors' browsers post to the receiver - the receiver refuses requests without it)
'use strict';

const CLIENT = 'goldline-takeoff';
const at = (endpoint, route) => {
  const base = String(endpoint || '').trim().replace(/\/+$/, '');
  return base.endsWith('/' + route) ? base : base + '/' + route;
};

/** a report (already anonymised: a JSON text or an object) as it is posted */
function reportRequest(endpoint, body) {
  return { url: at(endpoint, 'report'), init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-report-client': CLIENT }, body: typeof body === 'string' ? body : JSON.stringify(body) } };
}

/** the OS as the receiver takes it: win | linux | mac */
const osKey = (os) => (/^win/i.test(String(os)) ? 'win' : /^(mac|darwin)/i.test(String(os)) ? 'mac' : 'linux');

/** the user count's ping: exactly three things - the random number, the version, the OS - in the shape
 *  the receiver takes: {"id":"<32 lowercase hex>","v":"d.d.d","os":"win|linux|mac"} */
function countRequest(endpoint, { id, version, os }) {
  const v = (/^\d+\.\d+\.\d+/.exec(String(version)) || ['0.0.0'])[0];
  return { url: at(endpoint, 'count'), init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-report-client': CLIENT }, body: JSON.stringify({ id: String(id).toLowerCase(), v, os: osKey(os) }) } };
}

/** Electron's network stack where this process has it (the PC's proxy settings), else Node's */
function fetcher() {
  try { const { net } = require('electron'); if (net && typeof net.fetch === 'function') return (u, i) => net.fetch(u, i); } catch (_) { /* not here */ }
  return (u, i) => fetch(u, i);
}

/** the receiver's address from package.json (tests: GT_REPORT_ENDPOINT / GT_COUNT_ENDPOINT - never in the packaged app) */
function endpoint(kind, pkg, packaged = false) {
  const env = packaged ? undefined : kind === 'count' ? process.env.GT_COUNT_ENDPOINT : process.env.GT_REPORT_ENDPOINT;
  const v = env !== undefined ? env : pkg && pkg[kind === 'count' ? 'countEndpoint' : 'reportEndpoint'];
  const s = String(v || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

module.exports = { reportRequest, countRequest, fetcher, endpoint, osKey, CLIENT };
