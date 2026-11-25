// Administrators: People (accounts, roles, passwords), Activity,
// and who may see / edit each project.
import { useEffect, useMemo, useState } from 'react';
import type { Auth } from './App';
import { colorFor } from '../engine/ids';
import {
  listAccounts, newAccountOps, resetPasswordOps, userId, normUsername, suggestUsername, firstName,
  MAX_ADMINS, ROLE_LABEL, type Account, type Role,
} from '../engine/accounts';
import {
  accessFor, getAcl, setEveryoneOps, setOwnerOps, setPersonAccessOps, activityLog,
  ACCESS_LABEL, type Access, type ActivityEvent,
} from '../engine/access';
import type { ProjectEntry } from '../engine/projects';
import { setRootsOps, setBackupFolderOps, trustedGet, CFG } from '../engine/accounts';
import { backupDirOf, type BackupKind } from '../engine/backups';
import { FORMAT, formatOf } from '../engine/legacy';
import { checkNewTeamFolder, clearOldTeamFolder, countBackupSets, inside, moveBackupSets, moveTeamFolder, movedAlready, onDisk, samePath, stillHoldsAccounts, whoIsThere } from '../engine/teamfolder';
import { backupFs } from './backup';
import { gt } from './api';
import { IFolder } from './icons';
import { initials, ago } from './format';
import { ISearch } from './icons';
import { toUnc } from './takeoff/drawings';
import { cmpVersion } from '../engine/version';
import { useEscClose } from './escape';

/** the first version that follows a moved team folder (and knows chosen backups folders) */
const FOLLOWS_FROM = '0.13.0';
/** a folder on this PC's own drive (not a server): other PCs can't reach it */
const localOnly = (p: string | null) => !!p && /^[A-Za-z]:/.test(p);

/** Re-render when the accounts folder changes (another admin, another PC). */
function useAccountsVersion(auth: Auth) {
  const [, setVer] = useState(0);
  useEffect(() => { const off = auth.accounts.onChange(() => setVer((v) => v + 1)); return () => { off(); }; }, [auth.accounts]);
}

/**
 * Setup codes handed out in this window: kept (in memory only, never on disk: the accounts folder
 * holds just a scrambled form of each) until Done, sign-out, or the person has used it - so adding
 * the next person or looking at another tab doesn't lose one before it is noted down.
 */
interface Issued { name: string; username: string; code: string; reset: boolean; at: number; hash: string }
let issuedCodes: Issued[] = [];
const issuedListeners = new Set<() => void>();
const issuedChanged = () => issuedListeners.forEach((f) => f());
export function forgetIssuedCodes() { issuedCodes = []; issuedChanged(); }
function useIssued() {
  const [, setV] = useState(0);
  useEffect(() => { const f = () => setV((v) => v + 1); issuedListeners.add(f); return () => { issuedListeners.delete(f); }; }, []);
  return issuedCodes;
}
const setupHash = (ops: [string, string, unknown][]) => String(ops.find(([, f]) => f === 'setup')?.[2] ?? '');

const effRole = (a: Account, admins: Set<string>): Role => (admins.has(a.username) ? 'admin' : a.role === 'admin' ? 'qs' : a.role);

