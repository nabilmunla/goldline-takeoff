// v0.16 (group g2): what the take-off panel and the Finishes Summary show of rooms - worked out here
// without React so it can be tested. The quantities themselves are the engine's (rooms.ts / finishes.ts):
// nothing here computes a figure, it only lays them out.
import { segLensAt, type QtoModel, type TItem } from '../../engine/qto/model';
import { roomTree, CAT_NAME, FIN_CATS, type FinCat, type FinishNode, type FinishType, type Room } from '../../engine/qto/rooms';
import { natCmp, type Breakdown, type FinAtom, type FinFilter, type FinRow, type FinSummary, type GroupKey } from '../../engine/qto/finishes';

/** the name a room gets before the QS names it ("Room 3") */
export const DEFAULT_ROOM_NAME = /^Room \d+$/;
const f2 = (x: number) => (Math.abs(x) < 0.005 ? 0 : x).toFixed(2);

/** "Master Bedroom — Type A apartment" */
export const roomLabel = (r: Pick<Room, 'name' | 'desc'>) => r.name + (r.desc ? ' — ' + r.desc : '');

/** one line of a room's finishes in the take-off list (UI-TREE "Room") */
export interface FinLine {
  /** the finish's key in the room ('floor' 'wall' 'skirting' 'ceiling' 'gap' 'wp' 'wph' 'wpv') or the take-off's id */
  key: string;
  depth: number;
  label: string;
  /** '' = no code (kept out of the Finishes Summary) */
  code: string;
  /** null = nothing measured (no height yet, no skirting) */
  qty: number | null;
  unit: string;
  /** "h 3.00", "Manual", "deduct ✓", "upturn 0.30" */
  detail: string;
  role: 'main' | 'add' | 'link' | 'wp';
  /** the + (additional finish) on Floor / Wall / Skirting / Ceiling */
  plus?: FinCat;
  /** the take-off with shapes of its own (additional finish, linked take-off, manual ceiling areas) */
  part?: string;
  note?: string;
  over?: boolean;
}

/** the lines under a room row: Floor, Wall, Skirting, Ceiling (always - their code and height are set in the
 *  properties), each with its additional finishes and linked take-offs, the shadow gap under the ceiling,
 *  and waterproofing (when on) with its horizontal and vertical parts */
export function roomLines(m: QtoModel, roomId: string): FinLine[] {
  const room = m.fin.roomById.get(roomId);
  const q = m.fin.qty.get(roomId);
  if (!room || !q) return [];
  const t = roomTree(q);
  const out: FinLine[] = [];
  const kids = (n: FinishNode | null, depth: number) => {
    if (!n) return;
    // (the shadow gap first: it is the ceiling's own)
    const list = [...n.children].sort((a, b) => (a.f.key === 'gap' ? -1 : b.f.key === 'gap' ? 1 : 0));
    for (const c of list) {
      const f = c.f;
      const p = m.fin.partById.get(f.key);
      const detail = f.key === 'gap' ? (room.gm === 'all' ? 'perimeter' : 'picked edges')
        // (v0.16.4)
        : p?.ak === 'bh' ? 'bulkhead'
        : p?.ak === 'up' ? 'higher upturn'
        : f.key.endsWith('>above') ? 'on the soffit above'
        : room.cs && p?.rk === 'add' && p.cat === 'ceiling' ? 'under the soffit'
        : p?.rk === 'add' && p.full ? 'full area' + (f.ded ? ' · deduct ✓' : ' · on top')
        : p?.wa ? 'an area' + (f.ded ? ' · deduct ✓' : ' · on top')
        : f.ded ? 'deduct ✓' : 'on top';
      out.push({ key: f.key, depth, label: f.name, code: f.code, qty: f.qty, unit: f.unit, detail, role: f.role === 'main' ? 'main' : f.role, part: p ? p.id : undefined, note: f.note, over: f.over });
      kids(c, depth + 1);
    }
  };
  const ceil = (m.fin.partsByRoom.get(roomId) ?? []).find((p) => p.rk === 'ceil');
  const main = (cat: FinCat, n: FinishNode | null, detail: string) => {
    const f = n?.f.none ? undefined : n?.f;
    // (v0.18.1 a soffit-first room: its ceiling line is the soffit)
    out.push({ key: cat, depth: 0, label: cat === 'ceiling' && room.cs ? 'Soffit' : CAT_NAME[cat], code: f?.code ?? (cat === 'wall' ? room.wc : cat === 'skirting' ? room.kc : ''), qty: f ? f.qty : null, unit: cat === 'skirting' ? 'm' : 'm²', detail, role: 'main', plus: cat, part: cat === 'ceiling' && room.cm === 'manual' ? ceil?.id : undefined, over: f?.over });
    kids(n, 1);
  };
  main('floor', t.floor, '');
  const single = (n: FinishNode | null, detail: string) => { if (n) out.push({ key: n.f.key, depth: 0, label: n.f.name, code: n.f.code, qty: n.f.qty, unit: n.f.unit, detail, role: 'main', note: n.f.note, over: n.f.over }); };
  // (v0.18 the panel's order: floor, skirting, walls (+ plaster), ceiling, the walls above it)
  main('skirting', t.skirting, room.hs ? 'h ' + f2(room.hs) : t.skirting && !t.skirting.f.none ? '' : 'none');
  main('wall', t.wall, room.hw !== null && room.hw > 0 ? 'h ' + f2(room.hw) : (room.rmh ?? 0) > 0 ? 'by the ceilings' : 'no height');
  single(t.plaster, room.ppf ? 'with the finish' : room.php !== null ? 'to ' + f2(room.php) : 'full height');
  main('ceiling', t.ceiling, room.cs ? '' : room.cm === 'manual' ? 'Manual' : '');
  single(t.band, 'to the soffit');
  if (t.wp) {
    const lvl = !room.pm ? 'not set up' : room.pm === 'up' ? (room.pu !== null ? 'upturn ' + f2(room.pu) : 'no upturn height') : 'to ' + f2(room.pl ?? room.hw ?? 0);
    out.push({ key: 'wp', depth: 0, label: 'Waterproofing', code: room.pc, qty: null, unit: '', detail: lvl, role: 'wp' });
    for (const n of [t.wp.h, t.wp.v]) { out.push({ key: n.f.key, depth: 1, label: n.f.key === 'wph' ? 'Horizontal' : 'Vertical', code: n.f.code, qty: n.f.qty, unit: n.f.unit, detail: '', role: 'main', over: n.f.over }); kids(n, 2); }
  }
  // (v0.18 the miscellaneous items)
  for (const n of t.misc) {
    out.push({ key: n.f.key, depth: 0, label: n.f.name, code: n.f.code, qty: n.f.qty, unit: n.f.unit, detail: 'item' + (n.f.fin ? ' · ' + n.f.fin : ''), role: 'add', part: n.f.key, note: n.f.note });
    // (v0.18.1 a length with a height: its m² under it)
    for (const c of n.children) out.push({ key: c.f.key, depth: 1, label: 'its area', code: c.f.code, qty: c.f.qty, unit: c.f.unit, detail: '', role: 'add', part: n.f.key });
  }
  return out;
}

