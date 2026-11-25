// The take-off details of v0.15: walls (height, width, lintels, doors and openings on them), beams
// (types, slab), how a take-off is drawn, and its shapes segment by segment with their tags.
import { useMemo, useState, type ReactNode } from 'react';
import type { Op } from '../../engine/types';
import type { Box } from '../../engine/qto/geometry';
import { LINTEL_DEFAULT, tagBase, tagOwn, hasTagOwn, stairSizes, isConcWall, wallTypeOf, isLineKind, openingSize, pageKey, segLensAt, shapeQtyAt, isCountedStruct, colTypeOf, typesFor, flightSteps, shapeOverridden, SK_LABEL, type StructKind, type BeamType, type ItemQty, type Opening, type QtoModel, type Shape, type TItem } from '../../engine/qto/model';
import { setSegTagsOps, segOwnOps, tagsOf, shapeOverrideOps } from '../../engine/qto/ops';
import { LINE_WIDTHS } from './numfmt';
import { m1, m2, m3, q as fq } from './numfmt';
import { parseNum } from '../format';
import { TIcon } from './ticons';
import { mmOf } from './Dialogs15';
import type { MemberCat } from '../../engine/qto/beamsched';

type Set1 = (f: string, v: string | number | boolean | null, label?: string) => void;

/** a number field saved on leaving it; empty = the default (shown greyed) */
export function Num({ label, value, onSave, placeholder, suffix, title, allowZero, disabled, help, name }: { label: string; value: number | null; onSave: (v: number | null) => void; placeholder?: string; suffix?: string; title?: string; allowZero?: boolean; disabled?: boolean; help?: ReactNode; name?: string }) {
  const [v, setV] = useState<string | null>(null);
  const shown = v ?? (value === null ? '' : String(value));
  const save = () => {
    if (v === null) return;
    const n = parseNum(v);
    setV(null);
    if (n === undefined || (n !== null && (allowZero ? n < 0 : n <= 0))) return;
    if (n !== value) onSave(n);
  };
  return (
    <div className="field" title={title} data-num={name}>
      <label>{label}{help}</label>
      <div className="sfx">
        <input className="input" value={shown} placeholder={placeholder} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setV(null); }} />
        {suffix && <span>{suffix}</span>}
      </div>
    </div>
  );
}

/** walls: height and width; lintels (bearing each side, depth, breadth = the wall's width when given) */
export function WallFields({ it, set }: { it: TItem; set: Set1 }) {
  return (
    <>
      <div className="fields">
        <Num label="Height" suffix="m" value={it.h} placeholder="—" onSave={(v) => set('h', v, 'Height')} title="Length × height = the wall's area (doors and openings come off it)" />
        <Num label="Width" suffix="m" value={it.d} placeholder="—" onSave={(v) => set('d', v, 'Wall width')} title="The wall's thickness: area × width = volume; also the lintels' breadth" />
      </div>
      <div className="qd-sec tight">
        <h5>Lintels over doors and openings</h5>
        <div className="fields">
          <Num label="Bearing each side" suffix="m" value={it.lb} placeholder={LINTEL_DEFAULT.lb.toFixed(2)} allowZero onSave={(v) => set('lb', v, 'Lintel bearing')} title="How far the lintel runs past the opening on each side (empty = 0.20 m)" />
          <Num label="Depth" suffix="m" value={it.ld} placeholder={LINTEL_DEFAULT.ld.toFixed(2)} onSave={(v) => set('ld', v, 'Lintel depth')} title="Empty = 0.20 m" />
          {it.d
            ? <Num label="Breadth" suffix="m" value={it.d} disabled onSave={() => undefined} title="The wall's width (set above)" />
            : <Num label="Breadth" suffix="m" value={it.lw} placeholder={LINTEL_DEFAULT.lw.toFixed(2)} onSave={(v) => set('lw', v, 'Lintel breadth')} title="The wall's width when it is given; otherwise this (empty = 0.20 m)" />}
        </div>
      </div>
    </>
  );
}

/** v0.17.1 the family a take-off belongs to (its colour on the tool bar, its chip and its settings header) */
export type ToolCat = 'measure' | 'block' | 'finish' | 'struct' | 'note';
export const itemCat = (it: Pick<TItem, 'kind' | 'sk'>): ToolCat => (it.sk || it.kind === 'beam' ? 'struct' : it.kind === 'wall' ? 'block' : it.kind === 'room' ? 'finish' : 'measure');

/** a type's size as shown: 300×600, Ø500, 250 thick */
export const typeSize = (t: BeamType, cat: 'beam' | 'col' | 'wall' | 'swall' | 'ftg' | 'rwall' | 'stair') => (cat === 'stair' ? `${mmOf(t.tr ?? null)}/${mmOf(t.ri ?? null)}, ${mmOf(t.w)} wide` : cat === 'wall' || cat === 'rwall' ? mmOf(t.w) + ' thick' : t.round ? 'Ø' + mmOf(t.w) + (cat === 'ftg' ? '×' + mmOf(t.t ?? null) : '') : mmOf(t.w) + '×' + mmOf(t.d) + (cat === 'ftg' ? '×' + mmOf(t.t ?? null) : ''));
/** v0.18 the schedule a structural take-off's types come from */
export const catOfSk = (sk: StructKind | undefined): 'col' | 'wall' | 'swall' | 'ftg' | 'rwall' | 'stair' => (sk === 'sw' ? 'swall' : sk === 'ftg' ? 'ftg' : sk === 'col' ? 'col' : sk === 'rw' ? 'rwall' : sk === 'stair' ? 'stair' : 'wall');

/**
 * v0.18.1 (Nabil, 11 Nov) footings, rafts, slabs on grade and retaining walls: waterproofing under it (horizontal) and
 * to its sides (vertical, up to a height - its full depth / height when empty; a retaining wall: one face or both),
 * blinding (thickness, how far past the edges) and polythene under it. Each one a tick; its own BOQ link line.
 */
