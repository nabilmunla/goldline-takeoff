// One menu for the whole app: right-click menus, "More", "Levels", "Columns".
// Entries can open a submenu (to the side, on hover or →), so long menus stay short:
// the common things on top, the rest one step away. Arrow keys, Enter and Esc work.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ICheck } from './icons';

export type MenuEntry =
  | { kind?: 'item'; label: string; kbd?: string; on?: boolean; disabled?: boolean; hint?: string; danger?: boolean; run: () => void; keep?: boolean }
  | { kind: 'sep' }
  | { kind: 'head'; label: string }
  | { kind: 'sub'; label: string; hint?: string; detail?: string; items: MenuEntry[]; disabled?: boolean }
  | { kind: 'custom'; node: ReactNode };

const isActive = (e: MenuEntry) => (e.kind === undefined || e.kind === 'item' || e.kind === 'sub') && !(e as any).disabled;

/** drop separators/headings that end up with nothing under them */
export function tidy(items: (MenuEntry | false | null | undefined)[]): MenuEntry[] {
  const list = items.filter(Boolean) as MenuEntry[];
  const out: MenuEntry[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.kind === 'sep' && (!out.length || out[out.length - 1].kind === 'sep' || i === list.length - 1)) continue;
    if (e.kind === 'head') {
      const next = list.slice(i + 1).find((x) => x.kind !== 'head');
      if (!next || next.kind === 'sep') continue;
    }
    out.push(e);
  }
  while (out.length && out[out.length - 1].kind === 'sep') out.pop();
  return out;
}

export function PopMenu(p: { x: number; y: number; items: MenuEntry[]; title?: ReactNode; onClose: () => void; className?: string; side?: 'right' | 'below' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: p.x, y: p.y });
  const [hi, setHi] = useState(-1);
  const [open, setOpen] = useState<number | null>(null);
  /** the entry picked in the open submenu with the keyboard (-1: none - the keys work on this menu) */
  const [subHi, setSubHi] = useState(-1);
  const [subAt, setSubAt] = useState<{ x: number; y: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(p.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(p.y, window.innerHeight - r.height - 8)) });
  }, [p.x, p.y, p.items.length]);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) p.onClose(); };
    window.addEventListener('mousedown', down);
    return () => window.removeEventListener('mousedown', down);
  }, []);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);

  const openSub = (i: number, el: HTMLElement | null) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    setOpen(i);
    setSubAt({ x: r.right - 4, y: r.top - 6, left: r.left });
  };
  const run = (e: MenuEntry) => {
    if (e.kind === 'sep' || e.kind === 'head' || e.kind === 'custom' || e.kind === 'sub') return;
    if (e.disabled) return;
    e.run();
    if (!e.keep) p.onClose();
  };
  const onKey = (ev: React.KeyboardEvent) => {
    ev.stopPropagation();
    // an open submenu entered with → / Enter: the keys work in it (its entries could not be run from the keyboard -
    // 0.23.2, DeepSeek #30)
    const sub = open !== null && p.items[open]?.kind === 'sub' ? (p.items[open] as Extract<MenuEntry, { kind: 'sub' }>).items : null;
    if (sub && subHi >= 0) {
      const sidx = sub.map((e, i) => (isActive(e) && e.kind !== 'sub' ? i : -1)).filter((i) => i >= 0);
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const cur = sidx.indexOf(subHi);
        setSubHi((ev.key === 'ArrowDown' ? sidx[(cur + 1) % sidx.length] : sidx[(cur - 1 + sidx.length) % sidx.length]) ?? -1);
        return;
      }
      if (ev.key === 'ArrowLeft' || ev.key === 'Escape') { ev.preventDefault(); setSubHi(-1); setOpen(null); return; }
      if (ev.key === 'Enter') { ev.preventDefault(); const e = sub[subHi]; if (e) run(e); return; }
    }
    const idx = p.items.map((e, i) => (isActive(e) ? i : -1)).filter((i) => i >= 0);
    if (ev.key === 'Escape') { ev.preventDefault(); p.onClose(); return; }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const cur = idx.indexOf(hi);
      const next = ev.key === 'ArrowDown' ? idx[(cur + 1) % idx.length] : idx[(cur - 1 + idx.length) % idx.length];
      setHi(next ?? -1);
      setOpen(null); setSubHi(-1);
      return;
    }
    const e = p.items[hi];
    if (!e) return;
    if ((ev.key === 'ArrowRight' || ev.key === 'Enter') && e.kind === 'sub') {
      ev.preventDefault();
      openSub(hi, ref.current?.querySelector(`[data-i="${hi}"]`) as HTMLElement);
      setSubHi(e.items.findIndex((x) => isActive(x) && x.kind !== 'sub'));
      return;
    }
    if (ev.key === 'Enter') { ev.preventDefault(); run(e); }
  };

  return (
    <div
      className={'rowmenu popmenu ' + (p.className ?? '')}
      ref={ref}
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKey}
    >
      {p.title && <div className="mh">{p.title}</div>}
      {p.items.map((e, i) => {
        if (e.kind === 'sep') return <div key={i} className="msep" />;
        if (e.kind === 'head') return <div key={i} className="msec">{e.label}</div>;
        if (e.kind === 'custom') return <div key={i}>{e.node}</div>;
        if (e.kind === 'sub') {
          return (
            <button
              key={i}
              data-i={i}
              className={'mi sub' + (hi === i ? ' hi' : '') + (open === i ? ' open' : '')}
              disabled={e.disabled}
              title={e.hint}
              onMouseEnter={(ev) => { setHi(i); openSub(i, ev.currentTarget); }}
              onClick={(ev) => openSub(i, ev.currentTarget)}
            >
              <span className="ck" />
              <span className="lb">{e.label}</span>
              {e.detail && <span className="kb dt">{e.detail}</span>}
              <span className="arr">›</span>
            </button>
          );
        }
        return (
          <button
            key={i}
            data-i={i}
            className={'mi' + (e.danger ? ' danger' : '') + (hi === i ? ' hi' : '')}
            disabled={e.disabled}
            title={e.hint}
            onMouseEnter={() => { setHi(i); setOpen(null); setSubHi(-1); }}
            onClick={() => run(e)}
          >
            <span className="ck">{e.on ? <ICheck /> : null}</span>
            <span className="lb">{e.label}</span>
            {e.kbd && <span className="kb">{e.kbd}</span>}
          </button>
        );
      })}
      {open !== null && subAt && p.items[open]?.kind === 'sub' && (
        <SubMenu
          items={(p.items[open] as Extract<MenuEntry, { kind: 'sub' }>).items}
          at={subAt}
          hi={subHi}
          onRun={(e) => run(e)}
        />
      )}
    </div>
  );
}

