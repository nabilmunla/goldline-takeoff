// v0.16 (group b2, item 13): a colour picker - the take-off colours, a fuller standard palette, a colour
// of your own by hex or R / G / B, and the colours used last on this PC. For take-offs and beam types.
import { activeWin } from '../popout';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ITEM_COLORS } from '../../engine/qto/model';
import { useDismiss } from './ListBits';

/** 10 hues x 4 shades, then greys */
export const STANDARD_COLORS = [
  '#ffc9c9', '#ffd8a8', '#ffec99', '#d8f5a2', '#b2f2bb', '#96f2d7', '#99e9f2', '#a5d8ff', '#d0bfff', '#fcc2d7',
  '#ff6b6b', '#ff922b', '#fcc419', '#94d82d', '#51cf66', '#20c997', '#22b8cf', '#339af0', '#845ef7', '#f06595',
  '#f03e3e', '#f76707', '#f59f00', '#66a80f', '#37b24d', '#0ca678', '#1098ad', '#1c7ed6', '#7048e8', '#d6336c',
  '#c92a2a', '#d9480f', '#e67700', '#5c940d', '#2b8a3e', '#087f5b', '#0b7285', '#1864ab', '#5f3dc4', '#a61e4d',
  '#000000', '#343a40', '#495057', '#868e96', '#adb5bd', '#ced4da', '#dee2e6', '#e9ecef', '#f8f9fa', '#ffffff',
];

const RECENT_KEY = 'qto.recentColours';
const RECENT_MAX = 10;
export const recentColours = (): string[] => {
  try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && normHex(x)).slice(0, RECENT_MAX) : []; } catch { return []; }
};
const pushRecent = (c: string) => {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([c, ...recentColours().filter((x) => x !== c)].slice(0, RECENT_MAX))); } catch { /* */ }
};

/** "#abc", "abc", "#AABBCC" -> "#aabbcc"; null when it is not a colour */
export function normHex(s: string): string | null {
  const t = s.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(t)) return '#' + t.split('').map((c) => c + c).join('');
  if (/^[0-9a-f]{6}$/.test(t)) return '#' + t;
  return null;
}
export const rgbOf = (hex: string): [number, number, number] => {
  const h = normHex(hex) ?? '#000000';
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
};
export const hexOf = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v || 0))).toString(16).padStart(2, '0')).join('');

/** a colour swatch button that opens the picker; onPick is called once, with the colour chosen */
export function ColorButton({ value, onPick, disabled, title, className, mixed }: { value: string; onPick: (c: string) => void; disabled?: boolean; title?: string; className?: string; mixed?: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={(className ?? 'swbtn') + (mixed ? ' mixed' : '') + (open ? ' open' : '')}
        style={mixed ? undefined : { background: value }}
        title={mixed ? 'Multiple colours — pick one for all' : title ?? 'Colour'}
        disabled={disabled}
        data-colorbtn
        onClick={() => setOpen((x) => !x)}
      />
      {open && btn.current && <ColorPop anchor={btn.current} value={mixed ? '' : value} anchorRef={btn} onClose={() => setOpen(false)} onPick={(c) => { setOpen(false); pushRecent(c); onPick(c); }} />}
    </>
  );
}

function ColorPop({ anchor, anchorRef, value, onClose, onPick }: { anchor: HTMLElement; anchorRef: React.RefObject<HTMLButtonElement | null>; value: string; onClose: () => void; onPick: (c: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, box, anchorRef);
  const [hex, setHex] = useState(value || '#1c7ed6');
  const [rgb, setRgb] = useState<[string, string, string]>(() => rgbOf(value || '#1c7ed6').map(String) as [string, string, string]);
  const recent = useState(recentColours)[0];
  const r = anchor.getBoundingClientRect();
  const [pos, setPos] = useState({ left: r.left, top: r.bottom + 6 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    let top = pos.top, left = pos.left;
    if (b.bottom > activeWin().innerHeight - 8) top = Math.max(8, r.top - 6 - b.height);
    if (b.right > activeWin().innerWidth - 8) left = Math.max(8, activeWin().innerWidth - 8 - b.width);
    if (top !== pos.top || left !== pos.left) setPos({ top, left });
  }, []);
  const custom = normHex(hex);
  const setFromRgb = (i: number, v: string) => {
    const n = [...rgb] as [string, string, string];
    n[i] = v.replace(/[^0-9]/g, '').slice(0, 3);
    setRgb(n);
    setHex(hexOf(Number(n[0]), Number(n[1]), Number(n[2])));
  };
  const setFromHex = (v: string) => {
    setHex(v);
    const h = normHex(v);
    if (h) setRgb(rgbOf(h).map(String) as [string, string, string]);
  };
  const sw = (c: string, k: string) => (
    <button key={k} type="button" className={'cp-sw' + (c === value ? ' on' : '')} style={{ background: c }} title={c} data-colour={c} onClick={() => onPick(c)} />
  );
  return createPortal(
    <div ref={box} className="cpick" style={{ left: pos.left, top: pos.top }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div className="cp-h">Take-off colours</div>
      <div className="cp-grid">{ITEM_COLORS.map((c) => sw(c, 'i' + c))}</div>
      <div className="cp-h">Standard</div>
      <div className="cp-grid ten">{STANDARD_COLORS.map((c) => sw(c, 's' + c))}</div>
      {recent.length > 0 && (
        <>
          <div className="cp-h">Recent</div>
          <div className="cp-grid ten" data-recent>{recent.map((c) => sw(c, 'r' + c))}</div>
        </>
      )}
      <div className="cp-h">Your own</div>
      <div className="cp-own" onKeyDown={(e) => { if (e.key === 'Enter' && custom) { e.preventDefault(); onPick(custom); } }}>
        <i className="cp-prev" style={{ background: custom ?? 'transparent' }} />
        <label>#<input className="input xs" data-hex value={hex.replace(/^#/, '')} onChange={(e) => setFromHex('#' + e.target.value.replace(/^#/, ''))} maxLength={7} spellCheck={false} /></label>
        {(['R', 'G', 'B'] as const).map((l, i) => (
          <label key={l}>{l}<input className="input xs num" data-rgb={l} value={rgb[i]} onChange={(e) => setFromRgb(i, e.target.value)} onBlur={() => setRgb(rgbOf(hex).map(String) as [string, string, string])} /></label>
        ))}
        <button type="button" className="btn sm" disabled={!custom} onClick={() => custom && onPick(custom)}>Use</button>
      </div>
    </div>,
    // (the window its button is in - the drawing's own window too, v0.16.3)
    anchor.ownerDocument.body,
  );
}
