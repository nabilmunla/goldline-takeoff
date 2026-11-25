// "View only" as a safety switch: anyone who may edit a project (administrators too) can turn it
// on to look around without any chance of changing something by accident. Remembered per project on
// this PC until turned off. Nothing to do with access rights: it only ever takes editing away.
import { useCallback, useEffect, useState } from 'react';
import { ILock, IUnlock } from './icons';

const key = (projectId: string) => 'viewonly:' + projectId;

export function isViewOnly(projectId: string): boolean {
  try { return localStorage.getItem(key(projectId)) === '1'; } catch { return false; }
}
export function setViewOnly(projectId: string, on: boolean) {
  try { if (on) localStorage.setItem(key(projectId), '1'); else localStorage.removeItem(key(projectId)); } catch { /* the switch still works for this visit */ }
  window.dispatchEvent(new CustomEvent('gt:viewonly', { detail: projectId }));
}

export function useViewOnly(projectId: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => isViewOnly(projectId));
  const set = useCallback((v: boolean) => { setViewOnly(projectId, v); setOn(v); }, [projectId]);
  useEffect(() => {
    const h = () => setOn(isViewOnly(projectId));
    window.addEventListener('gt:viewonly', h);
    return () => window.removeEventListener('gt:viewonly', h);
  }, [projectId]);
  return [on, set];
}

/** changes whenever any project's View only is switched (to look again at several projects) */
export function useViewOnlyTick(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const h = () => setN((x) => x + 1);
    window.addEventListener('gt:viewonly', h);
    return () => window.removeEventListener('gt:viewonly', h);
  }, []);
  return n;
}

/** the switch in a project's title bar */
export function ViewOnlySwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return on ? (
    <button className="vo-switch on no-drag" onClick={() => onChange(false)} title="You turned View only on: nothing in this project can be changed. Click to edit again.">
      <ILock /> View only
    </button>
  ) : (
    <button className="vo-switch no-drag" onClick={() => onChange(true)} title="View only: look around without any chance of changing something by accident (you can turn it off any time)">
      <IUnlock />
    </button>
  );
}
