// The drawing on screen, with everything measured on it.
//
// Speed: the whole sheet is shown at once from a cached picture; whatever part is
// on screen is re-rendered sharp by PDFium a moment after you stop moving (about
// 50 ms even on the heaviest sheets, because PDFium skips what's off screen).
// While panning/zooming nothing is rendered: the pictures are just moved, so it
// stays smooth no matter how heavy the drawing is.
//
// Drawing (borrowed from Bluebeam / AutoCAD / On-Screen Takeoff):
//   Backspace or Ctrl+Z  takes back the last node (Ctrl+Y puts it back)
//   Esc                  v0.16: stops - keeps the shape when it is complete (as Enter), else drops the
//                        loose nodes; ✕ Cancel on the bar throws it away (Ctrl+Z right after brings it back)
//   Right-click          Finish / Undo node / Close / Cancel
//   type a number        after the first node: exact length of the next segment (Enter)
//   F8 / Shift           ortho: horizontal / vertical only, ⊥ snap onto take-offs near the pointer
//                        (Rectangle: Shift = a square)
//   A / L                next segments as arcs / straight (also on the bar). An arc: click
//                        where it ends, then a point it passes through.
//   Space (tap)          ends this run and starts the next one in the same take-off
//                        (hold Space and drag = pan, as before)
//   D / O (walls)        a door / another opening: click where it is on the wall (the wall
//                        being drawn, or one already drawn) - a list of door tags opens there
// An action bar under the sheet always shows what you can do next.
//
// Revisions: with `compare`, the previous revision is overlaid — removed lines red,
// added lines blue, unchanged lines dark.
import { watchDrawing } from '../closeGuards';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { anyMenuOpen } from './menus';
import { qsAny } from '../popout';
import type { PdfEngine, PageSize, Snapped } from './pdfengine';
import type { Note, Region, Shape, TItem } from '../../engine/qto/model';
import { bulgeThrough, centroid, dist, flatten, polyLength, scaleText, segDist, segMid, type Box, type Pt } from '../../engine/qto/geometry';
import { hitShape } from '../../engine/qto/model';
import { bandHalf, bandOutline, boxPicks, endNodeForLength, isEndNode, nearestEdge, nodeOnEdge, orthoHV, perpSnap, segsOf, type BandRun, type Seg } from '../../engine/qto/drawaids';
import { fixed, qtoFmt, useQtoFmt } from './numfmt';
import { aids, onAids, setAids } from './aids';
import { measureStep } from './viewlogic';
import { edgeAt, insideNormal, insideSign, nearestOutline, projectOnOutline } from '../../engine/qto/roomdraw';
import { pointInPoly } from '../../engine/qto/geometry';
import { edgeFlags } from '../../engine/qto/rooms';

export type Tool = 'select' | 'area' | 'rect' | 'circle' | 'line' | 'count' | 'hole' | 'measure' | 'scale' | 'region' | 'note';

export interface OpeningMark {
  id: string;
  a: Pt;
  b: Pt;
  label: string;
  color: string;
  k: 'door' | 'open';
  /** v0.16: the wall's thickness (m) - drawn as a band, the gap goes right across it */
  band?: number | null;
  /** v0.16.4 the edge it is on (its two nodes): dragged by its mark or its tag, it moves along it */
  ea?: Pt;
  eb?: Pt;
}
/** v0.16.4 where a door / an opening dragged to p goes: its centre on its own edge, wholly on it */
export function slideOnEdge(o: Pick<OpeningMark, 'a' | 'b' | 'ea' | 'eb'>, p: Pt): Pt | null {
  if (!o.ea || !o.eb) return null;
  const dx = o.eb[0] - o.ea[0], dy = o.eb[1] - o.ea[1];
  const L2 = dx * dx + dy * dy;
  if (L2 <= 1e-12) return null;
  const L = Math.sqrt(L2);
  const half = Math.min(0.5, Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]) / 2 / L);
  let t = ((p[0] - o.ea[0]) * dx + (p[1] - o.ea[1]) * dy) / L2;
  t = Math.max(half, Math.min(1 - half, t));
  return [o.ea[0] + dx * t, o.ea[1] + dy * t];
}

/** v0.16: what the app can ask of the drawing */
export interface SheetApi {
  /** before another tool / take-off is picked: a complete shape being drawn is kept (true: one was being drawn) */
  keepShape: () => boolean;
}

export interface OtherCursor {
  w: string;
  name: string;
  color: string;
  x: number;
  y: number;
}

/** v0.18 (Feedback 3, D) another sheet shown over this one - a ceiling plan over the floor plan, an elevation - put in
 *  place by two matching points: `m` takes its page's coordinates to this page's (a, b, c, d, e, f). Only a picture
 *  to draw over: what is measured goes on this sheet; neither PDF is changed. */
