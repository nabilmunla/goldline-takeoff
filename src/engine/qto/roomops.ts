// Changes to rooms (v0.16 Finishes): each builder returns the ops of ONE commit (= one Ctrl+Z step). Every
// setting is its own field, so two people changing different fields of one room both keep theirs.
// (Separate from rooms.ts so the model can read rooms without loading ops.ts: no import cycle at load.)
import { generateKeyBetween } from 'fractional-indexing';
import { randomId } from '../ids';
import type { Op } from '../types';
import { nearestSeg, type QtoModel, type Shape, type TItem } from './model';
import { copyShapesOps, newItemOps, geomTagsOps, tagsOf, nextColor, openingOps, shapeOps } from './ops';
import { ROOM_SETTING_FIELDS, CODE_FIELDS, LEN_FIELDS, FIN_CATS, EDGE_OPEN, EDGE_GAP, edgeFlags, withEdgeFlag, type FinCat, type Room, type RoomSettings } from './rooms';

const lenVal = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** the last room (the one made last) with this name: what a new room of that name copies */
export function templateRoom(m: QtoModel, name: string, not?: string): Room | null {
  const k = name.trim().toLowerCase();
  let best: Room | null = null;
  for (const r of m.fin.rooms) if (r.id !== not && r.name.trim().toLowerCase() === k && (!best || r.born > best.born || (r.born === best.born && r.id > best.id))) best = r;
  return best;
}

/** the settings of the last room (the one made last) with this name - what a new room of that name offers */
export function roomDefaults(m: QtoModel, name: string, not?: string): Partial<RoomSettings> {
  const best = templateRoom(m, name, not);
  if (!best) return {};
  const out: Partial<RoomSettings> = {};
  for (const f of ROOM_SETTING_FIELDS) (out as Record<string, unknown>)[f] = best[f];
  return out;
}

function settingOps(m: QtoModel, id: string, patch: Partial<RoomSettings>): Op[] {
  const ops: Op[] = [];
  for (const [f, v] of Object.entries(patch)) {
    if (!(ROOM_SETTING_FIELDS as readonly string[]).includes(f)) continue;
    if (CODE_FIELDS.has(f)) ops.push([id, f, canonCode(m, String(v ?? '')) || null]);
    else if (LEN_FIELDS.has(f)) ops.push([id, f, lenVal(v)]);
    else if (f === 'cm') ops.push([id, f, v === 'manual' ? 'manual' : null]);
    else if (f === 'gm') ops.push([id, f, v === 'all' || v === 'pick' ? (v as string) : null]);
    else if (f === 'pm') ops.push([id, f, v === 'up' || v === 'full' ? (v as string) : null]);
    else if (f === 'cs' || f === 'ppf' || f === 'bn') ops.push([id, f, v === true ? true : null]);
  }
  return ops;
}

/** the canonical spelling of a code in this project (case ignored: the first spelling is kept), else as typed */
export function canonCode(m: QtoModel, typed: string): string {
  const t = typed.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  return m.fin?.codeByKey.get(t.toLowerCase())?.code ?? t;
}

/**
 * A new room at the end of heading `par`: kind 'room', with the settings of the last room of the same
 * name (unless given). Its outline is drawn into it as areas (shapeOps with ti = its id).
 */
export function newRoomOps(m: QtoModel, owner: string, o: { name: string; desc?: string; par?: string; times?: number; settings?: Partial<RoomSettings> }): { id: string; ops: Op[]; defaults: Partial<RoomSettings> } {
  const r = newItemOps(m, owner, 'room', undefined, o.par ?? '');
  const id = r.id;
  const name = o.name.trim() || 'Room ' + (m.fin.rooms.length + 1);
  const ops = r.ops.map((x) => (x[1] === 'name' ? [id, 'name', name] as Op : x));
  if (o.desc?.trim()) ops.push([id, 'desc', o.desc.trim()]);
  if (o.times && o.times > 0 && o.times !== 1) ops.push([id, 'x', o.times]);
  // v0.18.1 (Nabil, 11 Nov) soffit first: a new room's ceiling is the soffit; false ceilings go under it
  const ord = (r.ops.find((x) => x[1] === 'ord')?.[2] as string | null) ?? '';
  const tpl = o.name.trim() ? fromTemplate(m, owner, { id, par: o.par ?? '', ord }, name) : { settings: {}, ops: [] as Op[] };
  const defaults = tpl.settings;
  ops.push(...settingOps(m, id, { ...defaults, cs: true, ...(o.settings ?? {}) }).filter((x) => x[2] !== null), ...tpl.ops);
  return { id, ops, defaults };
}

