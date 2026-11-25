// Drawing management: bringing in an issue (new sheets / new revisions) and the drawing register.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { gt } from '../api';
import type { Op } from '../../engine/types';
import type { QtoModel } from '../../engine/qto/model';
import { pageKey, sheetTitle } from '../../engine/qto/model';
import { planImport, clashingTargets, newSheetOps, newRevisionOps, revLabel, type FoundFile, type ImportRow, type ImportAction, type PageScan } from '../../engine/qto/revisions';
import { writeXlsx, type XCell } from '../../engine/xlsxwrite';
import { locate } from './drawings';
import { TIcon } from './ticons';
import { useEscClose } from '../escape';

// ---------------------------------------------------------------- import an issue
export function ImportDialog({ model, found, issue: issue0, user, unc, onClose, onCommit, scan }: {
  model: QtoModel;
  found: FoundFile[];
  issue: string;
  user: string;
  unc: (p: string) => string;
  onClose: () => void;
  onCommit: (ops: Op[], label: string, summary: string) => void;
  /** v0.16: how many pages a file has (and each page's sheet number): a bound set comes in as a sheet per page */
  scan?: (f: FoundFile, alive: () => boolean, onPage?: (done: number, of: number) => void) => Promise<PageScan>;
}) {
  const [issue, setIssue] = useState(issue0);
  const [rows, setRows] = useState<ImportRow[]>(() => planImport(found, model, unc));
  // v0.16: each file is looked into first (only its page tree; the words of each page of a bound set) - the
  // rows can be changed once that is done (a bound set's pages are rows of their own then)
  const [reading, setReading] = useState<{ done: number; total: number; page?: number; pages?: number } | null>(() => (scan ? { done: 0, total: rows.filter((r) => !r.known).length } : null));
  useEffect(() => {
    if (!scan) return;
    let alive = true;
    (async () => {
      const todo = rows.filter((r) => !r.known).map((r) => r.file);
      const scans = new Map<string, PageScan>();
      let shown = 0;
      for (let i = 0; i < todo.length && alive; i++) {
        // a bound set is read page by page (its sheet numbers): say how far (0.23.1 - an 870 MB set sat at "0 of 1"
        // for a minute and a half)
        scans.set(todo[i].path, await scan(todo[i], () => alive, (page, pages) => {
          if (alive && Date.now() - shown > 250) { shown = Date.now(); setReading({ done: i, total: todo.length, page, pages }); }
        }));
        if (Date.now() - shown > 120) { shown = Date.now(); setReading({ done: i + 1, total: todo.length }); }
      }
      if (!alive) return;
      if ([...scans.values()].some((x) => x.n > 1)) setRows(planImport(found, model, unc, scans));
      setReading(null);
    })();
    return () => { alive = false; };
  }, []);
  const [q, setQ] = useState('');
  const set = useCallback((i: number, patch: Partial<ImportRow>) => setRows((r) => r.map((x, k) => (k === i ? { ...x, ...patch } : x))), []);
  const startPick = useCallback((i: number) => { setPicking(i); setPickQ(''); }, []);
  const counts = { new: rows.filter((r) => r.action === 'new').length, rev: rows.filter((r) => r.action === 'rev').length, skip: rows.filter((r) => r.action === 'skip').length };
  const sheets = useMemo(() => [...model.drawings].sort((a, b) => (a.sheet || a.name).localeCompare(b.sheet || b.name, undefined, { numeric: true })), [model]);
  const [picking, setPicking] = useState<number | null>(null);
  const [pickQ, setPickQ] = useState('');
  const esc = useEscClose(onClose);
  const pickAll = useMemo(() => {
    if (picking === null) return [];
    const t = pickQ.trim().toLowerCase();
    return sheets.filter((d) => d.id !== rows[picking]?.target && (!t || (d.sheet + ' ' + d.title + ' ' + d.name).toLowerCase().includes(t)));
  }, [picking, pickQ, sheets]);
  const pickList = pickAll.slice(0, 40);
  const pickMore = pickAll.length - pickList.length;
  const f = q.trim().toLowerCase();
  // two files made the new revision of one sheet: one would silently replace the other
  const clash = clashingTargets(rows).map((t) => model.dwgById.get(t)).filter(Boolean).map((d) => d!.sheet || d!.title || d!.name);
  const go = () => {
    if (clash.length) return;
    const ctx = { user, issue: issue.trim(), unc, taken: (id: string) => model.dwgById.has(id) || model.removedDwg.has(id) };
    const ops: Op[] = [];
    let n = 0, r = 0;
    for (const row of rows) {
      if (row.action === 'new') { ops.push(...newSheetOps(row, ctx).ops); n++; }
      else if (row.action === 'rev' && row.target) {
        const d = model.dwgById.get(row.target);
        if (!d) continue;
        ops.push(...newRevisionOps(model, d, { ...row.file, name: row.name, fp: row.fp, fpn: row.fpn }, { ...ctx, rev: row.rev }));
        r++;
      }
    }
    const summary = [n && `${n} new sheet${n > 1 ? 's' : ''}`, r && `${r} new revision${r > 1 ? 's' : ''}`].filter(Boolean).join(' and ') || 'nothing';
    onCommit(ops, issue.trim() ? 'Issue ' + issue.trim() : 'Added drawings', summary);
  };
  return (
    <div className="scrim" onKeyDown={esc.onKeyDown} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={esc.box} tabIndex={-1} className="modal imp report" style={{ width: 'min(1180px, 96vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div className="imp-head">
          <div>
            <h2>Bring in drawings</h2>
            <p className="sub">
              Files are linked where they are, never copied. A file with the same sheet number as a sheet already in the project becomes its <b>new revision</b>:
              the take-offs stay on the sheet, the shapes measured on the old revision are flagged <b>to check</b>, and you can overlay old and new to see what changed.
            </p>
          </div>
        </div>
        <div className="impbar">
          <label>Issue <input className="input sm" style={{ width: 260 }} value={issue} placeholder="e.g. 260814 PTA 03, Addendum 2, IFC" onChange={(e) => setIssue(e.target.value)} /></label>
          <span className="cnt new">{counts.new} new sheet{counts.new === 1 ? '' : 's'}</span>
          <span className="cnt rev">{counts.rev} new revision{counts.rev === 1 ? '' : 's'}</span>
          <span className="cnt skip">{counts.skip} left out</span>
          <span className="grow" />
          <input className="input sm" style={{ width: 220 }} placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="imptable">
          <div className="ir head"><span>File</span><span>Sheet</span><span>Title</span><span>Revision</span><span>What to do</span></div>
          {rows.map((r, i) =>
            f && !(r.name.toLowerCase().includes(f) || r.sheet.toLowerCase().includes(f)) ? null : (
              <ImportRowView key={r.file.path + '|' + (r.fp ?? '') + '|' + i} r={r} i={i} target={r.target ? model.dwgById.get(r.target)?.sheet || sheetTitle(model.dwgById.get(r.target)!) : ''} canPick={sheets.length > 0} set={set} startPick={startPick} locked={!!reading}
                picker={picking === i ? (
                  <span className="imp-pick">
                    <input className="input sm" autoFocus placeholder={'Find the sheet (' + sheets.length + ')'} value={pickQ} onChange={(e) => setPickQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setPicking(null); } }} />
                    <span className="imp-pick-list">
                      {pickList.map((d) => (
                        <button key={d.id} className="mi" onClick={() => { set(i, { action: 'rev' as ImportAction, target: d.id }); setPicking(null); }}>
                          {d.sheet ? <b>{d.sheet}</b> : null} {d.title || d.name}
                        </button>
                      ))}
                      {pickMore > 0 && <i className="faint">{pickMore} more — type to narrow</i>}
                      {!pickList.length && <i className="faint">No sheet matches</i>}
                    </span>
                  </span>
                ) : null} />
            ),
          )}
        </div>
        <div className="imp-foot">
          {reading ? (
            <span className="imp-sum imp-reading"><span className="dot busy" /> Looking into the files for their pages… {reading.pages ? <>{reading.done + 1} of {reading.total} · page {reading.page} of {reading.pages}</> : <>{reading.done} of {reading.total}</>}</span>
          ) : clash.length ? (
            <span className="imp-sum warnline">Two files are set as the new revision of <b>{clash.join(', ')}</b> — keep one, skip the other.</span>
          ) : <span className="imp-sum">Nothing is changed on the server — only links are added.{rows.some((r) => r.fp !== undefined) ? ' Each page of a bound set comes in as a sheet of its own.' : ''}</span>}
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!!reading || (!counts.new && !counts.rev) || clash.length > 0} onClick={go}>Bring in {counts.new + counts.rev} drawing{counts.new + counts.rev === 1 ? '' : 's'}</button>
        </div>
      </div>
    </div>
  );
}

