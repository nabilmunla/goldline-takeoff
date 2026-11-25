// Take-off project model.
//
// A take-off project is an ordinary synced project folder (the journal engine) with format
// "takeoff" (earlier versions wrote another id: engine/legacy.ts). It never holds a price.
//
// Entities (id prefix : fields)
//   project            name, est (estimation project id it is attached to), estName
//   dwg:<id>           a sheet; its fields describe the CURRENT file: name, path, unc, hash, size, mtime, pages,
//                      grp, sheet (no.), title, disc (discipline), rev (revision label), issue (e.g. "PTA 03"), del
//                      v0.16: fp / fpn - the sheet is ONE page of a bound set (a "binder" PDF): page fp (from 0) of a
//                      file of fpn pages; the sheet itself has one page (pages 1, its shapes / scale on pg 0). Without
//                      fp a sheet is the whole file (a multi-page drawing from before 0.16 shows its pages under it)
//   rv:<id>            an earlier revision of a sheet: dwg, name, path, unc, hash, size, mtime, pages, rev, issue, added
//                      (v0.16: fp / fpn as on dwg: the page of that file the sheet was)
//   pg:<dwg>.<n>       one page of a drawing: sc (metres per sheet point - across, and both ways unless
//                      scy is set), scl (label), scy / scyl (a different scale up-down, v0.12.5), sn, title;
//                      scy0 / scyl0: the up-down scale kept as it was when only across was changed on a sheet
//                      with one scale (scy wins over it: someone setting up-down at the same time keeps theirs)
//   sr:<id>            a scale region (viewport with its own scale): dwg, pg, r [x0,y0,x1,y1], sc, scl, scy, scyl, del
//   dh:<id>            a heading in the drawing list (same as hd:, for sheets). A sheet's place: dpar (heading, "/" =
//                      top level), dord. Without dpar a sheet sits under headings made from its folder path.
//   hd:<id>            a heading in the take-off list: name, par (parent heading id), ord, del. Headings nest;
//                      take-off items and headings under one parent share one order (ord).
//                      "hd:g<hash>" = the heading made from a v0.6/v0.7 group name (exists virtually until edited)
//   ti:<id>            a take-off item: name, kind (area|line|count|wall|beam), color, par (heading), grp (old group name,
//                      used only when there is no par), owner, priv, h, d, x, waste, dmin, ded [opening item ids],
//                      ow, oh, note, ord, del
//                      walls (v0.15): h height, d thickness; lintels lb (bearing each side), ld (depth), lw (breadth
//                      when the wall has no thickness) - null = 0.20 m each
//                      beams (v0.15): bt (beam type of untagged segments), st (slab thickness taken off the depth)
//                      display (v0.15): sw (line thickness factor), fill (solid|hatch|none), lab (hover|always|never)
//   sh:<id>            a measured shape: ti, dwg, pg, k (poly|line|pt), p [x,y,...], b [bulge per segment: arcs], holes [[x,y,...]], m, rv (fingerprint
//                      of the revision it was measured / last checked on), sg [tag per segment: text, or a beam type
//                      id 'bt:..'; null = none] (v0.15), del
//                      v0.16: by = who drew it (its owner); co:<username> = true - someone else who changed it since
//                      (a joint owner, owners.ts)
//   bt:<id>            a beam type (v0.15): name, w (width m), d (depth m), r (steel kg/m³), color, del
//   ds:<id>            a door in the door schedule (v0.15): tag, desc, loc, sw / sh (structural opening W / H, m),
//                      cw / ch (clear opening), ord, src ('a' = added in the app, else from an Excel import), del.
//                      A link (lk:) from a door ('ti' = 'ds:<id>') takes its count.
//   op:<id>            an opening placed on a wall (v0.15): sh (shape), x, y (where on the sheet), k (door|open),
//                      door (ds:<id>, for a door from the schedule), w, h (other openings: size, m), tag, lint
//                      (false = no lintel), del. Its segment is the shape's nearest to (x, y).
//   lk:<id>            link take-off -> BOQ line: ti, to ('b:<boq id>' or 'dm:<id>'), q (measure), f (factor), del
//   dm:<id>            dummy BOQ line made by the QS before the real BOQ exists: ref, desc, unit, grp, map, ord, del
//   b:<boq id>         price-free copy of the estimator's BOQ line: bt, par, ord, ref, desc, unit, qty, page, del
//   nt:<id>            note: on (entity id), text, to (est|me), by, byName, t, done, dwg, pg, x, y, del
//   -- v0.16 Finishes (rooms.ts / finishes.ts; ROOM-SPEC.md) --
//   ti:<id> kind room  a Room: name, desc, x (Times), color, par, ord, owner, priv; finish codes and heights:
//                      fc (floor), wc + hw (wall finish code, height), kc + hs (skirting code, height), cc + cm
//                      (ceiling code, 'manual' | null = auto), gc + gm (shadow gap code, 'all' | 'pick' | null = off),
//                      pc + pm + pu + pl + phc + pvc (waterproofing code, 'up' | 'full' | null = off, upturn,
//                      level (null = wall finish height), own codes of the horizontal / vertical parts).
//                      Its sh: shapes are the outline (closed areas, cut-outs allowed); its edges' flags ride in
//                      the shape's sg (segment tags): '~o' = open edge (no wall), '~g' = shadow gap picked.
//   ti: (any kind)     fcode: finish code ('' = none: not in the Finishes Summary, behaves as before)
//                      rm (room), rk ('add' additional finish | 'ceil' manual ceiling area | 'link' an existing
//                      take-off linked to the room), rcat (floor|wall|skirting|ceiling, or for 'link' an additional
//                      finish's ti id), rded (false = not deducted from the main finish), bl (bottom level of an
//                      additional wall finish), full (additional floor / ceiling = the full room area), rh (height
//                      of a length linked to Wall). 'add' / 'ceil' take-offs exist only with their room.
//   op: on a room      the same entity as on walls, plus sill (m; doors 0). Never counted as doors (roomOpenings).
//   fl:<id>            Finishes portion link: code, unit, g (JSON [[group key, value]...]), flt (JSON filters), to
//   fb:<id>            saved Finishes breakdown: name, by (JSON group keys), flt (JSON filters), ord, del
import type { Store } from '../store';
import type { Cell, Value } from '../types';
import polygonClipping, { type Polygon as PcPolygon } from 'polygon-clipping';
const pcIntersection = polygonClipping.intersection, pcUnion = polygonClipping.union;
import { arcPoints, bbox, centroid, flatten, pathArea, pathLengthY, polyArea, polyLengthY, pointInPoly, polyInside, polysOverlap, segLengthY, toPts, yRatio, type Box, type Pt } from './geometry';
import { unitFactor } from './units';
import { buildFinishes, needsFormatFinishes, type FinModel } from './finishes';
import { pageSheetId } from './revisions';

export type Kind = 'area' | 'line' | 'count' | 'wall' | 'beam' | 'room';
export type ShapeKind = 'poly' | 'line' | 'pt';
/** what a link takes from a take-off item */
// (v0.18.1 substructure: waterproofing horizontal (bottom) / vertical (sides), blinding (m³), polythene (m²))
export type Measure = 'area' | 'len' | 'perim' | 'vol' | 'cnt' | 'form' | 'kg' | 'lvol' | 'llen' | 'lcnt' | 'wph' | 'wpv' | 'blv' | 'pea';

export const KIND_LABEL: Record<Kind, string> = { area: 'Area', line: 'Length', count: 'Count', wall: 'Wall', beam: 'Beam', room: 'Room' };
export const MEASURE_LABEL: Record<Measure, string> = { area: 'Area', len: 'Length', perim: 'Perimeter', vol: 'Volume', cnt: 'Count', form: 'Formwork', kg: 'Steel', lvol: 'Lintels (volume)', llen: 'Lintels (length)', lcnt: 'Lintels (number)', wph: 'WP horizontal', wpv: 'WP vertical', blv: 'Blinding', pea: 'Polythene' };
export const MEASURE_UNIT: Record<Measure, string> = { area: 'm²', len: 'm', perim: 'm', vol: 'm³', cnt: 'nr', form: 'm²', kg: 'kg', lvol: 'm³', llen: 'm', lcnt: 'nr', wph: 'm²', wpv: 'm²', blv: 'm³', pea: 'm²' };
/** what a measure is, for unit checks and decimals: formwork is an area, lintel volume a volume... */
export const MEASURE_BASE: Record<Measure, 'area' | 'len' | 'vol' | 'cnt' | 'kg'> = { area: 'area', len: 'len', perim: 'len', vol: 'vol', cnt: 'cnt', form: 'area', kg: 'kg', lvol: 'vol', llen: 'len', lcnt: 'cnt', wph: 'area', wpv: 'area', blv: 'vol', pea: 'area' };
/** kinds measured with a line (and its segments) */
export const LINE_KINDS: Kind[] = ['line', 'wall', 'beam'];
export const isLineKind = (k: Kind) => k === 'line' || k === 'wall' || k === 'beam';
/** lintel defaults (m): bearing each side, depth, breadth when the wall has no thickness */
export const LINTEL_DEFAULT = { lb: 0.2, ld: 0.2, lw: 0.2 };

export interface Drawing {
  id: string;
  name: string;
  path: string;
  unc: string;
  hash: string;
  size: number;
  mtime: number;
  pages: number;
  grp: string;
  /** sheet number / title from the file name or title block */
  sheet: string;
  title: string;
  added: number;
  addedBy: string;
  /** discipline (Architectural, Structural, ...) */
  disc: string;
  /** revision label of the current file ("Rev C", "IFC-02") and the issue it came with ("260814 PTA 03") */
  rev: string;
  issue: string;
  /** heading in the drawing list ('' = top level), resolved; and its order there */
  dpar: string;
  dord: string;
  /** v0.16: one page of a bound set - the page (from 0) of the file this sheet shows; undefined = the whole file */
  fp?: number;
  /** v0.16: pages in that file */
  fpn?: number;
}

/** An earlier revision of a sheet (the file it was, kept so it can be compared) */
export interface Revision {
  id: string;
  dwg: string;
  name: string;
  path: string;
  unc: string;
  hash: string;
  size: number;
  mtime: number;
  pages: number;
  rev: string;
  issue: string;
  added: number;
  addedBy: string;
  /** when it was replaced by a newer file */
  superseded: number;
  /** v0.16: the page of that file the sheet was (a page of a bound set); undefined = the whole file */
  fp?: number;
  fpn?: number;
}

export interface PageInfo {
  key: string;
  dwg: string;
  pg: number;
  sc: number | null;
  scl: string;
  /** a different scale up and down the sheet (Y), metres per point; null = the same as across */
  scy: number | null;
  scyl: string;
  /** scy was set on its own (not only kept from before across changed: scy0) */
  scyOwn?: boolean;
  /** size of the page (sheet points) when its scale was set: a revision on other paper needs a new scale */
  w: number | null;
  h: number | null;
}

export interface Region {
  id: string;
  dwg: string;
  pg: number;
  r: Box;
  sc: number;
  scl: string;
  /** a different scale up and down in this viewport (Y); null = the same as across */
  scy: number | null;
  scyl: string;
}

export interface TItem {
  id: string;
  name: string;
  kind: Kind;
  color: string;
  grp: string;
  owner: string;
  priv: boolean;
  /** height (m): length x height = area (walls, skirting height, glazing) */
  h: number | null;
  /** depth / thickness (m): area x depth = volume */
  d: number | null;
  /** multiplier for the whole item (e.g. 2 sides) */
  x: number;
  /** waste allowance % */
  waste: number;
  /** openings / holes up to this area (m²) are NOT deducted; null = deduct every opening */
  dmin: number | null;
  /** opening items deducted from this item */
  ded: string[];
  /** size of one opening (m), for count items used as openings */
  ow: number | null;
  oh: number | null;
  note: string;
  ord: string;
  /** heading it sits under ('' = top level), resolved */
  par: string;
  /** walls: lintel bearing each side, depth, breadth (when no thickness) - null = LINTEL_DEFAULT */
  lb: number | null;
  ld: number | null;
  lw: number | null;
  /** beams: the type of segments without a tag; slab thickness taken off the depth */
  bt: string;
  st: number | null;
  /** display: line thickness factor, area fill, labels on the drawing ('' = as set on this PC) */
  sw: number | null;
  fill: '' | 'solid' | 'hatch' | 'none';
  lab: '' | 'hover' | 'always' | 'never';
  /** v0.16 finishes: finish code ('' = none); the room it belongs to / is linked to, and how (see rooms.ts) */
  fcode?: string;
  rm?: string;
  rk?: '' | 'add' | 'ceil' | 'link';
  /** v0.16.1 a door counter (count take-off whose points are doors of the schedule, `door` on each shape: doors not
   *  on a wall - cores, partitions); its doors reach the BOQ only through the door schedule */
  dc?: boolean;
  /** v0.17 a structural element measured with a base kind: an area as a slab / a drop panel, a count as columns,
   *  a wall as a shear wall ('' = none) */
  sk?: StructKind;
  /** v0.18 a slab with A254 mesh (its m² shown in Finalize); a stair's tread and riser (its waist = d, its landings'
   *  thickness = st, its flights' width = ow). A column's `st` = the slab thickness that comes off its height. */
  mesh?: boolean;
  /** v0.18.1 a slab: its soffit formwork less the drop panels' and beams' soffits under it */
  fdx?: boolean;
  /** v0.18.1 substructure (footings, rafts, slabs on grade, retaining walls): waterproofing under it (wb) and to its
   *  sides (wsd) up to wvh (null = its full depth / height; a wall: on wfc faces, 1 or 2); blinding under it (bln) blt
   *  thick (0.05) reaching blx past its edges (0.05); polythene under it (pe), over the blinding's extent */
  wb?: boolean; wsd?: boolean; wvh?: number | null; wfc?: 1 | 2; bln?: boolean; blt?: number | null; blx?: number | null; pe?: boolean;
  /** v0.18 columns / shear walls: the slab thickness that comes off their height (floor to floor typed, the slab not counted twice) */
  cst?: number | null;
  tr?: number | null;
  ri?: number | null;
  /** v0.17 steel (kg per m³ of concrete) of a slab / drop panel - and of columns / shear walls / beams whose type has none */
  sr?: number | null;
  /** v0.17 beams: upstands (inverted beams, above the slab: no slab off the depth, formwork both sides, no soffit) */
  up?: boolean;
}

/** v0.17 structural elements measured with a base kind */
// v0.18: 'sw' a shear wall counted like a column (its type: length × thickness), 'ftg' footings counted (its type:
// L × W × D), 'raft' a raft / an irregular footing drawn as an area (× its thickness), 'stair' a stair (its flights
// and landings drawn as areas on the plan)
// v0.18.1: 'sog' a slab on grade (area × thickness; formwork to its edges), 'rw' a retaining wall (a wall: its type's
// thickness, formwork both faces, waterproofing)
export type StructKind = '' | 'slab' | 'drop' | 'col' | 'shear' | 'sw' | 'ftg' | 'raft' | 'stair' | 'sog' | 'rw';
export const SK_LABEL: Record<Exclude<StructKind, ''>, string> = { slab: 'Slab', drop: 'Drop panel', col: 'Column', shear: 'Core wall', sw: 'Shear wall', ftg: 'Footing', raft: 'Raft', stair: 'Stair', sog: 'Slab on grade', rw: 'Retaining wall' };
/** the kind a structural element is measured with */
export const SK_KIND: Record<Exclude<StructKind, ''>, Kind> = { slab: 'area', drop: 'area', col: 'count', shear: 'wall', sw: 'count', ftg: 'count', raft: 'area', stair: 'area', sog: 'area', rw: 'wall' };
/** v0.18.1 a concrete wall drawn as a wall (core wall, retaining wall): its segments' types give the thickness */
export const isConcWall = (sk: StructKind | undefined): sk is 'shear' | 'rw' => sk === 'shear' || sk === 'rw';
/** v0.18.1 elements on the ground: waterproofing (bottom / sides), blinding and polythene may go with them */
export const isSubStruct = (sk: StructKind | undefined): boolean => sk === 'ftg' || sk === 'raft' || sk === 'sog' || sk === 'rw';
/** v0.18 the structural elements counted one by one, each with a type of its schedule (and its own overrides) */
export const isCountedStruct = (sk: StructKind | undefined): sk is 'col' | 'sw' | 'ftg' => sk === 'col' || sk === 'sw' || sk === 'ftg';
/** the type entities' prefix of a counted element's schedule */
export const TYPE_PRE: Record<'col' | 'sw' | 'ftg', 'ct' | 'st' | 'ft'> = { col: 'ct', sw: 'st', ftg: 'ft' };
/** what a take-off is called by its kind ("Slab", "Upstand beam", "Area") */
export const itemKindLabel = (it: Pick<TItem, 'kind' | 'sk' | 'up'>) => (it.sk ? SK_LABEL[it.sk] : it.kind === 'beam' && it.up ? 'Upstand beam' : KIND_LABEL[it.kind]);
/** A beam type: segments of a beam take-off tagged with it get its size and steel ratio */
export interface BeamType {
  id: string;
  name: string;
  /** width and depth (m), steel (kg per m³ of concrete) */
  w: number | null;
  d: number | null;
  r: number | null;
  color: string;
  /** v0.17 a column type: round (w = its diameter) */
  round?: boolean;
  /** v0.18 a footing type: its depth (w × d its plan) (v0.18.1 a stair type: its landing thickness) */
  t?: number | null;
  /** v0.18.1 a stair type: tread and riser (w = the flight width, d = the waist) */
  tr?: number | null;
  ri?: number | null;
}
/** v0.17 column types (w × d, or round: w the diameter) and shear wall types (w = the thickness) are BeamTypes too */
export type MemberType = BeamType;

