// v0.16 - the take-off's BOQ tab (items 20, 23, 24, 25).
//  - a real tree: bill › section › sub-section › item › sub-item (an additional item relinked to an
//    item), chevrons on every level with something under it; Expand all / Collapse all / Show levels
//  - search by ref, description or code (the consultant's page / code) - opens the tree to each match,
//    marks it; Show ▾ All / Linked / Not linked / Linked by me / Differs > 5 % / Additional items
//  - the column headers and the current "bill › section" stay at the top while scrolling
//  - expanded rows, the Show choice and the scroll position are remembered per person, PC and take-off
//  - the selected line lists its take-offs: tick several, Unlink (one Ctrl+Z links them again)
//  - additional items (items the BOQ doesn't have): added by a QS with bill and location; the
//    estimator (this tab inside the estimate) can edit, move or relink them
// Windowed: only the rows on screen are drawn (10,000+ lines).
import { FilledCopyDialog } from '../FilledCopy';
import { allWins } from '../popout';
import { targetsFromMirror } from '../../engine/boqfill';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { menuOpened } from './ListBits';
import type { Op } from '../../engine/types';
import { alreadyLinked, MEASURE_LABEL, mainMeasure, measuresFor, mirrorPath, qxId, type QtoModel, type MirrorRow, type Dummy, type TItem } from '../../engine/qto/model';
import { linkOps, removeDummyOps } from '../../engine/qto/ops';
import { measureForUnit, unitMismatch } from '../../engine/qto/units';
import { treeRows, collapsedForLevel, closable, ancestors, crumbOf, searchMatch, BOQ_SHOW_LABEL, type BoqShow, type TreeRow } from '../../engine/qto/boqtree';
import {
  additionalItemOps, keepAsAdditionalOps, editAdditionalOps, canEditSuggestion, linkedItems, unlinkOps, dummyState, DUMMY_STATE_LABEL, addView,
  billChoices, billLabel, knownLocations, lineOf, dummyOfLine, linkTarget, qtyOf, hasBoq, linkKind, lineTotals, type AddFields, type DummyState,
} from '../../engine/qto/additional';
import type { LineChange } from '../../engine/qto/bridge';
import { q as fq, useQtoFmt } from './numfmt';
import { fmtQty } from '../format';
import { TIcon } from './ticons';
import { useEscClose } from '../escape';
import { onRevealInBoq, takePendingReveal } from './boqnav';

const ROW = 30;
const UNITS = ['m2', 'm', 'm3', 'nr', 'kg', 'item'];
const uq = (x: number, unit: string) => { const m = measureForUnit(unit); return m ? fq(x, m) : fmtQty(x); };

/** the estimator's side (the take-off shown inside the estimate): an additional item's line is changed in the estimate */
export interface EstEdit {
  line(lineId: string, c: LineChange, label: string): boolean;
}

export interface BoqTabProps {
  model: QtoModel;
  readOnly: boolean;
  /** inside the estimate (the estimator) */
  embedded: boolean;
  linkBox?: ReactNode;
  activeId: string | null;
  /** take-offs selected in the list (linked together with "Link … here"); else the active one */
  selectedIds?: string[];
  me: string;
  meName: string;
  projectId: string;
  estEdit?: EstEdit | null;
  onCommit: (ops: Op[], label: string) => void;
  /** a take-off in a line's card clicked */
  onSelectItem: (id: string) => void;
  toast: (t: ReactNode) => void;
  /** Match / relink a temporary line or an additional item to a BOQ line (MatchDialog) */
  onMatch: (dm: string, relink: boolean) => void;
  /** the temporary lines (below the tree) */
  below?: ReactNode;
}

type Sel = { k: 'row'; id: string } | { k: 'dm'; id: string } | null;
interface Mem { c?: string[]; top?: number; show?: BoqShow; sel?: Sel }
const memRead = (k: string): Mem => { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; } };
const memWrite = (k: string, m: Mem) => { try { localStorage.setItem(k, JSON.stringify(m)); } catch { /* full */ } };

/** the mark of an additional item / temporary line (and of a line of the BOQ copy made from one) */
export function QaMark({ st, title }: { st: DummyState | 'a' | 'n'; title?: string }) {
  if (st === 'add' || st === 'a') return <span className="qam add" title={title ?? 'Additional – QS: an item the BOQ doesn\'t have'}>A+</span>;
  if (st === 'open' || st === 'n') return <span className="qam open" title={title ?? 'Not resolved – QS: match it to a BOQ line or keep it as an additional item'}>!</span>;
  if (st === 'relinked') return <span className="qam rel" title={title ?? 'Additional item relinked to a BOQ item: counted in its Take-off quantity'}>↳</span>;
  return null;
}

