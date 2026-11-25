// v0.16.4 a place a sheet is shown in: the main window or a sheet tab's own window. Each place opens its own sheet
// in the PDF engine (shared: a drawing open once is open for every place) and keeps its own picture of it, so a
// sheet in a window not worked in is still there, live, and turning to it is instant. The sheet worked on gets the
// take-off screen's full drawing; the others are seen (zoom, pan) and a click makes them the one worked on.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { filePage, type Drawing } from '../../engine/qto/model';
import { loadDrawing, preview, previewScale, type Loaded } from './drawings';
import type { PdfEngine, PageSize } from './pdfengine';

/** a place's own copy of its sheet */
export interface Own { dwg: string; pg: number; key: string; page: PageSize; fpg: number; pages: number; prev: ImageBitmap | null; prevScale: number }
export type OwnState = 'none' | 'loading' | 'missing' | 'error' | 'ready';
/** the drawings some place shows NOW (users: the places), open in the PDF engine - turning to a sheet another
 *  window shows needs no reading of its file again. A drawing no place shows is read again when opened (a file
 *  replaced on disk is then seen: "This drawing has changed"). */
export type Opened = Map<string, { dwg: string; path: string; hash: string; r: Loaded; users: Set<string> }>;
export function holdOpened(opened: Opened, d: { id: string; path: string; hash: string }, r: Loaded, user: string) {
  const e = opened.get(d.id);
  if (e && e.r === r) { e.users.add(user); return; }
  opened.set(d.id, { dwg: d.id, path: d.path, hash: d.hash, r, users: new Set([...(e?.users ?? []), user]) });
}
export function dropOpened(opened: Opened, dwg: string, user: string) {
  const e = opened.get(dwg);
  if (!e) return;
  e.users.delete(user);
  if (!e.users.size) opened.delete(dwg);
}

export function SheetLoc({ place, engine, d, pg, wait, localDir, projectDir, opened, children }: {
  /** which place (the main window, a tab's window) */
  place: string;
  engine: PdfEngine | null;
  d: Drawing | null;
  pg: number;
  /** the sheet worked on, still being opened by the screen itself: not read twice at once - its own copy after */
  wait?: boolean;
  localDir: string;
  projectDir: string;
  opened: Opened;
  children: (own: Own | null, st: OwnState) => ReactNode;
}) {
  const [own, setOwn] = useState<Own | null>(null);
  const [st, setSt] = useState<OwnState>('none');
  const bmp = useRef<ImageBitmap | null>(null);
  const swap = (b: ImageBitmap | null) => { if (bmp.current && bmp.current !== b) bmp.current.close(); bmp.current = b; };
  useEffect(() => () => swap(null), []);
  useEffect(() => {
    if (!engine || !d) { setOwn(null); setSt('none'); return; }
    if (wait) return;
    let alive = true;
    // (the picture shown stays until the new one is there)
    setSt((x) => (x === 'ready' ? x : 'loading'));
    (async () => {
      const c = opened.get(d.id);
      const r = c && c.path === d.path && c.hash === d.hash && engine.isOpen(c.r.key) ? c.r : await loadDrawing(d, localDir, engine, { wanted: () => alive });
      if (!alive) return;
      if ('missing' in r) { setSt('missing'); return; }
      holdOpened(opened, d, r, place);
      if (!r.pages.length) { setSt('error'); return; }
      const fpg = Math.min(filePage(d, pg), r.pages.length - 1);
      const page = r.pages[fpg];
      const b = await preview(engine, r.key, fpg, page, localDir, projectDir).catch(() => null);
      if (!alive) { b?.close(); return; }
      swap(b);
      setOwn({ dwg: d.id, pg, key: r.key, page, fpg, pages: r.pages.length, prev: b, prevScale: previewScale(page) });
      setSt('ready');
    })().catch(() => { if (alive) setSt('error'); });
    const dwg = d.id;
    return () => { alive = false; dropOpened(opened, dwg, place); };
  }, [engine, d?.id, d?.path, d?.hash, d?.fp, pg, wait]);
  // (a picture of another sheet is not this one's)
  const mine = own && d && own.dwg === d.id && own.pg === pg ? own : null;
  return <>{children(mine, mine ? 'ready' : st === 'ready' ? 'loading' : st)}</>;
}
