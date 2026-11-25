// v0.16 drawing management: the tabs of open sheets, the drawing row menu, and "Go to sheet" for a take-off.
import { activeWin } from '../popout';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { menuOpened } from './ListBits';
import { itemQty, mainMeasure, measureOf, MEASURE_UNIT, isOldBinder, sheetTitle, pageKey, type QtoModel, type Shape } from '../../engine/qto/model';
import { pageSheetId } from '../../engine/qto/revisions';
import { leavesInOrder } from '../../engine/qto/headings';
import { q as fq, useQtoFmt } from './numfmt';
import { fitOnScreen } from './ItemTree';
import { TIcon } from './ticons';
import { HScroll } from './Scroller';

/** a tab: the sheet it shows (PgUp / PgDn move it through the sheets); fl (v0.16.4): in its own window */
/** fl: in its own window; sd (v0.18.1, Feedback 3 D Phase 1): in the pane beside the main one, in this window */
export interface SheetTab { id: string; dwg: string; pg: number; fl?: boolean; sd?: boolean }
/** at most this many tabs: opening one more closes the one used longest ago */
export const MAX_TABS = 10;

/** what a tab says: the sheet number, else its title (a page of a drawing from before 0.16: its page) */
export function tabLabel(m: QtoModel, t: { dwg: string; pg: number }): { label: string; tip: string } {
  // (v0.17.1 a new, empty tab: the drawing picked next opens in it)
  if (!t.dwg) return { label: 'New tab', tip: 'Pick a drawing in the list: it opens in this tab' };
  const d = m.dwgById.get(t.dwg);
  if (!d) return { label: '…', tip: '' };
  const pg = isOldBinder(d) ? ' p' + (t.pg + 1) : '';
  const title = sheetTitle(d);
  return { label: (d.sheet || title) + pg, tip: [d.sheet, title].filter(Boolean).join(' · ') + pg };
}

/**
 * Tabs, LRU and all, as plain functions (the screen and the tests run the same): open a sheet (its tab if it has
 * one, else a new tab - the one used longest ago closed past MAX_TABS), close one (the one used last before it comes
 * up), move the current tab to another sheet (PgUp / PgDn).
 */
export function openTab(tabs: SheetTab[], used: string[], s: { dwg: string; pg: number }, newId: () => string, dup = false): { tabs: SheetTab[]; used: string[]; cur: string } {
  // (v0.17.1 dup: a second tab on the same sheet - "Duplicate")
  const have = dup ? undefined : tabs.find((t) => t.dwg === s.dwg && t.pg === s.pg);
  if (have) return { tabs, used: [...used.filter((x) => x !== have.id), have.id], cur: have.id };
  const t: SheetTab = { id: newId(), dwg: s.dwg, pg: s.pg };
  let next = [...tabs, t];
  let u = [...used.filter((x) => next.some((y) => y.id === x)), t.id];
  while (next.length > MAX_TABS) {
    // (a tab never used - restored from before - counts as used longest ago; a tab in its own window is never
    // closed by itself - the person put it there)
    const docked = (x: SheetTab) => x.id !== t.id && !x.fl && !x.sd;
    const old = next.find((x) => docked(x) && !u.includes(x.id)) ?? next.find((x) => docked(x) && x.id === u.find((id) => next.some((y) => y.id === id && docked(y)))) ?? next.find(docked);
    // (every other tab is in a window of its own: one tab more than the limit, rather than a window closed)
    if (!old) break;
    next = next.filter((x) => x.id !== old.id);
    u = u.filter((x) => x !== old.id);
  }
  return { tabs: next, used: u, cur: t.id };
}
/** v0.17.1 the + button: a new, empty tab (the one there already, if any) - the drawing picked next opens in it */
export function emptyTab(tabs: SheetTab[], used: string[], newId: () => string): { tabs: SheetTab[]; used: string[]; cur: string } {
  const have = tabs.find((t) => !t.dwg && !t.fl && !t.sd);
  if (have) return { tabs, used: [...used.filter((x) => x !== have.id), have.id], cur: have.id };
  const t: SheetTab = { id: newId(), dwg: '', pg: 0 };
  return { tabs: [...tabs, t], used: [...used, t.id], cur: t.id };
}
/** v0.17.1 a tab dragged along the strip: before / after another */
export function moveTab(tabs: SheetTab[], id: string, to: string, after: boolean): SheetTab[] {
  if (id === to) return tabs;
  const t = tabs.find((x) => x.id === id);
  if (!t || !tabs.some((x) => x.id === to)) return tabs;
  const rest = tabs.filter((x) => x.id !== id);
  const i = rest.findIndex((x) => x.id === to) + (after ? 1 : 0);
  return [...rest.slice(0, i), t, ...rest.slice(i)];
}
/** v0.17.1 "Close others": that tab stays - and the tabs in their own windows (the person put them there) */
export function closeOthers(tabs: SheetTab[], used: string[], id: string): { tabs: SheetTab[]; used: string[]; cur: string | null } {
  const next = tabs.filter((t) => t.id === id || t.fl || t.sd);
  return { tabs: next, used: used.filter((x) => next.some((t) => t.id === x)), cur: next.some((t) => t.id === id) ? id : next[0]?.id ?? null };
}
export function closeTab(tabs: SheetTab[], used: string[], id: string, cur: string | null): { tabs: SheetTab[]; used: string[]; cur: string | null } {
  const next = tabs.filter((t) => t.id !== id);
  const u = used.filter((x) => x !== id && next.some((t) => t.id === x));
  if (cur !== id) return { tabs: next, used: u, cur: next.some((t) => t.id === cur) ? cur : null };
  const i = tabs.findIndex((t) => t.id === id);
  const back = u[u.length - 1] ?? next[Math.min(i, next.length - 1)]?.id ?? null;
  return { tabs: next, used: u, cur: back };
}
/**
 * the sheet a tab (or the sheet remembered from last time) shows now: the same, or - its drawing split into
 * separate sheets since (by anyone, here or on another PC) - its page's sheet; null: the sheet is gone
 */