// ---------------------------------------------------------------- People
export function PeopleTab({ auth, projects }: { auth: Auth; projects: ProjectEntry[] }) {
  useAccountsVersion(auth);
  const store = auth.accounts.store;
  const accounts = listAccounts(store);
  // the administrators who really are (at most 3: two promotions at the same moment on two PCs can
  // write a 4th, who then acts as a quantity surveyor - the seats count what counts)
  const activeAdmins = accounts.filter((a) => a.active && auth.admins.has(a.username));
  const seatsFull = activeAdmins.length >= MAX_ADMINS;
  const me = auth.account.username;
  // the accounts can't be changed from this PC: nothing is offered that would only look done
  const locked = auth.accounts.readOnly || !!auth.accounts.newerApp;
  const notSaved = 'Not saved: the accounts are view only on this PC (or a newer version of the app wrote them). Update the app, then try again.';

  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [touched, setTouched] = useState(false);
  const [role, setRole] = useState<Role>('qs');
  const [err, setErr] = useState<string | null>(null);
  const issued = useIssued();
  const issue = (x: Issued) => { issuedCodes = [x, ...issuedCodes.filter((c) => c.username !== x.username)]; issuedChanged(); };
  const dropIssued = (username: string) => { issuedCodes = issuedCodes.filter((c) => c.username !== username); issuedChanged(); };
  const [busy, setBusy] = useState(false);
  const [projFor, setProjFor] = useState<Account | null>(null);
  const [renaming, setRenaming] = useState<Account | null>(null);
  const [q, setQ] = useState('');

  const u = normUsername(touched ? username : suggestUsername(name));
  const commit = (ops: Parameters<typeof auth.accounts.commit>[0], label: string) => auth.accounts.commit(ops, label);

  const add = async () => {
    setErr(null);
    if (!name.trim()) return setErr('Enter the person’s full name.');
    if (!u) return setErr('Enter a username.');
    if (accounts.some((a) => a.username === u)) return setErr(`The username “${u}” is already taken.`);
    if (role === 'admin' && seatsFull) return setErr(`All ${MAX_ADMINS} administrator seats are used. Add them as a quantity surveyor, or make an administrator a quantity surveyor first.`);
    // take the values and clear the form first: hashing the code takes a moment, and
    // whatever is typed meanwhile belongs to the next person
    const person = { username: u, name: name.trim(), role };
    const typed = { name, username, touched };
    setBusy(true);
    setName(''); setUsername(''); setTouched(false); setRole('qs');
    const { ops, code } = await newAccountOps(me, person);
    // a code is handed out only for an account that was written (BH-010)
    if (!commit(ops, 'Add person')) {
      setBusy(false);
      setErr(notSaved);
      // what was typed comes back (unless the next person is being typed already)
      setName((x) => x || typed.name); setUsername((x) => x || typed.username); setTouched((x) => x || typed.touched); setRole(person.role);
      return;
    }
    issue({ name: person.name, username: person.username, code, reset: false, at: Date.now(), hash: setupHash(ops) });
    setBusy(false);
  };

  const reset = async (a: Account) => {
    setErr(null);
    setBusy(true);
    const { ops, code } = await resetPasswordOps(a.username);
    // the old password still works if this was not written: no new code then
    if (!commit(ops, a.pw ? 'Reset password' : 'New setup code')) { setBusy(false); setErr(notSaved); return; }
    issue({ name: a.name, username: a.username, code, reset: true, at: Date.now(), hash: setupHash(ops) });
    setBusy(false);
  };

  const setRoleFor = (a: Account, r: Role) => {
    setErr(null);
    if (a.active && a.role === 'admin' && r !== 'admin' && activeAdmins.length <= 1) return setErr('There must always be at least one active administrator.');
    if (r === 'admin' && a.role !== 'admin' && seatsFull) return setErr(`All ${MAX_ADMINS} administrator seats are used. Make one of them a quantity surveyor first.`);
    if (!commit([[userId(a.username), 'role', r]], r === 'admin' ? 'Made administrator' : r === 'viewer' ? 'Made viewer' : 'Made quantity surveyor')) setErr(notSaved);
  };

  const setActive = (a: Account, active: boolean) => {
    setErr(null);
    if (!active && a.username === me) return setErr('You can’t deactivate yourself.');
    if (!active && a.role === 'admin' && activeAdmins.length <= 1) return setErr('There must always be at least one active administrator.');
    if (active && a.role === 'admin' && seatsFull) return setErr(`All ${MAX_ADMINS} administrator seats are used. Change the role first, or free a seat.`);
    if (!commit([[userId(a.username), 'active', active]], active ? 'Reactivated' : 'Deactivated')) setErr(notSaved);
  };

  // a code still shown only while it can be used: not once the person has chosen a password, nor
  // after someone gave them a newer code (or they were deactivated)
  const live = issued.filter((c) => {
    const a = accounts.find((x) => x.username === c.username);
    return !!a && a.active && !a.pw && (!c.hash || a.setup === c.hash);
  });
  useEffect(() => {
    if (live.length !== issued.length) { issuedCodes = issuedCodes.filter((c) => live.includes(c)); issuedChanged(); }
  });

  const projCount = (a: Account) => projects.filter((p) => accessFor(store, auth.admins, a, p.meta, accounts) !== 'none').length;
  const shown = accounts.filter((a) => !q.trim() || (a.name + ' ' + a.username).toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="sheet">
      <div className="toolbar addbar">
        <input className="input" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <input className="input" placeholder="username" value={u} onChange={(e) => { setTouched(true); setUsername(e.target.value); }} />
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="qs">Quantity surveyor</option>
          <option value="admin" disabled={seatsFull}>Administrator{seatsFull ? ' (seats full)' : ''}</option>
        </select>
        <button className="btn primary" disabled={busy || locked} onClick={add} title={locked ? notSaved : undefined}>Add person</button>
        <div className="grow" />
        <div className="search sm">
          <ISearch />
          <input className="input" placeholder="Find a person" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="paper-scroll">
        <div className="sheet-note">
          <b>{activeAdmins.length} of {MAX_ADMINS}</b> administrator seats used. Quantity surveyors: no limit.
          Administrators update the BOQ and see every project; quantity surveyors start take-offs, measure and link, and see their own projects and the ones shared with them.
        </div>
        <FoldersCard auth={auth} />
        {locked && !err && <p className="err" style={{ margin: '10px 16px' }}>The accounts are view only on this PC (or a newer version of the app wrote them): people can’t be added or changed here until the app is updated.</p>}
        {err && <p className="err" style={{ margin: '10px 16px' }}>{err}</p>}
        {live.map((c) => (
          <div className="codecard" key={c.username} data-code-for={c.username}>
            <div>
              <div className="k">{c.reset ? 'New setup code' : 'Setup code'} for <b>{c.name}</b> <span className="faint">· {ago(c.at)}</span></div>
              <div className="code">{c.code}</div>
              <div className="how">Give this to {firstName(c.name)}. They open Goldline Takeoff, type the username <b>{c.username}</b>, press <b>Sign in</b> with the password empty, enter this code and choose a password. The code works once. It stays here until you press Done or sign out; if it gets lost, press <b>New setup code</b> on their row.</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button className="btn" onClick={async (e) => { const b = e.currentTarget; const ok = await copyText(`Goldline Takeoff\nName: ${c.name}\nUsername: ${c.username}\nSetup code: ${c.code}`); b.textContent = ok ? 'Copied' : 'Not copied — write the code down'; setTimeout(() => { b.textContent = 'Copy'; }, 2500); }}>Copy</button>
              <button className="btn ghost" onClick={() => dropIssued(c.username)}>Done</button>
            </div>
          </div>
        ))}
        <table className="register people">
          <thead>
            <tr>
              <th>Person</th>
              <th style={{ width: 170 }}>Role</th>
              <th style={{ width: 170 }}>Status</th>
              <th style={{ width: 200 }}>Last sign-in</th>
              <th style={{ width: 110 }}>Projects</th>
              <th style={{ width: 290 }} />
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => {
              const status = !a.active ? 'Deactivated' : !a.pw ? 'Waiting for first sign-in' : 'Active';
              const isAdm = auth.admins.has(a.username);
              return (
                <tr key={a.username} className={'urow' + (a.active ? '' : ' off')} data-user={a.username}>
                  <td>
                    <span className="person">
                      <span className="avatar" style={{ background: colorFor(a.name) }}>{initials(a.name)}</span>
                      <span>
                        <span className="n">{a.name}{a.username === me ? <span className="you"> (you)</span> : null}</span>
                        <span className="u">{a.username}</span>
                      </span>
                    </span>
                  </td>
                  <td>
                    <select className="input sm" value={effRole(a, auth.admins)} onChange={(e) => setRoleFor(a, e.target.value as Role)} disabled={!a.active || locked} title={locked ? notSaved : undefined}>
                      <option value="qs">Quantity surveyor</option>
                      {a.role === 'viewer' && <option value="viewer">Viewer (view only)</option>}
                      <option value="admin" disabled={seatsFull && a.role !== 'admin'}>Administrator</option>
                    </select>
                  </td>
                  <td><span className={'status ' + (status === 'Active' ? 'ok' : status === 'Deactivated' ? 'off' : 'wait')}>{status}</span></td>
                  <td className="muted">{a.lastLogin ? <>{ago(a.lastLogin)}{a.lastHost ? <span className="faint"> on {a.lastHost}</span> : null}</> : 'never'}</td>
                  <td>
                    <button className="linkbtn" onClick={() => setProjFor(a)} title={isAdm ? 'Administrators see every project' : 'Choose which projects they can see or edit'}>
                      {isAdm ? 'all' : `${projCount(a)} of ${projects.length}`}
                    </button>
                  </td>
                  <td className="r acts">
                    <button className="btn sm ghost" disabled={locked} title={locked ? notSaved : undefined} onClick={() => setRenaming(a)}>Rename</button>
                    {a.active && (a.pw
                      ? <button className="btn sm" disabled={busy || locked} onClick={() => reset(a)} title="Clears their password and gives you a new setup code">Reset password</button>
                      : <button className="btn sm" disabled={busy || locked} onClick={() => reset(a)} title="The code you gave them stops working; give them this new one">New setup code</button>)}
                    {a.active ? (
                      <button className="btn sm danger" disabled={a.username === me || locked} title={locked ? notSaved : undefined} onClick={() => setActive(a, false)}>Deactivate</button>
                    ) : (
                      <button className="btn sm" disabled={locked} title={locked ? notSaved : undefined} onClick={() => setActive(a, true)}>Reactivate</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {projFor && <PersonAccessDialog auth={auth} person={projFor} projects={projects} onClose={() => setProjFor(null)} />}
      {renaming && <RenameDialog person={renaming} onClose={() => setRenaming(null)} onSave={(n) => { if (!commit([[userId(renaming.username), 'name', n]], `Renamed ${renaming.name} to ${n}`)) setErr(notSaved); setRenaming(null); }} />}
    </div>
  );
}

function RenameDialog({ person, onClose, onSave }: { person: Account; onClose: () => void; onSave: (name: string) => void }) {
  const [n, setN] = useState(person.name);
  const esc = useEscClose(onClose);
  const ok = n.trim() && n.trim() !== person.name;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={esc.onKeyDown}>
      <div className="modal" ref={esc.box} tabIndex={-1}>
        <h2>Rename {person.name}</h2>
        <p className="sub">The username <b>{person.username}</b> stays the same, so their sign-in and history are not affected.</p>
        <div className="row"><label>Full name</label><input className="input" autoFocus value={n} onChange={(e) => setN(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok && onSave(n.trim())} /></div>
        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ok} onClick={() => onSave(n.trim())}>Save name</button>
        </div>
      </div>
    </div>
  );
}

/** Where the team folder, the projects and the backups are kept (they can be on different servers). */
function FoldersCard({ auth }: { auth: Auth }) {
  const team = auth.roots.team;
  const r = auth.roots;
  const fs = gt().fs;
  const [open, setOpen] = useState(false);
  const [bak, setBak] = useState<{ which: 'team'; to: string | null } | null>(null);
  const [moving, setMoving] = useState(false);
  const [clearing, setClearing] = useState<string | null>(null);
  const movedFrom = trustedGet(auth.accounts.store, CFG, 'movedFrom');
  const [oldCopy, setOldCopy] = useState(false);
  useEffect(() => {
    let alive = true;
    if (typeof movedFrom !== 'string' || !movedFrom) { setOldCopy(false); return; }
    stillHoldsAccounts(fs, movedFrom).then((x) => alive && setOldCopy(x)).catch(() => alive && setOldCopy(false));
    return () => { alive = false; };
  }, [movedFrom, open]);

  /** a folder picked here, as the server's own name (\\server\share\…), not this PC's drive letter */
  const pickUnc = async (title: string, start: string, create = false) => {
    const picked = await gt().pickDir({ title, start, create });
    if (!picked) return null;
    // on another PC the same letter can be another share (or nothing)
    const unc = toUnc(picked, await gt().drives().catch(() => ({})));
    return unc || picked;
  };
  // (a setting that can't be saved says so - it was dropped without a word, 0.23.2, DeepSeek #21)
  const [folderErr, setFolderErr] = useState('');
  const saveRoots = (o: Parameters<typeof setRootsOps>[0]) => setFolderErr(auth.accounts.commit(setRootsOps(o), 'Folders') ? '' : 'Not saved: the accounts are view only on this PC (or a newer version of the app wrote them). Update the app, then try again.');
  const pick = async () => {
    const p = await pickUnc('Folder for take-off projects', r.qto);
    if (!p) return;
    saveRoots({ qto: p });
  };
  const reset = () => saveRoots({ qto: null });
  const pickBak = async () => {
    const p = await pickUnc('Folder for the backups of take-offs and the accounts', r.bak.team ?? fs.join(r.qto, '_backups'), true);
    if (p) setBak({ which: 'team', to: p });
  };
  const usual = () => (r.qto === team ? fs.join(team, '_backups') : `${fs.join(r.qto, '_backups')} and ${fs.join(team, '_backups')}`);
  return (
    <div className="folders">
      <button className="linkbtn" onClick={() => setOpen((x) => !x)}><IFolder /> Where things are kept {open ? '▴' : '▾'}</button>
      {open && (
        <div className="fgrid">
          <span className="k">Team folder (accounts)</span>
          <code title={team}>{team}</code>
          <span><button className="btn sm" onClick={() => setMoving(true)}>Move…</button></span>
          {typeof movedFrom === 'string' && movedFrom && oldCopy && (
            <p className="fnote" style={{ gridColumn: '1 / -1' }}>
              Moved here from <code>{movedFrom}</code>, which still holds a copy of the accounts. Clear it once everyone has used the app since the move.{' '}
              <button className="btn sm" onClick={() => setClearing(movedFrom)}>Clear the old copy…</button>
            </p>
          )}
          <span className="k">Take-off projects</span>
          <code title={r.qto}>{r.qto}</code>
          <span>
            <button className="btn sm" onClick={() => pick()}>Change…</button>
            {r.qto !== team && <button className="btn sm ghost" onClick={() => reset()}>Use team folder</button>}
            {folderErr && <span className="warn" role="alert"> {folderErr}</span>}
          </span>
          <span className="k">Backups: take-offs and accounts</span>
          <code title={r.bak.team ?? usual()}>{r.bak.team ?? <span className="faint">{usual()}</span>}</code>
          <span>
            <button className="btn sm" onClick={() => pickBak()}>Change…</button>
            {r.bak.team && <button className="btn sm ghost" onClick={() => setBak({ which: 'team', to: null })}>Usual place</button>}
          </span>
          <p className="hint" style={{ gridColumn: '1 / -1', margin: '4px 0 0' }}>
            Changing the projects folder does not move existing projects. Backups are written by whoever has a project open, so everyone who edits
            needs to be able to write in the backups folder (QS too for the take-offs and accounts one).
          </p>
        </div>
      )}
      {bak && <BackupFolderDialog auth={auth} which={bak.which} to={bak.to} onClose={() => setBak(null)} />}
      {moving && <MoveTeamDialog auth={auth} onClose={() => setMoving(false)} />}
      {clearing && <ClearOldCopyDialog auth={auth} old={clearing} onClose={() => { setClearing(null); setOldCopy(false); }} />}
    </div>
  );
}

/** a new place for one kind of backups: the setting, and (if wanted) the backups made so far moved there */
function BackupFolderDialog({ auth, which, to, onClose }: { auth: Auth; which: 'team'; to: string | null; onClose: () => void }) {
  const fs = gt().fs;
  const r = auth.roots;
  // what goes where: [from, to, kinds]
  const pairs = useMemo(() => {
    const out: { from: string; to: string; kinds: BackupKind[] }[] = [];
    const add = (from: string, dest: string, kinds: BackupKind[]) => {
      const same = out.find((x) => samePath(x.from, from) && samePath(x.to, dest));
      if (same) same.kinds.push(...kinds); else if (!samePath(from, dest)) out.push({ from, to: dest, kinds });
    };
    add(r.bak.team ?? fs.join(r.qto, '_backups'), to ?? fs.join(r.qto, '_backups'), ['qto']);
    add(r.bak.team ?? fs.join(r.team, '_backups'), to ?? fs.join(r.team, '_backups'), ['accounts']);
    return out;
  }, [which, to]);
  const [count, setCount] = useState<number | null>(null);
  const [move, setMove] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const esc = useEscClose(onClose, busy);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const bad = to && [r.team, r.qto].some((x) => samePath(x, to)) ? 'Choose a folder of its own for the backups (a new folder inside one of these is fine).'
    : to && inside(to, fs.join(r.team, '_accounts')) ? 'The backups can’t go inside the accounts folder.'
      : pairs.some((p) => inside(p.to, p.from) || inside(p.from, p.to)) ? 'The new backups folder can’t be inside the old one (or the other way round).' : null;
  useEffect(() => {
    let alive = true;
    Promise.all(pairs.map((p) => countBackupSets(fs, p.from, p.kinds))).then((n) => alive && setCount(n.reduce((a, b) => a + b, 0))).catch(() => alive && setCount(0));
    return () => { alive = false; };
  }, [pairs]);
  const what = 'take-off projects and the accounts';
  const go = async () => {
    if (busy || bad) return;
    setErr(null);
    try {
      if (to) {
        setBusy('Checking the folder…');
        if (!(await fs.exists(to))) throw new Error('That folder can’t be reached from this PC.');
        // a quick write: everyone's backups will be written there
        const probe = fs.join(to, '.gt-write-test-' + Date.now().toString(36));
        await fs.writeAtomic(probe, 'ok');
        await fs.remove(probe).catch(() => {});
        // the same folder under another name (S:\ and \\server\share) counts as the same
        for (const x of [r.team, r.qto]) {
          const rel = await onDisk(fs, to, x).catch(() => null);
          if (rel === 'same' || rel === 'b-in-a') throw new Error('That is a projects or team folder (under another name), or holds one. Choose a folder of its own for the backups.');
        }
        if ((await onDisk(fs, fs.join(r.team, '_accounts'), to).catch(() => null)) === 'same') throw new Error('The backups can’t go inside the accounts folder.');
      }
      if (!auth.accounts.commit(setBackupFolderOps(which, to, r), to ? `Backups of ${what} kept in ${to}` : `Backups of ${what} back in the usual place`)) {
        throw new Error('The setting could not be saved from this PC (view only, or a newer version wrote the accounts). Nothing was changed.');
      }
      let moved = 0, left = 0;
      let why = '';
      if (move && count) {
        const bfs = backupFs();
        for (const p of pairs) {
          const res = await moveBackupSets(bfs, p.from, p.to, p.kinds, (d, t) => setBusy(`Moving the backups… ${d} of ${t}`));
          moved += res.moved;
          left += res.left;
          if (res.error && !why) why = res.error;
        }
      }
      setBusy(null);
      setDone(`Backups of ${what} now go to ${to ?? 'the usual place'}.` + (moved ? ` ${moved} project backup folder${moved > 1 ? 's' : ''} moved there.` : '') + (left ? ` ${left} could not be moved completely${why ? ` (${why})` : ''}: what is left stays in the old place (still listed under Backups…).` : ''));
    } catch (e: any) {
      setBusy(null);
      setErr(String(e?.message ?? e));
    }
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()} onKeyDown={esc.onKeyDown}>
      <div className="modal" ref={esc.box} tabIndex={-1}>
        <h2>Backups of {what}</h2>
        {done ? (
          <>
            <p className="sub">{done}</p>
            <div className="actions"><button className="btn primary" autoFocus onClick={onClose}>Close</button></div>
          </>
        ) : (
          <>
            <p className="sub">
              From now on they are written to <b className="mono">{to || pairs.map((p) => p.to).join(' and ') || 'the usual place'}</b>
              {to ? '' : ' (the usual place)'}. Every PC uses the new place within seconds.
            </p>
            {bad && <p className="err">{bad}</p>}
            {!bad && localOnly(to) && <p className="warnline">This folder is on this PC’s own drive — other PCs can’t write their backups there. Choose a folder on the server.</p>}
            {count !== null && count > 0 && (
              <label className="check" style={{ margin: '4px 0 10px' }}>
                <input type="checkbox" checked={move} onChange={(e) => setMove(e.target.checked)} />
                Move the backups made so far ({count} project{count > 1 ? 's' : ''}) to the new place — otherwise they stay where they are (still restorable).
              </label>
            )}
            <p className="hint">Whoever has a project open writes its backup, so everyone who edits these projects must be able to write in this folder. Someone who can’t still works normally; their copy of the backup just isn’t written (it says so in their log).</p>
            {err && <p className="err">{err}</p>}
            <div className="actions">
              <button className="btn ghost" disabled={!!busy} onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={!!busy || !!bad || count === null} onClick={go}>{busy ?? (to ? 'Use this folder' : 'Use the usual place')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** the team folder (accounts, their backups, the newest release) moved to another folder; everyone follows */
function MoveTeamDialog({ auth, onClose }: { auth: Auth; onClose: () => void }) {
  const fs = gt().fs;
  const from = auth.roots.team;
  const [to, setTo] = useState<string | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const esc = useEscClose(onClose, busy);
  const [err, setErr] = useState<string | null>(null);
  const already = movedAlready(auth.accounts.store, from);
  const locked = auth.accounts.readOnly || !!auth.accounts.newerApp;
  const choose = async () => {
    const picked = await gt().pickDir({ title: 'New team folder', start: from, create: true });
    if (!picked) return;
    const unc = toUnc(picked, await gt().drives().catch(() => ({}))) || picked;
    setTo(unc);
    setErr(null);
    setWhy(await checkNewTeamFolder(fs, from, unc, auth.roots).catch((e) => String(e?.message ?? e)));
  };
  const go = async () => {
    if (!to || busy || why || already || locked) return;
    setErr(null);
    try {
      const host = (await gt().info()).host;
      // the projects stay in the old folder: written down as every PC can reach it, not this PC's drive letter
      const pinAs = toUnc(from, await gt().drives().catch(() => ({}))) || from;
      const r = await moveTeamFolder({
        fs: backupFs(), from, to, pinAs, roots: auth.roots, host,
        by: { username: auth.account.username, name: auth.account.name },
        oldStore: auth.accounts.store,
        commitOld: (ops, label) => !!auth.accounts.commit(ops, label),
        step: (t) => setBusy(t),
      });
      // moved without a release (the old folder had none, or its latest.json can't be read): said
      if (r.releaseNote) setErr(r.releaseNote);
      setBusy('Done — switching this PC over…');
      // the switch closes this window's lists; should it not come, the dialog can still be closed
      setTimeout(() => setBusy(null), 15000);
    } catch (e: any) {
      setBusy(null);
      setErr(String(e?.message ?? e));
    }
  };
  const pinned = [auth.roots.qto === from ? 'take-off' : ''].filter(Boolean);
  // people whose last sign-in was with a version that doesn't follow a move
  const behind = listAccounts(auth.accounts.store).filter((a) => a.active && a.lastLogin && (!a.lastApp || cmpVersion(a.lastApp, FOLLOWS_FROM) < 0));
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()} onKeyDown={esc.onKeyDown}>
      <div className="modal wide" ref={esc.box} tabIndex={-1}>
        <h2>Move the team folder</h2>
        <p className="sub">
          The team folder is where everyone signs in. Moving it copies the <b>accounts</b> (people, passwords, access, the folders on the project lists)
          {auth.roots.bak.team ? '' : <>, their <b>backups</b></>} and the <b>newest release</b> (for updates and the setup) to the new folder.
          Every PC then switches over by itself: at once on the project list, after the open project is closed, or at its next start.
        </p>
        <ul className="sub" style={{ margin: '0 0 10px 18px', padding: 0 }}>
          <li>The projects stay where they are{pinned.length ? <> — the {pinned.join(' and ')} folder{pinned.length > 1 ? 's' : ''} stay{pinned.length > 1 ? '' : 's'} at <code>{from}</code></> : null}.</li>
          <li>Everyone — QS too — must be able to read and write the new folder. Ask IT to set that up first.</li>
          <li>The old folder keeps a copy of the accounts until you clear it (Where things are kept, after everyone has moved).</li>
        </ul>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 4px', minWidth: 0 }}>
          <button className="btn" disabled={!!busy} onClick={choose}><IFolder /> {to ? 'Choose another folder…' : 'Choose the new folder…'}</button>
          {to && <code className="mono" title={to} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{to}</code>}
        </div>
        {already && <p className="err">The team folder has been moved to {already} already. To move it again, do it from there.</p>}
        {locked && <p className="err">The accounts are view only on this PC (or a newer version wrote them): update first.</p>}
        {why && <p className="err">{why}</p>}
        {!why && localOnly(to) && <p className="warnline">This folder is on this PC’s own drive — other PCs can’t reach it. Choose a folder on the server.</p>}
        {behind.length > 0 && (
          <p className="warnline">
            Not seen on {FOLLOWS_FROM} or later yet: {behind.slice(0, 8).map((a) => `${a.name}${a.lastApp ? ` (${a.lastApp})` : ''}`).join(', ')}{behind.length > 8 ? ` and ${behind.length - 8} more` : ''}.
            Older versions don’t follow a move: they stay in the old folder until updated. Best to let everyone update first.
          </p>
        )}
        {err && <p className="err">{err}</p>}
        {busy && <p className="sub"><span className="dot busy" /> {busy}</p>}
        <div className="actions">
          <button className="btn ghost" disabled={!!busy} onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!to || !!why || !!busy || !!already || locked} onClick={go}>Move the team folder</button>
        </div>
      </div>
    </div>
  );
}

/** after a move: the old copy of the accounts removed (what only it holds is brought over first) */
function ClearOldCopyDialog({ auth, old, onClose }: { auth: Auth; old: string; onClose: () => void }) {
  const fs = gt().fs;
  const [busy, setBusy] = useState(false);
  const esc = useEscClose(onClose, busy);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // who still works in the old folder (a project open, can't reach this one, an older version)
  const [there, setThere] = useState<{ name: string; host: string }[] | null>(null);
  const look = () => { whoIsThere(fs, old).then(setThere).catch(() => setThere([])); };
  useEffect(() => { look(); const t = setInterval(look, 10000); return () => clearInterval(t); }, [old]);
  const behind = listAccounts(auth.accounts.store).filter((a) => a.active && a.lastLogin && Date.now() - a.lastLogin < 30 * 86400000 && (!a.lastApp || cmpVersion(a.lastApp, FOLLOWS_FROM) < 0));
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const now = await whoIsThere(fs, old);
      if (now.length) { setThere(now); throw new Error('Someone is still working in the old folder: wait until they have switched over.'); }
      const r = await clearOldTeamFolder(backupFs(), old, auth.roots.team, backupDirOf(fs, auth.roots.team, 'accounts', '', '', auth.roots.bak.team));
      auth.accounts.commit([[CFG, 'movedFrom', null]], `Old copy of the accounts cleared from ${old}`);
      setDone(`Cleared${r.changes ? ` (${r.changes} last change${r.changes > 1 ? 's' : ''} brought over first)` : ''}. A note stays there pointing to this folder, so a PC that has been off since still finds its way.` + (r.left ? ` ${r.left} file${r.left > 1 ? 's' : ''} could not be removed (in use) - they no longer count.` : ''));
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
    setBusy(false);
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()} onKeyDown={esc.onKeyDown}>
      <div className="modal" ref={esc.box} tabIndex={-1}>
        <h2>Clear the old copy of the accounts</h2>
        {done ? <p className="sub">{done}</p> : (
          <p className="sub">
            Removes the accounts (and their backups) from <b className="mono">{old}</b>. Any change that is still only there is copied here first.
            Do this once everyone has used the app since the move. The releases and the projects there are not touched.
          </p>
        )}
        {!done && there && there.length > 0 && <p className="warnline">Still working there now: {there.map((p) => `${p.name} (${p.host})`).join(', ')}. Clearing waits until they have switched over (when they close their project).</p>}
        {!done && behind.length > 0 && <p className="warnline">Recently signed in with a version before {FOLLOWS_FROM}: {behind.slice(0, 8).map((a) => a.name).join(', ')}. Those PCs stay with the old folder until they update; once it is cleared they can’t sign in there.</p>}
        {err && <p className="err">{err}</p>}
        <div className="actions">
          {done ? <button className="btn primary" autoFocus onClick={onClose}>Close</button> : (
            <>
              <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
              <button className="btn danger" disabled={busy || !there || there.length > 0} onClick={go}>{busy ? 'Clearing…' : 'Clear the old copy'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Access dialogs
const ACCESS_OPTS: Access[] = ['none', 'view', 'edit'];
const LOCKED_ACCESS = 'The accounts are view only on this PC (or a newer version of the app wrote them): access can’t be changed here until the app is updated.';

function AccessSeg({ value, onChange, max = 'edit', disabled }: { value: Access; onChange: (a: Access) => void; max?: Access; disabled?: boolean }) {
  return (
    <div className="seg">
      {ACCESS_OPTS.map((a) => (
        <button key={a} className={value === a ? 'on' : ''} disabled={disabled || (max === 'view' && a === 'edit')} onClick={() => value !== a && onChange(a)}>
          {a === 'none' ? 'None' : ACCESS_LABEL[a]}
        </button>
      ))}
    </div>
  );
}

/** Who may see / edit one project. */
export function AccessDialog({ auth, project, onClose }: { auth: Auth; project: ProjectEntry; onClose: () => void }) {
  useAccountsVersion(auth);
  const esc = useEscClose(onClose);
  const store = auth.accounts.store;
  const accounts = listAccounts(store).filter((a) => a.active);
  const p = project.meta;
  const acl = getAcl(store, p, accounts);
  const nameOf = (u: string) => accounts.find((a) => a.username === u)?.name ?? u;
  const pname = p.name;
  const commit = (ops: Parameters<typeof auth.accounts.commit>[0], label: string) => auth.accounts.commit(ops, label);
  // the accounts can't be changed from this PC: nothing is offered that would only look done (BH-039)
  const locked = auth.accounts.readOnly || !!auth.accounts.newerApp;

  const setOwner = (u: string) => commit(setOwnerOps(p.id, u), `Made ${nameOf(u)} owner of ${pname}`);
  const setEveryone = (a: Access) => commit(setEveryoneOps(p.id, a), a === 'none' ? `Stopped sharing ${pname} with everyone` : `Shared ${pname} with everyone (${a})`);
  const setPerson = (u: string, a: Access) =>
    commit(setPersonAccessOps(p.id, u, a), a === 'none' ? `Removed ${nameOf(u)}'s access to ${pname}` : `Gave ${nameOf(u)} ${a} access to ${pname}`);

  const others = accounts.filter((a) => !auth.admins.has(a.username) && a.username !== acl.owner);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={esc.onKeyDown}>
      <div className="modal wide" ref={esc.box} tabIndex={-1}>
        <h2>Access to {pname}</h2>
        <p className="sub">Administrators always see and edit everything. Viewers can never edit, even if you choose Edit.</p>
        {locked && <p className="err">{LOCKED_ACCESS}</p>}
        <div className="acc-grid">
          <div className="acc-row head">
            <span>Owner</span>
            <select className="input sm" value={acl.owner ?? ''} onChange={(e) => setOwner(e.target.value)} style={{ width: 240 }} disabled={locked}>
              {!acl.owner && <option value="">— nobody —</option>}
              {accounts.filter((a) => a.role !== 'viewer').map((a) => <option key={a.username} value={a.username}>{a.name}</option>)}
            </select>
            <span className="faint">edits it, always</span>
          </div>
          <div className="acc-row head">
            <span>Everyone else</span>
            <AccessSeg value={acl.everyone} onChange={setEveryone} disabled={locked} />
            <span className="faint">unless set below</span>
          </div>
        </div>
        <div className="acc-list">
          {others.length === 0 && <div className="muted" style={{ padding: 14 }}>No quantity surveyors yet.</div>}
          {others.map((a) => {
            const own = acl.people.get(a.username) ?? 'none';
            const eff = accessFor(store, auth.admins, a, p, accounts);
            return (
              <div className="acc-row" key={a.username} data-user={a.username}>
                <span className="person">
                  <span className="avatar" style={{ background: colorFor(a.name) }}>{initials(a.name)}</span>
                  <span><span className="n">{a.name}</span><span className="u">{ROLE_LABEL[effRole(a, auth.admins)]}</span></span>
                </span>
                <AccessSeg value={own} max={a.role === 'viewer' ? 'view' : 'edit'} onChange={(x) => setPerson(a.username, x)} disabled={locked} />
                <span className={'acc ' + eff}>{eff === 'none' ? 'can’t see it' : eff === 'view' ? 'can view' : 'can edit'}</span>
              </div>
            );
          })}
        </div>
        <div className="actions"><button className="btn" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}

/** Which projects one person may see / edit. */
function PersonAccessDialog({ auth, person, projects, onClose }: { auth: Auth; person: Account; projects: ProjectEntry[]; onClose: () => void }) {
  useAccountsVersion(auth);
  const esc = useEscClose(onClose);
  const store = auth.accounts.store;
  const accounts = listAccounts(store);
  const a = accounts.find((x) => x.username === person.username) ?? person;
  const isAdm = auth.admins.has(a.username);
  const locked = auth.accounts.readOnly || !!auth.accounts.newerApp;
  const setPerson = (pid: string, pname: string, x: Access) =>
    auth.accounts.commit(setPersonAccessOps(pid, a.username, x), x === 'none' ? `Removed ${a.name}'s access to ${pname}` : `Gave ${a.name} ${x} access to ${pname}`);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={esc.onKeyDown}>
      <div className="modal wide" ref={esc.box} tabIndex={-1}>
        <h2>Projects for {a.name}</h2>
        <p className="sub">
          {isAdm ? 'Administrators see and edit every project.' : a.role === 'viewer' ? 'Viewers only ever view. Tick the projects they may open.' : 'Their own projects are always theirs to edit. Choose access for the rest.'}
        </p>
        {locked && <p className="err">{LOCKED_ACCESS}</p>}
        <div className="acc-list">
          {projects.length === 0 && <div className="muted" style={{ padding: 14 }}>No projects yet.</div>}
          {projects.map((p) => {
            const acl = getAcl(store, p.meta, accounts);
            const owner = acl.owner === a.username && a.role !== 'viewer';
            const eff = accessFor(store, auth.admins, a, p.meta, accounts);
            return (
              <div className="acc-row" key={p.dir}>
                <span className="pn">{p.meta.name}{formatOf(p.meta) === FORMAT.takeoff && <span className="tag main" style={{ marginLeft: 8 }}>take-off</span>}</span>
                {isAdm || owner ? (
                  <span className="faint">{isAdm ? 'administrator' : 'owner'}</span>
                ) : (
                  <AccessSeg value={acl.people.get(a.username) ?? 'none'} max={a.role === 'viewer' ? 'view' : 'edit'} onChange={(x) => setPerson(p.meta.id, p.meta.name, x)} disabled={locked} />
                )}
                <span className={'acc ' + eff}>{eff === 'none' ? 'can’t see it' : eff === 'view' ? 'can view' : 'can edit'}</span>
              </div>
            );
          })}
        </div>
        <div className="actions"><button className="btn" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Activity
const KINDS: { k: ActivityEvent['kind'] | 'all'; label: string }[] = [
  { k: 'all', label: 'Everything' },
  { k: 'people', label: 'People and roles' },
  { k: 'access', label: 'Project access' },
  { k: 'password', label: 'Passwords' },
  { k: 'signin', label: 'Sign-ins' },
];

export function ActivityTab({ auth }: { auth: Auth }) {
  useAccountsVersion(auth);
  const [kind, setKind] = useState<ActivityEvent['kind'] | 'all'>('all');
  const [q, setQ] = useState('');
  const all = useMemo(() => activityLog(auth.accounts.store, 2000), [auth.accounts.store.version]);
  const shown = all.filter((e) => (kind === 'all' || e.kind === kind) && (!q.trim() || (e.byName + ' ' + e.text).toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <div className="sheet">
      <div className="toolbar">
        <div className="seg">
          {KINDS.map((x) => <button key={x.k} className={kind === x.k ? 'on' : ''} onClick={() => setKind(x.k)}>{x.label}</button>)}
        </div>
        <div className="search">
          <ISearch />
          <input className="input" placeholder="Find a person or project" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="grow" />
        <span className="faint">{shown.length} of {all.length}</span>
      </div>
      <div className="paper-scroll">
        <table className="register activity">
          <thead><tr><th style={{ width: 200 }}>When</th><th style={{ width: 220 }}>Who</th><th>What</th></tr></thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.s} className={'ev ' + e.kind}>
                <td className="muted" title={new Date(e.t).toLocaleString('en-GB')}>{ago(e.t)}</td>
                <td>
                  <span className="person">
                    <span className="avatar" style={{ background: colorFor(e.byName) }}>{initials(e.byName)}</span>
                    <span className="n">{e.byName}</span>
                  </span>
                </td>
                <td>{e.text}</td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 24, textAlign: 'center' }}>Nothing here yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// (the app's own clipboard first, then the browser's - its refusal was not caught and the fallback never ran,
// 0.23.2, DeepSeek #22)
async function copyText(t: string): Promise<boolean> {
  if (gt().clipboard?.(t)) return true;
  try { await navigator.clipboard.writeText(t); return true; } catch { /* below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}
