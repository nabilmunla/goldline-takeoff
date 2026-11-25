// A take-off's own backups, from inside it: Back up now (anyone who can edit), and Roll back to a backup
// (administrators). A roll back is one change on top of the project - a backup of how it is now is made first,
// and Undo takes it back. A copy as a new project: Start screen › Backups (administrators).
import { useEffect, useState } from 'react';
import { gt, type AppInfo } from './api';
import type { Auth, OpenProject } from './App';
import type { ProjectSession } from '../engine/session';
import { backupBase } from '../engine/accounts';
import { backupDirOf, listBackupDays, readBackup, rollbackOps, writeManualBackup, type BackupDay } from '../engine/backups';
import type { Op } from '../engine/types';
import { getAcl } from '../engine/access';
import { backupFs } from './backup';
import { Modal } from './takeoff/Dialogs';

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const label = (d: BackupDay) => {
  const [day, time] = d.day.split(' ');
  const t = new Date(day + 'T00:00:00');
  const s = t.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return time ? `${s} ${time.slice(0, 5)}` : s;
};

export function ProjectBackupsDialog(p: { session: ProjectSession; project: OpenProject; auth: Auth; info: AppInfo; readOnly: boolean; onClose: () => void; toast: (t: string) => void;
  /** a BOQ hub's backups: what its roll back leaves alone (additional items, attach rows) and writes with it (its revision) */
  skip?: string[]; alsoOps?: () => Op[]; title?: string }) {
  const { session, project, auth, info } = p;
  const [days, setDays] = useState<BackupDay[] | null>(null);
  const [notes, setNotes] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ask, setAsk] = useState<BackupDay | null>(null);
  const [ver, setVer] = useState(0);
  const fs = gt().fs;
  const folder = base(project.dir);
  const id = project.id || session.meta.id;
  // administrators, and the person whose take-off it is (their own work)
  const mayRollBack = auth.isAdmin || getAcl(auth.accounts.store, { ...session.meta, id }).owner === auth.account.username;
  const opts = () => ({ fs: backupFs() as any, root: auth.roots.qto, base: backupBase(auth.roots, 'qto'), kind: 'qto' as const, projectDir: project.dir, folder, projectId: id, projectName: project.name, store: session.store, by: auth.account.username, host: info.host, app: info.version, admins: auth.wasAdmin, like: session.meta });

  useEffect(() => {
    let alive = true;
    const b = backupBase(auth.roots, 'qto');
    const dirs = [backupDirOf(fs, auth.roots.qto, 'qto', folder, id, b), ...(b ? [backupDirOf(fs, auth.roots.qto, 'qto', folder, id)] : [])];
    Promise.all(dirs.map((d) => listBackupDays(fs, d, { manual: true }).catch(() => [] as BackupDay[])))
      .then(async (lists) => {
        const seen = new Set<string>();
        const all = lists.flat().filter((d) => (seen.has(d.day) ? false : (seen.add(d.day), true))).sort((a, c) => (a.day < c.day ? 1 : -1));
        if (!alive) return;
        setDays(all);
        // what each hand-made one was for
        const m = new Map<string, string>();
        for (const d of all.filter((x) => x.manual).slice(0, 15)) { const bk = await readBackup(backupFs() as any, d.file).catch(() => null); if (bk?.note) m.set(d.file, bk.note); }
        if (alive) setNotes(m);
      })
      .catch((e) => alive && setErr(String(e?.message ?? e)));
    return () => { alive = false; };
  }, [ver]);

  const backUpNow = async () => {
    setBusy('Backing up…'); setErr(null);
    try { await writeManualBackup({ ...opts(), note: `Backed up by ${auth.account.name}` }); p.toast('Backed up — the daily clean-up leaves it (the last 40 made by hand are kept).'); setVer((v) => v + 1); }
    catch (e: any) { setErr('Not backed up: ' + String(e?.message ?? e)); }
    finally { setBusy(null); }
  };
  const rollBack = async (d: BackupDay) => {
    setAsk(null); setBusy('Rolling back…'); setErr(null);
    try {
      const b = await readBackup(backupFs() as any, d.file);
      // a take-off's BOQ copy is not its own work (it comes from the BOQ, or is kept frozen): never rolled back
      const opsNow = () => rollbackOps(session.store, b, { skip: p.skip ?? ['b:', 'bi:'] });
      const same = () => { p.toast(`Nothing to roll back: the take-off is already as it was on ${label(d)}.`); p.onClose(); };
      // (nothing to roll back: no "Before rolling back" backup either - 0.23.1, PC check)
      if (opsNow().length <= 1) return same();
      // how it is now, first: a roll back never loses anything
      await writeManualBackup({ ...opts(), note: `Before rolling back to ${label(d)}` });
      // (worked out again: someone may have changed it while that backup was written)
      const ops = opsNow();
      if (ops.length <= 1) return same();
      if (!session.commit([...ops, ...(p.alsoOps?.() ?? [])], `Rolled back to ${label(d)}`)) throw new Error('it is view only here');
      p.toast(`Rolled back to ${label(d)}. Undo (Ctrl+Z) or the backup made just before takes it back.`);
      p.onClose();
    } catch (e: any) { setErr('Not rolled back: ' + String(e?.message ?? e)); setBusy(null); }
  };

  return (
    <Modal title={p.title ?? 'Backups of this take-off'} sub={<>Made every day it is worked on, and whenever someone backs it up by hand. Kept: every day for two weeks, then weekly, then monthly; the last 40 made by hand.</>} onClose={p.onClose} wide>
      <div className="pbk">
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          {!p.readOnly && <button className="btn primary" data-backup-now disabled={!!busy} onClick={backUpNow}>Back up now</button>}
          {busy && <span className="faint"><span className="dot busy" /> {busy}</span>}
        </div>
        {err && <p className="err">{err}</p>}
        {days === null ? <p className="faint">Reading the backups…</p> : !days.length ? <p className="faint">No backups yet.</p> : (
          <div className="pbk-list">
            {days.map((d) => (
              <div key={d.file} className="pbk-row" data-backup-row={d.manual ? 'manual' : 'day'}>
                <span className="d">{label(d)}</span>
                <span className="n faint">{d.manual ? notes.get(d.file) ?? 'made by hand' : 'daily'}</span>
                {mayRollBack && !p.readOnly && <button className="btn sm" data-rollback disabled={!!busy} onClick={() => setAsk(d)}>Roll back to this…</button>}
              </div>
            ))}
          </div>
        )}
        {!mayRollBack && <p className="faint">Rolling back: administrators and the take-off’s owner. Copies from a backup: administrators.</p>}
        {auth.isAdmin && <p className="faint">A copy from a backup as a new project: Start screen › Backups.</p>}
      </div>
      {ask && (
        <div className="confirm" data-rollback-ask>
          <p>Roll <b>{project.name}</b> back to <b>{label(ask)}</b>? Everyone working in it sees it at once.<br />A backup of how it is now is made first, and Undo takes the roll back away again — nothing is lost.</p>
          <div className="actions">
            <button className="btn ghost" onClick={() => setAsk(null)}>Cancel</button>
            <button className="btn primary" data-rollback-go onClick={() => rollBack(ask)}>Roll back</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
