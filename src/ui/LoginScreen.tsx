// Sign-in screen. Three cases:
//  - no accounts in this shared folder yet  -> create the first administrator
//  - normal sign in
//  - account created by an admin but no password yet -> setup code + choose password
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { gt, type AppInfo } from './api';
import { Brand } from './App';
import { loadAccountStore, checkLogin, initAccounts, claimAccount, normUsername, MIN_PASSWORD, type Account } from '../engine/accounts';
import { listProjects } from '../engine/projects';
import { backupDirOf, listBackupDays, readBackup, restoreAccounts, storeFromBackup, type BackupDay, type BackupFile } from '../engine/backups';
import { adminSet } from '../engine/accounts';
import { decodeLine } from '../engine/codec';
import { Store } from '../engine/store';
import { backupFs } from './backup';
import { movedAlready, movedTarget, samePath, syncJournals } from '../engine/teamfolder';
import { accountsDir, appendOneOff, CFG } from '../engine/accounts';
import { toUnc } from './takeoff/drawings';
import { IFolder, IRefresh } from './icons';

// 'broken': the accounts folder is there but nobody is in it (its changes are gone) - restore only
type Phase = 'loading' | 'nofolder' | 'unreachable' | 'moved' | 'setup' | 'broken' | 'login' | 'claim';

/** places the accounts' backups may be in (the usual one, the one this PC last knew, one picked) */
async function findAccountBackups(fs: ReturnType<typeof gt>['fs'], dirs: (string | null | undefined)[]): Promise<{ dir: string; days: BackupDay[] } | null> {
  for (const d of dirs) {
    if (!d) continue;
    const days = await listBackupDays(fs, d).catch(() => []);
    if (days.length) return { dir: d, days };
  }
  return null;
}

