// v0.16 (item 25): "show this in the BOQ" - from anywhere in a take-off (the properties panel's link,
// a take-off just linked) to its line in the BOQ tab: the tab opens, the parents of the line expand and
// the line is selected and scrolled to.
//
//   revealInBoq(projectId, target)   target: 'b:<BOQ line id>', 'dm:<additional item / temporary line>',
//                                    or 'ti:<take-off>' (its first link)
//
// TakeoffView switches to the BOQ tab; the BOQ tab (mounted now or already) takes the request.
type Fn = (target: string) => void;
const subs = new Map<string, Set<Fn>>();
let pending: { project: string; target: string } | null = null;

export function revealInBoq(projectId: string, target: string): void {
  pending = { project: projectId, target };
  for (const f of [...(subs.get(projectId) ?? [])]) f(target);
}

/** listen for requests for this take-off project; returns the unsubscribe */
export function onRevealInBoq(projectId: string, fn: Fn): () => void {
  const set = subs.get(projectId) ?? subs.set(projectId, new Set()).get(projectId)!;
  set.add(fn);
  return () => { set.delete(fn); };
}

/** a request made before the BOQ tab was there to take it (taken once) */
export function takePendingReveal(projectId: string): string | null {
  if (!pending || pending.project !== projectId) return null;
  const t = pending.target;
  pending = null;
  return t;
}
/** the BOQ tab took it */
export function clearPendingReveal(projectId: string) { if (pending?.project === projectId) pending = null; }
