// Side panels of the take-off workspace: drawings, take-offs, BOQ, notes.
import { isMine } from '../../engine/qto/owners';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Op, PresenceInfo } from '../../engine/types';
import type { Box } from '../../engine/qto/geometry';
import { alreadyLinked, KIND_LABEL, itemKindLabel, MEASURE_LABEL, MEASURE_UNIT, mainMeasure, measureOf, pageKey, flattenMirror, mirrorPath, type Kind, type QtoModel, type TItem, type MirrorRow, type Note, type Drawing, type TreeNode, measuresFor, sheetTitle } from '../../engine/qto/model';
import { DrawingRowMenu } from './Sheets16';
import { TEMPLATES, type Template } from '../../engine/qto/templates';
import { linkOps, dummyOps, removeDummyOps } from '../../engine/qto/ops';
import { moveNodesOps } from '../../engine/qto/headings';
import { ItemTree, TreeList } from './ItemTree';
import { descendants } from '../../engine/qto/headings';
import { measureForUnit, unitMismatch, similarity } from '../../engine/qto/units';
import { q as fq, m1, m2, m3, useQtoFmt } from './numfmt';
import { ITEM_COLORS } from '../../engine/qto/model';
import { fmtQty, ago, initials, parseNum } from '../format';
import { colorFor } from '../../engine/ids';
import { thumbUrl } from './drawings';
import type { PrepState } from './prep';
import { TIcon } from './ticons';
import { usePanelWidth, PanelEdge } from '../PanelSize';
import { STRUCT_TOOLS, type StructTool } from './StructButton';
import { PopMenu } from './Sheets16';
import { BeamFields, StructFields, ElementBox, itemCat, ByTag, DisplayFields, QtyExtras, SegTable, WallFields } from './Panels15';
import type { Opening, Shape } from '../../engine/qto/model';
import { useEscClose } from '../escape';
import { BoqTab, QaMark, AddDialog, type EstEdit } from './BoqTab';
import { dummyState, keepAsAdditionalOps } from '../../engine/qto/additional';
import { ColorButton } from './ColorPicker';
import { useDismiss, useDragAutoScroll } from './ListBits';
import { MultiProps } from './MultiProps';
import type { Hidden } from '../../engine/qto/listops';
import { useRoomPanel, useE2EHook, RoomIcon, FinishCodeField } from './RoomPanel';

// measured numbers: decimals as set on this PC (Decimals in the sheet's tool bar)
const uq = (x: number, unit: string) => { const m = measureForUnit(unit); return m ? fq(x, m) : fmtQty(x); };

export function sheetLabel(m: QtoModel, dwg: string, pg: number) {
  const d = m.dwgById.get(dwg);
  if (!d) return '(removed drawing)';
  return sheetTitle(d) + (d.pages > 1 ? ' p' + (pg + 1) : '');
}

// =====================================================================
// Drawings
// =====================================================================
function Thumb({ dir, hash, ver, pg = 0 }: { dir: string; hash: string; ver: number; pg?: number }) {
  // the picture of THIS file and page (v0.16.3, 0.16.2 QA hunt BUG-006: after a new revision was accepted the row kept
  // the earlier picture - it was fetched only while there was none). The old one stays until the new one is there.
  const key = `${hash}|${pg}|${ver}`;
  const [pic, setPic] = useState<{ key: string; url: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    if (hash && pic?.key !== key) thumbUrl(dir, hash, pg).then((u) => { if (alive) setPic({ key, url: u }); });
    return () => { alive = false; };
  }, [dir, key]);
  const url = pic?.url ?? null;
  return url ? <img className="dthumb" src={url} alt="" /> : <span className="dthumb none"><TIcon k="file" size={14} /></span>;
}

type DwgBy = 'tree' | 'grp' | 'disc' | 'issue';
type DwgShow = 'all' | 'measured' | 'empty' | 'check' | 'noscale';
const SHOW_LABEL: Record<DwgShow, string> = { all: 'All', measured: 'Measured', empty: 'Not measured', check: 'To check', noscale: 'No scale' };
const SHOW_TIP: Record<DwgShow, string> = {
  all: 'Every sheet',
  measured: 'Sheets with take-off shapes on them',
  empty: 'Sheets nothing has been measured on yet',
  check: 'Sheets with shapes measured on an earlier revision',
  noscale: 'Sheets with shapes but no scale set',
};
const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* */ } };

