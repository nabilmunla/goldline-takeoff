// v0.16.2 (feedback 2): the Finishes Summary to Excel - the view as it is on screen (its levels and filters, or the
// saved breakdown it matches), every level open. Sheets: Summary (the tree with subtotals and the BOQ items it is
// linked to), Detail (every room finish / take-off under it), No code (what the summary leaves out, and why).
import type { QtoModel } from '../../engine/qto/model';
import { summarize, summarizeByType, atomLinkText, type FinFilter, type FinRow, type GroupKey } from '../../engine/qto/finishes';
import type { XCell, XSheet } from '../../engine/xlsxwrite';
import { groupKeyLabel, boqLineText, FILTER_TYPES } from './roomui';

export function finishesSheets(m: QtoModel, by: GroupKey[], flt: FinFilter, opts: { project: string; breakdown: string | null; when?: Date; byType?: boolean }): XSheet[] {
  const s = summarize(m, by, flt);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  // (full values, shown with 3 decimals - like Excel: the parts add up to the totals exactly)
  const n = (x: number): XCell => ({ v: x, s: 'n3' });
  const head = (cells: string[]): XCell[] => cells.map((v) => ({ v, s: 'h' as const }));
  const when = (opts.when ?? new Date()).toLocaleString('en-GB');
  const levels = ['Code + unit', ...by.map((k) => groupKeyLabel(m, k))].join(' › ');
  const types = flt.types?.length ? FILTER_TYPES.filter((t) => flt.types!.includes(t.t)).map((t) => t.label).join(', ') || 'none' : 'all';
  const heads = flt.heads?.length ? flt.heads.map((h) => m.headingById.get(h)?.name || h).join(', ') : 'all';
  const top: XCell[][] = [
    [{ v: `${opts.project} — Finishes Summary`, s: 'b' }],
    [`Breakdown: ${opts.breakdown ?? 'not saved'} · grouped by ${levels}`],
    [`Shown: ${types} · headings: ${heads}${flt.q ? ` · rooms / descriptions with “${flt.q}”` : ''}`],
    [{ v: `Exported ${when}`, s: 'i' }],
    [],
  ];
  const linkText = (r: FinRow) => r.links.map((id) => m.fin.linkById.get(id)).filter(Boolean).map((l) => boqLineText(m, l!.to) + ` (${r3(l!.qty)} ${l!.unit})`).join('; ');
  // the tree, every level open: the code row, then its groups indented
  const sum: XCell[][] = [...top, head(['Code', 'Unit', 'Level', 'Quantity', 'Linked', 'Unlinked', 'Parts', 'BOQ item (linked)'])];
  const walk = (r: FinRow, depth: number) => {
    sum.push([
      depth === 0 ? { v: r.code, s: 'b' } : r.code, r.unit,
      depth === 0 ? '' : '    '.repeat(depth - 1) + r.label,
      depth === 0 ? { v: r.qty, s: 'b2' } : n(r.qty), n(r.linked), n(r.unlinked), r.atoms.length, linkText(r) || null,
    ]);
    for (const c of r.children) walk(c, depth + 1);
  };
  for (const r of s.rows) walk(r, 0);
  // every part under the rows: the rooms' finishes and the coded take-offs
  const det: XCell[][] = [...top, head(['Code', 'Unit', 'Type', 'Room / take-off', 'Description', 'Headings', 'Quantity', 'BOQ item'])];
  const seen = new Set<string>();
  const parts = (r: FinRow) => { for (const a of r.atoms) seen.add(a); for (const c of r.children) parts(c); };
  for (const r of s.rows) parts(r);
  for (const a of m.fin.atoms) {
    if (!seen.has(a.id)) continue;
    det.push([a.code, a.unit, a.type, a.roomName ? `${a.roomName} — ${a.label}` : a.label, a.desc || null,
      a.heads.map((h) => m.headingById.get(h)?.name || '').filter(Boolean).join(' › ') || null, n(a.qty), atomLinkText(m, a) || null]);
  }
  const sheets: XSheet[] = [
    // (v0.16.4 shown by finish type: that layout first - a column pair each, its total on top)
    ...(opts.byType ? [byTypeSheet(m, flt, top)] : []),
    { name: 'Summary', rows: sum, header: top.length + 1, widths: [14, 7, 40, 14, 14, 14, 7, 60] },
    { name: 'Detail', rows: det, header: top.length + 1, widths: [14, 7, 14, 40, 30, 36, 14, 60] },
  ];
  if (s.uncoded.length) {
    const nc: XCell[][] = [[{ v: 'Finishes without a code: not in the summary (give each a code to count it)', s: 'b' }], [], head(['Room / take-off', 'Why', 'Quantity', 'Unit'])];
    for (const a of s.uncoded) nc.push([a.roomName || a.label, a.reason ?? '', n(a.qty), a.unit]);
    sheets.push({ name: 'No code', rows: nc, header: 3, widths: [36, 50, 14, 7] });
  }
  return sheets;
}

/** v0.16.4 the Finishes Summary by finish type (Nabil's layout): Floor | Qty | Wall | Qty | ..., the totals on top */
function byTypeSheet(m: QtoModel, flt: FinFilter, top: XCell[][]): XSheet {
  const cols = summarizeByType(m, flt);
  const label = (t: string) => FILTER_TYPES.find((x) => x.t === t)?.label ?? t;
  const head: XCell[] = [], tot: XCell[] = [];
  for (const c of cols) {
    head.push({ v: label(c.type), s: 'h' }, { v: 'Qty', s: 'h' });
    // (one unit: its total; more than one - other take-offs - each)
    tot.push(c.totals.length === 1 ? c.totals[0].unit : 'Total', c.totals.length === 1 ? { v: c.totals[0].qty, s: 'b2' } : c.totals.map((t) => `${(Math.round(t.qty * 100) / 100).toFixed(2)} ${t.unit}`).join(' · '));
  }
  const rows: XCell[][] = [...top, head, tot];
  const n = Math.max(0, ...cols.map((c) => c.rows.length));
  for (let i = 0; i < n; i++) {
    const r: XCell[] = [];
    for (const c of cols) {
      const x = c.rows[i];
      r.push(x ? (c.totals.length > 1 ? `${x.code} (${x.unit})` : x.code) : null, x ? { v: x.qty, s: 'n3' } : null);
    }
    rows.push(r);
  }
  return { name: 'By finish type', rows, header: top.length + 1, widths: cols.flatMap(() => [18, 13]) };
}