export function SubFields({ it, set, ro }: { it: TItem; set: Set1; ro: boolean }) {
  const rw = it.sk === 'rw';
  const mm = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 1000));
  const chk = (f: string, on: boolean | undefined, label: string, title: string, extra?: ReactNode) => (
    <label className="check tp" title={title}>
      <input type="checkbox" data-sub={f} checked={!!on} disabled={ro} onChange={(e) => set(f, e.target.checked ? true : null, (e.target.checked ? '' : 'No ') + label.toLowerCase())} /> {label}{extra}
    </label>
  );
  return (
    <div className="subfields" data-subfields={it.sk}>
      <div className="subhead">{rw ? 'Waterproofing' : 'Waterproofing · blinding · polythene'}</div>
      {chk('wb', it.wb, rw ? 'Waterproofing – under the wall (horizontal)' : 'Waterproofing – bottom (horizontal)', rw ? 'The wall\'s length × its thickness, in m² - under WP horizontal' : 'Its plan area, in m² - under WP horizontal in Finalize › Structure')}
      {chk('wsd', it.wsd, rw ? 'Waterproofing – face (vertical)' : 'Waterproofing – sides (vertical)', rw ? 'Length × the height below (empty = the wall\'s full height) × the faces; openings come off - under WP vertical' : 'Its perimeter × the height below (empty = its full depth), in m² - under WP vertical')}
      {it.wsd && (
        <div className="fields">
          <Num name="wvh" label="WP height" suffix="m" value={it.wvh ?? null} placeholder={rw ? 'full height' : 'full depth'} onSave={(v) => set('wvh', v, 'Waterproofing height')} title={rw ? 'The height of the waterproofing on the face: empty = the wall\'s full height (higher than the wall = the wall\'s height)' : 'The height of the waterproofing on the sides: empty = its full depth (deeper than it = its depth)'} />
          {rw && (
            <div className="field">
              <label>Faces</label>
              <select className="input" data-sub="wfc" value={it.wfc ?? 1} disabled={ro} onChange={(e) => set('wfc', e.target.value === '2' ? 2 : null, 'Waterproofing faces')} title="Usually one: the face against the soil">
                <option value={1}>One face (the soil side)</option>
                <option value={2}>Both faces</option>
              </select>
            </div>
          )}
        </div>
      )}
      {chk('bln', it.bln, 'Blinding', rw ? 'Concrete blinding under the wall: its length × its thickness grown by the projection on each side (and past its ends), × the blinding thickness, in m³ - under Blinding' : 'Concrete blinding: its plan area grown by the projection below, × the thickness, in m³ - under Blinding')}
      {it.bln && (
        <div className="fields">
          <Num name="blt" label="Thickness" suffix="mm" value={mm(it.blt)} placeholder="50" onSave={(v) => set('blt', v === null ? null : v / 1000, 'Blinding thickness')} title="Empty = 50 mm" />
          <Num name="blx" label="Projection" suffix="mm" value={mm(it.blx)} placeholder="50" allowZero onSave={(v) => set('blx', v === null ? null : v / 1000, 'Blinding projection')} title="How far the blinding (and the polythene) reaches past its edges, all round. Empty = 50 mm" />
        </div>
      )}
      {chk('pe', it.pe, 'Polythene sheet (DPM)', 'Polythene sheet (DPM): the same extent as the blinding (its plan area grown by the projection), in m² - under Polythene')}
      {it.pe && !it.bln && (
        <div className="fields">
          <Num name="blx" label="Projection" suffix="mm" value={mm(it.blx)} placeholder="50" allowZero onSave={(v) => set('blx', v === null ? null : v / 1000, 'Polythene projection')} title="How far the polythene reaches past its edges, all round. Empty = 50 mm" />
        </div>
      )}
    </div>
  );
}

/** beams: the type of segments without one, and the slab whose thickness comes off the depth (v0.17: upstands) */
export function BeamFields({ model, it, set, onTypes, ro }: { model: QtoModel; it: TItem; set: Set1; onTypes: () => void; ro: boolean }) {
  return (
    <>
      <div className="fields">
        <div className="field l" style={{ gridColumn: 'span 2' }}>
          <label>Type of segments without one</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <select className="input" value={it.bt} disabled={ro} onChange={(e) => set('bt', e.target.value || null, 'Beam type')}>
              <option value="">— none —</option>
              {model.beamTypes.map((t) => <option key={t.id} value={t.id}>{t.name} ({mmOf(t.w)}×{mmOf(t.d)})</option>)}
            </select>
            <button className="btn sm" onClick={onTypes} title="Beam schedule: sizes, steel, colours">Types…</button>
          </div>
        </div>
        <Num label="Slab" suffix="m" value={it.st} placeholder="0" allowZero onSave={(v) => set('st', v || null, 'Slab thickness')} title={it.up ? 'Slab thickness: an upstand counts the part above the slab (the overall depth less this), formwork both sides' : 'Slab thickness: taken off each beam\'s depth for the volume and the formwork sides (beam below a slab)'} />
        <Num label="Steel" suffix="kg/m³" value={it.sr ?? null} placeholder="by type" onSave={(v) => set('sr', v, 'Steel ratio')} title="Used for beam types that have no steel ratio of their own" />
      </div>
      <label className="check tp" title="An upstand (inverted beam) stands on the slab: the part above it counts (the overall depth less the slab), formwork both sides, no soffit">
        <input type="checkbox" data-upstand checked={!!it.up} disabled={ro} onChange={(e) => set('up', e.target.checked ? true : null, e.target.checked ? 'Upstand beam' : 'Beam below the slab')} /> Upstand (above the slab)
      </label>
    </>
  );
}