/** v0.16: the link mark of a take-off in the take-off list - none · teal link = BOQ item · amber "A+" = additional item */
export function LinkMark({ model, ti }: { model: QtoModel; ti: string }) {
  const k = linkKind(model, ti);
  if (k.k === 'none') return <span className="ib dim lkm" data-linkmark title="Not linked to a BOQ line yet"><TIcon k="link" size={12} /></span>;
  if (k.k === 'add') return <span className="ib lkm add" data-linkmark title={k.open ? 'Linked to a temporary line not resolved yet (Not resolved – QS)' : 'Linked to an additional item (Additional – QS)'}>A+{k.n > 1 ? <small>{k.n}</small> : null}</span>;
  return <span className="ib lkm boq" data-linkmark title={`Linked to ${k.n} BOQ line${k.n > 1 ? 's' : ''}`}><TIcon k="link" size={12} />{k.n > 1 ? k.n : ''}</span>;
}

/** a menu button: closes on a click outside or Esc (UI rule 6) */
function Drop({ label, title, children, cls }: { label: ReactNode; title?: string; children: ReactNode; cls?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setOpen(false); } };
    // (v0.16.2 QA hunt BUG-004: a click in the drawing's own window closes it too)
    const ws = allWins();
    for (const w of ws) { w.addEventListener('mousedown', down, true); w.addEventListener('keydown', key, true); }
    const off = menuOpened();
    return () => { off(); for (const w of ws) { w.removeEventListener('mousedown', down, true); w.removeEventListener('keydown', key, true); } };
  }, [open]);
  return (
    <div className={'bq-drop ' + (cls ?? '')} ref={ref}>
      <button className={'btn sm ghost' + (open ? ' on' : '')} title={title} onClick={() => setOpen((x) => !x)}>{label} <TIcon k="chev" size={10} /></button>
      {open && <div className="bq-dropmenu" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

/** the words of the search marked in a text */
function Hl({ text, q }: { text: string; q: string }) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return <>{text}</>;
  const lo = text.toLowerCase();
  const marks: [number, number][] = [];
  for (const w of words) { let i = lo.indexOf(w); while (i >= 0) { marks.push([i, i + w.length]); i = lo.indexOf(w, i + w.length); } }
  if (!marks.length) return <>{text}</>;
  marks.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of marks) { if (b <= at) continue; const s = Math.max(a, at); if (s > at) out.push(text.slice(at, s)); out.push(<mark key={s}>{text.slice(s, b)}</mark>); at = b; }
  out.push(text.slice(at));
  return <>{out}</>;
}

