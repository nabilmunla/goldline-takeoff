// Excel export of a take-off project: quantities by take-off, by sheet, and against the BOQ.
import { writeXlsx, nStyle, type XCell, type XSheet, type XStyle } from '../xlsxwrite';
import { measureForUnit } from './units';
import { summarize, atomLinkText } from './finishes';
import { itemQty, KIND_LABEL, itemKindLabel, wallTypeOf, tagOwn, tagBase, hasTagOwn, isConcWall, MEASURE_LABEL, MEASURE_UNIT, MEASURE_BASE, mirrorPath, type QtoModel, headingPath, flattenMirror, segLensAt, beamTypeOf, openingSize, isLineKind, LINTEL_DEFAULT, sheetTitle, type Measure } from './model';

// cells get every decimal (the number format only decides what Excel SHOWS), so sums in Excel match the app
const r3 = (x: number) => (Number.isFinite(x) ? Number(x.toPrecision(15)) : x);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** decimals shown: metres, square metres, cubic metres (as set in the app's Decimals) */
export interface QtoDecimals { len: number; area: number; vol: number }
export const QTO_DECIMALS: QtoDecimals = { len: 3, area: 2, vol: 3 };

export function exportQto(m: QtoModel, opts: { project: string; by: string; when?: Date; dec?: QtoDecimals }): Uint8Array {
  const when = opts.when ?? new Date();
  const dec = opts.dec ?? QTO_DECIMALS;
  const nL = nStyle(dec.len), nA = nStyle(dec.area), nV = nStyle(dec.vol);
  // a count shows whole numbers - unless it is not whole (a factor on a link)
  const nC = (x: number): XStyle => (Number.isInteger(r3(x)) ? 'n0' : 'n2');
  /** a total in a BOQ line's unit: m -> lengths' decimals, m² -> areas', ... */
  const nU = (unit: string, x: number): XStyle => {
    const ms = measureForUnit(unit);
    const b = ms ? MEASURE_BASE[ms as Measure] : null;
    return b === 'len' ? nL : b === 'area' ? nA : b === 'vol' ? nV : b === 'cnt' ? nC(x) : 'n2';
  };
  const title = (t: string): XCell[][] => [
    [{ v: opts.project + ' — ' + t, s: 'b' }],
    [{ v: `Exported ${when.toLocaleString('en-GB')} by ${opts.by}. Quantities in metres. Private take-offs are not included.`, s: 'i' }],
    [],
  ];
  const sheetName = (dwg: string) => {
    const d = m.dwgById.get(dwg);
    return d ? (d.sheet ? d.sheet + ' ' : '') + sheetTitle(d) : dwg;
  };
  const linkText = (id: string) =>
    (m.linksByItem.get(id) ?? [])
      .map((l) => {
        const to = l.to.startsWith('b:') ? m.boqById.get(l.to.slice(2)) : m.dummyById.get(l.to);
        const name = to ? (to.ref ? to.ref + ' ' : '') + to.desc.slice(0, 60) : '(line removed)';
        return `${name} [${MEASURE_LABEL[l.q]}${l.f !== 1 ? ' ×' + l.f : ''}]`;
      })
      .join('; ');
  // (a room's additional finishes / ceiling areas are measured with the room: on the Finishes sheet, not as take-offs)
  const items = m.items.filter((it) => !it.priv && it.rk !== 'add' && it.rk !== 'ceil');
  // a quantity written into text (the "From" column): with the decimals set
  const shown = (x: number, q: string) => {
    const b = MEASURE_BASE[q as Measure];
    const d = b === 'len' ? dec.len : b === 'area' ? dec.area : b === 'vol' ? dec.vol : b === 'kg' ? 2 : Number.isInteger(r3(x)) ? 0 : 2;
    return r3(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  };

  // 1. by take-off
  const s1: XCell[][] = [...title('Take-offs'), [
    { v: 'Heading', s: 'h' }, { v: 'Take-off', s: 'h' }, { v: 'Type', s: 'h' }, { v: 'Shapes', s: 'h' }, { v: 'Count (nr)', s: 'h' },
    { v: 'Length (m)', s: 'h' }, { v: 'Area (m²)', s: 'h' }, { v: 'Volume (m³)', s: 'h' }, { v: 'Perimeter (m)', s: 'h' },
    { v: 'Openings deducted (m²)', s: 'h' }, { v: 'Height (m)', s: 'h' }, { v: 'Thickness (m)', s: 'h' }, { v: 'Multiplier', s: 'h' }, { v: 'Waste %', s: 'h' },
    { v: 'Linked to', s: 'h' }, { v: 'Not scaled', s: 'h' }, { v: 'Not counted', s: 'h' },
    { v: 'Doors (nr)', s: 'h' }, { v: 'Other openings (nr)', s: 'h' }, { v: 'Lintels (nr)', s: 'h' }, { v: 'Lintels (m)', s: 'h' }, { v: 'Lintels (m³)', s: 'h' },
    { v: 'Formwork (m²)', s: 'h' }, { v: 'Steel (kg)', s: 'h' }, { v: 'Without a type (m / columns)', s: 'h' },
  ]];
  const offPage = new Map<string, number>();
  for (const list of m.offPageShapes.values()) for (const s of list) offPage.set(s.ti, (offPage.get(s.ti) ?? 0) + 1);
  for (const it of items) {
    const q = m.qty.get(it.id)!;
    const off = offPage.get(it.id) ?? 0;
    s1.push([
      headingPath(m, it.par), it.name, itemKindLabel(it), q.shapes, { v: r3(q.cnt), s: nC(q.cnt) }, { v: r3(q.len), s: nL }, { v: r3(q.area), s: nA }, { v: r3(q.vol), s: nV },
      { v: r3(q.perim), s: nL }, q.dedArea ? { v: r3(q.dedArea), s: nA } : null, it.h, it.d, it.x !== 1 ? it.x : null, it.waste || null,
      linkText(it.id), q.unscaled ? q.unscaled + ' shape(s) on sheets without a scale' : null,
      off ? off + ' shape(s) on pages the new revision no longer has' : null,
      it.kind === 'wall' ? r3(q.doors) : null, it.kind === 'wall' ? r3(q.opens) : null,
      it.kind === 'wall' ? r3(q.lcnt) : null, it.kind === 'wall' ? { v: r3(q.llen), s: nL } : null, it.kind === 'wall' ? { v: r3(q.lvol), s: nV } : null,
      it.kind === 'beam' || it.sk ? { v: r3(q.form), s: nA } : null, it.kind === 'beam' || it.sk ? { v: r3(q.kg), s: 'n2' } : null, (it.kind === 'beam' || it.sk === 'shear' || it.sk === 'rw') && q.untyped ? { v: r3(q.untyped), s: nL } : it.sk === 'col' && q.untyped ? q.untyped + ' column(s) without a type' : null,
    ]);
  }

  // 2. by sheet (measured, before openings from other take-offs and before waste)
  const s2: XCell[][] = [...title('Measured per sheet (before opening deductions and waste)'), [
    { v: 'Sheet', s: 'h' }, { v: 'Heading', s: 'h' }, { v: 'Take-off', s: 'h' }, { v: 'Shapes', s: 'h' }, { v: 'Count (nr)', s: 'h' }, { v: 'Length (m)', s: 'h' }, { v: 'Area (m²)', s: 'h' },
  ]];
  const pages = [...m.shapesByPage.keys()].sort((a, b) => sheetName(a.split('.')[0]).localeCompare(sheetName(b.split('.')[0]), undefined, { numeric: true }));
  for (const pk of pages) {
    const shapes = m.shapesByPage.get(pk)!;
    const byItem = new Map<string, typeof shapes>();
    for (const s of shapes) (byItem.get(s.ti) ?? byItem.set(s.ti, []).get(s.ti)!).push(s);
    const [dwg, pg] = [pk.slice(0, pk.lastIndexOf('.')), Number(pk.slice(pk.lastIndexOf('.') + 1))];
    for (const it of items) {
      const sh = byItem.get(it.id);
      if (!sh) continue;
      // (the whole model but this sheet's shapes: a column counted by its type needs the schedule's types - its
      // length was 0 here - 0.23.2, DeepSeek #13)
      const q = itemQty({ ...m, shapesByItem: new Map([[it.id, sh]]) }, { ...it, ded: [], waste: 0 });
      s2.push([sheetName(dwg) + (pg ? ' p' + (pg + 1) : ''), headingPath(m, it.par), it.name, q.shapes, { v: r3(q.cnt), s: nC(q.cnt) }, { v: r3(q.len), s: nL }, { v: r3(q.area), s: nA }]);
    }
  }

  const sheets: XSheet[] = [
    { name: 'Take-offs', rows: s1, header: 4, widths: [22, 34, 9, 8, 11, 12, 12, 12, 13, 14, 10, 12, 10, 9, 60, 24, 30, 10, 12, 11, 11, 12, 13, 11, 16] },
    { name: 'By sheet', rows: s2, header: 4, widths: [44, 22, 34, 8, 11, 12, 12] },
  ];

  // 2b. every segment of the lengths, walls and beams: its length, tag (beam type), and what it comes to -
  // every figure × the shape's repeat (BH-043: length and wall area were for one repeat, the concrete /
  // formwork / steel beside them for all), as on "By sheet" and "By tag"
  const segRows: XCell[][] = [...title('Segments (× repeat of the shape; before the take-off multiplier, deductions and waste)'), [
    { v: 'Heading', s: 'h' }, { v: 'Take-off', s: 'h' }, { v: 'Type', s: 'h' }, { v: 'Sheet', s: 'h' }, { v: 'Shape', s: 'h' }, { v: 'Segment', s: 'h' },
    { v: 'Length (m)', s: 'h' }, { v: 'Tag / type', s: 'h' }, { v: 'Repeat ×', s: 'h' },
    { v: 'Wall area (m²)', s: 'h' }, { v: 'Openings on it', s: 'h' },
    { v: 'Type W (m)', s: 'h' }, { v: 'Type D / height (m)', s: 'h' }, { v: 'Concrete (m³)', s: 'h' }, { v: 'Formwork (m²)', s: 'h' }, { v: 'Steel (kg)', s: 'h' },
  ]];
  const tagRows: XCell[][] = [...title('Totals by tag / beam type (after the take-off multiplier, before waste)'), [
    { v: 'Heading', s: 'h' }, { v: 'Take-off', s: 'h' }, { v: 'Tag / type', s: 'h' }, { v: 'Segments (columns: number)', s: 'h' }, { v: 'Length (m)', s: 'h' },
    { v: 'Concrete (m³)', s: 'h' }, { v: 'Formwork (m²)', s: 'h' }, { v: 'Steel (kg)', s: 'h' },
  ]];
  const tagName0 = (t: string) => (t.startsWith('bt:') ? m.beamTypeById.get(t)?.name ?? '(type removed)' : t.startsWith('wt:') ? m.wallTypeById.get(t)?.name ?? '(type removed)' : t.startsWith('ct:') ? m.colTypeById.get(t)?.name ?? '(type removed)' : t.startsWith('st:') ? m.swTypeById.get(t)?.name ?? '(type removed)' : t.startsWith('ft:') ? m.ftgTypeById.get(t)?.name ?? '(type removed)' : t.startsWith('rt:') ? m.rwTypeById.get(t)?.name ?? '(type removed)' : t.startsWith('sy:') ? m.stairTypeById.get(t)?.name ?? '(type removed)' : t);
  // (v0.18.1 a segment with figures of its own: its type and "own"; a stair's parts by type: "ST1 flights")
  const tagName = (t: string) => { if (hasTagOwn(t)) return (tagBase(t) ? tagName0(tagBase(t)!) : 'take-off’s type') + ' (own figures)'; const bar = t.indexOf('|'); return bar >= 0 ? tagName0(t.slice(0, bar)) + (t.endsWith('|l') ? ' landings' : ' flights') : tagName0(t); };
  for (const it of items) {
    // (v0.17 columns: by type in "By tag" - their segments are points)
    if (it.sk === 'col' || it.sk === 'sw' || it.sk === 'ftg' || it.sk === 'stair') {
      const q = m.qty.get(it.id)!;
      for (const [t, e] of q.byTag) tagRows.push([headingPath(m, it.par), it.name, t ? tagName(t) : '(no type)', r3(e.segs), { v: r3(e.len), s: nL }, { v: r3(e.vol), s: nV }, { v: r3(e.form), s: nA }, { v: r3(e.kg), s: 'n2' }]);
      continue;
    }
    if (!isLineKind(it.kind)) continue;
    const shapes = m.shapesByItem.get(it.id) ?? [];
    shapes.forEach((sh, si) => {
      if (sh.k !== 'line') return;
      const sl = segLensAt(m, sh);
      const opsOn = m.openingsByShape.get(sh.id) ?? [];
      sl.lens.forEach((L, i) => {
        const tag = sh.sg[i] ?? null;
        // (v0.17 a shear wall's segment: its type's thickness × the height, both faces; an upstand: its full depth)
        const wt = isConcWall(it.sk) ? wallTypeOf(m, it, tag) : null;
        const bt0 = it.kind === 'beam' ? beamTypeOf(m, it, tag) : wt;
        // (v0.18.1 the segment's own figures, else the shape's, else its type's)
        const own = tagOwn(tag);
        const bw = own.w ?? sh.xw ?? bt0?.w ?? null, bdd = own.d ?? sh.xd ?? bt0?.d ?? null, br = own.r ?? sh.xr ?? bt0?.r ?? null;
        const bt = bt0 || own.w || sh.xw ? { name: bt0?.name ?? '', w: bw, d: wt ? null : bdd, r: br } : null;
        const hh = isConcWall(it.sk) ? sh.xh ?? it.h : it.h;
        const dd = wt || isConcWall(it.sk) ? hh ?? null : bt?.d ? Math.max(0, bt.d - (it.st ?? 0)) : null;
        const vol = L !== null && bt?.w && dd !== null ? L * bt.w * dd : null;
        const here = opsOn.filter((o) => o.seg === i).map((o) => {
          const z = openingSize(m, o);
          const d = o.door ? m.doorById.get(o.door) : null;
          return (o.k === 'door' ? 'Door ' + (d?.tag ?? o.tag ?? '') : 'Opening' + (o.tag ? ' ' + o.tag : '')) + (z.w && z.h ? ` ${z.w}×${z.h}` : '');
        });
        segRows.push([
          headingPath(m, it.par), it.name, itemKindLabel(it), sheetName(sh.dwg) + (sh.pg ? ' p' + (sh.pg + 1) : ''), si + 1, i + 1,
          L !== null ? { v: r3(L * sh.m), s: nL } : 'no scale', tag ? tagName(tag) : bt ? bt.name + ' (default)' : null, sh.m !== 1 ? sh.m : null,
          it.kind === 'wall' && hh && L !== null ? { v: r3(L * hh * sh.m), s: nA } : null, here.join('; ') || null,
          bt?.w ?? null, bt?.d ?? null, vol !== null ? { v: r3(vol * sh.m), s: nV } : null,
          vol !== null && bt?.w ? { v: r3(L! * (wt ? 2 * dd! : it.up ? 2 * dd! : bt.w + 2 * dd!) * sh.m), s: nA } : null, vol !== null ? { v: r3(vol * (bt!.r ?? it.sr ?? 0) * sh.m), s: 'n2' } : null,
        ]);
      });
    });
    const q = m.qty.get(it.id)!;
    for (const [t, e] of q.byTag) {
      tagRows.push([headingPath(m, it.par), it.name, t ? tagName(t) : '(no type)', r3(e.segs), { v: r3(e.len), s: nL },
        it.kind === 'beam' || it.sk ? { v: r3(e.vol), s: nV } : null, it.kind === 'beam' || it.sk ? { v: r3(e.form), s: nA } : null, it.kind === 'beam' || it.sk ? { v: r3(e.kg), s: 'n2' } : null]);
    }
  }
  if (segRows.length > 4) sheets.push({ name: 'Segments', rows: segRows, header: 4, widths: [22, 30, 8, 40, 7, 9, 12, 22, 9, 13, 40, 10, 10, 13, 13, 12] });
  if (tagRows.length > 4) sheets.push({ name: 'By tag', rows: tagRows, header: 4, widths: [22, 30, 24, 10, 12, 13, 13, 12] });

  // 2c. doors and openings on the walls
  if (m.doors.length || m.openings.length) {
    const dRows: XCell[][] = [...title('Door schedule - doors on walls and doors not on walls'), [
      { v: 'Tag', s: 'h' }, { v: 'Description', s: 'h' }, { v: 'Location', s: 'h' }, { v: 'Structural W (m)', s: 'h' }, { v: 'Structural H (m)', s: 'h' },
      { v: 'Clear W (m)', s: 'h' }, { v: 'Clear H (m)', s: 'h' }, { v: 'Counted (nr)', s: 'h' }, { v: 'Linked to', s: 'h' },
    ]];
    for (const d of m.doors) dRows.push([d.tag, d.desc, d.loc, d.sw, d.sh, d.cw, d.ch, r3(m.doorCount.get(d.id) ?? 0), linkText(d.id) || null]);
    const oRows: XCell[][] = [...title('Doors and openings placed on walls'), [
      { v: 'Wall take-off', s: 'h' }, { v: 'Sheet', s: 'h' }, { v: 'Segment', s: 'h' }, { v: 'Kind', s: 'h' }, { v: 'Tag', s: 'h' }, { v: 'W (m)', s: 'h' }, { v: 'H (m)', s: 'h' },
      { v: 'Area (m²)', s: 'h' }, { v: 'Repeat ×', s: 'h' }, { v: 'Lintel length (m)', s: 'h' }, { v: 'Lintel (m³)', s: 'h' },
    ]];
    for (const o of m.openings) {
      const sh = m.shapes.find((x) => x.id === o.sh);
      const it = sh ? m.itemById.get(sh.ti) : null;
      if (!sh || !it || it.priv) continue;
      const z = openingSize(m, o);
      const d = o.door ? m.doorById.get(o.door) : null;
      const lb = it.lb ?? LINTEL_DEFAULT.lb, ld = it.ld ?? LINTEL_DEFAULT.ld, lw = it.d ?? it.lw ?? LINTEL_DEFAULT.lw;
      const ll = o.lint && z.w ? z.w + 2 * lb : null;
      oRows.push([it.name, sheetName(sh.dwg) + (sh.pg ? ' p' + (sh.pg + 1) : ''), o.seg + 1, o.k === 'door' ? (o.uns ? 'Door (not in the schedule)' : 'Door') : 'Opening', d?.tag ?? o.tag ?? '', z.w, z.h,
        z.w && z.h ? { v: r3(z.w * z.h), s: nA } : null, sh.m !== 1 ? sh.m : null, ll !== null ? { v: r3(ll), s: nL } : null, ll !== null ? { v: r3(ll * lw * ld), s: nV } : null]);
    }
    if (m.doors.length) sheets.push({ name: 'Doors', rows: dRows, header: 4, widths: [10, 34, 22, 14, 14, 12, 12, 12, 60] });
    if (oRows.length > 4) sheets.push({ name: 'Openings', rows: oRows, header: 4, widths: [30, 40, 9, 24, 10, 9, 9, 11, 9, 14, 12] });
  }

  // 3. against the BOQ
  if (m.boqById.size) {
    const s3: XCell[][] = [...title('BOQ lines with take-off quantities'), [
      { v: 'Section', s: 'h' }, { v: 'Ref', s: 'h' }, { v: 'Description', s: 'h' }, { v: 'Unit', s: 'h' }, { v: 'BOQ qty', s: 'h' }, { v: 'Take-off qty', s: 'h' },
      { v: 'Difference', s: 'h' }, { v: 'Difference %', s: 'h' }, { v: 'From', s: 'h' },
    ]];
    // in the BOQ's own order (as on the screen), not the order the lines reached this PC
    for (const b of flattenMirror(m)) {
      if (b.bt !== 'item') continue;
      const t = m.boqQty.get(b.id);
      if (!t) continue;
      const diff = b.qty !== null ? t.total - b.qty : null;
      s3.push([
        mirrorPath(m, b.id), b.ref, b.desc, b.unit, b.qty !== null ? { v: b.qty, s: 'n2' } : null, { v: r3(t.total), s: nU(b.unit, t.total) },
        diff !== null ? { v: r3(diff), s: nU(b.unit, diff) } : null, diff !== null && b.qty ? { v: r2(diff / b.qty * 10000) / 10000, s: 'pct' } : null,
        t.parts.map((p) => `${p.item.name} (${MEASURE_LABEL[p.link.q]}${p.link.f !== 1 ? ' ×' + p.link.f : ''}: ${shown(p.v, p.link.q)} ${MEASURE_UNIT[p.link.q]})`).join('; '),
      ]);
    }
    sheets.push({ name: 'BOQ', rows: s3, header: 4, widths: [40, 9, 60, 7, 12, 13, 12, 12, 70] });
  }
  if (m.dummies.length) {
    const s4: XCell[][] = [...title('Temporary lines (made before the BOQ was available)'), [
      { v: 'Ref', s: 'h' }, { v: 'Description', s: 'h' }, { v: 'Unit', s: 'h' }, { v: 'Take-off qty', s: 'h' }, { v: 'Matched to BOQ line', s: 'h' },
    ]];
    for (const d of m.dummies) {
      const t = m.targets.get(d.id);
      const real = d.map ? m.boqById.get(d.map) : null;
      s4.push([d.ref, d.desc, d.unit, t ? { v: r3(t.total), s: nU(d.unit, t.total) } : null, real ? (real.ref ? real.ref + ' ' : '') + real.desc : d.map ? '(line removed)' : 'not matched yet']);
    }
    sheets.push({ name: 'Temporary lines', rows: s4, header: 4, widths: [9, 60, 7, 13, 70] });
  }
  // 4. finishes (v0.16): one row per room × finish (and take-offs with a finish code), and the totals per code
  if (m.fin && (m.fin.atoms.length || m.fin.uncoded.length)) {
    const fRows: XCell[][] = [...title('Finishes - one row per room × finish (Times included)'), [
      { v: 'Heading', s: 'h' }, { v: 'Room', s: 'h' }, { v: 'Description', s: 'h' }, { v: 'Finish type', s: 'h' }, { v: 'Finish', s: 'h' }, { v: 'Code', s: 'h' },
      { v: 'Quantity', s: 'h' }, { v: 'Unit', s: 'h' }, { v: 'Times', s: 'h' }, { v: 'BOQ link', s: 'h' }, { v: 'Note', s: 'h' },
    ]];
    const nQ = (unit: string, x: number): XStyle => (unit === 'm' ? nL : unit === 'm³' ? nV : unit === 'nr' ? nC(x) : unit === 'kg' ? 'n2' : nA);
    const byId = new Map([...m.fin.atoms, ...m.fin.uncoded].map((a) => [a.id, a]));
    const row = (a: (typeof m.fin.atoms)[number], times: number | null) => fRows.push([
      headingPath(m, a.head), a.roomName || null, a.desc || null, a.role === 'takeoff' ? 'Take-off' : a.type, a.label + (a.role === 'add' ? ' (additional)' : a.role === 'link' ? ' (linked take-off)' : ''), a.code || null,
      { v: r3(a.qty), s: nQ(a.unit, a.qty) }, a.unit, times !== null && times !== 1 ? times : null,
      a.code ? atomLinkText(m, a) || 'not linked' : 'no code (not in the summary)',
      [a.flags.includes('over') ? 'deductions larger than the finish: 0' : '', a.flags.includes('twoLinks') ? 'under two links: counted in the older' : '',
        a.role === 'link' && (m.fin.qty.get(a.room)?.timesDiffer ?? []).includes(a.src[1] ?? '') ? 'Times differs from the room’s (×' + (m.fin.roomById.get(a.room)?.times ?? 1) + ')' : ''].filter(Boolean).join('; ') || null,
    ]);
    for (const r of m.fin.rooms) {
      if (r.it.priv) continue;
      for (const f of m.fin.qty.get(r.id)?.finishes ?? []) { const a = byId.get(r.id + '/' + f.key); if (a) row(a, f.role === 'link' ? null : r.times); }
    }
    for (const it of items) { const a = byId.get(it.id); if (a && a.role === 'takeoff') row(a, null); }
    sheets.push({ name: 'Finishes', rows: fRows, header: 4, widths: [30, 26, 24, 14, 34, 12, 13, 7, 8, 50, 34] });
    const cRows: XCell[][] = [...title('Finishes - total per code'), [
      { v: 'Code', s: 'h' }, { v: 'Unit', s: 'h' }, { v: 'Total', s: 'h' }, { v: 'Linked', s: 'h' }, { v: 'Not linked', s: 'h' }, { v: 'Rooms', s: 'h' }, { v: 'Linked to', s: 'h' }, { v: 'Note', s: 'h' },
    ]];
    const two = new Set(m.fin.warnings.map((w) => w.code));
    for (const r of summarize(m).rows) {
      const rooms = new Set(r.atoms.map((id) => m.fin.atomById.get(id)!.room).filter(Boolean));
      // (the links over this row's own atoms - a link made on the bare waterproofing code covers the split rows)
      const mine = new Set(r.atoms.map((id) => m.fin.atomById.get(id)!.link).filter(Boolean));
      const links = m.fin.links.filter((l) => mine.has(l.id));
      const to = (t: string) => { const b = t.startsWith('b:') ? m.boqById.get(t.slice(2)) : m.dummyById.get(t); return b ? (b.ref ? b.ref + ' ' : '') + b.desc.slice(0, 50) : '(line removed)'; };
      cRows.push([r.code, r.unit, { v: r3(r.qty), s: nQ(r.unit, r.qty) }, { v: r3(r.linked), s: nQ(r.unit, r.linked) }, { v: r3(r.unlinked), s: nQ(r.unit, r.unlinked) }, rooms.size || null,
        links.map((l) => `${l.label} → ${to(l.to)}: ${shown(l.qty, l.unit === 'm' ? 'len' : l.unit === 'm³' ? 'vol' : l.unit === 'nr' ? 'cnt' : 'area')} ${l.unit}`).join('; ') || null,
        [two.has(r.code) ? 'this code is used in more than one unit' : '', r.twoLinks ? 'part of it is under two links (counted in the older)' : ''].filter(Boolean).join('; ') || null]);
    }
    sheets.push({ name: 'Finishes by code', rows: cRows, header: 4, widths: [14, 7, 13, 13, 13, 8, 80, 40] });
  }
  return writeXlsx(sheets);
}
