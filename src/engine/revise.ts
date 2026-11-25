// A new issue of the consultant's BOQ: bring the latest page numbers (and item letters) onto
// the project's lines, without touching prices or build-ups.
//
// Lines are matched sheet by sheet: the new issue's sheets are paired with the bills they came
// in as (same sheet name, same bill/file), then the lines of each pair are aligned in order
// (lines with a description found once in both anchor the alignment; repeated descriptions
// such as "Ditto" are paired in order between the anchors; changed wording is paired by
// similarity). Lines that moved to another sheet are found in a last pass.
import type { BoqModel, BoqNode } from './boq';
import { norm, type FilePlan, type SrcRow } from './boqimport';
import type { Op, Value } from './types';
import { randomId } from './ids';
import { pagedLines } from './pages';

export interface IssueLine {
  fi: number;
  si: number;
  row: SrcRow;
  /** bill / sheet it is in, for the report */
  where: string;
}

export interface IssueMatch {
  node: BoqNode;
  line: IssueLine;
  pageChanged: boolean;
  refChanged: boolean;
  qtyChanged: boolean;
  descChanged: boolean;
  /** found in another sheet than the one its bill came from */
  moved: boolean;
}

export interface IssueUpdate {
  matches: IssueMatch[];
  /** in the new issue, not found in the project */
  added: IssueLine[];
  /** in the project (from the consultant's BOQ), not found in the new issue */
  missing: BoqNode[];
  /** new-issue sheets and the project bill they were paired with */
  pairs: { file: string; sheet: string; bill: BoqNode | null; lines: number }[];
}

const keyOf = (kind: 'item' | 'note', desc: string, unit: string) => (kind === 'item' ? 'i|' : 'n|') + norm(desc) + '|' + unit.trim().toLowerCase();
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 1));
function similarSets(x: Set<string>, y: Set<string>, a: string, b: string): number {
  if (!x.size || !y.size) return a.trim() === b.trim() ? 1 : 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

/**
 * Align two key sequences (patience style): equal keys at both ends, keys found once in each
 * as anchors (longest increasing run), recurse between anchors; what is left is paired in order
 * by equal key. Returns index pairs [i in a, j in b], ascending.
 */
export function alignKeys(a: string[], b: string[]): [number, number][] {
  const out: [number, number][] = [];
  const stack: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (stack.length) {
    let [a0, a1, b0, b1] = stack.pop()!;
    const head: [number, number][] = [];
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) head.push([a0++, b0++]);
    const tail: [number, number][] = [];
    while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) tail.unshift([--a1, --b1]);
    out.push(...head, ...tail);
    if (a0 >= a1 || b0 >= b1) continue;
    // unique keys on both sides
    const ca = new Map<string, number>(), cb = new Map<string, number>();
    for (let i = a0; i < a1; i++) ca.set(a[i], ca.has(a[i]) ? -1 : i);
    for (let j = b0; j < b1; j++) cb.set(b[j], cb.has(b[j]) ? -1 : j);
    const cand: [number, number][] = [];
    for (let i = a0; i < a1; i++) {
      const ia = ca.get(a[i])!, jb = cb.get(a[i]);
      if (ia >= 0 && jb !== undefined && jb >= 0) cand.push([ia, jb]);
    }
    if (cand.length) {
      // longest increasing subsequence on j
      const tails: number[] = [], prev = new Array<number>(cand.length).fill(-1);
      for (let k = 0; k < cand.length; k++) {
        let lo = 0, hi = tails.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (cand[tails[m]][1] < cand[k][1]) lo = m + 1; else hi = m; }
        if (lo > 0) prev[k] = tails[lo - 1];
        tails[lo] = k;
      }
      const lis: [number, number][] = [];
      for (let k = tails[tails.length - 1]; k >= 0; k = prev[k]) lis.unshift(cand[k]);
      let pa = a0, pb = b0;
      for (const [i, j] of lis) {
        out.push([i, j]);
        if (pa < i && pb < j) stack.push([pa, i, pb, j]);
        pa = i + 1; pb = j + 1;
      }
      if (pa < a1 && pb < b1) stack.push([pa, a1, pb, b1]);
      continue;
    }
    // no unique keys: pair equal keys in order
    let j = b0;
    for (let i = a0; i < a1 && j < b1; i++) {
      let k = j;
      while (k < b1 && k - j < 60 && b[k] !== a[i]) k++;
      if (k < b1 && b[k] === a[i]) { out.push([i, k]); j = k + 1; }
    }
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/** the project's bills/sections that came from a sheet, with the file and sheet names from the import record */
function projectSheets(model: BoqModel, store: { get(id: string, f: string): unknown }) {
  const recs = new Map<string, { name: string; sheets: { name: string }[] }[] | null>();
  const rec = (imp: string) => {
    if (!recs.has(imp)) {
      try { recs.set(imp, JSON.parse(String(store.get('imp:' + imp, 'files') ?? 'null'))); } catch { recs.set(imp, null); }
    }
    return recs.get(imp);
  };
  const out: { node: BoqNode; file: string; fileRef: string; sheet: string; lines: BoqNode[] }[] = [];
  const walk = (list: BoqNode[], fileNode: BoqNode | null) => {
    for (const n of list) {
      if (n.type !== 'group' || n.deleted) continue;
      const parts = n.src.split(':');
      if (parts.length === 3) {
        const files = rec(parts[0]);
        const f = files?.[Number(parts[1])];
        out.push({ node: n, file: f?.name ?? '', fileRef: fileNode?.ref ?? '', sheet: f?.sheets[Number(parts[2])]?.name ?? n.desc, lines: pagedLines(model, n).filter((l) => !l.deleted && l.src) });
        continue;
      }
      walk(n.children, parts.length === 2 ? n : fileNode);
    }
  };
  walk(model.roots, null);
  return out;
}

