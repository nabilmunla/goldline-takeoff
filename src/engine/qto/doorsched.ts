// Door schedules from Excel (v0.15): find the header row, which column is the tag, the description,
// the location, the structural opening's width / height and the clear opening's width / height.
// Sizes in mm (a number over 20) or m; "900 x 2100" in one cell is a width and a height.
import type { XWorkbook, XSheet } from '../xlsx';
import type { DoorIn } from './ops';

export type DoorCol = 'tag' | 'desc' | 'loc' | 'sw' | 'sh' | 'cw' | 'ch' | 'ssz' | 'csz';
export const DOOR_COL_LABEL: Record<DoorCol, string> = {
  tag: 'Tag', desc: 'Description', loc: 'Location', sw: 'Structural width', sh: 'Structural height', cw: 'Clear width', ch: 'Clear height',
  ssz: 'Structural size (W × H)', csz: 'Clear size (W × H)',
};
export type DoorCols = Partial<Record<DoorCol, number>>;

export interface DoorSheetPlan {
  sheet: string;
  /** the (last) header row, 1-based; data starts below it */
  header: number;
  /** column headings as read (1-based column -> text), for choosing a column by hand */
  heads: Map<number, string>;
  cols: DoorCols;
}

const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** the heading of each column over one or two rows (merged cells over two columns spread to both) */
export function headsAt(sh: XSheet, r: number): Map<number, string> {
  const out = new Map<number, string>();
  const above = sh.rows.get(r - 1) ?? [];
  const row = sh.rows.get(r) ?? [];
  const mergedAbove = (c: number) => {
    for (const m of sh.merges) if (m.r1 <= r - 1 && m.r2 >= r - 1 && m.c1 <= c && m.c2 >= c) return norm(sh.rows.get(m.r1)?.[m.c1]?.v);
    return norm(above[c]?.v);
  };
  const mergedHere = (c: number) => {
    for (const m of sh.merges) if (m.r1 <= r && m.r2 >= r && m.c1 <= c && m.c2 >= c) return norm(sh.rows.get(m.r1)?.[m.c1]?.v);
    return norm(row[c]?.v);
  };
  let prevA = '', prevH = '';
  for (let c = 1; c <= Math.min(sh.maxCol, 60); c++) {
    let a = mergedAbove(c);
    const h = mergedHere(c);
    // a group heading over two columns written once, not merged ("Structural opening" over Width | Height):
    // the next column only (carried on, it prefixed every column after it)
    const own = a;
    if (!a && h && prevA && prevH) a = prevA;
    const t = a && a !== h && !/^\d/.test(a) ? (a + ' ' + h).trim() : h;
    if (t) out.set(c, t);
    prevA = own; prevH = h;
  }
  return out;
}

/** the headings of one row on its own (the row above is a title, not a heading over these) */
export function headsOne(sh: XSheet, r: number): Map<number, string> {
  const out = new Map<number, string>();
  const row = sh.rows.get(r) ?? [];
  for (let c = 1; c <= Math.min(sh.maxCol, 60); c++) {
    let t = norm(row[c]?.v);
    if (!t) for (const m of sh.merges) if (m.r1 <= r && m.r2 >= r && m.c1 <= c && m.c2 >= c) { t = norm(sh.rows.get(m.r1)?.[m.c1]?.v); break; }
    if (t) out.set(c, t);
  }
  return out;
}

const TAG = /^(tag|mark|door ?(no\.?|nos?|number|ref\.?|reference|id|code|tag|mark)|ref\.?|reference|code|no\.?|id|type ?mark|door)$/;
const W = /\b(width|wide|w)\b/;
const H = /\b(height|high|ht|h)\b/;
const CLEAR = /(clear|\bc\.? ?o\b|leaf|nett?|passage|door size|panel)/;

/** which column is what, from the headings */
export function guessDoorCols(heads: Map<number, string>): DoorCols {
  const cols: DoorCols = {};
  const set = (k: DoorCol, c: number) => { if (cols[k] === undefined) cols[k] = c; };
  for (const [c, t0] of heads) {
    const t = t0.toLowerCase().replace(/[()[\]:]/g, ' ').replace(/\s+/g, ' ').trim();
    const last = t.split(' ').slice(-3).join(' ');
    if (TAG.test(t) || TAG.test(last)) { set('tag', c); continue; }
    const isW = W.test(t), isH = H.test(t);
    // structural unless it says clear / leaf (one pair of sizes with nothing said = the structural opening)
    const clear = CLEAR.test(t);
    // a size column: "Size", "Dimensions", "W x H", "Size (W x H)" - not "Width" / "Height" alone
    if (/size|dimension|\bw ?[x×] ?h\b/.test(t) && !(isW !== isH && !/[x×]/.test(t))) { set(clear ? 'csz' : 'ssz', c); continue; }
    // "Clear opening" / "Structural opening" / "S.O." with no width or height in the heading: both in one cell
    if (!isW && !isH && /opening|\bs\.? ?o\b|\bc\.? ?o\b|frame/.test(t)) { set(clear ? 'csz' : 'ssz', c); continue; }
    if (isW && !isH) { set(clear ? 'cw' : 'sw', c); continue; }
    if (isH && !isW) { set(clear ? 'ch' : 'sh', c); continue; }
    if (/locat|room|space|zone|level|floor|from|area/.test(t)) { set('loc', c); continue; }
    if (/desc|type|leaf|material|finish|fire|rating|remark/.test(t)) { set('desc', c); continue; }
  }
  return cols;
}

