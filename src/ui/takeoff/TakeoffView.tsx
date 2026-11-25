// The take-off workspace: drawings on the left, the sheet in the middle, take-offs
// and the BOQ on the right. Used on its own by QS (take-off projects) and inside an
// estimation project's Take-off tab by estimators.
import { useHelp } from '../Help';
import { pointsInProgress } from '../closeGuards';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePopouts, useOverlayHost, openPopout, closePopout, closeAllPopouts, popoutOf, onActiveWin, activeWin, qsAny } from '../popout';
import { generateKeyBetween } from 'fractional-indexing';
import { gt, type AppInfo } from '../api';
import type { Auth } from '../App';
import type { ProjectSession } from '../../engine/session';
import type { Op, PresenceInfo, Value } from '../../engine/types';
import { buildQtoModel, pageKey, scaleAt, shapeQtyAt, needsFormat3, needsFormat16, needsFormat164, needsFormat165, needsFormat17, needsFormat18, needsFormat181, doorTagKey, openingSize, isLineKind, doorItem, filePage, isOldBinder, isPageSheet, sheetTitle, type QtoModel, type Shape, type TItem, type Kind, type Note, type Opening } from '../../engine/qto/model';
import { scaleFromRatio, scaleText, scalesInText, selfCrosses, polyInside, polysOverlap, bbox, flatten as flattenPath, yRatio, arcCircle, type Box, type Pt } from '../../engine/qto/geometry';
import { newItemOps, newStructOps, imageOps, shapeOps, moveShapesOps, copyShapesOps, addHoleOps, vertexOps, insertVertexOps, deleteVertexOps, replacePointsOps, noteOps, deleteItemOps, setBulgeOps, splitLineOps, splitLineAtOps, explodeLineOps, joinLinesOps, openingOps, doorRowsOps, duplicateItemOps, reassignOpeningsOps, newShapesIn } from '../../engine/qto/ops';
import { issueFromPath, replacedInPlaceOps, markCheckedOps, makeCurrentOps, moveOffPageOps, revLabel, splitBinderOps, type FoundFile } from '../../engine/qto/revisions';
import { exportQto } from '../../engine/qto/export';
import type { Template } from '../../engine/qto/templates';
import { randomId } from '../../engine/ids';
import { pdfEngine, engineNotices, type PdfEngine, type PageSize } from './pdfengine';
import { loadDrawing, preview, previewScale, statPicked, trimCache, drives, toUnc, baseName, fingerprint, heavySrc, locate, scanPdf, siblingFingerprints, type Loaded } from './drawings';
import { SheetTabs, FloatTab, GoToSheetMenu, MAX_TABS, openTab, closeTab, emptyTab, moveTab, closeOthers, retarget, tabTarget, floatTab, mainTabOf, tabLabel, type SheetTab } from './Sheets16';
import { SheetLoc, holdOpened, dropOpened, type Own, type OwnState, type Opened } from './SheetWindows';
import { ImportDialog, RegisterDialog } from './Register';
import { leavesInOrder } from '../../engine/qto/headings';
import { SheetPrep, type PrepState } from './prep';
import { SheetCanvas, alignMat, applyMat, invMat, type Mat6, type OverSpec, type Tool, type OtherCursor, type CompareSpec, type VertexRef, type SegRef, type OpeningMark, type SheetApi } from './SheetCanvas';
import { OverlayPicker } from './Overlay18';
import { ImagesMenu, type ImagePlace } from './Images18';
import { sheetLabel } from './Panels';
import { KeysButton, ScaleChip, ClearScaleDialog, AID_ICON } from './Aids16';
import { aids, setAids, useAids } from './aids';
import { bandWidthOf, clearScaleOps, shapesLosingScale } from '../../engine/qto/drawaids';
import { beamTagOps, beamTagProposals, type BeamProp, type MemberCat } from '../../engine/qto/beamsched';
import { STRUCT_TOOLS, type StructTool } from './StructButton';
import { ToolBarGroups, TB_GROUP_LABEL, type TbGroup } from './ToolBar18';
import { HScroll } from './Scroller';
import { SK_KIND, SK_LABEL, IMAGE_FILE_RE, colTypeOf, tagBase, hasTagOwn, isCountedStruct, typesFor, shapeOverridden, type StructKind, type Measure } from '../../engine/qto/model';
import { DuplicateDialog, DoorScheduleDialog, BeamTypesDialog, type SchedTab, OpeningPicker, AutoCountDialog, mmOf } from './Dialogs15';
import { findTags, tagKey, type Found, type TagMode, type Word } from '../../engine/qto/autocount';
import { ITEM_COLORS, overAlignId } from '../../engine/qto/model';
import { DrawingsPanel, ItemsPanel, BoqPanel, NotesPanel } from './Panels';
import { onRevealInBoq } from './boqnav';
import type { EstEdit } from './BoqTab';
import { unresolvedCount } from '../../engine/qto/additional';
import { fitOnScreen } from './ItemTree';
import { FORMAT_XY_SCALES, FORMAT_WALLS, FORMAT_V16, FORMAT_V164, FORMAT_V165, FORMAT_V17, FORMAT_V18, FORMAT_V181 } from '../../engine/version';
import { ScaleDialog, RegionDialog, CopyDialog, NoteDialog, LinkDialog, RepeatDialog, MoveToItemDialog, type ScaleDir } from './Dialogs';
import { TIcon } from './ticons';
import { m1, m2, qtoFmt, useQtoFmt } from './numfmt';
import { NumFmtFace, NumFmtPop } from './NumFmtPop';
import { usePanelWidth, PanelEdge } from '../PanelSize';
import { descendants } from '../../engine/qto/headings';
import { deleteNodesOps, deleteQuestion, duplicateHeadingOps, hiddenItemsOf, loadHidden, saveHidden, toggleHeadEye, toggleItemEye, type Hidden } from '../../engine/qto/listops';
import { DeleteDialog } from './ListBits';
import { MultiLinkDialog } from './MultiProps';
import { catOfSk, typeSize } from './Panels15';
import { SheetQtyTable, segBox } from './SheetQty';
import { isMine, jointLabel, mayEdit, ownerOf, ownership, ownerText, peopleWithShapes, shownFor, shownPeople } from '../../engine/qto/owners';
import { listAccounts } from '../../engine/accounts';
import { EditOthersChip, InUseBy, OwnerBits, PeopleButton } from './People16';
// v0.16 rooms on the drawing (group g1)
import { duplicateRoomOps, newRoomOps, roomOpeningOps, setOpeningSillOps, pickEdgeLineOps } from '../../engine/qto/roomops';
import { alongOutline, copyWithRoomsOps, deleteShapesOps, edgeFlagFits, edgeToggleOps, hiddenWithRooms, isRoomOutline, nearestOutline, outlineFollowOps, roomDoorRefusal, roomOutlines, tagText, withAttached } from '../../engine/qto/roomdraw';
import { edgeFlags } from '../../engine/qto/rooms';
import { onRoomMode, roomModeDone, type RoomMode } from './roommode';
import { doorCounterOps, doorCountOps, doorCountRefusal, DOOR_COUNTER_NAME } from '../../engine/qto/doorcount';
import { FinishesSummary } from './FinishesSummary';

type Load =
  | { state: 'none' }
  | { state: 'loading'; text: string }
  | { state: 'missing' }
  | { state: 'error'; text: string; heavyPg?: number }
  | { state: 'ready'; key: string; pages: PageSize[]; changed: boolean; path: string; gone?: boolean; bad?: string; dwg: string; pg: number };

export type RightTab = 'items' | 'boq' | 'notes';

/** the tool bar: WHAT is measured (or another tool); HOW it is drawn is the shape mode (below) */
type UiTool = 'select' | 'area' | 'line' | 'count' | 'wall' | 'beam' | 'room' | 'hole' | 'measure' | 'scale' | 'region' | 'note';
type ShapeMode = 'path' | 'rect' | 'circle';
const TOOLS: { k: UiTool; label: string; key: string; hint: string }[] = [
  { k: 'select', label: 'Select', key: 'V', hint: 'Select, move, edit nodes. Drag on empty paper: window (→) / crossing (←) selection. Pan: middle / right drag, Space + drag, wheel.' },
  { k: 'area', label: 'Area', key: 'A', hint: 'Floors, ceilings, slabs: node by node (or a rectangle / circle)' },
  { k: 'line', label: 'Length', key: 'L', hint: 'Skirting, kerbs, pipes: along the line' },
  { k: 'count', label: 'Count', key: 'C', hint: 'Click each one' },
  { k: 'wall', label: 'Wall', key: 'B', hint: 'Blockwork: length × height × width. While drawing: D = a door, O = another opening' },
  { k: 'beam', label: 'Beam', key: 'E', hint: 'Beams by type: concrete, formwork, steel' },
  { k: 'room', label: 'Room', key: 'F', hint: 'Finishes: draw the room’s outline as an area. D = a door, O = another opening on it' },
  { k: 'hole', label: 'Cut-out', key: 'H', hint: 'Select an area first, then draw the part to cut out of it' },
  { k: 'measure', label: 'Ruler', key: 'Q', hint: 'Measure without saving anything' },
  { k: 'scale', label: 'Scale', key: 'S', hint: 'Click both ends of a dimension you know' },
  { k: 'region', label: 'Viewport', key: 'W', hint: 'Drag around a detail drawn at another scale' },
  { k: 'note', label: 'Note', key: 'N', hint: 'Click where the note belongs' },
];
/** v0.16 the tool bar's HELPERS group (the others: WHAT is measured) */
const HELPER_TOOLS: UiTool[] = ['hole', 'measure', 'scale', 'region', 'note'];
/** tools that draw a shape in one of the modes (polygon / polyline, rectangle, circle) */
const MODE_TOOLS: UiTool[] = ['area', 'line', 'wall', 'beam', 'room'];

const TOOL_FOR_KIND: Record<Kind, UiTool> = { area: 'area', line: 'line', count: 'count', wall: 'wall', beam: 'beam', room: 'room' };
/** which kind of take-off a measuring tool makes */
const KIND_OF_TOOL: Partial<Record<UiTool, Kind>> = { area: 'area', line: 'line', count: 'count', wall: 'wall', beam: 'beam', room: 'room' };
/** what the drawing does for a tool in a mode */
const canvasToolOf = (t: UiTool, mode: ShapeMode, holeMode: ShapeMode = 'path'): Tool => {
  // (v0.17.1 a cut-out drawn as a box or a circle too - its own mode, the measuring tool's stays as it was)
  if (t === 'hole') return holeMode === 'rect' ? 'rect' : holeMode === 'circle' ? 'circle' : 'hole';
  if (!MODE_TOOLS.includes(t)) return t as Tool;
  if (mode === 'rect') return 'rect';
  if (mode === 'circle') return 'circle';
  return t === 'area' || t === 'room' ? 'area' : 'line';
};

