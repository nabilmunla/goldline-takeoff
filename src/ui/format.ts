// calculations keep every decimal (like Excel); these only decide what is shown.
// "negative": a total that is -0.000000001 after adding decimals shows 0.00, never -0.00
const money2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'negative' } as unknown as Intl.NumberFormatOptions);
const qtyF = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3, signDisplay: 'negative' } as unknown as Intl.NumberFormatOptions);

// shown as Excel shows a cell: the value to 15 significant digits first, then the format's decimals
// (970.1249999999999 from adding binary fractions is 970.125 -> "970.13", as in Excel)
const xl = (n: number) => (Number.isFinite(n) ? Number(n.toPrecision(15)) : n);
export const fmtMoney = (n: number | null | undefined) => (n === null || n === undefined ? '' : money2.format(xl(n)));
export const fmtQty = (n: number | null | undefined) => (n === null || n === undefined ? '' : qtyF.format(xl(n)));

/** Parses what people type into a number cell. "" -> null, invalid -> undefined. */
export function parseNum(raw: string): number | null | undefined {
  let s = raw.trim().replace(/\s/g, '').replace(/^AED/i, '');
  // commas: thousands separators ("1,250.50") are dropped; a single comma with no point is a
  // decimal comma ("1,5" = 1.5); anything else ("1,2,3", "1.234,56") is not a number
  if (s.includes(',')) {
    if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    else if (/^[-+]?\d*,\d+$/.test(s)) s = s.replace(',', '.');
    else return undefined;
  }
  if (s === '' || s === '-') return null;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return s + ' s ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' h ago';
  const d = new Date(t);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export const initials = (name: string) =>
  name
    .replace(/[._-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

export const FIELD_LABEL: Record<string, string> = {
  ref: 'Ref', desc: 'Description', unit: 'Unit', qty: 'Qty', rate: 'Rate', del: 'Recycle bin', purged: 'Permanently deleted', type: 'Line type', parent: 'Moved', ord: 'Order', name: 'Name',
  st: 'Status', stx: 'Status note', q0: 'Consultant qty', page: 'Page', src: 'Source',
  tq: 'Take-off qty',
};

// words that stay in capitals when an all-capitals title is shown in title case
const KEEP_CAPS = new Set(['MEP', 'HVAC', 'GRC', 'GRP', 'GFRC', 'RC', 'PT', 'UPVC', 'PVC', 'HDPE', 'LV', 'MV', 'HV', 'ELV', 'BMS', 'CCTV', 'AV', 'IT',
  'LPG', 'FCU', 'AHU', 'FAHU', 'VRF', 'DB', 'PS', 'BOQ', 'ACP', 'WPC', 'SS', 'MS', 'GI', 'UV', 'NA', 'AC', 'FF', 'FFE', 'FOH', 'BOH', 'GF', 'LGF', 'UGF',
  'FFL', 'SSL', 'DEWA', 'UAE', 'CP', 'MDF', 'HPL', 'TV', 'LED', 'EPDM', 'XPS', 'EPS', 'SBS', 'APP', 'POD', 'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII']);
const SMALL = new Set(['and', 'or', 'of', 'the', 'to', 'in', 'on', 'for', 'at', 'by', 'with', 'a', 'an', 'from']);
/**
 * "SITEWORK - SECTION B" -> "Sitework - Section B" (all-capitals titles only; anything typed in mixed case
 * is shown as typed). Abbreviations (MEP, HVAC, FF&E…), single letters and words with digits stay.
 */
export function niceTitle(s: string): string {
  if (!s || /[a-z]/.test(s)) return s;
  let first = true;
  return s.replace(/[A-Z0-9&'’.\/]+/g, (w) => {
    const isFirst = first;
    first = false;
    if (w.length === 1 || /\d|&|\//.test(w) || KEEP_CAPS.has(w.replace(/[.'’]/g, ''))) return w;
    const lo = w.toLowerCase();
    if (!isFirst && SMALL.has(lo)) return lo;
    return lo.charAt(0).toUpperCase() + lo.slice(1);
  });
}

/** a number as typed back into a box: thousands separated, every decimal kept (140000 -> "140,000") */
export function plainNum(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumSignificantDigits: 15, useGrouping: true }) : String(n);
}