/**
 * v0.18.1 (Nabil, 11 Nov: soffit first) what a room takes from the last room of its name: its settings, and its
 * full-room false ceilings (code, height, the finish on the soffit above) - "Bedroom" again is one click. That room
 * made before 0.18.1 (its main ceiling a false ceiling at the ceiling height): that ceiling comes as a full-room
 * false ceiling under the soffit (one drawn by hand: a false ceiling to draw), the soffit's code left for the QS.
 */
export function fromTemplate(m: QtoModel, owner: string, room: { id: string; par: string; ord: string }, name: string, not?: string): { settings: Partial<RoomSettings>; ops: Op[]; n: number } {
  const tpl = templateRoom(m, name, not);
  if (!tpl) return { settings: { cs: true }, ops: [], n: 0 };
  const settings: Partial<RoomSettings> = { ...roomDefaults(m, name, not), cs: true };
  const host = { id: room.id, par: room.par, it: { ord: room.ord } } as unknown as Room;
  const ops: Op[] = [];
  let n = 0;
  if (!tpl.cs) {
    settings.cc = ''; settings.ch = null; settings.cm = 'auto';
    if (tpl.cc || tpl.ch !== null) {
      ops.push(...partOps(m, owner, host, 'add', 'ceiling', 'False ceiling', { code: tpl.cc, lv: tpl.ch, full: tpl.cm !== 'manual' }).ops);
      n++;
    }
  } else {
    for (const p of m.fin.partsByRoom.get(tpl.id) ?? []) {
      if (p.rk !== 'add' || p.cat !== 'ceiling' || p.ak || !p.full) continue;
      ops.push(...partOps(m, owner, host, 'add', 'ceiling', p.it.name, { code: p.code, lv: p.lv, full: true, fa: p.fa, fac: p.fac }).ops);
      n++;
    }
  }
  return { settings, ops, n };
}

/**
 * v0.18.1 a room made before 0.18.1 (its main ceiling a false ceiling at its ceiling height): made soffit first - its
 * ceiling a false ceiling under the soffit (full room, or the areas drawn for it), the soffit's code left to give.
 * Figures stay the same, but for an additional ceiling that was "on top" of the main one: under a soffit it is a
 * false ceiling too (said by the caller).
 */
export function soffitFirstOps(m: QtoModel, owner: string, roomId: string): { ops: Op[]; onTop: string[] } {
  const room = m.fin.roomById.get(roomId);
  if (!room || room.cs) return { ops: [], onTop: [] };
  const ops: Op[] = [[roomId, 'cs', true], [roomId, 'cc', null], [roomId, 'ch', null], [roomId, 'cm', null], [roomId, 'cnn', null], [roomId, 'cnv', null]];
  const parts = m.fin.partsByRoom.get(roomId) ?? [];
  /** the false ceiling the room's own ceiling became: bulkheads that hung from that ceiling hang from it (fresh eyes) */
  let from: string | null = null;
  if (room.cm === 'manual') {
    for (const p of parts) {
      if (p.rk !== 'ceil') continue;
      from = from ?? p.id;
      ops.push([p.id, 'rk', 'add']);
      if (p.it.name === 'Ceiling areas') ops.push([p.id, 'name', 'False ceiling']);
      if (!p.code && room.cc) ops.push([p.id, 'fcode', room.cc]);
      if (p.lv === null && room.ch !== null) ops.push([p.id, 'lv', room.ch]);
    }
  } else if (room.cc || room.ch !== null) {
    const r = partOps(m, owner, room, 'add', 'ceiling', 'False ceiling', { code: room.cc, lv: room.ch, full: true });
    from = r.id;
    ops.push(...r.ops);
  }
  if (from) for (const p of parts) if (p.ak === 'bh' && !p.bp) ops.push([p.id, 'bp', from]);
  const onTop = parts.filter((p) => p.rk === 'add' && p.cat === 'ceiling' && !p.ak && !p.ded).map((p) => p.it.name);
  return { ops, onTop };
}

/** change a room's fields: name, desc, times and any setting (codes canonical, heights ≥ 0, modes) - one field each */
export function setRoomOps(m: QtoModel, roomId: string, patch: Partial<RoomSettings> & { name?: string; desc?: string; times?: number | null; color?: string }): Op[] {
  if (!m.fin.roomById.has(roomId)) return [];
  const ops: Op[] = [];
  if (patch.name !== undefined && patch.name.trim()) ops.push([roomId, 'name', patch.name.trim()]);
  if (patch.desc !== undefined) ops.push([roomId, 'desc', patch.desc.trim() || null]);
  if (patch.times !== undefined) ops.push([roomId, 'x', patch.times && patch.times > 0 && patch.times !== 1 ? patch.times : null]);
  if (patch.color) ops.push([roomId, 'color', patch.color]);
  ops.push(...settingOps(m, roomId, patch));
  return ops;
}