export function tabTarget(m: Pick<QtoModel, 'dwgById' | 'removedDwg'>, t: { dwg: string; pg: number }): { dwg: string; pg: number } | null {
  if (m.dwgById.has(t.dwg)) return t;
  const p = m.removedDwg.has(t.dwg) ? pageSheetId(t.dwg, t.pg) : '';
  return p && m.dwgById.has(p) ? { dwg: p, pg: 0 } : null;
}
export function retarget(tabs: SheetTab[], id: string, s: { dwg: string; pg: number }): SheetTab[] {
  return tabs.map((t) => (t.id === id ? { ...t, dwg: s.dwg, pg: s.pg } : t));
}
/** v0.16.4 a tab into its own window (fl) or back into the main window */
export function floatTab(tabs: SheetTab[], id: string, fl: boolean): SheetTab[] {
  return tabs.map((t) => (t.id === id ? (fl ? { ...t, fl: true } : { id: t.id, dwg: t.dwg, pg: t.pg }) : t));
}
/** the main window's tab: the current one when it is there, else the one used last there (else its first) */
export function mainTabOf(tabs: SheetTab[], used: string[], cur: string | null): string | null {
  const here = (id: string | null) => !!id && tabs.some((t) => t.id === id && !t.fl && !t.sd);
  if (here(cur)) return cur;
  for (let i = used.length - 1; i >= 0; i--) if (here(used[i])) return used[i];
  return tabs.find((t) => !t.fl && !t.sd)?.id ?? null;
}
/** a screen point inside a box (a tab dropped on the main window's tab strip; some room above and below) */
export function overStrip(p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number } | null, slack = 24): boolean {
  return !!r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y - slack && p.y <= r.y + r.h + slack;
}

