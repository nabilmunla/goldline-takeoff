// v0.18 (Nabil, 9 Nov: "estimators should be able to understand what they are filling at a glance. or at least
// hover with mouse over a field and receive easy to understand TLDR type explanation, maybe even with visual aid")
// - a "?" next to the room's height fields: hover (or focus) shows two lines of plain words and the wall drawn in
// section, the thing the field is about picked out.
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type HelpKey = 'rmh' | 'fe' | 'hw' | 'hs' | 'ch' | 'plaster' | 'band' | 'misc' | 'elev' | 'soffit';
const TEXT: Record<HelpKey, { t: string; d: string; hi?: string }> = {
  rmh: { t: 'Room height', d: 'Finished floor to the underside of the slab (soffit). With it filled, the walls are measured by the ceiling over each stretch: up to the false ceiling plus the allowance; where there is no false ceiling, up to here.', hi: 'H' },
  fe: { t: 'Finish above false ceiling', d: 'How far the wall finish carries on above the false ceiling. 0.10 m unless you type another figure.', hi: 'E' },
  hw: { t: 'Wall finish top (override)', d: 'Leave empty: the finish follows the ceilings. Type a height only when the finish stops at one level all round the room, whatever the ceilings.', hi: 'W' },
  hs: { t: 'Skirting height', d: 'The wall finish starts at the top of the skirting. No skirting: leave empty.', hi: 'S' },
  ch: { t: 'Ceiling height', d: 'Finished floor to the false ceiling. Other ceilings drawn in the room have their own height.', hi: 'C' },
  plaster: { t: 'Plaster', d: 'Every wall from the floor up: to the soffit (default), to a typed height, or stopping where the wall finish stops. No code = not measured.', hi: 'P' },
  band: { t: 'Walls above false ceiling', d: 'From where the wall finish stops up to the soffit - only along walls that have a false ceiling. Usually anti-fungal paint; with or without plaster behind it.', hi: 'B' },
  soffit: { t: 'Soffit (slab underside)', d: 'At the Room height. Its m² = the room less the false ceilings under it (+ False ceiling: full room, or drawn). Its code is needed while any of it shows.', hi: 'H' },
  misc: { t: 'Miscellaneous items', d: 'Kitchen cabinets, wardrobes, vanities, mirrors… Each row is counted, a length (give a height and it becomes m²) or an area - measured on any sheet, or typed. Totals go to Finalize › Miscellaneous by code.' },
  elev: { t: 'Measured on its elevation', d: 'Draw the wall as an area on its elevation, then pick the plan edges it stands for: the wall finish is no longer taken along those edges (length × height) - the elevation is. Nothing is counted twice.' },
};

/** the wall in section: floor, skirting, wall finish, false ceiling, the wall above it, the soffit */
function WallSection({ hi }: { hi?: string }) {
  const on = (k: string) => (hi === k ? 'hs-on' : '');
  return (
    <svg className="wallsec" viewBox="0 0 230 150" width="230" height="150" aria-hidden="true">
      <rect x="20" y="8" width="190" height="10" className="ws-slab" />
      <text x="214" y="16" className="ws-t" textAnchor="end">soffit</text>
      <rect x="20" y="132" width="190" height="8" className="ws-slab" />
      <rect x="20" y="18" width="12" height="114" className="ws-wall" />
      <rect x="32" y="18" width="3" height="114" className={'ws-plaster ' + on('P')} />
      <rect x="35" y="122" width="5" height="10" className={'ws-skirt ' + on('S')} />
      <rect x="35" y="52" width="4" height="70" className={'ws-fin ' + on('W')} />
      <rect x="35" y="18" width="4" height="34" className={'ws-band ' + on('B')} />
      <line x1="39" y1="60" x2="150" y2="60" className={'ws-fc ' + on('C')} />
      <text x="96" y="72" className="ws-t" textAnchor="middle">false ceiling</text>
      <g className={'ws-dim ' + on('H')}><line x1="190" y1="18" x2="190" y2="132" /><path d="M187 23 L190 18 L193 23 M187 127 L190 132 L193 127" /><text x="186" y="100" textAnchor="end">room height</text></g>
      <g className={'ws-dim ' + on('C')}><line x1="140" y1="60" x2="140" y2="132" /><path d="M137 65 L140 60 L143 65 M137 127 L140 132 L143 127" /><text x="136" y="112" textAnchor="end">ceiling height</text></g>
      <g className={'ws-dim ' + on('E')}><line x1="48" y1="52" x2="48" y2="60" /><path d="M45 52 H51 M45 60 H51" /><text x="54" y="54">finish above (0.10)</text></g>
      <text x="44" y="36" className={'ws-t ' + on('B')}>wall above: anti-fungal…</text>
      <text x="44" y="96" className={'ws-t ' + on('W')}>wall finish</text>
      <text x="44" y="130" className={'ws-t ' + on('S')}>skirting</text>
    </svg>
  );
}

export function Help({ k, children }: { k: HelpKey; children?: ReactNode }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const h = TEXT[k];
  const open = (e: { currentTarget: EventTarget }) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const w = 262, hgt = h.hi ? 345 : 150;
    setAt({ x: Math.max(8, Math.min(window.innerWidth - w - 8, r.left - w - 10 > 8 ? r.left - w - 10 : r.right + 10)), y: Math.max(8, Math.min(window.innerHeight - hgt - 8, r.top - 20)) });
  };
  return (
    <span className="helpq" data-help={k} tabIndex={0} onMouseEnter={open} onMouseLeave={() => setAt(null)} onFocus={open} onBlur={() => setAt(null)} onClick={(e) => e.stopPropagation()}>
      {children ?? '?'}
      {at && createPortal(
        <div className="helpcard" data-helpcard={k} style={{ left: at.x, top: at.y }}>
          <b>{h.t}</b>
          <p>{h.d}</p>
          {h.hi && <WallSection hi={h.hi} />}
        </div>, document.body)}
    </span>
  );
}
