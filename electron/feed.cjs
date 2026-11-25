// Where new versions come from: Goldline Takeoff's GitHub releases (package.json "updateFeed", else
// FEED below). Tests point it elsewhere with GT_UPDATE_FEED (never honoured in the packaged app).
//   - a GitHub repository (https://github.com/<owner>/<repo>): the newest release -
//     releases/latest/download/latest.json, and each package from the release of its own version
//     (releases/download/v<version>/<file>), so a release published between the check and the
//     download can't hand over another version's file
//   - any other http(s) address (tests): <address>/latest.json, <address>/<file>
// Whatever the place, nothing is installed unless latest.json carries the publisher's signature
// and the package matches its SHA-256 (updsig.cjs, updater.cjs).
'use strict';

/** where every copy looks for new versions (when package.json names none) */
const FEED = 'https://github.com/nabilmunla/goldline-takeoff';
const isWeb = (src) => /^https?:\/\//i.test(String(src || '').trim());

/** { owner, repo } for a GitHub repository address, else null */
function github(src) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(String(src || '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}
const base = (src) => String(src).trim().replace(/\/+$/, '') + '/';
const gh = (g) => `https://github.com/${g.owner}/${g.repo}`;

function latestUrl(src) {
  const g = github(src);
  return g ? `${gh(g)}/releases/latest/download/latest.json` : base(src) + 'latest.json';
}
function fileUrl(src, version, file) {
  const name = encodeURIComponent(String(file).split(/[\\/]/).pop());
  const g = github(src);
  return g ? `${gh(g)}/releases/download/v${encodeURIComponent(version)}/${name}` : base(src) + name;
}
/** where a person downloads a version's setup by hand */
function releasePage(src, version) {
  const g = github(src);
  if (g) return version ? `${gh(g)}/releases/tag/v${encodeURIComponent(version)}` : `${gh(g)}/releases/latest`;
  return String(src).trim();
}

/**
 * The feed this copy reads: GT_UPDATE_FEED (tests, development - never the packaged app: an
 * environment variable anyone can set must not decide where code comes from), else package.json's
 * "updateFeed" if it is a GitHub repository, else FEED.
 */
function source(pkg, packaged, env = process.env) {
  const t = String((env && env.GT_UPDATE_FEED) || '').trim();
  if (!packaged && isWeb(t)) return t;
  const p = pkg && typeof pkg.updateFeed === 'string' ? pkg.updateFeed.trim() : '';
  return github(p) ? p : FEED;
}

module.exports = { FEED, isWeb, github, latestUrl, fileUrl, releasePage, source };