/** v0.17 slabs, drop panels, columns, shear walls: their sizes, default type and steel ratio */
export function StructFields({ model, it, set, onTypes, ro }: { model: QtoModel; it: TItem; set: Set1; onTypes: (cat: MemberCat) => void; ro: boolean }) {
  if (it.sk === 'slab' || it.sk === 'drop' || it.sk === 'raft' || it.sk === 'sog') {
    return (
      <>
        <div className="fields" data-structfields={it.sk}>
          <Num label={it.sk === 'drop' ? 'Depth below the slab' : 'Thickness'} suffix="m" value={it.d} placeholder="needed" onSave={(v) => set('d', v, 'Thickness')} title={it.sk === 'drop' ? 'How far the drop panel projects below the slab: area × this = its concrete; its edges × this = side formwork' : it.sk === 'raft' ? 'Area × thickness = concrete; its edges × thickness = side formwork (it sits on the ground: no soffit)' : 'Area × thickness = concrete; the edges × thickness = edge formwork (with the soffit)'} />
          <Num label="Steel" suffix="kg/m³" value={it.sr ?? null} placeholder="—" onSave={(v) => set('sr', v, 'Steel ratio')} title="Reinforcement in kg per m³ of concrete" />
        </div>
        {it.sk === 'slab' && (
          <label className="check tp" title="Formwork under the slab: its area less the drop panels and the beams under it (their own soffits are counted with them). Off = the slab's whole area">
            <input type="checkbox" data-fdx checked={!!it.fdx} disabled={ro} onChange={(e) => set('fdx', e.target.checked ? true : null, e.target.checked ? 'Soffit less drops and beams' : 'Whole soffit')} /> Soffit formwork: less drop panels and beams
          </label>
        )}
        {(it.sk === 'slab' || it.sk === 'sog') && (
          <label className="check tp" title="A254 mesh over this slab: its m² (the slab's area) shows under Mesh in Finalize › Structure, with its own link button">
            <input type="checkbox" data-mesh checked={!!it.mesh} disabled={ro} onChange={(e) => set('mesh', e.target.checked ? true : null, e.target.checked ? 'A254 mesh' : 'No mesh')} /> A254 mesh <span className="faint">(m² in Finalize)</span>
          </label>
        )}
        {(it.sk === 'raft' || it.sk === 'sog') && <SubFields it={it} set={set} ro={ro} />}
      </>
    );
  }
  // v0.18 a stair: its flights and landings drawn as areas on the plan (Nabil's stairs sheet); v0.18.1 stair types
  if (it.sk === 'stair') {
    const st = it.bt ? model.stairTypeById.get(it.bt) : null;
    return (
      <div className="fields" data-structfields="stair">
        <div className="field l" style={{ gridColumn: 'span 2' }}>
          <label>Default stair type</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <select className="input" data-stairtype value={st ? it.bt : ''} disabled={ro} onChange={(e) => set('bt', e.target.value || null, 'Stair type')} title="A type gives tread, riser, flight width, waist and landing thickness; the figures below are used when there is none (or the type leaves one empty)">
              <option value="">— none: the figures below —</option>
              {model.stairTypes.map((t) => <option key={t.id} value={t.id}>{t.name} ({typeSize(t, 'stair')})</option>)}
            </select>
            <button className="btn sm" onClick={() => onTypes('stair')} title="Stair schedule: tread, riser, flight width, waist, landing, steel">Types…</button>
          </div>
        </div>
        <Num label="Tread" suffix="m" value={it.tr ?? null} placeholder={st?.tr ? 'by type' : '0.28'} onSave={(v) => set('tr', v, 'Tread')} title="The going of one step" />
        <Num label="Riser" suffix="m" value={it.ri ?? null} placeholder={st?.ri ? 'by type' : '0.18'} onSave={(v) => set('ri', v, 'Riser')} title="The rise of one step" />
        <Num label="Flight width" suffix="m" value={it.ow} placeholder={st?.w ? 'by type' : 'needed'} onSave={(v) => set('ow', v, 'Flight width')} title="Steps of a flight = its area on the plan ÷ (width × tread) - change it on the flight if the drawing says otherwise" />
        <Num label="Waist" suffix="m" value={it.d} placeholder={st?.d ? 'by type' : 'needed'} onSave={(v) => set('d', v, 'Waist thickness')} title="The sloping slab under the steps: its thickness" />
        <Num label="Landing thickness" suffix="m" value={it.st} placeholder={st?.t ? 'by type' : 'needed'} onSave={(v) => set('st', v, 'Landing thickness')} title="Landings: their area × this" />
        <Num label="Steel" suffix="kg/m³" value={it.sr ?? null} placeholder="—" onSave={(v) => set('sr', v, 'Steel ratio')} title="Reinforcement in kg per m³ of concrete" />
      </div>
    );
  }
  const cat = catOfSk(it.sk);
  const types = cat === 'col' ? model.colTypes : cat === 'swall' ? model.swTypes : cat === 'ftg' ? model.ftgTypes : cat === 'rwall' ? model.rwTypes : model.wallTypes;
  const noun = cat === 'col' ? 'Column' : cat === 'swall' ? 'Shear wall' : cat === 'ftg' ? 'Footing' : cat === 'rwall' ? 'Retaining wall' : 'Core wall';
  return (
    <>
    <div className="fields" data-structfields={it.sk}>
      {cat !== 'ftg' && <Num label="Height" suffix="m" value={it.h} placeholder="needed" onSave={(v) => set('h', v, 'Height')} title={cat === 'wall' ? 'The wall\'s height: length × height × its type\'s thickness = concrete; both faces = formwork' : 'Each one\'s height: section × height = its concrete. Floor to floor? give the slab thickness next to it and it comes off'} />}
      {(cat === 'col' || cat === 'swall') && <Num name="cst" label="Slab" suffix="m" value={it.cst ?? null} placeholder="0" onSave={(v) => set('cst', v, 'Slab thickness')} title="Slab thickness: taken off the height (the slab is measured with the slab, not twice)" />}
      <div className="field l" style={{ gridColumn: 'span 2' }}>
        <label>{cat === 'wall' || cat === 'rwall' ? 'Type of segments without one' : `Type of ${noun.toLowerCase()}s without one`}</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <select className="input" value={it.bt} disabled={ro} onChange={(e) => set('bt', e.target.value || null, noun + ' type')}>
            <option value="">— none —</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name} ({typeSize(t, cat)})</option>)}
          </select>
          <button className="btn sm" onClick={() => onTypes(cat)} title={noun + ' schedule: sizes, steel, colours'}>Types…</button>
        </div>
      </div>
      <Num label="Steel" suffix="kg/m³" value={it.sr ?? null} placeholder="by type" onSave={(v) => set('sr', v, 'Steel ratio')} title="Used for types that have no steel ratio of their own" />
    </div>
    {(it.sk === 'ftg' || it.sk === 'rw') && <SubFields it={it} set={set} ro={ro} />}
    </>
  );
}

