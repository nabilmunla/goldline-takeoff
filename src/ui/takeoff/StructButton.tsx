// v0.17 (Nabil, 9 Nov: "need to add new structural tools ... and now the tools bar is crowded") - the structural
// elements in one tool bar button: it measures the last one picked; ▾ lists them all.
import { useState } from 'react';
import { TIcon } from './ticons';
import { PopMenu } from './Sheets16';

export type StructTool = 'beam' | 'col' | 'sw' | 'slab' | 'drop' | 'shear' | 'ftg' | 'raft' | 'stair' | 'sog' | 'rw';
export const STRUCT_TOOLS: { k: StructTool; label: string; icon: string; key?: string; hint: string; grp?: string }[] = [
  { k: 'beam', label: 'Beam', icon: 'beam', key: 'E', hint: 'Beams by type: concrete, formwork, steel (upstands: tick "Upstand" on the take-off)' },
  { k: 'col', label: 'Column', icon: 'column', hint: 'Click each column: its type from the column schedule (or all at once from the C1, C2 marks on the sheet), × the height' },
  { k: 'sw', label: 'Shear wall', icon: 'swall', hint: 'Click each shear wall, like columns: its type gives length × thickness, × the height' },
  { k: 'shear', label: 'Core wall', icon: 'shear', hint: 'Draw it as a wall: length × height × its type\'s thickness; formwork both faces; D / O for openings' },
  { k: 'rw', label: 'Retaining wall', icon: 'rw', hint: 'Draw it as a wall: length × height × its type\'s thickness; formwork both faces; waterproofing on one face or both, under it; D / O for openings' },
  { k: 'slab', label: 'Slab', icon: 'slab', hint: 'Draw the slab as an area: × its thickness = concrete; soffit and edges = formwork; steel by ratio; A254 mesh as an option', grp: 'Floors' },
  { k: 'sog', label: 'Slab on grade', icon: 'sog', hint: 'Draw it as an area: × its thickness = concrete; edges = formwork; mesh, waterproofing, blinding and polythene under it as options' },
  { k: 'drop', label: 'Drop panel', icon: 'drop', hint: 'Draw the drop panel as an area: × its depth below the slab; soffit and sides = formwork' },
  { k: 'stair', label: 'Stair', icon: 'stair', hint: 'Draw each flight and landing as an area on the plan: steps, waist and landings worked out from tread, riser and thicknesses' },
  { k: 'ftg', label: 'Footing', icon: 'footing', hint: 'Click each footing: its type from the footing schedule gives L × W × D; formwork to its sides', grp: 'Foundations' },
  { k: 'raft', label: 'Raft / drawn footing', icon: 'footing', hint: 'Draw a raft, a strip or an irregular footing as an area: × its thickness; formwork to its sides' },
];

export function StructButton({ on, last, readOnly, onPick }: { on: StructTool | ''; last: StructTool; readOnly: boolean; onPick: (t: StructTool) => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const cur = STRUCT_TOOLS.find((t) => t.k === (on || last))!;
  return (
    <span className={'qtool-split' + (on ? ' on' : '')} data-struct data-cat="struct">
      <button className={'qtool' + (on ? ' on' : '')} data-cat="struct" disabled={readOnly} data-structmain={cur.k} title={`${cur.label}${cur.key ? ' (' + cur.key + ')' : ''} — ${cur.hint}. ▾ for the other structural elements`} onClick={() => onPick(cur.k)}>
        <TIcon k={cur.icon} />
        <span>{cur.label}</span>
      </button>
      <button className="qtool caret" disabled={readOnly} data-structmenu title="Structural elements: beams, columns, shear walls, core walls, slabs, drop panels, stairs, footings, rafts" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: r.left - 60, y: r.bottom + 4 }); }}>▾</button>
      {menu && (
        <PopMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} className="structmenu">
          <div className="mh">Structure</div>
          {STRUCT_TOOLS.map((t) => (
            <span key={t.k}>
              {t.grp && <div className="mh sub">{t.grp}</div>}
              <button className="mi" data-structpick={t.k} title={t.hint} onClick={() => { setMenu(null); onPick(t.k); }}>
                <span className="ck"><TIcon k={t.icon} size={13} /></span><span className="lb">{t.label}</span>{t.key && <span className="kb">{t.key}</span>}
              </button>
            </span>
          ))}
        </PopMenu>
      )}
    </span>
  );
}