/** A row of the door schedule (imported from Excel or typed) */
export interface DoorRow {
  id: string;
  tag: string;
  desc: string;
  loc: string;
  /** structural opening (deducted from the wall; its width carries the lintel) and clear opening, m */
  sw: number | null;
  sh: number | null;
  cw: number | null;
  ch: number | null;
  ord: string;
  /** added in the app (from the door picker or the schedule table) rather than from an Excel file */
  app: boolean;
}

/** An opening placed on a wall shape */
export interface Opening {
  id: string;
  sh: string;
  x: number;
  y: number;
  k: 'door' | 'open';
  /** the door schedule row (doors) */
  door: string | null;
  tag: string;
  /** size of an opening that is not from the schedule (m) */
  w: number | null;
  h: number | null;
  /** a lintel over it */
  lint: boolean;
  /** a door whose tag is not (or no longer) in the door schedule: counted with its last known size */
  uns: boolean;
  /** resolved: the shape's segment it is on, and how far along it (0..1) */
  seg: number;
  t: number;
  /** v0.18 on a plain length (skirting, a partition measured by its length): its width comes off the length (its
   *  width × height off the area when the length has a height) - never a door count, no lintel */
  ln?: boolean;
  /** v0.16: in a room (corrects its finishes only - never a door count), and its sill height (m; doors 0) */
  room?: boolean;
  sill?: number | null;
}

/** A heading in the take-off list (headings nest) */
export interface Heading {
  id: string;
  name: string;
  /** parent heading ('' = top level), resolved */
  par: string;
  ord: string;
  /** made from an old group name, not saved as a heading yet */
  virtual: boolean;
  depth: number;
}

export type TreeNode = { t: 'h'; id: string; ord: string } | { t: 'i'; id: string; ord: string };

/** A list organised under headings (the take-off list, the drawing list) */
export interface TreeView {
  kind: 'items' | 'drawings';
  /** children of each heading in list order ('' = top level) */
  tree: Map<string, TreeNode[]>;
  /** depth-first */
  headings: Heading[];
  headingById: Map<string, Heading>;
  /** heading each leaf (take-off / sheet) sits under ('' = top level) */
  leafPar: Map<string, string>;
}

export interface Shape {
  id: string;
  ti: string;
  dwg: string;
  pg: number;
  k: ShapeKind;
  pts: Pt[];
  /** bulge of each segment (segment i = point i -> i+1; areas: the last one closes back to the first); [] = all straight */
  b: number[];
  /** the outline as a fine polyline (= pts when there are no arcs) — for drawing and hit tests */
  flat: Pt[];
  holes: Pt[][];
  m: number;
  box: Box;
  by: string;
  /** fingerprint of the drawing revision the shape was measured / last checked on ('' = unknown) */
  rv: string;
  /** the page it was measured on, when it was moved here from a page the new revision no longer has */
  opg?: number;
  /** tag of each segment (beam type id, or text); [] = none */
  sg: (string | null)[];
  /** v0.16 (owners.ts): people who changed it besides who drew it (`co:<username>` fields) - joint owners */
  co?: string[];
  /** v0.16.1 a door counter's point: the door schedule row (ds:) it is */
  door?: string;
  /** v0.17 a column (a count of columns): its type (ct:) */
  mt?: string;
  /** v0.18 (Feedback 3, 7) this element's own figures in place of its type's / its take-off's: size (xw × xd; a
   *  footing's depth xt), height (xh), steel ratio (xr); a stair flight's number of steps (xn) */
  xw?: number; xd?: number; xt?: number; xh?: number; xr?: number; xn?: number;
  /** v0.18 a stair's area that is a landing ('l'; else a flight) */
  sp?: 'l';
}
/** has this shape figures of its own (v0.18) */
export const shapeOverridden = (s: Pick<Shape, 'xw' | 'xd' | 'xt' | 'xh' | 'xr' | 'xn'>) => s.xw !== undefined || s.xd !== undefined || s.xt !== undefined || s.xh !== undefined || s.xr !== undefined || s.xn !== undefined;

export interface Link {
  id: string;
  ti: string;
  to: string;
  q: Measure;
  f: number;
  /** a second link of the same take-off to the same BOQ line: shown, not counted */
  dup?: boolean;
  /** v0.16: who linked it there (account of the last change of its target) */
  by?: string;
}

/** is this take-off already linked to that line (directly, or through a temporary line matched to it)? */
export function alreadyLinked(m: Pick<QtoModel, 'linksByItem' | 'dummyById'>, ti: string, to: string): boolean {
  // (a temporary line not matched counts to its own line in the estimate: qx_<id>)
  const realOf = (t: string) => { if (t.startsWith('b:')) return t.slice(2); const d = m.dummyById.get(t); return d ? dummyReal(d) : null; };
  const want = realOf(to);
  return (m.linksByItem.get(ti) ?? []).some((l) => l.to === to || (!!want && realOf(l.to) === want));
}

export interface Dummy {
  id: string;
  ref: string;
  desc: string;
  unit: string;
  grp: string;
  /** real BOQ line id this dummy now stands for */
  map: string | null;
  ord: string;
  /** v0.16: kept as an additional item (the BOQ doesn't have it) */
  add: boolean;
  /** v0.16: the bill it goes in (the estimate's id of a top-level heading) and where it is */
  bill: string;
  loc: string;
  /** v0.16: who added it (username, display name) */
  by: string;
  byName: string;
}

/** v0.16: the estimate's line an additional item (or a temporary line not resolved yet) becomes */
export const qxId = (dmId: string) => 'qx_' + dmId.slice(dmId.indexOf(':') + 1);
/** ...and back: the temporary line / additional item an estimate line was made from */
export const dmOfQx = (lineId: string) => (lineId.startsWith('qx_') ? 'dm:' + lineId.slice(3) : null);
/** the BOQ line a temporary line's links count to: the line it was matched to, else its own line */
export const dummyReal = (d: Pick<Dummy, 'id' | 'map'>) => d.map ?? qxId(d.id);

export interface MirrorRow {
  id: string;
  bt: 'group' | 'item' | 'note';
  par: string | null;
  ord: string;
  ref: string;
  desc: string;
  unit: string;
  qty: number | null;
  page: string;
  depth: number;
  children: MirrorRow[];
  /** v0.16: a: additional item from a QS · n: temporary line not resolved · g: the "Additional items (QS)" heading */
  qa: '' | 'a' | 'n' | 'g';
  loc: string;
  qby: string;
  /** v0.16.2 where it came from in the consultant's file: importId:file:sheet:row */
  src: string;
  /** v0.16.3 the consultant's quantity at import (undefined: a copy from an older app, without it) */
  q0?: number | null;
  /** v0.16: the estimator changed the QS's suggestion (from then on it is the estimator's) */
  own: boolean;
}

export interface Note {
  id: string;
  on: string;
  text: string;
  to: 'est' | 'me';
  by: string;
  byName: string;
  t: number;
  done: boolean;
  dwg: string | null;
  pg: number | null;
  x: number | null;
  y: number | null;
}

export interface ShapeQty {
  cnt: number;
  len: number;
  area: number;
  perim: number;
  /** area of holes that were deducted / left in (below the threshold) */
  holesDeducted: number;
  holesKept: number;
  /** null when the page has no scale yet */
  scaled: boolean;
  /** cut-outs outside the outline or overlapping another one: not deducted (fix them) */
  badHoles: number;
  /** parts of the shape lie at different scales (it crosses a viewport's edge) */
  mixed?: boolean;
}

export interface ItemQty {
  shapes: number;
  unscaled: number;
  cnt: number;
  len: number;
  area: number;
  /** area before openings from other items were deducted */
  gross: number;
  perim: number;
  vol: number;
  /** opening deductions taken off */
  dedArea: number;
  dedLen: number;
  /** openings at or under the threshold that were left in */
  keptOpenings: number;
  /** shapes crossing a viewport's edge (measured part by part / at their middle) */
  mixed: number;
  /** cut-outs not deducted because they lie outside their area or overlap another */
  badHoles: number;
  /** beams: formwork (m²) and steel (kg); length without a beam type (not in the volume) */
  form: number;
  kg: number;
  untyped: number;
  /** walls: lintels (volume m³, length m, number), doors and other openings placed on the walls */
  lvol: number;
  llen: number;
  lcnt: number;
  doors: number;
  opens: number;
  /** v0.18.1 substructure: waterproofing horizontal (bottom) and vertical (sides) m², blinding m³, polythene m² */
  wph: number;
  wpv: number;
  blv: number;
  pea: number;
  /** v0.18.1 a stair: its steps (all its flights) */
  steps: number;
  /** v0.18.1 a slab: soffit formwork taken off where drop panels and beams are under it (m²) */
  soffitOff: number;
  /** per segment tag (beam type id or text): what the tagged segments come to */
  byTag: Map<string, TagQty>;
}

/** what the segments with one tag come to (lengths, and for beams the concrete, formwork, steel) */
export interface TagQty {
  len: number;
  segs: number;
  vol: number;
  form: number;
  kg: number;
}

export interface TargetQty {
  total: number;
  /** fl: a Finishes portion link (v0.16): `link` / `item` stand for it (its id), see finishes.ts */
  parts: { link: Link; item: TItem; v: number; fl?: string }[];
}

export interface QtoModel {
  name: string;
  est: string | null;
  estName: string;
  drawings: Drawing[];
  dwgById: Map<string, Drawing>;
  /** earlier revisions per sheet, newest first */
  revisions: Map<string, Revision[]>;
  /** shapes measured on an earlier revision than the sheet's current file, not checked since */
  stale: Set<string>;
  staleByDwg: Map<string, number>;
  /** shapes on pages a drawing no longer has (a new revision with fewer pages): not counted */
  offPage: Map<string, number>;
  /** those shapes (not in `shapes`: not counted, not drawn on the current revision) */
  offPageShapes: Map<string, Shape[]>;
  /** drawings removed from the project (their ids stay taken) */
  removedDwg: Set<string>;
  pages: Map<string, PageInfo>;
  regions: Region[];
  items: TItem[];
  itemById: Map<string, TItem>;
  headings: Heading[];
  headingById: Map<string, Heading>;
  /** children of each heading in list order ('' = top level) */
  tree: Map<string, TreeNode[]>;
  /** the take-off list (tree, headings, headingById above are the same objects) */
  itemTree: TreeView;
  /** the drawing list organised by the team */
  dwgTree: TreeView;
  shapes: Shape[];
  shapesByPage: Map<string, Shape[]>;
  /** v0.18 the images on sheets this viewer sees (his own, and those shared) */
  images: SheetImage[];
  /** v0.18.1 another sheet put in place over a sheet ("this|over" page keys): shared by the team */
  overAligns: Map<string, OverAlign>;
  shapesByItem: Map<string, Shape[]>;
  links: Link[];
  linksByItem: Map<string, Link[]>;
  dummies: Dummy[];
  dummyById: Map<string, Dummy>;
  boqRoots: MirrorRow[];
  boqById: Map<string, MirrorRow>;
  /** v0.16.2 the estimate's import records: importId -> files JSON (mirrored as bi:<id>) */
  boqImports: Map<string, string>;
  notes: Note[];
  qty: Map<string, ItemQty>;
  beamTypes: BeamType[];
  beamTypeById: Map<string, BeamType>;
  /** v0.17 column types (ct:) and shear wall types (wt:) */
  colTypes: MemberType[];
  colTypeById: Map<string, MemberType>;
  wallTypes: MemberType[];
  wallTypeById: Map<string, MemberType>;
  /** v0.18 shear wall types (st: w = length, d = thickness) and footing types (ft: w × d × t) */
  swTypes: MemberType[];
  swTypeById: Map<string, MemberType>;
  /** v0.18.1 retaining wall types (rt: w = thickness) */
  rwTypes: MemberType[];
  rwTypeById: Map<string, MemberType>;
  /** v0.18.1 stair types (sy: tread tr, riser ri, flight width w, waist d, landing thickness t, steel r) */
  stairTypes: MemberType[];
  stairTypeById: Map<string, MemberType>;
  ftgTypes: MemberType[];
  ftgTypeById: Map<string, MemberType>;
  doors: DoorRow[];
  doorById: Map<string, DoorRow>;
  /** door schedule rows deleted, by tag (lower case): a tag coming back revives its row, links and all */
  doorsGone: Map<string, string>;
  /** doors and openings on walls (counted). openingsByShape also has the ones in rooms (roomOpenings) */
  openings: Opening[];
  openingsByShape: Map<string, Opening[]>;
  /** v0.16: doors / openings placed in rooms - they correct the room's finishes only, never a count */
  roomOpenings: Opening[];
  /** v0.16: the additional finishes / manual ceiling areas of each room (ti ids, in id order) */
  roomParts: Map<string, string[]>;
  /** v0.16: rooms, finishes, codes, Finishes Summary atoms, portion links, breakdowns (finishes.ts) */
  fin: FinModel;
  /** doors counted per door schedule row: on walls and in the door counter (private take-offs left out) */
  doorCount: Map<string, number>;
  /** per BOQ target ('b:<id>' or 'dm:<id>'): linked quantity */
  targets: Map<string, TargetQty>;
  /** per real BOQ line id: quantity from take-offs (dummies mapped to it included) */
  boqQty: Map<string, TargetQty>;
  /** v0.16: lines of the BOQ copy deleted in the estimate (an additional item's line the estimator removed) */
  boqGone: Set<string>;
}

/** v0.18 (Feedback 3, 14) an image put on a sheet (a sketch, a photo, a detail from another source): a picture over
 *  the PDF, which is never changed. Its file is in the project's `images` folder. Seen only by who put it there
 *  unless shared (`pub`). */
/**
 * v0.18.1 (Feedback 3, D: "the alignment is saved per source/target pair so it can be reused for every room on that
 * floor, and can be edited"; "colour tint, show/hide toggle and lock") - one entity per pair of sheets (`oa:` + a hash
 * of the pair): p "this|over" (page keys), m the matrix (JSON, over's page -> this page), lk locked, cr the part of
 * the overlaid sheet shown (JSON box on its page; none: all of it), tn its tint.
 */
export interface OverAlign { id: string; pair: string; m: [number, number, number, number, number, number]; lk: boolean; cr: Box | null; tn: string }
/** the entity of a pair of sheets put one over the other */
export function overAlignId(pair: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < pair.length; i++) { h ^= pair.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let h2 = 0x9747b28c;
  for (let i = pair.length - 1; i >= 0; i--) { h2 ^= pair.charCodeAt(i); h2 = Math.imul(h2, 0x01000193) >>> 0; }
  return 'oa:' + h.toString(36) + h2.toString(36);
}

/** an image's file: the name the app gives it (im<time><random>.<ext>) in <project>\images - a name from
 *  project data that is anything else (a path, '..') is not read */
export const IMAGE_FILE_RE = /^[A-Za-z0-9_-]{1,64}\.(png|jpe?g|webp|gif|bmp)$/i;
export interface SheetImage {
  id: string;
  dwg: string;
  pg: number;
  /** where it lies on the page (page units) */
  box: Box;
  file: string;
  name: string;
  by: string;
  pub: boolean;
}
export interface Viewer {
  username: string;
  /** admins see private take-offs of everybody */
  seeAll: boolean;
}

export const pageKey = (dwg: string, pg: number) => dwg + '.' + pg;

/**
 * v0.16: the page of the FILE that page `pg` of a sheet (or of an earlier revision) is. A page of a bound
 * set (fp) has its one page at fp; a shape left on a page past it (a new revision with fewer pages) is
 * that many pages further on. A sheet that is the whole file: the same page.
 */
export const filePage = (d: { fp?: number } | null | undefined, pg: number) => (d?.fp ?? 0) + pg;
/** one page of a bound set, shown as a sheet of its own (v0.16) */
export const isPageSheet = (d: { fp?: number } | null | undefined) => d?.fp !== undefined;
/** a multi-page drawing brought in before 0.16: shown as one sheet with its pages, until it is split */
export const isOldBinder = (d: Pick<Drawing, 'pages'> & { fp?: number }) => d.fp === undefined && d.pages > 1;
/** the sheet's name as the list shows it */
export const sheetTitle = (d: Pick<Drawing, 'title' | 'name'> & { fp?: number }) => d.title || (d.fp !== undefined ? d.name.replace(/\.pdf$/i, '') + ' p.' + (d.fp + 1) : d.name);