/**
 * v0.18 (Feedback 3, 7: "each instance may have different dimensions and/or steel ratios ... the right-side settings
 * panel can override defaults for any instance") - the elements picked on the drawing (one or many, of this take-off):
 * figures of their own in place of their type's / the take-off's. Empty = the default (shown greyed).
 */
export function ElementBox({ model, it, shapes, ro, onCommit }: { model: QtoModel; it: TItem; shapes: Shape[]; ro: boolean; onCommit: (ops: Op[], label: string) => void }) {
  const mine = shapes.filter((s) => s.ti === it.id && (isCountedStruct(it.sk) ? s.k === 'pt' : it.kind === 'beam' || isConcWall(it.sk) ? s.k === 'line' : s.k === 'poly'));
  if (!mine.length || !(it.kind === 'beam' || it.sk)) return null;
  const same = <K extends 'xw' | 'xd' | 'xt' | 'xh' | 'xr' | 'xn'>(k: K): number | null => { const v = mine[0][k]; return v !== undefined && mine.every((s) => s[k] === v) ? v : null; };
  const mixed = (k: 'xw' | 'xd' | 'xt' | 'xh' | 'xr' | 'xn') => new Set(mine.map((s) => s[k])).size > 1;
  const setX = (patch: Parameters<typeof shapeOverrideOps>[1], label: string) => { const ops = shapeOverrideOps(mine, patch); if (ops.length) onCommit(ops, label); };
  const counted = isCountedStruct(it.sk);
  const t0 = counted ? colTypeOf(model, it, mine[0].mt) : null;
  const oneType = counted && mine.every((s) => (colTypeOf(model, it, s.mt)?.id ?? '') === (t0?.id ?? ''));
  const types = typesFor(model, it.sk);
  const mm = (v: number | null | undefined) => (v ? String(Math.round(v * 1000)) : '');
  const ph = (k: 'xw' | 'xd' | 'xt' | 'xh' | 'xr' | 'xn', def: string) => (mixed(k) ? 'varies' : def);
  const any = mine.some(shapeOverridden);
  const size = (k: 'xw' | 'xd' | 'xt', label: string, def: number | null | undefined, title: string) => (
    <Num name={k} label={label} suffix="mm" value={same(k) === null ? null : Math.round(same(k)! * 1000)} placeholder={ph(k, mm(def) || '—')} onSave={(v) => setX({ [k]: v === null ? null : v / 1000 }, 'Element ' + label.toLowerCase())} title={title} />
  );
  const noun = it.sk ? SK_LABEL[it.sk].toLowerCase() : 'beam';
  const stairFlights = it.sk === 'stair' ? mine.filter((s) => s.sp !== 'l') : [];
  return (
    <div className="elbox" data-elbox={mine.length}>
      <div className="elbox-h">
        <b>{mine.length === 1 ? 'This ' + noun : `${mine.length} ${noun}s picked`}</b>
        {any && <span className="autotag off" title="Figures of its own are typed here">own figures</span>}
        <span className="grow" />
        {any && !ro && <button className="linkbtn" data-elreset onClick={() => setX({ xw: null, xd: null, xt: null, xh: null, xr: null, xn: null }, 'Element back to its type')}>Back to the type</button>}
      </div>
      <fieldset className="qd-fields" disabled={ro}>
        {counted && (
          <div className="field l">
            <label>Type</label>
            <select className="input" data-eltype value={oneType ? mine[0].mt ?? '' : '*'} onChange={(e) => { if (e.target.value !== '*') onCommit(mine.map((s) => [s.id, 'mt', e.target.value || null] as Op), 'Element type'); }}>
              {!oneType && <option value="*">— varies —</option>}
              <option value="">{it.bt && types.find((t) => t.id === it.bt) ? 'take-off’s type (' + types.find((t) => t.id === it.bt)!.name + ')' : '— none —'}</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name} ({typeSize(t, catOfSk(it.sk))})</option>)}
            </select>
          </div>
        )}
        <div className="fields">
          {(counted || it.kind === 'beam') && size('xw', it.sk === 'sw' || it.sk === 'ftg' ? 'Length' : 'Width', oneType ? t0?.w : null, 'This element only - empty: its type’s')}
          {(counted || it.kind === 'beam') && !(t0?.round && same('xw') === null && same('xd') === null) && size('xd', it.sk === 'sw' ? 'Thickness' : it.sk === 'ftg' ? 'Width' : 'Depth', oneType ? t0?.d : null, 'This element only - empty: its type’s')}
          {isConcWall(it.sk) && size('xw', 'Thickness', null, 'This wall only - empty: its segments’ types')}
          {isConcWall(it.sk) && <Num name="xh" label="Height" suffix="m" value={same('xh')} placeholder={ph('xh', it.h ? String(it.h) : '—')} onSave={(v) => setX({ xh: v }, 'Wall height')} title="This wall only - empty: the take-off’s height (its waterproofing height too, when that is “full”)" />}
          {it.sk === 'ftg' && size('xt', 'Depth', oneType ? t0?.t : null, 'This footing only - empty: its type’s')}
          {(it.sk === 'col' || it.sk === 'sw') && <Num name="xh" label="Height" suffix="m" value={same('xh')} placeholder={ph('xh', it.h ? String(it.h) : '—')} onSave={(v) => setX({ xh: v }, 'Element height')} title="This element only - empty: the take-off’s height" />}
          {it.sk === 'stair' && stairFlights.length > 0 && <Num name="xn" label="Steps" suffix="nr" value={same('xn')} placeholder={ph('xn', stairFlights.length === 1 ? String((() => { const z = stairSizes(model, it, stairFlights[0]); return flightSteps({ ow: z.w, tr: z.tr }, { xn: undefined }, shapeQtyAt(model, stairFlights[0], null).area); })()) : 'by area')} onSave={(v) => setX({ xn: v === null ? null : Math.round(v) }, 'Steps')} title="The steps of this flight - empty: its area ÷ (flight width × tread)" />}
          <Num name="xr" label="Steel" suffix="kg/m³" value={same('xr')} allowZero placeholder={ph('xr', counted && oneType && t0?.r != null ? String(t0.r) : it.sr != null ? String(it.sr) : 'by type')} onSave={(v) => setX({ xr: v }, 'Element steel ratio')} title="This element only - empty: its type’s (or the take-off’s) ratio" />
        </div>
        {it.sk === 'stair' && model.stairTypes.length > 0 && (
          <div className="field l">
            <label>Stair type</label>
            <select className="input" data-elstairtype value={new Set(mine.map((s) => s.mt ?? '')).size === 1 ? mine[0].mt ?? '' : '*'} onChange={(e) => { if (e.target.value !== '*') onCommit(mine.map((s) => [s.id, 'mt', e.target.value || null] as Op), 'Stair type'); }}>
              {new Set(mine.map((s) => s.mt ?? '')).size > 1 && <option value="*">— varies —</option>}
              <option value="">{it.bt && model.stairTypeById.get(it.bt) ? 'take-off’s type (' + model.stairTypeById.get(it.bt)!.name + ')' : '— the take-off’s figures —'}</option>
              {model.stairTypes.map((t) => <option key={t.id} value={t.id}>{t.name} ({typeSize(t, 'stair')})</option>)}
            </select>
          </div>
        )}
        {it.sk === 'stair' && (
          <div className="field l">
            <label>It is</label>
            <span className="seg sm" data-stairpart>
              <button type="button" className={mine.every((s) => s.sp !== 'l') ? 'on' : ''} onClick={() => setX({ sp: null }, 'Flight')} title="Steps on a sloping waist slab">A flight</button>
              <button type="button" className={mine.every((s) => s.sp === 'l') ? 'on' : ''} onClick={() => setX({ sp: 'l', xn: null }, 'Landing')} title="A flat slab: its area × the landing thickness">A landing</button>
            </span>
          </div>
        )}
      </fieldset>
    </div>
  );
}