/** what the Properties panel shows for the selection: a room (and the finish in it that was clicked), or null */
export function roomSelection(m: QtoModel, picked: Set<string>, selItems: TItem[]): { room: string; focus: string | null } | null {
  if (selItems.length === 1 && selItems[0].kind === 'room' && m.fin.roomById.has(selItems[0].id)) return { room: selItems[0].id, focus: null };
  if (selItems.length === 0 && picked.size === 1) {
    // a room's own finish (its shapes clicked on the drawing, or its line in the list)
    const id = [...picked][0];
    const p = m.fin.partById.get(id);
    if (p && (p.rk === 'add' || p.rk === 'ceil') && m.fin.roomById.has(p.room)) return { room: p.room, focus: p.rk === 'ceil' ? 'ceiling' : p.id };
  }
  return null;
}

/** a room with nothing set yet (codes, heights, modes): naming it may fill in the last room of that name's */
export function roomIsBlank(r: Room): boolean {
  return !r.fc && !r.wc && r.hw === null && !r.kc && r.hs === null && !r.cc && r.cm === 'auto' && !r.gc && !r.gm && !r.pc && !r.pm && r.pu === null && r.pl === null && !r.phc && !r.pvc;
}

const FLAG_TEXT: Record<string, string> = {
  over: 'Deductions are larger than a finish — it shows 0.',
  timesDiffer: 'A linked take-off has its own Times, not the room’s — it counts at face value.',
  doorOnOpen: 'A door or opening is on an open edge — not deducted.',
  noSize: 'A door or opening has no size — not deducted.',
  noOutline: 'No outline drawn yet.',
  notArea: 'A shape of the room is not an area — left out.',
  unscaled: 'Drawn on a sheet with no scale — not measured.',
  mixed: 'The outline crosses the edge of a viewport.',
  badHoles: 'A cut-out is not deducted (it lies outside the outline).',
  offOutline: 'An additional finish is not drawn along the outline.',
  notDrawn: 'An additional finish or the manual ceiling is not drawn yet.',
  noHeight: 'A wall finish or waterproofing has no height.',
  incompatible: 'A linked take-off cannot go in that finish.',
  outsideRoom: 'An area is drawn outside the room’s outline.',
  addOverlap: 'Two finishes drawn over each other: that area is counted in both — check which one is right.',
  ceilFloor: 'The ceilings drawn do not cover the floor — draw the rest, or say why (a note).',
  ceilLevel: 'A ceiling has no height: the walls under it are finished to the room height. Give the ceiling its height.',
  ceilElsewhere: 'A ceiling is drawn on another sheet than the room: which walls it is over is not known, so they are finished to the room height. Draw it over the plan (the overlay shows another sheet over this one).',
  replNoEdge: 'An elevation is set to replace the wall on the plan but no plan edge is picked for it yet.',
  aboveFinish: 'An additional wall finish goes higher than where the wall finish stops (false ceiling + the allowance) over some of its walls: check its height.',
  bhHeight: 'A bulkhead’s drop is not known — a height is missing, or it is not below its ceiling.',
  soffitCode: 'The soffit has m² no false ceiling covers but no code — give it one.',
  noRoomHeight: 'No Room height (floor to soffit): the walls are not measured up to their ceilings. Give the room its height.',
  twoFull: 'Two false ceilings are both “full room area” — the room is counted twice. Keep one full, draw the other.',
  fcAbove: 'A false ceiling is set higher than the room height (the slab) — it is not measured and the soffit stays. Lower it, or correct the room height.',
};
/** the room's warnings, short (flags + the finishes without a code) */
export function roomWarnings(m: QtoModel, roomId: string): string[] {
  const q = m.fin.qty.get(roomId);
  if (!q) return [];
  const out = q.flags.map((f) => FLAG_TEXT[f]).filter(Boolean);
  const nc = m.fin.uncoded.filter((a) => a.room === roomId).length;
  if (nc) out.push(`${nc} finish${nc > 1 ? 'es have' : ' has'} no code — not in the Finishes Summary.`);
  return out;
}