/** the sheet and row that look most like a door schedule's header */
export function analyseDoorSchedule(wb: XWorkbook): DoorSheetPlan | null {
  let best: { score: number; plan: DoorSheetPlan } | null = null;
  for (const { name, state } of wb.sheetNames) {
    if (state !== 'visible') continue;
    let sh: XSheet;
    try { sh = wb.sheet(name); } catch { continue; }
    for (let r = 1; r <= Math.min(sh.maxRow, 40); r++) {
      // read over two rows ("Structural opening" over Width | Height) and as one row: a title right above
      // the headings ("DOOR SCHEDULE", merged across or not) made every heading "DOOR SCHEDULE Door No."
      // and nothing was found - the better reading wins
      for (const heads of [headsAt(sh, r), headsOne(sh, r)]) {
        if (heads.size < 2) continue;
        const cols = guessDoorCols(heads);
        if (cols.tag === undefined) continue;
        const sizes = ['sw', 'sh', 'cw', 'ch', 'ssz', 'csz'].filter((k) => cols[k as DoorCol] !== undefined).length;
        if (!sizes) continue;
        // rows below with a tag and a size
        let data = 0;
        for (let rr = r + 1; rr <= Math.min(sh.maxRow, r + 60); rr++) {
          const row = sh.rows.get(rr);
          if (!row || !norm(row[cols.tag]?.v)) continue;
          if (doorFromRow(row, cols)) data++;
        }
        if (!data) continue;
        const score = data * 10 + sizes * 3 + (cols.desc !== undefined ? 2 : 0) + (cols.loc !== undefined ? 1 : 0);
        if (!best || score > best.score) best = { score, plan: { sheet: name, header: r, heads, cols } };
      }
    }
  }
  return best?.plan ?? null;
}

/** a length in metres from a cell: mm when over 20 ("900", 900), else m ("0.9"); text with units too */
export function sizeOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 0 ? (v > 20 ? v / 1000 : v) : null;
  const t = String(v).toLowerCase().replace(/,/g, '').trim();
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(mm|cm|m)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  if (m[2] === 'mm') return n / 1000;
  if (m[2] === 'cm') return n / 100;
  if (m[2] === 'm') return n;
  return n > 20 ? n / 1000 : n;
}
/**
 * "900 x 2100", "0.9×2.1m", "900W x 2100H", "W900 x H2100", "900(W) x 2100(H)", "90 x 210 cm";
 * "900 x 2100 x 45" (a leaf's thickness after it); "2 x 900 x 2100" a double door: 2 leaves of 900
 * (read as 2 m wide x 0.9 m high before - deducted and lintelled at that size)
 */
export function pairOf(v: unknown): [number, number] | null {
  const t = String(v ?? '').toLowerCase().replace(/,/g, '');
  // numbers joined by x / × / * / "/", each with what is written around it (W, H, mm, brackets)
  const m = t.match(/(\d+(?:\.\d+)?)\s*(mm|cm|m)?[\s()wh]*[x×*\/][\s()wh]*(\d+(?:\.\d+)?)\s*(mm|cm|m)?(?:[\s()wh]*[x×*][\s()wh]*(\d+(?:\.\d+)?)\s*(mm|cm|m)?)?/);
  if (!m) return null;
  const nums: [string, string | undefined][] = [[m[1], m[2]], [m[3], m[4]], ...(m[5] ? [[m[5], m[6]] as [string, string | undefined]] : [])];
  // centimetres written once after the last number are for all of them ("90 x 210 cm": unwritten, 90
  // reads as mm); mm and m need not be (a number over 20 is mm anyway; "900 x 2.1 m" is 900 mm)
  const unit = nums[nums.length - 1][1] === 'cm' && nums.every((x, i) => i === nums.length - 1 || !x[1]) ? 'cm' : undefined;
  const sz = (x: [string, string | undefined]) => sizeOf(x[0] + (x[1] ?? unit ?? ''));
  if (nums.length === 3 && /^[1-4]$/.test(nums[0][0])) {
    const leaf = sz(nums[1]), h = sz(nums[2]);
    return leaf && h ? [Math.round(Number(nums[0][0]) * leaf * 1e6) / 1e6, h] : null;
  }
  const a = sz(nums[0]), b = sz(nums[1]);
  return a && b ? [a, b] : null;
}

