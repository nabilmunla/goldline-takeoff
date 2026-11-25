// The take-off list as a tree: headings, subheadings and take-offs, all drag and drop.
// Drag a heading and everything under it goes with it. Ctrl/Shift+click picks several.
// Drop on the top or bottom edge of a row = before / after it; on the middle of a
// heading = into it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Op } from '../../engine/types';
import { MEASURE_UNIT, mainMeasure, measureOf, type Kind, type QtoModel, type TreeNode, type TreeView } from '../../engine/qto/model';
import { descendants, moveNodesOps, newHeadingOps, removeHeadingOps, renameHeadingOps, type DropAt } from '../../engine/qto/headings';
import { deleteItemOps } from '../../engine/qto/ops';
import { installPointerDrag } from './pdrag';

if (typeof document !== 'undefined') installPointerDrag(document);

/** a take-off's family (the tool bar's colours): structure, blockwork, finishes, plain measures */
const catOfItem = (it: { kind: string; sk?: string }) => (it.sk || it.kind === 'beam' ? 'struct' : it.kind === 'wall' ? 'block' : it.kind === 'room' ? 'finish' : 'measure');
import { initials } from '../format';
import { q as fq, useQtoFmt } from './numfmt';
import { colorFor } from '../../engine/ids';
import { TIcon } from './ticons';
import { LinkMark } from './BoqTab';
import { useDismiss, MenuList, EyeBtn, PlayBtn, type MenuEntry } from './ListBits';
import { headEye, underHidden, type Hidden } from '../../engine/qto/listops';
import { RoomIcon } from './RoomIcon';
import { roomWarnings, roomLabel } from './roomui';

/**
 * A menu opened where it was asked for, moved up as far as it must to be wholly on the screen (by its
 * real height: a fixed allowance cut the take-off heading menu - 0.15 gave it six more lines - off the
 * bottom of a 768 px screen). Used as the menu's ref.
 */
export function fitOnScreen(el: HTMLElement | null) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  // (the window it is in: the main one or the drawing's own - v0.16.2)
  const w = el.ownerDocument.defaultView ?? window;
  if (r.bottom > w.innerHeight - 8) el.style.top = Math.max(8, w.innerHeight - 8 - r.height) + 'px';
  if (r.right > w.innerWidth - 8) el.style.left = Math.max(8, w.innerWidth - 8 - r.width) + 'px';
}

const MIME = 'application/x-qto-nodes';

type Row = { t: 'h' | 'i'; id: string; depth: number; par: string };
type Drop = { id: string; pos: 'before' | 'after' | 'into' } | { id: '__end'; pos: 'after' };

export interface TreeListProps {
  tv: TreeView;
  readOnly: boolean;
  /** where the open/closed headings are remembered (per PC) */
  storageKey: string;
  /** v0.17.1 Collapse all / Expand all (a new token each press) */
  fold?: { token: number; close: boolean } | null;
  /** the leaf in use (kept picked, its headings opened) */
  activeId: string | null;
  curHead?: string;
  onCurHead?: (h: string) => void;
  /** filtering: which leaves (and headings, by name) to show */
  filter: (id: string) => boolean;
  filtering: boolean;
  onLeafClick: (id: string) => void;
  leafClass: (id: string) => string;
  /** v0.18.1 Ctrl+click on a row (the drawings: opens it in a new tab) - picking one more is Ctrl+Shift+click then */
  onLeafCtrl?: (id: string) => void;
  /** v0.18.1 (Feedback 3: colour by tool category on the take-off list) a row's / a heading's family */
  leafCat?: (id: string) => string | undefined;
  headCat?: (id: string) => string | undefined;
  /** nameEdit: the name box while the leaf is being renamed (in place of its name) */
  renderLeaf: (id: string, nameEdit?: ReactNode) => ReactNode;
  afterLeaf?: (id: string, pad: number) => ReactNode;
  leafTitle?: (id: string) => string;
  headTotals?: (hid: string) => string;
  headCount?: (hid: string) => number;
  headMenuExtra?: (hid: string, close: () => void) => ReactNode;
  /** enables "delete heading and everything in it" */
  delLeaf?: (id: string) => Op[];
  leafNoun: [string, string];
  onCommit: (ops: Op[], label: string) => void;
  leafIndent?: number;
  className?: string;
  /** the rows picked (Ctrl/Shift+click), as they change */
  onPicked?: (ids: Set<string>) => void;
  /** right-click on a leaf: its menu */
  leafMenu?: (id: string, close: () => void) => ReactNode;
  // ---- v0.16 (b2)
  /** the rows picked, held by the caller (the take-off list: one selection with the drawing) */
  picked?: Set<string>;
  onPick?: (ids: Set<string>) => void;
  /** before a heading's name (its eye) */
  headPre?: (hid: string) => ReactNode;
  /** in the heading menu after Rename (Duplicate…) */
  headMenuMid?: (hid: string) => MenuEntry[];
  /** Delete key on the picked rows / "Delete heading and everything in it": the caller asks first */
  onDeleteNodes?: (ids: string[]) => void;
  /** rename a leaf in place (F2, its menu): its name now, and saving it */
  leafName?: (id: string) => string;
  onLeafRename?: (id: string, name: string) => void;
  /** a leaf to rename now (its menu's Rename): a new token each time */
  renameLeaf?: { id: string; token: number } | null;
  // ---- v0.16 (g2): take-offs dropped ON a leaf (the middle of a room row: Link to room…)
  leafInto?: (leafId: string, dragIds: string[]) => boolean;
  onLeafInto?: (leafId: string, dragIds: string[]) => void;
}

