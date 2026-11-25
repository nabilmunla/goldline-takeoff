// v0.16 (group b2, item 17): "Quantities on this sheet" - a floating table over the drawing with what was
// taken off the open sheet only: each take-off's name, colour, type and quantity here; opened, its shapes and
// segments one by one. A click selects (the take-off, a shape) or lights up one segment. Moved by its
// header, resized by its corner; where it is and its size are kept on this PC.
import { activeWin } from '../popout';
import { useEffect, useMemo, useRef, useState } from 'react';
import { KIND_LABEL, itemKindLabel, MEASURE_UNIT, isLineKind, mainMeasure, measureOf, segLensAt, shapeQtyAt, type QtoModel, type Shape } from '../../engine/qto/model';
import { leavesInOrder } from '../../engine/qto/headings';
import { sheetQty } from '../../engine/qto/listops';
import type { Box } from '../../engine/qto/geometry';
import { q as fq, useQtoFmt } from './numfmt';
import { TIcon } from './ticons';

const BOX_KEY = 'qto.sheetQty.box';
type Place = { x: number; y: number; w: number; h: number };
const MIN_W = 300, MIN_H = 140;
const loadPlace = (): Place => {
  const d = { x: Math.max(8, activeWin().innerWidth - 820), y: 150, w: 400, h: 340 };
  try { const j = JSON.parse(localStorage.getItem(BOX_KEY) || 'null'); return j && [j.x, j.y, j.w, j.h].every((v) => typeof v === 'number' && isFinite(v)) ? j : d; } catch { return d; }
};
/** wholly inside the window (a smaller window: moved in, then made smaller) */
const clampPlace = (p: Place): Place => {
  // (the window it is shown in: the main one or the drawing's own - v0.16.2)
  const W = activeWin().innerWidth, H = activeWin().innerHeight;
  const w = Math.max(MIN_W, Math.min(p.w, W - 16)), h = Math.max(MIN_H, Math.min(p.h, H - 16));
  return { w, h, x: Math.max(8, Math.min(p.x, W - w - 8)), y: Math.max(8, Math.min(p.y, H - h - 8)) };
};

const unionBox = (list: Box[]): Box | null => list.length ? list.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) })) : null;
/** the box of one segment of a shape */
export function segBox(s: Shape, i: number): Box {
  const a = s.pts[i], b = s.pts[(i + 1) % s.pts.length] ?? a;
  return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
}