/** v0.16.5 the room's open edges, one by one (its outlines' order): each can be made a wall edge again */
export function openEdgesOf(m: QtoModel, roomId: string): { shape: string; seg: number; len: number | null; sheet: string }[] {
  const out: { shape: string; seg: number; len: number | null; sheet: string }[] = [];
  for (const s of m.shapesByItem.get(roomId) ?? []) {
    if (s.k !== 'poly' || !s.sg.some((t) => t && t.includes('~o'))) continue;
    const sl = segLensAt(m, s);
    const d = m.drawings.find((x) => x.id === s.dwg);
    s.sg.forEach((t, i) => { if (t && t.includes('~o')) out.push({ shape: s.id, seg: i, len: sl.lens[i] === null ? null : sl.lens[i]! * s.m, sheet: d ? d.name + (s.pg ? ' p' + (s.pg + 1) : '') : '' }); });
  }
  return out;
}
/** the room's edges marked "Open edge (no wall)" */
export function openEdgeCount(m: QtoModel, roomId: string): number {
  let n = 0;
  for (const s of m.shapesByItem.get(roomId) ?? []) for (const t of s.sg) if (t && t.includes('~o')) n++;
  return n;
}

/** the categories a take-off can be linked to in that room: the main four, then the room's additional
 *  finishes (an existing take-off can show under one of them) */
export function linkChoices(m: QtoModel, roomId: string, items: TItem[], ok: (it: TItem, cat: FinCat) => boolean): { to: string; label: string; cat: FinCat }[] {
  const out: { to: string; label: string; cat: FinCat }[] = [];
  for (const c of FIN_CATS) if (items.length && items.every((it) => ok(it, c))) out.push({ to: c, label: CAT_NAME[c], cat: c });
  for (const p of m.fin.partsByRoom.get(roomId) ?? []) if (p.rk === 'add' && !p.ak && items.length && items.every((it) => ok(it, p.cat))) out.push({ to: p.id, label: p.it.name + ' (additional ' + CAT_NAME[p.cat].toLowerCase() + ')', cat: p.cat });
  return out;
}

// ------------------------------------------------------------------ the Finishes Summary
/** the grouping levels this project can use: heading levels (as deep as its headings go), finish type, room name, description */
export function groupKeys(m: Pick<QtoModel, 'headings'>): { k: GroupKey; label: string }[] {
  const depth = m.headings.reduce((d, h) => Math.max(d, h.depth + 1), 0);
  const out: { k: GroupKey; label: string }[] = [];
  for (let i = 0; i < Math.min(depth, 6); i++) out.push({ k: 'h' + i, label: depth === 1 ? 'Heading' : 'Heading level ' + (i + 1) });
  if (depth > 1) out.push({ k: 'head', label: 'Own heading' });
  out.push({ k: 'type', label: 'Finish type' }, { k: 'room', label: 'Room name' }, { k: 'desc', label: 'Description' });
  return out;
}
export function groupKeyLabel(m: Pick<QtoModel, 'headings'>, k: GroupKey): string {
  return groupKeys(m).find((x) => x.k === k)?.label ?? (/^h(\d+)$/.test(k) ? 'Heading level ' + (Number(k.slice(1)) + 1) : k === 'head' ? 'Own heading' : k);
}
/** a level moved to another place in the order (drag and drop of the chips) */
export function moveKey(by: GroupKey[], from: number, to: number): GroupKey[] {
  if (from === to || from < 0 || from >= by.length) return by;
  const out = [...by];
  const [k] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, k);
  return out;
}

