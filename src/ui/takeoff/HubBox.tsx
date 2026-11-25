// The take-off's BOQ source (engine/hub.ts): the hub session kept open next to the take-off, the BOQ copy pulled
// from it, the take-off's additional items pushed to it, and the box at the top of the BOQ tab - import the first
// BOQ, a new issue (administrators), the combined filled copy, making a take-off from before updatable.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { gt, type AppInfo } from '../api';
import type { Auth, OpenProject } from '../App';
import { ProjectSession } from '../../engine/session';
import { Store } from '../../engine/store';
import { buildModel } from '../../engine/boq';
import { listProjects, projectsRoot, readProjectStore } from '../../engine/projects';
import { DATA_FORMAT, BASE_FORMAT } from '../../engine/version';
import { FORMAT } from '../../engine/legacy';
import {
  hubOf, legacyEstOf, legacyHubId, hubFolder, pullOps, pushAdditionalOps, ensureAttachedOps, takeoffAttachOps, bumpRevOps,
  canEditBoq, hasBoq, combinedTargets, legacySeedOps, attachHubOps, attachedTakeoffs, createHub, FORMAT_HUB, ownHubId, HUB_ROLLBACK_SKIP,
} from '../../engine/hub';
import { getAcl } from '../../engine/access';
import type { Op } from '../../engine/types';
import type { BackupKeeper } from '../../engine/backups';
import { keepBackedUp, closeWithBackup } from '../backup';
import { ImportDialog } from '../Import';
import { IssueDialog } from '../Pages';
import { FilledCopyDialog } from '../FilledCopy';
import type { FillTarget } from '../../engine/boqfill';
import { ProjectBackupsDialog } from '../ProjectBackups';

export type HubStatus = 'none' | 'frozen' | 'opening' | 'ready' | 'missing';
export interface HubState { status: HubStatus; hub: ProjectSession | null; hubId: string | null; ver: number }

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const hasMirror = (s: Store) => { for (const k of s.ents.keys()) if (k.startsWith('b:')) return true; return false; };
const PUSH_MS = 1500;
/** measuring more on a take-off linked to an additional item: its figure goes to the BOQ a little later */
const MEASURE_PUSH_MS = 8000;
/** does the take-off have additional items of its own (lines it adds to the BOQ)? */
const hasAdditional = (st: { ents: Map<string, Map<string, { v: unknown }>> }) => {
  for (const [id, ent] of st.ents) if (id.startsWith('dm:') && ent.get('add')?.v === true && ent.get('del')?.v !== true) return true;
  return false;
};

