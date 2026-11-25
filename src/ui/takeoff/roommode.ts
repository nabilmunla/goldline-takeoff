// v0.16: the Room panel (Properties / take-off list) asks the drawing for a room drawing step, and the
// drawing says when it is done. A tiny per-project event bus, like boqnav.ts, so the panel and the
// canvas don't need each other's props.
//
//   k = 'outline'  draw another outline of the room (area tool, polygon / rectangle / circle modes)
//       'addLine'  draw an additional wall finish / skirting along the room's outline (part = its take-off id)
//       'addArea'  draw an additional floor / ceiling area inside the room (part = its take-off id)
//       'ceil'     draw the manual ceiling area(s) (part = the ceiling take-off returned by setCeilingModeOps)
//       'gap'      pick the edges with a shadow gap (outline edges, ceiling edges); Enter / Esc = done
//       'door'     place a door on one of the room's wall edges (picker from the door schedule)
//       'open'     place another opening (width, height, sill) on one of its wall edges
//       'edge'     pick edges to mark / unmark as "Open edge (no wall)"
//       'pickLine' (v0.16.4) pick the edges a bulkhead / a higher upturn runs along (part = it): each picked edge is a
//                  length of its own in it, picked again it comes out; Enter / Esc = done
export type RoomModeKind = 'outline' | 'addLine' | 'addArea' | 'ceil' | 'gap' | 'door' | 'open' | 'edge' | 'pickLine' | 'misc';
export interface RoomMode {
  k: RoomModeKind;
  /** the room (ti: id, kind 'room') */
  room: string;
  /** the sub-item the shapes go into (additional finish, manual ceiling) */
  part?: string;
}

type Fn = (m: RoomMode | null) => void;
const startL = new Map<string, Set<Fn>>();
const doneL = new Map<string, Set<Fn>>();
const sub = (map: Map<string, Set<Fn>>, pid: string, f: Fn) => {
  let s = map.get(pid);
  if (!s) map.set(pid, (s = new Set()));
  s.add(f);
  return () => { s!.delete(f); };
};

/** the panel: start a room drawing step on the open sheet (null = stop the one running) */
export function startRoomMode(projectId: string, m: RoomMode | null): void {
  for (const f of startL.get(projectId) ?? []) f(m);
}
/** the drawing (TakeoffView / SheetCanvas) listens; returns the unsubscribe */
export function onRoomMode(projectId: string, f: Fn): () => void { return sub(startL, projectId, f); }

/** the drawing: the step ended (finished, Esc, another tool) - m = the step that ended */
export function roomModeDone(projectId: string, m: RoomMode): void {
  for (const f of doneL.get(projectId) ?? []) f(m);
}
/** the panel listens (to clear its "Picking edges…" state etc.) */
export function onRoomModeDone(projectId: string, f: Fn): () => void { return sub(doneL, projectId, f); }

// (the e2e tests ask for a step the way the room panel does, and hear when it ends: tests/e2e-v16-g1.mjs)
if (typeof window !== 'undefined') Object.assign(window, { __gtRoomMode: { start: startRoomMode, onDone: onRoomModeDone } });
