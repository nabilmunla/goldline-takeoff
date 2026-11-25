// The Finishes Summary (v0.16, ROOM-SPEC.md sections 7-8): the project's finish codes, the "atoms" every
// figure is made of, grouping / filters with subtotals, portion links to the BOQ and saved breakdowns.
//
// Atom = one room × one finish (main, additional or a linked take-off), or one take-off with a finish
// code that is not in a room. It carries its code, unit, quantity, finish type, room name / description,
// heading path and the ids it comes from. Every total in the summary is a sum of atoms (in id order).
//
// Portion link (fl:) = "code + unit + the group values of a row (+ the filters it was made under)" ->
// a BOQ target (b: line, or dm: temporary / additional line, like lk:'s `to`). It is a predicate, not a
// number: its quantity is the atoms it covers now, so it follows the rooms as they change or are added.
//   - a new link covering an atom already linked (by another portion link, or a take-off's own lk:) is
//     refused with the list of links it overlaps (portionLinkOps);
//   - an atom that later falls under two links counts in the OLDER one (the stamp of its creation - the
//     same on every PC - then by id) and is flagged on both;
//   - a take-off with a code and its own lk: links counts as already linked (never in a portion link).
// The quantities reach the estimate through m.targets / m.boqQty (like lk: links: the Take-off column,
// the BOQ tab, the Excel export) at full precision; bridge.roundQty only for the write.
import { randomId } from '../ids';
import type { Store } from '../store';
import type { Cell, Op, Value } from '../types';
import { MEASURE_UNIT, mainMeasure, measureOf, parseJson, type Measure, type QtoModel, type TItem, type Link } from './model';
import { unitFactor } from './units';
import { readRoom, readPart, roomQty, CAT_TYPE, FINISH_TYPES, WP_SPLIT, type Room, type RoomPart, type RoomQty, type FinishType } from './rooms';

/** group keys: 'h0' 'h1' ... = the heading at that level (0 = top), 'head' = the take-off's own heading,
 *  'type' = finish type, 'room' = room name, 'desc' = description */
export type GroupKey = string;
export const GROUP_KEYS: { k: GroupKey; label: string }[] = [
  { k: 'h0', label: 'Heading (level 1)' }, { k: 'h1', label: 'Heading (level 2)' }, { k: 'h2', label: 'Heading (level 3)' }, { k: 'head', label: 'Heading' },
  { k: 'type', label: 'Finish type' }, { k: 'room', label: 'Room name' }, { k: 'desc', label: 'Description' },
];
export interface FinFilter {
  /** finish types to keep */
  types?: FinishType[];
  /** headings to keep (anything under them); '' = top level */
  heads?: string[];
  /** text in the room name / description (or a take-off's name) */
  q?: string;
}

export interface FinAtom {
  id: string;
  /** canonical spelling of the code ('' = none: not in the summary, see `uncoded`), and its key (case ignored) */
  code: string;
  key: string;
  unit: string;
  qty: number;
  type: FinishType;
  role: 'main' | 'add' | 'link' | 'takeoff';
  /** "Wall finish", "Wallpaper", the take-off's name */
  label: string;
  /** room id ('' = a take-off not in a room), its name and description */
  room: string;
  roomName: string;
  desc: string;
  /** heading ('' = top level) and every heading from the top down to it */
  head: string;
  heads: string[];
  /** ids it comes from: the room, the additional finish / linked take-off, or the take-off */
  src: string[];
  /** 'over' (deductions larger than the finish, shown 0), 'twoLinks', 'direct' (its take-off is linked itself) */
  flags: string[];
  /** v0.18 a miscellaneous item's finish (a note) */
  fin?: string;
  /** v0.16.4 a waterproofing code split into horizontal / vertical: the bare code's key (a link made on it before) */
  base?: string;
  /** lk: links of its take-off (it then counts as linked already) */
  direct: string[];
  /** why it is not in the summary ("Wallpaper (additional wall finish) has no code") - atoms in `uncoded` only */
  reason?: string;
  /** the portion link it counts in ('' = none) and every portion link whose predicate covers it */
  link: string;
  links: string[];
}

export interface CodeEntry {
  /** the spelling kept (the first written: earliest stamp, then the smaller text) */
  code: string;
  key: string;
  /** how many places use it, and the units it is used in */
  n: number;
  units: string[];
}

export interface PortionLink {
  id: string;
  code: string;
  key: string;
  unit: string;
  /** the group values of the row it was made from, in order */
  g: [GroupKey, string][];
  flt: FinFilter;
  to: string;
  /** stamp of its creation: the older link wins an atom two links cover */
  born: string;
  /** "PT-08 › Ground floor › Wall" */
  label: string;
  /** atoms counted in it, its quantity (the code's unit) and in the BOQ line's unit */
  atoms: string[];
  qty: number;
  v: number;
  /** atoms it covers that count in another (older) link, or are linked by their take-off itself */
  shared: string[];
  shadowed: string[];
  /** v0.16.4 made on a waterproofing code before horizontal / vertical were split: it covers both */
  split?: boolean;
  /** v0.16.4 made by 0.16.4 or later (nb): it covers its own code only - never the split waterproofing codes */
  nb?: boolean;
}

