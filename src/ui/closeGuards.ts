// What the window holds that is not a change yet - asked about before the app closes.
// (Changes already made but not on the shared folder: backup.ts pendingTotal.)

/** a shape being drawn on a sheet: its points so far (0 = none) */
const drawing = new Set<() => number>();
export function watchDrawing(points: () => number): () => void {
  drawing.add(points);
  return () => { drawing.delete(points); };
}
export const pointsInProgress = () => [...drawing].reduce((a, f) => Math.max(a, f()), 0);

/** text written but not saved yet (a note being written): what it is, or '' */
const drafts = new Set<() => string>();
export function watchDraft(what: () => string): () => void {
  drafts.add(what);
  return () => { drafts.delete(what); };
}
export const unsavedDrafts = () => [...drafts].map((f) => f()).filter(Boolean);
