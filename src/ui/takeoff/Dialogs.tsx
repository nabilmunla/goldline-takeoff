// Dialogs of the take-off workspace.
import { watchDraft } from '../closeGuards';
import { useMemo, useState, type ReactNode, useEffect, useRef } from 'react';
import type { Op } from '../../engine/types';
import { dist, ratioOf, scaleFromRatio, STANDARD_SCALES, type Pt } from '../../engine/qto/geometry';
import { alreadyLinked, MEASURE_LABEL, MEASURE_UNIT, measuresFor, measureOf, mainMeasure, flattenMirror, mirrorPath, pageKey, emptyQty, type QtoModel, type Shape, type TItem, type Measure, headingPath } from '../../engine/qto/model';
import { linkOps, dummyOps } from '../../engine/qto/ops';
import { measureForUnit, unitMismatch } from '../../engine/qto/units';
import { fmtQty, parseNum } from '../format';
import { q as fq } from './numfmt';
import { TIcon } from './ticons';
import { sheetLabel } from './Panels';
import { AddDialog } from './BoqTab';
import { revealInBoq } from './boqnav';
import { additionalItemOps, billLabel, hasBoq, linkTarget } from '../../engine/qto/additional';


export function Modal({ title, sub, children, onClose, wide, cls }: { title: string; sub?: ReactNode; children: ReactNode; onClose: () => void; wide?: boolean; cls?: string }) {
  // Esc closes a dialog only when the keyboard is in it: one opened from a button with nothing in it that
  // takes the keyboard (the door schedule, beam types, Duplicate on a take-off with no BOQ link - its first
  // tick is disabled) left the keyboard on the button behind it, and Esc did nothing
  const box = useRef<HTMLDivElement>(null);
  // (the document it is in: the drawing's own window too - v0.16.3; there the main document's focus is elsewhere)
  useEffect(() => { if (box.current && !box.current.contains(box.current.ownerDocument.activeElement)) box.current.focus(); }, []);
  // (and when the keyboard was left nowhere - a dialog opened over this one and closed again: Esc still closes the
  // one on top - 0.23.2, DeepSeek #47)
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const doc = box.current?.ownerDocument;
    const win = doc?.defaultView;
    if (!doc || !win) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const a = doc.activeElement;
      if (a && a !== doc.body) return;
      const scrims = doc.querySelectorAll('.scrim');
      if (scrims[scrims.length - 1] !== box.current?.parentElement) return;
      e.preventDefault();
      closeRef.current();
    };
    win.addEventListener('keydown', h);
    return () => win.removeEventListener('keydown', h);
  }, []);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div ref={box} tabIndex={-1} className={'modal' + (wide ? ' wide' : '') + (cls ? ' ' + cls : '')}>
        <h2>{title}</h2>
        {sub && <p className="sub">{sub}</p>}
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
/** a scale for both directions, or only across (X) / up and down (Y): drawings with heights drawn at
 *  another scale (long sections), or a sheet printed stretched (v0.12.5, as in the PDF Editor) */
export type ScaleDir = 'both' | 'x' | 'y';
function DirChoice({ dir, setDir, hint }: { dir: ScaleDir; setDir: (d: ScaleDir) => void; hint: string }) {
  return (
    <div className="row">
      <label>Direction</label>
      <div className="seg">
        <button className={dir === 'both' ? 'on' : ''} onClick={() => setDir('both')}>Both ways</button>
        <button className={dir === 'x' ? 'on' : ''} title="Across the sheet only" onClick={() => setDir('x')}>Across (X)</button>
        <button className={dir === 'y' ? 'on' : ''} title="Up and down the sheet only" onClick={() => setDir('y')}>Up-down (Y)</button>
      </div>
      {dir !== 'both' && <p className="faint" style={{ margin: '6px 0 0' }}>{hint}</p>}
    </div>
  );
}