export interface Breakdown { id: string; name: string; by: GroupKey[]; flt: FinFilter; ord: string }

export interface FinModel {
  rooms: Room[];
  roomById: Map<string, Room>;
  /** additional finishes, manual ceiling areas and linked take-offs of each room (id order) */
  partsByRoom: Map<string, RoomPart[]>;
  partById: Map<string, RoomPart>;
  qty: Map<string, RoomQty>;
  /** coded atoms (in id order) - the summary - and the room finishes without a code (not in it; each with
   *  a reason; their deductions from the main finish still apply), and how many: "N finishes have no code" */
  atoms: FinAtom[];
  atomById: Map<string, FinAtom>;
  uncoded: FinAtom[];
  noCode: number;
  codes: CodeEntry[];
  codeByKey: Map<string, CodeEntry>;
  links: PortionLink[];
  linkById: Map<string, PortionLink>;
  breakdowns: Breakdown[];
  /** a code used in two units (usually a typing mistake) */
  warnings: { code: string; units: string[] }[];
}

export const codeKey = (c: string) => c.trim().replace(/\s+/g, ' ').toLowerCase();
const CAT_LOWER: Partial<Record<FinishType, string>> = { Floor: 'floor finish', Wall: 'wall finish', Skirting: 'skirting', Ceiling: 'ceiling finish' };
const UNIT_MEASURE: Record<string, Measure> = { 'm²': 'area', m: 'len', 'm³': 'vol', nr: 'cnt', kg: 'kg' };
const ROOM_CODE_FIELDS = ['fc', 'wc', 'kc', 'cc', 'gc', 'pc', 'phc', 'pvc', 'plc', 'bc'] as const;

/** natural order without the locale (the same on every PC): "PT-2" before "PT-10" */
export function natCmp(a: string, b: string): number {
  const ra = a.toLowerCase().match(/\d+|\D+/g) ?? [], rb = b.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
    const x = ra[i], y = rb[i];
    if (x === y) continue;
    const nx = /^\d/.test(x), ny = /^\d/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; if (x.length !== y.length) return x.length - y.length; continue; }
    return x < y ? -1 : 1;
  }
  return ra.length - rb.length || (a < b ? -1 : a > b ? 1 : 0);
}

const headsOf = (m: Pick<QtoModel, 'headingById'>, h: string): string[] => {
  const out: string[] = [];
  let x = h ? m.headingById.get(h) : undefined;
  let guard = 0;
  while (x && guard++ < 50) { out.unshift(x.id); x = x.par ? m.headingById.get(x.par) : undefined; }
  return out;
};

