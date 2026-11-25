// Sign a GitHub release's latest.json with the publisher's key (electron/updsig.cjs):
//   node tools/sign-latest.cjs <latest.json> [key.pem]
//   node tools/sign-latest.cjs --check [key.pem]    only: the key is there and is the one the app trusts
// The key: [key.pem], else GT_SIGNING_KEY, else keys\goldline-takeoff-update-signing.pem NEXT TO the
// source folder (never inside it, never in a release). tools/release-github.cjs runs this for you.
'use strict';
const fs = require('fs');
const path = require('path');
const { signLatest, verifyLatest } = require('../electron/updsig.cjs');

const ROOT = path.join(__dirname, '..');
const DEFAULT_KEY = path.resolve(ROOT, '..', 'keys', 'goldline-takeoff-update-signing.pem');
const keyPath = (arg) => arg || process.env.GT_SIGNING_KEY || DEFAULT_KEY;

/** the key's text, or throws: missing, or not the key whose public half is in the app */
function loadKey(file) {
  if (!fs.existsSync(file)) throw new Error('No signing key at ' + file + ' - updates must be signed (see tools/README.md).');
  const pem = fs.readFileSync(file, 'utf8');
  let back;
  try { back = verifyLatest(signLatest({ version: '0.0.0-check' }, pem)); } catch (e) { back = { err: String((e && e.message) || e) }; }
  if (!back.latest) throw new Error('The signing key at ' + file + " isn't the one the app trusts (" + back.err + ').');
  return pem;
}

/** sign latest.json in place (any old signature dropped); checked with the app's own key before it is written */
function signFile(file, pem) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const out = signLatest(j, pem);
  const back = verifyLatest(out);
  if (!back.latest) throw new Error('signature check failed: ' + back.err);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return back.latest;
}

module.exports = { loadKey, signFile, keyPath, DEFAULT_KEY };

if (require.main === module) {
  const check = process.argv[2] === '--check';
  const [file, keyArg] = check ? ['', process.argv[3]] : process.argv.slice(2);
  try {
    const pem = loadKey(keyPath(keyArg));
    if (check) { console.log('signing key: OK'); process.exit(0); }
    if (!file) { console.error('usage: node tools/sign-latest.cjs <latest.json> [key.pem] | --check [key.pem]'); process.exit(2); }
    signFile(file, pem);
    console.log('signed', file);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