/** the hub next to an open take-off: opened, backed up, pulled from and pushed to while the take-off is open */
export function useHub(o: { session: ProjectSession | null; project: OpenProject; auth: Auth; info: AppInfo; readOnly: boolean; closer?: { current: (() => Promise<void>) | null } }): HubState & { retry: () => void } {
  const { session, project, auth, info, readOnly } = o;
  const [tries, setTries] = useState(0);
  const fails = useRef(0);
  const authRef = useRef(auth); authRef.current = auth;
  const [hubId, setHubId] = useState<string | null>(null);
  const [est, setEst] = useState<string | null>(null);
  const [state, setState] = useState<HubState>({ status: 'opening', hub: null, hubId: null, ver: 0 });
  const roRef = useRef(readOnly); roRef.current = readOnly;

  // which hub (the take-off says it; a take-off from before attaches itself once its group's hub exists)
  useEffect(() => {
    if (!session) return;
    const read = () => { setHubId(hubOf(session.store)); setEst(legacyEstOf(session.store)); };
    read();
    const off = session.onChange((ids) => { if (ids.has('project')) read(); });
    return () => { off(); };
  }, [session]);

  useEffect(() => {
    if (!session) return;
    // no hub and no estimate: a BOQ copy kept (a copy from a backup) is frozen like one from before; none at all: 'none'
    if (hubId || !est) { if (!hubId) setState({ status: hasMirror(session.store) ? 'frozen' : 'none', hub: null, hubId: null, ver: 0 }); return; }
    let alive = true;
    setState({ status: 'frozen', hub: null, hubId: null, ver: 0 });
    // (frozen: kept as it was at the switch, until an administrator makes the group updatable)
    const fs = gt().fs;
    const dir = fs.join(projectsRoot(fs, auth.roots.qto), hubFolder(legacyHubId(est)));
    void fs.exists(fs.join(dir, 'project.json')).then((ok) => {
      if (!alive || !ok || roRef.current || session.readOnly) return;
      const ops = takeoffAttachOps(session.store, { id: legacyHubId(est), name: String(session.store.get('project', 'estName') ?? project.name) });
      if (ops.length) { session.needFormat(FORMAT_HUB); session.commit(ops, 'BOQ made updatable', { recordUndo: false }); }
    }).catch(() => {});
    return () => { alive = false; };
  }, [session, hubId, est]);

  // the hub session
  useEffect(() => {
    if (!session || !hubId) return;
    const fs = gt().fs;
    const dir = fs.join(projectsRoot(fs, auth.roots.qto), hubFolder(hubId));
    let alive = true;
    let hub: ProjectSession | null = null;
    let keeper: BackupKeeper | null = null;
    const offs: (() => void)[] = [];
    let pushT: ReturnType<typeof setTimeout> | null = null;
    let retryT: ReturnType<typeof setTimeout> | null = null;
    setState({ status: 'opening', hub: null, hubId, ver: 0 });
    const me = { id: project.id || session.meta.id, name: project.name, folder: base(project.dir) };
    const pull = () => {
      if (!hub || session.readOnly) return;
      const ops = pullOps(hub.store, session.store, authRef.current.wasAdmin);
      if (ops.length) { session.needFormat(FORMAT_HUB); session.commit(ops, 'BOQ copy updated', { recordUndo: false }); }
    };
    const push = () => {
      pushT = null;
      if (!hub || hub.readOnly) return;
      const att = ensureAttachedOps(hub.store, me);
      if (att.length) hub.commit(att, 'Take-off attached', { recordUndo: false });
      const ops = pushAdditionalOps(hub.store, { id: me.id, store: session.store }, authRef.current.wasAdmin);
      if (ops.length) hub.commit(ops, 'Additional items from the take-off', { recordUndo: false });
    };
    const pushSoon = (ms = PUSH_MS) => { if (pushT) clearTimeout(pushT); pushT = setTimeout(push, ms); };
    void (async () => {
      if (!(await fs.exists(fs.join(dir, 'project.json')).catch(() => false))) {
        if (!alive) return;
        setState({ status: 'missing', hub: null, hubId, ver: 0 });
        // (late on the share, or a drive not there: looked for again every 15 s)
        retryT = setTimeout(() => alive && setTries((n) => n + 1), 15_000);
        return;
      }
      const h = new ProjectSession({ fs, localFs: fs, projectDir: dir, localDir: info.localDir, user: auth.account.name, account: auth.account.username, host: info.host, readOnly: session.readOnly, adoptQueued: !session.readOnly, appVersion: info.version, dataFormat: DATA_FORMAT, markFormat: BASE_FORMAT, quiet: true });
      try { await h.open(); } catch (e) { void h.close().catch(() => {}); throw e; }
      if (!alive) { void h.close(); return; }
      hub = h;
      keeper = keepBackedUp(h, { kind: 'qto', root: auth.roots.qto, projectDir: dir, by: auth.account.username, host: info.host, app: info.version });
      let ver = 0;
      offs.push(h.onChange(() => { pull(); setState((s) => ({ ...s, ver: ++ver })); }));
      // (measuring more - shapes, a take-off's settings, a scale - changes what an additional item adds up to: it never
      // reached the BOQ until the take-off was closed - 0.23.2, DeepSeek #32. Only when there are additional items.)
      let adds = hasAdditional(session.store as never);
      offs.push(session.onChange((ids) => {
        let lines = false, measured = false;
        for (const id of ids) {
          if (id.startsWith('dm:') || id.startsWith('lk:')) { lines = true; break; }
          if (id.startsWith('sh:') || id.startsWith('ti:') || id.startsWith('op:') || id.startsWith('pg:') || id.startsWith('sr:')) measured = true;
        }
        if (lines) { adds = hasAdditional(session.store as never); pushSoon(); } else if (measured && adds) pushSoon(MEASURE_PUSH_MS);
      }));
      pull();
      push();
      fails.current = 0;
      setState({ status: 'ready', hub: h, hubId, ver: 0 });
      if (o.closer) o.closer.current = async () => { if (pushT) { clearTimeout(pushT); push(); } await closeWithBackup(h, keeper); };
    })().catch((e) => {
      gt().log('BOQ hub: ' + String(e?.message ?? e));
      if (!alive) return;
      setState({ status: 'missing', hub: null, hubId, ver: 0 });
      // looked for again too - 15 s, then longer while it keeps failing, up to 5 minutes (0.23.2, DeepSeek #7: a hub
      // that was there but could not be opened was never looked for again while the take-off stayed open)
      const wait = Math.min(300_000, 15_000 * 2 ** Math.min(fails.current++, 5));
      retryT = setTimeout(() => alive && setTries((n) => n + 1), wait);
    });
    return () => {
      alive = false;
      if (retryT) clearTimeout(retryT);
      if (pushT) { clearTimeout(pushT); push(); }
      for (const f of offs) f();
      if (o.closer) o.closer.current = null;
      if (hub) void closeWithBackup(hub, keeper);
    };
  }, [session, hubId, tries]);

  // view only changes while open: the hub follows the take-off
  useEffect(() => { state.hub?.setReadOnly(readOnly); }, [readOnly, state.hub]);
  return { ...state, retry: () => setTries((n) => n + 1) };
}

