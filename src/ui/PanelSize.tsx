// Side panels whose width the person sets: drag the edge, double-click it for the normal width.
// Remembered per panel on this PC.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';

const read = (key: string, def: number, min: number, max: number) => {
  try {
    const v = Number(localStorage.getItem('pw:' + key));
    return Number.isFinite(v) && v > 0 ? Math.max(min, Math.min(max, v)) : def;
  } catch { return def; }
};

/**
 * width of a panel: [width, set width, the default]. `def` may change (a wider default on big
 * screens): the remembered width stays, a panel never set follows the default.
 */
export function usePanelWidth(key: string, def: number, min: number, max: number): [number, (w: number | null) => void, boolean] {
  const [w, setW] = useState<number | null>(() => { const r = read(key, -1, min, max); return r > 0 ? r : null; });
  const set = useCallback((v: number | null) => {
    const x = v === null ? null : Math.round(Math.max(min, Math.min(max, v)));
    setW(x);
    try { if (x === null) localStorage.removeItem('pw:' + key); else localStorage.setItem('pw:' + key, String(x)); } catch { /* this visit only */ }
  }, [key, min, max]);
  return [w ?? def, set, w !== null];
}

/**
 * The handle on a panel's edge. side = which edge of the PANEL it sits on: a left panel is
 * dragged at its right edge ('right'), a right panel at its left edge ('left').
 */
export function PanelEdge({ side, width, onWidth, keep = 320, title, style }: {
  side: 'left' | 'right';
  width: number;
  onWidth: (w: number | null) => void;
  /** the main area next to the panel (grid, drawing) keeps at least this much room while dragging */
  keep?: number;
  title?: string;
  style?: CSSProperties;
}) {
  const drag = useRef<{ x: number; w: number; max: number } | null>(null);
  const [active, setActive] = useState(false);
  useEffect(() => () => { document.body.classList.remove('pw-dragging'); }, []);
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // start from the width on the screen (a small window may show the panel narrower than set)
    const wrap = (e.currentTarget as HTMLElement).parentElement;
    const w0 = wrap ? wrap.getBoundingClientRect().width || width : width;
    // the panel only grows into the room the stretchy part beside it can spare
    // (in a grid - the import dialog - every other column gives way)
    const parent = wrap?.parentElement;
    const grid = !!parent && getComputedStyle(parent).display.includes('grid');
    let flex = 0, found = false;
    for (const c of Array.from(parent?.children ?? [])) {
      if (c === wrap || !(c instanceof HTMLElement)) continue;
      const g = parseFloat(getComputedStyle(c).flexGrow || '0');
      if (grid || g > 0) { found = true; flex += c.getBoundingClientRect().width; }
    }
    drag.current = { x: e.clientX, w: w0, max: found ? w0 + Math.max(0, flex - keep) : Infinity };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setActive(true);
    document.body.classList.add('pw-dragging');
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!(e.buttons & 1)) { up(); return; } // the button came up somewhere else (Alt+Tab)
    const dx = e.clientX - d.x;
    onWidth(Math.min(d.max, side === 'right' ? d.w + dx : d.w - dx));
  };
  const up = () => {
    drag.current = null;
    setActive(false);
    document.body.classList.remove('pw-dragging');
  };
  return (
    <div
      className={'pw-edge ' + side + (active ? ' on' : '')}
      style={style}
      title={title ?? 'Drag to make this panel wider or narrower — double-click for the normal width'}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onDoubleClick={() => onWidth(null)}
      role="separator"
      aria-orientation="vertical"
    />
  );
}
