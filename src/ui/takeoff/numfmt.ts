// How measured numbers are SHOWN in the take-off (and written to its Excel export): decimals per unit
// and the size of the numbers on the drawing. Quantities are always calculated in full; this only
// decides what is shown. One setting on this PC, for every take-off: changed while measuring or
// after, everything on screen follows at once.
import { useEffect, useState } from 'react';
import type { Measure } from '../../engine/qto/model';

export interface QtoFmt {
  /** decimals: metres (lengths, perimeters), millimetres, square metres, cubic metres */
  dm: number;
  dmm: number;
  da: number;
  dv: number;
  /** size of the numbers on the drawing (1 = normal) */
  size: number;
  /** lines on the drawing: thickness factor (1 = normal), area fill strength (1 = normal) */
  lw: number;
  fill: number;
  /** numbers on the shapes: on hover / selection only, always, or never */
  labels: 'hover' | 'always' | 'never';
  /** tags of segments (beam types...): always, or on the selected shape only */
  tags: 'sel' | 'always';
  /** take-offs not highlighted fade to this much when some are highlighted (0..1 = how faint) */
  dim: number;
}

export const FMT_DEFAULTS: QtoFmt = { dm: 3, dmm: 0, da: 2, dv: 3, size: 1, lw: 1, fill: 1, labels: 'hover', tags: 'sel', dim: 0.75 };
export const LINE_WIDTHS: { k: number; label: string }[] = [{ k: 0.6, label: 'Thin' }, { k: 1, label: 'Normal' }, { k: 1.5, label: 'Thick' }, { k: 2.2, label: 'Heavy' }];
export const FILLS: { k: number; label: string }[] = [{ k: 0.4, label: 'Light' }, { k: 1, label: 'Normal' }, { k: 1.8, label: 'Strong' }];
export const DIMS: { k: number; label: string }[] = [{ k: 0, label: 'Off' }, { k: 0.5, label: 'Some' }, { k: 0.75, label: 'Strong' }];
export const SIZES: { k: number; label: string }[] = [
  { k: 0.85, label: 'Small' }, { k: 1, label: 'Normal' }, { k: 1.25, label: 'Large' }, { k: 1.5, label: 'Extra large' },
];
const KEY = 'qto.numfmt';

const clampD = (x: unknown, max: number, d: number) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= max ? x : d);
function read(): QtoFmt {
  let j: Partial<QtoFmt> = {};
  try { j = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { j = {}; }
  return {
    dm: clampD(j.dm, 4, FMT_DEFAULTS.dm), dmm: clampD(j.dmm, 2, FMT_DEFAULTS.dmm), da: clampD(j.da, 4, FMT_DEFAULTS.da), dv: clampD(j.dv, 4, FMT_DEFAULTS.dv),
    size: SIZES.some((s) => s.k === j.size) ? (j.size as number) : FMT_DEFAULTS.size,
    lw: LINE_WIDTHS.some((s) => s.k === j.lw) ? (j.lw as number) : FMT_DEFAULTS.lw,
    fill: FILLS.some((s) => s.k === j.fill) ? (j.fill as number) : FMT_DEFAULTS.fill,
    labels: j.labels === 'always' || j.labels === 'never' ? j.labels : 'hover',
    tags: j.tags === 'always' ? 'always' : 'sel',
    dim: DIMS.some((s) => s.k === j.dim) ? (j.dim as number) : FMT_DEFAULTS.dim,
  };
}

let cur: QtoFmt = read();
const subs = new Set<(f: QtoFmt) => void>();

/** the format now (for code outside React: canvas drawing, the export) */
export const qtoFmt = () => cur;

export function setQtoFmt(patch: Partial<QtoFmt>) {
  cur = { ...cur, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* not kept: still used now */ }
  for (const f of subs) f(cur);
}

/** React: the format, re-rendering when it is changed (anywhere) */
export function useQtoFmt(): QtoFmt {
  const [f, setF] = useState(cur);
  useEffect(() => { subs.add(setF); setF(cur); return () => { subs.delete(setF); }; }, []);
  return f;
}

/**
 * A number with a fixed number of decimals, as Excel shows it: the value to 15 significant digits
 * first (970.1249999999999 shows as 970.125), never "-0.000".
 */
const NF = new Map<number, Intl.NumberFormat>();
export function fixed(x: number, d: number): string {
  if (!Number.isFinite(x)) return '—';
  let f = NF.get(d);
  if (!f) NF.set(d, (f = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d, signDisplay: 'negative' } as unknown as Intl.NumberFormatOptions)));
  return f.format(Number(x.toPrecision(15)));
}

/** decimals for a measure: lengths in m, areas in m², volumes in m³, counts whole */
export function decimalsFor(m: Measure | 'nr' | string, f: QtoFmt = cur): number {
  if (m === 'len' || m === 'perim' || m === 'llen' || m === 'm') return f.dm;
  if (m === 'area' || m === 'form' || m === 'm²' || m === 'm2') return f.da;
  if (m === 'vol' || m === 'lvol' || m === 'm³' || m === 'm3') return f.dv;
  if (m === 'mm') return f.dmm;
  if (m === 'kg') return 2;
  return 0;
}

const COUNT = new Set(['cnt', 'lcnt', 'nr', 'no', 'nos', 'each', 'ea', 'pcs', 'pc', 'set', 'sets', 'item', 'unit', 'units', 'pair']);

/**
 * a measured quantity: q(12.3456, 'area') -> "12.35". A count is whole ("12") - unless it is not
 * (a factor on a link: 2.5 shows "2.50", never rounded to 3).
 */
export function q(x: number, m: Measure | string, f: QtoFmt = cur): string {
  const d = decimalsFor(m, f);
  if (d === 0 && COUNT.has(String(m).toLowerCase()) && Number.isFinite(x) && !Number.isInteger(Number(x.toPrecision(12)))) return fixed(x, 2);
  return fixed(x, d);
}
/** metres / square metres / cubic metres, with the unit */
export const m1 = (x: number, f: QtoFmt = cur) => fixed(x, f.dm) + ' m';
export const m2 = (x: number, f: QtoFmt = cur) => fixed(x, f.da) + ' m²';
export const m3 = (x: number, f: QtoFmt = cur) => fixed(x, f.dv) + ' m³';
export const mm = (x: number, f: QtoFmt = cur) => fixed(x * 1000, f.dmm) + ' mm';
