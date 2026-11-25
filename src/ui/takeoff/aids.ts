// v0.16 drawing aids, one setting on this PC for every take-off (like Display, numfmt.ts): ortho (F8),
// the crosshair lines, the magnifier (M; its magnification with Alt+wheel). Ortho, the crosshair and
// the magnification are remembered; the magnifier itself starts off.
import { useEffect, useState } from 'react';

export interface Aids {
  /** horizontal / vertical only while drawing (Shift = for the moment) */
  ortho: boolean;
  /** full-width / full-height lines through the pointer */
  cross: boolean;
  /** the loupe next to the pointer */
  loupe: boolean;
  /** its magnification, 2..8 */
  zoom: number;
}

const KEY = 'qto.aids';
export const ZOOM_MIN = 2, ZOOM_MAX = 8;

function read(): Aids {
  let j: Partial<Aids> = {};
  try { j = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { j = {}; }
  const z = typeof j.zoom === 'number' && j.zoom >= ZOOM_MIN && j.zoom <= ZOOM_MAX ? j.zoom : 3;
  return { ortho: j.ortho === true, cross: j.cross === true, loupe: false, zoom: z };
}

let cur: Aids = read();
const subs = new Set<(a: Aids) => void>();

/** the aids now (canvas code outside React) */
export const aids = () => cur;

export function setAids(patch: Partial<Aids>) {
  cur = { ...cur, ...patch };
  if (patch.zoom !== undefined) cur.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(cur.zoom * 2) / 2));
  try { localStorage.setItem(KEY, JSON.stringify({ ortho: cur.ortho, cross: cur.cross, zoom: cur.zoom })); } catch { /* kept for now only */ }
  for (const f of subs) f(cur);
}

/** subscribe outside React (the canvas redraws) */
export function onAids(f: (a: Aids) => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}

/** React: the aids, re-rendering when one is switched (here or by a key) */
export function useAids(): Aids {
  const [a, setA] = useState(cur);
  useEffect(() => { subs.add(setA); setA(cur); return () => { subs.delete(setA); }; }, []);
  return a;
}