/** what a wall / beam adds to the big number */
export function QtyExtras({ it, qty }: { it: TItem; qty: ItemQty }) {
  if (it.kind === 'wall' && !it.sk) {
    return (
      <div className="qd-stats">
        {qty.doors > 0 && <span>{fq(qty.doors, 'cnt')} door{qty.doors === 1 ? '' : 's'}</span>}
        {qty.opens > 0 && <span>{fq(qty.opens, 'cnt')} other opening{qty.opens === 1 ? '' : 's'}</span>}
        {qty.lcnt > 0 && <span>lintels: {fq(qty.lcnt, 'cnt')} nr · {m1(qty.llen)} · {m3(qty.lvol)}</span>}
        {!it.h && <span className="warnline">set the height to get m²</span>}
      </div>
    );
  }
  // (v0.18 a plain length with doors / openings on it)
  if (it.kind === 'line' && qty.doors + qty.opens > 0) {
    return (
      <div className="qd-stats" data-lendoors>
        <span>{fq(qty.doors + qty.opens, 'cnt')} door{qty.doors + qty.opens === 1 ? '' : 's'} / opening{qty.doors + qty.opens === 1 ? '' : 's'} off{!it.h && qty.dedLen > 0 ? ': − ' + m1(qty.dedLen) : it.h && qty.dedArea > 0 ? ': − ' + m2(qty.dedArea) : ''}</span>
      </div>
    );
  }
  if (it.kind === 'beam' || it.sk) {
    return (
      <div className="qd-stats">
        {(isCountedStruct(it.sk) || it.sk === 'stair') && qty.vol > 0 && <span>concrete {m3(qty.vol)}</span>}
        {it.sk === 'stair' && qty.steps > 0 && <span>{fq(qty.steps, 'cnt')} steps</span>}
        {(it.sk === 'slab' || it.sk === 'sog') && it.mesh && <span>mesh A254 {m2(qty.area)}</span>}
        {qty.wph > 0 && <span>WP horizontal {m2(qty.wph)}</span>}
        {qty.wpv > 0 && <span>WP vertical {m2(qty.wpv)}</span>}
        {qty.blv > 0 && <span>blinding {m3(qty.blv)}</span>}
        {qty.pea > 0 && <span>polythene {m2(qty.pea)}</span>}
        {it.sk === 'slab' && it.fdx && qty.soffitOff > 0 && <span title="Drop panels and beams under the slab: their soffits are counted with them">{m2(qty.soffitOff)} of soffit under drops / beams</span>}
        {(it.sk === 'shear' || it.sk === 'rw') && qty.doors + qty.opens > 0 && <span>{fq(qty.doors + qty.opens, 'cnt')} opening{qty.doors + qty.opens === 1 ? '' : 's'} off</span>}
        {qty.form > 0 && <span>formwork {m2(qty.form)}</span>}
        {qty.kg > 0 && <span>steel {fq(qty.kg, 'kg')} kg</span>}
        {(it.sk === 'slab' || it.sk === 'drop' || it.sk === 'raft' || it.sk === 'sog') && !it.d && <span className="warnline">set the thickness to get m³</span>}
        {(it.sk === 'col' || it.sk === 'sw' || it.sk === 'shear' || it.sk === 'rw') && !it.h && qty.vol <= 0 && <span className="warnline">set the height to get m³</span>}
        {(it.sk === 'shear' || it.sk === 'rw') && qty.untyped > 0 && <span className="warnline">give its walls a type (or their own thickness) to get m³</span>}
        {qty.untyped > 0 && (it.sk === 'stair'
          ? <span className="warnline" title="Tread, riser, flight width and waist (flights) or the landing thickness are needed">{fq(qty.untyped, 'cnt')} waiting for the stair’s sizes</span>
          : isCountedStruct(it.sk)
          ? <span className="warnline" title="Counted with no type (and no default type for the take-off) or a type with no size: no concrete">{fq(qty.untyped, 'cnt')} without a {it.sk === 'ftg' ? 'type (L × W × D)' : 'type'}</span>
          : <span className="warnline" title="Segments with no type (and no default type for the take-off): their length is counted, no volume">{m1(qty.untyped)} without a type</span>)}
      </div>
    );
  }
  return null;
}

