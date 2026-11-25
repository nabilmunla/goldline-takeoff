// Import BOQ from Excel: pick files, check the sheets and the preview, import, then a
// reconciliation report (what came in, what was left out and why, totals vs the sheets).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { gt } from './api';
import { readXlsx, colName, type XWorkbook } from '../engine/xlsx';
import {
  analyseFile, remapSheet, tidyFileTitles, checkSheet, planToOps, lineAmount,
  COL_LABEL, SKIP_LABEL, type FilePlan, type SheetPlan, type SrcRow, type ColKey, type ColMap, type SheetCheck, type BuiltImport, type RowKind,
} from '../engine/boqimport';
import { STATUS_LABEL, UNFILED, type BoqModel } from '../engine/boq';
import type { ProjectSession } from '../engine/session';
import type { Op } from '../engine/types';
import { PAGE_METHOD_LABEL } from '../engine/pages';
import { fmtMoney, fmtQty } from './format';
import { IFile, IImport, ICheck, IWarn, IPlus } from './icons';
import { usePanelWidth, PanelEdge } from './PanelSize';
import { useEscClose } from './escape';

type Plan = FilePlan & { fromCover?: boolean };
interface FileEntry {
  path: string;
  name: string;
  status: 'reading' | 'ok' | 'error';
  error?: string;
  plan?: Plan;
  wb?: XWorkbook;
}

const COLS: ColKey[] = ['ref', 'desc', 'qty', 'unit', 'rate', 'amt'];
const ROW_H = 28;
const BATCH = 3000;

