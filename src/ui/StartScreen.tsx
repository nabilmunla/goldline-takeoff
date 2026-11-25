// Home: the take-off project register, and (administrators) People and Activity.
// Same frame as a project: teal title bar + sheet tabs on top, status bar below.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { gt, type AppInfo } from './api';
import { Brand, type OpenProject, type Auth } from './App';
import { listProjects, createProject, projectsRoot, readProjectStore, type ProjectEntry, type ProjectFormat } from '../engine/projects';
import { createHub, hubOf, FORMAT_HUB } from '../engine/hub';
import { FORMAT, formatFor } from '../engine/legacy';
import { randomId } from '../engine/ids';
import { listFolders, folderOf, subtree, newFolderOps, renameFolderOps, moveFolderOps, deleteFolderOps, moveProjectOps, placeProjectOps, type Folder, type FolderKind } from '../engine/folders';
import { MenuButton, PopMenu, type MenuEntry } from './Menu';
import { useEscClose } from './escape';
import { colorFor } from '../engine/ids';
import { accessFor, accessReason, canCreateTakeoffs, getAcl, newProjectAclOps, setEveryoneOps, type Access } from '../engine/access';
import { listAccounts, ROLE_LABEL } from '../engine/accounts';
import { ago, initials } from './format';
import { IFolder, IPlus, IRefresh, ISearch, IMore } from './icons';
import { PeopleTab, ActivityTab, AccessDialog } from './People';
import { BackupsDialog } from './Backups';
import { setViewOnly, isViewOnly } from './ViewOnly';
import { ILock } from './icons';
import { usePanelWidth, PanelEdge } from './PanelSize';

export type HomeTab = 'takeoff' | 'people' | 'activity';

/**
 * Keeps a register fresh while it is on screen: read again 5 s after the last reading finished (not
 * every 5 s whatever happens - on a slow share one reading can take longer than that, and readings
 * started on a clock would pile up on the server). One reading at a time; a Refresh asked for while
 * one is under way is done right after it. A reading of a folder that is no longer the one shown
 * (the list switched folders meanwhile) is not shown.
 */
function useRegister(root: string | null, format: ProjectFormat, enabled: boolean) {
  const fs = gt().fs;
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = root + '\u0000' + format;
  const keyRef = useRef(key);
  keyRef.current = key;
  const running = useRef<{ key: string; p: Promise<void>; again: boolean } | null>(null);
  const refresh = useCallback((): Promise<void> => {
    if (!root || !enabled) return Promise.resolve();
    const cur = running.current;
    if (cur && cur.key === key) { cur.again = true; return cur.p; }
    const run: { key: string; p: Promise<void>; again: boolean } = { key, p: Promise.resolve(), again: false };
    run.p = (async () => {
      do {
        run.again = false;
        try {
          if (!(await fs.exists(root))) throw new Error('not reachable');
          const list = await listProjects(fs, root, Date.now(), format);
          if (keyRef.current !== key) return;
          setProjects(list);
          setError(null);
        } catch {
          if (keyRef.current !== key) return;
          setError(`Can't reach ${root}. Check that the network drive is connected, then retry.`);
        }
      } while (run.again && keyRef.current === key);
    })().finally(() => { if (running.current === run) running.current = null; });
    running.current = run;
    return run.p;
  }, [key, enabled]);
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout> | null = null;
    const loop = () => { void refresh().then(() => { if (!stop) t = setTimeout(loop, 5000); }); };
    loop();
    return () => { stop = true; if (t) clearTimeout(t); };
  }, [refresh, enabled]);
  return { projects, error, refresh };
}