const num = (v: Value | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
/** a size or factor: zero or below is not one (×0 would quietly wipe a quantity) */
const pos = (v: Value | undefined): number | null => { const n = num(v); return n !== null && n > 0 ? n : null; };
const str = (v: Value | undefined) => (v === null || v === undefined ? '' : String(v));
export function parseJson<T>(v: Value | undefined, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

const KINDS: Kind[] = ['area', 'line', 'count', 'wall', 'beam', 'room'];
const MEASURES: Measure[] = ['area', 'len', 'perim', 'vol', 'cnt', 'form', 'kg', 'lvol', 'llen', 'lcnt', 'wph', 'wpv', 'blv', 'pea'];
export const ITEM_COLORS = ['#e8590c', '#1c7ed6', '#2b8a3e', '#c2255c', '#7048e8', '#0c8599', '#e67700', '#5c940d', '#d6336c', '#364fc7', '#a61e4d', '#087f5b'];

/** The scale (metres per sheet point) that applies at a point of a page. */
/** viewports by page (smallest first, as in m.regions): looked up per shape, so not a scan of all */
const regionsByPage = new WeakMap<Region[], Map<string, Region[]>>();
function regionsOn(regions: Region[], dwg: string, pg: number): Region[] {
  let idx = regionsByPage.get(regions);
  if (!idx) {
    idx = new Map();
    for (const r of regions) {
      const k = pageKey(r.dwg, r.pg);
      const l = idx.get(k);
      if (l) l.push(r); else idx.set(k, [r]);
    }
    regionsByPage.set(regions, idx);
  }
  return idx.get(pageKey(dwg, pg)) ?? [];
}

export interface ScaleHere {
  /** metres per sheet point across (X) - and both ways unless scy differs; null = no scale here */
  sc: number | null;
  label: string;
  /** up and down (Y): the same as sc unless the sheet / viewport has a scale of its own for it */
  scy: number | null;
  labelY: string;
  /** how much a sheet point counts up-down compared with across (1 = the same) */
  ry: number;
  region: Region | null;
}

export function scaleAt(m: Pick<QtoModel, 'pages' | 'regions'>, dwg: string, pg: number, p: Pt | undefined): ScaleHere {
  const of = (sc: number | null, label: string, scy: number | null, labelY: string, region: Region | null): ScaleHere => {
    const ry = yRatio(sc, scy);
    return { sc, label, scy: sc ? (ry === 1 ? sc : scy) : null, labelY: ry === 1 ? label : labelY, ry, region };
  };
  if (p && m.regions.length) {
    for (const r of regionsOn(m.regions, dwg, pg)) {
      if (p[0] >= r.r.x0 && p[0] <= r.r.x1 && p[1] >= r.r.y0 && p[1] <= r.r.y1) return of(r.sc, r.scl, r.scy ?? null, r.scyl ?? '', r);
    }
  }
  const pi = m.pages.get(pageKey(dwg, pg));
  return of(pi?.sc ?? null, pi?.scl ?? '', pi?.scy ?? null, pi?.scyl ?? '', null);
}

/** Raw quantities of one shape, in metres, before item settings. ry: a separate up-down scale (see yRatio). */
export function shapeQty(s: Shape, sc: number | null, dmin: number | null, ry = 1): ShapeQty {
  const q: ShapeQty = { cnt: 0, len: 0, area: 0, perim: 0, holesDeducted: 0, holesKept: 0, scaled: sc !== null, badHoles: 0 };
  if (s.k === 'pt') {
    q.cnt = s.pts.length || 1;
    return q;
  }
  q.cnt = 1;
  if (sc === null) return q;
  if (s.k === 'line') {
    q.len = pathLengthY(s.pts, s.b, false, ry) * sc;
    return q;
  }
  // (Y stretched by ry: an area is the plain area times ry - the stretch is affine)
  const a2 = sc * sc * ry;
  q.area = pathArea(s.pts, s.b) * a2;
  q.perim = pathLengthY(s.pts, s.b, true, ry) * sc;
  // a cut-out counts only inside its area and not over another one (corners dragged later can put
  // it anywhere): otherwise it is left out - and reported - rather than deducted wrongly
  const good: Pt[][] = [];
  for (const h of s.holes) {
    if (!polyInside(h, s.flat) || good.some((g) => polysOverlap(h, g))) { q.badHoles++; continue; }
    good.push(h);
    const ha = polyArea(h) * a2;
    if (dmin !== null && ha <= dmin + 1e-9) { q.holesKept += ha; continue; }
    q.holesDeducted += ha;
    q.area -= ha;
    q.perim += polyLengthY(h, true, ry) * sc;
  }
  q.area = Math.max(0, q.area);
  q.len = q.perim;
  return q;
}

/**
 * A shape's quantities where it lies: a length segment by segment, each at the scale where it is
 * (so splitting it, or removing its first corner, never changes the total); an area at the scale
 * of its middle. `mixed` when parts lie at different scales (it crosses a viewport's edge).
 */
export function shapeQtyAt(m: Pick<QtoModel, 'pages' | 'regions'>, s: Shape, dmin: number | null): ShapeQty {
  if (s.k === 'pt') return shapeQty(s, null, dmin);
  const here = (p: Pt) => scaleAt(m, s.dwg, s.pg, p);
  const regionsHere = m.regions.length > 0 && regionsOn(m.regions, s.dwg, s.pg).length > 0;
  if (s.k === 'line') {
    if (!regionsHere) { const h = here(s.pts[0]); return shapeQty(s, h.sc, dmin, h.ry); }
    const q = shapeQty(s, null, dmin);
    const sl = segLensAt(m, s);
    // a part without a scale: the whole length waits for it (as on a sheet without a scale)
    if (!sl.scaled) return { ...q, mixed: sl.mixed };
    let len = 0;
    for (const l of sl.lens) len += l!;
    return { ...q, len, scaled: true, mixed: sl.mixed };
  }
  const h = here(centroid(s.flat));
  const q = shapeQty(s, h.sc, dmin, h.ry);
  if (regionsHere) q.mixed = s.flat.some((p) => { const o = here(p); return o.sc !== h.sc || o.ry !== h.ry; });
  return q;
}

/**
 * The real length of each segment of a shape's outline (a length: its segments; an area: its edges,
 * the closing one last), each piece at the scale where it lies - cut where it crosses a viewport's
 * edge (exact for straight sides; an arc in short chords), so splitting a line anywhere gives the
 * same total. `scaled` false when any part has no scale (its length is then null).
 */
export function segLensAt(m: Pick<QtoModel, 'pages' | 'regions'>, s: Pick<Shape, 'dwg' | 'pg' | 'k' | 'pts' | 'b'>): { lens: (number | null)[]; scaled: boolean; mixed: boolean } {
  const n = s.k === 'pt' ? 0 : s.k === 'poly' ? s.pts.length : Math.max(0, s.pts.length - 1);
  const here = (p: Pt) => scaleAt(m, s.dwg, s.pg, p);
  const rects = m.regions.length ? regionsOn(m.regions, s.dwg, s.pg).map((r) => r.r) : [];
  // no viewport on the sheet: one scale for every segment (the common case - looked up once, not per
  // segment: 10,000 beams took 140 ms more than lengths before)
  if (!rects.length) {
    const h = here(s.pts[0] ?? [0, 0]);
    const out: (number | null)[] = [];
    for (let i = 0; i < n; i++) out.push(h.sc === null ? null : segLengthY(s.pts[i], s.pts[(i + 1) % s.pts.length], s.b[i] || 0, h.ry) * h.sc);
    return { lens: out, scaled: h.sc !== null, mixed: false };
  }
  const lens: (number | null)[] = [];
  const seen = new Set<string>();
  const key = (h: ScaleHere) => (h.sc === null ? 'none' : h.sc + '/' + h.ry);
  for (let i = 0; i < n; i++) {
    const b = s.b[i] || 0;
    const a = s.pts[i], c = s.pts[(i + 1) % s.pts.length];
    if (!rects.length) {
      const h = here(a);
      seen.add(key(h));
      lens.push(h.sc === null ? null : segLengthY(a, c, b, h.ry) * h.sc);
      continue;
    }
    // (from a: arcPoints leaves the start out - the first chord of an arc was missed before 0.12.5)
    const path = b ? arcPoints(a, c, b) : [c];
    const pieces: { dx: number; dy: number; f: number; h: ScaleHere }[] = [];
    let prev = a;
    for (let k = 0; k < path.length; k++) {
      const p0 = prev, p1 = path[k];
      prev = p1;
      const ts = [0, 1];
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      for (const r of rects) {
        if (dx) for (const x of [r.x0, r.x1]) { const t = (x - p0[0]) / dx; if (t > 0 && t < 1) ts.push(t); }
        if (dy) for (const y of [r.y0, r.y1]) { const t = (y - p0[1]) / dy; if (t > 0 && t < 1) ts.push(t); }
      }
      ts.sort((u, v) => u - v);
      for (let j = 0; j + 1 < ts.length; j++) {
        const tm = (ts[j] + ts[j + 1]) / 2;
        if (ts[j + 1] - ts[j] <= 0) continue;
        pieces.push({ dx, dy, f: ts[j + 1] - ts[j], h: here([p0[0] + dx * tm, p0[1] + dy * tm]) });
      }
    }
    const scs = new Set(pieces.map((x) => key(x.h)));
    scs.forEach((x) => seen.add(x));
    if (scs.has('none') || !pieces.length) { lens.push(null); continue; }
    // all of it at one scale: the exact length (arcs included)
    if (scs.size === 1) lens.push(segLengthY(a, c, b, pieces[0].h.ry) * pieces[0].h.sc!);
    else { let l = 0; for (const x of pieces) l += Math.hypot(x.dx, x.dy * x.h.ry) * x.f * x.h.sc!; lens.push(l); }
  }
  return { lens, scaled: !seen.has('none'), mixed: seen.size > 1 };
}

/**
 * The openings deducted from a take-off: the list ('ded'), and one field per opening added or
 * taken off since ('dd:<id>' true / false) - so two people adding openings at the same time both
 * keep theirs (one list would keep only the last one written).
 */
function dedOf(ent: Map<string, { v: Value }>): string[] {
  const out = parseJson<string[]>(ent.get('ded')?.v, []).filter((x) => typeof x === 'string');
  const add: string[] = [];
  const off = new Set<string>();
  for (const [f, c] of ent) {
    if (!f.startsWith('dd:')) continue;
    if (c.v === true) add.push(f.slice(3));
    else if (c.v === false) off.add(f.slice(3));
  }
  add.sort();
  return [...new Set([...out, ...add])].filter((x) => !off.has(x));
}

/**
 * A shape's parsed geometry, kept per store between model builds and used again while the shape's entity
 * has not changed (`store.rev`): a big take-off is rebuilt on every change, and parsing every outline again
 * was most of the time (BH-028: 10,000 shapes ~140 ms a build). The arrays are shared between builds - never
 * changed in place (every edit makes new ones through ops).
 */
interface ParsedGeo { rev: number; k: 'poly' | 'line' | 'pt'; pts: Pt[]; b: number[]; flat: Pt[]; holes: Pt[][]; box: Box; sg: (string | null)[] }
const geoCache = new WeakMap<Store, Map<string, ParsedGeo>>();

export function buildQtoModel(store: Store, viewer: Viewer | null): QtoModel {
  const m: QtoModel = {
    name: str(store.get('project', 'name')),
    est: (store.get('project', 'est') as string) || null,
    estName: str(store.get('project', 'estName')),
    drawings: [], dwgById: new Map(), revisions: new Map(), stale: new Set(), staleByDwg: new Map(), offPage: new Map(), offPageShapes: new Map(), removedDwg: new Set(), pages: new Map(), regions: [], items: [], itemById: new Map(), headings: [], headingById: new Map(), tree: new Map(),
    itemTree: null as unknown as TreeView, dwgTree: null as unknown as TreeView,
    shapes: [], shapesByPage: new Map(), shapesByItem: new Map(), links: [], linksByItem: new Map(),
    dummies: [], dummyById: new Map(), boqRoots: [], boqById: new Map(), boqImports: new Map(), notes: [], qty: new Map(), targets: new Map(), boqQty: new Map(), boqGone: new Set(),
    beamTypes: [], beamTypeById: new Map(), images: [], overAligns: new Map(), colTypes: [], colTypeById: new Map(), wallTypes: [], wallTypeById: new Map(), swTypes: [], swTypeById: new Map(), rwTypes: [], rwTypeById: new Map(), stairTypes: [], stairTypeById: new Map(), ftgTypes: [], ftgTypeById: new Map(), doors: [], doorById: new Map(), doorsGone: new Map(), openings: [], openingsByShape: new Map(), doorCount: new Map(),
    roomOpenings: [], roomParts: new Map(), fin: null as unknown as FinModel,
  };
  const finRaw: [string, Map<string, Cell>][] = [];
  const hiddenItems = new Set<string>();
  const shapeRaw: [string, Map<string, { v: Value }>][] = [];
  const opRaw: [string, Map<string, { v: Value }>][] = [];
  const linkRaw: [string, Map<string, { v: Value; a?: string }>][] = [];
  const headRaw: { id: string; name: string; par: string; ord: string }[] = [];
  const dheadRaw: { id: string; name: string; par: string; ord: string }[] = [];
  const itemPar = new Map<string, string>();
  const dwgPlace = new Map<string, { par: string; ord: string }>();
  const mirror: MirrorRow[] = [];
  const goneDwg = m.removedDwg;

  // Parts of a split / join (they say which shapes they were made from, 'of'): they count only
  // while their originals stay deleted by whoever made the parts. If someone else deleted the original
  // at the same time (or it was brought back), the parts give way: the delete is not undone by
  // the split, and a join whose other half was deleted gives back the half that wasn't.
  const delCell = (id: string) => store.ents.get(id)?.get('del');
  const partOk = new Map<string, boolean>();
  const lineageOk = (id: string, depth = 0): boolean => {
    const known = partOk.get(id);
    if (known !== undefined) return known;
    const ofc = store.ents.get(id)?.get('of');
    let ok = true;
    if (ofc && depth < 50) {
      const origs = parseJson<string[]>(ofc.v, []);
      // deleted by the same writer that made the parts (the split itself, or its redo)
      ok = origs.every((o) => { const c = delCell(o); return !!c && c.v === true && c.w === ofc.w && lineageOk(o, depth + 1); });
    }
    partOk.set(id, ok);
    return ok;
  };
  const revived = new Set<string>();
  for (const [id, ent] of store.ents) {
    if (!id.startsWith('sh:') || !ent.has('of') || ent.get('del')?.v === true || lineageOk(id)) continue;
    const ofc = ent.get('of')!;
    for (const o of parseJson<string[]>(ofc.v, [])) { const c = delCell(o); if (c && c.v === true && c.w === ofc.w && lineageOk(o)) revived.add(o); }
  }

  for (const [id, ent] of store.ents) {
    const g = (f: string) => ent.get(f)?.v;
    const colon = id.indexOf(':');
    const pre = colon > 0 ? id.slice(0, colon) : id;
    if (pre === 'pg') {
      const key = id.slice(3);
      const dot = key.lastIndexOf('.');
      const sy = pos(g('scy')), sy0 = pos(g('scy0'));
      m.pages.set(key, { key, dwg: key.slice(0, dot), pg: Number(key.slice(dot + 1)), sc: pos(g('sc')), scl: str(g('scl')), scy: sy ?? sy0, scyl: str(g(sy !== null || sy0 === null ? 'scyl' : 'scyl0')), scyOwn: sy !== null, w: num(g('w')), h: num(g('h')) });
      continue;
    }
    if (pre === 'sh' && ((g('del') === true && !revived.has(id)) || !lineageOk(id))) continue;
    if (g('del') === true && !(pre === 'sh' && revived.has(id))) {
      if (pre === 'ti') hiddenItems.add(id);
      if (pre === 'dwg') goneDwg.add(id);
      if (pre === 'b') m.boqGone.add(id.slice(2));
      // (two deleted rows with one tag: the same one on every PC, whatever order they arrived in)
      if (pre === 'ds' && g('tag')) { const k = doorTagKey(str(g('tag'))), was = m.doorsGone.get(k); if (!was || id < was) m.doorsGone.set(k, id); }
      continue;
    }
    switch (pre) {
      case 'dwg': {
        if (!g('path') && !g('name')) break;
        const d: Drawing = {
          id, name: str(g('name')), path: str(g('path')), unc: str(g('unc')), hash: str(g('hash')), size: num(g('size')) ?? 0,
          mtime: num(g('mtime')) ?? 0, pages: num(g('pages')) ?? 0, grp: str(g('grp')), sheet: str(g('sheet')), title: str(g('title')),
          added: num(g('added')) ?? 0, addedBy: str(g('addedBy')), disc: str(g('disc')), rev: str(g('rev')), issue: str(g('issue')),
          dpar: '', dord: str(g('dord')),
        };
        const fp = num(g('fp'));
        if (fp !== null && fp >= 0) { d.fp = Math.floor(fp); d.fpn = num(g('fpn')) ?? undefined; d.pages = 1; }
        dwgPlace.set(id, { par: str(g('dpar')), ord: str(g('dord')) });
        m.drawings.push(d);
        m.dwgById.set(id, d);
        break;
      }
      case 'rv': {
        const dwg = str(g('dwg'));
        if (!dwg || !g('path')) break;
        const r: Revision = {
          id, dwg, name: str(g('name')), path: str(g('path')), unc: str(g('unc')), hash: str(g('hash')), size: num(g('size')) ?? 0, mtime: num(g('mtime')) ?? 0,
          pages: num(g('pages')) ?? 0, rev: str(g('rev')), issue: str(g('issue')), added: num(g('added')) ?? 0, addedBy: str(g('addedBy')), superseded: num(g('superseded')) ?? 0,
        };
        const fp = num(g('fp'));
        if (fp !== null && fp >= 0) { r.fp = Math.floor(fp); r.fpn = num(g('fpn')) ?? undefined; }
        (m.revisions.get(dwg) ?? m.revisions.set(dwg, []).get(dwg)!).push(r);
        break;
      }
      case 'sr': {
        const r = parseJson<number[]>(g('r'), []);
        const sc = pos(g('sc'));
        if (r.length === 4 && sc) m.regions.push({ id, dwg: str(g('dwg')), pg: num(g('pg')) ?? 0, r: { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) }, sc, scl: str(g('scl')), scy: pos(g('scy')), scyl: str(g('scyl')) });
        break;
      }
      case 'ti': {
        if (!g('kind')) break;
        const kind = KINDS.includes(g('kind') as Kind) ? (g('kind') as Kind) : 'area';
        const it: TItem = {
          id, name: str(g('name')) || 'Untitled', kind, color: str(g('color')) || ITEM_COLORS[0], grp: str(g('grp')), owner: str(g('owner')),
          priv: g('priv') === true, h: pos(g('h')), d: pos(g('d')), x: pos(g('x')) ?? 1, waste: Math.max(0, num(g('waste')) ?? 0),
          dmin: num(g('dmin')), ded: dedOf(ent), ow: pos(g('ow')), oh: pos(g('oh')), note: str(g('note')), ord: str(g('ord')), par: '',
          lb: num(g('lb')) !== null && num(g('lb'))! >= 0 ? num(g('lb')) : null, ld: pos(g('ld')), lw: pos(g('lw')), bt: str(g('bt')), st: num(g('st')) !== null && num(g('st'))! >= 0 ? num(g('st')) : null,
          sw: pos(g('sw')), fill: (['solid', 'hatch', 'none'] as const).find((v) => v === g('fill')) ?? '', lab: (['hover', 'always', 'never'] as const).find((v) => v === g('lab')) ?? '',
          fcode: str(g('fcode')).trim(), rm: str(g('rm')), rk: (['add', 'ceil', 'link'] as const).find((v) => v === g('rk')) ?? '', dc: g('dc') === true && g('kind') === 'count',
          // (v0.17 a structural element: only on its base kind)
          sk: kind === 'area' && (g('sk') === 'slab' || g('sk') === 'drop' || g('sk') === 'raft' || g('sk') === 'stair' || g('sk') === 'sog') ? (g('sk') as StructKind) : kind === 'count' && (g('sk') === 'col' || g('sk') === 'sw' || g('sk') === 'ftg') && g('dc') !== true ? (g('sk') as StructKind) : kind === 'wall' && (g('sk') === 'shear' || g('sk') === 'rw') ? (g('sk') as StructKind) : '',
          // (v0.18.1 substructure: waterproofing bottom / sides (its height, a wall's faces), blinding, polythene)
          wb: g('wb') === true, wsd: g('wsd') === true, wvh: pos(g('wvh')), wfc: g('wfc') === 2 ? 2 : 1, bln: g('bln') === true, blt: pos(g('blt')), blx: num(g('blx')) !== null && num(g('blx'))! >= 0 ? num(g('blx')) : null, pe: g('pe') === true,
          // (v0.18 a slab with A254 mesh; a stair's tread and riser)
          mesh: kind === 'area' && (g('sk') === 'slab' || g('sk') === 'sog') && g('mesh') === true, fdx: kind === 'area' && g('sk') === 'slab' && g('fdx') === true, tr: pos(g('tr')), ri: pos(g('ri')), cst: pos(g('cst')),
          sr: num(g('sr')) !== null && num(g('sr'))! >= 0 ? num(g('sr')) : null, up: kind === 'beam' && g('up') === true,
        };
        if (!it.rm) it.rk = '';
        itemPar.set(id, str(g('par')));
        // (a room's own finishes are as private as their room - below - never on their own)
        if (it.priv && viewer && !viewer.seeAll && it.owner !== viewer.username && it.rk !== 'add' && it.rk !== 'ceil') { hiddenItems.add(id); break; }
        m.items.push(it);
        m.itemById.set(id, it);
        break;
      }
      case 'hd': case 'dh': {
        if (!g('name')) break;
        (pre === 'hd' ? headRaw : dheadRaw).push({ id, name: str(g('name')), par: str(g('par')), ord: str(g('ord')) });
        break;
      }
      case 'sh': shapeRaw.push([id, ent]); break;
      case 'op': opRaw.push([id, ent]); break;
      case 'bt': case 'ct': case 'wt': case 'st': case 'ft': case 'rt': case 'sy': {
        if (!g('name')) break;
        const t: BeamType = { id, name: str(g('name')), w: pos(g('w')), d: pos(g('d')), r: num(g('r')) !== null && num(g('r'))! >= 0 ? num(g('r')) : null, color: str(g('color')) || '#364fc7' };
        // (v0.17 column types - round ones: w the diameter - and shear wall types: w the thickness)
        if (pre === 'ct') { if (g('round') === true) t.round = true; m.colTypes.push(t); m.colTypeById.set(id, t); }
        else if (pre === 'wt') { m.wallTypes.push(t); m.wallTypeById.set(id, t); }
        else if (pre === 'st') { m.swTypes.push(t); m.swTypeById.set(id, t); }
        else if (pre === 'rt') { m.rwTypes.push(t); m.rwTypeById.set(id, t); }
        else if (pre === 'sy') { t.t = pos(g('t')); t.tr = pos(g('tr')); t.ri = pos(g('ri')); m.stairTypes.push(t); m.stairTypeById.set(id, t); }
        else if (pre === 'ft') { t.t = pos(g('t')); if (g('round') === true) t.round = true; m.ftgTypes.push(t); m.ftgTypeById.set(id, t); }
        else { m.beamTypes.push(t); m.beamTypeById.set(id, t); }
        break;
      }
      case 'ds': {
        if (!g('tag')) break;
        const d: DoorRow = { id, tag: str(g('tag')), desc: str(g('desc')), loc: str(g('loc')), sw: pos(g('sw')), sh: pos(g('sh')), cw: pos(g('cw')), ch: pos(g('ch')), ord: str(g('ord')), app: g('src') === 'a' };
        m.doors.push(d);
        m.doorById.set(id, d);
        break;
      }
      case 'lk': linkRaw.push([id, ent]); break;
      case 'fl': case 'fb': finRaw.push([id, ent as Map<string, Cell>]); break;
      case 'oa': {
        // v0.18.1 another sheet put in place over a sheet (the team's)
        const pair = str(g('p'));
        let mm: unknown = null, cr: unknown = null;
        try { mm = JSON.parse(str(g('m')) || 'null'); cr = JSON.parse(str(g('cr')) || 'null'); } catch { /* bad */ }
        const ok6 = Array.isArray(mm) && mm.length === 6 && mm.every((v) => typeof v === 'number' && Number.isFinite(v));
        if (!pair || !ok6 || g('del') === true) break;
        const c = cr as Box | null;
        const crOk = !!c && [c.x0, c.y0, c.x1, c.y1].every((v) => typeof v === 'number' && Number.isFinite(v)) && c.x1 > c.x0 && c.y1 > c.y0;
        m.overAligns.set(pair, { id, pair, m: mm as OverAlign['m'], lk: g('lk') === true, cr: crOk ? c : null, tn: str(g('tn')) });
        break;
      }
      case 'im': {
        // v0.18 an image on a sheet: its owner's only, unless shared
        const file = str(g('file')), dwg = str(g('dwg'));
        const x0 = num(g('x0')), y0 = num(g('y0')), x1 = num(g('x1')), y1 = num(g('y1'));
        if (!file || !dwg || x0 === null || y0 === null || x1 === null || y1 === null || !(x1 > x0) || !(y1 > y0)) break;
        // (v0.18.3 the file is one the app named in the project's images folder - never a path: BUG-005)
        if (!IMAGE_FILE_RE.test(file)) break;
        const im: SheetImage = { id, dwg, pg: Math.max(0, Math.floor(num(g('pg')) ?? 0)), box: { x0, y0, x1, y1 }, file, name: str(g('name')) || 'Image', by: str(g('by')), pub: g('pub') === true };
        if (viewer && im.by !== viewer.username && !im.pub) break;
        m.images.push(im);
        break;
      }
      case 'dm': {
        if (!g('desc') && !g('ref')) break;
        const d: Dummy = { id, ref: str(g('ref')), desc: str(g('desc')), unit: str(g('unit')), grp: str(g('grp')), map: (g('map') as string) || null, ord: str(g('ord')),
          add: g('add') === true, bill: str(g('bill')), loc: str(g('loc')), by: str(g('by')), byName: str(g('byName')) || str(g('by')) || str(ent.get('desc')?.u ?? '') };
        m.dummies.push(d);
        m.dummyById.set(id, d);
        break;
      }
      case 'b': {
        const bt = g('bt');
        if (bt !== 'group' && bt !== 'item' && bt !== 'note') break;
        const qa = g('qa');
        mirror.push({ id: id.slice(2), bt, par: (g('par') as string) || null, ord: str(g('ord')), ref: str(g('ref')), desc: str(g('desc')), unit: str(g('unit')), qty: num(g('qty')), page: str(g('page')), depth: 0, children: [],
          qa: qa === 'a' || qa === 'n' || qa === 'g' ? qa : '', loc: str(g('loc')), qby: str(g('qby')), own: g('own') === true, src: str(g('src')), q0: g('q0') === undefined ? undefined : num(g('q0')) });
        break;
      }
      // v0.16.2 the estimate's import records (for the filled copy)
      case 'bi': {
        if (typeof g('files') === 'string') m.boqImports.set(id.slice(3), g('files') as string);
        break;
      }
      case 'nt': {
        if (!g('text')) break;
        m.notes.push({
          id, on: str(g('on')), text: str(g('text')), to: g('to') === 'me' ? 'me' : 'est', by: str(g('by')), byName: str(g('byName')), t: num(g('t')) ?? 0,
          done: g('done') === true, dwg: (g('dwg') as string) || null, pg: num(g('pg')), x: num(g('x')), y: num(g('y')),
        });
        break;
      }
    }
  }
  // v0.16: a room's additional finishes and manual ceiling areas exist only with their room (deleted or
  // hidden from this viewer: they go too - undoing the delete brings them back)
  let anyPart = false;
  for (const it of [...m.items]) {
    if (it.rk !== 'add' && it.rk !== 'ceil') continue;
    anyPart = true;
    const room = m.itemById.get(it.rm!);
    if (room && room.kind === 'room') { it.priv = room.priv; (m.roomParts.get(room.id) ?? m.roomParts.set(room.id, []).get(room.id)!).push(it.id); continue; }
    m.itemById.delete(it.id);
    hiddenItems.add(it.id);
  }
  if (anyPart) m.items = m.items.filter((it) => m.itemById.has(it.id));
  for (const l of m.roomParts.values()) l.sort();
  // v0.16: a drawing split into separate sheets (revisions.ts splitBinderOps) while someone - on a PC that had
  // not seen the split yet - measured, put a viewport or a note on one of its pages: that goes onto the page's
  // sheet, as everything else on it did (not out of sight - and out of the quantities - with the drawing)
  const splitCache = new Map<string, [string, number] | null>();
  const splitTo = (dwg: string, pg: number): [string, number] | null => {
    if (!goneDwg.has(dwg)) return null;
    const key = dwg + '.' + pg;
    if (splitCache.has(key)) return splitCache.get(key)!;
    let to: [string, number] | null = null;
    const direct = pageSheetId(dwg, pg);
    if (m.dwgById.has(direct)) to = [direct, 0];
    else if (!goneDwg.has(direct)) {
      // past the last page: off the page of the last sheet, as many pages on (as the split puts it)
      for (let k = pg - 1; k >= 0 && k > pg - 2000; k--) {
        const id = pageSheetId(dwg, k), d = m.dwgById.get(id);
        if (d) { if (d.fpn !== undefined && k === d.fpn - 1) to = [id, pg - k]; break; }
        if (goneDwg.has(id)) break;
      }
    }
    splitCache.set(key, to);
    return to;
  };
  for (const x of [...m.regions, ...m.notes]) {
    const to = x.dwg ? splitTo(x.dwg, x.pg ?? 0) : null;
    if (to) { x.dwg = to[0]; x.pg = to[1]; }
  }
  // private notes are only for their writer
  if (viewer) m.notes = m.notes.filter((n) => n.to !== 'me' || n.by === viewer.username);
  m.notes.sort((a, b) => b.t - a.t);

  const cmpOrd = (a: { ord: string; id: string }, b: { ord: string; id: string }) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : a.id < b.id ? -1 : 1);
  m.items.sort(cmpOrd);
  // ---- the take-off list
  m.itemTree = buildTree('items', headRaw, (anyPart ? m.items.filter((it) => it.rk !== 'add' && it.rk !== 'ceil') : m.items).map((it) => {
    const p = itemPar.get(it.id) ?? '';
    return { id: it.id, par: p, ord: it.ord, groups: it.grp.trim() ? [it.grp.trim()] : [], sortKey: it.name };
  }), 'hd:g');
  m.tree = m.itemTree.tree;
  m.headings = m.itemTree.headings;
  m.headingById = m.itemTree.headingById;
  for (const it of m.items) it.par = m.itemTree.leafPar.get(it.id) ?? '';
  {
    const order: TItem[] = [];
    // (a room's own finishes right after it: they are not in the tree, the room is)
    const walk = (par: string) => { for (const n of m.tree.get(par) ?? []) n.t === 'i' ? (order.push(m.itemById.get(n.id)!), m.roomParts.get(n.id)?.forEach((p) => order.push(m.itemById.get(p)!))) : walk(n.id); };
    walk('');
    m.items = order;
  }
  // ---- the drawing list: by default under headings made from the folders the sheets came from
  m.dwgTree = buildTree('drawings', dheadRaw, m.drawings.map((d) => {
    const pl = dwgPlace.get(d.id)!;
    // (a page of a bound set without a sheet number: by its title, "Set p.2" before "Set p.10" - all its
    //  pages have the file's name)
    return { id: d.id, par: pl.par, ord: pl.ord, groups: d.grp ? d.grp.split(' › ').map((x) => x.trim()).filter(Boolean) : [], sortKey: d.sheet || (d.fp !== undefined ? d.title : '') || d.name };
  }), 'dh:g');
  for (const d of m.drawings) d.dpar = m.dwgTree.leafPar.get(d.id) ?? '';
  m.dummies.sort(cmpOrd);
  m.drawings.sort((a, b) => (a.grp < b.grp ? -1 : a.grp > b.grp ? 1 : a.name.localeCompare(b.name, undefined, { numeric: true }) || (a.fp ?? 0) - (b.fp ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

  const prevGeo = geoCache.get(store);
  const nextGeo = new Map<string, ParsedGeo>();
  geoCache.set(store, nextGeo);
  const geoOf = (id: string, g: (f: string) => Value | undefined): ParsedGeo => {
    const rev = store.rev(id);
    const was = prevGeo?.get(id);
    if (was && was.rev === rev) { nextGeo.set(id, was); return was; }
    const k = g('k') === 'line' ? 'line' : g('k') === 'pt' ? 'pt' : 'poly';
    // (v0.16.2 a coordinate that is not a number - only a damaged journal has one: the shape counts nothing, not NaN;
    // never a point moved to 0,0 - that would be a wrong area that looks right)
    const rawP = parseJson<number[]>(g('p'), []);
    const pts = toPts(Array.isArray(rawP) && rawP.every((x) => typeof x === 'number' && Number.isFinite(x)) ? rawP : []);
    const b = k === 'pt' ? [] : parseJson<number[]>(g('b'), []).map((x) => (Number.isFinite(x) ? x : 0));
    const flat = pts.length ? flatten(pts, b, k === 'poly') : [];
    const geo: ParsedGeo = {
      rev, k, pts, b, flat, box: flat.length ? bbox(flat) : { x0: 0, y0: 0, x1: 0, y1: 0 },
      holes: parseJson<number[][]>(g('holes'), []).map(toPts).filter((h) => h.length >= 3),
      sg: k === 'pt' ? [] : parseJson<unknown[]>(g('sg'), []).map((t) => (typeof t === 'string' && t ? t : null)),
    };
    nextGeo.set(id, geo);
    return geo;
  };
  for (const [id, ent] of shapeRaw) {
    const g = (f: string) => ent.get(f)?.v;
    const ti = str(g('ti'));
    if (!m.itemById.has(ti)) continue;
    const geo = geoOf(id, g);
    const pts = geo.pts;
    if (!pts.length) continue;
    // a removed drawing takes its shapes with it (undoing the removal brings them back) - one split into
    // separate sheets puts them on their page's sheet (above)
    const moved = splitTo(str(g('dwg')), Math.max(0, Math.floor(num(g('pg')) ?? 0)));
    if (!moved && goneDwg.has(str(g('dwg')))) continue;
    const sdwg = moved ? moved[0] : str(g('dwg'));
    const dw = m.dwgById.get(sdwg);
    // a page the drawing no longer has (new revision with fewer pages): not counted, reported
    const spg = moved ? moved[1] : num(g('pg')) ?? 0;
    const s: Shape = {
      id, ti, dwg: sdwg, pg: spg, k: geo.k, pts, b: geo.b, flat: geo.flat, holes: geo.holes,
      m: pos(g('m')) ?? 1, box: geo.box, by: str(g('by')), rv: str(g('rv')), door: str(g('door')) || undefined, mt: str(g('mt')) || undefined,
      xw: pos(g('xw')) ?? undefined, xd: pos(g('xd')) ?? undefined, xt: pos(g('xt')) ?? undefined, xh: pos(g('xh')) ?? undefined,
      xr: num(g('xr')) !== null && num(g('xr'))! >= 0 ? num(g('xr'))! : undefined, xn: pos(g('xn')) ?? undefined, sp: g('sp') === 'l' ? 'l' : undefined,
      // (the page of an earlier revision it was measured on, counted from its sheet's page - as the split does)
      opg: num(g('opg')) === null ? undefined : num(g('opg'))! - (moved ? Math.max(0, Math.floor(num(g('pg')) ?? 0)) - moved[1] : 0),
      sg: geo.sg,
    };
    // v0.16 joint owners (owners.ts): co:<username> = true
    for (const [f, c] of ent) if (f.startsWith('co:') && c.v === true) (s.co ??= []).push(f.slice(3));
    if (s.co) s.co.sort();
    if (dw && dw.pages > 0 && spg >= dw.pages) {
      m.offPage.set(dw.id, (m.offPage.get(dw.id) ?? 0) + 1);
      (m.offPageShapes.get(dw.id) ?? m.offPageShapes.set(dw.id, []).get(dw.id)!).push(s);
      continue;
    }
    m.shapes.push(s);
    const pk = pageKey(s.dwg, s.pg);
    (m.shapesByPage.get(pk) ?? m.shapesByPage.set(pk, []).get(pk)!).push(s);
    (m.shapesByItem.get(ti) ?? m.shapesByItem.set(ti, []).get(ti)!).push(s);
  }
  // in id order: sums of floating-point numbers depend on their order, and every PC must get the
  // same quantity to the last digit whatever order the changes arrived in
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  m.shapes.sort(byId);
  for (const l of m.shapesByItem.values()) l.sort(byId);
  for (const l of m.shapesByPage.values()) l.sort(byId);
  for (const list of m.revisions.values()) list.sort((a, b) => b.superseded - a.superseded || b.added - a.added);
  // viewports that overlap: the smaller (a detail inside a plan) wins, then by id - the same on
  // every PC, whatever order their changes arrived in
  const areaOf = (r: Region) => (r.r.x1 - r.r.x0) * (r.r.y1 - r.r.y0);
  m.regions.sort((a, b) => areaOf(a) - areaOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const s of m.shapes) {
    const d = m.dwgById.get(s.dwg);
    if (d && d.hash && s.rv && s.rv !== d.hash) {
      m.stale.add(s.id);
      m.staleByDwg.set(d.id, (m.staleByDwg.get(d.id) ?? 0) + 1);
    }
  }
  for (const l of [m.beamTypes, m.colTypes, m.wallTypes, m.swTypes, m.ftgTypes, m.rwTypes, m.stairTypes]) l.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || (a.id < b.id ? -1 : 1));
  m.doors.sort((a, b) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : a.tag.localeCompare(b.tag, undefined, { numeric: true }) || (a.id < b.id ? -1 : 1)));
  // openings on walls: on the segment of their shape nearest to where they were put (corners moved,
  // added or taken away since: still on the right segment)
  const shapeById = new Map(m.shapes.map((x) => [x.id, x]));
  const doorByTag = new Map<string, string>();
  for (const d of m.doors) if (!doorByTag.has(doorTagKey(d.tag))) doorByTag.set(doorTagKey(d.tag), d.id);
  // shapes made from a shape (split / join / split into segments: 'of'): a door put on a wall while
  // someone else split it (the split moves only the doors it knows of) goes onto the part nearest to it,
  // instead of staying with the removed wall - uncounted, and not on the drawing either
  let madeFrom: Map<string, string[]> | null = null;
  const partsFor = (id: string, depth = 0): Shape[] => {
    const live = shapeById.get(id);
    if (live) return [live];
    if (depth > 20) return [];
    if (!madeFrom) {
      madeFrom = new Map();
      for (const [sid, ent] of store.ents) {
        if (!sid.startsWith('sh:') || !ent.has('of')) continue;
        for (const o of parseJson<string[]>(ent.get('of')!.v, [])) (madeFrom.get(o) ?? madeFrom.set(o, []).get(o)!).push(sid);
      }
    }
    return (madeFrom.get(id) ?? []).flatMap((p) => partsFor(p, depth + 1));
  };
  for (const [id, ent] of opRaw) {
    const g = (f: string) => ent.get(f)?.v;
    const x = num(g('x')), y = num(g('y'));
    if (x === null || y === null) continue;
    let sh = shapeById.get(str(g('sh')));
    // (only a shape that is gone: one taken out of the take-off, or deleted, takes its openings with it)
    if (!sh && store.get(str(g('sh')), 'del') === true) {
      const was = str(g('sh'));
      const wk = store.get(was, 'k') === 'poly' ? 'poly' : 'line';
      const d0 = nearestSeg({ k: wk, pts: toPts(parseJson<number[]>(store.get(was, 'p'), [])), b: parseJson<number[]>(store.get(was, 'b'), []) }, [x, y]).d;
      let best: { s: Shape; d: number } | null = null;
      for (const p of partsFor(was)) {
        if (p.k === 'pt') continue;
        const d = nearestSeg(p, [x, y]).d;
        if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && p.id < best.s.id)) best = { s: p, d };
      }
      // the part that has the piece of wall it was on (that part deleted since: gone with it)
      sh = best && best.d <= d0 + 1 ? best.s : undefined;
    }
    if (!sh || sh.k === 'pt') continue;
    const k = g('k') === 'open' ? 'open' : 'door';
    const tag = str(g('tag'));
    // its schedule row; failing that (row deleted, schedule re-imported under new ids, or another
    // PC's import racing this one) the row with its tag: the door follows the schedule by tag
    let door = k === 'door' && typeof g('door') === 'string' && m.doorById.has(g('door') as string) ? (g('door') as string) : null;
    if (k === 'door' && !door && tag) door = doorByTag.get(doorTagKey(tag)) ?? null;
    // a door whose schedule row was removed: kept as an opening of its last known size, if any - and flagged
    let w = pos(g('w')), h = pos(g('h'));
    // (placed while someone else deleted the row - the delete wrote the size only onto the doors it knew
    //  of: the deleted row's own last size, else it came off nothing and lost its lintel)
    const was = k === 'door' && !door && w === null && h === null && typeof g('door') === 'string' ? store.ents.get(g('door') as string) : undefined;
    if (was?.get('del')?.v === true) { w = pos(was.get('sw')?.v) ?? pos(was.get('cw')?.v); h = pos(was.get('sh')?.v) ?? pos(was.get('ch')?.v); }
    const o: Opening = { id, sh: sh.id, x, y, k, door, tag, w, h, lint: g('lint') !== false, uns: k === 'door' && !door, seg: 0, t: 0 };
    const at = nearestSeg(sh, [x, y]);
    o.seg = at.seg; o.t = at.t;
    // v0.16: in a room - its finishes only, never in the door schedule's counts or any total
    if (m.itemById.get(sh.ti)?.kind === 'room') {
      o.room = true;
      o.sill = k === 'door' ? 0 : Math.max(0, num(g('sill')) ?? 0);
      m.roomOpenings.push(o);
      (m.openingsByShape.get(sh.id) ?? m.openingsByShape.set(sh.id, []).get(sh.id)!).push(o);
      continue;
    }
    // v0.18 on a plain length: off that length only - kept with the rooms' (no door count, no total)
    if (m.itemById.get(sh.ti)?.kind === 'line') {
      o.ln = true; o.lint = false;
      o.sill = k === 'door' ? 0 : Math.max(0, num(g('sill')) ?? 0);
      m.roomOpenings.push(o);
      (m.openingsByShape.get(sh.id) ?? m.openingsByShape.set(sh.id, []).get(sh.id)!).push(o);
      continue;
    }
    m.openings.push(o);
    (m.openingsByShape.get(sh.id) ?? m.openingsByShape.set(sh.id, []).get(sh.id)!).push(o);
  }
  m.openings.sort(byId);
  m.roomOpenings.sort(byId);
  for (const l of m.openingsByShape.values()) l.sort(byId);
  // doors counted per schedule row: on walls that count (shared take-offs), × the shape's repeat
  for (const o of m.openings) {
    if (o.k !== 'door' || !o.door) continue;
    const sh = shapeById.get(o.sh)!;
    const it = m.itemById.get(sh.ti);
    if (!it || it.priv || it.kind !== 'wall') continue;
    m.doorCount.set(o.door, (m.doorCount.get(o.door) ?? 0) + sh.m);
  }
  // v0.16.1 and the doors counted with a door counter (not on a wall: cores, partitions), × the point's repeat
  for (const it of m.items) {
    if (!it.dc || it.priv) continue;
    for (const s of m.shapesByItem.get(it.id) ?? []) {
      if (s.k !== 'pt' || !s.door || !m.doorById.has(s.door)) continue;
      m.doorCount.set(s.door, (m.doorCount.get(s.door) ?? 0) + s.m);
    }
  }
  for (const [id, ent] of linkRaw) {
    const g = (f: string) => ent.get(f)?.v;
    const ti = str(g('ti'));
    const to = str(g('to'));
    if (!ti || !to || hiddenItems.has(ti)) continue;
    if (ti.startsWith('ds:') && !m.doorById.has(ti)) continue;
    const q = MEASURES.includes(g('q') as Measure) ? (g('q') as Measure) : 'area';
    const l: Link = { id, ti, to, q, f: num(g('f')) ?? 1, by: ent.get('to')?.a ?? '' };
    m.links.push(l);
    (m.linksByItem.get(ti) ?? m.linksByItem.set(ti, []).get(ti)!).push(l);
  }

  // ---- BOQ copy tree ----
  for (const r of mirror) m.boqById.set(r.id, r);
  for (const r of mirror) {
    const p = r.par ? m.boqById.get(r.par) : null;
    if (p) p.children.push(r);
    else m.boqRoots.push(r);
  }
  const seen = new Set<string>();
  const walk = (r: MirrorRow, depth: number) => {
    seen.add(r.id);
    r.depth = depth;
    r.children.sort(cmpOrd);
    for (const c of r.children) if (!seen.has(c.id)) walk(c, depth + 1);
  };
  m.boqRoots.sort(cmpOrd);
  for (const r of m.boqRoots) walk(r, 0);

  // ---- quantities ----
  for (const it of m.items) m.qty.set(it.id, itemQty(m, it));
  // the same quantity of a take-off linked twice to one BOQ line (directly, or through a temporary
  // line matched to it) counts once: the first link by id, so every PC picks the same one
  m.links.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const countedTo = new Set<string>();
  const countedReal = new Set<string>();
  for (const l of m.links) {
    const it = l.ti.startsWith('ds:') ? doorItem(m, l.ti) : m.itemById.get(l.ti);
    if (!it || it.priv) continue; // private take-offs are scratch work: never counted in the BOQ
    // v0.16: a room's quantities reach the BOQ only through the Finishes Summary (portion links, fl:)
    if (it.kind === 'room' || it.rk === 'add' || it.rk === 'ceil') continue;
    // (v0.16.1 a door counter's doors reach the BOQ through the door schedule only: a link of its own would count them twice)
    if (it.dc) continue;
    // (a temporary line not matched: counted on it (targets) - bridge.ts takes it to its own line in
    // the estimate, qx_<id>, v0.16)
    const real = l.to.startsWith('b:') ? l.to.slice(2) : m.dummyById.get(l.to)?.map ?? null;
    const kTo = l.ti + '>' + l.to + '>' + l.q, kReal = real ? l.ti + '>' + real + '>' + l.q : '';
    if (countedTo.has(kTo) || (kReal && countedReal.has(kReal))) { l.dup = true; continue; }
    countedTo.add(kTo);
    if (kReal) countedReal.add(kReal);
    // a BOQ line in feet / square feet / cubic feet gets the measured metres converted
    const unit = l.to.startsWith('b:') ? m.boqById.get(l.to.slice(2))?.unit ?? '' : m.dummyById.get(l.to)?.unit ?? '';
    const v = (l.ti.startsWith('ds:') ? (l.q === 'cnt' ? m.doorCount.get(l.ti) ?? 0 : 0) : measureOf(m.qty.get(it.id)!, l.q)) * l.f * unitFactor(unit, l.q);
    const t = m.targets.get(l.to) ?? m.targets.set(l.to, { total: 0, parts: [] }).get(l.to)!;
    t.total += v;
    t.parts.push({ link: l, item: it, v });
    if (real) {
      const b = m.boqQty.get(real) ?? m.boqQty.set(real, { total: 0, parts: [] }).get(real)!;
      b.total += v;
      b.parts.push({ link: l, item: it, v });
    }
  }
  // ---- v0.16 finishes: rooms, the Finishes Summary and its portion links (into targets / boqQty)
  m.fin = buildFinishes(m, store, finRaw);
  return m;
}