/** the unit a column's heading names: "Width (cm)", "Height in m", "W [mm]" (none: mm when over 20, else m) */
export function unitOfHeading(h: string): 'mm' | 'cm' | 'm' | '' {
  const t = h.toLowerCase();
  if (/[(\[]\s*mm\s*[)\]]|\bin mm\b|\bmm$/.test(t)) return 'mm';
  if (/[(\[]\s*cm\s*[)\]]|\bin cm\b|\bcm$/.test(t)) return 'cm';
  if (/[(\[]\s*m\s*[)\]]|\bin m\b|\bm$/.test(t)) return 'm';
  return '';
}

function doorFromRow(row: { v: unknown }[], cols: DoorCols, units: Partial<Record<DoorCol, 'mm' | 'cm' | 'm' | ''>> = {}): DoorIn | null {
  const cell = (k: DoorCol) => (cols[k] !== undefined ? row[cols[k]!]?.v : undefined);
  const tag = norm(cell('tag'));
  if (!tag || tag.length > 40) return null;
  const r: DoorIn = { tag };
  if (cols.desc !== undefined) r.desc = norm(cell('desc'));
  // v0.16.2 a number is never a location (an "Area" column of m² taken for the location gave locations like 19.294249999999998)
  if (cols.loc !== undefined && typeof cell('loc') !== 'number' && !/^[-+]?\d+(\.\d+)?$/.test(norm(cell('loc')))) r.loc = norm(cell('loc'));
  // a plain number in a column whose heading names its unit: in that unit ("Width (cm)": 90 = 0.9 m - read
  // as mm it was a 0.09 m door); a cell that writes its own unit keeps it
  // (a heading that can't be right for the number - 2100 under "(m)", 0.9 under "(mm)" - is ignored)
  const num = (v: unknown) => (typeof v === 'number' ? v : /^\s*\d+(\.\d+)?\s*$/.test(String(v ?? '')) ? Number(v) : NaN);
  // "(cm)" too (BH-042): 0.9 (a 9 mm door) or 2100 (21 m) can't be centimetres. And one row's sizes are in
  // one unit: mm typed under "(cm)" headings (900 | 2100) - the 2100 shows it, so the 900 is not a 9 m door
  const sizes = ['sw', 'sh', 'cw', 'ch'] as const;
  // (a height over 600 under "(cm)" - a 6 m door - is mm too: 1000 x 2000 mm became a 10 x 20 m opening -
  // 0.23.2, DeepSeek #16)
  const mmRow = sizes.some((k) => units[k] === 'cm' && cols[k] !== undefined && (num(cell(k)) > 2000 || ((k === 'sh' || k === 'ch') && num(cell(k)) > 600)));
  const inUnit = (k: DoorCol, v: unknown) => {
    const u = units[k], n = num(v);
    if (!u || !Number.isFinite(n) || (u === 'm' && n > 20) || (u === 'mm' && n <= 20) || (u === 'cm' && (mmRow || n <= 20))) return sizeOf(v);
    return sizeOf(String(n) + u);
  };
  for (const k of sizes) if (cols[k] !== undefined) r[k] = inUnit(k, cell(k));
  if (cols.ssz !== undefined) { const p = pairOf(cell('ssz')); if (p) { if (r.sw == null) r.sw = p[0]; if (r.sh == null) r.sh = p[1]; } }
  if (cols.csz !== undefined) { const p = pairOf(cell('csz')); if (p) { if (r.cw == null) r.cw = p[0]; if (r.ch == null) r.ch = p[1]; } }
  // a heading row inside the table ("GROUND FLOOR"): a tag and nothing else
  if (![r.sw, r.sh, r.cw, r.ch].some((x) => x) && !r.desc) return null;
  return r;
}

/** the doors of a schedule sheet, with the columns as chosen */
export function doorRows(wb: XWorkbook, plan: Pick<DoorSheetPlan, 'sheet' | 'header' | 'cols'>): DoorIn[] {
  const sh = wb.sheet(plan.sheet);
  const out: DoorIn[] = [];
  if (plan.cols.tag === undefined) return out;
  const heads = headsAt(sh, plan.header);
  const units: Partial<Record<DoorCol, 'mm' | 'cm' | 'm' | ''>> = {};
  for (const k of ['sw', 'sh', 'cw', 'ch'] as const) if (plan.cols[k] !== undefined) units[k] = unitOfHeading(heads.get(plan.cols[k]!) ?? '');
  for (let r = plan.header + 1; r <= sh.maxRow; r++) {
    if (sh.hiddenRows.has(r)) continue;
    const row = sh.rows.get(r);
    if (!row) continue;
    const d = doorFromRow(row, plan.cols, units);
    if (d) out.push(d);
  }
  return out;
}

/** the headings of any row of a sheet (choosing another sheet / header row by hand) */
export function headsOf(wb: XWorkbook, sheet: string, header: number): Map<number, string> {
  return headsAt(wb.sheet(sheet), header);
}
