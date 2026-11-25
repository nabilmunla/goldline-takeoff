// v0.16 (group g2, item 30): the finish code box - one box for every code field (rooms, additional finishes,
// shadow gap, waterproofing, and the finish code of any take-off, one or several selected). The project's
// codes are suggested as you type ("PT" -> PT-01, PT-08; case ignored), picked with the mouse or ↑↓ + Enter;
// a new code is just typed. The engine keeps the first spelling ("pt-08" is PT-08).
import { activeWin } from '../popout';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { QtoModel } from '../../engine/qto/model';
import { suggestCodes, codesUsedFor, type CodeKind } from '../../engine/qto/finishes';

/** v0.16.4 the kind of finish a code box is for (its name): its codes come first in the list */
const KIND_OF: Record<string, CodeKind> = { fc: 'floor', wc: 'wall', kc: 'skirting', cc: 'ceiling', fac: 'ceiling', bhc: 'ceiling', gc: 'gap', pc: 'wp', phc: 'wp', pvc: 'wp', upc: 'wp' };

export function CodeBox({ model, value, onSave, placeholder, disabled, mixed, title, name, kind }: {
  model: QtoModel;
  value: string;
  /** the code typed or picked ('' = none) - only when it changed */
  onSave: (code: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** several selected with different codes */
  mixed?: boolean;
  title?: string;
  /** what the box is for (tests, tooltips) */
  name?: string;
  /** the kind of finish (else from its name): the codes used for it first */
  kind?: CodeKind | null;
}) {
  const [v, setV] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const inp = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const typed = v ?? value;
  const k = kind !== undefined ? kind : name ? KIND_OF[name] ?? null : null;
  const prefer = useMemo(() => (open && k ? codesUsedFor(model, k) : undefined), [open, model, k]);
  // (every code - the list scrolls; the codes used for this kind of finish first)
  const list = open && !disabled ? suggestCodes(model, v ?? '', 400, prefer).filter((c) => !(v === null && c.code === value)) : [];
  useLayoutEffect(() => {
    if (!open || !inp.current) return;
    const r = inp.current.getBoundingClientRect();
    const up = r.bottom + 230 > activeWin().innerHeight && r.top > 240;
    setPos({ left: r.left, top: up ? r.top - 2 : r.bottom + 2, width: Math.max(r.width, 190), up });
  }, [open, list.length]);
  const save = (c: string) => {
    done.current = true;
    setV(null);
    setOpen(false);
    setHi(-1);
    const t = c.trim();
    // (several with different codes and nothing typed: left as they are)
    if (mixed && !t) return;
    if (t !== value || mixed) onSave(t);
  };
  return (
    <div className="codebox" data-codebox={name ?? ''}>
      <input
        ref={inp}
        className={'input' + (mixed && v === null ? ' mixed' : '')}
        value={typed}
        disabled={disabled}
        title={title}
        placeholder={mixed ? 'Multiple values' : placeholder ?? 'no code: not in the Finishes Summary'}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => { done.current = false; setOpen(true); }}
        onChange={(e) => { setV(e.target.value); setOpen(true); setHi(-1); }}
        onBlur={() => { if (done.current) { done.current = false; return; } if (v !== null) save(v); else { setOpen(false); setHi(-1); } }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); setHi((h) => Math.min(list.length - 1, h + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(-1, h - 1)); }
          else if (e.key === 'Enter') {
            e.preventDefault();
            const c = hi >= 0 && list[hi] ? list[hi].code : v ?? value;
            save(c);
            inp.current?.blur();
          } else if (e.key === 'Escape') {
            // first Esc closes the list, the next one puts the code back as it was
            e.stopPropagation();
            if (open && list.length) { setOpen(false); setHi(-1); return; }
            done.current = true;
            setV(null);
            inp.current?.blur();
          } else if (e.key === 'Tab' && hi >= 0 && list[hi]) { save(list[hi].code); }
        }}
      />
      {open && list.length > 0 && pos && (
        <div className="codelist" role="listbox" style={{ left: pos.left, width: pos.width, ...(pos.up ? { bottom: activeWin().innerHeight - pos.top } : { top: pos.top }) }}>
          {list.map((c, i) => (
            <button
              type="button"
              key={c.key}
              role="option"
              aria-selected={i === hi}
              className={'cl-i' + (i === hi ? ' on' : '')}
              onMouseDown={(e) => { e.preventDefault(); save(c.code); inp.current?.blur(); }}
              onMouseEnter={() => setHi(i)}
            >
              <b>{c.code}</b>
              <span className="faint">{c.units.join(' · ')}{c.n > 1 ? ` · used ${c.n}×` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
