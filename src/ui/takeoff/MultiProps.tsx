// v0.16 (group b2, item 22): the properties of several selected take-offs at once. Only the fields they all
// have are shown; a field where they differ shows "Multiple values"; a change goes to all of them in one
// step (one Ctrl+Z); a field left alone keeps each one's own value. One shared field = one line in FIELDS.
import { useRef, useState, type ReactNode } from 'react';
import type { Op, Value } from '../../engine/types';
import { KIND_LABEL, alreadyLinked, mainMeasure, type Kind, type Measure, type QtoModel, type TItem } from '../../engine/qto/model';
import { linkOps } from '../../engine/qto/ops';
import { measureForUnit } from '../../engine/qto/units';
import { LinkDialog } from './Dialogs';
import { moveNodesOps } from '../../engine/qto/headings';
import { sharedValue } from '../../engine/qto/listops';
import { parseNum } from '../format';
import { LINE_WIDTHS } from './numfmt';
import { mmOf } from './Dialogs15';
import { ColorButton } from './ColorPicker';
import { TIcon } from './ticons';
import { CodeBox } from './CodeBox';
import { setFinishCodeOps } from '../../engine/qto/roomops';

const MIXED = 'Multiple values';
type When = (it: TItem) => boolean;
const any: When = () => true;
const kinds = (...k: Kind[]): When => (it) => k.includes(it.kind);

/** a field of a take-off, as several selected show it */
type Field =
  | { t: 'num'; f: string; label: string; when: When; suffix?: string; title?: string; placeholder?: string; allowZero?: boolean;
      /** how it is shown / written when that is not the field as stored (Times: empty = 1) */
      read?: (it: TItem) => number | null; write?: (v: number | null) => Value }
  | { t: 'text'; f: string; label: string; when: When; title?: string; placeholder?: string }
  | { t: 'seg'; f: string; label: string; when: When; opts: { v: string | number | null; label: string }[] }
  | { t: 'beamtype'; f: 'bt'; label: string; when: When }
  /** v0.16 (g2): a finish code (the project's code list suggested as you type) */
  | { t: 'code'; f: 'fcode'; label: string; when: When };

const val = (it: TItem, f: string) => (it as unknown as Record<string, unknown>)[f];

/** every field several selected take-offs can share - shown when every one of them has it */
const FIELDS: Field[] = [
  { t: 'num', f: 'h', label: 'Height', suffix: 'm', when: kinds('line', 'wall'), title: 'Length × height = area' },
  { t: 'num', f: 'd', label: 'Thickness', suffix: 'm', when: (it) => it.kind === 'area' || (it.kind === 'line' && !!it.h), title: 'Area × thickness = volume' },
  { t: 'num', f: 'd', label: 'Width', suffix: 'm', when: kinds('wall'), title: "The wall's thickness: area × width = volume; also the lintels' breadth" },
  { t: 'num', f: 'ow', label: 'Opening W', suffix: 'm', when: kinds('count') },
  { t: 'num', f: 'oh', label: 'Opening H', suffix: 'm', when: kinds('count') },
  { t: 'num', f: 'x', label: 'Times', suffix: '×', when: (it) => !it.dc, placeholder: '1', read: (it) => (it.x === 1 ? null : it.x), write: (v) => (v === null || v === 1 ? null : v), title: 'e.g. 2 for both faces of a wall' },
  { t: 'num', f: 'waste', label: 'Waste', suffix: '%', when: (it) => it.kind !== 'room', placeholder: '0', read: (it) => it.waste || null, write: (v) => v || null },
  { t: 'num', f: 'dmin', label: 'Leave in openings up to', suffix: 'm²', when: kinds('area', 'line', 'wall'), placeholder: 'deduct all', title: 'Openings up to this size each are not deducted (empty = every opening is deducted)' },
  { t: 'num', f: 'lb', label: 'Lintel bearing', suffix: 'm', when: kinds('wall'), placeholder: '0.20', allowZero: true },
  { t: 'num', f: 'ld', label: 'Lintel depth', suffix: 'm', when: kinds('wall'), placeholder: '0.20' },
  { t: 'beamtype', f: 'bt', label: 'Type of segments without one', when: kinds('beam') },
  { t: 'num', f: 'st', label: 'Slab', suffix: 'm', when: kinds('beam'), placeholder: '0', allowZero: true, write: (v) => v || null },
  { t: 'code', f: 'fcode', label: 'Finish code', when: (it) => it.kind !== 'room' },
  { t: 'seg', f: 'sw', label: 'Lines', when: any, opts: [{ v: null, label: 'As set' }, ...LINE_WIDTHS.map((w) => ({ v: w.k, label: w.label }))] },
  { t: 'seg', f: 'fill', label: 'Fill', when: kinds('area'), opts: [{ v: null, label: 'As set' }, { v: 'hatch', label: 'Hatched' }, { v: 'none', label: 'Outline only' }] },
  { t: 'seg', f: 'lab', label: 'Numbers', when: any, opts: [{ v: null, label: 'As set' }, { v: 'always', label: 'Always' }, { v: 'hover', label: 'On hover' }, { v: 'never', label: 'Selected only' }] },
];