/** a press on a tab that turns into a drag (beyond a few pixels): where it went, where it ended */
function useTabDrag(o: { onMove?: (e: PointerEvent, out: boolean) => void; onDrop: (e: PointerEvent, out: boolean) => void }) {
  const st = useRef<{ x: number; y: number; on: boolean; el: HTMLElement; id: number } | null>(null);
  const dragged = useRef(false);
  const outside = (e: PointerEvent) => {
    const w = (e.view ?? window) as Window;
    return e.clientX < 0 || e.clientY < 0 || e.clientX > w.innerWidth || e.clientY > w.innerHeight;
  };
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const el = e.currentTarget as HTMLElement;
    st.current = { x: e.clientX, y: e.clientY, on: false, el, id: e.pointerId };
    dragged.current = false;
    try { el.setPointerCapture(e.pointerId); } catch { /* fine */ }
  };
  const move = (e: React.PointerEvent) => {
    const s = st.current;
    if (!s) return;
    if (!s.on && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 6) { s.on = true; dragged.current = true; }
    if (s.on) o.onMove?.(e.nativeEvent, outside(e.nativeEvent));
  };
  const up = (e: React.PointerEvent) => {
    const s = st.current;
    st.current = null;
    try { s?.el.releasePointerCapture(e.pointerId); } catch { /* fine */ }
    if (s?.on) o.onDrop(e.nativeEvent, outside(e.nativeEvent));
  };
  const cancel = () => { st.current = null; };
  return { handlers: { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: cancel, onLostPointerCapture: cancel }, dragged };
}