export function measureOf(q: ItemQty, ms: Measure): number {
  switch (ms) {
    case 'area': return q.area;
    case 'len': return q.len;
    case 'perim': return q.perim;
    case 'vol': return q.vol;
    case 'cnt': return q.cnt;
    case 'form': return q.form;
    case 'kg': return q.kg;
    case 'lvol': return q.lvol;
    case 'llen': return q.llen;
    case 'lcnt': return q.lcnt;
    case 'wph': return q.wph;
    case 'wpv': return q.wpv;
    case 'blv': return q.blv;
    case 'pea': return q.pea;
  }
  return 0;
}

/** Measures that make sense for an item, the main one first. */
export function measuresFor(it: TItem): Measure[] {
  // v0.17 structural elements: concrete, formwork, steel first
  if (it.sk === 'slab' || it.sk === 'drop') return ['vol', 'area', 'form', 'kg', 'perim', 'cnt'];
  // (v0.18.1 substructure: its waterproofing, blinding, polythene when it has them)
  const sub: Measure[] = isSubStruct(it.sk) ? [...(it.wb ? ['wph'] as Measure[] : []), ...(it.wsd ? ['wpv'] as Measure[] : []), ...(it.bln ? ['blv'] as Measure[] : []), ...(it.pe ? ['pea'] as Measure[] : [])] : [];
  if (it.sk === 'rw') return ['vol', 'area', 'form', 'kg', ...sub, 'len', 'cnt'];
  if (it.sk === 'raft' || it.sk === 'sog') return ['vol', 'area', 'form', 'kg', ...sub, 'perim', 'cnt'];
  if (it.sk === 'ftg') return ['cnt', 'vol', 'form', 'kg', ...sub];
  if (it.sk === 'col' || it.sk === 'sw') return ['cnt', 'vol', 'form', 'kg', 'len'];
  if (it.sk === 'stair') return ['vol', 'form', 'kg', 'area', 'cnt'];
  if (it.sk === 'shear') return ['vol', 'area', 'form', 'kg', 'len', 'cnt'];
  if (it.kind === 'count') return it.dc ? ['cnt'] : it.ow && it.oh ? ['cnt', 'area', 'len'] : it.ow ? ['cnt', 'len'] : ['cnt'];
  if (it.kind === 'line') return it.h ? (it.d ? ['area', 'len', 'vol', 'cnt'] : ['area', 'len', 'cnt']) : ['len', 'cnt'];
  if (it.kind === 'wall') return [...(it.h ? ['area'] as Measure[] : []), 'len', ...(it.h && it.d ? ['vol'] as Measure[] : []), 'lvol', 'llen', 'lcnt', 'cnt'];
  if (it.kind === 'beam') return ['vol', 'len', 'form', 'kg', 'cnt'];
  if (it.kind === 'room') return ['area', 'perim', 'cnt'];
  return it.d ? ['area', 'vol', 'perim', 'cnt'] : ['area', 'perim', 'cnt'];
}
export const mainMeasure = (it: TItem): Measure => measuresFor(it)[0];

