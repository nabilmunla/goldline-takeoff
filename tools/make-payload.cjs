// Make the app's files ready to ship, after `npm run build`:
//   node tools/make-payload.cjs <out folder>
// <out folder>\payload-<version>\           the app itself
// <out folder>\resources-app-<version>.zip   a whole resources\app folder for a NEW install (unzip it into
//                                            Goldline Takeoff\resources\app): starter + current.json + versions\<v>
'use strict';
const fs = require('fs');
const path = require('path');
const { zipSync } = require('fflate');

/** a file an app release may hold: package.json, dist\..., electron\*.cjs (anything else is refused) */
function safeRel(p) {
  if (typeof p !== 'string' || !p || path.isAbsolute(p) || p.includes('\0') || /^[a-zA-Z]:/.test(p)) return null;
  const norm = p.replace(/\\/g, '/');
  if (norm.split('/').some((s) => s === '..' || s === '' || s === '.')) return null;
  if (!(norm === 'package.json' || /^dist\/[\w./@ -]+$/.test(norm) || /^electron\/[\w.-]+\.cjs$/.test(norm))) return null;
  return norm;
}

const root = path.join(__dirname, '..');
/**
 * the app's own package.json (the same in the payload, the GitHub app zip and a store copy): main is
 * Goldline Takeoff's starter (a copy installed by its setup starts there; on a PC set up before, the
 * old resources\app\boot.cjs loads versions\<v>\electron\main.cjs and never reads it); updateFeed is
 * where every copy looks for new versions (electron/feed.cjs); reportEndpoint / countEndpoint are the
 * developer's receiver (electron/outbound.cjs; empty = nothing is ever sent) - the one place to switch them on
 */
function appPackage(src, runtime) {
  return { name: 'goldline-takeoff', productName: 'Goldline Takeoff', version: src.version, description: src.description || 'Goldline Takeoff', main: 'electron/start.cjs', runtime, updateFeed: src.updateFeed, reportEndpoint: src.reportEndpoint || '', countEndpoint: src.countEndpoint || '', private: true };
}
if (require.main !== module) { module.exports = { appPackage }; return; }
const out = process.argv[2];
if (!out) { console.error('usage: node tools/make-payload.cjs <out folder>'); process.exit(2); }
const src = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = src.version;
const payload = path.join(out, 'payload-' + version);
fs.rmSync(payload, { recursive: true, force: true });

const files = {};
const add = (rel, buf) => { files[rel] = buf; const p = path.join(payload, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); };
const walk = (dir, rel) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
    else if (safeRel(r)) add(r, fs.readFileSync(path.join(dir, e.name)));
    else { console.error('not part of a release (rename or remove it): ' + r); process.exit(1); }
  }
};
walk(path.join(root, 'dist'), 'dist');
for (const f of fs.readdirSync(path.join(root, 'electron'))) if (f.endsWith('.cjs')) add('electron/' + f, fs.readFileSync(path.join(root, 'electron', f)));
// runtime: the Electron version this app is built for (the release says so; a PC on another one gets
// the setup instead of an app update)
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
add('package.json', Buffer.from(JSON.stringify(appPackage(src, runtime), null, 2)));

// a whole resources\app for a new install
const tree = {};
for (const [rel, buf] of Object.entries(files)) tree['versions/' + version + '/' + rel] = new Uint8Array(buf);
tree['boot.cjs'] = new Uint8Array(files['electron/boot.cjs']);
tree['package.json'] = Buffer.from(JSON.stringify({ name: 'goldline-takeoff', productName: 'Goldline Takeoff', version, description: 'Goldline Takeoff - quantity take-off from drawings', main: 'boot.cjs', private: true }, null, 1));
tree['current.json'] = Buffer.from(JSON.stringify({ version, previous: null, bad: [], at: Date.now() }, null, 1));
const zip = path.join(out, 'resources-app-' + version + '.zip');
fs.writeFileSync(zip, zipSync(tree, { level: 9 }));
console.log(`payload ${version}: ${Object.keys(files).length} files in ${payload}\nnew install: ${zip}`);
