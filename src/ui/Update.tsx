// New versions, version locks and problem reports.
//
// - A newer version on GitHub (electron/updater.cjs: signed, checked, no helper program) is offered by a
//   pill in the title bar; "Update" downloads it in the background (you keep working), "Restart now"
//   closes the app the normal way (the open project sends its last changes) and starts the new
//   version. A version with a new runtime needs the setup: the card opens the release page.
// - A project last worked on by a newer app opens view-only here (engine: ProjectSession.newerApp);
//   VersionBar says so and offers the update.
// - "Copy a problem report" writes what is needed to look into a problem into
//   <shared folder>\_reports, and copies it to the clipboard. (With a receiver in package.json, the card
//   also offers an anonymous report to the developer: src/ui/Privacy.tsx.)
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { gt, recentErrors, type AppInfo, type UpdateSnapshot } from './api';
import { pendingTotal } from './backup';
import { useEscClose } from './escape';
import { scrubPaths } from '../engine/scrub';

interface UpdateState {
  snap: UpdateSnapshot | null;
  /** the version on offer, downloaded or needing the setup (null: nothing to show) */
  available: string | null;
  /** downloading or unpacking */
  busy: boolean;
  /** said on the card (a failed download, changes not sent yet) */
  error: string | null;
  /** the card's main button: Update / Restart now / Open the release page */
  act: () => void;
  own: string;
  checkNow: () => void;
  cancel: () => void;
  later: () => void;
}

const Ctx = createContext<UpdateState>({ snap: null, available: null, busy: false, error: null, act: () => {}, own: '', checkNow: () => {}, cancel: () => {}, later: () => {} });
export const useUpdate = () => useContext(Ctx);

const OFFERED = ['available', 'downloading', 'installing', 'ready', 'setup'];

export function UpdateProvider({ info, children }: { info: AppInfo; children: ReactNode }) {
  const [snap, setSnap] = useState<UpdateSnapshot | null>(null);
  const [hold, setHold] = useState<string | null>(null);
  useEffect(() => {
    const u = gt().update;
    if (!u?.get) return;
    let alive = true;
    u.get().then((s) => alive && setSnap(s), () => {});
    const off = u.onState((s) => { if (alive) setSnap(s); });
    return () => { alive = false; off(); };
  }, []);
  const s = snap;
  const offered = !!s && !!s.available && (OFFERED.includes(s.state) || (s.state === 'error' && s.show !== false));
  const available = offered ? s!.available! : null;
  const busy = !!s && (s.state === 'downloading' || s.state === 'installing');
  const act = useCallback(() => {
    const u = gt().update;
    if (!s || !u) return;
    setHold(null);
    if (s.state === 'setup') { void u.openPage(); return; }
    if (s.state === 'ready') {
      // the restart closes the app: changes still waiting for the shared folder go first
      const waiting = pendingTotal();
      if (waiting) { setHold(`${waiting} change${waiting > 1 ? 's have' : ' has'} not reached the shared folder yet. Restart once ${waiting > 1 ? 'they are' : 'it is'} sent (the status bar says “All changes saved”) — or the new version starts next time.`); return; }
      void u.restart();
      return;
    }
    if (s.state === 'available' || s.state === 'error') void u.download();
  }, [s]);
  const checkNow = useCallback(() => { void gt().update?.check(); }, []);
  const cancel = useCallback(() => { void gt().update?.cancel(); }, []);
  const later = useCallback(() => { setHold(null); void gt().update?.later(); }, []);
  const error = hold ?? (s && s.state === 'error' && s.available ? s.err || 'The update did not work.' : null);
  return <Ctx.Provider value={{ snap, available, busy, error, act, own: info.version, checkNow, cancel, later }}>{children}</Ctx.Provider>;
}

const mb = (n?: number) => (n ? ` (${Math.max(1, Math.round(n / 1e6))} MB)` : '');