export function ImportDialog({ session, model, user, onClose, toast, alsoOps }: {
  session: ProjectSession;
  model: BoqModel;
  user: string;
  onClose: () => void;
  toast: (t: string) => void;
  /** written in the same change as the import's last part and as its undo (the BOQ hub's revision) */
  alsoOps?: () => Op[];
}) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filesW, setFilesW] = usePanelWidth('imp-files', 340, 220, 640);
  const [sel, setSel] = useState<{ fi: number; si: number } | null>(null);
  const [withRatesSet, setWithRates] = useState<boolean | null>(null);
  const [groupByFile, setGroupByFile] = useState(true);
  const [showSkipped, setShowSkipped] = useState(false);
  const [allSheets, setAllSheets] = useState<Set<string>>(new Set());
  const [, setVer] = useState(0);
  const bump = () => setVer((v) => v + 1);
  const [done, setDone] = useState<{ built: BuiltImport; checks: SheetCheck[]; undone: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const esc = useEscClose(onClose, busy);
  const picking = useRef(false);
  // the latest list / selection, for the reading loop (it runs across many renders)
  const filesRef = useRef(files); filesRef.current = files;
  const selRef = useRef(sel); selRef.current = sel;

  const okFiles = files.filter((f) => f.status === 'ok' && f.plan);
  const plans = okFiles.map((f) => f.plan!);
  const included = plans.flatMap((p) => p.sheets.filter((s) => s.include && s.cols).map((s) => ({ p, s })));
  const anyPriced = included.some(({ s }) => s.priced);
  // (take-off app: never the consultant's rates or amounts - the BOQ is quantities only)
  const withRates = false;
  void withRatesSet; void setWithRates;

  const addFiles = async () => {
    if (picking.current) return;
    picking.current = true;
    try {
      const paths = await gt().pickFiles({ title: 'Choose the consultant’s BOQ files' });
      const fresh = [...new Set(paths)].filter((p) => !filesRef.current.some((f) => f.path === p));
      if (!fresh.length) return;
      const entries: FileEntry[] = fresh.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() ?? p, status: 'reading' }));
      const put = (list: FileEntry[]) => { filesRef.current = list; setFiles(list); };
      put([...filesRef.current, ...entries]);
      for (let i = 0; i < entries.length; i++) {
        await new Promise((r) => setTimeout(r, 30)); // let the screen show "Reading…"
        const e = { ...entries[i] };
        try {
          if (/\.xls$/i.test(e.name)) throw new Error('Old .xls format. Open it in Excel, Save As .xlsx, and pick that file.');
          const r = await gt().fs.readFrom(e.path, 0, 512 * 1024 * 1024);
          if (!r) throw new Error('The file could not be read.');
          const wb = readXlsx(r.data);
          e.wb = wb;
          e.plan = analyseFile(e.name, wb);
          e.status = 'ok';
        } catch (err: any) {
          e.status = 'error';
          e.error = String(err?.message ?? err);
        }
        // by path: the list may have changed meanwhile (a file removed)
        const fi = filesRef.current.findIndex((x) => x.path === e.path);
        if (fi < 0) continue;
        const list = filesRef.current.map((x, k) => (k === fi ? e : x));
        tidyFileTitles(list.filter((x) => x.plan).map((x) => x.plan!));
        put(list);
        if (!selRef.current && e.plan) {
          const si = e.plan.sheets.findIndex((s) => s.include);
          if (si >= 0) { selRef.current = { fi, si }; setSel(selRef.current); }
        }
      }
    } finally {
      picking.current = false;
    }
  };

  // open the picker straight away
  useEffect(() => { addFiles(); }, []);

  const removeFile = (fi: number) => {
    const list = files.filter((_f, k) => k !== fi);
    tidyFileTitles(list.filter((x) => x.plan).map((x) => x.plan!));
    filesRef.current = list;
    setFiles(list);
    // keep looking at the same sheet when another file goes
    const next = !sel || sel.fi === fi ? null : { fi: sel.fi > fi ? sel.fi - 1 : sel.fi, si: sel.si };
    selRef.current = next;
    setSel(next);
  };

  const cur = sel ? files[sel.fi]?.plan?.sheets[sel.si] ?? null : null;
  const curWb = sel ? files[sel.fi]?.wb ?? null : null;

  const remap = (k: ColKey, c: number | null) => {
    if (!sel || !cur || !curWb || !cur.cols) return;
    const cols: ColMap = { ...cur.cols };
    if (c === null) { if (k === 'desc') return; delete cols[k]; } else cols[k] = c;
    files[sel.fi].plan!.sheets[sel.si] = remapSheet(curWb, cur, cols);
    bump();
  };

  const totals = (() => {
    let items = 0, notes = 0, heads = 0, amount = 0, warn = 0;
    for (const { p, s } of included) {
      const c = checkSheet(p.name, s, withRates);
      items += c.items; notes += c.notes; heads += c.heads; amount += c.imported; warn += c.warnings.length;
    }
    return { items, notes, heads, amount: Math.round(amount * 100) / 100, warn };
  })();

  const doImport = () => {
    if (!included.length || busy) return;
    setBusy(true);
    try {
      const roots = model.roots.filter((r) => r.id !== UNFILED);
      const afterOrd = roots.length ? roots[roots.length - 1].ord : null;
      const built = planToOps(plans, { withRates, groupByFile, by: user }, { afterOrd, beforeOrd: null });
      // big imports go in several lines, so no journal line gets too long to read back
      for (let i = 0; i < built.ops.length; i += BATCH) {
        const part: Op[] = built.ops.slice(i, i + BATCH);
        if (i + BATCH >= built.ops.length && alsoOps) part.push(...alsoOps());
        session.commit(part, `Imported BOQ (${built.counts.items} items)`, { recordUndo: false });
      }
      const checks = included.map(({ p, s }) => checkSheet(p.name, s, withRates));
      setDone({ built, checks, undone: false });
    } finally {
      setBusy(false);
    }
  };

  const undoImport = () => {
    if (!done || done.undone) return;
    session.commit([...done.built.top.map((id) => [id, 'del', true] as Op), ...(alsoOps?.() ?? [])], 'Undid BOQ import', { recordUndo: false });
    setDone({ ...done, undone: true });
    toast('Import undone. The imported bills are in the recycle bin.');
  };

  if (done) return <ImportReport done={done} withRates={withRates} onUndo={undoImport} onClose={onClose} />;

  return (
    <div className="scrim" onKeyDown={esc.onKeyDown}>
      <div ref={esc.box} tabIndex={-1} className="modal imp">
        <div className="imp-head">
          <div>
            <h2>Import BOQ from Excel</h2>
            <p className="sub">Each sheet becomes a bill. Check the sheets and the preview, then import. Nothing in the files is changed.</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={addFiles}><IPlus /> Add files</button>
          </div>
        </div>

        <div className="imp-body" style={{ gridTemplateColumns: `minmax(220px, min(${filesW}px, 45vw)) minmax(320px, 1fr)` }}>
          <div className="pw-wrap" style={{ width: '100%' }}>
          <PanelEdge side="right" width={filesW} onWidth={setFilesW} />
          <aside className="imp-files">
            {files.length === 0 && <div className="muted" style={{ padding: 16 }}>Choose one or more .xlsx files. A BOQ split over several files comes in as one BOQ.</div>}
            {files.map((f, fi) => (
              <div key={f.path} className="imp-file">
                <div className="imp-fname" title={f.path}>
                  <IFile />
                  <span className="t">{f.name}</span>
                  <button className="x" onClick={() => removeFile(fi)} title="Leave this file out">×</button>
                </div>
                {f.status === 'reading' && <div className="imp-note"><span className="dot busy" /> Reading…</div>}
                {f.status === 'error' && <div className="imp-note err">{f.error}</div>}
                {f.plan && groupByFile && okFiles.length > 1 && f.plan.sheets.filter((s) => s.include).length > 1 && (
                  <div className="imp-billname">
                    <input className="input sm ref" value={f.plan.ref} placeholder="Ref" onChange={(e) => { f.plan!.ref = e.target.value; bump(); }} />
                    <input className="input sm" value={f.plan.title} onChange={(e) => { f.plan!.title = e.target.value; bump(); }} />
                  </div>
                )}
                {f.plan?.sheets.map((s, si) => {
                  const items = s.rows.filter((r) => r.kind === 'item').length;
                  if (!(s.cols && items) && !allSheets.has(f.path)) return null;
                  const on = sel?.fi === fi && sel?.si === si;
                  return (
                    <div key={s.name} className={'imp-sheet' + (on ? ' on' : '') + (s.include ? '' : ' off')} onClick={() => s.cols && setSel({ fi, si })}>
                      <input
                        type="checkbox"
                        checked={s.include}
                        disabled={!s.cols || !items}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => { s.include = e.target.checked; bump(); }}
                        title={s.cols ? (s.include ? 'Leave this sheet out' : 'Bring this sheet in') : s.reason}
                      />
                      <span className="sn">{s.name}</span>
                      <span className="sc">{s.cols && items ? `${items.toLocaleString('en-US')} items` : s.reason}</span>
                    </div>
                  );
                })}
                {f.plan && (() => {
                  const others = f.plan.sheets.filter((s) => !(s.cols && s.rows.some((r) => r.kind === 'item'))).length;
                  if (!others) return null;
                  const open = allSheets.has(f.path);
                  return (
                    <button className="imp-more" onClick={() => { const n = new Set(allSheets); open ? n.delete(f.path) : n.add(f.path); setAllSheets(n); }}>
                      {open ? 'Hide' : 'Show'} {others} other sheet{others > 1 ? 's' : ''} (cover, title pages, summaries, empty)
                    </button>
                  );
                })()}
              </div>
            ))}
          </aside>
          </div>

          <section className="imp-preview">
            {cur && cur.cols ? (
              <SheetPreview key={`${sel!.fi}:${sel!.si}`} sheet={cur} wb={curWb!} withRates={withRates} showSkipped={showSkipped} onChange={bump} onRemap={remap} fileName={files[sel!.fi].name} />
            ) : (
              <div className="empty">{files.some((f) => f.status === 'reading') ? 'Reading the files…' : 'Pick a sheet on the left to see how it will come in.'}</div>
            )}
          </section>
        </div>

        <div className="imp-foot">
          <label className="check"><input type="checkbox" checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)} /> Show the rows that are left out</label>
          {okFiles.length > 1 && <label className="check"><input type="checkbox" checked={groupByFile} onChange={(e) => setGroupByFile(e.target.checked)} /> One bill per file, sheets under it</label>}
          <span className="grow" />
          <span className="imp-sum">
            {included.length ? (
              <>
                <b>{totals.items.toLocaleString('en-US')}</b> items in <b>{included.length}</b> sheet{included.length > 1 ? 's' : ''}
                {withRates && anyPriced ? <> · AED <b>{fmtMoney(totals.amount)}</b></> : null}
                {totals.warn ? <span className="warnchip"><IWarn /> {totals.warn} to check</span> : null}
              </>
            ) : 'No sheets chosen'}
          </span>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!included.length || busy || files.some((f) => f.status === 'reading')} onClick={doImport}>
            <IImport /> {busy ? 'Importing…' : `Import ${totals.items.toLocaleString('en-US')} items`}
          </button>
        </div>
      </div>
    </div>
  );
}