function SubMenu({ items, at, hi = -1, onRun }: { items: MenuEntry[]; at: { x: number; y: number; left: number }; hi?: number; onRun: (e: MenuEntry) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: at.x, y: at.y });
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    // to the right if it fits, else to the left of the parent menu
    const x = at.x + r.width > window.innerWidth - 8 ? Math.max(8, at.left - r.width + 4) : at.x;
    setPos({ x, y: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) });
  }, [at.x, at.y, items.length]);
  return (
    <div className="rowmenu popmenu flyout" ref={ref} style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((e, i) => {
        if (e.kind === 'sep') return <div key={i} className="msep" />;
        if (e.kind === 'head') return <div key={i} className="msec">{e.label}</div>;
        if (e.kind === 'custom') return <div key={i}>{e.node}</div>;
        if (e.kind === 'sub') return null; // one level is enough
        return (
          <button key={i} className={'mi' + (e.danger ? ' danger' : '') + (hi === i ? ' hi' : '')} disabled={e.disabled} title={e.hint} onClick={() => onRun(e)}>
            <span className="ck">{e.on ? <ICheck /> : null}</span>
            <span className="lb">{e.label}</span>
            {e.kbd && <span className="kb">{e.kbd}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** a toolbar button that opens a menu below itself */
export function MenuButton(p: { label: ReactNode; title?: string; items: () => MenuEntry[]; className?: string; disabled?: boolean }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        className={'btn ' + (p.className ?? '') + (at ? ' on' : '')}
        title={p.title}
        disabled={p.disabled}
        // while open, a click on the button itself closes the menu (and must not reopen it)
        onMouseDown={(e) => { if (at) e.nativeEvent.stopPropagation(); }}
        onClick={(e) => {
          if (at) { setAt(null); return; }
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setAt({ x: r.left, y: r.bottom + 4 });
        }}
      >
        {p.label}
      </button>
      {at && <PopMenu x={at.x} y={at.y} items={p.items()} onClose={() => setAt(null)} />}
    </>
  );
}