/** the box at the top of the BOQ tab */
export function HubBox(p: { st: HubState & { retry?: () => void }; session: ProjectSession; project: OpenProject; auth: Auth; info: AppInfo; readOnly: boolean; toast: (t: ReactNode) => void }) {
  const { st, session, auth, project } = p;
  const [dialog, setDialog] = useState<'import' | 'issue' | 'backups' | null>(null);
  const [combined, setCombined] = useState<{ targets: FillTarget[]; unread: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const hub = st.hub;
  const who = { username: auth.account.username, isAdmin: auth.isAdmin };
  const model = useMemo(() => (hub ? buildModel(hub.store, auth.wasAdmin) : null), [hub, st.ver]);
  const has = hub ? hasBoq(hub.store) : false;
  const mayEdit = !!hub && !p.readOnly && !hub.readOnly && canEditBoq(hub.store, who);
  const sharedWith = hub ? attachedTakeoffs(hub.store).length : 0;
  const fs = gt().fs;
  const pdir = projectsRoot(fs, auth.roots.qto);

  /** an administrator's BOQ change carries the hub's new revision in the same change (pullOps' guard) */
  const rev = () => (hub ? bumpRevOps(hub.store) : []);
  const meId = project.id || session.meta.id;
  const isOwner = getAcl(auth.accounts.store, { ...session.meta, id: meId }).owner === auth.account.username;

  /** a take-off with no BOQ yet (made before this version, or its BOQ folder was never made): make one */
  const makeHub = async (seed = false) => {
    setBusy('Making the BOQ…');
    try {
      // (the same id on every PC: two clicks at once make one hub)
      const id = st.hubId ?? ownHubId(meId);
      const made = await createHub(fs, pdir, { hubId: id, name: project.name, user: auth.account.name, account: auth.account.username, initialOps: [...(seed ? [...legacySeedOps([session.store]), ['project', 'rev', Date.now()] as Op] : []), ...attachHubOps({ id, name: project.name }, { id: meId, name: project.name, folder: base(project.dir) }).hub] });
      if (!made.meta) throw new Error('its folder on the share could not be finished');
      session.needFormat(FORMAT_HUB);
      if (takeoffAttachOps(session.store, { id, name: project.name }).length && !session.commit(takeoffAttachOps(session.store, { id, name: project.name }), 'BOQ made', { recordUndo: false })) throw new Error('this take-off is view only here');
      p.st.retry?.();
      if (!seed && !made.existed) setDialog('import');
    } catch (e: any) { p.toast('The BOQ could not be made: ' + String(e?.message ?? e)); }
    finally { setBusy(null); }
  };

  /** take-offs from before, linked to one estimate: a hub made from the freshest copy among them */
  const makeUpdatable = async () => {
    const est = legacyEstOf(session.store);
    if (!est) return makeHub(true);
    setBusy('Reading the take-offs of this BOQ…');
    try {
      const all = await listProjects(fs, auth.roots.qto, Date.now(), FORMAT.takeoff);
      const sibs: { id: string; name: string; folder: string; store: Store }[] = [];
      for (const x of all) {
        const s = x.dir === project.dir ? session.store : await readProjectStore(fs, x.dir).catch(() => null);
        // (one that can't be read could be the group's freshest copy: nothing is made until every take-off is read)
        if (!s) throw new Error(`“${x.meta.name}” can't be read from this PC right now — try again when the share is reachable`);
        if (legacyEstOf(s) === est) sibs.push({ id: x.meta.id, name: x.meta.name, folder: base(x.dir), store: s });
      }
      const name = String(session.store.get('project', 'estName') ?? project.name);
      const id = legacyHubId(est);
      const ops: Op[] = [...legacySeedOps(sibs.map((x) => x.store)), ...sibs.flatMap((x) => attachHubOps({ id, name }, x).hub), ['project', 'rev', Date.now()]];
      const made = await createHub(fs, pdir, { hubId: id, name, user: auth.account.name, account: auth.account.username, initialOps: ops });
      if (!made.meta) throw new Error('its folder on the share could not be finished');
      session.needFormat(FORMAT_HUB);
      if (!session.commit(takeoffAttachOps(session.store, { id, name }), 'BOQ made updatable', { recordUndo: false })) throw new Error('this take-off is view only here');
      p.toast(`The BOQ is updatable now — ${sibs.length} take-off${sibs.length === 1 ? '' : 's'} share it (each follows when it is next opened).`);
    } catch (e: any) { p.toast('Could not make the BOQ updatable: ' + String(e?.message ?? e)); }
    finally { setBusy(null); }
  };

  const openCombined = async () => {
    if (!hub) return;
    setBusy('Adding up the take-offs…');
    try {
      const list = attachedTakeoffs(hub.store);
      const qtos = await Promise.all(list.map(async (x) => ({ id: x.id, store: x.id === (project.id || session.meta.id) ? session.store : await readProjectStore(fs, fs.join(pdir, x.folder)).catch(() => null) })));
      const r = combinedTargets(hub.store, qtos, auth.wasAdmin);
      setCombined({ targets: r.targets, unread: r.unread });
    } finally { setBusy(null); }
  };

  let body: ReactNode = null;
  if (st.status === 'frozen') {
    body = <>
      <span>{legacyEstOf(session.store) ? 'BOQ from an earlier version, kept as it was.' : 'BOQ copy kept as it was (no BOQ to update it from).'}</span>
      {auth.isAdmin && !p.readOnly && <button className="btn sm" data-hub-updatable disabled={!!busy} onClick={makeUpdatable}>Make it updatable…</button>}
    </>;
  } else if (st.status === 'none') {
    body = <>
      <span>No BOQ yet — temporary lines work meanwhile.</span>
      {!p.readOnly && (auth.isAdmin || isOwner) && <button className="btn sm" data-hub-make disabled={!!busy} onClick={() => makeHub()}>Import the BOQ…</button>}
    </>;
  } else if (st.status === 'missing') {
    body = <>
      <span className="warn">The BOQ’s folder can’t be reached from this PC — the copy here is used meanwhile (looked for again by itself).</span>
      {(auth.isAdmin || isOwner) && !p.readOnly && <button className="btn sm ghost" data-hub-remake disabled={!!busy} title="Only if the BOQ's folder is really gone (not just an unreachable drive)" onClick={() => makeHub(true)}>Make it again…</button>}
    </>;
  } else if (st.status === 'opening') {
    body = <span className="faint">Opening the BOQ…</span>;
  } else if (hub) {
    body = <>
      <span>BOQ <b>{hub.meta.name}</b>{sharedWith > 1 ? <> · shared by {sharedWith} take-offs</> : null}</span>
      {mayEdit && !has && <button className="btn sm primary" data-hub-import onClick={() => setDialog('import')}>Import the BOQ…</button>}
      {mayEdit && has && <button className="btn sm" data-hub-issue title="A new issue of the BOQ: new and changed lines, removed ones marked" onClick={() => setDialog('issue')}>New issue…</button>}
      {mayEdit && has && <button className="btn sm ghost" data-hub-addmore title="More bills from other files" onClick={() => setDialog('import')}>Add bills…</button>}
      {has && !auth.isAdmin && <span className="faint" title="BOQ updates are made by an administrator">· updates: administrators</span>}
      {auth.isAdmin && <button className="btn sm ghost" data-hub-backups title="The BOQ's own backups: roll it back (every take-off on it follows)" onClick={() => setDialog('backups')}>BOQ backups…</button>}
      {has && model && (model.imports?.size ?? 0) > 0 && <button className="btn sm ghost" data-hub-combined disabled={!!busy} title="The consultant's Excel BOQ with every take-off on this BOQ added up (their file is never changed)" onClick={openCombined}>Combined filled copy…</button>}
    </>;
  }
  return (
    <div className="qto-hubbox" data-hub={st.status}>
      {body}
      {busy && <span className="faint"><span className="dot busy" /> {busy}</span>}
      {dialog === 'import' && hub && model && (
        <ImportDialog session={hub} model={model} user={auth.account.name} toast={(t) => p.toast(t)} alsoOps={rev} onClose={() => setDialog(null)} />
      )}
      {dialog === 'issue' && hub && model && (
        <IssueDialog model={model} store={hub.store} user={auth.account.name}
          onApply={(ops, _undo, what) => { if (ops.length) hub.commit([...ops, ...rev()], what, { recordUndo: false }); }}
          onReveal={() => {}} onClose={() => setDialog(null)} />
      )}
      {dialog === 'backups' && hub && (
        <ProjectBackupsDialog title="Backups of this BOQ" session={hub} project={{ dir: hub.projectDir, name: hub.meta.name, id: hub.meta.id, readOnly: false, kind: 'qto' }} auth={auth} info={p.info} readOnly={p.readOnly || hub.readOnly} toast={(t) => p.toast(t)} skip={HUB_ROLLBACK_SKIP} alsoOps={rev} onClose={() => setDialog(null)} />
      )}
      {combined && (
        <FilledCopyDialog targets={combined.targets} from="combined" note={combined.unread ? `${combined.unread} take-off${combined.unread === 1 ? '' : 's'} on this BOQ could not be read — their quantities are missing.` : undefined} onClose={() => setCombined(null)} />
      )}
    </div>
  );
}
