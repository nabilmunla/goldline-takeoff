// Signed updates (electron/updsig.cjs) and the package checks (electron/versions.cjs): only a
// latest.json signed with the publisher's key is taken, and only the package it signed is unpacked
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { zipSync, strToU8 } from 'fflate';
const require = createRequire(import.meta.url);
const { verifyLatest, signLatest, PUBLIC_KEY } = require('../electron/updsig.cjs');
const V = require('../electron/versions.cjs');

const pair = () => { const k = crypto.generateKeyPairSync('ed25519'); return { priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, pub: k.publicKey.export({ type: 'spki', format: 'pem' }) as string }; };
const payload = { product: 'Goldline Takeoff', version: '0.23.0', runtime: '44.10.0', notes: ['x'], app: { file: 'app-v0.23.0.zip', sha256: 'a'.repeat(64), size: 10 } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gt-updsig-'));
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const app = (v: string, extra: Record<string, Uint8Array> = {}) => zipSync({
  'package.json': strToU8(JSON.stringify({ version: v, main: 'electron/start.cjs' })),
  'electron/main.cjs': strToU8('// main'), 'electron/preload.cjs': strToU8('// preload'), 'dist/index.html': strToU8('<html>'), ...extra,
});

test('a signed latest.json gives what was signed - not the plain fields beside it', () => {
  const k = pair();
  const j = signLatest(payload, k.priv);
  const swapped = { ...j, app: { file: 'evil.zip', sha256: 'b'.repeat(64), size: 10 } };
  assert.deepEqual(verifyLatest(swapped, k.pub).latest, payload);
  // signing again drops an old signature first (sign-latest on a file signed before)
  assert.deepEqual(verifyLatest(signLatest(j, k.priv), k.pub).latest, payload);
});

test('unsigned, signed with another key, or changed after signing: refused', () => {
  const k = pair(), other = pair();
  assert.match(verifyLatest(payload, k.pub).err, /not signed/);
  assert.match(verifyLatest({ ...payload, signed: JSON.stringify(payload) }, k.pub).err, /not signed/);
  assert.match(verifyLatest(signLatest(payload, other.priv), k.pub).err, /doesn't match/, 'the wrong key');
  const j = signLatest(payload, k.priv);
  assert.match(verifyLatest({ ...j, signed: j.signed.replace('a'.repeat(64), 'c'.repeat(64)) }, k.pub).err, /doesn't match/, 'the signed text changed');
  assert.match(verifyLatest({ ...j, signed: j.signed.replace('0.23.0', '0.23.1') }, k.pub).err, /doesn't match/);
  assert.match(verifyLatest({ ...j, signature: Buffer.from('x'.repeat(64)).toString('base64') }, k.pub).err, /doesn't match/);
  assert.match(verifyLatest(null).err, /not signed/);
  // the old _releases format (company key, sig / sig2) is not a GitHub release
  assert.match(verifyLatest({ version: '0.23.0', files: [], sig: 'x', sig2: 'y' }).err, /not signed/);
});

test('the app trusts only the new key: a release signed with any other key is refused', () => {
  const j = signLatest(payload, pair().priv);
  assert.match(verifyLatest(j).err, /doesn't match/);
  // (the key of the company version's own update system, by its SHA-256: it must not be the GitHub key)
  const body = PUBLIC_KEY.replace(/-----[A-Z ]+-----|\s/g, '');
  assert.notEqual(crypto.createHash('sha256').update(body).digest('hex'), 'ee6d4b58f2a20030c3deac1aa3e9dd0a7231ed34f0bb070049ca29801ad4bd70', 'the old key is not the GitHub key');
  for (const f of fs.readdirSync('electron')) {
    if (!f.endsWith('.cjs')) continue;
    assert.ok(!fs.readFileSync(path.join('electron', f), 'utf8').includes('PRIVATE KEY-----'), f + ' holds no private key');
  }
});

test("the key in the app is the publisher's (kept next to the source, never in it)", (t) => {
  const f = path.resolve('..', 'keys', 'goldline-takeoff-update-signing.pem');
  if (!fs.existsSync(f)) { t.skip('no signing key on this PC (only the publisher has it)'); return; }
  const j = signLatest(payload, fs.readFileSync(f, 'utf8'));
  assert.deepEqual(verifyLatest(j).latest, payload);
  assert.equal(crypto.createPublicKey(fs.readFileSync(f, 'utf8')).export({ type: 'spki', format: 'pem' }), PUBLIC_KEY);
  assert.ok(!fs.existsSync('keys'), 'no keys folder inside the source');
});

test('a tampered package is refused before it is unpacked: size, SHA-256', () => {
  const d = tmp();
  const zip = path.join(d, 'app-v0.23.0.zip');
  const good = app('0.23.0');
  fs.writeFileSync(zip, good);
  V.checkPackage(zip, sha(good), good.length);
  const bad = Buffer.from(good);
  bad[Math.floor(bad.length / 2)] ^= 1;
  fs.writeFileSync(zip, bad);
  assert.throws(() => V.checkPackage(zip, sha(good), good.length), /checksum/);
  fs.writeFileSync(zip, Buffer.concat([good, Buffer.from('x')]));
  assert.throws(() => V.checkPackage(zip, sha(good), good.length), /size/);
  assert.throws(() => V.checkPackage(zip, 'nothex', 0), /checksum/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('a package holding anything but the app files, or another version, is refused whole', () => {
  const d = tmp();
  const store = path.join(d, 'store');
  const put = (name: string, z: Uint8Array) => { const f = path.join(d, name); fs.writeFileSync(f, z); return f; };
  for (const [what, extra] of [
    ['a program', { 'electron/helper.exe': strToU8('MZ') }],
    ['a path outside', { '../evil.cjs': strToU8('x') }],
    ['a file at the top', { 'evil.cjs': strToU8('x') }],
    ['a script outside electron/', { 'node_modules/x.js': strToU8('x') }],
  ] as const) {
    assert.throws(() => V.installPackage(put('a.zip', app('0.23.0', extra as Record<string, Uint8Array>)), store, '0.23.0', '44.10.0', 'a'.repeat(64)), /does not take|bad path/, what);
    assert.ok(!fs.existsSync(path.join(store, '0.23.0')), what + ': nothing unpacked');
  }
  assert.throws(() => V.installPackage(put('b.zip', app('0.24.0')), store, '0.23.0', '44.10.0', 'a'.repeat(64)), /holds version 0.24.0/);
  // the store's own marks never come from a package
  assert.throws(() => V.installPackage(put('c.zip', app('0.23.0', { 'ready.json': strToU8('{}') })), store, '0.23.0', '44.10.0', 'a'.repeat(64)), /does not take/);
  const dir = V.installPackage(put('d.zip', app('0.23.0')), store, '0.23.0', '44.10.0', 'a'.repeat(64));
  assert.equal(V.readJson(path.join(dir, 'ready.json')).version, '0.23.0');
  assert.ok(fs.readdirSync(store).every((n) => !n.includes('.part-')), 'no half-unpacked folder left');
  fs.rmSync(d, { recursive: true, force: true });
});
