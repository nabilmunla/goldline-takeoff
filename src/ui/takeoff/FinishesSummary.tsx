// v0.16 (group g2, item 33): the Finishes Summary ("Finalize" in the tool bar). One table: a row per finish
// code + unit, broken down by the levels picked (headings, finish type, room name, description) with
// subtotals at every level, down to the rooms and take-offs. Any row links to a BOQ item (a portion link:
// it remembers what it covers, so it follows the rooms); a quantity is linked once, never twice. Live: it
// is worked out from the model on every change. The figures are the engine's (finishes.ts).
import { finishesSheets } from './finexport';
import { gt } from '../api';
import { writeXlsx } from '../../engine/xlsxwrite';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Op } from '../../engine/types';
import { flattenMirror, mirrorPath, type QtoModel } from '../../engine/qto/model';
import { summarize, summarizeByType, portionLinkOps, removePortionLinkOps, rowPredicate, linkCheck, saveBreakdownOps, removeBreakdownOps, atomLinkText, type FinFilter, type FinPred, type FinRow, type GroupKey } from '../../engine/qto/finishes';
import type { FinishType } from '../../engine/qto/rooms';
import { dummyOps } from '../../engine/qto/ops';
import { additionalItemOps, billLabel, hasBoq, linkTarget } from '../../engine/qto/additional';
import { measureForUnit } from '../../engine/qto/units';
import { fmtQty } from '../format';
import { useEscClose } from '../escape';
import { q as fq, useQtoFmt } from './numfmt';
import { TIcon } from './ticons';
import { useDismiss } from './ListBits';
import { ElementSummary, MiscSummary, HeadsFilter, LinkBtn } from './StructSummary';
import type { Measure } from '../../engine/qto/model';
import { Modal } from './Dialogs';
import { AddDialog } from './BoqTab';
import { revealInBoq } from './boqnav';
import { groupKeys, groupKeyLabel, moveKey, FILTER_TYPES, NO_TYPE, summaryLines, sameBreakdown, atomText, boqLineText, rowPathLabel } from './roomui';

const EPS = 1e-9;
const uq = (x: number, unit: string) => fq(x, unit);
type Toast = (t: ReactNode, opts?: { action?: { label: string; fn: () => void } }) => void;
interface View { by: GroupKey[]; flt: FinFilter }