export function StartScreen({ info, auth, tab, setTab, onOpen, themeButton, userMenu, onSwitchFolder }: {
  info: AppInfo;
  auth: Auth;
  tab: HomeTab;
  setTab: (t: HomeTab) => void;
  onOpen: (p: OpenProject) => void;
  themeButton: ReactNode;
  userMenu: ReactNode;
  onSwitchFolder: () => void;
}) {
  const fs = gt().fs;
  const me = auth.account;
  const showTab: HomeTab = auth.isAdmin ? tab : tab === 'people' || tab === 'activity' ? 'takeoff' : tab;
  // only the list on screen is kept fresh (People counts the projects); it is read again
  // as soon as its tab is opened
  const qto = useRegister(auth.roots.qto, FORMAT.takeoff, showTab === 'takeoff' || showTab === 'people');
  const [showNew, setShowNew] = useState(false);
  const [q, setQ] = useState('');
  const [accessFor_, setAccessFor] = useState<ProjectEntry | null>(null);
  const [showBackups, setShowBackups] = useState(false);
  const reg = qto;

  const store = auth.accounts.store;
  const accounts = listAccounts(store);
  // folders of this list (shared by the team) and the one being looked at (remembered per list)
  const kind: FolderKind = 'qto';
  const folders = useMemo(() => listFolders(store, kind), [auth, kind, store.version]);
  const [whereByKind, setWhereByKind] = useState<Record<FolderKind, string>>(() => {
    try { return JSON.parse(localStorage.getItem('home:folder') || '') as Record<FolderKind, string>; } catch { return { est: 'all', qto: 'all' }; }
  });
  const whereRaw = whereByKind[kind] ?? 'all';
  const where = whereRaw === 'all' || whereRaw === 'none' || folders.some((f) => f.id === whereRaw) ? whereRaw : 'all';
  const setWhere = (w: string) => {
    const next = { ...whereByKind, [kind]: w };
    setWhereByKind(next);
    try { localStorage.setItem('home:folder', JSON.stringify(next)); } catch { /* ignore */ }
  };
  const canFolders = me.role !== 'viewer';
  const pathOf = (fid: string | null) => (fid ? folders.find((f) => f.id === fid)?.path ?? '' : '');
  const visible = useMemo(() => {
    if (!reg.projects) return [];
    return reg.projects
      .map((p) => ({ p, access: accessFor(store, auth.admins, me, p.meta, accounts) as Access, fld: folderOf(store, p.meta.id, folders) }))
      .filter((r) => r.access !== 'none');
  }, [reg.projects, auth, folders, store.version]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    // a search looks in every folder: name, owner, folder
    if (t) {
      const words = t.split(/\s+/);
      return visible.filter((r) => {
        const hay = (r.p.meta.name + ' ' + (accounts.find((a) => a.username === getAcl(store, r.p.meta, accounts).owner)?.name ?? '') + ' ' + pathOf(r.fld)).toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    if (where === 'all') return visible;
    if (where === 'none') return visible.filter((r) => !r.fld);
    const inside = subtree(folders, where);
    return visible.filter((r) => r.fld && inside.has(r.fld));
  }, [visible, q, where, folders]);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of visible) {
      let f = r.fld;
      const seen = new Set<string>();
      while (f && !seen.has(f)) { seen.add(f); c.set(f, (c.get(f) ?? 0) + 1); f = folders.find((x) => x.id === f)?.par ?? null; }
    }
    return c;
  }, [visible, folders]);
  const moveProject = (pid: string, to: string | null) => auth.accounts.commit(moveProjectOps(pid, to), to ? 'Moved a project to a folder' : 'Took a project out of its folder');
  const hidden = reg.projects ? reg.projects.length - reg.projects.filter((p) => accessFor(store, auth.admins, me, p.meta, accounts) !== 'none').length : 0;

  const open = (p: ProjectEntry, access: Access) => onOpen({ dir: p.dir, name: p.meta.name, id: p.meta.id, readOnly: access !== 'edit', kind: 'qto' });
  const nameOf = (u: string | null) => (u ? accounts.find((a) => a.username === u)?.name ?? u : '—');
  const canNew = canCreateTakeoffs(me);
  const root = auth.roots.qto;

  return (
    <div className="pview">
      <header className="frame-top">
        <div className="topbar">
          <Brand />
          <div className="spacer" />
          {themeButton}
          {userMenu}
        </div>
        <nav className="sheet-tabs">
          <button className={'stab' + (showTab === 'takeoff' ? ' on' : '')} onClick={() => setTab('takeoff')}>Take-off</button>
          {auth.isAdmin && <span className="stab-gap" />}
          {auth.isAdmin && <button className={'stab' + (showTab === 'people' ? ' on' : '')} onClick={() => setTab('people')}>People</button>}
          {auth.isAdmin && <button className={'stab' + (showTab === 'activity' ? ' on' : '')} onClick={() => setTab('activity')}>Activity</button>}
        </nav>
      </header>

      {showTab === 'people' ? (
        <PeopleTab auth={auth} projects={qto.projects ?? []} />
      ) : showTab === 'activity' ? (
        <ActivityTab auth={auth} />
      ) : (
        <div className="sheet">
          <div className="toolbar">
            <div className="search">
              <ISearch />
              <input className="input" placeholder="Find: name, owner, folder" title="Looks in every folder: project name, owner and folder names" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
            </div>
            <button className="btn ghost icon" onClick={reg.refresh} title="Refresh the list"><IRefresh /></button>
            <span className="faint">Take-off projects hold quantities and drawing links only — never a price.</span>
            <div className="grow" />
            {auth.isAdmin && <button className="btn ghost" onClick={() => setShowBackups(true)} title="Daily backups of every project in this list — restore any day as a new project (administrators)">Backups…</button>}
            {canNew && (
              <button className="btn primary" disabled={!!reg.error} onClick={() => setShowNew(true)}>
                <IPlus /> New take-off
              </button>
            )}
          </div>
          <div className="reg-split">
          {!reg.error && (folders.length > 0 || canFolders) && (
            <FolderPane
              folders={folders}
              where={q.trim() ? '' : where}
              counts={counts}
              total={visible.length}
              unfiled={visible.filter((r) => !r.fld).length}
              canEdit={canFolders}
              onPick={(w) => { setQ(''); setWhere(w); }}
              onNew={(par) => { const r = newFolderOps(store, kind, 'New folder', par); auth.accounts.commit(r.ops, 'New folder'); return r.id; }}
              onRename={(id, name) => auth.accounts.commit(renameFolderOps(id, name), 'Renamed a folder')}
              onMoveFolder={(id, par) => { const ops = moveFolderOps(store, kind, id, par); if (ops) auth.accounts.commit(ops, 'Moved a folder'); }}
              onDelete={(id) => { auth.accounts.commit(deleteFolderOps(store, kind, id, (reg.projects ?? []).map((p) => p.meta.id)), 'Removed a folder'); if (where === id) setWhere('all'); }}
              onDropProject={(pid, to) => { const r = visible.find((x) => x.p.meta.id === pid); if (r && r.access === 'edit') moveProject(pid, to); }}
            />
          )}
          <div className="paper-scroll">
            {reg.error ? (
              <div className="empty">
                <h3>Folder not reachable</h3>
                <p>{reg.error}</p>
                <button className="btn" onClick={reg.refresh}><IRefresh /> Retry</button>
              </div>
            ) : reg.projects && rows.length === 0 && !q ? (
              <div className="empty">
                <h3>No take-off projects yet</h3>
                <p>Start one for a tender: add the received drawings (they stay where they are) and measure.</p>
                {canNew && <button className="btn primary" onClick={() => setShowNew(true)}><IPlus /> New take-off</button>}
              </div>
            ) : (
              <table className="register">
                <thead>
                  <tr>
                    <th>Take-off project</th>
                    {folders.length > 0 && <th style={{ width: 200 }}>Folder</th>}
                    <th style={{ width: 170 }}>Owner</th>
                    <th style={{ width: 150 }}>Your access</th>
                    <th style={{ width: 170 }}>Shared with</th>
                    <th style={{ width: 150 }}>Created</th>
                    <th style={{ width: 190 }}>Working in it now</th>
                    <th style={{ width: auth.isAdmin ? 132 : 52 }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ p, access, fld }) => {
                    const acl = getAcl(store, p.meta, accounts);
                    const shared = [...acl.people.keys()].filter((u) => u !== acl.owner);
                    const reason = accessReason(store, auth.admins, me, p.meta, accounts);
                    return (
                      <tr
                        key={p.dir}
                        className="prow"
                        onClick={() => open(p, access)}
                        title={canFolders && access === 'edit' && folders.length ? 'Open · drag onto a folder on the left to file it' : 'Open'}
                        draggable={canFolders && access === 'edit'}
                        onDragStart={(e) => { e.dataTransfer.setData('text/x-gt-project', p.meta.id); e.dataTransfer.effectAllowed = 'move'; }}
                      >
                        <td className="pn">{p.meta.name}{isViewOnly(p.meta.id) && <span className="vo-mark" title="You set this project to View only on this PC — the lock inside the project turns it off"><ILock /></span>}</td>
                        {folders.length > 0 && <td className="muted fpath" title={pathOf(fld)}>{fld ? pathOf(fld) : '—'}</td>}
                        <td>{nameOf(acl.owner)}</td>
                        <td>
                          <span className={'acc ' + access}>{access === 'edit' ? 'Edit' : 'View only'}</span>
                          {reason && <span className="why">{reason === 'Administrator' ? 'admin' : reason === 'Owner' ? 'owner' : reason === 'Shared with everyone' ? 'everyone' : 'shared'}</span>}
                        </td>
                        <td className="muted">
                          {acl.everyone !== 'none' ? `Everyone (${acl.everyone})` : shared.length ? `${shared.length} ${shared.length === 1 ? 'person' : 'people'}` : 'Only the owner'}
                        </td>
                        <td className="muted">{ago(p.meta.created)}</td>
                        <td>
                          {p.activeUsers.length ? (
                            <span className="nowin">
                              <span className="avatars">
                                {p.activeUsers.slice(0, 4).map((u) => (
                                  <span key={u} className="avatar" style={{ background: colorFor(u) }} title={u}>{initials(u)}</span>
                                ))}
                              </span>
                              {p.activeUsers.length === 1 ? p.activeUsers[0].split(' ')[0] : `${p.activeUsers.length} people`}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="r acts" onClick={(e) => e.stopPropagation()}>
                          {auth.isAdmin && <button className="btn sm" onClick={() => setAccessFor(p)}>Access…</button>}
                          <MenuButton
                            className="ghost icon sm"
                            title="Folder, access…"
                            label={<IMore />}
                            items={(): MenuEntry[] => [
                              { label: 'Open', run: () => open(p, access) },
                              ...(access === 'edit' ? [{ label: 'Open view only', hint: 'look without any chance of changing something', run: () => { setViewOnly(p.meta.id, true); open(p, access); } } as MenuEntry] : []),
                              ...(canFolders && access === 'edit' && folders.length ? [{
                                kind: 'sub' as const, label: 'Move to folder', items: [
                                  { label: 'Not in a folder', on: !fld, run: () => moveProject(p.meta.id, null) } as MenuEntry,
                                  { kind: 'sep' } as MenuEntry,
                                  ...folders.map((f): MenuEntry => ({ label: '\u00a0\u00a0'.repeat(f.depth) + f.name, on: fld === f.id, run: () => moveProject(p.meta.id, f.id) })),
                                ],
                              } as MenuEntry] : []),
                              ...(auth.isAdmin ? [{ kind: 'sep' } as MenuEntry, { label: 'Who can open it…', run: () => setAccessFor(p) } as MenuEntry] : []),
                            ]}
                          />
                        </td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && q && (
                    <tr><td colSpan={7} className="muted" style={{ padding: 24, textAlign: 'center' }}>No project matches “{q}”.</td></tr>
                  )}
                </tbody>
              </table>
            )}
            {!auth.isAdmin && hidden > 0 && (
              <p className="hint" style={{ margin: '14px 16px' }}>
                {me.role === 'viewer' ? 'You see only the projects an administrator shared with you.' : 'You see your own projects and the ones shared with you.'}
              </p>
            )}
          </div>
          </div>
        </div>
      )}

      <footer className="statusbar">
        <span className="s" title={root}>
          <span className={'dot ' + (reg.error ? 'bad' : 'ok')} />
          {showTab === 'people' || showTab === 'activity' ? auth.roots.team : root}
        </span>
        <button className="sb-btn" onClick={onSwitchFolder} title="Accounts belong to a team folder, so switching signs you out"><IFolder /> Switch folder</button>
        <span className="grow" />
        <span className="s">{me.name} ({ROLE_LABEL[auth.isAdmin ? 'admin' : me.role === 'admin' ? 'qs' : me.role]})</span>
        <span className="s faint">Goldline Takeoff {info.version}{info.profile !== 'default' ? ` · test profile “${info.profile}”` : ''}</span>
      </footer>

      {showNew && (
        <NewTakeoff
          others={(reg.projects ?? []).filter((x) => accessFor(auth.accounts.store, auth.admins, me, x.meta) !== 'none').map((x) => ({ dir: x.dir, name: x.meta.name }))}
          onClose={() => setShowNew(false)}
          onCreate={async (pname, from) => {
            // its BOQ: a new one (imported later, in the BOQ tab), or the one another take-off uses
            let hub: { id: string; name: string } | null = null;
            if (from) {
              const st = await readProjectStore(fs, from.dir);
              const hid = hubOf(st);
              if (!hid) throw new Error(`“${from.name}” has no updatable BOQ yet (made before this version) — an administrator can make it updatable in its BOQ tab.`);
              hub = { id: hid, name: String(st.get('project', 'hubName') ?? from.name) };
            }
            // a new BOQ is made FIRST: a take-off never points at a hub that isn't there (the take-off's row in
            // the hub is written by its app when it is opened)
            if (!hub) {
              hub = { id: randomId(12), name: pname };
              const made = await createHub(fs, projectsRoot(fs, auth.roots.qto), { hubId: hub.id, name: pname, user: me.name, account: me.username });
              if (!made.meta) throw new Error('The BOQ folder could not be made on the share — nothing was created.');
            }
            const { dir, meta } = await createProject(fs, auth.roots.qto, pname, me.name, info.host, [['project', 'hub', hub.id], ['project', 'hubName', hub.name], ['project', 'fmt', FORMAT_HUB], ['project', 'fmtBy', info.version]], me.username, formatFor(FORMAT.takeoff, auth.accounts.meta));
            // shared with the whole team by default (Nabil, Oct 2026); an administrator can narrow it
            auth.accounts.commit([...newProjectAclOps(meta, me.username, 'qto'), ...setEveryoneOps(meta.id, 'edit'), ...placeProjectOps(meta.id, where !== 'all' && where !== 'none' ? where : null)], `Created take-off ${pname}`);
            setShowNew(false);
            onOpen({ dir, name: pname, id: meta.id, readOnly: false, kind: 'qto' });
          }}
        />
      )}
      {accessFor_ && <AccessDialog auth={auth} project={accessFor_} onClose={() => setAccessFor(null)} />}
      {showBackups && auth.isAdmin && <BackupsDialog auth={auth} info={info} kind="qto" projects={reg.projects} onOpen={(o) => { setShowBackups(false); onOpen(o); }} onClose={() => setShowBackups(false)} />}
    </div>
  );
}

function NewTakeoff({ onClose, onCreate, others }: { onClose: () => void; onCreate: (name: string, from: { dir: string; name: string } | null) => Promise<void>; others: { dir: string; name: string }[] }) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const esc = useEscClose(onClose, busy);
  const [err, setErr] = useState<string | null>(null);
  const going = useRef(false);
  const go = async () => {
    // Enter pressed twice (or Enter + click) must not create two projects
    if (!name.trim() || going.current) return;
    going.current = true;
    setBusy(true);
    try {
      await onCreate(name.trim(), others.find((o) => o.dir === from) ?? null);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setBusy(false);
      going.current = false;
    }
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={esc.onKeyDown}>
      <div className="modal" ref={esc.box} tabIndex={-1}>
        <h2>New take-off</h2>
        <p className="sub">
          Shared with the whole team. Add the received drawings next — they are linked, never copied. Several take-offs can share one BOQ (the combined filled copy adds them up).
        </p>
        <div className="row">
          <label>Name</label>
          <input className="input" autoFocus value={name} placeholder="e.g. Marina Tower – Architectural take-off" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
        </div>
        <div className="row">
          <label>BOQ</label>
          <select className="input" data-newboq value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">A new BOQ (import it in the BOQ tab)</option>
            {others.map((o) => <option key={o.dir} value={o.dir}>The same BOQ as “{o.name}”</option>)}
          </select>
        </div>
        {err && <p className="err">{err}</p>}
        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim() || busy} onClick={go}>{busy ? 'Creating…' : 'Create take-off'}</button>
        </div>
      </div>
    </div>
  );
}