export function BoqTab(p: BoqTabProps) {
  useQtoFmt();
  const { model } = p;
  const has = model.boqById.size > 0;
  const [fill, setFill] = useState(false);
  const memKey = 'qto-boq:' + p.me + ':' + p.projectId;
  const mem = useMemo(() => memRead(memKey), [memKey]);
  const [q, setQ] = useState('');
  const [show, setShow] = useState<BoqShow>(mem.show && BOQ_SHOW_LABEL[mem.show] ? mem.show : 'all');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(mem.c ?? []));
  const [sel, setSel] = useState<Sel>(mem.sel && (mem.sel.k === 'row' || mem.sel.k === 'dm') ? mem.sel : null);
  const [dialog, setDialog] = useState<{ mode: 'new' | 'edit' | 'keep'; d?: Dummy } | null>(null);
  const memRef = useRef<Mem>({ ...mem });
  const save = (x: Partial<Mem>) => { memRef.current = { ...memRef.current, ...x }; memWrite(memKey, memRef.current); };
  useEffect(() => { save({ c: [...collapsed], show, sel }); }, [collapsed, show, sel]);

  const rows = useMemo(() => (has && show !== 'add' ? treeRows(model, { collapsed, q, show, me: p.me }) : []), [model, collapsed, q, show, has, p.me]);
  const linkable = useMemo(() => {
    const ids = p.selectedIds?.length ? p.selectedIds : p.activeId ? [p.activeId] : [];
    // (v0.16: never a room - its quantities reach the BOQ only through the Finishes Summary)
    return ids.map((id) => model.itemById.get(id)).filter((x): x is TItem => !!x && x.kind !== 'room' && !x.dc);
  }, [p.selectedIds, p.activeId, model]);

  // ---- windowing + the remembered scroll position
  const listRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, h: 600 });
  const restored = useRef(false);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || restored.current || !rows.length) return;
    restored.current = true;
    const top = Math.min(mem.top ?? 0, Math.max(0, rows.length * ROW - el.clientHeight));
    el.scrollTop = top;
    setScroll({ top, h: el.clientHeight });
  }, [rows.length]);
  const saveT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTop = useRef<number | null>(null);
  const onScroll = (el: HTMLDivElement) => {
    setScroll({ top: el.scrollTop, h: el.clientHeight });
    if (saveT.current) clearTimeout(saveT.current);
    const top = el.scrollTop;
    lastTop.current = top;
    saveT.current = setTimeout(() => save({ top }), 150);
  };
  // (leaving the tab: where it was, even if the last scroll was a moment ago)
  useEffect(() => () => { if (saveT.current) clearTimeout(saveT.current); if (lastTop.current !== null) save({ top: lastTop.current }); }, []);
  const first = Math.max(0, Math.floor(scroll.top / ROW) - 10);
  const last = Math.min(rows.length, Math.ceil((scroll.top + scroll.h) / ROW) + 10);
  const topRow = rows[Math.min(rows.length - 1, Math.floor(scroll.top / ROW))];
  const crumb = topRow ? crumbOf(model, topRow.k === 'row' ? topRow.id : topRow.parent) : '';

  // ---- jump to a line (from the properties panel, a take-off just linked...)
  const [scrollTo, setScrollTo] = useState<{ id: string; n: number } | null>(null);
  const reveal = (target: string) => {
    let t = target;
    if (t.startsWith('ti:')) { const l = model.linksByItem.get(t)?.[0]; if (!l) return; t = l.to; }
    let row: string | null = null;
    let s: Sel = null;
    if (t.startsWith('dm:')) {
      const d = model.dummyById.get(t);
      if (!d) return;
      if (d.map && model.boqById.has(d.map)) { row = d.map; s = d.add ? { k: 'dm', id: d.id } : { k: 'row', id: d.map }; }
      else if (lineOf(model, d)) { row = qxId(d.id); s = { k: 'row', id: row }; }
      else { setQ(''); setShow('add'); setSel({ k: 'dm', id: d.id }); return; }
    } else {
      const id = t.startsWith('b:') ? t.slice(2) : t;
      if (!model.boqById.has(id)) return;
      row = id;
      s = { k: 'row', id };
    }
    setQ('');
    setShow('all');
    const open = [...ancestors(model, row), ...(s?.k === 'dm' ? [row] : [])];
    setCollapsed((c) => { if (!open.some((x) => c.has(x))) return c; const n = new Set(c); for (const x of open) n.delete(x); return n; });
    setSel(s);
    setScrollTo({ id: s?.k === 'dm' ? s.id : row, n: Date.now() });
  };
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  useEffect(() => {
    const t = takePendingReveal(p.projectId);
    if (t) setTimeout(() => revealRef.current(t), 0);
    return onRevealInBoq(p.projectId, (x) => { takePendingReveal(p.projectId); revealRef.current(x); });
  }, [p.projectId]);
  useEffect(() => {
    if (!scrollTo || !listRef.current) return;
    const i = rows.findIndex((r) => r.id === scrollTo.id);
    if (i < 0) return;
    const el = listRef.current;
    const want = i * ROW - el.clientHeight / 2 + ROW;
    if (i * ROW < el.scrollTop || (i + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, want);
    setScroll({ top: el.scrollTop, h: el.clientHeight });
    setScrollTo(null);
  }, [scrollTo, rows]);

  const toggle = (id: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // ---- linking the selected (or active) take-offs to a line
  const linkHere = (to: string, unit: string, label: string, items = linkable) => {
    if (!items.length || p.readOnly) return;
    const ops: Op[] = [];
    const done: string[] = [], twice: string[] = [];
    let missing = '';
    let mism = '';
    for (const it of items) {
      const target = linkTarget(model, to);
      if (alreadyLinked(model, it.id, target)) { twice.push(it.name); continue; }
      const ms = measureForUnit(unit) ?? mainMeasure(it);
      ops.push(...linkOps(it.id, target, ms).ops);
      done.push(it.name);
      if (!measuresFor(it).includes(ms)) missing = ms === 'vol' ? 'thickness' : ms === 'area' ? 'height' : 'size';
      else if (unitMismatch(unit, ms)) mism = unit;
    }
    if (ops.length) p.onCommit(ops, done.length > 1 ? `Linked ${done.length} take-offs to BOQ` : 'Linked to BOQ');
    if (done.length) p.toast(<span>Linked <b>{done.length > 1 ? `${done.length} take-offs` : done[0]}</b> to {label}{missing ? <> — <b>0 until it has a {missing}</b></> : mism ? ' — check: the line is in ' + mism : ''}.{twice.length ? ` ${twice.join(', ')} ${twice.length > 1 ? 'were' : 'was'} linked there already.` : ''}</span>);
    else if (twice.length) p.toast(<span><b>{twice.join(', ')}</b> {twice.length > 1 ? 'are' : 'is'} already linked to {label}.</span>);
  };
  const linkLabel = linkable.length > 1 ? `${linkable.length} take-offs` : linkable[0] ? `“${linkable[0].name}”` : '';

  const selRow = sel?.k === 'row' ? model.boqById.get(sel.id) ?? null : null;
  const selDm = sel?.k === 'dm' ? model.dummyById.get(sel.id) ?? null : selRow ? dummyOfLine(model, selRow.id) : null;
  const boqHere = hasBoq(model);

  // ---- additional items: the dialogs' results
  const by = { username: p.me, name: p.meName };
  const saveDialog = (f: AddFields) => {
    if (!dialog) return;
    if (dialog.mode === 'new') {
      const r = additionalItemOps(model, f, by);
      p.onCommit(r.ops, 'Additional item');
      p.toast(<span>Added the additional item “{f.desc.trim()}”{f.bill ? <> in <b>{billLabel(model, f.bill)}</b></> : ''}. It is added to the BOQ as a line flagged Additional – QS (filled copies list it on their own sheet).</span>);
      setShow('add');
      setSel({ k: 'dm', id: r.id });
    } else if (dialog.mode === 'keep' && dialog.d) {
      p.onCommit(keepAsAdditionalOps(dialog.d, f, by), 'Kept as additional item');
      // v0.16.2 (feedback 2): it left the temporary lines and is not in the tree until the estimate takes it -
      // shown where it is now, like a new additional item
      p.toast(<span>Kept “{(f.desc || dialog.d.desc).trim()}” as an additional item{f.bill ? <> in <b>{billLabel(model, f.bill)}</b></> : ''}: here under Show ▾ Additional items; in the BOQ as a line flagged Additional – QS.</span>);
      setShow('add');
      setQ('');
      setSel({ k: 'dm', id: dialog.d.id });
    } else if (dialog.mode === 'edit' && dialog.d) {
      const d = dialog.d;
      const line = lineOf(model, d);
      // the estimator: in the estimate (it is the estimator's from then on); a QS: his suggestion
      if (p.embedded && line && p.estEdit) p.estEdit.line(line.id, f, 'Changed additional item');
      else p.onCommit(editAdditionalOps(d, f), 'Changed additional item');
    }
    setDialog(null);
  };

  const addRows = useMemo(() => (show === 'add' ? model.dummies.filter((d) => { const st = dummyState(model, d, boqHere); return st === 'add' || st === 'open' || st === 'relinked'; }) : []), [model, show, boqHere]);
  const addMatch = searchMatch(q);
  const addShown = addMatch ? addRows.filter((d) => { const v = addView(model, d); return addMatch(v.ref + ' ' + v.desc + ' ' + v.loc + ' ' + v.by + ' ' + billLabel(model, v.bill)); }) : addRows;
  // v0.16.2 a search in the other views finds the additional items too (they are listed under Show ▾ Additional items)
  const addElsewhere = show !== 'add' && addMatch ? model.dummies.filter((d) => { const st = dummyState(model, d, boqHere); if (st !== 'add' && st !== 'open' && st !== 'relinked') return false; const v = addView(model, d); return addMatch(v.ref + ' ' + v.desc + ' ' + v.loc + ' ' + v.by + ' ' + billLabel(model, v.bill)); }).length : 0;

  return (
    <div className="qto-boq v16">
      {fill && <FilledCopyDialog targets={targetsFromMirror(model.boqById.values(), model.boqImports, lineTotals(model))} from="takeoff" onClose={() => setFill(false)} />}
      {p.linkBox}
      {!has && (
        <div className="qto-boqnote">
          {p.embedded ? (
            <>The BOQ copy for take-offs is being prepared from this project…</>
          ) : (
            <>Until the BOQ is here, make temporary lines and link your take-offs to them. Once the BOQ is imported (box above), match each temporary line to the real BOQ line — or keep it as an additional item.</>
          )}
        </div>
      )}
      {has && (
        <>
          <div className="bq-tools">
            <input className="input sm bq-search" placeholder="Find by ref, description or code" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }} />
            {/* v0.16.2 the consultant's own Excel BOQ with this take-off's quantities, as a new copy */}
            {addElsewhere > 0 && <button className="btn sm ghost bq-addhits" data-addhits title="Additional items are listed under Show ▾ Additional items" onClick={() => setShow('add')}>{addElsewhere} additional item{addElsewhere > 1 ? 's' : ''} match ›</button>}
            {model.boqImports.size > 0 && <button className="btn sm ghost" data-fillopen title="A new copy of the consultant's own Excel BOQ with what this take-off measured (their file is never changed)" onClick={() => setFill(true)}>Filled copy…</button>}
          </div>
          <div className="bq-tools bq-tools2">
            <Drop cls="bq-show" label={<span>Show{show !== 'all' ? <b>: {BOQ_SHOW_LABEL[show]}</b> : ''}</span>} title="Which lines to show">
              {(Object.keys(BOQ_SHOW_LABEL) as BoqShow[]).map((k) => (
                <button key={k} className={'mi' + (show === k ? ' on' : '')} onClick={() => { setShow(k); if (k === 'add' && sel?.k === 'row') setSel(null); }}>
                  <span className="ck">{show === k ? '✓' : ''}</span><span className="lb">{BOQ_SHOW_LABEL[k]}</span>
                  {k === 'add' && addCount(model, boqHere) > 0 && <span className="kb">{addCount(model, boqHere)}</span>}
                </button>
              ))}
            </Drop>
            {show !== 'add' && (
              <>
                <button className="btn sm ghost bq-expand" title="Open every heading" onClick={() => setCollapsed(new Set())}>Expand all</button>
                <button className="btn sm ghost bq-collapse" title="Close every heading (bills only)" onClick={() => setCollapsed(new Set(closable(model).map((x) => x.id)))}>Collapse all</button>
                <Drop cls="bq-levels" label="Show levels" title="Show the BOQ down to a level">
                  {([[1, 'Bills'], [2, '+ Sections'], [3, '+ Sub-sections'], [0, 'All']] as const).map(([lv, lb]) => (
                    <button key={lv} className="mi" onClick={() => setCollapsed(collapsedForLevel(model, lv))}><span className="ck" /><span className="lb">{lb}</span></button>
                  ))}
                </Drop>
              </>
            )}
          </div>
          {show === 'add' ? (
            <AddList model={model} rows={addShown} all={addRows.length} sel={sel?.k === 'dm' ? sel.id : null} onSel={(id) => setSel({ k: 'dm', id })} q={q} boq={boqHere} />
          ) : (
            <>
              <div className="bq-head"><span>Ref</span><span>Description</span><span>Unit</span><span className="r">BOQ</span><span className="r">Take-off</span></div>
              <div className="bq-listwrap">
              {crumb && scroll.top >= ROW && <div className="bq-crumb" title={crumb}>{crumb}</div>}
              <div className="bq-list" ref={listRef} onScroll={(e) => onScroll(e.currentTarget)}>
                <div style={{ height: rows.length * ROW, position: 'relative' }}>
                  {rows.slice(first, last).map((r, i) => (
                    <TreeLine
                      key={r.id}
                      r={r}
                      y={(first + i) * ROW}
                      model={model}
                      q={q}
                      on={r.k === 'row' ? sel?.k === 'row' && sel.id === r.id : sel?.k === 'dm' && sel.id === r.id}
                      onToggle={toggle}
                      onSel={() => (r.k === 'sub' ? setSel({ k: 'dm', id: r.id }) : r.r.bt === 'item' ? setSel({ k: 'row', id: r.id }) : r.kids ? toggle(r.id) : undefined)}
                      onLink={r.k === 'row' && r.r.bt === 'item' && !p.readOnly && linkable.length ? () => linkHere('b:' + r.id, r.r.unit, r.r.ref || 'the line') : undefined}
                      linkLabel={linkLabel}
                    />
                  ))}
                </div>
                {rows.length === 0 && <p className="hint" style={{ padding: 14 }}>{q || show !== 'all' ? 'Nothing matches.' : 'Nothing to show.'}</p>}
              </div>
              </div>
            </>
          )}
          {(selRow || selDm) && (
            <div className="bq-sel">
              {selDm ? (
                <AddCard p={p} d={selDm} row={selRow} onDialog={(mode) => setDialog({ mode, d: selDm })} linkHere={linkHere} linkLabel={linkLabel} canLink={linkable.length > 0} />
              ) : selRow ? (
                <>
                  <div className="path">{mirrorPath(model, selRow.id)}</div>
                  <div className="t">{selRow.qa === 'a' || selRow.qa === 'n' ? <QaMark st={selRow.qa} /> : null} <b>{selRow.ref}</b> {selRow.desc}</div>
                  <div className="faint">BOQ quantity {selRow.qty !== null && !selRow.qa ? fmtQty(selRow.qty) : '—'} {selRow.unit}{qtyOf(model, selRow.id) !== null ? <> · take-off <b>{uq(qtyOf(model, selRow.id)!, selRow.unit)}</b></> : null}</div>
                  {selRow.qa && <div className="faint">{DUMMY_STATE_LABEL[selRow.qa === 'n' ? 'open' : 'add']}{selRow.qby ? ' · added by ' + selRow.qby : ''}{selRow.loc ? ' · ' + selRow.loc : ''} (another take-off)</div>}
                  <LinkedList p={p} target={selRow.id} label={selRow.ref || 'this line'} unit={selRow.unit} />
                  {!p.readOnly && linkable.length > 0 && <button className="btn sm primary bq-linkhere" onClick={() => linkHere('b:' + selRow.id, selRow.unit, selRow.ref || 'the line')}><TIcon k="link" /> Link {linkLabel} here</button>}
                  {!p.readOnly && !linkable.length && <p className="hint">Select a take-off on the Take-offs tab to link it here (or double-click a line).</p>}
                </>
              ) : null}
            </div>
          )}
        </>
      )}
      {p.below}
      {has && !p.readOnly && (
        <div className="bq-addbar">
          <button className="btn sm ghost bq-addnew" onClick={() => setDialog({ mode: 'new' })}><TIcon k="plus" /> Not in the BOQ? Add an additional item…</button>
        </div>
      )}
      {dialog && <AddDialog model={model} mode={dialog.mode} d={dialog.d} onClose={() => setDialog(null)} onSave={saveDialog} />}
    </div>
  );
}