/** mark edges (segment indexes of a room outline or a ceiling area) open / not open, or shadow gap / not */
export function setEdgeOps(s: Shape, segs: number[], flag: 'open' | 'gap', on: boolean): Op[] {
  const sg = tagsOf(s);
  const f = flag === 'open' ? EDGE_OPEN : EDGE_GAP;
  let changed = false;
  for (const i of segs) {
    if (i < 0 || i >= sg.length) continue;
    const nt = withEdgeFlag(sg[i], f, on);
    if (nt !== sg[i]) { sg[i] = nt; changed = true; }
  }
  return changed ? geomTagsOps(s, sg) : [];
}

/** a door (from the schedule) or an opening placed in a room - refused on an open edge */
export function roomOpeningOps(m: QtoModel, shapeId: string, o: { k: 'door' | 'open'; x: number; y: number; door?: string | null; tag?: string; w?: number | null; h?: number | null; sill?: number | null }): { id: string; ops: Op[] } | { error: string } {
  const s = m.shapes.find((x) => x.id === shapeId);
  if (!s || m.itemById.get(s.ti)?.kind !== 'room' || s.k !== 'poly') return { error: 'Place it on a room’s outline.' };
  const seg = nearestSeg(s, [o.x, o.y]).seg;
  if (edgeFlags(s.sg[seg]).open) return { error: 'This edge is open (no wall): doors and openings go on wall edges only.' };
  return openingOps({ sh: shapeId, x: o.x, y: o.y, k: o.k, door: o.door ?? null, tag: o.tag ?? '', w: o.w ?? null, h: o.h ?? null, lint: true, sill: o.k === 'open' ? lenVal(o.sill) : null });
}
export const setOpeningSillOps = (id: string, sill: number | null): Op[] => [[id, 'sill', lenVal(sill)]];
export const removeRoomOpeningOps = (id: string): Op[] => [[id, 'del', true]];

const PART_KIND: Record<FinCat, 'line' | 'area'> = { floor: 'area', wall: 'line', skirting: 'line', ceiling: 'area' };
const ADD_NAME: Record<FinCat, string> = { floor: 'Additional floor finish', wall: 'Additional wall finish', skirting: 'Additional skirting', ceiling: 'Additional ceiling finish' };

/** an additional finish of a room (the + next to Floor / Wall / Skirting / Ceiling); draw its geometry into it */
export function addFinishOps(m: QtoModel, owner: string, roomId: string, cat: FinCat, o: { name?: string; code?: string; h?: number | null; bl?: number | null; deduct?: boolean; full?: boolean; wa?: boolean } = {}): { id: string; ops: Op[] } | null {
  const room = m.fin.roomById.get(roomId);
  if (!room) return null;
  // (v0.18.1 under a soffit an additional ceiling is a false ceiling)
  return partOps(m, owner, room, 'add', cat, o.name?.trim() || (o.wa && cat === 'wall' ? 'Wall cladding' : cat === 'ceiling' && room.cs ? 'False ceiling' : ADD_NAME[cat]), { ...o, wa: o.wa && cat === 'wall' });
}