/** The folders of a project list: All, the team's folders (nested), Not in a folder. */
function FolderPane(p: {
  folders: Folder[];
  /** 'all' | 'none' | folder id; '' while searching (the search looks everywhere) */
  where: string;
  counts: Map<string, number>;
  total: number;
  unfiled: number;
  canEdit: boolean;
  onPick: (w: string) => void;
  onNew: (par: string | null) => string;
  onRename: (id: string, name: string) => void;
  onMoveFolder: (id: string, par: string | null) => void;
  onDelete: (id: string) => void;
  onDropProject: (projectId: string, to: string | null) => void;
}) {
  const [panelW, setPanelW] = usePanelWidth('folders', 236, 170, 480);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; f: Folder } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [closed, setClosed] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('home:closed') || '[]')); } catch { return new Set(); } });
  const toggle = (id: string) => {
    const n = new Set(closed);
    if (n.has(id)) n.delete(id); else n.add(id);
    setClosed(n);
    try { localStorage.setItem('home:closed', JSON.stringify([...n])); } catch { /* ignore */ }
  };
  // a folder is shown when none of the folders above it is closed
  const hiddenBy = (f: Folder): boolean => {
    let par = f.par;
    while (par) { if (closed.has(par)) return true; par = p.folders.find((x) => x.id === par)?.par ?? null; }
    return false;
  };
  const hasKids = (id: string) => p.folders.some((f) => f.par === id);
  const drop = (to: string | null, key: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!p.canEdit) return;
      const t = e.dataTransfer.types;
      if (t.includes('text/x-gt-project') || t.includes('text/x-gt-folder')) { e.preventDefault(); setOver(key); }
    },
    onDragLeave: () => setOver((o) => (o === key ? null : o)),
    onDrop: (e: React.DragEvent) => {
      setOver(null);
      const pid = e.dataTransfer.getData('text/x-gt-project');
      const fid = e.dataTransfer.getData('text/x-gt-folder');
      if (pid) { e.preventDefault(); p.onDropProject(pid, to); }
      else if (fid && fid !== to) { e.preventDefault(); p.onMoveFolder(fid, to); }
    },
  });
  const addNew = (par: string | null) => {
    const id = p.onNew(par);
    if (par && closed.has(par)) toggle(par);
    setRenaming(id);
  };
  return (
    <div className="pw-wrap" style={{ width: panelW }}>
    <aside className="folders-pane">
      <div className="fp-head">
        <span>Folders</span>
        {p.canEdit && <button className="btn ghost icon sm" title="New folder" onClick={() => addNew(null)}><IPlus /></button>}
      </div>
      <div className="fp-list">
        <button className={'fp-row' + (p.where === 'all' ? ' on' : '') + (over === 'all' ? ' over' : '')} onClick={() => p.onPick('all')} {...drop(null, 'all')} title="Every project (drop here: take it out of its folder)">
          <span className="fp-name">All projects</span><span className="fp-n">{p.total}</span>
        </button>
        {p.folders.filter((f) => !hiddenBy(f)).map((f) => (
          <div
            key={f.id}
            className={'fp-row' + (p.where === f.id ? ' on' : '') + (over === f.id ? ' over' : '')}
            style={{ paddingLeft: 10 + f.depth * 16 }}
            onClick={() => p.onPick(f.id)}
            onDoubleClick={() => p.canEdit && setRenaming(f.id)}
            onContextMenu={(e) => { if (!p.canEdit) return; e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, f }); }}
            draggable={p.canEdit && renaming !== f.id}
            onDragStart={(e) => { e.dataTransfer.setData('text/x-gt-folder', f.id); e.dataTransfer.effectAllowed = 'move'; }}
            title={f.path + (p.canEdit ? ' · double-click to rename, right-click for more, drag to move' : '')}
            {...drop(f.id, f.id)}
          >
            <span className={'fp-tw' + (hasKids(f.id) ? '' : ' none') + (closed.has(f.id) ? ' closed' : '')} onClick={(e) => { e.stopPropagation(); if (hasKids(f.id)) toggle(f.id); }}>▾</span>
            <IFolder />
            {renaming === f.id ? (
              <input
                className="input sm"
                autoFocus
                defaultValue={f.name}
                onClick={(e) => e.stopPropagation()}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => { setRenaming(null); if (e.currentTarget.value.trim() && e.currentTarget.value.trim() !== f.name) p.onRename(f.id, e.currentTarget.value); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { e.currentTarget.value = f.name; (e.target as HTMLInputElement).blur(); } }}
              />
            ) : <span className="fp-name">{f.name}</span>}
            <span className="fp-n">{p.counts.get(f.id) ?? ''}</span>
          </div>
        ))}
        {p.folders.length > 0 && (
          <button className={'fp-row' + (p.where === 'none' ? ' on' : '')} onClick={() => p.onPick('none')} title="Projects not filed in any folder">
            <span className="fp-name faint">Not in a folder</span><span className="fp-n">{p.unfiled}</span>
          </button>
        )}
        {p.folders.length === 0 && p.canEdit && (
          <p className="fp-hint">Group projects in folders — e.g. by year, client or status. Click <b>+</b>, then drag projects onto a folder.</p>
        )}
      </div>
      {menu && (
        <PopMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'New folder inside', run: () => addNew(menu.f.id) },
            { label: 'Rename', run: () => setRenaming(menu.f.id) },
            { label: 'Move to the top level', disabled: !menu.f.par, run: () => p.onMoveFolder(menu.f.id, null) },
            { kind: 'sep' },
            { label: 'Remove the folder', hint: 'what is in it moves up a level', danger: true, run: () => p.onDelete(menu.f.id) },
          ]}
        />
      )}
    </aside>
    <PanelEdge side="right" width={panelW} onWidth={setPanelW} />
    </div>
  );
}