const addCount = (m: QtoModel, boq: boolean) => m.dummies.reduce((a, d) => { const st = dummyState(m, d, boq); return a + (st === 'add' || st === 'open' || st === 'relinked' ? 1 : 0); }, 0);

function TreeLine({ r, y, model, q, on, onToggle, onSel, onLink, linkLabel }: { r: TreeRow; y: number; model: QtoModel; q: string; on: boolean; onToggle: (id: string) => void; onSel: () => void; onLink?: () => void; linkLabel: string }) {
  if (r.k === 'sub') {
    const t = model.targets.get(r.d.id);
    return (
      <div className={'bq-row sub' + (on ? ' on' : '') + (r.hit ? ' hit' : '')} style={{ transform: `translateY(${y}px)` }} onClick={onSel} title={r.d.desc + '\n\nAdditional item relinked to this BOQ item: its quantity counts in the item\'s Take-off quantity (not in the BOQ quantity)'}>
        <span className="ref">{r.d.ref}</span>
        <span className="desc" style={{ paddingLeft: r.depth * 10 + 14 }}><QaMark st="relinked" /> <Hl text={r.d.desc} q={q} />{r.d.loc ? <span className="faint"> · {r.d.loc}</span> : null}</span>
        <span className="unit">{r.d.unit}</span>
        <span className="r num" />
        <span className="r num tq sub">{t ? uq(t.total, r.d.unit) : ''}</span>
      </div>
    );
  }
  const b = r.r;
  const t = qtyOf(model, b.id);
  const diff = t !== null && b.qty && !b.qa ? (t - b.qty) / b.qty : null;
  return (
    <div
      className={'bq-row ' + b.bt + ' d' + Math.min(r.depth, 3) + (on ? ' on' : '') + (r.hit ? ' hit' : '') + (b.qa ? ' qa-' + b.qa : '')}
      style={{ transform: `translateY(${y}px)` }}
      data-id={b.id}
      onClick={onSel}
      onDoubleClick={() => onLink?.()}
      title={b.desc + (b.bt === 'item' && onLink ? '\n\nDouble-click: link ' + linkLabel + ' here' : '')}
    >
      <span className="ref"><Hl text={b.ref} q={q} /></span>
      <span className="desc" style={{ paddingLeft: r.depth * 10 }}>
        {r.kids ? (
          <button className={'chev' + (r.open ? '' : ' closed')} onClick={(e) => { e.stopPropagation(); onToggle(b.id); }} title={r.open ? 'Collapse' : 'Expand'}><TIcon k="chev" size={11} /></button>
        ) : <span className="chev none" />}
        {b.qa === 'a' || b.qa === 'n' ? <QaMark st={b.qa} title={(b.qa === 'a' ? 'Additional – QS' : 'Not resolved – QS') + (b.qby ? ' · added by ' + b.qby : '') + (b.loc ? ' · ' + b.loc : '')} /> : null}
        <Hl text={b.desc} q={q} />
      </span>
      <span className="unit">{b.bt === 'item' ? b.unit : ''}</span>
      <span className="r num">{b.bt === 'item' && b.qty !== null && !b.qa ? fmtQty(b.qty) : ''}</span>
      <span className={'r num tq' + (diff !== null && Math.abs(diff) > 0.05 ? ' differs' : '')} title={diff !== null ? `${diff > 0 ? '+' : ''}${(diff * 100).toFixed(1)}% against the BOQ` : ''}>
        {b.bt === 'item' && t !== null ? uq(t, b.unit) : ''}
      </span>
    </div>
  );
}