export function SheetQtyTable({ model, dwg, pg, hiddenItems, ownerHidden, selItems, selected, segHi, onPickItem, onPickShape, onPickSeg, onClose }: {
  model: QtoModel;
  dwg: string;
  pg: number;
  hiddenItems: Set<string>;
  /** v0.16 (e): other people's shapes not shown on the drawing (People ▾): counted in the row, not listed under it */
  ownerHidden?: Set<string>;
  selItems: Set<string>;
  selected: Set<string>;
  segHi: { shape: string; segs: number[] } | null;
  onPickItem: (ti: string, add: boolean, box: Box | null) => void;
  onPickShape: (s: Shape, add: boolean) => void;
  onPickSeg: (s: Shape, i: number) => void;
  onClose: () => void;
}) {
  useQtoFmt();
  const [place, setPlace] = useState<Place>(() => clampPlace(loadPlace()));
  const placeRef = useRef(place);
  placeRef.current = place;
  const save = (p: Place) => { try { localStorage.setItem(BOX_KEY, JSON.stringify(p)); } catch { /* */ } };
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // the window made smaller: the table stays inside it
  useEffect(() => {
    const on = () => setPlace((p) => clampPlace(p));
    const w = activeWin();
    w.addEventListener('resize', on);
    return () => w.removeEventListener('resize', on);
  }, []);
  // resized by its corner: the size kept
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const ro = new ((el.ownerDocument.defaultView ?? window) as Window & { ResizeObserver: typeof ResizeObserver }).ResizeObserver(() => {
      const w = el.offsetWidth, h = el.offsetHeight;
      const p = placeRef.current;
      if (Math.abs(w - p.w) < 1 && Math.abs(h - p.h) < 1) return;
      const n = clampPlace({ ...p, w, h });
      placeRef.current = n;
      if (t) clearTimeout(t);
      t = setTimeout(() => { setPlace(n); save(n); }, 150);
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (t) clearTimeout(t); };
  }, []);
  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, p0 = placeRef.current;
    const move = (ev: MouseEvent) => setPlace(clampPlace({ ...p0, x: p0.x + ev.clientX - sx, y: p0.y + ev.clientY - sy }));
    const w = (e.nativeEvent.view as Window | null) ?? window;
    const up = () => { w.removeEventListener('mousemove', move); w.removeEventListener('mouseup', up); save(placeRef.current); };
    w.addEventListener('mousemove', move);
    w.addEventListener('mouseup', up);
  };

  const rows = useMemo(() => {
    const qty = sheetQty(model, dwg, pg);
    const shapesHere = new Map<string, Shape[]>();
    for (const s of model.shapesByPage.get(dwg + '.' + pg) ?? []) (shapesHere.get(s.ti) ?? shapesHere.set(s.ti, []).get(s.ti)!).push(s);
    const order = leavesInOrder(model.itemTree).filter((ti) => shapesHere.has(ti));
    return order.map((ti) => {
      const it = model.itemById.get(ti)!;
      const ms = mainMeasure(it);
      const all = shapesHere.get(ti)!;
      const shapes = all.filter((s) => !ownerHidden?.has(s.id)).sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0 || (a.id < b.id ? -1 : 1));
      return { it, ms, v: measureOf(qty.get(ti)!, ms), shapes, others: all.length - shapes.length };
    });
  }, [model, dwg, pg, ownerHidden]);

  const toggle = (ti: string) => setOpen((o) => { const n = new Set(o); n.has(ti) ? n.delete(ti) : n.add(ti); return n; });
  const st = { left: place.x, top: place.y, width: place.w, height: place.h };
  return (
    <div ref={box} className="sheetqty" style={st} data-sheetqty onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="sq-head" onMouseDown={startDrag} title="Drag to move it">
        <TIcon k="list" size={14} />
        <b title="What was taken off this sheet only, worked out as the totals are (times, openings, waste)">Quantities on this sheet</b>
        <span className="faint">{rows.length} take-off{rows.length === 1 ? '' : 's'}</span>
        <span className="grow" />
        <button className="btn icon ghost sm" title="Close" onClick={onClose}><TIcon k="x" size={13} /></button>
      </div>
      <div className="sq-body">
        {!rows.length && <div className="hint" style={{ padding: 12 }}>Nothing measured on this sheet yet.</div>}
        {rows.map(({ it, ms, v, shapes, others }) => {
          const isOpen = open.has(it.id);
          const line = isLineKind(it.kind);
          let n = 0;
          return (
            <div key={it.id} className={'sq-item' + (hiddenItems.has(it.id) ? ' hid' : '')}>
              <div
                className={'sq-row main' + (selItems.has(it.id) ? ' on' : '')}
                data-sq-item={it.id}
                title={hiddenItems.has(it.id) ? 'Hidden on the drawing (its eye in the take-off list)' : 'Select it on the drawing'}
                onClick={(e) => onPickItem(it.id, e.ctrlKey || e.metaKey || e.shiftKey, shapes.length ? unionBox(shapes.map((s) => s.box)) : null)}
              >
                <button className={'chev' + (isOpen ? '' : ' closed')} title={isOpen ? 'Fold' : 'Its shapes and segments'} onClick={(e) => { e.stopPropagation(); toggle(it.id); }}><TIcon k="chev" size={11} /></button>
                <i className="sw" style={{ background: it.color }} />
                <span className="nm">{it.name}</span>
                <span className="kd">{itemKindLabel(it)}</span>
                <span className="qv num">{fq(v, ms)} <small>{MEASURE_UNIT[ms]}</small></span>
              </div>
              {isOpen && shapes.map((s) => {
                n++;
                const sq = shapeQtyAt(model, s, it.dmin);
                const rep = s.m !== 1 ? ` ×${s.m}` : '';
                if (s.k === 'pt') {
                  return (
                    <div key={s.id} className={'sq-row sub' + (selected.has(s.id) ? ' on' : '')} data-sq-shape={s.id} onClick={(e) => onPickShape(s, e.ctrlKey || e.metaKey || e.shiftKey)}>
                      <span className="nm">Count {n}{rep}</span><span className="qv num">{fq(sq.cnt * s.m, 'cnt')} <small>nr</small></span>
                    </div>
                  );
                }
                if (s.k === 'poly' || !line) {
                  return (
                    <div key={s.id} className={'sq-row sub' + (selected.has(s.id) ? ' on' : '')} data-sq-shape={s.id} onClick={(e) => onPickShape(s, e.ctrlKey || e.metaKey || e.shiftKey)}>
                      <span className="nm">{s.k === 'poly' ? 'Area' : 'Line'} {n}{rep}{s.holes.length ? ` · ${s.holes.length} cut-out${s.holes.length > 1 ? 's' : ''}` : ''}</span>
                      <span className="qv num">{!sq.scaled ? 'no scale' : s.k === 'poly' ? <>{fq(sq.area * s.m, 'area')} <small>m²</small></> : <>{fq(sq.len * s.m, 'len')} <small>m</small></>}</span>
                    </div>
                  );
                }
                // a line (length, wall, beam): each segment's length
                const sl = segLensAt(model, s);
                return (
                  <div key={s.id}>
                    <div className={'sq-row sub' + (selected.has(s.id) ? ' on' : '')} data-sq-shape={s.id} onClick={(e) => onPickShape(s, e.ctrlKey || e.metaKey || e.shiftKey)}>
                      <span className="nm">Line {n}{rep} · {sl.lens.length} segment{sl.lens.length === 1 ? '' : 's'}</span>
                      <span className="qv num">{sq.scaled ? <>{fq(sq.len * s.m, 'len')} <small>m</small></> : 'no scale'}</span>
                    </div>
                    {sl.lens.length > 1 && sl.lens.map((L, i) => (
                      <div key={i} className={'sq-row sq-seg' + (segHi && segHi.shape === s.id && segHi.segs.length === 1 && segHi.segs[0] === i ? ' on' : '')} data-sq-seg={s.id + ':' + i} onClick={() => onPickSeg(s, i)}>
                        <span className="nm">segment {i + 1}</span>
                        <span className="qv num">{L === null ? 'no scale' : <>{fq(L, 'len')} <small>m</small></>}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
              {isOpen && others > 0 && <div className="sq-row sub sq-others" data-sq-others title="Counted in the row above; not on the drawing for you now (People ▾)"><span className="nm faint">+ {others} by others</span></div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