/** one file of the import list (kept apart so typing in one row doesn't redraw hundreds) */
const ImportRowView = memo(function ImportRowView({ r, i, target, canPick, set, startPick, picker, locked }: {
  r: ImportRow; i: number; target: string; canPick: boolean;
  set: (i: number, patch: Partial<ImportRow>) => void; startPick: (i: number) => void; picker: ReactNode; locked?: boolean;
}) {
  // (a page of a bound set: its sheet number and title as read from the page - corrected here if need be)
  const page = r.fp !== undefined;
  return (
    <div className={'ir ' + r.action + (page ? ' page' : '')}>
      <span className="fn" title={r.file.path}>{r.name}<small>{page ? `page ${r.fp! + 1} of ${r.fpn}` + (r.grp ? ' · ' + r.grp : '') : r.grp}</small></span>
      <span>{page ? <input className="input sm" value={r.sheet} placeholder="Sheet no." disabled={r.action === 'skip' || locked} onChange={(e) => set(i, { sheet: e.target.value })} /> : r.sheet || <i className="faint">—</i>}</span>
      <span className="tt" title={r.title}>{page ? <input className="input sm" value={r.title} disabled={r.action === 'skip' || locked} onChange={(e) => set(i, { title: e.target.value })} /> : r.title}</span>
      <span><input className="input sm" value={r.rev} placeholder="Rev" disabled={r.action === 'skip' || locked} onChange={(e) => set(i, { rev: e.target.value })} /></span>
      <span className="act">
        {/* every sheet of a big project in every row's list would be hundreds of thousands of
            entries: the list of sheets is only built for the row being changed */}
        <select className="input sm" disabled={locked} value={r.action === 'rev' ? 'rev:' + r.target : r.action} onChange={(e) => {
          const v = e.target.value;
          if (v === 'pick') { startPick(i); return; }
          if (v.startsWith('rev:')) set(i, { action: 'rev' as ImportAction, target: v.slice(4) });
          else set(i, { action: v as ImportAction, target: null });
        }}>
          <option value="new">New sheet</option>
          <option value="skip">Skip</option>
          {r.target && <option value={'rev:' + r.target}>New revision of {target}</option>}
          {canPick && <option value="pick">New revision of another sheet…</option>}
        </select>
        <small className="why">{r.why}</small>
        {picker}
      </span>
    </div>
  );
});