/** in every title bar: a new version (a small pill; it never covers the work) */
export function UpdateButton() {
  const u = useUpdate();
  const s = u.snap;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // a failed download, or the version just made ready after Update: the card says so
  useEffect(() => { if (u.error || (s?.show && s.state === 'ready')) setOpen(true); }, [u.error, s?.show, s?.state]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  if (!u.available || !s) return null;
  const v = u.available;
  const pct = Math.round((s.pct ?? 0) * 100);
  const pill = s.state === 'downloading' ? `Downloading ${v}… ${pct}%` : s.state === 'installing' ? `Getting ${v} ready…` : s.state === 'ready' ? `Restart for ${v}` : s.state === 'setup' ? `${v} needs the setup` : `Update to ${v}`;
  const main = s.state === 'ready' ? 'Restart now' : s.state === 'setup' ? 'Open the release page' : s.state === 'error' ? 'Try again' : 'Update';
  return (
    <div className="updwrap no-drag" ref={ref}>
      <button className="tb-btn updpill" onClick={() => setOpen((x) => !x)} title={`Goldline Takeoff ${v} — you have ${u.own}`}>
        <span className="updot" /> {pill}
      </button>
      {open && (
        <div className="updpop" role="dialog" data-state={s.state}>
          <div className="t"><b>Goldline Takeoff {v}</b>{s.state === 'ready' ? ' is ready' : s.state === 'setup' ? ' needs the setup' : ' is out'}<span className="faint"> · you have {u.own}</span></div>
          {!!s.notes?.length && <ul className="faint notes">{s.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          {s.note && <div className="faint">{s.note}</div>}
          {u.error ? <div className="err">{u.error}</div>
            : s.state === 'setup' ? <div className="faint">It comes with a new runtime, so only its setup can install it. Download the setup from the release page and run it. Your work and settings stay.</div>
            : s.state === 'downloading' ? <div className="faint">Downloading{mb(s.size)}… {pct}%. Keep working.</div>
            : s.state === 'installing' ? <div className="faint">Checking and unpacking…</div>
            : s.state === 'ready' ? <div className="faint">Restart now to use it (your last changes are sent first), or it starts the next time you open Goldline Takeoff.</div>
            : <div className="faint">Update downloads it{mb(s.size)} while you keep working. Nothing changes until you restart.</div>}
          <div className="acts">
            {u.busy ? <button className="btn ghost sm" onClick={u.cancel}>Cancel</button>
              : <><button className="btn ghost sm" onClick={() => { setOpen(false); u.later(); }}>Later</button>
                <button className="btn primary sm" onClick={u.act}>{main}</button></>}
          </div>
        </div>
      )}
    </div>
  );
}

/** the bar over a project opened view-only because a newer app has worked in it */
export function VersionBar({ newer, own }: { newer: string; own: string }) {
  const u = useUpdate();
  const st = u.snap?.state;
  return (
    <div className="revbar verbar">
      <span>
        <b>View only:</b> this project was last worked on with Goldline Takeoff <b>{newer}</b>; this copy is {own}.
        {' '}Update the app to work in it{u.available ? '' : ' — ask whoever installs the app for the new version'}.
      </span>
      <span className="grow" />
      {u.available && st !== 'setup' && <button className="btn sm primary" disabled={u.busy} onClick={u.act}>{u.busy ? 'Downloading…' : st === 'ready' ? `Restart for ${u.available}` : `Update to ${u.available}`}</button>}
      {u.available && st === 'setup' && <span className="faint">Version {u.available} needs the setup — see “{u.available} needs the setup” at the top.</span>}
    </div>
  );
}

// ---------------------------------------------------------------- problem reports
/** what the screen knows that the main process doesn't (the open project, its sync state) */
export const reportContext: { screen: string; project?: string; projectDir?: string; sync?: unknown } = { screen: 'start' };

/** ask for a problem report from anywhere (menus, F1, Ctrl+K): the shell writes it */
export const askProblemReport = () => window.dispatchEvent(new Event('gt:report'));

/**
 * Write a problem report into `dir`\_reports (the folder of the people who can read it: an
 * estimator's goes to the estimation folder, so a project name never lands where QS look) and
 * copy it to the clipboard.
 */
export async function problemReport(info: AppInfo, who: string, dir: string | null, redact = false): Promise<{ path: string | null; text: string }> {
  const r = await gt().report();
  // a report saved where QS can read it carries no folder paths or project names (they could name
  // estimation projects): only what is needed to see what went wrong
  // (folder names may have spaces: the known folders go whole, and a path runs to its last \ or / on the line -
  // it stopped at the first space and the rest of the folder names stayed - 0.23.2, DeepSeek #8)
  const known = [info.dataRoot, info.localDir, info.accBackups, dir];
  const scrub = (t: string) => (!redact ? t : scrubPaths(t, known));
  const lines = [
    `Goldline Takeoff problem report — ${new Date().toISOString()}`,
    `Person: ${who} (Windows user ${r.winUser}) on ${r.host}`,
    `App ${r.version} · Electron ${r.electron} · ${r.os} · profile ${r.profile} · memory ${r.memoryMB} MB · running ${r.uptimeMin} min`,
    `App folder: ${scrub(r.appDir)}`,
    `Shared folder: ${scrub(info.dataRoot ?? '(none)')}`,
    `Screen: ${reportContext.screen}${reportContext.project ? (redact ? ' · a project' : ' · project ' + reportContext.project + ' (' + reportContext.projectDir + ')') : ''}`,
    reportContext.sync ? 'Sync: ' + JSON.stringify(reportContext.sync) : '',
    '',
    '--- errors in this window ---',
    recentErrors.length ? scrub(recentErrors.join('\n')) : '(none)',
    '',
    '--- settings ---',
    scrub(JSON.stringify(r.settings, null, 1)),
    '',
    '--- last lines of the log ---',
    scrub(r.log),
  ].filter((x, i, a) => x !== '' || (a[i - 1] !== '' && i > 0));
  const text = lines.join('\n');
  let path: string | null = null;
  if (dir) {
    try {
      const fs = gt().fs;
      const out = fs.join(dir, '_reports');
      // never make the shared folder again where it has gone
      if (!(await fs.exists(dir))) throw new Error('the shared folder is not reachable');
      await fs.mkdirp(out);
      // to the second, and a few random letters: two reports in the same minute (one before and one
      // after showing the problem) never replace each other
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const tag = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
      const safe = (x: string) => x.replace(/[^\w.-]+/g, '_');
      path = fs.join(out, `${safe(who)}_${safe(r.host)}_${stamp}_${tag}.txt`);
      await fs.writeAtomic(path, text);
    } catch {
      path = null;
    }
  }
  if (!gt().clipboard?.(text)) {
    try { await navigator.clipboard.writeText(text); } catch { /* the file is still there */ }
  }
  return { path, text };
}

/** listens for askProblemReport() and shows where the report went */
export function ProblemReports({ info, who, dir, redact = false }: { info: AppInfo; who: string; dir: string | null; redact?: boolean }) {
  const [res, setRes] = useState<{ path: string | null; lines: number } | 'busy' | null>(null);
  // a build with a receiver (package.json "reportEndpoint") can also send an anonymous report to the developer
  const [web, setWeb] = useState(false);
  useEffect(() => { void gt().webReport?.available().then(setWeb).catch(() => {}); }, []);
  useEffect(() => {
    const h = () => {
      setRes('busy');
      problemReport(info, who, dir, redact).then((r) => setRes({ path: r.path, lines: r.text.split('\n').length }), () => setRes({ path: null, lines: 0 }));
    };
    window.addEventListener('gt:report', h);
    return () => window.removeEventListener('gt:report', h);
  }, [info, who, dir, redact]);
  const esc = useEscClose(() => setRes(null), res === 'busy', !!res);
  if (!res) return null;
  return (
    <div className="scrim" onKeyDown={esc.onKeyDown} onMouseDown={(e) => e.target === e.currentTarget && res !== 'busy' && setRes(null)}>
      <div ref={esc.box} tabIndex={-1} className="modal" style={{ width: 480 }}>
        <h2>Problem report</h2>
        {res === 'busy' ? (
          <p className="sub"><span className="dot busy" /> Collecting…</p>
        ) : (
          <>
            <p className="sub">
              Copied to the clipboard{res.path ? ' and saved on the shared folder' : ''}. Paste it into an email or a Teams message to whoever looks after the app, with a line on what you were doing.
            </p>
            {res.path && <p className="faint mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{res.path}</p>}
            {!res.path && dir && <p className="faint">It could not be saved on the shared folder (is it reachable?) — the clipboard copy is all there is.</p>}
            <div className="actions">
              {res.path && <button className="btn" onClick={() => gt().openPath(res.path!.replace(/[\\/][^\\/]+$/, ''))}>Open the folder</button>}
              {web && <button className="btn" title="An anonymous report to the developer: you see exactly what is sent before it goes" onClick={() => { setRes(null); window.dispatchEvent(new Event('gt:report-web')); }}>Send to the developer…</button>}
              <button className="btn primary" onClick={() => setRes(null)}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Help: the version, where updates come from and what the last look found */
export function UpdateStatusLine() {
  const u = useUpdate();
  const s = u.snap;
  const at = s?.checked ? new Date(s.checked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const text = !s || s.state === 'idle' ? 'not checked yet'
    : s.state === 'checking' ? 'checking…'
    : s.state === 'none' ? `up to date${at ? ', ' + at : ''}`
    : s.state === 'unreachable' ? `GitHub can't be reached${at ? ', ' + at : ''}`
    : s.state === 'empty' ? 'nothing published yet'
    : s.state === 'error' ? (s.err || 'the last check failed')
    : `${s.available} is out (the pill at the top)`;
  const bad = !!s && (s.state === 'error' || s.state === 'unreachable');
  return (
    <span className={'updstatus' + (bad ? ' bad' : '')} data-updstatus title={s?.source ? `Looks at ${s.source} when the app starts and every 4 hours` : undefined}>
      Version {u.own} · Updates: from GitHub — {text}
      {' '}<button className="btn sm ghost" data-checknow onClick={u.checkNow}>Check now</button>
    </span>
  );
}
