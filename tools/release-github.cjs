// The files of one GitHub release, from a build (`npm run build` first):
//   node tools/release-github.cjs <out folder> [--notes "line\nline" | --notes-file <file>]
//        [--key <key.pem>] [--setup <setup.exe>] [--source <source.zip>]
// <out folder> gets:
//   app-v<version>.zip   the app files (package.json, dist\..., electron\*.cjs) - what installed copies
//                        download into %LOCALAPPDATA%\Goldline Takeoff\app\<version>
//   latest.json          what they read first: version, runtime, notes, the zip's size + SHA-256 (and
//                        the setup's / source's if given), signed with the publisher's key
//   the setup and source zip, if given (made by the release tooling of the installer)
// The key is checked FIRST (it must be the one whose public half is in electron/updsig.cjs: else the
// PCs would refuse the release), and at the end latest.json is read back the way the app reads it:
// signature, sizes and SHA-256 of the files beside it, and the zip unpacked as the app unpacks it.
// Publishing: tools/README.md.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { zipSync } = require('fflate');
const { loadKey, signFile, keyPath } = require('./sign-latest.cjs');
const { verifyLatest } = require('../electron/updsig.cjs');
const V = require('../electron/versions.cjs');

const ROOT = path.join(__dirname, '..');
const PRODUCT = 'Goldline Takeoff';
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const meta = (f) => ({ file: path.basename(f), size: fs.statSync(f).size, sha256: sha(f) });

function fail(msg) { console.error(msg); process.exit(1); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf('--' + name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); if (v === undefined) fail('--' + name + ' needs a value'); return v; };
const notesText = opt('notes');
const notesFile = opt('notes-file');
const keyArg = opt('key');
const setup = opt('setup');
const source = opt('source');
const out = args[0];
if (!out || args.length > 1) fail('usage: node tools/release-github.cjs <out folder> [--notes "..." | --notes-file f] [--key key.pem] [--setup setup.exe] [--source source.zip]');

// 1. the key, before anything is made
let pem;
try { pem = loadKey(keyPath(keyArg)); } catch (e) { fail(e.message); }

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
if (!V.VERSION_NAME.test(version)) fail(`"${version}" is not a version number like 0.23.0.`);
if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) fail('No build: run `npm run build` first.');
const runtime = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
for (const f of [setup, source]) if (f && !fs.existsSync(f)) fail('Not found: ' + f);
if (setup && !/\.exe$/i.test(setup)) fail('--setup must be the setup .exe');
if (source && !/\.zip$/i.test(source)) fail('--source must be a .zip');
const notes = (notesFile ? fs.readFileSync(notesFile, 'utf8') : notesText || '').split(/\r?\n|\\n/).map((x) => x.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean);

// 2. the app files: exactly what tools/make-payload.cjs puts in the bridge payload (same checks)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-release-'));
try {
  execFileSync(process.execPath, [path.join(__dirname, 'make-payload.cjs'), tmp], { stdio: ['ignore', 'ignore', 'inherit'] });
  const payload = path.join(tmp, 'payload-' + version);
  const files = {};
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (V.appFile(r)) files[r] = [new Uint8Array(fs.readFileSync(path.join(dir, e.name))), { mtime: new Date('2026-01-01T00:00:00Z') }];
      else fail('not part of an app package: ' + r);
    }
  };
  walk(payload, '');
  for (const f of ['package.json', 'electron/start.cjs', 'electron/starter.cjs', 'electron/main.cjs', 'electron/preload.cjs', 'dist/index.html']) if (!files[f]) fail('The build is incomplete: no ' + f);
  const appPkg = JSON.parse(Buffer.from(files['package.json'][0]).toString('utf8'));
  if (appPkg.version !== version || appPkg.main !== 'electron/start.cjs' || appPkg.runtime !== runtime) fail('The payload\'s package.json is not this build\'s: ' + JSON.stringify(appPkg));

  fs.mkdirSync(out, { recursive: true });
  const zip = path.join(out, `app-v${version}.zip`);
  fs.writeFileSync(zip, zipSync(files, { level: 6 }));
  for (const f of [setup, source]) if (f && path.resolve(path.dirname(f)) !== path.resolve(out)) fs.copyFileSync(f, path.join(out, path.basename(f)));

  // 3. latest.json, signed (written under another name and signed there: latest.json is never in the folder unsigned)
  const latest = {
    product: PRODUCT,
    version,
    runtime,
    published: new Date().toISOString().slice(0, 10),
    notes,
    app: meta(zip),
    ...(setup ? { setup: meta(path.join(out, path.basename(setup))) } : {}),
    ...(source ? { source: meta(path.join(out, path.basename(source))) } : {}),
  };
  const unsigned = path.join(out, 'latest.json.unsigned');
  fs.writeFileSync(unsigned, JSON.stringify(latest, null, 2));
  try { signFile(unsigned, pem); } catch (e) { fs.rmSync(unsigned, { force: true }); fail(e.message); }
  fs.renameSync(unsigned, path.join(out, 'latest.json'));

  // 4. read back as the app reads it: signature, every file's size + SHA-256, the zip unpacked
  const back = verifyLatest(JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8')));
  if (!back.latest) fail('latest.json does not verify: ' + back.err);
  for (const k of ['app', 'setup', 'source']) {
    const p = back.latest[k];
    if (!p) continue;
    const m = meta(path.join(out, p.file));
    if (m.size !== p.size || m.sha256 !== p.sha256) fail(`${p.file} is not the file latest.json signed`);
  }
  const store = path.join(tmp, 'store');
  V.installPackage(zip, store, version, runtime, back.latest.app.sha256);
  if (!V.candidates(path.join(tmp, 'none'), store, runtime).some((c) => c.version === version)) fail('The app zip does not unpack into a copy the app would run.');
  console.log(`Goldline Takeoff ${version} (runtime ${runtime}): ${Object.keys(files).length} files`);
  for (const k of ['app', 'setup', 'source']) if (back.latest[k]) console.log(`  ${back.latest[k].file}  ${back.latest[k].size} bytes  sha256 ${back.latest[k].sha256}`);
  console.log('  latest.json  signed and checked with the key in the app');
  console.log(`Publish: a GitHub release tagged v${version} with every file in ${out} (latest.json last) - tools/README.md`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
