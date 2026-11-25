// Dialogs of v0.15: duplicate a take-off, beam types, the door schedule (typed, imported, re-imported),
// and the picker that opens on the drawing when a door (D) or another opening (O) is put on a wall.
import { activeWin } from '../popout';
import { DOOR_COUNTER_NAME } from '../../engine/qto/doorcount';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Op } from '../../engine/types';
import { doorTagKey, tagBase, type QtoModel, type TItem, type DoorRow, type BeamType } from '../../engine/qto/model';
import { applyDoorPlanOps, beamTypeOps, memberTypeOps, deleteDoorOps, doorRowsOps, planDoorImport, renameDoorOps, setSegTagsOps, shapeOverrideOps, type DoorField, type DoorIn, type DoorPlan } from '../../engine/qto/ops';
import { analyseDoorSchedule, doorRows, headsOf, sizeOf, unitOfHeading, DOOR_COL_LABEL, type DoorCol, type DoorCols, type DoorSheetPlan } from '../../engine/qto/doorsched';
import { readXlsx, type XWorkbook } from '../../engine/xlsx';
import { isThk, analyseBeamSchedule, applyBeamPlanOps, beamRows, planBeamImport, colLabel, guessBeamCols, memberScheduleRows, MEMBER_PRE, type BeamCol, type BeamCols, type BeamField, type BeamIn, type BeamSheetPlan, type MemberCat } from '../../engine/qto/beamsched';
import { writeXlsx } from '../../engine/xlsxwrite';
import { typeInstances, groupOverrideOps, underHeads } from '../../engine/qto/structsum';
import { HeadsFilter } from './StructSummary';
import { byTag, tagKey, type Found, type TagMode } from '../../engine/qto/autocount';
import { gt } from '../api';
import { parseNum } from '../format';
import { Modal } from './Dialogs';
import { TIcon } from './ticons';
import { ColorButton } from './ColorPicker';

/** metres shown as millimetres (door and beam sizes are written in mm on drawings) */
export const mmOf = (v: number | null | undefined) => (v ? String(Math.round(v * 1000 * 10) / 10) : '');
const sizeIn = (s: string): number | null | undefined => {
  const t = s.trim();
  if (!t) return null;
  const v = sizeOf(t);
  return v === null ? undefined : v;
};

