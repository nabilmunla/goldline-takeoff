// v0.16.4 (feedback 2, done right): sheet tabs in their own windows - one sheet per window, as many as wanted (one
// on each screen). Not a second app: the take-off screen draws each of those sheets into another window of the
// same page, so the project, the selection and every change are the same everywhere, at once. Each window is a
// normal one (moved, resized, snapped by Windows); where a sheet's window was is remembered (electron/main.cjs).
//
// What follows the window the person works in:
// - menus, dialogs, pickers and messages (the overlay host is that window's);
// - the keys: a key pressed in a sheet window reaches the screen's key handlers in the main window (not while
//   typing in a field there - the same rule as in the main window), unless the drawing itself used it.
import { useSyncExternalStore } from 'react';

export interface Popout {
  /** the tab it shows */
  id: string;
  win: Window;
  /** where the sheet goes */
  root: HTMLElement;
  /** where menus, dialogs and messages go while this window is the one in use */
  overlay: HTMLElement;
}

const pops = new Map<string, Popout>();
/** the window in use: 'main' or a tab id */
let active = 'main';
const subs = new Set<() => void>();
let snap: { list: Popout[]; active: string } = { list: [], active };
const emit = () => { snap = { list: [...pops.values()], active }; for (const f of subs) f(); };
const subscribe = (f: () => void) => { subs.add(f); return () => subs.delete(f); };
const open = (p: Popout | undefined): p is Popout => !!p && !p.win.closed;

export const usePopouts = () => useSyncExternalStore(subscribe, () => snap);
/** the window the person is working in (positions of pickers, sizes) */
export const activeWin = (): Window => { const p = pops.get(active); return open(p) ? p.win : window; };
/** the element overlays go into: null = the main window as usual */
export const useOverlayHost = (): HTMLElement | null => { const s = usePopouts(); return s.active !== 'main' ? s.list.find((p) => p.id === s.active)?.overlay ?? null : null; };
/** the main window and every sheet window: a menu closes on a click in any of them */
export const allWins = (): Window[] => [window, ...[...pops.values()].filter(open).map((p) => p.win)];
/** a selector in any window (a dialog open in one counts for keys pressed in another) */
export const qsAny = (sel: string): Element | null => {
  const here = document.querySelector(sel);
  if (here) return here;
  for (const p of pops.values()) if (open(p)) { const x = p.win.document.querySelector(sel); if (x) return x; }
  return null;
};
export const popoutOf = (id: string): Popout | null => { const p = pops.get(id); return open(p) ? p : null; };
const activeSubs = new Set<(where: string) => void>();
/** told at once (not after the next paint) when the person turns to another window: a click in a sheet window
 *  is then already for the sheet worked on there */
export const onActiveWin = (f: (where: string) => void) => { activeSubs.add(f); return () => { activeSubs.delete(f); }; };
/** the window in use, as the screen sees it ('main' when the person clicks in the main window) */
export function setActiveWin(where: string) {
  if (active === where) return;
  active = where;
  emit();
  for (const f of activeSubs) f(where);
}

const EDITABLE = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';

function copyLook(from: Document, to: Document) {
  // the stylesheets (absolute: the new window has no address of its own) and the theme on <html>
  for (const n of [...to.head.querySelectorAll('link[rel="stylesheet"], style')]) n.remove();
  for (const n of from.head.querySelectorAll('link[rel="stylesheet"], style')) {
    const c = n.cloneNode(true) as HTMLElement;
    if (c instanceof HTMLLinkElement) c.href = (n as HTMLLinkElement).href;
    to.head.appendChild(c);
  }
  const a = from.documentElement, b = to.documentElement;
  for (const x of [...b.attributes]) if (x.name !== 'lang') b.removeAttribute(x.name);
  for (const x of a.attributes) b.setAttribute(x.name, x.value);
  to.body.className = from.body.className;
}

let mainHooked = false;
function hookMain() {
  if (mainHooked) return;
  mainHooked = true;
  // (a click in the main window, or the main window brought to the front: it is the one in use)
  window.addEventListener('pointerdown', () => setActiveWin('main'), true);
  window.addEventListener('focus', () => setActiveWin('main'));
}

/**
 * opens a tab's own window (or brings it to the front). `sheet`: the sheet's key (its window opens where it was
 * last); `at`: where the person dropped the tab (screen point). `onClosed` when the person closes the window.
 */
export function openPopout(id: string, sheet: string, title: string, onClosed: () => void, at?: { x: number; y: number }): Popout | null {
  const had = pops.get(id);
  if (open(had)) { had.win.focus(); return had; }
  hookMain();
  // (the frame's name carries the sheet: main.cjs puts the window where that sheet's was; a drop point wins)
  const feat = at ? `left=${Math.round(at.x)},top=${Math.round(at.y)}` : '';
  const w = window.open('', 'gt-sheet-' + id + '|' + sheet, feat);
  if (!w) return null;
  const d = w.document;
  d.open(); d.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title></title></head><body></body></html>'); d.close();
  d.title = title;
  copyLook(document, d);
  const root = d.createElement('div');
  // (.qto: the take-off screen's own styles apply in here too)
  root.className = 'app qto popout-root';
  const overlay = d.createElement('div');
  overlay.className = 'popout-overlay';
  d.body.append(root, overlay);
  // the theme / stylesheets change in the main window: the same here
  const mo = new MutationObserver(() => { if (!w.closed) copyLook(document, d); });
  mo.observe(document.documentElement, { attributes: true });
  mo.observe(document.head, { childList: true });
  // the window in use
  const onUse = () => setActiveWin(id);
  w.addEventListener('focus', onUse);
  w.addEventListener('pointerdown', onUse, true);
  // working in a sheet window: what the main window had in focus lets go (its key handlers would think the
  // person is typing in that field)
  w.addEventListener('focus', () => { const el = document.activeElement as HTMLElement | null; if (el && el !== document.body && el.matches?.(EDITABLE)) el.blur(); });
  // keys: to the main window's handlers, as if pressed there (bubble phase: the drawing's own handlers, which
  // listen in this window, come first and can keep a key to themselves)
  const forward = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && t.matches?.(EDITABLE)) return;
    const c = new KeyboardEvent(e.type, { key: e.key, code: e.code, location: e.location, repeat: e.repeat, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, bubbles: true, cancelable: true });
    window.dispatchEvent(c);
    if (c.defaultPrevented) e.preventDefault();
  };
  w.addEventListener('keydown', forward);
  w.addEventListener('keyup', forward);
  let done = false;
  const closed = () => {
    if (done) return;
    done = true;
    mo.disconnect();
    window.clearInterval(poll);
    if (pops.get(id)?.win === w) {
      pops.delete(id);
      if (active === id) active = 'main';
      emit();
      onClosed();
    }
  };
  w.addEventListener('pagehide', closed);
  // (a window closed by the system without pagehide)
  const poll = window.setInterval(() => { if (w.closed) closed(); }, 1000);
  const p: Popout = { id, win: w, root, overlay };
  pops.set(id, p);
  active = id;
  emit();
  w.focus();
  return p;
}

/** a tab's window closes (its sheet goes back into the main window - the screen decides) */
export function closePopout(id: string) {
  const p = pops.get(id);
  if (!p) return;
  pops.delete(id);
  if (active === id) active = 'main';
  emit();
  try { p.win.close(); } catch { /* gone */ }
  window.focus();
}
export function closeAllPopouts() { for (const id of [...pops.keys()]) closePopout(id); }
