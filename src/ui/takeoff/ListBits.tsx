// v0.16 (group b2): small pieces of the take-off list - menus that close on a click outside or Esc, the
// eye (show / hide on the drawing), the ▶ / ■ measure button, and the delete question.
import { allWins } from '../popout';
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Modal } from './Dialogs';
import { TIcon } from './ticons';

// menus / popovers open now: Esc is theirs. The drawing's keys are on the window in the capture phase and
// registered first, so they see Esc before any menu: they ask anyMenuOpen() and leave the key alone.
export { menuOpened, anyMenuOpen } from './menus';
import { menuOpened } from './menus';

/**
 * Close a menu / popover on a press outside it (and outside `keep`, e.g. the button that opens it) or on
 * Esc - not when the pointer leaves it. Esc closes only the menu (nothing behind it sees the key).
 */
export function useDismiss(open: boolean, onClose: () => void, ...keep: RefObject<HTMLElement | null>[]) {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && keep.some((r) => r.current?.contains(t))) return;
      cb.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cb.current();
    };
    // (after the click that opened it; v0.16.2 in either window - the drawing may be in its own)
    const ws = allWins();
    const t = setTimeout(() => { for (const w of ws) w.addEventListener('mousedown', down, true); }, 0);
    for (const w of ws) w.addEventListener('keydown', key, true);
    const off = menuOpened();
    return () => { off(); clearTimeout(t); for (const w of ws) { w.removeEventListener('mousedown', down, true); w.removeEventListener('keydown', key, true); } };
  }, [open]);
}

/** one line of a menu; `sep` = a divider line */
export type MenuEntry =
  | { sep: true }
  | { label: ReactNode; on: (at: { x: number; y: number }) => void; icon?: ReactNode; kb?: string; danger?: boolean; disabled?: boolean; title?: string; key?: string };

/** a menu made from a list: one entry = one line (so adding an entry is one line) */
export function MenuList({ entries, close }: { entries: (MenuEntry | null | false | undefined)[]; close: () => void }) {
  return (
    <>
      {entries.filter(Boolean).map((e, i) => {
        const x = e as MenuEntry;
        if ('sep' in x) return <div key={'s' + i} className="msep" />;
        return (
          <button key={x.key ?? i} className={'mi' + (x.danger ? ' danger' : '')} disabled={x.disabled} title={x.title} onClick={(ev) => { close(); x.on({ x: ev.clientX, y: ev.clientY }); }}>
            <span className="ck">{x.icon}</span><span className="lb">{x.label}</span>{x.kb && <span className="kb">{x.kb}</span>}
          </button>
        );
      })}
    </>
  );
}

const eyePath = 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z';
/** the eye: all shown / none / some (half-faded); faded = a heading above it is hidden */
export function EyeBtn({ state, faded, onClick, title }: { state: 'all' | 'none' | 'mixed'; faded?: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      className={'eyebtn ' + state + (faded ? ' faded' : '')}
      data-eye={state}
      title={title ?? (state === 'none' ? 'Hidden on the drawing — click to show' : state === 'mixed' ? 'Some of it is hidden on the drawing — click to hide all' : 'Shown on the drawing — click to hide')}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      draggable={false}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {state === 'none' ? (
          <>
            <path d={eyePath} opacity={0.45} />
            <path d="M2.5 13.5l11-11" />
          </>
        ) : state === 'mixed' ? (
          <>
            <path d={eyePath} opacity={0.5} />
            <path d="M8 3.5a4.5 4.5 0 000 9" />
            <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" opacity={0.5} />
          </>
        ) : (
          <>
            <path d={eyePath} />
            <circle cx="8" cy="8" r="1.8" />
          </>
        )}
      </svg>
    </button>
  );
}

/** ▶ = measure into this take-off; ■ while it is the one being measured (click = stop) */
export function PlayBtn({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      className={'playbtn' + (on ? ' on' : '')}
      data-play={on ? 'stop' : 'start'}
      disabled={disabled}
      title={on ? 'Stop measuring into this take-off (Esc)' : 'Measure into this take-off'}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      draggable={false}
    >
      {on ? <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><rect x="2" y="2" width="8" height="8" rx="1" fill="currentColor" /></svg>
        : <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M3 1.8v8.4L10.2 6z" fill="currentColor" /></svg>}
    </button>
  );
}

/** "Delete … and all its measurements?" - Cancel has the keyboard (Enter = Cancel) */
export function DeleteDialog({ title, detail, onDelete, onClose }: { title: string; detail: string; onDelete: () => void; onClose: () => void }) {
  const del = useRef<HTMLButtonElement>(null);
  return (
    <Modal title={title} sub={detail} onClose={onClose}>
      <div
        className="actions"
        data-confirm-delete
        onKeyDown={(e) => {
          // Enter anywhere but on Delete itself is Cancel
          if (e.key === 'Enter' && e.target !== del.current) { e.preventDefault(); e.stopPropagation(); onClose(); }
        }}
      >
        <div className="grow" />
        <button className="btn" autoFocus onClick={onClose}>Cancel</button>
        <button ref={del} className="btn danger" onClick={onDelete}><TIcon k="x" size={13} /> Delete</button>
      </div>
    </Modal>
  );
}

/**
 * v0.17.1 (Feedback 3: "dragging a measurement item will not scroll up or down ... the scrolling should be not too
 * fast") - a list scrolls by itself while something is dragged near its top or bottom edge: slowly at the edge of
 * the zone, faster right at the border (at most ~9 px a frame).
 */
export function useDragAutoScroll(ref: RefObject<HTMLElement | null>, zone = 56) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let v = 0, raf = 0;
    const step = () => { raf = 0; if (!v) return; el.scrollTop += v; raf = requestAnimationFrame(step); };
    const over = (e: DragEvent) => {
      const r = el.getBoundingClientRect();
      const top = e.clientY - r.top, bot = r.bottom - e.clientY;
      const speed = (d: number) => Math.max(1.5, Math.min(9, ((zone - d) / zone) * 9));
      v = top < zone && el.scrollTop > 0 ? -speed(Math.max(0, top)) : bot < zone && el.scrollTop + el.clientHeight < el.scrollHeight - 1 ? speed(Math.max(0, bot)) : 0;
      if (v && !raf) raf = requestAnimationFrame(step);
    };
    const stop = () => { v = 0; };
    el.addEventListener('dragover', over);
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget as Node | null)) stop(); });
    el.addEventListener('drop', stop);
    window.addEventListener('dragend', stop, true);
    return () => { stop(); if (raf) cancelAnimationFrame(raf); el.removeEventListener('dragover', over); el.removeEventListener('drop', stop); window.removeEventListener('dragend', stop, true); };
  }, []);
}
