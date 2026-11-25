// Esc closes a dialog (v0.15.0: most dialogs outside the take-off ignored it - New project, People's, Backups,
// Copy, Revisions, Import BOQ, Packages, Pages, the recycle bin, the problem report... - "New project" stayed open
// whatever was pressed; the take-off's own Modal already closed, its register and import did not). Put `onKeyDown` on the
// scrim and `box` (with tabIndex -1) on the modal: the dialog takes the keyboard when it opens, unless a field in it
// already has it (autoFocus), so Esc reaches it even when it was opened from a button. A field that uses Esc
// itself (an inline rename) calls preventDefault; menus inside stop it already.
import { useEffect, useRef, type KeyboardEvent } from 'react';

export function useEscClose<T extends HTMLElement = HTMLDivElement>(onClose: () => void, busy: unknown = false, open = true) {
  const box = useRef<T>(null);
  // (open: for a component that stays mounted and shows its dialog now and then)
  useEffect(() => {
    if (open && box.current && !box.current.contains(box.current.ownerDocument.activeElement)) box.current.focus();
  }, [open]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || busy) return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };
  return { box, onKeyDown };
}