type PartExtra = { ak?: '' | 'bh' | 'up' | 'misc'; lv?: number | null; fa?: boolean; fac?: string; bh?: number | null; bp?: string; wa?: boolean; wr?: boolean; mu?: 'nr' | 'm' | 'm2'; mq?: number | null; mf?: string };
function partOps(m: QtoModel, owner: string, room: Room, rk: 'add' | 'ceil', cat: FinCat, name: string, o: { code?: string; h?: number | null; bl?: number | null; deduct?: boolean; full?: boolean } & PartExtra): { id: string; ops: Op[] } {
  const id = 'ti:' + randomId(10);
  // (par = the room's heading: a 0.15 app shows it next to the room)
  // (v0.16.4 a bulkhead is a length under the ceiling, an upturn a length along the walls)
  // (v0.16.5 an additional wall drawn as an area: an elevation's cladding)
  // (v0.18 a miscellaneous item: a count, a length or an area - by its unit)
  const kind = o.ak === 'misc' ? MISC_KIND[o.mu ?? 'nr'] : o.ak === 'bh' || o.ak === 'up' ? 'line' : o.wa ? 'area' : PART_KIND[cat];
  const ops: Op[] = [[id, 'kind', kind], [id, 'name', name], [id, 'color', nextColor(m)], [id, 'owner', owner], [id, 'par', room.par || null], [id, 'ord', room.it.ord || null],
    [id, 'rm', room.id], [id, 'rk', rk], [id, 'rcat', o.ak === 'misc' ? 'misc' : cat]];
  // (no priv of its own: as private as its room)
  if (o.code?.trim()) ops.push([id, 'fcode', canonCode(m, o.code)]);
  if (o.h !== undefined && o.h !== null && o.h > 0) ops.push([id, 'h', o.h]);
  if (o.bl !== undefined && o.bl !== null && o.bl >= 0) ops.push([id, 'bl', o.bl]);
  if (o.deduct === false) ops.push([id, 'rded', false]);
  if (o.full && (cat === 'floor' || cat === 'ceiling') && !o.ak) ops.push([id, 'full', true]);
  if (o.ak) ops.push([id, 'ak', o.ak]);
  if (o.lv !== undefined && o.lv !== null && o.lv >= 0) ops.push([id, 'lv', o.lv]);
  if (o.fa) ops.push([id, 'fa', true]);
  if (o.fac?.trim()) ops.push([id, 'fac', canonCode(m, o.fac)]);
  if (o.bh !== undefined && o.bh !== null && o.bh >= 0) ops.push([id, 'bh', o.bh]);
  if (o.bp) ops.push([id, 'bp', o.bp]);
  if (o.wa) ops.push([id, 'wa', true]);
  if (o.wa && o.wr) ops.push([id, 'wr', true]);
  if (o.ak === 'misc') {
    if (o.mu && o.mu !== 'nr') ops.push([id, 'mu', o.mu]);
    if (o.mq !== undefined && o.mq !== null && o.mq >= 0) ops.push([id, 'mq', o.mq]);
    if (o.mf?.trim()) ops.push([id, 'mf', o.mf.trim()]);
  }
  return { id, ops };
}

/** v0.16.4 a bulkhead of a room (running metres; its drop = the height of the ceiling it hangs from - the main one
 *  unless bp says another of the room's ceilings - less its underside height bh). Draw it, or pick edges. */
export function addBulkheadOps(m: QtoModel, owner: string, roomId: string, o: { name?: string; bh?: number | null; bp?: string } = {}): { id: string; ops: Op[] } | null {
  const room = m.fin.roomById.get(roomId);
  if (!room) return null;
  const n = (m.fin.partsByRoom.get(roomId) ?? []).filter((p) => p.ak === 'bh').length;
  return partOps(m, owner, room, 'add', 'ceiling', o.name?.trim() || 'Bulkhead' + (n ? ' ' + (n + 1) : ''), { ak: 'bh', bh: o.bh ?? null, bp: o.bp ?? '' });
}
/** v0.16.4 a higher waterproofing upturn (showers, a cistern tank): a stretch along the walls with its own height */
export function addUpturnOps(m: QtoModel, owner: string, roomId: string, o: { name?: string; h?: number | null; code?: string } = {}): { id: string; ops: Op[] } | null {
  const room = m.fin.roomById.get(roomId);
  if (!room) return null;
  return partOps(m, owner, room, 'add', 'wall', o.name?.trim() || 'Higher upturn', { ak: 'up', h: o.h ?? null, code: o.code });
}
/** v0.16.4 a bulkhead's underside / the ceiling it hangs from; a ceiling's height; the soffit above a ceiling finished */
export function setPartExtraOps(m: QtoModel, partId: string, patch: { bh?: number | null; bp?: string; lv?: number | null; fa?: boolean; fac?: string }): Op[] {
  const it = m.itemById.get(partId);
  if (!it || !it.rk) return [];
  const ops: Op[] = [];
  if (patch.bh !== undefined) ops.push([partId, 'bh', lenVal(patch.bh)]);
  if (patch.bp !== undefined) ops.push([partId, 'bp', patch.bp || null]);
  if (patch.lv !== undefined) ops.push([partId, 'lv', lenVal(patch.lv)]);
  if (patch.fa !== undefined) ops.push([partId, 'fa', patch.fa ? true : null]);
  if (patch.fac !== undefined) ops.push([partId, 'fac', canonCode(m, patch.fac) || null]);
  return ops;
}
/** v0.16.5 an additional wall finish drawn along the walls (length × height) or as an area (an elevation's cladding,
 *  any shape): switched while nothing is drawn of it */
export function wallAreaOps(m: QtoModel, partId: string, on: boolean): Op[] | { error: string } {
  const p = m.fin.partById.get(partId);
  if (!p || p.rk !== 'add' || p.cat !== 'wall' || p.ak) return { error: 'Only an additional wall finish can be drawn as an area.' };
  if (p.wa === on) return [];
  if ((m.shapesByItem.get(partId) ?? []).length) return { error: 'Remove what is drawn of it first (it is drawn ' + (p.wa ? 'as an area' : 'along the walls') + ').' };
  return [[partId, 'kind', on ? 'area' : 'line'], [partId, 'wa', on ? true : null]];
}
/** v0.18 (Feedback 3, D) an elevation's area stands for a stretch of the plan: the wall finish is not taken along
 *  the lengths drawn of it on the plan (P × height and its openings) - the elevation's area is. Off: back to an
 *  area that simply comes off the wall finish. */