export function SheetTabs({ model, tabs, cur, onPick, onClose, onAdd, onUndock, onShowFloat, dropHere, onMove, onCloseOthers, onDuplicate, onSide }: {
  model: QtoModel;
  tabs: SheetTab[];
  cur: string | null;
  onPick: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  /** v0.16.4 into its own window (at: where it was dropped, on the screen) */
  onUndock?: (id: string, at?: { x: number; y: number }) => void;
  /** a tab in its own window: that window to the front */
  onShowFloat?: (id: string) => void;
  /** a tab from a sheet window is being dragged over the strip */
  dropHere?: boolean;
  /** v0.17.1 Explorer-style tabs: dragged along the strip, Close others, Duplicate */
  onMove?: (id: string, to: string, after: boolean) => void;
  onCloseOthers?: (id: string) => void;
  onDuplicate?: (id: string) => void;
  /** v0.18.1 into the pane beside the main one (and back) */
  onSide?: (id: string, on: boolean) => void;
}) {
  const [tear, setTear] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  // the tab in use is kept in view
  useEffect(() => { if (cur) document.querySelector(`[data-maintabs] [data-tab="${CSS.escape(cur)}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [cur, tabs.length]);
  if (!tabs.length) return null;
  const mt = menu ? tabs.find((t) => t.id === menu.id) : null;
  return (
    <HScroll className={'qto-tabs' + (dropHere ? ' drophere' : '')} wrapClass="qto-tabwrap" attrs={{ role: 'tablist', 'aria-label': 'Open sheets', 'data-maintabs': true }}>
      {tabs.map((t) => (
        <OneTab key={t.id} model={model} t={t} on={t.id === cur} tear={tear === t.id} setTear={setTear} onPick={onPick} onClose={onClose} onUndock={onUndock} onShowFloat={onShowFloat}
          dropCls={dropAt && dropAt.id === t.id ? (dropAt.after ? ' drop-r' : ' drop-l') : ''} setDropAt={setDropAt} onMove={onMove} onMenu={(x, y) => setMenu({ id: t.id, x, y })} />
      ))}
      <button className="qtab-add" data-tabadd title="New tab: then pick the drawing in the list (middle-click a drawing opens it in a new tab at once)" onClick={onAdd}>+</button>
      {dropHere && <span className="qtab-drophint">Release: back into this window</span>}
      {menu && mt && (
        <PopMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button className="mi" data-tabmenu="close" onClick={() => { setMenu(null); onClose(mt.id); }}><span className="ck" /><span className="lb">Close</span><span className="kb">Ctrl+W</span></button>
          <button className="mi" data-tabmenu="others" disabled={tabs.filter((t) => !t.fl).length < 2} onClick={() => { setMenu(null); onCloseOthers?.(mt.id); }}><span className="ck" /><span className="lb">Close others</span></button>
          <button className="mi" data-tabmenu="dup" disabled={!mt.dwg} onClick={() => { setMenu(null); onDuplicate?.(mt.id); }} title="A second tab on the same sheet: another part of it side by side (give one its own window)"><span className="ck" /><span className="lb">Duplicate</span></button>
          {!mt.fl && mt.dwg && onSide && <button className="mi" data-tabmenu="side" onClick={() => { setMenu(null); onSide(mt.id, !mt.sd); }} title="Two sheets (or two parts of one: Duplicate first) next to each other in this window, each with its own zoom"><span className="ck">◧</span><span className="lb">{mt.sd ? 'Back from the side' : 'Side by side'}</span></button>}
          {!mt.fl && mt.dwg && onUndock && <button className="mi" data-tabmenu="pop" onClick={() => { setMenu(null); onUndock(mt.id); }}><span className="ck">⧉</span><span className="lb">Open in its own window</span></button>}
        </PopMenu>
      )}
    </HScroll>
  );
}

function OneTab({ model, t, on, tear, setTear, onPick, onClose, onUndock, onShowFloat, dropCls, setDropAt, onMove, onMenu }: {
  model: QtoModel; t: SheetTab; on: boolean; tear: boolean; setTear: (id: string | null) => void;
  onPick: (id: string) => void; onClose: (id: string) => void;
  onUndock?: (id: string, at?: { x: number; y: number }) => void; onShowFloat?: (id: string) => void;
  dropCls: string; setDropAt: (d: { id: string; after: boolean } | null) => void; onMove?: (id: string, to: string, after: boolean) => void; onMenu: (x: number, y: number) => void;
}) {
  const { label, tip } = tabLabel(model, t);
  /** the tab under the pointer while this one is dragged along the strip (and which half of it) */
  const over = (e: PointerEvent): { id: string; after: boolean } | null => {
    const el = (document.elementsFromPoint(e.clientX, e.clientY).find((x) => (x as HTMLElement).dataset?.tab && (x as HTMLElement).dataset.tab !== t.id) ?? null) as HTMLElement | null;
    if (!el || !el.closest('[data-maintabs]')) return null;
    const r = el.getBoundingClientRect();
    return { id: el.dataset.tab!, after: e.clientX > r.left + r.width / 2 };
  };
  // (dragged out of the window: it opens in its own window where it was let go; along the strip: it moves there)
  const drag = useTabDrag({
    onMove: (e, out) => { setTear(out && !t.fl && onUndock && t.dwg ? t.id : null); setDropAt(out ? null : over(e)); },
    onDrop: (e, out) => {
      setTear(null); setDropAt(null);
      if (out) { if (!t.fl && onUndock && t.dwg) onUndock(t.id, { x: e.screenX, y: e.screenY }); return; }
      const to = over(e);
      if (to) onMove?.(t.id, to.id, to.after);
    },
  });
  return (
    <div
      role="tab"
      aria-selected={on}
      data-tab={t.id}
      className={'qtab' + (on ? ' on' : '') + (t.fl ? ' away' : '') + (t.sd ? ' side' : '') + (tear ? ' tearing' : '') + (t.dwg ? '' : ' empty') + dropCls}
      title={t.fl ? tip + '\nIn its own window - click to bring that window to the front' : t.dwg ? tip + '\nDrag it along to move it, out of the window (or ⧉) to give it its own window · Middle-click or Ctrl+W closes · Ctrl+Tab next · right-click for more' : tip}
      onClick={() => { if (drag.dragged.current) { drag.dragged.current = false; return; } if (t.fl) onShowFloat?.(t.id); else onPick(t.id); }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
      {...(t.fl ? {} : drag.handlers)}
      // (middle button: no scrolling cursor; the click closes it)
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(t.id); } }}
    >
      {t.fl && <span className="qtab-win" aria-hidden>⧉</span>}
      {t.sd && <span className="qtab-win" aria-hidden title="In the pane beside">◧</span>}
      <span className="qtab-t">{label}</span>
      {!t.fl && onUndock && t.dwg && <button className="qtab-pop" data-tabpop title="Open this sheet in its own window (or drag the tab out of the window)" onClick={(e) => { e.stopPropagation(); onUndock(t.id); }}>⧉</button>}
      <button className="qtab-x" title="Close (Ctrl+W)" onClick={(e) => { e.stopPropagation(); onClose(t.id); }}>×</button>
    </div>
  );
}

/**
 * v0.16.4 the tab of a sheet window: drag it back onto the main window's tab strip (or the button) to put the
 * sheet back there. `strip`: where that strip is on the screen (asked when the drag starts).
 */
export function FloatTab({ model, t, on, onDock, strip, onOver }: {
  model: QtoModel; t: SheetTab; on: boolean;
  onDock: (id: string) => void;
  strip: () => Promise<{ x: number; y: number; w: number; h: number } | null>;
  onOver: (over: boolean) => void;
}) {
  const { label, tip } = tabLabel(model, t);
  const box = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const drag = useTabDrag({
    onMove: (e) => onOver(overStrip({ x: e.screenX, y: e.screenY }, box.current)),
    onDrop: (e) => { onOver(false); if (overStrip({ x: e.screenX, y: e.screenY }, box.current)) onDock(t.id); },
  });
  return (
    <div className="qto-tabs float" role="tablist" aria-label="This window's sheet">
      <div
        role="tab"
        aria-selected={on}
        data-tab={t.id}
        className={'qtab' + (on ? ' on' : '')}
        title={tip + '\nDrag this tab onto the main window\'s tabs to put it back there'}
        {...drag.handlers}
        onPointerDown={(e) => { box.current = null; strip().then((b) => { box.current = b; }); drag.handlers.onPointerDown(e); }}
      >
        <span className="qtab-t">{label}</span>
      </div>
      <button className="btn sm ghost qtab-dock" data-dock title="Put this sheet back into the main window (or drag its tab onto the main window's tabs)" onClick={() => onDock(t.id)}>⇤ Back into the main window</button>
    </div>
  );
}

/** A menu at the pointer: closes on a click outside it or Esc (and when an entry is picked) */
export function PopMenu({ x, y, onClose, children, className }: { x: number; y: number; onClose: () => void; children: ReactNode; className?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', k, true);
    const off = menuOpened();
    return () => { off(); window.removeEventListener('keydown', k, true); };
  }, [onClose]);
  return (
    <div
      className="scrim clear"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        // (Windows sends the right-click's own contextmenu after the menu opened: only one somewhere else closes it)
        if (Math.abs(e.clientX - x) + Math.abs(e.clientY - y) > 4) onClose();
      }}
    >
      <div className={'rowmenu' + (className ? ' ' + className : '')} ref={fitOnScreen} style={{ left: Math.min(x, activeWin().innerWidth - 300), top: Math.min(y, activeWin().innerHeight - 120) }} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/** right-click on a sheet in the drawing list */
export function DrawingRowMenu({ model, id, x, y, readOnly, onClose, onOpenTab, onRename, onSplit, onRegister, onOpenPdf, onRemove }: {
  model: QtoModel; id: string; x: number; y: number; readOnly: boolean; onClose: () => void;
  onOpenTab: (id: string) => void; onRename: (id: string) => void; onSplit: (id: string) => void; onRegister: (id: string) => void;
  onOpenPdf: (id: string) => void; onRemove: (id: string) => void;
}) {
  const d = model.dwgById.get(id);
  if (!d) return null;
  const go = (f: (id: string) => void) => () => { onClose(); f(id); };
  return (
    <PopMenu x={x} y={y} onClose={onClose} className="dwgmenu">
      <div className="mh">{d.sheet ? d.sheet + ' · ' : ''}{sheetTitle(d)}</div>
      <button className="mi" onClick={go(onOpenTab)}><span className="ck"><TIcon k="plus" size={13} /></span><span className="lb">Open in a new tab</span></button>
      {!readOnly && <button className="mi" onClick={go(onRename)}><span className="ck" /><span className="lb">Rename…</span><span className="kb">F2</span></button>}
      {!readOnly && isOldBinder(d) && (
        <button className="mi" onClick={go(onSplit)} title="Each page becomes a sheet of its own, with what was measured on it (the file is not touched)">
          <span className="ck"><TIcon k="layers" size={13} /></span><span className="lb">Split into separate sheets <span className="faint">— {d.pages} pages</span></span>
        </button>
      )}
      <button className="mi" onClick={go(onRegister)}><span className="ck"><TIcon k="list" size={13} /></span><span className="lb">Show in register</span></button>
      <button className="mi" onClick={go(onOpenPdf)}><span className="ck"><TIcon k="file" size={13} /></span><span className="lb">Open the PDF in its own viewer</span></button>
      {!readOnly && (
        <>
          <div className="msep" />
          <button className="mi danger" onClick={go(onRemove)} title="The file itself is not touched"><span className="ck" /><span className="lb">Remove</span></button>
        </>
      )}
    </PopMenu>
  );
}

/** the sheets a take-off is measured on, and how much on each */
export function sheetsOfItem(m: QtoModel, ti: string): { dwg: string; pg: number; ids: string[]; v: number; label: string; no: string }[] {
  const it = m.itemById.get(ti);
  if (!it) return [];
  const by = new Map<string, Shape[]>();
  for (const s of m.shapesByItem.get(ti) ?? []) {
    const k = pageKey(s.dwg, s.pg);
    (by.get(k) ?? by.set(k, []).get(k)!).push(s);
  }
  const ms = mainMeasure(it);
  // in the order of the drawing list (as PgUp / PgDn go)
  const order = new Map(leavesInOrder(m.dwgTree).map((id, i) => [id, i]));
  return [...by.values()].map((list) => {
    const s = list[0];
    // measured on that sheet: the take-off's own shapes (and the doors on its walls) - openings taken off it from
    // other take-offs and waste go on its total only
    const q = itemQty({ shapesByItem: new Map([[ti, list]]), itemById: m.itemById, pages: m.pages, regions: m.regions, openingsByShape: m.openingsByShape, doorById: m.doorById, beamTypeById: m.beamTypeById, colTypeById: m.colTypeById, wallTypeById: m.wallTypeById, swTypeById: m.swTypeById, ftgTypeById: m.ftgTypeById, rwTypeById: m.rwTypeById, stairTypeById: m.stairTypeById, shapesByPage: m.shapesByPage }, { ...it, ded: [], waste: 0 });
    const d = m.dwgById.get(s.dwg);
    return { dwg: s.dwg, pg: s.pg, ids: list.map((x) => x.id), v: measureOf(q, ms), label: d ? sheetTitle(d) + (isOldBinder(d) ? ' p' + (s.pg + 1) : '') : '(removed drawing)', no: d?.sheet ?? '' };
  }).sort((a, b) => (order.get(a.dwg) ?? 1e9) - (order.get(b.dwg) ?? 1e9) || a.pg - b.pg);
}

/** "Go to sheet…" from a take-off's menu: every sheet with its shapes and the quantity on each */
export function GoToSheetMenu({ model, ti, x, y, onClose, onGo }: {
  model: QtoModel; ti: string; x: number; y: number; onClose: () => void;
  onGo: (dwg: string, pg: number, ids: string[]) => void;
}) {
  useQtoFmt();
  const it = model.itemById.get(ti);
  const list = useMemo(() => sheetsOfItem(model, ti), [model, ti]);
  if (!it) return null;
  const ms = mainMeasure(it);
  return (
    <PopMenu x={x} y={y} onClose={onClose} className="gotosheet">
      <div className="mh">Go to sheet · {it.name}</div>
      {!list.length && <div className="hint" style={{ padding: '6px 10px' }}>Nothing measured yet.</div>}
      {list.map((s) => (
        <button key={s.dwg + '.' + s.pg} className="mi gts" onClick={() => { onClose(); onGo(s.dwg, s.pg, s.ids); }} title="Open it in a new tab, zoomed to these shapes, selected">
          <span className="ck"><TIcon k="file" size={13} /></span>
          <span className="lb">{s.no && <b>{s.no} </b>}{s.label}</span>
          <span className="gq num">{fq(s.v, ms)} <small>{MEASURE_UNIT[ms]}</small></span>
        </button>
      ))}
      {list.length > 0 && (it.waste > 0 || it.ded.length > 0) && <div className="hint gts-note">Measured on each sheet — waste and openings from other take-offs go on the total only.</div>}
    </PopMenu>
  );
}