export function DrawingsPanel(p: {
  model: QtoModel;
  projectDir: string;
  cur: { dwg: string; pg: number } | null;
  onPick: (dwg: string, pg: number) => void;
  onAddFiles: () => void;
  onAddFolder: () => void;
  onRegister: () => void;
  onRemove: (id: string) => void;
  onCommit: (ops: Op[], label: string) => void;
  readOnly: boolean;
  people: (dwg: string, pg: number) => PresenceInfo[];
  busy: string | null;
  prep: PrepState | null;
  prepPaused: boolean;
  onPrepPause: (v: boolean) => void;
  thumbVer: number;
  /** v0.16: the row menu (and double-click / F2: rename) */
  onOpenTab?: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  /** v0.18.1 who is at this PC: the list's order / arrangement are remembered for them */
  me?: string;
  onSplit?: (id: string) => void;
  onShowInRegister?: (id: string) => void;
  onOpenPdf?: (id: string) => void;
  /** the search box: given the keyboard by the tab strip's + */
  searchRef?: React.RefObject<HTMLInputElement>;
}) {
  const [panelW, setPanelW] = usePanelWidth('qto-left', 268, 200, 560);
  // v0.16: the sheet's row menu, its name being edited, the row clicked last (F2)
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; v: string } | null>(null);
  const lastRow = useRef<string | null>(null);
  const rowOf = (el: EventTarget | null) => ((el as HTMLElement | null)?.closest?.('.drow')?.querySelector('[data-dwg]') as HTMLElement | null)?.dataset.dwg ?? null;
  const startRename = (id: string) => { const d = p.model.dwgById.get(id); if (d && !p.readOnly && p.onRename) setRenaming({ id, v: sheetTitle(d) }); };
  const saveRename = () => {
    if (!renaming) return;
    const d = p.model.dwgById.get(renaming.id);
    const v = renaming.v.trim();
    if (d && v !== sheetTitle(d)) p.onRename?.(renaming.id, v);
    setRenaming(null);
  };
  const { model } = p;
  const prep = p.prep;
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const dlistEl = useRef<HTMLDivElement>(null);
  useDragAutoScroll(dlistEl);
  /** v0.17.1 the sheets of each heading / group by name (sheet number), or as arranged (the shared order) - remembered */
  // (v0.18.1 Nabil: "an organizer by name option (ascending/descending?)" - and remembered for each user, not the PC)
  const uk = (k: string) => k + (p.me ? '.' + p.me : '');
  const ls0 = (k: string, d: string) => lsGet(uk(k), lsGet(k, d));
  const [sort, setSort] = useState<'default' | 'name' | 'desc'>(() => { const v = ls0('qto.dwgSort', 'default'); return v === 'name' || v === 'desc' ? v : 'default'; });
  const pickSort = (v: 'default' | 'name' | 'desc') => { setSort(v); lsSet(uk('qto.dwgSort'), v); };
  const [by, setBy] = useState<DwgBy>(() => (['tree', 'grp', 'disc', 'issue'].includes(ls0('qto.dwgBy2', 'tree')) ? ls0('qto.dwgBy2', 'tree') : 'tree') as DwgBy);
  // the "show" filter narrows the list: remembered for each project (0.23.1 - it was carried into a new project, whose
  // list then looked empty)
  const showKey = uk('qto.dwgShow') + '@' + (p.projectDir ?? '');
  const [show, setShow] = useState<DwgShow>(() => { const v = lsGet(showKey, 'all'); return (v in SHOW_LABEL ? v : 'all') as DwgShow; });
  const pickBy = (v: DwgBy) => { setBy(v); lsSet(uk('qto.dwgBy2'), v); };
  const pickShow = (v: DwgShow) => { setShow(v); lsSet(showKey, v); };

  // what is on each sheet
  const info = useMemo(() => {
    const shapes = new Map<string, number>();
    for (const [k, v] of model.shapesByPage) { const d = k.slice(0, k.lastIndexOf('.')); shapes.set(d, (shapes.get(d) ?? 0) + v.length); }
    const scaled = (d: Drawing) => {
      for (let i = 0; i < Math.max(1, d.pages); i++) if (model.pages.get(pageKey(d.id, i))?.sc) return true;
      return model.regions.some((r) => r.dwg === d.id);
    };
    const out = new Map<string, { n: number; scaled: boolean; check: number }>();
    for (const d of model.drawings) out.set(d.id, { n: shapes.get(d.id) ?? 0, scaled: scaled(d), check: (model.staleByDwg.get(d.id) ?? 0) + (model.offPage.get(d.id) ?? 0) });
    return out;
  }, [model]);
  const passes = (d: Drawing, sh: DwgShow) => {
    const i = info.get(d.id)!;
    return sh === 'all' || (sh === 'measured' ? i.n > 0 : sh === 'empty' ? i.n === 0 : sh === 'check' ? i.check > 0 : i.n > 0 && !i.scaled);
  };
  const counts = useMemo(() => {
    const c: Record<DwgShow, number> = { all: 0, measured: 0, empty: 0, check: 0, noscale: 0 };
    for (const d of model.drawings) for (const k of Object.keys(c) as DwgShow[]) if (passes(d, k)) c[k]++;
    return c;
  }, [info, model.drawings]);
  const f = q.trim().toLowerCase();
  const matches = (d: Drawing) => passes(d, show) && (!f || [d.title, d.name, d.sheet, d.grp, d.rev, d.issue, d.disc].some((x) => x.toLowerCase().includes(f)));
  const filterFn = useMemo(() => (id: string) => {
    const d = model.dwgById.get(id);
    if (d) return matches(d);
    const h = model.dwgTree.headingById.get(id);
    return !!h && !!f && show === 'all' && h.name.toLowerCase().includes(f);
  }, [model, f, show, info]);

  // automatic groupings (folder / discipline / issue)
  const groups = useMemo(() => {
    if (by === 'tree') return [];
    const m = new Map<string, Drawing[]>();
    for (const d of model.drawings) {
      if (!matches(d)) continue;
      const g = by === 'disc' ? d.disc || 'Other' : by === 'issue' ? d.issue || 'No issue given' : d.grp;
      (m.get(g) ?? m.set(g, []).get(g)!).push(d);
    }
    const out = [...m.entries()];
    if (by !== 'grp') out.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
    for (const [, ds] of out) if (by !== 'grp' || sort !== 'default') ds.sort((a, b) => (sort === 'desc' ? -1 : 1) * (a.sheet || a.name).localeCompare(b.sheet || b.name, undefined, { numeric: true }));
    return out;
  }, [model.drawings, f, by, show, info, sort]);
  // v0.17.1 "by name": the sheets of each heading in the order of their numbers (the headings stay where they are;
  // the shared order is untouched - "As arranged" shows it again)
  const dwgTree = useMemo(() => {
    if (sort === 'default') return model.dwgTree;
    const nm = (id: string) => { const d = model.dwgById.get(id); return d ? d.sheet || d.name : ''; };
    const tree = new Map<string, TreeNode[]>();
    for (const [par, nodes] of model.dwgTree.tree) {
      const leaves = nodes.filter((n) => n.t === 'i').sort((a, b) => (sort === 'desc' ? -1 : 1) * nm(a.id).localeCompare(nm(b.id), undefined, { numeric: true }));
      let i = 0;
      tree.set(par, nodes.map((n) => (n.t === 'i' ? leaves[i++] : n)));
    }
    return { ...model.dwgTree, tree };
  }, [model.dwgTree, model.drawings, sort]);
  const toCheck = model.stale.size + [...model.offPage.values()].reduce((a, b) => a + b, 0);
  const nShown = model.drawings.filter(matches).length;

  const rowContent = (d: Drawing) => {
    const on = p.cur?.dwg === d.id;
    const i = info.get(d.id)!;
    const who = p.people(d.id, on ? p.cur!.pg : 0);
    const nrev = model.revisions.get(d.id)?.length ?? 0;
    return (
      <>
        <Thumb dir={p.projectDir} hash={d.hash} ver={p.thumbVer} pg={d.fp ?? 0} />
        <span className="dtxt" data-dwg={d.id}>
          {renaming?.id === d.id ? (
            <input
              className="input sm dt-edit"
              autoFocus
              value={renaming.v}
              onFocus={(e) => e.target.select()}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              draggable={false}
              onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onChange={(e) => setRenaming({ id: d.id, v: e.target.value })}
              onBlur={saveRename}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); } }}
            />
          ) : <span className="dt">{sheetTitle(d)}</span>}
          <span className="ds">
            {d.sheet && <span>{d.sheet}</span>}
            {(d.rev || nrev > 0) && <span className="rv" title={(d.issue ? 'Issue: ' + d.issue : '') + (nrev ? ` · ${nrev} earlier revision${nrev > 1 ? 's' : ''}` : '')}>{d.rev || 'rev'}{nrev > 0 ? ' ·' + (nrev + 1) : ''}</span>}
            {i.check > 0 && <span className="chk" title="Measured on an earlier revision: check against the current one">{i.check} to check</span>}
            {i.n > 0 && <span className="cnt">{i.n} shape{i.n > 1 ? 's' : ''}</span>}
            {i.n > 0 && !i.scaled && <span className="bad" title="Measured but no scale set"><TIcon k="warn" size={11} /> no scale</span>}
          </span>
        </span>
        {who.length > 0 && (
          <span className="avatars">{who.slice(0, 3).map((o) => <span key={o.w} className="avatar xs" style={{ background: o.color }} title={o.u}>{initials(o.u)}</span>)}</span>
        )}
        {!p.readOnly && <button className="x" title="Remove from the project (the file is not touched)" onClick={(e) => { e.stopPropagation(); p.onRemove(d.id); }}>×</button>}
      </>
    );
  };
  const pagesOf = (d: Drawing) =>
    p.cur?.dwg === d.id && d.pages > 1 ? (
      <div className="dpages">
        {Array.from({ length: d.pages }, (_, i) => (
          <button key={i} className={p.cur!.pg === i ? 'on' : ''} onClick={() => p.onPick(d.id, i)}>{i + 1}</button>
        ))}
      </div>
    ) : null;

  return (
    <div className="pw-wrap" style={{ width: panelW }}>
    <nav className="qto-left">
      <h4>
        <span>Drawings <span className="pill">{nShown !== model.drawings.length ? `${nShown}/${model.drawings.length}` : model.drawings.length}</span></span>
        <span className="acts">
          <button className="btn icon ghost sm" title="Drawing register: every sheet, its revision and issue (export to Excel)" onClick={p.onRegister}><TIcon k="list" /></button>
          {!p.readOnly && <button className="btn icon ghost sm" title="Add a folder of drawings (every PDF inside)" onClick={p.onAddFolder}><TIcon k="folder" /></button>}
          {!p.readOnly && <button className="btn icon ghost sm" title="Add drawing files" onClick={p.onAddFiles}><TIcon k="plus" /></button>}
        </span>
      </h4>
      <div className="qto-lsearch">
        <input ref={p.searchRef} className="input sm" placeholder="Find a sheet, rev or issue" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
        <div className="seg xs" title="How the list is organised">
          {([['tree', 'Custom', 'Your own headings: drag and drop sheets and headings (starts as the folders)'], ['grp', 'Folder', 'As the folders on the server'], ['disc', 'Discipline', 'By discipline'], ['issue', 'Issue', 'By the issue each sheet came with']] as const).map(([k, l, t]) => (
            <button key={k} className={by === k ? 'on' : ''} title={t} onClick={() => pickBy(k)}>{l}</button>
          ))}
        </div>
        <div className="dshow">
          <select className={'input xs sortsel' + (sort !== 'default' ? ' on' : '')} data-dwgsort={sort} value={sort} onChange={(e) => pickSort(e.target.value as 'default' | 'name' | 'desc')} title="The sheets' order in each heading: as arranged (by you and the team, drag and drop), or by number / name. Remembered for you.">
            <option value="default">As arranged</option>
            <option value="name">Name A → Z</option>
            <option value="desc">Name Z → A</option>
          </select>
          {(Object.keys(SHOW_LABEL) as DwgShow[]).filter((k) => k === 'all' || counts[k] > 0 || show === k).map((k) => (
            <button key={k} className={'fchip' + (show === k ? ' on' : '') + (k === 'check' ? ' check' : k === 'noscale' ? ' warn' : '')} title={SHOW_TIP[k]} onClick={() => pickShow(show === k ? 'all' : k)}>
              {SHOW_LABEL[k]} <span>{counts[k]}</span>
            </button>
          ))}
        </div>
      </div>
      {toCheck > 0 && show !== 'check' && <button className="qto-tocheck" onClick={() => pickShow('check')}><TIcon k="warn" size={12} /> {toCheck} shape{toCheck > 1 ? 's' : ''} measured on an earlier revision — to check</button>}
      {p.busy && <div className="qto-busy"><span className="dot busy" /> {p.busy}</div>}
      {prep && prep.total > 0 && prep.done < prep.total && (prep.running || p.prepPaused) && (
        <div className="qto-prep" title="Each sheet is read once and a picture of it kept in the project folder, so it opens at once for everyone">
          <span className={'dot ' + (p.prepPaused ? 'warn' : 'busy')} />
          <span className="t">{p.prepPaused ? 'Preparing paused' : 'Preparing sheets'} {prep.done}/{prep.total}{prep.current && !p.prepPaused ? ' · ' + prep.current : ''}</span>
          <button className="linkbtn" onClick={() => p.onPrepPause(!p.prepPaused)}>{p.prepPaused ? 'Resume' : 'Pause'}</button>
        </div>
      )}
      {prep && !prep.running && !p.prepPaused && prep.failed > 0 && prep.done < prep.total && (
        <div className="qto-prep" title={prep.why || ''}>
          <span className="dot warn" />
          <span className="t">{prep.failed} sheet{prep.failed > 1 ? 's' : ''} could not be prepared{prep.why ? ' — ' + prep.why : ''}. {prep.failed > 1 ? 'They are' : 'It is'} read when opened.</span>
        </div>
      )}
      <div
        className="qto-dlist"
        ref={dlistEl}
        tabIndex={-1}
        // v0.17.1 a middle-click on a drawing: in a new tab (as in Explorer)
        onMouseDown={(e) => { if (e.button === 1 && rowOf(e.target)) e.preventDefault(); }}
        onAuxClick={(e) => { const id = e.button === 1 ? rowOf(e.target) : null; if (id && p.model.dwgById.has(id)) { e.preventDefault(); p.onOpenTab?.(id); } }}
        onClickCapture={(e) => { const id = rowOf(e.target); if (id) lastRow.current = id; }}
        onContextMenu={(e) => { const id = rowOf(e.target); if (!id) return; e.preventDefault(); lastRow.current = id; setRowMenu({ id, x: e.clientX, y: e.clientY }); }}
        onDoubleClick={(e) => { const id = rowOf(e.target); if (id && (e.target as HTMLElement).tagName !== 'INPUT') startRename(id); }}
        onKeyDown={(e) => {
          // (F2 on a heading is the heading's: the list renames it)
          if (e.key !== 'F2' || e.defaultPrevented || renaming || (e.target as HTMLElement).tagName === 'INPUT') return;
          const id = lastRow.current && p.model.dwgById.has(lastRow.current) ? lastRow.current : p.cur?.dwg;
          if (id) { e.preventDefault(); startRename(id); }
        }}
      >
        {by === 'tree' ? (
          <TreeList
            tv={dwgTree}
            className="dtree"
            readOnly={p.readOnly}
            storageKey={'qto.dclosed.' + (model.name || 'x')}
            activeId={p.cur?.dwg ?? null}
            filter={filterFn}
            filtering={!!f || show !== 'all'}
            onLeafClick={(id) => p.onPick(id, 0)}
            onLeafCtrl={(id) => p.onOpenTab?.(id)}
            leafClass={(id) => 'drow' + (p.cur?.dwg === id ? ' on' : '')}
            leafTitle={(id) => model.dwgById.get(id)?.path ?? ''}
            renderLeaf={(id) => rowContent(model.dwgById.get(id)!)}
            afterLeaf={(id) => pagesOf(model.dwgById.get(id)!)}
            headTotals={(hid) => {
              const ids = descendants(model.dwgTree, hid).items;
              const meas = ids.filter((id) => (info.get(id)?.n ?? 0) > 0).length;
              return meas ? `${meas} measured` : '';
            }}
            leafNoun={['sheet', 'sheets']}
            leafIndent={4}
            onCommit={p.onCommit}
          />
        ) : (
          groups.map(([g, ds]) => (
            <div key={g || '_'}>
              {g && (
                <button className="dgrp" onClick={() => setClosed((s) => { const n = new Set(s); n.has(g) ? n.delete(g) : n.add(g); return n; })}>
                  <span className={'chev' + (closed.has(g) && !f ? ' closed' : '')}><TIcon k="chev" size={12} /></span>
                  <span className="t" title={g}>{g}</span>
                  <span className="pill">{ds.length}</span>
                </button>
              )}
              {(!closed.has(g) || f) && ds.map((d) => (
                <div key={d.id}>
                  <div className={'drow' + (p.cur?.dwg === d.id ? ' on' : '')} onClick={(e) => ((e.ctrlKey || e.metaKey) && !e.shiftKey ? p.onOpenTab?.(d.id) : p.onPick(d.id, 0))} title={d.path + '\nCtrl+click or middle-click: in a new tab\n(picking several sheets to move them: in the “As arranged” order)'} tabIndex={-1}>{rowContent(d)}</div>
                  {pagesOf(d)}
                </div>
              ))}
            </div>
          ))
        )}
        {model.drawings.length > 0 && nShown === 0 && (
          <p className="hint" style={{ padding: 14 }}>
            No sheet {f ? <>matches “{q}”</> : null}{f && show !== 'all' ? ' and is ' : show !== 'all' ? 'is ' : ''}{show !== 'all' ? SHOW_LABEL[show].toLowerCase() : ''}.{' '}
            <button className="linkbtn" onClick={() => { setQ(''); pickShow('all'); }}>Show all</button>
          </p>
        )}
      </div>
      {rowMenu && (
        <DrawingRowMenu
          model={model} id={rowMenu.id} x={rowMenu.x} y={rowMenu.y} readOnly={p.readOnly} onClose={() => setRowMenu(null)}
          onOpenTab={(id) => p.onOpenTab?.(id)} onRename={startRename} onSplit={(id) => p.onSplit?.(id)}
          onRegister={(id) => p.onShowInRegister?.(id)} onOpenPdf={(id) => p.onOpenPdf?.(id)} onRemove={p.onRemove}
        />
      )}
    </nav>
    <PanelEdge side="right" width={panelW} onWidth={setPanelW} />
    </div>
  );
}

