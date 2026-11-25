// User menu (top-right) and Change password. People and access live in People.tsx.
import { useEffect, useRef, useState } from 'react';
import type { Auth } from './App';
import { colorFor } from '../engine/ids';
import { getAccount, userId, verifySecret, hashSecret, MIN_PASSWORD, ROLE_LABEL } from '../engine/accounts';
import { initials } from './format';
import { IUsers } from './icons';
import { askProblemReport } from './Update';
import { useEscClose } from './escape';
import { SettingsDlg, usePrivacyAvailable } from './Privacy';

export function UserMenu({ auth, onSignOut, onManageUsers, onChangePassword, version }: { auth: Auth; onSignOut: () => void; onManageUsers: () => void; onChangePassword: () => void; version?: string }) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  // (Settings only holds what needs a receiver - the user count's switch, the report to the developer)
  const priv = usePrivacyAvailable();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  const a = auth.account;
  const role = ROLE_LABEL[auth.isAdmin ? 'admin' : a.role === 'admin' ? 'qs' : a.role];
  return (
    <div className="umenu no-drag" ref={ref}>
      <button className="umenu-btn" onClick={() => setOpen((x) => !x)} title={a.name}>
        <span className="avatar me" style={{ background: colorFor(a.name) }}>{initials(a.name)}</span>
      </button>
      {open && (
        <div className="umenu-pop">
          <div className="umenu-head">
            <span className="avatar" style={{ background: colorFor(a.name), borderColor: 'transparent', marginLeft: 0, width: 34, height: 34, fontSize: 13 }}>{initials(a.name)}</span>
            <div>
              <div className="n">{a.name}</div>
              <div className="u">{a.username}, {role.toLowerCase()}</div>
            </div>
          </div>
          {auth.isAdmin && <button onClick={() => { setOpen(false); onManageUsers(); }}><IUsers /> People and access</button>}
          <button onClick={() => { setOpen(false); onChangePassword(); }}>Change password</button>
          <button onClick={() => { setOpen(false); askProblemReport(); }} title="Something not working? This copies what is needed to look into it (app version, recent errors, the log) — no prices, no BOQ">Copy a problem report</button>
          {(priv.count || priv.report) && <button onClick={() => { setOpen(false); setSettings(true); }}>Settings</button>}
          <button onClick={() => { setOpen(false); onSignOut(); }}>Sign out</button>
          {version && <div className="umenu-ver faint">Goldline Takeoff {version}</div>}
        </div>
      )}
      {settings && <SettingsDlg onClose={() => setSettings(false)} />}
    </div>
  );
}

export function ChangePassword({ auth, onClose }: { auth: Auth; onClose: () => void }) {
  const [cur, setCur] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const esc = useEscClose(onClose, busy);
  const save = async () => {
    setMsg(null);
    const me = getAccount(auth.accounts.store, auth.account.username);
    if (!me?.pw || !(await verifySecret(cur, me.pw))) return setMsg('Your current password is not right.');
    if (p1.length < MIN_PASSWORD) return setMsg(`New password must be at least ${MIN_PASSWORD} characters.`);
    if (p1 !== p2) return setMsg('The two new passwords are different.');
    if (auth.accounts.newerApp) return setMsg(`A newer Goldline Takeoff (${auth.accounts.newerApp}) is in use: update this copy to change your password.`);
    setBusy(true);
    const ok = auth.accounts.commit([[userId(me.username), 'pw', await hashSecret(p1)]], 'Password changed');
    setBusy(false);
    if (!ok) return setMsg('The password could not be changed here.');
    setDone(true);
  };
  return (
    <div className="scrim" onKeyDown={esc.onKeyDown} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={esc.box} tabIndex={-1} className="modal">
        <h2>Change password</h2>
        {done ? (
          <>
            <p className="sub">Done. Use the new password next time you sign in.</p>
            <div className="actions"><button className="btn primary" onClick={onClose}>Close</button></div>
          </>
        ) : (
          <>
            <p className="sub">Signed in as {auth.account.name} ({auth.account.username}).</p>
            <div className="row"><label>Current password</label><input className="input" type="password" autoFocus value={cur} onChange={(e) => setCur(e.target.value)} /></div>
            <div className="row"><label>New password (at least {MIN_PASSWORD} characters)</label><input className="input" type="password" value={p1} onChange={(e) => setP1(e.target.value)} /></div>
            <div className="row"><label>New password again</label><input className="input" type="password" value={p2} onChange={(e) => setP2(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} /></div>
            {msg && <p className="err">{msg}</p>}
            <div className="actions">
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Change password'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