/** A list under headings, everything drag and drop (the take-off list, the drawing list) */
export function TreeList(p: TreeListProps) {
  const { tv } = p;
  const [closed, setClosed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(p.storageKey) || '[]')); } catch { return new Set(); }
  });
  const saveClosed = (s: Set<string>) => { setClosed(s); try { localStorage.setItem(p.storageKey, JSON.stringify([...s])); } catch { /* */ } };
  useEffect(() => { if (p.fold) saveClosed(p.fold.close ? new Set(p.tv.headings.map((h) => h.id)) : new Set()); }, [p.fold?.token]);
  const [pickedOwn, setPickedOwn] = useState<Set<string>>(new Set());
  // (held by the caller when it gives them: the take-off list's picks are the selection)
  const picked = p.picked ?? pickedOwn;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  /** picked here (not from the drawing): the list is not scrolled to them */
  const ownPick = useRef(false);
  const setPicked = (v: Set<string> | ((s: Set<string>) => Set<string>)) => {
    const n = typeof v === 'function' ? v(pickedRef.current) : v;
    pickedRef.current = n;
    ownPick.current = true;
    if (p.onPick) p.onPick(n); else setPickedOwn(n);
  };
  const anchor = useRef<string | null>(null);
  const listEl = useRef<HTMLDivElement>(null);
  const menuEl = useRef<HTMLDivElement | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [dragging, setDragging] = useState<string[] | null>(null);
  const [edit, setEdit] = useState<{ id: string; v: string } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; sure?: boolean } | null>(null);
  useEffect(() => { p.onPicked?.(picked); }, [picked]);

  // the leaf in use is always picked (and its headings opened) - in the take-off list (picks held by the
  // caller) the one being measured is not the selection: only its headings open
  const openTo = (ids: string[]) => {
    const open: string[] = [];
    for (const id of ids) for (let h = tv.headingById.get(id)?.par ?? tv.leafPar.get(id) ?? ''; h; h = tv.headingById.get(h)?.par ?? '') if (closed.has(h)) open.push(h);
    if (open.length) { const n = new Set(closed); open.forEach((h) => n.delete(h)); saveClosed(n); }
  };
  useEffect(() => {
    if (!p.activeId) return;
    if (!p.onPick) setPicked((s) => (s.has(p.activeId!) && s.size === 1 ? s : new Set([p.activeId!])));
    openTo([p.activeId]);
  }, [p.activeId]);
  // picked from the drawing (a shape clicked): its row is shown - headings opened, scrolled to
  useEffect(() => {
    const own = ownPick.current;
    ownPick.current = false;
    if (own || !p.picked || !p.picked.size) return;
    const ids = [...p.picked].slice(0, 30);
    openTo(ids);
    requestAnimationFrame(() => {
      const el = listEl.current?.querySelector(`[data-row="${CSS.escape(ids[0])}"]`) as HTMLElement | null;
      el?.scrollIntoView?.({ block: 'nearest' });
    });
  }, [p.picked]);
  useEffect(() => { if (p.renameLeaf && p.leafName) setEdit({ id: p.renameLeaf.id, v: p.leafName(p.renameLeaf.id) }); }, [p.renameLeaf?.token]);
  useDismiss(!!menu, () => setMenu(null), menuEl);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const visible = (n: TreeNode): boolean => {
      if (!p.filtering) return true;
      if (n.t === 'i') return p.filter(n.id);
      return (tv.tree.get(n.id) ?? []).some(visible) || p.filter(n.id);
    };
    const walk = (par: string, depth: number) => {
      for (const n of tv.tree.get(par) ?? []) {
        if (n.t === 'i' && !tv.leafPar.has(n.id)) continue;
        if (!visible(n)) continue;
        out.push({ t: n.t, id: n.id, depth, par });
        if (n.t === 'h' && (!closed.has(n.id) || p.filtering)) walk(n.id, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }, [tv, closed, p.filtering, p.filter]);
  const order = useMemo(() => rows.map((r) => r.id), [rows]);

  const click = (e: React.MouseEvent, r: Row) => {
    setMenu(null);
    // (v0.18.1 Feedback 3: "Ctrl+click opens a new tab" - the drawings; Ctrl+Shift+click picks one more of them)
    if ((e.ctrlKey || e.metaKey) && r.t === 'i' && p.onLeafCtrl) {
      if (!e.shiftKey) { p.onLeafCtrl(r.id); return; }
      const n = new Set(picked);
      n.has(r.id) ? n.delete(r.id) : n.add(r.id);
      setPicked(n);
      anchor.current = r.id;
      return;
    }
    if (e.shiftKey && anchor.current) {
      const a = order.indexOf(anchor.current), b = order.indexOf(r.id);
      if (a >= 0 && b >= 0) { setPicked(new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1))); return; }
    }
    if (e.ctrlKey || e.metaKey) {
      const n = new Set(picked);
      n.has(r.id) ? n.delete(r.id) : n.add(r.id);
      setPicked(n);
      anchor.current = r.id;
      return;
    }
    anchor.current = r.id;
    setPicked(new Set([r.id]));
    if (r.t === 'h') p.onCurHead?.(r.id);
    else {
      p.onCurHead?.(tv.leafPar.get(r.id) ?? '');
      p.onLeafClick(r.id);
    }
  };

  // ---- drag and drop
  const dragIds = (id: string) => (picked.has(id) ? order.filter((x) => picked.has(x)) : [id]);
  const zone = (e: React.DragEvent, r: Row): Drop['pos'] => {
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = (e.clientY - b.top) / b.height;
    if (r.t === 'h') return f < 0.28 ? 'before' : f > 0.72 && (closed.has(r.id) || !(tv.tree.get(r.id) ?? []).length) ? 'after' : 'into';
    if (dragging && p.leafInto?.(r.id, dragging)) return f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'into';
    return f < 0.5 ? 'before' : 'after';
  };
  const target = (d: Drop): DropAt | null => {
    if (d.id === '__end') return { par: '', before: null };
    const r = rows.find((x) => x.id === d.id);
    if (!r) return null;
    if (d.pos === 'into') return { par: r.id, before: null };
    if (d.pos === 'before') return { par: r.par, before: r.id };
    const sib = tv.tree.get(r.par) ?? [];
    const i = sib.findIndex((n) => n.id === r.id);
    return { par: r.par, before: sib[i + 1]?.id ?? null };
  };
  const doDrop = (ids: string[], d: Drop) => {
    const to = target(d);
    if (!to) return;
    const ops = moveNodesOps(tv, ids, to);
    if (!ops.length) return;
    p.onCommit(ops, ids.length > 1 ? `Moved ${ids.length} rows` : 'Moved in the list');
    if (to.par && closed.has(to.par)) { const n = new Set(closed); n.delete(to.par); saveClosed(n); }
  };
  const isIn = (node: string, head: string): boolean => {
    let h = tv.headingById.get(node)?.par ?? tv.leafPar.get(node) ?? '';
    while (h) { if (h === head) return true; h = tv.headingById.get(h)?.par ?? ''; }
    return false;
  };

  const ro = p.readOnly;
  const rowProps = (r: Row) => ({
    // (v0.18.1 dragged with the pointer, not the browser's drag and drop: the wheel scrolls the list meanwhile - pdrag.ts)
    'data-pdrag': !ro && !edit ? '' : undefined,
    onDragStart: (e: React.DragEvent) => {
      const ids = dragIds(r.id);
      setDragging(ids);
      e.dataTransfer.setData(MIME, JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragEnd: () => { setDragging(null); setDrop(null); },
    onDragOver: (e: React.DragEvent) => {
      if (!dragging) return;
      const pos = zone(e, r);
      if (dragging.some((id) => tv.headingById.has(id) && (r.id === id || isIn(r.id, id)))) { setDrop(null); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (drop?.id !== r.id || drop.pos !== pos) setDrop({ id: r.id, pos });
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const ids = dragging ?? JSON.parse(e.dataTransfer.getData(MIME) || '[]');
      const d = drop;
      setDrop(null);
      setDragging(null);
      // (on the middle of a leaf that takes them: the caller's - a take-off dropped on a room is linked to it;
      // worked out from the drop itself, not the last dragover)
      const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const f = (e.clientY - b.top) / b.height;
      if (r.t === 'i' && ids.length && f >= 0.25 && f <= 0.75 && p.leafInto?.(r.id, ids)) { p.onLeafInto?.(r.id, ids); return; }
      // (where it lands is worked out from the drop itself: the last dragover's position may not have reached
      // the screen yet - a quick drop then did nothing)
      if (!ids.length || ids.some((id: string) => tv.headingById.has(id) && (r.id === id || isIn(r.id, id)))) return;
      doDrop(ids, d && d.id === r.id ? d : { id: r.id, pos: zone(e, r) });
    },
  });

  const toggle = (id: string) => { const n = new Set(closed); n.has(id) ? n.delete(id) : n.add(id); saveClosed(n); };
  const saveName = () => {
    if (!edit) return;
    if (!tv.headingById.has(edit.id)) {
      // a take-off renamed in place
      if (edit.v.trim() && edit.v.trim() !== p.leafName?.(edit.id)) p.onLeafRename?.(edit.id, edit.v.trim());
      setEdit(null);
      listEl.current?.focus();
      return;
    }
    const ops = renameHeadingOps(tv, edit.id, edit.v);
    if (ops.length && edit.v.trim() !== tv.headingById.get(edit.id)?.name) p.onCommit(ops, 'Renamed heading');
    setEdit(null);
  };
  const addHeading = (par: string, before: string | null = null) => {
    const r = newHeadingOps(tv, 'New heading', par, before);
    p.onCommit(r.ops, 'New heading');
    if (par && closed.has(par)) { const n = new Set(closed); n.delete(par); saveClosed(n); }
    setEdit({ id: r.id, v: 'New heading' });
    setPicked(new Set([r.id]));
    p.onCurHead?.(r.id);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (edit) return;
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
    // Esc: nothing picked any more (the list has the keyboard)
    if (e.key === 'Escape' && picked.size && p.onPick) { e.preventDefault(); e.stopPropagation(); setPicked(new Set()); return; }
    if (ro) return;
    const one = picked.size === 1 ? [...picked][0] : null;
    if (e.key === 'F2' && one && tv.headingById.has(one)) { e.preventDefault(); setEdit({ id: one, v: tv.headingById.get(one)!.name }); }
    else if (e.key === 'F2' && one && p.onLeafRename && p.leafName) { e.preventDefault(); setEdit({ id: one, v: p.leafName(one) }); }
    // Delete: the picked rows (the caller asks first)
    else if (e.key === 'Delete' && picked.size && p.onDeleteNodes) {
      e.preventDefault(); e.stopPropagation();
      // (v0.16: what is picked but not a row - a room's own finish picked on its line - goes to the caller as is)
      const ids = order.filter((x) => picked.has(x));
      p.onDeleteNodes(ids.length ? ids : [...picked]);
    }
  };
  const nameInput = (r: Row) => (
    <input
      className="input sm hname"
      autoFocus
      value={edit!.v}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setEdit({ ...edit!, v: e.target.value })}
      onBlur={saveName}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') saveName(); if (e.key === 'Escape') { setEdit(null); listEl.current?.focus(); } }}
      data-rename={r.id}
    />
  );

  const menuHead = menu ? tv.headingById.get(menu.id) : null;
  const menuContents = menu ? descendants(tv, menu.id) : null;
  const [one, many] = p.leafNoun;

  return (
    <div ref={listEl} className={'qto-tree' + (p.className ? ' ' + p.className : '')} tabIndex={-1} onKeyDown={onKey} onClick={(e) => { if (e.target === e.currentTarget) { setPicked(new Set()); p.onCurHead?.(''); } }}>
      {rows.map((r) => {
        const pad = 8 + r.depth * 16;
        const dropCls = drop && drop.id === r.id ? ' drop-' + drop.pos : '';
        const pickedCls = picked.has(r.id) ? ' picked' : '';
        const dragCls = dragging?.includes(r.id) ? ' dragging' : '';
        if (r.t === 'h') {
          const h = tv.headingById.get(r.id)!;
          const tot = p.headTotals?.(r.id) ?? '';
          const cnt = p.headCount?.(r.id) ?? descendants(tv, r.id).items.length;
          const open = !closed.has(r.id) || p.filtering;
          return (
            <div
              key={r.id}
              className={'hrow' + pickedCls + dropCls + dragCls + (p.curHead === r.id ? ' cur' : '') + (r.depth ? '' : ' top')}
              data-row={r.id}
              data-cat={p.headCat?.(r.id)}
              style={{ paddingLeft: pad }}
              onClick={(e) => click(e, r)}
              onDoubleClick={() => !ro && setEdit({ id: r.id, v: h.name })}
              onContextMenu={(e) => { e.preventDefault(); if (!ro) { setPicked(new Set([r.id])); setMenu({ id: r.id, x: e.clientX, y: e.clientY }); } }}
              {...rowProps(r)}
            >
              <button className={'chev' + (open ? '' : ' closed')} onClick={(e) => { e.stopPropagation(); toggle(r.id); }} title={open ? 'Collapse' : 'Expand'}><TIcon k="chev" size={12} /></button>
              {p.headPre?.(r.id)}
              {edit?.id === r.id ? (
                nameInput(r)
              ) : (
                <span className="hn" title={h.name}>{h.name}</span>
              )}
              <span className="hcnt">{cnt || ''}</span>
              {tot && <span className="htot num">{tot}</span>}
              {!ro && (
                <button className="hmore" title="Heading menu" onClick={(e) => { e.stopPropagation(); setPicked(new Set([r.id])); setMenu({ id: r.id, x: e.clientX, y: e.clientY }); }}>⋯</button>
              )}
            </div>
          );
        }
        return (
          <div key={r.id}>
            <div
              className={p.leafClass(r.id) + pickedCls + dropCls + dragCls}
              data-row={r.id}
              data-cat={p.leafCat?.(r.id)}
              style={{ paddingLeft: pad + (p.leafIndent ?? 14) }}
              title={p.leafTitle?.(r.id)}
              onClick={(e) => click(e, r)}
              onContextMenu={p.leafMenu ? (e) => { e.preventDefault(); if (p.onPick && !picked.has(r.id)) { anchor.current = r.id; setPicked(new Set([r.id])); } setMenu({ id: r.id, x: e.clientX, y: e.clientY }); } : undefined}
              {...rowProps(r)}
            >
              {p.renderLeaf(r.id, edit?.id === r.id ? nameInput(r) : undefined)}
            </div>
            {p.afterLeaf?.(r.id, pad + (p.leafIndent ?? 14))}
          </div>
        );
      })}
      {!ro && dragging && (
        <div
          className={'tree-end' + (drop?.id === '__end' ? ' drop-after' : '')}
          onDragOver={(e) => { e.preventDefault(); if (drop?.id !== '__end') setDrop({ id: '__end', pos: 'after' }); }}
          onDrop={(e) => { e.preventDefault(); const ids = dragging; setDrop(null); setDragging(null); if (ids) doDrop(ids, { id: '__end', pos: 'after' }); }}
        >
          Drop here: top level, at the end
        </div>
      )}
      {!ro && !p.filtering && (
        <button className="tree-add" onClick={() => addHeading('')}><TIcon k="plus" size={12} /> Heading</button>
      )}
      {menu && (!!menuHead || !!p.leafMenu) && (
        // (on a see-through cover, as the drawing's menus: a click anywhere else closes it - not the pointer
        // leaving it - and Esc is the menu's, wherever the pointer is)
        <div className="scrim clear" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); if (Math.abs(e.clientX - menu.x) + Math.abs(e.clientY - menu.y) > 4) setMenu(null); }}>
      {!menuHead && p.leafMenu && (
        <div className="rowmenu" ref={(el) => { menuEl.current = el; fitOnScreen(el); }} style={{ left: Math.min(menu.x, window.innerWidth - 300), top: Math.min(menu.y, window.innerHeight - 200) }} onMouseDown={(e) => e.stopPropagation()}>
          {p.leafMenu(menu.id, () => setMenu(null))}
        </div>
      )}
      {menuHead && (
        <div className="rowmenu" ref={(el) => { menuEl.current = el; fitOnScreen(el); }} style={{ left: Math.min(menu.x, window.innerWidth - 300), top: Math.min(menu.y, window.innerHeight - 330) }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="mh">{menuHead.name}</div>
          {p.headMenuExtra?.(menu.id, () => setMenu(null))}
          <button className="mi" onClick={() => { addHeading(menu.id); setMenu(null); }}><span className="ck">+</span><span className="lb">New subheading</span></button>
          <button className="mi" onClick={() => { const sib = tv.tree.get(menuHead.par) ?? []; const i = sib.findIndex((n) => n.id === menu.id); addHeading(menuHead.par, sib[i + 1]?.id ?? null); setMenu(null); }}><span className="ck">+</span><span className="lb">New heading below</span></button>
          <button className="mi" onClick={() => { setEdit({ id: menu.id, v: menuHead.name }); setMenu(null); }}><span className="ck" /><span className="lb">Rename</span><span className="kb">F2</span></button>
          {p.headMenuMid && <MenuList entries={p.headMenuMid(menu.id)} close={() => setMenu(null)} />}
          <button className="mi" onClick={() => { const all = descendants(tv, menu.id).headings; saveClosed(new Set([...closed, menu.id, ...all])); setMenu(null); }}><span className="ck" /><span className="lb">Collapse all inside</span></button>
          <button className="mi" onClick={() => { const all = new Set([menu.id, ...descendants(tv, menu.id).headings]); saveClosed(new Set([...closed].filter((x) => !all.has(x)))); setMenu(null); }}><span className="ck" /><span className="lb">Expand all inside</span></button>
          <div className="msep" />
          <button className="mi" onClick={() => { p.onCommit(removeHeadingOps(tv, menu.id, false, () => []), 'Removed heading'); setMenu(null); }}>
            <span className="ck" /><span className="lb">Remove heading <span className="faint">— keep what is in it</span></span>
          </button>
          {p.onDeleteNodes && (
            <button className="mi danger" onClick={() => { const id = menu.id; setMenu(null); p.onDeleteNodes!([id]); }}>
              <span className="ck" /><span className="lb">Delete heading and everything in it…</span>
            </button>
          )}
          {!p.onDeleteNodes && p.delLeaf && menuContents && menuContents.items.length > 0 && (
            <button
              className="mi danger"
              onClick={() => {
                if (!menu.sure) { setMenu({ ...menu, sure: true }); return; }
                p.onCommit(removeHeadingOps(tv, menu.id, true, p.delLeaf!), 'Deleted heading and what was in it');
                setMenu(null);
              }}
            >
              <span className="ck" /><span className="lb">{menu.sure ? `Click again: delete ${menuContents.items.length} ${menuContents.items.length > 1 ? many : one}` : `Delete heading and its ${menuContents.items.length} ${menuContents.items.length > 1 ? many : one}…`}</span>
            </button>
          )}
        </div>
      )}
        </div>
      )}
    </div>
  );
}