export function LoginScreen({ info, setInfo, onSignedIn, notice, themeButton }: {
  info: AppInfo;
  setInfo: (i: AppInfo) => void;
  onSignedIn: (a: Account) => Promise<void>;
  notice: string | null;
  themeButton: ReactNode;
}) {
  const fs = gt().fs;
  const [phase, setPhase] = useState<Phase>('loading');
  const [store, setStore] = useState<Store | null>(null);
  const [projectCount, setProjectCount] = useState(0);
  const [accBackups, setAccBackups] = useState<BackupDay[]>([]);
  const [accFrom, setAccFrom] = useState('');
  const [movedTo, setMovedTo] = useState<{ to: string; why?: string; canStay: boolean } | null>(null);
  const loadSeq = useRef(0);
  const hops = useRef(0);
  const [note, setNote] = useState<string | null>(null);
  const [accDay, setAccDay] = useState('');
  const [accUser, setAccUser] = useState('');
  const [accPw, setAccPw] = useState('');
  const [username, setUsername] = useState(info.lastUsername ?? '');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(notice);
  const [busy, setBusy] = useState(false);
  const fails = useRef({ n: 0, until: 0 });

  const load = useCallback(async () => {
    if (!info.dataRoot) return setPhase('nofolder');
    const seq = ++loadSeq.current;
    // a folder picked meanwhile wins over what this (slower) look found
    const stale = () => seq !== loadSeq.current;
    setPhase('loading');
    try {
      if (!(await fs.exists(info.dataRoot))) return stale() ? undefined : setPhase('unreachable');
      const r = await loadAccountStore(fs, info.dataRoot);
      if (stale()) return;
      setStore(r.store);
      // an administrator moved the team folder: this PC follows (what only the old folder holds comes along)
      const moved = await movedTarget(fs, info.dataRoot, r.exists ? r.store : null).catch(() => null);
      if (stale()) return;
      if (moved && moved.ok && hops.current < 3) {
        hops.current++;
        if (r.exists) await syncJournals(fs, accountsDir(fs, info.dataRoot), accountsDir(fs, moved.to)).catch(() => null);
        await gt().setSettings({ dataRoot: moved.to });
        setNote(`The team folder has moved to ${moved.to} — this PC uses it from now on.`);
        setInfo({ ...info, dataRoot: moved.to });
        return;
      }
      if (moved && !moved.ok) {
        // while the accounts are still here, this PC can go on with them until it reaches the new folder
        setMovedTo({ to: moved.to, why: moved.why, canStay: r.exists && !moved.cleared && !!r.store.top });
        return setPhase('moved');
      }
      // no accounts, or an accounts folder that has its project.json but none of its changes (the
      // journals deleted, quarantined, only partly copied): nobody could sign in there, and setting
      // up again is refused - the backups are offered (BH-007)
      if (!r.exists || !r.store.top) {
        // the backups this PC remembers are offered only for the team folder they were made for: a new,
        // empty team folder must not offer another team's accounts (PC check 0.23.0)
        const remembered = info.accBackupsFor && samePath(info.accBackupsFor, info.dataRoot) ? info.accBackups : null;
        const found = await findAccountBackups(fs, [backupDirOf(fs, info.dataRoot, 'accounts', '', ''), remembered]);
        if (stale()) return;
        const days = found?.days ?? [];
        setAccFrom(found?.dir ?? '');
        setAccBackups(days);
        setAccDay(days[0]?.day ?? '');
        if (r.exists) return setPhase('broken');
        setProjectCount((await listProjects(fs, info.dataRoot)).length);
        if (!username) setUsername(normUsername(info.winUser));
        setPhase('setup');
      } else setPhase('login');
    } catch {
      setPhase('unreachable');
    }
  }, [info.dataRoot]);

  useEffect(() => { load(); }, [load]);

  /** the accounts' backups kept somewhere else (an administrator chose a backups folder) */
  const pickBackups = async () => {
    const p = await gt().pickDir({ title: 'Folder with the accounts’ backups', start: accFrom || info.dataRoot });
    if (!p) return;
    const found = await findAccountBackups(fs, [p, fs.join(p, '_accounts'), fs.join(p, '_backups', '_accounts')]);
    if (!found) return setMsg('No backups of the accounts in that folder (they are in a folder called _accounts inside the backups folder).');
    setMsg(null);
    setAccFrom(found.dir);
    setAccBackups(found.days);
    setAccDay(found.days[0]?.day ?? '');
  };

  const pick = async () => {
    const picked = await gt().pickFolder(info.dataRoot);
    if (!picked) return;
    // kept as the server's own name (\\server\share\…): the same on every PC, whatever its drive letters
    const p = toUnc(picked, await gt().drives().catch(() => ({}))) || picked;
    await gt().setSettings({ dataRoot: p });
    setInfo({ ...info, dataRoot: p });
  };

  const finish = async (a: Account) => {
    try {
      await onSignedIn(a);
    } catch (e: any) {
      setMsg('Signed in, but the accounts folder could not be opened: ' + String(e?.message ?? e));
      setBusy(false);
    }
  };

  const doSetup = async () => {
    setMsg(null);
    const u = normUsername(username);
    if (!name.trim()) return setMsg('Enter your full name.');
    if (!u) return setMsg('Choose a username.');
    if (password.length < MIN_PASSWORD) return setMsg(`Password must be at least ${MIN_PASSWORD} characters.`);
    if (password !== password2) return setMsg('The two passwords are different.');
    setBusy(true);
    try {
      const acc = await initAccounts(fs, info.dataRoot!, info.host, { username: u, name, password });
      await finish(acc);
    } catch (e: any) {
      setMsg('Could not create the account: ' + String(e?.message ?? e));
      setBusy(false);
    }
  };

  const doRestore = async () => {
    const d = accBackups.find((x) => x.day === accDay);
    if (!d || busy) return;
    setMsg(null);
    setBusy(true);
    try {
      const b = await readBackup(backupFs(), d.file);
      // only an administrator of that day may bring the accounts back (their password then)
      const st = backupStore(b);
      const u = normUsername(accUser);
      const ok = !!u && adminSet(st).has(u) && (await checkLogin(st, u, accPw)).ok;
      if (!ok) { setBusy(false); setMsg('Restoring the accounts needs the username and password of an administrator as they were on that day.'); return; }
      await restoreAccounts(fs, info.dataRoot!, info.host, b, u);
      // a backup made after the accounts moved away still says so: here they are again, so they stay
      const back = await loadAccountStore(fs, info.dataRoot!).catch(() => null);
      if (back && movedAlready(back.store, info.dataRoot!)) {
        await appendOneOff(fs, accountsDir(fs, info.dataRoot!), u, u, info.host, [[CFG, 'movedTo', null]], 'Accounts restored here', back.store).catch(() => {});
      }
      setBusy(false);
      await load();
      setMsg(`The accounts are back as they were on ${d.day}. Sign in as before — changes to people or access made after that day need doing again.`);
    } catch (e: any) {
      setMsg('Could not restore the accounts: ' + String(e?.message ?? e));
      setBusy(false);
    }
  };

  const doLogin = async () => {
    setMsg(null);
    if (Date.now() < fails.current.until) return setMsg(`Too many wrong attempts. Wait ${Math.ceil((fails.current.until - Date.now()) / 1000)} seconds.`);
    setBusy(true);
    // always read the latest accounts (an admin may have just added you)
    const fresh = (await loadAccountStore(fs, info.dataRoot!).catch(() => null))?.store ?? store!;
    setStore(fresh);
    const r = await checkLogin(fresh, username, password);
    if (r.ok) return finish(r.account);
    setBusy(false);
    if (r.reason === 'needs-setup') {
      setPassword('');
      setPhase('claim');
      return setMsg(null);
    }
    if (r.reason === 'wrong') {
      fails.current.n++;
      if (fails.current.n >= 5) { fails.current = { n: 0, until: Date.now() + 30000 }; }
    }
    setMsg(r.reason === 'unknown' ? 'No account with that username. Ask an administrator to add you.' : r.reason === 'inactive' ? 'This account is deactivated. Ask an administrator.' : 'Wrong password.');
  };

  const doClaim = async () => {
    setMsg(null);
    if (password !== password2) return setMsg('The two passwords are different.');
    setBusy(true);
    const fresh = (await loadAccountStore(fs, info.dataRoot!).catch(() => null))?.store ?? store!;
    // (with folder removal: a code whose use could not be written is not used up)
    const r = await claimAccount(backupFs(), info.dataRoot!, info.host, fresh, username, code, password)
      .catch((e: any) => ({ ok: false as const, reason: 'The password could not be saved: ' + String(e?.message ?? e) + '. Check the network drive and try again.' }));
    if (r.ok) return finish(r.account);
    setBusy(false);
    setMsg(r.reason);
  };

  const enter = (f: () => void) => (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !busy) f(); };

  /** bring the accounts back from one of the app's backups (an administrator of that day signs it) */
  const restoreBox = (intro: ReactNode) => (
    <div className="warnbox" style={{ marginBottom: 14, flexDirection: 'column' }}>
      <div>{intro}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select className="input" value={accDay} onChange={(e) => setAccDay(e.target.value)} style={{ width: 'auto' }}>
          {accBackups.map((d) => <option key={d.day} value={d.day}>Backup of {d.day}</option>)}
        </select>
        <button className="btn primary" disabled={busy || !accUser || !accPw} onClick={doRestore}>{busy ? 'Restoring…' : 'Restore the accounts'}</button>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="input" placeholder="Administrator's username" value={accUser} onChange={(e) => setAccUser(e.target.value)} />
        <input className="input" type="password" placeholder="Their password" value={accPw} onChange={(e) => setAccPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doRestore()} />
      </div>
    </div>
  );
  const backupsHint = (
    <p className="hint" style={{ marginTop: -6 }}>
      {accBackups.length ? <>Backups from <span className="mono">{accFrom}</span>. </> : null}
      <button className="linkbtn" onClick={pickBackups}>{accBackups.length ? 'Look in another folder…' : 'Restore the accounts from a backups folder…'}</button>
    </p>
  );

  return (
    <>
      <div className="topbar">
        <Brand />
        <div className="spacer" />
        {themeButton}
      </div>
      <div className="login">
        <div className="login-brand">
          <img src="./gmark.svg" alt="" />
          <h1><b>Goldline</b> Takeoff</h1>
          <p>Quantity take-off on the drawings where they are — alone or as a team.</p>
          <div className="login-folder">
            <span className={'dot ' + (phase === 'unreachable' || phase === 'nofolder' || phase === 'broken' ? 'bad' : 'ok')} />
            <span className="path" title={info.dataRoot ?? ''}>{info.dataRoot ?? 'No shared folder chosen'}</span>
            <button className="btn ghost light" onClick={pick}><IFolder /> Change</button>
          </div>
        </div>
        <div className="login-form">
          <div className="login-card">
            {phase === 'loading' && <p className="sub"><span className="dot busy" /> Reading accounts…</p>}

            {phase === 'nofolder' && (
              <>
                <h2>Choose the shared folder</h2>
                <p className="sub">Pick the server folder where projects live. Everyone on the team should pick the same one.</p>
                {msg && <p className="err">{msg}</p>}
                <button className="btn primary wide" onClick={pick}><IFolder /> Choose folder…</button>
              </>
            )}

            {phase === 'unreachable' && (
              <>
                <h2>Shared folder not reachable</h2>
                <p className="sub">Can't reach <b>{info.dataRoot}</b>. Check that the network drive is connected.</p>
                <div className="row2">
                  <button className="btn" onClick={load}><IRefresh /> Retry</button>
                  <button className="btn" onClick={pick}><IFolder /> Choose another folder…</button>
                </div>
              </>
            )}

            {phase === 'moved' && movedTo && (
              <>
                <h2>The team folder has moved</h2>
                <p className="sub">An administrator moved it to <b>{movedTo.to}</b>, but {movedTo.why}. Check the network drive, or ask IT for access to that folder.</p>
                <div className="row2">
                  <button className="btn" onClick={load}><IRefresh /> Retry</button>
                  <button className="btn" onClick={pick}><IFolder /> Choose another folder…</button>
                </div>
                {movedTo.canStay && (
                  <button className="btn ghost wide" style={{ marginTop: 8 }} onClick={() => { setNote('This PC stays with the old team folder until it can reach the new one (it switches over by itself then).'); setPhase('login'); }}>Sign in here for now</button>
                )}
              </>
            )}

            {phase === 'setup' && (
              <>
                <h2>Set up accounts</h2>
                <p className="sub">{accBackups.length ? <>There are no accounts in this shared folder. Bring them back from a backup, or start again as the first <b>administrator</b>.</> : <>Nobody has signed in to this shared folder before. You'll be the first <b>administrator</b>: you add the rest of the team and you're the only one who can empty the recycle bin.</>}</p>
                {accBackups.length > 0 ? (
                  restoreBox(<>This folder has <b>no accounts</b>, but they were backed up by the app. If the accounts folder was deleted or damaged, bring it back — people sign in as before.</>)
                ) : projectCount > 0 && (
                  <div className="warnbox" style={{ marginBottom: 14 }}>
                    <div>There {projectCount === 1 ? 'is already 1 project' : `are already ${projectCount} projects`} in this folder but no accounts. Continue only if accounts have never been set up here — if they were, the <code>_accounts</code> folder is missing and should be restored from backup instead.</div>
                  </div>
                )}
                {backupsHint}
                <Field label="Your full name"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nabil Munla" /></Field>
                <Field label="Username"><input className="input" value={username} onChange={(e) => setUsername(e.target.value)} onBlur={() => setUsername(normUsername(username))} /></Field>
                <Field label={`Password (at least ${MIN_PASSWORD} characters)`}><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
                <Field label="Password again"><input className="input" type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} onKeyDown={enter(doSetup)} /></Field>
                {msg && <p className="err">{msg}</p>}
                <button className="btn primary wide" disabled={busy} onClick={doSetup}>{busy ? 'Creating…' : 'Create administrator account'}</button>
              </>
            )}

            {phase === 'broken' && (
              <>
                <h2>The accounts are missing</h2>
                <p className="sub">This shared folder has its accounts folder, but the people and passwords in it are gone (the <code>_accounts\journals</code> folder is empty or missing: deleted, held by antivirus, or only partly copied). Nobody can sign in here until they are brought back.</p>
                {accBackups.length > 0
                  ? restoreBox(<>The app backed the accounts up. Bring them back as they were on a day before this happened — people sign in as before.</>)
                  : <div className="warnbox" style={{ marginBottom: 14 }}><div>No backups of the accounts were found where they are usually kept. If they are in another folder, look there; otherwise ask IT to bring the <code>_accounts</code> folder back from the server’s own backup.</div></div>}
                {backupsHint}
                {msg && <p className="err">{msg}</p>}
                <div className="row2">
                  <button className="btn" onClick={load}><IRefresh /> Retry</button>
                  <button className="btn" onClick={pick}><IFolder /> Choose another folder…</button>
                </div>
              </>
            )}

            {phase === 'login' && (
              <>
                <h2>Sign in</h2>
                <p className="sub">Use the username your administrator gave you.</p>
                {note && <p className="okline">{note}</p>}
                <Field label="Username"><input className="input" autoFocus={!username} value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={enter(doLogin)} /></Field>
                <Field label="Password"><input className="input" type="password" autoFocus={!!username} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={enter(doLogin)} /></Field>
                {msg && <p className="err">{msg}</p>}
                <button className="btn primary wide" disabled={busy || !username} onClick={doLogin}>{busy ? 'Checking…' : 'Sign in'}</button>
                <p className="hint">New here? Type your username and press Sign in with an empty password field — you'll be asked for the setup code your administrator gave you.</p>
              </>
            )}

            {phase === 'claim' && (
              <>
                <h2>Choose your password</h2>
                <p className="sub">Welcome, <b>{normUsername(username)}</b>. Enter the one-time setup code from your administrator, then choose a password only you know.</p>
                <Field label="Setup code"><input className="input code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX" /></Field>
                <Field label={`New password (at least ${MIN_PASSWORD} characters)`}><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
                <Field label="Password again"><input className="input" type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} onKeyDown={enter(doClaim)} /></Field>
                {msg && <p className="err">{msg}</p>}
                <button className="btn primary wide" disabled={busy || !code || !password} onClick={doClaim}>{busy ? 'Saving…' : 'Set password and sign in'}</button>
                <button className="btn ghost wide" style={{ marginTop: 8 }} onClick={() => { setPhase('login'); setMsg(null); }}>Back</button>
              </>
            )}
          </div>
          <p className="login-foot">Goldline Takeoff {info.version} · {info.winUser} on {info.host}{info.profile !== 'default' ? ` · test profile “${info.profile}”` : ''}</p>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="lfield">
      <label>{label}</label>
      {children}
    </div>
  );
}

/** the accounts as they were in a backup (with their history when the backup kept it) */
function backupStore(b: BackupFile): Store {
  if (!b.lines?.length) return storeFromBackup(b);
  const st = new Store();
  for (const l of b.lines) { const x = decodeLine(l.replace(/\n$/, '')); if (x) st.apply(x); }
  return st;
}