export const emptyQty = (): ItemQty => ({ shapes: 0, unscaled: 0, cnt: 0, len: 0, area: 0, gross: 0, perim: 0, vol: 0, dedArea: 0, dedLen: 0, keptOpenings: 0, mixed: 0, badHoles: 0, form: 0, kg: 0, untyped: 0, lvol: 0, llen: 0, lcnt: 0, doors: 0, opens: 0, steps: 0, soffitOff: 0, wph: 0, wpv: 0, blv: 0, pea: 0, byTag: new Map() });

/** size of an opening: a door from the schedule its structural opening (else its clear one); others their own */
export function openingSize(m: Pick<QtoModel, 'doorById'>, o: Opening): { w: number | null; h: number | null } {
  if (o.k === 'door' && o.door) {
    const d = m.doorById.get(o.door);
    if (d) return { w: d.sw ?? d.cw, h: d.sh ?? d.ch };
  }
  return { w: o.w, h: o.h };
}

/** a beam segment's size: its type (tag) or the take-off's default type */
export function beamTypeOf(m: Pick<QtoModel, 'beamTypeById'>, it: TItem, tag: string | null | undefined): BeamType | null {
  // a type this PC doesn't know (removed, or not arrived from another PC yet): the take-off's default type
  // (v0.18.1 a segment's own figures after '#' are not part of its type)
  const t = tagBase(tag);
  return (t && t.startsWith('bt:') && m.beamTypeById.get(t)) || (it.bt && m.beamTypeById.get(it.bt)) || null;
}

