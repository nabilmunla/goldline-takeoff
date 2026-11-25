// Journal line format:  <crc32 hex, 8 chars><space><JSON batch>\n
// A line that is incomplete (no newline yet) is left for the next read.
// A line whose checksum does not match is skipped and counted, never applied.
import { crc32hex } from './crc32';
import type { Batch, Op } from './types';

export function encodeLine(b: Batch): string {
  const json = JSON.stringify(b);
  return crc32hex(json) + ' ' + json + '\n';
}

export function decodeLine(line: string): Batch | null {
  if (line.length < 10 || line[8] !== ' ') return null;
  const crc = line.slice(0, 8);
  const json = line.slice(9);
  if (crc32hex(json) !== crc) return null;
  try {
    const b = JSON.parse(json) as Batch;
    if (!b || typeof b.s !== 'string' || !STAMP_RE.test(b.s) || typeof b.w !== 'string' || !Array.isArray(b.o)) return null;
    // every change must be [entity, field, value] with a plain value: a malformed line written by
    // something else must never be half-applied
    for (const op of b.o) {
      if (!Array.isArray(op) || op.length !== 3 || typeof op[0] !== 'string' || typeof op[1] !== 'string') return null;
      const v = op[2];
      if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null;
      if (typeof v === 'number' && !Number.isFinite(v)) return null; // (1e400 reads as Infinity)
    }
    return b;
  } catch {
    return null;
  }
}

/** a stamp: 9 base-36 digits of time, 5 of counter, then the writer */
const STAMP_RE = /^[0-9a-z]{9}\.[0-9a-z]{5}\.\S+$/;

const dec = new TextDecoder('utf-8');

/**
 * Split raw bytes into complete lines. Returns the decoded batches, the number
 * of bytes consumed (up to and including the last newline) and a count of bad lines.
 */
export function splitBytes(data: Uint8Array): { batches: Batch[]; consumed: number; bad: number; badRanges: [number, number][] } {
  const last = data.lastIndexOf(0x0a);
  if (last < 0) return { batches: [], consumed: 0, bad: 0, badRanges: [] };
  const batches: Batch[] = [];
  const badRanges: [number, number][] = [];
  // line by line on the bytes, so an unreadable line is known by where it is (read again later:
  // only that line, not the whole file)
  for (let start = 0; start <= last; ) {
    const nl = data.indexOf(0x0a, start);
    if (nl > start) {
      const b = decodeLine(dec.decode(data.subarray(start, nl)));
      if (b) batches.push(b);
      else badRanges.push([start, nl + 1]);
    }
    start = nl + 1;
  }
  return { batches, consumed: last + 1, bad: badRanges.length, badRanges };
}

/**
 * The ops of a frozen copy (a revision or a backup: `ents` = [[id, [[field, value], ...]], ...]), keeping
 * only well-formed entries with plain values - a damaged or hand-edited file never feeds the engine
 * an object, a list or Infinity.
 */
export function entsToOps(ents: unknown): Op[] {
  const ops: Op[] = [];
  if (!Array.isArray(ents)) return ops;
  for (const e of ents) {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || !Array.isArray(e[1])) continue;
    for (const fv of e[1]) {
      if (!Array.isArray(fv) || typeof fv[0] !== 'string') continue;
      const v = fv[1];
      if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) ops.push([e[0], fv[0], v]);
    }
  }
  return ops;
}