export type FinalizeTab = 'fin' | 'block' | 'struct' | 'misc';
export function FinishesSummary({ model, projectId, projectName, readOnly: ro, onClose, onCommit, toast, me, onGoTo, onLinkItems }: {
  /** v0.17.1 the Blockwork / Structure tabs: the take-offs of a row linked to a BOQ item with that quantity */
  onLinkItems?: (ids: string[], ms: Measure) => void;
  /** v0.16.2 for the export's title and file name */
  projectName?: string;
  model: QtoModel;
  projectId: string;
  readOnly: boolean;
  onClose: () => void;
  onCommit: (ops: Op[], label: string) => void;
  toast: Toast;
  me: { username: string; name: string };
  /** a room / take-off: shown in the take-off list (the summary closes) */
  onGoTo: (id: string) => void;
}) {
  useQtoFmt();
  const key = 'qto.finview.' + projectId;
  const [view, setView0] = useState<View>(() => {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); if (v && Array.isArray(v.by)) return { by: v.by.filter((x: unknown) => typeof x === 'string'), flt: v.flt ?? {} }; } catch { /* */ }
    return { by: [], flt: {} };
  });
  const setView = (v: View) => { setView0(v); try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* */ } };
  // v0.16.4 (Nabil, his Excel layout): the list (links to the BOQ) or by finish type - a column each, the same filters
  // v0.17.1 (Feedback 3) Finalize has a tab each for finishes, blockwork and structure
  const [tab, setTab0] = useState<FinalizeTab>(() => { try { const t = localStorage.getItem(key + ':tab'); return t === 'block' || t === 'struct' || t === 'misc' ? t : 'fin'; } catch { return 'fin'; } });
  const setTab = (t: FinalizeTab) => { setTab0(t); try { localStorage.setItem(key + ':tab', t); } catch { /* */ } };
  const nMisc = useMemo(() => [...model.fin.partById.values()].filter((x) => x.ak === 'misc').length, [model]);
  const nStruct = useMemo(() => model.items.filter((it) => it.kind === 'beam' || !!it.sk).length, [model]);
  const nBlock = useMemo(() => model.items.filter((it) => it.kind === 'wall' && !it.sk).length, [model]);
  const [lay, setLay0] = useState<'list' | 'type'>(() => { try { return localStorage.getItem(key + ':lay') === 'type' ? 'type' : 'list'; } catch { return 'list'; } });
  const setLay = (l: 'list' | 'type') => { setLay0(l); try { localStorage.setItem(key + ':lay', l); } catch { /* */ } };
  /** a code clicked in the by-type columns: that row of the list, brought into view */
  const [jump, setJump] = useState<string | null>(null);
  useEffect(() => {
    if (lay !== 'list' || !jump) return;
    const el = esc.box.current?.querySelector(`[data-row="${CSS.escape(jump)}"]`) as HTMLElement | null;
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400); }
    setJump(null);
  }, [lay, jump]);
  const { by, flt } = view;
  const keys = groupKeys(model);
  // (a level this project no longer has - its headings went - is left out)
  const byOk = by.filter((k) => keys.some((x) => x.k === k));
  const s = useMemo(() => summarize(model, byOk, flt), [model, JSON.stringify(byOk), JSON.stringify(flt)]);
  const cols = useMemo(() => (lay === 'type' ? summarizeByType(model, flt) : []), [model, lay, JSON.stringify(flt)]);
  /** v0.16.4 links made on a waterproofing code before it was split into horizontal / vertical */
  const splitLinks = model.fin.links.filter((l) => l.split);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [atomsOpen, setAtomsOpen] = useState<Set<string>>(new Set());
  const lines = summaryLines(s, closed, atomsOpen, model.fin.atomById);
  const [linking, setLinking] = useState<FinRow | null>(null);
  /** v0.17.1 a code of one finish type linked from the By finish type columns (a portion link on code + type) */
  const [linkType, setLinkType] = useState<{ pred: FinPred; label: string; qty: number; unit: string } | null>(null);
  const [noCodeOpen, setNoCodeOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [saveAs, setSaveAs] = useState<string | null>(null);
  const [addLvl, setAddLvl] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  useDismiss(addLvl, () => setAddLvl(false), addRef);
  const esc = useEscClose(onClose, !!linking || !!linkType);
  const drag = useRef<number | null>(null);
  const cur = sameBreakdown(model.fin.breakdowns, byOk, flt);
  const exportXlsx = async () => {
    const proj = projectName || 'Take-off';
    const name = (proj + ' - finishes summary' + (cur ? ' - ' + cur.name : '')).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() + '.xlsx';
    const p = await gt().saveFile({ title: 'Export the Finishes Summary', name, filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
    if (!p) return;
    try {
      await gt().files.writeBytes(p, writeXlsx(finishesSheets(model, byOk, flt, { project: proj, breakdown: cur?.name ?? null, byType: lay === 'type' })));
    } catch (e) {
      // (most often: that file is open in Excel)
      toast(<span>Could not save it: {String((e as Error)?.message ?? e)}. Is the file open in Excel? Close it, or save under another name.</span>);
      return;
    }
    toast(<span>Exported the Finishes Summary{cur ? <> (“{cur.name}”)</> : ''}.</span>);
    gt().openPath(p);
  };
  const types = flt.types ?? [];
  // (v0.16.4 "None": a type no finish has - nothing shown until some are picked; no types = all)
  const none = types.length === 1 && types[0] === NO_TYPE;
  const typeOn = (t: FinishType) => !none && (!types.length || types.includes(t));
  const toggleType = (t: FinishType) => {
    const all = FILTER_TYPES.map((x) => x.t);
    let next = none ? [] : types.length ? [...types] : [...all];
    next = next.includes(t) ? next.filter((x) => x !== t) : [...next, t];
    if (next.length === all.length) next = [];
    else if (!next.length) next = [NO_TYPE];
    setView({ by, flt: { ...flt, types: next.length ? next : undefined } });
  };
  const allTypes = (on: boolean) => setView({ by, flt: { ...flt, types: on ? undefined : [NO_TYPE] } });
  const heads = flt.heads ?? [];
  const unlink = (id: string, what: string) => onCommit(id.startsWith('fl:') ? removePortionLinkOps(id) : [[id, 'del', true]], 'Unlinked ' + what);
  const toggleRow = (r: FinRow) => {
    if (r.children.length) { const n = new Set(closed); n.has(r.id) ? n.delete(r.id) : n.add(r.id); setClosed(n); }
    else { const n = new Set(atomsOpen); n.has(r.id) ? n.delete(r.id) : n.add(r.id); setAtomsOpen(n); }
  };
  const boqCell = (r: FinRow) => {
    const ls = r.links.map((id) => model.fin.linkById.get(id)).filter(Boolean);
    const direct = r.atoms.filter((a) => model.fin.atomById.get(a)?.direct.length).length;
    if (!ls.length && !direct) return null;
    return (
      <span className="fs-boq">
        {ls.slice(0, 2).map((l) => (
          <span key={l!.id} className="fs-lk" data-link={l!.id} title={`${l!.label} → ${boqLineText(model, l!.to)} (${uq(l!.qty, l!.unit)} ${l!.unit})`}>
            <TIcon k="link" size={11} /><span className="t">{boqLineText(model, l!.to)}</span>
            {!ro && <button className="x" title={`Unlink “${l!.label}” (all ${uq(l!.qty, l!.unit)} ${l!.unit} of it)`} onClick={(e) => { e.stopPropagation(); unlink(l!.id, l!.label); }}>×</button>}
          </span>
        ))}
        {ls.length > 2 && <span className="faint">+{ls.length - 2} more</span>}
        {direct > 0 && <span className="faint">{direct} take-off{direct > 1 ? 's' : ''} linked {direct > 1 ? 'themselves' : 'itself'}</span>}
      </span>
    );
  };
  const goto = (id: string) => { onGoTo(id); onClose(); };

  return (
    <>
      <div className="scrim" onKeyDown={esc.onKeyDown} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div ref={esc.box} tabIndex={-1} className="modal finsum" data-finsum>
          <div className="imp-head">
            <div>
              <h2>Finalize</h2>
              <div className="seg fin-tabs" data-fintabs>
                <button className={tab === 'fin' ? 'on' : ''} data-fintab="fin" onClick={() => setTab('fin')}>Finishes</button>
                <button className={tab === 'block' ? 'on' : ''} data-fintab="block" onClick={() => setTab('block')}>Blockwork{nBlock ? <small> {nBlock}</small> : null}</button>
                <button className={tab === 'struct' ? 'on' : ''} data-fintab="struct" onClick={() => setTab('struct')}>Structure{nStruct ? <small> {nStruct}</small> : null}</button>
                <button className={tab === 'misc' ? 'on' : ''} data-fintab="misc" onClick={() => setTab('misc')} title="The rooms’ miscellaneous items: kitchen cabinets, wardrobes, vanities, mirrors…">Miscellaneous{nMisc ? <small> {nMisc}</small> : null}</button>
              </div>
              <p className="sub">{tab === 'fin'
                ? 'Totals by finish code from every room and every take-off with a code — always up to date. Break a code down by the levels below, then link each part to its BOQ item.'
                : tab === 'misc' ? 'The rooms’ miscellaneous items by code — always up to date. The link button links a code to its BOQ item.'
                : tab === 'block'
                  ? 'Blockwork walls by thickness: area, length, volume and lintels — always up to date. The link button next to a figure links those take-offs to its BOQ item.'
                  : 'Structural elements: concrete, formwork and steel — always up to date. The link button next to a figure links those take-offs to its BOQ item (concrete, formwork and steel each to their own).'}</p>
            </div>
          </div>
          {tab === 'misc' && <MiscSummary model={model} readOnly={ro} onLink={(r, f) => setLinkType({ pred: rowPredicate({ code: r.code, unit: r.unit, g: [['type', 'Miscellaneous'], ['item', r.item], ['mfin', r.mfin]] } as unknown as FinRow, f), label: `${r.code} › ${r.descs[0] ?? ''}${r.fins[0] ? ' (' + r.fins[0] + ')' : ''}`, qty: r.qty - r.linked, unit: r.unit })} />}
          {(tab === 'block' || tab === 'struct') && <ElementSummary key={tab} model={model} mode={tab} projectId={projectId} projectName={projectName} readOnly={ro} onLink={(ids, ms) => onLinkItems?.(ids, ms)} onGoTo={goto} toast={toast} />}
          {tab === 'fin' && <>
          <div className="fs-bar fs-laybar">
            <span className="lbl">View</span>
            <span className="seg" data-lay>
              <button className={lay === 'list' ? 'on' : ''} data-lay="list" onClick={() => setLay('list')} title="Codes with their parts - link each to its BOQ item">List</button>
              <button className={lay === 'type' ? 'on' : ''} data-lay="type" onClick={() => setLay('type')} title="A column for each finish type - floors, walls, skirting, ceilings... - its codes and totals; a code used for two types is in both">By finish type</button>
            </span>
          </div>
          {lay === 'list' && <div className="fs-bar">
            <span className="lbl">Group by</span>
            <span className="chip fixed" title="Always the first level">Code + unit</span>
            {byOk.map((k, i) => (
              <span
                key={k}
                className="chip on fs-lvl"
                data-level={k}
                draggable
                title="Drag to change the order"
                onDragStart={(e) => { drag.current = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', k); }}
                onDragOver={(e) => { if (drag.current !== null) e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); if (drag.current !== null) setView({ by: moveKey(byOk, drag.current, i), flt }); drag.current = null; }}
                onDragEnd={() => { drag.current = null; }}
              >
                <span className="sep">›</span> {groupKeyLabel(model, k)}
                <button className="x" title="Remove this level" onClick={() => setView({ by: byOk.filter((x) => x !== k), flt })}>×</button>
              </span>
            ))}
            <div className="tplwrap" ref={addRef}>
              <button className="chip sub" data-addlevel disabled={keys.every((x) => byOk.includes(x.k))} onClick={() => setAddLvl((x) => !x)}>+ Level</button>
              {addLvl && (
                <div className="tplmenu fs-menu fs-lvlmenu">
                  {keys.filter((x) => !byOk.includes(x.k)).map((x) => (
                    <button key={x.k} className="mi" data-lvl={x.k} onClick={() => { setView({ by: [...byOk, x.k], flt }); setAddLvl(false); }}><span className="lb">{x.label}</span></button>
                  ))}
                </div>
              )}
            </div>
            <span className="grow" />
            <select className="input sm fs-saved" data-saved value={cur?.id ?? ''} onChange={(e) => { const b = model.fin.breakdowns.find((x) => x.id === e.target.value); if (b) setView({ by: b.by, flt: b.flt }); }} title="Saved breakdowns: a grouping and filters, by name">
              <option value="">{cur ? '' : model.fin.breakdowns.length ? 'Saved breakdowns…' : 'No saved breakdowns'}</option>
              {model.fin.breakdowns.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            {!ro && (saveAs === null ? (
              <button className="btn sm" data-saveas onClick={() => setSaveAs(cur?.name ?? '')}>Save as…</button>
            ) : (
              <span className="fs-saveas">
                <input className="input sm" autoFocus data-savename placeholder="Name, e.g. By floor and block" value={saveAs} onChange={(e) => setSaveAs(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setSaveAs(null); } if (e.key === 'Enter') (e.currentTarget.nextSibling as HTMLButtonElement | null)?.click(); }} />
                <button className="btn sm primary" disabled={!saveAs.trim()} onClick={() => {
                  const name = saveAs.trim();
                  const same = model.fin.breakdowns.find((b) => b.name.trim().toLowerCase() === name.toLowerCase());
                  const r = saveBreakdownOps(model, { name, by: byOk, filter: flt }, same?.id);
                  onCommit(r.ops, same ? 'Changed saved breakdown' : 'Saved breakdown');
                  setSaveAs(null);
                }}>Save</button>
                <button className="btn sm ghost" onClick={() => setSaveAs(null)}>Cancel</button>
              </span>
            ))}
            {!ro && cur && <button className="btn sm ghost" data-delsaved title={`Delete the saved breakdown “${cur.name}” (links made are not changed)`} onClick={() => onCommit(removeBreakdownOps(cur.id), 'Deleted saved breakdown')}>Delete</button>}
          </div>}
          <div className="fs-bar">
            <span className="lbl">Show</span>
            <span className="fs-allnone">
              <button className="linkbtn" data-typesall disabled={!types.length} onClick={() => allTypes(true)} title="Show every finish type">All</button>
              <button className="linkbtn" data-typesnone disabled={none} onClick={() => allTypes(false)} title="Show none - then pick the ones wanted">None</button>
            </span>
            {FILTER_TYPES.map((t) => <button key={t.t} className={'chip sm' + (typeOn(t.t) ? ' on' : '')} data-type={t.t} onClick={() => toggleType(t.t)}>{t.label}</button>)}
            <HeadsFilter model={model} heads={heads} onChange={(n) => setView({ by, flt: { ...flt, heads: n.length ? n : undefined } })} />
            <span className="grow" />
            <input className="input sm fs-q" data-finq placeholder="Find a room or description" value={flt.q ?? ''} onChange={(e) => setView({ by, flt: { ...flt, q: e.target.value || undefined } })} onKeyDown={(e) => { if (e.key === 'Escape' && flt.q) { e.stopPropagation(); setView({ by, flt: { ...flt, q: undefined } }); } }} />
          </div>
          {(s.warnings.length > 0 || s.noCode > 0 || splitLinks.length > 0) && (
            <div className="fs-notes">
              {s.warnings.map((w) => <div key={w.code} className="warnline" data-unitwarn><TIcon k="warn" size={13} /> <b>{w.code}</b> is used in {w.units.join(' and ')} — usually a typing mistake: each unit has its own row.</div>)}
              {splitLinks.map((l) => <div key={l.id} className="warnline" data-splitlink><TIcon k="warn" size={13} /> <b>{l.code}</b> was linked to the BOQ before horizontal and vertical waterproofing got a row each — that link still covers both. Unlink it and link the “(horizontal)” and “(vertical)” rows each to their own item.</div>)}
              {s.noCode > 0 && (
                <div className="fs-nocode" data-nocode>
                  <button className="linkbtn" onClick={() => setNoCodeOpen((x) => !x)}>{noCodeOpen ? '▾' : '▸'} {s.noCode} finish{s.noCode > 1 ? 'es have' : ' has'} no code — not in the summary</button>
                  {noCodeOpen && (
                    <div className="fs-nclist">
                      {s.uncoded.map((a) => (
                        <button key={a.id} className="fs-nc" data-nocodeitem onClick={() => goto(a.room || a.src[a.src.length - 1])} title="Show it in the take-off list">
                          <span>{a.roomName ? <b>{a.roomName}</b> : null}{a.roomName ? ' · ' : ''}{a.reason}</span>
                          <span className="num faint">{uq(a.qty, a.unit)} {a.unit}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="paper-scroll fs-scroll">
            {lay === 'type' ? (
              <div className="fs-types" data-bytype>
                {!cols.length && <div className="faint fs-tnone">Nothing to show with these filters.</div>}
                {cols.map((c) => (
                  <div key={c.type} className={'fs-tcol t-' + c.type.replace(/\s+/g, '-').toLowerCase()} data-tcol={c.type}>
                    <div className="fs-th"><span>{FILTER_TYPES.find((t) => t.t === c.type)?.label ?? c.type}</span><span>Qty</span></div>
                    <div className="fs-ttot" data-ttot>{c.totals.map((t) => <span key={t.unit} className="num">{uq(t.qty, t.unit)} <small>{t.unit}</small></span>)}</div>
                    {c.rows.map((r) => (
                      <div key={r.key + '|' + r.unit} className={'fs-trow' + (r.qty - r.linked > EPS ? ' open' : '')} data-tcode={r.code}>
                        <button
                          className="fs-tgo"
                          title={`${r.n} part${r.n === 1 ? '' : 's'} · linked ${uq(r.linked, r.unit)} of ${uq(r.qty, r.unit)} ${r.unit} — click: this code in the list`}
                          onClick={() => { setLay('list'); setJump(r.key + '|' + r.unit); }}
                        >
                          <span className="c">{r.code}</span>
                          <span className="q num">{uq(r.qty, r.unit)}{c.totals.length > 1 ? ' ' + r.unit : ''}</span>
                        </button>
                        {/* v0.17.1 the link button next to each code: this code of this finish type → its BOQ item */}
                        <LinkBtn
                          ms="type"
                          state={r.linked <= EPS ? 'none' : r.qty - r.linked > EPS ? 'some' : 'all'}
                          disabled={ro || r.qty - r.linked <= EPS}
                          title={r.qty - r.linked <= EPS ? 'All of it is linked to the BOQ (the list shows where)' : `Link ${uq(r.qty - r.linked, r.unit)} ${r.unit} of ${r.code} (${FILTER_TYPES.find((t) => t.t === c.type)?.label ?? c.type}) to a BOQ item${r.linked > EPS ? ' — the rest is linked already' : ''}`}
                          onClick={() => setLinkType({ pred: rowPredicate({ code: r.code, unit: r.unit, g: [['type', c.type]] } as unknown as FinRow, flt), label: `${r.code} › ${FILTER_TYPES.find((t) => t.t === c.type)?.label ?? c.type}`, qty: r.qty - r.linked, unit: r.unit })}
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
            <table className="register fs-table">
              <thead>
                <tr>
                  <th>Code / part</th>
                  <th className="r" style={{ width: 130 }}>Quantity</th>
                  <th className="r" style={{ width: 110 }}>Linked</th>
                  <th className="r" style={{ width: 110 }}>Unlinked</th>
                  <th style={{ width: '32%' }}>BOQ item</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((ln) => {
                  if (ln.t === 'atom') {
                    const a = ln.a;
                    const tx = atomText(a);
                    const lt = atomLinkText(model, a);
                    const lk = !!a.link || a.direct.length > 0;
                    return (
                      <tr key={ln.row.id + '/' + a.id} className="fs-atom" data-atom={a.id} onClick={() => goto(a.room || a.src[a.src.length - 1])} title="Show it in the take-off list">
                        <td style={{ paddingLeft: 14 + ln.depth * 18 }}><span className="fs-an">{tx.main}</span> <span className="faint">{tx.sub}</span>{a.flags.includes('over') && <span className="bad" title="Deductions larger than the finish: shown as 0"> ⚠</span>}</td>
                        <td className="r num">{uq(a.qty, a.unit)} <small>{a.unit}</small></td>
                        <td className="r num">{lk ? uq(a.qty, a.unit) : ''}</td>
                        <td className="r num">{lk ? '' : uq(a.qty, a.unit)}</td>
                        <td className="fs-boqt">{lt ? <span className="fs-lt"><TIcon k="link" size={11} /> {lt}</span> : <span className="faint">not linked</span>}{a.flags.includes('twoLinks') && <span className="bad" title="It falls under two links: counted in the older one"> ⚠ two links</span>}</td>
                      </tr>
                    );
                  }
                  const r = ln.row;
                  const can = !ro && r.unlinked > EPS && !!r.code;
                  const full = r.unlinked <= EPS && r.qty > EPS;
                  return (
                    <tr key={r.id} className={'fs-row d' + Math.min(ln.depth, 3) + (full ? ' done' : '')} data-row={r.id} data-label={r.label} onClick={() => toggleRow(r)}>
                      <td style={{ paddingLeft: 8 + ln.depth * 18 }}>
                        <span className={'chev' + (ln.open ? '' : ' closed')}><TIcon k="chev" size={12} /></span>
                        {ln.depth === 0 ? <><b className="fs-code">{r.code}</b> <span className="faint">{r.unit}</span></> : <span className="fs-gl">{r.label}</span>}
                        {r.twoLinks && <span className="bad" title="Part of it falls under two links: counted in the older one"> ⚠</span>}
                        {r.over && <span className="bad" title="A room in it has deductions larger than a finish (shown as 0)"> ⚠</span>}
                        <span className="faint fs-n">{r.atoms.length}</span>
                      </td>
                      <td className="r num"><b>{uq(r.qty, r.unit)}</b> <small>{r.unit}</small></td>
                      <td className="r num">{r.linked > EPS ? uq(r.linked, r.unit) : <span className="faint">—</span>}</td>
                      <td className={'r num' + (r.unlinked > EPS ? ' fs-un' : '')}>{r.unlinked > EPS ? uq(r.unlinked, r.unit) : <span className="okc">✓</span>}</td>
                      <td className="fs-boqt" onClick={(e) => e.stopPropagation()}>
                        {boqCell(r)}
                        {can && <button className="btn sm fs-link" data-linkrow onClick={() => setLinking(r)}><TIcon k="link" size={12} /> Link to BOQ item…</button>}
                      </td>
                    </tr>
                  );
                })}
                {!lines.length && (
                  <tr><td colSpan={5} className="hint" style={{ padding: 18 }}>
                    {model.fin.atoms.length ? 'Nothing matches the filters.' : 'No finishes with a code yet. Give the finishes of a room a code (or a take-off a finish code) and they are totalled here.'}
                  </td></tr>
                )}
              </tbody>
            </table>
            )}
          </div>
          </>}
          <div className="imp-foot">
            {tab === 'fin' && <button className="linkbtn" data-linksmade onClick={() => setLinksOpen((x) => !x)}>{linksOpen ? '▾' : '▸'} Links made ({model.fin.links.length})</button>}
            <span className="grow" />
            <span className="faint">{tab === 'fin' ? 'Grouping is only a view: links already made never change.' : 'A view of the take-offs as they stand: change them in the take-off list.'}</span>
            {/* v0.16.2 (feedback 2): this view - its levels and filters, or the saved breakdown chosen - to Excel */}
            {tab === 'fin' && <button className="btn" data-finexport title="This view to Excel: the levels and filters as shown (or the saved breakdown chosen), every level open, with the parts under it" onClick={exportXlsx}>Export to Excel</button>}
            <button className="btn" onClick={onClose}>Close</button>
            {linksOpen && tab === 'fin' && (
              <div className="fs-links" data-linklist>
                {!model.fin.links.length && <span className="hint">None yet.</span>}
                {model.fin.links.map((l) => (
                  <div key={l.id} className="fs-lrow" data-linkrowmade={l.id}>
                    <span className="t"><b>{l.label}</b> → {boqLineText(model, l.to)}</span>
                    <span className="num">{uq(l.qty, l.unit)} {l.unit}{l.shared.length ? <span className="bad" title="Some of it falls under another, newer link too"> ⚠</span> : null}</span>
                    {!ro && <button className="btn sm ghost" onClick={() => unlink(l.id, l.label)}>Unlink</button>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {linkType && (
        <BoqPicker model={model} pred={linkType.pred} label={linkType.label} qty={linkType.qty} unit={linkType.unit} projectId={projectId} me={me} onClose={() => setLinkType(null)} onCommit={onCommit} toast={toast} />
      )}
      {linking && (
        <BoqPicker
          model={model}
          pred={rowPredicate(linking, flt)}
          label={rowPathLabel(s.rows, linking)}
          qty={linking.unlinked}
          unit={linking.unit}
          projectId={projectId}
          me={me}
          onClose={() => setLinking(null)}
          onCommit={onCommit}
          toast={toast}
        />
      )}
    </>
  );
}

/** pick the BOQ item a part of the summary goes to: the BOQ lines, additional items, temporary lines (as the
 *  take-off's link dialog). Refused when part of it is linked already: those links are listed to unlink. */
function BoqPicker({ model, pred, label, qty, unit, projectId, me, onClose, onCommit, toast }: {
  model: QtoModel;
  pred: FinPred;
  label: string;
  qty: number;
  unit: string;
  projectId: string;
  me: { username: string; name: string };
  onClose: () => void;
  onCommit: (ops: Op[], label: string) => void;
  toast: Toast;
}) {
  const [q, setQ] = useState('');
  const [refused, setRefused] = useState<{ to: string; unit: string; label: string; extra: Op[] } | null>(null);
  const [addNew, setAddNew] = useState(false);
  const [newLine, setNewLine] = useState(false);
  const [nd, setNd] = useState({ ref: '', desc: label, unit: unit === 'm' ? 'm' : 'm2' });
  const boqHere = hasBoq(model);
  const rows = useMemo(() => (model.boqById.size ? flattenMirror(model, q).filter((r) => r.bt === 'item' || q === '').slice(0, 400) : []), [model, q]);
  const dms = model.dummies.filter((d) => !q.trim() || d.desc.toLowerCase().includes(q.trim().toLowerCase()));
  const adds = boqHere ? dms.filter((d) => d.add && !d.map) : [];
  const temps = boqHere ? dms.filter((d) => !d.add && !d.map) : dms;
  const overlaps = refused ? linkCheck(model, pred).overlaps : [];
  const link = (to0: string, lineUnit: string, lbl: string, extra: Op[] = []) => {
    const to = linkTarget(model, to0);
    const r = portionLinkOps(model, pred, to);
    if (!r.ok) {
      if (r.overlaps.length) setRefused({ to, unit: lineUnit, label: lbl, extra });
      else toast(r.reason);
      return;
    }
    // (what it covers now: the whole part, also what was linked elsewhere before and unlinked here)
    const now = linkCheck(model, pred).atoms.reduce((t, a) => t + a.qty, 0);
    onCommit([...extra, ...r.ops], 'Linked finishes to BOQ');
    // (the row's own unit says what it is - m, m2, nr, m3...: it was guessed as length or area, and a matching
    // unit was said to be wrong - 0.23.2, DeepSeek #33)
    const want = measureForUnit(unit) ?? (unit === 'm' ? 'len' : 'area');
    const ms = measureForUnit(lineUnit);
    toast(<span>Linked <b>{label}</b> to {lbl}: {fq(now, unit)} {unit} now — it follows the rooms as they change{ms && ms !== want ? <b> — careful, the line is in {lineUnit}</b> : null}.</span>, { action: { label: 'Show in BOQ', fn: () => revealInBoq(projectId, to) } });
    onClose();
  };
  return (
    <Modal wide title={`Link “${label}” to the BOQ`} onClose={onClose} sub={<>{fq(qty, unit)} {unit} not linked yet. The link covers this part of the summary, not a fixed number: rooms added or changed under it follow.</>}>
      {refused ? (
        <div className="warnbox fs-refused" data-refused>
          <TIcon k="warn" />
          <div>
            <b>Not linked: part of this quantity is linked already.</b> A quantity is linked once, never twice. Unlink {overlaps.length > 1 ? 'these' : 'this'} first, or cancel.
            {overlaps.map((o) => (
              <div key={o.id} className="fs-ov" data-overlap={o.id}>
                <span className="t"><b>{o.label}</b> → {o.to ? boqLineText(model, o.to) : ''}{o.kind === 'lk' ? <span className="faint"> (the take-off linked itself)</span> : null}</span>
                <button className="btn sm" onClick={() => onCommit(o.kind === 'fl' ? removePortionLinkOps(o.id) : [[o.id, 'del', true]], 'Unlinked ' + o.label)}>Unlink</button>
              </div>
            ))}
            {!overlaps.length && <div className="okc fs-ov">Nothing in the way any more.</div>}
            <div className="actions">
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn primary" data-linknow disabled={overlaps.length > 0} onClick={() => link(refused.to, refused.unit, refused.label, refused.extra)}>Link to {refused.label}</button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <input className="input" autoFocus placeholder={model.boqById.size ? 'Search the BOQ (description or ref)' : 'Search temporary lines'} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="picklist" style={{ maxHeight: 380, marginTop: 8 }}>
            {rows.map((r) =>
              r.bt === 'item' ? (
                <button key={r.id} className="pick psp" data-boqline={r.ref} onClick={() => link('b:' + r.id, r.unit, (r.ref ? r.ref + ' ' : '') + '“' + (r.desc.length > 48 ? r.desc.slice(0, 46) + '…' : r.desc) + '”')} title={mirrorPath(model, r.id)}>
                  <span className="pa">{r.ref}</span>
                  <span className="pd" style={{ paddingLeft: r.depth * 8 }}>{r.desc}</span>
                  <span className="pa">{r.unit}{r.qty !== null ? ` · ${fmtQty(r.qty)}` : ''}</span>
                </button>
              ) : (
                <div key={r.id} className={'pickhead d' + Math.min(r.depth, 2)}>{r.ref ? r.ref + ' · ' : ''}{r.desc}</div>
              ),
            )}
            {adds.length > 0 && <div className="pickhead d0">Additional items</div>}
            {adds.map((d) => (
              <button key={d.id} className="pick psp" onClick={() => link(d.id, d.unit, '“' + d.desc + '”')} title={[billLabel(model, d.bill), d.loc].filter(Boolean).join(' · ')}>
                <span className="pa"><span className="qam add">A+</span></span>
                <span className="pd">{d.desc}{d.loc ? <span className="faint"> · {d.loc}</span> : null}</span>
                <span className="pa">{d.unit}</span>
              </button>
            ))}
            {temps.length > 0 && <div className="pickhead d0">Temporary lines{boqHere ? ' (not resolved)' : ''}</div>}
            {temps.map((d) => (
              <button key={d.id} className="pick psp" onClick={() => link(d.id, d.unit, '“' + d.desc + '”')}>
                <span className="pa">{d.ref}</span>
                <span className="pd">{d.desc}</span>
                <span className="pa">{d.unit}</span>
              </button>
            ))}
            {!rows.length && !adds.length && !temps.length && <div className="hint" style={{ padding: 12 }}>{model.boqById.size ? 'No line matches.' : 'No BOQ yet — make a temporary line below.'}</div>}
          </div>
          {boqHere ? (
            <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={() => setAddNew(true)}><TIcon k="plus" /> Not in the BOQ? Add an additional item…</button>
          ) : newLine ? (
            <div className="dmadd" style={{ marginTop: 10 }}>
              <input className="input sm ref" placeholder="Ref" value={nd.ref} onChange={(e) => setNd({ ...nd, ref: e.target.value })} />
              <input className="input sm" placeholder="Description" value={nd.desc} onChange={(e) => setNd({ ...nd, desc: e.target.value })} />
              <select className="input sm unit" value={nd.unit} onChange={(e) => setNd({ ...nd, unit: e.target.value })}>{['m2', 'm', 'm3', 'nr', 'kg', 'item'].map((u) => <option key={u}>{u}</option>)}</select>
              <button className="btn sm primary" disabled={!nd.desc.trim()} onClick={() => { const d = dummyOps(model, nd); link(d.id, nd.unit, '“' + nd.desc.trim() + '”', d.ops); }}>Make and link</button>
            </div>
          ) : (
            <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={() => setNewLine(true)}><TIcon k="plus" /> Not in the list? Make a temporary line…</button>
          )}
          <div className="actions"><button className="btn" onClick={onClose}>Cancel</button></div>
        </>
      )}
      {addNew && (
        <AddDialog model={model} mode="link" onClose={() => setAddNew(false)} onSave={(fd) => {
          const d = additionalItemOps(model, fd, me);
          setAddNew(false);
          link(d.id, fd.unit, '“' + fd.desc.trim() + '”', d.ops);
        }} />
      )}
    </Modal>
  );
}
