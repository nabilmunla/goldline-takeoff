// The daily backups of the take-off projects in one list, for administrators:
// any day of any project - one that is still there, or one that was deleted - comes back as a
// NEW project next to the others. Nothing is ever put back over a project.
import { useEffect, useMemo, useState } from 'react';
import { gt, type AppInfo } from './api';
import type { Auth, OpenProject } from './App';
import { listBackups, mergeBackupSets, type BackupSet } from '../engine/backups';
import type { ProjectEntry } from '../engine/projects';
import { restoreTakeoff } from '../engine/restore';
import { backupBase } from '../engine/accounts';
import { backupFs } from './backup';
import { ago } from './format';
import type { Op } from '../engine/types';
import { useEscClose } from './escape';

const dayLabel = (d: string) => {
  const t = new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  // (a backup made by hand: "2026-11-18 14:25:30" - the time too)
  return t.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + (d.length > 10 ? ' ' + d.slice(11, 16) : '');
};

export function BackupsDialog(p: {
  auth: Auth;
  info: AppInfo;
  kind: 'qto';
  /** the projects in the list now (to say which backups are of projects that are gone) */
  projects: ProjectEntry[] | null;
  onOpen: (o: OpenProject) => void;
  onClose: () => void;
}) {
  const { auth, info, kind } = p;
  const root = auth.roots.qto;
  // the backups folder an administrator chose, and the usual one (what wasn't moved from there)
  const base = backupBase(auth.roots, kind);
  const usual = gt().fs.join(root, '_backups');
  const where = base ?? usual;
  const [sets, setSets] = useState<BackupSet[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<{ set: BackupSet; day: string } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const esc = useEscClose(p.onClose, busy);
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    // and the folders chosen before (what was left there when the setting changed)
    const prev = auth.roots.bak.prev.team.filter((p) => p !== base && p !== usual);
    Promise.all([
      listBackups(gt().fs, root, base),
      base ? listBackups(gt().fs, root).catch(() => []) : Promise.resolve([]),
      ...prev.map((p) => listBackups(gt().fs, root, p).catch(() => [])),
    ])
      .then((lists) => alive && setSets(mergeBackupSets(lists).filter((x) => (x.about ? x.about.kind === kind : true) && !/^BOQ-/.test(x.about?.folder ?? ''))))
      .catch((e) => alive && setErr(String(e?.message ?? e)));
    return () => { alive = false; };
  }, [root, kind, base, JSON.stringify(auth.roots.bak.prev)]);

  const live = useMemo(() => new Set((p.projects ?? []).map((x) => x.meta.id)), [p.projects]);
  const shown = (sets ?? []).filter((s) => !q.trim() || (s.about?.projectName ?? s.dir).toLowerCase().includes(q.trim().toLowerCase()));

  const choose = (set: BackupSet, day: string) => {
    setPick({ set, day });
    setName(`${set.about?.projectName ?? 'Project'} (restored ${day})`);
    setErr(null);
  };

  const restore = async () => {
    if (!pick || !name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const file = pick.set.days.find((d) => d.day === pick.day)!.file;
      // (refused whole when the accounts can't be written here: sweep B 8)
      const { dir, meta } = await restoreTakeoff({ fs: gt().fs, bfs: backupFs(), root, file, name: name.trim(), me: auth.account, host: info.host, accounts: auth.accounts });
      p.onOpen({ dir, name: name.trim(), id: meta.id, readOnly: false, kind });
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && p.onClose()} onKeyDown={esc.onKeyDown}>
      <div className="modal backups" ref={esc.box} tabIndex={-1}>
        <h2>Backups — take-off projects</h2>
        <p className="sub">
          Every project is backed up once a day while people work in it: every day of the last two weeks, one a week for two months and one a month
          for a year are kept. Restoring makes a <b>new project</b> from the backup — the project itself is never changed.
        </p>
        <div className="bk-tools">
          <input className="input" placeholder="Find a project" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="faint" title={base ? `${base} (and what is left in ${usual})` : usual}>{where}</span>
        </div>
        <div className="bk-list">
          {!sets && !err && <div className="faint" style={{ padding: 16 }}><span className="dot busy" /> Reading the backups…</div>}
          {sets && sets.length === 0 && <div className="faint" style={{ padding: 16 }}>No backups yet. The first ones are written as people open their projects with this version.</div>}
          {shown.map((s) => {
            const gone = s.about && !live.has(s.about.projectId);
            return (
              <div key={s.dir} className={'bk-set' + (pick?.set === s ? ' on' : '')}>
                <div className="bk-name">
                  <b>{s.about?.projectName ?? s.dir.split(/[\\/]/).pop()}</b>
                  {gone && <span className="bk-gone" title="This project is no longer in the list (its folder was deleted or moved)">not in the list any more</span>}
                  <span className="faint"> · last {s.about ? ago(s.about.lastAt) + ' by ' + s.about.lastBy : s.days[0].day} · {s.days.length} day{s.days.length > 1 ? 's' : ''} kept</span>
                </div>
                <div className="bk-days">
                  {s.days.map((d) => (
                    <button key={d.day} className={'chip' + (pick?.set === s && pick.day === d.day ? ' on' : '')} title={dayLabel(d.day)} onClick={() => choose(s, d.day)}>{d.day}</button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {pick && (
          <div className="bk-restore">
            <label>Restore <b>{pick.set.about?.projectName}</b> as it was at the end of {dayLabel(pick.day)}, as a new project called</label>
            <div className="bk-row">
              <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && restore()} />
              <button className="btn primary" disabled={busy || !name.trim()} onClick={restore}>{busy ? 'Restoring…' : 'Restore as a new project'}</button>
            </div>
            <p className="faint" style={{ margin: '6px 0 0' }}>You own it; the people who could open the original can open it too.</p>
          </div>
        )}
        {err && <p className="err">{err}</p>}
        <div className="actions">
          <button className="btn" disabled={busy} onClick={p.onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