export function MultiProps({ model, items, readOnly: ro, onCommit, onLink, onDelete, onClose, onBeamTypes, picked }: {
  model: QtoModel;
  items: TItem[];
  readOnly: boolean;
  onCommit: (ops: Op[], label: string) => void;
  onLink: () => void;
  onDelete: () => void;
  onClose: () => void;
  onBeamTypes: () => void;
  picked: Set<string>;
}) {
  const n = items.length;
  const label = (what: string) => `${what} (${n} take-offs)`;
  const setAll = (f: string, v: Value, what: string) => onCommit(items.map((it) => [it.id, f, v] as Op), label(what));
  const byKind = new Map<Kind, number>();
  for (const it of items) byKind.set(it.kind, (byKind.get(it.kind) ?? 0) + 1);
  const color = sharedValue(items, (it) => it.color);
  const par = sharedValue(items, (it) => it.par);
  const shapes = items.reduce((a, it) => a + (model.qty.get(it.id)?.shapes ?? 0), 0);
  const heads = [...picked].filter((id) => model.headingById.has(id)).map((id) => model.headingById.get(id)!.name);
  const fields = FIELDS.filter((f) => items.every(f.when));
  const nums = fields.filter((f) => f.t === 'num' || f.t === 'text');
  const rest = fields.filter((f) => f.t !== 'num' && f.t !== 'text');
  return (
    <div className="qto-detail multi" data-multiprops>
      <div className="qd-head">
        <ColorButton value={String(color.v ?? '')} mixed={color.mixed} disabled={ro} onPick={(c) => setAll('color', c, 'Colour')} />
        <div className="qd-name multi-name">
          <b>{n} take-offs selected</b>
          <span className="faint">{heads.length ? `under ${heads.join(', ')} · ` : ''}{[...byKind].map(([k, c]) => `${c} ${KIND_LABEL[k].toLowerCase()}${c > 1 ? 's' : ''}`).join(', ')} · {shapes} shape{shapes === 1 ? '' : 's'}</span>
        </div>
        <button className="btn icon ghost sm" title="Close" onClick={onClose}><TIcon k="x" /></button>
      </div>
      <div className="qd-body">
        <p className="hint">Only what they all have is shown. A change goes to all {n}; anything you leave keeps each one's own value.</p>
        <fieldset className="qd-fields" disabled={ro}>
          <div className="field l">
            <label>Under heading</label>
            <select className={'input' + (par.mixed ? ' mixed' : '')} value={par.mixed ? '__mixed' : String(par.v ?? '')} onChange={(e) => e.target.value !== '__mixed' && onCommit(moveNodesOps(model.itemTree, items.map((it) => it.id), { par: e.target.value, before: null }), label('Moved to heading'))}>
              {par.mixed && <option value="__mixed" disabled>{MIXED}</option>}
              <option value="">— top level —</option>
              {model.headings.map((h) => <option key={h.id} value={h.id}>{' '.repeat(h.depth) + h.name}</option>)}
            </select>
          </div>
          {nums.length > 0 && (
            <div className="fields">
              {nums.map((f) => <SharedField key={f.f + f.label} f={f} items={items} setAll={setAll} />)}
            </div>
          )}
          {rest.map((f) => (f.t === 'beamtype' ? (
            <div key={f.f} className="field l">
              <label>{f.label}</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {(() => {
                  const s = sharedValue(items, (it) => it.bt);
                  return (
                    <select className={'input' + (s.mixed ? ' mixed' : '')} value={s.mixed ? '__mixed' : String(s.v ?? '')} onChange={(e) => e.target.value !== '__mixed' && setAll('bt', e.target.value || null, 'Beam type')}>
                      {s.mixed && <option value="__mixed" disabled>{MIXED}</option>}
                      <option value="">— none —</option>
                      {model.beamTypes.map((t) => <option key={t.id} value={t.id}>{t.name} ({mmOf(t.w)}×{mmOf(t.d)})</option>)}
                    </select>
                  );
                })()}
                <button type="button" className="btn sm" onClick={onBeamTypes}>Types…</button>
              </div>
            </div>
          ) : f.t === 'seg' ? <SharedSeg key={f.f} f={f} items={items} setAll={setAll} />
            : f.t === 'code' ? (
              <div key={f.f} className="field l fincode" data-field={f.label}>
                <label>{f.label} <span className="faint">— in the Finishes Summary when set</span></label>
                {(() => { const s = sharedValue(items, (it) => it.fcode || null); return <CodeBox model={model} name="fcode" value={s.mixed ? '' : String(s.v ?? '')} mixed={s.mixed} disabled={ro} onSave={(c) => onCommit(setFinishCodeOps(model, items.map((it) => it.id), c), label(c ? 'Finish code' : 'Finish code cleared'))} />; })()}
              </div>
            ) : null))}
        </fieldset>
        {(() => {
          // (v0.16: rooms reach the BOQ only through the Finishes Summary - left out here)
          const rooms = items.filter((it) => it.kind === 'room').length;
          const rest = items.filter((it) => it.kind !== 'room' && !it.dc); // (v0.16.1 door counters: through the door schedule)
          if (!rest.length) return <div className="qd-sec"><h5>Linked to the BOQ</h5><p className="hint">Rooms reach the BOQ through the Finishes Summary (Finalize).</p></div>;
          const c = rest.filter((it) => (model.linksByItem.get(it.id)?.length ?? 0) > 0).length;
          return (
            <div className="qd-sec">
              <h5>Linked to the BOQ</h5>
              <p className="hint">{c ? `${c} of the ${rest.length} linked already.` : 'None of them linked yet.'} Link {rest.length > 1 ? `all ${rest.length}` : 'it'} to one line in one step (each with the quantity the line's unit asks for).{rooms ? ` ${rooms} room${rooms > 1 ? 's' : ''} left out: rooms reach the BOQ through the Finishes Summary.` : ''}</p>
              {!ro && <button className="btn sm" data-linkall onClick={onLink}><TIcon k="link" /> Link to a BOQ item…</button>}
            </div>
          );
        })()}
        {!ro && (
          <div className="qd-sec danger">
            <button className="btn sm danger" onClick={onDelete}>Delete these {n} take-offs and their {shapes} shape{shapes === 1 ? '' : 's'}…</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** a number (or text) for all: "Multiple values" where they differ; typed = written to all; left alone = kept */
function SharedField({ f, items, setAll }: { f: Extract<Field, { t: 'num' } | { t: 'text' }>; items: TItem[]; setAll: (f: string, v: Value, what: string) => void }) {
  const read = f.t === 'num' && f.read ? f.read : (it: TItem) => val(it, f.f) as number | string | null;
  const s = sharedValue(items, read);
  const shown = s.mixed || s.v === null || s.v === undefined ? '' : String(s.v);
  const [v, setV] = useState<string | null>(null);
  const save = () => {
    if (v === null) return;
    setV(null);
    if (v.trim() === shown) return;
    if (f.t === 'text') { setAll(f.f, v.trim() || null, f.label); return; }
    const x = parseNum(v);
    // empty = the default for all; 0 / below: not a size (as in the take-off's own fields)
    if (x === undefined || (x !== null && (f.allowZero ? x < 0 : x <= 0))) return;
    if (x === null && s.mixed) return;
    setAll(f.f, f.write ? f.write(x) : x, f.label);
  };
  return (
    <div className="field" title={f.title} data-field={f.label}>
      <label>{f.label}</label>
      <div className="sfx">
        <input
          className={'input' + (s.mixed && v === null ? ' mixed' : '')}
          value={v ?? shown}
          placeholder={s.mixed ? MIXED : f.placeholder ?? '—'}
          onChange={(e) => setV(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(null); e.stopPropagation(); } }}
        />
        {f.t === 'num' && f.suffix && <span>{f.suffix}</span>}
      </div>
    </div>
  );
}

function SharedSeg({ f, items, setAll }: { f: Extract<Field, { t: 'seg' }>; items: TItem[]; setAll: (f: string, v: Value, what: string) => void }) {
  const s = sharedValue(items, (it) => val(it, f.f) || null);
  const cur = s.mixed ? undefined : (s.v ?? null);
  return (
    <div className="dispsel" data-field={f.label}>
      <span>{f.label}{s.mixed ? <small className="faint"> · {MIXED}</small> : null}</span>
      <span className="seg">
        {f.opts.map((o) => <button type="button" key={String(o.v)} className={cur === o.v ? 'on' : ''} onClick={() => setAll(f.f, o.v, 'Display')}>{o.label}</button>)}
      </span>
    </div>
  );
}


/**
 * Link several take-offs to one BOQ line in one step: the take-off's own link dialog (search, quantity
 * type "From unit" or chosen, × factor, a temporary line made on the spot), its one link then made for each
 * of them - the quantity each gives as that dialog would choose it for that take-off. Take-offs already
 * linked to that line are left (they would count twice).
 */
export function MultiLinkDialog({ model, items, readOnly, onClose, onCommit, toast, measure }: {
  /** v0.17.1 the quantity asked for (a summary's link button) */
  measure?: Measure;
  model: QtoModel;
  items: TItem[];
  readOnly: boolean;
  onClose: () => void;
  onCommit: (ops: Op[], label: string) => void;
  toast: (t: ReactNode) => void;
}) {
  const first = items[0];
  const several = useRef<TItem>({ ...first, id: 'ti:__several', name: `${items.length} take-offs` });
  const said = useRef<ReactNode | null>(null);
  const commit = (ops: Op[], label: string) => {
    const fake = several.current.id;
    const linkIds = new Set(ops.filter((o) => o[1] === 'ti' && o[2] === fake).map((o) => o[0]));
    const out: Op[] = ops.filter((o) => !linkIds.has(o[0]));
    let made = 0, skipped = 0;
    for (const lid of linkIds) {
      const get = (f: string) => ops.find((o) => o[0] === lid && o[1] === f)?.[2];
      const to = String(get('to') ?? '');
      const q = get('q') as Measure;
      const f = (get('f') as number | null) ?? 1;
      // the line's unit (a temporary line made just now: in these ops)
      const unit = to.startsWith('b:') ? model.boqById.get(to.slice(2))?.unit ?? '' : model.dummyById.get(to)?.unit ?? String(ops.find((o) => o[0] === to && o[1] === 'unit')?.[2] ?? '');
      const um = measureForUnit(unit);
      for (const it of items) {
        if (alreadyLinked(model, it.id, to)) { skipped++; continue; }
        // "From unit": the unit's measure for all; a unit that names none: each one's main measure
        const m: Measure = um && um === q ? q : !um && q === mainMeasure(first) ? mainMeasure(it) : q;
        out.push(...linkOps(it.id, to, m, f).ops);
        made++;
      }
    }
    if (!made && !out.length) { said.current = <span>All {items.length} are linked to that line already.</span>; return; }
    onCommit(out, made > 1 ? `Linked ${made} take-offs to BOQ` : label);
    said.current = <span>Linked <b>{made}</b> take-off{made === 1 ? '' : 's'} to the line in one step{skipped ? ` (${skipped} linked to it already: left as they were)` : ''}.</span>;
  };
  return (
    <LinkDialog
      model={model}
      item={several.current}
      readOnly={readOnly}
      onClose={onClose}
      onCommit={commit}
      measure={measure}
      toast={(t) => { toast(said.current ?? t); said.current = null; }}
    />
  );
}
