// Listeners that only pass on what the screen shows: the session reports its status and
// who is here every second or so, mostly unchanged - re-drawing a 15,000-row project for
// that is wasted work.
import type { PresenceInfo, SyncStatus } from '../engine/types';

export function calmStatus(set: (s: SyncStatus) => void): (s: SyncStatus) => void {
  let last = '';
  return (s) => {
    // "checked … ago" needs a fresh time now and then, not every tick
    const k = [s.state, s.pending, s.lastError ?? '', s.corruptLines, Math.floor(s.lastSyncAt / 10000)].join('|');
    if (k !== last) { last = k; set(s); }
  };
}

export function calmPresence(set: (o: PresenceInfo[]) => void): (o: PresenceInfo[]) => void {
  let last = '';
  return (list) => {
    const k = list.map((o) => [o.w, o.u, o.a ?? '', o.color, o.sel ?? '', o.col ?? '', o.editing ? 1 : 0, o.detail ?? '', o.sheet ?? '', o.cx ?? '', o.cy ?? ''].join('|')).join('\n');
    if (k !== last) { last = k; set(list); }
  };
}