// ---------------------------------------------------------------------
export function DuplicateDialog({ item, links, shapes, onClose, onDo }: { item: TItem; links: number; shapes: number; onClose: () => void; onDo: (o: { links: boolean; shapes: boolean }) => void }) {
  const [withLinks, setWithLinks] = useState(links > 0);
  const [withShapes, setWithShapes] = useState(false);
  return (
    <Modal title={`Duplicate “${item.name}”`} onClose={onClose} sub={<>The copy goes right below it as <b>{item.name} (copy)</b>, with the same settings (height, thickness, openings, lintels, display).</>}>
      <label className="check tp" style={{ marginBottom: 8 }}>
        <input type="checkbox" checked={withLinks} disabled={!links} onChange={(e) => setWithLinks(e.target.checked)} autoFocus />
        With its linked BOQ item{links === 1 ? '' : 's'} {links ? <span className="faint">({links} line{links > 1 ? 's' : ''}; the copy's quantity adds to the same line{links > 1 ? 's' : ''})</span> : <span className="faint">(not linked)</span>}
      </label>
      <label className="check tp">
        <input type="checkbox" checked={withShapes} disabled={!shapes} onChange={(e) => setWithShapes(e.target.checked)} />
        With its shapes {shapes ? <span className="faint">({shapes}, on the same sheets in the same places — usually you measure the copy afresh)</span> : <span className="faint">(none yet)</span>}
      </label>
      {withLinks && withShapes && <div className="warnbox" style={{ marginTop: 10 }}><TIcon k="warn" /><div>Both ticked: the same shapes count <b>twice</b> on the same BOQ line{links > 1 ? 's' : ''} until you move or change them.</div></div>}
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => onDo({ links: withLinks, shapes: withShapes })}><TIcon k="copy" /> Duplicate</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
const BEAM_COLORS = ['#364fc7', '#c2255c', '#2b8a3e', '#e67700', '#5f3dc4', '#0b7285', '#a61e4d', '#5c940d', '#d9480f', '#1864ab'];

/** v0.17 the schedules (doors, beams, columns, shear walls): one tool bar button, a tab each */
export type SchedTab = 'doors' | MemberCat;
export const SCHED_LABEL: Record<SchedTab, string> = { doors: 'Doors', beam: 'Beams', col: 'Columns', wall: 'Core walls', swall: 'Shear walls', ftg: 'Footings', rwall: 'Retaining walls', stair: 'Stairs' };
export function SchedTabs({ tab, onTab }: { tab: SchedTab; onTab?: (t: SchedTab) => void }) {
  if (!onTab) return null;
  return (
    <div className="seg sched-tabs" data-schedtabs>
      {(['doors', 'beam', 'col', 'swall', 'wall', 'rwall', 'ftg', 'stair'] as SchedTab[]).map((t) => <button key={t} type="button" className={tab === t ? 'on' : ''} data-schedtab={t} onClick={() => onTab(t)}>{SCHED_LABEL[t]}</button>)}
    </div>
  );
}
const MEMBER_NOUN: Record<MemberCat, string> = { beam: 'beam', col: 'column', wall: 'core wall', swall: 'shear wall', ftg: 'footing', rwall: 'retaining wall', stair: 'stair' };
/** v0.18.1 a schedule's size columns (mm), in order */
type SizeF = 'w' | 'd' | 't' | 'tr' | 'ri';
const SIZE_COLS: Record<MemberCat, [SizeF, string][]> = {
  beam: [['w', 'Width'], ['d', 'Depth']], col: [['w', 'Width / Ø'], ['d', 'Depth']], wall: [['w', 'Thickness']], rwall: [['w', 'Thickness']],
  swall: [['w', 'Length'], ['d', 'Thickness']], ftg: [['w', 'Length'], ['d', 'Width'], ['t', 'Depth']],
  stair: [['tr', 'Tread'], ['ri', 'Riser'], ['w', 'Flight width'], ['d', 'Waist'], ['t', 'Landing']],
};
/** the types of one schedule as the model has them */
export const typesOf = (model: QtoModel, cat: MemberCat): BeamType[] => (cat === 'beam' ? model.beamTypes : cat === 'col' ? model.colTypes : cat === 'swall' ? model.swTypes : cat === 'ftg' ? model.ftgTypes : cat === 'rwall' ? model.rwTypes : cat === 'stair' ? model.stairTypes : model.wallTypes);

/** beam / column / shear wall types: sizes, steel ratio, colour; import / update from Excel, export; marks on the drawing */
export function BeamTypesDialog({ model, readOnly, onCommit, onClose, onAutoTag, toast, cat = 'beam', onTab }: {
  model: QtoModel; readOnly: boolean; onCommit: (ops: Op[], label: string) => void; onClose: () => void;
  /** v0.16.6 the marks on the open sheet tag the beam segments they sit by (null: no sheet / no beams on it) */
  onAutoTag?: (() => void) | null;
  toast?: (t: ReactNode) => void;
  /** v0.17 which schedule (beams, columns, shear walls) and the tabs to the others */
  cat?: MemberCat;
  onTab?: (t: SchedTab) => void;
}) {
  const [imp, setImp] = useState<{ file: string; wb: XWorkbook; plan: BeamSheetPlan } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const types = typesOf(model, cat);
  const pre = MEMBER_PRE[cat];
  const noun = MEMBER_NOUN[cat];
  const used = useMemo(() => {
    const n = new Map<string, number>();
    for (const s of model.shapes) {
      for (const t0 of s.sg ?? []) { const t = tagBase(t0); if (t && t.startsWith(pre + ':')) n.set(t, (n.get(t) ?? 0) + 1); }
      if ((cat === 'col' || cat === 'swall' || cat === 'ftg' || cat === 'stair') && s.mt && s.mt.startsWith(pre + ':')) n.set(s.mt, (n.get(s.mt) ?? 0) + s.m);
    }
    for (const it of model.items) if (it.bt && it.bt.startsWith(pre + ':')) n.set(it.bt, (n.get(it.bt) ?? 0) + 1);
    return n;
  }, [model, cat]);
  const [sure, setSure] = useState<string | null>(null);
  /** v0.18 the type whose instances are shown under it */
  const [openT, setOpenT] = useState<string | null>(null);
  const [heads, setHeads] = useState<string[]>([]);
  const save = (id: string, f: 'name' | 'w' | 'd' | 'r' | 'color' | 'round' | 't' | 'tr' | 'ri', v: string | number | boolean | null) => onCommit([[id, f, v]], SCHED_LABEL[cat].replace(/s$/, '') + ' type');
  // a type removed: what was tagged with it goes to the take-off's default type, as the button says (the
  // tags were left pointing at the removed type: no volume, formwork or steel, "(type removed)" in the
  // totals); a take-off whose default it was has none
  const removeOps = (id: string): Op[] => {
    const ops: Op[] = [[id, 'del', true]];
    for (const s of model.shapes) {
      const idx = (s.sg ?? []).flatMap((t, i) => (tagBase(t) === id ? [i] : []));
      if (idx.length) ops.push(...setSegTagsOps(s, idx, null));
      if (s.mt === id) ops.push([s.id, 'mt', null]);
    }
    for (const it of model.items) if (it.bt === id) ops.push([it.id, 'bt', null]);
    return ops;
  };
  const add = () => {
    const n = types.length + 1;
    const first = cat === 'beam' ? 'B' : cat === 'col' ? 'C' : cat === 'ftg' ? 'F' : cat === 'swall' ? 'SW' : cat === 'rwall' ? 'RW' : cat === 'stair' ? 'ST' : 'CW';
    const t = cat === 'beam' ? { w: 0.3, d: 0.6 } : cat === 'col' ? { w: 0.4, d: 0.4 } : cat === 'swall' ? { w: 2, d: 0.25 } : cat === 'ftg' ? { w: 1.5, d: 1.5, t: 0.5 }
      : cat === 'stair' ? { tr: 0.28, ri: 0.18, w: 1.4, d: 0.25, t: 0.25 } : cat === 'rwall' ? { w: 0.3, d: null } : { w: 0.25, d: null };
    onCommit(memberTypeOps(pre, { name: first + n, ...t, r: null, color: BEAM_COLORS[(n - 1) % BEAM_COLORS.length] }).ops, 'New ' + noun + ' type');
  };
  // v0.16.6 the schedule from Excel (as the door schedule's)
  const pick = async () => {
    const files = await gt().pickFiles({ title: `Choose the ${noun} schedule (Excel)` });
    if (!files.length) return;
    setBusy(true); setErr(null);
    try {
      const raw = await gt().fs.readFrom(files[0], 0, 256 * 1024 * 1024);
      if (!raw) throw new Error('Could not read the file.');
      const wb = readXlsx(raw.data);
      let plan = analyseBeamSchedule(wb, cat);
      if (!plan) {
        // (v0.17 review: not found by itself - the columns are chosen by hand, from the first sheet's first row)
        const first = wb.sheetNames.find((x) => x.state === 'visible');
        if (!first) throw new Error('This file has no sheet to read.');
        const heads = headsOf(wb, first.name, 1);
        plan = { sheet: first.name, header: 1, heads, cols: guessBeamCols(heads, cat) };
        setErr(`The ${noun} schedule's headings were not recognised: pick the sheet, the headings row and the columns under “Columns read”.`);
      }
      setImp({ file: files[0], wb, plan });
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  // v0.17 the schedule to Excel
  const exportIt = async () => {
    const p = await gt().saveFile({ title: `Export the ${noun} schedule`, name: (model.name ? model.name + ' - ' : '') + SCHED_LABEL[cat].toLowerCase() + ' schedule.xlsx', filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
    if (!p) return;
    try { await gt().files.writeBytes(p, writeXlsx([{ name: SCHED_LABEL[cat], rows: memberScheduleRows(types, cat) }])); }
    catch (e: any) { setErr('Could not write ' + p.split(/[\\/]/).pop() + ' (open in Excel?): ' + String(e?.message ?? e)); return; }
    toast?.(<span>Exported to <b>{p.split(/[\\/]/).pop()}</b>.</span>);
  };
  if (imp) return <BeamImport model={model} cat={cat} imp={imp} onBack={() => setImp(null)} onCommit={(ops, label, msg) => { onCommit(ops, label); toast?.(msg); setImp(null); }} />;
  const f = q.trim().toLowerCase();
  const rows = types.filter((t) => !f || t.name.toLowerCase().includes(f));
  const sub = cat === 'beam'
    ? 'Each beam segment tagged with a type takes its size and steel from here (tag them in the take-off\'s segment list, or from the marks on the drawing). Depth is the full depth — the slab thickness set on the take-off comes off it (not for upstands).'
    : cat === 'col'
      ? 'Each column counted takes its section and steel from its type: concrete = section × the take-off\'s height, formwork = perimeter × height. Round columns: the width is the diameter.'
      : cat === 'swall' ? 'Each shear wall counted takes its length, thickness and steel from its type: concrete = length × thickness × the take-off\'s height (less the slab), formwork all round.'
      : cat === 'rwall' ? 'Each retaining wall segment takes its thickness and steel from its type: concrete = length × the take-off\'s height × thickness, formwork both faces; waterproofing as set on the take-off.'
      : cat === 'stair' ? 'Each flight and landing drawn takes its sizes from its type (its own, else the take-off\'s): steps = the flight\'s area ÷ (width × tread); concrete = steps + waist + landings; steel by ratio.'
      : cat === 'ftg' ? 'Each footing counted takes its length, width, depth and steel from its type: concrete = L × W × D, formwork = its four sides. Irregular footings and rafts: draw them (Structure ▾ › Raft).'
      : 'Each core wall segment takes its thickness and steel from its type: concrete = length × the take-off\'s height × thickness, formwork both faces; openings on it come off.';
  return (
    <Modal wide title={SCHED_LABEL[cat].replace(/s$/, '') + ' schedule'} onClose={onClose} sub={sub}>
      <SchedTabs tab={cat} onTab={onTab} />
      <div className="dsched-bar">
        <input className="input sm" placeholder={'Find a ' + noun} value={q} onChange={(e) => setQ(e.target.value)} />
        {/* v0.18.1 (Feedback 3, 7: "it can be filtered and/or grouped by headings and subheadings") where a type is used: under these headings */}
        <HeadsFilter model={model} heads={heads} onChange={setHeads} />
        <div className="grow" />
        {!readOnly && onAutoTag !== undefined && (
          <button className="btn sm" data-beamautotag disabled={!onAutoTag || !types.length} onClick={() => onAutoTag?.()} title={!types.length ? 'Add the types first' : !onAutoTag ? `Open a sheet with ${noun}s measured on it` : `Find the ${noun} marks on the open sheet: each tags the ${noun} it sits by - shown first, kept when you say`}>
            <TIcon k="auto" /> Tag {noun}s from their marks
          </button>
        )}
        {types.length > 0 && <button className="btn sm" data-schedexport onClick={exportIt}><TIcon k="excel" /> Export…</button>}
        {!readOnly && <button className="btn sm" data-beamimport disabled={busy} onClick={pick}><TIcon k="excel" /> {types.length ? 'Update from Excel…' : 'Import from Excel…'}</button>}
      </div>
      {err && <div className="warnbox" style={{ margin: '8px 0' }}><TIcon k="warn" /><div>{err}</div></div>}
      <table className="qtbl">
        <thead><tr><th>Name</th>{cat === 'col' && <th>Shape</th>}{SIZE_COLS[cat].map(([k, l]) => <th key={k} className="r">{l} mm</th>)}<th className="r">Steel kg/m³</th><th>Colour</th><th className="r" title="Tagged with it (and take-offs with it as their type)">Used</th><th /></tr></thead>
        <tbody>
          {rows.map((t) => (<Fragment key={t.id}>
            <tr data-typerow={t.name}>
              <td><span className="tyname"><button className={'btn icon ghost sm tychev' + (openT === t.id ? ' on' : '')} data-typeopen disabled={!used.get(t.id)} title={used.get(t.id) ? 'Where it is used, take-off by take-off: give a group figures of its own' : 'Not used yet'} onClick={() => setOpenT(openT === t.id ? null : t.id)}>{openT === t.id ? '▾' : '▸'}</button><Cell value={t.name} disabled={readOnly} onSave={(v) => { if (!v.trim()) return false; save(t.id, 'name', v.trim()); }} /></span></td>
              {cat === 'col' && (
                <td>
                  <select className="input sm" disabled={readOnly} value={t.round ? 'round' : 'rect'} onChange={(e) => { const r = e.target.value === 'round'; onCommit([[t.id, 'round', r ? true : null], ...(r ? [] : t.d ? [] : [[t.id, 'd', t.w] as Op])], 'Column type'); }}>
                    <option value="rect">Rectangular</option>
                    <option value="round">Round</option>
                  </select>
                </td>
              )}
              {SIZE_COLS[cat].map(([k]) => (
                <td key={k} className="r">{cat === 'col' && k === 'd' && t.round ? <span className="faint">—</span> : <Cell num value={mmOf((t[k] as number | null | undefined) ?? null)} disabled={readOnly} onSave={(v) => { const x = sizeIn(v); if (x === undefined) return false; save(t.id, k, x); }} />}</td>
              ))}
              <td className="r"><Cell num value={t.r === null ? '' : String(t.r)} placeholder="—" disabled={readOnly} onSave={(v) => { const x = parseNum(v); if (x === undefined || (x !== null && x < 0)) return false; save(t.id, 'r', x); }} /></td>
              <td>
                <ColorButton className="swbtn sm" value={t.color} disabled={readOnly} title="Colour of this type on the drawing" onPick={(c) => save(t.id, 'color', c)} />
              </td>
              <td className="r num faint">{used.get(t.id) ?? ''}</td>
              <td>
                {!readOnly && (sure === t.id
                  ? <button className="btn sm danger" onClick={() => { onCommit(removeOps(t.id), 'Removed ' + noun + ' type'); setSure(null); }}>Remove{used.get(t.id) ? ` (${used.get(t.id)} use${used.get(t.id)! > 1 ? 's' : ''} go to the default)` : ''}</button>
                  : <button className="btn icon ghost sm" title="Remove this type" onClick={() => setSure(t.id)}><TIcon k="x" /></button>)}
              </td>
            </tr>
            {openT === t.id && <TypeInstances model={model} cat={cat} t={t} readOnly={readOnly} onCommit={onCommit} heads={heads} />}
          </Fragment>))}
          {types.length === 0 && <tr><td colSpan={8} className="hint">No {noun} types yet — add them, or import the {noun} schedule from Excel.</td></tr>}
        </tbody>
      </table>
      <div className="actions">
        {!readOnly && <button className="btn" onClick={add}><TIcon k="plus" /> Add a type</button>}
        <div className="grow" />
        <button className="btn primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

/** v0.18 (Feedback 3, 7) a type's instances, take-off by take-off (under its headings): each group can be given a
 *  steel ratio of its own (all its elements of this type), or put back to the type's */
function TypeInstances({ model, cat, t, readOnly, onCommit, heads }: { model: QtoModel; cat: MemberCat; t: BeamType; readOnly: boolean; onCommit: (ops: Op[], label: string) => void; heads: string[] }) {
  const all = useMemo(() => typeInstances(model, cat, t.id), [model, cat, t.id]);
  // (v0.18.1 the schedule's heading filter: a heading takes everything under it)
  const groups = all.filter((g) => underHeads(model, g.par, heads));
  const line = cat === 'beam' || isThk(cat);
  // (the sizes a group can have of its own: the schedule's, in mm - a stair's are its type's only)
  const dims: ['w' | 'd' | 't', string][] = cat === 'stair' ? [] : isThk(cat) ? [['w', 'Thickness']] : cat === 'ftg' ? [['w', 'L'], ['d', 'W'], ['t', 'D']] : cat === 'swall' ? [['w', 'L'], ['d', 'T']] : [['w', 'W'], ['d', 'D']];
  const val = (v: number | null | 'mixed', mm: boolean) => (v === 'mixed' || v === null ? '' : mm ? String(Math.round(v * 1000)) : String(v));
  const ph = (v: number | null | 'mixed', def: number | null | undefined, mm: boolean) => (v === 'mixed' ? 'varies' : def == null ? '—' : mm ? String(Math.round(def * 1000)) : String(def));
  const def = { w: t.w, d: t.d, t: t.t ?? null };
  return (
    <tr className="tyinst" data-typeinst={t.name}>
      <td colSpan={11}>
        <div className="tyinst-box">
          <div className="faint">Used in — each takes {t.name}’s figures unless it has its own. Typed on a line here: for all of that take-off’s {line ? 'segments' : 'elements'} of {t.name}; one element: pick it on the drawing (its box is on the right).</div>
          {groups.map((g) => (
            <div key={g.ti} className="tyinst-row" data-instgroup={g.label}>
              <span className="lb">{g.label}</span>
              <span className="num">{line ? g.n.toFixed(2) + ' m' : g.n + ' nr'}</span>
              <span className={g.own ? 'autotag off' : 'faint'}>{g.own ? `${g.own} with own figures` : 'as the type'}</span>
              <span className="grow" />
              {dims.map(([k, l]) => (
                <span key={k} className="tyinst-f"><span className="faint">{l}</span><span className="tyinst-in" data-instdim={k}><Cell num value={val(g[('x' + k) as 'xw'], true)} placeholder={ph(g[('x' + k) as 'xw'], def[k], true)} disabled={readOnly} onSave={(v) => { const x = sizeIn(v); if (x === undefined) return false; onCommit(groupOverrideOps(cat, g, { [k]: x }), t.name + ' in ' + g.label + ': ' + l); }} /></span></span>
              ))}
              {dims.length > 0 && <span className="faint">mm</span>}
              <span className="faint">Steel</span>
              <span className="tyinst-in" data-instdim="r"><Cell num value={val(g.xr, false)} placeholder={ph(g.xr, t.r, false)} disabled={readOnly} onSave={(v) => { const x = parseNum(v); if (x === undefined || (x !== null && x < 0)) return false; onCommit(groupOverrideOps(cat, g, { r: x }), 'Steel ratio of ' + t.name + ' in ' + g.label); }} /></span>
              <span className="faint">kg/m³</span>
              {!readOnly && g.own > 0 && <button className="linkbtn" data-instreset onClick={() => onCommit([...groupOverrideOps(cat, g, { w: null, d: null, t: null, r: null }), ...(line ? [] : shapeOverrideOps(g.shapes, { xh: null, xn: null }))], t.name + ' in ' + g.label + ' back to the type')}>Back to the type</button>}
            </div>
          ))}
          {!groups.length && <div className="faint">{all.length ? 'None under the headings picked.' : 'Only as a take-off’s default type so far: nothing drawn with it.'}</div>}
        </div>
      </td>
    </tr>
  );
}

/** v0.16.6 a schedule from Excel: what is new, what changed (tick what to take); nothing changes until asked */
function BeamImport({ model, imp, onBack, onCommit, cat }: { model: QtoModel; imp: { file: string; wb: XWorkbook; plan: BeamSheetPlan }; onBack: () => void; onCommit: (ops: Op[], label: string, msg: ReactNode) => void; cat: MemberCat }) {
  const [sheet, setSheet] = useState(imp.plan.sheet);
  const [header, setHeader] = useState(imp.plan.header);
  const [cols, setCols] = useState<BeamCols>(imp.plan.cols);
  const heads = useMemo(() => { try { return headsOf(imp.wb, sheet, header); } catch { return new Map<number, string>(); } }, [imp.wb, sheet, header]);
  const rows = useMemo<BeamIn[]>(() => { try { return beamRows(imp.wb, { sheet, header, cols }, cat); } catch { return []; } }, [imp.wb, sheet, header, cols, cat]);
  const types = typesOf(model, cat);
  const plan = useMemo(() => planBeamImport({ beamTypes: types }, rows, cat), [types, rows, cat]);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const added = plan.rows.filter((r) => r.k === 'new');
  const changed = plan.rows.filter((r) => r.k === 'changed');
  const same = plan.rows.filter((r) => r.k === 'same').length;
  const noun = MEMBER_NOUN[cat];
  const toggle = (k: string) => setSkip((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const FL: Record<BeamField, string> = { w: isThk(cat) ? 'Thickness' : cat === 'swall' || cat === 'ftg' ? 'Length' : cat === 'stair' ? 'Flight width' : 'Width', d: cat === 'swall' ? 'Thickness' : cat === 'ftg' ? 'Width' : cat === 'stair' ? 'Waist' : 'Depth', r: 'Steel kg/m³', round: 'Round', t: cat === 'stair' ? 'Landing' : 'Depth', tr: 'Tread', ri: 'Riser' };
  const show = (f: BeamField, v: number | boolean | null) => (v === null ? '—' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : f === 'r' ? String(v) : mmOf(v));
  const size = (r: BeamIn) => (r.round ? 'Ø' + mmOf(r.w) : cat === 'stair' ? `${mmOf(r.tr ?? null)} / ${mmOf(r.ri ?? null)}, ${mmOf(r.w)} wide` : isThk(cat) ? mmOf(r.w) + ' thick' : mmOf(r.w) + ' × ' + mmOf(r.d) + (cat === 'ftg' ? ' × ' + mmOf(r.t ?? null) : ''));
  const apply = () => {
    const take = new Map<string, Set<BeamField> | true>();
    for (const r of plan.rows) {
      if (skip.has(r.key)) continue;
      if (r.k === 'changed') { const fs = new Set(r.ch.map((c) => c[0]).filter((f) => !skip.has(r.key + '|' + f))); if (fs.size) take.set(r.key, fs); }
      else if (r.k === 'new') take.set(r.key, true);
    }
    const res = applyBeamPlanOps(plan, take, BEAM_COLORS, types.length, cat);
    if (!res.ops.length) { onBack(); return; }
    onCommit(res.ops, SCHED_LABEL[cat].replace(/s$/, '') + ' schedule from Excel', <span>{SCHED_LABEL[cat].replace(/s$/, '')} schedule from <b>{imp.file.split(/[\\/]/).pop()}</b>: {res.added} added, {res.updated} changed.</span>);
  };
  const colChoice = (k: BeamCol) => (
    <label key={k} className="dmap">
      <span>{colLabel(cat, k)}</span>
      <select className="input sm" value={cols[k] ?? ''} onChange={(e) => setCols((c) => { const n = { ...c }; if (e.target.value) n[k] = Number(e.target.value); else delete n[k]; return n; })}>
        <option value="">—</option>
        {[...heads.entries()].map(([c, t]) => <option key={c} value={c}>{t}</option>)}
      </select>
    </label>
  );
  return (
    <Modal wide title={SCHED_LABEL[cat].replace(/s$/, '') + ' schedule from Excel'} onClose={onBack} sub={<>From <b>{imp.file.split(/[\\/]/).pop()}</b>. Types are matched by mark (B-1 = B1). Nothing changes until you press <b>Update the schedule</b>.</>}>
      <details className="dsched-map">
        <summary>Columns read: {(Object.keys(cols) as BeamCol[]).map((k) => colLabel(cat, k)).join(', ') || 'none'} — sheet “{sheet}”, headings on row {header}</summary>
        <div className="dmaps">
          <label className="dmap"><span>Sheet</span>
            <select className="input sm" value={sheet} onChange={(e) => setSheet(e.target.value)}>{imp.wb.sheetNames.filter((x) => x.state === 'visible').map((x) => <option key={x.name}>{x.name}</option>)}</select>
          </label>
          <label className="dmap"><span>Headings on row</span><input className="input sm num" defaultValue={header} onBlur={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1) setHeader(n); }} /></label>
          {((isThk(cat) ? ['mark', 'w', 'sz', 'r'] : cat === 'ftg' ? ['mark', 'w', 'd', 't', 'sz', 'r'] : cat === 'stair' ? ['mark', 'tr', 'ri', 'w', 'd', 't', 'r'] : ['mark', 'w', 'd', 'sz', 'r']) as BeamCol[]).map(colChoice)}
        </div>
        <p className="hint">Sizes in the unit a column's heading names (mm, cm, m); without one, over 20 is millimetres. One “size” column (300 × 600{cat === 'col' ? ', or Ø500' : ''}) gives {isThk(cat) ? 'the thickness' : 'width and depth'}. The steel ratio is kg per m³ of concrete; reinforcement bars (4T16) are not read.</p>
      </details>
      <div className="dsum">
        <span><b>{rows.length}</b> {noun}s in the file</span>
        <span><b>{added.length}</b> new</span>
        <span><b>{changed.length}</b> changed</span>
        <span>{same} the same</span>
        {plan.missing.length > 0 && <span title={plan.missing.map((t) => t.name).join(', ')}>{plan.missing.length} in the schedule, not in the file (kept)</span>}
        {plan.dupes.length > 0 && <span className="bad" title={plan.dupes.join(', ')}>{plan.dupes.length} mark{plan.dupes.length > 1 ? 's' : ''} twice in the file (first one used)</span>}
      </div>
      <div className="dsched-wrap">
        {changed.length > 0 && (
          <>
            <h5>Changed — tick what to take from the file</h5>
            {changed.map((r) => (
              <div key={r.key} className="dchg">
                <label className="check"><input type="checkbox" checked={!skip.has(r.key)} onChange={() => toggle(r.key)} /> <b>{r.row.name}</b></label>
                {r.ch.map(([fld, ov, nv]) => (
                  <label key={fld} className={'check dfield' + (skip.has(r.key) ? ' off' : '')}>
                    <input type="checkbox" disabled={skip.has(r.key)} checked={!skip.has(r.key + '|' + fld)} onChange={() => toggle(r.key + '|' + fld)} />
                    {FL[fld]}: <s>{show(fld, ov)}</s> → <b>{show(fld, nv)}</b>
                  </label>
                ))}
              </div>
            ))}
          </>
        )}
        {added.length > 0 && (
          <>
            <h5>New</h5>
            {added.map((r) => (
              <label key={r.key} className="check dchg" data-beamnew={r.row.name}>
                <input type="checkbox" checked={!skip.has(r.key)} onChange={() => toggle(r.key)} />
                <b>{r.row.name}</b> <span className="faint">{size(r.row)}{r.row.r ? ` · ${r.row.r} kg/m³` : ''}</span>
              </label>
            ))}
          </>
        )}
        {!rows.length && <p className="hint">No {noun}s read with these columns. Open “Columns read” above and pick the mark and size columns.</p>}
      </div>
      <div className="actions">
        <button className="btn" onClick={onBack}>Back</button>
        <button className="btn primary" data-beamapply disabled={!rows.length} onClick={apply}>Update the schedule</button>
      </div>
    </Modal>
  );
}

/** a cell edited in place: saved when you leave it (Enter), Esc puts it back; refused (onSave says false:
 *  a tag another row has, a size that is not one) it shows what is kept again, not what was typed */
function Cell({ value, onSave, disabled, num, placeholder, title }: { value: string; onSave: (v: string) => boolean | void; disabled?: boolean; num?: boolean; placeholder?: string; title?: string }) {
  const [v, setV] = useState(value);
  const el = useRef<HTMLInputElement>(null);
  const from = useRef(value);
  // someone else's change to this cell (another PC) shows - unless you are typing in it: what you typed is
  // not swapped for theirs under your fingers (it was, and leaving the cell then saved nothing)
  // (its own window's document: in a sheet window the main window's focus was asked - 0.23.2, DeepSeek #46)
  useEffect(() => { setV((cur) => (cur !== from.current && !!el.current && el.current.ownerDocument.activeElement === el.current ? cur : value)); from.current = value; }, [value]);
  return (
    <input
      ref={el}
      className={'input sm cellin' + (num ? ' num' : '')}
      value={v}
      title={title}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== value && onSave(v) === false) setV(value); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape' && v !== value) { setV(value); e.stopPropagation(); } }}
    />
  );
}

// ---------------------------------------------------------------------
const FIELD_LABEL: Record<DoorField, string> = { desc: 'description', loc: 'location', sw: 'structural W', sh: 'structural H', cw: 'clear W', ch: 'clear H' };
const showField = (f: DoorField, v: string | number | null) => (v === null || v === '' ? '—' : f === 'desc' || f === 'loc' ? String(v) : mmOf(v as number));

export function DoorScheduleDialog({ model, readOnly, onCommit, onLink, onClose, toast, onTab }: {
  model: QtoModel;
  readOnly: boolean;
  onCommit: (ops: Op[], label: string) => void;
  onLink: (doorId: string) => void;
  onClose: () => void;
  toast: (t: ReactNode) => void;
  /** v0.17 the tabs to the other schedules */
  onTab?: (t: SchedTab) => void;
}) {
  // v0.17 the door schedule to Excel (read back by Import / Update)
  const exportIt = async () => {
    const p = await gt().saveFile({ title: 'Export the door schedule', name: (model.name ? model.name + ' - ' : '') + 'door schedule.xlsx', filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
    if (!p) return;
    const mm = (v: number | null) => (v === null ? null : Math.round(v * 1000 * 10) / 10);
    const rows: (string | number | null)[][] = [['Tag', 'Description', 'Location', 'Structural width (mm)', 'Structural height (mm)', 'Clear width (mm)', 'Clear height (mm)', 'Placed'],
      ...model.doors.map((d) => [d.tag, d.desc || null, d.loc || null, mm(d.sw), mm(d.sh), mm(d.cw), mm(d.ch), model.doorCount.get(d.id) ?? 0])];
    try { await gt().files.writeBytes(p, writeXlsx([{ name: 'Door Schedule', rows }])); }
    catch (e: any) { toast('Could not write ' + p.split(/[\\/]/).pop() + ' (open in Excel?): ' + String(e?.message ?? e)); return; }
    toast(<span>Exported to <b>{p.split(/[\\/]/).pop()}</b>.</span>);
  };
  const [q, setQ] = useState('');
  const [sure, setSure] = useState<string | null>(null);
  const [imp, setImp] = useState<{ file: string; wb: XWorkbook; plan: DoorSheetPlan } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newTag, setNewTag] = useState('');
  const placed = useMemo(() => {
    const n = new Map<string, number>();
    for (const o of model.openings) if (o.k === 'door' && o.door) n.set(o.door, (n.get(o.door) ?? 0) + 1);
    return n;
  }, [model]);
  const uns = model.openings.filter((o) => o.uns).length;
  const f = q.trim().toLowerCase();
  const rows = model.doors.filter((d) => !f || d.tag.toLowerCase().includes(f) || d.desc.toLowerCase().includes(f) || d.loc.toLowerCase().includes(f));
  const setField = (d: DoorRow, fld: DoorField, v: string): boolean | void => {
    if (fld === 'desc' || fld === 'loc') return onCommit(doorRowsOps(model, [{ tag: d.tag, [fld]: v }]).ops, 'Door schedule');
    const x = sizeIn(v);
    if (x === undefined) { toast('Type a size in mm (900) or m (0.9).'); return false; }
    onCommit(doorRowsOps(model, [{ tag: d.tag, [fld]: x }]).ops, 'Door schedule');
  };
  const rename = (d: DoorRow, v: string): boolean | void => {
    const ops = renameDoorOps(model, d.id, v);
    if (!ops) { toast(v.trim() ? <span>There is already a door <b>{v.trim()}</b> in the schedule.</span> : 'A door needs a tag.'); return false; }
    onCommit(ops, 'Renamed door');
  };
  const addRow = () => {
    const t = newTag.trim();
    if (!t) return;
    if (model.doors.some((d) => doorTagKey(d.tag) === doorTagKey(t))) { toast(<span><b>{t}</b> is already in the schedule.</span>); return; }
    onCommit(doorRowsOps(model, [{ tag: t }]).ops, 'Added door');
    setNewTag('');
  };
  const pick = async () => {
    const files = await gt().pickFiles({ title: 'Choose the door schedule (Excel)' });
    if (!files.length) return;
    setBusy(true); setErr(null);
    try {
      const raw = await gt().fs.readFrom(files[0], 0, 256 * 1024 * 1024);
      if (!raw) throw new Error('Could not read the file.');
      const wb = readXlsx(raw.data);
      const plan = analyseDoorSchedule(wb);
      if (!plan) throw new Error('No sheet in this file has a header row with a door tag (Tag, Mark, Door No.) and a size (width / height). Is it the door schedule?');
      setImp({ file: files[0], wb, plan });
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (imp) return <DoorImport model={model} imp={imp} onBack={() => setImp(null)} onCommit={(ops, label, msg) => { onCommit(ops, label); toast(msg); setImp(null); }} />;

  return (
    <Modal wide title="Door schedule" onClose={onClose} sub={<>Each door placed on a wall (<kbd>D</kbd> while measuring a wall) - or counted where there is no wall with the Count tool's <kbd>D</kbd> - takes its size from here: the structural opening comes off the wall and carries the lintel; without one, the clear opening is used. Change a size here and every door with that tag follows.</>}>
      <SchedTabs tab="doors" onTab={onTab} />
      <div className="dsched-bar">
        <input className="input sm" placeholder="Find a door" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="grow" />
        {model.doors.length > 0 && <button className="btn sm" data-schedexport onClick={exportIt}><TIcon k="excel" /> Export…</button>}
        {!readOnly && <button className="btn sm" disabled={busy} onClick={pick}><TIcon k="excel" /> {model.doors.length ? 'Update from Excel…' : 'Import from Excel…'}</button>}
      </div>
      {err && <div className="warnbox" style={{ margin: '8px 0' }}><TIcon k="warn" /><div>{err}</div></div>}
      {uns > 0 && <div className="warnbox" style={{ margin: '8px 0' }}><TIcon k="warn" /><div><b>{uns} door{uns > 1 ? 's' : ''} on the drawings {uns > 1 ? 'are' : 'is'} not in the schedule</b> (row deleted) — counted with {uns > 1 ? 'their' : 'its'} last size. Add the tag again and {uns > 1 ? 'they go' : 'it goes'} back on it.</div></div>}
      <div className="dsched-wrap">
        <table className="qtbl dsched">
          <thead>
            <tr><th>Tag</th><th>Description</th><th>Location</th><th className="r" colSpan={2}>Structural W × H mm</th><th className="r" colSpan={2}>Clear W × H mm</th><th className="r" title="Doors placed on shared walls, and counted where there is no wall (× repeats)">Placed</th><th>BOQ</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const n = model.doorCount.get(d.id) ?? 0;
              const pl = placed.get(d.id) ?? 0;
              const links = model.linksByItem.get(d.id)?.length ?? 0;
              return (
                <tr key={d.id}>
                  <td><span className="tagcell"><Cell value={d.tag} disabled={readOnly} onSave={(v) => rename(d, v)} />{d.app && <span className="tagapp" title="Added in the app (not from an Excel file): a later import keeps it">app</span>}</span></td>
                  <td><Cell value={d.desc} disabled={readOnly} onSave={(v) => setField(d, 'desc', v)} /></td>
                  <td><Cell value={d.loc} disabled={readOnly} onSave={(v) => setField(d, 'loc', v)} /></td>
                  {(['sw', 'sh', 'cw', 'ch'] as const).map((k) => (
                    <td key={k} className="r"><Cell num value={mmOf(d[k])} placeholder="—" disabled={readOnly} onSave={(v) => setField(d, k, v)} /></td>
                  ))}
                  <td className="r num">{n || (pl ? <span className="faint" title="Placed only on private take-offs">0</span> : '—')}</td>
                  <td>{!readOnly ? <button className={'btn sm ghost' + (links ? ' ok' : '')} onClick={() => onLink(d.id)} title="Link the number of these doors to a BOQ line"><TIcon k="link" />{links || ''}</button> : links ? <TIcon k="link" /> : null}</td>
                  <td>
                    {!readOnly && (sure === d.id
                      ? <button className="btn sm danger" onClick={() => { onCommit(deleteDoorOps(model, d.id), 'Deleted door'); setSure(null); }}>{pl ? `Delete — ${pl} placed keep this size` : 'Delete'}</button>
                      : <button className="btn icon ghost sm" title="Delete this door" onClick={() => setSure(d.id)}><TIcon k="x" /></button>)}
                  </td>
                </tr>
              );
            })}
            {model.doors.length === 0 && <tr><td colSpan={10} className="hint">No doors yet — import the schedule from Excel, add them here, or type a new tag when you place a door.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="actions">
        {!readOnly && (
          <>
            <input className="input sm" style={{ width: 120 }} placeholder="New tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addRow()} />
            <button className="btn" disabled={!newTag.trim()} onClick={addRow}><TIcon k="plus" /> Add a door</button>
          </>
        )}
        <div className="grow" />
        <button className="btn primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

/** an Excel door schedule against the one in the project: what is new, what changed (field by field) */
function DoorImport({ model, imp, onBack, onCommit }: { model: QtoModel; imp: { file: string; wb: XWorkbook; plan: DoorSheetPlan }; onBack: () => void; onCommit: (ops: Op[], label: string, msg: ReactNode) => void }) {
  const [sheet, setSheet] = useState(imp.plan.sheet);
  const [header, setHeader] = useState(imp.plan.header);
  const [cols, setCols] = useState<DoorCols>(imp.plan.cols);
  const heads = useMemo(() => { try { return headsOf(imp.wb, sheet, header); } catch { return new Map<number, string>(); } }, [imp.wb, sheet, header]);
  const rows = useMemo<DoorIn[]>(() => { try { return doorRows(imp.wb, { sheet, header, cols }); } catch { return []; } }, [imp.wb, sheet, header, cols]);
  const plan: DoorPlan = useMemo(() => planDoorImport(model, rows), [model, rows]);
  // what to take: per row (by tag), per changed field; new / back rows: in or out
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [drop, setDrop] = useState<Set<string>>(new Set());
  // (the same key the engine uses: "D-10" = "D10")
  const key = (tag: string, f?: DoorField) => doorTagKey(tag) + (f ? '|' + f : '');
  const added = plan.rows.filter((r) => r.k === 'new' || r.k === 'back');
  const changed = plan.rows.filter((r) => r.k === 'changed');
  const same = plan.rows.filter((r) => r.k === 'same').length;
  const toggle = (k: string) => setSkip((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const apply = () => {
    const take = new Map<string, Set<DoorField> | true>();
    for (const r of plan.rows) {
      if (skip.has(key(r.tag))) continue;
      if (r.k === 'changed') {
        const fs = new Set(r.ch.map((c) => c[0]).filter((f) => !skip.has(key(r.tag, f))));
        if (fs.size) take.set(key(r.tag), fs);
      } else take.set(key(r.tag), true);
    }
    const r = applyDoorPlanOps(model, plan, take, [...drop]);
    if (!r.ops.length) { onBack(); return; }
    const name = imp.file.split(/[\\/]/).pop();
    onCommit(r.ops, 'Door schedule from Excel', <span>Door schedule from <b>{name}</b>: {r.added} added, {r.updated} changed{r.removed ? `, ${r.removed} removed` : ''}.</span>);
  };
  const colChoice = (k: DoorCol) => (
    <label key={k} className="dmap">
      <span>{DOOR_COL_LABEL[k]}</span>
      <select className="input sm" value={cols[k] ?? ''} onChange={(e) => setCols((c) => { const n = { ...c }; if (e.target.value) n[k] = Number(e.target.value); else delete n[k]; return n; })}>
        <option value="">—</option>
        {[...heads.entries()].map(([c, t]) => <option key={c} value={c}>{t}</option>)}
      </select>
    </label>
  );
  return (
    <Modal wide title="Door schedule from Excel" onClose={onBack} sub={<>From <b>{imp.file.split(/[\\/]/).pop()}</b>. Doors are matched by tag. Nothing changes until you press <b>Update the schedule</b>.</>}>
      <details className="dsched-map">
        <summary>Columns read: {(Object.keys(cols) as DoorCol[]).map((k) => { const u = ['sw', 'sh', 'cw', 'ch'].includes(k) ? unitOfHeading(heads.get(cols[k]!) ?? '') : ''; return DOOR_COL_LABEL[k] + (u ? ` (${u})` : ''); }).join(', ') || 'none'} — sheet “{sheet}”, headings on row {header}</summary>
        <div className="dmaps">
          <label className="dmap"><span>Sheet</span>
            <select className="input sm" value={sheet} onChange={(e) => setSheet(e.target.value)}>{imp.wb.sheetNames.filter((s) => s.state === 'visible').map((s) => <option key={s.name}>{s.name}</option>)}</select>
          </label>
          <label className="dmap"><span>Headings on row</span><input className="input sm num" defaultValue={header} onBlur={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1) setHeader(n); }} /></label>
          {(['tag', 'desc', 'loc', 'sw', 'sh', 'cw', 'ch', 'ssz', 'csz'] as DoorCol[]).map(colChoice)}
        </div>
        <p className="hint">Sizes are in the unit a column's heading names: (mm), (cm) or (m). Without one, over 20 is millimetres, else metres; a cell with its own unit (90 cm) keeps it. One “size” column (900 × 2100) gives both width and height.</p>
      </details>
      <div className="dsum">
        <span><b>{rows.length}</b> doors in the file</span>
        <span><b>{added.length}</b> new</span>
        <span><b>{changed.length}</b> changed</span>
        <span>{same} the same</span>
        {plan.missing.length > 0 && <span><b>{plan.missing.length}</b> in the schedule, not in the file</span>}
        {plan.dupes.length > 0 && <span className="bad" title={plan.dupes.join(', ')}>{plan.dupes.length} tag{plan.dupes.length > 1 ? 's' : ''} twice in the file (first one used)</span>}
      </div>
      <div className="dsched-wrap">
        {changed.length > 0 && (
          <>
            <h5>Changed — tick what to take from the file</h5>
            {changed.map((r) => (
              <div key={r.tag} className="dchg">
                <label className="check"><input type="checkbox" checked={!skip.has(key(r.tag))} onChange={() => toggle(key(r.tag))} /> <b>{r.tag}</b></label>
                {r.ch.map(([fld, ov, nv]) => (
                  <label key={fld} className={'check dfield' + (skip.has(key(r.tag)) ? ' off' : '')}>
                    <input type="checkbox" disabled={skip.has(key(r.tag))} checked={!skip.has(key(r.tag, fld))} onChange={() => toggle(key(r.tag, fld))} />
                    {FIELD_LABEL[fld]}: <s>{showField(fld, ov)}</s> → <b>{showField(fld, nv)}</b>
                  </label>
                ))}
              </div>
            ))}
          </>
        )}
        {added.length > 0 && (
          <>
            <h5>New</h5>
            {added.map((r) => (
              <label key={r.tag} className="check dchg">
                <input type="checkbox" checked={!skip.has(key(r.tag))} onChange={() => toggle(key(r.tag))} />
                <b>{r.tag}</b> {r.row.desc && <span>{r.row.desc}</span>} <span className="faint">{mmOf(r.row.sw)}{r.row.sh ? ' × ' + mmOf(r.row.sh) : ''}{r.row.cw ? ` (clear ${mmOf(r.row.cw)}${r.row.ch ? ' × ' + mmOf(r.row.ch) : ''})` : ''}</span>
                {r.k === 'back' && <span className="tagapp" title="It was in the schedule before and was deleted: it comes back with its BOQ links, and doors still placed with it go back on it">back</span>}
              </label>
            ))}
          </>
        )}
        {plan.missing.length > 0 && (
          <>
            <h5>In the schedule but not in this file</h5>
            {plan.missing.map((x) => (
              <label key={x.id} className="check dchg">
                <input type="checkbox" disabled={x.placed > 0} checked={drop.has(x.id)} onChange={() => setDrop((s) => { const n = new Set(s); n.has(x.id) ? n.delete(x.id) : n.add(x.id); return n; })} />
                Remove <b>{x.tag}</b> {x.app && <span className="tagapp">added in the app</span>}
                {x.placed > 0 ? <span className="faint"> — kept: placed {x.placed} time{x.placed > 1 ? 's' : ''} (delete it in the schedule if it really goes)</span> : <span className="faint"> — not placed anywhere</span>}
              </label>
            ))}
          </>
        )}
        {!rows.length && <p className="hint">No doors read with these columns. Open “Columns read” above and pick the tag and size columns.</p>}
      </div>
      <div className="actions">
        <button className="btn" onClick={onBack}>Back</button>
        <button className="btn primary" disabled={!rows.length} onClick={apply}>Update the schedule</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
/**
 * Where a door / an opening was clicked on a wall: pick the door's tag (type to find it, or a new tag
 * to add it to the schedule), or give an opening's size. Opens at the click.
 */
export function OpeningPicker({ k, at, model, current, onClose, onDoor, onOpen, room, counter }: {
  k: 'door' | 'open';
  at: [number, number];
  model: QtoModel;
  /** changing one already placed */
  current?: { door: string | null; tag: string; w: number | null; h: number | null; lint: boolean; sill?: number | null } | null;
  onClose: () => void;
  /** a door from the schedule (id), or a new tag with its structural size (added to the schedule) */
  onDoor: (d: { id: string } | { tag: string; sw: number | null; sh: number | null }, lint: boolean) => void;
  onOpen: (o: { w: number; h: number; tag: string; sill?: number }, lint: boolean) => void;
  /** v0.16.1 a door counted with the Count tool (not on a wall): counted in the schedule, no lintel */
  counter?: boolean;
  /** v0.16: in a room - it corrects the room's finishes only (no lintel); an opening has a sill */
  room?: boolean;
}) {
  const [q, setQ] = useState(current?.door ? '' : current?.tag ?? '');
  // the row picked with the arrows / the mouse, for the text it was picked in (typing more starts again)
  const [pick, setPick] = useState<{ q: string; i: number } | null>(null);
  const [lint, setLint] = useState(current?.lint ?? true);
  const [nw, setNw] = useState(mmOf(current?.w));
  const [nh, setNh] = useState(mmOf(current?.h));
  const [ns, setNs] = useState(mmOf(current?.sill));
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  // opened by a click on the drawing: the click's own mousedown gives the drawing the keyboard after
  // this has mounted - take it back once that is over
  useEffect(() => { const t = setTimeout(() => first.current?.focus(), 0); return () => clearTimeout(t); }, []);
  const f = q.trim().toLowerCase();
  const fk = doorTagKey(q);
  const tk = (d: DoorRow) => doorTagKey(d.tag);
  const list = model.doors.filter((d) => !f || (fk && tk(d).includes(fk)) || d.tag.toLowerCase().includes(f) || d.desc.toLowerCase().includes(f) || d.loc.toLowerCase().includes(f));
  // exact tag first, then tags starting with it ("D10" finds D-10 too)
  list.sort((a, b) => Number(tk(b) === fk) - Number(tk(a) === fk) || Number(!!fk && tk(b).startsWith(fk)) - Number(!!fk && tk(a).startsWith(fk)));
  const exact = model.doors.find((d) => doorTagKey(d.tag) === doorTagKey(q));
  const isNew = k === 'door' && !!f && !exact;
  const shown = list.slice(0, 60);
  // the row Enter takes. Worked out here, not set by an effect after typing: Enter pressed before that
  // effect ran saw the row of the text before (a tag typed whole and Enter at once did nothing)
  const sel = pick && pick.q === q ? pick.i : isNew ? -1 : 0;
  const setSel = (i: number) => setPick({ q, i });
  const w = sizeIn(nw), h = sizeIn(nh);
  // (v0.16 a room's opening: its sill height - empty or 0 = from the floor, an arch)
  const sill = !room ? 0 : /^\s*0*(\.0*)?\s*(mm|cm|m)?\s*$/i.test(ns) ? 0 : sizeIn(ns);
  const okSize = !!w && !!h && sill !== undefined && sill !== null;
  const pickDoor = (d: DoorRow) => onDoor({ id: d.id }, lint);
  // (a size that is not one - "abc" - is not dropped silently: the Add button is off, and so is Enter)
  const addNew = () => { if (isNew && w !== undefined && h !== undefined) onDoor({ tag: q.trim(), sw: w || null, sh: h || null }, lint); };
  const doOpen = () => { if (okSize) onOpen({ w: w!, h: h!, tag: q.trim(), ...(room ? { sill: sill as number } : {}) }, lint); };
  // the row Enter takes: with a tag that is not in the schedule typed, none (-1: Enter adds the new tag)
  // until an arrow key goes into the rows found - typing part of a tag to find it then picking it with
  // the arrows must work (it used to: arrows did nothing and Enter added "D1" to the schedule)
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (k === 'door' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const lo = isNew ? -1 : 0, by = e.key === 'ArrowDown' ? 1 : -1;
      setPick((p) => ({ q, i: Math.max(lo, Math.min(shown.length - 1, (p && p.q === q ? p.i : lo === -1 ? -1 : 0) + by)) }));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (k === 'open') doOpen();
      else if (sel >= 0 && shown[sel] && !(e.target as HTMLElement).closest('.opick-new')) pickDoor(shown[sel]);
      else if (isNew) addNew();
    }
  };
  useEffect(() => { box.current?.querySelector('.opick-list .mi.on')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  // where it opens: by the click, inside the window whatever its height (a list and a new tag together
  // are ~440 px: a fixed 380 px allowance put the lintel tick and Cancel off a 768 px screen); above the
  // click when it does not fit below
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const bw = el.offsetWidth, bh = el.offsetHeight, W = activeWin().innerWidth, H = activeWin().innerHeight;
    let top = at[1] + 12;
    if (top + bh > H - 8) top = at[1] - 12 - bh >= 8 ? at[1] - 12 - bh : Math.max(8, H - 8 - bh);
    el.style.left = Math.max(8, Math.min(at[0] + 12, W - bw - 8)) + 'px';
    el.style.top = top + 'px';
  });
  return (
    <div className="scrim lite" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="opick" style={{ left: at[0] + 12, top: at[1] + 12 }} onKeyDown={onKey}>
        <div className="mh">{k === 'door' ? (current ? 'Change the door' : 'Door here') : current ? 'Change the opening' : 'Opening here'}</div>
        {k === 'door' ? (
          <>
            <input ref={first} className="input sm" autoFocus placeholder="Door tag (type to find, or a new tag)" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="opick-list">
              {shown.map((d, i) => (
                <button key={d.id} className={'mi' + (i === sel ? ' on' : '')} onMouseMove={() => sel !== i && setSel(i)} onClick={() => pickDoor(d)}>
                  <b>{d.tag}</b>
                  <span className="d">{d.desc}{d.loc ? ' · ' + d.loc : ''}</span>
                  <span className="sz num">{d.sw || d.cw ? `${mmOf(d.sw ?? d.cw)}×${mmOf(d.sh ?? d.ch) || '?'}` : <span className="bad">no size</span>}</span>
                </button>
              ))}
              {model.doors.length === 0 && !f && <div className="hint">No door schedule yet: type the tag of this door to start one.</div>}
            </div>
            {isNew && (
              <div className="opick-new">
                <div><b>Add “{q.trim()}” to the schedule</b> <span className="faint">(sizes can wait)</span></div>
                <div className="opick-sz">
                  <input className="input sm num" placeholder="W mm" value={nw} onChange={(e) => setNw(e.target.value)} />
                  <span>×</span>
                  <input className="input sm num" placeholder="H mm" value={nh} onChange={(e) => setNh(e.target.value)} />
                  <span className="faint">structural opening</span>
                </div>
                <button className="btn sm primary" onClick={addNew} disabled={w === undefined || h === undefined}>Add and place {sel < 0 && <kbd>↵</kbd>}</button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="opick-sz">
              <input ref={first} className="input sm num" autoFocus placeholder="W mm" value={nw} onChange={(e) => setNw(e.target.value)} />
              <span>×</span>
              <input className="input sm num" placeholder="H mm" value={nh} onChange={(e) => setNh(e.target.value)} />
            </div>
            {room && (
              <div className="opick-sz">
                <span>Sill</span>
                <input className="input sm num" data-sill placeholder="0" value={ns} onChange={(e) => setNs(e.target.value)} />
                <span className="faint">0 = from the floor (an arch)</span>
              </div>
            )}
            <input className="input sm" placeholder="Name (optional: W1, louvre…)" value={q} onChange={(e) => setQ(e.target.value)} />
            <p className="hint">{room ? 'Corrects the room’s finishes only — never counted. Sizes in mm (1200) or m (1.2).' : 'Comes off the wall as a minus in its segment list. Sizes in mm (1200) or m (1.2).'}</p>
          </>
        )}
        {counter ? <p className="hint">Not on a wall (core, partition): counted in the door schedule, no lintel. The next clicks count the same door.</p> : room ? (k === 'door' ? <p className="hint">In a room: it corrects the room’s finishes only, never a door count.</p> : null) : <label className="check tp"><input type="checkbox" checked={lint} onChange={(e) => setLint(e.target.checked)} /> Lintel over it</label>}
        <div className="opick-act">
          <button className="btn sm" onClick={onClose}>Cancel <kbd>Esc</kbd></button>
          {k === 'open' && <button className="btn sm primary" disabled={!okSize} onClick={doOpen}>{current ? 'Save' : 'Put it here'} <kbd>↵</kbd></button>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
/**
 * Auto-count by tag on this sheet: the tag is looked for in the sheet's text; what is found is shown on the
 * drawing to keep or leave out, one by one, before anything is counted.
 */
export function AutoCountDialog({ target, isDoor, find, onClose, onShow }: {
  /** the count take-off in use (its name), if any */
  target: string | null;
  /** v0.16.2: door mode is on - a tag of the door schedule is counted as that door, in "Doors (not on walls)" */
  isDoor?: (text: string) => boolean;
  find: (q: string, mode: TagMode) => Promise<Found[]>;
  onClose: () => void;
  onShow: (found: Found[], q: string, perTag: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<TagMode>('exact');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ q: string; found: Found[] } | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [perTag, setPerTag] = useState(true);
  const groups = res ? byTag(res.found) : [];
  const go = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const found = await find(q.trim(), mode);
      setRes({ q: q.trim(), found });
      setOff(new Set());
      // a take-off per tag when the tags are types that repeat (D1 ×12, D2 ×5); not when each tag is one door
      // (a plan's door ids - D-A0101-A, D-A0102-A: 126 take-offs of one each)
      const g = byTag(found);
      setPerTag(g.length > 1 && g.length <= 15 && found.length >= 2 * g.length);
    } finally { setBusy(false); }
  };
  const kept = res ? res.found.filter((f) => !off.has(tagKey(f.text))) : [];
  const keptGroups = groups.filter((g) => !off.has(g.key));
  // door mode: which of the kept tags are doors of the schedule (they go into the door counter)
  const doorGroups = isDoor ? keptGroups.filter((g) => isDoor(g.text)) : [];
  const others = keptGroups.filter((g) => !doorGroups.includes(g));
  const many = others.length > 1;
  return (
    <Modal title="Count by tag on this sheet" onClose={onClose} sub="Finds a tag written on the sheet (door marks, fixture codes, room numbers…). Each one found is shown on the drawing: click any to leave it out, then count the rest. Symbols without text: in the next version.">
      <div className="acrow">
        <input className="input" autoFocus placeholder="Tag, e.g. D01 or SD-1" value={q} onChange={(e) => { setQ(e.target.value); setRes(null); }} onKeyDown={(e) => e.key === 'Enter' && go()} />
        <span className="seg">
          {([['exact', 'Exactly'], ['starts', 'Starting with'], ['contains', 'Containing']] as [TagMode, string][]).map(([k, l]) => (
            <button key={k} className={mode === k ? 'on' : ''} onClick={() => { setMode(k); setRes(null); }} title={k === 'exact' ? 'The whole tag: D01 finds D01 (and D-01, d 01), not D01A' : k === 'starts' ? 'D finds D01, D02, D12A… (a number after it; not DOOR)' : 'Anywhere in a word'}>{l}</button>
          ))}
        </span>
        <button className="btn primary" disabled={!q.trim() || busy} onClick={go}>{busy ? 'Looking…' : 'Find'}</button>
      </div>
      {res && !res.found.length && <div className="warnbox" style={{ marginTop: 10 }}><TIcon k="warn" /><div>“{res.q}” is not written anywhere on this sheet as text. (Some drawings have their text turned into lines when they are exported: then only the symbol finder of the next version can find them.)</div></div>}
      {groups.length > 0 && (
        <div className="acres">
          {groups.map((g) => (
            <label key={g.key} className="check">
              <input type="checkbox" checked={!off.has(g.key)} onChange={() => setOff((s) => { const n = new Set(s); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n; })} />
              <b>{g.text}</b> <span className="faint">× {g.n}</span>
            </label>
          ))}
        </div>
      )}
      {many && (
        <label className="check tp" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={perTag} onChange={(e) => setPerTag(e.target.checked)} />
          A count take-off for each tag (named after it; one already there with that name is used)
        </label>
      )}
      {res && kept.length > 0 && (
        <p className="hint" style={{ marginTop: 8 }}>
          {doorGroups.length > 0 && <>{doorGroups.map((g) => g.text).join(', ')}: counted as {doorGroups.length > 1 ? 'doors' : 'a door'} of the door schedule, into “{DOOR_COUNTER_NAME}”.{others.length > 0 ? ' ' : ''}</>}
          {others.length > 0 && <>{doorGroups.length > 0 ? 'The rest: into ' : 'Into '}{many && perTag ? 'a count take-off per tag' : target ? <>“{target}”</> : <>a new count take-off “{others[0]?.text}”</>}.</>}
        </p>
      )}
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!kept.length} onClick={() => onShow(kept, res!.q, many && perTag)}>Show the {kept.length || ''} on the drawing</button>
      </div>
    </Modal>
  );
}
