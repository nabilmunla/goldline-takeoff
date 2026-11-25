// v0.18 (Feedback 3, D: "how do you suggest we allow the QS to overlay the drawings ... to get the ceiling layout (or
// walls elevations) right when taking a room's quantities?") - the sheet to show over the one open: any sheet of the
// project. It is put in place by two matching points (TakeoffView), drawn over, never changed.
import { useMemo, useRef, useState } from 'react';
import type { QtoModel } from '../../engine/qto/model';
import { sheetLabel } from './Panels';
import { useDismiss } from './ListBits';

export function OverlayPicker({ model, cur, on, aligned, onPick, onOff, onClose }: {
  model: QtoModel;
  cur: { dwg: string; pg: number };
  on: { dwg: string; pg: number } | null;
  /** put in place before for the sheet open */
  aligned: (dwg: string, pg: number) => boolean;
  onPick: (dwg: string, pg: number) => void;
  onOff: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, box);
  const all = useMemo(() => {
    const out: { dwg: string; pg: number; label: string; al: boolean }[] = [];
    for (const d of model.drawings) for (let pg = 0; pg < Math.max(1, d.pages || 1); pg++) {
      // (v0.18.1 Feedback 3, D: "or a region of the same sheet such as the ceiling layout beside the floor plan")
      const self = d.id === cur.dwg && pg === cur.pg;
      out.push({ dwg: d.id, pg, label: self ? 'This sheet — a layout beside the plan (then: A part only)' : sheetLabel(model, d.id, pg), al: aligned(d.id, pg) });
    }
    // (this sheet itself first, those put in place before next, then this drawing's other pages)
    const me = (x: { dwg: string; pg: number }) => Number(x.dwg === cur.dwg && x.pg === cur.pg);
    return out.sort((a, b) => me(b) - me(a) || Number(b.al) - Number(a.al) || Number(b.dwg === cur.dwg) - Number(a.dwg === cur.dwg) || a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [model, cur.dwg, cur.pg]);
  const f = q.trim().toLowerCase();
  const list = all.filter((x) => !f || x.label.toLowerCase().includes(f)).slice(0, 80);
  return (
    <div className="tplmenu ovr-menu" ref={box} data-overmenu>
      <div className="mh">Show over this sheet</div>
      <input className="input sm" autoFocus placeholder="Find a sheet" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }} />
      <div className="ovr-list">
        {list.map((x) => (
          <button key={x.dwg + '#' + x.pg} className={'mi' + (on && on.dwg === x.dwg && on.pg === x.pg ? ' on' : '')} data-oversheet={x.label} onClick={() => onPick(x.dwg, x.pg)}>
            <span className="lb">{x.label}</span>{x.al && <span className="kb" title="Put in place before for this sheet">in place</span>}
          </button>
        ))}
        {!list.length && <div className="faint" style={{ padding: 8 }}>{all.length ? 'No sheet by that name.' : 'No other sheet in this project yet.'}</div>}
      </div>
      {on && <button className="mi" data-overnone onClick={onOff}><span className="lb">Remove the overlay</span></button>}
      <div className="faint ovr-foot">Then two clicks on each sheet put it in place. Only a picture to draw over: neither PDF changes.</div>
    </div>
  );
}