export function wallReplaceOps(m: QtoModel, partId: string, on: boolean): Op[] | { error: string } {
  const p = m.fin.partById.get(partId);
  if (!p || !p.wa) return { error: 'Only a wall finish drawn as an area (an elevation) can stand for plan edges.' };
  if (p.wr === on) return [];
  const ops: Op[] = [[partId, 'wr', on ? true : null]];
  // (it takes the wall's place there: deducted, always)
  if (on && !p.ded) ops.push([partId, 'rded', null]);
  // (off: the plan edges picked for it go - they are nothing without it)
  if (!on) for (const s of m.shapesByItem.get(partId) ?? []) if (s.k === 'line') ops.push([s.id, 'del', true]);
  return ops;
}

// ---------------------------------------------------------------- v0.18 miscellaneous items
export const MISC_KIND: Record<'nr' | 'm' | 'm2', 'count' | 'line' | 'area'> = { nr: 'count', m: 'line', m2: 'area' };
export const MISC_UNIT_LABEL: Record<'nr' | 'm' | 'm2', string> = { nr: 'Count', m: 'Length', m2: 'Area' };
/** a miscellaneous item of a room (kitchen cabinets, wardrobes, vanities, mirrors…): drawn into, or typed */
export function addMiscOps(m: QtoModel, owner: string, roomId: string, o: { name?: string; code?: string; mu?: 'nr' | 'm' | 'm2'; h?: number | null; mq?: number | null; mf?: string } = {}): { id: string; ops: Op[] } | null {
  const room = m.fin.roomById.get(roomId);
  if (!room) return null;
  return partOps(m, owner, room, 'add', 'floor', o.name?.trim() || 'Item', { ...o, ak: 'misc' });
}
/** a miscellaneous item counted in something else: while nothing is drawn of it (what is drawn is a count, a length or an area) */
export function miscUnitOps(m: QtoModel, partId: string, mu: 'nr' | 'm' | 'm2'): Op[] | { error: string } {
  const p = m.fin.partById.get(partId);
  if (!p || p.ak !== 'misc') return { error: 'That is not a miscellaneous item any more.' };
  if (p.mu === mu) return [];
  if ((m.shapesByItem.get(partId) ?? []).length) return { error: 'Remove what is drawn of it first (it is drawn as ' + (p.mu === 'nr' ? 'a count' : p.mu === 'm' ? 'a length' : 'an area') + ').' };
  const ops: Op[] = [[partId, 'kind', MISC_KIND[mu]], [partId, 'mu', mu === 'nr' ? null : mu]];
  if (mu !== 'm' && p.h !== null) ops.push([partId, 'h', null]);
  return ops;
}
/** a miscellaneous item's typed quantity (null = as drawn) and its finish (a note) */
export function setMiscOps(m: QtoModel, partId: string, patch: { mq?: number | null; mf?: string }): Op[] {
  const p = m.fin.partById.get(partId);
  if (!p || p.ak !== 'misc') return [];
  const ops: Op[] = [];
  if (patch.mq !== undefined && patch.mq !== p.mq) ops.push([partId, 'mq', patch.mq !== null && patch.mq >= 0 ? patch.mq : null]);
  if (patch.mf !== undefined && patch.mf.trim() !== p.mf) ops.push([partId, 'mf', patch.mf.trim() || null]);
  return ops;
}
/** a copy of a miscellaneous item in its room (nothing drawn: its figures typed stay) */
export function dupMiscOps(m: QtoModel, owner: string, partId: string): { id: string; ops: Op[] } | null {
  const p = m.fin.partById.get(partId);
  if (!p || p.ak !== 'misc') return null;
  return addMiscOps(m, owner, p.room, { name: p.it.name, code: p.code, mu: p.mu, h: p.h, mq: p.mq, mf: p.mf });
}

/** v0.16.4 the ceilings don't cover the floor and that is right: the note (written for the figures as they are now) */
export function ceilingNoteOps(m: QtoModel, roomId: string, note: string): Op[] {
  const q = m.fin.qty.get(roomId);
  if (!q) return [];
  const t = note.trim();
  const f2 = (x: number) => (Math.abs(x) < 0.005 ? 0 : x).toFixed(2);
  return t ? [[roomId, 'cnn', t], [roomId, 'cnv', `${f2(q.ceil.covered)}|${f2(q.ceil.A)}`]] : [[roomId, 'cnn', null], [roomId, 'cnv', null]];
}
/**
 * v0.16.4 an edge picked for a bulkhead / an upturn (an edge of the room's outline, or of a ceiling drawn in it): a
 * length of its own along that edge goes into the part - or, picked again, comes out.
 */
