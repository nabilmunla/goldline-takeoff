// Updates are trusted only when latest.json is signed with the publisher's key (Ed25519) - Rev
// Radar's scheme. latest.json carries "signed" (the JSON text the app goes by) and "signature" (of
// exactly those bytes); the plain fields beside them are for people reading the file and are never
// used. The private key stays with the publisher (outside the source and every release; see
// tools/README.md); only the public key below is in the app. This key is for the GitHub releases
// only: the company key of the old _releases folder (0.22.0 and before) is not trusted here.
'use strict';
const crypto = require('crypto');

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAufnG0CgzyIGtRrOZVd3k66rgf0l+8tRumG8Zxu8W5Ho=
-----END PUBLIC KEY-----
`;

/** latest.json as read -> { latest } (the signed part) or { err } */
function verifyLatest(j, key = PUBLIC_KEY) {
  if (!j || typeof j !== 'object' || typeof j.signed !== 'string' || typeof j.signature !== 'string') return { err: 'latest.json is not signed by the publisher' };
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(j.signed, 'utf8'), crypto.createPublicKey(key), Buffer.from(j.signature, 'base64')); } catch (_) { ok = false; }
  if (!ok) return { err: "latest.json's signature doesn't match - it was changed after it was published" };
  try {
    const latest = JSON.parse(j.signed);
    if (!latest || typeof latest !== 'object' || Array.isArray(latest)) throw new Error('not an object');
    return { latest };
  } catch (_) { return { err: 'latest.json: the signed part is not valid' }; }
}

/** the publisher's side (tools/sign-latest.cjs, tools/release-github.cjs, tests) */
function signLatest(payload, privateKeyPem) {
  const plain = { ...payload };
  delete plain.signed;
  delete plain.signature;
  const signed = JSON.stringify(plain, null, 2);
  const signature = crypto.sign(null, Buffer.from(signed, 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return { ...plain, signed, signature };
}

module.exports = { verifyLatest, signLatest, PUBLIC_KEY };