/**
 * A door tag as compared everywhere (schedule, import, placed doors): no case, no spaces or - _ . /
 * ("D-11" = "D11") - except between two numbers, where a separator is what tells a type from its
 * variant: D1.1 and D11 are two doors, as are D1.12 and D11.2 (with all separators dropped, an import
 * kept one of each pair and left the other out as "twice in the file", and the picker placed D1.1's size
 * for D11). Between numbers any of them counts the same ("D1-1" = "D1.1").
 */
export const doorTagKey = (t: string) => t.toLowerCase().trim()
  .replace(/(\d)[\s\-_./]+(?=\d)/g, '$1.')
  .replace(/[\s\-_/]+/g, '')
  .replace(/(?<!\d)\.|\.(?!\d)/g, '');

type QtyModel = Pick<QtoModel, 'shapesByItem' | 'itemById' | 'pages' | 'regions'> & Partial<Pick<QtoModel, 'openingsByShape' | 'doorById' | 'beamTypeById' | 'colTypeById' | 'wallTypeById' | 'swTypeById' | 'ftgTypeById' | 'rwTypeById' | 'stairTypeById' | 'shapesByPage'>> & { qtyCache?: Map<string, ItemQty> };
/** v0.17 a column's type (its own, else the take-off's default) and a shear wall segment's (its tag, else the default) */
export function colTypeOf(m: Partial<Pick<QtoModel, 'colTypeById' | 'swTypeById' | 'ftgTypeById'>>, it: TItem, mt: string | null | undefined): MemberType | null {
  // (v0.18 shear walls and footings are counted the same way, each from its own schedule)
  const by = it.sk === 'sw' ? m.swTypeById : it.sk === 'ftg' ? m.ftgTypeById : m.colTypeById;
  return (mt && by?.get(mt)) || (it.bt && by?.get(it.bt)) || null;
}
/** v0.18 the types a counted element picks from */
export const typesFor = (m: Pick<QtoModel, 'colTypes' | 'swTypes' | 'ftgTypes'>, sk: StructKind | undefined): MemberType[] => (sk === 'sw' ? m.swTypes : sk === 'ftg' ? m.ftgTypes : sk === 'col' ? m.colTypes : []);
/** v0.18 a stair flight's number of steps: typed on it, else its plan area ÷ (flight width × tread) */
export function flightSteps(it: Pick<TItem, 'ow' | 'tr'>, s: Pick<Shape, 'xn'>, area: number): number {
  if (s.xn !== undefined) return s.xn;
  return it.ow && it.tr ? Math.max(0, Math.round(area / (it.ow * it.tr))) : 0;
}
/** v0.18.1 a stair's sizes where one of its flights / landings is: its type (its own, else the take-off's default),
 *  each size the take-off's own when the type has none */
export function stairSizes(m: Partial<Pick<QtoModel, 'stairTypeById'>>, it: TItem, s: Pick<Shape, 'mt'>): { type: MemberType | null; tr: number; ri: number; w: number; waist: number; land: number; r: number } {
  const t = (s.mt && m.stairTypeById?.get(s.mt)) || (it.bt && m.stairTypeById?.get(it.bt)) || null;
  return { type: t, tr: t?.tr ?? it.tr ?? 0, ri: t?.ri ?? it.ri ?? 0, w: t?.w ?? it.ow ?? 0, waist: t?.d ?? it.d ?? 0, land: t?.t ?? it.st ?? 0, r: t?.r ?? it.sr ?? 0 };
}
/**
 * v0.18.1 what of a slab's soffit is a drop panel's or a beam's soffit instead (m², one copy of the shape): the drop
 * panels drawn on its sheet where they overlap it (their plan area there), and the beams below it (not upstands) -
 * each segment's length inside it × its width. At the slab's scale.
 */
export function soffitUnder(m: Pick<QtoModel, 'shapesByPage' | 'itemById' | 'pages' | 'regions' | 'beamTypeById'>, slab: Shape): number {
  const h = scaleAt(m, slab.dwg, slab.pg, centroid(slab.flat));
  if (!h.sc) return 0;
  const ry = h.ry ?? 1, a2 = h.sc * h.sc * ry;
  const ring = (pts: Pt[]) => { const r = pts.map((p) => [p[0], p[1]] as [number, number]); return r.length ? [...r, r[0]] : r; };
  const geom = (s: Shape): PcPolygon => [ring(s.flat), ...s.holes.map((hh) => ring(hh))];
  const me = geom(slab);
  // (fresh eyes: someone else's private drop panel / beam is not seen by the others - nor does it come off their slab)
  const si = m.itemById.get(slab.ti);
  const seen = (oi: TItem) => !oi.priv || (!!si?.priv && si.owner === oi.owner);
  /** what is under the slab, in the sheet's units: drop panels as drawn, each beam segment as its width on plan */
  const under: PcPolygon[] = [];
  // (a beam's width on plan: worked out in metres - the sheet may be at another scale up-down - and back)
  const toM = (p: Pt): Pt => [p[0] * h.sc!, p[1] * h.sc! * ry], toS = (p: Pt): [number, number] => [p[0] / h.sc!, p[1] / (h.sc! * ry)];
  for (const o of m.shapesByPage.get(pageKey(slab.dwg, slab.pg)) ?? []) {
    const oi = m.itemById.get(o.ti);
    if (!oi || o.id === slab.id || !seen(oi) || !boxesTouch(o.box, slab.box)) continue;
    if (oi.sk === 'drop' && o.k === 'poly') { under.push(geom(o)); continue; }
    if (oi.kind !== 'beam' || oi.up || o.k !== 'line') continue;
    for (let i = 0; i + 1 < o.pts.length; i++) {
      const tag = o.sg[i] ?? null, bt = beamTypeOf(m, oi, tagBase(tag)), own = tagOwn(tag);
      const bw = own.w ?? o.xw ?? bt?.w ?? null;
      if (!bw) continue;
      const pl = flatten([o.pts[i], o.pts[i + 1]], [o.b[i] || 0], false).map(toM);
      for (let k = 0; k + 1 < pl.length; k++) {
        const a = pl[k], b = pl[k + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 1e-9) continue;
        const nx = (-(b[1] - a[1]) / L) * bw / 2, ny = ((b[0] - a[0]) / L) * bw / 2;
        under.push([[toS([a[0] + nx, a[1] + ny]), toS([b[0] + nx, b[1] + ny]), toS([b[0] - nx, b[1] - ny]), toS([a[0] - nx, a[1] - ny]), toS([a[0] + nx, a[1] + ny])]]);
      }
    }
  }
  if (!under.length) return 0;
  // (their union inside the slab: a beam on the slab's edge counts its half over the slab; drop panels and beams
  // over each other, beams crossing - once)
  let off = 0;
  try {
    const inter = pcIntersection(me, pcUnion(under[0], ...under.slice(1)));
    for (const poly of inter) for (let k = 0; k < poly.length; k++) off += (k ? -1 : 1) * Math.abs(ringArea(poly[k]));
  } catch { return 0; }
  off *= a2;
  return off;
}
const boxesTouch = (a: Box, b: Box) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
const ringArea = (r: [number, number][]) => { let t = 0; for (let i = 0; i + 1 < r.length; i++) t += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return t / 2; };

/** v0.18.1 blinding: 50 mm thick, 50 mm past the edges, unless typed */
export const BLIND_T = 0.05, BLIND_X = 0.05;
/**
 * The plan area of an outline grown by x all round (blinding, polythene): its area + its outer perimeter × x + x² ×
 * Σ tan(turn / 2) at its corners (mitred corners; a rectangle + 4x², a concave corner takes off). Cut-outs stay at
 * their own size (`area` is net of them). Exact for straight edges; arcs by their chords.
 */
export function offsetArea(m: Pick<QtoModel, 'pages' | 'regions'>, s: Shape, area: number, x: number): number {
  if (x <= 0) return area;
  const h = scaleAt(m, s.dwg, s.pg, centroid(s.flat));
  if (!h.sc) return area;
  const ry = h.ry ?? 1;
  const ring = s.flat.map((p) => [p[0], p[1] * ry] as Pt);
  const n = ring.length;
  if (n < 3) return area;
  let sa = 0;
  for (let i = 0; i < n; i++) { const a = ring[i], b = ring[(i + 1) % n]; sa += a[0] * b[1] - b[0] * a[1]; }
  const dir = sa >= 0 ? 1 : -1;
  let turn = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[(i + n - 1) % n], b = ring[i], c = ring[(i + 1) % n];
    const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
    if (Math.hypot(u[0], u[1]) < 1e-12 || Math.hypot(v[0], v[1]) < 1e-12) continue;
    const ang = Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]) * dir;
    turn += Math.tan(ang / 2);
  }
  const P = pathLengthY(s.pts, s.b, true, ry) * h.sc;
  return area + P * x + turn * x * x;
}

export function wallTypeOf(m: Partial<Pick<QtoModel, 'wallTypeById' | 'rwTypeById'>>, it: TItem, tag: string | null | undefined): MemberType | null {
  // (v0.18.1 a retaining wall: its own schedule)
  const rw = it.sk === 'rw', by = rw ? m.rwTypeById : m.wallTypeById, pre = rw ? 'rt:' : 'wt:';
  const t = tagBase(tag);
  return (t && t.startsWith(pre) && by?.get(t)) || (it.bt && by?.get(it.bt)) || null;
}
/**
 * v0.18.1 (Feedback 3, 7: "each instance may have different dimensions and/or steel ratios") a segment's tag may carry
 * figures of its own after '#': "bt:abc#w=0.4;d=0.8;r=150" - the segment is still of that type. Tags follow the
 * corners in every geometry change, so its figures do too.
 */
export interface SegOwn { w?: number; d?: number; r?: number }
/**
 * (fresh eyes: a free-text tag may hold '#' - "Unit #2") a segment's own figures only ever follow a type's id (bt: / wt: /
 * rt:) or nothing, as "#w=..;d=..;r=..": anything else is a plain tag, kept whole
 */