export function pickEdgeLineOps(m: QtoModel, partId: string, s: Shape, seg: number, by: string): { ops: Op[]; on: boolean } | { error: string } {
  const part = m.fin.partById.get(partId);
  // (v0.18 also the plan edges an elevation's area stands for)
  if (!part || (!part.ak && !(part.wa && part.wr)) || part.ak === 'misc') return { error: 'That is not a bulkhead or an upturn any more.' };
  const n = s.pts.length;
  if (s.k !== 'poly' || seg < 0 || seg >= n) return { error: 'Pick an edge of the room or of one of its ceilings.' };
  const a = s.pts[seg], b = s.pts[(seg + 1) % n], bulge = s.b[seg] ?? 0;
  const same = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.5;
  const have = (m.shapesByItem.get(partId) ?? []).find((x) => x.k === 'line' && x.dwg === s.dwg && x.pg === s.pg && x.pts.length === 2 && ((same(x.pts[0], a) && same(x.pts[1], b)) || (same(x.pts[0], b) && same(x.pts[1], a))));
  if (have) return { ops: [[have.id, 'del', true]], on: false };
  const r = shapeOps(partId, s.dwg, s.pg, 'line', [a, b], by, s.m, s.rv ?? '', [bulge], [null]);
  return { ops: r.ops, on: true };
}

/** change an additional finish (or a linked take-off's room settings): name, code, height, bottom level, deduct, full area */
export function setFinishPartOps(m: QtoModel, partId: string, patch: { name?: string; code?: string; h?: number | null; bl?: number | null; deduct?: boolean; full?: boolean; rh?: number | null }): Op[] {
  const it = m.itemById.get(partId);
  if (!it || !it.rk) return [];
  const ops: Op[] = [];
  if (patch.name !== undefined && patch.name.trim()) ops.push([partId, 'name', patch.name.trim()]);
  if (patch.code !== undefined) ops.push([partId, 'fcode', canonCode(m, patch.code) || null]);
  if (patch.h !== undefined) ops.push([partId, 'h', patch.h && patch.h > 0 ? patch.h : null]);
  if (patch.bl !== undefined) ops.push([partId, 'bl', lenVal(patch.bl)]);
  if (patch.deduct !== undefined) ops.push([partId, 'rded', patch.deduct ? null : false]);
  if (patch.full !== undefined) ops.push([partId, 'full', patch.full ? true : null]);
  if (patch.rh !== undefined) ops.push([partId, 'rh', patch.rh && patch.rh > 0 ? patch.rh : null]);
  return ops;
}

/** remove an additional finish / manual ceiling area with its shapes (a linked take-off: unlinked instead) */
export function removeFinishOps(m: QtoModel, partId: string): Op[] {
  const it = m.itemById.get(partId);
  if (!it || !it.rk) return [];
  if (it.rk === 'link') return unlinkFromRoomOps(m, partId);
  const ops: Op[] = [[partId, 'del', true]];
  for (const s of m.shapesByItem.get(partId) ?? []) ops.push([s.id, 'del', true]);
  return ops;
}

/** Auto (= floor area) or Manual (its own areas: the room's 'ceil' take-off is made if it has none - draw into `ceil`) */
export function setCeilingModeOps(m: QtoModel, owner: string, roomId: string, mode: 'auto' | 'manual'): { ops: Op[]; ceil: string | null } {
  const room = m.fin.roomById.get(roomId);
  if (!room) return { ops: [], ceil: null };
  const ops: Op[] = [[roomId, 'cm', mode === 'manual' ? 'manual' : null]];
  if (mode !== 'manual') return { ops, ceil: null };
  const have = (m.fin.partsByRoom.get(roomId) ?? []).find((p) => p.rk === 'ceil');
  if (have) return { ops, ceil: have.id };
  const p = partOps(m, owner, room, 'ceil', 'ceiling', 'Ceiling areas', {});
  return { ops: [...ops, ...p.ops], ceil: p.id };
}

/** shadow gap: off, entire perimeter (= P), or the edges picked (setEdgeOps 'gap' on outline / ceiling edges) */
export function setShadowGapOps(m: QtoModel, roomId: string, mode: 'off' | 'all' | 'pick', code?: string): Op[] {
  if (!m.fin.roomById.has(roomId)) return [];
  const ops: Op[] = [[roomId, 'gm', mode === 'off' ? null : mode]];
  if (code !== undefined) ops.push([roomId, 'gc', canonCode(m, code) || null]);
  return ops;
}

