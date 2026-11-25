// A take-off project opened on its own (QS, or anyone from the Take-off register).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { overDrawing } from './toastpos';
import { calmStatus, calmPresence } from '../live';
import { gt, type AppInfo } from '../api';
import { Brand, type OpenProject, type Auth } from '../App';
import { ProjectSession } from '../../engine/session';
import { accessFor } from '../../engine/access';
import type { PresenceInfo, SyncStatus } from '../../engine/types';
import type { QtoModel } from '../../engine/qto/model';
import { initials, ago } from '../format';
import { IBack, IUsers } from '../icons';
import { TakeoffView } from './TakeoffView';
import { VersionBar, reportContext } from '../Update';
import { isViewOnly, useViewOnly, ViewOnlySwitch } from '../ViewOnly';
import { keepBackedUp, closeWithBackup } from '../backup';
import type { BackupKeeper } from '../../engine/backups';
import { DATA_FORMAT, BASE_FORMAT } from '../../engine/version';
import { useHub, HubBox } from './HubBox';
import { ProjectBackupsDialog } from '../ProjectBackups';

interface Toast {
  id: number;
  text: ReactNode;
  color?: string;
  action?: { label: string; fn: () => void };
  /** how long it stays (default 4 s, 7 s with an action) */
  ms?: number;
}