function SheetPreview({ sheet, wb, withRates, showSkipped, onChange, onRemap, fileName }: {
  sheet: SheetPlan;
  wb: XWorkbook;
  withRates: boolean;
  showSkipped: boolean;
  onChange: () => void;
  onRemap: (k: ColKey, c: number | null) => void;
  fileName: string;
}) {
  const check = checkSheet(fileName, sheet, withRates);
  const xs = wb.sheet(sheet.name);
  const headerCells = xs.rows.get(sheet.headerRow) ?? [];
  const colOpts = Array.from({ length: Math.max(xs.maxCol, 6) }, (_x, i) => i + 1);
  // indent of items/notes = level of the heading they sit under
  const view = (() => {
    const out: { r: SrcRow; depth: number }[] = [];
    let lvl = 0;
    for (const r of sheet.rows) {
      if (r.kind === 'head') { lvl = r.level; out.push({ r, depth: r.level - 1 }); continue; }
      if (r.kind === 'skip' && !showSkipped) continue;
      out.push({ r, depth: r.kind === 'skip' ? 0 : lvl });
    }
    return out;
  })();

  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, h: 600 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setScroll({ top: el.scrollTop, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - 10);
  const last = Math.min(view.length, Math.ceil((scroll.top + scroll.h) / ROW_H) + 10);

  const setKind = (r: SrcRow, k: RowKind) => {
    if (k === r.kind) return;
    if (k === 'head') {
      // a new heading goes one level under the heading above it
      const i = sheet.rows.indexOf(r);
      let above = 0;
      for (let j = i - 1; j >= 0; j--) if (sheet.rows[j].kind === 'head') { above = sheet.rows[j].level; break; }
      r.level = above ? above + 1 : 1;
    }
    if (k === 'skip') r.why = 'user';
    else r.why = undefined;
    r.kind = k;
    r.user = true;
    onChange();
  };
  const setLevel = (r: SrcRow, d: number) => {
    r.level = Math.max(1, Math.min(9, r.level + d));
    r.user = true;
    onChange();
  };

  return (
    <div className="imp-sheetview">
      <div className="imp-sheethead">
        <div className="imp-billname big">
          <input className="input sm ref" value={sheet.ref} placeholder="Ref" onChange={(e) => { sheet.ref = e.target.value; onChange(); }} />
          <input className="input sm" value={sheet.title} onChange={(e) => { sheet.title = e.target.value; onChange(); }} />
        </div>
        <div className="imp-meta">Sheet <b>{sheet.name}</b> · column headings on row {sheet.headerRow}</div>
        <div className="imp-cols">
          {COLS.map((k) => (
            <label key={k}>
              <span>{COL_LABEL[k]}</span>
              <select className="input sm" value={sheet.cols?.[k] ?? ''} onChange={(e) => onRemap(k, e.target.value ? Number(e.target.value) : null)}>
                {k !== 'desc' && <option value="">—</option>}
                {colOpts.map((c) => {
                  const t = headerCells[c]?.v;
                  return <option key={c} value={c}>{colName(c)}{t ? ' · ' + String(t).slice(0, 14) : ''}</option>;
                })}
              </select>
            </label>
          ))}
        </div>
        <div className="imp-stats">
          <span><b>{check.items.toLocaleString('en-US')}</b> items</span>
          <span><b>{check.notes.toLocaleString('en-US')}</b> description lines</span>
          <span><b>{check.heads}</b> headings</span>
          <span title={Object.entries(check.skipped).map(([k, v]) => `${v} × ${SKIP_LABEL[k as keyof typeof SKIP_LABEL]}`).join('\n')}>
            <b>{Object.values(check.skipped).reduce((a, b) => a + (b ?? 0), 0).toLocaleString('en-US')}</b> rows left out
          </span>
          {check.rateOnly ? <span><b>{check.rateOnly}</b> rate only</span> : null}
          {check.statuses ? <span><b>{check.statuses}</b> with a status</span> : null}
          {check.ps ? <span><b>{check.ps}</b> provisional sums</span> : null}
          {sheet.pages.count > 0 && (
            <span
              className={sheet.pages.listed && sheet.pages.listed === sheet.pages.count ? 'good' : ''}
              title={`Pages from ${PAGE_METHOD_LABEL[sheet.pages.method]}${sheet.pages.pattern ? ` (printed as “${sheet.pages.pattern.replace('{A}', sheet.name.trim()).replace(/\{P[^}]*\}/, 'n')}”)` : ''}${sheet.pages.est ? `\n${sheet.pages.est} page break${sheet.pages.est > 1 ? 's' : ''} worked out from the row heights (marked ~): check against the PDF` : ''}`}
            >
              <b>{sheet.pages.count}</b> pages
              {sheet.pages.method === 'print' ? ' (print setup)' : sheet.pages.method === 'labels' ? ' (printed in the sheet)' : sheet.pages.method === 'counted' ? ' (counted)' : ' (estimated)'}
              {sheet.pages.est ? <> · <b>{sheet.pages.est}</b> estimated</> : null}
              {sheet.pages.listed ? (sheet.pages.listed === sheet.pages.count ? <> <ICheck /> as the collection page</> : <> · the collection page lists {sheet.pages.listed}</>) : null}
            </span>
          )}
          {withRates && sheet.priced ? (
            <span className={check.collected && Math.abs(check.collected - check.imported) > 0.5 ? 'bad' : 'good'}>
              AED <b>{fmtMoney(check.imported)}</b>
              {check.collected ? (Math.abs(check.collected - check.imported) <= 0.5 ? <> <ICheck /> matches the sheet</> : <> vs {fmtMoney(check.collected)} in the sheet</>) : null}
            </span>
          ) : null}
        </div>
        {check.warnings.length > 0 && <div className="imp-warn"><IWarn /> {check.warnings.join(' · ')}</div>}
      </div>
      <div className="imp-table-head">
        <span>Line</span><span>Ref</span><span>Description</span><span className="r">Qty</span><span>Unit</span><span className="r">Rate</span><span className="r">Amount</span><span>Page</span>
      </div>
      <div className="imp-table" ref={ref} onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}>
        <div style={{ height: view.length * ROW_H, position: 'relative' }}>
          {view.slice(first, last).map(({ r, depth }, i) => {
            const idx = first + i;
            const amt = r.kind === 'item' ? lineAmount(r, withRates) : 0;
            const status = r.kind === 'item' ? (r.ro ? 'Rate only' : r.st ? (r.stx || STATUS_LABEL[r.st]) : null) : null;
            return (
              <div key={r.r + ':' + r.kind + ':' + idx} className={'imp-row k-' + r.kind} style={{ transform: `translateY(${idx * ROW_H}px)` }} title={r.kind === 'skip' ? SKIP_LABEL[r.why ?? 'blank'] + ' · row ' + r.r : 'Row ' + r.r}>
                <span className="kind">
                  <select value={r.kind} onChange={(e) => setKind(r, e.target.value as RowKind)}>
                    <option value="head">Heading</option>
                    <option value="item">Item</option>
                    <option value="note">Description</option>
                    <option value="skip">Leave out</option>
                  </select>
                  {r.kind === 'head' && (
                    <span className="lv">
                      <button onClick={() => setLevel(r, -1)} disabled={r.level <= 1} title="Level up">‹</button>
                      <button onClick={() => setLevel(r, 1)} title="Level down">›</button>
                    </span>
                  )}
                </span>
                <span className="ref">{r.ref}</span>
                <span className="desc" style={{ paddingLeft: 6 + depth * 16 }}>
                  {r.kind === 'skip' ? <i>{r.desc || SKIP_LABEL[r.why ?? 'blank']}</i> : r.desc}
                  {r.ps && <span className="tag ps">PS</span>}
                </span>
                <span className="r num">{r.kind === 'item' ? fmtQty(r.qty) : ''}</span>
                <span>{r.unit}</span>
                <span className="r num">{r.kind === 'item' && withRates && r.rate !== null ? fmtMoney(r.rate) : ''}</span>
                <span className="r num">{status ? <i className="st">{status}</i> : r.kind === 'item' && amt ? fmtMoney(amt) : r.kind === 'skip' && r.amt ? <i>{fmtMoney(r.amt)}</i> : ''}</span>
                <span className={'pg' + (r.pest ? ' est' : '')} title={r.pest ? 'Estimated page (Excel works this page break out itself): check against the PDF' : undefined}>{r.kind !== 'skip' && r.page ? <bdi>{(r.pest ? '~' : '') + r.page}</bdi> : ''}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ImportReport({ done, withRates, onUndo, onClose }: {
  done: { built: BuiltImport; checks: SheetCheck[]; undone: boolean };
  withRates: boolean;
  onUndo: () => void;
  onClose: () => void;
}) {
  const { built, checks } = done;
  const esc = useEscClose(onClose);
  const tot = checks.reduce((a, c) => a + c.imported, 0);
  const problems = checks.filter((c) => c.warnings.length).length;
  return (
    <div className="scrim" onKeyDown={esc.onKeyDown}>
      <div ref={esc.box} tabIndex={-1} className="modal imp report">
        <div className="imp-head">
          <div>
            <h2>{done.undone ? 'Import undone' : 'Imported'}</h2>
            <p className="sub">
              {built.counts.items.toLocaleString('en-US')} items, {built.counts.notes.toLocaleString('en-US')} description lines and {built.counts.heads.toLocaleString('en-US')} headings in {built.counts.bills} bills
              {withRates ? <> · AED {fmtMoney(Math.round(tot * 100) / 100)}</> : null}.
              {' '}{problems ? `${problems} sheet${problems > 1 ? 's' : ''} to check (below).` : 'Every sheet checks out.'}
              {' '}Consultant quantities are kept: if you change one later, it is highlighted.
            </p>
          </div>
        </div>
        <div className="paper-scroll imp-report-scroll">
          <table className="register">
            <thead>
              <tr>
                <th>Sheet</th>
                <th className="r">Items</th>
                <th className="r">Description lines</th>
                <th className="r">Headings</th>
                <th className="r">Rows left out</th>
                {withRates && <th className="r">Imported (AED)</th>}
                {withRates && <th className="r">Sheet says (AED)</th>}
                <th>Check</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => {
                const skipped = Object.values(c.skipped).reduce((a, b) => a + (b ?? 0), 0);
                const ok = !c.warnings.length;
                return (
                  <tr key={c.file + c.sheet}>
                    <td><span className="pn">{c.sheet}</span><span className="faint"> · {c.file}</span></td>
                    <td className="r num">{c.items.toLocaleString('en-US')}</td>
                    <td className="r num">{c.notes.toLocaleString('en-US')}</td>
                    <td className="r num">{c.heads}</td>
                    <td className="r num" title={Object.entries(c.skipped).map(([k, v]) => `${v} × ${SKIP_LABEL[k as keyof typeof SKIP_LABEL]}`).join('\n')}>{skipped.toLocaleString('en-US')}</td>
                    {withRates && <td className="r num">{fmtMoney(c.imported)}</td>}
                    {withRates && <td className="r num">{c.collected ? fmtMoney(c.collected) : '–'}</td>}
                    <td>{ok ? <span className="acc edit">OK</span> : <span className="imp-warn inline"><IWarn /> {c.warnings.join(' · ')}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="imp-foot">
          <span className="grow" />
          {!done.undone && <button className="btn danger" onClick={onUndo}>Undo import</button>}
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