// =====================================================================
// Take-offs
// =====================================================================
export function ItemsPanel(p: {
  model: QtoModel;
  me: string;
  isAdmin: boolean;
  readOnly: boolean;
  /** v0.16.2 an estimator / administrator with "Edit other people's shapes" on */
  editOthers?: boolean;
  /** v0.16.2 a QS: links only his own measurements to the BOQ */
  isQs?: boolean;
  activeId: string | null;
  cur: { dwg: string; pg: number } | null;
  /** heading new take-offs go under ('' = top level) */
  curHead: string;
  onCurHead: (h: string) => void;
  onActivate: (id: string | null) => void;
  onNew: (kind: Kind, t?: Template, par?: string) => void;
  /** v0.17.1 a new structural take-off (column, slab, drop panel, core wall…) from the list's own buttons */
  onNewStruct: (st: Exclude<StructTool, 'beam'>, par?: string) => void;
  onCommit: (ops: Op[], label: string) => void;
  onDelete: (id: string) => void;
  onLink: (ti: string) => void;
  onGoTo: (dwg: string, pg: number, box?: Box) => void;
  onNote: (on: string) => void;
  /** v0.15 */
  onDuplicate: (ti: string) => void;
  onDoorSchedule: () => void;
  onBeamTypes: () => void;
  /** v0.17 a schedule (columns / shear walls) */
  onSchedule?: (cat: import('../../engine/qto/beamsched').MemberCat) => void;
  /** v0.18.1 a message at the side */
  onToast?: (msg: string) => void;
  /** v0.18 the shapes picked on the drawing (their own figures are typed in the take-off's settings) */
  selShapes?: Shape[];
  segHi: { shape: string; segs: number[] } | null;
  onSegHi: (v: { shape: string; segs: number[] } | null) => void;
  onEditOpening: (o: Opening) => void;
  labelFor: (s: Shape) => string;
  // ---- v0.16 (b2): one selection with the drawing; the properties of what is selected
  /** rows selected (take-offs and headings) */
  picked: Set<string>;
  onPick: (ids: Set<string>) => void;
  /** the take-offs selected (a heading: everything under it), in list order */
  selItems: TItem[];
  hidden: Hidden;
  hiddenItems: Set<string>;
  onEye: (id: string) => void;
  /** asks first */
  onDeleteNodes: (ids: string[]) => void;
  /** link one or several take-offs to a BOQ line */
  onLinkMany: (ids: string[]) => void;
  onDupHeading: (hid: string, withValues: boolean) => void;
  /** v0.16: a take-off's "Go to sheet…" (its row menu) */
  onGoToSheet?: (ti: string, at: { x: number; y: number }) => void;
  /** v0.16 (e): who drew the selected shapes, and a total split when not all its shapes are shown (People16.tsx) */
  ownerBits?: (it: TItem) => ReactNode;
  /** v0.16 (e): the shapes shown on the drawing for the people chosen (the shape list lists those) */
  shapeShown?: (s: Shape) => boolean;
  /** v0.16 (g2): the project (the room panel <-> drawing steps, roommode.ts) */
  projectId?: string;
}) {
  const { model } = p;
  // v0.16 (g2): rooms - their finish lines in the list, their properties, Link to room…
  const rp = useRoomPanel({
    model, projectId: p.projectId ?? model.name, me: p.me, readOnly: p.readOnly, picked: p.picked, selItems: p.selItems, onPick: p.onPick,
    activeId: p.activeId, onActivate: p.onActivate, onCommit: p.onCommit, onDeleteNodes: p.onDeleteNodes, onDuplicate: p.onDuplicate,
    hiddenOwn: p.hidden.items, onEye: p.onEye, storageKey: 'qto.rooms.open.' + (model.name || 'x'), onToast: p.onToast, onGoTo: p.onGoTo,
  });
  useE2EHook(model, p.onCommit, p.projectId ?? model.name);
  const [q, setQ] = useState('');
  const [onSheet, setOnSheet] = useState(false);
  const [tpl, setTpl] = useState(false);
  const tplBox = useRef<HTMLDivElement>(null);
  // v0.17.1 (Nabil: "the settings open suddenly, shifting the measurement items tab, and I lose the item I clicked")
  // the list keeps a height of its own once the properties are open (dragged to taste, remembered on this PC), and
  // the row picked stays in view when the properties open under it
  const listEl = useRef<HTMLDivElement>(null);
  useDragAutoScroll(listEl);
  const [fold, setFold] = useState<{ token: number; close: boolean } | null>(null);
  const [listH, setListH] = useState<number | null>(() => { try { const v = Number(localStorage.getItem('qto.listH')); return v >= 90 ? v : null; } catch { return null; } });
  const hasProps = p.selItems.length > 0 || !!rp.props;
  const pickedKey = [...p.picked].slice(0, 1)[0] ?? '';
  useLayoutEffect(() => {
    if (!hasProps || !pickedKey) return;
    const el = listEl.current?.querySelector(`[data-row="${CSS.escape(pickedKey)}"]`) as HTMLElement | null;
    // (after the list has its new height: the row goes back into view, not to the top)
    requestAnimationFrame(() => el?.scrollIntoView?.({ block: 'nearest' }));
  }, [hasProps, pickedKey]);
  const dragSplit = (e: React.PointerEvent) => {
    const box = listEl.current;
    if (!box) return;
    e.preventDefault();
    const y0 = e.clientY, h0 = box.getBoundingClientRect().height;
    const parent = box.parentElement!;
    const max = Math.max(120, parent.getBoundingClientRect().height - 220);
    const move = (ev: PointerEvent) => { const h = Math.max(90, Math.min(max, h0 + ev.clientY - y0)); setListH(h); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setListH((h) => { try { if (h) localStorage.setItem('qto.listH', String(Math.round(h))); } catch { /* */ } return h; }); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  useDismiss(tpl, () => setTpl(false), tplBox);
  const pk = p.cur ? pageKey(p.cur.dwg, p.cur.pg) : '';
  const onPage = useMemo(() => new Set((model.shapesByPage.get(pk) ?? []).map((s) => s.ti)), [model, pk]);
  const f = q.trim().toLowerCase();
  const filter = useMemo(() => (id: string) => {
    const h = model.headingById.get(id);
    if (h) return !onSheet && !!f && h.name.toLowerCase().includes(f);
    const it = model.itemById.get(id);
    if (!it) return false;
    if (onSheet && !onPage.has(id)) return false;
    if (!f) return true;
    if (it.name.toLowerCase().includes(f)) return true;
    for (let x = it.par; x; x = model.headingById.get(x)?.par ?? '') if (model.headingById.get(x)?.name.toLowerCase().includes(f)) return true;
    return false;
  }, [model, f, onSheet, onPage]);
  const curHead = p.curHead && model.headingById.has(p.curHead) ? p.curHead : '';
  const curHeadName = curHead ? model.headingById.get(curHead)!.name : '';
  const one = p.selItems.length === 1 ? p.selItems[0] : null;

  return (
    <div className="qto-items">
      {!p.readOnly && (
        <div className="qto-new">
          <button className="btn sm" data-cat="measure" onClick={() => p.onNew('area', undefined, curHead)} title={'New area take-off (floors, ceilings, slabs)' + (curHeadName ? ' under ' + curHeadName : '')}><TIcon k="area" /> Area</button>
          <button className="btn sm" data-cat="measure" onClick={() => p.onNew('line', undefined, curHead)} title={'New length take-off (walls, skirting, kerbs)' + (curHeadName ? ' under ' + curHeadName : '')}><TIcon k="line" /> Length</button>
          <button className="btn sm" data-cat="measure" onClick={() => p.onNew('count', undefined, curHead)} title={'New count (doors, fittings)' + (curHeadName ? ' under ' + curHeadName : '')}><TIcon k="count" /> Count</button>
          <button className="btn sm" data-cat="block" onClick={() => p.onNew('wall', undefined, curHead)} title={'New blockwork wall: length, height, width; doors (D) and openings (O) come off it, with lintels' + (curHeadName ? ' under ' + curHeadName : '')}><TIcon k="wall" /> Wall</button>
          <NewStruct onPick={(st) => (st === 'beam' ? p.onNew('beam', undefined, curHead) : p.onNewStruct(st, curHead))} under={curHeadName} />
          <button className="btn sm" data-cat="finish" data-newroom onClick={() => p.onNew('room', undefined, curHead)} title={'New room: draw its outline, then name it - floor, wall, skirting and ceiling finishes (codes, heights), doors, waterproofing' + (curHeadName ? ' under ' + curHeadName : '')}><RoomIcon /> Room</button>
          <div className="tplwrap" ref={tplBox}>
            <button className={'btn sm' + (tpl ? ' on' : '')} onClick={() => setTpl((x) => !x)} title="Start from a typical take-off with sensible defaults">Typical…</button>
            {tpl && (
              <div className="tplmenu">
                {[...new Set(TEMPLATES.map((t) => t.group))].map((g) => (
                  <div key={g}>
                    <div className="msec">{g}</div>
                    {TEMPLATES.filter((t) => t.group === g).map((t) => (
                      <button key={t.key} className="mi" onClick={() => { p.onNew(t.kind, t, curHead); setTpl(false); }}>
                        <TIcon k={t.kind} />
                        <span className="lb"><b>{t.name}</b><span className="d">{t.hint}</span></span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="qto-isearch">
        <input className="input sm" placeholder="Find a take-off" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
        <label className="check tp" title="Only take-offs with shapes on the sheet you are looking at"><input type="checkbox" checked={onSheet} onChange={(e) => setOnSheet(e.target.checked)} /> This sheet</label>
        {/* v0.17.1 (Feedback 3: "too many headings and subheadings to deal with") */}
        {model.headings.length > 0 && (
          <span className="foldall">
            <button className="btn icon ghost sm" data-foldall="close" title="Collapse all headings" onClick={() => setFold({ token: Date.now(), close: true })}><TIcon k="collapse" size={14} /></button>
            <button className="btn icon ghost sm" data-foldall="open" title="Expand all headings" onClick={() => setFold({ token: Date.now(), close: false })}><TIcon k="expand" size={14} /></button>
          </span>
        )}
      </div>
      {curHead && !p.readOnly && <div className="qto-curhead">New take-offs go under <b>{curHeadName}</b> <button className="linkbtn" onClick={() => p.onCurHead('')}>top level</button></div>}
      <div ref={listEl} className={'qto-ilist' + (hasProps ? ' half' : '')} style={hasProps && listH ? { flex: `0 0 ${listH}px` } : undefined}>
        {model.items.length === 0 && (
          <div className="hint" style={{ padding: '18px 14px' }}>
            No take-offs yet. Pick <b>Area</b>, <b>Length</b>, <b>Count</b>, <b>Wall</b> or <b>Beam</b> (or a <b>Typical</b> one with the deductions already set), then click on the drawing.
            {' '}Or just pick a tool and start — a take-off is made for you.
          </div>
        )}
        <ItemTree
          model={model}
          me={p.me}
          readOnly={p.readOnly}
          fold={fold}
          activeId={p.activeId}
          curHead={curHead}
          onCurHead={p.onCurHead}
          onActivate={p.onActivate}
          onNew={(kind, par) => p.onNew(kind, undefined, par)}
          onCommit={p.onCommit}
          filter={filter}
          filtering={!!f || onSheet}
          onPage={onPage}
          storageKey={'qto.closed.' + (model.name || 'x')}
          onDuplicate={p.readOnly ? undefined : p.onDuplicate}
          picked={p.picked}
          onPick={p.onPick}
          hidden={p.hidden}
          hiddenItems={p.hiddenItems}
          onEye={p.onEye}
          onDeleteNodes={rp.onDeleteNodes}
          onLink={p.onLinkMany}
          onDupHeading={p.onDupHeading}
          onGoToSheet={p.onGoToSheet}
          rooms={rp.rooms}
        />
      </div>
      {/* (one per take-off: the name typed in one is never saved onto the next one selected - a click on the
          drawing right after a new take-off was selected renamed it with the name of the one before) */}
      {hasProps && <div className="qto-split" data-split title="Drag to give the list more or less room" onPointerDown={dragSplit} />}
      {rp.props}
      {!rp.props && one && <ItemDetails key={one.id} {...p} item={one} onLinkRoom={rp.onLinkRoom} />}
      {rp.dialog}
      {!rp.props && p.selItems.length > 1 && <MultiProps model={model} items={p.selItems} readOnly={p.readOnly} onCommit={p.onCommit} onLink={() => p.onLinkMany(p.selItems.map((x) => x.id))} onDelete={() => p.onDeleteNodes([...p.picked])} onClose={() => p.onPick(new Set())} onBeamTypes={p.onBeamTypes} picked={p.picked} />}
    </div>
  );
}

function NumField({ label, value, onSave, placeholder, disabled, suffix, title }: { label: string; value: number | null; onSave: (v: number | null) => void; placeholder?: string; disabled?: boolean; suffix?: string; title?: string }) {
  const [v, setV] = useState(value === null ? '' : String(value));
  useEffect(() => setV(value === null ? '' : String(value)), [value]);
  const save = () => {
    const n = parseNum(v);
    // sizes, times and waste are never zero or below: 0 (or a minus) is taken as a slip and undone
    if (n === undefined || (n !== null && n <= 0)) { setV(value === null ? '' : String(value)); return; }
    if (n !== value) onSave(n);
  };
  return (
    <div className="field" title={title}>
      <label>{label}</label>
      <div className="sfx">
        <input className="input" value={v} placeholder={placeholder} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setV(value === null ? '' : String(value)); }} />
        {suffix && <span>{suffix}</span>}
      </div>
    </div>
  );
}

function ItemDetails(p: Parameters<typeof ItemsPanel>[0] & { item: TItem; onLinkRoom?: (ids: string[]) => void }) {
  useQtoFmt();
  const { model, item: it } = p;
  // v0.16.2 (QA hunt BUG-003): a take-off with other people's measurements in it - its settings (height, waste,
  // Times, code, name…) are part of them: view only, as their shapes are (an estimator: with "Edit other people's
  // shapes" on, and he becomes a joint owner). Its BOQ links: an estimator's to make; a QS only on his own.
  const theirs = !p.editOthers && model.shapes.some((s) => s.ti === it.id && !isMine(model, s, p.me));
  const ro = p.readOnly || theirs;
  const roFree = p.readOnly;
  const roLink = p.readOnly || (theirs && !!p.isQs);
  const set = (f: string, v: string | number | boolean | null, label = 'Take-off ' + f) => p.onCommit([[it.id, f, v]], label);
  const [name, setName] = useState(it.name);
  useEffect(() => { setName(it.name); }, [it.id, it.name]);
  const nameRef = useRef<HTMLInputElement>(null);
  // a brand-new take-off: offer to name it — but never steal the keyboard from the drawing
  // (that was what stopped Backspace / Ctrl+Z from undoing a point)
  useEffect(() => {
    // (only one with nothing measured yet: picking "Wall 1" in the list to put doors on it, then D, renamed
    // it "d" - the key went to its selected name)
    // (v0.16: and only the one just made to measure into - a click on a row only selects it, and the list
    // keeps the keyboard: Delete there is the take-off's, not a character of its name)
    if (!/^(Area|Length|Count|Wall|Beam) \d+$/.test(it.name) || ro || (model.qty.get(it.id)?.shapes ?? 0) > 0 || p.activeId !== it.id) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.tagName === 'CANVAS' || a.closest?.('.qto-stage'))) return;
    nameRef.current?.select();
  }, [it.id]);
  const qty = model.qty.get(it.id)!;
  const ms = mainMeasure(it);
  const links = model.linksByItem.get(it.id) ?? [];
  const sheets = useMemo(() => {
    const m = new Map<string, { dwg: string; pg: number; n: number; box: Box }>();
    for (const s of model.shapesByItem.get(it.id) ?? []) {
      const k = pageKey(s.dwg, s.pg);
      const e = m.get(k);
      if (e) { e.n++; e.box = { x0: Math.min(e.box.x0, s.box.x0), y0: Math.min(e.box.y0, s.box.y0), x1: Math.max(e.box.x1, s.box.x1), y1: Math.max(e.box.y1, s.box.y1) }; }
      else m.set(k, { dwg: s.dwg, pg: s.pg, n: 1, box: { ...s.box } });
    }
    return [...m.values()];
  }, [model, it.id]);
  const privOk = (o: TItem) => !o.priv || (it.priv && it.owner === o.owner); // see itemQty
  // only openings that take something off this take-off (see itemQty): doors with a width from a
  // skirting, doors with width and height or areas from a wall with a height, lengths from a length
  const takesOff = (o: TItem) => {
    const wallArea = (it.kind === 'line' || it.kind === 'wall') && !!it.h;
    const lengthOnly = it.kind === 'line' && !it.h;
    if (o.kind === 'count') return o.dc ? true : lengthOnly ? !!o.ow : !!(o.ow && o.oh);
    if (o.kind === 'area') return wallArea;
    return o.kind === 'line' && lengthOnly;
  };
  const openings = model.items.filter((o) => o.id !== it.id && privOk(o) && takesOff(o));
  const canDeduct = it.kind === 'area' || it.kind === 'line' || it.kind === 'wall';
  const notes = model.notes.filter((n) => n.on === it.id);
  const mine = it.owner === p.me || p.isAdmin || !it.owner;

  return (
    <div className="qto-detail" data-cat={itemCat(it)}>
      <div className="qd-head">
        <ColorButton value={it.color} disabled={roFree} onPick={(c) => set('color', c, 'Colour')} />
        <input
          ref={nameRef}
          className="input qd-name"
          value={name}
          disabled={ro}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== it.name && set('name', name.trim(), 'Renamed take-off')}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        <span className={'kindchip ' + it.kind + (it.sk ? ' ' + it.sk : '')} data-cat={itemCat(it)}>{itemKindLabel(it)}</span>
        {!roFree && <button className="btn icon ghost sm" title="Duplicate this take-off (with its BOQ links)…" onClick={() => p.onDuplicate(it.id)}><TIcon k="copy" /></button>}
        <button className="btn icon ghost sm" title="Close" onClick={() => p.onPick(new Set())}><TIcon k="x" /></button>
      </div>
      <div className="qd-body" key={it.id}>
        {/* v0.18.1 (Feedback 3: the settings split into groups - Quantity, Size, Deductions, Where it goes, BOQ link) */}
        <h5 className="qd-gh" data-grp="qty">Quantity</h5>
        <div className="qd-big">
          <span className="k">{MEASURE_LABEL[ms]} <span className="autotag" title="Worked out from what is drawn and the sizes below - not typed">auto</span></span>
          <span className="v num">{fq(measureOf(qty, ms), ms)} <small>{MEASURE_UNIT[ms]}</small></span>
        </div>
        <div className="qd-stats">
          <span>{qty.shapes} shape{qty.shapes === 1 ? '' : 's'}</span>
          {it.kind !== 'count' && ms !== 'len' && qty.len > 0 && <span>{m1(qty.len)} long</span>}
          {it.kind === 'area' && <span>perimeter {m1(qty.perim)}</span>}
          {it.kind === 'count' && qty.area > 0 && <span>{m2(qty.area)} of openings</span>}
          {qty.vol > 0 && <span>{m3(qty.vol)}</span>}
          {qty.dedArea > 0 && <span className="ded">−{m2(qty.dedArea)} openings (gross {m2(qty.gross)})</span>}
          {qty.keptOpenings > 0 && <span className="faint">{qty.keptOpenings} small opening{qty.keptOpenings > 1 ? 's' : ''} left in</span>}
          {it.waste > 0 && <span>incl. {it.waste}% waste</span>}
        </div>
        <QtyExtras it={it} qty={qty} />
        {/* v0.18 the elements picked on the drawing: figures of their own */}
        {(it.kind === 'beam' || it.sk) && p.selShapes && p.selShapes.some((s) => s.ti === it.id) && <ElementBox model={model} it={it} shapes={p.selShapes} ro={ro} onCommit={p.onCommit} />}
        {p.ownerBits?.(it)}
        {qty.unscaled > 0 && <div className="warnbox"><TIcon k="warn" /><div><b>{qty.unscaled} shape{qty.unscaled > 1 ? 's are' : ' is'} on a sheet with no scale</b> — not in the quantity yet. Set the scale on that sheet.</div></div>}
        {qty.badHoles > 0 && <div className="warnbox"><TIcon k="warn" /><div><b>{qty.badHoles} cut-out{qty.badHoles > 1 ? 's are' : ' is'} not deducted</b> — {qty.badHoles > 1 ? 'they lie' : 'it lies'} partly outside the area or over another cut-out (a corner moved since). Fix the cut-out and it counts again.</div></div>}
        {qty.mixed > 0 && <div className="warnbox"><TIcon k="warn" /><div><b>{qty.mixed} shape{qty.mixed > 1 ? 's cross' : ' crosses'} the edge of a viewport</b> — {it.kind === 'line' ? 'each part is measured at the scale where it lies' : 'measured at the scale of its middle'}. Check it belongs to that drawing.</div></div>}

        {theirs && !p.readOnly && (
          <div className="warnbox" data-theirs><TIcon k="lock" size={13} /> Other people's measurements are in this take-off: its settings are view only{p.isQs ? '.' : ' — People ▾ › “Edit other people’s shapes” to change them (you become a joint owner).'}</div>
        )}
        <fieldset className="qd-fields" disabled={ro}>
          {/* v0.17.1 the settings in labelled groups - v0.18.1 in the order asked: size, what comes off it, where it goes */}
          <h5 className="qd-gh" data-grp="size">Size</h5>
          {it.kind === 'wall' && !it.sk && <WallFields it={it} set={set} />}
          {it.kind === 'beam' && <BeamFields model={model} it={it} set={set} onTypes={p.onBeamTypes} ro={ro} />}
          {/* v0.17 slabs, drop panels, columns, shear walls */}
          {it.sk && <StructFields model={model} it={it} set={set} onTypes={(c) => p.onSchedule?.(c)} ro={ro} />}
          <div className="fields">
            {it.kind === 'line' && <NumField label="Height" suffix="m" value={it.h} placeholder="length only" onSave={(v) => set('h', v, 'Height')} title="Length × height = area (walls, tiling)" />}
            {((it.kind === 'area' && !it.sk) || (it.kind === 'line' && it.h)) && <NumField label="Thickness" suffix="m" value={it.d} placeholder="—" onSave={(v) => set('d', v, 'Thickness')} title="Area × thickness = volume" />}
            {it.kind === 'count' && !it.dc && !it.sk && <NumField label="Opening W" suffix="m" value={it.ow} placeholder="—" onSave={(v) => set('ow', v, 'Opening width')} title="Width of one (doors, windows): lets walls and skirting deduct it" />}
            {it.kind === 'count' && !it.dc && !it.sk && <NumField label="Opening H" suffix="m" value={it.oh} placeholder="—" onSave={(v) => set('oh', v, 'Opening height')} />}
            {!it.dc && <NumField label="Times" suffix="×" value={it.x === 1 ? null : it.x} placeholder="1" onSave={(v) => set('x', v === null || v === 1 ? null : v, 'Multiplier')} title="e.g. 2 for both faces of a wall" />}
            <NumField label="Waste" suffix="%" value={it.waste || null} placeholder="0" onSave={(v) => set('waste', v || null, 'Waste')} />
          </div>

          {(it.kind === 'wall' || canDeduct) && <h5 className="qd-gh" data-grp="ded">Deductions</h5>}
          {it.kind === 'wall' && (
            <div className="qd-sec">
              <h5>Doors and openings on it</h5>
              <p className="hint">While measuring the wall press <kbd>D</kbd> and click on it for a door (its tag from the door schedule), or <kbd>O</kbd> for another opening (its size). They come off the area, are counted, and get a lintel.</p>
              <button className="btn sm" onClick={p.onDoorSchedule}><TIcon k="door" /> Door schedule ({model.doors.length})…</button>
            </div>
          )}
          {canDeduct && (
            <div className="qd-sec">
              <h5>{it.kind === 'wall' ? 'Openings measured elsewhere' : 'Openings'}</h5>
              <label className="check tp">
                <input type="checkbox" checked={it.dmin !== null} onChange={(e) => set('dmin', e.target.checked ? 1 : null, 'Opening rule')} />
                Leave in openings up to
                <input className="input xs num" disabled={it.dmin === null || ro} defaultValue={it.dmin ?? 1} key={String(it.dmin)} onBlur={(e) => { const n = parseNum(e.target.value); if (n !== undefined && n !== null && n !== it.dmin) set('dmin', n, 'Opening rule'); }} />
                m² each
              </label>
              <div className="dedlist">
                {it.ded.map((oid) => {
                  const o = model.itemById.get(oid);
                  if (!o) return null;
                  return (
                    <span key={oid} className="dedchip">
                      <i style={{ background: o.color }} />{o.name}
                      {o.dc ? <small>doors at their sizes</small> : o.kind === 'count' && o.ow && o.oh ? <small>{o.ow}×{o.oh}</small> : null}
                      {!privOk(o) && <small className="warnline" title="Private take-offs are seen only by their owner, so they are not deducted from shared ones">private — not deducted</small>}
                      {!ro && <button onClick={() => p.onCommit([[it.id, 'ded', JSON.stringify(it.ded.filter((x) => x !== oid))], [it.id, 'dd:' + oid, false]], 'Openings')}>×</button>}
                    </span>
                  );
                })}
                {!ro && openings.filter((o) => !it.ded.includes(o.id)).length > 0 && (
                  <select className="input sm" value="" onChange={(e) => e.target.value && p.onCommit([[it.id, 'ded', JSON.stringify([...it.ded, e.target.value])], [it.id, 'dd:' + e.target.value, true]], 'Openings')}>
                    <option value="">Deduct openings from…</option>
                    {openings.filter((o) => !it.ded.includes(o.id)).map((o) => <option key={o.id} value={o.id}>{o.name}{o.dc ? ' (doors at their schedule sizes)' : o.kind === 'count' && o.ow ? ` (${o.ow}${o.oh ? '×' + o.oh : ''} m)` : ''}</option>)}
                  </select>
                )}
              </div>
              {it.ded.length === 0 && <p className="hint">Measure doors and windows once as counts with their size, then pick them here: they come off every wall, plaster and paint take-off that lists them.</p>}
            </div>
          )}
          <h5 className="qd-gh" data-grp="where">Where it goes</h5>
          <div className="field l">
            <label>Under heading</label>
            <select className="input" value={it.par} onChange={(e) => p.onCommit(moveNodesOps(model.itemTree, [it.id], { par: e.target.value, before: null }), 'Moved to heading')}>
              <option value="">— top level —</option>
              {model.headings.map((h) => <option key={h.id} value={h.id}>{'\u2003'.repeat(h.depth) + h.name}</option>)}
            </select>
          </div>
          {/* v0.16 (g2, item 30): in the Finishes Summary under its code when it has one; "In room…" when linked to a room */}
          <FinishCodeField model={model} it={it} ro={ro} onCommit={p.onCommit} onLinkRoom={p.onLinkRoom} />
        </fieldset>

        <ByTag model={model} it={it} qty={qty} />

        {it.dc ? (() => {
          // v0.16.1 a door counter: its doors are counted in the door schedule, which takes them to the BOQ
          const by = new Map<string, number>();
          for (const s of model.shapesByItem.get(it.id) ?? []) if (s.door) by.set(s.door, (by.get(s.door) ?? 0) + s.m);
          const rows = [...by].map(([d, n]) => [model.doorById.get(d)?.tag ?? '(not in the schedule)', n] as const).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
          return (
            <div className="qd-sec" data-doorcounter>
              <h5>Doors not on walls</h5>
              <p className="hint">Each point is a door of the door schedule: counted there (“Placed”), and it reaches the BOQ through the schedule row’s link - not linked here. Count tool, <kbd>D</kbd>.</p>
              {rows.length ? <p>{rows.map(([t, n]) => <span key={t} className="pill" style={{ marginRight: 6 }}>{t} × {n}</span>)}</p> : <p className="hint">None counted yet.</p>}
            </div>
          );
        })() : (
        <div className="qd-sec qd-link-sec">
          <h5 className="qd-gh" data-grp="boq">BOQ link</h5>
          {links.length === 0 && <p className="hint">Not linked yet. Its quantity reaches the BOQ once it is linked to a BOQ line (or a temporary line until the BOQ arrives).</p>}
          {links.map((l) => {
            const real = l.to.startsWith('b:') ? model.boqById.get(l.to.slice(2)) : null;
            const dm = !real ? model.dummyById.get(l.to) : null;
            const unit = real?.unit ?? dm?.unit ?? '';
            const v = measureOf(qty, l.q) * l.f;
            return (
              <div key={l.id} className="qd-link">
                <span className="lt" title={real ? mirrorPath(model, real.id) : ''}>
                  {real ? <><b>{real.ref}</b> {real.desc}</> : dm ? <><span className="tmp">temporary</span> <b>{dm.ref}</b> {dm.desc}{dm.map && <span className="faint"> → matched</span>}</> : <span className="faint">(line removed from the BOQ)</span>}
                </span>
                <span className="lq num">
                  {MEASURE_LABEL[l.q]}{l.f !== 1 ? ' ×' + l.f : ''} = {fq(v, l.q)} {MEASURE_UNIT[l.q]}
                  {unit && unitMismatch(unit, l.q) && <span className="bad" title={`The BOQ line is in ${unit}`}> ⚠ {unit}</span>}
                  {l.dup && <span className="bad" title="This take-off is already linked to the same BOQ line (directly or through a temporary line matched to it). It is counted once — remove this link."> ⚠ twice, counted once</span>}
                  {real && real.bt !== 'item' && <span className="bad" title="The administrator made this line a heading or a description: it has no quantity, so this measurement goes nowhere. Link it to the line that is priced."> ⚠ now a heading or description — not counted</span>}
                </span>
                {!roLink && <button className="x" title="Unlink" onClick={() => p.onCommit([[l.id, 'del', true]], 'Unlinked')}>×</button>}
              </div>
            );
          })}
          {!roLink && <button className="btn sm" onClick={() => p.onLinkMany([it.id])}><TIcon k="link" /> Link to a BOQ line…</button>}
        </div>
        )}

        <div className="qd-sec">
          <h5>Measured on</h5>
          {sheets.length === 0 && <p className="hint">Nothing measured yet. Click on the drawing.</p>}
          {sheets.map((s) => (
            <button key={s.dwg + s.pg} className="qd-sheet" onClick={() => p.onGoTo(s.dwg, s.pg, s.box)}>
              <span>{sheetLabel(model, s.dwg, s.pg)}</span>
              <span className="faint">{s.n} shape{s.n > 1 ? 's' : ''}</span>
            </button>
          ))}
        </div>

        <SegTable model={model} it={it} ro={ro} onCommit={p.onCommit} onGoTo={p.onGoTo} segHi={p.segHi} onSegHi={p.onSegHi} onEditOpening={p.onEditOpening} labelFor={p.labelFor} shown={p.shapeShown} />
        {!roFree && <DisplayFields it={it} set={set} />}

        <div className="qd-sec">
          <h5>Notes {notes.length ? `(${notes.length})` : ''}</h5>
          {notes.slice(0, 3).map((n) => <div key={n.id} className={'qd-note' + (n.done ? ' done' : '')}><b>{n.byName}</b> {n.text}</div>)}
          {!roFree && <button className="btn sm ghost" onClick={() => p.onNote(it.id)}><TIcon k="note" /> Add a note…</button>}
        </div>

        {!ro && mine && (
          <div className="qd-sec">
            <label className="check tp">
              <input type="checkbox" checked={it.priv} onChange={(e) => set('priv', e.target.checked || null, e.target.checked ? 'Made private' : 'Shared')} />
              Private — only I (and administrators) see it; not counted in the BOQ
            </label>
          </div>
        )}
        {!ro && mine && (
          <div className="qd-sec danger">
            <button className="btn sm danger" onClick={() => p.onDeleteNodes([it.id])}>Delete this take-off and its {qty.shapes} shape{qty.shapes === 1 ? '' : 's'}…</button>
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// BOQ (price-free copy from the estimator, plus temporary lines) - the tree, its tools, additional
// items and unlinking: BoqTab.tsx (v0.16)
// =====================================================================
export function BoqPanel(p: {
  model: QtoModel;
  readOnly: boolean;
  embedded: boolean;
  /** not linked to an estimate (or a link asked for): what to do about it */
  linkBox?: ReactNode;
  activeId: string | null;
  onCommit: (ops: Op[], label: string) => void;
  onLinkActive: (to: string) => void;
  onActivate: (id: string) => void;
  toast: (t: ReactNode) => void;
  /** v0.16: who is looking (the tab remembers its state per person) and which take-off project */
  me?: string;
  meName?: string;
  projectId?: string;
  /** v0.16: take-offs selected in the list (linked together); a take-off in a line's card clicked */
  selectedIds?: string[];
  onSelectItem?: (id: string) => void;
  /** v0.16: inside the estimate - an additional item's line is changed in the estimate */
  estEdit?: EstEdit | null;
}) {
  const { model } = p;
  const [match, setMatch] = useState<{ id: string; relink: boolean } | null>(null);
  const has = model.boqById.size > 0;
  const active = p.activeId ? model.itemById.get(p.activeId) ?? null : null;
  return (
    <>
      <BoqTab
        model={model}
        readOnly={p.readOnly}
        embedded={p.embedded}
        linkBox={p.linkBox}
        activeId={p.activeId}
        selectedIds={p.selectedIds}
        me={p.me ?? ''}
        meName={p.meName ?? p.me ?? ''}
        projectId={p.projectId ?? model.name}
        estEdit={p.estEdit}
        onCommit={p.onCommit}
        onSelectItem={p.onSelectItem ?? p.onActivate}
        toast={p.toast}
        onMatch={(id, relink) => setMatch({ id, relink })}
        below={<Dummies model={model} readOnly={p.readOnly} hasBoq={has} onCommit={p.onCommit} onMatch={(id) => setMatch({ id, relink: false })} active={active} toast={p.toast} me={p.me ?? ''} meName={p.meName ?? ''} />}
      />
      {match && model.dummyById.get(match.id) && (
        <MatchDialog
          model={model}
          dummy={match.id}
          relink={match.relink}
          onClose={() => setMatch(null)}
          onPick={(id) => { p.onCommit([[match.id, 'map', id]], match.relink ? (id ? 'Relinked additional item' : 'Additional item back on its own line') : id ? 'Matched temporary line' : 'Unmatched temporary line'); setMatch(null); }}
        />
      )}
    </>
  );
}

function Dummies({ model, readOnly, hasBoq, onCommit, onMatch, active, toast, me, meName }: { model: QtoModel; readOnly: boolean; hasBoq: boolean; onCommit: (ops: Op[], label: string) => void; onMatch: (id: string) => void; active: TItem | null; toast: (t: ReactNode) => void; me: string; meName: string }) {
  useQtoFmt();
  const [ref, setRef] = useState('');
  const [desc, setDesc] = useState('');
  const [unit, setUnit] = useState('m2');
  const [open, setOpen] = useState(!hasBoq);
  const [keep, setKeep] = useState<string | null>(null);
  // (v0.16: additional items live in the BOQ tree and under Show ▾ Additional items; here: temporary lines)
  const list = hasBoq ? model.dummies.filter((d) => !d.add) : model.dummies;
  const unmatched = list.filter((d) => !d.map).length;
  // a temporary line not resolved once the BOQ is here: the QS must pick (open by itself)
  useEffect(() => { if (hasBoq && unmatched) setOpen(true); }, [hasBoq, unmatched > 0]);
  if (hasBoq && !list.length) return null;
  const add = () => {
    if (!desc.trim()) return;
    onCommit(dummyOps(model, { ref, desc, unit }).ops, 'Temporary line');
    setRef(''); setDesc('');
  };
  return (
    <div className={'qto-dummies' + (hasBoq ? ' below' : '')}>
      <button className="dmhead" onClick={() => setOpen((x) => !x)}>
        <span className={'chev' + (open ? '' : ' closed')}><TIcon k="chev" size={12} /></span>
        Temporary lines <span className="pill">{list.length}</span>
        {hasBoq && unmatched > 0 && <span className="bad dm-open">{unmatched} not resolved</span>}
      </button>
      {open && (
        <>
          {hasBoq && unmatched > 0 && <p className="hint dm-why">The BOQ is here: match each temporary line to its BOQ line, or keep it as an additional item (it then goes to the BOQ in the bill you pick).</p>}
          {list.map((d) => {
            const t = model.targets.get(d.id);
            const real = d.map ? model.boqById.get(d.map) : null;
            const st = dummyState(model, d, hasBoq);
            return (
              <div key={d.id} className={'dmrow' + (st === 'open' ? ' open' : '')} data-id={d.id}>
                <span className="ref">{st === 'open' ? <QaMark st="open" /> : null}{d.ref}</span>
                <span className="desc" title={d.desc}>{d.desc}</span>
                <span className="unit">{d.unit}</span>
                <span className="r num">{t ? uq(t.total, d.unit) : '—'}</span>
                <span className="dm-act">
                  {hasBoq && (real ? (
                    <button className="linkbtn sm" title={real.desc} onClick={() => !readOnly && onMatch(d.id)}>→ {real.ref || real.desc.slice(0, 18)}</button>
                  ) : !readOnly ? (
                    <>
                      <button className="btn sm dm-match" onClick={() => onMatch(d.id)}>Match…</button>
                      <button className="btn sm dm-keep" title="Not in the BOQ: keep it as an additional item (pick its bill and location)" onClick={() => setKeep(d.id)}>Keep…</button>
                    </>
                  ) : null)}
                  {!readOnly && active && (
                    <button className="btn icon ghost sm" title={`Link “${active.name}” to this line`} onClick={() => { if (alreadyLinked(model, active.id, d.id)) { toast(<span><b>{active.name}</b> is already linked to this line{d.map ? ' (or to the BOQ line it is matched to)' : ''}.</span>); return; } const q = measureForUnit(d.unit) ?? mainMeasure(active); onCommit(linkOps(active.id, d.id, q).ops, 'Linked to temporary line'); toast(<span>Linked <b>{active.name}</b> to “{d.desc}”.</span>); }}><TIcon k="link" /></button>
                  )}
                  {!readOnly && <button className="x" title={real ? 'Remove the temporary line (its take-offs stay linked to the BOQ line it is matched to)' : 'Remove the temporary line and its links'} onClick={() => {
                    const r = removeDummyOps(model, d.id);
                    onCommit(r.ops, 'Removed temporary line');
                    if (r.moved) toast(<span>Removed. Its {r.moved} link{r.moved > 1 ? 's' : ''} now go{r.moved > 1 ? '' : 'es'} straight to <b>{real?.ref || real?.desc.slice(0, 30)}</b>.</span>);
                    else if (r.dropped) toast(<span>Removed with its {r.dropped} link{r.dropped > 1 ? 's' : ''}. Ctrl+Z brings {r.dropped > 1 ? 'them' : 'it'} back.</span>);
                  }}>×</button>}
                </span>
              </div>
            );
          })}
          {!readOnly && !hasBoq && (
            <div className="dmadd">
              <input className="input sm ref" placeholder="Ref" value={ref} onChange={(e) => setRef(e.target.value)} />
              <input className="input sm" placeholder="Description, e.g. Porcelain floor tiles 600×600" value={desc} onChange={(e) => setDesc(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
              <select className="input sm unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
                {['m2', 'm', 'm3', 'nr', 'kg', 'item'].map((u) => <option key={u}>{u}</option>)}
              </select>
              <button className="btn sm" disabled={!desc.trim()} onClick={add}>Add</button>
            </div>
          )}
        </>
      )}
      {keep && model.dummyById.get(keep) && <AddDialog model={model} mode="keep" d={model.dummyById.get(keep)} onClose={() => setKeep(null)} onSave={(f) => { onCommit(keepAsAdditionalOps(model.dummyById.get(keep)!, f, { username: me, name: meName }), 'Kept as additional item'); setKeep(null); toast(<span>Kept as an additional item. It is under <b>Show ▾ Additional items</b>.</span>); }} />}
    </div>
  );
}

export function MatchDialog({ model, dummy, onClose, onPick, relink }: { model: QtoModel; dummy: string; onClose: () => void; onPick: (id: string | null) => void; relink?: boolean }) {
  const d = model.dummyById.get(dummy)!;
  const [q, setQ] = useState('');
  const esc = useEscClose(onClose);
  // (not the lines additional items became: those are what is being resolved)
  const items = useMemo(() => [...model.boqById.values()].filter((b) => b.bt === 'item' && !b.qa), [model]);
  const list = useMemo(() => {
    const f = q.trim().toLowerCase();
    if (f) return items.filter((b) => b.desc.toLowerCase().includes(f) || b.ref.toLowerCase() === f).slice(0, 80).map((b) => ({ b, s: similarity(d, b) }));
    return items.map((b) => ({ b, s: similarity(d, b) })).filter((x) => x.s > 0.08).sort((a, z) => z.s - a.s).slice(0, 25);
  }, [items, q, d]);
  return (
    <div className="scrim" onKeyDown={esc.onKeyDown} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={esc.box} tabIndex={-1} className="modal wide">
        <h2>{relink ? 'Relink to a BOQ item' : 'Match a temporary line'}</h2>
        {relink
          ? <p className="sub">“<b>{d.desc}</b>” ({d.unit || 'no unit'}). Pick the BOQ item it belongs to: it shows as a sub-item of it, keeps its own description and quantity, and its quantity counts in the item's Take-off quantity (the BOQ quantity stays as issued). Its own line in the BOQ goes.</p>
          : <p className="sub">“<b>{d.desc}</b>” ({d.unit || 'no unit'}). Pick the real BOQ line it stands for: everything linked to it then counts there.</p>}
        <input className="input" autoFocus placeholder="Search the BOQ" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="picklist" style={{ marginTop: 10 }}>
          {!q && <div className="msec" style={{ padding: '6px 10px' }}>Closest matches</div>}
          {list.map(({ b, s }) => (
            <button key={b.id} className={'pick psp' + (d.map === b.id ? ' on' : '')} onClick={() => onPick(b.id)} title={mirrorPath(model, b.id)}>
              <span className="pa">{b.ref}</span>
              <span className="pd">{b.desc}</span>
              <span className="pa">{b.unit}{!q && <span className="faint"> · {Math.round(s * 100)}%</span>}</span>
            </button>
          ))}
          {list.length === 0 && <div className="hint" style={{ padding: 12 }}>No similar line found — search for it.</div>}
        </div>
        <div className="actions">
          {d.map && <button className="btn ghost" style={{ marginRight: 'auto' }} onClick={() => onPick(null)}>{relink ? 'Back to its own line' : 'Unmatch'}</button>}
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Notes
// =====================================================================
export function NotesPanel(p: { model: QtoModel; me: string; readOnly: boolean; onCommit: (ops: Op[], label: string) => void; onNew: () => void; onGo: (n: Note) => void }) {
  const { model } = p;
  const [all, setAll] = useState(false);
  const list = model.notes.filter((n) => all || !n.done);
  const target = (n: Note) => {
    if (n.on.startsWith('ti:')) return model.itemById.get(n.on)?.name ?? 'a take-off';
    if (n.on.startsWith('b:')) { const b = model.boqById.get(n.on.slice(2)); return b ? (b.ref ? b.ref + ' ' : '') + b.desc.slice(0, 40) : 'a BOQ line'; }
    if (n.on.startsWith('dm:')) return model.dummyById.get(n.on)?.desc ?? 'a temporary line';
    return n.dwg ? sheetLabel(model, n.dwg, n.pg ?? 0) : 'the project';
  };
  return (
    <div className="qto-notes">
      <div className="qto-new">
        {!p.readOnly && <button className="btn sm" onClick={p.onNew}><TIcon k="note" /> New note</button>}
        <span className="grow" />
        <label className="check tp"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show done</label>
      </div>
      <div className="ntlist">
        {list.length === 0 && <p className="hint" style={{ padding: 14 }}>{model.notes.length ? 'All notes are done.' : 'No notes. Leave one for the administrator (or for yourself) on a take-off, a BOQ line or a spot on a sheet.'}</p>}
        {list.map((n) => (
          <div key={n.id} className={'nt' + (n.done ? ' done' : '')}>
            <div className="nh">
              <span className="avatar xs" style={{ background: colorFor(n.byName || n.by) }}>{initials(n.byName || n.by)}</span>
              <b>{n.byName || n.by}</b>
              <span className={'to ' + n.to}>{n.to === 'me' ? 'private' : 'to administrator'}</span>
              <span className="faint">{ago(n.t)}</span>
            </div>
            <div className="nb">{n.text}</div>
            <div className="nf">
              <button className="linkbtn" onClick={() => p.onGo(n)}>{n.x !== null ? <><TIcon k="pin" size={12} /> </> : null}{target(n)}</button>
              <span className="grow" />
              {!p.readOnly && <label className="check tp"><input type="checkbox" checked={n.done} onChange={(e) => p.onCommit([[n.id, 'done', e.target.checked || null]], e.target.checked ? 'Note done' : 'Note reopened')} /> Done</label>}
              {!p.readOnly && n.by === p.me && <button className="x" title="Delete note" onClick={() => p.onCommit([[n.id, 'del', true]], 'Deleted note')}>×</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


/** v0.17.1 the list's "new take-off" row: every structural element behind one button (as on the tool bar) */
function NewStruct({ onPick, under }: { onPick: (st: StructTool) => void; under: string }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button className={'btn sm' + (menu ? ' on' : '')} data-cat="struct" data-newstruct title={'New structural take-off: beam, column, slab, drop panel, core wall…' + (under ? ' under ' + under : '')}
        onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }); }}><TIcon k="struct" /> Structure ▾</button>
      {menu && (
        <PopMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} className="structmenu">
          <div className="mh">New structural take-off</div>
          {STRUCT_TOOLS.map((t) => (
            <button key={t.k} className="mi" data-newstructpick={t.k} title={t.hint} onClick={() => { setMenu(null); onPick(t.k); }}>
              <span className="ck"><TIcon k={t.icon} size={13} /></span><span className="lb">{t.label}</span>
            </button>
          ))}
        </PopMenu>
      )}
    </>
  );
}