/** how this take-off is drawn ('' = as set on this PC under Display) */
export function DisplayFields({ it, set }: { it: TItem; set: Set1 }) {
  const seg = (f: 'sw' | 'fill' | 'lab', opts: { v: string | number | null; label: string }[], cur: string | number | null, label: string) => (
    <div className="dispsel">
      <span>{label}</span>
      <span className="seg">
        {opts.map((o) => <button key={String(o.v)} className={cur === o.v ? 'on' : ''} onClick={() => set(f, o.v, 'Display')}>{o.label}</button>)}
      </span>
    </div>
  );
  return (
    <div className="qd-sec">
      <h5>On the drawing</h5>
      {seg('sw', [{ v: null, label: 'As set' }, ...LINE_WIDTHS.map((w) => ({ v: w.k, label: w.label }))], it.sw, 'Lines')}
      {it.kind === 'area' && seg('fill', [{ v: null, label: 'As set' }, { v: 'hatch', label: 'Hatched' }, { v: 'none', label: 'Outline only' }], it.fill || null, 'Fill')}
      {seg('lab', [{ v: null, label: 'As set' }, { v: 'always', label: 'Always' }, { v: 'hover', label: 'On hover' }, { v: 'never', label: 'Selected only' }], it.lab || null, 'Numbers')}
    </div>
  );
}

/** a segment's tag as shown: a beam type's name, else the text */
export function tagText(model: QtoModel, t0: string | null | undefined): string {
  if (!t0) return '';
  // (v0.18.1 a segment with figures of its own: its type's name and *)
  const t = tagBase(t0) ?? '', star = hasTagOwn(t0) ? ' *' : '';
  if (star) return tagText(model, t) + star;
  // (v0.18.1 a stair's parts by type)
  if (/\|[fl]$/.test(t)) return tagText(model, t.slice(0, -2)) + (t.endsWith('|l') ? ' landings' : ' flights');
  if (t.startsWith('bt:')) return model.beamTypeById.get(t)?.name ?? '(type removed)';
  if (t.startsWith('wt:')) return model.wallTypeById.get(t)?.name ?? '(type removed)';
  if (t.startsWith('ct:')) return model.colTypeById.get(t)?.name ?? '(type removed)';
  if (t.startsWith('st:')) return model.swTypeById.get(t)?.name ?? '(type removed)';
  if (t.startsWith('ft:')) return model.ftgTypeById.get(t)?.name ?? '(type removed)';
  if (t.startsWith('rt:')) return model.rwTypeById.get(t)?.name ?? '(type removed)';
  if (t.startsWith('sy:')) return model.stairTypeById.get(t)?.name ?? '(type removed)';
  return t;
}

/**
 * The shapes of a take-off and, for lines (lengths, walls, beams), each segment: its length (and area
 * for a wall), its tag, and the doors / openings on it. Pick segments (click, Shift+click) to tag them;
 * the picked ones light up on the drawing.
 */