export function groupVal(a: FinAtom, k: GroupKey): string {
  if (k === 'type') return a.type;
  if (k === 'room') return a.roomName.trim().replace(/\s+/g, ' ').toLowerCase();
  if (k === 'desc') return a.desc.trim().replace(/\s+/g, ' ').toLowerCase();
  if (k === 'head') return a.head;
  // (v0.18.1 a miscellaneous item's description and finish)
  if (k === 'item') return a.label.trim().replace(/\s+/g, ' ').toLowerCase();
  if (k === 'mfin') return (a.fin ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const n = /^h(\d+)$/.exec(k);
  return n ? a.heads[Number(n[1])] ?? '' : '';
}

export function filterOk(a: FinAtom, f: FinFilter | undefined): boolean {
  if (!f) return true;
  if (f.types?.length && !f.types.includes(a.type)) return false;
  if (f.heads?.length && !(a.heads.some((h) => f.heads!.includes(h)) || (!a.head && f.heads.includes('')))) return false;
  const q = f.q?.trim().toLowerCase();
  if (q && !(a.roomName + '\n' + a.desc + '\n' + (a.role === 'takeoff' ? a.label : '')).toLowerCase().includes(q)) return false;
  return true;
}

const cleanFilter = (f: FinFilter | undefined): FinFilter => {
  const out: FinFilter = {};
  if (f?.types?.length) out.types = [...new Set(f.types)].sort((a, b) => FINISH_TYPES.indexOf(a) - FINISH_TYPES.indexOf(b));
  if (f?.heads?.length) out.heads = [...new Set(f.heads)].sort();
  if (f?.q?.trim()) out.q = f.q.trim();
  return out;
};
const emptyFilter = (f: FinFilter) => !f.types && !f.heads && !f.q;

export function covers(l: Pick<PortionLink, 'key' | 'unit' | 'g' | 'flt'> & { nb?: boolean }, a: FinAtom): boolean {
  return (a.key === l.key || (!l.nb && !!a.base && a.base === l.key)) && a.unit === l.unit && l.g.every(([k, v]) => groupVal(a, k) === v) && filterOk(a, l.flt);
}

// ------------------------------------------------------------------ building (called by buildQtoModel)
export function buildFinishes(m: QtoModel, store: Store, raw: [string, Map<string, Cell>][]): FinModel {
  const fin: FinModel = {
    rooms: [], roomById: new Map(), partsByRoom: new Map(), partById: new Map(), qty: new Map(), atoms: [], atomById: new Map(), uncoded: [], noCode: 0,
    codes: [], codeByKey: new Map(), links: [], linkById: new Map(), breakdowns: [], warnings: [],
  };
  for (const it of m.items) {
    if (it.kind !== 'room') continue;
    const r = readRoom(store, it);
    fin.rooms.push(r);
    fin.roomById.set(r.id, r);
  }
  // parts: additional finishes / ceiling areas, and take-offs linked to a room (a private one only in a
  // private room of its owner: others can't see it - their room would come to another figure)
  for (const it of m.items) {
    if (!it.rm || !it.rk) continue;
    const room = fin.roomById.get(it.rm);
    if (!room) continue;
    if (it.rk === 'link' && it.priv && !(room.it.priv && room.it.owner === it.owner)) continue;
    const p = readPart(store, it);
    if (!p) continue;
    fin.partById.set(p.id, p);
  }
  for (const p of fin.partById.values()) {
    if (p.rk === 'link' && p.under.startsWith('ti:')) {
      // shows under an additional finish: of this room (else it falls back to nothing - not counted)
      const a = fin.partById.get(p.under);
      if (!a || a.rk !== 'add' || a.room !== p.room) { fin.partById.delete(p.id); continue; }
      p.cat = a.cat;
    }
  }
  for (const p of [...fin.partById.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) (fin.partsByRoom.get(p.room) ?? fin.partsByRoom.set(p.room, []).get(p.room)!).push(p);
  for (const r of fin.rooms) fin.qty.set(r.id, roomQty({ m, room: r, parts: fin.partsByRoom.get(r.id) ?? [] }));

  // ---- the code list (every code anywhere; private take-offs left out - every PC keeps the same spelling)
  const spell = new Map<string, { code: string; s: string; n: number }>();
  const see = (code: string, cell: Cell | undefined) => {
    const c = code.trim().replace(/\s+/g, ' ');
    if (!c) return;
    const k = c.toLowerCase(), s = cell?.s ?? '';
    const was = spell.get(k);
    if (!was) { spell.set(k, { code: c, s, n: 1 }); return; }
    was.n++;
    if (s < was.s || (s === was.s && c < was.code)) { was.code = c; was.s = s; }
  };
  for (const r of fin.rooms) if (!r.it.priv) for (const f of ROOM_CODE_FIELDS) see(r[f], store.cell(r.id, f));
  for (const it of m.items) if (!it.priv && it.fcode) see(it.fcode, store.cell(it.id, 'fcode'));
  // (the finish above a false ceiling - its soffit code - too: it was never offered and kept each room's spelling,
  // 0.23.2, DeepSeek #37)
  for (const p of fin.partById.values()) if (!p.it.priv && p.fa && p.fac) see(p.fac, store.cell(p.id, 'fac'));
  const linkRaw = raw.filter(([id]) => id.startsWith('fl:'));
  for (const [id, ent] of linkRaw) { const c = ent.get('code'); if (c && typeof c.v === 'string') see(c.v, c); void id; }
  // (a split code - "AF-01 (SFT)", "WP-01 (vertical)" - not spelled as a whole anywhere takes its base code's spelling)
  const canon = (c: string) => {
    const w = spell.get(codeKey(c));
    if (w) return w.code;
    const sp = WP_SPLIT.exec(c.trim());
    const b = sp ? spell.get(codeKey(sp[1])) : undefined;
    return b ? `${b.code} (${sp![2]})` : c.trim();
  };

  // ---- atoms
  const atoms: FinAtom[] = [];
  const add = (a: Omit<FinAtom, 'key' | 'flags' | 'direct' | 'link' | 'links'> & { flags?: string[] }): FinAtom => {
    const code = a.code ? canon(a.code) : '';
    const at: FinAtom = { ...a, code, key: codeKey(code), flags: a.flags ?? [], direct: [], link: '', links: [] };
    // (v0.16.4 waterproofing "WP-01 (vertical)", a soffit "PT-05 (SFT)" - a link made on "WP-01" / "PT-05" before
    // the split still covers it)
    const wm = (a.type === 'Horizontal WP' || a.type === 'Vertical WP' || a.type === 'Ceiling') && code ? WP_SPLIT.exec(code) : null;
    if (wm) at.base = codeKey(wm[1]);
    if (!code) {
      const what = a.role === 'add' ? ` (additional ${CAT_LOWER[a.type] ?? 'finish'})` : a.role === 'link' ? ' (linked take-off)' : '';
      at.reason = `${a.label}${what} has no code`;
      fin.uncoded.push(at);
    } else atoms.push(at);
    return at;
  };
  const directOf = (ti: string) => (m.linksByItem.get(ti) ?? []).filter((l) => !l.dup).map((l) => l.id);
  for (const r of fin.rooms) {
    if (r.it.priv) continue;
    const q = fin.qty.get(r.id)!;
    const heads = headsOf(m, r.par);
    for (const f of q.finishes) {
      const role = f.role;
      const x = add({ id: r.id + '/' + f.key, code: f.code, unit: f.unit, qty: f.qty, type: f.type, role, label: f.name, room: r.id, roomName: r.name, desc: r.desc, head: r.par, heads, src: f.src, flags: f.over ? ['over'] : [], fin: f.fin });
      // a linked take-off that is linked to the BOQ itself: counts as linked already
      const d = role === 'link' ? directOf(f.key) : [];
      if (d.length) { x.direct = d; x.flags.push('direct'); }
    }
  }
  // (a take-off linked to a private room is still a coded take-off of its own for everyone else)
  const inRoom = new Set([...fin.partById.values()].filter((p) => !fin.roomById.get(p.room)!.it.priv).map((p) => p.id));
  for (const it of m.items) {
    if (it.kind === 'room' || it.priv || !it.fcode || inRoom.has(it.id) || it.rk === 'add' || it.rk === 'ceil') continue;
    const q = m.qty.get(it.id);
    if (!q) continue;
    const ms = mainMeasure(it);
    const x = add({ id: it.id, code: it.fcode, unit: MEASURE_UNIT[ms], qty: measureOf(q, ms), type: 'Other', role: 'takeoff', label: it.name, room: '', roomName: '', desc: '', head: it.par, heads: headsOf(m, it.par), src: [it.id] });
    const d = directOf(it.id);
    if (d.length) { x.direct = d; x.flags.push('direct'); }
  }
  atoms.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  fin.uncoded.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  fin.noCode = fin.uncoded.length;
  fin.atoms = atoms;
  for (const a of atoms) fin.atomById.set(a.id, a);

  // ---- codes and their units
  const units = new Map<string, Set<string>>();
  // (v0.18.1 a miscellaneous length with a height is in m and m² on purpose: its area line is not a second unit)
  for (const a of atoms) if (!a.id.endsWith('>area')) (units.get(a.key) ?? units.set(a.key, new Set()).get(a.key)!).add(a.unit);
  for (const [k, e] of spell) {
    const ce: CodeEntry = { code: e.code, key: k, n: e.n, units: [...(units.get(k) ?? [])].sort() };
    fin.codes.push(ce);
    fin.codeByKey.set(k, ce);
  }
  fin.codes.sort((a, b) => natCmp(a.code, b.code));
  for (const c of fin.codes) if (c.units.length > 1) fin.warnings.push({ code: c.code, units: c.units });

  // ---- portion links: what each covers; an atom under two counts in the older
  for (const [id, ent] of linkRaw) {
    const g = (f: string) => ent.get(f)?.v;
    const code = typeof g('code') === 'string' ? (g('code') as string) : '';
    const unit = typeof g('unit') === 'string' ? (g('unit') as string) : '';
    const to = typeof g('to') === 'string' ? (g('to') as string) : '';
    if (!code || !unit || !to) continue;
    const gv = parseJson<unknown[]>(g('g') as Value, []).filter((x): x is [string, string] => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string');
    const born = ['code', 'unit', 'g'].map((f) => ent.get(f)?.s ?? '').filter(Boolean).sort()[0] ?? '';
    const l: PortionLink = { id, code: canon(code), key: codeKey(code), unit, g: gv, flt: cleanFilter(parseJson<FinFilter>(g('flt') as Value, {})), to, born, label: '', atoms: [], qty: 0, v: 0, shared: [], shadowed: [], nb: g('nb') === true };
    l.label = linkLabel(m, l, atoms);
    fin.links.push(l);
  }
  fin.links.sort((a, b) => (a.born < b.born ? -1 : a.born > b.born ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const l of fin.links) fin.linkById.set(l.id, l);
  for (const a of atoms) {
    const hit = fin.links.filter((l) => covers(l, a));
    if (!hit.length) continue;
    a.links = hit.map((l) => l.id);
    if (a.direct.length) { for (const l of hit) l.shadowed.push(a.id); continue; }
    for (const l of hit) if (a.base && a.key !== l.key) l.split = true;
    const win = hit[0];
    a.link = win.id;
    win.atoms.push(a.id);
    win.qty += a.qty;
    if (hit.length > 1) { a.flags.push('twoLinks'); for (const l of hit) l.shared.push(a.id); }
  }
  // ---- into the BOQ targets, like lk: links
  for (const l of fin.links) {
    const ms = UNIT_MEASURE[l.unit] ?? 'area';
    const unit = l.to.startsWith('b:') ? m.boqById.get(l.to.slice(2))?.unit ?? '' : m.dummyById.get(l.to)?.unit ?? '';
    l.v = l.qty * unitFactor(unit, ms);
    const link: Link = { id: l.id, ti: l.id, to: l.to, q: ms, f: 1 };
    const item = linkItem(l, ms);
    const t = m.targets.get(l.to) ?? m.targets.set(l.to, { total: 0, parts: [] }).get(l.to)!;
    t.total += l.v;
    t.parts.push({ link, item, v: l.v, fl: l.id });
    const real = l.to.startsWith('b:') ? l.to.slice(2) : m.dummyById.get(l.to)?.map ?? null;
    if (real) {
      const b = m.boqQty.get(real) ?? m.boqQty.set(real, { total: 0, parts: [] }).get(real)!;
      b.total += l.v;
      b.parts.push({ link, item, v: l.v, fl: l.id });
    }
  }
  // ---- saved breakdowns
  for (const [id, ent] of raw) {
    if (!id.startsWith('fb:')) continue;
    const g = (f: string) => ent.get(f)?.v;
    const name = typeof g('name') === 'string' ? (g('name') as string).trim() : '';
    if (!name) continue;
    fin.breakdowns.push({ id, name, by: parseJson<unknown[]>(g('by') as Value, []).filter((x): x is string => typeof x === 'string'), flt: cleanFilter(parseJson<FinFilter>(g('flt') as Value, {})), ord: typeof g('ord') === 'string' ? (g('ord') as string) : '' });
  }
  fin.breakdowns.sort((a, b) => natCmp(a.name, b.name) || (a.id < b.id ? -1 : 1));
  return fin;
}

/** a portion link as a take-off, where the BOQ tab / export list what a line's quantity comes from */
function linkItem(l: PortionLink, ms: Measure): TItem {
  return {
    id: l.id, name: 'Finishes: ' + l.label, kind: ms === 'len' ? 'line' : ms === 'cnt' ? 'count' : 'area', color: '#b08d2c', grp: '', owner: '', priv: false, h: null, d: null, x: 1, waste: 0,
    dmin: null, ded: [], ow: null, oh: null, note: '', ord: '', par: '', lb: null, ld: null, lw: null, bt: '', st: null, sw: null, fill: '', lab: '', fcode: l.code, rm: '', rk: '',
  };
}

/** the shown value of a group key ("Ground floor", "Wall", "Bedroom", "(no heading)") */
export function groupLabel(m: Pick<QtoModel, 'headingById'> & { fin?: FinModel }, k: GroupKey, v: string, atoms?: FinAtom[]): string {
  if (k === 'type') return v;
  if (k === 'head' || /^h\d+$/.test(k)) return v ? m.headingById.get(v)?.name ?? '(heading removed)' : '(no heading)';
  if (!v) return k === 'room' ? '(not in a room)' : k === 'mfin' ? '(no finish)' : '(no description)';
  // the spelling of the first atom (id order) with that value
  const a = (atoms ?? m.fin?.atoms ?? []).find((x) => groupVal(x, k) === v);
  return a ? (k === 'room' ? a.roomName.trim() : k === 'item' ? a.label.trim() : k === 'mfin' ? (a.fin ?? '').trim() : a.desc.trim()) : v;
}

function linkLabel(m: Pick<QtoModel, 'headingById'>, l: Pick<PortionLink, 'code' | 'unit' | 'g' | 'flt'>, atoms: FinAtom[]): string {
  const parts = [l.code];
  for (const [k, v] of l.g) parts.push(groupLabel(m, k, v, atoms));
  const f = l.flt;
  const extra: string[] = [];
  if (f.types?.length) extra.push(f.types.join(', '));
  if (f.heads?.length) extra.push(f.heads.map((h) => (h ? m.headingById.get(h)?.name ?? '?' : 'top level')).join(', '));
  if (f.q) extra.push('“' + f.q + '”');
  return parts.join(' › ') + (extra.length ? ' (' + extra.join('; ') + ')' : '');
}

// ------------------------------------------------------------------ the code list
export const codeList = (m: QtoModel): CodeEntry[] => m.fin.codes;
/** v0.16.4 what a code box is for: the codes used for that kind of finish come first in its list */
export type CodeKind = 'floor' | 'wall' | 'skirting' | 'ceiling' | 'gap' | 'wp';
/** v0.16.4 the codes (keys) the project uses for a kind of finish: rooms' fields, their parts, the take-offs linked to them */
export function codesUsedFor(m: QtoModel, kind: CodeKind): Set<string> {
  const out = new Set<string>();
  const add = (c: string | undefined | null) => { if (c && c.trim()) out.add(codeKey(c)); };
  const RF: Record<CodeKind, (keyof Room)[]> = { floor: ['fc'], wall: ['wc'], skirting: ['kc'], ceiling: ['cc'], gap: ['gc'], wp: ['pc', 'phc', 'pvc'] };
  for (const r of m.fin.rooms) for (const f of RF[kind]) add(r[f] as string);
  for (const p of m.fin.partById.values()) {
    const k: CodeKind | null = p.ak === 'misc' ? null : p.ak === 'up' ? 'wp' : p.ak === 'bh' ? 'ceiling' : p.cat;
    if (k === kind) add(p.rk === 'link' ? p.it.fcode : p.code);
    if (kind === 'ceiling' && p.fa) add(p.fac);
  }
  return out;
}
/** codes for a code box as the QS types ("PT" -> PT-01, PT-08): starting with it first, then containing it; nothing
 *  typed: every code (v0.16.4 - the list stopped at 12, the rest only found by typing). prefer: these first. */
export function suggestCodes(m: QtoModel, typed: string, limit = Infinity, prefer?: Set<string>): CodeEntry[] {
  const k = codeKey(typed);
  const first = (l: CodeEntry[]) => (prefer?.size ? [...l.filter((c) => prefer.has(c.key)), ...l.filter((c) => !prefer.has(c.key))] : l);
  if (!k) return first(m.fin.codes).slice(0, limit);
  const starts = m.fin.codes.filter((c) => c.key.startsWith(k));
  const has = m.fin.codes.filter((c) => !c.key.startsWith(k) && c.key.includes(k));
  return [...first(starts), ...first(has)].slice(0, limit);
}
/** the project's spelling of a code (case ignored: the first spelling is kept), or as typed when new */
export function canonicalCode(m: QtoModel, typed: string): string {
  const t = typed.trim().replace(/\s+/g, ' ');
  return t ? m.fin.codeByKey.get(t.toLowerCase())?.code ?? t : '';
}

// ------------------------------------------------------------------ the summary
export interface FinRow {
  /** stable id of the row: code key, unit and the group values down to it */
  id: string;
  depth: number;
  code: string;
  key: string;
  unit: string;
  /** the group values from the top down to this row ([] = the code row) */
  g: [GroupKey, string][];
  label: string;
  qty: number;
  linked: number;
  unlinked: number;
  /** the atoms it is made of (filtered), in id order */
  atoms: string[];
  /** portion links counting atoms under it; links made from exactly this row (same values and filters) */
  links: string[];
  exact: string[];
  /** an atom under it falls under two links (counted in the older) / is in a room with deductions larger than a finish */
  twoLinks: boolean;
  over: boolean;
  children: FinRow[];
}
export interface FinSummary {
  rows: FinRow[];
  /** codes used in two units */
  warnings: { code: string; units: string[] }[];
  /** room finishes without a code (not in the summary), each with its reason; and how many ("N finishes have no code") */
  uncoded: FinAtom[];
  noCode: number;
  total: { atoms: number };
}

/**
 * The summary as a tree: one row per code + unit, then grouped by `by` in order (subtotals at every level),
 * after the filters. Always worked out from the model: it changes with every change.
 */
/** v0.16.4 a column of the Finishes Summary by finish type (Nabil's sheet: Floor | QTY | Wall | QTY | Ceiling ...) */
export interface TypeRow { code: string; key: string; unit: string; qty: number; linked: number; n: number }
export interface TypeCol { type: FinishType; rows: TypeRow[]; totals: { unit: string; qty: number }[] }
/**
 * v0.16.4 the Finishes Summary by finish type: a column each - Floor, Wall, Skirting, Ceiling ... - with its codes and
 * their totals, and the column's total on top (per unit). A code used for two types is in both, each with its own
 * quantity (never added together); the filters (Show, headings, search) as in the list.
 */
export function summarizeByType(m: QtoModel, filter?: FinFilter): TypeCol[] {
  const flt = cleanFilter(filter);
  const cols = new Map<FinishType, Map<string, TypeRow>>();
  for (const a of m.fin.atoms) {
    if (!filterOk(a, flt)) continue;
    const t = a.type as FinishType;
    let c = cols.get(t);
    if (!c) cols.set(t, (c = new Map()));
    const k = a.key + '|' + a.unit;
    let r = c.get(k);
    if (!r) c.set(k, (r = { code: a.code, key: a.key, unit: a.unit, qty: 0, linked: 0, n: 0 }));
    r.qty += a.qty;
    if (a.link || a.direct.length) r.linked += a.qty;
    r.n++;
  }
  return FINISH_TYPES.filter((t) => cols.has(t)).map((type) => {
    const rows = [...cols.get(type)!.values()].sort((a, b) => natCmp(a.code, b.code) || (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
    const tot = new Map<string, number>();
    for (const r of rows) tot.set(r.unit, (tot.get(r.unit) ?? 0) + r.qty);
    return { type, rows, totals: [...tot].map(([unit, qty]) => ({ unit, qty })) };
  });
}

export function summarize(m: QtoModel, by: GroupKey[] = [], filter?: FinFilter): FinSummary {
  const fin = m.fin;
  const flt = cleanFilter(filter);
  const atoms = fin.atoms.filter((a) => filterOk(a, flt));
  const headOrder = new Map(m.headings.map((h, i) => [h.id, i]));
  // the spelling shown for a room name / description: the first atom's (id order) with that value
  const spelled = new Map<string, string>();
  for (const a of fin.atoms) for (const k of ['room', 'desc']) { const v = groupVal(a, k); const kk = k + '\u0000' + v; if (v && !spelled.has(kk)) spelled.set(kk, k === 'room' ? a.roomName.trim() : a.desc.trim()); }
  const labelOf = (k: GroupKey, v: string) => ((k === 'room' || k === 'desc') && v ? spelled.get(k + '\u0000' + v) ?? v : groupLabel(m, k, v, []));
  const order = (k: GroupKey) => (a: string, b: string): number => {
    if (a === b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    if (k === 'type') return FINISH_TYPES.indexOf(a as FinishType) - FINISH_TYPES.indexOf(b as FinishType);
    if (k === 'head' || /^h\d+$/.test(k)) return (headOrder.get(a) ?? 1e9) - (headOrder.get(b) ?? 1e9) || (a < b ? -1 : 1);
    return natCmp(a, b);
  };
  const make = (list: FinAtom[], code: string, key: string, unit: string, g: [GroupKey, string][], depth: number, label: string): FinRow => {
    let qty = 0, linked = 0;
    const links = new Set<string>();
    let two = false, over = false;
    for (const a of list) {
      qty += a.qty;
      if (a.link || a.direct.length) linked += a.qty;
      if (a.link) links.add(a.link);
      if (a.flags.includes('twoLinks')) two = true;
      if (a.flags.includes('over')) over = true;
    }
    const exact = fin.links.filter((l) => l.key === key && l.unit === unit && JSON.stringify(l.g) === JSON.stringify(g) && JSON.stringify(l.flt) === JSON.stringify(flt)).map((l) => l.id);
    const row: FinRow = { id: [key, unit, ...g.map(([k, v]) => k + '=' + v)].join('|'), depth, code, key, unit, g, label, qty, linked, unlinked: Math.max(0, qty - linked), atoms: list.map((a) => a.id), links: [...links].sort(), exact, twoLinks: two, over, children: [] };
    if (depth < by.length) {
      const k = by[depth];
      const groups = new Map<string, FinAtom[]>();
      for (const a of list) { const v = groupVal(a, k); (groups.get(v) ?? groups.set(v, []).get(v)!).push(a); }
      for (const v of [...groups.keys()].sort(order(k))) row.children.push(make(groups.get(v)!, code, key, unit, [...g, [k, v]], depth + 1, labelOf(k, v)));
    }
    return row;
  };
  const tops = new Map<string, FinAtom[]>();
  for (const a of atoms) { const t = a.key + '\u0000' + a.unit; (tops.get(t) ?? tops.set(t, []).get(t)!).push(a); }
  const rows = [...tops.values()]
    .map((list) => make(list, list[0].code, list[0].key, list[0].unit, [], 0, list[0].code + ' (' + list[0].unit + ')'))
    .sort((a, b) => natCmp(a.code, b.code) || (a.unit < b.unit ? -1 : 1));
  return { rows, warnings: fin.warnings, uncoded: fin.uncoded, noCode: fin.noCode, total: { atoms: atoms.length } };
}

/** per code + unit: total, linked, still unlinked (no grouping, no filters) */
export const codeTotals = (m: QtoModel) => summarize(m).rows.map((r) => ({ code: r.code, unit: r.unit, total: r.qty, linked: r.linked, unlinked: r.unlinked }));

/** what a link made from a row would cover: the row's code, unit and group values, and the filters shown */
export interface FinPred { code: string; unit: string; g: [GroupKey, string][]; flt: FinFilter }
export const rowPredicate = (row: FinRow, filter?: FinFilter): FinPred => ({ code: row.code, unit: row.unit, g: row.g, flt: cleanFilter(filter) });

export interface Overlap { id: string; kind: 'fl' | 'lk'; label: string; to: string }
/**
 * The atoms a link would count now, and the portion links already counting any of them. A take-off linked to the
 * BOQ by itself is linked already: a new link leaves it out (`direct`) - it does not stand in the way (else a room
 * with such a take-off linked to it could never have the rest of its finish linked: nothing tells the two apart).
 */
export function linkCheck(m: QtoModel, pred: FinPred): { atoms: FinAtom[]; overlaps: Overlap[]; direct: FinAtom[] } {
  const p = { key: codeKey(pred.code), unit: pred.unit, g: pred.g, flt: cleanFilter(pred.flt) };
  // (a link made now: its own code only - nb)
  const all = m.fin.atoms.filter((a) => covers({ ...p, nb: true }, a));
  const atoms = all.filter((a) => !a.direct.length);
  const seen = new Map<string, Overlap>();
  for (const a of atoms) for (const id of a.links) { const l = m.fin.linkById.get(id)!; if (!seen.has(id)) seen.set(id, { id, kind: 'fl', label: l.label, to: l.to }); }
  return { atoms, overlaps: [...seen.values()], direct: all.filter((a) => a.direct.length) };
}

/**
 * Link a row of the summary to a BOQ line ('b:<id>') or a temporary / additional line ('dm:<id>'). Refused
 * when any quantity it would cover is already linked: the links it overlaps are listed (unlink them first).
 */
export function portionLinkOps(m: QtoModel, pred: FinPred, to: string): { ok: true; id: string; ops: Op[] } | { ok: false; overlaps: Overlap[]; reason: string } {
  if (!pred.code.trim()) return { ok: false, overlaps: [], reason: 'Only finishes with a code can be linked.' };
  if (!to) return { ok: false, overlaps: [], reason: 'Pick a BOQ item.' };
  const chk = linkCheck(m, pred);
  if (!chk.atoms.length) return { ok: false, overlaps: [], reason: chk.direct.length ? 'All of it is linked already (its take-offs are linked themselves).' : 'Nothing to link.' };
  if (chk.overlaps.length) return { ok: false, overlaps: chk.overlaps, reason: 'Part of this quantity is linked already.' };
  const id = 'fl:' + randomId(10);
  const flt = cleanFilter(pred.flt);
  // (nb: made after the waterproofing codes were split - its own code only; older apps ignore it)
  return { ok: true, id, ops: [[id, 'code', canonicalCode(m, pred.code)], [id, 'unit', pred.unit], [id, 'g', JSON.stringify(pred.g)], [id, 'flt', emptyFilter(flt) ? null : JSON.stringify(flt)], [id, 'to', to], [id, 'nb', true]] };
}
export const removePortionLinkOps = (id: string): Op[] => [[id, 'del', true]];

/** save a breakdown (grouping + filters) by name; with `id` it is changed (a change of view: links are left alone) */
export function saveBreakdownOps(m: QtoModel, b: { name: string; by: GroupKey[]; filter?: FinFilter }, id?: string): { id: string; ops: Op[] } {
  const bid = id ?? 'fb:' + randomId(10);
  const flt = cleanFilter(b.filter);
  const last = m.fin.breakdowns.map((x) => x.ord).filter(Boolean).sort().pop();
  const ops: Op[] = [[bid, 'name', b.name.trim() || 'Breakdown'], [bid, 'by', JSON.stringify(b.by)], [bid, 'flt', emptyFilter(flt) ? null : JSON.stringify(flt)]];
  if (!id) ops.push([bid, 'ord', (last ?? '') + 'a']);
  return { id: bid, ops };
}
export const removeBreakdownOps = (id: string): Op[] => [[id, 'del', true]];

/** the BOQ line(s) an atom counts in, as text (export, tooltips) */
export function atomLinkText(m: QtoModel, a: FinAtom): string {
  const name = (to: string) => {
    const r = to.startsWith('b:') ? m.boqById.get(to.slice(2)) : m.dummyById.get(to);
    return r ? (r.ref ? r.ref + ' ' : '') + r.desc.slice(0, 60) : '(line removed)';
  };
  if (a.direct.length) return a.direct.map((id) => name(m.links.find((l) => l.id === id)?.to ?? '')).join('; ') + ' (take-off linked itself)';
  if (a.link) return name(m.fin.linkById.get(a.link)!.to) + (a.flags.includes('twoLinks') ? ' (also under a newer link)' : '');
  return '';
}

/**
 * Do these changes use what only 0.16 reads (rooms, room links, portion links, saved breakdowns, sills)?
 * Then the take-off needs the next data format: a 0.15 app would show a room as a plain area, count room
 * doors as placed doors, and - not knowing portion links - write the estimate's Take-off column without
 * the finishes. (The integrator bumps DATA_FORMAT and calls this beside needsFormat3.)
 */
export function needsFormatFinishes(ops: [string, string, unknown][]): boolean {
  for (const [e, f, v] of ops) {
    if (v === null || v === undefined) continue;
    if (e.startsWith('fl:') || e.startsWith('fb:')) return true;
    if (e.startsWith('ti:') && ((f === 'kind' && v === 'room') || f === 'rm' || f === 'rk')) return true;
    if (e.startsWith('op:') && f === 'sill') return true;
  }
  return false;
}

export { CAT_TYPE };

// ---------------------------------------------------------------- v0.18 miscellaneous items (Finalize › Miscellaneous)
export interface MiscRow { code: string; key: string; unit: string; qty: number; linked: number; descs: string[]; fins: string[]; rooms: number; atoms: string[]; item: string; mfin: string }
/** the rooms' miscellaneous items by code and unit (Feedback 3, F): their descriptions and finishes, how many
 *  rooms, the total, what is linked; `uncoded` = items with no code (not in the totals). Filtered by headings / text. */
export function miscSummary(m: QtoModel, filter?: FinFilter): { rows: MiscRow[]; uncoded: number } {
  // (v0.18.1 Feedback 3, F: grouped by Code, Description, Finish and Unit - each row linked on all four)
  const flt: FinFilter = { heads: filter?.heads?.length ? filter.heads : undefined, q: filter?.q };
  const by = new Map<string, MiscRow & { rs: Set<string> }>();
  for (const a of m.fin.atoms) {
    if (a.type !== 'Miscellaneous' || !filterOk(a, flt)) continue;
    const k = a.key + '|' + groupVal(a, 'item') + '|' + groupVal(a, 'mfin') + '|' + a.unit;
    let r = by.get(k);
    if (!r) by.set(k, (r = { code: a.code, key: a.key, unit: a.unit, qty: 0, linked: 0, descs: [a.label.trim()], fins: a.fin ? [a.fin.trim()] : [], rooms: 0, atoms: [], rs: new Set(), item: groupVal(a, 'item'), mfin: groupVal(a, 'mfin') }));
    r.qty += a.qty;
    if (a.link || a.direct.length) r.linked += a.qty;
    r.rs.add(a.room);
    r.atoms.push(a.id);
  }
  const rows = [...by.values()].map(({ rs, ...r }) => ({ ...r, rooms: rs.size })).sort((a, b) => natCmp(a.code, b.code) || a.item.localeCompare(b.item) || a.mfin.localeCompare(b.mfin) || (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
  return { rows, uncoded: m.fin.uncoded.filter((a) => a.type === 'Miscellaneous' && filterOk(a, flt)).length };
}
