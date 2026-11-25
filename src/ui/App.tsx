import { useCallback, useEffect, useRef, useState } from 'react';
import { gt, type AppInfo } from './api';
import { StartScreen, type HomeTab } from './StartScreen';
import { LoginScreen } from './LoginScreen';
import { UserMenu, ChangePassword } from './Account';
import { ProjectSession } from '../engine/session';
import { accountsDir, adminSet, adminAtFn, getAccount, signInOps, rootsOf, trustedGet, loadAccountStore, CFG, type Account, type Roots } from '../engine/accounts';
import { backupDirOf } from '../engine/backups';
import { movedTarget, samePath, syncJournals } from '../engine/teamfolder';
import { TakeoffProjectView } from './takeoff/TakeoffProjectView';
import { previewsSaving, previewsSaved } from './takeoff/drawings';
import { ISun, IMoon } from './icons';
import { HelpProvider, HelpButton } from './Help';
import { UpdateProvider, UpdateButton, ProblemReports } from './Update';
import { CountAsk, WebReport } from './Privacy';
import { keepBackedUp, closeWithBackup, sendLeftovers, leftoverCount, openSessions, pendingTotal, setBackupRoots } from './backup';
import { forgetIssuedCodes } from './People';

/** changes this PC holds for projects that are not open: counted and sent (see Shell) */
interface Leftovers { count: () => Promise<number>; send: () => Promise<number>; stop: () => void }
import { pointsInProgress, unsavedDrafts } from './closeGuards';
import { accessFor } from '../engine/access';
import type { BackupKeeper } from '../engine/backups';
import { DATA_FORMAT, BASE_FORMAT } from '../engine/version';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface OpenProject {
  dir: string;
  name: string;
  id: string;
  /** viewers, or people an admin gave view access only */
  readOnly: boolean;
  /** a take-off project */
  kind?: 'qto';
}