/** waterproofing: mode off / floor with upturn / full wall height, its code, upturn, level (null = wall finish height), own codes */
export function setWaterproofingOps(m: QtoModel, roomId: string, o: { mode?: 'off' | 'up' | 'full'; code?: string; upturn?: number | null; level?: number | null; hcode?: string; vcode?: string }): Op[] {
  if (!m.fin.roomById.has(roomId)) return [];
  const patch: Partial<RoomSettings> = {};
  if (o.mode !== undefined) patch.pm = o.mode === 'off' ? '' : o.mode;
  if (o.code !== undefined) patch.pc = o.code;
  if (o.upturn !== undefined) patch.pu = o.upturn;
  if (o.level !== undefined) patch.pl = o.level;
  if (o.hcode !== undefined) patch.phc = o.hcode;
  if (o.vcode !== undefined) patch.pvc = o.vcode;
  return settingOps(m, roomId, patch);
}

/** can this take-off be linked to that category? (area -> Floor / Wall / Ceiling; length -> Skirting, or Wall with a height) */
export function linkableTo(it: TItem, cat: FinCat): boolean {
  if (it.kind === 'area') return cat !== 'skirting';
  if (it.kind === 'line' || it.kind === 'wall') return cat === 'skirting' || cat === 'wall';
  return false;
}

/**
 * Link an existing take-off to a room's Floor / Wall / Skirting / Ceiling, or to one of its additional
 * finishes (to = its id). It keeps its shapes, code and quantity. A length linked to Wall needs a height
 * (h, else the take-off's own).
 */
export function linkToRoomOps(m: QtoModel, ti: string, roomId: string, to: FinCat | string, o: { deduct?: boolean; h?: number | null } = {}): { ops: Op[] } | { error: string } {
  const it = m.itemById.get(ti);
  const room = m.fin.roomById.get(roomId);
  if (!it || !room) return { error: 'Pick a take-off and a room.' };
  if (it.kind === 'room' || it.rk === 'add' || it.rk === 'ceil') return { error: 'A room and its own finishes cannot be linked to a room.' };
  let cat: FinCat;
  if ((FIN_CATS as string[]).includes(to)) cat = to as FinCat;
  else {
    const p = (m.fin.partsByRoom.get(roomId) ?? []).find((x) => x.id === to && x.rk === 'add');
    if (!p) return { error: 'That finish is not in this room.' };
    cat = p.cat;
  }
  if (!linkableTo(it, cat)) return { error: it.kind === 'area' ? 'An area can be linked to Floor, Wall or Ceiling.' : it.kind === 'line' || it.kind === 'wall' ? 'A length can be linked to Skirting, or to Wall with a height.' : 'Only areas and lengths can be linked to a room.' };
  const h = o.h && o.h > 0 ? o.h : null;
  const isLen = it.kind === 'line' || it.kind === 'wall';
  if (cat === 'wall' && isLen && !h && !it.h) return { error: 'A length linked to Wall needs a height.' };
  return { ops: [[ti, 'rm', roomId], [ti, 'rk', 'link'], [ti, 'rcat', to], [ti, 'rded', o.deduct === false ? false : null], [ti, 'rh', cat === 'wall' && isLen ? h : null]] };
}

/** unlink a take-off from its room: it stays as it was */
export function unlinkFromRoomOps(m: QtoModel, ti: string): Op[] {
  const it = m.itemById.get(ti);
  if (!it || it.rk !== 'link') return [];
  return [[ti, 'rm', null], [ti, 'rk', null], [ti, 'rcat', null], [ti, 'rded', null], [ti, 'rh', null]];
}

/** the finish code of take-offs (several at once: multi-select). Rooms have one per finish (setRoomOps): left alone */
export function setFinishCodeOps(m: QtoModel, ids: string[], code: string): Op[] {
  const c = canonCode(m, code) || null;
  const ops: Op[] = [];
  for (const id of ids) { const it = m.itemById.get(id); if (it && it.kind !== 'room') ops.push([id, 'fcode', c]); }
  return ops;
}

/**
 * The shapes that go with a room outline when it is moved or copied on the drawing: the additional
 * finishes drawn along it and the ceiling / additional areas inside it (same sheet). Pass them with the
 * outline to moveShapesOps (copies: copy the room with duplicateRoomOps instead).
 */
