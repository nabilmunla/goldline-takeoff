// Shortcuts that people can find without being told:
//  - F1 (or the keyboard button in the title bar) opens the full list, searchable, with
//    the part you are working in shown first;
//  - the drawing shows the keys for the tool in use along its bottom edge;
//  - menus and button tooltips carry the same keys.
import { createPortal } from 'react-dom';
import { useOverlayHost } from './popout';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { askProblemReport, UpdateStatusLine } from './Update';
import { QTO_KEY_ROWS } from './takeoff/keymap';

export interface Shortcut {
  /** each entry is one key or combination, shown as chips: ['Ctrl+Z', 'Ctrl+Y'] */
  keys: string[];
  what: string;
}
export interface Section {
  id: SectionId;
  title: string;
  items: Shortcut[];
}
export type SectionId = 'general' | 'qto';

export const SECTIONS: Section[] = [
  {
    id: 'general', title: 'Everywhere', items: [
      { keys: ['F1'], what: 'This list of shortcuts' },
      { keys: ['Ctrl+Z', 'Ctrl+Y'], what: 'Undo / redo your own changes' },
      { keys: ['Esc'], what: 'Close a dialog or menu, cancel typing' },
      { keys: ['Right-click'], what: 'Everything you can do with what is under the mouse' },
    ],
  },
  { id: 'qto', title: 'Take-off (drawings)', items: QTO_KEY_ROWS },
];

// ---------- context: open the list from anywhere, hints on/off ----------
interface HelpState {
  open: (section?: SectionId) => void;
  /** the part of the app in use (shown first in the list) */
  setContext: (s: SectionId | null) => void;
}
const HelpCtx = createContext<HelpState>({ open: () => {}, setContext: () => {} });
export const useHelp = () => useContext(HelpCtx);

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export function HelpProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<SectionId | 'ctx' | null>(null);
  const [ctx, setContext] = useState<SectionId | null>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F1' || (e.key === '?' && !e.defaultPrevented && !typing(e.target) && !e.ctrlKey && !e.altKey)) {
        e.preventDefault();
        setShown((s) => (s ? null : 'ctx'));
      } else if (e.key === 'Escape' && shown) {
        setShown(null);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [shown]);
  const value = useMemo<HelpState>(() => ({ open: (s) => setShown(s ?? 'ctx'), setContext }), []);
  const overlayEl = useOverlayHost();
  const overlayHost = (n: ReactNode) => (overlayEl ? createPortal(n, overlayEl) : n);
  return (
    <HelpCtx.Provider value={value}>
      {children}
      {/* (v0.16.2 QA hunt BUG-005: in the window in use - the drawing's own window too) */}
      {shown && overlayHost(<ShortcutsPanel first={shown === 'ctx' ? ctx : shown} onClose={() => setShown(null)} />)}
    </HelpCtx.Provider>
  );
}

/** keyboard button for the title bar */
export function HelpButton() {
  const h = useHelp();
  return (
    <button className="tb-btn help" title="Keyboard shortcuts (F1)" onClick={() => h.open()}>
      <svg width="18" height="16" viewBox="0 0 18 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
        <rect x="1.5" y="3" width="15" height="10" rx="2" />
        <path d="M4.5 6.2h.01M7.5 6.2h.01M10.5 6.2h.01M13.5 6.2h.01M4.5 8.6h.01M13.5 8.6h.01M6.5 10.6h5" />
      </svg>
    </button>
  );
}

/** a key or combination as chips: "Ctrl+B" -> [Ctrl]+[B] */
export function Keys({ k }: { k: string }) {
  if (!/^(Ctrl|Alt|Shift)\+/.test(k) || k.length < 4) return <kbd>{k}</kbd>;
  const parts = k.split('+');
  return (
    <span className="kcombo">
      {parts.map((p, i) => <span key={i}>{i > 0 && <span className="kplus">+</span>}<kbd>{p}</kbd></span>)}
    </span>
  );
}

function ShortcutsPanel({ first, onClose }: { first: SectionId | null; onClose: () => void }) {
  const [q, setQ] = useState('');
  const sections = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const ordered = first ? [...SECTIONS.filter((s) => s.id === first), ...SECTIONS.filter((s) => s.id !== first)] : SECTIONS;
    return ordered
      .map((s) => ({ ...s, items: s.items.filter((it) => !words.length || words.every((w) => (s.title + ' ' + it.what + ' ' + it.keys.join(' ')).toLowerCase().includes(w))) }))
      .filter((s) => s.items.length);
  }, [q, first]);
  return (
    // (Esc handled here too: in the drawing's own window a key typed in the search box is not passed to the main
    // window's listener - v0.16.2)
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <div className="modal shortcuts">
        <div className="sc-head">
          <h2>Keyboard and mouse</h2>
          <input autoFocus className="input" placeholder="Find a shortcut — e.g. “move”, “take-off”, “paste”" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" onClick={onClose}>Close <kbd>Esc</kbd></button>
        </div>
        <div className="sc-body">
          {twoColumns(sections).map((col, ci) => (
            <div key={ci} className="sc-col">
              {col.map((s) => (
                <section key={s.id} className={'sc-sec' + (s.id === first && !q ? ' here' : '')}>
                  <h3>{s.title}{s.id === first && !q ? <span className="sc-here">where you are</span> : null}</h3>
                  {s.items.map((it, i) => (
                    <div key={i} className="sc-row">
                      <span className="sc-keys">{it.keys.map((k, j) => <span key={j}>{j > 0 && <span className="sc-or">/</span>}<Keys k={k} /></span>)}</span>
                      <span className="sc-what">{it.what}</span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          ))}
          {sections.length === 0 && <div className="faint" style={{ padding: 20 }}>Nothing matches “{q}”.</div>}
        </div>
        <div className="sc-foot">
          <span className="faint">Open this list any time with <kbd>F1</kbd> or the keyboard button at the top.</span>
          <span className="grow" />
          <UpdateStatusLine />
          <button className="btn sm ghost" title="Something not working? This copies what is needed to look into it (app version, recent errors, the log) — no prices, no BOQ" onClick={() => { onClose(); askProblemReport(); }}>Copy a problem report</button>
        </div>
      </div>
    </div>
  );
}

/** sections into two balanced columns (the first one stays first) */
function twoColumns(sections: Section[]): Section[][] {
  const cols: Section[][] = [[], []];
  const h = [0, 0];
  for (const s of sections) {
    const i = h[0] <= h[1] ? 0 : 1;
    cols[i].push(s);
    h[i] += s.items.length + 2;
  }
  return cols.filter((c) => c.length);
}