/** The signed-in person + the live accounts folder */
export interface Auth {
  account: Account;
  accounts: ProjectSession;
  admins: Set<string>;
  /** was this person an administrator when a change with that stamp was made (stable function) */
  wasAdmin: (username: string, stamp: string) => boolean;
  isAdmin: boolean;
  /** where accounts and take-off projects are kept */
  roots: Roots;
}

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme(initial: ThemeMode) {
  const [mode, setMode] = useState<ThemeMode>(initial);
  const [resolved, setResolved] = useState<'light' | 'dark'>(resolveTheme(initial));
  useEffect(() => {
    const apply = () => {
      const r = resolveTheme(mode);
      setResolved(r);
      document.documentElement.dataset.theme = r;
      gt().setTheme(r).catch(() => {});
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [mode]);
  return { mode, resolved, setMode };
}

export function ThemeButton({ resolved, onToggle }: { resolved: 'light' | 'dark'; onToggle: () => void }) {
  return (
    <button className="tb-btn" title={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={onToggle}>
      {resolved === 'dark' ? <ISun /> : <IMoon />}
    </button>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <img src="./gmark.svg" alt="" />
      <span className="word">
        <b>Goldline</b> Takeoff
      </span>
    </div>
  );
}

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const closers = useRef<{ project: (() => Promise<void>) | null; accounts: (() => Promise<void>) | null }>({ project: null, accounts: null });
  const leftoverRef = useRef<Leftovers | null>(null);

  useEffect(() => {
    gt().info().then((i) => {
      setInfo(i);
      document.documentElement.dataset.theme = resolveTheme(i.theme);
    });
    gt().onClosing(async () => {
      // a shape half drawn on a sheet, a note half written: not saved until finished - ask first
      const pts = pointsInProgress();
      const notes = unsavedDrafts();
      if (pts >= 2 || notes.length) {
        gt().closeHold?.();
        const go = await new Promise<boolean>((resolve) => setHalfAsk({ n: pts >= 2 ? pts : 0, note: notes.length > 0, resolve }));
        setHalfAsk(null);
        if (!go) { gt().closeCancelled?.(); return; }
      }
      // a figure still being typed in a cell is kept (a cell saves when it loses the focus)
      const a = document.activeElement as HTMLElement | null;
      if (a && a !== document.body && typeof a.blur === 'function') { a.blur(); await new Promise((r) => setTimeout(r, 60)); }
      // a sheet's picture still being saved (the first opening of a heavy sheet): a few seconds to finish
      // (within the app's own 6 s for closing: no hold, the window is not brought up for it)
      if (previewsSaving()) await Promise.race([previewsSaved(), new Promise((r) => setTimeout(r, 3000))]);
      // what is queued gets a moment to reach the shared folder
      for (let i = 0; i < 25 && pendingTotal() > 0; i++) await new Promise((r) => setTimeout(r, 100));
      // changes left on this PC by a project closed while the folder was away: sent now if they can be
      let left = leftoverRef.current ? await leftoverRef.current.count().catch(() => 0) : 0;
      if (left > 0) {
        gt().closeHold?.();
        setClosingNote('Sending changes left on this PC…');
        await Promise.race([leftoverRef.current!.send(), new Promise((r) => setTimeout(r, 8000))]).catch(() => {});
        left = await leftoverRef.current!.count().catch(() => 0);
        setClosingNote(null);
      }
      if (pendingTotal() + left > 0) {
        gt().closeHold?.();
        const go = await new Promise<boolean>((resolve) => setCloseAsk({ n: pendingTotal() + left, resolve }));
        setCloseAsk(null);
        if (!go) { gt().closeCancelled?.(); return; }
      }
      // (if a question held the close: from here it is bounded again, whatever the share does)
      gt().closeResume?.();
      setClosingNote('Closing…');
      try {
        if (closers.current.project) await closers.current.project();
        if (closers.current.accounts) await closers.current.accounts();
      } finally {
        gt().closed();
      }
    });
  }, []);
  const [closeAsk, setCloseAsk] = useState<{ n: number; resolve: (go: boolean) => void } | null>(null);
  const [halfAsk, setHalfAsk] = useState<{ n: number; note: boolean; resolve: (go: boolean) => void } | null>(null);
  const [closingNote, setClosingNote] = useState<string | null>(null);
  // the first screen is on: this version works on this PC (the starter keeps it; see boot.cjs)
  useEffect(() => { if (info) gt().healthy?.(); }, [!!info]);

  if (!info) return <div className="app" />;
  return (
    // the update state is outside Help: Help shows the last update check (v0.16.2)
    <UpdateProvider info={info}><HelpProvider>
      <Shell info={info} setInfo={setInfo} closers={closers} leftovers={leftoverRef} />
      {halfAsk && (
        <div className="scrim">
          <div className="modal">
            <h2>{halfAsk.n ? 'A shape is half drawn' : 'A note is not saved'}</h2>
            <p className="sub">
              {halfAsk.n ? <>The shape you are drawing has {halfAsk.n} points and is not saved until it is finished (Enter, or click its first point to close an area). </> : null}
              {halfAsk.note ? <>The note you are writing is not saved until you press Save note. </> : null}
              Keep the app open to finish {halfAsk.n && halfAsk.note ? 'them' : 'it'} — or close and lose just {halfAsk.n && halfAsk.note ? 'these' : 'this'}.
            </p>
            <div className="actions">
              <button className="btn" onClick={() => halfAsk.resolve(true)}>Close anyway</button>
              <button className="btn primary" autoFocus onClick={() => halfAsk.resolve(false)}>Keep the app open</button>
            </div>
          </div>
        </div>
      )}
      {closingNote && !closeAsk && !halfAsk && (
        <div className="scrim"><div className="modal" style={{ width: 360 }}><p className="sub" style={{ margin: 0 }}><span className="dot busy" /> {closingNote}</p></div></div>
      )}
      {closeAsk && (
        <div className="scrim">
          <div className="modal">
            <h2>Not sent yet</h2>
            <p className="sub">
              {closeAsk.n} change{closeAsk.n > 1 ? 's have' : ' has'} not reached the shared folder yet — it isn't reachable from this PC right now.
              {' '}{closeAsk.n > 1 ? 'They are' : 'It is'} kept safely on this PC and sent the next time you open Goldline Takeoff with the shared folder reachable.
            </p>
            <div className="actions">
              <button className="btn" onClick={() => closeAsk.resolve(true)}>Close anyway</button>
              <button className="btn primary" autoFocus onClick={() => closeAsk.resolve(false)}>Keep the app open</button>
            </div>
          </div>
        </div>
      )}
    </HelpProvider></UpdateProvider>
  );
}

function Shell(props: {
  info: AppInfo;
  setInfo: (i: AppInfo) => void;
  closers: React.MutableRefObject<{ project: (() => Promise<void>) | null; accounts: (() => Promise<void>) | null }>;
  leftovers: React.MutableRefObject<Leftovers | null>;
}) {
  const { info, setInfo, closers } = props;
  const theme = useTheme(info.theme);
  const [auth, setAuth] = useState<Auth | null>(null);
  const [project, setProject] = useState<OpenProject | null>(null);
  const [notice, setNotice] = useState<string | null>(() => {
    const rec = !info.recovered ? null
      : info.recovered.reason.startsWith('the newest version') ? `The newest version of Goldline Takeoff could not start on this PC, so the one before it was started (${info.version}). Please tell whoever looks after the app.`
        : 'Goldline Takeoff stopped unexpectedly and was started again. Please check your last change. If it happens again, use “Copy a problem report” (in your menu or F1) and send it to whoever looks after the app.';
    // a damaged settings file is said too (a shared folder asked for again must not look like a new PC)
    return [info.settingsNote, rec].filter(Boolean).join(' ') || null;
  });
  const [modal, setModal] = useState<'password' | null>(null);
  const [homeTab, setHomeTab] = useState<HomeTab>('takeoff');
  const authRef = useRef<Auth | null>(null);
  const keeperRef = useRef<BackupKeeper | null>(null);
  authRef.current = auth;
  /** the team folder moved (an administrator moved it): where to, and whether this PC can get there */
  const [moved, setMoved] = useState<{ to: string; ok: boolean; why?: string } | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const movedSeen = useRef<{ to: string; at: number; ok: boolean } | null>(null);

  const toggle = () => {
    const next = theme.resolved === 'dark' ? 'light' : 'dark';
    theme.setMode(next);
    gt().setSettings({ theme: next });
  };
  // every title bar gets the shortcuts button next to the theme switch
  const themeButton = <><UpdateButton /><HelpButton /><ThemeButton resolved={theme.resolved} onToggle={toggle} /></>;

  const signOut = useCallback(async (why?: string) => {
    const a = authRef.current;
    forgetIssuedCodes();
    // (the backups folders stay as they are: the last backups of what closes now go where they belong;
    // the next sign-in sets them before anything else is written)
    setMoved(null);
    movedSeen.current = null;
    setProject(null);
    setModal(null);
    setAuth(null);
    if (why) setNotice(why);
    if (a) await closeWithBackup(a.accounts, keeperRef.current);
    keeperRef.current = null;
    closers.current.accounts = null;
    props.leftovers.current?.stop();
    props.leftovers.current = null;
  }, []);

  const signedIn = useCallback(async (account: Account, o?: { root?: string; keepTab?: boolean }) => {
    const fs = gt().fs;
    const root = o?.root ?? info.dataRoot!;
    // people and access change seldom: every PC looks every 3 s, not every second (a whole team signed
    // in all day would otherwise read the accounts folder hundreds of times a minute)
    const s = new ProjectSession({ fs, localFs: fs, projectDir: accountsDir(fs, root), localDir: info.localDir, user: account.name, account: account.username, host: info.host, appVersion: info.version, dataFormat: DATA_FORMAT, markFormat: BASE_FORMAT, pollMs: 3000, heartbeatMs: 6000, fullScanMs: 20000 });
    await s.open();
    // (switching folders signs the same person in again: not if they are not there, or deactivated there)
    const meNow = getAccount(s.store, account.username);
    if (!meNow || !meNow.active) {
      await s.close().catch(() => {});
      await signOut(meNow ? 'Your account is deactivated in this team folder.' : 'Your account is not in this team folder.');
      return;
    }
    // where backups go, before the first one is written
    setBackupRoots(rootsOf(s.store, root));
    const wasAdmin = adminAtFn(s.store);
    let lastAdmins: Set<string> | null = null;
    let lastAccDir = '';
    const build = (): Auth | null => {
      const me = getAccount(s.store, account.username);
      if (!me) return null;
      // same administrators as before: keep the same Set, so screens that depend on it don't redo their work
      let admins = adminSet(s.store);
      if (lastAdmins && lastAdmins.size === admins.size && [...admins].every((u) => lastAdmins!.has(u))) admins = lastAdmins;
      lastAdmins = admins;
      const roots = rootsOf(s.store, root);
      setBackupRoots(roots);
      // this PC remembers where the accounts' backups are (offered if the accounts are ever lost)
      const accDir = backupDirOf(fs, root, 'accounts', '', '', roots.bak.team);
      if (accDir !== lastAccDir) { lastAccDir = accDir; gt().setSettings({ accBackups: accDir, accBackupsFor: root }); }
      return { account: me, accounts: s, admins, wasAdmin, isAdmin: me.active && admins.has(me.username), roots };
    };
    // an administrator moved the team folder: this PC follows (see the effect below)
    const lookMoved = () => {
      const v = trustedGet(s.store, CFG, 'movedTo');
      if (typeof v !== 'string' || !v.trim() || samePath(v, root)) return;
      const seen = movedSeen.current;
      // asked once; if it couldn't be reached, again every half minute
      if (seen && samePath(seen.to, v) && (seen.ok || Date.now() - seen.at < 30_000)) return;
      movedSeen.current = { to: v, at: Date.now(), ok: false };
      void movedTarget(fs, root, s.store).then((t) => {
        if (!t || authRef.current?.accounts !== s) return;
        movedSeen.current = { to: t.to, at: Date.now(), ok: t.ok };
        setMoved(t);
      }).catch(() => {});
    };
    s.onChange(() => {
      const next = build();
      if (!next || !next.account.active) {
        signOut('Your account was deactivated by an administrator.');
        return;
      }
      setAuth(next);
      lookMoved();
    });
    const keeper = keepBackedUp(s, { kind: 'accounts', root, projectDir: accountsDir(fs, root), by: account.username, host: info.host, app: info.version });
    keeperRef.current = keeper;
    closers.current.accounts = () => closeWithBackup(s, keeper);
    s.commit(signInOps(account.username, info.host, Date.now(), info.version), 'Signed in', { recordUndo: false });
    if (!o?.keepTab) setNotice(null);
    const first = build();
    gt().setSettings({ lastUsername: account.username });
    if (!o?.keepTab) setHomeTab('takeoff');
    setAuth(first);
    lookMoved();
    // changes left on this PC when the shared folder was out of reach (the app closed, or a project
    // left while offline): sent in the background after sign-in and then every 20 s while it runs (only
    // the local queue is looked at until there is something to send),
    // and before closing (App asks about what is still left)
    const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
    const isOpen = (pd: string) => [...openSessions].some((x) => norm(x.projectDir) === norm(pd));
    let running: Promise<number> | null = null;
    const send = () => {
      const cur = authRef.current;
      if (!cur) return Promise.resolve(0);
      running ??= sendLeftovers({
        localDir: info.localDir, user: account.name, account: account.username, host: info.host, appVersion: info.version, dataFormat: DATA_FORMAT, markFormat: BASE_FORMAT,
        canEdit: (meta) => accessFor(cur.accounts.store, cur.admins, cur.account, meta) === 'edit',
        isOpen,
        log: (l) => gt().log(l),
      }).catch(() => 0).finally(() => { running = null; });
      return running;
    };
    props.leftovers.current?.stop();
    const soon = setTimeout(() => void send(), 4000);
    const every = setInterval(() => void send(), 20000);
    props.leftovers.current = {
      count: () => leftoverCount({ localDir: info.localDir, account: account.username, isOpen }),
      send,
      stop: () => { clearTimeout(soon); clearInterval(every); },
    };
  }, [info.dataRoot, info.localDir, info.host]);

  // the team folder moved: switch over now if no project is open (else as soon as it closes). The
  // accounts here are closed first (their last changes sent), whatever only they hold is copied
  // across, and the same person carries on in the new folder - no second sign-in.
  const switchTeam = useCallback(async (to: string) => {
    const a = authRef.current;
    if (!a) return;
    const fs = gt().fs;
    const from = a.roots.team;
    // a late answer about the folder this PC is in already
    if (samePath(to, from)) { setMoved(null); return; }
    // the same person must be there, and active, before anything here is closed
    const there = await loadAccountStore(fs, to).catch(() => null);
    const me = there?.exists ? getAccount(there.store, a.account.username) : null;
    if (!me || !me.active) {
      setMoved({ to, ok: false, why: me ? 'your account is deactivated there' : 'your account isn’t there' });
      return;
    }
    setSwitching(`Moving to the new team folder (${to})…`);
    try {
      await closeWithBackup(a.accounts, keeperRef.current);
      keeperRef.current = null;
      closers.current.accounts = null;
      props.leftovers.current?.stop();
      props.leftovers.current = null;
      const r = await syncJournals(fs, accountsDir(fs, from), accountsDir(fs, to)).catch((e) => { gt().log('team folder move: copying the last changes failed: ' + String(e?.message ?? e)); return null; });
      if (r?.changes) gt().log(`team folder move: ${r.changes} change(s) copied from ${from}`);
      await gt().setSettings({ dataRoot: to });
      setInfo({ ...info, dataRoot: to });
      setMoved(null);
      movedSeen.current = null;
      await signedIn(a.account, { root: to, keepTab: true });
      setNotice(null);
      setFlash(`The team folder has moved to ${to} — this PC uses it from now on.`);
    } catch (e: any) {
      gt().log('team folder move failed: ' + String(e?.message ?? e));
      setSwitching(null);
      signOut(`Could not switch to the new team folder (${to}): ${String(e?.message ?? e)}`);
      return;
    }
    setSwitching(null);
  }, [info, signedIn, signOut]);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (moved?.ok && auth && !project && !switching) void switchTeam(moved.to);
  }, [moved, auth, project, switching, switchTeam]);
  // the new folder not reachable (yet): asked again every half minute
  useEffect(() => {
    if (!moved || moved.ok || !auth) return;
    const t = setInterval(() => {
      const cur = authRef.current;
      if (!cur) return;
      void movedTarget(gt().fs, cur.roots.team, cur.accounts.store).then((r) => { if (authRef.current === cur) setMoved(r); }).catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, [moved, !!auth]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 12000);
    return () => clearTimeout(t);
  }, [flash]);

  if (switching) {
    return (
      <div className="app">
        <div className="scrim"><div className="modal" style={{ width: 420 }}><p className="sub" style={{ margin: 0 }}><span className="dot busy" /> {switching}</p></div></div>
      </div>
    );
  }

  if (!auth) {
    return (
      <div className="app">
        <LoginScreen info={info} setInfo={setInfo} onSignedIn={signedIn} notice={notice} themeButton={themeButton} />
        <ProblemReports info={info} who={info.lastUsername || info.winUser} dir={info.dataRoot} redact />
        <WebReport words={[info.lastUsername ?? '', info.dataRoot ?? '']} />
        <CountAsk />
      </div>
    );
  }

  // a report goes to the shared folder the take-offs are kept in (it may name a project)
  const reportDir = auth.isAdmin || auth.account.role !== 'qs' ? auth.roots.qto : auth.roots.team;
  const userMenu = <UserMenu auth={auth} version={info.version} onSignOut={() => signOut()} onManageUsers={() => { setProject(null); setHomeTab('people'); }} onChangePassword={() => setModal('password')} />;
  return (
    <div className="app">
      {project ? (
        <TakeoffProjectView
          key={project.dir}
          info={info}
          auth={auth}
          project={project}
          onExit={() => setProject(null)}
          registerCloser={(f) => (closers.current.project = f)}
          themeButton={themeButton}
          userMenu={userMenu}
        />
      ) : (
        <StartScreen info={info} auth={auth} tab={homeTab} setTab={setHomeTab} onOpen={setProject} themeButton={themeButton} userMenu={userMenu} onSwitchFolder={() => signOut()} />
      )}
      {modal === 'password' && <ChangePassword auth={auth} onClose={() => setModal(null)} />}
      {auth.accounts.newerApp && !project && (
        <div className="verlock" title="People, access and settings can be changed again after the update">
          A newer Goldline Takeoff (<b>{auth.accounts.newerApp}</b>) has changed the accounts — this copy is {info.version}. You can work as usual (projects a newer copy has worked in open view only); people and access can't be changed here until you update.
        </div>
      )}
      {moved && (
        <div className="verlock movebar">
          {moved.ok
            ? <>The team folder has moved to <b>{moved.to}</b>. This PC switches over when you close this project — nothing is lost meanwhile.</>
            : <>The team folder has moved to <b>{moved.to}</b>, but {moved.why}. Ask IT for access to it; meanwhile this PC goes on in the old one (what you change here is carried across).{' '}
              <button className="linkbtn" onClick={() => { movedSeen.current = null; void movedTarget(gt().fs, auth.roots.team, auth.accounts.store).then((t) => setMoved(t)); }}>Check again</button></>}
        </div>
      )}
      {flash && !moved && <div className="verlock movebar ok" onClick={() => setFlash(null)}>{flash}</div>}
      <ProblemReports info={info} who={auth.account.username} dir={reportDir} redact={reportDir === auth.roots.team || reportDir === auth.roots.qto} />
      <WebReport words={[auth.account.name, auth.account.username, info.lastUsername ?? '', info.dataRoot ?? '', auth.roots.team, auth.roots.qto]} />
      <CountAsk />
    </div>
  );
}