export interface OverSpec {
  key: string;
  pg: number;
  preview: ImageBitmap | null;
  page: { w: number; h: number };
  m: [number, number, number, number, number, number];
  /** 0..1 */
  alpha: number;
  color: string;
  /** v0.18.1 only this part of it (a box on its own page) */
  crop?: Box | null;
}
export type Mat6 = [number, number, number, number, number, number];
export const invMat = (m: Mat6): Mat6 => {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};
export const applyMat = (m: Mat6, p: Pt): Pt => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
/** the similarity (move, turn, scale - no skew) that takes a1 -> b1 and a2 -> b2; null when the points coincide */
export function alignMat(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Mat6 | null {
  const ux = a2[0] - a1[0], uy = a2[1] - a1[1], vx = b2[0] - b1[0], vy = b2[1] - b1[1];
  const n = ux * ux + uy * uy;
  if (n < 1e-9 || vx * vx + vy * vy < 1e-9) return null;
  // (complex division v / u)
  const re = (vx * ux + vy * uy) / n, im = (vy * ux - vx * uy) / n;
  return [re, im, -im, re, b1[0] - (re * a1[0] - im * a1[1]), b1[1] - (im * a1[0] + re * a1[1])];
}

export interface CompareSpec {
  key: string;
  preview: ImageBitmap | null;
  previewScale: number;
  /** the earlier revision's page (points): drawn at its own size, from the same top-left corner -
   *  a sheet reissued on another paper size is not stretched to the current one */
  page?: { w: number; h: number };
  /** its page number (an earlier revision may have fewer pages) */
  pg?: number;
  /** overlay = both (red removed / blue added), previous = show only the older revision */
  mode: 'overlay' | 'previous';
  label: string;
}

export interface VertexRef {
  shape: string;
  ring: number;
  idx: number;
}

/** the segment of a shape under the pointer (outer outline only) */
export interface SegRef {
  shape: string;
  idx: number;
  p: Pt;
}

export interface SheetCanvasProps {
  engine: PdfEngine | null;
  dkey: string;
  pg: number;
  page: PageSize;
  preview: ImageBitmap | null;
  previewScale: number;
  compare: CompareSpec | null;
  /** v0.18 another sheet over this one */
  over?: OverSpec | null;
  /** v0.18 images put on this sheet (pictures over the PDF) */
  images?: { id: string; bmp: ImageBitmap; box: Box; shared: boolean; hi?: boolean; mine?: boolean }[];
  /** v0.18.1 an image of yours moved / resized on the sheet; removed with Delete */
  onImageBox?: (id: string, box: Box) => void;
  onImageDel?: (id: string) => void;
  shapes: Shape[];
  /** shapes measured on an earlier revision of this sheet (drawn dashed until checked) */
  stale: Set<string>;
  items: Map<string, TItem>;
  regions: Region[];
  notes: Note[];
  selected: Set<string>;
  active: TItem | null;
  tool: Tool;
  snapOn: boolean;
  readOnly: boolean;
  others: OtherCursor[];
  /** metres per sheet point at a point, across (x) and up-down (y) - the same unless the sheet has
   *  a separate vertical scale (null = no scale here) */
  scaleAt: (p: Pt) => { x: number; y: number } | null;
  /**
   * A path's length (and area when closed) in metres, measured as the take-off measures it: piece by
   * piece at each viewport's scale, an area at the scale of its middle. null = no scale (or part of it).
   */
  measure: (pts: Pt[], b: number[], closed: boolean) => { len: number; area: number } | null;
  labelFor: (s: Shape) => string;
  fitToken: number;
  /** zoom to a box; ifOff (v0.16): only when it is not wholly on screen - then panned to (zoomed out if it is bigger) */
  focus: { box: Box; token: number; ifOff?: boolean } | null;
  /** continue an existing line from its last point (token changes = start) */
  /** continue a line from its end - or (v0.17) any shape from a node: `from` its index (new nodes go in after it) */
  resume: { id: string; token: number; from?: number } | null;
  /** rectangle / circle: an area, or (with a length take-off active) its outline as a length */
  /** (v0.17.1 'hole': the rectangle / circle is a cut-out of the selected area) */
  closedAs: 'area' | 'line' | 'hole';
  /** the shape made (null: not made) */
  onShape: (k: 'poly' | 'line' | 'pt', pts: Pt[], b?: number[]) => string | null;
  /** walls (v0.15): D / O place a door / another opening on a wall - the one being drawn or one already drawn */
  /** v0.18 the sheet shown turned by this many quarter turns, clockwise (how it is looked at only) */
  rot?: number;
  wallMode?: boolean;
  /** v0.18 the Length tool (doors / openings go on plain lengths too: the bar says "line", not "wall") */
  plainLen?: boolean;
  onOpening?: (k: 'door' | 'open', at: { shape: string; p: Pt; client: [number, number]; drawing?: boolean }) => void;
  /** doors and openings on the walls of this sheet: a gap across the wall from a to b, with its tag */
  openings?: OpeningMark[];
  /** segments picked in the segment table: highlighted */
  segHi?: { shape: string; segs: number[] } | null;
  /** a segment's tag (text, and a colour for beam types) */
  segTag?: (s: Shape, i: number) => { text: string; color: string | null } | null;
  /** take-offs highlighted from the list (the others fade); null / empty = none */
  hiItems?: Set<string> | null;
  /** auto-count: marks found, waiting to be kept (click one to leave it out / take it back) */
  /** (v0.16.6 `to`: a beam mark's segment - a line drawn to its middle, the segment shown) */
  proposals?: { p: Pt; on: boolean; label: string; to?: Pt; seg?: [Pt, Pt]; color?: string }[] | null;
  onProposal?: (i: number) => void;
  /** how the shape is drawn (polygon / rectangle / circle), shown first in the bar under the drawing */
  modeStrip?: ReactNode;
  onReplace: (shapeId: string, pts: Pt[], b?: number[], sg?: (string | null)[]) => void;
  /** a segment bent into an arc (or straightened: 0) */
  onBulge: (shapeId: string, seg: number, bulge: number) => void;
  onHole: (shapeId: string, pts: Pt[]) => void;
  onSelect: (ids: string[], additive: boolean) => void;
  onMove: (ids: string[], dx: number, dy: number, copy: boolean) => void;
  onVertex: (shapeId: string, ring: number, idx: number, p: Pt) => void;
  onVertexInsert: (shapeId: string, ring: number, after: number, p: Pt) => void;
  onVertexDelete: (shapeId: string, ring: number, idx: number) => void;
  onCalibrate: (a: Pt, b: Pt) => void;
  onRegion: (b: Box) => void;
  onNote: (p: Pt) => void;
  onNoteOpen: (n: Note) => void;
  onCursor: (p: Pt | null) => void;
  onContext: (shapeId: string | null, clientX: number, clientY: number, p: Pt, vertex: VertexRef | null, seg: SegRef | null, opening?: string | null) => void;
  /** undo the last saved change (Count: take back the last count) */
  onUndo: () => void;
  /** take back the last count of this run (not whatever else was done last) */
  onUndoCount: () => void;
  onDelete: () => void;
  onToolDone: () => void;
  onSnapState: (s: 'off' | 'preparing' | 'ready' | 'failed') => void;
  /** v0.16 walls / beams drawn as a band: the real width (m) of a segment; null = a line */
  bandWidth?: (s: Shape, seg: number) => number | null;
  /** v0.16 the band of the wall / beam being drawn (m); null = none */
  drawBand?: number | null;
  /** v0.16 which shapes can be picked (clicked, boxed, snapped to, edited): hidden ones not. Default: all */
  canPick?: (s: Shape) => boolean;
  /** v0.16 filled in by the drawing: see SheetApi */
  api?: { current: SheetApi | null };
  /** v0.16 (e) other people's shapes this person may not change: drawn lighter, can be selected (to look at), never
   *  moved, reshaped, deleted or put a door on; why: whose it is, for the message under the drawing */
  viewOnly?: Set<string>;
  viewOnlyWhy?: (s: Shape) => string;
  // ---- v0.16 rooms (group g1)
  /** D / O put a door / an opening on a room's outline (Room tool, or a room selected / in use) */
  roomDoor?: boolean;
  /** start placing a door / an opening (a room step from the panel): a new token each time */
  armPlace?: { k: 'door' | 'open'; token: number } | null;
  /** placing a door / an opening started or stopped (null: Esc, or the click landed) */
  onPlacing?: (k: 'door' | 'open' | null) => void;
  /** picking edges (shadow gap / open edge): a click toggles the edge of one of these shapes under it */
  edgePick?: { flag: 'gap' | 'open' | 'line'; shapes: Set<string> } | null;
  onEdgePick?: (shape: string, seg: number) => void;
  /** v0.17 a column's type (its section and colour) - drawn at its size */
  colOf?: (s: Shape) => { w: number; d: number; round: boolean; color: string; name: string } | null;
  /** v0.16.5 a room's open edge picked with the Select tool (its room selected too): Del makes it a wall edge */
  edgeSel?: { shape: string; seg: number } | null;
  onEdgeSel?: (e: { shape: string; seg: number } | null) => void;
  onEdgeDel?: () => void;
  /** nodes go onto these outlines: always (a length along a room's outline), or when near (an area inside it) */
  rail?: { shapes: Shape[]; always: boolean } | null;
  /** the bar's "Open edge (no wall)" (Room tool): pick the room's open edges */
  onOpenEdges?: () => void;
  /** v0.16.1 the door the next click places (the last one used): shown by the bar's Door button, ▾ = another */
  doorChip?: { tag: string; onChange: (client: [number, number]) => void } | null;
  /** what is being done (a room step): said on the bar under the drawing, with Done / Cancel */
  stepBar?: { text: string; onDone: () => void; onCancel: () => void } | null;
  /** v0.16.4 a door / an opening dragged along its edge (by its mark or its tag): its new centre */
  onOpeningMove?: (id: string, p: Pt) => void;
  /** v0.16.4 a sheet in a window not worked in: seen live (zoom / pan), a click makes it the one worked on */
  passive?: boolean;
  onActivate?: () => void;
}

interface View { s: number; ox: number; oy: number }
const views = new Map<string, View>();

interface Detail { bmp: ImageBitmap; x0: number; y0: number; s: number }

type Drag =
  | { k: 'pan'; sx: number; sy: number; ox: number; oy: number; moved: boolean; button: number }
  | { k: 'box'; a: Pt; b: Pt; additive: boolean }
  | { k: 'move'; a: Pt; b: Pt; ids: string[]; copy: boolean; skip?: Set<string>; why?: string }
  | { k: 'vertex'; id: string; ring: number; idx: number; p: Pt; insert: boolean; sx: number; sy: number; moved: boolean }
  | { k: 'bend'; id: string; seg: number; p: Pt; sx: number; sy: number; moved: boolean }
  | { k: 'opening'; id: string; p: Pt; at: Pt | null; sx: number; sy: number; moved: boolean }
  | { k: 'region'; a: Pt; b: Pt }
  // (v0.18.1 an image picked on the sheet: moved by its body, resized by a corner - its proportions kept)
  | { k: 'image'; id: string; h: 'move' | 'nw' | 'ne' | 'sw' | 'se'; a: Pt; box0: Box; box: Box; moved: boolean };

// numbers as set in Decimals (numfmt.ts): metres, square metres
const fm = (n: number) => fixed(n, qtoFmt().dm);
const fa = (n: number) => fixed(n, qtoFmt().da);
const DRAW_TOOLS: Tool[] = ['area', 'rect', 'circle', 'line', 'hole', 'measure', 'scale'];
/** tools whose segments can be arcs */
const ARC_TOOLS: Tool[] = ['area', 'line', 'hole', 'measure'];
const SNAP_LABEL: Record<string, string> = { end: 'End point', mid: 'Middle', on: 'On line', own: 'Node' };

/** "4.2" -> 4.2 m, "4200mm" -> 4.2 m, "420cm" -> 4.2 m */
/**
 * A length typed while drawing, in metres. "4.2" / "4.2m" = 4.2 m, "4200mm" = 4.2 m,
 * "420cm" = 4.2 m. A whole number of 100 or more with no unit is read as millimetres
 * (that is how most drawings here are dimensioned): "4200" = 4.2 m.
 */
export function parseTypedLength(s: string): number | null {
  const t = s.trim().toLowerCase().replace(',', '.');
  const m = t.match(/^(\d+(?:\.\d*)?|\.\d+)\s*(mm|cm|m)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (m[2] === 'mm') return n / 1000;
  if (m[2] === 'cm') return n / 100;
  if (!m[2] && !m[1].includes('.') && n >= 100) return n / 1000;
  return n;
}

/**
 * What the typed text will be taken as, for the tooltip: "4200" -> "4.200 m (4,200 mm)". Never
 * rounded away: "4212.5" shows 4.2125 m even with 3 decimals set.
 */
export function typedLabel(s: string): string {
  const L = parseTypedLength(s);
  if (L === null) return s;
  const f = qtoFmt();
  let d = f.dm;
  while (d < 6 && Number(L.toFixed(d)) !== Number(L.toPrecision(12))) d++;
  let dm = f.dmm;
  while (dm < 3 && Number((L * 1000).toFixed(dm)) !== Number((L * 1000).toPrecision(12))) dm++;
  return `${fixed(L, d)} m (${fixed(L * 1000, dm)} mm)`;
}

export function SheetCanvas(p: SheetCanvasProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  // v0.16.2 the window this drawing is in (the main one, or its own window - popout.ts): its frames, keys, sizes
  const myWin = (): Window => cv.current?.ownerDocument?.defaultView ?? window;
  const myDoc = (): Document => cv.current?.ownerDocument ?? document;
  const liveEl = useRef<HTMLSpanElement>(null);
  const viewKey = p.dkey + '#' + p.pg + (p.rot ? '#r' + p.rot : '');
  // (the wheel / key / resize handlers are set once: they read the key from here - a zoom after turning the sheet was
  // kept under the unturned sheet's key - 0.23.2, DeepSeek #40)
  const viewKeyRef = useRef(viewKey);
  viewKeyRef.current = viewKey;
  const view = useRef<View>({ s: 0.3, ox: 0, oy: 0 });
  // (a guess until the drawing area is first measured: see viewlogic.ts for what that measure does)
  const size = useRef({ w: 800, h: 600 });
  /** the area was really measured; the view on screen was fitted to the guess; this sheet's view is set up */
  const sized = useRef(false);
  const fitOnGuess = useRef(false);
  const viewSet = useRef(false);
  const bufDpr = useRef(window.devicePixelRatio || 1);
  const detail = useRef<Detail | null>(null);
  const detail2 = useRef<Detail | null>(null);
  const detailTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(true);
  const raf = useRef(0);
  const pts = useRef<Pt[]>([]);
  // closing the app with a shape half drawn asks first (App.tsx); measuring and scale points are not work
  useEffect(() => watchDrawing(() => (['measure', 'scale', 'viewport'].includes(props.current.tool) ? 0 : pts.current.length)), []);
  /** bulge of each segment drawn so far (bul[i]: pts[i] -> pts[i+1]) */
  const bul = useRef<number[]>([]);
  const redoPts = useRef<{ p: Pt; b: number }[]>([]);
  const resumeId = useRef<string | null>(null);
  /** v0.17 continuing from a node: the rest after the new nodes (kept), the shape's tags, the nodes it had before them;
   *  rev: from a line's first node (drawn backwards, turned round when kept) */
  const tail = useRef<{ pts: Pt[]; bul: number[]; base: number; rev: boolean; sg: (string | null)[]; at: number; closed: boolean } | null>(null);
  const cancelled = useRef<{ pts: Pt[]; bul: number[]; tool: Tool; resume: string | null; t: number } | null>(null);
  /** next segments as arcs */
  const arcMode = useRef(false);
  /** arc: its end is chosen, waiting for a point it passes through */
  const arcEnd = useRef<Pt | null>(null);
  /** Space was used to pan while held (so letting go of it does not end the run) */
  const spacePanned = useRef(false);
  const typed = useRef('');
  const measured = useRef<Pt[] | null>(null);
  const hover = useRef<Pt | null>(null);
  const hoverScreen = useRef<Pt | null>(null);
  const hoverShape = useRef<string | null>(null);
  const snapHit = useRef<(Snapped & { own?: boolean }) | null>(null);
  const drag = useRef<Drag | null>(null);
  const spaceDown = useRef(false);
  const shiftDown = useRef(false);
  const pointerIn = useRef(false);
  const props = useRef(p);
  props.current = p;
  const [cursor, setCursor] = useState('default');
  const snapBusy = useRef(false);
  /** v0.18.1 the drawing's lines near the pointer at the last snap look-up (for the ⊥ snap) */
  const nearSegs = useRef<Seg[]>([]);
  /** v0.18.1 the image picked on the sheet (one of yours): its corners resize it, dragging it moves it */
  const imgSel = useRef<string | null>(null);
  /** the corner of a box (on screen) under the pointer, else null */
  const imgCorner = (bx: Box, cx: number, cy: number): 'nw' | 'ne' | 'sw' | 'se' | null => {
    const b = boxOnScreen(bx);
    const near = (x: number, y: number) => Math.abs(cx - x) <= 8 && Math.abs(cy - y) <= 8;
    // (a sheet shown turned: the corners as they are on screen)
    return near(b.x0, b.y0) ? 'nw' : near(b.x1, b.y0) ? 'ne' : near(b.x0, b.y1) ? 'sw' : near(b.x1, b.y1) ? 'se' : null;
  };
  const inBoxPt = (bx: Box, p: Pt) => p[0] >= bx.x0 && p[0] <= bx.x1 && p[1] >= bx.y0 && p[1] <= bx.y1;
  const lastCursorSent = useRef(0);
  const counted = useRef(0);
  const lastCount = useRef<{ q: Pt; t: number } | null>(null);
  const restoreT = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(restoreT.current), []);
  /** walls: D / O pressed - the next click puts a door / another opening on a wall */
  const placing = useRef<'door' | 'open' | null>(null);
  // what the action bar shows (re-rendered only when the number of points / mode changes)
  const [bar, setBar] = useState<{ n: number; mode: string; msg: string | null; canRestore: boolean; resume: boolean; typed: string; arc: boolean; arcEnd: boolean; placing: 'door' | 'open' | null }>({ n: 0, mode: '', msg: null, canRestore: false, resume: false, typed: '', arc: false, arcEnd: false, placing: null });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;
  // v0.16: the top layer (see paint), the ⊥ snap, the grip under the pointer, an end grip waiting for a
  // typed length, the pointer where it really is (hover is moved onto a snap)
  const topDirty = useRef(true);
  const sceneBuf = useRef<OffscreenCanvas | null>(null);
  const loupeBuf = useRef<OffscreenCanvas | null>(null);
  const labBuf = useRef<OffscreenCanvas | null>(null);
  const labOn = useRef(false);
  const perpHit = useRef<{ p: Pt; seg: Seg } | null>(null);
  const hoverGrip = useRef<{ id: string; ring: number; idx: number } | null>(null);
  const gripLen = useRef<{ id: string; idx: number } | null>(null);
  const hoverRaw = useRef<Pt | null>(null);

  const redraw = () => {
    dirty.current = true;
    if (!raf.current) raf.current = myWin().requestAnimationFrame(paint);
  };
  /** only the top layer (pointer, markers, ants): the scene is copied as it is */
  const redrawTop = () => {
    topDirty.current = true;
    if (!raf.current) raf.current = myWin().requestAnimationFrame(paint);
  };
  // Decimals / number size changed (here or in the panel): numbers on the sheet and the readout follow at
  // once, also in the middle of drawing a shape
  const nf = useQtoFmt();
  useEffect(() => { redraw(); live(); }, [nf]);

  const syncBar = (msg: string | null = null) => {
    const c = cancelled.current;
    setBar({
      n: pts.current.length,
      mode: props.current.tool,
      msg,
      // (only while it can be brought back: with the tool it was drawn with, within the 15 s - it stayed after a
      // tool change and for ever, then did nothing - 0.23.2, DeepSeek #39, #42)
      canRestore: !!c && c.tool === props.current.tool && Date.now() - c.t < 15000 && !pts.current.length,
      resume: !!resumeId.current,
      typed: typed.current,
      arc: arcMode.current,
      arcEnd: !!arcEnd.current,
      placing: placing.current,
    });
  };
  const flash = useRef<ReturnType<typeof setTimeout> | null>(null);
  const message = (m: string, ms = 4000) => {
    syncBar(m);
    if (flash.current) clearTimeout(flash.current);
    flash.current = setTimeout(() => syncBar(null), ms);
  };

  // ---------- coordinates ----------
  // v0.18 (Feedback 3, 1: "option for rotating the drawings") the sheet shown turned by quarter turns (clockwise):
  // only how it is looked at - every figure stays in the page's own coordinates. Turned r quarters, the page fills
  // [ox, ox + rw·s] × [oy, oy + rh·s] on screen (rw, rh: its width and height as turned).
  const rot = (): number => props.current.rot ?? 0;
  const turned = (pg = props.current.page): { w: number; h: number } => (rot() % 2 ? { w: pg.h, h: pg.w } : { w: pg.w, h: pg.h });
  /** page -> screen as a canvas matrix (a, b, c, d, e, f) */
  const pageMat = (pg = props.current.page): [number, number, number, number, number, number] => {
    const v = view.current, s = v.s;
    switch (rot()) {
      case 1: return [0, s, -s, 0, v.ox + pg.h * s, v.oy];
      case 2: return [-s, 0, 0, -s, v.ox + pg.w * s, v.oy + pg.h * s];
      case 3: return [0, -s, s, 0, v.ox, v.oy + pg.w * s];
      default: return [s, 0, 0, s, v.ox, v.oy];
    }
  };
  const toSheet = (cx: number, cy: number): Pt => {
    const v = view.current;
    const x = (cx - v.ox) / v.s, y = (cy - v.oy) / v.s;
    const r = rot();
    if (!r) return [x, y];
    const pg = props.current.page;
    return r === 1 ? [y, pg.h - x] : r === 2 ? [pg.w - x, pg.h - y] : [pg.w - y, x];
  };
  const toScreen = (q: Pt): Pt => {
    const v = view.current;
    if (!rot()) return [v.ox + q[0] * v.s, v.oy + q[1] * v.s];
    const m = pageMat();
    return [m[0] * q[0] + m[2] * q[1] + m[4], m[1] * q[0] + m[3] * q[1] + m[5]];
  };
  /** a box of the page on screen (its corners in order whatever the turn) */
  const boxOnScreen = (b: Box): { x0: number; y0: number; x1: number; y1: number } => {
    const v = view.current;
    if (!rot()) return { x0: v.ox + b.x0 * v.s, x1: v.ox + b.x1 * v.s, y0: v.oy + b.y0 * v.s, y1: v.oy + b.y1 * v.s };
    const p = toScreen([b.x0, b.y0]), q = toScreen([b.x1, b.y1]);
    return { x0: Math.min(p[0], q[0]), x1: Math.max(p[0], q[0]), y0: Math.min(p[1], q[1]), y1: Math.max(p[1], q[1]) };
  };
  /** the view that puts page point c at screen point (sx, sy) at scale s */
  const viewAt = (c: Pt, sx: number, sy: number, s: number): View => {
    const keep = view.current;
    view.current = { s, ox: 0, oy: 0 };
    const p = toScreen(c);
    view.current = keep;
    return { s, ox: sx - p[0], oy: sy - p[1] };
  };
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = cv.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const fit = () => {
    const { w, h } = size.current;
    const pg = turned();
    const s = Math.min((w - 40) / pg.w, (h - 40) / pg.h);
    view.current = { s, ox: (w - pg.w * s) / 2, oy: (h - pg.h * s) / 2 };
    fitOnGuess.current = !sized.current;
    viewSet.current = true;
    views.set(viewKeyRef.current, view.current);
    viewChanged();
  };

  const zoomTo = (b: Box) => {
    const { w, h } = size.current;
    const odd = rot() % 2 === 1;
    const bw = Math.max(odd ? b.y1 - b.y0 : b.x1 - b.x0, 20), bh = Math.max(odd ? b.x1 - b.x0 : b.y1 - b.y0, 20);
    const s = Math.min(Math.min((w * 0.7) / bw, (h * 0.7) / bh), 40);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    view.current = viewAt([cx, cy], w / 2, h / 2, s);
    viewChanged();
  };

  const zoomAt = (cx: number, cy: number, factor: number) => {
    const v = view.current;
    const pg = turned();
    const minS = Math.min(size.current.w / pg.w, size.current.h / pg.h) * 0.25;
    const s = Math.max(minS, Math.min(60, v.s * factor));
    const f = s / v.s;
    view.current = { s, ox: cx - (cx - v.ox) * f, oy: cy - (cy - v.oy) * f };
    viewChanged();
  };

  const viewChanged = () => {
    views.set(viewKeyRef.current, view.current);
    redraw();
    if (detailTimer.current) clearTimeout(detailTimer.current);
    detailTimer.current = setTimeout(renderDetail, 110);
  };

  // ---------- sharp render of what is on screen ----------
  const [sharpErr, setSharpErr] = useState<string | null>(null);
  useEffect(() => setSharpErr(null), [p.dkey, p.pg]);
  const renderDetail = async () => {
    const pr = props.current;
    if (!pr.engine || !pr.dkey) return;
    const dpr = bufDpr.current;
    const v = view.current;
    const s = v.s * dpr;
    if (s <= pr.previewScale * 1.08) {
      if (detail.current) { detail.current.bmp.close(); detail.current = null; }
      if (detail2.current) { detail2.current.bmp.close(); detail2.current = null; }
      redraw();
      return;
    }
    const { w, h } = size.current;
    // (the part of the page on screen, whatever its turn)
    const odd = rot() % 2 === 1;
    const mx = ((odd ? h : w) / v.s) * 0.08, my = ((odd ? w : h) / v.s) * 0.08;
    const ca = toSheet(0, 0), cb = toSheet(w, h);
    const x0 = Math.max(0, Math.min(ca[0], cb[0]) - mx), y0 = Math.max(0, Math.min(ca[1], cb[1]) - my);
    const x1 = Math.min(pr.page.w, Math.max(ca[0], cb[0]) + mx), y1 = Math.min(pr.page.h, Math.max(ca[1], cb[1]) + my);
    if (x1 <= x0 || y1 <= y0) return;
    const pw = Math.ceil((x1 - x0) * s), ph = Math.ceil((y1 - y0) * s);
    if (pw * ph > 40e6) return;
    const key = pr.dkey, pg = pr.pg;
    const one = async (k: string, slot: string, target: React.MutableRefObject<Detail | null>, kpg = pg) => {
      try {
        const { bmp } = await pr.engine!.render(k, kpg, s, Math.floor(x0 * s), Math.floor(y0 * s), pw, ph, { slot });
        if (unmounted.current || props.current.dkey !== key || props.current.pg !== pg) { bmp.close(); return; }
        if (target.current) target.current.bmp.close();
        target.current = { bmp, x0: Math.floor(x0 * s) / s, y0: Math.floor(y0 * s) / s, s };
        setSharpErr(null);
        redraw();
      } catch (e: any) {
        if (!e?.superseded) {
          console.warn('render', e?.message);
          // the preview stays on screen; say why it doesn't sharpen
          if (!unmounted.current && props.current.dkey === key) setSharpErr(String(e?.message ?? e));
        }
      }
    };
    const cmp = pr.compare;
    if (!cmp || cmp.mode === 'overlay') await one(key, 'detail', detail);
    if (cmp) await one(cmp.key, 'detail2', detail2, cmp.pg ?? pg);
    // v0.18 the sheet shown over this one: the part of it on screen, sharp
    const ov = pr.over;
    if (ov) {
      const inv = invMat(ov.m), k = Math.hypot(ov.m[0], ov.m[1]);
      const cs = [toSheet(0, 0), toSheet(w, 0), toSheet(0, h), toSheet(w, h)].map((q) => applyMat(inv, q));
      const ox0 = Math.max(0, Math.min(...cs.map((q) => q[0]))), oy0 = Math.max(0, Math.min(...cs.map((q) => q[1])));
      const ox1 = Math.min(ov.page.w, Math.max(...cs.map((q) => q[0]))), oy1 = Math.min(ov.page.h, Math.max(...cs.map((q) => q[1])));
      const so = s * k;
      const ow = Math.ceil((ox1 - ox0) * so), oh = Math.ceil((oy1 - oy0) * so);
      if (ox1 > ox0 && oy1 > oy0 && ow * oh <= 40e6 && ow > 0 && oh > 0) {
        try {
          const { bmp } = await pr.engine!.render(ov.key, ov.pg, so, Math.floor(ox0 * so), Math.floor(oy0 * so), ow, oh, { slot: 'detailO' });
          if (unmounted.current || props.current.over?.key !== ov.key || props.current.over?.pg !== ov.pg || props.current.dkey !== key) bmp.close();
          else { if (detailO.current) detailO.current.bmp.close(); detailO.current = { bmp, x0: Math.floor(ox0 * so) / so, y0: Math.floor(oy0 * so) / so, s: so }; redraw(); }
        } catch (e: any) { if (!e?.superseded) console.warn('overlay render', e?.message); }
      }
    }
  };

  // ---------- painting ----------
  /** v0.18 the sharp part of the sheet shown over this one, and the buffer it is tinted in */
  const detailO = useRef<Detail | null>(null);
  const overCanvas = useRef<OffscreenCanvas | null>(null);
  const tintCanvas = useRef<{ a: OffscreenCanvas; b: OffscreenCanvas } | null>(null);
  const unmounted = useRef(false);
  const drawSheet = (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, prev: ImageBitmap | null, det: Detail | null, page?: { w: number; h: number }) => {
    const v = view.current;
    const pg = page ?? props.current.page;
    if (rot()) {
      // (turned: drawn in the page's own units through the page -> screen matrix)
      ctx.save();
      ctx.transform(...pageMat(pg));
      if (prev) ctx.drawImage(prev, 0, 0, pg.w, pg.h);
      if (det) ctx.drawImage(det.bmp, det.x0, det.y0, det.bmp.width / det.s, det.bmp.height / det.s);
      ctx.restore();
      return;
    }
    if (prev) ctx.drawImage(prev, v.ox, v.oy, pg.w * v.s, pg.h * v.s);
    if (det) {
      const [sx, sy] = toScreen([det.x0, det.y0]);
      ctx.drawImage(det.bmp, sx, sy, (det.bmp.width / det.s) * v.s, (det.bmp.height / det.s) * v.s);
    }
  };

  // v0.16: what is drawn is in two layers. The scene (the sheet, the take-offs, notes) is drawn into a
  // buffer only when it changes; the top (the shape being drawn, snap / ⊥ markers, crosshair, tooltip,
  // the selection's marching ants and grips, the magnifier) is drawn over a copy of it - so moving the
  // pointer or the ants' animation does not draw thousands of take-offs again.
  const paint = () => {
    raf.current = 0;
    if (!dirty.current && !topDirty.current) return;
    const c = cv.current;
    if (!c) return;
    const t0 = performance.now();
    // the ratio the canvas buffer was sized with (the screen's may have changed since: another
    // monitor, display scaling, remote desktop) - drawing with another one puts everything off
    const dpr = bufDpr.current;
    const { w, h } = size.current;
    let sb = sceneBuf.current;
    if (!sb || sb.width !== c.width || sb.height !== c.height) { sb = sceneBuf.current = new OffscreenCanvas(c.width, c.height); dirty.current = true; }
    let sceneMs = -1;
    if (dirty.current) {
      dirty.current = false;
      const sx = sb.getContext('2d') as unknown as CanvasRenderingContext2D;
      sx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sx.clearRect(0, 0, w, h);
      drawScene(sx, w, h, dpr, false);
      // the selected shapes' numbers, for the top layer (over the ants)
      labOn.current = props.current.selected.size > 0;
      if (labOn.current) {
        let lb = labBuf.current;
        if (!lb || lb.width !== c.width || lb.height !== c.height) lb = labBuf.current = new OffscreenCanvas(c.width, c.height);
        const lx = lb.getContext('2d') as unknown as CanvasRenderingContext2D;
        lx.setTransform(1, 0, 0, 1, 0, 0);
        lx.clearRect(0, 0, lb.width, lb.height);
        lx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawSelLabels(lx, w, h);
      }
      sceneMs = performance.now() - t0;
    }
    topDirty.current = false;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(sb, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTop(ctx, w, h, false);
    if (aids().loupe) drawLoupe(ctx, w, h, dpr);
    paintStat(sceneMs, performance.now() - t0);
  };

  const drawScene = (ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, lp: boolean) => {
    const pr = props.current;
    const v = view.current;
    // paper
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = lp ? 0 : 18;
    ctx.fillStyle = '#fff';
    ctx.fillRect(v.ox, v.oy, turned().w * v.s, turned().h * v.s);
    ctx.restore();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const cmp = pr.compare;
    // (the magnifier shows the current revision only when two are overlaid)
    if (!cmp || (lp && cmp.mode === 'overlay')) { drawSheet(ctx, pr.preview, detail.current); if (lp) drawLoupeSharp(ctx); }
    else if (cmp.mode === 'previous') drawSheet(ctx, cmp.preview, detail2.current, cmp.page);
    else {
      // overlay: current -> blue, previous -> red, multiplied: common lines come out dark
      const W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (!tintCanvas.current || tintCanvas.current.a.width !== W || tintCanvas.current.a.height !== H) {
        tintCanvas.current = { a: new OffscreenCanvas(W, H), b: new OffscreenCanvas(W, H) };
      }
      const layer = (oc: OffscreenCanvas, prev: ImageBitmap | null, det: Detail | null, color: string, page?: { w: number; h: number }) => {
        const x = oc.getContext('2d')!;
        x.setTransform(1, 0, 0, 1, 0, 0);
        x.globalCompositeOperation = 'source-over';
        x.fillStyle = '#fff';
        x.fillRect(0, 0, W, H);
        x.setTransform(dpr, 0, 0, dpr, 0, 0);
        x.imageSmoothingQuality = 'high';
        drawSheet(x, prev, det, page);
        x.setTransform(1, 0, 0, 1, 0, 0);
        x.globalCompositeOperation = 'screen';
        x.fillStyle = color;
        x.fillRect(0, 0, W, H);
      };
      layer(tintCanvas.current.a, pr.preview, detail.current, '#1e6fff');
      layer(tintCanvas.current.b, cmp.preview, detail2.current, '#ff2a2a', cmp.page);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(tintCanvas.current.a, 0, 0);
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(tintCanvas.current.b, 0, 0);
      ctx.restore();
    }

    // v0.18 images put on this sheet (under the take-offs, over the PDF)
    for (const im0 of pr.images ?? []) {
      const dr = drag.current;
      const ibox = dr?.k === 'image' && dr.id === im0.id ? dr.box : im0.box;
      const im = { ...im0, box: ibox };
      const b = boxOnScreen(im.box);
      if (b.x1 < 0 || b.x0 > w || b.y1 < 0 || b.y0 > h) continue;
      ctx.save();
      ctx.transform(...pageMat());
      ctx.drawImage(im.bmp, im.box.x0, im.box.y0, im.box.x1 - im.box.x0, im.box.y1 - im.box.y0);
      ctx.restore();
      ctx.save();
      const picked = imgSel.current === im.id;
      ctx.strokeStyle = im.hi || picked ? '#e8590c' : im.shared ? 'rgba(54,79,199,0.55)' : 'rgba(100,116,139,0.6)';
      ctx.lineWidth = im.hi || picked ? 2 : 1;
      ctx.setLineDash(im.shared || picked ? [] : [5, 4]);
      ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      // (v0.18.1 picked: a handle at each corner - drag one to resize, the picture to move it)
      if (picked) {
        ctx.fillStyle = '#fff';
        ctx.lineWidth = 1.5;
        for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) { ctx.fillRect(x - 5, y - 5, 10, 10); ctx.strokeRect(x - 5, y - 5, 10, 10); }
      }
      ctx.restore();
    }
    // v0.18 another sheet over this one: tinted, multiplied (its paper lets this sheet through), as faint as asked
    const ov = pr.over;
    if (ov && ov.alpha > 0.01) {
      const W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (!overCanvas.current || overCanvas.current.width !== W || overCanvas.current.height !== H) overCanvas.current = new OffscreenCanvas(W, H);
      const x = overCanvas.current.getContext('2d')!;
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.globalCompositeOperation = 'source-over';
      x.fillStyle = '#fff';
      x.fillRect(0, 0, W, H);
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.imageSmoothingQuality = 'high';
      x.transform(...pageMat());
      x.transform(...ov.m);
      if (ov.crop) { x.beginPath(); x.rect(ov.crop.x0, ov.crop.y0, ov.crop.x1 - ov.crop.x0, ov.crop.y1 - ov.crop.y0); x.clip(); }
      if (ov.preview) x.drawImage(ov.preview, 0, 0, ov.page.w, ov.page.h);
      const d = detailO.current;
      if (d && !lp) x.drawImage(d.bmp, d.x0, d.y0, d.bmp.width / d.s, d.bmp.height / d.s);
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.globalCompositeOperation = 'screen';
      x.fillStyle = ov.color;
      x.fillRect(0, 0, W, H);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = Math.min(1, ov.alpha);
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(overCanvas.current, 0, 0);
      ctx.restore();
    }

    // scale regions (viewports with their own scale)
    for (const r of pr.regions) {
      const [ax, ay] = toScreen([r.r.x0, r.r.y0]);
      const [bx, by] = toScreen([r.r.x1, r.r.y1]);
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(122,79,196,0.8)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(ax, ay, bx - ax, by - ay);
      ctx.setLineDash([]);
      label(ctx, scaleText(r.sc, r.scl, r.scy, r.scyl) || 'own scale', ax + 4, ay + 4, 'rgba(122,79,196,0.95)', 'left');
      ctx.restore();
    }

    // shapes
    const dr0 = drag.current;
    const moving = dr0?.k === 'move' ? dr0 : null;
    const mdx = moving ? moving.b[0] - moving.a[0] : 0, mdy = moving ? moving.b[1] - moving.a[1] : 0;
    const vx = dr0?.k === 'vertex' ? dr0 : null;
    const ptR = Math.max(4, Math.min(9, 6 * Math.sqrt(v.s / 0.6)));
    const hid = resumeId.current;
    const F = qtoFmt();
    // take-offs highlighted in the list: the others fade (Display > Fade the others)
    const hiSet = pr.hiItems && pr.hiItems.size ? pr.hiItems : null;
    roomOutl.current = null;
    for (const s of pr.shapes) {
      if (s.id === hid) continue; // being continued: drawn as the line in progress
      const it = pr.items.get(s.ti);
      if (!it) continue;
      const sel = pr.selected.has(s.id);
      // wholly off screen and not being handled: nothing to draw (zoomed in on a sheet with thousands of
      // shapes, every one was painted on each move of the pointer). 300 px over the edge for its labels.
      if (!sel && hoverShape.current !== s.id && !(dr0 && 'id' in dr0 && dr0.id === s.id)) {
        const { x0, x1, y0, y1 } = boxOnScreen(s.box);
        if (x1 < -300 || x0 > w + 300 || y1 < -300 || y0 > h + 300) continue;
      }
      // display: this take-off's own settings, else this PC's (Display)
      const lwk = it.sw ?? F.lw;
      const labMode = it.lab || F.labels;
      // (v0.16 a room's additional floor / ceiling areas and its manual ceiling: hatched, over the room's fill)
      const fillMode = it.fill || (it.rk === 'add' || it.rk === 'ceil' ? 'hatch' : 'solid');
      const ga = (hiSet && !hiSet.has(s.ti) && !sel ? Math.max(0.12, 1 - F.dim) : 1) * (pr.viewOnly?.has(s.id) ? 0.5 : 1);
      const hov = hoverShape.current === s.id && !sel;
      const stale = pr.stale.has(s.id);
      const active = pr.active?.id === s.ti;
      const off = moving && sel && !moving.copy && !moving.skip?.has(s.id) ? [mdx, mdy] : [0, 0];
      const bd = dr0?.k === 'bend' && dr0.id === s.id ? dr0 : null;
      const ringPts = (arr: Pt[], ri: number): Pt[] => {
        if (vx && vx.id === s.id && vx.ring === ri) return vx.insert ? [...arr.slice(0, vx.idx + 1), vx.p, ...arr.slice(vx.idx + 1)] : arr.map((q, i) => (i === vx.idx ? vx.p : q));
        return arr;
      };
      const scr = (arr: Pt[]) => arr.map((q) => toScreen([q[0] + off[0], q[1] + off[1]]));
      // the outline: corners, and the bulge of each segment (arcs)
      const op = ringPts(s.pts, 0);
      let ob = s.b;
      if (vx && vx.id === s.id && vx.ring === 0 && vx.insert && s.b.length) ob = [...s.b.slice(0, vx.idx), 0, 0, ...s.b.slice(vx.idx + 1)];
      if (bd) { ob = [...(s.b.length ? s.b : [])]; while (ob.length <= bd.seg) ob.push(0); ob[bd.seg] = bulgeThrough(op[bd.seg], op[(bd.seg + 1) % op.length], bd.p); }
      const outerFlat = s.k === 'pt' ? op : ob === s.b && op === s.pts ? s.flat : flatten(op, ob, s.k === 'poly');
      const outer = scr(outerFlat);
      ctx.save();
      ctx.globalAlpha = ga;
      if (stale) ctx.setLineDash([7, 5]);
      if (s.k === 'pt' && (it.sk === 'col' || it.sk === 'sw' || it.sk === 'ftg') && pr.colOf?.(s)) {
        // v0.17 a column: its section at the sheet's scale (at least a dot's size), in its type's colour
        const c = pr.colOf(s)!;
        const sc = pr.scaleAt(s.pts[0]);
        for (const [x, y] of outer) {
          const hw0 = sc ? Math.max(ptR, (c.w / sc.x) * v.s / 2) : ptR, hd0 = sc ? Math.max(ptR, ((c.round ? c.w : c.d) / (sc.y ?? sc.x)) * v.s / 2) : ptR;
          // (v0.18 turned with the sheet)
          const hw = rot() % 2 ? hd0 : hw0, hd = rot() % 2 ? hw0 : hd0;
          ctx.beginPath();
          if (c.round) ctx.ellipse(x, y, hw, hd, 0, 0, Math.PI * 2); else ctx.rect(x - hw, y - hd, hw * 2, hd * 2);
          ctx.fillStyle = hexA(c.color, 0.45);
          ctx.fill();
          ctx.lineWidth = sel ? 3 : 1.5;
          ctx.strokeStyle = sel ? '#111' : hov ? '#333' : c.color;
          ctx.stroke();
          if (v.s > 0.08) smallLabel(ctx, c.name, x, y - hd - 8 * fsz(), c.color);
        }
      } else if (s.k === 'pt') {
        for (const [x, y] of outer) {
          ctx.beginPath();
          ctx.arc(x, y, ptR * Math.sqrt(lwk) + (hov ? 1.5 : 0), 0, Math.PI * 2);
          ctx.fillStyle = it.color;
          ctx.fill();
          ctx.lineWidth = sel ? 3 : 1.5;
          ctx.strokeStyle = sel ? '#111' : hov ? '#333' : '#fff';
          ctx.stroke();
          if (s.m !== 1) label(ctx, '×' + s.m, x + ptR + 2, y - ptR - 2, it.color, 'left');
        }
      } else if (s.k === 'line' && it.rk === 'add' && partOutline(s, it.rm ?? '')) {
        // v0.16 an additional wall finish / skirting: a coloured line just inside the room's outline, along
        // its stretch (it lies on the outline: drawn there it would hide the outline's edge)
        const rl = partOutline(s, it.rm ?? '')!;
        const fl = flatten(op, ob, false);
        const inset = 9 + 1.5 * lwk; // (inside the shadow-gap marks, 3.5 and 6.5 px in)
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let j = 0; j + 1 < fl.length; j++) {
          const a = fl[j], b = fl[j + 1];
          const L = dist(a, b);
          if (L < 1e-9) continue;
          const nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
          const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const e = 2 / v.s;
          const k = pointInPoly([mid[0] + nx * e, mid[1] + ny * e], rl.flat) ? 1 : -1;
          const [ax, ay] = toScreen([a[0] + off[0], a[1] + off[1]]), [bx, by] = toScreen([b[0] + off[0], b[1] + off[1]]);
          ctx.moveTo(ax + nx * k * inset, ay + ny * k * inset);
          ctx.lineTo(bx + nx * k * inset, by + ny * k * inset);
        }
        if (hov) { ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 3 + 3 * lwk; ctx.stroke(); }
        ctx.strokeStyle = it.color;
        ctx.globalAlpha = ga * (active || sel ? 1 : 0.9);
        ctx.lineWidth = (sel ? 3.5 : 3) * lwk;
        ctx.stroke();
        ctx.globalAlpha = ga;
      } else if (s.k === 'line') {
        // v0.16 walls / beams: a band of their real width at the sheet's scale (too thin to see: a line)
        let banded = false;
        for (const run of bandsOf(s, op, ob)) {
          if ((run.w / Math.max(run.sx, run.sy)) * v.s < 3 * lwk) continue;
          banded = true;
          ctx.beginPath();
          for (const ring of run.rings) { scr(ring).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
          ctx.fillStyle = hexA(run.color ?? it.color, Math.min(0.85, (sel || hov ? 0.4 : active ? 0.34 : 0.28) * F.fill));
          ctx.fill('evenodd');
          ctx.strokeStyle = run.color ?? it.color;
          ctx.lineWidth = 1.2 * lwk;
          ctx.lineJoin = 'miter';
          ctx.stroke();
        }
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        outer.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        // (selected: the marching ants on top say so - see drawSel)
        if (hov) { ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = (banded ? 3 : 4) + (banded ? 1 : 3) * lwk; ctx.stroke(); }
        ctx.strokeStyle = it.color;
        ctx.globalAlpha = ga * (active || sel ? 1 : 0.85);
        ctx.lineWidth = banded ? 1.5 * lwk : (sel ? 4 : 3) * lwk;
        ctx.stroke();
        // segments with a tag that has a colour (beam types): drawn in it
        if (pr.segTag && s.sg?.some((t) => t)) {
          for (let i = 0; i < op.length - 1; i++) {
            const t = pr.segTag(s, i);
            if (!t?.color) continue;
            const f = scr(flatten([op[i], op[i + 1]], [ob[i] || 0], false));
            ctx.beginPath();
            f.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
            ctx.strokeStyle = t.color;
            ctx.stroke();
          }
        }
        ctx.globalAlpha = ga;
      } else {
        ctx.beginPath();
        const trace = (r: Pt[]) => r.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        trace(outer);
        ctx.closePath();
        s.holes.forEach((hh, hi) => { trace(scr(ringPts(hh, hi + 1))); ctx.closePath(); });
        // (v0.16 a room: a lighter fill - its finishes and doors are drawn over it)
        const fa0 = Math.min(0.85, (sel ? 0.42 : hov ? 0.36 : active ? 0.32 : 0.24) * F.fill * (it.kind === 'room' ? 0.6 : 1));
        if (fillMode === 'hatch') {
          ctx.fillStyle = hexA(it.color, fa0 * 0.35);
          ctx.fill('evenodd');
          const pat = hatch(ctx, it.color);
          if (pat) { ctx.fillStyle = pat; ctx.fill('evenodd'); }
        } else if (fillMode !== 'none' || sel || hov) {
          // no fill: still a light one while selected / under the pointer, to see what it covers
          ctx.fillStyle = hexA(it.color, fillMode === 'none' ? 0.12 : fa0);
          ctx.fill('evenodd');
        }
        ctx.lineJoin = 'round';
        if (hov) { ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 3 + 1.5 * lwk; ctx.stroke(); }
        ctx.strokeStyle = it.color;
        ctx.lineWidth = (sel ? 2.5 : 1.6) * lwk;
        // v0.16 a room: its open edges (no wall) dashed, its shadow-gap edges with a thin double line inside
        const flags = op.length === s.pts.length && s.sg.some((t) => !!t) ? s.sg : null;
        const n0 = op.length;
        const edge = (i: number) => scr(flatten([op[i], op[(i + 1) % n0]], [ob[i] || 0], false));
        if (flags && it.kind === 'room' && flags.some((t) => edgeFlags(t).open)) {
          const dash = stale ? [7, 5] : [];
          for (const open of [false, true]) {
            ctx.beginPath();
            for (let i = 0; i < n0; i++) if (edgeFlags(flags[i]).open === open) edge(i).forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
            if (!open) s.holes.forEach((hh, hi) => { trace(scr(ringPts(hh, hi + 1))); ctx.closePath(); });
            ctx.setLineDash(open ? [9, 6] : dash);
            ctx.stroke();
          }
          ctx.setLineDash(dash);
        } else ctx.stroke();
        if (flags && (it.kind === 'room' || it.rk === 'ceil' || it.rk === 'add') && flags.some((t) => edgeFlags(t).gap)) {
          const k = insideSign(s);
          ctx.save();
          ctx.setLineDash([]);
          ctx.lineCap = 'butt';
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          for (let i = 0; i < n0; i++) {
            if (!edgeFlags(flags[i]).gap) continue;
            const f = flatten([op[i], op[(i + 1) % n0]], [ob[i] || 0], false);
            for (let j = 0; j + 1 < f.length; j++) {
              const nn = insideNormal(s, f[j], f[j + 1], k);
              const a = toScreen([f[j][0] + off[0], f[j][1] + off[1]]), b = toScreen([f[j + 1][0] + off[0], f[j + 1][1] + off[1]]);
              for (const d of [3.5, 6.5]) { ctx.moveTo(a[0] + nn[0] * d, a[1] + nn[1] * d); ctx.lineTo(b[0] + nn[0] * d, b[1] + nn[1] * d); }
            }
          }
          ctx.stroke();
          ctx.restore();
        }
      }
      // (segments picked in the segment table: marching ants on top, see drawSel)
      ctx.setLineDash([]);
      // its numbers (a selected shape's: on top, over its marching ants - see drawSel)
      if (!sel) drawShapeLabels(ctx, s, op, ob, outerFlat, off as Pt, false, hov, ga);
      ctx.restore();
    }
    // doors and openings on the walls: a gap across the wall, ticks at its sides, its tag
    for (const o of pr.openings ?? []) {
      const a = toScreen(o.a), b = toScreen(o.b);
      if (Math.max(a[0], b[0]) < -200 || Math.min(a[0], b[0]) > w + 200 || Math.max(a[1], b[1]) < -200 || Math.min(a[1], b[1]) > h + 200) continue;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      // (a wall drawn as a band: the gap goes right across it)
      let half = 0;
      if (o.band && L > 0.5) {
        const sc = pr.scaleAt([(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2]);
        if (sc) half = bandHalf(o.band, (b[0] - a[0]) / L, (b[1] - a[1]) / L, sc.x, sc.y) * v.s;
      }
      ctx.save();
      ctx.lineCap = 'butt';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(7, 2 * half + 2);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.strokeStyle = o.color;
      ctx.lineWidth = 1.6;
      ctx.setLineDash(o.k === 'door' ? [] : [3, 2]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.setLineDash([]);
      if (L > 0.5) {
        const tk = Math.max(6, half + 3);
        const nx = -(b[1] - a[1]) / L * tk, ny = (b[0] - a[0]) / L * tk;
        ctx.lineWidth = 2;
        for (const q of [a, b]) { ctx.beginPath(); ctx.moveTo(q[0] - nx, q[1] - ny); ctx.lineTo(q[0] + nx, q[1] + ny); ctx.stroke(); }
      }
      if (o.label && v.s > 0.06) smallLabel(ctx, o.label, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 15 * fsz(), o.color);
      ctx.restore();
    }
    // auto-count: what was found, to keep (filled) or leave out (hollow, crossed)
    if (pr.proposals) {
      const r = Math.max(6, ptR + 2);
      pr.proposals.forEach((q, i) => {
        const [x, y] = toScreen(q.p);
        if (x < -20 || y < -20 || x > w + 20 || y > h + 20) return;
        ctx.save();
        // v0.16.6 a beam mark: its segment in the type's colour (to keep), a line from the mark to it
        if (q.seg && q.to) {
          const [a, b] = [toScreen(q.seg[0]), toScreen(q.seg[1])];
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
          ctx.strokeStyle = q.on ? (q.color ?? '#157f54') : 'rgba(150,160,158,0.6)';
          ctx.globalAlpha = q.on ? 0.55 : 0.4;
          ctx.lineWidth = 7;
          ctx.stroke();
          ctx.globalAlpha = 1;
          const t = toScreen(q.to);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(t[0], t[1]);
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = q.on ? '#157f54' : '#9aa5a3';
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = q.on ? 'rgba(21,127,84,0.35)' : 'rgba(255,255,255,0.6)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = q.on ? '#157f54' : '#9aa5a3';
        ctx.stroke();
        if (!q.on) { ctx.beginPath(); ctx.moveTo(x - r * 0.6, y - r * 0.6); ctx.lineTo(x + r * 0.6, y + r * 0.6); ctx.moveTo(x + r * 0.6, y - r * 0.6); ctx.lineTo(x - r * 0.6, y + r * 0.6); ctx.stroke(); }
        if (hoverScreen.current && dist(hoverScreen.current, [x, y]) < r + 3) label(ctx, `${q.label} · ${q.on ? 'click to leave out' : 'click to take back'} (${i + 1})`, x + r + 4, y + 4, q.on ? '#157f54' : '#555', 'left');
        ctx.restore();
      });
    }
    // copies being dragged
    if (moving && moving.copy) {
      ctx.save();
      ctx.globalAlpha = 0.6;
      for (const s of pr.shapes) {
        if (!pr.selected.has(s.id) || moving.skip?.has(s.id)) continue;
        const it = pr.items.get(s.ti);
        ctx.strokeStyle = it?.color ?? '#333';
        ctx.lineWidth = 2;
        ctx.beginPath();
        s.flat.map((q) => toScreen([q[0] + mdx, q[1] + mdy])).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        if (s.k === 'poly') ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    }

    // notes pinned on the sheet
    for (const n of pr.notes) {
      if (n.x === null || n.y === null) continue;
      const [x, y] = toScreen([n.x, n.y]);
      ctx.save();
      ctx.fillStyle = n.done ? '#9aa5a3' : '#f2b705';
      ctx.strokeStyle = '#4a3b00';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 6, y - 9);
      ctx.lineTo(x + 20, y - 9);
      ctx.lineTo(x + 20, y - 25);
      ctx.lineTo(x - 4, y - 25);
      ctx.lineTo(x - 4, y - 9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#4a3b00';
      ctx.font = '700 11px Inter Variable, sans-serif';
      ctx.fillText('✎', x + 2, y - 13);
      ctx.restore();
    }

    // a finished ruler measurement (not saved)
    const mz = measured.current;
    if (mz && mz.length >= 2) drawMeasure(ctx, mz, false);
  };

  /** the top layer (see paint); lp = drawn in the magnifier (no tooltip, no full-length crosshair) */
  const drawTop = (ctx: CanvasRenderingContext2D, w: number, h: number, lp: boolean) => {
    const pr = props.current;
    const v = view.current;
    drawSel(ctx, w, h, lp);
    // v0.16.4 a door / an opening being dragged along its edge: where it goes
    const od = drag.current;
    if (od?.k === 'opening' && od.moved && od.at) {
      const o = (pr.openings ?? []).find((x) => x.id === od.id);
      const c = o ? slideOnEdge(o, od.at) : null;
      if (o && c) {
        const hx = (o.b[0] - o.a[0]) / 2, hy = (o.b[1] - o.a[1]) / 2;
        const a = toScreen([c[0] - hx, c[1] - hy]), b = toScreen([c[0] + hx, c[1] + hy]);
        ctx.save();
        ctx.strokeStyle = o.color;
        ctx.lineWidth = 4;
        ctx.setLineDash([5, 3]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        ctx.setLineDash([]);
        if (o.label) smallLabel(ctx, o.label, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 15 * fsz(), o.color);
        ctx.restore();
      }
    }
    // in progress
    const tool = pr.tool;
    const P = pts.current;
    const hv = hover.current;
    const col = pr.active?.color ?? '#d6af67';
    if (P.length && DRAW_TOOLS.includes(tool)) {
      const pg = progress(hv);
      if (tool === 'measure') drawMeasure(ctx, flatten(pg.pts, pg.b, false), true);
      else {
        ctx.save();
        let shape: Pt[];
        if (tool === 'rect') shape = hv ? rectOf(P[0], nextPoint(hv)) : P;
        else if (tool === 'circle') shape = hv ? flatten(...circleOf(P[0], nextPoint(hv)), true) : P;
        else {
          // (v0.17 continuing from a node: the rest of the shape after the pointer)
          const tl = tail.current;
          shape = tl && !tl.rev && tl.pts.length ? flatten([...pg.pts, ...tl.pts], [...pg.b, 0, ...tl.bul.slice(0, tl.pts.length - 1)], false) : flatten(pg.pts, pg.b, false);
        }
        // v0.16 a wall / beam being drawn: its band too (the width of the take-off measured into)
        if (tool === 'line' && pr.drawBand && shape.length >= 2) {
          const sc = pr.scaleAt(P[0]);
          if (sc && (pr.drawBand / Math.max(sc.x, sc.y)) * v.s >= 3) {
            ctx.beginPath();
            const closed = shape.length > 2 && dist(shape[0], shape[shape.length - 1]) < 0.01;
            for (const ring of bandOutline(shape, pr.drawBand / 2, sc.x, sc.y, closed)) { ring.map(toScreen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
            ctx.fillStyle = hexA(col, 0.26);
            ctx.fill('evenodd');
          }
        }
        const scrS = shape.map(toScreen);
        ctx.beginPath();
        scrS.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        const closedish = tool === 'area' || tool === 'hole' || tool === 'rect' || tool === 'circle';
        const asLine = (tool === 'rect' || tool === 'circle') && pr.closedAs === 'line';
        if (closedish && shape.length >= 3) {
          ctx.closePath();
          if (!asLine) {
            ctx.fillStyle = hexA(tool === 'hole' || pr.closedAs === 'hole' ? '#ffffff' : col, tool === 'hole' || pr.closedAs === 'hole' ? 0.6 : 0.22);
            ctx.fill();
          }
        }
        ctx.setLineDash(tool === 'hole' || pr.closedAs === 'hole' ? [5, 4] : []);
        ctx.strokeStyle = tool === 'scale' ? '#7a4fc4' : tool === 'hole' || pr.closedAs === 'hole' ? '#222' : col;
        ctx.lineWidth = tool === 'line' || asLine ? 3 : 2.2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.setLineDash([]);
        // arc mode, end not chosen yet: the chord, dashed
        if (pg.chord) {
          const [a, b] = pg.chord.map(toScreen);
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        if (tool === 'circle' && hv) {
          const [cx0, cy0] = toScreen(P[0]);
          const [rx, ry] = toScreen(nextPoint(hv));
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cx0, cy0);
          ctx.lineTo(rx, ry);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        const fixed = (tool === 'rect' || tool === 'circle' ? [P[0]] : P).map(toScreen);
        fixed.forEach(([x, y], i) => {
          const last = i === fixed.length - 1;
          ctx.fillStyle = last ? col : '#fff';
          ctx.strokeStyle = '#222';
          ctx.lineWidth = 1.2;
          ctx.fillRect(x - (last ? 4 : 3), y - (last ? 4 : 3), last ? 8 : 6, last ? 8 : 6);
          ctx.strokeRect(x - (last ? 4 : 3), y - (last ? 4 : 3), last ? 8 : 6, last ? 8 : 6);
        });
        // the chosen end of an arc
        if (arcEnd.current) {
          const [x, y] = toScreen(arcEnd.current);
          ctx.beginPath();
          ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.strokeStyle = col;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        // closing hint: clicking the first point closes the shape
        if ((tool === 'area' || tool === 'hole') && P.length >= 3 && hv && !arcMode.current && dist(toScreen(hv), toScreen(P[0])) < 12) {
          const [x0, y0] = toScreen(P[0]);
          ctx.beginPath();
          ctx.arc(x0, y0, 10, 0, Math.PI * 2);
          ctx.strokeStyle = '#157f54';
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    const dr = drag.current;
    if (dr && (dr.k === 'box' || dr.k === 'region')) {
      const [ax, ay] = toScreen(dr.a);
      const [bx, by] = toScreen(dr.b);
      // v0.16 selection box: left -> right = window (solid, blue), right -> left = crossing (dashed, green)
      const crossing = dr.k === 'box' && bx < ax;
      ctx.save();
      ctx.setLineDash(dr.k === 'region' || crossing ? [5, 4] : []);
      ctx.strokeStyle = dr.k === 'region' ? '#7a4fc4' : crossing ? '#2b8a3e' : '#2f6fd1';
      ctx.fillStyle = dr.k === 'region' ? 'rgba(122,79,196,0.08)' : crossing ? 'rgba(43,138,62,0.12)' : 'rgba(47,111,209,0.12)';
      ctx.lineWidth = 1.4;
      ctx.fillRect(ax, ay, bx - ax, by - ay);
      ctx.strokeRect(ax, ay, bx - ax, by - ay);
      ctx.restore();
    }
    // D / O: where on which wall the door / opening would go
    if (placing.current && hv) {
      const at = wallAt(hv);
      if (at) {
        const [x, y] = toScreen(at.p);
        ctx.save();
        ctx.strokeStyle = placing.current === 'door' ? '#1864ab' : '#7a4fc4';
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }
    // v0.16 picking edges (shadow gap / open edge): the edges with the flag now, and the one under the pointer
    const ep = pr.edgePick;
    if (ep) {
      const path = (s: Shape, i: number) => flatten([s.pts[i], s.pts[(i + 1) % s.pts.length]], [s.b[i] || 0], false).map(toScreen);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (const s of pr.shapes) {
        if (!ep.shapes.has(s.id) || s.k !== 'poly') continue;
        for (let i = 0; i < s.pts.length; i++) {
          const f = edgeFlags(s.sg[i]);
          if (ep.flag === 'gap' ? f.gap : ep.flag === 'open' ? f.open : false) path(s, i).forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        }
      }
      ctx.strokeStyle = 'rgba(242,183,5,0.7)';
      ctx.lineWidth = 8;
      ctx.stroke();
      const he = hoverEdge.current;
      const hs = he ? pr.shapes.find((x) => x.id === he.shape) : null;
      if (he && hs && !lp) {
        ctx.beginPath();
        path(hs, he.seg).forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.strokeStyle = 'rgba(18,122,114,0.85)';
        ctx.lineWidth = 5;
        ctx.stroke();
      }
      ctx.restore();
    }
    // v0.16.5 the open edge picked (Select tool): Del makes it a wall edge
    const es = pr.edgeSel ? pr.shapes.find((x) => x.id === pr.edgeSel!.shape) : null;
    if (es && pr.edgeSel && es.k === 'poly' && pr.edgeSel.seg < es.pts.length) {
      const i = pr.edgeSel.seg;
      const pp = flatten([es.pts[i], es.pts[(i + 1) % es.pts.length]], [es.b[i] || 0], false).map(toScreen);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pp.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.strokeStyle = 'rgba(242,183,5,0.55)';
      ctx.lineWidth = 10;
      ctx.stroke();
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = 'rgba(180,83,9,0.95)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
    // snap marker + what it snapped to
    const sh = snapHit.current;
    const drawing = (tool !== 'select' || dr?.k === 'vertex') && !placing.current;
    if (sh && hv && drawing) {
      const [x, y] = toScreen([sh.x, sh.y]);
      ctx.save();
      ctx.strokeStyle = sh.own ? '#157f54' : '#e8590c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (sh.k === 'end') ctx.rect(x - 6, y - 6, 12, 12);
      else if (sh.k === 'mid') { ctx.moveTo(x, y - 7); ctx.lineTo(x + 7, y + 6); ctx.lineTo(x - 7, y + 6); ctx.closePath(); }
      else { ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6); ctx.moveTo(x + 6, y - 6); ctx.lineTo(x - 6, y + 6); }
      ctx.stroke();
      ctx.restore();
    }
    // v0.16 ⊥ perpendicular snap (ortho): the foot on the take-off, and the right angle there
    const pf = perpHit.current;
    if (pf && hv && drawing) {
      const [x, y] = toScreen(pf.p);
      const a = toScreen(pf.seg.a), b = toScreen(pf.seg.b);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
      // (on the side of the element the last node is on)
      const lastS = P.length ? toScreen(P[P.length - 1]) : null;
      const sd = lastS && (lastS[0] - x) * -uy + (lastS[1] - y) * ux < 0 ? -1 : 1;
      const nx = -uy * sd, ny = ux * sd;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.beginPath();
      // the ⊥ sign drawn along the element: its base on the element, its stem across it, a right-angle mark
      ctx.moveTo(x - ux * 10, y - uy * 10); ctx.lineTo(x + ux * 10, y + uy * 10);
      ctx.moveTo(x, y); ctx.lineTo(x + nx * 13, y + ny * 13);
      ctx.moveTo(x + ux * 5, y + uy * 5); ctx.lineTo(x + ux * 5 + nx * 5, y + uy * 5 + ny * 5); ctx.lineTo(x + nx * 5, y + ny * 5);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 4.5;
      ctx.stroke();
      ctx.strokeStyle = '#157f54';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
    // v0.16 crosshair: lines across the whole drawing area through the pointer
    if (hoverScreen.current && pointerIn.current && aids().cross && !lp) {
      const [x, y] = hv && drawing ? toScreen(hv) : hoverScreen.current;
      ctx.save();
      ctx.strokeStyle = 'rgba(9,48,47,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5);
      ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h);
      ctx.stroke();
      ctx.restore();
    }
    // an end grip clicked: the length typed for its segment, next to the pointer
    if (gripLen.current && hoverScreen.current && !lp) {
      const [x, y] = hoverScreen.current;
      label(ctx, typed.current ? `end segment → ${typed.current}▌  = ${typedLabel(typed.current)} (Enter)` : 'type the length of this end segment, then Enter', x + 16, y + 14, '#e8590c', 'left');
    }
    // crosshair + tooltip next to the pointer (segment length / angle / typed length / snap)
    if (hv && drawing && !lp) {
      const [x, y] = toScreen(hv);
      ctx.save();
      ctx.strokeStyle = 'rgba(9,48,47,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - 14, y); ctx.lineTo(x - 4, y); ctx.moveTo(x + 4, y); ctx.lineTo(x + 14, y);
      ctx.moveTo(x, y - 14); ctx.lineTo(x, y - 4); ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 14);
      ctx.stroke();
      ctx.restore();
      const tip: string[] = [];
      if (P.length && DRAW_TOOLS.includes(tool) && tool !== 'scale') {
        const a = P[P.length - 1];
        const b = nextPoint(hv);
        const ang = (Math.atan2(-(b[1] - a[1]), b[0] - a[0]) * 180) / Math.PI;
        const e = arcEnd.current;
        const len = (q: Pt[], bb: number[]) => pr.measure(q, bb, false)?.len ?? null;
        if (tool === 'rect') {
          const sc = pr.scaleAt([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
          if (sc) tip.push(`${fm(Math.abs(b[0] - a[0]) * sc.x)} × ${fm(Math.abs(b[1] - a[1]) * sc.y)} m`);
        } else if (tool === 'circle') {
          const sc = pr.scaleAt(P[0]);
          // (a separate up-down scale makes the circle an ellipse in reality: both half-axes)
          if (sc) tip.push(sc.x === sc.y ? `radius ${fm(dist(P[0], b) * sc.x)} m` : `half-axes ${fm(dist(P[0], b) * sc.x)} × ${fm(dist(P[0], b) * sc.y)} m (across × up-down)`);
        } else if (e && ARC_TOOLS.includes(tool)) {
          const la = len([a, e], [bulgeThrough(a, e, hv)]), lc = len([a, e], [0]);
          if (la !== null && lc !== null) tip.push(`arc ${fm(la)} m · chord ${fm(lc)} m`);
          tip.push('click a point the arc passes through');
        } else {
          const l = len([a, b], [0]);
          if (l !== null) tip.push(`${fm(l)} m  ${Math.round((ang + 360) % 360)}°${arcMode.current && ARC_TOOLS.includes(tool) ? ' · arc: click where it ends' : ''}`);
        }
      }
      if (typed.current) tip.push(`→ ${typed.current}▌  = ${typedLabel(typed.current)} (Enter)`);
      if (pf && P.length) tip.push('⊥ Perpendicular');
      else if (sh && dist([sh.x, sh.y], hv) < 0.01) tip.push(SNAP_LABEL[sh.own ? 'own' : sh.k]);
      else if (P.length && orthoNow() && tool !== 'rect' && !arcEnd.current) tip.push('Ortho');
      if (tip.length) label(ctx, tip.join('  ·  '), x + 16, y + 14, typed.current ? '#e8590c' : 'rgba(9,48,47,0.7)', 'left');
    }
    if (hv && placing.current && !lp) {
      const [x, y] = toScreen(hv);
      label(ctx, `click on the ${placeOn()} where the ${placing.current === 'door' ? 'door' : 'opening'} is`, x + 16, y + 14, placing.current === 'door' ? '#1864ab' : '#7a4fc4', 'left');
    }
    // other people's pointers on this sheet
    for (const o of pr.others) {
      const [x, y] = toScreen([o.x, o.y]);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      ctx.save();
      ctx.fillStyle = o.color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x + 4, y + 15); ctx.lineTo(x + 7.5, y + 9); ctx.lineTo(x + 14, y + 9); ctx.closePath();
      ctx.fill();
      ctx.stroke();
      label(ctx, o.name.split(/[\s._-]/)[0], x + 12, y + 14, o.color, 'left');
      ctx.restore();
    }
  };

  /** a shape's numbers: segment tags, each segment's length (one length selected), its quantity */
  const drawShapeLabels = (ctx: CanvasRenderingContext2D, s: Shape, op: Pt[], ob: number[], outerFlat: Pt[], off: Pt, sel: boolean, hov: boolean, ga: number) => {
    const pr = props.current;
    const v = view.current;
    const it = pr.items.get(s.ti);
    if (!it) return;
    const F = qtoFmt();
    const labMode = it.lab || F.labels;
    const stale = pr.stale.has(s.id);
    // segment tags: on the selected shape, or always (Display > Segment tags)
    if (pr.segTag && s.k !== 'pt' && s.sg?.some((t) => t) && (sel || F.tags === 'always') && v.s > 0.08) {
      const n0 = op.length;
      for (let i = 0; i < (s.k === 'poly' ? n0 : n0 - 1); i++) {
        const t = pr.segTag(s, i);
        if (!t?.text) continue;
        const a = toScreen(op[i]), c = toScreen(op[(i + 1) % n0]);
        if (Math.hypot(c[0] - a[0], c[1] - a[1]) < 34) continue;
        const [mx, my] = toScreen(segMid(op[i], op[(i + 1) % n0], ob[i] || 0));
        smallLabel(ctx, t.text, mx + off[0] * v.s, my + off[1] * v.s + 13 * fsz(), t.color || it.color);
      }
    }
    const alone = sel && s.k !== 'pt' && pr.selected.size === 1;
    // one length selected: the length of each of its segments (to see where to split it)
    if (alone && s.k === 'line' && op.length >= 3 && v.s > 0.15) {
      for (let i = 0; i < op.length - 1; i++) {
        const a = toScreen(op[i]), c = toScreen(op[i + 1]);
        if (Math.hypot(c[0] - a[0], c[1] - a[1]) < 60) continue;
        const sq = pr.measure([op[i], op[i + 1]], [ob[i] || 0], false);
        if (!sq) continue;
        const [mx, my] = toScreen(segMid(op[i], op[i + 1], ob[i] || 0));
        smallLabel(ctx, fm(sq.len) + ' m', mx + off[0] * v.s, my + off[1] * v.s - 14 * fsz(), it.color);
      }
    }
    // the shape's numbers: selected always; under the pointer unless "never"; all the time with "always"
    const showLab = sel || (hov && labMode !== 'never') || (labMode === 'always' && ga === 1);
    // v0.16 a room: its name always (screen-sized, like every label), its area under it as the numbers are
    if (it.kind === 'room' && s.k === 'poly') {
      const [lx, ly] = toScreen(((c) => [c[0] + off[0], c[1] + off[1]] as Pt)(centroid(outerFlat)));
      label(ctx, it.name + (s.m !== 1 ? ' ×' + s.m : ''), lx, ly, it.color, 'center');
      if (showLab) label(ctx, pr.labelFor(s) + (stale && (sel || hov) ? ' · measured on an earlier revision' : ''), lx, ly + 22 * fsz(), stale ? '#b45309' : it.color, 'center');
      return;
    }
    if ((showLab || s.m !== 1) && s.k !== 'pt') {
      const c0 = s.k === 'poly' ? centroid(outerFlat) : outerFlat[Math.floor((outerFlat.length - 1) / 2)];
      const [lx, ly0] = toScreen([c0[0] + off[0], c0[1] + off[1]]);
      // (a selected line's number sits on a node: just above it, clear of the grip)
      const ly = sel && s.k === 'line' ? ly0 - 17 * fsz() : ly0;
      const txt = (showLab ? pr.labelFor(s) : '') + (s.m !== 1 ? ' ×' + s.m : '') + (stale && (sel || hov) ? ' · measured on an earlier revision' : '');
      label(ctx, txt.trim(), lx, ly, stale ? '#b45309' : it.color, 'center');
    }
  };

  // ---------- v0.16 the selection: marching ants + grips ----------
  /** a shape's outline as on screen now: a node being dragged, an arc being bent, the selection being moved */
  const liveGeom = (s: Shape) => {
    const d = drag.current;
    const vx = d?.k === 'vertex' && d.id === s.id ? d : null;
    const bd = d?.k === 'bend' && d.id === s.id ? d : null;
    const off: Pt = d?.k === 'move' && !d.copy && props.current.selected.has(s.id) && !d.skip?.has(s.id) ? [d.b[0] - d.a[0], d.b[1] - d.a[1]] : [0, 0];
    const ringPts = (arr: Pt[], ri: number): Pt[] => (vx && vx.ring === ri ? (vx.insert ? [...arr.slice(0, vx.idx + 1), vx.p, ...arr.slice(vx.idx + 1)] : arr.map((q, i) => (i === vx.idx ? vx.p : q))) : arr);
    const op = ringPts(s.pts, 0);
    let ob = s.b;
    if (vx && vx.ring === 0 && vx.insert && s.b.length) ob = [...s.b.slice(0, vx.idx), 0, 0, ...s.b.slice(vx.idx + 1)];
    if (bd) { ob = [...(s.b.length ? s.b : [])]; while (ob.length <= bd.seg) ob.push(0); ob[bd.seg] = bulgeThrough(op[bd.seg], op[(bd.seg + 1) % op.length], bd.p); }
    const holes = s.holes.map((hh, hi) => ringPts(hh, hi + 1));
    return { op, ob, holes, off };
  };
  /** the two-tone marching ants along a path on screen (constant width and dash at any zoom) */
  const ants = (ctx: CanvasRenderingContext2D, paths: { p: Pt[]; closed: boolean }[]) => {
    if (!paths.length) return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.beginPath();
    for (const { p, closed } of paths) { p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (closed) ctx.closePath(); }
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 3.4;
    ctx.stroke();
    ctx.setLineDash([6, 5]);
    ctx.lineDashOffset = -antPhase();
    ctx.strokeStyle = '#0b1f1e';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  };
  /** filled square grips (constant size on screen): cold teal, gold under the pointer, orange while dragged
   *  or waiting for a typed length */
  const drawGrips = (ctx: CanvasRenderingContext2D, at: Pt[], state: 'cold' | 'hover' | 'hot' | 'armed') => {
    const g = state === 'cold' ? 4 : 5;
    ctx.beginPath();
    for (const [x, y] of at) ctx.rect(Math.round(x) - g, Math.round(y) - g, 2 * g, 2 * g);
    ctx.fillStyle = state === 'hot' || state === 'armed' ? '#e8590c' : state === 'hover' ? '#f2b705' : '#127a72';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    for (const [x, y] of at) ctx.rect(Math.round(x) - g - 1, Math.round(y) - g - 1, 2 * g + 2, 2 * g + 2);
    ctx.strokeStyle = 'rgba(9,48,47,0.85)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  };
  /** every selected shape (and the segments picked in the segment table): ants, grips at every node */
  /** the numbers of the selected shapes (see drawSel) */
  const drawSelLabels = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const pr = props.current;
    const v = view.current;
    const d = drag.current;
    for (const s of pr.shapes) {
      if (!pr.selected.has(s.id) || s.k === 'pt' || s.id === resumeId.current) continue;
      const { x0, x1, y0, y1 } = boxOnScreen(s.box);
      if (d?.k !== 'move' && !(d && 'id' in d && d.id === s.id) && (x1 < -300 || x0 > w + 300 || y1 < -300 || y0 > h + 300)) continue;
      const { op, ob, off } = liveGeom(s);
      ctx.save();
      drawShapeLabels(ctx, s, op, ob, flatten(op, ob, s.k === 'poly'), off, true, false, 1);
      ctx.restore();
    }
  };
  const drawSel = (ctx: CanvasRenderingContext2D, w: number, h: number, lp = false) => {
    const pr = props.current;
    const v = view.current;
    const hs = pr.segHi;
    if (!pr.selected.size && !hs) return;
    const d = drag.current;
    const hg = hoverGrip.current, gl = gripLen.current;
    const ptR = Math.max(4, Math.min(9, 6 * Math.sqrt(v.s / 0.6)));
    const F = qtoFmt();
    const many = pr.selected.size;
    // (all the ants in one path, the grips in one batch per colour: thousands selected stay cheap)
    const paths: { p: Pt[]; closed: boolean }[] = [];
    const dots: { x: number; y: number; arc: boolean }[] = [];
    const grips: Record<'cold' | 'hover' | 'hot' | 'armed', Pt[]> = { cold: [], hover: [], hot: [], armed: [] };
    for (const s of pr.shapes) {
      const sel = pr.selected.has(s.id);
      const segs = hs && hs.shape === s.id ? hs.segs : null;
      if (!sel && !segs) continue;
      if (s.id === resumeId.current) continue;
      if (!sel && !pickable(s)) continue;
      const { x0, x1, y0, y1 } = boxOnScreen(s.box);
      const dragged = d && 'id' in d && d.id === s.id;
      if (!dragged && d?.k !== 'move' && (x1 < -20 || x0 > w + 20 || y1 < -20 || y0 > h + 20)) continue;
      const { op, ob, holes, off } = liveGeom(s);
      const scr = (arr: Pt[]) => arr.map((q) => toScreen([q[0] + off[0], q[1] + off[1]]));
      if (s.k === 'pt') {
        const lwk = pr.items.get(s.ti)?.sw ?? F.lw;
        const r = ptR * Math.sqrt(lwk) + 4;
        for (const [x, y] of scr(op)) {
          const c: Pt[] = [];
          for (let i = 0; i < 24; i++) c.push([x + r * Math.cos((i / 24) * Math.PI * 2), y + r * Math.sin((i / 24) * Math.PI * 2)]);
          paths.push({ p: c, closed: true });
        }
        continue;
      }
      // the ants: the picked segments only, else the whole outline and its cut-outs
      if (segs) {
        const n0 = op.length;
        for (const i of segs) if (i >= 0 && i < (s.k === 'poly' ? n0 : n0 - 1)) paths.push({ p: scr(flatten([op[i], op[(i + 1) % n0]], [ob[i] || 0], false)), closed: false });
      } else {
        paths.push({ p: scr(flatten(op, ob, s.k === 'poly')), closed: s.k === 'poly' });
        for (const hh of holes) paths.push({ p: scr(hh), closed: true });
      }
      if (!sel || pr.readOnly || pr.viewOnly?.has(s.id)) continue;
      const rings = [op, ...holes];
      // one shape selected: a round dot in the middle of every edge (straight: drag to add a node; arc: reshape it)
      if (many === 1) {
        rings.forEach((r, ri) => {
          const closed = ri > 0 || s.k === 'poly';
          const b = ri === 0 ? ob : [];
          const n = r.length;
          for (let i = 0; i < (closed ? n : n - 1); i++) {
            const a = toScreen(r[i]), c = toScreen(r[(i + 1) % n]);
            if (Math.hypot(c[0] - a[0], c[1] - a[1]) < 26 && !b[i]) continue;
            const [mx, my] = toScreen(segMid(r[i], r[(i + 1) % n], b[i] || 0));
            dots.push({ x: mx + off[0] * v.s, y: my + off[1] * v.s, arc: !!b[i] });
          }
        });
      }
      // grips at every node; the one under the pointer / being dragged / waiting for a typed length stands out
      const vx = d?.k === 'vertex' && d.id === s.id ? d : null;
      rings.forEach((r, ri) => {
        scr(r).forEach(([x, y], i) => {
          if (x < -10 || y < -10 || x > w + 10 || y > h + 10) return;
          const idx = vx && vx.ring === ri && vx.insert && i > vx.idx ? i - 1 : i;
          const isNew = !!vx && vx.ring === ri && vx.insert && i === vx.idx + 1;
          const hot = !!vx && vx.moved && vx.ring === ri && (vx.insert ? isNew : idx === vx.idx);
          const hov = !hot && !isNew && !!hg && hg.id === s.id && hg.ring === ri && hg.idx === idx;
          const armed = !!gl && gl.id === s.id && ri === 0 && gl.idx === idx;
          grips[hot ? 'hot' : armed ? 'armed' : hov ? 'hover' : 'cold'].push([x, y]);
        });
      });
    }
    ants(ctx, paths);
    // the selected shapes' numbers over their ants, under their grips (drawn with the scene, copied here:
    // the ants' frames do not draw thousands of labels again)
    if (lp) drawSelLabels(ctx, w, h);
    else if (labBuf.current && labOn.current) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(labBuf.current, 0, 0); ctx.restore(); }
    if (dots.length) {
      ctx.save();
      for (const arc of [false, true]) {
        const list = dots.filter((q) => q.arc === arc);
        if (!list.length) continue;
        ctx.beginPath();
        for (const q of list) { ctx.moveTo(q.x + 3.6, q.y); ctx.arc(q.x, q.y, 3.6, 0, Math.PI * 2); }
        ctx.fillStyle = arc ? 'rgba(255,224,160,0.95)' : 'rgba(255,255,255,0.9)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.save();
    for (const k of ['cold', 'hover', 'armed', 'hot'] as const) if (grips[k].length) drawGrips(ctx, grips[k], k);
    ctx.restore();
  };

  // ---------- v0.16 the magnifier ----------
  const LOUPE = 180;
  /** where the loupe looks: the point a click would put down (snapped / ortho), else the pointer */
  const loupeAt = (): Pt | null => {
    const hv = hover.current;
    const d = drag.current;
    if (d?.k === 'vertex') return d.p;
    if (!hv) return hoverScreen.current ? toSheet(hoverScreen.current[0], hoverScreen.current[1]) : null;
    const pr = props.current;
    return pr.tool !== 'select' && pts.current.length ? nextPoint(hv) : hv;
  };
  const drawLoupe = (ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number) => {
    const ps = hoverScreen.current;
    const c = loupeAt();
    if (!ps || !c || !pointerIn.current) return;
    const z = aids().zoom, R = LOUPE / 2, gap = 26;
    // beside the pointer (up and to the right), the other side near an edge of the drawing area
    let lx = ps[0] + gap + R, ly = ps[1] - gap - R;
    if (lx + R > w - 4) lx = ps[0] - gap - R;
    if (ly - R < 4) ly = ps[1] + gap + R;
    if (ly + R > h - 4) ly = Math.max(R + 4, h - R - 4);
    if (lx - R < 4) lx = Math.min(w - R - 4, R + 4);
    const px = Math.round(LOUPE * dpr);
    let lb = loupeBuf.current;
    if (!lb || lb.width !== px) lb = loupeBuf.current = new OffscreenCanvas(px, px);
    const lc = lb.getContext('2d') as unknown as CanvasRenderingContext2D;
    const v0 = view.current;
    const s = v0.s * z;
    view.current = viewAt(c, R, R, s);
    try {
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.fillStyle = '#d9dfde';
      lc.fillRect(0, 0, px, px);
      lc.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawScene(lc, LOUPE, LOUPE, dpr, true);
      drawTop(lc, LOUPE, LOUPE, true);
    } finally {
      view.current = v0;
    }
    ctx.save();
    ctx.beginPath();
    ctx.arc(lx, ly, R, 0, Math.PI * 2);
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.clip();
    ctx.drawImage(lb, lx - R, ly - R, LOUPE, LOUPE);
    // the exact point: a fine crosshair with a gap in the middle
    ctx.strokeStyle = '#c92a2a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx - R, ly + 0.5); ctx.lineTo(lx - 4, ly + 0.5); ctx.moveTo(lx + 4, ly + 0.5); ctx.lineTo(lx + R, ly + 0.5);
    ctx.moveTo(lx + 0.5, ly - R); ctx.lineTo(lx + 0.5, ly - 4); ctx.moveTo(lx + 0.5, ly + 4); ctx.lineTo(lx + 0.5, ly + R);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(lx, ly, R, 0, Math.PI * 2);
    ctx.strokeStyle = '#09302f';
    ctx.lineWidth = 2;
    ctx.stroke();
    label(ctx, '×' + z, lx + R * 0.5, ly + R * 0.72, '#09302f', 'left');
    ctx.restore();
    scheduleLoupeSharp(c, s);
  };
  /** the line work in the loupe: the screen picture magnified while moving; drawn sharp once the pointer rests */
  const loupeSharp = useRef<(Detail & { key: string; pg: number }) | null>(null);
  const loupeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loupeWant = useRef('');
  const drawLoupeSharp = (ctx: CanvasRenderingContext2D) => {
    const d = loupeSharp.current;
    const pr = props.current;
    if (!d || d.key !== pr.dkey || d.pg !== pr.pg || Math.abs(d.s - view.current.s * bufDpr.current) > 1e-6 * d.s) return;
    if (rot()) { ctx.save(); ctx.transform(...pageMat()); ctx.drawImage(d.bmp, d.x0, d.y0, d.bmp.width / d.s, d.bmp.height / d.s); ctx.restore(); return; }
    const [sx, sy] = toScreen([d.x0, d.y0]);
    ctx.drawImage(d.bmp, sx, sy, (d.bmp.width / d.s) * view.current.s, (d.bmp.height / d.s) * view.current.s);
  };
  const scheduleLoupeSharp = (c: Pt, s: number) => {
    const pr = props.current;
    if (!pr.engine || !pr.dkey) return;
    const dpr = bufDpr.current;
    const S = s * dpr;
    const d = loupeSharp.current;
    // already sharp around here
    const half = LOUPE / 2 / s;
    if (d && d.key === pr.dkey && d.pg === pr.pg && Math.abs(d.s - S) < 1e-6 * S && c[0] - half >= d.x0 && c[1] - half >= d.y0 && c[0] + half <= d.x0 + d.bmp.width / d.s && c[1] + half <= d.y0 + d.bmp.height / d.s) return;
    // (the screen picture is sharp enough: no need)
    if (S <= pr.previewScale * 1.08) return;
    const want = `${pr.dkey}#${pr.pg}#${S}#${Math.round(c[0])}#${Math.round(c[1])}`;
    if (loupeWant.current === want) return;
    loupeWant.current = want;
    if (loupeTimer.current) clearTimeout(loupeTimer.current);
    loupeTimer.current = setTimeout(async () => {
      const p2 = props.current;
      if (!p2.engine || !aids().loupe) return;
      // a little more than the loupe, so small moves stay sharp
      const m = half * 1.6;
      const x0 = Math.max(0, c[0] - m), y0 = Math.max(0, c[1] - m), x1 = Math.min(p2.page.w, c[0] + m), y1 = Math.min(p2.page.h, c[1] + m);
      if (x1 <= x0 || y1 <= y0) return;
      const key = p2.dkey, pg = p2.pg;
      try {
        const { bmp } = await p2.engine.render(key, pg, S, Math.floor(x0 * S), Math.floor(y0 * S), Math.ceil((x1 - x0) * S), Math.ceil((y1 - y0) * S), { slot: 'loupe' });
        if (unmounted.current || props.current.dkey !== key || props.current.pg !== pg) { bmp.close(); return; }
        loupeSharp.current?.bmp.close();
        loupeSharp.current = { bmp, x0: Math.floor(x0 * S) / S, y0: Math.floor(y0 * S) / S, s: S, key, pg };
        redrawTop();
      } catch { /* superseded, or it could not be drawn: the magnified picture stays */ }
    }, 180);
  };

  // ---------- v0.16 walls and beams as bands ----------
  const bandCache = useRef(new WeakMap<Shape, { key: string; runs: BandRun[] }>());
  /** the band of a wall / beam: runs of segments of one width, scale and colour; [] = drawn as a line */
  const bandsOf = (s: Shape, op: Pt[], ob: number[]): BandRun[] => {
    const pr = props.current;
    if (!pr.bandWidth || s.k !== 'line' || op.length < 2) return [];
    const kind = pr.items.get(s.ti)?.kind;
    if (kind !== 'wall' && kind !== 'beam') return [];
    const n = op.length - 1;
    const segs: { w: number | null; sx: number; sy: number; color: string | null }[] = [];
    let key = '';
    for (let i = 0; i < n; i++) {
      const bw = pr.bandWidth(s, i);
      const sc = bw ? pr.scaleAt(segMid(op[i], op[i + 1], ob[i] || 0)) : null;
      const color = bw && pr.segTag && s.sg?.[i] ? pr.segTag(s, i)?.color ?? null : null;
      segs.push({ w: sc ? bw : null, sx: sc?.x ?? 0, sy: sc?.y ?? 0, color });
      key += `${bw}|${sc?.x}|${sc?.y}|${color};`;
    }
    const still = op === s.pts && ob === s.b;
    if (still) { const c = bandCache.current.get(s); if (c && c.key === key) return c.runs; }
    if (!segs.some((g) => g.w)) { if (still) bandCache.current.set(s, { key, runs: [] }); return []; }
    const runs: BandRun[] = [];
    const closedLine = n >= 2 && dist(op[0], op[n]) < 0.01;
    const same = (a: typeof segs[0], b: typeof segs[0]) => a.w === b.w && a.sx === b.sx && a.sy === b.sy && a.color === b.color;
    for (let i = 0; i < n;) {
      let j = i;
      while (j + 1 < n && same(segs[j + 1], segs[i])) j++;
      const g = segs[i];
      if (g.w) {
        const path = flatten(op.slice(i, j + 2), ob.slice(i, j + 1), false);
        runs.push({ rings: bandOutline(path, g.w / 2, g.sx, g.sy, i === 0 && j === n - 1 && closedLine), color: g.color, w: g.w, sx: g.sx, sy: g.sy });
      }
      i = j + 1;
    }
    if (still) bandCache.current.set(s, { key, runs });
    return runs;
  };
  /** half the widest band of a shape, in sheet points (hit tests: a click anywhere on the band) */
  const bandTol = (s: Shape): number => {
    if (s.k !== 'line' || !props.current.bandWidth) return 0;
    let t = 0;
    for (const r of bandsOf(s, s.pts, s.b)) t = Math.max(t, r.w / 2 / Math.min(r.sx, r.sy));
    return t;
  };

  // ---------- v0.16 rooms: the outline an additional finish is drawn along ----------
  /** the room outlines on this sheet (those shown), by room - worked out once per scene */
  const roomOutl = useRef<Map<string, Shape[]> | null>(null);
  const partOutline = (s: Shape, room: string): Shape | null => {
    let mp = roomOutl.current;
    if (!mp) {
      mp = new Map();
      for (const x of props.current.shapes) if (x.k === 'poly' && props.current.items.get(x.ti)?.kind === 'room') (mp.get(x.ti) ?? mp.set(x.ti, []).get(x.ti)!).push(x);
      roomOutl.current = mp;
    }
    const list = mp.get(room);
    return list ? nearestOutline(list, s.pts) : null;
  };
  /** picking edges (room steps): the edge under the pointer */
  const hoverEdge = useRef<{ shape: string; seg: number } | null>(null);
  const edgeUnder = (raw: Pt) => {
    const ep = props.current.edgePick;
    if (!ep) return null;
    return edgeAt(props.current.shapes.filter((s) => ep.shapes.has(s.id) && pickable(s)), raw, 10 / view.current.s);
  };

  // ---------- v0.16 one place that says which shapes the pointer can pick ----------
  /** hidden shapes (a take-off switched off) are not picked, boxed, snapped to or edited */
  const pickable = (s: Shape) => s.id !== resumeId.current && (!props.current.canPick || props.current.canPick(s));
  /** the top shape under the pointer (on a wall / beam band: anywhere on it) */
  const hitAt = (raw: Pt, tol: number): Shape | undefined => {
    const list = props.current.shapes;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (!pickable(s)) continue;
      if (hitShape(s, raw, tol + bandTol(s))) return s;
    }
    return undefined;
  };

  const drawMeasure = (c2: CanvasRenderingContext2D, m: Pt[], live: boolean) => {
      const pr = props.current;
      const ml = m.length > 1 ? pr.measure(m, [], false) : null;
      const scr = m.map(toScreen);
      c2.save();
      c2.strokeStyle = '#e8590c';
      c2.lineWidth = 2;
      c2.setLineDash([8, 4]);
      c2.beginPath();
      scr.forEach(([x, y], i) => (i ? c2.lineTo(x, y) : c2.moveTo(x, y)));
      c2.stroke();
      c2.setLineDash([]);
      for (const [x, y] of scr) { c2.beginPath(); c2.arc(x, y, 3, 0, Math.PI * 2); c2.fillStyle = '#e8590c'; c2.fill(); }
      const L = polyLength(m);
      const [lx, ly] = scr[scr.length - 1];
      label(c2, ml ? `${fm(ml.len)} m${m.length > 2 ? ' total' : ''}${live ? '' : ' · ruler (not saved)'}` : `${fixed(L, 1)} pt (no scale)`, lx + 10, ly - 26 * fsz(), '#e8590c', 'left');
      c2.restore();
  };

  // ---------- the point a click would put down ----------
  /** ortho (F8) or Shift held */
  const orthoNow = () => aids().ortho || shiftDown.current;
  /**
   * v0.16 ⊥ snap: with ortho, a take-off line / wall / beam / area edge within 12 px of the pointer gives
   * the foot of the perpendicular from the last node onto it (where that foot lies on it).
   * v0.18.1 (Nabil: "it should snap to perpendicular ... even if not [ortho]"): the drawing's own lines too
   * (snapping on), and without ortho as well - then the pointer has to come within 12 px of the foot.
   * A corner / line end or middle nearer the pointer than the foot wins over it.
   */
  const perpAt = (raw: Pt): { p: Pt; seg: Seg } | null => {
    const pr = props.current;
    const P = pts.current;
    const tool = pr.tool;
    if (!P.length || arcEnd.current || tool === 'rect' || tool === 'circle' || !DRAW_TOOLS.includes(tool)) return null;
    const tol = 12 / view.current.s;
    const from = P[P.length - 1];
    const ortho = orthoNow();
    function* segs(): Generator<Seg> {
      for (const s of pr.shapes) {
        if (s.k === 'pt' || !pickable(s)) continue;
        if (s.box.x0 - tol > raw[0] || s.box.x1 + tol < raw[0] || s.box.y0 - tol > raw[1] || s.box.y1 + tol < raw[1]) continue;
        yield* segsOf(s);
      }
      // the shape being drawn: its own earlier segments too
      for (let i = 0; i + 2 < P.length; i++) yield { a: P[i], b: P[i + 1], bulge: bul.current[i] || 0 };
      // the drawing's lines near the pointer (from the last snap look-up)
      if (pr.snapOn) yield* nearSegs.current;
    }
    const hit = perpSnap(from, raw, segs(), tol, !ortho);
    const sh = snapHit.current;
    if (hit && sh && sh.k !== 'on' && dist([sh.x, sh.y], raw) < Math.min(14 / view.current.s, dist(hit.p, raw))) return null;
    return hit;
  };
  /** snapped, then squared off (ortho: F8 / Shift) - the ⊥ snap first; v0.16 then onto the rail (a room's outline) */
  const nextPoint = (raw: Pt): Pt => {
    const q = nextPoint0(raw);
    const rl = props.current.rail;
    if (!rl || !rl.shapes.length || arcEnd.current) return q;
    let best: { q: Pt; d: number } | null = null;
    for (const s of rl.shapes) { const h = projectOnOutline(s, q); if (!best || h.d < best.d) best = h; }
    return best && (rl.always || best.d * view.current.s < 14) ? best.q : q;
  };
  const nextPoint0 = (raw: Pt): Pt => {
    const pf = perpHit.current;
    if (pf) return pf.p;
    const sh = snapHit.current;
    // (with ortho the drawing's "on a line" snap is not used: it would pull the point off the straight)
    if (sh && dist([sh.x, sh.y], raw) < 14 / view.current.s && !(orthoNow() && pts.current.length && sh.k === 'on' && !sh.own)) return [sh.x, sh.y];
    if (orthoNow() && pts.current.length) {
      const prev = pts.current[pts.current.length - 1];
      if (arcEnd.current) return raw;
      // Rectangle: Shift makes it a square (ortho alone changes nothing: its sides are straight anyway)
      if (props.current.tool === 'rect') return shiftDown.current ? squareOf(prev, raw) : raw;
      return orthoHV(prev, raw);
    }
    return raw;
  };
  /** the opposite corner of a square from a (its sides as long in reality, across and up-down) */
  const squareOf = (a: Pt, raw: Pt): Pt => {
    const sc = props.current.scaleAt(a);
    const sx = sc?.x ?? 1, sy = sc?.y ?? 1;
    const dx = (raw[0] - a[0]) * sx, dy = (raw[1] - a[1]) * sy;
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    return [a[0] + (Math.sign(dx) || 1) * m / sx, a[1] + (Math.sign(dy) || 1) * m / sy];
  };

  // ---------- live readout in the action bar ----------
  /** the shape in progress with the segment to the pointer (sheet points + bulges) */
  const progress = (hv: Pt | null): { pts: Pt[]; b: number[]; chord: [Pt, Pt] | null } => {
    const P = pts.current, B = bul.current;
    if (!hv || !P.length) return { pts: P, b: B, chord: null };
    const last = P[P.length - 1];
    if (ARC_TOOLS.includes(props.current.tool) && arcMode.current) {
      const e = arcEnd.current;
      if (!e) return { pts: P, b: B, chord: [last, nextPoint(hv)] };
      return { pts: [...P, e], b: [...B, bulgeThrough(last, e, nextPoint(hv))], chord: null };
    }
    return { pts: [...P, nextPoint(hv)], b: [...B, 0], chord: null };
  };

  const live = () => {
    const el = liveEl.current;
    if (!el) return;
    const pr = props.current;
    const tool = pr.tool;
    const pg = progress(pts.current.length ? hover.current : null);
    const P = pg.chord ? [...pg.pts, pg.chord[1]] : pg.pts;
    const B = pg.chord ? [...pg.b, 0] : pg.b;
    let t = '';
    if (tool === 'scale') t = P.length ? 'Click the other end of the dimension' : 'Click one end of a dimension you know';
    else if (tool === 'count') t = counted.current ? `${counted.current} counted` : 'Click each one';
    else if (DRAW_TOOLS.includes(tool) && P.length) {
      // as the take-off will count it (piece by piece across viewports, an area at its middle's scale)
      const line = pr.closedAs === 'line';
      const noScale = 'No scale here yet — the shape is kept, its quantity appears once the sheet has a scale';
      if (pr.scaleAt(P[0]) === null && P.length < 2) t = noScale;
      else if (tool === 'line' || tool === 'measure') {
        const ml = P.length > 1 ? pr.measure(P, B, false) : { len: 0, area: 0 };
        t = !ml ? noScale : tool === 'line' ? `Length ${fm(ml.len)} m` : `Ruler ${fm(ml.len)} m (not saved)`;
      } else if (tool === 'rect' && P.length === 2) {
        const sc = pr.scaleAt([(P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2]);
        // (the sides at the middle's scale; the perimeter as it is kept: piece by piece across viewports)
        const m = sc && line ? pr.measure([...rectOf(P[0], P[1]), P[0]], [], false) : null;
        if (!sc || (line && !m)) t = noScale;
        else {
          const w = Math.abs(P[1][0] - P[0][0]) * sc.x, h = Math.abs(P[1][1] - P[0][1]) * sc.y;
          t = line ? `Perimeter ${fm(m!.len)} m · ${fm(w)} × ${fm(h)} m` : `Area ${fa(w * h)} m² · ${fm(w)} × ${fm(h)} m`;
        }
      } else if (tool === 'rect') t = 'Click the opposite corner';
      else if (tool === 'circle' && P.length === 2) {
        const sc = pr.scaleAt(P[0]);
        if (!sc) t = noScale;
        else if (sc.x !== sc.y) {
          // an ellipse in reality (a separate up-down scale): measured as the take-off will count it
          const [cp, cb] = circleOf(P[0], P[1]);
          // (as kept: an outline is a closed line, an area a shape)
          const mm = line ? pr.measure([cp[0], cp[1], cp[0]], cb, false) : pr.measure(cp, cb, true);
          t = !mm ? noScale : line ? `Circumference ${fm(mm.len)} m (an ellipse: the scales differ)` : `Area ${fa(mm.area)} m² (an ellipse: the scales differ)`;
        } else {
          const r = dist(P[0], P[1]) * sc.x;
          // (the circumference as it is kept: piece by piece across viewports)
          const [cp, cb] = circleOf(P[0], P[1]);
          const mm = line ? pr.measure([cp[0], cp[1], cp[0]], cb, false) : null;
          t = line ? (mm ? `Circumference ${fm(mm.len)} m · radius ${fm(r)} m` : noScale) : `Area ${fa(Math.PI * r * r)} m² · radius ${fm(r)} m`;
        }
      } else if (tool === 'circle') t = 'Click the centre, then a point on the circle';
      else {
        const ma = P.length > 2 ? pr.measure(P, [...B, 0], true) : P.length === 2 ? pr.measure(P, B, false) : { len: 0, area: 0 };
        t = !ma ? noScale : P.length > 2 ? `Area ${fa(ma.area)} m² · perimeter ${fm(ma.len)} m` : `Area ${fa(0)} m² · side ${fm(ma.len)} m`;
      }
    } else if (tool === 'measure' && measured.current) {
      const ml = measured.current.length > 1 ? pr.measure(measured.current, [], false) : null;
      t = ml ? `Ruler ${fm(ml.len)} m (not saved) — click to measure again` : 'No scale here';
    }
    el.textContent = t;
  };

  // ---------- snapping ----------
  const ownSnap = (q: Pt, r: number): (Snapped & { own: true }) | null => {
    let best = r, hit: Pt | null = null;
    // dragging a corner: every other corner snaps - the same shape's too (lining a corner up with
    // its own neighbours was impossible before 0.15: the whole shape was left out); only the corner
    // being moved is not a target (and a new corner being added has none of its own yet)
    const dv = drag.current?.k === 'vertex' ? drag.current : null;
    const cp = props.current.canPick;
    for (const s of props.current.shapes) {
      if (s.box.x0 - r > q[0] || s.box.x1 + r < q[0] || s.box.y0 - r > q[1] || s.box.y1 + r < q[1]) continue;
      if (cp && !cp(s)) continue;
      const rings = [s.pts, ...s.holes];
      for (let ri = 0; ri < rings.length; ri++) {
        const v = rings[ri];
        for (let ci = 0; ci < v.length; ci++) {
          if (dv && !dv.insert && dv.id === s.id && dv.ring === ri && dv.idx === ci) continue;
          const d = dist(v[ci], q);
          if (d < best) { best = d; hit = v[ci]; }
        }
      }
    }
    // the first point of what is being drawn (to close a room)
    if (pts.current.length >= 3) {
      const d = dist(pts.current[0], q);
      if (d < best) { best = d; hit = pts.current[0]; }
    }
    return hit ? { x: hit[0], y: hit[1], k: 'end', own: true } : null;
  };

  const updateSnap = (raw: Pt) => {
    const pr = props.current;
    const r = 11 / view.current.s;
    const own = ownSnap(raw, r * 0.8);
    if (own || !pr.snapOn || !pr.engine) {
      snapHit.current = own;
      if (!pr.snapOn || !pr.engine) nearSegs.current = [];
      return;
    }
    if (snapBusy.current) return;
    snapBusy.current = true;
    pr.engine.snapNear(pr.dkey, pr.pg, raw[0], raw[1], r).then(({ hit: h, near }) => {
      snapBusy.current = false;
      const ns: Seg[] = [];
      for (let i = 0; i + 3 < near.length; i += 4) ns.push({ a: [near[i], near[i + 1]], b: [near[i + 2], near[i + 3]], bulge: 0 });
      nearSegs.current = ns;
      const cur = hover.current;
      if (cur && h && dist(cur, raw) < r) snapHit.current = h;
      else if (!h) snapHit.current = null;
      // a corner being dragged: the snap found after the pointer stopped is where it goes (it used to
      // wait for the next move - let go meanwhile and the corner landed off the line the marker showed)
      const d = drag.current;
      if (d?.k === 'vertex' && cur) { d.p = vertexPoint(d, cur); if (d.moved) { redraw(); return; } }
      aim();
      live();
      redrawTop();
    }).catch(() => { snapBusy.current = false; });
  };

  /** where a dragged node goes: a snap near the pointer; else ortho (F8 / Shift) squares the edge off against a neighbour */
  const vertexPoint = (d: Extract<Drag, { k: 'vertex' }>, raw: Pt): Pt => {
    const sh = snapHit.current;
    if (sh && dist([sh.x, sh.y], raw) < 14 / view.current.s) return [sh.x, sh.y];
    if (orthoNow()) {
      const s = props.current.shapes.find((x) => x.id === d.id);
      const ring = s ? (d.ring === 0 ? s.pts : s.holes[d.ring - 1]) : null;
      if (ring && ring.length > 1) {
        const closed = d.ring > 0 || s!.k === 'poly';
        // inserting after idx: the neighbour is idx itself; moving idx: the corner before it (or after, at the start)
        const nb = d.insert ? ring[d.idx] : d.idx > 0 || closed ? ring[(d.idx - 1 + ring.length) % ring.length] : ring[1];
        if (nb) return orthoHV(nb, raw);
      }
    }
    return raw;
  };

  /**
   * D / O: the wall nearest the pointer - the wall being drawn (from 2 points) or a wall already drawn
   * on this sheet - and the point on it
   */
  const wallAt = (raw: Pt): { shape: string | null; p: Pt } | null => {
    const pr = props.current;
    const tol = 16 / view.current.s;
    // (how far outside the wall: on a band, anywhere across it counts as on it)
    let best = tol, hit: { shape: string | null; p: Pt } | null = null;
    const near = (path: Pt[], closed: boolean, shape: string | null, band = 0) => {
      const n = path.length;
      for (let i = 0; i < (closed ? n : n - 1); i++) {
        const r = segDist(raw, path[i], path[(i + 1) % n]);
        const d = Math.max(0, r.d - band);
        if (d < best) { best = d; hit = { shape, p: r.q }; }
      }
    };
    if (pr.wallMode && pr.tool === 'line' && pts.current.length >= 2) near(flatten(pts.current, bul.current, false), false, null);
    for (const s of pr.shapes) {
      if (s.k === 'pt' || !pickable(s) || pr.viewOnly?.has(s.id)) continue;
      const kind = pr.items.get(s.ti)?.kind;
      // (v0.16: a room's outline too, when a door / opening goes in a room)
      // (v0.18 a plain length too: the door's width comes off it)
      // (only with the Length tool, and never a room's own lengths: a door meant for a wall must not land on a
      // skirting drawn along it)
      const lenOk = kind === 'line' && s.k === 'line' && !!pr.plainLen && !pr.items.get(s.ti)?.rm;
      if (!((kind === 'wall' || lenOk) && (pr.wallMode || !pr.roomDoor)) && !(kind === 'room' && s.k === 'poly' && pr.roomDoor)) continue;
      const band = bandTol(s);
      const t = tol + band;
      if (s.box.x0 - t > raw[0] || s.box.x1 + t < raw[0] || s.box.y0 - t > raw[1] || s.box.y1 + t < raw[1]) continue;
      near(s.flat, s.k === 'poly', s.id, band);
    }
    return hit;
  };
  const openingAt = (raw: Pt): string | null => {
    const tol = 7 / view.current.s;
    let best = tol, id: string | null = null;
    for (const o of props.current.openings ?? []) {
      const d = segDist(raw, o.a, o.b).d;
      if (d < best) { best = d; id = o.id; }
    }
    return id;
  };
  /** v0.16.4 a door's / an opening's tag under the pointer (screen px): it can be taken by its tag too */
  const openingTagAt = (cx: number, cy: number): string | null => {
    if (view.current.s <= 0.06) return null;
    // (the tag's own box, as smallLabel draws it)
    const k = fsz();
    const ctx = cv.current?.getContext('2d');
    if (!ctx) return null;
    ctx.save();
    ctx.font = `600 ${10.5 * k}px Inter Variable, Segoe UI, sans-serif`;
    let id: string | null = null;
    for (const o of props.current.openings ?? []) {
      if (!o.label) continue;
      const [mx, my] = toScreen([(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2]);
      const ly = my - 15 * k, hw = (ctx.measureText(o.label).width + 8 * k) / 2;
      if (Math.abs(cx - mx) <= hw && Math.abs(cy - ly) <= 8 * k) { id = o.id; break; }
    }
    ctx.restore();
    return id;
  };
  const setPlacing = (k: 'door' | 'open' | null) => {
    const was = placing.current;
    placing.current = k;
    setCursor(k ? 'crosshair' : props.current.tool === 'select' ? 'default' : 'none');
    syncBar();
    redraw();
    if (was !== k) props.current.onPlacing?.(k);
  };
  /** v0.16.1 where the door chooser opens: by the pointer when it is on the drawing */
  const chooserAt = (): [number, number] => {
    const r = cv.current?.getBoundingClientRect();
    const m = hoverScreen.current;
    return r && m ? [Math.round(r.left + m[0]), Math.round(r.top + m[1])] : [Math.round(myWin().innerWidth / 2 - 170), Math.round(myWin().innerHeight / 3)];
  };
  /** the bar's Door / Other opening: a room outline being drawn is kept first (the door goes on it) */
  const togglePlace = (k: 'door' | 'open') => {
    const pr = props.current;
    if (pr.roomDoor && !pr.wallMode && pts.current.length && placing.current !== k) {
      if (pr.tool !== 'area' || pts.current.length < 3) { message('Finish the outline first (3 nodes or more), then D / O'); return; }
      finish();
    }
    setPlacing(placing.current === k ? null : k);
  };
  /** what a door goes on: a wall, or (v0.16) a room's edge */
  const placeOn = () => (props.current.roomDoor && !props.current.wallMode ? 'room’s edge' : 'wall');
  /** the click of D / O: the door / opening goes on that wall; a wall being drawn is saved first and goes on */
  const placeOpening = (raw: Pt, client: [number, number]) => {
    const pr = props.current;
    const k = placing.current!;
    const at = wallAt(raw);
    if (!at) { message(`Click on ${placeOn() === 'wall' ? 'a wall' : 'an edge of the room'} to put the ${k === 'door' ? 'door' : 'opening'} on — Esc to stop`); return; }
    let shape = at.shape;
    if (shape === null) {
      // on the wall being drawn: what is drawn so far is saved (the door needs a wall to sit on), and the
      // drawing goes on from the same point - finishing later saves the rest onto the same wall
      const P = pts.current, B = bul.current;
      if (resumeId.current) { pr.onReplace(resumeId.current, P, B); shape = resumeId.current; }
      else {
        const id = pr.onShape('line', P, B.some((x) => x) ? B : undefined);
        if (!id) { message('The wall could not be saved here — finish it first, then add the door'); return; }
        resumeId.current = id;
        shape = id;
      }
      redoPts.current = [];
    }
    // (v0.16.1 a wall / outline being drawn goes on after the door: the caller doesn't keep door placing on then)
    const drawingNow = pts.current.length > 0;
    setPlacing(null);
    pr.onOpening?.(k, { shape, p: at.p, client, drawing: drawingNow });
  };

  // ---------- point editing while drawing ----------
  const addPoint = (q: Pt, b = 0) => {
    if (pts.current.length) bul.current = [...bul.current, b];
    pts.current = [...pts.current, q];
    redoPts.current = [];
    cancelled.current = null;
    aim();
    syncBar();
  };
  const undoPoint = () => {
    if (arcEnd.current) { arcEnd.current = null; syncBar(); live(); redraw(); return true; }
    if (!pts.current.length) return false;
    const b = bul.current[bul.current.length - 1] ?? 0;
    redoPts.current = [...redoPts.current, { p: pts.current[pts.current.length - 1], b }];
    pts.current = pts.current.slice(0, -1);
    bul.current = bul.current.slice(0, Math.max(0, pts.current.length - 1));
    if (!pts.current.length) resumeId.current = null;
    aim();
    syncBar();
    live();
    redraw();
    return true;
  };
  const redoPoint = () => {
    const r = redoPts.current;
    if (!r.length) return false;
    const { p: q, b } = r[r.length - 1];
    if (pts.current.length) bul.current = [...bul.current, b];
    pts.current = [...pts.current, q];
    redoPts.current = r.slice(0, -1);
    aim();
    syncBar();
    live();
    redraw();
    return true;
  };
  const clearRun = () => {
    pts.current = [];
    bul.current = [];
    redoPts.current = [];
    arcEnd.current = null;
    resumeId.current = null;
    tail.current = null;
    typed.current = '';
    perpHit.current = null;
  };
  const cancel = (why: 'esc' | 'tool' = 'esc') => {
    // (v0.17 review: continuing from a node is not brought back by Ctrl+Z - the rest of the shape went with it)
    if ((pts.current.length >= 2 || (pts.current.length && resumeId.current)) && !tail.current) {
      cancelled.current = { pts: pts.current, bul: bul.current, tool: props.current.tool, resume: resumeId.current, t: Date.now() };
      clearTimeout(restoreT.current);
      restoreT.current = setTimeout(() => syncBar(), 15050);
    }
    clearRun();
    drag.current = null;
    setMenu(null);
    if (why === 'esc' && cancelled.current) message('Shape thrown away — Ctrl+Z brings it back', 8000);
    else syncBar();
    live();
    redraw();
  };
  const restore = () => {
    const c = cancelled.current;
    // only shortly after the cancel (as long as "Bring back" is offered): later, Ctrl+Z is the normal undo
    if (!c || c.tool !== props.current.tool || Date.now() - c.t > 15000) return false;
    pts.current = c.pts;
    bul.current = c.bul;
    resumeId.current = c.resume;
    cancelled.current = null;
    syncBar();
    live();
    redraw();
    return true;
  };
  const setArc = (on: boolean) => {
    if (arcMode.current === on) return;
    arcMode.current = on;
    if (!on) arcEnd.current = null;
    syncBar();
    live();
    redraw();
  };

  // ---------- finishing ----------
  const finish = (closingBulge = 0) => {
    const pr = props.current;
    let P = pts.current;
    let B = bul.current;
    // a double-click leaves a duplicate last point
    const keep = P.map((q, i) => i === 0 || dist(q, P[i - 1]) > 0.05);
    if (keep.some((k) => !k)) {
      const P2: Pt[] = [], B2: number[] = [];
      P.forEach((q, i) => { if (!keep[i]) return; if (P2.length) B2.push(B[i - 1] ?? 0); P2.push(q); });
      P = P2; B = B2;
    }
    const rid = resumeId.current;
    // v0.17 continued from a node: the new nodes go in, the rest stays (its tags with it; the new segments take
    // the tag of the segment they replace - an open room edge stays open)
    const tl = tail.current;
    if (rid && tl) {
      const k = P.length - tl.base;
      if (k > 0) {
        if (tl.rev) pr.onReplace(rid, [...P].reverse(), [...B].reverse().map((x) => -x), [...Array(k).fill(null), ...tl.sg]);
        else pr.onReplace(rid, [...P, ...tl.pts], [...B, 0, ...tl.bul], [...tl.sg.slice(0, tl.at), ...Array(k + 1).fill(tl.sg[tl.at] ?? null), ...tl.sg.slice(tl.at + 1)]);
      }
      clearRun();
      cancelled.current = null;
      setMenu(null);
      syncBar();
      live();
      redraw();
      return true;
    }
    const arcs = B.some((x) => x) || closingBulge ? B : undefined;
    if (pr.tool === 'area' && P.length >= (closingBulge ? 2 : 3)) pr.onShape('poly', P, arcs && [...B, closingBulge]);
    else if (pr.tool === 'line' && P.length >= 2) rid ? pr.onReplace(rid, P, B) : pr.onShape('line', P, arcs);
    else if (pr.tool === 'hole' && P.length >= (closingBulge ? 2 : 3)) {
      const target = [...pr.selected].map((id) => pr.shapes.find((s) => s.id === id)).find((s) => s && s.k === 'poly');
      if (target) pr.onHole(target.id, flatten(P, [...B, closingBulge], true));
    } else if (pr.tool === 'measure' && P.length >= 2) {
      measured.current = flatten(P, B, false);
    } else if (P.length) {
      message(pr.tool === 'line' ? 'A line needs at least 2 nodes' : 'An area needs at least 3 nodes');
      return false;
    }
    clearRun();
    cancelled.current = null;
    setMenu(null);
    syncBar();
    live();
    redraw();
    return true;
  };

  /** the shape being drawn is complete: a line / wall / beam 2 nodes (1 segment), an area / cut-out 3 */
  const shapeValid = () => {
    const t = props.current.tool, n = pts.current.length;
    if (tail.current) return n > tail.current.base;
    return ((t === 'line' || t === 'measure') && n >= 2) || ((t === 'area' || t === 'hole') && n >= 3);
  };
  /**
   * v0.16 Esc (and picking another tool / take-off mid-shape): a complete shape is kept, as Enter keeps
   * it - only the nodes placed, never the segment to the pointer; an incomplete one: its loose nodes go.
   * `why` 'tool': not kept -> restorable as before (Ctrl+Z / Bring back).
   */
  const keepOrDrop = (why: 'esc' | 'tool') => {
    if (!pts.current.length) return;
    if (shapeValid()) { arcEnd.current = null; finish(); return; }
    if (why === 'tool') { cancel('tool'); return; }
    clearRun();
    setMenu(null);
    syncBar();
    live();
    redraw();
  };

  /** Space: end this run here and start the next one (same take-off) */
  const breakRun = () => {
    const t = props.current.tool;
    if (!pts.current.length) return;
    if (arcEnd.current) arcEnd.current = null;
    if ((t === 'line' && pts.current.length >= 2) || ((t === 'area' || t === 'hole') && pts.current.length >= 3) || t === 'measure') {
      if (finish()) message(t === 'measure' ? 'Ruler ended — click to start again' : 'Run ended — click to start the next one (same take-off)', 2500);
      return;
    }
    // a single loose point: just drop it
    clearRun();
    syncBar();
    live();
    redraw();
  };

  /** v0.16 the end grip's segment set to the typed length, along its direction now (one undo step) */
  const applyGripLen = () => {
    const pr = props.current;
    const g = gripLen.current;
    const L = parseTypedLength(typed.current);
    typed.current = '';
    const s = g ? pr.shapes.find((x) => x.id === g.id) : null;
    if (!g || !s || !L) { syncBar(); redrawTop(); return; }
    const q = endNodeForLength(s, g.idx, L, (a, b, bulge) => pr.measure([a, b], [bulge], false)?.len ?? null);
    if (!q) { message('Set the scale first — typed lengths need it'); return; }
    pr.onVertex(s.id, 0, g.idx, q);
    gripLen.current = null;
    syncBar();
    redraw();
  };

  /** put down a point exactly `metres` from the last one, towards the pointer */
  const placeTyped = () => {
    const pr = props.current;
    const L = parseTypedLength(typed.current);
    typed.current = '';
    const P = pts.current;
    if (!L || !P.length || !hover.current) { syncBar(); redraw(); return; }
    const a = P[P.length - 1];
    // at the scale where this segment starts (a viewport's own scale when it is in one)
    const sc = pr.scaleAt(pr.tool === 'circle' ? P[0] : a);
    if (!sc) { message('Set the scale first — typed lengths need it'); return; }
    const b = nextPoint(hover.current);
    const d = dist(a, b);
    if (d < 1e-6) { message('Point the mouse in the direction to go, then type the length'); return; }
    // (metres per sheet point along this direction: across and up-down may differ)
    const k = L / Math.hypot((b[0] - a[0]) * sc.x, (b[1] - a[1]) * sc.y);
    const q: Pt = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    if (pr.tool === 'rect') { pts.current = [...P, q]; finishRect(); return; }
    if (pr.tool === 'circle') { pts.current = [...P, q]; finishCircle(); return; }
    if (arcEnd.current) arcEnd.current = null;
    addPoint(q);
    live();
    redraw();
  };

  /** the area a cut-out comes off: the one selected */
  const holeTarget = () => { const pr = props.current; return [...pr.selected].map((id) => pr.shapes.find((s) => s.id === id)).find((s) => s && s.k === 'poly') ?? null; };
  const finishRect = () => {
    const pr = props.current;
    const [a, b] = pts.current;
    pts.current = [];
    bul.current = [];
    if (a && b && Math.abs(b[0] - a[0]) > 0.5 && Math.abs(b[1] - a[1]) > 0.5) {
      const r = rectOf(a, b);
      if (pr.closedAs === 'hole') { const t = holeTarget(); if (t) pr.onHole(t.id, r); }
      else if (pr.closedAs === 'line') pr.onShape('line', [...r, r[0]]);
      else pr.onShape('poly', r);
    }
    syncBar();
    live();
    redraw();
  };

  const finishCircle = () => {
    const pr = props.current;
    const [c, e] = pts.current;
    pts.current = [];
    bul.current = [];
    if (c && e && dist(c, e) > 0.5) {
      const [P, B] = circleOf(c, e);
      if (pr.closedAs === 'hole') { const t = holeTarget(); if (t) pr.onHole(t.id, flatten(P, B, true)); }
      else if (pr.closedAs === 'line') pr.onShape('line', [P[0], P[1], P[0]], [1, 1]);
      else pr.onShape('poly', P, B);
    }
    syncBar();
    live();
    redraw();
  };

  // ---------- pointer ----------
  /**
   * The grip under the pointer: a node of any selected shape (v0.16: every selected shape has grips), else
   * - one shape selected - the dot in the middle of one of its edges
   */
  const vertexAt = (raw: Pt): { s: Shape; ring: number; idx: number; mid: boolean } | null => {
    const pr = props.current;
    if (pr.readOnly || !pr.selected.size) return null;
    const tol = 6.5 / view.current.s;
    let best: { s: Shape; ring: number; idx: number; mid: boolean } | null = null, bd = tol;
    let only: Shape | null = null;
    for (const s of pr.shapes) {
      if (!pr.selected.has(s.id) || s.k === 'pt' || !pickable(s)) continue;
      // (v0.16 e: someone else's, view only: no grips)
      if (pr.viewOnly?.has(s.id)) { only = only === null ? s : only; if (pr.selected.size === 1) return null; continue; }
      only = only === null ? s : only;
      if (s.box.x0 - tol > raw[0] || s.box.x1 + tol < raw[0] || s.box.y0 - tol > raw[1] || s.box.y1 + tol < raw[1]) continue;
      const rings = [s.pts, ...s.holes];
      for (let ri = 0; ri < rings.length; ri++) {
        const r = rings[ri];
        for (let idx = 0; idx < r.length; idx++) { const d = dist(r[idx], raw); if (d <= bd) { bd = d; best = { s, ring: ri, idx, mid: false }; } }
      }
    }
    if (best || pr.selected.size !== 1 || !only) return best;
    const s: Shape = only;
    const rings = [s.pts, ...s.holes];
    for (let ri = 0; ri < rings.length; ri++) {
      const r = rings[ri];
      const closed = ri > 0 || s.k === 'poly';
      for (let i = 0; i < (closed ? r.length : r.length - 1); i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        const bg = ri === 0 ? s.b[i] || 0 : 0;
        if (dist(a, b) * view.current.s < 26 && !bg) continue;
        if (dist(segMid(a, b, bg), raw) <= tol) return { s, ring: ri, idx: i, mid: true };
      }
    }
    return null;
  };

  /** the segment of a shape's outline nearest to p (for the right-click menu) */
  const segmentAt = (s: Shape, raw: Pt): SegRef | null => {
    if (s.k === 'pt') return null;
    const n = s.pts.length;
    let best = Infinity, idx = -1;
    for (let i = 0; i < (s.k === 'poly' ? n : n - 1); i++) {
      const f = flatten([s.pts[i], s.pts[(i + 1) % n]], [s.b[i] || 0], false);
      for (let j = 1; j < f.length; j++) {
        const d = segDistTo(raw, f[j - 1], f[j]);
        if (d < best) { best = d; idx = i; }
      }
    }
    return idx >= 0 && best <= 10 / view.current.s ? { shape: s.id, idx, p: raw } : null;
  };

  /** the point the pointer aims at now (⊥ snap, a snap, else where it is) - again when Shift / ortho changes */
  const aim = () => {
    const raw = hoverRaw.current;
    if (!raw || drag.current) return;
    if (props.current.tool === 'select') { perpHit.current = null; return; }
    perpHit.current = perpAt(raw);
    const sh = snapHit.current;
    hover.current = perpHit.current ? perpHit.current.p : sh && dist([sh.x, sh.y], raw) < 14 / view.current.s && !(orthoNow() && pts.current.length && sh.k === 'on' && !sh.own) ? [sh.x, sh.y] : raw;
  };

  const onDown = (e: React.PointerEvent) => {
    const pr = props.current;
    cv.current!.focus();
    setMenu(null);
    const [cx, cy] = local(e);
    const raw = toSheet(cx, cy);
    if (e.button === 0 && spaceDown.current) spacePanned.current = true;
    if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown.current && !pr.passive)) {
      drag.current = { k: 'pan', sx: cx, sy: cy, ox: view.current.ox, oy: view.current.oy, moved: false, button: e.button };
      cv.current!.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    // (a sheet not worked on: the click makes it the one worked on - nothing else)
    if (pr.passive) { pr.onActivate?.(); return; }
    const tool = pr.tool;
    if (placing.current && !pr.readOnly) { placeOpening(raw, [e.clientX, e.clientY]); return; }
    // v0.16 picking a room's edges: a click toggles the edge under it
    if (pr.edgePick && pr.onEdgePick && !pr.readOnly && !pts.current.length) {
      const h = edgeUnder(raw);
      if (h) pr.onEdgePick(h.shape.id, h.seg);
      else message(pr.edgePick.flag === 'open' ? 'Click on an edge of the room · Enter when done' : pr.edgePick.flag === 'line' ? 'Click on the edges it runs along (again to take one back) · Enter when done' : 'Click on an edge of the room or of its ceiling areas · Enter when done');
      return;
    }
    // auto-count marks: a click leaves one out / takes it back
    if (pr.proposals && pr.onProposal) {
      const r = Math.max(6, Math.max(4, Math.min(9, 6 * Math.sqrt(view.current.s / 0.6))) + 2) + 3;
      const i = pr.proposals.findIndex((q) => dist(toScreen(q.p), [cx, cy]) <= r);
      if (i >= 0) { pr.onProposal(i); redraw(); return; }
    }
    if (tool === 'select' || pr.readOnly) {
      const tol = 6 / view.current.s;
      const mod = e.shiftKey || e.ctrlKey || e.metaKey;
      // an end grip waiting for a typed length: a click anywhere else lets it go
      if (gripLen.current) { gripLen.current = null; typed.current = ''; syncBar(); redrawTop(); }
      // (v0.16.5 a picked open edge: any click lets it go - one on an open edge picks that one, below)
      if (pr.edgeSel && pr.onEdgeSel) pr.onEdgeSel(null);
      // (Shift / Ctrl + click: selection only - Ctrl+click no longer deletes a node)
      const v = mod ? null : vertexAt(raw);
      if (v) {
        if (!v.mid && e.altKey) {
          pr.onVertexDelete(v.s.id, v.ring, v.idx);
          return;
        }
        const rings = [v.s.pts, ...v.s.holes];
        // middle dot: a straight edge gets a new node, an arc is reshaped (Alt: the other way round)
        const isArc = v.ring === 0 && !!v.s.b[v.idx];
        const bend = v.mid && v.ring === 0 && isArc !== e.altKey;
        drag.current = bend
          ? { k: 'bend', id: v.s.id, seg: v.idx, p: raw, sx: cx, sy: cy, moved: false }
          : v.mid
            ? { k: 'vertex', id: v.s.id, ring: v.ring, idx: v.idx, p: raw, insert: true, sx: cx, sy: cy, moved: false }
            : { k: 'vertex', id: v.s.id, ring: v.ring, idx: v.idx, p: rings[v.ring][v.idx], insert: false, sx: cx, sy: cy, moved: false };
        cv.current!.setPointerCapture(e.pointerId);
        redrawTop();
        return;
      }
      // note pin?
      for (const n of pr.notes) {
        if (n.x === null || n.y === null) continue;
        const [nx, ny] = toScreen([n.x, n.y]);
        if (cx >= nx - 5 && cx <= nx + 21 && cy >= ny - 26 && cy <= ny) { pr.onNoteOpen(n); return; }
      }
      // v0.16.4 a door / an opening taken by its mark or its tag: dragged along its edge (a click alone: as before)
      if (!mod && !pr.readOnly && pr.onOpeningMove && !pts.current.length) {
        const oid = openingTagAt(cx, cy) ?? openingAt(raw);
        if (oid) {
          drag.current = { k: 'opening', id: oid, p: raw, at: null, sx: cx, sy: cy, moved: false };
          cv.current!.setPointerCapture(e.pointerId);
          return;
        }
      }
      // v0.18.1 the image picked: a corner resizes it, the picture itself (where no take-off is) moves it
      const isel = imgSel.current && !mod && !pr.readOnly ? (pr.images ?? []).find((x) => x.id === imgSel.current && x.mine) : null;
      if (isel) {
        const h = imgCorner(isel.box, cx, cy);
        if (h || (inBoxPt(isel.box, raw) && !hitAt(raw, tol))) {
          drag.current = { k: 'image', id: isel.id, h: h ?? 'move', a: raw, box0: isel.box, box: isel.box, moved: false };
          cv.current!.setPointerCapture(e.pointerId);
          return;
        }
      }
      const hit = hitAt(raw, tol);
      // v0.16.5 an open (dashed) edge of a room clicked: the room selected, that edge picked - Del: a wall edge again
      if (pr.onEdgeSel) {
        const oe = hit && !mod && hit.k === 'poly' ? edgeAt([hit], raw, Math.max(tol, 8 / view.current.s)) : null;
        const on = oe && edgeFlags(hit!.sg[oe.seg]).open ? { shape: oe.shape.id, seg: oe.seg } : null;
        if (on) pr.onEdgeSel(on);
        if (on && !pr.readOnly) message('Open edge picked · Del: a wall edge again', 5000);
      }
      if (hit) {
        if (mod) {
          pr.onSelect([hit.id], true);
          return;
        }
        if (!pr.selected.has(hit.id)) pr.onSelect([hit.id], false);
        if (!pr.readOnly) {
          const ids0 = pr.selected.has(hit.id) ? [...pr.selected] : [hit.id];
          // (v0.16 e: other people's shapes, view only, stay where they are)
          const vo = pr.viewOnly;
          const skip = vo && ids0.some((id) => vo.has(id)) ? new Set(ids0.filter((id) => vo.has(id))) : undefined;
          const ids = skip ? ids0.filter((id) => !skip.has(id)) : ids0;
          const why = skip ? (pr.viewOnlyWhy?.(vo!.has(hit.id) ? hit : pr.shapes.find((x) => skip.has(x.id)) ?? hit) ?? 'View only.') : undefined;
          drag.current = { k: 'move', a: raw, b: raw, ids, copy: e.altKey, skip, why };
          cv.current!.setPointerCapture(e.pointerId);
        }
        return;
      }
      // v0.16 empty paper: a selection box - left to right = window, right to left = crossing; Shift / Ctrl:
      // the shapes in it go in / out of the selection. (Pan: middle / right drag, Space + drag, the wheel.)
      // A click without dragging clears the selection (see onUp).
      drag.current = { k: 'box', a: raw, b: raw, additive: e.shiftKey || e.ctrlKey || e.metaKey };
      cv.current!.setPointerCapture(e.pointerId);
      return;
    }
    if (tool === 'region') {
      drag.current = { k: 'region', a: raw, b: raw };
      cv.current!.setPointerCapture(e.pointerId);
      return;
    }
    const q = nextPoint(raw);
    typed.current = '';
    if (tool === 'count') {
      // (the second press of a double-click on the same spot counted the item twice - 0.23.2, DeepSeek #14)
      const lc = lastCount.current, now = performance.now();
      if (lc && now - lc.t < 500 && dist(toScreen(lc.q), toScreen(q)) < 3) return;
      lastCount.current = { q, t: now };
      // (v0.16.1 a door count can be refused - the same door already there - or wait for its door to be picked)
      if (pr.onShape('pt', [q])) counted.current++;
      live();
      return;
    }
    if (tool === 'note') {
      pr.onNote(q);
      pr.onToolDone();
      return;
    }
    if (tool === 'measure' && !pts.current.length) measured.current = null;
    if ((tool === 'hole' || ((tool === 'rect' || tool === 'circle') && pr.closedAs === 'hole')) && !pts.current.length) {
      const target = holeTarget();
      if (!target) {
        message('Select the area to cut first (Select tool, click it), then draw the cut-out inside it', 6000);
        return;
      }
    }
    // arcs: first click = where the arc ends, second = a point it passes through
    if (arcMode.current && ARC_TOOLS.includes(tool) && pts.current.length) {
      const last = pts.current[pts.current.length - 1];
      const e0 = arcEnd.current;
      if (!e0) {
        if (dist(toScreen(last), toScreen(q)) < 3) return;
        const closing = (tool === 'area' || tool === 'hole') && pts.current.length >= 2 && dist(toScreen(pts.current[0]), toScreen(q)) < 12;
        arcEnd.current = closing ? pts.current[0] : q;
        syncBar();
        live();
        redraw();
        return;
      }
      // the point it passes through snaps like any other; on (or right next to) an end it says nothing
      const through = q;
      if (dist(toScreen(through), toScreen(last)) < 4 || dist(toScreen(through), toScreen(e0)) < 4) return;
      const b = bulgeThrough(last, e0, through);
      arcEnd.current = null;
      if ((tool === 'area' || tool === 'hole') && e0 === pts.current[0]) { finish(b); return; }
      addPoint(e0, b);
      live();
      redraw();
      return;
    }
    // v0.17 continuing from a node: a click on the next node of the rest finishes
    const tl0 = tail.current;
    // (an outline continued from its last node: the next one is its first)
    const next0 = tl0 ? (tl0.pts.length ? tl0.pts[0] : tl0.closed ? pts.current[0] : null) : null;
    if (tl0 && next0 && pts.current.length > tl0.base && dist(toScreen(next0), toScreen(q)) < 12) { finish(); return; }
    // closing a room by clicking its first point
    if ((tool === 'area' || tool === 'hole') && !tl0 && pts.current.length >= 3 && dist(toScreen(pts.current[0]), toScreen(q)) < 12) {
      finish();
      return;
    }
    if (tool === 'rect' || tool === 'circle') {
      if (!pts.current.length) { addPoint(q); live(); redraw(); return; }
      pts.current = [...pts.current, q];
      tool === 'rect' ? finishRect() : finishCircle();
      return;
    }
    // ignore a second click on the same spot (half of a double-click: Windows' double-click box is 4 px,
    // so the second press can be up to ~2.8 px away - 2 px let some through as a spurious last corner)
    const last = pts.current[pts.current.length - 1];
    if (last && dist(toScreen(last), toScreen(q)) < 3) return;
    addPoint(q);
    if (tool === 'scale' && pts.current.length === 2) {
      const [a, b] = pts.current;
      // everything about the run goes (the arc list too, or the next shape's arcs land a segment late)
      clearRun();
      pr.onCalibrate(a, b);
      syncBar();
      live();
      redraw();
      return;
    }
    live();
    redraw();
  };

  const onMove = (e: React.PointerEvent) => {
    const pr = props.current;
    // over the drawing, whatever Chrome said: when the door picker's overlay goes away under a pointer
    // that stayed put, no pointerenter follows - D / O, Space, Home went elsewhere until a click
    pointerIn.current = true;
    const [cx, cy] = local(e);
    hoverScreen.current = [cx, cy];
    const raw = toSheet(cx, cy);
    const d = drag.current;
    if (d?.k === 'pan') {
      if (Math.abs(cx - d.sx) + Math.abs(cy - d.sy) > 3) d.moved = true;
      view.current = { ...view.current, ox: d.ox + cx - d.sx, oy: d.oy + cy - d.sy };
      viewChanged();
      return;
    }
    hoverRaw.current = raw;
    if (d?.k === 'box' || d?.k === 'region') { d.b = raw; redrawTop(); return; }
    if (d?.k === 'image') {
      const dx = raw[0] - d.a[0], dy = raw[1] - d.a[1], b0 = d.box0;
      if (!d.moved && Math.hypot(dx, dy) * view.current.s > 3) d.moved = true;
      if (!d.moved) return;
      if (d.h === 'move') d.box = { x0: b0.x0 + dx, y0: b0.y0 + dy, x1: b0.x1 + dx, y1: b0.y1 + dy };
      else {
        // (the opposite corner stays; the width follows the pointer, the height the picture's proportions)
        const ar = (b0.x1 - b0.x0) / Math.max(1e-6, b0.y1 - b0.y0);
        const fx = d.h === 'nw' || d.h === 'sw' ? b0.x1 : b0.x0, fy = d.h === 'nw' || d.h === 'ne' ? b0.y1 : b0.y0;
        const W = Math.max(4 / view.current.s, Math.abs(raw[0] - fx), Math.abs(raw[1] - fy) * ar);
        const H = W / ar;
        const x0 = d.h === 'nw' || d.h === 'sw' ? fx - W : fx, y0 = d.h === 'nw' || d.h === 'ne' ? fy - H : fy;
        d.box = { x0, y0, x1: x0 + W, y1: y0 + H };
      }
      redraw();
      return;
    }
    if (d?.k === 'opening') {
      if (!d.moved && Math.hypot(cx - d.sx, cy - d.sy) > 3) d.moved = true;
      if (d.moved) { d.at = raw; redrawTop(); }
      return;
    }
    if (d?.k === 'move') { d.b = orthoNow() ? orthoHV(d.a, raw) : raw; redraw(); return; }
    // a node / an edge dot only moves once the pointer has (a click on it changes nothing)
    if ((d?.k === 'bend' || d?.k === 'vertex') && !d.moved && Math.hypot(cx - d.sx, cy - d.sy) > 3) d.moved = true;
    if (d?.k === 'bend') { d.p = raw; hover.current = null; redraw(); return; }
    if (d?.k === 'vertex') {
      hover.current = raw;
      updateSnap(raw);
      d.p = vertexPoint(d, raw);
      // (not moved yet: nothing changes on the sheet)
      d.moved ? redraw() : redrawTop();
      return;
    }
    hover.current = raw;
    // v0.16 picking edges: the one under the pointer lights up
    if (pr.edgePick && !pts.current.length) {
      const h = edgeUnder(raw);
      const he0 = hoverEdge.current;
      hoverEdge.current = h ? { shape: h.shape.id, seg: h.seg } : null;
      if (cursor !== 'crosshair') setCursor('crosshair');
      if ((he0?.shape ?? '') + (he0?.seg ?? '') !== (h?.shape.id ?? '') + (h?.seg ?? '')) redrawTop();
      return;
    }
    if (pr.tool !== 'select') updateSnap(raw);
    aim();
    // cursor shape + hover highlight
    const hov0 = hoverShape.current, grip0 = hoverGrip.current;
    if (pr.tool === 'select') {
      const tol = 6 / view.current.s;
      let c = 'grab';
      const v = !pr.readOnly ? vertexAt(raw) : null;
      const hs = hitAt(raw, tol);
      if (v) c = v.mid ? (v.ring === 0 && !!v.s.b[v.idx] !== e.altKey ? 'crosshair' : 'copy') : e.altKey ? 'not-allowed' : 'move';
      else if (hs) c = 'pointer';
      else c = 'default';
      if (c !== cursor) setCursor(c);
      if ((hs?.id ?? null) !== hoverShape.current) { hoverShape.current = hs?.id ?? null; }
      const g = v && !v.mid ? { id: v.s.id, ring: v.ring, idx: v.idx } : null;
      if (!g !== !grip0 || (g && grip0 && (g.id !== grip0.id || g.ring !== grip0.ring || g.idx !== grip0.idx))) hoverGrip.current = g;
    } else {
      hoverShape.current = null;
      hoverGrip.current = null;
      if (cursor !== 'none') setCursor('none');
    }
    const t = performance.now();
    if (t - lastCursorSent.current > 700) {
      lastCursorSent.current = t;
      pr.onCursor(raw);
    }
    live();
    // the take-offs are drawn again only when the one under the pointer changes (it is lit up) or the
    // auto-count marks say what a click does; the rest is on the top layer
    if (hoverShape.current !== hov0 || pr.proposals) redraw();
    else redrawTop();
  };

  const onUp = (e: React.PointerEvent) => {
    const pr = props.current;
    const d = drag.current;
    drag.current = null;
    try { cv.current!.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!d) return;
    if (d.k === 'image') {
      if (d.moved) pr.onImageBox?.(d.id, d.box);
      redraw();
      return;
    }
    if (d.k === 'opening') {
      const o = (pr.openings ?? []).find((x) => x.id === d.id);
      const to = d.moved && d.at && o ? slideOnEdge(o, d.at) : null;
      if (to) pr.onOpeningMove?.(d.id, to);
      else if (!d.moved) {
        // (a click on it, not a drag: what a click there did before - the wall / room under it selected)
        const hit = hitAt(d.p, 6 / view.current.s);
        pr.onSelect(hit ? [hit.id] : [], false);
      }
      redrawTop();
      return;
    }
    if (d.k === 'pan') {
      if (!d.moved && d.button === 2 && pr.passive) { pr.onActivate?.(); return; }
      if (!d.moved && d.button === 2) {
        const [cx, cy] = local(e);
        const raw = toSheet(cx, cy);
        // while drawing: the drawing menu
        if (pts.current.length && DRAW_TOOLS.includes(pr.tool)) {
          setMenu({ x: cx, y: cy });
          return;
        }
        // a door / an opening wins over the selected wall's edge dot under it (a door in the middle of a
        // segment sits right on that dot: its right-click gave the wall's menu); a corner wins over both
        const v0 = vertexAt(raw);
        const opn = v0 && !v0.mid ? null : openingAt(raw);
        const v = opn ? null : v0;
        const hit = v?.s ?? hitAt(raw, 6 / view.current.s);
        pr.onContext(hit?.id ?? null, e.clientX, e.clientY, raw, v && !v.mid ? { shape: v.s.id, ring: v.ring, idx: v.idx } : null, hit ? segmentAt(hit, raw) : null, opn);
      }
      return;
    }
    if (d.k === 'box') {
      // a click on empty paper (no drag): the selection goes (with Shift / Ctrl it stays)
      if (Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) * view.current.s < 3) {
        if (!d.additive && pr.selected.size) pr.onSelect([], false);
        // (v0.18.1 a click on one of your images picks it: its corners resize it, Delete removes it)
        const im = !pr.readOnly ? [...(pr.images ?? [])].reverse().find((x) => x.mine && inBoxPt(x.box, d.a)) : null;
        const was = imgSel.current;
        imgSel.current = im?.id ?? null;
        if (im) message('Image picked · drag it to move, a corner to resize · Delete removes it', 4000);
        if (was !== imgSel.current) redraw(); else redrawTop();
        return;
      }
      const b = { x0: Math.min(d.a[0], d.b[0]), y0: Math.min(d.a[1], d.b[1]), x1: Math.max(d.a[0], d.b[0]), y1: Math.max(d.a[1], d.b[1]) };
      // left -> right: window (wholly inside); right -> left: crossing (touched)
      // (v0.18 as it is drawn on screen - a sheet shown turned)
      const crossing = rot() ? toScreen(d.b)[0] < toScreen(d.a)[0] : d.b[0] < d.a[0];
      const ids = pr.shapes.filter((s) => pickable(s) && boxPicks(s, b, crossing)).map((s) => s.id);
      if (ids.length || !d.additive) pr.onSelect(ids, d.additive);
      redraw();
      return;
    }
    if (d.k === 'region') {
      const b = { x0: Math.min(d.a[0], d.b[0]), y0: Math.min(d.a[1], d.b[1]), x1: Math.max(d.a[0], d.b[0]), y1: Math.max(d.a[1], d.b[1]) };
      redraw();
      if (b.x1 - b.x0 > 10 && b.y1 - b.y0 > 10) pr.onRegion(b);
      return;
    }
    if (d.k === 'move') {
      const dx = d.b[0] - d.a[0], dy = d.b[1] - d.a[1];
      const moved = Math.hypot(dx, dy) * view.current.s > 2;
      if (moved && d.ids.length) pr.onMove(d.ids, dx, dy, d.copy);
      if (moved && d.why) message(d.ids.length ? `${d.skip!.size} of them left where ${d.skip!.size === 1 ? 'it is' : 'they are'}: ${d.why}` : d.why, 5000);
      redraw();
      return;
    }
    if (d.k === 'bend') {
      const s = d.moved ? pr.shapes.find((x) => x.id === d.id) : null;
      if (s) {
        const a = s.pts[d.seg], b = s.pts[(d.seg + 1) % s.pts.length];
        const near = segDistTo(d.p, a, b) * view.current.s < 3; // dropped back on the chord: straight again
        pr.onBulge(d.id, d.seg, near ? 0 : bulgeThrough(a, b, d.p));
      }
      redraw();
      return;
    }
    if (d.k === 'vertex') {
      // a click on a node or an edge dot, without moving: nothing changes (it used to add a node in
      // the middle of the edge, or - with the snap taken on release - could pull the node to a snap)
      if (d.moved) {
        if (hover.current) d.p = vertexPoint(d, hover.current);
        if (d.insert) pr.onVertexInsert(d.id, d.ring, d.idx, d.p);
        else pr.onVertex(d.id, d.ring, d.idx, d.p);
      } else if (!d.insert) {
        // v0.16 a click on an END grip of a line / wall / beam: type the end segment's length, Enter
        const s = pr.shapes.find((x) => x.id === d.id);
        if (s && isEndNode(s, d.ring, d.idx) && !pr.readOnly) { gripLen.current = { id: s.id, idx: d.idx }; typed.current = ''; message('End node: type the length of its segment (4.2 = m, 4200 = mm), then Enter · Esc = back', 6000); }
      }
      snapHit.current = null;
      redraw();
    }
  };

  const onDouble = (e: React.MouseEvent) => {
    const pr = props.current;
    if (pr.passive) return;
    const t = pr.tool;
    if (t === 'select') {
      // v0.16 nodes: double-click a node = delete it; on a line / wall / beam / an area's edge = a new node
      // exactly there (the shape does not change: an arc becomes two arcs of the same curve)
      if (pr.readOnly || pts.current.length || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const [cx, cy] = local(e);
      const raw = toSheet(cx, cy);
      const s0 = view.current.s;
      if (gripLen.current) { gripLen.current = null; typed.current = ''; syncBar(); }
      const v = vertexAt(raw);
      if (v && !v.mid) { pr.onVertexDelete(v.s.id, v.ring, v.idx); redraw(); return; }
      const hit = v?.s ?? hitAt(raw, 6 / s0);
      if (!hit || hit.k === 'pt') return;
      if (pr.viewOnly?.has(hit.id)) { message(pr.viewOnlyWhy?.(hit) ?? 'View only.', 5000); return; }
      // (a node of a shape not selected yet)
      const rings = [hit.pts, ...hit.holes];
      for (let ri = 0; ri < rings.length; ri++) {
        const idx = rings[ri].findIndex((q) => dist(q, raw) * s0 <= 6.5);
        if (idx >= 0) { pr.onVertexDelete(hit.id, ri, idx); redraw(); return; }
      }
      const ed = nearestEdge(hit, raw);
      // inside an area, away from its edges: nothing
      if (!ed || ed.d > 6 / s0 + bandTol(hit)) return;
      const q = nodeOnEdge(hit, ed.ring, ed.seg, raw);
      if (rings[ed.ring].some((n) => dist(n, q) * s0 < 3)) return;
      pr.onVertexInsert(hit.id, ed.ring, ed.seg, q);
      if (!pr.selected.has(hit.id)) pr.onSelect([hit.id], false);
      redraw();
      return;
    }
    if (arcEnd.current) return; // second click of an arc, not the end of the shape
    if (t === 'area' || t === 'line' || t === 'hole' || t === 'measure') finish();
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [cx, cy] = local(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    // v0.16 Alt+wheel with the magnifier on: its magnification (×2..×8, remembered on this PC)
    if (e.altKey && aids().loupe) {
      if (dy) setAids({ zoom: aids().zoom + (dy < 0 ? 0.5 : -0.5) });
      return;
    }
    if (e.shiftKey && !e.ctrlKey) {
      view.current = { ...view.current, ox: view.current.ox - dy };
      viewChanged();
      return;
    }
    zoomAt(cx, cy, Math.pow(1.0018, -dy * (e.ctrlKey ? 2.2 : 1)));
  };

  /**
   * Keys go to the sheet whenever the pointer is over it or something is being
   * drawn — not only when the sheet has the keyboard focus — unless you are
   * typing in a box. Captured before the rest of the app, so Ctrl+Z here takes
   * back a point instead of undoing the last saved change.
   */
  const onKey = (e: KeyboardEvent) => {
    const pr = props.current;
    if (pr.passive) return;
    const el = myDoc().activeElement as HTMLElement | null;
    const typing = !!el && el !== cv.current && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    const busy = pts.current.length > 0 || !!typed.current || !!gripLen.current;
    // a box keeps its keys - also with a shape half drawn while the pointer is away from the sheet (BH-045:
    // clicking the take-off's Height to type in it lost the first digit to the drawing, and the box). With
    // the pointer back on the sheet the drawing takes the keyboard back (Backspace / Ctrl+Z undo a point)
    if (typing && (!busy || !pointerIn.current)) return;
    if (!busy && !pointerIn.current && el !== cv.current) return;
    if (qsAny('.scrim:not(.clear)')) return; // a dialog is open (in either window)
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    // the take-off's right-click menu (a door's, a shape's) is open: Esc is for it (the app closes it)
    // (v0.16: so is a popover of the tool bar / sheet bar - the keys list, the scale chip's menu)
    // (and any menu / popover that says it is open: People ▾, the BOQ tab's Show ▾, a row's ⋯, the colour picker)
    if (k === 'Escape' && (anyMenuOpen() || qsAny('.scrim.clear .rowmenu, [data-pop]'))) return;
    const consume = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (typing && busy) (el as HTMLElement).blur();

    // typed length after the first point
    if (pts.current.length && !ctrl && !e.altKey && DRAW_TOOLS.includes(pr.tool) && pr.tool !== 'scale' && /^[0-9.,]$|^[mc]$/i.test(k) && (typed.current || /[0-9.]/.test(k))) {
      typed.current += k;
      consume();
      syncBar();
      redraw();
      return;
    }
    // v0.16 an end grip clicked: the length of its segment (4.2 = m, 4200 = mm, 420cm)
    if (gripLen.current && !ctrl && !e.altKey && /^[0-9.,]$|^[mc]$/i.test(k) && (typed.current || /[0-9.]/.test(k))) {
      typed.current += k;
      consume();
      syncBar();
      redrawTop();
      return;
    }
    if (typed.current) {
      if (k === 'Backspace') { typed.current = typed.current.slice(0, -1); consume(); syncBar(); redraw(); return; }
      if (k === 'Escape') { typed.current = ''; consume(); syncBar(); redraw(); return; }
      if (k === 'Enter') { consume(); gripLen.current ? applyGripLen() : placeTyped(); return; }
    }
    if (gripLen.current && (k === 'Enter' || k === 'Backspace')) { consume(); return; }
    if (ctrl && (k === 'z' || k === 'Z') && !e.shiftKey) {
      if (undoPoint()) return consume();
      if (restore()) return consume();
      return; // the app undoes the last saved change
    }
    if (ctrl && ((k === 'y' || k === 'Y') || ((k === 'z' || k === 'Z') && e.shiftKey))) {
      if (busy && redoPoint()) return consume();
      return;
    }
    if (ctrl) return;
    // v0.16 picking a room's edges: Enter or Esc = done
    if (pr.edgePick && !busy && (k === 'Enter' || k === 'Escape')) {
      consume();
      if (menuRef.current) { setMenu(null); return; }
      pr.stepBar?.onDone();
      return;
    }
    if (k === 'Enter' && busy) { consume(); if (pr.tool === 'rect') return; finish(); return; }
    // v0.16 Esc stops, it does not destroy - each press the next thing: (typed length, above) -> the end
    // grip waiting for one -> placing a door -> a drag under way -> the shape being drawn is kept when it is
    // complete (else its loose nodes go) -> the ruler -> the selection -> the take-off / tool (the app)
    if (k === 'Escape') {
      consume();
      if (menuRef.current) { setMenu(null); return; }
      if (gripLen.current) { gripLen.current = null; syncBar(); redrawTop(); return; }
      if (placing.current) { setPlacing(null); return; }
      if (drag.current) { drag.current = null; snapHit.current = null; redraw(); return; }
      if (imgSel.current && !pts.current.length) { imgSel.current = null; redraw(); return; }
      if (pr.edgeSel && pr.onEdgeSel && !pts.current.length) { pr.onEdgeSel(null); return; }
      if (pts.current.length) keepOrDrop('esc');
      else if (measured.current) { measured.current = null; live(); redraw(); }
      else if (pr.selected.size) pr.onSelect([], false);
      else pr.onToolDone();
      return;
    }
    if ((k === 'Backspace' || k === 'Delete') && (pts.current.length || arcEnd.current)) { consume(); undoPoint(); return; }
    // walls: D = a door, O = another opening (the next click on a wall puts it there)
    // (v0.16 rooms: the same keys put one on a room's edge - while drawing its outline, or with one selected)
    const doorKey = !pr.readOnly && !e.altKey && !e.shiftKey && (k === 'd' || k === 'D' || k === 'o' || k === 'O');
    if (doorKey && pr.roomDoor && !pr.wallMode && ['area', 'select', 'rect', 'circle'].includes(pr.tool)) {
      consume();
      if (arcEnd.current) arcEnd.current = null;
      // the outline being drawn: kept first (closed), the door then goes on it
      if (pts.current.length) {
        if (pr.tool !== 'area' || pts.current.length < 3) { message('Finish the outline first (3 nodes or more), then D / O'); return; }
        finish();
      }
      const want = k === 'd' || k === 'D' ? 'door' : 'open';
      // (v0.16.1 D while placing doors, with a door in use: another door - Esc / the bar's Door button stop)
      if (want === 'door' && placing.current === 'door' && pr.doorChip) { pr.doorChip.onChange(chooserAt()); return; }
      setPlacing(placing.current === want ? null : want);
      return;
    }
    // (v0.18 the Length tool: D puts a door on the length; O stays its Circle shape - an opening: the bar's button)
    if (pr.wallMode && doorKey && ['line', 'select', 'rect', 'circle'].includes(pr.tool) && !(pr.plainLen && (k === 'o' || k === 'O') && !placing.current)) {
      consume();
      if (arcEnd.current) arcEnd.current = null;
      const want = k === 'd' || k === 'D' ? 'door' : 'open';
      if (want === 'door' && placing.current === 'door' && pr.doorChip) { pr.doorChip.onChange(chooserAt()); return; }
      setPlacing(placing.current === want ? null : want);
      return;
    }
    // arcs / straight for the next segments
    if (!e.altKey && ARC_TOOLS.includes(pr.tool) && pts.current.length && (k === 'a' || k === 'A' || k === 'l' || k === 'L')) {
      consume();
      setArc(k === 'a' || k === 'A');
      return;
    }
    if (k === 'Backspace' && pr.tool === 'count' && !pr.readOnly) {
      consume();
      if (counted.current > 0) { counted.current--; pr.onUndoCount(); live(); }
      return;
    }
    // (UI rule 5: Del deletes what has the keyboard - the take-off list has it: its take-offs, asked; not their
    // shapes on this sheet because the pointer rests on the drawing)
    const listKeys = !!el && el !== cv.current && !!el.closest?.('.qto-tree');
    // (v0.16.5 an open edge picked: Del makes it a wall edge - not the room deleted)
    if ((k === 'Delete' || k === 'Backspace') && pr.edgeSel && pr.onEdgeDel && !pr.readOnly && pr.tool === 'select' && !listKeys) { consume(); pr.onEdgeDel(); return; }
    if ((k === 'Delete' || k === 'Backspace') && imgSel.current && !pr.selected.size && pr.onImageDel && !pr.readOnly && pr.tool === 'select' && !listKeys) { consume(); const id = imgSel.current; imgSel.current = null; pr.onImageDel(id); return; }
    if ((k === 'Delete' || k === 'Backspace') && pr.selected.size && !pr.readOnly && pr.tool === 'select' && !listKeys) { consume(); pr.onDelete(); return; }
    if ((k === 'c' || k === 'C') && pts.current.length >= 3 && (pr.tool === 'area' || pr.tool === 'hole') && e.shiftKey) { consume(); finish(); return; }
    if (k === '+' || k === '=') { consume(); zoomAt(size.current.w / 2, size.current.h / 2, 1.25); return; }
    if (k === '-') { consume(); zoomAt(size.current.w / 2, size.current.h / 2, 0.8); return; }
    if (k === 'Home') { consume(); fit(); return; }
    const step = 80;
    const pan = (dx: number, dy: number) => { consume(); view.current = { ...view.current, ox: view.current.ox + dx, oy: view.current.oy + dy }; viewChanged(); };
    if (k === 'ArrowLeft') return pan(step, 0);
    if (k === 'ArrowRight') return pan(-step, 0);
    if (k === 'ArrowUp') return pan(0, step);
    if (k === 'ArrowDown') return pan(0, -step);
  };

  // ---------- lifecycle ----------
  useLayoutEffect(() => {
    const el = wrap.current!;
    const resize = () => {
      const r = el.getBoundingClientRect();
      const dpr = myWin().devicePixelRatio || 1;
      // (an area not laid out yet measures 0: not a measure)
      const real = r.width >= 2 && r.height >= 2;
      const step = measureStep({ real, sized: sized.current, remembered: views.has(viewKeyRef.current), fitOnGuess: fitOnGuess.current, viewSet: viewSet.current });
      if (real) { sized.current = true; fitOnGuess.current = false; }
      size.current = { w: Math.max(50, r.width), h: Math.max(50, r.height) };
      bufDpr.current = dpr;
      const c = cv.current!;
      c.width = Math.round(size.current.w * dpr);
      c.height = Math.round(size.current.h * dpr);
      c.style.width = size.current.w + 'px';
      c.style.height = size.current.h + 'px';
      if (step === 'fit') fit();
      else if (step === 'keep') viewChanged();
      else redraw();
    };
    const ro = new (myWin() as Window & { ResizeObserver: typeof ResizeObserver }).ResizeObserver(resize);
    ro.observe(el);
    // the screen's pixel ratio changes without the size changing (window moved to another monitor,
    // display scaling changed): size the buffer again
    let mq: MediaQueryList | null = null;
    const onDpr = () => { resize(); watchDpr(); };
    const watchDpr = () => {
      mq?.removeEventListener('change', onDpr);
      mq = myWin().matchMedia(`(resolution: ${myWin().devicePixelRatio || 1}dppx)`);
      mq.addEventListener('change', onDpr);
    };
    watchDpr();
    const wh = (e: WheelEvent) => onWheel(e);
    cv.current!.addEventListener('wheel', wh, { passive: false });
    const kd = (e: KeyboardEvent) => {
      shiftDown.current = e.shiftKey;
      if (e.key === ' ' && (myDoc().activeElement === cv.current || pointerIn.current || pts.current.length) && !(myDoc().activeElement as HTMLElement)?.matches?.('input,textarea,select')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) { spaceDown.current = true; spacePanned.current = false; }
        return;
      }
      onKey(e);
      if (e.key === 'Shift') { aim(); live(); redrawTop(); }
    };
    const ku = (e: KeyboardEvent) => {
      if (e.key === ' ' && spaceDown.current) {
        spaceDown.current = false;
        // a tap (no panning while it was held) ends the run
        if (!spacePanned.current && pts.current.length && DRAW_TOOLS.includes(props.current.tool)) breakRun();
      }
      shiftDown.current = e.shiftKey;
      if (e.key === 'Shift') { aim(); live(); redrawTop(); }
    };
    const kw = myWin();
    kw.addEventListener('keydown', kd, true);
    kw.addEventListener('keyup', ku, true);
    // (a key let go in another program - Alt+Tab with Space held - never came back as a keyup: every click then
    // panned - 0.23.2, DeepSeek #41)
    const blur = () => { spaceDown.current = false; shiftDown.current = false; };
    kw.addEventListener('blur', blur);
    // ortho / crosshair / magnifier switched (tool bar, F8, M, Alt+wheel): the pointer's point and the top again
    const offAids = onAids(() => { aim(); live(); redrawTop(); });
    return () => {
      offAids();
      if (loupeTimer.current) clearTimeout(loupeTimer.current);
      loupeSharp.current?.bmp.close();
      loupeSharp.current = null;
      ro.disconnect();
      mq?.removeEventListener('change', onDpr);
      cv.current?.removeEventListener('wheel', wh);
      kw.removeEventListener('keydown', kd, true);
      kw.removeEventListener('keyup', ku, true);
      kw.removeEventListener('blur', blur);
      // sharp renders are big: let them go now, not whenever the browser gets round to it
      unmounted.current = true;
      if (detail.current) { detail.current.bmp.close(); detail.current = null; }
      if (detail2.current) { detail2.current.bmp.close(); detail2.current = null; }
      tintCanvas.current = null;
    };
  }, []);

  // new sheet: restore its last view (or fit), drop the old sharp render
  useEffect(() => {
    if (detail.current) { detail.current.bmp.close(); detail.current = null; }
    if (detail2.current) { detail2.current.bmp.close(); detail2.current = null; }
    clearRun();
    measured.current = null;
    snapHit.current = null;
    perpHit.current = null;
    gripLen.current = null;
    syncBar();
    const v = views.get(viewKey);
    if (v) { view.current = v; viewSet.current = true; viewChanged(); } else fit();
  }, [viewKey, p.page.w, p.page.h]);

  useEffect(() => { if (p.fitToken) fit(); }, [p.fitToken]);
  // (v0.18.1 fresh eyes: the image picked is let go when shapes are picked, or another sheet is shown - Delete then
  // goes to them, never to an image picked before)
  useEffect(() => { if (p.selected.size) imgSel.current = null; }, [p.selected]);
  useEffect(() => { imgSel.current = null; }, [p.dkey, p.pg]);
  useEffect(() => {
    if (!p.focus) return;
    if (p.focus.ifOff) {
      const v = view.current, { w, h } = size.current, b = p.focus.box;
      const { x0, x1, y0, y1 } = boxOnScreen(b);
      if (x0 >= 0 && y0 >= 0 && x1 <= w && y1 <= h) return;
      // it fits at this zoom: only moved to the middle
      if (x1 - x0 < w * 0.9 && y1 - y0 < h * 0.9) {
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
        view.current = viewAt([cx, cy], w / 2, h / 2, v.s);
        viewChanged();
        return;
      }
    }
    zoomTo(p.focus.box);
  }, [p.focus?.token]);
  useEffect(() => { redraw(); }, [p.shapes, p.items, p.selected, p.active, p.preview, p.others, p.regions, p.notes, p.stale, p.openings, p.segHi, p.hiItems, p.proposals, p.viewOnly]);
  useEffect(() => { if (p.engine) viewChanged(); }, [p.engine, p.dkey]);
  useEffect(() => {
    if (detail2.current) { detail2.current.bmp.close(); detail2.current = null; }
    viewChanged();
  }, [p.compare?.key, p.compare?.mode, p.compare?.preview]);
  useEffect(() => {
    if (detailO.current) { detailO.current.bmp.close(); detailO.current = null; }
    viewChanged();
  }, [p.over?.key, p.over?.pg, p.over?.preview, p.over?.m.join(',')]);
  useEffect(() => { redraw(); }, [p.over?.alpha, p.over?.color, p.over?.crop, p.images]);
  // (tests only - qto.e2e on this PC: where a point of the sheet worked on is on the screen)
  useEffect(() => {
    if (p.passive) return;
    let on = false;
    try { on = localStorage.getItem('qto.e2e') === '1'; } catch { /* */ }
    if (!on) return;
    (globalThis as unknown as { __qtoView?: unknown }).__qtoView = {
      toClient: (x: number, y: number) => { const r = cv.current?.getBoundingClientRect(); const q = toScreen([x, y]); return r ? [r.left + q[0], r.top + q[1]] : null; },
      toSheet: (cx: number, cy: number) => { const r = cv.current?.getBoundingClientRect(); return r ? toSheet(cx - r.left, cy - r.top) : null; },
    };
  });
  useEffect(() => {
    // switching tool mid-shape: keep it restorable (Ctrl+Z on the same tool)
    if (pts.current.length) cancel('tool');
    counted.current = 0;
    typed.current = '';
    measured.current = null;
    snapHit.current = null;
    perpHit.current = null;
    gripLen.current = null;
    hoverGrip.current = null;
    setMenu(null);
    placing.current = null;
    syncBar();
    live();
    setCursor(p.tool === 'select' ? 'default' : 'none');
    redraw();
  }, [p.tool]);
  // v0.16 the app asks first, before it switches tool / take-off: a complete shape is kept (in the take-off
  // and tool it was drawn with); an incomplete one goes the old way (restorable)
  useEffect(() => { if (p.api) p.api.current = { keepShape: () => { const had = pts.current.length > 0; keepOrDrop('tool'); return had; } }; });
  // the marching ants move while something is selected: ~10 frames a second, the top layer only
  const antsOn = p.selected.size > 0 || !!p.segHi;
  useEffect(() => {
    if (!antsOn) return;
    const id = setInterval(() => { if (!myDoc().hidden) redrawTop(); }, 100);
    return () => clearInterval(id);
  }, [antsOn]);
  useEffect(() => { if (!p.wallMode && !p.roomDoor && placing.current) setPlacing(null); }, [p.wallMode, p.roomDoor]);
  // v0.16 rooms: placing asked for by a room step; picking edges started / ended
  useEffect(() => { if (p.armPlace && !p.readOnly) setPlacing(p.armPlace.k); }, [p.armPlace?.token]);
  useEffect(() => { hoverEdge.current = null; redraw(); }, [p.edgePick]);
  useEffect(() => { redraw(); }, [p.edgeSel?.shape, p.edgeSel?.seg]);
  // continue a line from its last point (v0.17: any line / outline from a node - new nodes after it, the rest kept)
  useEffect(() => {
    if (!p.resume) return;
    const s = p.shapes.find((x) => x.id === p.resume!.id);
    if (!s || s.k === 'pt' || (s.k !== 'line' && p.resume.from === undefined)) return;
    const n = s.pts.length, closed = s.k === 'poly';
    const B = Array.from({ length: closed ? n : n - 1 }, (_, i) => s.b[i] || 0);
    const SG = Array.from({ length: closed ? n : n - 1 }, (_, i) => s.sg[i] ?? null);
    const from = p.resume.from;
    tail.current = null;
    if (from !== undefined && !closed && from === 0 && n >= 2) {
      // (a line's first node: drawn on from it backwards - turned round again when kept)
      pts.current = [...s.pts].reverse();
      bul.current = [...B].reverse().map((x) => -x);
      tail.current = { pts: [], bul: [], base: n, rev: true, sg: SG, at: 0, closed: false };
    } else if (from !== undefined && (closed || from < n - 1) && from >= 0 && from < n) {
      pts.current = s.pts.slice(0, from + 1);
      bul.current = B.slice(0, from);
      tail.current = { pts: s.pts.slice(from + 1), bul: B.slice(from + 1), base: from + 1, rev: false, sg: SG, at: from, closed };
    } else {
      pts.current = [...s.pts];
      bul.current = B;
    }
    arcEnd.current = null;
    resumeId.current = s.id;
    redoPts.current = [];
    syncBar();
    live();
    redraw();
    cv.current?.focus();
  }, [p.resume?.token]);

  // snapping index: built in the background the first time snapping is wanted on a sheet
  useEffect(() => {
    if (!p.snapOn || !p.engine || !p.dkey) { p.onSnapState('off'); return; }
    if (p.engine.snapReadyNow(p.dkey, p.pg)) { p.onSnapState('ready'); }
    else p.onSnapState('preparing');
    let alive = true;
    p.engine.prepareSnap(p.dkey, p.pg).then(() => alive && p.onSnapState('ready')).catch(() => alive && p.onSnapState('failed'));
    return () => { alive = false; };
  }, [p.snapOn, p.engine, p.dkey, p.pg]);

  // ---------- the action bar ----------
  const tool = p.tool;
  const drawingTool = DRAW_TOOLS.includes(tool);
  const n = bar.n;
  const finishOk = tool === 'line' ? n >= 2 : tool === 'area' || tool === 'hole' ? n >= 3 : false;
  const hint: Partial<Record<Tool, string>> = {
    area: 'Click the nodes · click the first one (or double-click / Enter / Esc) to finish',
    rect: p.closedAs === 'line' ? 'Rectangle as a length (its perimeter): click one corner, then the opposite one' : 'Click one corner, then the opposite corner',
    circle: p.closedAs === 'line' ? 'Circle as a length (its circumference): click the centre, then a point on it' : 'Click the centre, then a point on the circle',
    line: 'Click along the line · double-click, Enter or Esc to finish',
    count: 'Click each one',
    hole: 'Select an area first, then draw the cut-out inside it',
    measure: 'Click from point to point — nothing is saved',
    scale: 'Click both ends of a dimension you know',
    region: 'Drag a box around a detail drawn at another scale',
    note: 'Click where the note belongs',
  };

  return (
    <div
      ref={wrap}
      className="sheetcanvas"
      onPointerEnter={() => { pointerIn.current = true; }}
      onPointerLeave={() => { pointerIn.current = false; hover.current = null; hoverShape.current = null; snapHit.current = null; perpHit.current = null; hoverGrip.current = null; props.current.onCursor(null); redraw(); }}
    >
      <canvas
        ref={cv}
        tabIndex={0}
        style={{ cursor }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={onDouble}
        onContextMenu={(e) => e.preventDefault()}
      />
      {p.compare && (
        <div className="cmp-legend">
          {p.compare.mode === 'overlay' ? (
            <><span className="k red" /> only in {p.compare.label} (removed) <span className="k blue" /> only in the current revision (added) <span className="k dark" /> unchanged{!p.preview && <i> · preparing the current revision…</i>}</>
          ) : (
            <>Showing <b>{p.compare.label}</b> — the take-offs are drawn over it</>
          )}
        </div>
      )}
      {/* the sheet's picture is not ready yet (a big sheet opened for the first time takes seconds): say so,
          rather than a blank page that looks like an empty drawing (shown after a moment, not for a quick open) */}
      {!p.preview && !p.compare && <div className="cmp-legend sheet-wait" data-sheetwait>Preparing this sheet — the first time takes a few seconds; from then on it opens at once.</div>}
      {sharpErr && <div className="cmp-legend" style={{ top: p.compare ? 40 : undefined }} title={sharpErr}>The sharp view could not be drawn — you see the preview. {sharpErr}</div>}
      {(tool !== 'select' || bar.msg || bar.canRestore || bar.placing || p.stepBar) && !p.readOnly && (
        <div className={'qto-bar' + (n ? ' on' : '')} onPointerDown={(e) => e.stopPropagation()}>
          {p.stepBar && (
            <span className="roomstep" data-roomstep>
              <span className="what">{p.stepBar.text}</span>
              <button className="bb primary" onClick={() => { keepOrDrop('esc'); p.stepBar?.onDone(); cv.current?.focus(); }} title="Enter">Done</button>
              <button className="bb" onClick={() => { if (pts.current.length) cancel('tool'); p.stepBar?.onCancel(); cv.current?.focus(); }} title="Nothing of this step is kept">Cancel</button>
            </span>
          )}
          {n === 0 && p.modeStrip}
          {bar.msg ? <span className="msg" title={bar.msg}>{bar.msg}</span> : n === 0 && (drawingTool || tool === 'region' || tool === 'note') && !(tool === 'measure' && measured.current) ? <span className="msg dim" title={hint[tool]}>{hint[tool]}</span> : null}
          <span className="live" ref={liveEl} />
          {bar.typed && <span className="typed" title={'Typed: ' + bar.typed}>→ {typedLabel(bar.typed)}</span>}
          {bar.canRestore && <button className="bb" onClick={() => { restore(); cv.current?.focus(); }}>↶ Bring back the shape</button>}
          {ARC_TOOLS.includes(tool) && drawingTool && (
            <span className="segmode" title="Next segments straight or as arcs (keys L / A while drawing)">
              <button className={!bar.arc ? 'on' : ''} onClick={() => { setArc(false); cv.current?.focus(); }}>╱ Straight <kbd>L</kbd></button>
              <button className={bar.arc ? 'on' : ''} onClick={() => { setArc(true); cv.current?.focus(); }}>◠ Arc <kbd>A</kbd></button>
            </span>
          )}
          {bar.arcEnd && <span className="tip">now click a point the arc passes through</span>}
          {drawingTool && n > 0 && tool !== 'rect' && tool !== 'circle' && tool !== 'scale' && (
            <>
              <button className="bb" onClick={() => { undoPoint(); cv.current?.focus(); }} title="Backspace or Ctrl+Z">↶ Undo node <kbd>⌫</kbd></button>
              {(tool === 'area' || tool === 'hole') && <button className="bb" disabled={!finishOk} onClick={() => { finish(); cv.current?.focus(); }} title="Close the shape back to the first point">Close</button>}
              {tool !== 'area' && tool !== 'hole' && <button className="bb primary" disabled={!finishOk && tool !== 'measure'} onClick={() => { finish(); cv.current?.focus(); }} title="Enter, Esc or double-click">✓ Finish <kbd>↵</kbd></button>}
              <button className="bb" onClick={() => { cancel('esc'); cv.current?.focus(); }} title="Throw this shape away — Bring back (or Ctrl+Z) for 15 s">✕ Cancel</button>
            </>
          )}
          {tool === 'count' && counted.current > 0 && (
            <button className="bb" onClick={() => { if (counted.current > 0) { counted.current--; p.onUndoCount(); live(); setBar((b) => ({ ...b })); } }} title="Backspace">↶ Undo last <kbd>⌫</kbd></button>
          )}
          {drawingTool && n > 0 && tool !== 'scale' && tool !== 'rect' && tool !== 'circle' && <span className="tip keys">Space = next run · Shift = ortho · type a length + Enter · Esc = finish</span>}
          {bar.resume && <span className="tip">{p.wallMode && !p.plainLen ? 'continuing the wall' : 'continuing the line'}</span>}
          {/* (v0.16.1 placing doors from Select - on walls already drawn: the bar says which door, ▾ = another) */}
          {bar.placing === 'door' && p.doorChip && tool === 'select' && <button data-doorchip className="doorchip" title="The door each click puts on a wall - click to choose another" onClick={(e) => p.doorChip!.onChange([e.clientX - 40, e.clientY - 300])}>{p.doorChip.tag} ▾</button>}
          {((p.wallMode && (tool === 'line' || tool === 'rect' || tool === 'circle')) || (p.roomDoor && !p.wallMode && (tool === 'area' || tool === 'rect' || tool === 'circle'))) && (
            <span className="segmode" title="Doors and other openings on the wall: press the key, then click on the wall">
              <button data-place="door" className={bar.placing === 'door' ? 'on' : ''} onClick={() => { togglePlace('door'); cv.current?.focus(); }}>Door <kbd>D</kbd></button>
              {p.doorChip && <button data-doorchip className="doorchip" title="The door each click puts on a wall - click to choose another" onClick={(e) => p.doorChip!.onChange([e.clientX - 40, e.clientY - 300])}>{p.doorChip.tag} ▾</button>}
              <button data-place="open" className={bar.placing === 'open' ? 'on' : ''} onClick={() => { togglePlace('open'); cv.current?.focus(); }}>Other opening <kbd>O</kbd></button>
              {p.onOpenEdges && p.roomDoor && !p.wallMode && <button data-place="edge" title="Click the room’s edges that have no wall (an open kitchen…)" onClick={() => { keepOrDrop('tool'); p.onOpenEdges?.(); }}>Open edge (no wall)</button>}
            </span>
          )}
          {bar.placing && !bar.msg && <span className="msg" title="Esc = back">Click on the {placeOn()} where the {bar.placing === 'door' ? 'door' : 'opening'} is · Esc = back</span>}
        </div>
      )}
      {menu && (
        <div className="rowmenu drawmenu" style={{ left: Math.min(menu.x, size.current.w - 240), top: Math.min(menu.y, size.current.h - 190) }} onPointerDown={(e) => e.stopPropagation()}>
          <div className="mh">{n} node{n === 1 ? '' : 's'}</div>
          {(tool === 'area' || tool === 'hole') && <button className="mi" disabled={!finishOk} onClick={() => finish()}><span className="ck">✓</span><span className="lb">Close and finish</span><span className="kb">Enter / Esc</span></button>}
          {(tool === 'line' || tool === 'measure') && <button className="mi" disabled={!finishOk && tool !== 'measure'} onClick={() => finish()}><span className="ck">✓</span><span className="lb">Finish</span><span className="kb">Enter / Esc</span></button>}
          {(tool === 'line' || tool === 'measure') && <button className="mi" onClick={() => { setMenu(null); breakRun(); }}><span className="ck">⏎</span><span className="lb">End this run, start the next</span><span className="kb">Space</span></button>}
          <button className="mi" onClick={() => { setMenu(null); undoPoint(); }}><span className="ck">↶</span><span className="lb">Undo last node</span><span className="kb">Backspace</span></button>
          {ARC_TOOLS.includes(tool) && (bar.arc
            ? <button className="mi" onClick={() => { setMenu(null); setArc(false); }}><span className="ck">╱</span><span className="lb">Straight segments</span><span className="kb">L</span></button>
            : <button className="mi" onClick={() => { setMenu(null); setArc(true); }}><span className="ck">◠</span><span className="lb">Arc segments</span><span className="kb">A</span></button>)}
          <div className="msep" />
          <button className="mi danger" onClick={() => cancel('esc')}><span className="ck">✕</span><span className="lb">Cancel this shape</span></button>
        </div>
      )}
    </div>
  );
}

/** the ants' dash moves along at a steady speed (screen px per second), whatever the frame rate */
const antPhase = () => ((performance.now() / 1000) * 14) % 11;

/**
 * v0.16: what painting costs, for the record (and the tests): scene = the take-offs drawn again,
 * frame = everything (scene when needed + the top layer + the magnifier). Times in ms.
 */
const PAINT = { frames: 0, frameMs: 0, frameMax: 0, scenes: 0, sceneMs: 0, sceneMax: 0, reset() { this.frames = this.frameMs = this.frameMax = this.scenes = this.sceneMs = this.sceneMax = 0; } };
(globalThis as unknown as { __qtoPaint?: typeof PAINT }).__qtoPaint = PAINT;
function paintStat(sceneMs: number, frameMs: number) {
  PAINT.frames++; PAINT.frameMs += frameMs; PAINT.frameMax = Math.max(PAINT.frameMax, frameMs);
  if (sceneMs >= 0) { PAINT.scenes++; PAINT.sceneMs += sceneMs; PAINT.sceneMax = Math.max(PAINT.sceneMax, sceneMs); }
}

const rectOf = (a: Pt, b: Pt): Pt[] => [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
/** a circle round centre c through e: two half circles */
const circleOf = (c: Pt, e: Pt): [Pt[], number[]] => [[e, [2 * c[0] - e[0], 2 * c[1] - e[1]]], [1, 1]];

const hatches = new Map<string, CanvasPattern | null>();
/** diagonal hatching in a take-off's colour (Area fill: hatched) */
function hatch(ctx: CanvasRenderingContext2D, color: string): CanvasPattern | null {
  let pt = hatches.get(color);
  if (pt !== undefined) return pt;
  const c = document.createElement('canvas');
  c.width = c.height = 10;
  const x = c.getContext('2d')!;
  x.strokeStyle = hexA(color, 0.8);
  x.lineWidth = 1.2;
  x.beginPath();
  x.moveTo(0, 10); x.lineTo(10, 0);
  x.moveTo(-5, 5); x.lineTo(5, -5);
  x.moveTo(5, 15); x.lineTo(15, 5);
  x.stroke();
  pt = ctx.createPattern(c, 'repeat');
  hatches.set(color, pt);
  return pt;
}

function hexA(hex: string, a: number) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Size of the numbers on the drawing (Decimals > Number size). They are drawn at a fixed size on
 * the SCREEN, not on the sheet: zoomed out over a big sheet or zoomed right in on a detail, a
 * label is the same readable size - never a giant number across half the screen.
 */
const fsz = () => qtoFmt().size;

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, align: 'left' | 'center') {
  if (!text) return;
  const k = fsz();
  ctx.save();
  ctx.font = `600 ${11.5 * k}px Inter Variable, Segoe UI, sans-serif`;
  const w = ctx.measureText(text).width + 10 * k;
  const bx = align === 'center' ? x - w / 2 : x;
  const by = align === 'center' ? y - 10 * k : y;
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(bx, by, w, 20 * k, 5 * k);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#10201f';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + 5 * k, by + 10.5 * k);
  ctx.restore();
}

function segDistTo(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function smallLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  const k = fsz();
  ctx.save();
  ctx.font = `600 ${10.5 * k}px Inter Variable, Segoe UI, sans-serif`;
  const w = ctx.measureText(text).width + 8 * k;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - 8 * k, w, 16 * k, 4 * k);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#10201f';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}