const NEW_KINDS: { k: Kind; label: string }[] = [
  { k: 'area', label: 'Area' }, { k: 'line', label: 'Length' }, { k: 'count', label: 'Count' }, { k: 'wall', label: 'Wall' }, { k: 'beam', label: 'Beam' }, { k: 'room', label: 'Room' },
];
/** "New take-off here ▸": the kinds open under it (a click, not a hover) */
function NewHere({ onNew, close }: { onNew: (k: Kind) => void; close: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="mi" data-newhere onClick={(e) => { const menu = (e.currentTarget as HTMLElement).closest('.rowmenu') as HTMLElement | null; setOpen((x) => !x); requestAnimationFrame(() => fitOnScreen(menu)); }}><span className="ck"><TIcon k="plus" size={13} /></span><span className="lb">New take-off here</span><span className="kb">{open ? '▾' : '▸'}</span></button>
      {open && NEW_KINDS.map((x) => (
        <button key={x.k} className="mi msub" onClick={() => { close(); onNew(x.k); }}><span className="ck">{x.k === 'room' ? <RoomIcon size={13} /> : <TIcon k={x.k} size={13} />}</span><span className="lb">{x.label}</span></button>
      ))}
    </>
  );
}

/** The take-off list */
export function ItemTree(p: {
  model: QtoModel;
  me: string;
  readOnly: boolean;
  activeId: string | null;
  curHead: string;
  onCurHead: (h: string) => void;
  /** ▶ / ■ on a row (or its menu's Measure): measure into it, or stop */
  onActivate: (id: string | null) => void;
  onNew: (kind: Kind, par: string) => void;
  onCommit: (ops: Op[], label: string) => void;
  filter: (id: string) => boolean;
  filtering: boolean;
  onPage: Set<string>;
  storageKey: string;
  fold?: { token: number; close: boolean } | null;
  onDuplicate?: (ti: string) => void;
  // ---- v0.16 (b2)
  /** the rows selected (the same selection as the drawing's) */
  picked: Set<string>;
  onPick: (ids: Set<string>) => void;
  /** shown / hidden on the drawing (this person, this PC) */
  hidden: Hidden;
  hiddenItems: Set<string>;
  onEye: (id: string) => void;
  onDeleteNodes?: (ids: string[]) => void;
  onLink?: (ids: string[]) => void;
  onDupHeading?: (hid: string, withValues: boolean) => void;
  /** v0.16: "Go to sheet…" - the sheets it is measured on (a list opened at the pointer) */
  onGoToSheet?: (ti: string, at: { x: number; y: number }) => void;
  /** v0.16 (g2): rooms - open / closed, the finish lines under an open one, "Link to room…" (a room given: a
   *  take-off dropped on that room's row) */
  rooms?: { open: Set<string>; toggle: (id: string) => void; lines: (roomId: string, pad: number) => ReactNode; onLinkRoom?: (ids: string[], room?: string) => void };
}) {
  useQtoFmt();
  const { model } = p;
  const tv = model.itemTree;
  const ro = p.readOnly;
  const [rename, setRename] = useState<{ id: string; token: number } | null>(null);
  // totals per heading, by unit
  const totals = useMemo(() => {
    const t = new Map<string, Map<string, number>>();
    for (const it of model.items) {
      // (a room is a set of finishes in m² and m: its quantities are in its own lines and the Finishes Summary,
      // not in the heading's totals - its floor area would be added to the area take-offs' m²)
      if (it.priv || it.kind === 'room' || it.dc) continue;
      const ms = mainMeasure(it);
      const v = measureOf(model.qty.get(it.id)!, ms);
      for (let h = it.par; h; h = model.headingById.get(h)?.par ?? '') {
        const m = t.get(h) ?? t.set(h, new Map()).get(h)!;
        m.set(MEASURE_UNIT[ms], (m.get(MEASURE_UNIT[ms]) ?? 0) + v);
      }
    }
    return t;
  }, [model]);
  return (
    <TreeList
      tv={tv}
      readOnly={ro}
      storageKey={p.storageKey}
      fold={p.fold}
      activeId={p.activeId}
      curHead={p.curHead}
      onCurHead={p.onCurHead}
      filter={p.filter}
      filtering={p.filtering}
      picked={p.picked}
      onPick={p.onPick}
      // a click only selects (rule 1): measuring starts with the row's ▶
      onLeafClick={() => undefined}
      leafClass={(id) => 'irow' + (id === p.activeId ? ' on' : '') + (p.onPage.has(id) ? ' here' : '') + (p.hiddenItems.has(id) ? ' hid' : '') + (model.itemById.get(id)?.kind === 'room' ? ' room' : '')}
      // v0.16 (g2): an open room shows its finishes under its row; areas / lengths dropped on a room's row are linked to it
      afterLeaf={p.rooms ? (id, pad) => (p.rooms!.open.has(id) && model.fin.roomById.has(id) ? p.rooms!.lines(id, pad) : null) : undefined}
      leafInto={p.rooms?.onLinkRoom ? (leaf, drag) => model.fin.roomById.has(leaf) && drag.every((x) => { const t = model.itemById.get(x); return !!t && (t.kind === 'area' || t.kind === 'line' || t.kind === 'wall') && t.rk !== 'add' && t.rk !== 'ceil'; }) : undefined}
      onLeafInto={p.rooms?.onLinkRoom ? (leaf, drag) => p.rooms!.onLinkRoom!(drag, leaf) : undefined}
      headTotals={(hid) => { const tot = totals.get(hid); return tot ? [...tot.entries()].filter(([, v]) => v > 0).map(([u, v]) => `${fq(v, u)} ${u}`).join(' · ') : ''; }}
      headPre={(hid) => <EyeBtn state={headEye(tv, hid, p.hidden)} faded={underHidden(tv, hid, p.hidden)} onClick={() => p.onEye(hid)} />}
      headMenuExtra={(hid, close) => (
        <>
          <NewHere onNew={(k) => p.onNew(k, hid)} close={close} />
          <div className="msep" />
        </>
      )}
      headMenuMid={p.onDupHeading ? (hid) => [
        { label: 'Duplicate with take-off values', icon: <TIcon k="copy" size={13} />, title: 'Its sub-headings and take-offs with their shapes (same sheets, same places) and settings. BOQ links are not copied.', on: () => p.onDupHeading!(hid, true) },
        { label: 'Duplicate without values', icon: <TIcon k="copy" size={13} />, title: 'Its sub-headings and take-offs (names, settings, colours), nothing measured', on: () => p.onDupHeading!(hid, false) },
      ] : undefined}
      delLeaf={(ti) => deleteItemOps(model, ti)}
      onDeleteNodes={ro ? undefined : p.onDeleteNodes}
      leafName={(id) => model.itemById.get(id)?.name ?? ''}
      onLeafRename={ro ? undefined : (id, name) => p.onCommit([[id, 'name', name]], 'Renamed take-off')}
      renameLeaf={rename}
      leafNoun={['take-off', 'take-offs']}
      onCommit={p.onCommit}
      leafMenu={(id, close) => {
        const it = model.itemById.get(id);
        if (!it) return null;
        // on a row of several selected: for all of them
        const ids = p.picked.has(id) && p.picked.size > 1 ? [...p.picked] : [id];
        const many = ids.length > 1 ? ` (${ids.length})` : '';
        // v0.16 (g2): a room's quantities reach the BOQ only through the Finishes Summary (no Link to BOQ item);
        // areas and lengths can be linked to a room
        const toBoq = ids.filter((x) => model.itemById.get(x)?.kind !== 'room' && !model.itemById.get(x)?.dc); // (v0.16.1 a door counter: through the door schedule)
        const toRoom = ids.map((x) => model.itemById.get(x)).filter((x) => x && (x.kind === 'area' || x.kind === 'line' || x.kind === 'wall') && x.rk !== 'add' && x.rk !== 'ceil');
        const entries: MenuEntry[] = [
          { label: id === p.activeId ? 'Stop measuring' : 'Measure', icon: id === p.activeId ? '■' : '▶', disabled: ro, on: () => p.onActivate(id === p.activeId ? null : id) },
          { label: 'Rename', kb: 'F2', disabled: ro, on: () => setRename({ id, token: Date.now() }) },
          ...(toBoq.length ? [{ label: 'Link to BOQ item…' + (toBoq.length > 1 ? ` (${toBoq.length})` : ''), icon: <TIcon k="link" size={13} />, disabled: ro || !p.onLink, on: () => p.onLink?.(toBoq) }] : []),
          // (only in a project with rooms: nothing to link to otherwise)
          ...(p.rooms?.onLinkRoom && model.fin.rooms.length && toRoom.length === ids.length ? [{ label: 'Link to room…' + many, icon: <RoomIcon size={13} />, disabled: ro, title: 'Show it under a room’s Floor, Wall, Skirting or Ceiling (it keeps its own shapes, code and quantity)', on: () => p.rooms!.onLinkRoom!(toRoom.map((x) => x!.id)) }] : []),
          { label: 'Go to sheet…', icon: <TIcon k="file" size={13} />, disabled: !p.onGoToSheet || ids.length > 1, on: (at) => p.onGoToSheet?.(id, at) },
          { label: 'Duplicate…', icon: <TIcon k="copy" size={13} />, disabled: ro || !p.onDuplicate, on: () => p.onDuplicate?.(id) },
          { sep: true },
          { label: 'Delete' + many, kb: 'Del', danger: true, disabled: ro || !p.onDeleteNodes, on: () => p.onDeleteNodes?.(ids) },
        ];
        return (
          <>
            <div className="mh">{ids.length > 1 ? `${ids.length} selected` : it.name}</div>
            <MenuList entries={entries} close={close} />
          </>
        );
      }}
      leafCat={(id) => { const it = model.itemById.get(id); return it ? catOfItem(it) : undefined; }}
      headCat={(hid) => {
        // (a heading of one family only: that family's colour)
        const ids = descendants(tv, hid).items;
        let c: string | undefined;
        for (const id of ids) { const it = model.itemById.get(id); if (!it) continue; const k = catOfItem(it); if (c && c !== k) return undefined; c = k; }
        return c;
      }}
      renderLeaf={(id, nameEdit) => {
        const it = model.itemById.get(id)!;
        if (it.kind === 'room') return <RoomRow model={model} id={id} me={p.me} ro={ro} on={id === p.activeId} nameEdit={nameEdit} open={!!p.rooms?.open.has(id)} onToggle={() => p.rooms?.toggle(id)} eye={p.hidden.items.has(id) ? 'none' : 'all'} eyeFaded={underHidden(tv, id, p.hidden)} onEye={() => p.onEye(id)} onPlay={() => p.onActivate(id === p.activeId ? null : id)} />;
        const qty = model.qty.get(it.id)!;
        const ms = mainMeasure(it);
        const links = model.linksByItem.get(it.id)?.length ?? 0;
        const on = id === p.activeId;
        return (
          <>
            <EyeBtn state={p.hidden.items.has(id) ? 'none' : 'all'} faded={underHidden(tv, id, p.hidden)} onClick={() => p.onEye(id)} />
            <i className="sw" style={{ background: it.color }} />
            {nameEdit ?? <span className="in" title={it.name}>{it.name}</span>}
            {it.priv && <span className="ib" title="Private: only you see it, not counted in the BOQ"><TIcon k="lock" size={12} /></span>}
            {qty.unscaled > 0 && <span className="ib bad" title={`${qty.unscaled} shape(s) on sheets without a scale`}><TIcon k="warn" size={12} /></span>}
            <LinkMark model={model} ti={it.id} />
            {it.owner && it.owner !== p.me && <span className="avatar xs" style={{ background: colorFor(it.owner) }} title={'By ' + it.owner}>{initials(it.owner)}</span>}
            <span className="iq num">{fq(measureOf(qty, ms), ms)} <small>{MEASURE_UNIT[ms]}</small></span>
            {!ro && <PlayBtn on={on} onClick={() => p.onActivate(on ? null : id)} />}
          </>
        );
      }}
    />
  );
}

