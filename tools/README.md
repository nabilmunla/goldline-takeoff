# Publishing a Goldline Takeoff version

Installed copies update from GitHub only: https://github.com/nabilmunla/goldline-takeoff
(package.json `updateFeed`). They read `releases/latest/download/latest.json`, and download
the app zip from the release of that version (`releases/download/v<version>/...`).

## The signing key

- Private key: `keys/goldline-takeoff-update-signing.pem` NEXT TO the source folder (not in it),
  or set `GT_SIGNING_KEY` / pass `--key`. Never in the repository, a release, a zip or a share.
  Keep a second copy somewhere safe. Whoever has it can put code on every PC.
- The public half is in `electron/updsig.cjs`. The app trusts only that key for GitHub releases.
- Lost key: make a new pair, put the new public key in `electron/updsig.cjs`, and every PC
  has to install that version once by hand (the setup).
- Check: `node tools/sign-latest.cjs --check`

## Every release

1. Raise `version` in package.json (it must be higher than the last release).
2. `npm run build`
3. `node tools/release-github.cjs out/release-<version> --notes "line one\nline two"`
   (add `--setup <setup.exe>` and `--source <source.zip>` when the release tooling made them).
   It checks the key first, writes `app-v<version>.zip` and `latest.json` (signed), and reads
   them back the way the app does. Don't edit latest.json by hand: an edited one is refused.
4. On GitHub: a new release, tag `v<version>`, title `Goldline Takeoff <version>`. Attach every
   file from the out folder, then publish it as the latest release (copies see it from then on).
   To hold a version back: a draft or a pre-release (copies only read the latest release).

A version on a new Electron runtime (`runtime` in latest.json differs from the PC's) is not
installed by the app: the card says "needs the setup" and opens the release page. Attach the
setup to that release.

## Tests

    npx tsx --test tests/feed.test.ts tests/updsig.test.ts tests/store.test.ts