/** the take-offs linked to a line: tick, Unlink one or the ticked ones (item 24) */
function LinkedList({ p, target, label, unit }: { p: BoqTabProps; target: string; label: string; unit: string }) {
  const { model } = p;
  const list = linkedItems(model, target).filter((x) => model.itemById.has(x.ti) || x.ti.startsWith('ds:'));
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [ask, setAsk] = useState<string[] | null>(null);
  useEffect(() => { setTicked(new Set()); setAsk(null); }, [target]);
  if (!list.length) return <p className="hint bq-nolinks">No take-off linked here yet.</p>;
  const nameOf = (ti: string) => model.itemById.get(ti)?.name ?? model.doorById.get(ti)?.tag ?? 'take-off';
  const live = [...ticked].filter((t) => list.some((x) => x.ti === t));
  const doUnlink = (tis: string[]) => {
    const links = list.filter((x) => tis.includes(x.ti)).flatMap((x) => x.links);
    p.onCommit(unlinkOps(links), tis.length > 1 ? `Unlinked ${tis.length} take-offs` : 'Unlinked from BOQ');
    p.toast(<span>Unlinked {tis.length > 1 ? `${tis.length} take-offs` : <b>{nameOf(tis[0])}</b>} from {label}. The take-off{tis.length > 1 ? 's' : ''} and {tis.length > 1 ? 'their' : 'its'} shapes stay. Ctrl+Z links again.</span>);
    setTicked(new Set());
    setAsk(null);
  };
  return (
    <div className="bq-links">
      <div className="bq-lhead">Linked take-offs <span className="pill">{list.length}</span></div>
      {list.map((x) => {
        const it = model.itemById.get(x.ti);
        const l = x.links[0];
        return (
          <div key={x.ti} className="bq-lrow">
            {!p.readOnly && <input type="checkbox" checked={ticked.has(x.ti)} onChange={(e) => setTicked((s) => { const n = new Set(s); if (e.target.checked) n.add(x.ti); else n.delete(x.ti); return n; })} title="Tick to unlink several together" />}
            <button className="qd-sheet" onClick={() => p.onSelectItem(x.ti)} title="Select this take-off">
              <span><i className="sw" style={{ background: it?.color ?? '#888' }} /> {nameOf(x.ti)} <span className="faint">{l ? MEASURE_LABEL[l.q] + (l.f !== 1 ? ' ×' + l.f : '') : ''}{x.links.length > 1 ? ` · ${x.links.length} links` : ''}</span></span>
              <span className="num">{uq(x.v, unit)}</span>
            </button>
            {!p.readOnly && <button className="btn sm ghost bq-unlink" title="Remove only the link — the take-off and its shapes stay" onClick={() => setAsk([x.ti])}>Unlink</button>}
          </div>
        );
      })}
      {!p.readOnly && live.length > 0 && !ask && <button className="btn sm bq-unlinksel" onClick={() => setAsk(live)}>Unlink selected ({live.length})</button>}
      {ask && (
        <div className="bq-ask">
          <span>Unlink {ask.length > 1 ? `${ask.length} take-offs` : <b>{nameOf(ask[0])}</b>} from {label}? The take-off{ask.length > 1 ? 's' : ''} and shapes stay.</span>
          <button className="btn sm ghost" autoFocus onClick={() => setAsk(null)}>Cancel</button>
          <button className="btn sm dangerfill bq-confirm" onClick={() => doUnlink(ask)}>Unlink</button>
        </div>
      )}
    </div>
  );
}