// ---------------------------------------------------------------- register
type Col = 'sheet' | 'title' | 'disc' | 'grp' | 'rev' | 'revs' | 'shapes' | 'check' | 'scale';

export function RegisterDialog({ model, readOnly, onClose, onOpen, onCommit, projectName, focus }: {
  model: QtoModel;
  readOnly: boolean;
  onClose: () => void;
  onOpen: (dwg: string) => void;
  onCommit: (ops: Op[], label: string) => void;
  projectName: string;
  /** v0.16: "Show in register" - this sheet's row, marked and scrolled to */
  focus?: string;
}) {
  useEffect(() => { if (focus) setTimeout(() => document.querySelector('.regtable tr.focus')?.scrollIntoView({ block: 'center' }), 0); }, [focus]);
  const [sort, setSort] = useState<{ c: Col; dir: 1 | -1 }>({ c: 'sheet', dir: 1 });
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<Map<string, 'ok' | 'missing'> | null>(null);
  const [checking, setChecking] = useState(false);
  const [edit, setEdit] = useState<{ id: string; f: 'sheet' | 'title' | 'disc' | 'rev'; v: string } | null>(null);
  const esc = useEscClose(onClose);
  const shapesOf = (id: string) => { let n = 0; for (const [k, v] of model.shapesByPage) if (k.startsWith(id + '.')) n += v.length; return n; };
  const scaled = (id: string, pages: number) => { for (let i = 0; i < Math.max(1, pages); i++) if (model.pages.get(pageKey(id, i))?.sc) return true; return model.regions.some((r) => r.dwg === id); };
  const rows = useMemo(() => {
    const f = q.trim().toLowerCase();
    const list = model.drawings
      .filter((d) => !f || [d.sheet, d.title, d.name, d.disc, d.grp, d.rev, d.issue].some((x) => x.toLowerCase().includes(f)))
      .map((d) => ({ d, revs: (model.revisions.get(d.id)?.length ?? 0) + 1, shapes: shapesOf(d.id), check: (model.staleByDwg.get(d.id) ?? 0) + (model.offPage.get(d.id) ?? 0), scale: scaled(d.id, d.pages) }));
    const key = (r: (typeof list)[number]): string | number => {
      switch (sort.c) {
        case 'sheet': return r.d.sheet || r.d.name;
        case 'title': return r.d.title;
        case 'disc': return r.d.disc;
        case 'grp': return r.d.grp;
        case 'rev': return revLabel(r.d);
        case 'revs': return r.revs;
        case 'shapes': return r.shapes;
        case 'check': return r.check;
        case 'scale': return r.scale ? 1 : 0;
      }
    };
    return list.sort((a, b) => {
      const x = key(a), y = key(b);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort.dir;
    });
  }, [model, q, sort]);
  const head = (c: Col, label: string, w?: number) => (
    <th style={w ? { width: w } : undefined} className={'sortable' + (sort.c === c ? ' on' : '')} onClick={() => setSort((s) => ({ c, dir: s.c === c ? (-s.dir as 1 | -1) : 1 }))}>
      {label}{sort.c === c ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );
  const checkFiles = async () => {
    setChecking(true);
    const m = new Map<string, 'ok' | 'missing'>();
    for (const d of model.drawings) m.set(d.id, (await locate(d).catch(() => null)) ? 'ok' : 'missing');
    setStatus(m);
    setChecking(false);
  };
  const exportXlsx = async () => {
    const name = (projectName || 'Drawings').replace(/[\\/:*?"<>|]+/g, ' ').trim() + ' - drawing register.xlsx';
    const p = await gt().saveFile({ title: 'Export the drawing register', name, filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
    if (!p) return;
    const out: XCell[][] = [[{ v: projectName + ' — drawing register', s: 'b' }], [{ v: 'Exported ' + new Date().toLocaleString('en-GB'), s: 'i' }], [],
      ['Sheet', 'Title', 'Discipline', 'Folder', 'Revision', 'Issue', 'Revisions', 'Shapes', 'To check', 'Scale set', 'File'].map((v) => ({ v, s: 'h' as const }))];
    for (const r of rows) out.push([r.d.sheet, r.d.title, r.d.disc, r.d.grp, r.d.rev, r.d.issue, r.revs, r.shapes, r.check || null, r.scale ? 'yes' : 'no', r.d.path]);
    for (const r of rows) for (const v of model.revisions.get(r.d.id) ?? []) out.push([r.d.sheet, r.d.title, r.d.disc, r.d.grp, v.rev || '(earlier)', v.issue, null, null, null, null, v.path]);
    await gt().files.writeBytes(p, writeXlsx([{ name: 'Register', rows: out, header: 4, widths: [14, 40, 16, 30, 10, 20, 10, 8, 9, 9, 80] }]));
    gt().openPath(p);
  };
  const save = () => {
    if (!edit) return;
    const d = model.dwgById.get(edit.id);
    if (d && (d as any)[edit.f] !== edit.v.trim()) onCommit([[edit.id, edit.f, edit.v.trim() || null]], 'Register: ' + edit.f);
    setEdit(null);
  };
  // a click on a title opens the sheet a moment later - unless it was the first of a double-click, which corrects
  // the title (it opened the sheet at once and the title could never be corrected - 0.23.2, DeepSeek #4)
  const openT = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(openT.current), []);
  const openSoon = (id: string) => { clearTimeout(openT.current); openT.current = setTimeout(() => onOpen(id), 260); };
  const cell = (id: string, f: 'sheet' | 'title' | 'disc' | 'rev', v: string) =>
    edit && edit.id === id && edit.f === f ? (
      <input className="input sm" autoFocus onFocus={(e) => e.currentTarget.select()} value={edit.v} onChange={(e) => setEdit({ ...edit, v: e.target.value })} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.preventDefault(); setEdit(null); } }} />
    ) : (
      <span className={readOnly ? '' : 'editable'} onDoubleClick={() => !readOnly && setEdit({ id, f, v })} title={readOnly ? '' : 'Double-click to edit'}>{v || <i className="faint">—</i>}</span>
    );
  return (
    <div className="scrim" onKeyDown={esc.onKeyDown} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={esc.box} tabIndex={-1} className="modal" style={{ width: 'min(1320px, 96vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', padding: 0 }}>
        <div className="imp-head">
          <div>
            <h2>Drawing register</h2>
            <p className="sub">{model.drawings.length} sheets · {[...model.revisions.values()].reduce((a, l) => a + l.length, 0)} earlier revisions. Double-click a sheet number, title, discipline or revision to correct it. Click a row to open the sheet.</p>
          </div>
        </div>
        <div className="impbar">
          <input className="input sm" style={{ width: 260 }} placeholder="Find a sheet, discipline, issue…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="grow" />
          <button className="btn sm" disabled={checking} onClick={checkFiles} title="Look for every file on the server (can take a while for big sets)">{checking ? 'Checking…' : 'Check files'}</button>
          <button className="btn sm" onClick={exportXlsx}><TIcon k="excel" /> Export</button>
        </div>
        <div className="paper-scroll" style={{ minHeight: 200 }}>
          <table className="register regtable">
            <thead>
              <tr>
                {head('sheet', 'Sheet', 120)}{head('title', 'Title')}{head('disc', 'Discipline', 130)}{head('grp', 'Folder', 200)}{head('rev', 'Revision / issue', 190)}
                {head('revs', 'Revs', 60)}{head('shapes', 'Shapes', 70)}{head('check', 'To check', 80)}{head('scale', 'Scale', 60)}
                {status && <th style={{ width: 80 }}>File</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.d.id} className={'prow' + (r.d.id === focus ? ' focus' : '')} onClick={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') onOpen(r.d.id); }}>
                  <td onClick={(e) => e.stopPropagation()}>{cell(r.d.id, 'sheet', r.d.sheet)}</td>
                  <td onClick={(e) => { e.stopPropagation(); if (!edit && e.detail === 1 && (e.target as HTMLElement).tagName !== 'INPUT') openSoon(r.d.id); }} onDoubleClick={() => clearTimeout(openT.current)}>{cell(r.d.id, 'title', sheetTitle(r.d))}</td>
                  <td onClick={(e) => e.stopPropagation()}>{cell(r.d.id, 'disc', r.d.disc)}</td>
                  <td className="muted" title={r.d.grp}>{r.d.grp}</td>
                  <td onClick={(e) => e.stopPropagation()}>{cell(r.d.id, 'rev', r.d.rev)} <span className="faint">{r.d.issue}</span></td>
                  <td className="r">{r.revs > 1 ? <b>{r.revs}</b> : r.revs}</td>
                  <td className="r">{r.shapes || ''}</td>
                  <td className="r">{r.check ? <span className="bad">{r.check}</span> : ''}</td>
                  <td>{r.scale ? <span className="okc">✓</span> : r.shapes ? <span className="bad">none</span> : ''}</td>
                  {status && <td>{status.get(r.d.id) === 'missing' ? <span className="bad">missing</span> : <span className="okc">found</span>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="imp-foot"><span className="grow" /><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
