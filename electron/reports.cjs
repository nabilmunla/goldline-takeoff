// The problem report sent to the developer (the web one; the team's own copy in the shared folder's
// _reports is src/ui/Update.tsx and stays in the team). Only with a receiver (package.json
// "reportEndpoint"), only when the person presses Send, and only what the preview shows: the body is
// made and anonymised here (anon.cjs) once, shown, and exactly that text is posted - from the update
// worker's process (update-worker.cjs "post"), with a time limit; no internet = it says so, nothing waits
// and nothing is kept on this PC. Never host, Windows user name, app folder, settings, shared folder,
// project name or file names - and no drawing, BOQ, price or picture of the screen.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const anon = require('./anon.cjs');

/** folder or word in a settings path that tells nothing about the person or the work (taking them out of the log would only spoil it) */
const PLAIN = /^(users?|home|desktop|documents|downloads|appdata|local|roaming|programs?|data|projects?|takeoffs?|goldline|share[sd]?|team|drive|mnt|media|run|opt|tmp|temp|var|c|d|e)$/i;

/** names this PC knows are private, from the settings: folders and files in any path the settings hold */
function settingsWords(s) {
  const words = new Set();
  const walk = (v, depth) => {
    if (depth > 3 || v == null) return;
    if (typeof v === 'string') {
      if (!/[\\/]/.test(v) || v.length > 400) return;
      const parts = v.split(/[\\/]+/).filter(Boolean);
      for (const part of parts) {
        const p = part.replace(/^[A-Za-z]:$/, '');
        if (p.length >= 4 && !PLAIN.test(p) && !/^\.+$/.test(p)) words.add(p);
        const noExt = p.replace(/\.[^.]+$/, '');
        if (noExt !== p && noExt.length >= 4 && !PLAIN.test(noExt)) words.add(noExt);
      }
    } else if (Array.isArray(v)) v.slice(0, 50).forEach((x) => walk(x, depth + 1));
    else if (typeof v === 'object') Object.values(v).slice(0, 50).forEach((x) => walk(x, depth + 1));
  };
  walk(s, 0);
  for (const k of ['displayName', 'lastUsername']) if (typeof s[k] === 'string') addName(words, s[k]);
  return [...words];
}
/** a person's or a project's name, whole and in its words (letters, not tiny: "Smith" - not "Mr") */
function addName(words, v) {
  const n = String(v || '').trim();
  if (n.length < 4) return;
  words.add(n);
  for (const part of n.split(/\s+/)) if (part.length >= 4 && part !== n && !PLAIN.test(part)) words.add(part);
}

function create({ version, appName, endpoint = '', readSettings, logTail, run, dir, now = () => Date.now() }) {
  let last = null; // the text last shown: the one that may be sent
  let sends = 0;

  /** what a report says about the app and the PC (no user or PC name) */
  function base() {
    return {
      app: appName,
      version,
      runtime: process.versions.electron,
      windows: os.platform() === 'win32' ? os.release() : os.platform() + ' ' + os.release(),
      arch: os.arch(),
      memoryMB: { total: Math.round(os.totalmem() / 2 ** 20), free: Math.round(os.freemem() / 2 ** 20) },
      uptimeMin: Math.round(process.uptime() / 60),
      time: new Date(now()).toISOString(),
    };
  }
  function who(extraWords) {
    let w = { user: '', pc: '' };
    try { w = { user: os.userInfo().username, pc: os.hostname() }; } catch (_) { /* none */ }
    const words = new Set(settingsWords(readSettings()));
    for (const x of Array.isArray(extraWords) ? extraWords.slice(0, 200) : []) {
      // (a path is split into its folders; a name stays whole)
      if (/[\\/]/.test(String(x))) for (const y of settingsWords({ x: String(x) })) words.add(y); else addName(words, x);
    }
    return { ...w, words: [...words] };
  }

  /**
   * ctx from the window: { screen, errors: [recent errors of the window], words: [names it knows are private
   * - the person, the project, the shared folder] } - none of it is sent as such, only scrubbed
   */
  function body(text, ctx) {
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    const rep = {
      kind: 'problem',
      ...base(),
      where: String(c.screen || '').slice(0, 40),
      text: String(text || '').slice(0, 20000),
      stack: Array.isArray(c.errors) ? c.errors.map((e) => String(e).slice(0, 2000)).slice(-30).join('\n') : '',
      log: logTail(),
    };
    return JSON.stringify(anon.anonymize(rep, who(c.words)), null, 2);
  }

  const available = () => !!endpoint;

  /** exactly the text that Send will post */
  function preview(text, ctx) {
    if (!endpoint) return '';
    last = body(text, ctx);
    return last;
  }

  /** post what was last shown (and only that); { state: 'sent' | 'failed' | 'local' | 'changed', err } */
  async function send(shown) {
    if (!endpoint) return { state: 'local', err: '' };
    if (typeof shown !== 'string' || shown !== last) return { state: 'changed', err: '' };
    // (a name of its own: two sends at once must not post each other's text or remove each other's file)
    const f = path.join(dir(), 'report-out-' + process.pid + '-' + (++sends) + '-' + Date.now().toString(36) + '.tmp');
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, shown);
      const r = await run(['post', endpoint, f]);
      return r && r.ok ? { state: 'sent', err: '' } : { state: 'failed', err: String((r && r.err) || 'unknown') };
    } catch (e) {
      return { state: 'failed', err: String((e && e.message) || e) };
    } finally { try { fs.rmSync(f, { force: true }); } catch (_) { /* gone */ } }
  }

  return { available, preview, send, settingsWords };
}

module.exports = { create, settingsWords };