/** v0.16 (g2): a room's row - ▸ (its finishes), 👁, colour, "Room name — description", ×N, ▶/■ */
function RoomRow({ model, id, me, ro, on, nameEdit, open, onToggle, eye, eyeFaded, onEye, onPlay }: {
  model: QtoModel; id: string; me: string; ro: boolean; on: boolean; nameEdit?: ReactNode; open: boolean; onToggle: () => void;
  eye: 'all' | 'none'; eyeFaded: boolean; onEye: () => void; onPlay: () => void;
}) {
  const it = model.itemById.get(id)!;
  const r = model.fin.roomById.get(id);
  const warns = r ? roomWarnings(model, id).filter((w) => !/no code/.test(w) && !/No outline/.test(w)) : [];
  const label = r ? roomLabel(r) : it.name;
  return (
    <>
      <button className={'chev rchev' + (open ? '' : ' closed')} data-roomchev={id} title={open ? 'Hide its finishes' : 'Show its finishes'} onClick={(e) => { e.stopPropagation(); onToggle(); }}><TIcon k="chev" size={12} /></button>
      <EyeBtn state={eye} faded={eyeFaded} onClick={onEye} />
      <i className="sw" style={{ background: it.color }} />
      {nameEdit ?? <span className="in" data-roomrow={r?.name ?? it.name} title={label + (r?.times && r.times !== 1 ? ' × ' + r.times : '')}>{r?.name ?? it.name}{r?.desc ? <span className="rdesc"> — {r.desc}</span> : null}</span>}
      {r && r.times !== 1 && <span className="rtimes num" title="Times: every quantity of the room × this">×{r.times}</span>}
      {it.priv && <span className="ib" title="Private: only you see it, not counted in the BOQ"><TIcon k="lock" size={12} /></span>}
      {warns.length > 0 && <span className="ib bad" title={warns.join('\n')}><TIcon k="warn" size={12} /></span>}
      {it.owner && it.owner !== me && <span className="avatar xs" style={{ background: colorFor(it.owner) }} title={'By ' + it.owner}>{initials(it.owner)}</span>}
      <span className="rkind" title="Room: its finishes are under it (▸), they reach the BOQ through the Finishes Summary"><RoomIcon size={13} /></span>
      {!ro && <PlayBtn on={on} onClick={onPlay} />}
    </>
  );
}

/** "Floor finishes › Tower A" options for a heading picker, in list order */
export function headingOptions(m: QtoModel): { id: string; label: string; depth: number }[] {
  return m.headings.map((h) => ({ id: h.id, label: h.name, depth: h.depth }));
}
