// The merged state of a project.
// Every field of every entity is a "last writer wins" register keyed by stamp.
// Applying the same batches in ANY order gives the same result, and applying a
// batch twice changes nothing. That is what makes the shared-folder design safe:
// duplicates and out-of-order reads cannot corrupt anything.
import type { Batch, Cell, HistEntry, Value } from './types';

export interface Overwrite {
  eid: string;
  field: string;
  prev: Cell;
  next: Cell;
}

export interface ApplyResult {
  changed: Set<string>;
  overwrites: Overwrite[];
  applied: boolean;
}

export class Store {
  readonly ents = new Map<string, Map<string, Cell>>();
  readonly hist = new Map<string, HistEntry[]>();
  private readonly seen = new Set<string>();
  version = 0;
  batchCount = 0;
  /** the biggest stamp applied so far (a writer outside a session observes it before stamping) */
  top = '';
  /** how many times each entity's values changed: lets readers keep what they worked out from one */
  private readonly revs = new Map<string, number>();
  rev(eid: string): number { return this.revs.get(eid) ?? 0; }
  /** the same per kind of entity (the part of the id before ':', e.g. 'ln' for build-up lines) */
  private readonly kindRevs = new Map<string, number>();
  kindRev(kind: string): number { return this.kindRevs.get(kind) ?? 0; }

  hasBatch(stamp: string): boolean {
    return this.seen.has(stamp);
  }

  apply(b: Batch): ApplyResult {
    const changed = new Set<string>();
    const overwrites: Overwrite[] = [];
    if (this.seen.has(b.s)) return { changed, overwrites, applied: false };
    this.seen.add(b.s);
    this.batchCount++;
    if (b.s > this.top) this.top = b.s;
    for (const [eid, field, v] of b.o) {
      let ent = this.ents.get(eid);
      if (!ent) {
        ent = new Map();
        this.ents.set(eid, ent);
      }
      let h = this.hist.get(eid);
      if (!h) {
        h = [];
        this.hist.set(eid, h);
      }
      h.push({ s: b.s, u: b.u, w: b.w, t: b.t, f: field, v, m: b.m, a: b.a });
      const cur = ent.get(field);
      if (!cur || b.s > cur.s) {
        const next: Cell = { v, s: b.s, u: b.u, w: b.w, t: b.t, a: b.a };
        ent.set(field, next);
        if (!cur || cur.v !== v) changed.add(eid);
        if (cur) overwrites.push({ eid, field, prev: cur, next });
      }
    }
    if (changed.size) this.version++;
    for (const eid of changed) {
      this.revs.set(eid, (this.revs.get(eid) ?? 0) + 1);
      const c = eid.indexOf(':');
      const kind = c > 0 ? eid.slice(0, c) : '';
      this.kindRevs.set(kind, (this.kindRevs.get(kind) ?? 0) + 1);
    }
    return { changed, overwrites, applied: true };
  }

  get(eid: string, field: string): Value | undefined {
    return this.ents.get(eid)?.get(field)?.v;
  }

  cell(eid: string, field: string): Cell | undefined {
    return this.ents.get(eid)?.get(field);
  }

  history(eid: string): HistEntry[] {
    const h = this.hist.get(eid) ?? [];
    const ent = this.ents.get(eid);
    return h
      .map((e) => ({ ...e, live: ent?.get(e.f)?.s === e.s }))
      .sort((a, b) => (a.s < b.s ? 1 : a.s > b.s ? -1 : 0));
  }

  /** Value of a field just before a given stamp (for "old -> new" in history) */
  valueBefore(eid: string, field: string, stamp: string): Value | undefined {
    const h = this.hist.get(eid);
    if (!h) return undefined;
    let best: HistEntry | undefined;
    for (const e of h) if (e.f === field && e.s < stamp && (!best || e.s > best.s)) best = e;
    return best?.v;
  }

  /** Deterministic fingerprint of the merged state (used by tests) */
  fingerprint(): string {
    const ids = [...this.ents.keys()].sort();
    const parts: string[] = [];
    for (const id of ids) {
      const ent = this.ents.get(id)!;
      const fs = [...ent.keys()].sort();
      for (const f of fs) parts.push(id + '.' + f + '=' + JSON.stringify(ent.get(f)!.v) + '@' + ent.get(f)!.s);
    }
    let h = 0x811c9dc5;
    const s = parts.join('\n');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16) + ':' + parts.length;
  }
}
