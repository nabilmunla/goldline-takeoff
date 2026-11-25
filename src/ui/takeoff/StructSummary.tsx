// v0.17.1 (Feedback 3) the Structure and Blockwork tabs of Finalize: totals by element (or heading), the take-offs
// behind each row, and a small link button next to every quantity (concrete, formwork, steel... each goes to its own
// BOQ item). Read only: it changes nothing but the links made from it (the take-offs' ordinary links).
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { Measure, QtoModel } from '../../engine/qto/model';
import { MEASURE_LABEL } from '../../engine/qto/model';
import { structSummary, structSummaryRows, type SumGroup, type SumMode, type SumRow, type SumCol } from '../../engine/qto/structsum';
import { miscSummary, type MiscRow, type FinFilter } from '../../engine/qto/finishes';
import { writeXlsx } from '../../engine/xlsxwrite';
import { gt } from '../api';
import { q as fq, useQtoFmt } from './numfmt';
import { TIcon } from './ticons';
import { useDismiss } from './ListBits';

/** the heading filter of the summaries: search, the tree; a heading ticked takes everything under it */
export function HeadsFilter({ model, heads, onChange }: { model: QtoModel; heads: string[]; onChange: (h: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  const toggle = (h: string) => onChange(heads.includes(h) ? heads.filter((x) => x !== h) : [...heads, h]);
  /** under a ticked heading: in already */
  const under = (id: string) => { for (let h = model.headingById.get(id)?.par ?? '', n = 0; h && n < 20; n++) { if (heads.includes(h)) return true; h = model.headingById.get(h)?.par ?? ''; } return false; };
  const f = q.trim().toLowerCase();
  const list = model.headings.filter((h) => !f || h.name.toLowerCase().includes(f));
  const names = heads.map((h) => (h ? model.headingById.get(h)?.name ?? '' : '(no heading)')).filter(Boolean);
  return (
    <div className="tplwrap" ref={box}>
      <button className={'chip sm' + (heads.length ? ' on' : '')} data-headsfilter disabled={!model.headings.length} onClick={() => setOpen((x) => !x)} title={names.length ? names.join(', ') : 'Show only what is under the headings you tick'}>
        {heads.length === 0 ? 'All headings' : heads.length === 1 ? names[0] : `${heads.length} headings`} ▾
      </button>
      {open && (
        <div className="tplmenu fs-menu fs-heads">
          <input className="input sm" autoFocus placeholder="Find a heading" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); q ? setQ('') : setOpen(false); } }} />
          <div className="fs-headlist">
            {!f && <label className="check tp"><input type="checkbox" checked={heads.includes('')} onChange={() => toggle('')} /> (no heading)</label>}
            {list.map((h) => {
              const inh = under(h.id);
              return (
                <label key={h.id} className={'check tp' + (inh ? ' inh' : '')} style={{ paddingLeft: 8 + (f ? 0 : h.depth * 14) }} data-head={h.name} title={inh ? 'Under a ticked heading: shown already' : ''}>
                  <input type="checkbox" checked={heads.includes(h.id) || inh} disabled={inh} onChange={() => toggle(h.id)} /> {h.name}
                </label>
              );
            })}
            {!list.length && <div className="faint" style={{ padding: 6 }}>No heading by that name.</div>}
          </div>
          <div className="fs-headfoot">
            <span className="faint">A heading takes everything under it</span>
            <button className="linkbtn" disabled={!heads.length} onClick={() => onChange([])}>All headings</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** the small link button of the summaries: nothing linked yet / part / all of it */
export function LinkBtn({ state, title, disabled, onClick, ms }: { state: 'none' | 'some' | 'all'; title: string; disabled?: boolean; onClick: () => void; ms?: string }) {
  return (
    <button className={'lkb ' + state} data-sumlink={ms ?? ''} data-linkstate={state} disabled={disabled} title={title} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <TIcon k="link" size={11} />
    </button>
  );
}

const GROUPS: { k: SumGroup; label: string; tip: string; struct?: boolean }[] = [
  { k: 'el', label: 'Element', tip: 'Columns, beams, slabs… each with its take-offs' },
  { k: 'type', label: 'Element › type', tip: 'Each element by its schedule types (C1, C2…)', struct: true },
  { k: 'h0', label: 'Heading', tip: 'The top heading first (a block, a building), then its elements' },
  { k: 'head', label: 'Subheading', tip: 'Each heading on its own (GF, 1F…): its columns together, its beams together…' },
];

export function ElementSummary({ model, mode, projectId, projectName, readOnly: ro, onLink, onGoTo, toast }: {
  model: QtoModel;
  mode: SumMode;
  projectId: string;
  projectName?: string;
  readOnly: boolean;
  /** the take-offs of a row linked to a BOQ item with that quantity (the take-offs' ordinary link dialog) */
  onLink: (ids: string[], ms: Measure) => void;
  onGoTo: (id: string) => void;
  toast: (t: ReactNode) => void;
}) {
  useQtoFmt();
  const key = `qto.sumview.${projectId}.${mode}`;
  const [view, setView0] = useState<{ g: SumGroup; heads: string[]; q: string }>(() => {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); if (v && typeof v.g === 'string') return { g: v.g, heads: Array.isArray(v.heads) ? v.heads : [], q: '' }; } catch { /* */ }
    return { g: 'el', heads: [], q: '' };
  });
  const setView = (v: typeof view) => { setView0(v); try { localStorage.setItem(key, JSON.stringify({ g: v.g, heads: v.heads })); } catch { /* */ } };
  const g: SumGroup = mode === 'block' && view.g === 'type' ? 'el' : view.g;
  const heads = view.heads.filter((h) => h === '' || model.headingById.has(h));
  const s = useMemo(() => structSummary(model, mode, g, { heads, q: view.q }), [model, mode, g, JSON.stringify(heads), view.q]); // (join() was '' for both 'all' and 'no heading' - 0.23.2, DeepSeek #12)
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const num = (v: number | undefined, c: SumCol) => (v && v > 1e-9 ? fq(v, c.ms === 'kg' ? 'kg' : c.unit) : null);
  const cell = (r: SumRow, c: SumCol) => {
    const give = r.give[c.ms] ?? [], linked = r.linked[c.ms] ?? [];
    const v = num(r.qty[c.ms], c);
    const state = !linked.length ? 'none' : linked.length >= give.length ? 'all' : 'some';
    return (
      <td key={c.ms + c.unit} className="r num sum-cell">
        {v === null ? <span className="faint">—</span> : <>{r.id === '__total' || r.ti === undefined && !r.type ? <b>{v}</b> : v}</>}
        {c.link && !r.type && r.id !== '__total' && v !== null && (
          <LinkBtn
            ms={c.ms}
            state={state}
            disabled={ro && state === 'none'}
            title={`${MEASURE_LABEL[c.ms]}: ${state === 'all' ? 'linked to the BOQ' : state === 'some' ? `${linked.length} of ${give.length} take-offs linked to the BOQ` : 'not linked yet'}${ro ? '' : ' — click to link ' + (give.length > 1 ? `these ${give.length} take-offs` : 'it') + ' to a BOQ item'}`}
            onClick={() => { if (!ro) onLink(give, c.ms); }}
          />
        )}
        {(r.type || r.id === '__total' || v === null) && c.link && <span className="lkb gap" />}
      </td>
    );
  };
  const line = (r: SumRow, depth: number, open?: boolean) => (
    <tr key={r.id} className={'sum-row d' + depth + (r.id === '__total' ? ' tot' : '')} data-sumrow={r.label} onClick={() => { if (r.children.length) { const n = new Set(closed); n.has(r.id) ? n.delete(r.id) : n.add(r.id); setClosed(n); } }}>
      <td style={{ paddingLeft: 8 + depth * 18 }}>
        {depth === 0 && r.id !== '__total' && <span className={'chev' + (open ? '' : ' closed')}><TIcon k="chev" size={12} /></span>}
        {r.ti ? <button className="linkbtn sum-name" title="Show this take-off in the list" onClick={(e) => { e.stopPropagation(); onGoTo(r.ti!); }}>{r.label}</button> : depth === 0 ? <b>{r.label}</b> : <span>{r.label}</span>}
        {depth === 0 && r.id !== '__total' && <span className="faint fs-n">{r.items.length}</span>}
      </td>
      <td className="r num">{r.meas && r.meas.unit && r.meas.qty > 1e-9 ? <>{fq(r.meas.qty, r.meas.unit === 'nr' || r.meas.unit === 'openings' ? 'cnt' : r.meas.unit)} <small>{r.meas.unit}</small></> : <span className="faint">—</span>}</td>
      {s.cols.map((c) => cell(r, c))}
      {mode === 'struct' && <td className="r num auto" title="Steel ÷ concrete">{r.ratio === null ? <span className="faint">—</span> : fq(r.ratio, 'kg')}</td>}
    </tr>
  );
  const exportIt = async () => {
    const what = mode === 'struct' ? 'structure summary' : 'blockwork summary';
    const p = await gt().saveFile({ title: 'Export the ' + what, name: (projectName ? projectName + ' - ' : '') + what + '.xlsx', filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
    if (!p) return;
    try { await gt().files.writeBytes(p, writeXlsx([{ name: mode === 'struct' ? 'Structure' : 'Blockwork', rows: structSummaryRows(s, mode) }])); }
    catch (e: any) { toast('Could not write ' + p.split(/[\\/]/).pop() + ' (open in Excel?): ' + String(e?.message ?? e)); return; }
    toast(<span>Exported to <b>{p.split(/[\\/]/).pop()}</b>.</span>);
  };
  return (
    <>
      <div className="fs-bar" data-sumbar={mode}>
        <span className="lbl">Group by</span>
        <span className="seg">
          {GROUPS.filter((x) => mode === 'struct' || !x.struct).map((x) => <button key={x.k} className={g === x.k ? 'on' : ''} data-sumgroup={x.k} title={x.tip} onClick={() => setView({ ...view, g: x.k })}>{mode === 'block' && x.k === 'el' ? 'Thickness' : x.label}</button>)}
        </span>
        <HeadsFilter model={model} heads={heads} onChange={(h) => setView({ ...view, heads: h })} />
        <span className="grow" />
        <input className="input sm fs-q" placeholder="Find a take-off" value={view.q} onChange={(e) => setView0({ ...view, q: e.target.value })} onKeyDown={(e) => { if (e.key === 'Escape' && view.q) { e.stopPropagation(); setView0({ ...view, q: '' }); } }} />
        <button className="btn sm" data-sumexport disabled={!s.rows.length} onClick={exportIt}><TIcon k="excel" /> Export…</button>
      </div>
      <div className="paper-scroll fs-scroll">
        <table className="register fs-table sum-table" data-sumtable={mode}>
          <thead>
            <tr>
              <th>{mode === 'struct' ? 'Element' : 'Walls'}</th>
              <th className="r" style={{ width: 120 }}>{mode === 'struct' ? 'Measured' : 'Doors + openings'}</th>
              {s.cols.map((c) => <th key={c.ms + c.unit} className="r" style={{ width: 132 }}>{c.label} <small>{c.unit}</small></th>)}
              {mode === 'struct' && <th className="r" style={{ width: 90 }} title="Steel ÷ concrete, worked out">kg/m³ <span className="autotag">auto</span></th>}
            </tr>
          </thead>
          <tbody>
            {s.rows.flatMap((r) => { const open = !closed.has(r.id); return [line(r, 0, open), ...(open ? r.children.map((c) => line(c, 1)) : [])]; })}
            {s.rows.length > 1 && line(s.total, 0)}
            {!s.rows.length && (
              <tr><td colSpan={3 + s.cols.length} className="hint" style={{ padding: 18 }}>
                {mode === 'struct' ? 'No structural take-offs yet (beams, columns, slabs, drop panels, core walls) — or none under these headings.' : 'No blockwork walls yet (the Wall tool) — or none under these headings.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** v0.18 Finalize › Miscellaneous (Feedback 3, F): the rooms' miscellaneous items by code and unit, with what
 *  they are, their finishes, the total and a link button (a portion link on the code, as the finishes') */
export function MiscSummary({ model, readOnly, onLink }: { model: QtoModel; readOnly: boolean; onLink: (r: MiscRow, flt: FinFilter) => void }) {
  useQtoFmt();
  const [heads, setHeads] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const flt: FinFilter = { heads: heads.filter((h) => !h || model.headingById.has(h)), q };
  const s = useMemo(() => miscSummary(model, flt), [model, heads, q]);
  const EPS = 1e-9;
  return (
    <div className="sum-wrap" data-miscsum>
      <div className="fs-bar">
        <span className="lbl">Show</span>
        <HeadsFilter model={model} heads={heads} onChange={setHeads} />
        <input className="input sm" style={{ width: 190 }} placeholder="Room name or description" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="grow" />
        {s.uncoded > 0 && <span className="warnt" data-miscnocode title="Give each item a code in its room: only coded items are totalled and linked">{s.uncoded} item{s.uncoded > 1 ? 's' : ''} without a code — not in these totals</span>}
      </div>
      {s.rows.length === 0 ? (
        <p className="hint" style={{ padding: 18 }}>No miscellaneous items yet. In a room’s settings, under <b>Miscellaneous items</b>: kitchen cabinets, wardrobes, vanities, mirrors… — counted, measured or typed, each with a code.</p>
      ) : (
        <table className="sum-table" data-sumtable="misc">
          <thead><tr><th>Code</th><th>Description</th><th>Finish</th><th className="r">Rooms</th><th className="r">Quantity</th><th>Unit</th><th /></tr></thead>
          <tbody>
            {s.rows.map((r) => (
              <tr key={r.key + '|' + r.item + '|' + r.mfin + '|' + r.unit} data-sumrow={r.code + '|' + r.unit}>
                <td><b>{r.code}</b></td>
                <td>{r.descs.join(', ')}</td>
                <td className="faint">{r.fins.join(', ')}</td>
                <td className="r num">{r.rooms}</td>
                <td className="r num">{fq(r.qty, r.unit)}</td>
                <td>{r.unit}</td>
                <td>
                  <LinkBtn ms="misc" state={r.linked <= EPS ? 'none' : r.qty - r.linked > EPS ? 'some' : 'all'} disabled={readOnly || r.qty - r.linked <= EPS}
                    title={r.qty - r.linked <= EPS ? 'All of it is linked to the BOQ' : `Link ${fq(r.qty - r.linked, r.unit)} ${r.unit} of ${r.code} to a BOQ item${r.linked > EPS ? ' — the rest is linked already' : ''}`}
                    onClick={() => onLink(r, flt)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
