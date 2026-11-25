// Project settings in one place, instead of buttons scattered over the screens:
// pages, and what this PC shows.
// (Not mounted at the moment: the estimate project screen was its only user.)
import { useEffect, useRef, useState, type ReactNode } from 'react';

export type SettingsTab = 'pages' | 'view';

export interface ViewPrefs {
  showPage: boolean;
  showOutline: boolean;
}

export function ProjectSettings(p: {
  tab: SettingsTab;
  view: ViewPrefs;
  setView: (v: Partial<ViewPrefs>) => void;
  pages?: ReactNode;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(p.tab === 'pages' && !p.pages ? 'view' : p.tab);
  const tabs: [SettingsTab, string][] = [...(p.pages ? [['pages', 'Pages'] as [SettingsTab, string]] : []), ['view', 'What I see']];
  // Esc closes it from anywhere in the dialog - also straight after it opened, when the focus is still
  // on the button that opened it (outside the dialog): the dialog takes the focus when it opens
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el && !el.contains(document.activeElement)) el.focus();
  }, []);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="modal wide settings" ref={box} tabIndex={-1} style={{ outline: 'none' }} onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); p.onClose(); } }}>
        <div className="set-head">
          <h2>Project settings</h2>
          <button className="btn" onClick={p.onClose}>Close <kbd>Esc</kbd></button>
        </div>
        <div className="set-body">
          <nav className="set-tabs">
            {tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
          </nav>
          <div className="set-pane">
            {tab === 'pages' && p.pages}
            {tab === 'view' && (
              <>
                <h3>What I see</h3>
                <p className="sub">Only on this PC — everyone sets their own.</p>
                <label className="check big"><input type="checkbox" checked={p.view.showPage} onChange={(e) => p.setView({ showPage: e.target.checked })} /> <span><b>Page</b> column in the BOQ<br /><span className="faint">The consultant’s page of each line, with a line where each page starts</span></span></label>
                <label className="check big"><input type="checkbox" checked={p.view.showOutline} onChange={(e) => p.setView({ showOutline: e.target.checked })} /> <span><b>Outline</b> of bills and sections on the left</span></label>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