const OWN_RE = /^((?:bt|wt|rt):[^#]*)?#((?:[wdr]=[-+0-9.eE]+;?)+)$/;
export const hasTagOwn = (tag: string | null | undefined): boolean => !!tag && OWN_RE.test(tag);
export const tagBase = (tag: string | null | undefined): string | null => {
  if (!tag) return null;
  const m = OWN_RE.exec(tag);
  return m ? m[1] || null : tag;
};
export function tagOwn(tag: string | null | undefined): SegOwn {
  const out: SegOwn = {};
  const mm = tag ? OWN_RE.exec(tag) : null;
  if (!mm) return out;
  for (const kv of mm[2].split(';')) {
    const [k, v] = kv.split('=');
    const n = Number(v);
    if ((k === 'w' || k === 'd') && Number.isFinite(n) && n > 0) out[k] = n;
    if (k === 'r' && Number.isFinite(n) && n >= 0) out.r = n;
  }
  return out;
}
export function withTagOwn(tag: string | null | undefined, own: SegOwn): string | null {
  const base = tagBase(tag) ?? '';
  const parts = (['w', 'd', 'r'] as const).filter((k) => own[k] !== undefined).map((k) => k + '=' + Math.round(own[k]! * 100000) / 100000);
  if (!parts.length) return base || null;
  return base + '#' + parts.join(';');
}

/**
 * Quantities of a take-off item.
 * Shape multipliers (typical floors) apply first, then the item multiplier, then
 * openings are deducted, then waste is added on top.
 */
export function itemQty(m: QtyModel, it: TItem, depth = 0, noWaste = false): ItemQty {
  const q = emptyQty();
  /** v0.18.1 a stair's steps, all its flights (its byTag is by type now) */
  let stairSteps = 0, cwFace = 0;
  const lineKind = isLineKind(it.kind);
  const tagged = lineKind;
  for (const s of m.shapesByItem.get(it.id) ?? []) {
    const sq = shapeQtyAt(m, s, it.dmin);
    q.shapes++;
    if (s.k !== 'pt' && !sq.scaled) q.unscaled++;
    if (sq.mixed) q.mixed++;
    q.badHoles += sq.badHoles;
    q.cnt += sq.cnt * s.m;
    q.len += sq.len * s.m;
    // (v0.18.1 a concrete wall's own height, when typed on it)
    if (isConcWall(it.sk)) cwFace += sq.len * (s.xh ?? it.h ?? 0) * s.m;
    q.area += sq.area * s.m;
    q.perim += sq.perim * s.m;
    // v0.17 a column: its type's section × the take-off's height (v0.18: less the slab thickness when given; a
    // shear wall counted the same way, its type length × thickness; each with figures of its own when typed on it)
    if ((it.sk === 'col' || it.sk === 'sw') && s.k === 'pt') {
      const t = colTypeOf(m, it, s.mt);
      const key = t ? t.id : '';
      const e = q.byTag.get(key) ?? q.byTag.set(key, { len: 0, segs: 0, vol: 0, form: 0, kg: 0 }).get(key)!;
      e.segs += s.m;
      // (a round one stays round with a width of its own - its diameter - until it is given a depth too)
      const round = !!t?.round && s.xd === undefined;
      const w = s.xw ?? t?.w ?? null, d = round ? null : s.xd ?? t?.d ?? null;
      const h0 = s.xh ?? it.h;
      const h = h0 ? Math.max(0, h0 - (it.cst ?? 0)) : null;
      if (w && (round || d) && h0) {
        const A = round ? Math.PI * w * w / 4 : w * d!, P = round ? Math.PI * w : 2 * (w + d!);
        const v = A * h! * s.m;
        e.len += h! * s.m; e.vol += v; e.form += P * h! * s.m; e.kg += v * (s.xr ?? t?.r ?? it.sr ?? 0);
      } else if (!w || !(round || d)) q.untyped += s.m; // (no height: said on its own, not "no type")
    }
    // v0.18 a footing: its type's L × W × D (formwork: its sides)
    if (it.sk === 'ftg' && s.k === 'pt') {
      const t = colTypeOf(m, it, s.mt);
      const key = t ? t.id : '';
      const e = q.byTag.get(key) ?? q.byTag.set(key, { len: 0, segs: 0, vol: 0, form: 0, kg: 0 }).get(key)!;
      e.segs += s.m;
      const round = !!t?.round && s.xd === undefined;
      const w = s.xw ?? t?.w ?? null, d = round ? null : s.xd ?? t?.d ?? null, dp = s.xt ?? t?.t ?? null;
      if (w && (round || d) && dp) {
        const A = round ? Math.PI * w * w / 4 : w * d!, P = round ? Math.PI * w : 2 * (w + d!);
        const v = A * dp * s.m;
        e.vol += v; e.form += P * dp * s.m; e.kg += v * (s.xr ?? t?.r ?? it.sr ?? 0);
        // v0.18.1 waterproofing under it / to its sides, blinding and polythene reaching blx past its edges
        if (it.wb) q.wph += A * s.m;
        if (it.wsd) q.wpv += P * Math.min(it.wvh ?? dp, dp) * s.m;
        const bx = it.blx ?? BLIND_X, bA = round ? Math.PI * (w / 2 + bx) ** 2 : (w + 2 * bx) * (d! + 2 * bx);
        if (it.bln) q.blv += bA * (it.blt ?? BLIND_T) * s.m;
        if (it.pe) q.pea += bA * s.m;
      } else q.untyped += s.m;
    }
    // v0.18.1 a raft / a slab on grade: the same under and around its outline
    if ((it.sk === 'raft' || it.sk === 'sog') && s.k === 'poly' && sq.scaled) {
      if (it.wb) q.wph += sq.area * s.m;
      if (it.wsd && it.d) q.wpv += sq.perim * Math.min(it.wvh ?? it.d, it.d) * s.m;
      if (it.bln || it.pe) {
        const bA = offsetArea(m, s, sq.area, it.blx ?? BLIND_X);
        if (it.bln) q.blv += bA * (it.blt ?? BLIND_T) * s.m;
        if (it.pe) q.pea += bA * s.m;
      }
    }
    // v0.18 a stair (Nabil's STAIRS_CALCULATION.xlsx): a flight = its steps (½ tread × riser × width each) + the waist
    // slab under them (√(tread² + riser²) × steps × width × waist); a landing = its area × its thickness. Formwork: the
    // steps' two sides and their risers, the waist's soffit, the landing's soffit. Steel by ratio.
    if (it.sk === 'stair' && s.k === 'poly' && sq.scaled) {
      // (v0.18.1 by its type from the stair schedule - its own, else the take-off's default - else the take-off's sizes)
      const z = stairSizes(m, it, s);
      const a = sq.area * s.m, r = s.xr ?? z.r;
      const tk = z.type ? z.type.id + (s.sp === 'l' ? '|l' : '|f') : s.sp === 'l' ? 'Landings' : 'Flights';
      const e = q.byTag.get(tk) ?? q.byTag.set(tk, { len: 0, segs: 0, vol: 0, form: 0, kg: 0 }).get(tk)!;
      if (s.sp === 'l') {
        const v = a * z.land;
        e.vol += v; e.form += a; e.kg += v * r;
        if (!z.land) q.untyped += s.m;
      } else {
        const n = flightSteps({ ow: z.w, tr: z.tr }, s, sq.area), T = z.tr, R = z.ri, W = z.w, hyp = Math.hypot(T, R);
        const v = (0.5 * T * R * W * n + hyp * n * W * z.waist) * s.m;
        // (len: the waist's length along the slope; segs: the steps)
        e.len += hyp * n * s.m; e.segs += n * s.m; e.vol += v; e.form += (0.5 * T * R * 2 * n + R * W * n + hyp * n * W) * s.m; e.kg += v * r;
        stairSteps += n * s.m;
        if (!T || !R || !W || !z.waist) q.untyped += s.m;
      }
    }
    // segment by segment: tags (beam types for beams), and for walls the openings placed on them
    if (tagged && s.k === 'line' && sq.scaled && (it.kind === 'beam' || isConcWall(it.sk) || s.sg.some((t) => t) )) {
      const sl = segLensAt(m, s);
      // (v0.18.3 a retaining wall's blinding / polythene: its strip grown by the projection on both sides, and at
      // its two ends when it is not closed - BUG-001)
      const bx = it.blx ?? BLIND_X;
      let rwStrip = 0, wFirst: number | null = null, wLast: number | null = null;
      sl.lens.forEach((L, i) => {
        if (L === null) return;
        const tag = s.sg[i] ?? null;
        if (it.kind === 'beam') {
          const bt = m.beamTypeById ? beamTypeOf(m as Pick<QtoModel, 'beamTypeById'>, it, tagBase(tag)) : null;
          const key = bt ? bt.id : tagBase(tag) || '';
          const own = tagOwn(tag);
          const e = q.byTag.get(key) ?? q.byTag.set(key, { len: 0, segs: 0, vol: 0, form: 0, kg: 0 }).get(key)!;
          e.len += L * s.m; e.segs += s.m;
          // (v0.18 this beam's own size / steel ratio when typed on it)
          // (v0.18.1 a segment's own figures first)
          const bw = own.w ?? s.xw ?? bt?.w ?? null, bd = own.d ?? s.xd ?? bt?.d ?? null;
          if (bw && bd) {
            // (v0.17 an upstand stands on the slab: the part above it - the overall depth less the slab - both sides, no soffit)
            const dd = Math.max(0, bd - (it.st ?? 0));
            const v = L * bw * dd * s.m;
            e.vol += v; e.form += L * (it.up ? 2 * dd : bw + 2 * dd) * s.m; e.kg += v * (own.r ?? s.xr ?? bt?.r ?? it.sr ?? 0);
          } else q.untyped += L * s.m;
        } else if (isConcWall(it.sk)) {
          // v0.17 a shear wall segment: its type's thickness × the wall's height (formwork both faces)
          // (v0.18.1 a retaining wall the same, from its own schedule - and its waterproofing)
          const wt = wallTypeOf(m, it, tag);
          const key = wt ? wt.id : tagBase(tag) || '';
          const own = tagOwn(tag);
          const e = q.byTag.get(key) ?? q.byTag.set(key, { len: 0, segs: 0, vol: 0, form: 0, kg: 0 }).get(key)!;
          e.len += L * s.m; e.segs += s.m;
          const ww = own.w ?? s.xw ?? wt?.w ?? null, hh = s.xh ?? it.h;
          if (ww && hh) {
            const v = L * hh * ww * s.m;
            e.vol += v; e.form += 2 * L * hh * s.m; e.kg += v * (own.r ?? s.xr ?? wt?.r ?? it.sr ?? 0);
          } else if (!ww) q.untyped += L * s.m;
          if (it.sk === 'rw' && hh) {
            if (it.wsd) q.wpv += L * Math.min(it.wvh ?? hh, hh) * (it.wfc ?? 1) * s.m;
            if (it.wb && ww) q.wph += L * ww * s.m;
          }
          if (it.sk === 'rw' && ww) { rwStrip += L * (ww + 2 * bx); if (wFirst === null) wFirst = ww; wLast = ww; }
        } else if (tag) {
          const e = q.byTag.get(tag) ?? q.byTag.set(tag, { len: 0, segs: 0, vol: 0, form: 0, kg: 0 }).get(tag)!;
          e.len += L * s.m; e.segs += s.m;
        }
      });
      if (it.sk === 'rw' && (it.bln || it.pe) && rwStrip > 0) {
        const p0 = s.pts[0], p1 = s.pts[s.pts.length - 1];
        const closed = s.pts.length > 2 && Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) < 1e-9;
        const bA = rwStrip + (closed ? 0 : bx * ((wFirst ?? 0) + 2 * bx) + bx * ((wLast ?? 0) + 2 * bx));
        if (it.bln) q.blv += bA * (it.blt ?? BLIND_T) * s.m;
        if (it.pe) q.pea += bA * s.m;
      }
    } else if (it.kind === 'beam' && s.k === 'line' && !sq.scaled) { /* waits for a scale */ }
  }
  const x = it.dc ? 1 : it.x || 1;
  q.cnt *= x; q.len *= x; q.area *= x; q.perim *= x; q.untyped *= x;
  q.wph *= x; q.wpv *= x; q.blv *= x; q.pea *= x;
  for (const e of q.byTag.values()) { e.len *= x; e.segs *= x; e.vol *= x; e.form *= x; e.kg *= x; }
  // derived measures
  if (it.kind === 'line' || it.kind === 'wall') q.area = isConcWall(it.sk) ? cwFace * x : it.h ? q.len * it.h : 0;
  if (it.kind === 'count' && !isCountedStruct(it.sk)) {
    q.area = it.ow && it.oh ? q.cnt * it.ow * it.oh : 0;
    q.len = it.ow ? q.cnt * it.ow : 0;
  }
  // v0.17 columns: their concrete, formwork, steel by type; len = the columns' length (number × height)
  if (isCountedStruct(it.sk)) {
    q.area = 0; q.len = 0;
    for (const e of q.byTag.values()) { q.vol += e.vol; q.form += e.form; q.kg += e.kg; q.len += e.len; }
  }
  if (it.kind === 'beam') {
    q.area = 0;
    for (const e of q.byTag.values()) { q.vol += e.vol; q.form += e.form; q.kg += e.kg; }
  }
  q.gross = q.area;
  // walls: the doors and other openings placed on them, and a lintel over each (unless taken off)
  /** v0.17 a shear wall: the openings placed on it by type (its segment's), each off its own thickness */
  const placed = new Map<string, number>();
  let wpOff = 0;
  if (it.kind === 'wall' && m.openingsByShape) {
    const lb = it.lb ?? LINTEL_DEFAULT.lb, ld = it.ld ?? LINTEL_DEFAULT.ld, lw = it.d ?? it.lw ?? LINTEL_DEFAULT.lw;
    for (const s of m.shapesByItem.get(it.id) ?? []) {
      for (const o of m.openingsByShape.get(s.id) ?? []) {
        const { w, h } = openingSize(m as Pick<QtoModel, 'doorById'>, o);
        if (o.k === 'door') q.doors += s.m; else q.opens += s.m;
        // (v0.18.1 a concrete wall's own height counts as its height - fresh eyes: with the take-off's empty, its
        // openings were not deducted)
        const wh = isConcWall(it.sk) ? s.xh ?? it.h : it.h;
        // (v0.18.3 only the part of the opening within the wall's height, from its sill - as a plain length does:
        // an opening taller than the wall took off more than the wall has there - BUG-007)
        const sill0 = o.sill ?? 0;
        const a = w && h ? w * (wh ? Math.max(0, Math.min(sill0 + h, wh) - Math.min(sill0, wh)) : h) : 0;
        if (a > 0 && wh && (it.dmin === null || a > it.dmin + 1e-9)) {
          q.dedArea += a * s.m;
          if (isConcWall(it.sk)) { const tag = s.sg[o.seg] ?? null; const wt = wallTypeOf(m, it, tag); const k = wt ? wt.id : tagBase(tag) || ''; placed.set(k, (placed.get(k) ?? 0) + a * s.m); }
          // (v0.18.1 a retaining wall's waterproofing: the opening's part below the waterproofing's top, on each face -
          // from its sill)
          if (it.sk === 'rw' && it.wsd && w && h) { const top = Math.min(it.wvh ?? wh, wh), sill = o.sill ?? 0; wpOff += w * Math.max(0, Math.min(sill + h, top) - Math.min(sill, top)) * (it.wfc ?? 1) * s.m; }
        }
        else if (a > 0 && wh) q.keptOpenings += s.m;
        // (v0.17 a shear wall is concrete: no lintels)
        if (o.lint && w && !isConcWall(it.sk)) {
          q.lcnt += s.m;
          q.llen += (w + 2 * lb) * s.m;
          q.lvol += (w + 2 * lb) * lw * ld * s.m;
        }
      }
    }
  }
  // v0.18 (Feedback 3, 2: "add doors to the length tool") a plain length: the doors / openings placed on it come off
  // it - their width off the length; with a height, their width × height (no higher than the length's) off the area
  if (it.kind === 'line' && m.openingsByShape) {
    for (const s of m.shapesByItem.get(it.id) ?? []) {
      for (const o of m.openingsByShape.get(s.id) ?? []) {
        const { w, h } = openingSize(m as Pick<QtoModel, 'doorById'>, o);
        if (o.k === 'door') q.doors += s.m; else q.opens += s.m;
        if (!w) continue;
        if (it.h) {
          // (what of it is within the length's height, from its sill)
          const sill = o.sill ?? 0;
          const a = w * (h ? Math.max(0, Math.min(sill + h, it.h) - Math.min(sill, it.h)) : it.h);
          if (a <= 0) continue;
          if (it.dmin === null || a > it.dmin + 1e-9) q.dedArea += a * s.m; else q.keptOpenings += s.m;
        } else q.dedLen += w * s.m;
      }
    }
  }
  // openings measured once, deducted from every item that lists them (window -> blockwork, plaster, paint)
  if (depth < 2) {
    for (const oid of it.ded) {
      const o = m.itemById.get(oid);
      if (!o || o.id === it.id) continue;
      // a private (scratch) take-off is seen only by its owner: deducting it would give the
      // others a different quantity - only another private one of the same person uses it
      if (o.priv && !(it.priv && it.owner === o.owner)) continue;
      if (o.kind === 'count' && o.dc) {
        // v0.16.1 a door counter: each door at its own size from the schedule (structural, else clear)
        for (const s of m.shapesByItem.get(o.id) ?? []) {
          const d = s.door ? m.doorById?.get(s.door) : undefined;
          const w = d ? d.sw ?? d.cw : null, h = d ? d.sh ?? d.ch : null;
          if (!w || !h) continue;
          const each = w * h;
          if (it.dmin === null || each > it.dmin + 1e-9) q.dedArea += each * s.m;
          else q.keptOpenings += s.m;
          if (it.kind === 'line' && !it.h) q.dedLen += w * s.m;
        }
      } else if (o.kind === 'count') {
        const each = o.ow && o.oh ? o.ow * o.oh : 0;
        // the opening as measured: its own waste allowance (for ordering doors) is not a hole in the wall
        const oq = itemQty(m, o, depth + 1, true);
        if (each > 0 && (it.dmin === null || each > it.dmin + 1e-9)) q.dedArea += oq.cnt * each;
        else if (each > 0) q.keptOpenings += oq.cnt;
        if (o.ow && it.kind === 'line' && !it.h) q.dedLen += oq.cnt * o.ow;
      } else if (o.kind === 'area') {
        for (const s of m.shapesByItem.get(o.id) ?? []) {
          const sq = shapeQtyAt(m, s, null);
          if (!sq.scaled) continue;
          const a = sq.area;
          if (it.dmin === null || a > it.dmin + 1e-9) q.dedArea += a * s.m * (o.x || 1);
          else q.keptOpenings += s.m;
        }
      } else if (o.kind === 'line' && it.kind === 'line' && !it.h) {
        q.dedLen += itemQty(m, o, depth + 1, true).len;
      }
    }
  }
  // the item's own "times" (both faces of a wall, ×2) has the openings on every face too
  q.dedArea *= x; q.dedLen *= x; q.keptOpenings *= x;
  q.lvol *= x; q.llen *= x; q.lcnt *= x; q.doors *= x; q.opens *= x;
  if (it.kind === 'line' && !it.h) q.len = Math.max(0, q.len - q.dedLen);
  if (it.kind !== 'beam') {
    q.area = Math.max(0, q.area - q.dedArea);
    if (isConcWall(it.sk)) {
      // (the take-off's Times: on the openings as on the faces)
      q.wpv = Math.max(0, q.wpv - wpOff * x);
      // v0.17 the openings come off the concrete, formwork and steel: one placed on the wall off its own segment's type
      // (its thickness), those measured elsewhere (deducted from it) shared over the faces
      let placedSum = 0;
      for (const v of placed.values()) placedSum += v * x;
      const other = Math.max(0, q.dedArea - placedSum);
      // (a segment's face: half its formwork - its own height when typed on the wall; one without a thickness: its
      // length × height, as before 0.18.1)
      const face = (e: TagQty) => (e.form > 0 ? e.form / 2 : e.len * (it.h ?? 0));
      let faces = 0;
      for (const e of q.byTag.values()) faces += face(e);
      for (const [k, e] of q.byTag) {
        const fe = face(e);
        if (fe > 0) {
          const ded = (placed.get(k) ?? 0) * x + (faces > 0 ? (other * fe) / faces : 0);
          const f = Math.max(0, (fe - ded) / fe);
          e.vol *= f; e.form *= f; e.kg *= f;
        }
        q.vol += e.vol; q.form += e.form; q.kg += e.kg;
      }
    } else if (it.sk === 'stair') {
      // (v0.18 a stair: its flights and landings, worked out shape by shape above)
      for (const e of q.byTag.values()) { q.vol += e.vol; q.form += e.form; q.kg += e.kg; }
      q.steps = stairSteps * x;
    } else if (!isCountedStruct(it.sk)) q.vol = it.d ? q.area * it.d : 0;
    // v0.17 slabs / drop panels: formwork = the soffit and the edges (perimeter × thickness), steel by ratio
    if (it.sk === 'slab' || it.sk === 'drop') { q.form = q.area + q.perim * (it.d ?? 0); q.kg = q.vol * (it.sr ?? 0); }
    // v0.18.1 a slab ticked so: its soffit formwork less where drop panels and beams are under it (their own soffits)
    if (it.sk === 'slab' && it.fdx && m.shapesByPage && m.beamTypeById) {
      let off = 0;
      for (const s of m.shapesByItem.get(it.id) ?? []) if (s.k === 'poly') off += soffitUnder(m as QtyModel & Pick<QtoModel, 'shapesByPage' | 'beamTypeById'>, s) * s.m;
      q.soffitOff = off * x;
      q.form = Math.max(0, q.form - q.soffitOff);
    }
    // v0.18 a raft / a footing drawn as an area: on the ground - formwork to its sides only (v0.18.1 a slab on grade too)
    if (it.sk === 'raft' || it.sk === 'sog') { q.form = q.perim * (it.d ?? 0); q.kg = q.vol * (it.sr ?? 0); }
    // v0.18 an area with a steel ratio of its own (an override on the shape): the difference on its concrete
    if ((it.sk === 'slab' || it.sk === 'drop' || it.sk === 'raft' || it.sk === 'sog') && it.d) {
      for (const s of m.shapesByItem.get(it.id) ?? []) {
        if (s.xr === undefined || s.k !== 'poly') continue;
        q.kg += shapeQtyAt(m, s, it.dmin).area * s.m * x * it.d * (s.xr - (it.sr ?? 0));
      }
    }
  }
  if (it.waste && !noWaste) {
    const f = 1 + it.waste / 100;
    // waste on what is ordered: the measure of the take-off (3 rooms stay 3 rooms; 3 doors + 10 % spares is 3.3)
    if (it.kind === 'count') q.cnt *= f;
    q.len *= f; q.area *= f; q.perim *= f; q.vol *= f; q.form *= f; q.kg *= f;
    q.wph *= f; q.wpv *= f; q.blv *= f; q.pea *= f;
    // (and the figures by type, which the Structure summary's type rows show: they no longer added up to
    // their element - 0.23.2, DeepSeek #10)
    for (const e of q.byTag.values()) { e.len *= f; e.vol *= f; e.form *= f; e.kg *= f; }
  }
  return q;
}

/** the segment of a shape's outline nearest to p, and how far along it (0..1) */
export function nearestSeg(s: Pick<Shape, 'k' | 'pts'> & { b?: number[] }, p: Pt): { seg: number; t: number; d: number } {
  const n = s.k === 'poly' ? s.pts.length : s.pts.length - 1;
  let best = { seg: 0, t: 0, d: Infinity };
  for (let i = 0; i < n; i++) {
    const a = s.pts[i], c = s.pts[(i + 1) % s.pts.length];
    const dx = c[0] - a[0], dy = c[1] - a[1];
    const l2 = dx * dx + dy * dy;
    // (t: along the chord, where the drawing puts the mark)
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    let d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    // an arc: how far from the arc itself, not its chord - a door half-way round a curved wall is
    // up to the arc's height off the chord, and went onto the straight wall next to it
    const bu = s.b?.[i];
    if (bu) {
      d = Infinity;
      let q = a;
      for (const r of arcPoints(a, c, bu)) { d = Math.min(d, segD(p, q, r)); q = r; }
    }
    if (d < best.d) best = { seg: i, t, d };
  }
  return best;
}

/** a door of the schedule as a take-off (a count) - what a link from it shows */
export function doorItem(m: Pick<QtoModel, 'doorById'>, id: string): TItem | null {
  const d = m.doorById.get(id);
  if (!d) return null;
  return {
    id, name: 'Door ' + d.tag + (d.desc ? ' – ' + d.desc : ''), kind: 'count', color: '#8d6e3f', grp: '', owner: '', priv: false, h: null, d: null, x: 1, waste: 0,
    dmin: null, ded: [], ow: d.sw ?? d.cw, oh: d.sh ?? d.ch, note: '', ord: '', par: '', lb: null, ld: null, lw: null, bt: '', st: null, sw: null, fill: '', lab: '', fcode: '', rm: '', rk: '',
  };
}

/** Point-in-shape hit test (for selecting shapes on the drawing). tol is in sheet points. */
export function hitShape(s: Shape, p: Pt, tol: number): boolean {
  if (p[0] < s.box.x0 - tol || p[0] > s.box.x1 + tol || p[1] < s.box.y0 - tol || p[1] > s.box.y1 + tol) return false;
  if (s.k === 'poly') {
    if (pointInPoly(p, s.flat) && !s.holes.some((h) => pointInPoly(p, h))) return true;
  }
  const pts = s.k === 'pt' ? s.pts : s.flat;
  if (s.k === 'pt') return pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol * 1.6);
  for (let i = 1; i < pts.length; i++) if (segD(p, pts[i - 1], pts[i]) <= tol) return true;
  if (s.k === 'poly' && pts.length > 2 && segD(p, pts[pts.length - 1], pts[0]) <= tol) return true;
  return false;
}
function segD(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Flattened BOQ copy for pickers (headings + lines, with depth). */
export function flattenMirror(m: QtoModel, filter = ''): MirrorRow[] {
  const f = filter.trim().toLowerCase();
  const out: MirrorRow[] = [];
  if (!f) {
    const visit = (r: MirrorRow) => { out.push(r); r.children.forEach(visit); };
    m.boqRoots.forEach(visit);
    return out;
  }
  const keep = new Map<string, boolean>();
  const mark = (r: MirrorRow): boolean => {
    let k = (r.desc.toLowerCase().includes(f) || r.ref.toLowerCase() === f || r.ref.toLowerCase().startsWith(f + ' ')) && r.bt === 'item';
    for (const c of r.children) k = mark(c) || k;
    keep.set(r.id, k);
    return k;
  };
  m.boqRoots.forEach(mark);
  const visit = (r: MirrorRow) => { if (!keep.get(r.id)) return; out.push(r); r.children.forEach(visit); };
  m.boqRoots.forEach(visit);
  return out;
}

/** "Bill 02 › 5.01 Sanitary fixtures" path of a BOQ copy row (headings above it). */
export function mirrorPath(m: QtoModel, id: string): string {
  const parts: string[] = [];
  let r = m.boqById.get(id);
  let guard = 0;
  while (r && r.par && guard++ < 20) {
    r = m.boqById.get(r.par);
    if (r) parts.unshift(r.ref && r.depth === 0 ? r.ref : r.desc.length > 40 ? r.desc.slice(0, 38) + '…' : r.desc);
  }
  return parts.join(' › ');
}

// ---------------------------------------------------------------- headings tree
const fnv = (t: string) => {
  let h = 0x811c9dc5;
  for (const ch of t.trim().toLowerCase()) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
};
/** id of the heading that stands for an old (v0.6/v0.7) group name — the same on every PC */
export const groupHeadingId = (name: string) => 'hd:g' + fnv(name);
/** id of the heading made from a folder path of the drawing list ("04 Plans › Tower A") */
export const folderHeadingId = (parts: string[]) => 'dh:g' + fnv(parts.join(' › '));

interface Leaf { id: string; par: string; ord: string; groups: string[]; sortKey: string }

function buildTree(kind: TreeView['kind'], raw: { id: string; name: string; par: string; ord: string }[], leaves: Leaf[], gprefix: string): TreeView {
  const tv: TreeView = { kind, tree: new Map(), headings: [], headingById: new Map(), leafPar: new Map() };
  const hs = new Map<string, Heading>();
  for (const r of raw) hs.set(r.id, { id: r.id, name: r.name, par: r.par, ord: r.ord, virtual: false, depth: 0 });
  // a leaf's heading: its own, or the headings made from its group / folder path
  for (const lf of leaves) {
    if (lf.par === '/') { tv.leafPar.set(lf.id, ''); continue; }
    if (lf.par && hs.has(lf.par)) { tv.leafPar.set(lf.id, lf.par); continue; }
    let parent = '';
    for (let i = 0; i < lf.groups.length; i++) {
      const id = gprefix + fnv(lf.groups.slice(0, i + 1).join(' › '));
      let h = hs.get(id);
      if (!h) { h = { id, name: lf.groups[i], par: parent, ord: kind === 'items' ? lf.ord : '', virtual: true, depth: 0 }; hs.set(id, h); }
      else if (h.virtual && kind === 'items' && lf.ord && (!h.ord || lf.ord < h.ord)) h.ord = lf.ord;
      parent = id;
    }
    tv.leafPar.set(lf.id, parent);
  }
  // headings: parent must exist and must not make a loop (two people moving A under B and B under A
  // at once). Looked at in id order, so every PC breaks a loop at the same heading.
  const inOrder = [...hs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const h of inOrder) if (h.par && !hs.has(h.par)) h.par = '';
  for (const h of inOrder) {
    const seen = new Set<string>([h.id]);
    let p = h.par;
    while (p) {
      if (seen.has(p)) { h.par = ''; break; }
      seen.add(p);
      p = hs.get(p)?.par ?? '';
    }
  }
  // order: by order key; things never placed by hand after them, by name / sheet number
  const key = new Map<string, string>();
  for (const h of hs.values()) key.set(h.id, h.name);
  for (const lf of leaves) key.set(lf.id, lf.sortKey);
  const cmp = (a: TreeNode, b: TreeNode) => {
    if (a.ord && b.ord) return a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (a.ord) return -1;
    if (b.ord) return 1;
    return (key.get(a.id) ?? '').localeCompare(key.get(b.id) ?? '', undefined, { numeric: true }) || (a.id < b.id ? -1 : 1);
  };
  const add = (par: string, n: TreeNode) => (tv.tree.get(par) ?? tv.tree.set(par, []).get(par)!).push(n);
  for (const h of hs.values()) add(h.par, { t: 'h', id: h.id, ord: h.ord });
  for (const lf of leaves) add(tv.leafPar.get(lf.id) ?? '', { t: 'i', id: lf.id, ord: lf.ord });
  for (const l of tv.tree.values()) l.sort(cmp);
  const walk = (par: string, depth: number) => {
    for (const n of tv.tree.get(par) ?? []) {
      if (n.t !== 'h') continue;
      const h = hs.get(n.id)!;
      h.depth = depth;
      tv.headings.push(h);
      walk(h.id, depth + 1);
    }
  };
  walk('', 0);
  for (const h of tv.headings) tv.headingById.set(h.id, h);
  return tv;
}

/** "Finishes › Tower A › Level 1" */
export function headingPath(m: Pick<QtoModel, 'headingById'>, id: string, sep = ' › '): string {
  const names: string[] = [];
  let h = id ? m.headingById.get(id) : undefined;
  while (h) { names.unshift(h.name); h = h.par ? m.headingById.get(h.par) : undefined; }
  return names.join(sep);
}

/**
 * Do these changes use what only 0.15.0 and later read (walls, beams, segment tags, openings placed
 * on walls, the door schedule, beam types, the new measures)? Then the take-off is marked with data
 * format 3: older apps open it view only and their estimates leave its quantities alone.
 */
/**
 * v0.16 (for the integrator's data-format bump): do these changes make pages of a bound set sheets of
 * their own (dwg:/rv: fp)? A 0.15 app shows such a sheet as page 1 of the file (the quantities are right,
 * the picture under them is not): it should open the project view only.
 */
export function usesPageSheets(ops: [string, string, unknown][]): boolean {
  for (const [e, f, v] of ops) if (f === 'fp' && v !== null && v !== undefined && (e.startsWith('dwg:') || e.startsWith('rv:'))) return true;
  return false;
}

/** v0.16 (format 4): rooms / finishes, binder pages as sheets, additional items */
export function needsFormat16(ops: [string, string, unknown][]): boolean {
  if (usesPageSheets(ops) || needsFormatFinishes(ops)) return true;
  for (const [e, f, v] of ops) if ((e.startsWith('dm:') && f === 'add' && v === true) || (e.startsWith('ti:') && f === 'dc' && v === true) || (e.startsWith('sh:') && f === 'door' && v)) return true;
  return false;
}

/** v0.16.4 a room with a soffit, a bulkhead or a higher upturn: older apps would misread it (version.ts format 5) */
export function needsFormat164(ops: [string, string, unknown][]): boolean {
  for (const [e, f, v] of ops) {
    if (e.startsWith('ti:') && ((f === 'ak' && (v === 'bh' || v === 'up')) || (f === 'cs' && v === true))) return true;
    // (a BOQ link on a split waterproofing code: 0.16.3 has no such code - it would write 0 for that item)
    if (e.startsWith('fl:') && f === 'code' && typeof v === 'string' && /\((horizontal|vertical|SFT)\)\s*$/i.test(v)) return true;
  }
  return false;
}

/** v0.17 structural elements (slab, drop panel, columns, shear walls; upstands; column / shear wall types, a column's
 *  type, a take-off's steel ratio): a 0.16 app would count them as plain areas / counts / walls (version.ts format 7) */
export function needsFormat17(ops: [string, string, unknown][]): boolean {
  for (const [e, f, v] of ops) {
    if (v === null || v === undefined || v === false) continue;
    if (e.startsWith('ct:') || e.startsWith('wt:')) return true;
    if (e.startsWith('ti:') && (f === 'sk' || f === 'up' || f === 'sr')) return true;
    if (e.startsWith('sh:') && (f === 'mt' || (f === 'sg' && typeof v === 'string' && v.includes('"wt:')))) return true;
  }
  return false;
}

/** v0.18 what a 0.17 app would get wrong (version.ts format 8): a room with a Room height (its walls by the ceilings,
 *  plaster, the walls above the false ceiling), miscellaneous items, an elevation standing for plan edges; shear walls
 *  counted, footings, rafts, stairs and their types; a column's slab thickness, mesh; an element's own figures; doors on a plain length; images on a sheet */
export function needsFormat18(ops: [string, string, unknown][]): boolean {
  for (const [e, f, v] of ops) {
    if (v === null || v === undefined || v === false) continue;
    if (e.startsWith('st:') || e.startsWith('ft:')) return true;
    if (e.startsWith('ti:') && (f === 'rmh' || f === 'plc' || f === 'bc' || f === 'wr' || f === 'mesh' || f === 'tr' || f === 'ri' || (f === 'ak' && v === 'misc') || (f === 'sk' && (v === 'sw' || v === 'ftg' || v === 'raft' || v === 'stair')) || f === 'cst')) return true;
    if (e.startsWith('op:') && f === 'ln') return true;
    if (e.startsWith('sh:') && (f === 'xw' || f === 'xd' || f === 'xt' || f === 'xh' || f === 'xr' || f === 'xn' || f === 'sp')) return true;
  }
  return false;
}

/** v0.18.1 what a 0.18.0 app would get wrong (version.ts format 9): slabs on grade, retaining walls (rt: types),
 *  waterproofing / blinding / polythene, links on those quantities (0.18.0 reads them as Area), stair types (sy:) and a
 *  flight's type, a segment's own figures (tags with '#'), a slab's soffit less drop panels and beams */
export function needsFormat181(ops: [string, string, unknown][]): boolean {
  for (const [e, f, v] of ops) {
    if (v === null || v === undefined || v === false) continue;
    if (e.startsWith('rt:') || e.startsWith('sy:')) return true;
    if (e.startsWith('ti:') && ((f === 'sk' && (v === 'sog' || v === 'rw')) || f === 'wb' || f === 'wsd' || f === 'wvh' || f === 'bln' || f === 'pe' || f === 'fdx')) return true;
    if (e.startsWith('lk:') && f === 'q' && (v === 'wph' || v === 'wpv' || v === 'blv' || v === 'pea')) return true;
    // (a portion link on a miscellaneous item's description / finish: 0.18.0 would match nothing)
    if (e.startsWith('fl:') && f === 'g' && typeof v === 'string' && (v.includes('"item"') || v.includes('"mfin"'))) return true;
    if (e.startsWith('sh:') && f === 'sg' && typeof v === 'string' && v.includes('#')) { let tl: unknown = null; try { tl = JSON.parse(v); } catch { /* bad */ } if (Array.isArray(tl) && tl.some((t) => typeof t === 'string' && hasTagOwn(t))) return true; }
    // (fresh eyes: a core / retaining wall's own height - 0.18.0 reads xh on columns only; soffit-first rooms - 0.18.0
    // takes a full-room false ceiling as the whole room even with others drawn in it)
    if (e.startsWith('sh:') && f === 'xh') return true;
    if (e.startsWith('ti:') && f === 'cs' && v === true) return true;
    if (e.startsWith('sh:') && f === 'mt' && typeof v === 'string' && v.startsWith('sy:')) return true;
  }
  return false;
}

/** v0.16.5 an additional wall finish drawn as an area: a 0.16.4 app would count it 0 (version.ts format 6) */
export function needsFormat165(ops: [string, string, unknown][]): boolean {
  for (const [e, f, v] of ops) {
    if (e.startsWith('ti:') && f === 'wa' && v === true) return true;
    // (v0.17 review: 0.16.5 / 0.16.6 things a 0.16.4 app gets wrong - a link on a soffit code "X (SFT)" or written own-code
    // only (nb), a bulkhead (its underside may be taken from the ceiling it runs along: no code in 0.16.4)
    if (e.startsWith('fl:') && ((f === 'code' && typeof v === 'string' && /\(SFT\)\s*$/i.test(v)) || (f === 'nb' && v === true))) return true;
    if (e.startsWith('ti:') && f === 'ak' && v === 'bh') return true;
  }
  return false;
}

export function needsFormat3(ops: [string, string, unknown][]): boolean {
  for (const [e, f, v] of ops) {
    if (v === null || v === undefined) continue;
    if (e.startsWith('op:') || e.startsWith('bt:') || e.startsWith('ds:')) return true;
    if (e.startsWith('ti:') && f === 'kind' && (v === 'wall' || v === 'beam')) return true;
    if (e.startsWith('sh:') && f === 'sg') return true;
    if (e.startsWith('lk:') && ((f === 'q' && !['area', 'len', 'perim', 'vol', 'cnt'].includes(String(v))) || (f === 'ti' && String(v).startsWith('ds:')))) return true;
  }
  return false;
}