export function ScaleDialog({ a, b, detected, groupName, cur, next, nextScope, onClose, onSave }: {
  a: Pt;
  b: Pt;
  detected: number[];
  groupName: string;
  /** this sheet's scale now (null = none yet): across, and up-down when it has its own */
  cur: { sc: number; scy: number | null } | null;
  /** the up-down step right after across was set */
  next?: ScaleDir | null;
  /** ...and the sheets the across step went on (the up-down step goes on the same ones) */
  nextScope?: 'page' | 'group' | 'all';
  onClose: () => void;
  /** more: the dialog stays open for the next direction */
  onSave: (sc: number, label: string, scope: 'page' | 'group' | 'all', dir: ScaleDir, more: boolean) => void;
}) {
  const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
  const [dir, setDir] = useState<ScaleDir>(() => next ?? (cur?.scy ? (dx >= dy ? 'x' : 'y') : 'both'));
  // a line drawn mostly across measures across (X), mostly up-down Y: only that extent counts
  const d = dir === 'x' ? dx : dir === 'y' ? dy : dist(a, b);
  const tooSlanted = dir !== 'both' && d < 0.5 * dist(a, b);
  const [len, setLen] = useState('');
  const [unit, setUnit] = useState<'m' | 'mm'>('mm');
  const [scope, setScope] = useState<'page' | 'group' | 'all'>(nextScope ?? 'page');
  const n0 = parseNum(len);
  const n = typeof n0 === "number" && n0 > 0 ? n0 : null; // a length is never 0 or below
  const metres = n ? (unit === 'mm' ? n / 1000 : n) : null;
  const sc = metres && d > 0 && !tooSlanted ? metres / d : null;
  const ratio = sc ? sc / scaleFromRatio(1) : null;
  const near = ratio ? STANDARD_SCALES.reduce((best, s) => (Math.abs(s - ratio) < Math.abs(best - ratio) ? s : best), STANDARD_SCALES[0]) : null;
  const close = ratio && near ? Math.abs(near - ratio) / near < 0.015 : false;
  const [round, setRound] = useState(true);
  const final = sc && close && round && near ? scaleFromRatio(near) : sc;
  const label = final ? (ratioOf(final) ? '1:' + ratioOf(final) : `calibrated (≈1:${Math.round(ratio!)})`) : '';
  const save = () => final && onSave(final, label, scope, dir, false);
  // a scale picked from the list: across first, then the dialog stays for up-down
  /** across was set from the list (the dialog stayed for up-down): closing it keeps that - "Done" */
  const [xSet, setXSet] = useState(false);
  const pick = (r: number) => { onSave(scaleFromRatio(r), '1:' + r, scope, dir, dir === 'x'); if (dir === 'x') { setDir('y'); setXSet(true); } };
  const along = dir === 'x' ? ' across' : dir === 'y' ? ' up-down' : '';
  const hint = tooSlanted
    ? `Pick the ${dir === 'x' ? 'across' : 'up-down'} scale from the list above. A typed length needs a ${dir === 'x' ? 'horizontal' : 'vertical'} dimension: this line runs mostly ${dir === 'x' ? 'up and down' : 'across'}.`
    : dir === 'x' ? 'Only the scale across the sheet is set; up-down stays as it is (set it next).'
      : cur ? 'Only the scale up and down the sheet is set; across stays as it is.' : 'No scale yet: this one is used both ways until across (X) is set.';
  return (
    <Modal title="Set the scale" onClose={onClose} sub={<>You clicked two points {fmtQty(Math.round(dist(a, b) * 10) / 10)} pt apart on the sheet{dir !== 'both' && !tooSlanted ? <> ({fmtQty(Math.round(d * 10) / 10)} pt{along})</> : null}. How long is that in reality? Use a long dimension for accuracy.</>}>
      <div className="row">
        <label>Real length</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" autoFocus value={len} placeholder={unit === 'mm' ? 'e.g. 7200' : 'e.g. 7.2'} onChange={(e) => setLen(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
          <div className="seg">
            <button className={unit === 'mm' ? 'on' : ''} onClick={() => setUnit('mm')}>mm</button>
            <button className={unit === 'm' ? 'on' : ''} onClick={() => setUnit('m')}>m</button>
          </div>
        </div>
        {/* (a comma can be a decimal or a thousands one: what was understood is said) */}
        {/,/.test(len) && n !== null && <div className="faint" style={{ marginTop: 4 }}>Read as {n.toLocaleString('en-GB', { maximumFractionDigits: 6 })} {unit}.</div>}
      </div>
      {ratio && (
        <div className="scaleres">
          That is about <b>1:{ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}</b>{along} at true paper size.
          {close && near && (
            <label className="check tp" style={{ marginTop: 6 }}>
              <input type="checkbox" checked={round} onChange={(e) => setRound(e.target.checked)} /> Use exactly 1:{near} (the click was {Math.abs((ratio - near) / near * 100).toFixed(1)}% off)
            </label>
          )}
          {!close && <div className="faint" style={{ marginTop: 4 }}>Not a standard scale — fine if the PDF was printed to fit; the measured scale is used as it is.</div>}
        </div>
      )}
      <div className="row">
        <label>Or the drawing's scale (when the PDF is at its true paper size)</label>
        <div className="scalepick">
          {[...new Set([...detected, 50, 100, 200, 500])].slice(0, 8).map((s) => (
            <button key={s} className={'chip' + (detected.includes(s) ? ' on' : '')} onClick={() => pick(s)} title={detected.includes(s) ? 'Written on this sheet' : ''}>1:{s}</button>
          ))}
          <select className="input sm" value="" onChange={(e) => e.target.value && pick(Number(e.target.value))}>
            <option value="">Other…</option>
            {STANDARD_SCALES.map((s) => <option key={s} value={s}>1:{s}</option>)}
          </select>
        </div>
      </div>
      <DirChoice dir={dir} setDir={setDir} hint={hint} />
      <div className="row">
        <label>Apply to</label>
        <div className="choice">
          <label className={'choice-opt' + (scope === 'page' ? ' on' : '')}><input type="radio" checked={scope === 'page'} onChange={() => setScope('page')} /><span><b>This sheet</b></span></label>
          {groupName && <label className={'choice-opt' + (scope === 'group' ? ' on' : '')}><input type="radio" checked={scope === 'group'} onChange={() => setScope('group')} /><span><b>Every sheet in “{groupName}”</b><span className="d">that has no scale yet</span></span></label>}
          <label className={'choice-opt' + (scope === 'all' ? ' on' : '')}><input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /><span><b>Every sheet in the project</b><span className="d">that has no scale yet</span></span></label>
        </div>
      </div>
      <div className="actions">
        <button className="btn ghost" onClick={onClose} title={xSet || next === 'y' ? 'Across (X) stays as set; up-down stays as it was' : undefined}>{xSet || (dir === 'y' && next === 'y') ? 'Done' : 'Cancel'}</button>
        <button className="btn primary" disabled={!final} onClick={save}>Set {dir === 'x' ? 'across ' : dir === 'y' ? 'up-down ' : ''}scale{label ? ' ' + label : ''}</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
export function RegionDialog({ detected, onClose, onSave }: { detected: number[]; onClose: () => void; onSave: (sc: number, label: string, y: { sc: number; label: string } | null) => void }) {
  const [custom, setCustom] = useState('');
  /** a different vertical scale in this box (a section with exaggerated heights): 0 = the same */
  const [yr, setYr] = useState(0);
  const n0 = parseNum(custom);
  const n = typeof n0 === "number" && n0 > 0 ? n0 : null; // 1:0 or 1:-50 is no scale
  const save = (r: number) => onSave(scaleFromRatio(r), '1:' + r, yr && yr !== r ? { sc: scaleFromRatio(yr), label: '1:' + yr } : null);
  return (
    <Modal title="Viewport scale" onClose={onClose} sub="Shapes that start inside the box you drew use this scale instead of the sheet's (details, enlarged plans on the same sheet).">
      <div className="row">
        <label>Up-down (Y) scale</label>
        <select className="input sm" style={{ maxWidth: 240 }} value={yr} onChange={(e) => setYr(Number(e.target.value))} title="Only for a box drawn with a different vertical scale (e.g. a long section)">
          <option value={0}>Same as across</option>
          {STANDARD_SCALES.map((s) => <option key={s} value={s}>1:{s}</option>)}
        </select>
      </div>
      <div className="row">
        <label>{yr ? 'Across (X) scale' : 'Scale'}</label>
        <div className="scalepick">
          {[...new Set([...detected, 5, 10, 20, 25, 50, 100])].slice(0, 10).map((s) => (
            <button key={s} className={'chip' + (detected.includes(s) ? ' on' : '')} onClick={() => save(s)}>1:{s}</button>
          ))}
        </div>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <label>Other: 1 :</label>
        <input className="input" value={custom} placeholder="e.g. 75" onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && n && save(n)} />
      </div>
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!n} onClick={() => n && save(n)}>Use 1:{n || '…'}{yr && n && yr !== n ? ` · Y 1:${yr}` : ''}</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
export function CopyDialog({ model, from, count, onClose, onCopy }: { model: QtoModel; from: { dwg: string; pg: number }; count: number; onClose: () => void; onCopy: (t: { dwg: string; pg: number }[]) => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const fromD = model.dwgById.get(from.dwg);
  const sheets = model.drawings.flatMap((d) => Array.from({ length: Math.max(1, d.pages || 1) }, (_, pg) => ({ d, pg }))).filter(({ d, pg }) => !(d.id === from.dwg && pg === from.pg));
  const f = q.trim().toLowerCase();
  const shown = sheets.filter(({ d }) => !f || d.title.toLowerCase().includes(f) || d.name.toLowerCase().includes(f) || d.grp.toLowerCase().includes(f));
  const k = (d: string, pg: number) => pageKey(d, pg);
  const same = sheets.filter(({ d }) => d.grp === fromD?.grp);
  return (
    <Modal title="Copy to other sheets" onClose={onClose} wide sub={<>{count} shape{count > 1 ? 's' : ''} will be copied to the same position on each sheet you tick — the quick way through typical floors. Check every sheet afterwards for walls that moved.</>}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <input className="input" placeholder="Filter sheets, e.g. Tower A" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={() => setSel(new Set(shown.map(({ d, pg }) => k(d.id, pg))))}>Tick shown</button>
        {same.length > 0 && <button className="btn" onClick={() => setSel(new Set(same.map(({ d, pg }) => k(d.id, pg))))}>Same folder</button>}
        <button className="btn ghost" onClick={() => setSel(new Set())}>None</button>
      </div>
      <div className="picklist" style={{ maxHeight: 360 }}>
        {shown.map(({ d, pg }) => (
          <label key={k(d.id, pg)} className="pick check" style={{ display: 'flex' }}>
            <input type="checkbox" checked={sel.has(k(d.id, pg))} onChange={(e) => setSel((s) => { const n = new Set(s); e.target.checked ? n.add(k(d.id, pg)) : n.delete(k(d.id, pg)); return n; })} />
            <span style={{ flex: 1 }}>{sheetLabel(model, d.id, pg)}</span>
            <span className="faint">{d.grp}</span>
          </label>
        ))}
      </div>
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!sel.size} onClick={() => onCopy([...sel].map((x) => ({ dwg: x.slice(0, x.lastIndexOf('.')), pg: Number(x.slice(x.lastIndexOf('.') + 1)) })))}>Copy to {sel.size} sheet{sel.size === 1 ? '' : 's'}</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
export function RepeatDialog({ count, current, onClose, onSave }: { count: number; current: number; onClose: () => void; onSave: (m: number) => void }) {
  const [v, setV] = useState(String(current));
  const n = parseNum(v);
  return (
    <Modal title="Repeat" onClose={onClose} sub={<>Counts {count > 1 ? 'these shapes' : 'this shape'} several times without drawing it again: typical floors (×12), both faces of a wall (×2), identical units.</>}>
      <div className="row">
        <label>Times</label>
        <input className="input" autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && n && n > 0 && onSave(n)} />
      </div>
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!n || n <= 0} onClick={() => n && n > 0 && onSave(n)}>Set ×{n && n > 0 ? n : '…'}</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
export function MoveToItemDialog({ model, shapes, onClose, onPick, onNew }: { model: QtoModel; shapes: Shape[]; onClose: () => void; onPick: (ti: string) => void; onNew?: (name: string) => void }) {
  const [nn, setNn] = useState('');
  // what the shapes are (an outline, a line, points): a line can go to a length, a wall or a beam
  const kinds = new Set(shapes.map((s) => s.k));
  const shapeOf = (it: TItem) => (it.kind === 'area' ? 'poly' : it.kind === 'count' ? 'pt' : 'line');
  const fits = model.items.filter((it) => kinds.size === 1 && kinds.has(shapeOf(it)) && !shapes.every((s) => s.ti === it.id));
  return (
    <Modal title="Move to another take-off" onClose={onClose} sub="The shapes stay where they are on the sheet; only the take-off they count in changes.">
      <div className="picklist">
        {fits.map((it) => (
          <button key={it.id} className="pick" onClick={() => onPick(it.id)}><i className="sw" style={{ background: it.color }} /> {it.name} <span className="faint">{headingPath(model, it.par)}</span></button>
        ))}
        {fits.length === 0 && <div className="hint" style={{ padding: 12 }}>No other take-off of the same type.</div>}
      </div>
      {onNew && kinds.size === 1 && !kinds.has('pt') && (
        <div className="row" style={{ marginTop: 12 }}>
          <label>Or a new take-off for {shapes.length > 1 ? 'them' : 'it'} (same heading)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input" value={nn} placeholder="e.g. Blockwork 100 mm" onChange={(e) => setNn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && nn.trim() && onNew(nn.trim())} />
            <button className="btn primary" disabled={!nn.trim()} onClick={() => onNew(nn.trim())}>Create and move</button>
          </div>
        </div>
      )}
      <div className="actions"><button className="btn" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
export function NoteDialog({ model, on, pinned, onClose, onSave }: { model: QtoModel; on: string; pinned: boolean; onClose: () => void; onSave: (text: string, to: 'est' | 'me', on: string) => void }) {
  const [text, setText] = useState('');
  const [to, setTo] = useState<'est' | 'me'>('est');
  const [target, setTarget] = useState(on);
  // closing the app with a note half written asks first (App.tsx)
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => watchDraft(() => (textRef.current.trim() ? 'a note' : '')), []);
  const it = target ? model.itemById.get(target) : null;
  return (
    <Modal title={pinned ? 'Note on the drawing' : 'New note'} onClose={onClose}>
      <div className="row">
        <textarea className="input" style={{ height: 110, padding: 10 }} autoFocus value={text} placeholder="e.g. Ceiling heights not shown on L03 — assumed 2.8 m as L02. Please confirm." onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="row">
        <label>For</label>
        <div className="seg">
          <button className={to === 'est' ? 'on' : ''} onClick={() => setTo('est')}>The administrator (everyone)</button>
          <button className={to === 'me' ? 'on' : ''} onClick={() => setTo('me')}>Just me</button>
        </div>
      </div>
      <div className="row">
        <label>About</label>
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">{pinned ? 'This spot on the sheet' : 'The project in general'}</option>
          {model.items.map((x) => <option key={x.id} value={x.id}>Take-off: {x.name}</option>)}
        </select>
        {it && <span className="hint">Shown with the take-off “{it.name}”.</span>}
      </div>
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!text.trim()} onClick={() => onSave(text, to, target)}>Save note</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
export function LinkDialog({ model, item, readOnly, onClose, onCommit, toast, by, projectId, measure }: {
  /** v0.17.1 the quantity asked for (a summary's link button: its column - concrete, formwork, steel...) */
  measure?: Measure;
  model: QtoModel;
  item: TItem;
  readOnly: boolean;
  onClose: () => void;
  onCommit: (ops: Op[], label: string) => void;
  toast: (t: ReactNode, opts?: { action?: { label: string; fn: () => void } }) => void;
  /** v0.16: who is linking (an additional item made here records who added it) */
  by?: { username: string; name: string };
  /** v0.16: the take-off project (the message after linking offers "Show in BOQ") */
  projectId?: string;
}) {
  const showIn = (to: string) => (projectId ? { action: { label: 'Show in BOQ', fn: () => revealInBoq(projectId, to) } } : undefined);
  const [addNew, setAddNew] = useState(false);
  const boqHere = hasBoq(model);
  const [q, setQ] = useState('');
  const [ms, setMs] = useState<Measure | null>(measure ?? null);
  const [factor, setFactor] = useState('1');
  const [newLine, setNewLine] = useState(false);
  const [nd, setNd] = useState({ ref: '', desc: item.name, unit: unitFor(mainMeasure(item)) });
  // a door of the door schedule: its number (doors placed on walls)
  const isDoor = item.id.startsWith('ds:');
  const qty = model.qty.get(item.id) ?? { ...emptyQty(), cnt: isDoor ? model.doorCount.get(item.id) ?? 0 : 0 };
  const measures: Measure[] = isDoor ? ['cnt'] : measuresFor(item);
  const rows = useMemo(() => (model.boqById.size ? flattenMirror(model, q).filter((r) => r.bt === 'item' || q === '').slice(0, 400) : []), [model, q]);
  const dms = model.dummies.filter((d) => !q.trim() || d.desc.toLowerCase().includes(q.trim().toLowerCase()));
  // (v0.16: additional items listed on their own once the BOQ is here; matched temporary lines are their BOQ line)
  const adds = boqHere ? dms.filter((d) => d.add && !d.map) : [];
  const temps = boqHere ? dms.filter((d) => !d.add && !d.map) : dms;
  const f = parseNum(factor) ?? 1;
  const linked = new Set((model.linksByItem.get(item.id) ?? []).map((l) => l.to));
  const link = (to0: string, unit: string, label: string) => {
    // a factor of 0 or less is refused (it turned the BOQ line's quantity negative, or 0 became 1 without a word -
    // 0.23.2, DeepSeek #11; openings and deductions are given on the take-off itself)
    if (!(f > 0)) { toast(<span>The factor must be more than 0 — it is “×{factor}”.</span>); return; }
    // a line of the BOQ copy that is this take-off's own additional item: linked to the item itself
    const to = linkTarget(model, to0);
    if (alreadyLinked(model, item.id, to)) { toast(<span>“{item.name}” is already linked to {label} — it would count twice.</span>); return; }
    let m = ms ?? measureForUnit(unit) ?? mainMeasure(item);
    // the line's unit asks for something this take-off can't give yet (a volume from an area without
    // a thickness): linked as the line asks - it gets 0 until the size is given, and says so
    // (linking the area into an m³ line instead would stay wrong after the thickness is added)
    if (!measures.includes(m)) {
      onCommit(linkOps(item.id, to, m, f).ops, 'Linked to BOQ');
      toast(<span>Linked to {label} as {MEASURE_LABEL[m].toLowerCase()} — <b>0 until “{item.name}” has a {m === 'vol' ? 'thickness' : m === 'area' ? 'height' : 'size'}</b> (set it in its details).</span>, showIn(to));
      onClose();
      return;
    }
    onCommit(linkOps(item.id, to, m, f).ops, 'Linked to BOQ');
    toast(<span>Linked to {label}: {MEASURE_LABEL[m].toLowerCase()} {fq(measureOf(qty, m) * (f), m)} {MEASURE_UNIT[m]}{unitMismatch(unit, m) ? ` — careful, the line is in ${unit}` : ''}.</span>, showIn(to));
    onClose();
  };
  return (
    <Modal wide title={`Link “${item.name}” to the BOQ`} onClose={onClose} sub="Pick the line its quantity belongs to. The quantity type follows the line's unit (m² → area, m → length, nr → count) unless you choose one.">
      <div className="linkopts">
        <div className="seg">
          <button className={ms === null ? 'on' : ''} onClick={() => setMs(null)}>From unit</button>
          {measures.map((m) => (
            <button key={m} className={ms === m ? 'on' : ''} onClick={() => setMs(m)} title={`${fq(measureOf(qty, m), m)} ${MEASURE_UNIT[m]}`}>{MEASURE_LABEL[m]}</button>
          ))}
        </div>
        <label className="fx">× <input className={'input xs num' + (f > 0 ? '' : ' bad')} value={factor} onChange={(e) => setFactor(e.target.value)} title="e.g. 2 when the line covers both faces (more than 0)" /></label>
        <input className="input" autoFocus placeholder={model.boqById.size ? 'Search the BOQ (description or ref)' : 'Search temporary lines'} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="picklist" style={{ maxHeight: 380 }}>
        {rows.map((r) =>
          r.bt === 'item' ? (
            <button key={r.id} className={'pick psp' + (linked.has('b:' + r.id) ? ' on' : '')} disabled={readOnly} onClick={() => link('b:' + r.id, r.unit, r.ref || 'the line')} title={mirrorPath(model, r.id)}>
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
          <button key={d.id} className={'pick psp' + (linked.has(d.id) ? ' on' : '')} disabled={readOnly} onClick={() => link(d.id, d.unit, '“' + d.desc + '”')} title={[billLabel(model, d.bill), d.loc].filter(Boolean).join(' · ')}>
            <span className="pa"><span className="qam add">A+</span></span>
            <span className="pd">{d.desc}{d.loc ? <span className="faint"> · {d.loc}</span> : null}</span>
            <span className="pa">{d.unit}</span>
          </button>
        ))}
        {temps.length > 0 && <div className="pickhead d0">Temporary lines{boqHere ? ' (not resolved)' : ''}</div>}
        {temps.map((d) => (
          <button key={d.id} className={'pick psp' + (linked.has(d.id) ? ' on' : '')} disabled={readOnly} onClick={() => link(d.id, d.unit, '“' + d.desc + '”')}>
            <span className="pa">{d.ref}</span>
            <span className="pd">{d.desc}</span>
            <span className="pa">{d.unit}</span>
          </button>
        ))}
        {!rows.length && !adds.length && !temps.length && <div className="hint" style={{ padding: 12 }}>{model.boqById.size ? 'No line matches.' : 'No BOQ yet — make a temporary line below.'}</div>}
      </div>
      {!readOnly && boqHere ? (
        <button className="btn sm ghost lk-addnew" style={{ marginTop: 10 }} onClick={() => setAddNew(true)}><TIcon k="plus" /> Not in the BOQ? Add an additional item…</button>
      ) : !readOnly && (newLine ? (
        <div className="dmadd" style={{ marginTop: 10 }}>
          <input className="input sm ref" placeholder="Ref" value={nd.ref} onChange={(e) => setNd({ ...nd, ref: e.target.value })} />
          <input className="input sm" placeholder="Description" value={nd.desc} onChange={(e) => setNd({ ...nd, desc: e.target.value })} />
          <select className="input sm unit" value={nd.unit} onChange={(e) => setNd({ ...nd, unit: e.target.value })}>{['m2', 'm', 'm3', 'nr', 'kg', 'item'].map((u) => <option key={u}>{u}</option>)}</select>
          <button className="btn sm primary" disabled={!nd.desc.trim() || !(f > 0)} title={f > 0 ? '' : 'The factor must be more than 0'} onClick={() => {
            const d = dummyOps(model, nd);
            const m = ms ?? measureForUnit(nd.unit) ?? mainMeasure(item);
            onCommit([...d.ops, ...linkOps(item.id, d.id, m, f).ops], 'Temporary line + link');
            toast(<span>Temporary line made and linked. Match it to the real BOQ line once the BOQ is attached.</span>);
            onClose();
          }}>Make and link</button>
        </div>
      ) : (
        <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={() => setNewLine(true)}><TIcon k="plus" /> Not in the list? Make a temporary line…</button>
      ))}
      <div className="actions"><button className="btn" onClick={onClose}>Close</button></div>
      {addNew && (
        <AddDialog model={model} mode="link" onClose={() => setAddNew(false)} onSave={(fd) => {
          if (!(f > 0)) { toast(<span>The factor must be more than 0 — it is “×{factor}”.</span>); return; }
          const d = additionalItemOps(model, fd, by ?? { username: '', name: '' });
          const m = ms ?? measureForUnit(fd.unit) ?? mainMeasure(item);
          onCommit([...d.ops, ...linkOps(item.id, d.id, m, f).ops], 'Additional item + link');
          toast(<span>Added the additional item “{fd.desc.trim()}” and linked <b>{item.name}</b> to it. It reaches the BOQ flagged Additional – QS.</span>, showIn(d.id));
          setAddNew(false);
          onClose();
        }} />
      )}
    </Modal>
  );
}

const unitFor = (m: Measure) => (m === 'area' ? 'm2' : m === 'vol' ? 'm3' : m === 'cnt' ? 'nr' : 'm');

// HUB: the dialog that attaches the BOQ source to a take-off goes here (it replaces the old "Link to an estimate" picker).
