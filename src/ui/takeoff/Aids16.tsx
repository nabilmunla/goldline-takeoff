// v0.16 group a: the tool bar's AIDS group (Snap G · Ortho F8 · Crosshair · Magnifier M), its "?" list
// of keys (from keymap.ts, the same as F1), the scale chip's menu with Clear scale, and its question.
import { allWins } from '../popout';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { menuOpened } from './ListBits';
import { TIcon } from './ticons';
import { setAids, useAids } from './aids';
import { QTO_KEYS } from './keymap';
import { Keys } from '../Help';
import { Modal } from './Dialogs';

const Svg = ({ children }: { children: ReactNode }) => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);
export const AID_ICON = {
  ortho: <Svg><path d="M3 2.5v10.5h10.5" /><path d="M3 9.5h3.5V13" /></Svg>,
  cross: <Svg><path d="M8 1.5v13M1.5 8h13" /><circle cx="8" cy="8" r="2.2" /></Svg>,
  loupe: <Svg><circle cx="6.8" cy="6.8" r="4.6" /><path d="M10.2 10.2l4 4" /><path d="M6.8 5v3.6M5 6.8h3.6" strokeWidth={1.2} /></Svg>,
};

/** a popover / menu closes on a click outside it or Esc (UI rule 6) */
export function useDismiss(open: boolean, onClose: () => void, ...inside: React.RefObject<HTMLElement>[]) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!inside.some((r) => r.current?.contains(e.target as Node))) close.current(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); } };
    // (v0.16.2 in either window - the drawing may be in its own)
    const ws = allWins();
    for (const w of ws) { w.addEventListener('mousedown', down, true); w.addEventListener('keydown', key, true); }
    const off = menuOpened();
    return () => { off(); for (const w of ws) { w.removeEventListener('mousedown', down, true); w.removeEventListener('keydown', key, true); } };
  }, [open]);
}

/** Snap · Ortho · Crosshair · Magnifier: toggles, their state always shown */
export function AidsGroup({ snapOn, snapState, onSnap }: { snapOn: boolean; snapState: 'off' | 'preparing' | 'ready' | 'failed'; onSnap: () => void }) {
  const a = useAids();
  return (
    <div className="qto-tools aids" data-aids>
      <button className={'qtool aux' + (snapOn ? ' on snap' : '')} data-aid="snap" title={snapOn && snapState === 'failed' ? 'Snapping is not available on this sheet (its line work could not be read). Points go where you click.' : "Snap to the drawing's lines and nodes (G)"} onClick={onSnap}>
        <TIcon k="snap" />
        <span>{snapOn ? (snapState === 'preparing' ? 'Snap…' : snapState === 'failed' ? 'No snap here' : 'Snap') : 'Snap off'}</span>
      </button>
      <button className={'qtool aux' + (a.ortho ? ' on aid' : '')} data-aid="ortho" aria-pressed={a.ortho} title="Ortho (F8): horizontal and vertical only, and ⊥ onto a take-off near the pointer. Hold Shift for the moment." onClick={() => setAids({ ortho: !a.ortho })}>
        {AID_ICON.ortho}
        <span>{a.ortho ? 'Ortho' : 'Ortho off'}</span>
      </button>
      <button className={'qtool aux' + (a.cross ? ' on aid' : '')} data-aid="cross" aria-pressed={a.cross} title="Crosshair: lines across the whole sheet through the pointer" onClick={() => setAids({ cross: !a.cross })}>
        {AID_ICON.cross}
        <span>Crosshair</span>
      </button>
      <button className={'qtool aux' + (a.loupe ? ' on aid' : '')} data-aid="loupe" aria-pressed={a.loupe} title={`Magnifier (M): a loupe next to the pointer, ×${a.zoom} — Alt+wheel for more / less`} onClick={() => setAids({ loupe: !a.loupe })}>
        {AID_ICON.loupe}
        <span>{a.loupe ? 'Magnifier ×' + a.zoom : 'Magnifier'}</span>
      </button>
    </div>
  );
}

/** the tool bar's "?": every key and gesture of the take-off (the same table as F1) */
export function KeysButton() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  return (
    <div className="tplwrap" ref={box}>
      <button className={'btn icon ghost' + (open ? ' on' : '')} title="Keyboard and mouse (the full list: F1)" onClick={() => setOpen((x) => !x)}>?</button>
      {open && (
        <div className="keyshelp v16" data-pop>
          {QTO_KEYS.map((s) => (
            <section key={s.title}>
              <h5>{s.title}</h5>
              {s.rows.map((r, i) => (
                <div key={i} className="kh-row">
                  <span className="kh-keys">{r.keys.map((k, j) => <span key={j}>{j > 0 && <span className="kh-or">/</span>}<Keys k={k} /></span>)}</span>
                  <span className="kh-what">{r.what}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The scale chip of a sheet with a scale: a click measures it again (as before); its ▾ opens the menu -
 * set it again, or clear it
 */
export function ScaleChip({ label, warn, title, readOnly, onSet, onClear }: { label: ReactNode; warn: boolean; title: string; readOnly: boolean; onSet: () => void; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  return (
    <div className="tplwrap scalesplit" ref={box}>
      <button className={'scalechip ' + (warn ? 'warn' : 'ok')} disabled={readOnly} onClick={onSet} title={title}>
        <TIcon k="scale" /> {label}
      </button>
      <button className={'scalecaret ' + (warn ? 'warn' : 'ok') + (open ? ' on' : '')} disabled={readOnly} onClick={() => setOpen((x) => !x)} title="More: set the scale again, or clear it">▾</button>
      {open && (
        <div className="revmenu scalemenu" data-pop>
          <button className="mi" onClick={() => { setOpen(false); onSet(); }}><span className="lb">Set the scale again…</span><kbd>S</kbd></button>
          <button className="mi danger" onClick={() => { setOpen(false); onClear(); }}><span className="lb">Clear scale<span className="d">this sheet’s own scale, both ways — viewports keep theirs</span></span></button>
        </div>
      )}
    </div>
  );
}

/** shapes measured on the sheet lose their quantity until a scale is set again: ask first */
export function ClearScaleDialog({ n, label, onCancel, onClear }: { n: number; label: string; onCancel: () => void; onClear: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  return (
    <Modal title={`Clear the scale ${label}?`} onClose={onCancel}>
      <p>{n} shape{n === 1 ? '' : 's'} on this sheet will have no scale until you set it again.</p>
      <div className="actions">
        <button ref={cancel} className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn dangerfill" data-clearscale onClick={onClear}>Clear scale</button>
      </div>
    </Modal>
  );
}
