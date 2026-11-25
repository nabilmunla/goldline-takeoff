// v0.16 (group g2, items 28-32): rooms in the take-off panel - the finish lines under a room row, the
// properties of a selected room (and of one of its additional finishes), the finish code of any take-off,
// and "Link to room…". The quantities are the engine's (rooms.ts); every change is one commit (one Ctrl+Z).
// Drawing steps (outline, additional finish, manual ceiling, shadow-gap edges, doors, open edges) are asked
// of the drawing through roommode.ts.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Op } from '../../engine/types';
import type { Box } from '../../engine/qto/geometry';
import type { QtoModel, TItem } from '../../engine/qto/model';
import { roomWorking, bulkheadUnderside, CAT_NAME, type FinCat, type Room, type RoomPart } from '../../engine/qto/rooms';
import { setRoomOps, addFinishOps, setFinishPartOps, removeFinishOps, setCeilingModeOps, setShadowGapOps, setWaterproofingOps, linkToRoomOps, unlinkFromRoomOps, linkableTo, setFinishCodeOps, fromTemplate, soffitFirstOps, setOpeningSillOps, removeRoomOpeningOps, addBulkheadOps, addUpturnOps, setPartExtraOps, ceilingNoteOps, wallAreaOps, wallReplaceOps, addMiscOps, miscUnitOps, dupMiscOps, setMiscOps, MISC_UNIT_LABEL, setEdgeOps } from '../../engine/qto/roomops';
import { startRoomMode, onRoomModeDone, onRoomMode, roomModeDone, type RoomMode } from './roommode';
import { CodeBox } from './CodeBox';
import { Help } from './RoomHelp';
import { Num } from './Panels15';
import { ColorButton } from './ColorPicker';
import { TIcon } from './ticons';
import { EyeBtn } from './ListBits';
import { Modal } from './Dialogs';
import { q as fq, useQtoFmt } from './numfmt';
import { gt } from '../api';
import { parseNum } from '../format';
import { roomLines, roomWarnings, roomIsBlank, openEdgeCount, openEdgesOf, linkChoices, roomLabel, roomSelection, DEFAULT_ROOM_NAME, type FinLine } from './roomui';

const f2 = (x: number) => (Math.abs(x) < 0.005 ? 0 : x).toFixed(2);
const unitQ = (x: number, unit: string) => fq(x, unit || 'm²');

export { RoomIcon } from './RoomIcon';

// ------------------------------------------------------------------ drawing steps (roommode bus)
export function useRoomMode(projectId: string) {
  const [mode, setMode] = useState<RoomMode | null>(null);
  useEffect(() => onRoomModeDone(projectId, (m) => setMode((cur) => (!cur || !m || (cur.k === m.k && cur.room === m.room) ? null : cur))), [projectId]);
  return {
    mode,
    start: (m: RoomMode) => { setMode(m); startRoomMode(projectId, m); },
    stop: () => { setMode(null); startRoomMode(projectId, null); },
    /** a step whose state shows elsewhere (an outline: the room's ▶ / ■) */
    send: (m: RoomMode) => startRoomMode(projectId, m),
  };
}
export type RoomModeCtl = ReturnType<typeof useRoomMode>;
const MODE_TEXT: Record<RoomMode['k'], string> = {
  outline: 'Draw another outline of the room on the drawing.',
  addLine: 'Draw it along the room’s outline on the drawing.',
  addArea: 'Draw it inside the room on the drawing.',
  ceil: 'Draw the ceiling area(s) inside the room on the drawing.',
  gap: 'Pick the edges with a shadow gap on the drawing — Enter or Esc when done.',
  door: 'Click on a wall edge of the room to place a door.',
  open: 'Click on a wall edge of the room to place an opening.',
  edge: 'Pick the edges with no wall on the drawing — Enter or Esc when done.',
  pickLine: 'Pick the edges it runs along on the drawing (again to take one back) — Enter or Esc when done.',
  misc: 'Measure it on the drawing — on any sheet.',
};
function Picking({ rm, room, text }: { rm: RoomModeCtl; room: string; text?: string }) {
  if (!rm.mode || rm.mode.room !== room) return null;
  return (
    <div className="rm-picking" data-picking={rm.mode.k}>
      <span className="dot" />
      <span className="t">{text ?? MODE_TEXT[rm.mode.k]}</span>
      <button className="btn sm" onClick={rm.stop}>Done</button>
    </div>
  );
}

// ------------------------------------------------------------------ the lines under a room row
export function RoomLines({ model, roomId, pad, ro, sel, onLine, onPlus, onUnlink, onRemove, eyeOf, onEye, onDropLink }: {
  model: QtoModel;
  roomId: string;
  pad: number;
  ro: boolean;
  /** is this line selected */
  sel: (l: FinLine) => boolean;
  onLine: (l: FinLine) => void;
  onPlus: (cat: FinCat) => void;
  onUnlink: (ti: string) => void;
  /** an additional finish / bulkhead / upturn of the room removed (with what is drawn of it; Ctrl+Z brings it back) */
  onRemove?: (id: string) => void;
  eyeOf: (ti: string) => boolean;
  onEye: (ti: string) => void;
  /** take-offs dragged onto a finish line */
  onDropLink: (ids: string[], to: string) => void;
}) {
  useQtoFmt();
  const lines = useMemo(() => roomLines(model, roomId), [model, roomId]);
  const [over, setOver] = useState<string | null>(null);
  return (
    <div className="rm-lines" data-room-lines={roomId}>
      {lines.map((l) => {
        const dropTo = l.role === 'main' && (l.key === 'floor' || l.key === 'wall' || l.key === 'skirting' || l.key === 'ceiling') ? l.key : l.role === 'add' && model.fin.partById.has(l.key) && !model.fin.partById.get(l.key)!.ak ? l.key : null;
        return (
          <div
            key={l.key}
            className={'frow' + (sel(l) ? ' picked' : '') + (l.depth ? ' sub' : '') + (l.role === 'wp' ? ' wp' : '') + (over === l.key ? ' drop-into' : '')}
            data-fin={l.key}
            style={{ paddingLeft: pad + l.depth * 14 }}
            onClick={(e) => { e.stopPropagation(); onLine(l); }}
            onDragOver={dropTo && !ro ? (e) => { if (!e.dataTransfer.types.includes(NODES_MIME)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'link'; if (over !== l.key) setOver(l.key); } : undefined}
            onDragLeave={() => over === l.key && setOver(null)}
            onDrop={dropTo && !ro ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              setOver(null);
              let ids: string[] = [];
              try { ids = JSON.parse(e.dataTransfer.getData(NODES_MIME) || '[]'); } catch { ids = []; }
              if (ids.length) onDropLink(ids, dropTo);
            } : undefined}
            title={l.note ?? (l.code ? '' : 'No code: not in the Finishes Summary')}
          >
            {l.part && l.role !== 'main' ? <EyeBtn state={eyeOf(l.part) ? 'none' : 'all'} onClick={() => onEye(l.part!)} /> : <span className="eyegap" />}
            <span className="fn">{l.role === 'link' && <span className="lk"><TIcon k="link" size={11} /></span>}{l.label}</span>
            {l.detail && <span className="fd">{l.detail}</span>}
            {(l.over || l.note) && <span className="ib bad"><TIcon k="warn" size={12} /></span>}
            <span className={'fc' + (l.code ? '' : ' none')}>{l.code || '—'}</span>
            <span className="fq num">{l.qty === null ? <span className="faint">—</span> : <>{unitQ(l.qty, l.unit)} <small>{l.unit}</small></>}</span>
            {l.plus && !ro ? (
              <button className="fplus" data-plus={l.plus} title={`Add an additional ${CAT_NAME[l.plus].toLowerCase()} (its own code; drawn on the drawing)`} onClick={(e) => { e.stopPropagation(); onPlus(l.plus!); }}>+</button>
            ) : l.role === 'link' && !ro ? (
              <button className="fplus x" title="Unlink from the room (the take-off stays as it is)" onClick={(e) => { e.stopPropagation(); onUnlink(l.key); }}>×</button>
            ) : l.role === 'add' && !ro && onRemove && model.fin.partById.has(l.key) ? (
              <button className="fplus x" data-rmpart={l.key} title="Remove it (and what is drawn of it) · Ctrl+Z brings it back" onClick={(e) => { e.stopPropagation(); onRemove(l.key); }}>×</button>
            ) : <span className="fgap" />}
          </div>
        );
      })}
    </div>
  );
}
/** what the take-off list drags (ItemTree's MIME) */
export const NODES_MIME = 'application/x-qto-nodes';

// ------------------------------------------------------------------ properties of a selected room
export interface RoomPropsP {
  model: QtoModel;
  room: Room;
  /** the finish clicked in the list ('wall', a linked take-off's id...) */
  focus: string | null;
  ro: boolean;
  me: string;
  rm: RoomModeCtl;
  onCommit: (ops: Op[], label: string) => void;
  onPick: (ids: Set<string>) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  /** ▶: draw (more of) its outline */
  onMeasure: (id: string) => void;
  /** a message at the side (v0.18.1) */
  onToast?: (msg: string) => void;
  /** v0.18.1 open a sheet where something is drawn */
  onGoTo?: (dwg: string, pg: number, box?: Box) => void;
}

