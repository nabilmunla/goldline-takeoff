// Updates from the web (electron/feed.cjs): GitHub releases, or a local feed in the tests only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const feed = require('../electron/feed.cjs');

test('a GitHub repository: the newest release, each package from its own version', () => {
  const r = 'https://github.com/someone/goldline-takeoff';
  for (const v of [r, r + '/', r + '.git']) assert.deepEqual(feed.github(v), { owner: 'someone', repo: 'goldline-takeoff' });
  assert.equal(feed.latestUrl(r), r + '/releases/latest/download/latest.json');
  assert.equal(feed.fileUrl(r, '1.2.3', 'app-v1.2.3.zip'), r + '/releases/download/v1.2.3/app-v1.2.3.zip');
  assert.equal(feed.fileUrl(r, '1.2.3', 'Goldline Takeoff Setup 1.2.3.exe'), r + '/releases/download/v1.2.3/Goldline%20Takeoff%20Setup%201.2.3.exe');
  // (a file name can't reach outside the release)
  assert.equal(feed.fileUrl(r, '1.2.3', '../../x/evil.zip'), r + '/releases/download/v1.2.3/evil.zip');
  assert.equal(feed.fileUrl(r, '1.2.3', '..\\..\\evil.zip'), r + '/releases/download/v1.2.3/evil.zip');
  assert.equal(feed.releasePage(r, '1.2.3'), r + '/releases/tag/v1.2.3');
  assert.equal(feed.releasePage(r, ''), r + '/releases/latest');
  for (const bad of ['https://github.com/someone', 'http://github.com/a/b', 'https://github.com.evil.io/a/b', 'https://github.com/a/b/c', '\\\\server\\share\\_releases']) assert.equal(feed.github(bad), null, bad);
});

test('any other web address (the tests\' local feed): files side by side', () => {
  const w = 'http://127.0.0.1:8080/feed';
  assert.ok(feed.isWeb(w) && feed.isWeb('HTTPS://x.y/') && !feed.isWeb('\\\\server\\share\\_releases') && !feed.isWeb('C:\\updates') && !feed.isWeb(''));
  assert.equal(feed.latestUrl(w + '/'), w + '/latest.json');
  assert.equal(feed.fileUrl(w, '1.0.0', 'app-v1.0.0.zip'), w + '/app-v1.0.0.zip');
  assert.equal(feed.releasePage(w, '1.0.0'), w);
});

test('where a copy looks: package.json "updateFeed"; GT_UPDATE_FEED only outside the packaged app', () => {
  const pkg = { updateFeed: 'https://github.com/nabilmunla/goldline-takeoff' };
  const env = { GT_UPDATE_FEED: 'http://127.0.0.1:9/feed' };
  assert.equal(feed.source(pkg, true, env), pkg.updateFeed, 'the packaged app ignores the variable');
  assert.equal(feed.source(pkg, false, env), env.GT_UPDATE_FEED, 'tests and development may point elsewhere');
  assert.equal(feed.source(pkg, false, { GT_UPDATE_FEED: '\\\\server\\share' }), pkg.updateFeed, 'never a folder');
  assert.equal(feed.source({ updateFeed: 'http://evil.example/feed' }, true, {}), feed.FEED, 'package.json names a GitHub repository or nothing');
  assert.equal(feed.source({}, true, {}), feed.FEED);
});

test("every copy reads Goldline Takeoff's own GitHub releases", () => {
  assert.equal(feed.FEED, 'https://github.com/nabilmunla/goldline-takeoff');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.updateFeed, feed.FEED);
  assert.equal(feed.latestUrl(feed.FEED), 'https://github.com/nabilmunla/goldline-takeoff/releases/latest/download/latest.json');
});