export function attachedShapes(m: QtoModel, outline: Shape): Shape[] {
  const it = m.itemById.get(outline.ti);
  if (!it || it.kind !== 'room') return [];
  const outlines = (m.shapesByItem.get(it.id) ?? []).filter((s) => s.k === 'poly' && s.dwg === outline.dwg && s.pg === outline.pg);
  const out: Shape[] = [];
  for (const pid of m.roomParts.get(it.id) ?? []) {
    for (const s of m.shapesByItem.get(pid) ?? []) {
      if (s.dwg !== outline.dwg || s.pg !== outline.pg) continue;
      // the outline it lies along / inside: the nearest (summed over its nodes), then by id
      let best: { o: Shape; d: number } | null = null;
      for (const o of outlines) {
        let d = 0;
        for (const p of s.pts) d += nearestSeg(o, p).d;
        if (!best || d < best.d - 1e-9) best = { o, d };
      }
      if (best?.o.id === outline.id) out.push(s);
    }
  }
  return out;
}

/** delete a room: its outline, doors / openings, additional finishes and ceiling areas (linked take-offs stay, unlinked) */
export function deleteRoomOps(m: QtoModel, roomId: string): Op[] {
  const ops: Op[] = [[roomId, 'del', true]];
  for (const s of m.shapesByItem.get(roomId) ?? []) {
    ops.push([s.id, 'del', true]);
    for (const o of m.openingsByShape.get(s.id) ?? []) ops.push([o.id, 'del', true]);
  }
  for (const pid of m.roomParts.get(roomId) ?? []) {
    ops.push([pid, 'del', true]);
    for (const s of m.shapesByItem.get(pid) ?? []) ops.push([s.id, 'del', true]);
  }
  return ops;
}

/** a copy of a room right after it: its settings, outline (edges, doors and openings) and its own finishes */
export function duplicateRoomOps(m: QtoModel, roomId: string, owner: string, opts: { shapes: boolean }): { id: string; ops: Op[] } | null {
  const room = m.fin.roomById.get(roomId);
  if (!room) return null;
  const r = newItemOps(m, owner, 'room', undefined, room.par);
  const id = r.id;
  const sib = m.tree.get(room.par) ?? [];
  const i = sib.findIndex((n) => n.id === room.id);
  let ord: string | null = null;
  try { ord = generateKeyBetween(room.it.ord || null, sib[i + 1]?.ord || null); } catch { ord = null; }
  const ops: Op[] = r.ops.map((o) => (o[1] === 'name' ? [id, 'name', room.name + ' (copy)'] as Op : o[1] === 'color' ? [id, 'color', room.it.color] as Op : o[1] === 'ord' && ord ? [id, 'ord', ord] as Op : o));
  if (room.desc) ops.push([id, 'desc', room.desc]);
  if (room.times !== 1) ops.push([id, 'x', room.times]);
  if (room.it.priv) ops.push([id, 'priv', true]);
  const set: Partial<RoomSettings> = {};
  for (const f of ROOM_SETTING_FIELDS) (set as Record<string, unknown>)[f] = room[f];
  ops.push(...settingOps(m, id, set).filter((x) => x[2] !== null));
  // (the outline with its edges' flags, doors and openings - sills too)
  if (opts.shapes) for (const s of m.shapesByItem.get(roomId) ?? []) ops.push(...copyShapesOps([s], { dwg: s.dwg, pg: s.pg, rv: s.rv }, s.by, 0, 0, id, m.openingsByShape).ops);
  const newIds = new Map<string, string>();
  const own = (m.fin.partsByRoom.get(roomId) ?? []).filter((p) => p.rk !== 'link');
  // (a bulkhead hangs from a ceiling of the copy: the ceilings first)
  own.sort((a, b) => (a.ak === 'bh' ? 1 : 0) - (b.ak === 'bh' ? 1 : 0));
  for (const p of own) {
    if (p.rk === 'link') continue;
    const np = partOps(m, owner, { ...room, id }, p.rk, p.cat, p.it.name, { code: p.code, h: p.h, bl: p.bl, deduct: p.ded, full: p.full, ak: p.ak, lv: p.lv, fa: p.fa, fac: p.fac, bh: p.bh, bp: p.bp ? newIds.get(p.bp) ?? p.bp : '', wa: p.wa, wr: p.wr, mu: p.mu, mq: p.mq, mf: p.mf });
    newIds.set(p.id, np.id);
    ops.push(...np.ops.map((o) => (o[1] === 'color' ? [o[0], 'color', p.it.color] as Op : o)));
    if (opts.shapes) for (const s of m.shapesByItem.get(p.id) ?? []) ops.push(...copyShapesOps([s], { dwg: s.dwg, pg: s.pg, rv: s.rv }, s.by, 0, 0, np.id).ops);
  }
  return { id, ops };
}