export function RoomProps(p: RoomPropsP) {
  useQtoFmt();
  const { model, room, ro, rm } = p;
  const id = room.id;
  const q = model.fin.qty.get(id);
  const parts = model.fin.partsByRoom.get(id) ?? [];
  const shapes = (model.shapesByItem.get(id) ?? []).length;
  const [name, setName] = useState(room.name);
  useEffect(() => setName(room.name), [room.name]);
  const [desc, setDesc] = useState(room.desc);
  useEffect(() => setDesc(room.desc), [room.desc]);
  const nameRef = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState<string | null>(null);
  const [gapAsk, setGapAsk] = useState(false);
  /** v0.16.4 the note for ceilings that don't cover the floor, being typed (null: not asked) */
  const [ceilAsk, setCeilAsk] = useState<string | null>(null);
  const [work, setWork] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const set = (patch: Parameters<typeof setRoomOps>[2], label: string) => { const ops = setRoomOps(model, id, patch); if (ops.length) p.onCommit(ops, label); };
  // a new room gets the keyboard in its Name box right after its first outline (not before: the keys
  // belong to the drawing while the outline is drawn)
  const shapes0 = useRef(shapes);
  useEffect(() => {
    const was = shapes0.current;
    shapes0.current = shapes;
    if (ro || was > 0 || !shapes || !(DEFAULT_ROOM_NAME.test(room.name) || !room.name)) return;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [shapes]);
  // the finish clicked in the list: shown
  useEffect(() => {
    if (!p.focus) return;
    const el = bodyRef.current?.querySelector(`[data-blk="${CSS.escape(p.focus)}"], [data-sub="${CSS.escape(p.focus)}"]`) as HTMLElement | null;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [p.focus, id]);
  // (Esc: the name as it was, nothing saved - the blur that follows saved the typed name, 0.23.2, DeepSeek #45)
  const escName = useRef(false);
  const saveName = () => {
    if (escName.current) { escName.current = false; setName(room.name); return; }
    const n = name.trim();
    if (!n || n === room.name) { setName(room.name); return; }
    // a room with nothing set yet takes the settings of the last room with that name (the QS sees them and can change them)
    // (v0.18.1 and its full-room false ceilings - one from before 0.18.1: its ceiling as a false ceiling under the soffit)
    const blank = roomIsBlank(room) && !parts.some((x) => x.rk === 'add' && x.cat === 'ceiling');
    const t = blank ? fromTemplate(model, p.me, { id, par: room.par, ord: room.it.ord ?? '' }, n, id) : null;
    const d = t?.settings ?? {};
    const has = Object.entries(d).some(([k, v]) => k !== 'cs' && v !== '' && v !== null && v !== 'auto') || !!t?.n;
    const ops = setRoomOps(model, id, { name: n, ...(has ? d : {}) });
    p.onCommit(has ? [...ops, ...t!.ops] : ops, has ? 'Named room (settings of the last ' + n + ')' : 'Renamed room');
    if (has) setFilled(n);
  };
  const warns = roomWarnings(model, id);
  /** v0.18 the room has a Room height: measured by the ceiling over each stretch of wall */
  const zoned = (room.rmh ?? 0) > 0;
  /** v0.18.1 a false ceiling over some of the walls: only then the allowance above it and the walls above it matter */
  const hasFc = zoned && !!q && q.zones.some((z) => z.fc !== null);
  const fin = (k: string) => q?.byKey.get(k) ?? null;
  const qtyOf = (k: string) => { const f = fin(k); return f ? `${unitQ(f.qty, f.unit)} ${f.unit}` : '—'; };
  const subs = (cat: FinCat) => parts.filter((x) => (x.rk === 'add' || x.rk === 'link') && x.cat === cat && !x.ak && !(x.rk === 'link' && x.under.startsWith('ti:')));
  const linkedUnder = (pid: string) => parts.filter((x) => x.rk === 'link' && x.under === pid);
  const addPart = (cat: FinCat, wa = false) => {
    const r = addFinishOps(model, p.me, id, cat, { wa });
    if (!r) return;
    p.onCommit(r.ops, wa ? 'Additional wall finish (an area)' : cat === 'ceiling' && room.cs ? 'False ceiling' : 'Additional ' + CAT_NAME[cat].toLowerCase());
    p.onPick(new Set([r.id]));
    rm.start({ k: (cat === 'wall' && !wa) || cat === 'skirting' ? 'addLine' : 'addArea', room: id, part: r.id });
  };
  const ceil = parts.find((x) => x.rk === 'ceil');
  const openN = openEdgeCount(model, id);
  const blk = (key: string) => 'rf-blk' + (p.focus === key ? ' focus' : '');
  const sub = (x: RoomPart) => {
    const f = fin(x.id);
    const isLink = x.rk === 'link';
    return (
      <div className={'rf-sub' + (p.focus === x.id ? ' focus' : '')} data-sub={x.id} onClick={() => p.onPick(new Set([x.id]))} title={isLink ? 'A take-off linked to this room: it keeps its own shapes, code and quantity (click: its properties)' : 'Click to change it'}>
        <i className="sw" style={{ background: x.it.color }} />
        <span className="fn">{isLink && <span className="lk"><TIcon k="link" size={11} /></span>}{x.it.name}</span>
        <span className={'fc' + (x.code ? '' : ' none')}>{x.code || 'no code'}</span>
        <span className="fq num">{f ? unitQ(f.qty, f.unit) + ' ' + f.unit : '—'}</span>
        {room.cs && x.cat === 'ceiling' && x.rk === 'add' ? <span className="fd" title="Under the soffit: the soffit's finish stops where it is">under the soffit</span> : x.wr ? <span className="fd" title="Measured on its elevation: the wall finish is not taken along the plan edges picked for it">replaces the wall</span> : <label className="check tp" onClick={(e) => e.stopPropagation()} title="On: its quantity comes off the main finish. Off: added on top (the main finish stays as it is).">
          <input type="checkbox" disabled={ro} checked={x.ded} onChange={(e) => p.onCommit(setFinishPartOps(model, x.id, { deduct: e.target.checked }), e.target.checked ? 'Deducted from main finish' : 'Added on top of main finish')} /> deduct
        </label>}
        {isLink && !ro && <button className="linkbtn" onClick={(e) => { e.stopPropagation(); p.onCommit(unlinkFromRoomOps(model, x.id), 'Unlinked from room'); }}>Unlink</button>}
        {/* v0.18.1 (Feedback 3, D: "elevation-sourced walls must be clearly marked and reachable") its sheet, at once */}
        {x.wa && p.onGoTo && (() => { const sh = (model.shapesByItem.get(x.id) ?? [])[0]; return sh ? <button className="linkbtn" data-goelev title="Open the elevation it is measured on" onClick={(e) => { e.stopPropagation(); p.onGoTo!(sh.dwg, sh.pg, sh.box); }}>Go to ↗</button> : null; })()}
        {f?.note && <span className="ib bad" title={f.note}><TIcon k="warn" size={12} /></span>}
      </div>
    );
  };
  /** v0.16.4 a ceiling of the room (additional ceiling): its height; under a soffit, the soffit above it finished too */
  const ceilX = (x: RoomPart) => (x.rk === 'add' && x.cat === 'ceiling' && !x.ak ? (
    <div className="rf-subx" data-ceilx={x.id} onClick={(e) => e.stopPropagation()}>
      <Num label="Height" suffix="m" value={x.lv} placeholder="above FFL" disabled={ro} onSave={(v) => p.onCommit(setPartExtraOps(model, x.id, { lv: v }), 'Ceiling height')} title="Its height above FFL 0: a bulkhead under it drops from here" />
      {room.cs && (
        <label className="check tp" title="The soffit above this ceiling is finished all the same (anti-fungal paint above a false ceiling...): its own line, with its own code">
          <input type="checkbox" data-fabove disabled={ro} checked={x.fa} onChange={(e) => p.onCommit(setPartExtraOps(model, x.id, { fa: e.target.checked }), e.target.checked ? 'Finish on the soffit above' : 'No finish on the soffit above')} />
          Finish on the soffit above it
        </label>
      )}
      {room.cs && x.fa && <div className="field"><label>Code above</label><CodeBox model={model} name="fac" value={x.fac} disabled={ro} onSave={(c) => p.onCommit(setPartExtraOps(model, x.id, { fac: c }), 'Code of the finish above')} /></div>}
    </div>
  ) : null);
  const subList = (cat: FinCat) => {
    const l = subs(cat);
    if (!l.length) return null;
    return <div className="rf-subs">{l.map((x) => <div key={x.id}>{sub(x)}{ceilX(x)}{linkedUnder(x.id).map((y) => <div key={y.id} className="rf-under">{sub(y)}</div>)}</div>)}</div>;
  };
  /** v0.16.4 bulkheads and higher upturns: a length each (picked edges or drawn), with their own figures */
  const lineParts = (ak: 'bh' | 'up') => parts.filter((x) => x.ak === ak);
  const ceilChoices = [
    { id: '', label: room.cs ? 'The soffit' : 'The ceiling' },
    ...(ceil && room.cm === 'manual' && !room.cs ? [{ id: ceil.id, label: 'The ceiling areas' }] : []),
    ...parts.filter((x) => x.rk === 'add' && x.cat === 'ceiling' && !x.ak).map((x) => ({ id: x.id, label: x.it.name })),
  ];
  const lineRow = (x: RoomPart) => {
    const f = fin(x.id);
    const n = (model.shapesByItem.get(x.id) ?? []).length;
    return (
      <div key={x.id} data-linepart={x.id}>
        <div className={'rf-sub' + (p.focus === x.id ? ' focus' : '')} onClick={() => p.onPick(new Set([x.id]))} title={f?.note ?? ''}>
          <i className="sw" style={{ background: x.it.color }} />
          <span className="fn">{f?.name ?? x.it.name}</span>
          <span className={'fc' + (f?.code ? '' : ' none')}>{f?.code || 'no code'}</span>
          <span className="fq num">{f ? unitQ(f.qty, f.unit) + ' ' + f.unit : '—'}</span>
          {f?.note && <span className="ib bad" title={f.note}><TIcon k="warn" size={12} /></span>}
          {!ro && <button className="x" data-rmline title="Remove it (and what is drawn of it) · Ctrl+Z brings it back" onClick={(e) => { e.stopPropagation(); p.onCommit(removeFinishOps(model, x.id), x.ak === 'bh' ? 'Removed bulkhead' : 'Removed upturn'); }}>×</button>}
        </div>
        <div className="rf-subx" onClick={(e) => e.stopPropagation()}>
          {x.ak === 'bh' ? (
            <>
              {(() => {
                // (v0.16.5 along a ceiling's edge: that ceiling's height - the box only to give another)
                const au = bulkheadUnderside(model, room, parts, x);
                return <Num label="Underside" suffix="m" value={x.bh} placeholder={au ? '= ' + f2(au.h) + ' ' + au.name : 'above FFL'} disabled={ro} onSave={(v) => p.onCommit(setPartExtraOps(model, x.id, { bh: v }), 'Bulkhead underside')} title={au ? `Along the edge of ${au.name}: its height ${f2(au.h)} is the bulkhead's underside. Type a height only to give another.` : 'Not along a ceiling with a height: its underside above FFL 0. (Picked or drawn on a ceiling\'s edge, that ceiling\'s height is taken.)'} />;
              })()}
              <div className="field"><label>Code</label><CodeBox model={model} name="bhc" value={x.code} disabled={ro} placeholder={'= the ceiling\'s'} onSave={(c) => p.onCommit(setFinishPartOps(model, x.id, { code: c }), 'Bulkhead code')} /></div>
              <div className="field" title="Its top: the soffit (or the room's ceiling) - or another ceiling of the room it rises to"><label>Top</label>
                <select className="input sm" data-bhparent disabled={ro} value={ceilChoices.some((c) => c.id === x.bp) ? x.bp : ''} onChange={(e) => p.onCommit(setPartExtraOps(model, x.id, { bp: e.target.value }), 'Bulkhead under another ceiling')}>
                  {ceilChoices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </div>
            </>
          ) : (
            <>
              <Num label="Height" suffix="m" value={x.h} placeholder="e.g. 1.80" disabled={ro} onSave={(v) => p.onCommit(setFinishPartOps(model, x.id, { h: v }), 'Upturn height')} title="The waterproofing's height along these edges, in place of the room's upturn there" />
              <div className="field"><label>Code</label><CodeBox model={model} name="upc" value={x.code} disabled={ro} placeholder={room.pvc || room.pc ? '= ' + (room.pvc || room.pc) : undefined} onSave={(c) => p.onCommit(setFinishPartOps(model, x.id, { code: c }), 'Upturn code')} /></div>
            </>
          )}
          {!ro && (
            <span className="rf-btns">
              <button className="btn sm" data-pickline onClick={() => rm.start({ k: 'pickLine', room: id, part: x.id })} title={x.ak === 'bh' ? 'Click the edges of the room or of a ceiling it runs along' : 'Click the room\'s edges it runs along'}>Pick edges</button>
              <button className="btn sm ghost" data-drawline onClick={() => rm.start({ k: 'addLine', room: id, part: x.id })}>Draw it</button>
              <span className="faint">{n} piece{n === 1 ? '' : 's'}</span>
            </span>
          )}
        </div>
      </div>
    );
  };
  const addLinePart = (ak: 'bh' | 'up') => {
    const r = ak === 'bh' ? addBulkheadOps(model, p.me, id) : addUpturnOps(model, p.me, id);
    if (!r) return;
    p.onCommit(r.ops, ak === 'bh' ? 'Bulkhead' : 'Higher upturn');
    p.onPick(new Set([r.id]));
    // (picking the line is the default; Draw it is next to it)
    rm.start({ k: 'pickLine', room: id, part: r.id });
  };
  // v0.18 miscellaneous items (kitchen cabinets, wardrobes, vanities, mirrors…)
  const miscParts = parts.filter((x) => x.ak === 'misc');
  const miscNames = useMemo(() => [...new Set([...model.fin.partById.values()].filter((x) => x.ak === 'misc').map((x) => x.it.name))].sort(), [model]);
  const miscFins = useMemo(() => [...new Set([...model.fin.partById.values()].filter((x) => x.ak === 'misc' && x.mf).map((x) => x.mf))].sort(), [model]);
  const addMisc = () => {
    const r = addMiscOps(model, p.me, id, {});
    if (r) p.onCommit(r.ops, 'Miscellaneous item');
  };
  const miscRow = (x: RoomPart) => {
    const f = fin(x.id);
    const n = (model.shapesByItem.get(x.id) ?? []).length;
    // (v0.18.1 a length with a height: what is typed is its area, m² - its length is worked out from the height)
    const withH = x.mu === 'm' && (x.h ?? 0) > 0;
    const fa = withH ? fin(x.id + '>area') : null;
    const unit = withH ? 'm²' : f?.unit ?? (x.mu === 'nr' ? 'nr' : x.mu === 'm' ? 'm' : 'm²');
    const com = (ops: Op[] | { error: string }, label: string) => { if (!('error' in ops) && ops.length) p.onCommit(ops, label); };
    return (
      <div key={x.id} className={'misc-row' + (p.focus === x.id ? ' focus' : '')} data-sub={x.id} data-misc={x.id}>
        <div className="mr-1">
          <CodeBox model={model} name="misccode" value={x.code} placeholder="Code" onSave={(c) => com(setFinishPartOps(model, x.id, { code: c }), 'Item code')} />
          <TextIn value={x.it.name} list="misc-desc" placeholder="Description" name="miscdesc" onSave={(v) => v && com(setFinishPartOps(model, x.id, { name: v }), 'Item description')} />
          <TextIn value={x.mf} list="misc-fin" placeholder="Finish (optional)" name="miscfin" onSave={(v) => com(setMiscOps(model, x.id, { mf: v }), 'Item finish')} />
        </div>
        <div className="mr-2">
          <span className="seg sm" data-miscunit={x.mu} title={n ? 'Remove what is drawn of it to count it in something else' : 'What it is counted in'}>
            {(['nr', 'm', 'm2'] as const).map((u) => <button key={u} type="button" className={x.mu === u ? 'on' : ''} disabled={!!n && x.mu !== u} onClick={() => com(miscUnitOps(model, x.id, u), 'Item unit')}>{MISC_UNIT_LABEL[u]}</button>)}
          </span>
          {x.mu === 'm' && <Num name="misch" label="" suffix="m high" value={x.h} placeholder="height" onSave={(v) => com(setFinishPartOps(model, x.id, { h: v }), 'Item height')} title="Optional: with a height the length becomes an area (m²)" />}
          <Num name="miscq" label="" suffix={unit} value={x.mq} allowZero placeholder={n ? ((withH ? fa : f) ? String(unitQ((withH ? fa! : f!).qty / (q?.N || 1), unit)) : '0') + ' drawn' : 'type or draw'} onSave={(v) => com(setMiscOps(model, x.id, { mq: v }), 'Item quantity')} title="Empty = what is drawn of it. Typed = that figure (before Times)" />
          {x.mq !== null && n > 0 && <span className="autotag off" title="A typed quantity is used: what is drawn of it is kept but not counted">typed</span>}
          {x.mq === null && n > 0 && <span className="autotag" title="Measured on the drawing">auto</span>}
          <span className="grow" />
          {!ro && <button className="btn sm" data-miscdraw onClick={() => rm.start({ k: 'misc', room: id, part: x.id })} title={x.mu === 'nr' ? 'Click each one on the drawing' : x.mu === 'm' ? 'Draw its length on the drawing' : 'Draw its area on the drawing'}>{n ? 'Measure more' : 'Measure'}</button>}
          {!ro && <button className="btn icon ghost sm" data-miscdup title="Duplicate this item" onClick={() => { const r = dupMiscOps(model, p.me, x.id); if (r) p.onCommit(r.ops, 'Duplicated item'); }}><TIcon k="copy" size={13} /></button>}
          {!ro && <button className="btn icon ghost sm" data-miscdel title="Remove it (and what is drawn of it) · Ctrl+Z brings it back" onClick={() => p.onCommit(removeFinishOps(model, x.id), 'Removed item')}><TIcon k="trash" size={13} /></button>}
        </div>
        {f?.note && <div className="mr-note"><TIcon k="warn" size={12} /> {f.note}</div>}
      </div>
    );
  };
  const cq = q?.ceil;
  const addBtn = (cat: FinCat) => !ro && <button className="linkbtn rf-add" data-add={cat} onClick={() => addPart(cat)}>+ Additional {CAT_NAME[cat].toLowerCase()}</button>;
  const lines = work ? roomWorking(model, id) : [];

  return (
    <div className="qto-detail rm-detail" data-cat="finish" data-roomprops={id}>
      <div className="qd-head">
        <ColorButton value={room.it.color} disabled={ro} onPick={(c) => set({ color: c }, 'Colour')} />
        <input
          ref={nameRef}
          className="input qd-name"
          data-roomname
          value={name}
          disabled={ro}
          placeholder="Room name, e.g. Master Bedroom"
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { escName.current = true; setName(room.name); e.stopPropagation(); (e.target as HTMLInputElement).blur(); } }}
        />
        <span className="kindchip room">Room</span>
        {!ro && <button className="btn icon ghost sm" title="Duplicate this room…" onClick={() => p.onDuplicate(id)}><TIcon k="copy" /></button>}
        <button className="btn icon ghost sm" title="Close" onClick={p.onClose}><TIcon k="x" /></button>
      </div>
      <div className="qd-body" ref={bodyRef}>
        <fieldset className="qd-fields" disabled={ro}>
          <div className="rf-top">
            <div className="field l">
              <label>Description</label>
              <input className="input txt" data-roomdesc value={desc} placeholder="e.g. Type A apartment" onChange={(e) => setDesc(e.target.value)} onBlur={() => desc.trim() !== room.desc && set({ desc }, 'Room description')} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            </div>
            <Num label="Times" suffix="×" value={room.times === 1 ? null : room.times} placeholder="1" onSave={(v) => set({ times: v }, 'Room times')} title="Typical floors / apartments: every quantity of the room × this" />
          </div>
        </fieldset>
        {filled && <p className="hint rm-filled">Codes and heights filled in from the last <b>{filled}</b> — change any of them below.</p>}
        <div className="qd-big rm-big">
          <span className="k">Floor area (A)</span>
          <span className="v num">{q ? unitQ(q.A, 'm²') : '—'} <small>m²</small></span>
        </div>
        <div className="qd-stats">
          <span>wall perimeter (P) <b className="num">{q ? unitQ(q.P, 'm') : '—'} m</b></span>
          {q && q.open > 0 && <span>open edges {unitQ(q.open, 'm')} m (no wall)</span>}
          <span>{shapes} outline{shapes === 1 ? '' : 's'}</span>
          {room.times !== 1 && <span>× {room.times} (Times)</span>}
          {!ro && <button className="linkbtn" data-drawoutline onClick={() => { p.onMeasure(id); rm.send({ k: 'outline', room: id }); }}>{shapes ? 'Draw another outline' : 'Draw its outline'}</button>}
        </div>
        <Picking rm={rm} room={id} />
        {warns.length > 0 && (
          <div className="warnbox rm-warns" data-roomwarn><TIcon k="warn" /><div>{warns.map((w) => <div key={w}>{w}</div>)}</div></div>
        )}

        <fieldset className="qd-fields rm-fins" disabled={ro}>
          {/* v0.18 General: the room height - what the walls, the plaster and the soffit are measured to */}
          <div className={blk('general')} data-blk="general">
            <div className="rf-h"><b>General</b>{zoned && <span className="autotag" title="The walls are measured by the ceiling over each stretch of them">by the ceilings</span>}</div>
            <div className="rf-f">
              <Num name="rmh" label="Room height" suffix="m" value={room.rmh} placeholder="floor to soffit" onSave={(v) => set({ rmh: v }, 'Room height')} help={<Help k="rmh" />} title="Finished floor to the underside of the slab" />
 {hasFc && <Num name="fe" label="Finish above ceiling" suffix="m" value={room.fe} allowZero placeholder="0.10" onSave={(v) => set({ fe: v }, 'Finish above the false ceiling')} help={<Help k="fe" />} title="How far the wall finish goes above a false ceiling" />}
            </div>
            {!zoned && <div className="faint rf-hint">Fill it and the walls follow the ceilings: finish to each false ceiling + 0.10, plaster, and the wall above the false ceiling. Empty: the room is measured as before (one wall height).</div>}
            {zoned && q && q.zones.length > 0 && (
              <div className="rm-zones" data-zones>
                {q.zones.map((z, i) => (
                  <div key={i} className="rz"><b className="num">{unitQ(z.len, 'm')} m</b> of wall {z.fc !== null ? <>under a ceiling at <b className="num">{f2(z.fc)}</b></> : <>with no false ceiling</>} → finish to <b className="num">{f2(room.hw && room.hw > 0 ? room.hw : z.top)}</b></div>
                ))}
              </div>
            )}
          </div>

          <div className={blk('floor')} data-blk="floor">
            <div className="rf-h"><b>Floor finish</b><span className="num">{qtyOf('floor')}</span></div>
            <div className="rf-f">
              <div className="field"><label>Code</label><CodeBox model={model} name="fc" value={room.fc} title="Floor finish code, as in the finishes schedule: its m² = the room's area (cut-outs off)" onSave={(c) => set({ fc: c }, 'Floor finish code')} /></div>
            </div>
            {subList('floor')}
            {addBtn('floor')}
          </div>

          <div className={blk('skirting')} data-blk="skirting">
            <div className="rf-h"><b>Skirting</b><span className="num">{qtyOf('skirting')}</span></div>
            <div className="rf-f">
              <div className="field"><label>Code</label><CodeBox model={model} name="kc" value={room.kc} title="Skirting code: its m = the wall edges less the doors" onSave={(c) => set({ kc: c }, 'Skirting code')} /></div>
              <Num name="hs" label="Skirting height" suffix="m" value={room.hs} placeholder="none" allowZero onSave={(v) => set({ hs: v }, 'Skirting height')} help={<Help k="hs" />} title="Its height comes off the wall finish height (no skirting: leave empty)" />
            </div>
            {subList('skirting')}
            {addBtn('skirting')}
          </div>

          <div className={blk('wall')} data-blk="wall">
            <div className="rf-h"><b>Wall finish</b><span className="num">{qtyOf('wall')}</span></div>
            <div className="rf-f">
              <div className="field"><label>Code</label><CodeBox model={model} name="wc" value={room.wc} title="Wall finish code (paint, tiles): its m² = the walls from the skirting up to each ceiling + the allowance, openings off" onSave={(c) => set({ wc: c }, 'Wall finish code')} /></div>
              <Num name="hw" label={zoned ? 'Finish top' : 'Wall height'} suffix="m" value={room.hw} placeholder={zoned ? 'by the ceilings' : 'from floor'} onSave={(v) => set({ hw: v }, 'Wall finish height')} help={zoned ? <Help k="hw" /> : undefined} title={zoned ? 'Empty: up to each false ceiling + the allowance (the room height where there is none). Typed: that height all round' : 'Wall finish height from the finished floor; the band above the skirting is measured'} />
            </div>
            {zoned && (
              <div className="rf-opt" data-blk="plaster">
                <div className="rf-h sub"><b>Plaster</b><Help k="plaster" /><span className="num">{qtyOf('plaster')}</span></div>
                <div className="rf-f">
                  <div className="field"><label>Code</label><CodeBox model={model} name="plc" kind="wall" value={room.plc} placeholder="none: not measured" title="Plaster code: from the floor up to its top, openings off. No code: not measured" onSave={(c) => set({ plc: c }, 'Plaster code')} /></div>
                  {!room.ppf && <Num name="php" label="Plaster top" suffix="m" value={room.php} placeholder={'soffit ' + f2(room.rmh ?? 0)} onSave={(v) => set({ php: v }, 'Plaster height')} title="Empty = full height, to the soffit" />}
                </div>
                <label className="check tp" title="Plaster only as high as the wall finish goes over each stretch of wall (nothing behind the wall above the false ceiling)">
                  <input type="checkbox" data-ppf checked={room.ppf} onChange={(e) => set({ ppf: e.target.checked }, e.target.checked ? 'Plaster stops with the finish' : 'Plaster full height')} /> Stops where the wall finish stops
                </label>
              </div>
            )}
            {subList('wall')}
            <div className="rf-adds">
              {addBtn('wall')}
              {!ro && <button className="linkbtn rf-add" data-addwa onClick={() => addPart('wall', true)} title="Cladding or a panel of any shape, drawn as an area on its elevation (any sheet): its own m²">+ As an area (elevation)</button>}
            </div>
          </div>

          <div className={blk('ceiling')} data-blk="ceiling">
            <div className="rf-h"><b>{room.cs ? 'Soffit (slab underside)' : 'Ceiling finish'}</b>{room.cs && <Help k="soffit" />}<span className="num">{qtyOf('ceiling')}</span></div>
            {!room.cs && (
              // v0.18.1 a room from before: its ceiling is a false ceiling at its height - made soffit first on request only
              <div className="rf-line rf-old" data-oldceil>
                <span className="faint">{room.cc || room.ch !== null || room.cm === 'manual' ? <>Old-style ceiling: a false ceiling{room.ch !== null ? ' at ' + f2(room.ch) + ' m' : ''}, no soffit.</> : 'Old-style ceiling (no soffit yet).'}</span>
                {!ro && <button className="btn sm" data-soffitfirst title="The ceiling becomes a false ceiling under the soffit (same code, height and m²); then give the soffit its code" onClick={() => {
                  const r = soffitFirstOps(model, p.me, id);
                  if (!r.ops.length) return;
                  p.onCommit(r.ops, 'Ceiling: soffit first');
                  if (r.onTop.length) p.onToast?.(`${r.onTop.join(', ')} was “on top” of the ceiling: under the soffit it is a false ceiling — check its area.`);
                }}>Convert: soffit + false ceiling</button>}
              </div>
            )}
            <div className="rf-f">
              <div className="field"><label>Code</label><CodeBox model={model} name="cc" value={room.cc} placeholder={room.cs ? 'needed' : undefined} title={room.cs ? 'Soffit finish code (paint on the slab): needed while some of the soffit is not under a false ceiling' : 'Ceiling finish code'} onSave={(c) => set({ cc: c }, room.cs ? 'Soffit finish code' : 'Ceiling finish code')} /></div>
              {room.cs && room.ch === null ? (
                <div className="field"><label>Height</label><span className="faint rf-at" data-soffitat>{zoned ? 'Room height ' + f2(room.rmh!) + ' m' : 'Room height needed'}</span></div>
              ) : <Num name="ch" label={room.cs ? 'Soffit height' : 'Ceiling height'} suffix="m" value={room.ch} placeholder={room.cs && zoned ? 'room h ' + f2(room.rmh ?? 0) : 'above FFL'} disabled={ro} onSave={(v) => set({ ch: v }, room.cs ? 'Soffit height' : 'Ceiling height')} help={room.cs ? undefined : <Help k="ch" />} title="Above FFL 0: a bulkhead under it drops from here" />}
              {!room.cs && <div className="field">
                <label>Area</label>
                <span className="seg" data-ceilmode>
                  <button type="button" className={room.cm === 'auto' ? 'on' : ''} title="The floor area: follows the outline" onClick={() => room.cm !== 'auto' && p.onCommit(setCeilingModeOps(model, p.me, id, 'auto').ops, 'Ceiling auto')}>Auto</button>
                  <button type="button" className={room.cm === 'manual' ? 'on' : ''} title="Measure the ceiling as its own area(s): bulkheads, a ceiling that differs from the floor" onClick={() => {
                    if (room.cm === 'manual') return;
                    const r = setCeilingModeOps(model, p.me, id, 'manual');
                    p.onCommit(r.ops, 'Ceiling manual');
                    if (r.ceil) rm.start({ k: 'ceil', room: id, part: r.ceil });
                  }}>Manual</button>
                </span>
              </div>}
            </div>
            {cq && !cq.equal && !room.cs && (cq.noted ? (
              <div className="rf-line" data-ceilnoted>
                <span className="faint">Ceilings {f2(cq.covered)} m² ≠ floor {f2(cq.A)} m² — <i>{cq.noted}</i></span>
                {!ro && <button className="linkbtn" onClick={() => setCeilAsk(cq.noted)}>Change</button>}
              </div>
            ) : (
              <button className="btn sm rf-alert" data-ceilalert disabled={ro} onClick={() => setCeilAsk('')} title="The ceilings drawn should cover the floor. Draw the rest, or say why not (a room open to the sky, no ceiling)">
                <TIcon k="warn" size={12} /> Ceilings {f2(cq.covered)} m² ≠ floor {f2(cq.A)} m²
              </button>
            ))}
            {ceilAsk !== null && !ro && (
              <div className="rf-ask" data-ceilask>
                <input className="input sm" autoFocus placeholder="Why — e.g. open to the sky, no ceiling" value={ceilAsk} onChange={(e) => setCeilAsk(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setCeilAsk(null); } if (e.key === 'Enter' && ceilAsk.trim()) { p.onCommit(ceilingNoteOps(model, id, ceilAsk), 'Ceiling note'); setCeilAsk(null); } }} />
                <button className="btn sm primary" data-ceilok disabled={!ceilAsk.trim()} onClick={() => { p.onCommit(ceilingNoteOps(model, id, ceilAsk), 'Ceiling note'); setCeilAsk(null); }}>Dismiss with this note</button>
                <button className="btn sm ghost" onClick={() => setCeilAsk(null)}>Cancel</button>
              </div>
            )}
            {room.cm === 'manual' && !room.cs && (
              <div className="rf-line">
                <span className="faint">{ceil ? `${(model.shapesByItem.get(ceil.id) ?? []).length} ceiling area(s) drawn` : 'No ceiling area yet'}</span>
                {!ro && ceil && <button className="linkbtn" data-drawceil onClick={() => rm.start({ k: 'ceil', room: id, part: ceil.id })}>Draw the ceiling</button>}
              </div>
            )}
            <div className="rf-opt" data-blk="gap">
              <label className="check tp">
                <input type="checkbox" data-gap checked={!!room.gm || gapAsk} onChange={(e) => {
                  if (e.target.checked) setGapAsk(true);
                  else { setGapAsk(false); p.onCommit(setShadowGapOps(model, id, 'off'), 'Shadow gap off'); }
                }} />
                Shadow gap {room.gm && <span className="num faint">{qtyOf('gap')}</span>}
              </label>
              {(room.gm || gapAsk) && (
                <div className="rf-f">
                  {!room.gm ? (
                    <div className="rf-ask">
                      <button type="button" className="btn sm" data-gappick onClick={() => { setGapAsk(false); p.onCommit(setShadowGapOps(model, id, 'pick'), 'Shadow gap on picked edges'); rm.start({ k: 'gap', room: id }); }}>Pick the edges on the drawing</button>
                      <button type="button" className="btn sm" data-gapall onClick={() => { setGapAsk(false); p.onCommit(setShadowGapOps(model, id, 'all'), 'Shadow gap all round'); }}title="Every wall edge where a ceiling meets it - not the free edges of a ceiling inside the room, nor walls with no false ceiling under a soffit">Entire perimeter</button>
                    </div>
                  ) : (
                    <>
                      <div className="field"><label>Code</label><CodeBox model={model} name="gc" value={room.gc} title="Shadow gap code: its m where a false ceiling meets the walls" onSave={(c) => set({ gc: c }, 'Shadow gap code')} /></div>
                      <div className="field">
                        <label>Where</label>
                        <span className="seg">
                          <button type="button" className={room.gm === 'pick' ? 'on' : ''} onClick={() => { if (room.gm !== 'pick') p.onCommit(setShadowGapOps(model, id, 'pick'), 'Shadow gap on picked edges'); rm.start({ k: 'gap', room: id }); }} title="Pick the outline / ceiling edges on the drawing">Edges picked</button>
                          <button type="button" className={room.gm === 'all' ? 'on' : ''} title="Every wall edge where a ceiling meets it - not the free edges of a ceiling inside the room" onClick={() => room.gm !== 'all' && p.onCommit(setShadowGapOps(model, id, 'all'), 'Shadow gap all round')}>Entire perimeter</button>
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
            {subList('ceiling')}
            {!ro && <button className="linkbtn rf-add" data-add="ceiling" onClick={() => addPart('ceiling')}>{room.cs ? '+ False ceiling' : '+ Additional ceiling finish'}</button>}
            <div className="rf-subs" data-bulkheads>{lineParts('bh').map(lineRow)}</div>
            {!ro && <button className="linkbtn rf-add" data-addbh onClick={() => addLinePart('bh')} title="Running metres, its drop from the ceiling above it in its code (each drop its own rate)">+ Bulkhead</button>}
          </div>

          {hasFc && (
            <div className={blk('band')} data-blk="band">
              <div className="rf-h"><b>Walls above false ceiling</b><Help k="band" /><span className="num">{room.bn ? 'no finish' : qtyOf('band')}</span></div>
              {!room.bn && (
                <div className="rf-f">
                  <div className="field"><label>Code</label><CodeBox model={model} name="bc" kind="wall" value={room.bc} placeholder="e.g. anti-fungal paint" title="The walls between where the finish stops and the soffit, over the stretches with a false ceiling" onSave={(c) => set({ bc: c }, 'Code of the walls above the false ceiling')} /></div>
                </div>
              )}
              {!room.bn && !fin('band') && <div className="faint rf-hint">Measured by itself wherever a false ceiling is drawn (or the room’s ceiling has a height below the room height): from where the wall finish stops, up to the soffit.</div>}
              <label className="check tp" title="No paint or other finish on the walls above the false ceiling in this room">
                <input type="checkbox" data-bn checked={room.bn} onChange={(e) => set({ bn: e.target.checked }, e.target.checked ? 'No finish above the false ceiling' : 'Walls above the false ceiling measured')} /> No finish
              </label>
            </div>
          )}

          <div className={blk('wp')} data-blk="wp">
            <label className="check tp rf-h">
              <input type="checkbox" data-wp checked={!!room.pm} onChange={(e) => p.onCommit(setWaterproofingOps(model, id, { mode: e.target.checked ? 'up' : 'off' }), e.target.checked ? 'Waterproofing on' : 'Waterproofing off')} />
              <b>Waterproofing</b> <span className="faint">wet areas</span>
            </label>
            {room.pm && (
              <>
                <div className="rf-f">
                  <div className="field"><label>Code</label><CodeBox model={model} name="pc" value={room.pc} title="Waterproofing code: the floor, and the walls up to the upturn (or full height)" onSave={(c) => p.onCommit(setWaterproofingOps(model, id, { code: c }), 'Waterproofing code')} /></div>
                  {room.pm === 'up'
                    ? <Num label="Upturn height" suffix="m" value={room.pu} placeholder="e.g. 0.30" onSave={(v) => p.onCommit(setWaterproofingOps(model, id, { upturn: v }), 'Waterproofing upturn')} />
                    : <Num label="Up to level" suffix="m" value={room.pl} placeholder={room.hw !== null ? 'wall h ' + f2(room.hw) : 'e.g. 1.80'} onSave={(v) => p.onCommit(setWaterproofingOps(model, id, { level: v }), 'Waterproofing level')} title="Empty = the wall finish height" />}
                </div>
                <span className="seg rf-seg" data-wpmode>
                  <button type="button" className={room.pm === 'up' ? 'on' : ''} onClick={() => room.pm !== 'up' && p.onCommit(setWaterproofingOps(model, id, { mode: 'up' }), 'Waterproofing floor with upturn')}>Floor with upturn</button>
                  <button type="button" className={room.pm === 'full' ? 'on' : ''} onClick={() => room.pm !== 'full' && p.onCommit(setWaterproofingOps(model, id, { mode: 'full' }), 'Waterproofing full wall height')}>Full wall height</button>
                </span>
                <div className="rf-f rf-wp2">
                  <div className="field"><label>Horizontal <span className="num faint">{qtyOf('wph')}</span></label><CodeBox model={model} name="phc" value={room.phc} placeholder={room.pc ? '= ' + room.pc : undefined} onSave={(c) => p.onCommit(setWaterproofingOps(model, id, { hcode: c }), 'Horizontal waterproofing code')} /></div>
                  <div className="field"><label>Vertical <span className="num faint">{qtyOf('wpv')}</span></label><CodeBox model={model} name="pvc" value={room.pvc} placeholder={room.pc ? '= ' + room.pc : undefined} onSave={(c) => p.onCommit(setWaterproofingOps(model, id, { vcode: c }), 'Vertical waterproofing code')} /></div>
                </div>
              </>
            )}
            {(room.pm || lineParts('up').length > 0) && <div className="rf-subs" data-upturns>{lineParts('up').map(lineRow)}</div>}
            {room.pm && !ro && <button className="linkbtn rf-add" data-addup onClick={() => addLinePart('up')} title="Showers, a cistern tank's walls: picked edges with a higher upturn, in place of the room's there">+ Higher upturn (picked sides)</button>}
          </div>
        </fieldset>

        <div className="qd-sec" data-doors>
          <h5>Doors and openings{q && q.openings.length ? ` (${q.openings.length})` : ''}</h5>
          {q && q.openings.length === 0 && <p className="hint">They correct the room’s finishes only (never counted as doors). Doors come from the door schedule.</p>}
          {q?.openings.map((o) => (
            <div key={o.id} className={'rf-door' + (o.onOpen ? ' bad' : '')} data-opening={o.id}>
              <span className="fn"><b>{o.tag}</b> {o.w ? f2(o.w) : '?'} × {o.h ? f2(o.h) : '?'}</span>
              {o.k === 'open' ? (
                <label className="rf-sill">sill <input className="input xs num" disabled={ro} defaultValue={f2(o.sill)} key={o.id + o.sill} onBlur={(e) => { const n = parseNum(e.target.value); if (n !== undefined && (n ?? 0) !== o.sill && (n === null || n >= 0)) p.onCommit(setOpeningSillOps(o.id, n), 'Opening sill'); }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} /></label>
              ) : <span className="faint">door</span>}
              {o.onOpen && <span className="bad" title="An open edge has no wall: not deducted">on an open edge</span>}
              {!ro && <button className="x" title="Remove" onClick={() => p.onCommit(removeRoomOpeningOps(o.id), 'Removed ' + (o.k === 'door' ? 'door' : 'opening') + ' from room')}>×</button>}
            </div>
          ))}
          {!ro && (
            <div className="rf-btns">
              <button className="btn sm" data-adddoor onClick={() => rm.start({ k: 'door', room: id })}><TIcon k="door" /> Add a door</button>
              <button className="btn sm" data-addopen onClick={() => rm.start({ k: 'open', room: id })}>Add an opening</button>
            </div>
          )}
        </div>

        <div className="qd-sec">
          <h5>Open edges (no wall)</h5>
          <div className="rf-line">
            <span>{openN ? `${openN} edge${openN > 1 ? 's' : ''}${q ? ' · ' + unitQ(q.open, 'm') + ' m' : ''}` : <span className="faint">None — every edge has a wall.</span>}</span>
            {!ro && <button className="btn sm" data-pickedges onClick={() => rm.start({ k: 'edge', room: id })}>Pick open edges</button>}
          </div>
          {/* (v0.16.5 Nabil: each open edge can be made a wall edge again - its ×; or click it on the drawing + Del) */}
          {openN > 0 && (
            <div className="rf-subs" data-openedges>
              {openEdgesOf(model, id).map((e, i) => (
                <div key={e.shape + ':' + e.seg} className="rf-sub" data-openedge={e.shape + ':' + e.seg} title={(e.sheet ? e.sheet + ' · ' : '') + 'On the drawing: click the dashed edge, then Del'}>
                  <span className="fn">Open edge {i + 1}</span>
                  <span className="fq num">{e.len === null ? '—' : unitQ(e.len, 'm') + ' m'}</span>
                  {!ro && <button className="x" data-rmopen title="A wall edge again · Ctrl+Z brings it back" onClick={() => {
                    const sh = model.shapes.find((x) => x.id === e.shape);
                    if (sh) p.onCommit(setEdgeOps(sh, [e.seg], 'open', false), 'Wall edge');
                  }}>×</button>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="qd-sec" data-miscsec>
          <h5>Miscellaneous items{miscParts.length ? ` (${miscParts.length})` : ''} <Help k="misc" /></h5>
          <datalist id="misc-desc">{miscNames.map((n) => <option key={n} value={n} />)}</datalist>
          <datalist id="misc-fin">{miscFins.map((n) => <option key={n} value={n} />)}</datalist>
          <fieldset className="qd-fields misc-list" disabled={ro}>{miscParts.map(miscRow)}</fieldset>
          {!miscParts.length && <div className="faint rf-hint">Kitchen cabinets, wardrobes, vanities, mirrors… counted, measured as a length or an area, or typed.</div>}
          {!ro && <button className="linkbtn rf-add" data-addmisc onClick={addMisc}>+ Item</button>}
        </div>

        <div className="qd-sec">
          <button className="btn sm ghost" data-working onClick={() => setWork((x) => !x)}>{work ? 'Hide working' : 'Show working'}</button>
          {work && (
            <>
              <pre className="rm-work" data-workingtext>{lines.join('\n')}</pre>
              <button className="btn sm ghost" onClick={async () => {
                const t = lines.join('\n');
                if (!gt().clipboard?.(t)) { try { await navigator.clipboard.writeText(t); } catch { /* */ } }
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}>{copied ? 'Copied' : 'Copy'}</button>
            </>
          )}
        </div>

        {!ro && (
          <div className="qd-sec danger">
            <button className="btn sm danger" onClick={() => p.onDelete(id)}>Delete this room…</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ an additional finish selected
export function PartProps({ model, part, ro, rm, onCommit, onPick, onDelete }: {
  model: QtoModel;
  part: RoomPart;
  ro: boolean;
  rm: RoomModeCtl;
  onCommit: (ops: Op[], label: string) => void;
  onPick: (ids: Set<string>) => void;
  onDelete: (id: string) => void;
}) {
  useQtoFmt();
  const room = model.fin.roomById.get(part.room);
  const q = model.fin.qty.get(part.room);
  const f = q?.byKey.get(part.id) ?? null;
  const [name, setName] = useState(part.it.name);
  useEffect(() => setName(part.it.name), [part.it.name]);
  if (!room) return null;
  const set = (patch: Parameters<typeof setFinishPartOps>[2], label: string) => { const ops = setFinishPartOps(model, part.id, patch); if (ops.length) onCommit(ops, label); };
  // (v0.18 an elevation: its areas are what is drawn of it; the lengths in it are the plan edges it stands for)
  const edges = part.wa ? (model.shapesByItem.get(part.id) ?? []).filter((x) => x.k === 'line').length : 0;
  const drawn = (model.shapesByItem.get(part.id) ?? []).length - edges;
  const isLine = (part.cat === 'wall' && !part.wa) || part.cat === 'skirting';
  const what = 'Additional ' + CAT_NAME[part.cat].toLowerCase() + (part.wa ? ' · an area' : '');
  /** v0.16.5 an additional wall: along the walls (length × height) or an area (an elevation) - while nothing is drawn */
  const setWa = (on: boolean) => {
    const r = wallAreaOps(model, part.id, on);
    if ('error' in r) return;
    if (!r.length) return;
    onCommit(r, on ? 'Drawn as an area' : 'Drawn along the walls');
    if (rm.mode?.part === part.id) rm.start({ k: on ? 'addArea' : 'addLine', room: room.id, part: part.id });
  };
  return (
    <div className="qto-detail rm-detail" data-cat="finish" data-partprops={part.id}>
      <div className="qd-head">
        <button className="btn sm ghost rm-back" title="Back to the room" onClick={() => onPick(new Set([room.id]))}>‹ {room.name}</button>
        <input className="input qd-name" value={name} disabled={ro} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name.trim() !== part.it.name && set({ name }, 'Renamed finish')} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        <button className="btn icon ghost sm" title="Close" onClick={() => onPick(new Set())}><TIcon k="x" /></button>
      </div>
      <div className="qd-body">
        <div className="qd-big">
          <span className="k">{what}</span>
          <span className="v num">{f ? unitQ(f.qty, f.unit) : '—'} <small>{f?.unit ?? (isLine && part.cat === 'skirting' ? 'm' : 'm²')}</small></span>
        </div>
        <Picking rm={rm} room={room.id} text={part.wa ? 'Draw its area on the drawing — on any sheet (its elevation).' : undefined} />
        {f?.note && <div className="warnbox"><TIcon k="warn" /><div>{f.note}</div></div>}
        <fieldset className="qd-fields" disabled={ro}>
          {part.cat === 'wall' && (
            <div className="field l" data-wamode={part.wa ? 'area' : 'line'}>
              <label>Drawn</label>
              <div className="seg sm" title={drawn ? 'Remove what is drawn of it to draw it the other way' : ''}>
                <button type="button" className={part.wa ? '' : 'on'} disabled={!!drawn && part.wa} data-wa="line" onClick={() => setWa(false)} title="A length along the room's walls × its height (doors on it come off)">Along the walls</button>
                <button type="button" className={part.wa ? 'on' : ''} disabled={!!drawn && !part.wa} data-wa="area" onClick={() => setWa(true)} title="An area of any shape, drawn on its elevation (any sheet): wooden cladding, a feature panel">As an area</button>
              </div>
            </div>
          )}
          <div className="field l"><label>Code</label><CodeBox model={model} name="partcode" kind={part.cat} value={part.code} onSave={(c) => set({ code: c }, 'Finish code')} /></div>
          {part.cat === 'wall' && part.wa && <div className="faint rf-hint">Its m² as drawn — openings in it are yours to cut out (a hole: H while drawing). {part.wr ? 'It stands for the plan edges picked: the wall finish is not taken along them.' : 'Deducted: all of it comes off the wall finish.'}</div>}
          {part.cat === 'wall' && part.wa && (
            <div className="rf-opt" data-elev>
              <label className="check tp" title="The whole wall measured on its elevation, in place of length × height on the plan">
                <input type="checkbox" data-wr checked={part.wr} onChange={(e) => { const r = wallReplaceOps(model, part.id, e.target.checked); if (!('error' in r) && r.length) onCommit(r, e.target.checked ? 'Elevation stands for its plan edges' : 'Elevation: an area off the wall finish'); }} />
                It replaces the wall on the plan <Help k="elev" />
              </label>
              {part.wr && (
                <div className="rf-line">
                  <span className={edges ? 'faint' : 'warnt'}>{edges ? `${edges} plan edge${edges > 1 ? 's' : ''} picked` : 'No plan edge picked yet: its area comes off the wall finish meanwhile'}</span>
                  {!ro && <button className="btn sm" data-pickrepl onClick={() => rm.start({ k: 'pickLine', room: room.id, part: part.id })} title="On the plan: click the edges of the room this elevation shows">Pick the plan edges</button>}
                </div>
              )}
            </div>
          )}
          {part.cat === 'wall' && !part.wa && (
            <div className="fields">
              <Num label="Height" suffix="m" value={part.h} placeholder={'to h ' + f2(room.hw ?? 0)} onSave={(v) => set({ h: v }, 'Finish height')} title="Empty = up to the wall finish height" />
              <Num label="Bottom level" suffix="m" value={part.bl} allowZero placeholder={'skirting ' + f2(room.hs ?? 0)} onSave={(v) => set({ bl: v }, 'Finish bottom level')} title="Empty = the top of the skirting (e.g. 0.90 for a kitchen splashback)" />
            </div>
          )}
          {part.cat === 'skirting' && (
            <div className="fields"><Num label="Height" suffix="m" value={part.h} placeholder={'h ' + f2(room.hs ?? 0)} onSave={(v) => set({ h: v }, 'Skirting height')} /></div>
          )}
          {part.cat === 'ceiling' && (
            <div className="fields" data-ceilx={part.id}>
              <Num label="Height" suffix="m" value={part.lv} placeholder="above FFL" onSave={(v) => onCommit(setPartExtraOps(model, part.id, { lv: v }), 'Ceiling height')} title="Its height above FFL 0: a bulkhead under it drops from here" />
              {room.cs && (
                <label className="check tp" title="The soffit above this ceiling is finished all the same (anti-fungal paint above a false ceiling...): its own line, with its own code">
                  <input type="checkbox" data-fabove checked={part.fa} onChange={(e) => onCommit(setPartExtraOps(model, part.id, { fa: e.target.checked }), e.target.checked ? 'Finish on the soffit above' : 'No finish on the soffit above')} /> Finish on the soffit above it
                </label>
              )}
              {room.cs && part.fa && <div className="field"><label>Code above</label><CodeBox model={model} name="fac" value={part.fac} onSave={(c) => onCommit(setPartExtraOps(model, part.id, { fac: c }), 'Code of the finish above')} /></div>}
            </div>
          )}
          {!isLine && !part.wa && (
            <label className="check tp"><input type="checkbox" data-full checked={part.full} onChange={(e) => set({ full: e.target.checked }, e.target.checked ? 'Full room area' : 'Drawn area')} /> Full room area <span className="faint">{room.cs && part.cat === 'ceiling' ? '(nothing to draw; the false ceilings drawn come off it)' : '(nothing to draw)'}</span></label>
          )}
{!(room.cs && part.cat === 'ceiling') && !part.wr && (
          <label className="check tp" title="Off: added on top (e.g. cladding over a painted wall) - the main finish stays as it is">
            <input type="checkbox" data-deduct checked={part.ded} onChange={(e) => set({ deduct: e.target.checked }, e.target.checked ? 'Deducted from main finish' : 'Added on top of main finish')} /> Deduct from the {CAT_NAME[part.cat].toLowerCase()}
          </label>)}
        </fieldset>
        {!part.full && (
          <div className="rf-line">
            <span className="faint">{drawn ? `${drawn} piece${drawn > 1 ? 's' : ''} drawn` : 'Not drawn yet'}</span>
            {!ro && <button className="btn sm" data-drawpart onClick={() => rm.start({ k: isLine ? 'addLine' : 'addArea', room: room.id, part: part.id })}>{drawn ? 'Draw more' : 'Draw it'}</button>}
          </div>
        )}
        {!ro && (
          <div className="qd-sec danger">
            <button className="btn sm danger" onClick={() => onDelete(part.id)}>Delete this finish</button>
          </div>
        )}
      </div>
    </div>
  );
}
/** a text box saved on leaving it (Enter leaves it, Esc puts it back) */
function TextIn({ value, onSave, placeholder, list, name }: { value: string; onSave: (v: string) => void; placeholder?: string; list?: string; name?: string }) {
  const [v, setV] = useState<string | null>(null);
  return (
    <input className="input txt" data-txt={name} list={list} value={v ?? value} placeholder={placeholder} onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== null && v.trim() !== value) onSave(v.trim()); setV(null); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { e.stopPropagation(); setV(null); } }} />
  );
}
/** removing an additional finish: one step (its shapes go with it) */
export const deletePartOps = removeFinishOps;

// ------------------------------------------------------------------ the finish code of any take-off
export function FinishCodeField({ model, it, ro, onCommit, onLinkRoom }: { model: QtoModel; it: TItem; ro: boolean; onCommit: (ops: Op[], label: string) => void; onLinkRoom?: (ids: string[]) => void }) {
  const room = it.rk === 'link' && it.rm ? model.fin.roomById.get(it.rm) : null;
  const part = model.fin.partById.get(it.id);
  const under = part ? (part.under.startsWith('ti:') ? model.itemById.get(part.under)?.name ?? '' : CAT_NAME[part.cat]) : '';
  return (
    <div className="field l fincode" data-fincode>
      <label>Finish code <span className="faint">— in the Finishes Summary when set</span></label>
      <CodeBox model={model} name="fcode" value={it.fcode ?? ''} disabled={ro} onSave={(c) => onCommit(setFinishCodeOps(model, [it.id], c), c ? 'Finish code' : 'Finish code cleared')} />
      {room ? (
        <div className="rm-linked" data-inroom>
          <span>In room <b>{roomLabel(room)}</b> › {under}</span>
          {part && <label className="check tp"><input type="checkbox" disabled={ro} checked={part.ded} onChange={(e) => onCommit(setFinishPartOps(model, it.id, { deduct: e.target.checked }), e.target.checked ? 'Deducted from main finish' : 'Added on top of main finish')} /> deduct from main</label>}
          {!ro && <button className="linkbtn" data-unlinkroom onClick={() => onCommit(unlinkFromRoomOps(model, it.id), 'Unlinked from room')}>Unlink</button>}
          {/* a length shown as wall finish: length × this height */}
          {part && part.cat === 'wall' && (it.kind === 'line' || it.kind === 'wall') && (
            <div className="rm-linkh"><Num label="Height in the room" suffix="m" value={part.rh} disabled={ro} placeholder={it.h ? 'its own ' + f2(it.h) : 'needed'} onSave={(v) => onCommit(setFinishPartOps(model, it.id, { rh: v }), 'Height in the room')} title="Its length × this height comes into the room's wall finish (empty: the take-off's own height)" /></div>
          )}
        </div>
      ) : !ro && onLinkRoom && (it.kind === 'area' || it.kind === 'line' || it.kind === 'wall') && model.fin.rooms.length > 0 ? (
        <button className="linkbtn rm-linkto" onClick={() => onLinkRoom([it.id])}>Link to a room…</button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ Link to room…
export function LinkRoomDialog({ model, ids, room0, to0, onClose, onCommit }: {
  model: QtoModel;
  ids: string[];
  room0?: string;
  to0?: string;
  onClose: () => void;
  onCommit: (ops: Op[], label: string, room?: string) => void;
}) {
  useQtoFmt();
  const items = ids.map((x) => model.itemById.get(x)).filter((it): it is TItem => !!it && it.kind !== 'room' && it.rk !== 'add' && it.rk !== 'ceil');
  const [q, setQ] = useState('');
  const [room, setRoom] = useState<string>(room0 && model.fin.roomById.has(room0) ? room0 : '');
  const choices = room ? linkChoices(model, room, items, linkableTo) : [];
  const [to, setTo] = useState<string>(to0 ?? '');
  const pick = choices.find((c) => c.to === to) ?? null;
  const lens = items.filter((it) => it.kind === 'line' || it.kind === 'wall');
  const needH = !!pick && pick.cat === 'wall' && lens.length > 0;
  const [h, setH] = useState<string>(() => (lens[0]?.h ? String(lens[0].h) : ''));
  const [ded, setDed] = useState(true);
  const [err, setErr] = useState('');
  const f = q.trim().toLowerCase();
  const rooms = model.fin.rooms.filter((r) => !f || (r.name + ' ' + r.desc + ' ' + (model.headingById.get(r.par)?.name ?? '')).toLowerCase().includes(f));
  useEffect(() => { if (to && !choices.some((c) => c.to === to)) setTo(''); }, [room]);
  const link = () => {
    if (!room || !pick) return;
    const hv = parseNum(h) ?? null;
    const ops: Op[] = [];
    const bad: string[] = [];
    for (const it of items) {
      const r = linkToRoomOps(model, it.id, room, pick.to, { deduct: ded, h: needH ? hv : null });
      if ('error' in r) bad.push(`${it.name}: ${r.error}`);
      else ops.push(...r.ops);
    }
    if (!ops.length) { setErr(bad[0] ?? 'Nothing to link.'); return; }
    onCommit(ops, items.length > 1 ? `Linked ${items.length} take-offs to room` : 'Linked to room', room);
    onClose();
  };
  const title = items.length === 1 ? `Link “${items[0].name}” to a room` : `Link ${items.length} take-offs to a room`;
  return (
    <Modal title={title} onClose={onClose} sub="It keeps its own shapes, code and quantity, and shows under that finish in the room. An area goes to Floor, Wall or Ceiling; a length to Skirting, or to Wall with a height.">
      {!items.length ? <p className="hint">Only areas and lengths can be linked to a room.</p> : (
        <div className="rmlink" data-linkroom>
          <input className="input" autoFocus placeholder="Find a room (name, description, heading)" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="picklist" style={{ maxHeight: 210 }}>
            {rooms.map((r) => (
              <button key={r.id} className={'pick psp' + (r.id === room ? ' on' : '')} data-pickroom={r.name} onClick={() => setRoom(r.id)}>
                <span className="pa"><i className="sw" style={{ background: r.it.color }} /></span>
                <span className="pd">{roomLabel(r)}</span>
                <span className="pa">{model.headingById.get(r.par)?.name ?? ''}{r.times !== 1 ? ' · ×' + r.times : ''}</span>
              </button>
            ))}
            {!rooms.length && <div className="hint" style={{ padding: 10 }}>{model.fin.rooms.length ? 'No room matches.' : 'No rooms yet.'}</div>}
          </div>
          {room && (
            <>
              <div className="field l">
                <label>Under</label>
                <div className="rmlink-cats">
                  {choices.map((c) => <button key={c.to} type="button" className={'chip' + (c.to === to ? ' on' : '')} data-cat={c.to} onClick={() => setTo(c.to)}>{c.label}</button>)}
                  {!choices.length && <span className="hint">Nothing in this room fits {items.length > 1 ? 'all of them' : 'it'}.</span>}
                </div>
              </div>
              {needH && (
                <div className="field" style={{ maxWidth: 160 }}>
                  <label>Height</label>
                  <div className="sfx"><input className="input" data-linkh value={h} placeholder="m" onChange={(e) => setH(e.target.value)} /><span>m</span></div>
                </div>
              )}
              <label className="check tp"><input type="checkbox" data-linkded checked={ded} onChange={(e) => setDed(e.target.checked)} /> Deduct from main finish <span className="faint">(off: added on top)</span></label>
            </>
          )}
          {err && <div className="warnbox"><TIcon k="warn" /><div>{err}</div></div>}
        </div>
      )}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" data-linkroomok disabled={!room || !pick || (needH && !(parseNum(h) ?? 0) && !lens.every((it) => it.h))} onClick={link}>Link</button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ the take-off panel's room parts, together
/**
 * Everything the take-off panel needs for rooms: the open / closed rooms of the list and the finish lines under
 * them, the finish clicked (shown in the room's properties), the properties of a selected room / additional
 * finish, and the "Link to room…" dialog. One hook so the panel (Panels.tsx) only places what it returns.
 */
export function useRoomPanel(o: {
  model: QtoModel;
  projectId: string;
  me: string;
  readOnly: boolean;
  /** the rows selected (the one selection) and the take-offs among them (list order) */
  picked: Set<string>;
  selItems: TItem[];
  onPick: (ids: Set<string>) => void;
  activeId: string | null;
  onActivate: (id: string | null) => void;
  onCommit: (ops: Op[], label: string) => void;
  onDeleteNodes: (ids: string[]) => void;
  onDuplicate: (id: string) => void;
  /** own eye state (this PC) and the eye */
  hiddenOwn: Set<string>;
  onEye: (id: string) => void;
  storageKey: string;
  onToast?: (msg: string) => void;
  onGoTo?: (dwg: string, pg: number, box?: Box) => void;
}) {
  const { model, readOnly: ro } = o;
  const rm = useRoomMode(o.projectId);
  // rooms opened in the list (per PC): a new room opens; the ▸ on its row
  const [open, setOpen0] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(o.storageKey) || '[]')); } catch { return new Set(); } });
  const setOpen = (n: Set<string>) => { setOpen0(n); try { localStorage.setItem(o.storageKey, JSON.stringify([...n].filter((x) => model.itemById.has(x)))); } catch { /* */ } };
  const openRef = useRef(open);
  openRef.current = open;
  const ensureOpen = (id: string) => { if (!openRef.current.has(id)) setOpen(new Set([...openRef.current, id])); };
  // the finish clicked in the list: { room, line key } - kept while that room (or that finish) is the selection
  const [focus, setFocus] = useState<{ room: string; key: string } | null>(null);
  const lineClick = useRef(false);
  useEffect(() => { if (lineClick.current) { lineClick.current = false; return; } setFocus(null); }, [o.picked]);
  // a room made to be drawn (New › Room): its finishes show under it
  useEffect(() => { const a = o.activeId; if (a && model.fin.roomById.has(a) && !(model.shapesByItem.get(a) ?? []).length) ensureOpen(a); }, [o.activeId]);
  const [linkDlg, setLinkDlg] = useState<{ ids: string[]; room?: string; to?: string } | null>(null);
  const sel = roomSelection(model, o.picked, o.selItems);
  // an additional finish picked elsewhere (the drawing, the Summary): its room opens in the list
  useEffect(() => { if (sel && sel.focus && sel.focus !== 'ceiling') ensureOpen(sel.room); }, [sel?.room, sel?.focus]);
  const pickLine = (ids: Set<string>, f: { room: string; key: string } | null) => {
    // (the selection is set anew - a new set - so the effect above sees it: keep this focus)
    lineClick.current = true;
    o.onPick(ids);
    setFocus(f);
  };
  const addPart = (roomId: string, cat: FinCat) => {
    const r = addFinishOps(model, o.me, roomId, cat);
    if (!r) return;
    o.onCommit(r.ops, 'Additional ' + CAT_NAME[cat].toLowerCase());
    pickLine(new Set([r.id]), { room: roomId, key: r.id });
    ensureOpen(roomId);
    rm.start({ k: cat === 'wall' || cat === 'skirting' ? 'addLine' : 'addArea', room: roomId, part: r.id });
  };
  const one = o.picked.size === 1 ? [...o.picked][0] : null;
  const blkOf = (key: string) => (key === 'wph' || key === 'wpv' ? 'wp' : key);
  const lines = (roomId: string, pad: number) => (
    <RoomLines
      model={model}
      roomId={roomId}
      pad={pad}
      ro={ro}
      sel={(l) => (l.role === 'add' || l.role === 'link' ? one === l.key : (one === roomId || (!!l.part && one === l.part)) && focus?.room === roomId && focus.key === l.key)}
      onLine={(l) => {
        if (l.role === 'add') pickLine(new Set([l.key]), { room: roomId, key: l.key });
        else if (l.role === 'link') pickLine(new Set([l.key]), null);
        else if (l.part) pickLine(new Set([l.part]), { room: roomId, key: l.key });
        else pickLine(new Set([roomId]), { room: roomId, key: l.key });
      }}
      onPlus={(cat) => addPart(roomId, cat)}
      onUnlink={(ti) => o.onCommit(unlinkFromRoomOps(model, ti), 'Unlinked from room')}
      onRemove={(id) => {
        const x = model.fin.partById.get(id);
        o.onCommit(removeFinishOps(model, id), x?.ak === 'bh' ? 'Removed bulkhead' : x?.ak === 'up' ? 'Removed upturn' : 'Removed additional finish');
        if (one === id) o.onPick(new Set([roomId]));
      }}
      eyeOf={(ti) => o.hiddenOwn.has(ti)}
      onEye={o.onEye}
      onDropLink={(ids, to) => setLinkDlg({ ids, room: roomId, to })}
    />
  );
  let props: ReactNode = null;
  if (sel) {
    const room = model.fin.roomById.get(sel.room)!;
    const part = sel.focus ? model.fin.partById.get(sel.focus) : null;
    // (v0.16.4 a bulkhead / an upturn: the room's own panel, its row in focus - its settings are there)
    if (part && part.rk === 'add' && !part.ak) props = <PartProps key={part.id} model={model} part={part} ro={ro} rm={rm} onCommit={o.onCommit} onPick={o.onPick} onDelete={(id) => { o.onCommit(removeFinishOps(model, id), 'Removed additional finish'); o.onPick(new Set([room.id])); }} />;
    else {
      const f = sel.focus ?? (focus && focus.room === room.id ? focus.key : null);
      props = (
        <RoomProps
          key={room.id}
          model={model}
          room={room}
          focus={f ? blkOf(f) : null}
          ro={ro}
          me={o.me}
          rm={rm}
          onCommit={o.onCommit}
          onPick={o.onPick}
          onClose={() => o.onPick(new Set())}
          onDelete={(id) => o.onDeleteNodes([id])}
          onDuplicate={o.onDuplicate}
          onMeasure={(id) => o.onActivate(id)}
          onToast={o.onToast}
          onGoTo={o.onGoTo}
        />
      );
    }
  }
  const dialog = linkDlg ? <LinkRoomDialog model={model} ids={linkDlg.ids} room0={linkDlg.room} to0={linkDlg.to} onClose={() => setLinkDlg(null)} onCommit={(ops, label, room) => { o.onCommit(ops, label); const r = room ?? linkDlg.room; if (r) ensureOpen(r); }} /> : null; // (the room picked in the dialog - 0.23.2, DeepSeek #48)
  return {
    rm,
    /** for ItemTree's `rooms` */
    rooms: { open, toggle: (id: string) => { const n = new Set(open); n.has(id) ? n.delete(id) : n.add(id); setOpen(n); }, lines, onLinkRoom: ro ? undefined : (ids: string[], room?: string) => setLinkDlg({ ids, room }) },
    /** the properties of the room / additional finish selected (null: not a room) */
    props,
    dialog,
    onLinkRoom: (ids: string[]) => setLinkDlg({ ids }),
    /** Del in the list: a room's own finish picked on its line is removed (one step, Ctrl+Z brings it back);
     *  anything else goes on to the take-offs' delete (it asks first) */
    onDeleteNodes: (ids: string[]) => {
      const parts = ids.map((x) => model.fin.partById.get(x)).filter((x): x is RoomPart => !!x && x.rk === 'add');
      if (ids.length && parts.length === ids.length) {
        o.onCommit(parts.flatMap((x) => removeFinishOps(model, x.id)), parts.length > 1 ? 'Removed additional finishes' : 'Removed additional finish');
        o.onPick(new Set([parts[0].room]));
        return;
      }
      o.onDeleteNodes(ids.filter((x) => !model.fin.partById.has(x) || model.fin.partById.get(x)!.rk === 'link'));
    },
  };
}

/**
 * tests/e2e-v16-g2.mjs builds rooms with engine ops where the drawing would be needed (outlines, doors - the
 * drawing side is another group's): with `qto.e2e` = '1' in this PC's storage only, the take-off panel lends
 * its model and commit to the test. Nothing else reads it.
 */
export function useE2EHook(model: QtoModel, commit: (ops: Op[], label: string) => void, projectId: string) {
  const ref = useRef({ model, commit });
  ref.current = { model, commit };
  useEffect(() => {
    let on = false;
    try { on = localStorage.getItem('qto.e2e') === '1'; } catch { /* */ }
    if (!on) return;
    // (and the drawing steps the panel asks for: the drawing side answers them, the test sees they were asked)
    const modes: (RoomMode | null)[] = [];
    const off = onRoomMode(projectId, (m) => { modes.push(m); });
    (globalThis as unknown as { __qtoG2?: unknown }).__qtoG2 = { model: () => ref.current.model, commit: (ops: Op[], label = 'e2e') => ref.current.commit(ops, label), modes, done: (m: RoomMode) => roomModeDone(projectId, m) };
    return off;
  }, [projectId]);
}
