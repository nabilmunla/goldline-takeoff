// Auto-count by tag (v0.15): the tags written on a sheet (door marks D01, fixture codes SD-1, ...) found in
// its text, each one a proposed count the person keeps or leaves out. (Symbols without text: 0.15.1.)
import type { Pt } from './geometry';

export interface Word { t: string; x0: number; y0: number; x1: number; y1: number }
export type TagMode = 'exact' | 'starts' | 'contains';
export interface Found {
  /** the text as written ("D01", "D 01" joined) */
  text: string;
  /** its middle, sheet points */
  p: Pt;
  x0: number; y0: number; x1: number; y1: number;
}

/**
 * tags compared without case, spaces or the usual separators: "d-01" = "D01" = "D 01" - except between
 * two numbers, as door tags (model.ts doorTagKey): D1.1 and D11 are two tags, not one count
 */
export const tagKey = (s: string) => s.toUpperCase().trim()
  .replace(/(\d)[\s\-_./]+(?=\d)/g, '$1.')
  .replace(/[\s\-_/]+/g, '')
  .replace(/(?<!\d)\.|\.(?!\d)/g, '');

/** the next word continues this one: right next to it (a tag drawn as "D" and "01") */
function touches(a: Word, b: Word): boolean {
  const ha = Math.min(a.x1 - a.x0, a.y1 - a.y0) || 1, hb = Math.min(b.x1 - b.x0, b.y1 - b.y0) || 1;
  const h = Math.max(ha, hb, 1);
  const gx = Math.max(0, b.x0 - a.x1, a.x0 - b.x1), gy = Math.max(0, b.y0 - a.y1, a.y0 - b.y1);
  return Math.hypot(gx, gy) <= 0.9 * h;
}

/**
 * Where a tag is written on a sheet. exact: the whole word (or 2-3 touching words) is the tag;
 * starts: words beginning with it ("D" finds D01, D02, ... - not DOOR SCHEDULE: at most 6 more characters);
 * contains: words with it inside. The same text drawn twice on top of itself (bold in CAD exports) is one.
 */
export function findTags(words: Word[], q: string, mode: TagMode): Found[] {
  const nq = tagKey(q);
  if (!nq) return [];
  // starts: what follows the tag is short and has a number in it (D -> D01, D12A; not DOOR, not D alone)
  const ok = (k: string) => (mode === 'exact' ? k === nq : mode === 'starts' ? k.startsWith(nq) && k.length > nq.length && k.length <= nq.length + 6 && /\d/.test(k.slice(nq.length)) : k.includes(nq));
  const out: Found[] = [];
  const used = new Set<number>();
  const take = (from: number, to: number, text: string) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let j = from; j <= to; j++) { const w = words[j]; x0 = Math.min(x0, w.x0); y0 = Math.min(y0, w.y0); x1 = Math.max(x1, w.x1); y1 = Math.max(y1, w.y1); used.add(j); }
    out.push({ text, p: [(x0 + x1) / 2, (y0 + y1) / 2], x0, y0, x1, y1 });
  };
  for (let i = 0; i < words.length; i++) {
    if (used.has(i)) continue;
    // a tag drawn in pieces that touch ("D" + "01"): read together - the longest that is the tag, and
    // only when the first piece is not the tag on its own
    let done = false;
    if (mode !== 'contains' && !ok(tagKey(words[i].t))) {
      for (let len = 3; len >= 2 && !done; len--) {
        const j = i + len - 1;
        if (j >= words.length) continue;
        let fine = true;
        for (let x = i + 1; x <= j && fine; x++) if (used.has(x) || !touches(words[x - 1], words[x])) fine = false;
        // not when what follows is a tag on its own: "DOOR" + "D01" a space apart (no space character in
        // the PDF) read "DOORD01", and a stacked tag "D-B" over "DRT05" read "D-BDRT05" - D01 / DRT05 lost
        for (let x = i + 1; x <= j && fine; x++) if (ok(tagKey(words.slice(x, j + 1).map((w) => w.t).join('')))) fine = false;
        if (!fine) continue;
        const t = words.slice(i, j + 1).map((w) => w.t).join('');
        if (ok(tagKey(t))) { take(i, j, t); done = true; }
      }
    }
    if (done) continue;
    const k = tagKey(words[i].t);
    if (k && ok(k)) take(i, i, words[i].t);
  }
  // the same text drawn on top of itself: once (compared within the same tag only - comparing every pair,
  // with the key worked out each time, took 0.4 s for "0" on a GA plan's 1,000 finds)
  const kept: Found[] = [];
  const byKey = new Map<string, Found[]>();
  for (const f of out) {
    const h = Math.max(1, Math.min(f.x1 - f.x0, f.y1 - f.y0));
    const k = tagKey(f.text);
    const same = byKey.get(k) ?? byKey.set(k, []).get(k)!;
    if (same.some((g) => Math.hypot(g.p[0] - f.p[0], g.p[1] - f.p[1]) < 0.8 * h)) continue;
    same.push(f);
    kept.push(f);
  }
  return kept;
}

/** what was found, by tag: D01 ×12, D02 ×5 ... (most first) */
export function byTag(found: Found[]): { key: string; text: string; n: number }[] {
  const m = new Map<string, { key: string; text: string; n: number }>();
  for (const f of found) {
    const k = tagKey(f.text);
    const e = m.get(k) ?? m.set(k, { key: k, text: f.text.replace(/\s+/g, ''), n: 0 }).get(k)!;
    e.n++;
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.text.localeCompare(b.text, undefined, { numeric: true }));
}