const nk = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const billNo = (s: string) => /\bbill\s*(?:no\.?\s*)?0*(\d+)/i.exec(s)?.[1] ?? '';

export function matchIssue(model: BoqModel, store: { get(id: string, f: string): unknown }, files: FilePlan[]): IssueUpdate {
  const proj = projectSheets(model, store);
  const used = new Set<number>();
  const pairs: IssueUpdate['pairs'] = [];
  const matches: IssueMatch[] = [];
  const added: IssueLine[] = [];
  const matched = new Set<string>();

  const issueSheets: { fi: number; si: number; file: FilePlan; lines: IssueLine[] }[] = [];
  files.forEach((f, fi) => f.sheets.forEach((s, si) => {
    if (!s.include || !s.cols) return;
    const where = [f.ref, s.name.trim()].filter(Boolean).join(' · ');
    issueSheets.push({ fi, si, file: f, lines: s.rows.filter((r) => r.kind === 'item' || r.kind === 'note').map((row) => ({ fi, si, row, where })) });
  }));

  // pair sheets globally, best score first: the same sheet name ("CONCRETE WORKS") is in every
  // tower's file, so the bill number decides - and two different bill numbers never pair
  const cand: { i: number; k: number; sc: number }[] = [];
  issueSheets.forEach((is, i) => {
    const sp = is.file.sheets[is.si];
    const bnIssue = billNo(is.file.ref + ' ' + is.file.title + ' ' + is.file.name);
    proj.forEach((p, k) => {
      const bnProj = billNo(p.fileRef + ' ' + p.file);
      if (bnIssue && bnProj && bnIssue !== bnProj) return;
      let sc = 0;
      if (nk(p.sheet) === nk(sp.name)) sc += 3;
      if (bnIssue && bnIssue === bnProj) sc += 2;
      if (sp.ref && nk(sp.ref) === nk(p.node.ref)) sc += 1;
      if (nk(sp.title) === nk(p.node.desc)) sc += 1;
      if (sc >= 3) cand.push({ i, k, sc });
    });
  });
  cand.sort((x, y) => y.sc - x.sc || x.i - y.i || x.k - y.k);
  const pairOf = new Map<number, number>();
  for (const c of cand) {
    if (pairOf.has(c.i) || used.has(c.k)) continue;
    pairOf.set(c.i, c.k);
    used.add(c.k);
  }

  const wordCache = new Map<string, Set<string>>();
  const wordsOf = (t: string) => { let w = wordCache.get(t); if (!w) { w = words(t); wordCache.set(t, w); } return w; };
  issueSheets.forEach((is, isi) => {
    const sp = is.file.sheets[is.si];
    const pk = pairOf.get(isi);
    const p = pk === undefined ? null : proj[pk];
    pairs.push({ file: is.file.name, sheet: sp.name, bill: p?.node ?? null, lines: is.lines.length });
    if (!p) { added.push(...is.lines); return; }
    const a = p.lines.map((n) => keyOf(n.type === 'item' ? 'item' : 'note', n.desc, n.unit));
    const b = is.lines.map((l) => keyOf(l.row.kind === 'item' ? 'item' : 'note', l.row.desc, l.row.unit));
    const al = alignKeys(a, b);
    const ja = new Map<number, number>();
    for (const [i, j] of al) ja.set(i, j);
    // the next aligned line after each line (one pass from the end, not a search per line)
    const nextAligned = new Array<number>(a.length + 1).fill(b.length);
    for (let i = a.length - 1; i >= 0; i--) nextAligned[i] = ja.has(i + 1) ? ja.get(i + 1)! : nextAligned[i + 1];
    // fill the gaps between aligned lines by similar wording
    const takenB = new Set(al.map((x) => x[1]));
    let lastJ = -1;
    for (let i = 0; i < a.length; i++) {
      if (ja.has(i)) { lastJ = ja.get(i)!; continue; }
      const nextJ = nextAligned[i];
      let bestJ = -1, bestS = 0.5;
      const n = p.lines[i];
      for (let j = lastJ + 1; j < nextJ && j - lastJ < 80; j++) {
        if (takenB.has(j)) continue;
        const r = is.lines[j].row;
        if ((n.type === 'item') !== (r.kind === 'item')) continue;
        if (n.type === 'item' && n.unit.trim().toLowerCase() !== r.unit.trim().toLowerCase()) continue;
        const sc = similarSets(wordsOf(n.desc), wordsOf(r.desc), n.desc, r.desc);
        if (sc > bestS) { bestS = sc; bestJ = j; }
      }
      if (bestJ >= 0) { ja.set(i, bestJ); takenB.add(bestJ); lastJ = bestJ; }
    }
    for (const [i, j] of ja) {
      matched.add(p.lines[i].id);
      matches.push(mk(p.lines[i], is.lines[j], false));
    }
    is.lines.forEach((l, j) => { if (!takenB.has(j)) added.push(l); });
  });

  // lines that moved to another sheet of the same bill: same wording found once among what is left
  // on both sides (the bill number is part of the key: Tower B's lines never "move" into Tower A)
  const billOfLine = new Map<string, string>();
  for (const p of proj) { const bn = billNo(p.fileRef + ' ' + p.file); for (const l of p.lines) billOfLine.set(l.id, bn); }
  const billOfFile = files.map((f) => billNo(f.ref + ' ' + f.title + ' ' + f.name));
  let missing = proj.flatMap((p) => p.lines).filter((n) => !matched.has(n.id));
  const left = new Map<string, number[]>();
  added.forEach((l, k) => { const key = billOfFile[l.fi] + '#' + keyOf(l.row.kind === 'item' ? 'item' : 'note', l.row.desc, l.row.unit); left.set(key, [...(left.get(key) ?? []), k]); });
  const mkey = new Map<string, number>();
  for (const n of missing) { const key = (billOfLine.get(n.id) ?? '') + '#' + keyOf(n.type === 'item' ? 'item' : 'note', n.desc, n.unit); mkey.set(key, (mkey.get(key) ?? 0) + 1); }
  const gone = new Set<number>();
  for (const n of missing) {
    if (n.type !== 'item' || n.desc.trim().length < 12) continue;
    const key = (billOfLine.get(n.id) ?? '') + '#' + keyOf('item', n.desc, n.unit);
    const ks = left.get(key);
    if (ks?.length !== 1 || mkey.get(key) !== 1) continue;
    matches.push(mk(n, added[ks[0]], true));
    matched.add(n.id);
    gone.add(ks[0]);
  }
  missing = missing.filter((n) => !matched.has(n.id));
  return { matches, added: added.filter((_l, k) => !gone.has(k)), missing, pairs };
}