/** `where`: 'side' = over the drawing (a take-off), 'left' = bottom left (notices from the background) */
export function useToasts(where: 'side' | 'left' = 'side') {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const n = useRef(0);
  const toast = useCallback((text: ReactNode, opts: Partial<Toast> = {}) => {
    const id = ++n.current;
    // at most two at a time (newest wins); the same message again replaces the old one
    setToasts((t) => [...t.filter((x) => typeof text !== 'string' || x.text !== text).slice(-1), { id, text, ...opts }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.ms ?? (opts.action ? 7000 : 4000));
  }, []);
  const view = (
    <div className={'toasts ' + where} style={where === 'side' && toasts.length ? overDrawing() : undefined}>
      {toasts.map((t) => (
        <div key={t.id} className="toast" title="Click to close" onClick={(e) => { if (!(e.target as HTMLElement).closest('.tbtn')) setToasts((x) => x.filter((y) => y.id !== t.id)); }}>
          {t.color && <span className="bar" style={{ background: t.color }} />}
          <div style={{ flex: 1 }}>{t.text}</div>
          {t.action && <button className="tbtn" onClick={() => { t.action!.fn(); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>{t.action.label}</button>}
          {/* (v0.18 over the drawing a message lets clicks through to it: its own × closes it) */}
          <button className="tx" title="Close" aria-label="Close">×</button>
        </div>
      ))}
    </div>
  );
  return { toast, view };
}

export function TakeoffProjectView(props: {
  info: AppInfo;
  project: OpenProject;
  auth: Auth;
  onExit: () => void;
  registerCloser: (f: (() => Promise<void>) | null) => void;
  themeButton: ReactNode;
  userMenu: ReactNode;
}) {
  const { info, project, auth } = props;
  const [session, setSession] = useState<ProjectSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [others, setOthers] = useState<PresenceInfo[]>([]);
  const [selfLock, setSelfLock] = useViewOnly(project.id);
  const [canWrite, setCanWrite] = useState(false);
  const [ro, setRo] = useState(project.readOnly || selfLock);
  const [model, setModel] = useState<QtoModel | null>(null);
  const { toast, view: toastView } = useToasts();
  const hubCloser = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const s = new ProjectSession({ fs: gt().fs, localFs: gt().fs, projectDir: project.dir, localDir: info.localDir, user: auth.account.name, account: auth.account.username, host: info.host, readOnly: project.readOnly || isViewOnly(project.id), adoptQueued: !project.readOnly, appVersion: info.version, dataFormat: DATA_FORMAT, markFormat: BASE_FORMAT });
    let alive = true;
    s.onStatus(calmStatus(setStatus));
    s.onPresence(calmPresence(setOthers));
    s.onConflict((n) => toast(<span><b>{n.byUser}</b> changed the same thing a moment ago — your change was replaced (it is still in the history).</span>, { color: '#d6af67' }));
    let keeper: BackupKeeper | null = null;
    s.open().then(() => {
      if (!alive) return;
      setSession(s);
      keeper = keepBackedUp(s, { kind: 'qto', root: auth.roots.qto, projectDir: project.dir, by: auth.account.username, host: info.host, app: info.version });
    }).catch((e) => setError(String(e?.message ?? e)));
    // (the BOQ hub kept open beside it closes with it - its last additional items and its backup)
    props.registerCloser(async () => { await Promise.all([closeWithBackup(s, keeper), hubCloser.current?.()]); });
    return () => {
      alive = false;
      props.registerCloser(null);
      void closeWithBackup(s, keeper);
    };
  }, [project.dir]);

  // access can change while open (an administrator shares or un-shares)
  useEffect(() => {
    if (!session) return;
    const a = accessFor(auth.accounts.store, auth.admins, auth.account, { ...session.meta, id: session.meta.id || project.id });
    if (a === 'none') { props.onExit(); return; }
    const newer = !!session.newerApp;
    const allowed = a === 'edit' && !newer;
    setCanWrite(allowed);
    const nowRo = !allowed || selfLock;
    session.setReadOnly(nowRo);
    if (nowRo !== ro) {
      setRo(nowRo);
      if (!newer && lastAllowed.current !== null && lastAllowed.current !== allowed) toast(!allowed ? 'An administrator changed your access: view only.' : 'You can now edit this take-off.');
    }
    lastAllowed.current = allowed;
  }, [auth, session, selfLock, session?.newerApp]);
  const lastAllowed = useRef<boolean | null>(null);
  const toggleSelfLock = (on: boolean) => {
    setSelfLock(on);
    toast(on ? 'View only is on — nothing in this take-off can be changed until you turn it off (the lock at the top).' : 'View only is off — you can measure again.');
  };

  // the BOQ source (engine/hub.ts): kept open next to the take-off, its box at the top of the BOQ tab
  const hub = useHub({ session, project, auth, info, readOnly: ro, closer: hubCloser });
  const [showBackups, setShowBackups] = useState(false);

  // what a problem report says about this screen
  useEffect(() => {
    reportContext.screen = 'take-off project';
    reportContext.project = project.name;
    reportContext.projectDir = project.dir;
    return () => { reportContext.screen = 'start'; reportContext.project = undefined; reportContext.projectDir = undefined; reportContext.sync = undefined; };
  }, [project.dir]);
  useEffect(() => { reportContext.sync = { status, readOnly: ro, newerApp: session?.newerApp ?? null }; }, [status, ro, session]);

  let dot = 'busy', text = 'Connecting…';
  if (status) {
    if (status.state === 'offline') { dot = 'bad'; text = status.pending ? `Server not reachable — ${status.pending} change${status.pending > 1 ? 's' : ''} kept safely on this PC` : 'Server not reachable — retrying…'; }
    else if (status.state === 'saving' || status.pending) { dot = 'busy'; text = 'Saving…'; }
    else { dot = 'ok'; text = ro ? 'Up to date with the server' : 'All changes saved to the server'; }
  }

  return (
    <div className="pview">
      <header className="frame-top">
        <div className="topbar">
          <Brand />
          <div className="crumb">
            <button onClick={props.onExit} title="Back to the take-off projects"><IBack /> Take-off</button>
            <span className="sep">/</span>
            <span className="pname">{project.name}</span>
            {ro && !(canWrite && selfLock) && <span className="ro-badge" title={session?.newerApp ? `Goldline Takeoff ${session.newerApp} has worked in this take-off; this copy is ${info.version}. Update the app to work in it.` : 'You can look but not change this take-off'}>View only</span>}
            {canWrite && session && <ViewOnlySwitch on={selfLock} onChange={toggleSelfLock} />}
            {session && <button className="btn sm ghost no-drag" data-backups title="Back up now, or roll back to a backup" onClick={() => setShowBackups(true)}>Backups</button>}
          </div>
          <div className="spacer" />
          <div className="avatars no-drag" title={others.map((o) => o.u).join('\n')}>
            {others.slice(0, 6).map((o) => <span key={o.w} className="avatar" style={{ background: o.color }}>{initials(o.u)}</span>)}
            {others.length > 6 && <span className="avatar more">+{others.length - 6}</span>}
          </div>
          {props.themeButton}
          {props.userMenu}
        </div>
      </header>
      {session?.newerApp && <VersionBar newer={session.newerApp} own={info.version} />}
      {error ? (
        <div className="sheet"><div className="paper-scroll"><div className="empty"><h3>Could not open the take-off</h3><p>{error}</p><button className="btn" onClick={props.onExit}>Back</button></div></div></div>
      ) : !session ? (
        <div className="sheet"><div className="paper-scroll"><div className="empty"><span className="dot busy" /> Opening…</div></div></div>
      ) : (
        <div className="sheet qto-sheet">
          <TakeoffView session={session} info={info} auth={auth} projectDir={project.dir} readOnly={ro} toast={toast} others={others} onModel={setModel}
            linkBox={<HubBox st={hub} session={session} project={project} auth={auth} info={info} readOnly={ro} toast={toast} />} />
          {showBackups && (
            <ProjectBackupsDialog session={session} project={project} auth={auth} info={info} readOnly={ro} toast={(t) => toast(t)} onClose={() => setShowBackups(false)} />
          )}
        </div>
      )}
      <div className="statusbar">
        <span className="s" title={status?.lastError ?? ''}><span className={'dot ' + dot} /> {text}</span>
        {ro && <span className="s ro">View only</span>}
        <span className="grow" />
        {model && <span className="s">{model.drawings.length} drawings · {model.items.length} take-offs · {model.shapes.length} shapes</span>}
        <span className="s"><IUsers /> {others.length ? `${others.length + 1} people here` : 'Only you here'}</span>
        {status?.lastSyncAt ? <span className="s" style={{ color: 'var(--text-3)' }}>checked {ago(status.lastSyncAt)}</span> : null}
      </div>
      {toastView}
    </div>
  );
}