/** v0.16.4 the Finishes Summary showing no type (Show › None): a type no finish has */
export const NO_TYPE = 'None' as FinishType;
export const FILTER_TYPES: { t: FinishType; label: string }[] = [
  { t: 'Floor', label: 'Floor' }, { t: 'Wall', label: 'Wall' }, { t: 'Plaster', label: 'Plaster' }, { t: 'Above ceiling', label: 'Above false ceiling' }, { t: 'Skirting', label: 'Skirting' }, { t: 'Ceiling', label: 'Ceiling' },
  { t: 'Bulkhead', label: 'Bulkhead' }, { t: 'Shadow gap', label: 'Shadow gap' }, { t: 'Horizontal WP', label: 'Horizontal WP' }, { t: 'Vertical WP', label: 'Vertical WP' }, { t: 'Miscellaneous', label: 'Miscellaneous' }, { t: 'Other', label: 'Other take-offs' },
];

/** one line of the summary table: a row (code, group) or one room finish / take-off it is made of */
export type SumLine = { t: 'row'; row: FinRow; depth: number; open: boolean } | { t: 'atom'; a: FinAtom; depth: number; row: FinRow };

/** the table's lines: every group row (children shown unless closed), and a row's rooms / take-offs when opened
 *  (a row with groups under it shows them; one at the bottom level opens to its rooms / take-offs, by name) */
export function summaryLines(s: Pick<FinSummary, 'rows'>, closed: Set<string>, atomsOpen: Set<string>, atomById: Map<string, FinAtom>): SumLine[] {
  const out: SumLine[] = [];
  const walk = (r: FinRow, depth: number) => {
    const hasKids = r.children.length > 0;
    const open = hasKids ? !closed.has(r.id) : atomsOpen.has(r.id);
    out.push({ t: 'row', row: r, depth, open });
    if (!open) return;
    if (hasKids) for (const c of r.children) walk(c, depth + 1);
    else {
      const list = r.atoms.map((id) => atomById.get(id)).filter((a): a is FinAtom => !!a);
      const key = (a: FinAtom) => { const t = atomText(a); return [t.main, t.sub]; };
      list.sort((a, b) => { const x = key(a), y = key(b); return natCmp(x[0], y[0]) || natCmp(x[1], y[1]) || (a.id < b.id ? -1 : 1); });
      for (const a of list) out.push({ t: 'atom', a, depth: depth + 1, row: r });
    }
  };
  for (const r of s.rows) walk(r, 0);
  return out;
}

/** the saved breakdown that is this view (same levels, same filters), if any */
export function sameBreakdown(list: Breakdown[], by: GroupKey[], flt: FinFilter): Breakdown | null {
  const norm = (f: FinFilter) => JSON.stringify({ types: f.types?.length ? [...f.types].sort() : undefined, heads: f.heads?.length ? [...f.heads].sort() : undefined, q: f.q?.trim() || undefined });
  return list.find((b) => JSON.stringify(b.by) === JSON.stringify(by) && norm(b.flt) === norm(flt)) ?? null;
}

/** "Master Bedroom — Type A apartment · Wall finish" / "Paint to columns (take-off)" */
export function atomText(a: FinAtom): { main: string; sub: string } {
  if (a.role === 'takeoff') return { main: a.label, sub: 'take-off' };
  return { main: a.roomName + (a.desc ? ' — ' + a.desc : ''), sub: a.label + (a.role === 'add' ? ' (additional)' : a.role === 'link' ? ' (linked take-off)' : '') };
}

/** the BOQ line a link goes to, as text ("03.02.010 Emulsion paint…") */
export function boqLineText(m: Pick<QtoModel, 'boqById' | 'dummyById'>, to: string): string {
  const r = to.startsWith('b:') ? m.boqById.get(to.slice(2)) : m.dummyById.get(to);
  if (!r) return '(line removed)';
  return (r.ref ? r.ref + ' ' : '') + r.desc;
}

/** a row of the summary with the rows above it: "PT-08 › Ground floor › Wall" */
export function rowPathLabel(rows: FinRow[], row: FinRow): string {
  const find = (list: FinRow[], path: FinRow[]): FinRow[] | null => {
    for (const r of list) {
      if (r.id === row.id) return [...path, r];
      const x = find(r.children, [...path, r]);
      if (x) return x;
    }
    return null;
  };
  const chain = find(rows, []) ?? [row];
  return chain.map((r) => (r.depth === 0 ? r.code : r.label)).join(' › ');
}