function mk(node: BoqNode, line: IssueLine, moved: boolean): IssueMatch {
  const r = line.row;
  return {
    node,
    line,
    moved,
    pageChanged: node.page !== r.page || node.pageEst !== !!r.pest,
    refChanged: node.ref !== r.ref,
    // against the consultant's quantity as imported (a lump sum has none: blank stays blank)
    qtyChanged: node.type === 'item' && r.kind === 'item' && node.q0 !== r.qty,
    descChanged: node.desc.replace(/\s+/g, ' ').trim() !== r.desc.replace(/\s+/g, ' ').trim(),
  };
}

export interface IssueApply {
  refs: boolean;
  qty: boolean;
  by: string;
}

/** the changes: page (and item letters, quantities if asked) on the matched lines, and a new import record */
export function issueOps(u: IssueUpdate, files: FilePlan[], o: IssueApply): { ops: Op[]; pages: number; refs: number; qty: number } {
  const importId = randomId(8);
  const ops: Op[] = [];
  let pages = 0, refs = 0, qty = 0;
  for (const m of u.matches) {
    const r = m.line.row, id = m.node.id;
    if (m.node.page !== r.page) { ops.push([id, 'page', r.page]); pages++; }
    if (m.node.pageEst !== !!r.pest) ops.push([id, 'pe', r.pest ? true : null]);
    if (o.refs && m.refChanged) { ops.push([id, 'ref', r.ref]); refs++; }
    if (o.qty && m.qtyChanged && m.node.type === 'item') {
      // our own quantity typed over the BOQ quantity stays; the BOQ quantity follows the issue
      ops.push([id, 'q0', r.qty as Value]);
      if (m.node.qty === m.node.q0) ops.push([id, 'qty', r.qty as Value]);
      qty++;
    }
    // the line now points at the new issue (for writing rates back, and the next update)
    ops.push([id, 'src', `${importId}:${m.line.fi}:${m.line.si}:${r.r}`]);
  }
  ops.push(['imp:' + importId, 'when', Date.now()]);
  ops.push(['imp:' + importId, 'by', o.by]);
  ops.push(['imp:' + importId, 'kind', 'issue']);
  ops.push(['imp:' + importId, 'files', JSON.stringify(files.map((f) => ({
    name: f.name,
    sheets: f.sheets.map((s) => (s.include && s.cols ? { name: s.name, headerRow: s.headerRow, cols: s.cols } : { name: s.name })),
  })))]);
  return { ops, pages, refs, qty };
}