export function TakeoffView(props: {
  session: ProjectSession;
  info: AppInfo;
  auth: Auth;
  projectDir: string;
  readOnly: boolean;
  toast: (t: ReactNode, opts?: { action?: { label: string; fn: () => void }; color?: string }) => void;
  /** shown inside an estimation project */
  embedded?: boolean;
  others: PresenceInfo[];
  onModel?: (m: QtoModel) => void;
  /** the take-off on its own: linking it to an estimate, at the top of the BOQ panel (nothing when linked) */
  linkBox?: ReactNode;
  /** v0.16: inside the estimate - additional items' lines are changed in the estimate */
  estEdit?: EstEdit | null;
}) {
  const { session, info, auth, projectDir, readOnly, toast } = props;
  // what the drawing engines need said (one stopping again and again, one that stopped answering)
  useEffect(() => {
    const say = (text: string) => toast(text, { color: '#b45309' });
    engineNotices.add(say);
    return () => { engineNotices.delete(say); };
  }, []);
  const me = auth.account;
  // F1 opens the list with the take-off's keys first, "where you are" (0.23.2, DeepSeek #27: never set)
  const help = useHelp();
  useEffect(() => { help.setContext('qto'); return () => help.setContext(null); }, []);
  const [ver, setVer] = useState(0);
  useEffect(() => session.onChange(() => setVer((v) => v + 1)) as unknown as () => void, [session]);
  const model = useMemo(() => buildQtoModel(session.store, { username: me.username, seeAll: auth.isAdmin }), [session, ver, me.username, auth.isAdmin]);
  const modelRef = useRef(model);
  modelRef.current = model;
  useEffect(() => { props.onModel?.(model); }, [model]);

  const storeKey = 'qto:' + session.meta.id;
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem(storeKey) ?? '{}'); } catch { return {}; } }, []);
  const [cur, setCur] = useState<{ dwg: string; pg: number } | null>(saved.cur && typeof saved.cur.dwg === 'string' ? tabTarget(model, { dwg: saved.cur.dwg, pg: Math.max(0, Math.floor(Number(saved.cur.pg) || 0)) }) : null);
  // v0.16: the sheets open in tabs (remembered per PC per project with the current one, `cur`); only the
  // current tab's sheet is loaded - the others are a name and a remembered view (zoom / pan per file page)
  const tabSeq = useRef(0);
  const newTabId = () => 't' + ++tabSeq.current;
  const [tabs, setTabs] = useState<SheetTab[]>(() => {
    // (a sheet split into separate sheets since: its page's sheet)
    const list = (Array.isArray(saved.tabs) ? saved.tabs : []).filter((t: any) => t && typeof t.dwg === 'string').map((t: any) => tabTarget(model, { dwg: t.dwg as string, pg: Math.max(0, Math.floor(Number(t.pg) || 0)) })).filter((t: { dwg: string; pg: number } | null, i: number, all: ({ dwg: string; pg: number } | null)[]) => !!t && all.findIndex((x) => !!x && x.dwg === t.dwg && x.pg === t.pg) === i);
    if (cur && !list.some((t: { dwg: string; pg: number }) => t.dwg === cur.dwg && t.pg === cur.pg)) list.push(cur);
    // (v0.16.4 a tab that was in its own window opens in it again)
    const fl = new Set((Array.isArray(saved.tabs) ? saved.tabs : []).filter((t: any) => t && t.fl).map((t: any) => t.dwg + '#' + t.pg));
    return list.slice(-MAX_TABS).map((t: { dwg: string; pg: number }) => ({ id: newTabId(), dwg: t.dwg, pg: t.pg, ...(fl.has(t.dwg + '#' + t.pg) ? { fl: true } : {}) }));
  });
  const [curTab, setCurTab] = useState<string | null>(() => (cur ? tabs.find((t) => t.dwg === cur.dwg && t.pg === cur.pg)?.id ?? null : null));
  /** tab ids, used longest ago first (the 11th tab closes the first of them) */
  const tabUsed = useRef<string[]>(curTab ? [curTab] : []);
  const tabsRef = useRef(tabs);
  const curTabRef = useRef(curTab);
  const [tool, setTool] = useState<UiTool>('select');
  // v0.16.4 sheet tabs in their own windows (popout.ts)
  const pops = usePopouts();
  const overlayEl = useOverlayHost();
  useEffect(() => () => closeAllPopouts(), []);
  const [mode, setMode] = useState<ShapeMode>(saved.mode === 'rect' || saved.mode === 'circle' ? saved.mode : 'path');
  /** v0.17.1 (Feedback 3: "need box option for deducting the openings in slab") how a cut-out is drawn: a box first */
  const [holeMode, setHoleMode] = useState<ShapeMode>('rect');
  // (the take-off being measured into is not brought back when the project is opened again: the next
  // shape of its kind went into it silently)
  const [activeId, setActiveId] = useState<string | null>(null);
  // ONE selection (v0.16): shapes on the drawing and rows in the take-off list. Shapes selected on the
  // drawing select their take-offs' rows; rows selected in the list select their shapes on the sheet open.
  const [selected, setSelectedRaw] = useState<Set<string>>(new Set());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  /** rows selected in the take-off list (take-offs, headings) */
  const [selRows, setSelRows] = useState<Set<string>>(new Set());
  const rowsFollow = useRef(false);
  /** shapes selected (on the drawing, or after a shape was made / split / copied): their rows go with them */
  const setSelected = (v: Set<string> | ((s: Set<string>) => Set<string>)) => {
    const n = typeof v === 'function' ? v(selectedRef.current) : v;
    selectedRef.current = n;
    setSelectedRaw(n);
    if (n.size) rowsFollow.current = true;
  };
  useEffect(() => {
    if (!rowsFollow.current) return;
    rowsFollow.current = false;
    const tis = new Set<string>();
    const byId = new Map(model.shapes.map((x) => [x.id, x.ti]));
    for (const id of selected) { const ti = byId.get(id); if (ti) tis.add(ti); }
    if (tis.size) setSelRows(tis);
  }, [selected, model]);
  const [snapOn, setSnapOn] = useState<boolean>(saved.snap ?? true);
  const [snapState, setSnapState] = useState<'off' | 'preparing' | 'ready' | 'failed'>('off');
  /** v0.18.1 the aids (ortho, crosshair, magnifier) as they are now: the tool bar's View group shows them */
  const aidsNow = useAids();
  const [right, setRight] = useState<RightTab>(saved.right ?? 'items');
  /** v0.16 (g2, item 33): the Finishes Summary window (Finalize) */
  const [finOpen, setFinOpen] = useState(false);
  const [engine, setEngine] = useState<PdfEngine | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ state: 'none' });
  const [prev, setPrev] = useState<{ key: string; pg: number; bmp: ImageBitmap; scale: number } | null>(null);
  /** "Fit the sheet" asked for (a count), on the sheet it was asked on */
  const [fitToken, setFitToken] = useState<{ n: number; pk: string } | null>(null);
  /** v0.18 (Feedback 3, 1) sheets shown turned (quarter turns, clockwise): how they are looked at on this PC */
  const rotKey = 'qto.rot.' + session.meta.id;
  const [rots, setRots] = useState<Record<string, number>>(() => { try { return JSON.parse(localStorage.getItem(rotKey) ?? '{}') ?? {}; } catch { return {}; } });
  const rotOf = (k: string) => (rots[k] ?? 0) % 4;
  const turnSheet = (k: string) => setRots((r) => { const n = { ...r, [k]: ((r[k] ?? 0) + 1) % 4 }; if (!n[k]) delete n[k]; try { localStorage.setItem(rotKey, JSON.stringify(n)); } catch { /* */ } return n; });
  /** a box to zoom to on a sheet ("show it on the drawing"); pk: the sheet it is on */
  const [focus, setFocus] = useState<{ box: Box; token: number; pk: string; ifOff?: boolean } | null>(null);
  const [dialog, setDialog] = useState<
    | null
    | { k: 'scale'; a: Pt; b: Pt; next?: ScaleDir | null; nextScope?: 'page' | 'group' | 'all' }
    | { k: 'region'; box: Box }
    | { k: 'copy'; ids: string[] }
    | { k: 'note'; on: string; at?: Pt }
    | { k: 'link'; ti: string; measure?: Measure }
    | { k: 'repeat'; ids: string[] }
    | { k: 'moveto'; ids: string[] }
    | { k: 'import'; found: FoundFile[]; issue: string }
    | { k: 'register'; focus?: string }
    | { k: 'dup'; ti: string }
    | { k: 'doors' }
    | { k: 'beams'; cat?: MemberCat }
    | { k: 'linkdoor'; id: string }
    | { k: 'auto' }
    | { k: 'del'; ids: string[] }
    | { k: 'linkmany'; ids: string[]; measure?: Measure }
  >(null);
  /** auto-count: what was found on a sheet, each kept (on) or left out, waiting to be counted */
  const [auto, setAuto] = useState<{ dwg: string; pg: number; q: string; perTag: boolean; doors?: boolean; list: { f: Found; on: boolean; dup: boolean; in: string }[] } | null>(null);
  const wordsCache = useRef(new Map<string, Word[]>());
  /** v0.16.6 beam marks found on the sheet, each with the segment it would tag (kept when said) */
  const [beamAuto, setBeamAuto] = useState<{ dwg: string; pg: number; list: BeamProp[]; cat?: 'beam' | 'wall' | 'rwall' } | null>(null);
  /** v0.17 the structural element the tool measures (a slab with the Area tool...; '' = none) */
  const [sk, setSk] = useState<StructKind>('');
  /** the Structure button: the last one picked */
  const [lastStruct, setLastStruct] = useState<StructTool>('beam');
  /** the column type each click of the Columns tool puts down */
  const [colType, setColType] = useState('');
  /** v0.18 a stair: the area being drawn is a flight or a landing */
  const [stairPart, setStairPart] = useState<'f' | 'l'>('f');
  /** the schedules' last tab */
  const [schedTab, setSchedTab] = useState<SchedTab>('doors');
  /** v0.17 column marks found on the sheet: columns placed there (kept when said) */
  const [colAuto, setColAuto] = useState<{ dwg: string; pg: number; list: { p: Pt; bt: string; text: string; on: boolean; dup: boolean }[]; ck?: 'col' | 'sw' | 'ftg' } | null>(null);
  /** v0.15: the door / opening picker on the drawing, segments picked in the details, take-offs highlighted */
  const [opick, setOpick] = useState<{ k: 'door' | 'open'; shape: string; p: Pt; client: [number, number]; edit?: Opening; choose?: 'wall' | 'count' } | null>(null);
  // v0.16.1 the last door placed or counted: the next click uses it (shown on the bar, ▾ = another) -
  // walls, rooms and the Count tool's door mode alike
  const [lastDoor, setLastDoor] = useState<{ id: string; lint: boolean } | null>(null);
  /** the Count tool counts doors of the schedule (doors not on a wall: cores, partitions) */
  const [doorModeSet, setDoorMode] = useState(false);
  // (tests: forget the last door, so the next door asks again)
  useEffect(() => { (window as unknown as { __gtClearLastDoor?: () => void }).__gtClearLastDoor = () => setLastDoor(null); }, []);
  const [segHi, setSegHi] = useState<{ shape: string; segs: number[] } | null>(null);
  // show / hide on the drawing (v0.16): this person's, on this PC, per project - never shared
  const hideKey = 'qto.hide.' + session.meta.id;
  const [hidden, setHidden] = useState<Hidden>(() => loadHidden(hideKey));
  useEffect(() => { saveHidden(hideKey, hidden); }, [hidden]);
  // (v0.16: a room's own finishes are hidden with their room, or by their own eye)
  const hiddenItems = useMemo(() => hiddenWithRooms(model, hiddenItemsOf(model.itemTree, hidden, model.roomParts), hidden), [model.itemTree, model.roomParts, hidden]);
  const [sqOpen, setSqOpen] = useState(() => { try { return localStorage.getItem('qto.sheetQty.open') === '1'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem('qto.sheetQty.open', sqOpen ? '1' : '0'); } catch { /* */ } }, [sqOpen]);
  const [menu, setMenu] = useState<{ x: number; y: number; shape: string | null; p: Pt; vertex: VertexRef | null; seg: SegRef | null; opening?: string | null } | null>(null);
  /** heading new take-offs go under */
  const [curHead, setCurHead] = useState('');
  const [resume, setResume] = useState<{ id: string; token: number; from?: number } | null>(null);
  const [cmp, setCmp] = useState<{ rv: string; mode: 'overlay' | 'previous'; pg?: number } | null>(null);
  /** pg: the page of the earlier file shown; spg: that page counted from the sheet's page; one: the sheet was one page of it */
  const [cmpLoaded, setCmpLoaded] = useState<{ rv: string; key: string; bmp: ImageBitmap | null; scale: number; page: { w: number; h: number }; pg: number; pages: number; spg: number; one: boolean } | null>(null);
  // a sheet's preview is tens of MB: free the one replaced (or left behind) straight away
  useEffect(() => () => { prev?.bmp.close(); }, [prev]);
  useEffect(() => () => { cmpLoaded?.bmp?.close(); }, [cmpLoaded]);
  const [revMenu, setRevMenu] = useState(false);
  const [uncMap, setUncMap] = useState<Record<string, string>>({});
  useEffect(() => { drives().then(setUncMap); }, []);
  const [detectedScales, setDetectedScales] = useState<number[]>([]);
  const [showLeft, setShowLeft] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [rw, setRw] = usePanelWidth('qto-right', (() => { try { return Number(localStorage.getItem('qto:rw')) || 380; } catch { return 380; } })(), 300, 800);
  useEffect(() => {
    try { localStorage.setItem(storeKey, JSON.stringify({ cur, tabs: tabs.map((t) => ({ dwg: t.dwg, pg: t.pg, ...(t.fl ? { fl: true } : {}) })), snap: snapOn, right, mode })); } catch { /* ignore */ }
  }, [cur, tabs, snapOn, right, mode]);
  // v0.16: "show it in the BOQ" (boqnav.ts revealInBoq): the BOQ tab opens and takes it from there
  useEffect(() => onRevealInBoq(session.meta.id, () => setRight('boq')), [session]);

  // Undo / Redo say what they could not do (someone else worked on it since)
  const doUndo = () => {
    const r = session.undo();
    if (r?.refused) toast('Not undone: someone else has worked on what it made since (a part of the split, the joined length). Nothing was changed. Ctrl+Z again goes to the step before.');
    else if (r?.skipped) toast(`Undone. ${r.skipped} value${r.skipped > 1 ? 's were' : ' was'} left alone because someone changed ${r.skipped > 1 ? 'them' : 'it'} since.`);
  };
  const doRedo = () => {
    const r = session.redo();
    if (r?.skipped) toast(`Redone, except ${r.skipped} value${r.skipped > 1 ? 's' : ''} someone changed since.`);
  };
  // ---------- v0.16 (e): each person's shapes ----------
  /** a QS sees his own shapes (others' to look at, switched on); estimators and administrators everyone's */
  const isQs = me.role === 'qs' && !auth.isAdmin;
  const peopleKey = 'qto.people.' + session.meta.id;
  const [showOthers, setShowOthers] = useState<boolean>(() => { try { return localStorage.getItem(peopleKey) === '1'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(peopleKey, showOthers ? '1' : '0'); } catch { /* */ } }, [showOthers]);
  /** estimators: whose shapes are shown (null = everyone's) - this session */
  const [pickPeople, setPickPeople] = useState<Set<string> | null>(null);
  /** estimators / administrators: other people's shapes can be changed (this session, off at the start) */
  const [editOthers, setEditOthersRaw] = useState(false);
  const mayEditOthers = !isQs && !readOnly && editOthers;
  const editOthersRef = useRef(mayEditOthers);
  editOthersRef.current = mayEditOthers;
  const people = useMemo(() => shownPeople({ qs: isQs, me: me.username, showOthers, pick: pickPeople }), [isQs, me.username, showOthers, pickPeople]);
  const names = useMemo(() => { const n = new Map<string, string>(); try { for (const a of listAccounts(auth.accounts.store)) n.set(a.username, a.name); } catch { /* */ } return n; }, [auth.accounts, ver]);
  const nameOf = useCallback((u: string) => names.get(u) || u, [names]);
  const nameOfRef = useRef(nameOf);
  nameOfRef.current = nameOf;
  /** someone else's shape that this person may not change: whose it is, said on the drawing / in a message */
  const lockedWhy = (s: Shape) => `${nameOf(ownerOf(model, s))}'s shape — view only.${isQs || readOnly ? '' : ' People ▾ › Edit other people\'s shapes to change it.'}`;
  const lockedMsg = (list: Shape[]) => {
    const who = [...new Set(list.map((s) => nameOfRef.current(ownerOf(modelRef.current, s))))];
    return <span>Not changed: {list.length === 1 ? 'that is' : 'those are'} <b>{who.join(', ')}</b>'s shape{list.length === 1 ? '' : 's'} — view only.{isQs ? '' : <> To change {list.length === 1 ? 'it' : 'them'}: <b>People ▾ › Edit other people's shapes</b>.</>}</span>;
  };

  // v0.16 a room step asked for by the room panel (roommode.ts) - what it committed, for its Cancel
  const stepRef = useRef<RoomMode | null>(null);
  const stepMarks = useRef<object[]>([]);
  const stepRec = useRef(false);
  /** a change made on the drawing: recorded for a room step's Cancel */
  const onDrawing = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => { stepRec.current = true; try { return fn(...a); } finally { stepRec.current = false; } };
  const commit = useCallback((ops: Op[], label: string, opts?: { recordUndo?: boolean }) => {
    if (!ops.length) return null;
    if (readOnly || session.readOnly) { toast('View only — you can look but not change this take-off.'); return null; }
    // v0.16 (e): other people's shapes are view only (unless switched on); a change of one makes this person a
    // joint owner of it, in its history ("… — Ahmed's shape, also edited by Nabil")
    if (opts?.recordUndo !== false) {
      const own = ownership(modelRef.current, ops, me.username, editOthersRef.current, { boq: !isQs });
      if (own.locked.length) { toast(lockedMsg(own.locked)); return null; }
      if (own.ops.length) {
        ops = [...ops, ...own.ops];
        label = jointLabel(label, own.joint, modelRef.current, nameOfRef.current, me.name);
      }
    }
    // walls, beams, door schedules (v0.15): older apps open the project view-only rather than misread them
    if (needsFormat3(ops as [string, string, unknown][])) session.needFormat(FORMAT_WALLS);
    if (needsFormat16(ops as [string, string, unknown][])) session.needFormat(FORMAT_V16);
    if (needsFormat164(ops as [string, string, unknown][])) session.needFormat(FORMAT_V164);
    if (needsFormat165(ops as [string, string, unknown][])) session.needFormat(FORMAT_V165);
    if (needsFormat17(ops as [string, string, unknown][])) session.needFormat(FORMAT_V17);
    if (needsFormat18(ops as [string, string, unknown][])) session.needFormat(FORMAT_V18);
    if (needsFormat181(ops as [string, string, unknown][])) session.needFormat(FORMAT_V181);
    const r = session.commit(ops, label, opts);
    // (what the drawing commits during a room step - not the panel's changes meanwhile - for its Cancel)
    if (r && stepRef.current && stepRec.current && opts?.recordUndo !== false) { const mk = session.undoMark(); if (mk) stepMarks.current.push(mk); }
    return r;
  }, [session, readOnly, toast]);

  // ---------- PDF engine ----------
  useEffect(() => {
    let alive = true;
    pdfEngine().then((e) => alive && setEngine(e)).catch((e) => alive && setEngineError('The PDF engine could not start: ' + String(e?.message ?? e)));
    return () => { alive = false; };
  }, []);

  // a sheet in a tab was removed by someone (its tab closes; the one used last before comes up); or its new
  // revision has fewer pages
  const applyTabs = (r: { tabs: SheetTab[]; used: string[]; cur: string | null }) => {
    tabsRef.current = r.tabs;
    curTabRef.current = r.cur;
    tabUsed.current = r.used;
    setTabs(r.tabs);
    setCurTab(r.cur);
    const t = r.cur ? r.tabs.find((x) => x.id === r.cur) : null;
    // (v0.17.1 a new, empty tab shows no sheet)
    setCur((c) => (t && t.dwg ? (c && c.dwg === t.dwg && c.pg === t.pg ? c : { dwg: t.dwg, pg: t.pg }) : null));
  };
  useEffect(() => {
    const tl = tabsRef.current;
    let changed = false;
    const fixed = tl.flatMap((t) => {
      if (!t.dwg) return [t];
      const d = model.dwgById.get(t.dwg);
      // (split into separate sheets by someone: the tab goes to its page's sheet)
      if (!d) { changed = true; const to = tabTarget(model, t); return to ? [{ ...t, ...to }] : []; }
      if (d.pages > 0 && t.pg >= d.pages) { changed = true; return [{ ...t, pg: d.pages - 1 }]; }
      return [t];
    });
    if (changed) {
      const u = tabUsed.current.filter((x) => fixed.some((t) => t.id === x));
      const c = curTabRef.current;
      applyTabs({ tabs: fixed, used: u, cur: c && fixed.some((t) => t.id === c) ? c : u[u.length - 1] ?? fixed[0]?.id ?? null });
    } else if (cur && !model.dwgById.has(cur.dwg)) setCur(null);
  }, [model]);

  // ---------- background preparation of every sheet ----------
  const [prep, setPrep] = useState<PrepState | null>(null);
  const [prepPaused, setPrepPaused] = useState(false);
  const [thumbVer, setThumbVer] = useState(0);
  const loadingRef = useRef(false);
  const prepRef = useRef<SheetPrep | null>(null);
  useEffect(() => {
    if (!trimmed) { trimmed = true; trimCache(info.localDir).catch(() => {}); }
    const p = new SheetPrep({
      drawings: () => modelRef.current.drawings,
      localDir: info.localDir,
      projectDir,
      commit: readOnly ? null : (ops) => session.commit(ops, 'Drawing fingerprint', { recordUndo: false }),
      busy: () => loadingRef.current,
      onState: setPrep,
      onPrepared: () => setThumbVer((v) => v + 1),
    });
    prepRef.current = p;
    p.run();
    return () => p.stop();
  }, [session]);
  useEffect(() => { prepRef.current?.poke(); }, [model.drawings.length]);
  useEffect(() => { prepRef.current?.setPaused(prepPaused); }, [prepPaused]);

  // ---------- open the current drawing ----------
  // (opened again when its file changes: a new revision brought in, by anyone)
  const curPath = cur ? model.dwgById.get(cur.dwg)?.path ?? '' : '';
  // (v0.16: or its page of the file - a page of a bound set taken back to another page of the same file)
  const curFp = cur ? model.dwgById.get(cur.dwg)?.fp ?? -1 : -1;
  const openedRef = useRef<{ dwg: string; path: string; hash: string; r: Loaded } | null>(null);
  // v0.16.4 every drawing open in the PDF engine (this window's and the sheet windows'): turning to another
  // window's sheet needs no reading of its file again
  const openedAll = useRef<Opened>(new Map());
  const [loadTry, setLoadTry] = useState(0);
  useEffect(() => {
    if (!engine || !cur) { setLoad({ state: 'none' }); return; }
    const d = modelRef.current.dwgById.get(cur.dwg);
    if (!d) return;
    let alive = true;
    const o0 = openedRef.current, c0 = openedAll.current.get(d.id);
    const hit = (x: { path: string; hash: string; r: Loaded } | null | undefined) => !!x && x.path === d.path && x.hash === d.hash && engine.isOpen(x.r.key);
    // (open already - here or in a sheet window: no "Opening…" in between)
    if (load.state !== 'ready' || (!(hit(o0) && (o0!.dwg === d.id || (isPageSheet(d) && !!d.hash))) && !hit(c0))) setLoad({ state: 'loading', text: 'Opening ' + (d.title || d.name) + '…' });
    setSelected(new Set());
    setDetectedScales([]);
    setCmp(null);
    setCmpLoaded(null);
    (async () => {
      const t0 = performance.now();
      // another page of the drawing already open: no need to read (and fingerprint) the file again
      const o = openedRef.current;
      const known = (modelRef.current.revisions.get(d.id) ?? []).map((x) => x.hash).filter(Boolean);
      const progress = (text: string) => { if (alive) setLoad({ state: 'loading', text }); };
      // (another page of the same bound set too: the same file)
      const c = openedAll.current.get(d.id);
      const r = o && (o.dwg === d.id || (isPageSheet(d) && !!d.hash)) && hit(o) ? { ...o.r, ops: [] } : hit(c) ? { ...c!.r, ops: [] } : await loadDrawing(d, info.localDir, engine, { known, progress, wanted: () => alive });
      if (!alive) return;
      if ('missing' in r) { setLoad({ state: 'missing' }); return; }
      openedRef.current = { dwg: d.id, path: d.path, hash: d.hash, r };
      holdOpened(openedAll.current, d, r, 'live');
      heavyRef.current = { key: r.key, file: r.file, size: r.src.size ?? 0 };
      if (!r.pages.length) { setLoad({ state: 'error', text: 'This PDF has no pages to show.' }); return; }
      // (a page of a bound set: the set's other pages nobody opened yet get the fingerprint too)
      if (r.ops.length && !readOnly) session.commit([...r.ops, ...siblingFingerprints(modelRef.current.drawings, d, r.ops)], 'Drawing fingerprint', { recordUndo: false });
      // the page of the file (a page of a bound set is its page of the set)
      const pg = Math.min(filePage(d, cur.pg), r.pages.length - 1);
      const page = r.pages[pg];
      // a new file for a drawing nothing has been measured on yet: nothing to check - simply the new version
      let changed = r.changed;
      if (changed && !readOnly && !session.readOnly && !modelRef.current.shapes.some((x) => x.dwg === d.id)) {
        const st = await gt().files.stat(r.path).catch(() => null);
        if (!alive) return;
        const when = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        if (st && commit(replacedInPlaceOps(modelRef.current, d, { hash: r.key, size: st.size, mtime: st.mtime, pages: r.pages.length }, { user: me.username, rev: '', issue: 'replaced ' + when }), 'New version of drawing (nothing measured on it)')) changed = false;
      }
      setLoad({ state: 'ready', key: r.key, pages: r.pages, changed, path: r.path, gone: r.gone, bad: r.bad, dwg: d.id, pg: cur.pg });
      if (engine.converted.has(r.key)) {
        toast(<span>This sheet is a <b>{engine.converted.get(r.key)!.toUpperCase()} picture</b> with a .pdf name, not a real PDF. It opens, but there are no lines to snap to and no scale text — set the scale from a known dimension.</span>, { color: '#b45309' });
      }
      if (!prev || prev.key !== r.key || prev.pg !== pg) {
        const bmp = await preview(engine, r.key, pg, page, info.localDir, projectDir, (ms) => {
          if (ms > 1500) toast(`First time this sheet was opened: it took ${(ms / 1000).toFixed(1)} s to prepare. From now on it opens at once — for everyone.`);
        }).catch((e) => { if (alive) setLoad({ state: 'error', text: String(e?.message ?? e), heavyPg: e?.heavy && !engine.converted.has(r.key) ? pg : undefined }); return null; }); // (a sheet left meanwhile: not written over the one now open - 0.23.2, DeepSeek #19)
        if (!bmp) return;
        if (!alive) { bmp.close(); return; }
        setPrev({ key: r.key, pg, bmp, scale: previewScale(page) });
      }
      gt().log(`sheet ${d.name} ready in ${Math.round(performance.now() - t0)} ms (${r.fromCache ? 'local copy' : 'from server'})`);
      // what scale does the sheet say?
      engine.text(r.key, pg).then((t) => alive && setDetectedScales(scalesInText(t).slice(0, 4))).catch(() => {});
    })().catch((e) => alive && setLoad({ state: 'error', text: String(e?.message ?? e) }));
    return () => { alive = false; dropOpened(openedAll.current, d.id, 'live'); };
  }, [engine, cur?.dwg, cur?.pg, curPath, curFp, loadTry]);

  // a sheet that ran the drawing engine out of memory twice: its line work simplified on request
  const heavyRef = useRef<{ key: string; file: string; size: number } | null>(null);
  const [simplifying, setSimplifying] = useState(false);
  const simplifySheet = async (pg: number) => {
    const h = heavyRef.current;
    if (!h || !engine || simplifying) return;
    setSimplifying(true);
    try {
      const st = await gt().files.stat(h.file);
      await heavySrc(info.localDir, h.key, h.file, st?.size ?? h.size, undefined, [pg]);
      engine.close(h.key);
      openedRef.current = null;
      for (const [k, v] of openedAll.current) if (v.r.key === h.key) openedAll.current.delete(k);
      toast('The line work of this sheet was simplified (drawn the same, far lighter for the PDF engine). Done once on this PC.');
      setLoadTry((x) => x + 1);
    } catch (e: any) {
      toast(String(e?.message ?? e), { color: '#b45309' });
    } finally { setSimplifying(false); }
  };

  loadingRef.current = load.state === 'loading';
  // (the sheet worked on: its own load - for a moment after turning to another window's sheet, none yet)
  const ready = load.state === 'ready' && cur && load.dwg === cur.dwg && load.pg === cur.pg ? load : null;
  /** the page of the file on screen (v0.16: a page of a bound set is its page of the set; else the sheet's page) */
  const fpg = cur ? filePage(model.dwgById.get(cur.dwg), cur.pg) : 0;
  const page: PageSize | null = ready && cur ? ready.pages[Math.min(fpg, ready.pages.length - 1)] ?? null : null;
  const pk = cur ? pageKey(cur.dwg, cur.pg) : '';
  const pageShapes = useMemo(() => (cur ? model.shapesByPage.get(pk) ?? [] : []), [model, pk]);
  const pageRegions = useMemo(() => (cur ? model.regions.filter((r) => r.dwg === cur.dwg && r.pg === cur.pg) : []), [model, pk]);
  const pageNotes = useMemo(() => (cur ? model.notes.filter((n) => n.dwg === cur.dwg && n.pg === cur.pg && n.x !== null) : []), [model, pk]);
  const pageInfo = model.pages.get(pk);
  // the scale was set on a page of another size (a revision issued on other paper, or rotated)
  const sizeChanged = !!(page && pageInfo?.sc && pageInfo.w && pageInfo.h && (Math.abs(pageInfo.w - page.w) > Math.max(2, page.w * 0.01) || Math.abs(pageInfo.h - page.h) > Math.max(2, page.h * 0.01)));
  const active: TItem | null = activeId ? model.itemById.get(activeId) ?? null : null;
  // v0.16.2 measuring into "Doors (not on walls)" is door mode: a plain mark never goes into the door counter
  const doorMode = doorModeSet || (tool === 'count' && !!active?.dc);
  const curDrawing = cur ? model.dwgById.get(cur.dwg) ?? null : null;
  // each sheet window's title: its sheet (the taskbar shows which is which)
  useEffect(() => {
    for (const p of pops.list) {
      const t = tabs.find((x) => x.id === p.id);
      const d = t ? model.dwgById.get(t.dwg) : null;
      const name = d ? [d.sheet, sheetTitle(d)].filter(Boolean).join(' - ') : 'Sheet';
      try { if (p.win.document.title !== `${name} - Goldline Takeoff`) p.win.document.title = `${name} - Goldline Takeoff`; } catch { /* closed */ }
    }
  }, [pops.list, tabs, model]);

  // ---------- v0.16: opening a sheet (every way of getting to one goes through here) ----------
  /** zoom to / select on a sheet once it is on screen */
  const pendingGo = useRef<{ pk: string; box?: Box; select?: string[] } | null>(null);
  /**
   * Open a sheet: its tab if it is open in one, else a new tab (past MAX_TABS the tab used longest ago closes).
   * inTab: the current tab moves to it instead (PgUp / PgDn). zoomToItem: zoom to
   * that take-off's shapes on it; box: zoom there; select: those shapes are selected.
   */
  // v0.17.1 (Feedback 3: "drawing tabs are getting congested because every click opens a new tab ... like Windows 11
  // Explorer") a sheet opens in the tab in use; newTab (middle-click, "Open in a new tab"): in a tab of its own;
  // dup: a second tab on a sheet already open. A sheet already in a tab: that tab comes up.
  const openSheet = (dwg: string, pg: number, opts: { newTab?: boolean; inTab?: boolean; dup?: boolean; zoomToItem?: string; select?: string[]; box?: Box } = {}) => {
    const m = modelRef.current;
    if (!m.dwgById.has(dwg)) return;
    // (another sheet while a shape is half drawn: it was thrown away - as for a tab, 0.23.2, DeepSeek #18)
    if ((!cur || cur.dwg !== dwg || cur.pg !== pg) && pointsInProgress() > 0) { toast('Finish or cancel the shape you are drawing first (Enter / Esc).'); return; }
    // the same sheet clicked again after it failed to open (still being copied, the server was away): try again
    if (cur && cur.dwg === dwg && cur.pg === pg && (load.state === 'error' || load.state === 'missing')) setLoadTry((x) => x + 1);
    let box = opts.box;
    if (opts.zoomToItem) {
      const list = (m.shapesByItem.get(opts.zoomToItem) ?? []).filter((x) => x.dwg === dwg && x.pg === pg);
      if (list.length) box = list.reduce((b, x) => ({ x0: Math.min(b.x0, x.box.x0), y0: Math.min(b.y0, x.box.y0), x1: Math.max(b.x1, x.box.x1), y1: Math.max(b.y1, x.box.y1) }), { ...list[0].box });
    }
    pendingGo.current = box || opts.select ? { pk: pageKey(dwg, pg), box, select: opts.select } : null;
    const tl = tabsRef.current, id = curTabRef.current;
    const here = !!id && tl.some((t) => t.id === id);
    const have = tl.some((t) => t.dwg === dwg && t.pg === pg);
    if (!opts.dup && here && (opts.inTab || (!have && !opts.newTab))) {
      // (another tab on that sheet stays as it is: nothing the user opened closes by itself)
      const tl2 = retarget(tl, id!, { dwg, pg });
      applyTabs({ tabs: tl2, used: [...tabUsed.current.filter((x) => x !== id && tl2.some((t) => t.id === x)), id!], cur: id! });
    } else applyTabs(openTab(tl, tabUsed.current, { dwg, pg }, newTabId, !!opts.dup));
    // already on screen: at once
    if (cur && cur.dwg === dwg && cur.pg === pg) setTimeout(applyPending, 0);
  };
  const applyPending = () => {
    const g = pendingGo.current;
    if (!g || g.pk !== pkRef.current || !readyRef.current) return;
    pendingGo.current = null;
    // (after the sheet's own view is set up: its remembered one, or fitted once the drawing area is measured)
    setTimeout(() => {
      // (v0.16 e: those shown for the people chosen)
      if (g.select) { const ok = new Set(shownRef.current.map((x) => x.id)); setSelected(new Set(g.select.filter((id) => ok.has(id)))); }
      if (g.box) setFocus({ box: g.box, token: Date.now(), pk: g.pk });
    }, 150);
  };
  const pkRef = useRef(pk);
  pkRef.current = pk;
  const readyRef = useRef(!!ready);
  readyRef.current = !!ready;
  useEffect(() => { applyPending(); }, [ready?.key, pk, load.state]);
  const pickTab = (id: string) => {
    const t = tabsRef.current.find((x) => x.id === id);
    // (another tab while a shape is half drawn: it was thrown away for good - 0.23.2, DeepSeek #18)
    if (t && id !== curTabRef.current && pointsInProgress() > 0) { toast('Finish or cancel the shape you are drawing first (Enter / Esc).'); return; }
    if (t) applyTabs({ tabs: tabsRef.current, used: [...tabUsed.current.filter((x) => x !== id), id], cur: id });
  };
  const closeTabId = (id: string) => applyTabs(closeTab(tabsRef.current, tabUsed.current, id, curTabRef.current));

  // ---------- v0.16.4 sheet tabs in their own windows ----------
  /** a tab from a sheet window is dragged over the main window's tabs */
  const [dropHere, setDropHere] = useState(false);
  const floatTabs = tabs.filter((t) => t.fl);
  const mainTab = mainTabOf(tabs, tabUsed.current, curTab);
  const drawingNow = (id: string) => id === curTabRef.current && pointsInProgress() > 0;
  const MOVE_BUSY = 'Finish or cancel the shape you are drawing first (Enter / Esc): moving its sheet to another window would lose it.';
  const winOf = (t: SheetTab, at?: { x: number; y: number }) => {
    const d = modelRef.current.dwgById.get(t.dwg);
    const name = d ? [d.sheet, sheetTitle(d)].filter(Boolean).join(' - ') : 'Sheet';
    const p = openPopout(t.id, pageKey(t.dwg, t.pg), name + ' - Goldline Takeoff', () => dockTab(t.id, true), at);
    // (its window closed with a shape half drawn in it: not closed - finish or cancel the shape first)
    p?.win.addEventListener('beforeunload', (e) => {
      if (curTabRef.current === t.id && pointsInProgress() > 0) { e.preventDefault(); e.returnValue = ''; toast(MOVE_BUSY); }
    });
    return p;
  };
  /** a tab into its own window (at: where it was dropped, on the screen) */
  const undockTab = (id: string, at?: { x: number; y: number }) => {
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t || t.fl) return;
    if (drawingNow(id)) { toast(MOVE_BUSY); return; }
    if (!winOf(t, at)) { toast('The sheet\'s window could not be opened.', { color: '#b45309' }); return; }
    applyTabs({ tabs: floatTab(tabsRef.current, id, true), used: tabUsed.current, cur: curTabRef.current });
  };
  /** back into the main window (closed: its window was closed by the person - it is gone already) */
  const dockTab = (id: string, closed = false) => {
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t || !t.fl) return;
    if (!closed && drawingNow(id)) { toast(MOVE_BUSY); return; }
    if (!closed) closePopout(id);
    setDropHere(false);
    // (put back by the person: the sheet worked on, in the main window; a window closed: the sheet goes back
    // to the main window, worked on if it was)
    const cur0 = curTabRef.current;
    applyTabs({ tabs: floatTab(tabsRef.current, id, false), used: [...tabUsed.current.filter((x) => x !== id), id], cur: closed ? cur0 : id });
  };
  // ---------- v0.18.1 (Feedback 3, D Phase 1) a sheet in the pane beside the main one, in this window ----------
  /** into the side pane (the one there goes back to the strip) or back from it */
  const sideTab = (id: string, on: boolean) => {
    if (drawingNow(id)) { toast(MOVE_BUSY); return; }
    const tl = tabsRef.current.map((t) => (t.id === id ? { ...t, sd: on || undefined } : on && t.sd ? { ...t, sd: undefined } : t));
    applyTabs({ tabs: tl, used: tabUsed.current, cur: curTabRef.current });
  };
  const sideT = tabs.find((t) => t.sd && !t.fl) ?? null;
  const [splitR, setSplitR] = useState<number>(() => { try { const v = Number(localStorage.getItem('qto.splitR')); return v > 0.15 && v < 0.85 ? v : 0.5; } catch { return 0.5; } });
  const splitEl = useRef<HTMLDivElement>(null);
  const dragSplit = (e: React.PointerEvent) => {
    const el = splitEl.current;
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const mv = (ev: PointerEvent) => { const v = Math.min(0.85, Math.max(0.15, (ev.clientX - r.left) / r.width)); setSplitR(v); };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); setSplitR((v) => { try { localStorage.setItem('qto.splitR', String(v)); } catch { /* */ } return v; }); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  const showFloat = (id: string) => { const p = popoutOf(id); if (p) p.win.focus(); else dockTab(id, true); };
  /** the sheet in another place becomes the one worked on (a click there, or its window brought to the front) */
  const activateTab = (id: string) => {
    if (id === curTabRef.current) return;
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t) return;
    if (pointsInProgress() > 0) { toast('Finish or cancel the shape you are drawing first (Enter / Esc).'); return; }
    // (what was selected goes, as when another tab is picked: Delete / Move act on the sheet worked on only)
    pickTab(id);
  };
  const activateRef = useRef(activateTab);
  activateRef.current = activateTab;
  /** where the main window's tab strip is on the screen (a sheet window's tab dragged back onto it) */
  const mainStrip = async () => {
    const el = document.querySelector('[data-maintabs]') as HTMLElement | null;
    const c = await gt().win?.content().catch(() => null);
    if (!el || !c) return null;
    const r = el.getBoundingClientRect();
    return { x: c.x + r.left, y: c.y + r.top, w: r.width, h: r.height };
  };
  // a sheet window brought to the front (or clicked): its sheet is the one worked on - at once, so the click
  // that brought it is already for it
  const restoreUntil = useRef(0);
  useEffect(() => onActiveWin((where) => {
    if (where === 'main' || Date.now() < restoreUntil.current) return;
    if (tabsRef.current.some((t) => t.id === where && t.fl)) activateRef.current(where);
  }), []);
  // the tabs that were in their own windows last time: in them again
  useEffect(() => {
    let tl = tabsRef.current;
    const fl = tl.filter((t) => t.fl);
    if (!fl.length) return;
    restoreUntil.current = Date.now() + 1200;
    for (const t of fl) if (!winOf(t)) tl = floatTab(tl, t.id, false);
    window.focus();
    if (tl !== tabsRef.current) applyTabs({ tabs: tl, used: tabUsed.current, cur: curTabRef.current });
  }, []);
  // a tab closed (or put back) while its window is open: the window goes
  useEffect(() => {
    for (const p of pops.list) { const t = tabs.find((x) => x.id === p.id); if (!t || !t.fl) closePopout(p.id); }
  }, [tabs, pops.list]);
  // the sheet worked on is in a window not in front (a sheet opened that is already there): that window to the front
  useEffect(() => {
    const t = curTab ? tabsRef.current.find((x) => x.id === curTab) : null;
    if (t?.fl && pops.active !== t.id) popoutOf(t.id)?.win.focus();
  }, [curTab]);
  const stepTab = (dir: number) => {
    const tl = tabsRef.current;
    if (tl.length < 2) return;
    const i = tl.findIndex((t) => t.id === curTabRef.current);
    pickTab(tl[(i + dir + tl.length) % tl.length].id);
  };
  const dwgSearch = useRef<HTMLInputElement>(null);
  /** "Go to sheet…" of a take-off: its list, at the pointer */
  const [goSheet, setGoSheet] = useState<{ ti: string; x: number; y: number } | null>(null);
  const openPdf = async (id: string) => {
    const d = model.dwgById.get(id);
    if (!d) return;
    const loc = await locate(d).catch(() => null);
    gt().openPath(loc?.path ?? d.path);
  };
  // ---------- the selection (v0.16) ----------
  /** the take-offs of rows (a heading: everything under it) */
  const itemsOfRows = (rows: Iterable<string>, m: QtoModel = modelRef.current) => {
    const out = new Set<string>();
    for (const id of rows) {
      if (m.headingById.has(id)) { for (const x of descendants(m.itemTree, id).items) if (m.itemById.has(x)) out.add(x); }
      else if (m.itemById.has(id)) out.add(id);
    }
    return out;
  };
  const selItems = useMemo(() => itemsOfRows(selRows, model), [selRows, model]);
  const selItemList = useMemo(() => leavesInOrder(model.itemTree).filter((id) => selItems.has(id)).map((id) => model.itemById.get(id)!).filter(Boolean), [selItems, model]);
  /** v0.18 the shapes picked on the drawing (for their own figures in the take-off's settings) */
  const selShapeList = useMemo(() => (selected.size ? model.shapes.filter((s) => selected.has(s.id)) : []), [selected, model]);
  const pageShapesRef = useRef(pageShapes);
  pageShapesRef.current = pageShapes;
  const hiddenRef = useRef(hiddenItems);
  hiddenRef.current = hiddenItems;
  /** the shapes drawn on the sheet open (see shownShapes) */
  const shownRef = useRef<Shape[]>([]);
  /** the shapes of take-offs on the sheet open (those shown: their eye, and v0.16 e whose they are) */
  const shapesOfItems = (items: Set<string>) => new Set(shownRef.current.filter((x) => items.has(x.ti)).map((x) => x.id));
  /** rows selected in the list: their shapes on this sheet are selected with them */
  const pickRows = (rows: Set<string>) => {
    setSelRows(rows);
    const n = shapesOfItems(itemsOfRows(rows));
    selectedRef.current = n;
    setSelectedRaw(n);
    setSegHi(null);
  };
  // another sheet opened: the rows stay selected, and their shapes on it are
  useEffect(() => {
    if (!selRows.size) return;
    const n = shapesOfItems(itemsOfRows(selRows));
    selectedRef.current = n;
    setSelectedRaw(n);
  }, [pk]);
  /** what fades on the drawing: everything but the take-offs selected (while shapes are selected) */
  const hiItems = useMemo(() => {
    if (!selected.size) return null;
    const n = new Set(selItems);
    for (const x of pageShapes) if (selected.has(x.id)) n.add(x.ti);
    return n;
  }, [selected, selItems, pageShapes]);
  const onEye = (id: string) => {
    const n = model.headingById.has(id) ? toggleHeadEye(model.itemTree, id, hidden) : toggleItemEye(id, hidden);
    setHidden(n);
    // what is hidden is not selected on the drawing any more
    const gone = hiddenWithRooms(model, hiddenItemsOf(model.itemTree, n, model.roomParts), n);
    const tiOf = new Map(pageShapes.map((y) => [y.id, y.ti]));
    const k = new Set([...selected].filter((x) => !gone.has(tiOf.get(x) ?? '')));
    if (k.size !== selected.size) { selectedRef.current = k; setSelectedRaw(k); }
  };
  /** the shapes drawn: not those hidden (by their eye or their heading's), nor (v0.16 e) other people's when they are
   *  not shown (People ▾) - not drawn, not hit, not boxed, not snapped to */
  const shownShapes = useMemo(() => {
    const l = hiddenItems.size || people ? pageShapes.filter((x) => !hiddenItems.has(x.ti) && shownFor(model, x, people)) : pageShapes;
    // v0.16 rooms' outlines first: drawn under, picked after what is drawn in them (their own finishes)
    const room = (x: Shape) => isRoomOutline(model, x);
    return l.some(room) ? [...l.filter(room), ...l.filter((x) => !room(x))] : l;
  }, [pageShapes, hiddenItems, people, model]);
  shownRef.current = shownShapes;
  /** v0.16 (e) other people's shapes on this sheet not shown (they still count) */
  const ownerHidden = useMemo(() => (people ? new Set(pageShapes.filter((x) => !shownFor(model, x, people)).map((x) => x.id)) : new Set<string>()), [pageShapes, people, model]);
  /** v0.16 (e) shown, but this person may not change them: drawn lighter, can be selected and looked at */
  const viewOnly = useMemo(() => new Set(shownShapes.filter((x) => !mayEdit(model, x, me.username, mayEditOthers)).map((x) => x.id)), [shownShapes, model, me.username, mayEditOthers]);
  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;
  /** may this person change it (a shape anywhere in the take-off) */
  const canEditShape = (s: Shape) => mayEdit(modelRef.current, s, me.username, editOthersRef.current);
  /** refused (with a short message) when any of these shapes is someone else's and view only */
  const refuseLocked = (ids: string[]): boolean => {
    const m = modelRef.current;
    const set = new Set(ids);
    const bad = m.shapes.filter((s) => set.has(s.id) && !canEditShape(s));
    if (bad.length) toast(lockedMsg(bad));
    return bad.length > 0;
  };
  // what is no longer shown (People ▾) is not selected on the drawing any more
  useEffect(() => {
    if (!ownerHidden.size) return;
    const k = new Set([...selectedRef.current].filter((x) => !ownerHidden.has(x)));
    if (k.size !== selectedRef.current.size) { selectedRef.current = k; setSelectedRaw(k); }
  }, [ownerHidden]);
  const shapeShownFn = useMemo(() => (people ? (s: Shape) => shownFor(model, s, people) : undefined), [model, people]);
  /** the people with shapes in this take-off (People ▾) */
  const peopleList = useMemo(() => peopleWithShapes(model), [model]);
  const setEditOthers = (v: boolean) => {
    setEditOthersRaw(v);
    toast(v ? <span>Other people's shapes can be changed now. What you change stays <b>theirs</b>, with you as a joint owner in its history.</span> : 'Other people\'s shapes are view only again.');
  };

  // ---------- earlier revisions: load the one being compared ----------
  const revisions = cur ? model.revisions.get(cur.dwg) ?? [] : [];
  useEffect(() => {
    if (!cmp || !engine || !ready || !cur) return;
    const r = (model.revisions.get(cur.dwg) ?? []).find((x) => x.id === cmp.rv);
    if (!r) { setCmp(null); return; }
    // the earlier revision's page: picked, or where the shapes here were measured (moved from a
    // page the new revision no longer has), or the same page number
    // (counted from the sheet's page; a page of a bound set: from its page of that file - v0.16)
    const want = cmp.pg ?? pageShapes.find((s) => s.opg !== undefined)?.opg ?? cur.pg;
    const wantFile = Math.max(0, filePage(r, want));
    if (cmpLoaded?.rv === r.id && cmpLoaded.pg === Math.min(wantFile, cmpLoaded.pages - 1)) return;
    let alive = true;
    (async () => {
      const l = await loadDrawing(r, info.localDir, engine, { exact: true, wanted: () => alive });
      if (!alive) return;
      if ('missing' in l) {
        toast(l.replaced
          ? <span>Can't show <b>{revLabel(r)}</b>: its file <code>{r.path}</code> has been replaced by a newer one, and this PC has no copy of the earlier file.</span>
          : <span>Can't open <b>{revLabel(r)}</b>: <code>{r.path}</code> is not there any more, and this PC has no copy of it.</span>, { color: '#b45309' });
        setCmp(null);
        return;
      }
      if (l.ops.length && !readOnly) session.commit(l.ops, 'Revision fingerprint', { recordUndo: false });
      const pg = Math.max(0, Math.min(wantFile, l.pages.length - 1));
      const bmp = await preview(engine, l.key, pg, l.pages[pg], info.localDir, projectDir).catch(() => null);
      if (alive) setCmpLoaded({ rv: r.id, key: l.key, bmp, scale: previewScale(l.pages[pg]), page: { w: l.pages[pg].w, h: l.pages[pg].h }, pg, pages: l.pages.length, spg: pg - (r.fp ?? 0), one: r.fp !== undefined });
      else bmp?.close();
    })();
    return () => { alive = false; };
  }, [cmp?.rv, cmp?.pg, engine, ready?.key]);
  const compareSpec: CompareSpec | null = cmp && cmpLoaded && cmpLoaded.rv === cmp.rv
    ? { key: cmpLoaded.key, preview: cmpLoaded.bmp, previewScale: cmpLoaded.scale, page: cmpLoaded.page, pg: cmpLoaded.pg, mode: cmp.mode, label: revLabel(revisions.find((r) => r.id === cmp.rv) ?? { rev: '', issue: '' }) }
    : null;
  // ---------- v0.18 (Feedback 3, D) another sheet over this one, put in place by two matching points ----------
  // (a ceiling plan or an elevation over the floor plan: drawn over, measured into this sheet's take-offs; how it
  // is put in place is kept on this PC for each pair of sheets)
  const ovrKey = 'qto.ovr.' + session.meta.id;
  const [aligns, setAligns] = useState<Record<string, Mat6>>(() => { try { return JSON.parse(localStorage.getItem(ovrKey) ?? '{}') ?? {}; } catch { return {}; } });
  const saveAlignLocal = (k: string, m: Mat6 | null) => setAligns((a) => { const n = { ...a }; if (m) n[k] = m; else delete n[k]; try { localStorage.setItem(ovrKey, JSON.stringify(n)); } catch { /* */ } return n; });
  // v0.18.1 (Feedback 3, D) kept in the project for the team (this PC's from 0.18.0 still read; view only: this PC)
  const alignOf = (pair: string): Mat6 | null => (model.overAligns.get(pair)?.m as Mat6 | undefined) ?? aligns[pair] ?? null;
  const ovrInfo = (pair: string) => model.overAligns.get(pair) ?? null;
  const putAlign = (pair: string, patch: { m?: Mat6; lk?: boolean; cr?: Box | null; tn?: string }, label: string) => {
    const m = patch.m ?? alignOf(pair);
    if (!m) return;
    if (readOnly) { if (patch.m) saveAlignLocal(pair, patch.m); return; }
    const id = overAlignId(pair);
    const ops: Op[] = [[id, 'p', pair], [id, 'm', JSON.stringify(m.map((v) => Math.round(v * 1e6) / 1e6))], [id, 'del', null]];
    if (patch.lk !== undefined) ops.push([id, 'lk', patch.lk ? true : null]);
    if (patch.cr !== undefined) ops.push([id, 'cr', patch.cr ? JSON.stringify(patch.cr) : null]);
    if (patch.tn !== undefined) ops.push([id, 'tn', patch.tn || null]);
    commit(ops, label);
  };
  const saveAlign = (k: string, m: Mat6) => putAlign(k, { m }, 'Overlay put in place');
  const [ovr, setOvr] = useState<{ on: string; dwg: string; pg: number; alpha: number; show: boolean } | null>(null);
  const [ovrLoaded, setOvrLoaded] = useState<{ dwg: string; pg: number; key: string; fpg: number; bmp: ImageBitmap | null; page: { w: number; h: number } } | null>(null);
  // (the overlay's picture freed when replaced or let go, as the other two are - 0.23.2, DeepSeek #38)
  useEffect(() => () => { ovrLoaded?.bmp?.close(); }, [ovrLoaded]);
  const [ovrPick, setOvrPick] = useState(false);
  /** putting it in place: the points clicked so far - this sheet, the other, this sheet, the other */
  const [align, setAlign] = useState<{ pts: Pt[]; check?: boolean } | null>(null);
  /** v0.18.1 the part of the overlaid sheet to show: the next rectangle drawn on this sheet */
  const [ovrCrop, setOvrCrop] = useState(false);
  const ovrCropRef = useRef(ovrCrop);
  ovrCropRef.current = ovrCrop;
  const alignRef = useRef(align);
  alignRef.current = align;
  useEffect(() => { setOvrCrop(false); if (ovr && ovr.on !== pk) { setOvr(null); setAlign(null); } }, [pk]);
  useEffect(() => {
    if (!ovr || !engine) { if (ovrLoaded) setOvrLoaded(null); return; }
    if (ovrLoaded && ovrLoaded.dwg === ovr.dwg && ovrLoaded.pg === ovr.pg) return;
    const d = model.drawings.find((x) => x.id === ovr.dwg);
    if (!d) { setOvr(null); return; }
    let alive = true;
    (async () => {
      const l = await loadDrawing(d, info.localDir, engine, { wanted: () => alive });
      if (!alive) return;
      if ('missing' in l) { toast(<span>Can't open <b>{d.title || d.name}</b> to show it over this sheet: its file is not there.</span>, { color: '#b45309' }); setOvr(null); return; }
      const fpg = Math.max(0, Math.min(filePage(d, ovr.pg), l.pages.length - 1));
      const bmp = await preview(engine, l.key, fpg, l.pages[fpg], info.localDir, projectDir).catch(() => null);
      if (alive) setOvrLoaded({ dwg: ovr.dwg, pg: ovr.pg, key: l.key, fpg, bmp, page: { w: l.pages[fpg].w, h: l.pages[fpg].h } });
      else bmp?.close();
    })();
    return () => { alive = false; };
  }, [ovr?.dwg, ovr?.pg, engine]);
  const ovrPair = ovr ? pk + '|' + pageKey(ovr.dwg, ovr.pg) : '';
  const ovrMat: Mat6 = (ovr && alignOf(ovrPair)) || [1, 0, 0, 1, 0, 0];
  const ovrI = ovr ? ovrInfo(ovrPair) : null;
  const overSpec: OverSpec | null = ovr && ovr.show && ovr.on === pk && ovrLoaded && ovrLoaded.dwg === ovr.dwg && ovrLoaded.pg === ovr.pg
    ? { key: ovrLoaded.key, pg: ovrLoaded.fpg, preview: ovrLoaded.bmp, page: ovrLoaded.page, m: ovrMat, alpha: ovr.alpha, color: ovrI?.tn || '#e8590c', crop: ovrI?.cr ?? null } : null;
  const startOverlay = (dwg: string, pg: number) => {
    setOvrPick(false);
    if (!cur) return;
    setOvr({ on: pk, dwg, pg, alpha: 0.7, show: true });
    // (never put in place for this pair of sheets: asked for straight away)
    if (!alignOf(pk + '|' + pageKey(dwg, pg))) { keepShape(); setAlign({ pts: [] }); }
  };
  const alignPoint = (p: Pt) => {
    const a = alignRef.current;
    if (!a || !ovr) return;
    // (a click on the other sheet: where that is on its own page, as it lies now)
    const pts = [...a.pts, a.pts.length % 2 ? applyMat(invMat(ovrMat), p) : p];
    // v0.18.1 (Feedback 3, D: "an optional 3rd point is used to check the fit") - a point here and the same one there
    if (a.check) {
      if (pts.length < 2) { setAlign({ pts, check: true }); return; }
      setAlign(null);
      const here = pts[0], there = applyMat(ovrMat, pts[1]);
      const h = scaleAt(model, cur!.dwg, cur!.pg, here);
      const off = h.sc ? Math.hypot((there[0] - here[0]) * h.sc, (there[1] - here[1]) * (h.scy ?? h.sc)) : null;
      if (off === null) toast('No scale on this sheet: the fit can\'t be told in mm.', { color: '#b45309' });
      else toast(off <= 0.05 ? `It fits: ${Math.round(off * 1000)} mm off there.` : `Off by ${Math.round(off * 1000)} mm there — align again with two points further apart (gridline crossings).`, { color: off <= 0.05 ? undefined : '#b45309' });
      return;
    }
    if (pts.length < 4) { setAlign({ pts }); return; }
    const m = alignMat(pts[1], pts[3], pts[0], pts[2]);
    setAlign(null);
    if (!m) { toast('Those two points are the same: pick two points well apart.', { color: '#b45309' }); return; }
    saveAlign(ovrPair, m);
    toast('In place. Draw over it: what you measure goes on this sheet. “Check” with a third point; “Align again” if it is off.');
  };
  // ---------- v0.18 (Feedback 3, 14) images on a sheet ----------
  const [imgMenu, setImgMenu] = useState(false);
  const [imgHi, setImgHi] = useState<string | null>(null);
  /** an image waiting for its place: the next rectangle drawn on the sheet is where it goes */
  const [imgPlace, setImgPlace] = useState<ImagePlace | null>(null);
  const imgPlaceRef = useRef(imgPlace);
  imgPlaceRef.current = imgPlace;
  const [imgBmps, setImgBmps] = useState<Map<string, ImageBitmap>>(new Map());
  const imgsHere = useMemo(() => (cur ? model.images.filter((x) => x.dwg === cur.dwg && x.pg === cur.pg) : []), [model, cur?.dwg, cur?.pg]);
  const imgDir = () => gt().fs.join(projectDir, 'images');
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const im of imgsHere) {
        if (imgBmps.has(im.file)) continue;
        const b = IMAGE_FILE_RE.test(im.file) ? await gt().files.readBytes(gt().fs.join(imgDir(), im.file)).catch(() => null) : null;
        if (!b || !alive) continue;
        const bmp = await createImageBitmap(new Blob([b as BlobPart])).catch(() => null);
        if (bmp && alive) setImgBmps((m0) => new Map(m0).set(im.file, bmp));
      }
    })();
    return () => { alive = false; };
  }, [imgsHere]);
  const canvasImages = useMemo(() => imgsHere.flatMap((im) => { const bmp = imgBmps.get(im.file); return bmp ? [{ id: im.id, bmp, box: im.box, shared: im.pub, hi: imgHi === im.id, mine: im.by === me.username }] : []; }), [imgsHere, imgBmps, imgHi, me.username]);
  const addImage = async () => {
    setImgMenu(false);
    const files = await gt().pickFiles({ title: 'Choose an image (PNG, JPG, WEBP)' });
    if (!files.length) return;
    try {
      const b = await gt().files.readBytes(files[0]);
      if (!b) throw new Error('Could not read the file.');
      if (b.length > 40 * 1024 * 1024) throw new Error('That image is over 40 MB.');
      const bmp = await createImageBitmap(new Blob([b as BlobPart]));
      const base = files[0].split(/[\\/]/).pop() ?? 'image';
      const ext = (base.match(/\.(png|jpe?g|webp|gif|bmp)$/i)?.[0] ?? '.png').toLowerCase();
      const file = 'im' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + ext;
      await gt().files.writeBytes(gt().fs.join(imgDir(), file), b, projectDir);
      setImgBmps((m0) => new Map(m0).set(file, bmp));
      keepShape();
      setImgPlace({ k: 'new', file, name: base.replace(/\.[a-z0-9]+$/i, ''), ar: bmp.width / Math.max(1, bmp.height) });
    } catch (e: any) {
      toast(<span>That file could not be used as an image: {String(e?.message ?? e)}</span>, { color: '#b45309' });
    }
  };
  /** the rectangle drawn for the image waiting: its width; the height follows the picture's proportions */
  const placeImage = (pts: Pt[]) => {
    const pl = imgPlaceRef.current;
    if (!pl || !cur) return;
    setImgPlace(null);
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), w0 = Math.max(...xs) - x0, h0 = Math.max(...ys) - y0;
    if (w0 < 2 || h0 < 2) return;
    // (as large as fits in the rectangle drawn; turned sheets: the box is still the page's own)
    const fitW = Math.min(w0, h0 * pl.ar), box = { x0, y0, x1: x0 + fitW, y1: y0 + fitW / pl.ar };
    const src = pl.id ? modelRef.current.images.find((x) => x.id === pl.id) : null;
    const r = imageOps({ id: pl.k === 'again' || pl.k === 'move' ? pl.id : undefined, dwg: cur.dwg, pg: cur.pg, box, file: pl.file, name: pl.name, by: me.username, pub: pl.k === 'again' || pl.k === 'move' ? src?.pub : false });
    commit(r.ops, pl.k === 'new' ? 'Image on the sheet' : pl.k === 'copy' ? 'Image copied here' : pl.k === 'move' ? 'Image moved here' : 'Image moved / resized');
  };
  const OVR_TINTS = ['#e8590c', '#1971c2', '#2f9e44', '#c2255c', '#495057'];
  const CHECK_TEXT = ['Check 1 of 2 · On THIS sheet: click a third point you can find on both, away from the first two', 'Check 2 of 2 · On the overlaid sheet: click the same point'];
  const ALIGN_TEXT = ['1 of 4 · On THIS sheet: click a point you can find on both (a wall corner)', '2 of 4 · On the ORANGE sheet: click the same point', '3 of 4 · On THIS sheet: a second point, far from the first', '4 of 4 · On the ORANGE sheet: that second point'];
  const staleHere = cur ? model.staleByDwg.get(cur.dwg) ?? 0 : 0;
  // looking at a page of an earlier revision that the current one no longer has: the shapes left
  // on that page are shown there (to see; nothing can be drawn there)
  const offView = cur && compareSpec && compareSpec.mode === 'previous' && ready && cmpLoaded && cmpLoaded.spg >= Math.max(1, curDrawing?.pages || ready.pages.length)
    ? (model.offPageShapes.get(cur.dwg) ?? []).filter((s) => s.pg === cmpLoaded.spg && shownFor(model, s, people))
    : null;

  // ---------- presence ----------
  useEffect(() => { session.setFocus({ sheet: pk || null, detail: activeId }); }, [pk, activeId]);
  const cursors: OtherCursor[] = useMemo(
    () => props.others.filter((o) => o.sheet === pk && typeof o.cx === 'number' && typeof o.cy === 'number').map((o) => ({ w: o.w, name: o.u, color: o.color, x: o.cx!, y: o.cy! })),
    [props.others, pk],
  );

  /** an "Undo" button for a message: undoes that step only, not whatever was done after it */
  const undoAction = () => {
    const mark = session.undoMark();
    return { label: 'Undo', fn: () => { if (session.undoIfTop(mark) === 'moved') toast('Other changes were made since. Use Ctrl+Z to step back through them in order.'); } };
  };

  // ---------- tools ----------
  /** v0.16 the drawing: a shape being drawn is kept (complete) before another tool / take-off is picked */
  const sheetApi = useRef<SheetApi | null>(null);
  const keepShape = () => { sheetApi.current?.keepShape(); };
  const pickTool = (t: UiTool, nsk: StructKind = '') => {
    if (readOnly && t !== 'select') return toast('View only.');
    if (t !== tool || nsk !== sk) keepShape();
    // (v0.16 another tool ends a room step)
    if (stepRef.current) endStep();
    // switching to another kind of measuring: the active take-off can't take it (v0.17: nor a slab's the Area tool)
    const k = KIND_OF_TOOL[t];
    if (k && active && (active.kind !== k || (active.sk ?? '') !== nsk)) setActiveId(null);
    setSk(k ? nsk : '');
    if (cmp?.mode === 'previous' && t !== 'select' && t !== 'measure') setCmp({ ...cmp, mode: 'overlay' });
    // another kind of measuring starts as polygon / polyline again (a rectangle is the exception, not the
    // rule: the rectangle picked for rooms must not turn the next length into a rectangle)
    if (t !== tool && MODE_TOOLS.includes(t)) setMode('path');
    setTool(t);
  };
  /** v0.17 the Structure button: beams, columns, slabs, drop panels, shear walls */
  const pickStruct = (st: StructTool) => {
    setLastStruct(st);
    if (st === 'beam') return pickTool('beam');
    pickTool(TOOL_FOR_KIND[SK_KIND[st]], st);
  };
  /** the structural tool in use ('' = none) */
  const structOn: StructTool | '' = tool === 'beam' ? 'beam' : sk && KIND_OF_TOOL[tool] === SK_KIND[sk as Exclude<StructKind, ''>] ? (sk as StructTool) : '';
  /** P / R / O: how the shape is drawn (outside a measuring tool: the take-off in use, else an area) */
  const pickMode = (m: ShapeMode) => {
    if (tool === 'hole') { if (m !== holeMode) keepShape(); setHoleMode(m); return; }
    if (m !== mode) keepShape();
    // (the tool first: picking a tool puts the mode back to polygon / polyline)
    if (!MODE_TOOLS.includes(tool)) pickTool(active && MODE_TOOLS.includes(TOOL_FOR_KIND[active.kind]) ? TOOL_FOR_KIND[active.kind] : 'area');
    setMode(m);
  };

  // one-off tools (scale, viewport, cut-out, note) hand back the tool you were measuring with
  const ONE_OFF: UiTool[] = ['scale', 'region', 'hole', 'note'];
  const workTool = useRef<UiTool>('select');
  // the counts of this run, newest last (Backspace in the count tool takes them back one by one)
  const countRun = useRef<string[]>([]);
  // (v0.16.1 the Count tool's door mode ends with the tool)
  useEffect(() => { if (tool !== 'count') setDoorMode(false); }, [tool]);
  useEffect(() => { if (!ONE_OFF.includes(tool)) workTool.current = tool; countRun.current = []; }, [tool, cur?.dwg, cur?.pg]);
  const toolDone = () => setTool((t) => (ONE_OFF.includes(t) && !readOnly ? workTool.current : 'select'));
  /**
   * v0.16 Esc on the drawing with nothing left there to stop (UI rule 3): a one-off tool hands back the
   * tool you were measuring with; else the active take-off stops; then back to Select
   */
  const escToolDone = () => {
    if (auto) { setAuto(null); return; }
    if (stepRef.current) { endStep({ restore: true }); return; }
    if (ONE_OFF.includes(tool) && !readOnly) { setTool(workTool.current); return; }
    if (activeId) { activate(null); return; }
    if (tool !== 'select') setTool('select');
  };

  const activate = (id: string | null) => {
    if (id !== activeId) keepShape();
    // (v0.16 measuring into another take-off ends a room step drawn into this one)
    if (stepRef.current && id !== stepItem(stepRef.current)) endStep();
    setActiveId(id);
    const it = id ? modelRef.current.itemById.get(id) : null;
    if (it && !readOnly) {
      if (id !== activeId) setMode('path');
      setTool(TOOL_FOR_KIND[it.kind]);
      setSk(it.sk ?? '');
      // measuring into a take-off hidden on the drawing: what is drawn would not show
      if (hiddenRef.current.has(it.id)) {
        toast(<span><b>{it.name}</b> is hidden on the drawing — what you measure into it won't show.</span>, { action: { label: 'Show it', fn: () => setHidden((h) => {
          const n: Hidden = { items: new Set(h.items), heads: new Set(h.heads) };
          n.items.delete(it.id);
          for (let x = modelRef.current.itemTree.leafPar.get(it.id) ?? ''; x; x = modelRef.current.headingById.get(x)?.par ?? '') n.heads.delete(x);
          return n;
        }) } });
      }
    }
  };
  /** ■ (on its row, or the take-off chip in the tool bar): stop measuring into it - back to Select */
  const stopMeasuring = () => {
    activate(null);
    if (KIND_OF_TOOL[tool]) setTool('select');
  };

  // ---------- v0.16 room steps on the drawing (group g1): asked for by the room panel (roommode.ts) ----------
  const [step, setStepS] = useState<RoomMode | null>(null);
  /** a door / an opening to place (a room step): a new token each time */
  const [placeArm, setPlaceArm] = useState<{ k: 'door' | 'open'; token: number } | null>(null);
  /** the drawing is placing a door / an opening (D / O, or a room step) */
  const [placingK, setPlacingK] = useState<'door' | 'open' | null>(null);
  const placedOnce = useRef(false);
  /** the take-off a step draws into */
  const stepItem = (m: RoomMode) => ((m.k === 'addLine' || m.k === 'addArea' || m.k === 'ceil' || m.k === 'misc') && m.part ? m.part : m.room);
  /**
   * The room step ends (UI rule 3: it stops, it does not destroy). restore: back to Select, nothing measured
   * into (Done / Cancel / Esc / the door placed) - not when another tool or take-off was picked (that one goes
   * on). cancel: what the step committed is undone (one Ctrl+Z each, newest first).
   */
  const endStep = (o: { restore?: boolean; cancel?: boolean } = {}) => {
    const m = stepRef.current;
    if (!m) return;
    stepRef.current = null;
    setStepS(null);
    setPlaceArm(null);
    placedOnce.current = false;
    const marks = stepMarks.current;
    stepMarks.current = [];
    if (o.cancel) {
      for (let i = marks.length - 1; i >= 0; i--) {
        const r = session.undoIfTop(marks[i]);
        if (r === 'moved') { toast('Other changes were made since: what this step drew is kept. Use Ctrl+Z to step back through it.'); break; }
      }
    }
    if (o.restore) {
      if (activeId) setActiveId(null);
      setTool('select');
    }
    roomModeDone(session.meta.id, m);
  };
  /** a room step waiting for the finish it draws into to reach the model (made by the panel a moment ago) */
  const stepWait = useRef(new Map<string, number>());
  const startStep = (m: RoomMode | null) => {
    if (!m) { endStep({ restore: true }); return; }
    const mm = modelRef.current;
    const room = mm.itemById.get(m.room);
    const no = (msg: string) => { toast(msg); roomModeDone(session.meta.id, m); };
    if (readOnly || session.readOnly) return no('View only — you can look but not change this take-off.');
    if (!room || room.kind !== 'room') return no('That room is not there any more.');
    if (!cur || !ready) return no('Open a sheet first: the room is drawn on it.');
    const part = m.part ? mm.itemById.get(m.part) : null;
    if ((m.k === 'addLine' || m.k === 'addArea' || m.k === 'ceil' || m.k === 'pickLine' || m.k === 'misc') && !part) {
      // (the panel makes the finish and asks for it in one go: it is in the project already but the model on
      // screen is built from it a moment later - wait for it rather than refuse)
      const tries = stepWait.current.get(m.part!) ?? 0;
      if (m.part && tries < 40 && session.store.ents.has(m.part) && session.store.get(m.part, 'del') !== true) {
        stepWait.current.set(m.part, tries + 1);
        setTimeout(() => startStepRef.current(m), 50);
        return;
      }
      if (m.part) stepWait.current.delete(m.part);
      return no('That finish is not there any more.');
    }
    if (m.part) stepWait.current.delete(m.part);
    const outl = roomOutlines(mm, room.id, cur.dwg, cur.pg);
    // (v0.16.5 an additional wall drawn as an area goes on any sheet - an elevation: no outline needed there)
    // (switched to an area a moment ago: in the project already, the model on screen a moment later)
    // (v0.18 a miscellaneous item too: a mirror on its elevation, cabinets on the kitchen's own sheet)
    const elev = m.k === 'misc' || (m.k === 'addArea' && !!m.part && (!!mm.fin.partById.get(m.part)?.wa || session.store.get(m.part, 'wa') === true));
    if (m.k !== 'outline' && !elev && !outl.length) return no(`${room.name} has no outline on this sheet: draw its outline first (or open the sheet it is on).`);
    if (m.k === 'gap' || m.k === 'edge' || m.k === 'door' || m.k === 'open' || m.k === 'pickLine') {
      if (hiddenRef.current.has(room.id)) return no(`${room.name} is hidden on the drawing: show it first (its eye).`);
    }
    keepShape();
    if (stepRef.current) endStep();
    stepRef.current = m;
    stepMarks.current = [];
    placedOnce.current = false;
    setStepS(m);
    setAuto(null);
    if (m.k === 'outline' || m.k === 'addLine' || m.k === 'addArea' || m.k === 'ceil' || m.k === 'misc') {
      activate(stepItem(m));
      setMode('path');
    } else {
      // (the selection stays as it is: the room's panel asked for the step)
      if (activeId) setActiveId(null);
      setTool('select');
      if (m.k === 'door' || m.k === 'open') setPlaceArm({ k: m.k, token: Date.now() });
    }
  };
  const startStepRef = useRef(startStep);
  startStepRef.current = startStep;
  useEffect(() => onRoomMode(session.meta.id, (m) => startStepRef.current(m)), [session]);
  // a door / an opening step: done when it was placed (its picker closed) or placing stopped (Esc)
  useEffect(() => {
    const m = stepRef.current;
    if (!m || (m.k !== 'door' && m.k !== 'open')) return;
    if (placingK) { placedOnce.current = true; rearm.current = false; return; }
    if (placedOnce.current && !opick && !rearm.current) endStep({ restore: true });
  }, [placingK, opick, step]);
  // the sheet changed under a step that needs this sheet's outline: it ends
  // (v0.16.5 the take-off measured into changed kind - an additional wall switched to an area: the tool follows)
  const activeKind = useRef<{ id: string | null; kind: Kind | null }>({ id: null, kind: null });
  useEffect(() => {
    const it = activeId ? model.itemById.get(activeId) : null;
    const was = activeKind.current;
    activeKind.current = { id: activeId, kind: it?.kind ?? null };
    if (!it || readOnly || was.id !== activeId || !was.kind || was.kind === it.kind) return;
    if (tool === TOOL_FOR_KIND[was.kind]) setTool(TOOL_FOR_KIND[it.kind]);
  }, [model, activeId]);
  // (v0.16.5 not an additional wall drawn as an area: it is drawn on an elevation - any sheet)
  useEffect(() => {
    const m = stepRef.current;
    if (m && m.k !== 'outline' && m.k !== 'misc' && !(m.k === 'addArea' && m.part && modelRef.current.fin.partById.get(m.part)?.wa)) endStep({ restore: true });
  }, [pk]);
  // (9 Nov: the finish a step draws into / picks edges for removed meanwhile - the step stops with it)
  useEffect(() => {
    const m = stepRef.current;
    if (m && m.part && (m.k === 'addLine' || m.k === 'addArea' || m.k === 'ceil' || m.k === 'pickLine' || m.k === 'misc') && !model.itemById.has(m.part)) endStep({ restore: true });
  }, [model]);
  /** what a step is doing, on the bar under the drawing */
  const stepText = (m: RoomMode): string => {
    const room = model.itemById.get(m.room)?.name ?? 'the room';
    const part = m.part ? model.itemById.get(m.part)?.name ?? '' : '';
    switch (m.k) {
      case 'outline': return `Draw an outline of ${room} · Space = another outline · H = a cut-out`;
      case 'addLine': return model.fin.partById.get(m.part ?? '')?.ak === 'bh' ? `Draw ${part} under the ceiling of ${room}` : `Draw ${part} along the outline of ${room} · it runs along its edges`;
      case 'pickLine': return model.fin.partById.get(m.part ?? '')?.wa ? `Click the plan edges of ${room} that ${part} stands for (again to take one back) · Enter when done` : `Click the edges ${part} runs along (again to take one back) · Enter when done`;
      case 'misc': return `Measure ${part} of ${room} · on any sheet`;
      case 'addArea': return model.fin.partById.get(m.part ?? '')?.wa ? `Draw ${part} of ${room} as an area · on any sheet (an elevation)` : `Draw ${part} inside ${room} · it snaps to the outline`;
      case 'ceil': return `Draw the ceiling areas of ${room} · it snaps to the outline`;
      case 'gap': return 'Click the edges with a shadow gap · Enter when done';
      case 'edge': return `Click the edges of ${room} that are open (no wall) · Enter when done`;
      case 'door': return `Click on a wall edge of ${room} where the door is`;
      case 'open': return `Click on a wall edge of ${room} where the opening is`;
    }
  };
  /** the shapes whose edges a step picks: the room's outlines (and, for a shadow gap, its ceiling areas) */
  const stepEdges = useMemo(() => {
    if (!step || (step.k !== 'gap' && step.k !== 'edge' && step.k !== 'pickLine') || !cur) return null;
    const ids = new Set<string>();
    // (a bulkhead: along the room's edges or a ceiling's; an upturn: the room's edges)
    const ceilToo = step.k === 'gap' || (step.k === 'pickLine' && model.fin.partById.get(step.part ?? '')?.ak === 'bh');
    for (const s of shownShapes) {
      if (s.ti === step.room && s.k === 'poly') ids.add(s.id);
      else if (ceilToo && edgeFlagFits(model, s, 'gap') && model.itemById.get(s.ti)?.rm === step.room) ids.add(s.id);
    }
    return { flag: step.k === 'gap' ? 'gap' as const : step.k === 'pickLine' ? 'line' as const : 'open' as const, shapes: ids };
  }, [step, shownShapes, model, cur?.dwg, cur?.pg]);
  /** v0.16.4 an edge picked for a bulkhead / an upturn: a length along it goes in (or, picked again, out) */
  const pickLine = (shapeId: string, seg: number) => {
    const m = stepRef.current;
    const s = modelRef.current.shapes.find((x) => x.id === shapeId);
    if (!m?.part || !s) return;
    const r = pickEdgeLineOps(modelRef.current, m.part, s, seg, me.username);
    if ('error' in r) return toast(r.error, { color: '#b45309' });
    commit(r.ops, r.on ? 'Edge picked' : 'Edge taken back');
  };
  /** v0.17 a column as drawn: its type's section and colour */
  const colOf = (s: Shape) => {
    const it = model.itemById.get(s.ti);
    // (v0.18 shear walls and footings counted the same way; an element with a size of its own is drawn at it)
    const t = it && isCountedStruct(it.sk) ? colTypeOf(model, it, s.mt) : null;
    const round = !!t?.round && s.xd === undefined;
    const w = s.xw ?? t?.w ?? null, d = round ? w : s.xd ?? t?.d ?? null;
    return w && d ? { w, d, round, color: t?.color ?? it!.color, name: (t?.name ?? '') + (shapeOverridden(s) ? '*' : '') } : null;
  };
  /** v0.16.5 a room's open edge picked with the Select tool (Nabil: "select it + Delete"): Del makes it a wall edge */
  const [edgeSel, setEdgeSel] = useState<{ shape: string; seg: number } | null>(null);
  useEffect(() => {
    if (!edgeSel) return;
    const s = model.shapes.find((x) => x.id === edgeSel.shape);
    // (its room no longer selected, gone, or the edge not open any more: let it go)
    if (!s || !selected.has(s.id) || !edgeFlags(s.sg[edgeSel.seg]).open || !cur || s.dwg !== cur.dwg || s.pg !== cur.pg) setEdgeSel(null);
  }, [edgeSel, model, selected, cur?.dwg, cur?.pg]);
  const edgeDel = () => {
    const e = edgeSel;
    setEdgeSel(null);
    const s = e ? modelRef.current.shapes.find((x) => x.id === e.shape) : null;
    if (!e || !s || !edgeFlags(s.sg[e.seg]).open) return;
    toggleEdge(s.id, e.seg, 'open');
  };
  /** an edge clicked while picking, or toggled from its right-click menu (one step each) */
  const toggleEdge = (shapeId: string, seg: number, flag: 'open' | 'gap') => {
    const s = modelRef.current.shapes.find((x) => x.id === shapeId);
    if (!s) return;
    const r = edgeToggleOps(modelRef.current, s, seg, flag);
    if ('error' in r) return toast(r.error, { color: '#b45309' });
    commit(r.ops, flag === 'open' ? (r.on ? 'Open edge' : 'Wall edge') : r.on ? 'Shadow gap on an edge' : 'No shadow gap on an edge');
  };
  /** a room's own finish measured into (additional / ceiling): its nodes go onto the room's outline */
  const rail = useMemo(() => {
    if (!active || !cur || (active.rk !== 'add' && active.rk !== 'ceil') || !active.rm) return null;
    // (v0.16.4 a bulkhead lies inside the room, under its ceiling: not along the outline)
    if (model.fin.partById.get(active.id)?.ak === 'bh') return null;
    // (v0.16.5 nor an additional wall drawn as an area: an elevation's shape, not the plan's)
    if (model.fin.partById.get(active.id)?.wa || model.fin.partById.get(active.id)?.ak === 'misc') return null;
    const shapes = roomOutlines(model, active.rm, cur.dwg, cur.pg).filter((s) => !hiddenItems.has(s.ti));
    return shapes.length ? { shapes, always: active.kind === 'line' } : null;
  }, [active, model, cur?.dwg, cur?.pg, hiddenItems]);
  // ---------- auto-count by tag (v0.15) ----------
  const findOnSheet = async (q: string, mode: TagMode): Promise<Found[]> => {
    if (!engine || !ready || !cur) return [];
    const k = ready.key + '#' + fpg;
    let w = wordsCache.current.get(k);
    if (!w) { w = await engine.words(ready.key, fpg); wordsCache.current.set(k, w); }
    return findTags(w, q, mode);
  };
  /** v0.16.6 the beam types' marks on this sheet -> the beam segments they sit by (shown; kept when said) */
  /** a shape whose marks a schedule's types can tag (beams; shear walls; columns) */
  const markable = (s: Shape, cat: MemberCat) => {
    const it = model.itemById.get(s.ti);
    return !!it && cat !== 'stair' && (cat === 'beam' ? it.kind === 'beam' : cat === 'wall' ? it.sk === 'shear' : cat === 'rwall' ? it.sk === 'rw' : cat === 'swall' ? it.sk === 'sw' : cat === 'ftg' ? it.sk === 'ftg' : it.sk === 'col');
  };
  const beamMarks = async (cat: 'beam' | 'wall' | 'rwall' = 'beam') => {
    if (!cur) return;
    const noun = cat === 'beam' ? 'beam' : cat === 'rwall' ? 'retaining wall' : 'core wall';
    const beams = shownShapes.filter((s) => markable(s, cat) && mayEdit(model, s, me.username, mayEditOthers));
    if (!beams.length) return toast(`No ${noun}s of yours measured on this sheet: draw them first, then their marks tag them.`);
    const marks: { bt: string; f: Found }[] = [];
    for (const t of cat === 'beam' ? model.beamTypes : cat === 'rwall' ? model.rwTypes : model.wallTypes) for (const f of await findOnSheet(t.name, 'exact')) marks.push({ bt: t.id, f });
    const list = beamTagProposals(beams, marks);
    if (!list.length) return toast(marks.length ? `${marks.length} ${noun} mark${marks.length > 1 ? 's' : ''} found, none by a ${noun} drawn on this sheet.` : `None of the ${noun} schedule’s marks is written on this sheet (as text: a scanned drawing has none).`);
    setAuto(null); setColAuto(null);
    setBeamAuto({ dwg: cur.dwg, pg: cur.pg, list, cat });
    setDialog(null);
    setTool('select');
  };
  /** v0.17 the column types' marks on this sheet: a column at each (where none is counted yet), kept when said */
  const colMarks = async (ck: 'col' | 'sw' | 'ftg' = isCountedStruct(sk as StructKind) ? (sk as 'col' | 'sw' | 'ftg') : 'col') => {
    if (!cur) return;
    const found: { p: Pt; bt: string; text: string; on: boolean; dup: boolean }[] = [];
    const counted = (model.shapesByPage.get(pageKey(cur.dwg, cur.pg)) ?? []).filter((s) => s.k === 'pt' && model.itemById.get(s.ti)?.sk === ck);
    for (const t of typesFor(model, ck)) {
      for (const f of await findOnSheet(t.name, 'exact')) {
        const h = Math.max(4, Math.min(f.x1 - f.x0, f.y1 - f.y0) * 3);
        const dup = counted.some((s) => Math.hypot(s.pts[0][0] - f.p[0], s.pts[0][1] - f.p[1]) < h + 6);
        found.push({ p: f.p, bt: t.id, text: f.text, on: !dup, dup });
      }
    }
    if (!found.length) return toast(`None of the ${SK_LABEL[ck].toLowerCase()} schedule’s marks is written on this sheet (as text: a scanned drawing has none).`);
    setAuto(null); setBeamAuto(null);
    setColAuto({ dwg: cur.dwg, pg: cur.pg, list: found, ck });
    setDialog(null);
    setTool('select');
  };
  const keepColMarks = () => {
    if (!colAuto || !cur) return;
    const take = colAuto.list.filter((x) => x.on);
    if (!take.length) return;
    // (into the columns take-off in use, else a new one)
    const m0 = modelRef.current;
    const ck = colAuto.ck ?? 'col';
    let ti = active?.sk === ck ? active.id : '';
    const ops: Op[] = [];
    if (!ti) { const r = newStructOps(m0, me.username, ck, (curHead && m0.headingById.has(curHead) ? curHead : '') || ''); ops.push(...r.ops); ti = r.id; }
    for (const x of take) { const r = shapeOps(ti, cur.dwg, cur.pg, 'pt', [x.p], me.username, 1, ready?.key ?? ''); ops.push(...r.ops, [r.id, 'mt', x.bt]); }
    setColAuto(null);
    if (commit(ops, SK_LABEL[ck] + 's from their marks')) {
      setActiveId(ti); setTool('count'); setSk(ck);
      const it = modelRef.current.itemById.get(ti);
      toast(`${take.length} ${SK_LABEL[ck].toLowerCase()}${take.length > 1 ? 's' : ''} placed from the marks on the drawing${ck !== 'ftg' && !it?.h ? ' — give the take-off its height (on the right) for the concrete' : ''}.`);
    }
  };
  const openSched = (t: SchedTab) => { setSchedTab(t); setDialog(t === 'doors' ? { k: 'doors' } : { k: 'beams', cat: t }); };
  const keepBeamMarks = () => {
    if (!beamAuto) return;
    // (a shape changed since the marks were read - a node put in - its segments are not the ones proposed: left alone)
    const live = beamAuto.list.filter((x) => modelRef.current.shapes.find((s) => s.id === x.shape)?.pts.length === x.n);
    const ops = beamTagOps(modelRef.current.shapes, live);
    const n = live.filter((x) => x.on && !x.same).length;
    const noun = beamAuto.cat === 'wall' ? 'core wall' : beamAuto.cat === 'rwall' ? 'retaining wall' : 'beam';
    setBeamAuto(null);
    if (ops.length && commit(ops, (beamAuto.cat === 'wall' ? 'Core walls' : beamAuto.cat === 'rwall' ? 'Retaining walls' : 'Beams') + ' tagged from their marks')) toast(`${n} ${noun} segment${n > 1 ? 's' : ''} tagged from the marks on the drawing.${live.length < beamAuto.list.length ? ' (Some were changed meanwhile: left alone.)' : ''}`);
  };
  /** the count take-off(s) the marks go into: one per tag, or the count in use, or a new one */
  // (v0.16.2 never the door counter: only doors of the schedule go into it, as doors)
  const autoTargets = (q: string, perTag: boolean) => (text: string) => {
    // (v0.17 never into columns: their points have a type - "From their marks" places those)
    if (perTag) return model.items.find((it) => it.kind === 'count' && !it.dc && !it.sk && tagKey(it.name) === tagKey(text)) ?? null;
    return active?.kind === 'count' && !active.dc && !active.sk ? active : model.items.find((it) => it.kind === 'count' && !it.dc && !it.sk && tagKey(it.name) === tagKey(q)) ?? null;
  };
  const showAuto = (found: Found[], q: string, perTag: boolean) => {
    if (!cur) return;
    const target = autoTargets(q, perTag);
    // a mark where a count already is - in that take-off, or in another count take-off (counted before
    // under another tag or one take-off per tag): left out, named, can be taken back
    const counts = (model.shapesByPage.get(pageKey(cur.dwg, cur.pg)) ?? []).filter((s) => s.k === 'pt' && model.itemById.get(s.ti)?.kind === 'count');
    // v0.16.1 the Count tool's door mode: a tag that is a door of the schedule is counted as that door (not on
    // a wall); where that door is already counted - on a wall, or before - the mark is left out and named
    const dRow = (t: string) => (doorMode ? model.doors.find((d) => doorTagKey(d.tag) === doorTagKey(t)) ?? null : null);
    const list = found.map((f) => {
      const dr = dRow(f.text);
      const why = dr ? doorCountRefusal(model, cur.dwg, cur.pg, f.p, dr.id) : null;
      if (why) return { f, on: false, dup: true, in: why.replace(/\.$/, '') };
      const it = target(f.text);
      const h = Math.max(4, Math.min(f.x1 - f.x0, f.y1 - f.y0) * 1.5);
      const near = (s: Shape) => s.pts.some((p) => Math.hypot(p[0] - f.p[0], p[1] - f.p[1]) < h + 6);
      const hit = (it && counts.find((s) => s.ti === it.id && near(s))) || counts.find(near);
      // (v0.16 e: counted by someone else - perhaps not on this person's drawing - says by whom)
      return { f, on: !hit, dup: !!hit, in: hit ? (model.itemById.get(hit.ti)?.name ?? '') + (isMine(model, hit, me.username) ? '' : ' (by ' + nameOf(ownerOf(model, hit)) + ')') : '' };
    });
    // shown and named as written on the drawing ("SCALE", not the "scale" typed), when it is one tag
    const groups = new Set(found.map((f) => tagKey(f.text)));
    setAuto({ dwg: cur.dwg, pg: cur.pg, q: groups.size === 1 ? found[0].text.replace(/\s+/g, '') : q, perTag, doors: doorMode, list });
    setDialog(null);
    setTool('select');
  };
  const keepAuto = () => {
    if (!auto) return;
    const target = autoTargets(auto.q, auto.perTag);
    const ops: Op[] = [];
    const made = new Map<string, string>();
    const itemFor = (text: string): string => {
      const it = target(text);
      if (it) return it.id;
      const key = auto.perTag ? tagKey(text) : tagKey(auto.q);
      if (made.has(key)) return made.get(key)!;
      const r = newItemOps(model, me.username, 'count', undefined, (curHead && model.headingById.has(curHead) ? curHead : '') || (active?.par ?? ''));
      for (const o of r.ops) if (o[0] === r.id && o[1] === 'name') o[2] = auto.perTag ? text.replace(/\s+/g, '') : auto.q;
      ops.push(...r.ops);
      made.set(key, r.id);
      return r.id;
    };
    let n = 0, nd = 0;
    let last = '';
    let counter: string | null = null;
    for (const x of auto.list) {
      if (!x.on) continue;
      // v0.16.1 door mode: a door of the schedule goes into the door counter, as that door
      const dr = auto.doors ? model.doors.find((d) => doorTagKey(d.tag) === doorTagKey(x.f.text)) : undefined;
      if (dr) {
        if (!counter) { const c = doorCounterOps(model, me.username, (curHead && model.headingById.has(curHead) ? curHead : '') || (active?.par ?? ''), activeId); ops.push(...c.ops); counter = c.id; }
        ops.push(...doorCountOps(counter, auto.dwg, auto.pg, x.f.p, dr.id, me.username, ready?.key ?? '').ops);
        n++; nd++;
        continue;
      }
      const ti = itemFor(x.f.text);
      last = ti;
      ops.push(...shapeOps(ti, auto.dwg, auto.pg, 'pt', [x.f.p], me.username, 1, ready?.key ?? '').ops);
      n++;
    }
    if (!n) { setAuto(null); return; }
    // the new take-offs (one per tag) one after the other in tag order, each its own colour: every one was
    // given the same place at the end of the list and the same colour (the model has none of the others
    // yet) - 126 door marks came out in random order
    const fresh = [...made.values()].map((id) => ({ id, name: String(ops.find((o) => o[0] === id && o[1] === 'name')?.[2] ?? '') })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const use = new Map<string, number>();
    for (const it of model.items) use.set(it.color, (use.get(it.color) ?? 0) + 1);
    const colours = [...ITEM_COLORS].sort((a, b) => (use.get(a) ?? 0) - (use.get(b) ?? 0));
    let ord: string | null = null;
    fresh.forEach((f, i) => {
      for (const o of ops) {
        if (o[0] !== f.id) continue;
        if (o[1] === 'color') o[2] = colours[i % colours.length];
        if (o[1] === 'ord') { ord = i === 0 ? (o[2] as string) : generateKeyBetween(ord, null); o[2] = ord; }
      }
    });
    if (!commit(ops, `Auto-count ${n} × ${auto.q}`)) return;
    setAuto(null);
    if (!auto.perTag && last) setActiveId(last);
    toast(<span>Counted <b>{n}</b> × “{auto.q}”{nd ? <> ({nd} as doors of the schedule, in <b>{DOOR_COUNTER_NAME}</b>)</> : null}{made.size ? ` (${made.size} new count take-off${made.size > 1 ? 's' : ''})` : ''}.</span>, { action: undoAction() });
  };

  /** v0.16 (e): the model with only the shapes this person may change (what a copy with its shapes copies) */
  const editableModel = (): { m: QtoModel; left: number } => {
    const m = modelRef.current;
    let left = 0;
    const by = new Map<string, Shape[]>();
    for (const [ti, list] of m.shapesByItem) { const k = list.filter(canEditShape); left += list.length - k.length; by.set(ti, k); }
    return { m: left ? { ...m, shapesByItem: by } : m, left };
  };
  const duplicate = (ti: string, o: { links: boolean; shapes: boolean }) => {
    const em = o.shapes ? editableModel() : { m: model, left: 0 };
    const left = o.shapes ? (model.shapesByItem.get(ti) ?? []).filter((s) => !canEditShape(s)).length : 0;
    // (v0.16 a room: its settings, outline with its edges / doors / openings, and its own finishes)
    const r = model.itemById.get(ti)?.kind === 'room' ? duplicateRoomOps(em.m, ti, me.username, { shapes: o.shapes }) : duplicateItemOps(em.m, ti, me.username, o);
    if (!r || !commit(r.ops, 'Duplicated take-off')) return;
    pickRows(new Set([r.id]));
    toast(<span>Duplicated as <b>{String(r.ops.find((x) => x[0] === r.id && x[1] === 'name')?.[2] ?? '')}</b>{o.links ? ', linked to the same BOQ lines' : ''}.{left ? ` ${left} shape${left === 1 ? '' : 's'} of other people (view only) not copied.` : ''}</span>, { action: undoAction() });
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      // (the document the key was pressed in: the drawing window's, or this one - a key passed on from the drawing
      // window comes from this window, whose field in focus let go)
      const el = ((e.target as Node | null)?.ownerDocument ?? document).activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      // the door / opening picker is open but its box lost the keyboard (a click on its heading): keys are
      // not tools behind it (A changed the tool under it, Ctrl+Z could undo the wall it is placing on);
      // Esc still closes it
      // (nor is Ctrl+Z / Ctrl+Y the browser's own undo: with the keyboard on no box, it typed the last box
      // edited behind back to what it was - and moved the keyboard there)
      const undoKey = (e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key);
      if (opick) { if (e.key === 'Escape') { e.preventDefault(); setOpick(null); } else if (undoKey) e.preventDefault(); return; }
      // v0.18 putting an overlaid sheet in place: Esc stops it (Backspace: the last point again)
      if (imgPlaceRef.current && e.key === 'Escape') { e.preventDefault(); setImgPlace(null); return; }
      if (ovrCropRef.current && e.key === 'Escape') { e.preventDefault(); setOvrCrop(false); return; }
      if (alignRef.current) {
        if (e.key === 'Escape') { e.preventDefault(); setAlign(null); return; }
        if (e.key === 'Backspace') { e.preventDefault(); setAlign({ ...alignRef.current, pts: alignRef.current.pts.slice(0, -1) }); return; }
      }
      // Esc closes the right-click menu of the drawing (a door's, a shape's) - it stayed open
      if (menu && e.key === 'Escape') { e.preventDefault(); setMenu(null); return; }
      // a dialog is open (the take-off's own, or F1 / the command box over it): Ctrl+Z / Ctrl+Y are not for the
      // take-off behind it either (BH-044: they undid a wall under its door schedule) - as on the drawing
      if (dialog || qsAny('.scrim:not(.clear)')) { if (undoKey) e.preventDefault(); return; }
      if (e.ctrlKey || e.metaKey) {
        // v0.16 tabs: Ctrl+Tab / Ctrl+Shift+Tab the next / previous one, Ctrl+W closes this one (the window has no
        // Ctrl+W of its own; the estimate around an embedded take-off uses neither)
        if (e.key === 'Tab') { e.preventDefault(); stepTab(e.shiftKey ? -1 : 1); return; }
        if ((e.key === 'w' || e.key === 'W') && !e.shiftKey && !e.altKey) { e.preventDefault(); if (curTabRef.current) closeTabId(curTabRef.current); return; }
        if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
        else if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); doRedo(); }
        return;
      }
      if (e.altKey || dialog) return;
      // v0.16 aids: F8 = ortho, M = the magnifier (M is a unit while a length is typed: the drawing takes it then)
      if (e.key === 'F8') { e.preventDefault(); setAids({ ortho: !aids().ortho }); return; }
      if ((e.key === 'm' || e.key === 'M') && !e.shiftKey) { e.preventDefault(); setAids({ loupe: !aids().loupe }); return; }
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (t) { e.preventDefault(); pickTool(t.k); return; }
      const mk = e.key.toLowerCase();
      if (mk === 'p' || mk === 'r' || mk === 'o') { e.preventDefault(); pickMode(mk === 'p' ? 'path' : mk === 'r' ? 'rect' : 'circle'); return; }
      if (mk === 't' && !readOnly && ready && cur) { e.preventDefault(); setDialog({ k: 'auto' }); return; }
      if (e.key === 'Escape' && auto) { e.preventDefault(); setAuto(null); return; }
      if (e.key === 'Escape' && beamAuto) { e.preventDefault(); setBeamAuto(null); return; }
      if (e.key === 'Escape' && colAuto) { e.preventDefault(); setColAuto(null); return; }
      if (e.key === 'g' || e.key === 'G') { e.preventDefault(); setSnapOn((s) => !s); }
      // v0.16.1 Count tool: D = count doors of the schedule (doors not on a wall)
      if ((e.key === 'd' || e.key === 'D') && tool === 'count' && !sk && !readOnly) { e.preventDefault(); if (doorMode) chooseDoor('count', [Math.round(activeWin().innerWidth / 2 - 170), Math.round(activeWin().innerHeight / 3)]); else setDoorMode(true); }
      if (e.key === 'PageDown') { e.preventDefault(); stepSheet(1); }
      if (e.key === 'PageUp') { e.preventDefault(); stepSheet(-1); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // PageUp / PageDown follow the drawing list as the team organised it
  const sheetsInOrder = useMemo(() => leavesInOrder(model.dwgTree).map((id) => model.dwgById.get(id)!).filter(Boolean).flatMap((d) => Array.from({ length: Math.max(1, d.pages || 1) }, (_, pg) => ({ dwg: d.id, pg }))), [model.dwgTree, model.drawings]);
  const stepSheet = (dir: number) => {
    if (!cur) return;
    const i = sheetsInOrder.findIndex((s) => s.dwg === cur.dwg && s.pg === cur.pg);
    const n = sheetsInOrder[i + dir];
    // (in the current tab: PgUp / PgDn move it on through the sheets)
    if (n) openSheet(n.dwg, n.pg, { inTab: true });
  };

  // ---------- measuring ----------
  const ensureItem = (kind: Kind): string | null => {
    // (v0.17 a structural element: the take-off in use if it is one of that kind, else a new one)
    const want = sk && SK_KIND[sk as Exclude<StructKind, ''>] === kind ? sk : '';
    if (active && active.kind === kind && (active.sk ?? '') === want) return active.id;
    if (want) {
      const m0 = modelRef.current;
      const r = newStructOps(m0, me.username, want as Exclude<StructKind, ''>, (curHead && m0.headingById.has(curHead) ? curHead : '') || (active?.par ?? ''));
      if (!commit(r.ops, 'New ' + SK_LABEL[want as Exclude<StructKind, ''>].toLowerCase())) return null;
      setActiveId(r.id);
      toast(<span>New take-off <b>{String(r.ops.find((o) => o[1] === 'name')?.[2])}</b> — {want === 'slab' || want === 'drop' || want === 'raft' || want === 'sog' ? 'its thickness' : want === 'stair' ? 'its tread, riser, flight width, waist and landing thickness' : want === 'ftg' ? 'the footing types (L × W × D)' : want === 'col' ? 'its height (and the column types)' : 'its height (and the wall types)'} on the right.</span>);
      return r.id;
    }
    const m = modelRef.current;
    const par = (curHead && m.headingById.has(curHead) ? curHead : '') || (active?.par ?? '');
    // v0.16 a new room: with the settings of the last room of its name (the Room tool with no room in use)
    if (kind === 'room') {
      const r = newRoomOps(m, me.username, { name: '', par });
      if (!commit(r.ops, 'New room')) return null;
      setActiveId(r.id);
      toast(<span>New room <b>{String(r.ops.find((o) => o[0] === r.id && o[1] === 'name')?.[2] ?? '')}</b> — name it on the right.</span>);
      return r.id;
    }
    const { id, ops } = newItemOps(m, me.username, kind, undefined, par);
    if (!commit(ops, 'New take-off')) return null;
    setActiveId(id);
    toast(<span>New take-off <b>{String(ops.find((o) => o[1] === 'name')?.[2])}</b> — rename it on the right.</span>);
    return id;
  };

  const onShape = (k: 'poly' | 'line' | 'pt', pts: Pt[], b?: number[]): string | null => {
    if (!cur) return null;
    // v0.18 putting an overlaid sheet in place: the click is one of its four points
    if (alignRef.current) { if (k === 'pt') alignPoint(pts[0]); return null; }
    // v0.18 an image waiting for its place: this rectangle is it
    if (imgPlaceRef.current) { if (k === 'poly') placeImage(pts); return null; }
    if (ovrCropRef.current) {
      setOvrCrop(false);
      if (k === 'poly' && ovr) {
        // (the rectangle drawn here, on the overlaid sheet's own page: the part of it shown)
        const inv = invMat(ovrMat), q = pts.map((x) => applyMat(inv, x));
        const cr = { x0: Math.min(...q.map((x) => x[0])), y0: Math.min(...q.map((x) => x[1])), x1: Math.max(...q.map((x) => x[0])), y1: Math.max(...q.map((x) => x[1])) };
        if (cr.x1 - cr.x0 > 2 && cr.y1 - cr.y0 > 2) putAlign(ovrPair, { cr: { x0: Math.round(cr.x0 * 100) / 100, y0: Math.round(cr.y0 * 100) / 100, x1: Math.round(cr.x1 * 100) / 100, y1: Math.round(cr.y1 * 100) / 100 } }, 'Overlay: a part of it');
      }
      return null;
    }
    // v0.16.1 the Count tool's door mode: a door of the schedule (the last one used; the first click asks which)
    if (k === 'pt' && tool === 'count' && doorMode) {
      const ld = lastDoor && modelRef.current.doorById.has(lastDoor.id) ? lastDoor : null;
      if (ld) return countDoorAt(pts[0], ld.id);
      setOpick({ k: 'door', shape: 'count', p: pts[0], client: [Math.round(activeWin().innerWidth / 2 - 170), Math.round(activeWin().innerHeight / 3)], choose: 'count' });
      return null;
    }
    // the take-off the tool measures (a wall's or a beam's rectangle / circle is its outline, a line)
    const byShape: Kind = k === 'poly' ? 'area' : k === 'line' ? 'line' : 'count';
    const tk = KIND_OF_TOOL[tool];
    const kind: Kind = tk && (k === 'pt' ? tk === 'count' : k === 'poly' ? tk === 'area' || tk === 'room' : isLineKind(tk)) ? tk : byShape;
    // v0.16 a room's own finish being drawn: a length runs along the room's outline (projected onto it,
    // round its corners); an area should lie inside it
    // (v0.18 a miscellaneous item is measured as it is drawn, anywhere: not along / inside the outline)
    const part = active && (active.rk === 'add' || active.rk === 'ceil') && active.kind === kind && modelRef.current.fin.partById.get(active.id)?.ak !== 'misc' ? active : null;
    if (part) {
      const outl = roomOutlines(modelRef.current, part.rm ?? '', cur.dwg, cur.pg);
      if (k === 'line' && outl.length) {
        const o = nearestOutline(outl, pts);
        const on = o ? alongOutline(o, flattenPath(pts, b, false)) : null;
        if (!on) { toast('Draw it along the room’s outline: it comes to nothing there.'); return null; }
        pts = on;
        b = undefined;
      } else if (!outl.length) toast(<span>The room has no outline on this sheet: <b>{part.name}</b> is kept, but it can’t be matched to the room’s edges here.</span>, { color: '#b45309' });
      else if (k === 'poly' && !outl.some((o) => polyInside(flattenPath(pts, b, true), o.flat))) toast(<span>That area is not inside the room’s outline — it is kept and flagged in the room.</span>, { color: '#b45309' });
    }
    const ti = ensureItem(kind);
    if (!ti) return null;
    const { id, ops } = shapeOps(ti, cur.dwg, cur.pg, k, pts, me.username, 1, ready?.key ?? '', b);
    // v0.17 a column: the type picked in the bar (else the take-off's default type)
    if (k === 'pt' && isCountedStruct(sk as StructKind) && colType && typesFor(modelRef.current, sk as StructKind).some((t) => t.id === colType)) ops.push([id, 'mt', colType]);
    // v0.18 a stair's landing (the bar under the drawing says which is being drawn)
    if (k === 'poly' && sk === 'stair' && stairPart === 'l') ops.push([id, 'sp', 'l']);
    if (!commit(ops, k === 'pt' ? (isCountedStruct(sk as StructKind) ? SK_LABEL[sk as 'col'] : 'Count') : k === 'line' ? (kind === 'wall' ? 'Measured wall' : kind === 'beam' ? 'Measured beam' : part ? 'Drew ' + part.name : 'Measured length') : kind === 'room' ? 'Room outline' : part ? 'Drew ' + part.name : 'Measured area', {})) return null;
    if (k === 'pt') countRun.current.push(id);
    warnCrossing(k, pts, b);
    if (k !== 'pt') setSelected(new Set([id]));
    if (!pageInfo?.sc && k !== 'pt' && !model.regions.some((r) => r.dwg === cur.dwg && r.pg === cur.pg)) {
      toast(<span>This sheet has <b>no scale yet</b> — the shape is kept, its quantity appears as soon as you set the scale.</span>, { action: { label: 'Set scale', fn: () => setTool('scale') }, color: '#b45309' });
    }
    return id;
  };

  // ---------- doors and openings on walls (v0.15) ----------
  const placeDoor = (d: { id: string } | { tag: string; sw: number | null; sh: number | null }, lint: boolean) => placeDoorWith(opick, d, lint);
  /** v0.16.1 a door counted where the Count tool was clicked (door mode): into the door counter */
  const countDoorAt = (p: Pt, door: string, pre: Op[] = []): string | null => {
    const m = modelRef.current;
    if (!cur) return null;
    const why = doorCountRefusal(m, cur.dwg, cur.pg, p, door);
    if (why) { toast(why, { color: '#b45309' }); return null; }
    const par = (curHead && m.headingById.has(curHead) ? curHead : '') || (active?.par ?? '');
    const c = doorCounterOps(m, me.username, par, activeId);
    const d = doorCountOps(c.id, cur.dwg, cur.pg, p, door, me.username, ready?.key ?? '');
    const tag = m.doorById.get(door)?.tag ?? String(pre.find((o) => o[0] === door && o[1] === 'tag')?.[2] ?? '');
    if (!commit([...pre, ...c.ops, ...d.ops], 'Door ' + tag + ' (not on a wall)')) return null;
    countRun.current.push(d.id);
    if (c.ops.length) toast(<span>Doors not on walls are counted in <b>{DOOR_COUNTER_NAME}</b>: they count in the door schedule, and reach the BOQ through it.</span>);
    return d.id;
  };
  const placeDoorWith = (pk0: typeof opick, d: { id: string } | { tag: string; sw: number | null; sh: number | null }, lint: boolean) => {
    if (!pk0) return;
    const ops: Op[] = [];
    let door: string, tag: string;
    if ('id' in d) { door = d.id; tag = model.doorById.get(d.id)?.tag ?? ''; }
    else {
      const r = doorRowsOps(model, [{ tag: d.tag, sw: d.sw, sh: d.sh }]);
      ops.push(...r.ops);
      door = r.ids[0];
      tag = d.tag;
      if (!d.sw || !d.sh) toast(<span><b>{d.tag}</b> added to the door schedule without a size: it is counted, nothing comes off the wall until it has one.</span>, { action: { label: 'Door schedule', fn: () => setDialog({ k: 'doors' }) } });
    }
    // v0.16.1 the bar's ▾ / the Count tool's first click: the door the next clicks use
    if (pk0.choose) {
      setOpick(null);
      setLastDoor({ id: door, lint });
      if (pk0.choose === 'count') { if (pk0.shape === 'count') countDoorAt(pk0.p, door, ops); else if (ops.length) commit(ops, 'Door schedule: ' + tag); }
      else { if (ops.length) commit(ops, 'Door schedule: ' + tag); setPlaceArm({ k: 'door', token: Date.now() }); }
      return;
    }
    // (v0.16 in a room: it corrects the room's finishes only - refused on an open edge)
    const inRoom = opickInRoom(pk0);
    if (pk0.edit) {
      const id = pk0.edit.id;
      ops.push([id, 'k', 'door'], [id, 'door', door], [id, 'tag', tag], [id, 'w', null], [id, 'h', null], [id, 'lint', lint || inRoom ? null : false]);
      if (inRoom) ops.push(...setOpeningSillOps(id, null));
    } else if (inRoom) {
      const r = roomOpeningOps(model, pk0.shape, { k: 'door', x: pk0.p[0], y: pk0.p[1], door, tag });
      if ('error' in r) { toast(r.error, { color: '#b45309' }); setOpick(null); return; }
      ops.push(...r.ops);
    } else ops.push(...openingOps({ sh: pk0.shape, x: pk0.p[0], y: pk0.p[1], k: 'door', door, tag, w: null, h: null, lint, ln: onLength(pk0.shape) }).ops);
    if (!commit(ops, pk0.edit ? 'Changed door' : (inRoom ? 'Room door ' : 'Door ') + tag)) { setOpick(null); return; }
    setOpick(null);
    // v0.16.1 the next click on a wall / room edge puts the same door (Esc stops; ▾ on the bar = another door)
    if (!pk0.edit) { setLastDoor({ id: door, lint }); if (!stepRef.current && !placedWhileDrawing.current) setPlaceArm({ k: 'door', token: Date.now() }); }
  };
  const placeOpen = (o: { w: number; h: number; tag: string; sill?: number }, lint: boolean) => {
    const pk0 = opick;
    if (!pk0) return;
    const inRoom = opickInRoom(pk0);
    let ops: Op[];
    if (pk0.edit) {
      ops = [[pk0.edit.id, 'k', 'open'], [pk0.edit.id, 'door', null], [pk0.edit.id, 'tag', o.tag || null], [pk0.edit.id, 'w', o.w], [pk0.edit.id, 'h', o.h], [pk0.edit.id, 'lint', lint || inRoom ? null : false]];
      if (inRoom) ops.push(...setOpeningSillOps(pk0.edit.id, o.sill || null));
    } else if (inRoom) {
      const r = roomOpeningOps(model, pk0.shape, { k: 'open', x: pk0.p[0], y: pk0.p[1], tag: o.tag, w: o.w, h: o.h, sill: o.sill || null });
      if ('error' in r) { toast(r.error, { color: '#b45309' }); setOpick(null); return; }
      ops = r.ops;
    } else ops = openingOps({ sh: pk0.shape, x: pk0.p[0], y: pk0.p[1], k: 'open', door: null, tag: o.tag, w: o.w, h: o.h, lint, ln: onLength(pk0.shape) }).ops;
    commit(ops, pk0.edit ? 'Changed opening' : (inRoom ? 'Room opening ' : 'Opening ') + mmOf(o.w) + '×' + mmOf(o.h) + (inRoom && o.sill ? ' sill ' + mmOf(o.sill) : ''));
    setOpick(null);
  };
  /** v0.16 shapes moved to another take-off: a room's outline only to a room, a room takes areas only */
  const roomMoveRefusal = (ids: string[], ti: string): string | null => {
    const to = model.itemById.get(ti);
    const list = model.shapes.filter((s) => ids.includes(s.id));
    if (to?.kind === 'room' && list.some((s) => s.k !== 'poly')) return 'A room’s outline is an area: only areas can go into a room.';
    if (to?.kind !== 'room' && list.some((s) => isRoomOutline(model, s))) return 'A room’s outline can only go into another room (its doors and edges go with it).';
    return null;
  };
  /** the drawing: a door / an opening clicked onto a wall or (v0.16) a room's edge - its picker opens there */
  const rearm = useRef(false);
  /** v0.16.1 the door went on a wall still being drawn: the wall goes on after it (door placing is not kept on) */
  const placedWhileDrawing = useRef(false);
  const onOpening = (k: 'door' | 'open', at: { shape: string; p: Pt; client: [number, number]; drawing?: boolean }) => {
    placedWhileDrawing.current = !!at.drawing;
    const why = roomDoorRefusal(modelRef.current, at.shape, at.p);
    // (refused on an open edge: said, and the next click goes on placing it)
    if (why) { toast(why, { color: '#b45309' }); rearm.current = true; setPlaceArm({ k, token: Date.now() }); return; }
    // v0.16.1 a door again: the last one used, at once (outside a room step from the panel, which asks each time)
    const ld = lastDoor && modelRef.current.doorById.has(lastDoor.id) ? lastDoor : null;
    if (k === 'door' && ld && !stepRef.current) { placeDoorWith({ k, shape: at.shape, p: at.p, client: at.client }, { id: ld.id }, ld.lint); return; }
    setOpick({ k, shape: at.shape, p: at.p, client: at.client });
  };
  /** v0.16 the door / opening being placed or changed is in a room (on a room's outline) */
  /** v0.18 a door / opening on a plain length: off that length only */
  const onLength = (shapeId: string) => { const s = modelRef.current.shapes.find((x) => x.id === shapeId); return !!s && modelRef.current.itemById.get(s.ti)?.kind === 'line'; };
  const opickInRoom = (pk0: { shape: string; edit?: Opening } | null) => {
    if (!pk0) return false;
    if (pk0.edit) return !!pk0.edit.room;
    const s = modelRef.current.shapes.find((x) => x.id === pk0.shape);
    return !!s && isRoomOutline(modelRef.current, s);
  };
  const editOpening = (o: Opening, client?: [number, number]) => {
    const s = model.shapes.find((x) => x.id === o.sh);
    if (s && cur && (s.dwg !== cur.dwg || s.pg !== cur.pg)) openSheet(s.dwg, s.pg);
    setOpick({ k: o.k, shape: o.sh, p: [o.x, o.y], client: client ?? [activeWin().innerWidth / 2 - 150, activeWin().innerHeight / 3], edit: o });
  };
  /** the doors and openings of this sheet's walls, as gaps across the wall */
  /** the doors and openings drawn on a sheet's walls (v0.16.4: any sheet shown - the one worked on and the others) */
  const openingsOn = (shapes: Shape[], at: { dwg: string; pg: number }, hide: Set<string>): OpeningMark[] => {
    const out: OpeningMark[] = [];
    for (const s of shapes) {
      const list = model.openingsByShape.get(s.id);
      if (!list || s.k === 'pt' || hiddenItems.has(s.ti) || hide.has(s.id)) continue;
      for (const o of list) {
        const a = s.pts[o.seg], b = s.pts[(o.seg + 1) % s.pts.length];
        if (!a || !b) continue;
        let p: Pt = [a[0] + (b[0] - a[0]) * o.t, a[1] + (b[1] - a[1]) * o.t];
        let L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        let ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
        // a curved segment: the mark goes on the arc (the point of it nearest where the door was put, the
        // gap along the arc's tangent there) - on the chord it sat off the wall, inside the curve
        const k = s.b[o.seg] ? arcCircle(a, b, s.b[o.seg]) : null;
        if (k) {
          const sg = Math.sign(k.th), span = Math.abs(k.th), TAU = Math.PI * 2;
          // how far round from a, in the arc's own direction (0..2π); past its end: the nearer end
          let rel = ((Math.atan2(o.y - k.c[1], o.x - k.c[0]) - k.a0) * sg) % TAU;
          if (rel < 0) rel += TAU;
          if (rel > span) rel = rel - span < TAU - rel ? span : 0;
          const ang = k.a0 + sg * rel;
          p = [k.c[0] + k.r * Math.cos(ang), k.c[1] + k.r * Math.sin(ang)];
          ux = -Math.sin(ang) * sg; uy = Math.cos(ang) * sg;
          L = k.r * span || 1;
        }
        const { w, h } = openingSize(model, o);
        const sc = scaleAt(model, at.dwg, at.pg, p);
        // metres per sheet point along the wall (across and up-down may differ)
        const mpp = sc.sc ? Math.hypot(ux * sc.sc, uy * (sc.scy ?? sc.sc)) : 0;
        const half = w && mpp ? Math.min(L / 2, w / 2 / mpp) : 0;
        const d = o.door ? model.doorById.get(o.door) : null;
        out.push({
          id: o.id,
          ea: s.pts[o.seg], eb: s.pts[(o.seg + 1) % s.pts.length],
          a: [p[0] - ux * half, p[1] - uy * half],
          b: [p[0] + ux * half, p[1] + uy * half],
          label: o.k === 'door' ? (d?.tag || o.tag || 'door') + (o.uns ? ' (not in schedule)' : !w ? ' (no size)' : '') : (o.tag || (w && h ? `${mmOf(w)}×${mmOf(h)}` : 'opening')) + (o.room && o.sill ? ` · sill ${mmOf(o.sill)}` : ''),
          color: o.uns ? '#c92a2a' : o.k === 'door' ? '#1864ab' : '#7a4fc4',
          k: o.k,
          band: model.itemById.get(s.ti)?.kind === 'wall' ? model.itemById.get(s.ti)?.d ?? null : null,
        });
      }
    }
    return out;
  };
  const pageOpenings: OpeningMark[] = useMemo(() => (cur ? openingsOn(pageShapes, cur, ownerHidden) : []), [model, pageShapes, cur?.dwg, cur?.pg, hiddenItems, ownerHidden]);
  /** a segment's tag on the drawing: a beam type's name and colour, else the text */
  const segTag = (s: Shape, i: number) => {
    // (v0.16 a room's edge flags - open edge, shadow gap - are not tags: drawn as the edge's look)
    const t0 = tagText(s.sg?.[i]);
    if (!t0) return null;
    // (v0.18.1 a segment with figures of its own: marked *)
    const t = tagBase(t0) ?? '', star = hasTagOwn(t0) ? '*' : '';
    if (t.startsWith('bt:')) { const bt = model.beamTypeById.get(t); return { text: (bt?.name ?? '?') + star, color: bt?.color ?? null }; }
    if (t.startsWith('wt:')) { const wt = model.wallTypeById.get(t); return { text: (wt?.name ?? '?') + star, color: wt?.color ?? null }; }
    if (t.startsWith('rt:')) { const wt = model.rwTypeById.get(t); return { text: (wt?.name ?? '?') + star, color: wt?.color ?? null }; }
    return { text: t, color: null };
  };
  useEffect(() => { setSegHi(null); }, [activeId]);
  // a zoom (or Fit) asked for on one sheet is done with when another sheet is opened: the drawing is made
  // afresh for each sheet and did what it was last given - an old zoom box (a beam opened in the segment
  // list) zoomed the next sheet opened to that box of the earlier sheet (a GA plan opened on blank paper),
  // and a Fit pressed once fitted every sheet opened after it instead of showing it as it was left
  useEffect(() => { setFocus((f) => (f && f.pk !== pk ? null : f)); setFitToken((f) => (f && f.pk !== pk ? null : f)); }, [pk]);
  useEffect(() => { if (auto && (!cur || auto.dwg !== cur.dwg || auto.pg !== cur.pg)) setAuto(null); }, [cur?.dwg, cur?.pg]);
  useEffect(() => { if (beamAuto && (!cur || beamAuto.dwg !== cur.dwg || beamAuto.pg !== cur.pg)) setBeamAuto(null); }, [cur?.dwg, cur?.pg]);
  useEffect(() => { if (colAuto && (!cur || colAuto.dwg !== cur.dwg || colAuto.pg !== cur.pg)) setColAuto(null); }, [cur?.dwg, cur?.pg]);

  const onHole = (shapeId: string, pts: Pt[]) => {
    const s = model.shapes.find((x) => x.id === shapeId);
    if (!s) return;
    // a cut-out outside the area, over another one or crossing itself would deduct the wrong amount
    if (selfCrosses(pts)) return toast('That cut-out crosses itself — draw it again node by node.', { color: '#b45309' });
    if (!polyInside(pts, s.flat)) return toast('A cut-out has to be inside the area it comes off. Not added.', { color: '#b45309' });
    if (s.holes.some((h) => polysOverlap(pts, h))) return toast('That cut-out overlaps another one — it would be deducted twice. Not added.', { color: '#b45309' });
    commit(addHoleOps(s, pts), 'Cut-out');
  };
  // an outline that crosses itself has a meaningless area: say so (it is kept, a corner can be moved)
  const warnCrossing = (k: string, pts: Pt[], b?: number[]) => {
    if (k === 'poly' && pts.length > 3 && selfCrosses(flattenPath(pts, b, true))) {
      toast('This outline crosses itself, so its area is not right. Drag a node to untangle it.', { color: '#b45309' });
    }
  };

  const onMove = (ids: string[], dx: number, dy: number, copy: boolean) => {
    const shapes = model.shapes.filter((s) => ids.includes(s.id));
    if (!shapes.length || !cur) return;
    // v0.16 (e): other people's shapes, view only, are neither moved nor copied
    if (refuseLocked(ids)) return;
    if (copy) {
      // (v0.16 a room's outline: with its doors / openings and the finishes drawn along / inside it)
      const r = copyWithRoomsOps(model, shapes, { ...cur, rv: ready?.key }, me.username, dx, dy);
      commit(r.ops, 'Copied shapes');
      setSelected(new Set(r.ids.slice(0, shapes.length)));
    } else commit(moveShapesOps(withAttached(model, shapes), dx, dy, model.openingsByShape), 'Moved');
  };

  const onVertex = (id: string, ring: number, idx: number, p: Pt) => {
    const s = model.shapes.find((x) => x.id === id);
    if (!s) return;
    // (v0.16 a room's outline: its doors / openings and the finishes drawn along it keep their place)
    const follow = ring === 0 ? outlineFollowOps(model, s, { k: 'move', idx, p }) : [];
    if (commit([...vertexOps(s, ring, idx, p), ...follow], 'Moved node') && ring === 0) warnCrossing(s.k, s.pts.map((q, i) => (i === idx ? p : q)), s.b);
  };

  const onReplace = (id: string, pts: Pt[], b?: number[], sg?: (string | null)[]) => {
    const s = model.shapes.find((x) => x.id === id);
    if (s) commit(replacePointsOps(s, pts, b, sg), sg ? 'Continued from a node' : 'Continued line');
    setSelected(new Set([id]));
  };
  const onBulge = (id: string, seg: number, bulge: number) => {
    const s = model.shapes.find((x) => x.id === id);
    if (s) commit([...setBulgeOps(s, seg, bulge), ...outlineFollowOps(model, s, { k: 'bulge', seg, b: bulge })], bulge ? 'Arc' : 'Straightened');
  };
  /** the doors and openings of walls that a split / join replaces go onto the new parts (nearest one) */
  const withOpenings = (ops: Op[]): Op[] => {
    const gone = ops.filter((o) => o[0].startsWith('sh:') && o[1] === 'del' && o[2] === true).map((o) => o[0]);
    if (!gone.some((id) => model.openingsByShape.has(id))) return ops;
    return [...ops, ...reassignOpeningsOps(model.openingsByShape, gone, newShapesIn(ops))];
  };
  /** split a length; the parts stay in the same take-off (move one to another with "Move to another take-off") */
  const split = (r: { id: string; ops: Op[] } | { ids: string[]; ops: Op[] } | null, what: string) => {
    if (!r || !r.ops.length) return toast('Nothing to split there.');
    if (!commit(withOpenings(r.ops), what)) return;
    // a split in two: the new second part is selected (right-click it to measure it as something
    // else); split into segments: all of them
    const ids = 'id' in r ? [r.id] : r.ids;
    setSelected(new Set(ids));
    toast(<span>{what}. To measure a part as something else, right-click it › <b>Move to another take-off</b>.</span>);
  };
  const joinable = (ids: string[]) => {
    if (ids.length !== 2) return null;
    const [a, c] = ids.map((id) => model.shapes.find((x) => x.id === id));
    return a && c && a.ti === c.ti ? joinLinesOps(a, c, 1, (x) => model.stale.has(x.id), me.username) : null;
  };

  const onVertexInsert = (id: string, ring: number, after: number, p: Pt) => {
    const s = model.shapes.find((x) => x.id === id);
    if (s) commit(insertVertexOps(s, ring, after, p), 'Added node');
  };
  const onVertexDelete = (id: string, ring: number, idx: number) => {
    const s = model.shapes.find((x) => x.id === id);
    if (!s) return;
    const ops = deleteVertexOps(s, ring, idx);
    if (!ops.length) return toast(ring > 0 ? 'Not deleted: a cut-out needs at least 3 nodes (right-click the area › Remove its cut-outs).' : s.k === 'poly' ? 'Not deleted: an area needs at least 3 nodes.' : 'Not deleted: a line needs at least 2 nodes.');
    commit([...ops, ...(ring === 0 ? outlineFollowOps(model, s, { k: 'delete', idx }) : [])], 'Deleted node');
  };

  const deleteSelected = () => {
    if (!selected.size) return;
    // v0.16 (e): other people's shapes that are view only stay (and stay selected)
    const keep = [...selected].filter((id) => viewOnlyRef.current.has(id));
    const ids = [...selected].filter((id) => !viewOnlyRef.current.has(id));
    if (!ids.length) { const m = modelRef.current; toast(lockedMsg(m.shapes.filter((s) => keep.includes(s.id)))); return; }
    // (v0.16 a room's outline goes with its doors / openings and the finishes drawn along / inside it)
    if (!commit(deleteShapesOps(model, ids), 'Deleted shapes')) return;
    setSelected(new Set(keep));
    toast(`Deleted ${ids.length} shape${ids.length > 1 ? 's' : ''}.${keep.length ? ` ${keep.length} of other people's (view only) left as they are.` : ''}`, { action: undoAction() });
  };

  // ---------- the take-off list (v0.16) ----------
  /** Delete (the key on the list, a row's menu, the properties): asked first, then one step */
  const askDelete = (ids: string[]) => {
    if (readOnly) return toast('View only.');
    // someone else's take-offs: only they or an administrator delete them (as the button in its details)
    const theirs = deleteNodesOps(model, ids).items.map((ti) => model.itemById.get(ti)!).filter((it) => it && it.owner && it.owner !== me.username && !auth.isAdmin);
    if (theirs.length) return toast(<span><b>{theirs[0].name}</b>{theirs.length > 1 ? ` and ${theirs.length - 1} more` : ''} {theirs.length > 1 ? 'are' : 'is'} someone else's: only they or an administrator can delete {theirs.length > 1 ? 'them' : 'it'}. Nothing was deleted.</span>);
    // v0.16 (e): nor with other people's shapes in it that this person may not change (view only)
    const locked = deleteNodesOps(model, ids).items.flatMap((ti) => model.shapesByItem.get(ti) ?? []).filter((s) => !canEditShape(s));
    if (locked.length) {
      const who = [...new Set(locked.map((s) => nameOf(ownerOf(model, s))))];
      return toast(<span>Nothing was deleted: it has {locked.length} shape{locked.length === 1 ? '' : 's'} by <b>{who.join(', ')}</b> — view only.{isQs ? '' : <> To delete them too: <b>People ▾ › Edit other people's shapes</b>.</>}</span>);
    }
    if (ids.some((id) => model.itemById.has(id) || model.headingById.has(id))) setDialog({ k: 'del', ids });
  };
  const doDelete = (ids: string[]) => {
    const r = deleteNodesOps(model, ids);
    if (!commit(r.ops, r.items.length + r.headings.length > 1 ? `Deleted ${r.items.length} take-off${r.items.length === 1 ? '' : 's'}` : r.headings.length ? 'Deleted heading and what was in it' : 'Deleted take-off')) return;
    if (activeId && r.items.includes(activeId)) setActiveId(null);
    pickRows(new Set());
    toast(`Deleted ${r.items.length} take-off${r.items.length === 1 ? '' : 's'} with ${r.shapes} shape${r.shapes === 1 ? '' : 's'}${r.headings.length ? ` and ${r.headings.length} heading${r.headings.length === 1 ? '' : 's'}` : ''}. Ctrl+Z brings ${r.items.length + r.headings.length === 1 ? 'it' : 'them'} back.`, { action: undoAction() });
  };
  /** link one take-off (its own dialog) or several in one step */
  const linkRows = (rows: string[]) => {
    // (v0.16: a room's quantities reach the BOQ only through the Finishes Summary)
    const ids = [...itemsOfRows(rows)].filter((x) => model.itemById.get(x)?.kind !== 'room');
    if (!ids.length) return;
    setDialog(ids.length === 1 ? { k: 'link', ti: ids[0] } : { k: 'linkmany', ids: leavesInOrder(model.itemTree).filter((x) => ids.includes(x)) });
  };
  /** a heading copied (with its measurements or without), right after it; BOQ links never */
  const dupHeading = (hid: string, withValues: boolean) => {
    const raw = (ti: string): [string, Value][] => [...(session.store.ents.get(ti) ?? new Map<string, { v: Value }>())].map(([f, c]) => [f, c.v]);
    // (v0.16 e: with its measurements - only the shapes this person may change)
    const r = duplicateHeadingOps(withValues ? editableModel().m : model, hid, me.username, withValues, raw);
    if (!r || !commit(r.ops, withValues ? 'Duplicated heading with its take-offs' : 'Duplicated heading without values')) return;
    setCurHead(r.id);
    pickRows(new Set([r.id]));
    const name = model.headingById.get(hid)?.name ?? '';
    toast(<span>Copied as <b>{name} (copy)</b>: {r.items} take-off{r.items === 1 ? '' : 's'}{withValues ? `, ${r.shapes} shape${r.shapes === 1 ? '' : 's'}` : ', nothing measured'}. {withValues ? 'BOQ links are not copied — the copies would count twice.' : 'BOQ links are not copied.'}</span>, { action: undoAction() });
  };

  // ---------- drawings ----------
  const addFiles = async () => {
    const paths = await gt().pickPdfs({ title: 'Choose drawings (they stay where they are)' });
    if (!paths.length) return;
    const found = await statPicked(paths);
    setDialog({ k: 'import', found, issue: issueFromPath(paths[0]) });
  };
  const addFolder = async () => {
    const dir = await gt().pickDir({ title: 'Choose a drawings folder (every PDF in it and its subfolders)', remember: true });
    if (!dir) return;
    setBusy('Looking for PDFs in ' + dir + '…');
    try {
      const found = await gt().files.listPdfs(dir);
      const cut = found.length && found[found.length - 1].truncated ? found.pop()!.truncated : '';
      if (cut) toast(<span>Not every file in that folder was listed: <b>{cut}</b>. Bring in the rest by picking its subfolders one at a time.</span>, { color: '#b45309' });
      if (!found.length) { toast(cut ? 'No PDF files could be listed in that folder: ' + cut + '.' : 'No PDF files in that folder.'); return; }
      setDialog({ k: 'import', found, issue: issueFromPath(dir) });
    } finally {
      setBusy(null);
    }
  };
  const relocate = async () => {
    if (!curDrawing) return;
    const paths = await gt().pickPdfs({ title: 'Where is ' + curDrawing.name + ' now?' });
    if (!paths[0]) return;
    const st = await gt().files.stat(paths[0]);
    if (!st) return;
    // the share it is on, so PCs that map it to another letter find it too
    const unc = toUnc(paths[0], await drives());
    commit([[curDrawing.id, 'path', paths[0]], [curDrawing.id, 'unc', unc || null], [curDrawing.id, 'size', st.size], [curDrawing.id, 'mtime', st.mtime]], 'Drawing moved');
    // the fingerprint stays: a file with other contents opens as "changed" (on every PC) until
    // someone takes it as the new version
    if (curDrawing.hash) {
      const h = await fingerprint(paths[0], info.localDir);
      if (h && h !== curDrawing.hash) toast(<span><b>{baseName(paths[0])}</b> is not the same file as the one measured (other contents). It shows as changed: if it is the new revision, press <b>Use the new version</b>; if not, pick the right file.</span>, { color: '#b45309' });
    }
    // (opened again from where it is now: its path changed)
    setLoadTry((x) => x + 1);
  };
  /**
   * v0.16: a multi-page drawing brought in before 0.16 becomes a sheet per page, with what was measured on each
   * (one undo step). Each page's sheet number and title from its title block where the file can be read.
   */
  const splitDrawing = async (id: string) => {
    const d = modelRef.current.dwgById.get(id);
    if (!d || !isOldBinder(d) || readOnly || session.readOnly) return;
    let names: ({ sheet: string; title: string } | null)[] = [];
    if (engine) {
      setBusy('Reading the pages of ' + d.name + '…');
      try {
        const loc = await locate(d).catch(() => null);
        if (loc) names = (await scanPdf(engine, loc.path, { size: loc.stat.size, mtime: loc.stat.mtime })).pages ?? [];
      } finally { setBusy(null); }
    }
    const m = modelRef.current;
    const d2 = m.dwgById.get(id);
    if (!d2) return;
    const r = splitBinderOps(session.store, m, d2, names, me.username);
    if (!commit(r.ops, 'Split into separate sheets')) return;
    // its tabs go to its pages
    const tl = tabsRef.current.map((t) => (t.dwg === id ? { ...t, dwg: r.ids[Math.min(t.pg, r.ids.length - 1)], pg: 0 } : t));
    applyTabs({ tabs: tl, used: tabUsed.current, cur: curTabRef.current });
    const n = m.shapes.filter((x) => x.dwg === id).length + (m.offPage.get(id) ?? 0);
    toast(<span><b>{sheetTitle(d2)}</b> is now {r.ids.length} sheets, one per page{n ? <> — its {n} shape{n > 1 ? 's' : ''}, scales, viewports and notes moved with their pages</> : ''}. The file is not touched.</span>, { action: undoAction() });
  };
  /** the import reads each file's pages (a bound set comes in as a sheet per page) */
  const scanFile = useCallback((f: FoundFile, alive: () => boolean, onPage?: (done: number, of: number) => void) => (engine ? scanPdf(engine, f.path, f, alive, onPage) : Promise.resolve({ n: 1 })), [engine]);
  const accepting = useRef(false);
  const acceptRevision = async () => {
    if (!curDrawing || !ready || !ready.changed || accepting.current) return;
    accepting.current = true;
    setTimeout(() => (accepting.current = false), 1500);
    const st = await gt().files.stat(ready.path);
    const when = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    if (!commit(replacedInPlaceOps(model, curDrawing, { hash: ready.key, size: st?.size ?? 0, mtime: st?.mtime ?? 0, pages: ready.pages.length }, { user: me.username, rev: '', issue: 'replaced ' + when }), 'New revision of drawing')) return;
    // what is on screen is now the current revision: the question is answered
    setLoad({ ...ready, changed: false });
    toast('Now using the new version. Take-offs measured on the old one are flagged to check — use Compare to see what changed.');
  };
  const markChecked = (ids?: string[]) => {
    if (!curDrawing?.hash) return;
    const shapes = model.shapes.filter((s) => s.dwg === curDrawing.id && model.stale.has(s.id) && (!ids || ids.includes(s.id)));
    commit(markCheckedOps(shapes, curDrawing.hash), 'Checked against the new revision');
    toast(`${shapes.length} shape${shapes.length === 1 ? '' : 's'} marked as checked on ${revLabel(curDrawing)}.`);
  };

  // ---------- scale ----------
  /** after across (X) was calibrated: the next calibration line is for up-down (Y) */
  const scaleNext = useRef<ScaleDir | null>(null);
  /** the sheets the across (X) step was set on: the up-down (Y) step goes on the same ones (they all
   *  have a scale by then - "never overwrite" would leave all but this sheet without their Y) */
  const scaleTargets = useRef<{ at: string; list: { dwg: string; pg: number }[]; scope: 'page' | 'group' | 'all' } | null>(null);
  // (only for that sheet, while the scale tool stays on)
  useEffect(() => { if (tool !== 'scale') { scaleNext.current = null; scaleTargets.current = null; } }, [tool]);
  useEffect(() => { scaleNext.current = null; scaleTargets.current = null; }, [pk]);
  const setPageScale = (sc: number, label: string, scope: 'page' | 'group' | 'all', dir: ScaleDir = 'both', more = false) => {
    if (!cur) return;
    let targets: { dwg: string; pg: number }[] = [cur];
    const afterX = dir === 'y' && scope !== 'page' && scaleTargets.current?.at === pk ? scaleTargets.current.list : null;
    if (afterX) targets = afterX;
    else if (scope !== 'page') {
      const grp = curDrawing?.grp ?? '';
      for (const s of sheetsInOrder) {
        if (s.dwg === cur.dwg && s.pg === cur.pg) continue;
        const d = model.dwgById.get(s.dwg);
        if (scope === 'group' && d?.grp !== grp) continue;
        if (model.pages.get(pageKey(s.dwg, s.pg))?.sc) continue; // never overwrite a scale someone set
        targets.push(s);
      }
    }
    // the page size goes with the scale: a later revision on other paper is then flagged. Sheets
    // given this page's scale ("every sheet…") get this page's size too: one on other paper is
    // flagged when opened (its scale was not measured on it), and so is a later revision of it
    const sizeOps = (t: { dwg: string; pg: number }): Op[] => (page ? [['pg:' + pageKey(t.dwg, t.pg), 'w', Math.round(page.w)], ['pg:' + pageKey(t.dwg, t.pg), 'h', Math.round(page.h)]] : []);
    // across (X) or up-down (Y) only: the other direction stays as the sheet has it (a sheet without
    // a scale yet gets it both ways: there is nothing to keep). The same both ways: one scale.
    const ops: Op[] = [];
    let text = label;
    for (const t of targets) {
      const k = 'pg:' + pageKey(t.dwg, t.pg);
      const pi = model.pages.get(pageKey(t.dwg, t.pg));
      const has = !!pi?.sc;
      let x = sc, xl = label, y: number | null = null, yl: string | null = null;
      if (dir === 'x' && has) { y = pi!.scy ?? pi!.sc!; yl = pi!.scy ? pi!.scyl : pi!.scl; }
      else if (dir === 'y' && has) { x = pi!.sc!; xl = pi!.scl; y = sc; yl = label; }
      if (y !== null && yRatio(x, y) === 1) { y = null; yl = null; }
      // only what changes is written, so someone setting the other direction of the same sheet at the
      // same time keeps theirs: across alone writes across - and on a sheet that had one scale, the
      // up-down one as it was goes to scy0, which an up-down scale set meanwhile (scy) wins over
      if (dir === 'x' && has) {
        ops.push([k, 'sc', x], [k, 'scl', xl]);
        if (pi!.scyOwn) { if (y === null) ops.push([k, 'scy', null], [k, 'scyl', null], [k, 'scy0', null], [k, 'scyl0', null]); }
        else if ((pi!.scy ?? null) !== y) ops.push([k, 'scy0', y], [k, 'scyl0', yl]);
      } else if (dir === 'y' && has) {
        ops.push([k, 'scy', y], [k, 'scyl', yl]);
        if (y === null) ops.push([k, 'scy0', null], [k, 'scyl0', null]); // the same both ways now: one scale
      } else ops.push([k, 'sc', x], [k, 'scl', xl], [k, 'scy', y], [k, 'scyl', yl], [k, 'scy0', null], [k, 'scyl0', null]);
      ops.push(...sizeOps(t));
      if (t === targets[0]) text = scaleText(x, xl, y, yl ?? '');
    }
    // an up-down scale of its own: older apps would count it at the across scale - they open this
    // take-off view only from now on (the project is marked with the format that has it)
    if (ops.some((o) => (o[1] === 'scy' || o[1] === 'scy0') && o[2] !== null) && !readOnly && !session.readOnly) session.needFormat(FORMAT_XY_SCALES);
    commit(ops, 'Scale ' + text);
    toast(`Scale ${text} set on ${targets.length === 1 ? 'this sheet' : targets.length + ' sheets'}.`);
    scaleTargets.current = dir === 'x' ? { at: pk, list: targets, scope } : null;
    if (more) return;
    if (dir === 'x') {
      // across first, then up-down: the scale tool stays on for the vertical dimension
      scaleNext.current = 'y';
      setTool('scale');
      toast(<span>Across (X) set. Now click both ends of a known <b>up-down</b> (vertical) dimension for the up-down (Y) scale — or press Esc if it is the same.</span>, { color: '#1c7ed6' });
      return;
    }
    scaleNext.current = null;
    toolDone();
  };

  // ---------- v0.16 clearing the sheet's scale ----------
  /** the sheet's own scale off (both ways; viewports keep theirs) - one undo step */
  const clearScale = () => {
    if (!cur || !pageInfo?.sc) return;
    const was = scaleLabel;
    if (commit(clearScaleOps(cur.dwg, cur.pg), 'Cleared scale ' + was)) toast(<span>Scale {was} cleared on this sheet. Set it again with <b>S</b>.</span>, { action: undoAction() });
  };
  const [clearAsk, setClearAsk] = useState<{ pk: string; n: number } | null>(null);
  /** shapes measured on the sheet would lose their quantity: ask first */
  const askClearScale = () => {
    if (!cur || !pageInfo?.sc || readOnly) return;
    const n = shapesLosingScale(model, cur.dwg, cur.pg).length;
    if (n) setClearAsk({ pk, n });
    else clearScale();
  };

  // ---------- context menu ----------
  const ctxShape = menu?.shape ? model.shapes.find((s) => s.id === menu.shape) ?? null : null;
  const ctxOpening = menu?.opening ? model.openings.find((o) => o.id === menu.opening) ?? model.roomOpenings.find((o) => o.id === menu.opening) ?? null : null;
  const ctxIds = ctxShape ? (selected.has(ctxShape.id) ? [...selected] : [ctxShape.id]) : [];

  // ---------- export ----------
  const doExport = async () => {
    const name = (model.name || session.meta.name || 'Take-off').replace(/[\\/:*?"<>|]+/g, ' ').trim() + ' - quantities.xlsx';
    const p = await gt().saveFile({ title: 'Export quantities to Excel', name, filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
    if (!p) return;
    const nf = qtoFmt();
    const bytes = exportQto(model, { project: model.name || session.meta.name, by: me.name, dec: { len: nf.dm, area: nf.da, vol: nf.dv } });
    await gt().files.writeBytes(p, bytes);
    toast(<span>Exported to <b>{p.split(/[\\/]/).pop()}</b>.</span>, { action: { label: 'Open', fn: () => gt().openPath(p) } });
  };

  // ---------- labels ----------
  // the number on the sheet is the one in the totals: measured as the totals measure it (a length piece
  // by piece at each viewport's scale, an area at the scale of its middle), shown with the decimals set
  const qf = useQtoFmt();
  // worked out once per model and format: with "Numbers on the drawing: Always" every shape's number was
  // measured again on each move of the pointer
  const labels = useMemo(() => new Map<Shape, string>(), [model, qf]);
  const labelFor = (s: Shape) => {
    const had = labels.get(s);
    if (had !== undefined) return had;
    const it = model.itemById.get(s.ti);
    if (!it) return '';
    const q = shapeQtyAt(model, s, it.dmin);
    const mixed = q.mixed ? ' (across viewports)' : '';
    const t = s.k === 'pt' ? String(q.cnt) : !q.scaled ? 'no scale' : s.k === 'poly' ? m2(q.area) + mixed : m1(q.len) + (it.h ? ' · ' + m2(q.len * it.h) : '') + mixed;
    labels.set(s, t);
    return t;
  };
  /** a path being drawn / ruled, measured the same way (null = no scale for it, or for part of it) */
  const measurePath = (pts: Pt[], b: number[], closed: boolean): { len: number; area: number } | null => {
    if (!cur || pts.length < 2) return null;
    const flat = flattenPath(pts, b, closed);
    const tmp: Shape = { id: '', ti: '', dwg: cur.dwg, pg: cur.pg, k: closed ? 'poly' : 'line', pts, b, flat, holes: [], m: 1, box: bbox(flat), by: '', rv: '', sg: [] };
    const q = shapeQtyAt(model, tmp, null);
    return q.scaled ? { len: closed ? q.perim : q.len, area: q.area } : null;
  };
  const [fmtOpen, setFmtOpen] = useState(false);
  // how the shape is drawn: in the bar under the drawing, next to straight / arc (the tool bar above
  // stays the same whatever the tool, so the drawing never jumps when another tool is picked)
  const lastDoorTag = lastDoor ? model.doorById.get(lastDoor.id)?.tag ?? null : null;
  const chooseDoor = (choose: 'wall' | 'count', client: [number, number]) => setOpick({ k: 'door', shape: '', p: [0, 0], client, choose });
  const ckTypes = typesFor(model, sk as StructKind);
  const modeStrip = tool === 'count' && isCountedStruct(sk as StructKind) && !readOnly ? (
    // v0.17 columns (v0.18 shear walls, footings): the type each click puts down; the marks on the sheet place them all (after a look)
    <span className="segmode modestrip" data-colstrip={sk}>
      <span className="faint">Type</span>
      <select className="input sm" data-coltype value={ckTypes.some((t) => t.id === colType) ? colType : ''} onChange={(e) => { if (e.target.value === '+') openSched(catOfSk(sk as StructKind)); else setColType(e.target.value); }}>
        <option value="">{active?.bt && ckTypes.some((t) => t.id === active.bt) ? 'the take-off’s default (' + ckTypes.find((t) => t.id === active.bt)!.name + ')' : '— none —'}</option>
        {ckTypes.map((t) => <option key={t.id} value={t.id}>{t.name} ({typeSize(t, catOfSk(sk as StructKind))})</option>)}
        <option value="+">{SK_LABEL[sk as 'col']} schedule…</option>
      </select>
      <button data-frommarks onClick={() => { void colMarks(); }} disabled={!ckTypes.length || !ready} title={`Place them all at once: finds the ${SK_LABEL[sk as 'col'].toLowerCase()} marks of the schedule written on this sheet and puts one of that type at each - shown first, kept when you say`}><TIcon k="auto" size={13} /> Place from their marks</button>
      <span className="faint tip">click = one · pick placed ones to give them their own size or steel (right panel)</span>
    </span>
  ) : tool === 'area' && sk === 'stair' && !readOnly ? (
    // v0.18 a stair: what the area being drawn is
    <span className="segmode modestrip" data-stairstrip>
      <span className="faint">Drawing</span>
      <button className={stairPart === 'f' ? 'on' : ''} data-stair="f" onClick={() => setStairPart('f')} title="A flight on the plan: its steps = its area ÷ (flight width × tread)">A flight</button>
      <button className={stairPart === 'l' ? 'on' : ''} data-stair="l" onClick={() => setStairPart('l')} title="A landing: its area × the landing thickness">A landing</button>
    </span>
  ) : tool === 'count' && !readOnly ? (
    <span className="segmode modestrip">
      <button onClick={() => setDialog({ k: 'auto' })} title="Find a tag written on this sheet (D01, SD-1…) and count every one, after a look"><TIcon k="auto" size={13} /> Count by tag <kbd>T</kbd></button>
      {/* v0.16.1 doors not on a wall (cores, partitions): counted into the door schedule */}
      <button data-doormode className={doorMode ? 'on' : ''} onClick={() => { if (!active?.dc) setDoorMode((x) => !x); }} title={active?.dc ? 'Measuring into “Doors (not on walls)”: every click is a door of the schedule' : 'Count doors that are not on a wall (cores, partitions): each click is a door of the schedule, counted in it'}>Door <kbd>D</kbd></button>
      {doorMode && <button data-doorchip className="doorchip" title="The door each click counts - click to choose another" onClick={(e) => chooseDoor('count', [e.clientX - 40, e.clientY - 300])}>{lastDoorTag ?? 'Which door?'} ▾</button>}
    </span>
  ) : tool === 'hole' && !readOnly ? (
            <span className="segmode modestrip" data-holemodes title="How the cut-out is drawn (select the area first)">
              <button className={holeMode === 'rect' ? 'on' : ''} onClick={() => pickMode('rect')} title="A box: two opposite corners"><TIcon k="rect" size={13} /> Rectangle <kbd>R</kbd></button>
              <button className={holeMode === 'circle' ? 'on' : ''} onClick={() => pickMode('circle')} title="Centre, then a point on it"><TIcon k="circle" size={13} /> Circle <kbd>O</kbd></button>
              <button className={holeMode === 'path' ? 'on' : ''} onClick={() => pickMode('path')} title="Any shape, node by node"><TIcon k="area" size={13} /> Polygon <kbd>P</kbd></button>
            </span>
  ) : MODE_TOOLS.includes(tool) && !readOnly ? (
            <>
            {/* v0.18.1 (Nabil, 11 Nov: "maybe the normal wall tool should give 3 options? block, core, or retaining?") */}
            {tool === 'wall' && (
              <span className="segmode modestrip walltype" data-walltype title="What the wall is: a take-off keeps its type">
                <button className={!sk ? 'on' : ''} data-wt="block" onClick={() => pickTool('wall', '')} title="Blockwork: length × height × the block width; lintels over doors and openings"><TIcon k="wall" size={13} /> Block</button>
                <button className={sk === 'shear' ? 'on' : ''} data-wt="shear" onClick={() => pickStruct('shear')} title="Concrete core wall: length × height × its type's thickness; formwork both faces; openings come off, no lintels"><TIcon k="shear" size={13} /> Core</button>
                <button className={sk === 'rw' ? 'on' : ''} data-wt="rw" onClick={() => pickStruct('rw')} title="Concrete retaining wall: as a core wall, from its own schedule; waterproofing on one face or both, and under it"><TIcon k="rw" size={13} /> Retaining</button>
              </span>
            )}
            <span className="segmode modestrip" title="How the shape is drawn. While drawing: A = next segments as arcs, L = straight">
              <button className={mode === 'path' ? 'on' : ''} onClick={() => pickMode('path')} title={tool === 'area' ? 'Node by node' : 'Node by node'}><TIcon k={tool === 'area' || tool === 'room' ? 'area' : 'path'} size={13} /> {tool === 'area' || tool === 'room' ? 'Polygon' : 'Polyline'} <kbd>P</kbd></button>
              <button className={mode === 'rect' ? 'on' : ''} onClick={() => pickMode('rect')} title={'Two opposite corners' + (tool === 'area' || tool === 'room' ? '' : ': its perimeter as a length')}><TIcon k="rect" size={13} /> Rectangle <kbd>R</kbd></button>
              {/* (walls and rooms: O is another opening there) */}
              <button className={mode === 'circle' ? 'on' : ''} onClick={() => pickMode('circle')} title={'Centre, then a point on it' + (tool === 'area' || tool === 'room' ? '' : ': its circumference as a length')}><TIcon k="circle" size={13} /> Circle{tool === 'wall' || tool === 'room' ? '' : <> <kbd>O</kbd></>}</button>
            </span>
            </>
  ) : null;

  const scaleLabel = pageInfo?.sc ? scaleText(pageInfo.sc, pageInfo.scl, pageInfo.scy, pageInfo.scyl) : null;
  const sheetPeople = (dwg: string, pg: number) => props.others.filter((o) => o.sheet === pageKey(dwg, pg));

  // ---------- render ----------
  // v0.16.2 (feedback 2) the drawing in its own window: its tool bar, sheet tabs, sheet bar and the drawing go there
  // (the same screen drawn in two windows); menus, dialogs and pickers go to the window in use
  // ---------- v0.16.4 the places a sheet is shown: the main window and each sheet tab's own window ----------
  // The sheet worked on (its tab is the current one) gets the full drawing, its sheet bar and messages, in
  // whichever window it is; every other place shows its own sheet live (zoom / pan), a click there makes it
  // the one worked on. The tool bar is in every window (one set of tools: the window worked in uses it).
  const curTabObj = curTab ? tabs.find((x) => x.id === curTab) ?? null : null;
  const mainT = mainTab ? tabs.find((x) => x.id === mainTab) ?? null : null;
  // v0.18.1 the tool bar's groups (Nabil, 11 Nov): what each tool is, its family colour, and what a click does
  const tool1 = (k: UiTool, cat?: string) => {
    const t = TOOLS.find((x) => x.k === k)!;
    return { id: k, label: t.label, icon: k, key: t.key, hint: t.hint, cat, on: tool === k && !structOn, disabled: readOnly && k !== 'select', run: () => pickTool(k) };
  };
  const wallOn = tool === 'wall' && !sk;
  /** Door / Opening from the bar: on a wall, a room's edge or a length - the Wall tool when no such tool is in use */
  const armOpening = (k: 'door' | 'open') => {
    if (readOnly) return toast('View only.');
    if (!(tool === 'wall' || tool === 'line' || tool === 'room' || (tool === 'select' && selItemList.some((x) => x.kind === 'wall')))) pickTool('wall', '');
    setPlaceArm({ k, token: Date.now() });
  };
  const tbGroups: TbGroup[] = [
    { id: 'general', label: TB_GROUP_LABEL.general, items: [tool1('select'), tool1('area', 'measure'), tool1('line', 'measure'), tool1('count', 'measure'),
      // (v0.18.1 found only in the Count tool's bar before)
      { id: 'tagcount', label: 'Count by tag', icon: 'auto', key: 'T', cat: 'measure', disabled: readOnly || !ready, hint: 'Find a tag written on this sheet (D01, SD-1…) and count every one, after a look', run: () => { pickTool('count'); setDialog({ k: 'auto' }); } },
      tool1('hole', 'note')] },
    { id: 'arch', label: TB_GROUP_LABEL.arch, items: [
      { ...tool1('wall', 'block'), label: 'Wall', text: 'Wall', hint: 'Blockwork: length × height × width (Core and Retaining walls: the bar under the drawing, or Structure). While drawing: D = a door, O = another opening', on: wallOn },
      tool1('room', 'finish'),
      { id: 'door', label: 'Door', icon: 'door', key: 'D', hint: 'Put a door from the schedule on a wall, a room’s edge or a length: click where it goes', cat: 'block', disabled: readOnly, run: () => armOpening('door') },
      { id: 'opening', label: 'Opening', icon: 'hole', key: 'O', hint: 'Put another opening (a window, a hole) on a wall or a room’s edge: click where it goes, then its size', cat: 'block', disabled: readOnly, run: () => armOpening('open') },
    ] },
    { id: 'struct', label: TB_GROUP_LABEL.struct, items: [
      ...STRUCT_TOOLS.map((t) => ({ id: t.k, label: t.label, icon: t.icon, key: t.key, hint: t.hint, cat: 'struct', on: structOn === t.k, disabled: readOnly, mattrs: { 'data-structpick': t.k }, run: () => pickStruct(t.k) })),
      // (v0.18.1 the schedules' marks written on the sheet: found only in a tool's bar or the schedule before)
      ...([['colmarks', 'Columns from marks', 'col'], ['swmarks', 'Shear walls from marks', 'sw'], ['ftgmarks', 'Footings from marks', 'ftg']] as const).map(([id, label, ck], i) => ({
        id, label, icon: 'auto', cat: 'struct', sec: i === 0 ? 'From the schedule marks on this sheet' : undefined, disabled: readOnly || !ready || !typesFor(model, ck).length,
        hint: `Finds the schedule’s marks (C1, C2…) written on this sheet and puts one of that type at each - shown first, kept when you say${typesFor(model, ck).length ? '' : ' (fill its schedule first)'}`,
        run: () => { pickStruct(ck); void colMarks(ck); } })),
      ...([['beammarks', 'Beams: type from marks', 'beam', model.beamTypes.length], ['wallmarks', 'Core walls: type from marks', 'wall', model.wallTypes.length], ['rwmarks', 'Retaining walls: type from marks', 'rwall', model.rwTypes.length]] as const).map(([id, label, cat, n]) => ({
        id, label, icon: 'auto', cat: 'struct', disabled: readOnly || !ready || !n,
        hint: 'The marks of the schedule written on this sheet give the segments drawn by them their type - shown first, kept when you say' + (n ? '' : ' (fill its schedule first)'),
        run: () => { void beamMarks(cat); } })),
    ] },
    { id: 'annot', label: TB_GROUP_LABEL.annot, items: [tool1('note', 'note'), tool1('measure', 'note'), tool1('scale', 'note'), tool1('region', 'note')] },
    { id: 'view', label: TB_GROUP_LABEL.view, items: [
      { id: 'snap', label: 'Snap', icon: 'snap', key: 'G', aux: true, on: snapOn, attrs: { 'data-aid': 'snap' }, text: snapOn ? (snapState === 'preparing' ? 'Snap…' : snapState === 'failed' ? 'No snap here' : 'Snap') : 'Snap off',
        hint: snapOn && snapState === 'failed' ? 'Snapping is not available on this sheet (its line work could not be read). Points go where you click.' : "Snap to the drawing's lines and nodes, and ⊥ onto them from the last node", run: () => setSnapOn((x) => !x) },
      { id: 'ortho', label: 'Ortho', icon: AID_ICON.ortho, key: 'F8', aux: true, on: aidsNow.ortho, attrs: { 'data-aid': 'ortho' }, text: aidsNow.ortho ? 'Ortho' : 'Ortho off', hint: 'Horizontal and vertical only, and ⊥ onto a line near the pointer. Hold Shift for the moment.', run: () => setAids({ ortho: !aidsNow.ortho }) },
      { id: 'cross', label: 'Crosshair', icon: AID_ICON.cross, aux: true, on: aidsNow.cross, attrs: { 'data-aid': 'cross' }, hint: 'Lines across the whole sheet through the pointer', run: () => setAids({ cross: !aidsNow.cross }) },
      { id: 'loupe', label: 'Magnifier', icon: AID_ICON.loupe, key: 'M', aux: true, on: aidsNow.loupe, attrs: { 'data-aid': 'loupe' }, text: aidsNow.loupe ? 'Magnifier ×' + aidsNow.zoom : 'Magnifier', hint: `A loupe next to the pointer, ×${aidsNow.zoom} — Alt+wheel for more / less`, run: () => setAids({ loupe: !aidsNow.loupe }) },
      { id: 'display', label: 'Display', icon: 'list', aux: true, on: fmtOpen, attrs: { 'data-numfmt': '' }, face: <NumFmtFace />, hint: 'Decimals and size of the measured numbers, thickness of the lines, area fill, labels, highlighting. This PC; quantities are always calculated in full.', run: () => setFmtOpen((x) => !x) },
    ] },
  ];
  const toolbarEl = (live: boolean) => (
        <HScroll className="qto-toolbar" wrapClass="qto-tbwrap">
          <button className="btn icon ghost" title="Show/hide drawings" onClick={() => setShowLeft((x) => !x)}><TIcon k="sidebar" /></button>
          <div className="divider" />
          {/* v0.18.1 the tools by discipline (General, Architecture, Structure, Annotate, View) - folding when short of room */}
          <ToolBarGroups groups={tbGroups} user={me.username} after={<div className="tplwrap">{fmtOpen && live && <NumFmtPop onClose={() => setFmtOpen(false)} />}</div>} />
          {active && (
            <button className="qto-active stop" title="Measuring into this take-off — click to stop" onClick={stopMeasuring} data-activechip>
              <span className="sq">■</span>
              <i style={{ background: active.color }} />
              {active.name}
            </button>
          )}
          <button className="btn icon ghost" title="Undo (Ctrl+Z)" disabled={!session.canUndo()} onClick={doUndo}><TIcon k="undo" /></button>
          <button className="btn icon ghost" title="Redo (Ctrl+Y)" disabled={!session.canRedo()} onClick={doRedo}><TIcon k="redo" /></button>
          {/* v0.17 the schedules (doors, beams, columns, shear walls) in one: a tab each - import / update / export Excel */}
          <button className="btn" data-scheds onClick={() => openSched(schedTab)} title={`Schedules: doors (${model.doors.length}), beams (${model.beamTypes.length}), columns (${model.colTypes.length}) and core walls (${model.wallTypes.length}) by mark with their sizes and steel - add them here, import / update / export them in Excel`}><TIcon k="list" /><span className="tb-label"> Schedules</span></button>
          <button className="btn" data-finalize onClick={() => setFinOpen(true)} title="Finishes Summary: the totals of every finish code (rooms and take-offs with a code), broken down as the BOQ needs and linked to its items"><TIcon k="summary" /><span className="tb-label"> Finalize</span></button>
          <button className="btn" onClick={doExport} title="Export to Excel: quantities by take-off, by sheet, by segment and tag, doors and openings, and against the BOQ"><TIcon k="excel" /><span className="tb-label"> Export</span></button>
          <KeysButton />
        </HScroll>
  );
  const liveSheetBar = () => (
    <>
        {curDrawing && (
          <div className="qto-sheetbar">
            <button className="btn icon ghost sm" disabled={!cur || sheetsInOrder.findIndex((s) => s.dwg === cur.dwg && s.pg === cur.pg) <= 0} onClick={() => stepSheet(-1)} title="Previous sheet (PgUp)">‹</button>
            <span className="sh-title" title={curDrawing.path}>
              {curDrawing.sheet && <span className="sh-no">{curDrawing.sheet}</span>}
              <b>{sheetTitle(curDrawing)}</b>
              {ready && !isPageSheet(curDrawing) && ready.pages.length > 1 && <span className="sh-pg">page {cur!.pg + 1} of {ready.pages.length}</span>}
            </span>
            <button className="btn icon ghost sm" onClick={() => stepSheet(1)} title="Next sheet (PgDn)">›</button>
            {cur && <InUseBy people={sheetPeople(cur.dwg, cur.pg)} />}
            <span className="grow" />
            {scaleLabel && sizeChanged ? (
              <ScaleChip warn readOnly={readOnly} label={<>{scaleLabel} — paper size changed, check</>} onSet={() => pickTool('scale')} onClear={askClearScale} title={`The scale ${scaleLabel} was set on a ${Math.round(pageInfo!.w! / 72 * 25.4)} × ${Math.round(pageInfo!.h! / 72 * 25.4)} mm page; this file's page is ${Math.round(page!.w / 72 * 25.4)} × ${Math.round(page!.h / 72 * 25.4)} mm. Measure the scale again, or check it.`} />
            ) : null}
            {scaleLabel && sizeChanged && !readOnly && page ? (
              <button className="linkbtn" title={`The drawing is at ${scaleLabel} on this paper size too (checked against a dimension): keep it`} onClick={() => commit([['pg:' + pk, 'w', Math.round(page.w)], ['pg:' + pk, 'h', Math.round(page.h)]], 'Scale ' + scaleLabel + ' checked')}>It's right</button>
            ) : null}
            {scaleLabel && sizeChanged ? null : scaleLabel ? (
              <ScaleChip warn={false} readOnly={readOnly} label={scaleLabel} onSet={() => pickTool('scale')} onClear={askClearScale} title="Scale of this sheet — click to measure it again (▾: clear it)" />
            ) : (
              <button className="scalechip warn" disabled={readOnly} onClick={() => setTool('scale')} title="Set the scale before measuring lengths or areas">
                <TIcon k="scale" /> No scale — set it
              </button>
            )}
            {!scaleLabel && detectedScales.length > 0 && !readOnly && (
              <span className="scalesug">
                Sheet says{' '}
                {detectedScales.slice(0, 3).map((n) => (
                  <button key={n} className="linkbtn" onClick={() => setPageScale(scaleFromRatio(n), '1:' + n, 'page')}>1:{n}</button>
                ))}
                <span className="faint">(true paper size)</span>
              </span>
            )}
            {pageRegions.length > 0 && <span className="faint">{pageRegions.length} viewport{pageRegions.length > 1 ? 's' : ''} with own scale</span>}
            <div className="tplwrap">
              <button className={'revchip' + (cmp ? ' on' : '') + (revisions.length ? '' : ' single')} onClick={() => revisions.length && setRevMenu((x) => !x)} title={revisions.length ? 'Revisions of this sheet — compare with an earlier one' : 'Only one revision so far'}>
                <TIcon k="layers" /> {curDrawing.rev || curDrawing.issue ? revLabel(curDrawing) : 'Current'}
                {revisions.length > 0 && <span className="pill">{revisions.length + 1}</span>}
                {cmp && <span className="cmpon">{cmp.mode === 'overlay' ? 'comparing' : 'earlier'}</span>}
              </button>
              {cmp && cmpLoaded && cmpLoaded.rv === cmp.rv && cmpLoaded.pages > 1 && !cmpLoaded.one && (
                <span className="cmppg" title="Page of the earlier revision">
                  <button className="btn icon ghost sm" disabled={cmpLoaded.pg <= 0} onClick={() => setCmp({ ...cmp, pg: cmpLoaded.pg - 1 })}>‹</button>
                  <span className="faint">its page {cmpLoaded.pg + 1}/{cmpLoaded.pages}</span>
                  <button className="btn icon ghost sm" disabled={cmpLoaded.pg >= cmpLoaded.pages - 1} onClick={() => setCmp({ ...cmp, pg: cmpLoaded.pg + 1 })}>›</button>
                </span>
              )}
              {revMenu && revisions.length > 0 && (
                <div className="revmenu" onMouseLeave={() => setRevMenu(false)}>
                  <div className="msec">This sheet</div>
                  <button className={'mi' + (!cmp ? ' on' : '')} onClick={() => { setCmp(null); setRevMenu(false); }}>
                    <span className="lb"><b>{revLabel(curDrawing)}</b><span className="d">current · {curDrawing.name}{isPageSheet(curDrawing) ? ' p.' + (curDrawing.fp! + 1) : ''}</span></span>
                  </button>
                  {revisions.map((r) => (
                    <div key={r.id} className="revrow">
                      <span className="lb"><b>{revLabel(r)}</b><span className="d">replaced {new Date(r.superseded || r.added).toLocaleDateString('en-GB')} · {r.name}{r.fp !== undefined ? ' p.' + (r.fp + 1) : ''}</span></span>
                      <button className={'btn sm' + (cmp?.rv === r.id && cmp.mode === 'overlay' ? ' on' : '')} onClick={() => { setCmp({ rv: r.id, mode: 'overlay' }); setRevMenu(false); }} title="Red = only in this one (removed), blue = only in the current one (added)">Compare</button>
                      <button className={'btn sm' + (cmp?.rv === r.id && cmp.mode === 'previous' ? ' on' : '')} onClick={() => { setCmp({ rv: r.id, mode: 'previous' }); setRevMenu(false); }}>View</button>
                      {!readOnly && <button className="btn sm ghost" title="Make this the current revision again" onClick={() => { commit(makeCurrentOps(curDrawing, r, me.username, Date.now(), model), 'Went back to ' + revLabel(r)); setRevMenu(false); }}>Make current</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button className={'btn sm ghost sqbtn' + (sqOpen ? ' on' : '')} data-sheetqty-btn title="A table of what was taken off this sheet only — each take-off, its shapes and segments" onClick={() => setSqOpen((x) => !x)}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden><rect x="2" y="2.5" width="12" height="11" rx="1.2" /><path d="M2 6.2h12M2 9.8h12M6.5 2.5v11" /></svg>
              <span>Quantities on this sheet</span>
            </button>
            {mayEditOthers && <EditOthersChip onOff={() => setEditOthers(false)} />}
            <PeopleButton
              qs={isQs}
              me={me.username}
              nameOf={nameOf}
              people={peopleList}
              showOthers={showOthers}
              onShowOthers={setShowOthers}
              pick={pickPeople}
              onPick={setPickPeople}
              editOthers={mayEditOthers}
              onEditOthers={isQs || readOnly ? null : setEditOthers}
              hiddenHere={ownerHidden.size}
            />
            <button className="btn icon ghost sm" title="Fit the sheet (Home)" onClick={() => setFitToken((x) => ({ n: (x?.n ?? 0) + 1, pk }))}><TIcon k="fit" /></button>
            <button className={'btn icon ghost sm' + (rotOf(pk) ? ' on' : '')} data-rotate={rotOf(pk)} title={'Turn this sheet a quarter turn clockwise' + (rotOf(pk) ? ' (now turned ' + rotOf(pk) * 90 + '°)' : '') + ' — only how it is shown on this PC: nothing measured changes'} onClick={() => turnSheet(pk)}><TIcon k="rotate" /></button>
            <span className="tplwrap">
              <button className={'btn icon ghost sm' + (imgsHere.length ? ' on' : '')} data-images title={'Images on this sheet' + (imgsHere.length ? ' (' + imgsHere.length + ')' : '') + ': add a sketch, a photo or a detail as a picture over the sheet — yours only until you share it; the PDF is never changed'} onClick={() => setImgMenu((x) => !x)}><TIcon k="image" /></button>
              {imgMenu && cur && <ImagesMenu model={model} cur={cur} me={me.username} readOnly={readOnly} onAdd={() => { void addImage(); }} onHover={setImgHi} onClose={() => { setImgMenu(false); setImgHi(null); }}
                onPlace={(im, k) => { setImgMenu(false); keepShape(); const b = imgBmps.get(im.file); const ar = b ? b.width / Math.max(1, b.height) : (im.box.x1 - im.box.x0) / Math.max(1e-6, im.box.y1 - im.box.y0); setImgPlace({ k, id: im.id, file: im.file, name: im.name, ar }); }}
                onShare={(im, on) => commit([[im.id, 'pub', on ? true : null]], on ? 'Image shared' : 'Image private')}
                onRemove={(im) => commit([[im.id, 'del', true]], 'Removed image')} />}
            </span>
            {/* v0.18.1 (Feedback 3, D Phase 1) this sheet beside itself (or another: pick it in the list while the side is in use) */}
            <button className={'btn icon ghost sm' + (sideT ? ' on' : '')} data-sidebtn title={sideT ? 'Close the side-by-side pane' : 'Side by side: this sheet again in a pane beside it, with its own zoom (pick another sheet in the list while that pane is in use)'} onClick={() => {
              if (sideT) { sideTab(sideT.id, false); return; }
              if (!cur) return;
              const r = openTab(tabsRef.current, tabUsed.current, { dwg: cur.dwg, pg: cur.pg }, newTabId, true);
              applyTabs({ tabs: r.tabs.map((t) => (t.id === r.cur ? { ...t, sd: true } : t)), used: r.used, cur: r.cur });
            }}>◧</button>
            <span className="tplwrap">
              <button className={'btn icon ghost sm' + (ovr ? ' on' : '')} data-overlay title="Show another sheet over this one (a ceiling plan over the floor plan, an elevation…): put in place by two matching points, then draw over it" onClick={() => setOvrPick((x) => !x)}><TIcon k="overlay" /></button>
              {ovrPick && cur && <OverlayPicker model={model} cur={cur} aligned={(d, g) => !!alignOf(pk + '|' + pageKey(d, g))} on={ovr && ovr.on === pk ? { dwg: ovr.dwg, pg: ovr.pg } : null} onPick={startOverlay} onOff={() => { setOvr(null); setAlign(null); setOvrPick(false); }} onClose={() => setOvrPick(false)} />}
            </span>
          </div>
        )}
    </>
  );
  const liveBanners = () => (
    <>
        {ovrCrop && (
          <div className="qto-banner over aligning" data-ovrcropbar>
            <TIcon k="overlay" /> <span className="bt"><b>A part of the overlaid sheet</b> — draw a rectangle around the part to keep (two clicks: corner to corner). <span className="faint">Esc: not now</span></span>
            <button className="btn sm" onClick={() => setOvrCrop(false)}>Cancel</button>
          </div>
        )}
        {imgPlace && (
          <div className="qto-banner over aligning" data-imgplacebar>
            <TIcon k="image" /> <span className="bt"><b>{imgPlace.name}</b> — draw a rectangle on the sheet where it goes (two clicks: corner to corner). It keeps its proportions. <span className="faint">Esc: not now</span></span>
            <button className="btn sm" onClick={() => setImgPlace(null)}>Cancel</button>
          </div>
        )}
        {/* v0.18 another sheet over this one: what it is, how faint, in place or not */}
        {ovr && ovr.on === pk && (
          <div className={'qto-banner over' + (align ? ' aligning' : '')} data-overbar>
            <TIcon k="overlay" />
            {align ? (
              <>
                <span className="bt" data-alignstep={align.pts.length}><b>{align.check ? 'Checking the fit' : 'Putting it in place'}</b> — {(align.check ? CHECK_TEXT : ALIGN_TEXT)[align.pts.length] ?? ''} <span className="faint">(Backspace: the last point again · Esc: stop)</span></span>
                <button className="btn sm" onClick={() => setAlign(null)}>Stop</button>
              </>
            ) : (
              <>
                <span className="bt"><b style={{ color: ovrI?.tn || '#e8590c' }}>{sheetLabel(model, ovr.dwg, ovr.pg)}</b> over this sheet{alignOf(ovrPair) ? (ovrI?.cr ? ' · a part of it' : '') : ' — not put in place yet'}{!ovrLoaded ? ' · opening…' : ''}{ovrI?.lk ? ' · locked' : ''}</span>
                <label className="ovr-alpha" title="How strong the overlaid sheet shows"><input type="range" min={10} max={100} step={5} value={Math.round(ovr.alpha * 100)} data-overalpha onChange={(e) => setOvr({ ...ovr, alpha: Number(e.target.value) / 100 })} /></label>
                <span className="ovr-tints" title="Its colour">
                  {OVR_TINTS.map((c) => <button key={c} className={'tint' + ((ovrI?.tn || '#e8590c') === c ? ' on' : '')} data-overtint={c} style={{ background: c }} disabled={!alignOf(ovrPair)} onClick={() => putAlign(ovrPair, { tn: c === '#e8590c' ? '' : c }, 'Overlay colour')} />)}
                </span>
                <button className={'btn sm' + (ovr.show ? '' : ' on')} data-overshow onClick={() => setOvr({ ...ovr, show: !ovr.show })}>{ovr.show ? 'Hide' : 'Show'}</button>
                {alignOf(ovrPair) && <button className="btn sm" data-overcheck disabled={!!ovrI?.lk} onClick={() => { keepShape(); setOvr({ ...ovr, show: true }); setAlign({ pts: [], check: true }); }} title="Click a third point on this sheet and the same one on the overlaid sheet: how far off it is, in mm">Check fit</button>}
                <button className="btn sm" data-overalign disabled={!!ovrI?.lk} onClick={() => { keepShape(); setOvr({ ...ovr, show: true }); setAlign({ pts: [] }); }} title="Click a point on this sheet and the same point on the overlaid sheet, twice">{alignOf(ovrPair) ? 'Align again' : 'Put in place'}</button>
                {alignOf(ovrPair) && (ovrI?.cr
                  ? <button className="btn sm" data-overcrop disabled={!!ovrI?.lk} onClick={() => putAlign(ovrPair, { cr: null }, 'Overlay: all of it')} title="Show all of the overlaid sheet again">Show all</button>
                  : <button className={'btn sm' + (ovrCrop ? ' on' : '')} data-overcrop disabled={!!ovrI?.lk || readOnly} onClick={() => { keepShape(); setOvrCrop((x) => !x); }} title="Only a part of it (the ceiling layout beside the plan): draw a rectangle around that part, where it shows now">Crop</button>)}
                {alignOf(ovrPair) && !readOnly && <button className={'btn sm' + (ovrI?.lk ? ' on' : '')} data-overlock onClick={() => putAlign(ovrPair, { lk: !ovrI?.lk }, ovrI?.lk ? 'Overlay unlocked' : 'Overlay locked')} title={ovrI?.lk ? 'Locked: its place can\'t be changed by mistake - click to unlock' : 'Lock its place (for the team): Align again / a part only are off'}>{ovrI?.lk ? '🔒 Locked' : 'Lock'}</button>}
                <button className="btn sm" data-overoff onClick={() => { setOvr(null); setAlign(null); setOvrCrop(false); }}>Remove</button>
              </>
            )}
          </div>
        )}
        {staleHere > 0 && curDrawing && !ready?.changed && (
          <div className="qto-banner check">
            <TIcon k="warn" /> <span className="bt"><b>{staleHere} shape{staleHere > 1 ? 's were' : ' was'} measured on an earlier revision</b> of this sheet (dashed). Compare, adjust what changed, then mark them checked.</span>
            {revisions[0] && <button className="btn sm" onClick={() => setCmp({ rv: revisions[0].id, mode: 'overlay' })}>Compare with {revLabel(revisions[0])}</button>}
            {!readOnly && <button className="btn sm" onClick={() => markChecked()}>Mark all checked</button>}
          </div>
        )}
        {cur && (model.offPage.get(cur.dwg) ?? 0) > 0 && (
          <div className="qto-banner warn">
            <TIcon k="warn" /> <span className="bt"><b>{model.offPage.get(cur.dwg)} shape{model.offPage.get(cur.dwg)! > 1 ? 's are' : ' is'} on pages this drawing no longer has</b> (its new revision has {curDrawing?.pages} page{curDrawing?.pages === 1 ? '' : 's'}). They are not counted until they are moved onto one of its pages — then they show dashed, to check, and Compare shows the page they were measured on.</span>
            {revisions[0] && <button className="btn sm" onClick={() => setCmp({ rv: revisions[0].id, mode: 'previous', pg: model.offPageShapes.get(cur.dwg)?.[0]?.pg })}>See them on {revLabel(revisions[0])}</button>}
            {!readOnly && <button className="btn sm" onClick={() => {
              const list = model.offPageShapes.get(cur.dwg) ?? [];
              commit(moveOffPageOps(list, cur.pg), 'Moved to page ' + (cur.pg + 1) + ' to check');
              setCmp(null);
              toast(`${list.length} shape${list.length === 1 ? '' : 's'} moved to page ${cur.pg + 1}, to check: compare, adjust, then mark them checked.`);
            }}>Move them to this page</button>}
          </div>
        )}
        {ready?.bad && curDrawing && (
          <div className="qto-banner warn">
            <TIcon k="warn" /> <span className="bt"><b>The file at {curDrawing.path} can't be opened now</b> ({ready.bad.replace(/\.$/, '')}). You see this PC's copy of the version that was measured; other PCs may not have one. Ask for the drawing again, or point to a good copy.</span>
            {!readOnly && <button className="btn sm" onClick={relocate}>Find the file…</button>}
          </div>
        )}
        {ready?.gone && curDrawing && !ready.changed && (
          <div className="qto-banner warn">
            <TIcon k="warn" /> <span className="bt"><b>This file is no longer at {curDrawing.path}</b> (deleted, moved or renamed on the server). You see this PC's copy of it; other PCs may not have one.</span>
            {!readOnly && <button className="btn sm" onClick={relocate}>Find the file…</button>}
          </div>
        )}
        {ready?.changed && curDrawing && (
          <div className="qto-banner warn">
            <b>This drawing has changed</b> since it was measured — the file on the server is not the same as when the take-offs were made (a new revision?).
            <span className="grow" />
            {!readOnly && <button className="btn sm" onClick={acceptRevision}>Use the new version</button>}
          </div>
        )}
    </>
  );
  const liveCanvas = () => (!page || !ready || !cur ? null : (
            <SheetCanvas
              key="sc"
              engine={engine}
              dkey={ready.key}
              pg={fpg}
              page={page}
              preview={prev && prev.key === ready.key && prev.pg === fpg ? prev.bmp : null}
              previewScale={prev?.scale ?? 1}
              compare={compareSpec}
              over={overSpec}
              images={canvasImages}
              onImageBox={(id, box) => { const r = (v: number) => Math.round(v * 100) / 100; commit([[id, 'x0', r(box.x0)], [id, 'y0', r(box.y0)], [id, 'x1', r(box.x1)], [id, 'y1', r(box.y1)]], 'Image moved / resized'); }}
              onImageDel={(id) => { commit([[id, 'del', true]], 'Removed image'); toast('Image removed — Ctrl+Z brings it back.'); }}
              stale={model.stale}
              resume={resume}
              shapes={offView ? offView : shownShapes}
              viewOnly={offView ? undefined : viewOnly}
              viewOnlyWhy={lockedWhy}
              items={model.itemById}
              regions={pageRegions}
              notes={pageNotes}
              selected={selected}
              active={active}
              tool={align ? 'count' : imgPlace || ovrCrop ? 'rect' : readOnly ? (tool === 'measure' ? 'measure' : 'select') : cmp?.mode === 'previous' && tool !== 'measure' ? 'select' : canvasToolOf(tool, mode, holeMode)}
              snapOn={snapOn}
              readOnly={(readOnly && !align) || !!offView}
              others={cursors}
              scaleAt={(p) => { const h = scaleAt(model, cur.dwg, cur.pg, p); return h.sc ? { x: h.sc, y: h.scy ?? h.sc } : null; }}
              labelFor={labelFor}
              measure={measurePath}
              fitToken={fitToken && fitToken.pk === pk ? fitToken.n : 0}
              rot={rotOf(pk)}
              focus={focus && focus.pk === pk ? focus : null}
              closedAs={imgPlace || ovrCrop ? 'area' : tool === 'hole' ? 'hole' : tool === 'area' || tool === 'room' ? 'area' : 'line'}
              onShape={onDrawing(onShape)}
              plainLen={tool === 'line'}
              wallMode={!readOnly && !offView && (tool === 'wall' || tool === 'line' || (tool === 'select' && (active?.kind === 'wall' || selItemList.some((x) => x.kind === 'wall'))))}
              doorChip={lastDoorTag && !readOnly ? { tag: lastDoorTag, onChange: (c) => chooseDoor('wall', c) } : null}
              onOpening={onOpening}
              onOpeningMove={readOnly || offView ? undefined : (oid, p) => { commit([[oid, 'x', Math.round(p[0] * 100) / 100], [oid, 'y', Math.round(p[1] * 100) / 100]], 'Moved door / opening'); }}
              roomDoor={!readOnly && !offView && (tool === 'room' || (step?.k === 'door' || step?.k === 'open') || (tool === 'select' && (active?.kind === 'room' || selItemList.some((x) => x.kind === 'room'))))}
              armPlace={placeArm}
              onOpenEdges={() => {
                // (after the outline being drawn is kept and the model has it: the room drawn into, else the one selected)
                const id0 = active?.kind === 'room' ? active.id : selItemList.find((x) => x.kind === 'room')?.id;
                setTimeout(() => {
                  const m = modelRef.current;
                  const id = id0 ?? [...selectedRef.current].map((x) => m.shapes.find((s) => s.id === x)).find((s) => s && isRoomOutline(m, s))?.ti;
                  if (!id) return toast('Draw the room’s outline first, then pick its open edges.');
                  startStepRef.current({ k: 'edge', room: id });
                }, 0);
              }}
              onPlacing={setPlacingK}
              colOf={colOf}
              edgeSel={offView ? null : edgeSel}
              onEdgeSel={setEdgeSel}
              onEdgeDel={edgeDel}
              edgePick={offView ? null : stepEdges}
              onEdgePick={onDrawing((shape: string, seg: number) => { if (stepEdges) { if (stepEdges.flag === 'line') pickLine(shape, seg); else toggleEdge(shape, seg, stepEdges.flag); } })}
              rail={offView ? null : rail}
              stepBar={step ? { text: stepText(step), onDone: () => endStep({ restore: true }), onCancel: () => endStep({ restore: true, cancel: true }) } : null}
              openings={offView ? [] : pageOpenings}
              segHi={segHi}
              segTag={segTag}
              hiItems={hiItems}
              modeStrip={modeStrip}
              proposals={auto && cur && auto.dwg === cur.dwg && auto.pg === cur.pg ? auto.list.map((x) => ({ p: x.f.p, on: x.on, label: x.f.text + (x.dup ? ` · counted already in “${x.in}”` : '') }))
                : beamAuto && cur && beamAuto.dwg === cur.dwg && beamAuto.pg === cur.pg ? beamAuto.list.map((x) => {
                  const s = model.shapes.find((y) => y.id === x.shape);
                  const tl = beamAuto.cat === 'wall' ? model.wallTypes : beamAuto.cat === 'rwall' ? model.rwTypes : model.beamTypes;
                  const t = tl.find((y) => y.id === x.bt);
                  const was = x.cur ? tl.find((y) => y.id === x.cur)?.name : '';
                  return { p: x.p, on: x.on, to: x.at, seg: s ? [s.pts[x.seg], s.pts[(x.seg + 1) % s.pts.length]] as [Pt, Pt] : undefined, color: t?.color,
                    label: x.text + ' → ' + ((s ? model.itemById.get(s.ti)?.name : '') || (beamAuto.cat === 'wall' ? 'core wall' : 'beam')) + ' segment ' + (x.seg + 1) + (x.same ? ' · tagged ' + x.text + ' already' : was ? ' (was ' + was + ')' : '') };
                }) : colAuto && cur && colAuto.dwg === cur.dwg && colAuto.pg === cur.pg ? colAuto.list.map((x) => ({ p: x.p, on: x.on, label: x.text + (x.dup ? ' · a column is counted there already' : ' → a column ' + x.text) }))
                : null}
              onProposal={(i) => (colAuto && !auto && !beamAuto ? setColAuto((a) => (a ? { ...a, list: a.list.map((x, j) => (j === i ? { ...x, on: !x.on } : x)) } : a)) : beamAuto && !auto ? setBeamAuto((a) => (a ? { ...a, list: a.list.map((x, j) => (j === i && !x.same ? { ...x, on: !x.on } : x)) } : a)) : setAuto((a) => (a ? { ...a, list: a.list.map((x, j) => (j === i ? { ...x, on: !x.on } : x)) } : a)))}
              onReplace={onDrawing(onReplace)}
              onBulge={onBulge}
              onVertexInsert={onVertexInsert}
              onVertexDelete={onVertexDelete}
              onUndo={doUndo}
              onUndoCount={() => {
                const id = countRun.current.pop();
                if (id && modelRef.current.shapes.some((x) => x.id === id)) commit([[id, 'del', true]], 'Removed count');
              }}
              onHole={onDrawing(onHole)}
              onSelect={(ids, add) => {
                // (a click on a shape selects it and its row - it does not make it the take-off measured into)
                const n = add ? new Set(selectedRef.current) : new Set<string>();
                for (const id of ids) add && n.has(id) ? n.delete(id) : n.add(id);
                setSelected(n);
                if (!n.size) setSelRows(new Set());
                setSegHi(null);
              }}
              onMove={onMove}
              onVertex={onVertex}
              onCalibrate={(a, b) => { setDialog({ k: 'scale', a, b, next: scaleNext.current, nextScope: scaleNext.current && scaleTargets.current?.at === pk ? scaleTargets.current.scope : undefined }); scaleNext.current = null; }}
              onRegion={(box) => setDialog({ k: 'region', box })}
              onNote={(p) => setDialog({ k: 'note', on: activeId ?? '', at: p })}
              onNoteOpen={() => setRight('notes')}
              onCursor={(p) => session.setFocus({ cx: p ? Math.round(p[0]) : null, cy: p ? Math.round(p[1]) : null })}
              onContext={(shape, x, y, p, vertex, seg, opening) => {
                if (opening) { setMenu({ x, y, shape: null, p, vertex: null, seg: null, opening }); return; }
                if (shape && !selected.has(shape)) { setSelected(new Set([shape])); setSegHi(null); }
                setMenu({ x, y, shape, p, vertex, seg });
              }}
              onDelete={deleteSelected}
              onToolDone={escToolDone}
              onSnapState={setSnapState}
              bandWidth={(s, i) => bandWidthOf(model, model.itemById.get(s.ti), s, i)}
              drawBand={tool === 'wall' && active?.kind === 'wall' ? (active.sk === 'shear' ? (active.bt ? model.wallTypeById.get(active.bt)?.w ?? null : null) : active.sk === 'rw' ? (active.bt ? model.rwTypeById.get(active.bt)?.w ?? null : null) : active.d) : tool === 'beam' && active?.kind === 'beam' ? (active.bt ? model.beamTypeById.get(active.bt)?.w ?? null : null) : null}
              api={sheetApi}
            />
  ));
  const stageEl = (t: SheetTab | null, live: boolean, own: Own | null, ost: OwnState) => (
        <div className="qto-stage">
          {live && auto && cur && auto.dwg === cur.dwg && auto.pg === cur.pg && (
            <div className="acbar" data-autocount>
              <TIcon k="auto" />
              <span><b>{auto.list.filter((x) => x.on).length}</b> of {auto.list.length} × “{auto.q}”{auto.list.some((x) => x.dup) ? ` (${auto.list.filter((x) => x.dup).length} counted already: left out)` : ''}</span>
              <span className="msg">click a mark to leave it out / take it back</span>
              <button className="btn sm ghost" onClick={() => setAuto((a) => a && { ...a, list: a.list.map((x) => ({ ...x, on: !a.list.every((y) => y.on) && !x.dup ? true : false })) })}>{auto.list.every((x) => x.on) ? 'Leave all out' : 'Take all'}</button>
              <button className="btn sm" onClick={() => setAuto(null)}>Cancel <kbd>Esc</kbd></button>
              <button className="btn sm primary" disabled={!auto.list.some((x) => x.on)} onClick={keepAuto}>Count {auto.list.filter((x) => x.on).length}</button>
            </div>
          )}
          {live && beamAuto && !auto && cur && beamAuto.dwg === cur.dwg && beamAuto.pg === cur.pg && (
            <div className="acbar" data-beamauto>
              <TIcon k="auto" />
              <span><b>{beamAuto.list.filter((x) => x.on).length}</b> {beamAuto.cat === 'wall' ? 'core wall' : beamAuto.cat === 'rwall' ? 'retaining wall' : 'beam'} segment{beamAuto.list.filter((x) => x.on).length === 1 ? '' : 's'} to tag from their marks{beamAuto.list.some((x) => x.same) ? ` (${beamAuto.list.filter((x) => x.same).length} tagged already)` : ''}</span>
              <span className="msg">click a mark to leave it out / take it back</span>
              <button className="btn sm" onClick={() => setBeamAuto(null)}>Cancel <kbd>Esc</kbd></button>
              <button className="btn sm primary" data-beamkeep disabled={!beamAuto.list.some((x) => x.on)} onClick={keepBeamMarks}>Tag {beamAuto.list.filter((x) => x.on).length}</button>
            </div>
          )}
          {live && colAuto && !auto && !beamAuto && cur && colAuto.dwg === cur.dwg && colAuto.pg === cur.pg && (
            <div className="acbar" data-colauto>
              <TIcon k="auto" />
              <span><b>{colAuto.list.filter((x) => x.on).length}</b> of {colAuto.list.length} column marks to place{colAuto.list.some((x) => x.dup) ? ` (${colAuto.list.filter((x) => x.dup).length} counted already: left out)` : ''}</span>
              <span className="msg">click a mark to leave it out / take it back</span>
              <button className="btn sm" onClick={() => setColAuto(null)}>Cancel <kbd>Esc</kbd></button>
              <button className="btn sm primary" data-colkeep disabled={!colAuto.list.some((x) => x.on)} onClick={keepColMarks}>Place {colAuto.list.filter((x) => x.on).length}</button>
            </div>
          )}
          {!live ? passiveStage(t, own, ost) : model.drawings.length > 0 && !cur ? (
            <div className="qto-empty">
              <h3>Pick a sheet</h3>
              <p>Choose a drawing on the left. Sheets that have been opened (or prepared in the background) open at once.</p>
            </div>
          ) : !model.drawings.length ? (
            <div className="qto-empty">
              <h3>No drawings yet</h3>
              <p>Add the PDFs from wherever you keep received documents. They are <b>not copied or changed</b> — the take-off is saved separately and linked to each file.</p>
              {!readOnly && (
                <div className="row2">
                  <button className="btn primary" onClick={addFolder}><TIcon k="folder" /> Add a folder of drawings</button>
                  <button className="btn" onClick={addFiles}><TIcon k="file" /> Add files</button>
                </div>
              )}
            </div>
          ) : load.state === 'missing' ? (
            <div className="qto-empty">
              <h3>Drawing not found</h3>
              <p>
                <code>{curDrawing?.path}</code> isn't there any more (moved, renamed, or the drive isn't connected on this PC). The take-offs on it are safe.
              </p>
              {!readOnly && <button className="btn primary" onClick={relocate}>Find the file…</button>}
            </div>
          ) : engineError || load.state === 'error' ? (
            <div className="qto-empty"><h3>Could not open the drawing</h3><p>{engineError ?? (load.state === 'error' ? load.text : '')}</p>
              {!engineError && load.state === 'error' && load.heavyPg !== undefined && (
                <>
                  <p className="faint">Sheets whose line work is millions of separate little pieces (traced scans, some CAD exports) can be simplified: drawn the same, far lighter. The drawing itself is not changed — the simplified copy is kept on this PC.</p>
                  <button className="btn primary" disabled={simplifying} onClick={() => simplifySheet(load.heavyPg!)}>{simplifying ? 'Simplifying the line work…' : 'Simplify the line work and try again'}</button>
                </>
              )}
            </div>
          ) : page && ready && cur ? liveCanvas() : own && t ? passiveCanvas(t, own, false) : (
            <div className="qto-empty"><span className="dot busy" /> {load.state === 'loading' ? load.text : 'Starting the PDF engine…'}</div>
          )}
        </div>
  );
  /** a sheet shown in a place not worked in: what is drawn on it, as on the sheet worked on (hidden take-offs and
   *  people not shown left out; rooms' outlines under the rest) */
  const shownOn = (t: SheetTab): Shape[] => {
    const all = model.shapesByPage.get(pageKey(t.dwg, t.pg)) ?? [];
    const l = hiddenItems.size || people ? all.filter((x) => !hiddenItems.has(x.ti) && shownFor(model, x, people)) : all;
    const room = (x: Shape) => isRoomOutline(model, x);
    return l.some(room) ? [...l.filter(room), ...l.filter((x) => !room(x))] : l;
  };
  const none = () => {};
  const passiveCanvas = (t: SheetTab, own: Own, act: boolean) => {
    const shapes = shownOn(t);
    return (
      <SheetCanvas
        key="sc"
        passive
        rot={t.dwg ? rotOf(pageKey(t.dwg, t.pg)) : 0}
        onActivate={act ? () => activateTab(t.id) : none}
        engine={engine}
        dkey={own.key}
        pg={own.fpg}
        page={own.page}
        preview={own.prev}
        previewScale={own.prevScale}
        compare={null}
        stale={model.stale}
        resume={null}
        shapes={shapes}
        items={model.itemById}
        regions={model.regions.filter((r) => r.dwg === t.dwg && r.pg === t.pg)}
        notes={model.notes.filter((n) => n.dwg === t.dwg && n.pg === t.pg && n.x !== null)}
        selected={selected}
        active={null}
        tool="select"
        snapOn={false}
        readOnly
        others={[]}
        scaleAt={(p) => { const h = scaleAt(model, t.dwg, t.pg, p); return h.sc ? { x: h.sc, y: h.scy ?? h.sc } : null; }}
        labelFor={labelFor}
        measure={() => null}
        fitToken={0}
        focus={focus && focus.pk === pageKey(t.dwg, t.pg) ? focus : null}
        closedAs="line"
        onShape={() => null}
        openings={openingsOn(shapes, t, new Set())}
        hiItems={hiItems}
        segTag={segTag}
        onReplace={none}
        onBulge={none}
        onHole={none}
        onSelect={none}
        onMove={none}
        onVertex={none}
        onVertexInsert={none}
        onVertexDelete={none}
        onCalibrate={none}
        onRegion={none}
        onNote={none}
        onNoteOpen={none}
        onCursor={none}
        onContext={none}
        onUndo={none}
        onUndoCount={none}
        onDelete={none}
        onToolDone={none}
        onSnapState={none}
        bandWidth={(s, i) => bandWidthOf(model, model.itemById.get(s.ti), s, i)}
      />
    );
  };
  /** the sheet bar of a place not worked in: which sheet, its scale, and how to work on it */
  const passiveBar = (t: SheetTab) => {
    const d = model.dwgById.get(t.dwg);
    if (!d) return null;
    const pi = model.pages.get(pageKey(t.dwg, t.pg));
    const sl = pi?.sc ? scaleText(pi.sc, pi.scl, pi.scy, pi.scyl) : null;
    return (
      <div className="qto-sheetbar passive" data-passivebar>
        <span className="sh-title" title={d.path}>
          {d.sheet && <span className="sh-no">{d.sheet}</span>}
          <b>{sheetTitle(d)}</b>
          {isOldBinder(d) && <span className="sh-pg">page {t.pg + 1}</span>}
        </span>
        <span className="grow" />
        <span className="faint">{sl ? 'Scale ' + sl + ' · ' : 'No scale · '}click the drawing to work on this sheet</span>
      </div>
    );
  };
  const passiveStage = (t: SheetTab | null, own: Own | null, ost: OwnState) => (
    !t ? (
      floatTabs.length ? (
        <div className="qto-empty" data-allaway>
          <h3>Every open sheet is in its own window</h3>
          <p>Pick a sheet on the left to open it here, or drag a sheet window's tab back onto the tabs above.</p>
        </div>
      ) : model.drawings.length ? (
        <div className="qto-empty">
          <h3>Pick a sheet</h3>
          <p>Choose a drawing on the left. Sheets that have been opened (or prepared in the background) open at once.</p>
        </div>
      ) : (
        <div className="qto-empty">
          <h3>No drawings yet</h3>
          <p>Add the PDFs from wherever you keep received documents. They are <b>not copied or changed</b> — the take-off is saved separately and linked to each file.</p>
          {!readOnly && (
            <div className="row2">
              <button className="btn primary" onClick={addFolder}><TIcon k="folder" /> Add a folder of drawings</button>
              <button className="btn" onClick={addFiles}><TIcon k="file" /> Add files</button>
            </div>
          )}
        </div>
      )
    ) : own ? passiveCanvas(t, own, true)
      : ost === 'missing' ? <div className="qto-empty"><h3>Drawing not found</h3><p><code>{model.dwgById.get(t.dwg)?.path}</code> isn't there any more. Click here to work on this sheet and find it.</p></div>
      : ost === 'error' ? <div className="qto-empty"><h3>Could not open the drawing</h3><p>Click here to work on this sheet and try again.</p></div>
      : <div className="qto-empty"><span className="dot busy" /> Opening {tabLabel(model, t).label}…</div>
  );
  /** a place: the main window (its tab strip and the sheet of its tab) or a sheet tab's own window */
  const centreEl = (where: 'main' | SheetTab, own: Own | null, ost: OwnState) => {
    const t = where === 'main' ? mainT : where;
    const live = !!t && !!curTabObj && t.id === curTabObj.id;
    return (
      <div
        className={'qto-center' + (live ? ' live' : ' passive')}
        data-place={where === 'main' ? 'main' : where.id}
        onPointerDownCapture={(e) => { if (!live && t && !(e.target as HTMLElement).closest?.('.qto-tabs')) activateTab(t.id); }}
      >
        {(where === 'main' || !where.sd || !mainT) && toolbarEl(live || (where === 'main' && !!sideT && sideT.id === curTab))}
        {where !== 'main' && where.sd ? (
          <div className="qto-sidebar-h" data-sidehead>
            <span className="qtab-win">◧</span>
            <b>{tabLabel(model, where).label}</b>
            <span className="faint">{live ? 'worked on' : 'click the drawing to work on it'}</span>
            <span className="grow" />
            <button className="btn sm ghost" data-sideswap title="Change places with the main pane" onClick={(e) => { e.stopPropagation(); if (mainT) { const tl = tabsRef.current.map((x) => (x.id === where.id ? { ...x, sd: undefined } : x.id === mainT.id ? { ...x, sd: true } : x)); applyTabs({ tabs: tl, used: tabUsed.current, cur: curTabRef.current }); } }}>⇄</button>
            <button className="btn sm ghost" data-sideclose title="Close the side pane (its tab stays in the strip)" onClick={(e) => { e.stopPropagation(); sideTab(where.id, false); }}>×</button>
          </div>
        ) : where === 'main' ? (
          <SheetTabs
            model={model}
            tabs={tabs}
            cur={mainTab}
            onPick={pickTab}
            onClose={closeTabId}
            onAdd={() => { applyTabs(emptyTab(tabsRef.current, tabUsed.current, newTabId)); setShowLeft(true); setTimeout(() => { dwgSearch.current?.focus(); dwgSearch.current?.select(); }, 0); }}
            onMove={(id, to, after) => applyTabs({ tabs: moveTab(tabsRef.current, id, to, after), used: tabUsed.current, cur: curTabRef.current })}
            onCloseOthers={(id) => applyTabs(closeOthers(tabsRef.current, tabUsed.current, id))}
            onDuplicate={(id) => { const t = tabsRef.current.find((x) => x.id === id); if (t && t.dwg) openSheet(t.dwg, t.pg, { dup: true }); }}
            onUndock={undockTab}
            onShowFloat={showFloat}
            dropHere={dropHere}
            onSide={sideTab}
          />
        ) : (
          <FloatTab model={model} t={where} on={live} onDock={dockTab} strip={mainStrip} onOver={setDropHere} />
        )}
        {live ? liveSheetBar() : t ? passiveBar(t) : null}
        {live && liveBanners()}
        {stageEl(t, live, own, ost)}
      </div>
    );
  };
  const placeLoc = (t: SheetTab | null, live: boolean, key: string, body: (own: Own | null, ost: OwnState) => ReactNode) => (
    <SheetLoc
      key={key}
      place={key}
      engine={engine}
      d={t ? model.dwgById.get(t.dwg) ?? null : null}
      pg={t?.pg ?? 0}
      wait={live && !ready}
      localDir={info.localDir}
      projectDir={projectDir}
      opened={openedAll.current}
    >
      {body}
    </SheetLoc>
  );
  const mainPlace = placeLoc(mainT, !!mainT && mainT.id === curTab, 'main', (own, ost) => centreEl('main', own, ost));
  const sidePlace = sideT ? placeLoc(sideT, sideT.id === curTab, 's' + sideT.id, (own, ost) => centreEl(sideT, own, ost)) : null;
  const floatPlaces = floatTabs.map((t) => {
    const p = pops.list.find((x) => x.id === t.id);
    return p ? createPortal(placeLoc(t, t.id === curTab, 'f' + t.id, (own, ost) => centreEl(t, own, ost)), p.root, t.id) : null;
  });
  const overlay = (node: ReactNode) => (overlayEl ? createPortal(node, overlayEl) : node);
  return (
    <div className="qto">
      {showLeft && (
        <DrawingsPanel
          model={model}
          projectDir={projectDir}
          cur={cur}
          onPick={(dwg, pg) => openSheet(dwg, pg)}
          onOpenTab={(id) => openSheet(id, 0, { newTab: true })}
          onRename={(id, title) => commit([[id, 'title', title || null]], 'Renamed sheet')}
          me={me.username}
          onSplit={(id) => splitDrawing(id)}
          onShowInRegister={(id) => setDialog({ k: 'register', focus: id })}
          onOpenPdf={(id) => openPdf(id)}
          searchRef={dwgSearch}
          onAddFiles={addFiles}
          onAddFolder={addFolder}
          onRemove={(id) => {
            const n = model.shapes.filter((x) => x.dwg === id).length;
            commit([[id, 'del', true]], 'Removed drawing');
            toast(n ? `Drawing removed (the file itself is untouched). Its ${n} measured shape${n > 1 ? 's' : ''} no longer count — Undo brings them back.` : 'Drawing removed from the project (the file itself is untouched).', { action: undoAction() });
          }}
          readOnly={readOnly}
          people={sheetPeople}
          busy={busy}
          onRegister={() => setDialog({ k: 'register' })}
          onCommit={(ops, label) => commit(ops, label)}
          prep={prep}
          prepPaused={prepPaused}
          onPrepPause={setPrepPaused}
          thumbVer={thumbVer}
        />
      )}
      {/* (one wrapper always: the main pane is not made again when the side pane opens) */}
      <div className={'qto-sbs' + (sideT ? ' on' : '')} ref={splitEl} style={sideT ? ({ '--split': splitR } as React.CSSProperties) : undefined}>
        {mainPlace}
        {sideT && <div className="qto-sbs-bar" data-splitter title="Drag: more room for one side" onPointerDown={dragSplit} />}
        {sidePlace}
      </div>
      {floatPlaces}

      <div className="pw-wrap" style={{ width: rw }}>
      <PanelEdge side="left" width={rw} onWidth={setRw} />
      <aside className="qto-right">
        <nav className="qto-rtabs">
          <button className={right === 'items' ? 'on' : ''} onClick={() => setRight('items')}>Take-offs <span className="pill">{model.items.length}</span></button>
          <button className={right === 'boq' ? 'on' : ''} onClick={() => setRight('boq')}>BOQ {model.boqById.size ? (unresolvedCount(model) ? <span className="pill hot" title="Temporary lines not resolved: match each to a BOQ line or keep it as an additional item">{unresolvedCount(model)}</span> : null) : model.dummies.length ? <span className="pill">{model.dummies.length}</span> : null}</button>
          <button className={right === 'notes' ? 'on' : ''} onClick={() => setRight('notes')}>
            Notes {model.notes.filter((n) => !n.done).length ? <span className="pill hot">{model.notes.filter((n) => !n.done).length}</span> : null}
          </button>
        </nav>
        {right === 'items' && (
          <ItemsPanel
            model={model}
            me={me.username}
            isAdmin={auth.isAdmin}
            readOnly={readOnly}
            editOthers={mayEditOthers}
            isQs={isQs}
            activeId={activeId}
            cur={cur}
            onActivate={(id) => (id ? activate(id) : stopMeasuring())}
            curHead={curHead}
            onCurHead={setCurHead}
            onNew={(kind: Kind, t?: Template, par?: string) => {
              const under = par ?? (curHead && model.headingById.has(curHead) ? curHead : '');
              // (v0.16: a room offers the settings of the last room with its name once it is named - roomops)
              const r = kind === 'room' ? newRoomOps(model, me.username, { name: '', par: under }) : newItemOps(model, me.username, kind, t, under);
              // made, measured into (▶) and selected (its properties, to name it)
              // (v0.17 a plain take-off: the structural element the tool measured is let go)
              if (commit(r.ops, kind === 'room' ? 'New room' : 'New take-off')) { setActiveId(r.id); setTool(TOOL_FOR_KIND[kind]); setSk(''); setMode('path'); pickRows(new Set([r.id])); }
            }}
            onNewStruct={(st, par) => {
              const r = newStructOps(model, me.username, st, par ?? (curHead && model.headingById.has(curHead) ? curHead : ''));
              if (commit(r.ops, 'New ' + SK_LABEL[st].toLowerCase())) { setLastStruct(st); setActiveId(r.id); setTool(TOOL_FOR_KIND[SK_KIND[st]]); setSk(st); setMode('path'); pickRows(new Set([r.id])); }
            }}
            onCommit={(ops, label) => commit(ops, label)}
            onDelete={(id) => askDelete([id])}
            onLink={(ti) => setDialog({ k: 'link', ti })}
            onGoTo={(dwg, pg, box) => openSheet(dwg, pg, { box })}
            onGoToSheet={(ti, at) => setGoSheet({ ti, ...at })}
            onNote={(on) => setDialog({ k: 'note', on })}
            onDuplicate={(ti) => setDialog({ k: 'dup', ti })}
            onDoorSchedule={() => setDialog({ k: 'doors' })}
            onBeamTypes={() => setDialog({ k: 'beams' })}
            onSchedule={(c) => openSched(c)}
            onToast={(t) => toast(t, { color: '#b45309' })}
            segHi={segHi}
            onSegHi={setSegHi}
            onEditOpening={(o) => editOpening(o)}
            labelFor={labelFor}
            picked={selRows}
            onPick={pickRows}
            selItems={selItemList}
            selShapes={selShapeList}
            hidden={hidden}
            hiddenItems={hiddenItems}
            onEye={onEye}
            onDeleteNodes={askDelete}
            onLinkMany={linkRows}
            onDupHeading={dupHeading}
            ownerBits={(it) => <OwnerBits model={model} it={it} me={me.username} nameOf={nameOf} selected={selected} shown={(s) => shownFor(model, s, people)} qs={isQs} locked={(s) => !mayEdit(model, s, me.username, mayEditOthers)} />}
            shapeShown={shapeShownFn}
            projectId={session.meta.id}
          />
        )}
        {right === 'boq' && (
          <BoqPanel
            model={model}
            readOnly={readOnly}
            embedded={!!props.embedded}
            linkBox={props.linkBox}
            activeId={activeId}
            onCommit={(ops, label) => commit(ops, label)}
            onLinkActive={() => active && setDialog({ k: 'link', ti: active.id })}
            onActivate={activate}
            selectedIds={selItemList.map((x) => x.id)}
            onSelectItem={(id: string) => pickRows(new Set([id]))}
            toast={toast}
            me={me.username}
            meName={me.name}
            projectId={session.meta.id}
            estEdit={props.estEdit}
          />
        )}
        {right === 'notes' && (
          <NotesPanel
            model={model}
            me={me.username}
            readOnly={readOnly}
            onCommit={(ops, label) => commit(ops, label)}
            onNew={() => setDialog({ k: 'note', on: activeId ?? '' })}
            onGo={(n: Note) => {
              if (n.dwg && n.x !== null && n.y !== null) {
                openSheet(n.dwg, n.pg ?? 0, { box: { x0: n.x! - 60, y0: n.y! - 60, x1: n.x! + 60, y1: n.y! + 60 } });
              } else if (n.on.startsWith('ti:')) { setRight('items'); pickRows(new Set([n.on])); }
            }}
          />
        )}
      </aside>
      </div>

      {overlay(<>
      {menu && (
        <div
          className="scrim clear"
          onMouseDown={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            // Windows sends the right-click's own "contextmenu" AFTER the button is released, i.e. after this
            // menu opened: that one must not close it. Only a right-click somewhere else does.
            if (Math.abs(e.clientX - menu.x) + Math.abs(e.clientY - menu.y) > 4) setMenu(null);
          }}
        >
          <div className="rowmenu" ref={fitOnScreen} style={{ left: Math.min(menu.x, activeWin().innerWidth - 290), top: Math.min(menu.y, activeWin().innerHeight - 360) }} onMouseDown={(e) => e.stopPropagation()}>
            {menu.opening && ctxOpening ? (
              <>
                <div className="mh">{ctxOpening.k === 'door' ? 'Door ' + (ctxOpening.door ? model.doorById.get(ctxOpening.door)?.tag ?? '' : ctxOpening.tag) : 'Opening ' + (ctxOpening.tag || '')} · {(() => { const z = openingSize(model, ctxOpening); return z.w && z.h ? `${mmOf(z.w)} × ${mmOf(z.h)}` : 'no size'; })()}{ctxOpening.room && ctxOpening.k === 'open' && ctxOpening.sill ? ` · sill ${mmOf(ctxOpening.sill)}` : ''}{ctxOpening.uns ? ' · not in the schedule' : ''}</div>
                <button className="mi" disabled={readOnly} onClick={() => { setMenu(null); if (!refuseLocked([ctxOpening.sh])) editOpening(ctxOpening, [menu.x, menu.y]); }}><span className="ck" /><span className="lb">{ctxOpening.k === 'door' ? 'Another door tag…' : ctxOpening.room ? 'Change its size and sill…' : 'Change its size…'}</span></button>
                {/* (v0.16 in a room: it corrects the room's finishes only - no lintel; an opening has a sill) */}
                {ctxOpening.room && ctxOpening.k === 'open' && <button className="mi" data-sillmenu disabled={readOnly} onClick={() => { setMenu(null); if (!refuseLocked([ctxOpening.sh])) editOpening(ctxOpening, [menu.x, menu.y]); }}><span className="ck" /><span className="lb">Sill {ctxOpening.sill ? mmOf(ctxOpening.sill) + ' mm' : '0 (from the floor)'}…</span></button>}
                {ctxOpening.room && <div className="mi dim"><span className="ck" /><span className="lb faint">In a room: corrects its finishes only, never counted</span></div>}
                {!ctxOpening.room && <button className="mi" disabled={readOnly} onClick={() => { commit([[ctxOpening.id, 'lint', ctxOpening.lint ? false : null]], ctxOpening.lint ? 'No lintel' : 'Lintel'); setMenu(null); }}><span className="ck">{ctxOpening.lint ? '✓' : ''}</span><span className="lb">Lintel over it</span></button>}
                {ctxOpening.k === 'door' && <button className="mi" onClick={() => { setDialog({ k: 'doors' }); setMenu(null); }}><span className="ck"><TIcon k="door" size={13} /></span><span className="lb">Door schedule…</span></button>}
                <div className="msep" />
                <button className="mi danger" disabled={readOnly} onClick={() => { commit([[ctxOpening.id, 'del', true]], ctxOpening.k === 'door' ? 'Removed door' : 'Removed opening'); setMenu(null); }}><span className="ck" /><span className="lb">Remove</span></button>
              </>
            ) : ctxShape ? (
              <>
                <div className="mh">{ctxIds.length > 1 ? `${ctxIds.length} shapes` : model.itemById.get(ctxShape.ti)?.name} · {labelFor(ctxShape)}</div>
                {ctxIds.length === 1 && !isMine(model, ctxShape, me.username) && <div className="mh sub" data-menu-owner>{ownerText(model, ctxShape, nameOf)}{viewOnly.has(ctxShape.id) ? ' · view only' : ''}</div>}
                {menu.vertex && (
                  <button className="mi" disabled={readOnly} onClick={() => { onVertexDelete(menu.vertex!.shape, menu.vertex!.ring, menu.vertex!.idx); setMenu(null); }}><span className="ck" /><span className="lb">Delete node</span><span className="kb">Double-click</span></button>
                )}
                {/* v0.17 (Nabil: "continue modifying / drawing an area or a line ... from a specific node"): new nodes go in after it */}
                {menu.vertex && menu.vertex.ring === 0 && ctxShape.k !== 'pt' && (
                  <button className="mi" data-fromnode disabled={readOnly} onClick={() => {
                    const v = menu.vertex!;
                    if (refuseLocked([ctxShape.id])) { setMenu(null); return; }
                    activate(ctxShape.ti);
                    const it = model.itemById.get(ctxShape.ti);
                    setTool(ctxShape.k === 'poly' ? (it?.kind === 'room' ? 'room' : 'area') : it && isLineKind(it.kind) ? TOOL_FOR_KIND[it.kind] : 'line');
                    setMode('path');
                    setTimeout(() => setResume({ id: ctxShape.id, token: Date.now(), from: v.idx }), 0);
                    setMenu(null);
                  }}><span className="ck" /><span className="lb">Continue from this node</span></button>
                )}
                {ctxShape.k === 'line' && ctxIds.length === 1 && (
                  <button className="mi" disabled={readOnly} onClick={() => { if (refuseLocked([ctxShape.id])) { setMenu(null); return; } activate(ctxShape.ti); const it = model.itemById.get(ctxShape.ti); setTool(it && isLineKind(it.kind) ? TOOL_FOR_KIND[it.kind] : 'line'); setMode('path'); setTimeout(() => setResume({ id: ctxShape.id, token: Date.now() }), 0); setMenu(null); }}><span className="ck" /><span className="lb">Continue this {model.itemById.get(ctxShape.ti)?.kind === 'wall' ? 'wall' : 'line'}</span></button>
                )}
                {ctxShape.k === 'line' && ctxIds.length === 1 && (() => {
                  const v = menu.vertex && menu.vertex.shape === ctxShape.id && menu.vertex.ring === 0 ? menu.vertex.idx : -1;
                  const corner = v > 0 && v < ctxShape.pts.length - 1;
                  const seg = menu.seg && menu.seg.shape === ctxShape.id ? menu.seg : null;
                  return (
                    <>
                      <div className="msec">Split</div>
                      {corner && <button className="mi" disabled={readOnly} onClick={() => { split(splitLineOps(ctxShape, v, me.username), 'Split at the node'); setMenu(null); }}><span className="ck">✂</span><span className="lb">Split at this node</span></button>}
                      {!corner && seg && <button className="mi" disabled={readOnly} onClick={() => { split(splitLineAtOps(ctxShape, seg.idx, seg.p, me.username), 'Split in two'); setMenu(null); }}><span className="ck">✂</span><span className="lb">Split here</span></button>}
                      {ctxShape.pts.length > 2 && <button className="mi" disabled={readOnly} onClick={() => { split(explodeLineOps(ctxShape, me.username), `Split into ${ctxShape.pts.length - 1} lengths`); setMenu(null); }}><span className="ck">✂</span><span className="lb">Split into {ctxShape.pts.length - 1} separate segments</span></button>}
                    </>
                  );
                })()}
                {ctxShape.k !== 'pt' && ctxIds.length === 1 && menu.seg && menu.seg.shape === ctxShape.id && (
                  ctxShape.b[menu.seg.idx]
                    ? <button className="mi" disabled={readOnly} onClick={() => { onBulge(ctxShape.id, menu.seg!.idx, 0); setMenu(null); }}><span className="ck">╱</span><span className="lb">Make this segment straight</span></button>
                    : <button className="mi" disabled={readOnly} onClick={() => { onBulge(ctxShape.id, menu.seg!.idx, 0.25); setMenu(null); }}><span className="ck">◠</span><span className="lb">Make this segment an arc</span><span className="kb">then drag its middle dot</span></button>
                )}
                {/* v0.16 a room's edge: open (no wall) / shadow gap - each a ✓ toggle */}
                {ctxShape.k === 'poly' && menu.seg && menu.seg.shape === ctxShape.id && (edgeFlagFits(model, ctxShape, 'open') || edgeFlagFits(model, ctxShape, 'gap')) && (() => {
                  const f = edgeFlags(ctxShape.sg[menu.seg.idx]);
                  const seg = menu.seg.idx;
                  return (
                    <>
                      <div className="msec">This edge</div>
                      {edgeFlagFits(model, ctxShape, 'open') && <button className="mi" data-edge="open" disabled={readOnly} onClick={() => { toggleEdge(ctxShape.id, seg, 'open'); setMenu(null); }}><span className="ck">{f.open ? '✓' : ''}</span><span className="lb">Open edge (no wall)</span></button>}
                      <button className="mi" data-edge="gap" disabled={readOnly} onClick={() => { toggleEdge(ctxShape.id, seg, 'gap'); setMenu(null); }}><span className="ck">{f.gap ? '✓' : ''}</span><span className="lb">Shadow gap here</span></button>
                    </>
                  );
                })()}
                {!joinable(ctxIds) && ctxIds.length === 2 && (() => {
                  const [a, c] = ctxIds.map((id) => model.shapes.find((x) => x.id === id));
                  return a && c && a.k === 'line' && c.k === 'line' && a.ti === c.ti && (a.m || 1) !== (c.m || 1) && joinLinesOps({ ...a, m: 1 }, { ...c, m: 1 }, 1, (x) => model.stale.has(x.id), me.username);
                })() && (
                  <button className="mi" disabled><span className="ck">⇥</span><span className="lb">Join: repeated a different number of times (×{model.shapes.find((x) => x.id === ctxIds[0])?.m ?? 1} and ×{model.shapes.find((x) => x.id === ctxIds[1])?.m ?? 1})</span></button>
                )}
                {joinable(ctxIds) && (
                  <button className="mi" disabled={readOnly} onClick={() => { const ops = joinable(ctxIds)!; if (!commit(withOpenings(ops), 'Joined lengths')) { setMenu(null); return; } const nid = ops.find((o) => o[1] === 'ti')?.[0]; setSelected(new Set(nid ? [nid] : [])); setMenu(null); }}><span className="ck">⇥</span><span className="lb">Join the two lengths into one</span></button>
                )}
                {ctxIds.some((id) => model.stale.has(id)) && (
                  <button className="mi" disabled={readOnly} onClick={() => { markChecked(ctxIds); setMenu(null); }}><span className="ck" /><span className="lb">Mark checked on the current revision</span></button>
                )}
                <button className="mi" disabled={readOnly} onClick={() => { setMenu(null); if (!refuseLocked(ctxIds)) setDialog({ k: 'moveto', ids: ctxIds }); }}><span className="ck" /><span className="lb">Move to another take-off…</span></button>
                <button className="mi" disabled={readOnly} onClick={() => { setMenu(null); if (!refuseLocked(ctxIds)) setDialog({ k: 'repeat', ids: ctxIds }); }}><span className="ck" /><span className="lb">Repeat ×N (typical floors, both sides)…</span></button>
                <button className="mi" disabled={readOnly} onClick={() => { setMenu(null); if (!refuseLocked(ctxIds)) setDialog({ k: 'copy', ids: ctxIds }); }}><span className="ck" /><span className="lb">Copy to other sheets…</span></button>
                {ctxShape.k === 'poly' && ctxIds.length === 1 && <button className="mi" disabled={readOnly} onClick={() => { setMenu(null); if (refuseLocked([ctxShape.id])) return; setSelected(new Set([ctxShape.id])); setTool('hole'); }}><span className="ck" /><span className="lb">Cut out an opening…</span><span className="kb">H</span></button>}
                {ctxShape.k === 'poly' && ctxShape.holes.length > 0 && ctxIds.length === 1 && <button className="mi" disabled={readOnly} onClick={() => { commit([[ctxShape.id, 'holes', null]], 'Removed cut-outs'); setMenu(null); }}><span className="ck" /><span className="lb">Remove its cut-outs</span></button>}
                <button className="mi" onClick={() => { pickRows(new Set([ctxShape.ti])); setRight('items'); setMenu(null); }}><span className="ck" /><span className="lb">Show the take-off</span></button>
                <button className="mi" disabled={readOnly} onClick={() => { setDialog({ k: 'note', on: ctxShape.ti, at: menu.p }); setMenu(null); }}><span className="ck" /><span className="lb">Add a note here…</span></button>
                <div className="msep" />
                <button className="mi danger" disabled={readOnly} onClick={() => { deleteSelected(); setMenu(null); }}><span className="ck" /><span className="lb">Delete</span><span className="kb">Del</span></button>
              </>
            ) : (
              <>
                <div className="mh">Sheet</div>
                <button className="mi" onClick={() => { setFitToken((x) => ({ n: (x?.n ?? 0) + 1, pk })); setMenu(null); }}><span className="ck" /><span className="lb">Fit the sheet</span><span className="kb">Home</span></button>
                <button className="mi" disabled={readOnly} onClick={() => { setTool('scale'); setMenu(null); }}><span className="ck" /><span className="lb">Set the scale…</span><span className="kb">S</span></button>
                {pageInfo?.sc && <button className="mi" disabled={readOnly} onClick={() => { setMenu(null); askClearScale(); }}><span className="ck" /><span className="lb">Clear scale {scaleLabel}</span></button>}
                <button className="mi" disabled={readOnly} onClick={() => { setDialog({ k: 'note', on: activeId ?? '', at: menu.p }); setMenu(null); }}><span className="ck" /><span className="lb">Add a note here…</span></button>
                <button className="mi" disabled={readOnly} onClick={() => { setDialog({ k: 'auto' }); setMenu(null); }}><span className="ck"><TIcon k="auto" size={13} /></span><span className="lb">Count by tag on this sheet…</span><span className="kb">T</span></button>
                {pageRegions.filter((r) => menu.p[0] >= r.r.x0 && menu.p[0] <= r.r.x1 && menu.p[1] >= r.r.y0 && menu.p[1] <= r.r.y1).map((r) => (
                  <button key={r.id} className="mi danger" disabled={readOnly} onClick={() => { commit([[r.id, 'del', true]], 'Removed viewport scale'); setMenu(null); }}><span className="ck" /><span className="lb">Remove viewport scale {r.scl}</span></button>
                ))}
                {curDrawing && <button className="mi" onClick={() => { gt().openPath(ready?.path ?? curDrawing.path); setMenu(null); }}><span className="ck" /><span className="lb">Open the PDF in its own viewer</span></button>}
              </>
            )}
          </div>
        </div>
      )}

      {finOpen && (
        <FinishesSummary
          model={model}
          projectId={session.meta.id}
          projectName={model.name || session.meta.name}
          readOnly={readOnly}
          onClose={() => setFinOpen(false)}
          onCommit={(ops, label) => commit(ops, label)}
          toast={toast}
          me={{ username: me.username, name: me.name }}
          onGoTo={(id) => { setRight('items'); pickRows(new Set([id])); }}
          onLinkItems={(ids, measure) => setDialog(ids.length === 1 ? { k: 'link', ti: ids[0], measure } : { k: 'linkmany', ids: leavesInOrder(model.itemTree).filter((x) => ids.includes(x)), measure })}
        />
      )}
      {goSheet && (
        <GoToSheetMenu model={model} ti={goSheet.ti} x={goSheet.x} y={goSheet.y} onClose={() => setGoSheet(null)}
          onGo={(dwg, pg, ids) => openSheet(dwg, pg, { zoomToItem: goSheet.ti, select: ids })} />
      )}
      {clearAsk && cur && clearAsk.pk === pk && (
        <ClearScaleDialog n={clearAsk.n} label={scaleLabel ?? ''} onCancel={() => setClearAsk(null)} onClear={() => { setClearAsk(null); clearScale(); }} />
      )}
      {dialog?.k === 'scale' && cur && (
        <ScaleDialog
          a={dialog.a}
          b={dialog.b}
          detected={detectedScales}
          groupName={curDrawing?.grp ?? ''}
          cur={pageInfo?.sc ? { sc: pageInfo.sc, scy: pageInfo.scy } : null}
          next={dialog.next}
          nextScope={dialog.nextScope}
          onClose={() => { setDialog(null); scaleNext.current = null; scaleTargets.current = null; toolDone(); }}
          onSave={(sc, label, scope, dir, more) => { setPageScale(sc, label, scope, dir, more); if (!more) setDialog(null); }}
        />
      )}
      {dialog?.k === 'region' && cur && (
        <RegionDialog
          detected={detectedScales}
          onClose={() => { setDialog(null); toolDone(); }}
          onSave={(sc, label, y) => {
            const id = 'sr:' + randomId(10);
            const b = dialog.box;
            const ops: Op[] = [[id, 'dwg', cur.dwg], [id, 'pg', cur.pg], [id, 'r', JSON.stringify([b.x0, b.y0, b.x1, b.y1].map((v) => Math.round(v * 10) / 10))], [id, 'sc', sc], [id, 'scl', label]];
            if (y) { ops.push([id, 'scy', y.sc], [id, 'scyl', y.label]); if (!readOnly && !session.readOnly) session.needFormat(FORMAT_XY_SCALES); }
            commit(ops, 'Viewport scale');
            setDialog(null);
            toolDone();
            toast(`Viewport set to ${scaleText(sc, label, y?.sc, y?.label)}. Shapes that start inside it use this scale.`);
          }}
        />
      )}
      {dialog?.k === 'copy' && cur && (
        <CopyDialog
          model={model}
          from={cur}
          count={dialog.ids.length}
          onClose={() => setDialog(null)}
          onCopy={(targets) => {
            const shapes = model.shapes.filter((s) => dialog.ids.includes(s.id));
            const ops: Op[] = [];
            for (const t of targets) ops.push(...copyWithRoomsOps(model, shapes, { ...t, rv: model.dwgById.get(t.dwg)?.hash }, me.username, 0, 0).ops);
            commit(ops, `Copied to ${targets.length} sheets`);
            setDialog(null);
            toast(`Copied ${shapes.length} shape${shapes.length > 1 ? 's' : ''} to ${targets.length} sheet${targets.length > 1 ? 's' : ''}, same position. Check each sheet: walls that moved need their nodes adjusted.`);
          }}
        />
      )}
      {dialog?.k === 'repeat' && (
        <RepeatDialog
          count={dialog.ids.length}
          current={model.shapes.find((s) => s.id === dialog.ids[0])?.m ?? 1}
          onClose={() => setDialog(null)}
          onSave={(m) => { commit(dialog.ids.map((id) => [id, 'm', m === 1 ? null : m] as Op), 'Repeat ×' + m); setDialog(null); }}
        />
      )}
      {dialog?.k === 'moveto' && (
        <MoveToItemDialog
          model={model}
          shapes={model.shapes.filter((s) => dialog.ids.includes(s.id))}
          onClose={() => setDialog(null)}
          onPick={(ti) => {
            // (v0.16 a room's outline goes to another room only, and only areas become a room's outline)
            const why = roomMoveRefusal(dialog.ids, ti);
            if (why) return toast(why, { color: '#b45309' });
            commit(dialog.ids.map((id) => [id, 'ti', ti] as Op), 'Moved to another take-off'); setDialog(null); setSelected(new Set(dialog.ids));
          }}
          onNew={(name) => {
            const src = model.shapes.find((s) => dialog.ids.includes(s.id));
            const from = src ? model.itemById.get(src.ti) : null;
            if (!src || !from) return;
            if (from.kind === 'room' && model.shapes.some((s) => dialog.ids.includes(s.id) && s.ti !== from.id)) return toast('Pick the outlines of one room only.', { color: '#b45309' });
            const r = from.kind === 'room' ? newRoomOps(model, me.username, { name, par: from.par }) : newItemOps(model, me.username, from.kind, undefined, from.par);
            const ops: Op[] = [...r.ops.map((o) => (o[1] === 'name' ? ([o[0], 'name', name] as Op) : o))];
            // same measuring settings as the take-off it came from
            for (const f of ['h', 'd', 'x', 'waste', 'dmin', 'lb', 'ld', 'lw', 'st', 'sw'] as const) if (from[f] !== null && from[f] !== undefined && !(f === 'x' && from.x === 1) && !(f === 'waste' && !from.waste)) ops.push([r.id, f, from[f] as number]);
            for (const f of ['bt', 'fill', 'lab'] as const) if (from[f]) ops.push([r.id, f, from[f]]);
            ops.push(...dialog.ids.map((id) => [id, 'ti', r.id] as Op));
            commit(ops, 'New take-off from part of another');
            setDialog(null);
            setSelected(new Set(dialog.ids));
          }}
        />
      )}
      {dialog?.k === 'note' && (
        <NoteDialog
          model={model}
          on={dialog.on}
          pinned={!!dialog.at}
          onClose={() => { setDialog(null); toolDone(); }}
          onSave={(text, to, on) => {
            const r = noteOps({ on, text, to, by: me.username, byName: me.name, dwg: dialog.at && cur ? cur.dwg : null, pg: dialog.at && cur ? cur.pg : null, x: dialog.at?.[0] ?? null, y: dialog.at?.[1] ?? null });
            commit(r.ops, 'Note');
            setDialog(null);
            toolDone();
            toast(to === 'est' ? 'Note saved — the administrator sees it in Notes.' : 'Note saved (only you see it).');
          }}
        />
      )}
      {dialog?.k === 'import' && (
        <ImportDialog
          model={model}
          found={dialog.found}
          issue={dialog.issue}
          scan={engine ? scanFile : undefined}
          user={me.username}
          unc={(p) => toUnc(p, uncMap)}
          onClose={() => setDialog(null)}
          onCommit={(ops, label, summary) => {
            if (ops.length) commit(ops, label);
            setDialog(null);
            toast(`Brought in ${summary}. Nothing was copied or changed on the server.`);
          }}
        />
      )}
      {dialog?.k === 'register' && (
        <RegisterDialog
          model={model}
          readOnly={readOnly}
          projectName={model.name || session.meta.name}
          onClose={() => setDialog(null)}
          focus={dialog.focus}
          onOpen={(id) => { openSheet(id, 0); setDialog(null); }}
          onCommit={(ops, label) => commit(ops, label)}
        />
      )}
      {dialog?.k === 'dup' && model.itemById.get(dialog.ti) && (
        <DuplicateDialog
          item={model.itemById.get(dialog.ti)!}
          links={model.linksByItem.get(dialog.ti)?.length ?? 0}
          shapes={model.shapesByItem.get(dialog.ti)?.length ?? 0}
          onClose={() => setDialog(null)}
          onDo={(o) => { duplicate(dialog.ti, o); setDialog(null); }}
        />
      )}
      {dialog?.k === 'doors' && (
        <DoorScheduleDialog model={model} readOnly={readOnly} onCommit={(ops, label) => commit(ops, label)} onLink={(id) => setDialog({ k: 'linkdoor', id })} onClose={() => setDialog(null)} toast={toast} onTab={openSched} />
      )}
      {dialog?.k === 'beams' && <BeamTypesDialog key={dialog.cat ?? 'beam'} model={model} readOnly={readOnly} onCommit={(ops, label) => commit(ops, label)} onClose={() => setDialog(null)} toast={toast} cat={dialog.cat ?? 'beam'} onTab={openSched}
        onAutoTag={cur && ready && dialog.cat !== 'stair' && (dialog.cat === 'col' || dialog.cat === 'swall' || dialog.cat === 'ftg' || shownShapes.some((s) => markable(s, dialog.cat ?? 'beam'))) ? () => { void (dialog.cat === 'col' || dialog.cat === 'swall' || dialog.cat === 'ftg' ? colMarks(dialog.cat === 'swall' ? 'sw' : dialog.cat === 'ftg' ? 'ftg' : 'col') : beamMarks(dialog.cat === 'wall' ? 'wall' : dialog.cat === 'rwall' ? 'rwall' : 'beam')); } : null} />}
      {dialog?.k === 'linkdoor' && doorItem(model, dialog.id) && (
        <LinkDialog model={model} item={doorItem(model, dialog.id)!} readOnly={readOnly} onClose={() => setDialog({ k: 'doors' })} onCommit={(ops, label) => commit(ops, label)} toast={toast} />
      )}
      {dialog?.k === 'auto' && (
        <AutoCountDialog target={active?.kind === 'count' && !active.dc ? active.name : null} isDoor={doorMode ? (t) => model.doors.some((d) => doorTagKey(d.tag) === doorTagKey(t)) : undefined} find={findOnSheet} onClose={() => setDialog(null)} onShow={showAuto} />
      )}
      {opick && (
        <OpeningPicker
          k={opick.k}
          at={opick.client}
          model={model}
          current={opick.edit ? { door: opick.edit.door, tag: opick.edit.tag, ...openingSize(model, opick.edit), lint: opick.edit.lint, sill: opick.edit.sill ?? null } : null}
          room={opickInRoom(opick)}
          counter={opick.choose === 'count'}
          onClose={() => setOpick(null)}
          onDoor={onDrawing(placeDoor)}
          onOpen={onDrawing(placeOpen)}
        />
      )}
      {dialog?.k === 'del' && (() => {
        const q = deleteQuestion(model, dialog.ids);
        return <DeleteDialog title={q.title} detail={q.detail} onClose={() => setDialog(null)} onDelete={() => { const ids = dialog.ids; setDialog(null); doDelete(ids); }} />;
      })()}
      {dialog?.k === 'linkmany' && (() => {
        const items = dialog.ids.map((id) => model.itemById.get(id)!).filter(Boolean);
        return items.length ? <MultiLinkDialog key={dialog.ids.join() + (dialog.measure ?? '')} model={model} items={items} readOnly={readOnly} onClose={() => setDialog(null)} onCommit={(ops, label) => commit(ops, label)} toast={toast} measure={dialog.measure} /> : null;
      })()}
      {sqOpen && cur && curDrawing && !offView && (
        <SheetQtyTable
          model={model}
          dwg={cur.dwg}
          pg={cur.pg}
          hiddenItems={hiddenItems}
          ownerHidden={ownerHidden}
          selItems={selItems}
          selected={selected}
          segHi={segHi}
          onClose={() => setSqOpen(false)}
          onPickItem={(ti, add, box) => {
            const n = add ? new Set(selRows) : new Set<string>();
            add && n.has(ti) ? n.delete(ti) : n.add(ti);
            pickRows(n);
            if (box && !hiddenItems.has(ti)) setFocus({ box, token: Date.now(), pk, ifOff: true });
          }}
          onPickShape={(x, add) => {
            const n = add ? new Set(selectedRef.current) : new Set<string>();
            add && n.has(x.id) ? n.delete(x.id) : n.add(x.id);
            setSelected(n);
            if (!n.size) setSelRows(new Set());
            setSegHi(null);
            if (!hiddenItems.has(x.ti)) setFocus({ box: x.box, token: Date.now(), pk, ifOff: true });
          }}
          onPickSeg={(x, i) => {
            // only that segment lights up (its take-off's row stays selected)
            setSelRows(new Set([x.ti]));
            selectedRef.current = new Set();
            setSelectedRaw(new Set());
            setSegHi({ shape: x.id, segs: [i] });
            if (!hiddenItems.has(x.ti)) setFocus({ box: segBox(x, i), token: Date.now(), pk, ifOff: true });
          }}
        />
      )}
      {dialog?.k === 'link' && model.itemById.get(dialog.ti) && (
        <LinkDialog
          model={model}
          item={model.itemById.get(dialog.ti)!}
          readOnly={readOnly}
          onClose={() => setDialog(null)}
          onCommit={(ops, label) => commit(ops, label)}
          toast={toast}
          by={{ username: me.username, name: me.name }}
          projectId={session.meta.id}
          measure={dialog.measure}
        />
      )}
      </>)}
    </div>
  );
}

let trimmed = false;