/** an additional item / temporary line: what it is, who added it, and what can be done with it */
function AddCard({ p, d, row, onDialog, linkHere, linkLabel, canLink }: { p: BoqTabProps; d: Dummy; row: MirrorRow | null; onDialog: (m: 'edit' | 'keep') => void; linkHere: (to: string, unit: string, label: string) => void; linkLabel: string; canLink: boolean }) {
  const { model } = p;
  const st = dummyState(model, d);
  // (only an additional item's own line can have been removed by the estimator: the sync removes it only when it is relinked)
  const v = addView(model, d, st === 'add' && model.boqGone.has(qxId(d.id)));
  const mayEdit = !p.readOnly && canEditSuggestion(model, d, p.me, p.embedded);
  const real = d.map ? model.boqById.get(d.map) : null;
  const t = model.targets.get(d.id);
  return (
    <>
      <div className="path">{st === 'relinked' && real ? <>Sub-item of {mirrorPath(model, real.id)} › {real.ref} {real.desc.slice(0, 40)}</> : v.bill ? billLabel(model, v.bill) : row ? mirrorPath(model, row.id) : ''}</div>
      <div className="t"><QaMark st={st} /> <b>{v.ref}</b> {v.desc} <span className="faint">{v.unit}</span></div>
      <div className="faint bq-qainfo">
        <span className={'qast ' + st}>{DUMMY_STATE_LABEL[st]}</span>
        {v.by ? ' · added by ' + v.by : ''}{v.loc ? ' · ' + v.loc : ''}{t ? <> · take-off <b>{uq(t.total, v.unit)}</b></> : null}
      </div>
      {v.own && <div className="hint">Changed by an administrator — their version is shown; it can no longer be changed here.</div>}
      {v.removed && <div className="hint warnline">Removed from the BOQ by an administrator.</div>}
      {st === 'open' && <div className="hint warnline">Not resolved: match it to a BOQ line, or keep it as an additional item (pick its bill and location).</div>}
      {st === 'relinked' && real && <div className="hint">Its quantity counts in {real.ref || 'the item'}'s Take-off quantity — the BOQ quantity stays as issued.</div>}
      <LinkedList p={p} target={d.id} label={'“' + v.desc + '”'} unit={v.unit} />
      {!p.readOnly && (
        <div className="bq-acts">
          {canLink && st !== 'matched' && <button className="btn sm primary" onClick={() => linkHere(d.id, v.unit, '“' + v.desc + '”')}><TIcon k="link" /> Link {linkLabel} here</button>}
          {st === 'open' && <button className="btn sm bq-match" onClick={() => p.onMatch(d.id, false)}>Match…</button>}
          {st === 'open' && <button className="btn sm bq-keep" onClick={() => onDialog('keep')}>Keep as additional item…</button>}
          {(st === 'add' || st === 'relinked') && mayEdit && <button className="btn sm bq-edit" onClick={() => onDialog('edit')}>{p.embedded ? 'Edit / move…' : 'Edit…'}</button>}
          {p.embedded && st === 'add' && <button className="btn sm bq-relink" onClick={() => p.onMatch(d.id, true)}>Relink to a BOQ item…</button>}
          {p.embedded && st === 'relinked' && <button className="btn sm ghost bq-unrelink" onClick={() => p.onCommit([[d.id, 'map', null]], 'Additional item back on its own line')}>Back to its own line</button>}
          {!p.embedded && st === 'add' && mayEdit && <button className="btn sm ghost danger bq-remove" onClick={() => {
            const r = removeDummyOps(model, d.id);
            p.onCommit(r.ops, 'Removed additional item');
            p.toast(<span>Removed{r.dropped ? ` with its ${r.dropped} link${r.dropped > 1 ? 's' : ''}` : ''}. Ctrl+Z brings it back.</span>);
          }}>Remove</button>}
        </div>
      )}
    </>
  );
}

/** Show ▾ Additional items: every additional item (and temporary line not resolved) of this take-off */
function AddList({ model, rows, all, sel, onSel, q, boq }: { model: QtoModel; rows: Dummy[]; all: number; sel: string | null; onSel: (id: string) => void; q: string; boq: boolean }) {
  return (
    <div className="bq-addlist">
      <div className="bq-ahead"><span /><span>Description</span><span>Unit</span><span className="r">Take-off</span><span>Bill · location</span><span>Added by</span></div>
      <div className="bq-alist">
        {rows.map((d) => {
          const st = dummyState(model, d, boq);
          const v = addView(model, d, st === 'add' && model.boqGone.has(qxId(d.id)));
          const t = model.targets.get(d.id);
          const real = d.map ? model.boqById.get(d.map) : null;
          return (
            <div key={d.id} className={'bq-arow ' + st + (sel === d.id ? ' on' : '')} onClick={() => onSel(d.id)} data-id={d.id}>
              <span><QaMark st={st} /></span>
              <span className="desc" title={v.desc}><Hl text={v.desc} q={q} />{v.own ? <span className="faint"> · changed by an administrator</span> : null}</span>
              <span className="unit">{v.unit}</span>
              <span className="r num">{t ? uq(t.total, v.unit) : '—'}</span>
              <span className="bl" title={billLabel(model, v.bill)}>{st === 'relinked' && real ? 'relinked → ' + (real.ref ? real.ref + ' ' : '') + real.desc.slice(0, 24) : st === 'open' ? <span className="bad">not resolved</span> : billLabel(model, v.bill) || <span className="faint">no bill</span>}{v.loc ? <span className="faint"> · <Hl text={v.loc} q={q} /></span> : null}</span>
              <span className="by">{v.by}</span>
            </div>
          );
        })}
        {!rows.length && <p className="hint" style={{ padding: 14 }}>{all ? 'Nothing matches.' : 'No additional items yet. Not in the BOQ? Add one below.'}</p>}
      </div>
    </div>
  );
}

/** add / change an additional item, or keep a temporary line as one: description, unit, bill, location */
export function AddDialog({ model, mode, d, onClose, onSave, title, saveLabel }: { model: QtoModel; mode: 'new' | 'edit' | 'keep' | 'link'; d?: Dummy; onClose: () => void; onSave: (f: AddFields) => void; title?: string; saveLabel?: string }) {
  const esc = useEscClose(onClose);
  const v = d ? addView(model, d) : null;
  const bills = billChoices(model);
  const [f, setF] = useState<AddFields>({ desc: v?.desc ?? '', unit: v?.unit || 'm2', ref: v?.ref ?? '', bill: v?.bill && bills.some((b) => b.id === v.bill) ? v.bill : bills[0]?.id ?? '', loc: v?.loc ?? '' });
  const locs = useMemo(() => knownLocations(model), [model]);
  const ok = !!f.desc.trim() && !!f.bill;
  const T = title ?? (mode === 'new' || mode === 'link' ? 'Add an additional item' : mode === 'keep' ? 'Keep as additional item' : 'Change the additional item');
  return (
    <div className="scrim" onKeyDown={esc.onKeyDown} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={esc.box} tabIndex={-1} className="modal addmodal">
        <h2>{T}</h2>
        <p className="sub">{mode === 'keep' ? <>“<b>{d?.desc}</b>” is not in the BOQ. It goes into the BOQ as a line of its own, flagged <b>Additional – QS</b>, in the bill you pick.</> : <>An item the BOQ doesn't have. It goes into the BOQ as a line flagged <b>Additional – QS</b>, in the bill you pick (an administrator may change it).</>}</p>
        <div className="addform">
          <label>Description</label>
          <input className="input" autoFocus={mode !== 'keep'} value={f.desc} onChange={(e) => setF({ ...f, desc: e.target.value })} placeholder="e.g. Planter boxes, precast, 1200 × 600" />
          <label>Unit</label>
          <select className="input" value={UNITS.includes(f.unit) ? f.unit : f.unit || 'm2'} onChange={(e) => setF({ ...f, unit: e.target.value })}>
            {(UNITS.includes(f.unit) || !f.unit ? UNITS : [f.unit, ...UNITS]).map((u) => <option key={u}>{u}</option>)}
          </select>
          <label>Bill</label>
          <select className="input addbill" value={f.bill} onChange={(e) => setF({ ...f, bill: e.target.value })}>
            {bills.map((b) => <option key={b.id} value={b.id}>{billLabel(model, b.id)}</option>)}
          </select>
          <label>Location</label>
          <input className="input addloc" autoFocus={mode === 'keep'} list="qto-locs" value={f.loc} onChange={(e) => setF({ ...f, loc: e.target.value })} placeholder="e.g. Level 3, Podium, Roof" />
          <datalist id="qto-locs">{locs.map((l) => <option key={l} value={l} />)}</datalist>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ok} onClick={() => onSave(f)}>{saveLabel ?? (mode === 'new' ? 'Add' : mode === 'link' ? 'Add and link' : mode === 'keep' ? 'Keep as additional item' : 'Save')}</button>
        </div>
      </div>
    </div>
  );
}