export function SegTable({ model, it, ro, onCommit, onGoTo, segHi, onSegHi, onEditOpening, labelFor, shown: isShown }: {
  model: QtoModel;
  it: TItem;
  ro: boolean;
  onCommit: (ops: Op[], label: string) => void;
  onGoTo: (dwg: string, pg: number, box?: Box) => void;
  segHi: { shape: string; segs: number[] } | null;
  onSegHi: (v: { shape: string; segs: number[] } | null) => void;
  onEditOpening: (o: Opening) => void;
  labelFor: (s: Shape) => string;
  /** v0.16 (e): only the shapes shown on the drawing for the people chosen are listed (the others: "+ n by others") */
  shown?: (s: Shape) => boolean;
}) {
  const allShapes = model.shapesByItem.get(it.id) ?? [];
  const shapes = useMemo(() => [...allShapes].filter((s) => !isShown || isShown(s)).sort((a, b) => (a.dwg + '#' + a.pg).localeCompare(b.dwg + '#' + b.pg) || a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0), [model, it.id, isShown]);
  const byOthers = allShapes.length - shapes.length;
  const [open, setOpen] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [tagIn, setTagIn] = useState('');
  const [more, setMore] = useState(false);
  const line = isLineKind(it.kind);
  const beam = it.kind === 'beam';
  const known = useMemo(() => {
    const s = new Set<string>();
    for (const sh of model.shapes) for (const t0 of sh.sg ?? []) { const t = tagBase(t0); if (t && !t.startsWith('bt:') && !t.startsWith('wt:') && !t.startsWith('rt:') && !t.includes('~')) s.add(t); }
    return [...s].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [model]);
  if (!shapes.length && !byOthers) return null;
  const picked = segHi && open === segHi.shape ? new Set(segHi.segs) : new Set<number>();
  const sheetName = (s: Shape) => {
    const d = model.dwgById.get(s.dwg);
    return (d?.sheet || d?.name || '?') + ((d?.pages ?? 1) > 1 ? ' p' + (s.pg + 1) : '');
  };
  const toggleShape = (s: Shape) => {
    if (open === s.id) { setOpen(null); onSegHi(null); return; }
    setOpen(s.id);
    onSegHi({ shape: s.id, segs: [] });
    onGoTo(s.dwg, s.pg, s.box);
  };
  const clickSeg = (s: Shape, i: number, e: React.MouseEvent) => {
    let segs = new Set(picked);
    if (e.shiftKey && anchor !== null) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      for (let k = a; k <= b; k++) segs.add(k);
    } else if (e.ctrlKey || e.metaKey || (e.target as HTMLElement).tagName === 'INPUT') {
      segs.has(i) ? segs.delete(i) : segs.add(i);
    } else segs = segs.has(i) && segs.size === 1 ? new Set() : new Set([i]);
    setAnchor(i);
    onSegHi({ shape: s.id, segs: [...segs].sort((a, b) => a - b) });
  };
  const applyTag = (s: Shape, tag: string | null) => {
    const segs = [...picked];
    if (!segs.length) return;
    const ops = setSegTagsOps(s, segs, tag);
    if (ops.length) onCommit(ops, tag ? 'Tagged segments' : 'Untagged segments');
    setTagIn('');
  };
  const shown = more ? shapes : shapes.slice(0, 150);
  let lastSheet = '';
  return (
    <div className="qd-sec">
      <h5>Shapes{line ? ' and segments' : ''} ({shapes.length})</h5>
      <div className="segtbl">
        {shown.map((s) => {
          const sk = pageKey(s.dwg, s.pg);
          const head = sk !== lastSheet ? sheetName(s) : null;
          lastSheet = sk;
          const isOpen = open === s.id;
          const tags = tagsOf(s);
          const tagsUsed = [...new Set(tags.filter(Boolean) as string[])];
          return (
            <div key={s.id} className={'segshape' + (isOpen ? ' open' : '')}>
              {head && <div className="segsheet">{head}</div>}
              <button className="segrow sh" onClick={() => toggleShape(s)} title="Show it on the drawing">
                {line && s.k === 'line' && <TIcon k="chev" size={11} />}
                <span className="lb">{s.k === 'pt' ? 'Count' : s.k === 'poly' ? 'Outline' : `${s.pts.length - 1} segment${s.pts.length > 2 ? 's' : ''}`}{s.m !== 1 ? ` ×${s.m}` : ''}</span>
                <span className="tg">{tagsUsed.map((t) => <i key={t} className="tagchip" style={beam && t.startsWith('bt:') ? { borderColor: model.beamTypeById.get(t)?.color } : t.startsWith('wt:') ? { borderColor: model.wallTypeById.get(t)?.color } : undefined}>{tagText(model, t)}</i>)}</span>
                <span className="v num">{labelFor(s)}</span>
              </button>
              {isOpen && line && s.k === 'line' && <Segments model={model} it={it} s={s} picked={picked} ro={ro} onClick={(i, e) => clickSeg(s, i, e)} onEditOpening={onEditOpening} onCommit={onCommit} />}
              {isOpen && line && s.k === 'line' && !ro && (
                <div className="segtag">
                  {picked.size === 0 ? <span className="faint">Click segments to tag them (Shift+click: a run, Ctrl+click: add one)</span> : (
                    <>
                      <span>{picked.size} picked:</span>
                      {beam || isConcWall(it.sk) ? (
                        <>
                          <select className="input sm" data-segtype value="" onChange={(e) => e.target.value && applyTag(s, e.target.value === '-' ? null : e.target.value)}>
                            <option value="">{beam ? 'Beam type…' : 'Wall type…'}</option>
                            {(beam ? model.beamTypes : it.sk === 'rw' ? model.rwTypes : model.wallTypes).map((t) => <option key={t.id} value={t.id}>{t.name} ({typeSize(t, beam ? 'beam' : it.sk === 'rw' ? 'rwall' : 'wall')})</option>)}
                            <option value="-">— the take-off's default —</option>
                          </select>
                          <SegOwnFields s={s} segs={[...picked]} beam={beam} onCommit={onCommit} />
                        </>
                      ) : (
                        <>
                          <input className="input sm" list="segtags" placeholder="Tag (e.g. GF, Type A)" value={tagIn} onChange={(e) => setTagIn(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && tagIn.trim()) applyTag(s, tagIn.trim()); }} />
                          <datalist id="segtags">{known.map((t) => <option key={t} value={t} />)}</datalist>
                          <button className="btn sm" disabled={!tagIn.trim()} onClick={() => applyTag(s, tagIn.trim())}>Tag</button>
                          <button className="btn sm ghost" onClick={() => applyTag(s, null)}>Clear</button>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {shapes.length > shown.length && <button className="linkbtn" onClick={() => setMore(true)}>Show all {shapes.length}</button>}
        {byOthers > 0 && <div className="faint segothers" data-seg-others title="Other people's shapes are counted in the total; they are not on the drawing for you now (People ▾)">+ {byOthers} by others</div>}
      </div>
    </div>
  );
}

/**
 * v0.18 (Feedback 3, 7) + v0.18.1: the picked segments of a beam / core wall / retaining wall - sizes and steel of
 * their own in place of their type's (mm; empty = the type's). Kept when the segments' type is changed.
 */
function SegOwnFields({ s, segs, beam, onCommit }: { s: Shape; segs: number[]; beam: boolean; onCommit: (ops: Op[], label: string) => void }) {
  const owns = segs.map((i) => tagOwn(s.sg?.[i]));
  const same = (k: 'w' | 'd' | 'r'): number | null => { const v = owns[0]?.[k]; return v !== undefined && owns.every((o) => o[k] === v) ? v : null; };
  const varies = (k: 'w' | 'd' | 'r') => new Set(owns.map((o) => o[k])).size > 1;
  const put = (k: 'w' | 'd' | 'r', v: number | null, label: string) => { const ops = segOwnOps(s, segs, { [k]: v }); if (ops.length) onCommit(ops, label); };
  const mmv = (k: 'w' | 'd') => (same(k) === null ? null : Math.round(same(k)! * 1000));
  const any = owns.some((o) => o.w !== undefined || o.d !== undefined || o.r !== undefined);
  return (
    <div className="segown" data-segown={segs.length}>
      <Num name="sw" label={beam ? 'Width' : 'Thickness'} suffix="mm" value={mmv('w')} placeholder={varies('w') ? 'varies' : 'by type'} onSave={(v) => put('w', v === null ? null : v / 1000, beam ? 'Segment width' : 'Segment thickness')} title="These segments only - empty: their type's" />
      {beam && <Num name="sd" label="Depth" suffix="mm" value={mmv('d')} placeholder={varies('d') ? 'varies' : 'by type'} onSave={(v) => put('d', v === null ? null : v / 1000, 'Segment depth')} title="These segments only - empty: their type's" />}
      <Num name="sr" label="Steel" suffix="kg/m³" value={same('r')} allowZero placeholder={varies('r') ? 'varies' : 'by type'} onSave={(v) => put('r', v, 'Segment steel ratio')} title="These segments only - empty: their type's (or the take-off's)" />
      {any && <button className="linkbtn" data-segown-reset onClick={() => { const ops = segOwnOps(s, segs, { w: null, d: null, r: null }); if (ops.length) onCommit(ops, 'Segments back to their type'); }}>Back to the type</button>}
    </div>
  );
}

function Segments({ model, it, s, picked, ro, onClick, onEditOpening, onCommit }: { model: QtoModel; it: TItem; s: Shape; picked: Set<number>; ro: boolean; onClick: (i: number, e: React.MouseEvent) => void; onEditOpening: (o: Opening) => void; onCommit: (ops: Op[], label: string) => void }) {
  const sl = segLensAt(model, s);
  const tags = tagsOf(s);
  const ops = model.openingsByShape.get(s.id) ?? [];
  const wall = it.kind === 'wall';
  const beam = it.kind === 'beam';
  const cw = isConcWall(it.sk);
  // the height the take-off counts for this shape: a concrete wall's own height first (as the take-off does - the rows
  // used the take-off's height alone, and hid the area when only the element had one - 0.23.2, DeepSeek #34)
  const wh = cw ? s.xh ?? it.h : it.h;
  return (
    <div className="segs">
      <div className="seghdr"><span>#</span><span>Length</span>{wall && wh ? <span>Area</span> : null}{beam || cw ? <span>Type</span> : <span>Tag</span>}</div>
      {sl.lens.map((L, i) => {
        const t0 = tags[i], t = tagBase(t0), star = hasTagOwn(t0) ? ' *' : '';
        const here = ops.filter((o) => o.seg === i);
        const bt = beam ? model.beamTypeById.get(t || it.bt) : cw ? wallTypeOf(model, it, t0) : null;
        return (
          <div key={i}>
            <div className={'seg1' + (picked.has(i) ? ' on' : '')} onClick={(e) => onClick(i, e)}>
              <span className="n"><input type="checkbox" checked={picked.has(i)} readOnly tabIndex={-1} /> {i + 1}</span>
              <span className="num">{L === null ? 'no scale' : m1(L)}</span>
              {wall && wh ? <span className="num">{L === null ? '' : m2(L * wh)}</span> : null}
              <span className="tg">{beam || cw ? <i className="tagchip" style={bt ? { borderColor: bt.color } : undefined} title={star ? 'Figures of its own' : undefined}>{bt ? bt.name + (t ? '' : ' (default)') + star : '—' + star}</i> : t ? <i className="tagchip">{t}</i> : <span className="faint">—</span>}</span>
            </div>
            {here.map((o) => {
              const { w, h } = openingSize(model, o);
              // (only the part within the wall's height from its sill, and none at or under the smallest deducted - as
              // the take-off counts it; the row took off the whole opening - 0.23.2, DeepSeek #35)
              const sill0 = o.sill ?? 0;
              const a0 = w && h ? w * (wh ? Math.max(0, Math.min(sill0 + h, wh) - Math.min(sill0, wh)) : h) : 0;
              const a = a0 > 0 && (it.dmin === null || a0 > it.dmin + 1e-9) ? a0 : 0;
              const d = o.door ? model.doorById.get(o.door) : null;
              return (
                <div key={o.id} className={'seg1 op' + (o.uns ? ' bad' : '')}>
                  <span className="n"><TIcon k={o.k === 'door' ? 'door' : 'hole'} size={12} /></span>
                  <span className="lb">{o.k === 'door' ? (d?.tag ?? o.tag ?? 'door') : o.tag || 'opening'} <span className="faint">{w ? mmOf(w) : '?'}×{h ? mmOf(h) : '?'}{o.lint ? ' · lintel' : ''}{o.uns ? ' · not in the schedule' : ''}</span></span>
                  {wall && wh ? <span className="num neg">{a ? '−' + m2(a) : a0 ? <span className="faint" title="Not deducted: no bigger than the smallest opening deducted">kept</span> : ''}</span> : null}
                  <span className="tg">
                    {!ro && <button className="linkbtn" onClick={() => onEditOpening(o)}>change</button>}
                    {!ro && <button className="x" title="Remove" onClick={() => onCommit([[o.id, 'del', true]], o.k === 'door' ? 'Removed door' : 'Removed opening')}>×</button>}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** totals by tag (beams: by type) */
export function ByTag({ model, it, qty }: { model: QtoModel; it: TItem; qty: ItemQty }) {
  if (!qty.byTag.size) return null;
  // (v0.17 columns and shear walls by type too: columns their number)
  const beam = it.kind === 'beam' || isConcWall(it.sk) || isCountedStruct(it.sk) || it.sk === 'stair';
  const col = isCountedStruct(it.sk) || it.sk === 'stair';
  const rows = [...qty.byTag.entries()].sort((a, b) => tagText(model, a[0]).localeCompare(tagText(model, b[0]), undefined, { numeric: true }));
  return (
    <div className="qd-sec">
      <h5>By {it.kind === 'beam' ? 'beam type' : it.sk === 'stair' ? 'part (flights: their steps)' : col ? 'type' : isConcWall(it.sk) ? 'wall type' : 'tag'}</h5>
      <table className="qtbl bytag">
        <thead><tr><th>{beam ? 'Type' : 'Tag'}</th><th className="r">{col ? 'Number' : 'Length'}</th>{beam && <><th className="r">Volume</th><th className="r">Formwork</th><th className="r">Steel kg</th></>}</tr></thead>
        <tbody>
          {rows.map(([t, e]) => (
            <tr key={t}>
              <td>{t ? tagText(model, t) : <span className="faint">no type</span>}</td>
              <td className="r num">{col ? fq(e.segs, 'cnt') : m1(e.len)}</td>
              {beam && <><td className="r num">{e.vol ? m3(e.vol) : '—'}</td><td className="r num">{e.form ? m2(e.form) : '—'}</td><td className="r num">{e.kg ? fq(e.kg, 'kg') : '—'}</td></>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
