// The OLD company release key (the _releases folder of 0.22.0 and before - the bridge only). The key
// GitHub releases are signed with is another one: see tools/README.md.
// Make the key that signs Goldline Takeoff releases (once; again only if the old one is lost).
//   node tools/release-key.cjs <file for the PRIVATE key>
// Keep the private key on the publisher's own PC (and a copy somewhere safe, e.g. a USB stick in a
// drawer) - NEVER on the shared folder: whoever has it can put code on every PC. The public key it
// prints went into the old updater; copies of the app with the new key then
// have to be installed by hand once.
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const out = process.argv[2];
if (!out) { console.error('usage: node tools/release-key.cjs <private key file>'); process.exit(2); }
if (fs.existsSync(out)) { console.error(out + ' already exists - not overwritten.'); process.exit(1); }
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
console.log('private key written to ' + out);
console.log('public key (for electron/updater.cjs):');
console.log(publicKey.export({ type: 'spki', format: 'pem' }));
