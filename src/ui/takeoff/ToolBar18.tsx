// v0.18.1 (Nabil, 11 Nov: "the least used tools like line and area and so on are shown, while the others are hidden.
// maybe group them by architecture, structure, general, etc.?") - the tool bar by discipline: General, Architecture,
// Structure, Annotate, View. Each group shows its tools as buttons (the ones ticked in Customize) and ▾ lists all of
// them. When the bar runs out of room a group folds into one button (View first, General last); with all folded the
// last groups go under ». Customize (⚙): which tools are buttons, their order and the groups' order - for this user on
// this PC.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { TIcon } from './ticons';
import { PopMenu } from './Sheets16';

export type TbGroupId = 'general' | 'arch' | 'struct' | 'annot' | 'view';
export interface TbItem {
  id: string;
  label: string;
  /** a ticons key, or a drawing of its own */
  icon: string | ReactNode;
  key?: string;
  hint: string;
  on?: boolean;
  disabled?: boolean;
  /** its family's colour (measure, block, finish, struct, note) */
  cat?: string;
  /** the button's own text when it says more than the label ("Snap off", "Magnifier ×2") */
  text?: string;
  /** the button's face in place of icon + text (the Display button's sample number) */
  face?: ReactNode;
  /** a toggle (Snap, Ortho...) rather than a tool */
  aux?: boolean;
  /** a heading over it in the ▾ menu (the first of a set) */
  sec?: string;
  /** attributes on its button / on its line in the ▾ menu (kept for the tests: data-aid, data-structpick...) */
  attrs?: Record<string, string>;
  mattrs?: Record<string, string>;
  run: () => void;
}
export interface TbGroup { id: TbGroupId; label: string; items: TbItem[] }

export const TB_GROUP_LABEL: Record<TbGroupId, string> = { general: 'General', arch: 'Architecture', struct: 'Structure', annot: 'Annotate', view: 'View' };
/** in the group's ▾ only, until ticked in Customize */
const DEFAULT_MENU_ONLY = new Set(['hole', 'sw', 'drop', 'stair', 'sog', 'raft', 'colmarks', 'swmarks', 'ftgmarks', 'beammarks', 'wallmarks', 'rwmarks']);
/**
 * short of room, first the buttons go into their group's ▾ one by one, least used first (each group keeps its first
 * one, and the tool in use stays out); then whole groups fold into one button; then the last groups go under »
 */
const HIDE_ORDER = ['loupe', 'cross', 'region', 'scale', 'measure', 'opening', 'door', 'tagcount', 'rw', 'ftg', 'shear', 'slab', 'col', 'count', 'line', 'ortho', 'area', 'room'];
// (View never folds: snap / ortho must show their state - it is the first to go under » when even that is too wide)
const FOLD_ORDER: TbGroupId[] = ['annot', 'struct', 'arch', 'general'];

interface Prefs { groups?: TbGroupId[]; vis?: Record<string, boolean>; order?: Partial<Record<TbGroupId, string[]>> }
const KEY = (user: string) => 'qto.toolbar.v1.' + (user || 'x');
function loadPrefs(user: string): Prefs {
  try { const v = JSON.parse(localStorage.getItem(KEY(user)) ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
const byOrder = <T,>(xs: T[], id: (x: T) => string, order: string[] | undefined) => {
  if (!order?.length) return xs;
  const ix = new Map(order.map((k, i) => [k, i]));
  return xs.map((x, i) => ({ x, i })).sort((a, b) => (ix.get(id(a.x)) ?? 1e3 + a.i) - (ix.get(id(b.x)) ?? 1e3 + b.i)).map((o) => o.x);
};
const shownOf = (p: Prefs, id: string) => p.vis?.[id] ?? !DEFAULT_MENU_ONLY.has(id);
const iconOf = (it: TbItem, size?: number) => (typeof it.icon === 'string' ? <TIcon k={it.icon} size={size} /> : it.icon);

export function ToolBarGroups({ groups, user, after }: { groups: TbGroup[]; user: string; after?: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(user));
  useEffect(() => setPrefs(loadPrefs(user)), [user]);
  const save = (p: Prefs) => { setPrefs(p); setLevel(0); try { localStorage.setItem(KEY(user), JSON.stringify(p)); } catch { /* full */ } };
  const ordered = byOrder(groups, (g) => g.id, prefs.groups).map((g) => ({ ...g, items: byOrder(g.items, (i) => i.id, prefs.order?.[g.id]) }));
  // ---- room on the bar: fold groups, then put the last ones under » (worked out before the bar is painted)
  const [level, setLevel] = useState(0);
  const [, setTick] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const lastW = useRef(0);
  // (the buttons that can go into the ▾ when short of room: shown ones, not a group's first)
  const firsts = new Set(ordered.map((g) => g.items.find((i) => shownOf(prefs, i.id))?.id ?? ''));
  const hideable = HIDE_ORDER.filter((id) => !firsts.has(id) && ordered.some((g) => g.items.some((i) => i.id === id && shownOf(prefs, id))));
  const H = hideable.length;
  const maxLevel = H + FOLD_ORDER.length + ordered.length;
  useLayoutEffect(() => {
    const el = box.current;
    if (el && el.scrollWidth > el.clientWidth + 1 && level < maxLevel) setLevel(level + 1);
  });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    lastW.current = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      // (another width: worked out again from everything open - before the bar is painted)
      if (Math.abs(w - lastW.current) > 1) setLevel(0); else setTick((t) => t + 1);
      lastW.current = w;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const autoHidden = new Set(hideable.slice(0, Math.min(level, H)));
  const folded = new Set(FOLD_ORDER.slice(0, Math.max(0, Math.min(level - H, FOLD_ORDER.length))));
  const overN = Math.max(0, level - H - FOLD_ORDER.length);
  const inBar = ordered.slice(0, Math.max(0, ordered.length - overN));
  const inMore = ordered.slice(inBar.length);
  const [menu, setMenu] = useState<{ g: TbGroupId | 'more'; x: number; y: number } | null>(null);
  const [custom, setCustom] = useState<{ x: number; y: number } | null>(null);
  const openAt = (e: React.MouseEvent, g: TbGroupId | 'more') => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ g, x: r.left, y: r.bottom + 4 }); };

  const button = (it: TbItem) => (
    <button
      key={it.id}
      {...it.attrs}
      data-tb={it.id}
      data-cat={it.cat}
      className={'qtool' + (it.aux ? ' aux' : '') + (it.on ? ' on' + (it.aux ? (it.id === 'snap' ? ' snap' : ' aid') : '') : '')}
      aria-pressed={it.aux ? !!it.on : undefined}
      disabled={it.disabled}
      title={`${it.label}${it.key ? ' (' + it.key + ')' : ''} — ${it.hint}`}
      onMouseDown={it.face ? (e) => e.preventDefault() : undefined}
      onClick={it.run}
    >
      {it.face ?? <>{iconOf(it)}<span>{it.text ?? it.label}</span></>}
    </button>
  );
  const menuLine = (it: TbItem) => (
    <span key={it.id}>
    {it.sec && <div className="mh sub">{it.sec}</div>}
    <button {...it.mattrs} data-tbpick={it.id} className={'mi' + (it.on ? ' on' : '')} disabled={it.disabled} title={it.hint} onClick={() => { setMenu(null); it.run(); }}>
      <span className="ck">{iconOf(it, 13)}</span><span className="lb">{it.text ?? it.label}</span>{it.key && <span className="kb">{it.key}</span>}
    </button>
    </span>
  );
  const menuGroup = menu ? (menu.g === 'more' ? inMore : ordered.filter((g) => g.id === menu.g)) : [];
  return (
    <>
      <div className="tbgroups" ref={box} data-tbgroups data-level={level}>
        {inBar.map((g) => {
          const on = g.items.find((i) => i.on && !i.aux);
          if (folded.has(g.id)) {
            // (folded: one button - the tool in use of this group, else the group's name; a click lists them all)
            const face = on ?? g.items[0];
            return (
              <div key={g.id} className={'qto-tools tbg folded' + (on ? ' hason' : '')} data-tbg={g.id}>
                <button className={'qtool tbfold' + (on ? ' on' : '')} data-cat={face?.cat} data-tbcaret={g.id} {...(g.id === 'struct' ? { 'data-structmenu': '' } : {})} title={`${g.label}: ${g.items.map((i) => i.label).join(', ')}`} onClick={(e) => openAt(e, g.id)}>
                  {face && iconOf(face)}<span>{on ? on.label : g.label} ▾</span>
                </button>
              </div>
            );
          }
          const vis = g.items.filter((i) => (shownOf(prefs, i.id) && !autoHidden.has(i.id)) || i.on);
          return (
            <div key={g.id} className="qto-tools tbg" data-tbg={g.id} title={g.label}>
              <span className="tbg-cap" aria-hidden>{g.label}</span>
              {vis.map(button)}
              <button className="qtool caret tbg-caret" data-tbcaret={g.id} {...(g.id === 'struct' ? { 'data-structmenu': '' } : {})} title={`${g.label}: all of them${vis.length < g.items.length ? ' (' + (g.items.length - vis.length) + ' more here)' : ''}`} onClick={(e) => openAt(e, g.id)}>▾</button>
            </div>
          );
        })}
        {inMore.length > 0 && (
          <div className="qto-tools tbg">
            <button className={'qtool tbfold' + (inMore.some((g) => g.items.some((i) => i.on && !i.aux)) ? ' on' : '')} data-tbmore title={'More: ' + inMore.map((g) => g.label).join(', ')} onClick={(e) => openAt(e, 'more')}>
              <span className="tbmore">»</span><span>More</span>
            </button>
          </div>
        )}
      </div>
      <button className="qtool aux tbcust" data-tbcustom title="Customize the tool bar: which tools are buttons, their order (for you, on this PC)" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setCustom({ x: r.left, y: r.bottom + 4 }); }}>
        <TIcon k="cog" />
      </button>
      {after}
      {menu && (
        <PopMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} className={'tbmenu' + (menuGroup.some((g) => g.id === 'struct') ? ' structmenu' : '')}>
          {menuGroup.map((g) => (
            <div key={g.id} data-tbmenu={g.id}>
              <div className="mh">{g.label}</div>
              {g.items.map(menuLine)}
            </div>
          ))}
        </PopMenu>
      )}
      {custom && <Customize groups={ordered} prefs={prefs} x={custom.x} y={custom.y} onSave={save} onClose={() => setCustom(null)} />}
    </>
  );
}

function Customize({ groups, prefs, x, y, onSave, onClose }: { groups: TbGroup[]; prefs: Prefs; x: number; y: number; onSave: (p: Prefs) => void; onClose: () => void }) {
  const moveGroup = (i: number, d: -1 | 1) => {
    const ids = groups.map((g) => g.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    onSave({ ...prefs, groups: ids });
  };
  const moveItem = (g: TbGroup, i: number, d: -1 | 1) => {
    const ids = g.items.map((t) => t.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    onSave({ ...prefs, order: { ...prefs.order, [g.id]: ids } });
  };
  const setVis = (id: string, v: boolean) => onSave({ ...prefs, vis: { ...prefs.vis, [id]: v } });
  return (
    <PopMenu x={x} y={y} onClose={onClose} className="tbcustom">
      <div className="mh">Tool bar <span className="faint">— ticked: a button; the rest: in the group’s ▾ (for you, on this PC)</span></div>
      <div className="tbc-body" data-tbcustom-pop>
        {groups.map((g, gi) => (
          <section key={g.id} data-tbc-group={g.id}>
            <div className="tbc-gh">
              <b>{g.label}</b>
              <span className="grow" />
              <button className="btn icon ghost sm" disabled={gi === 0} title="Move the group left" onClick={() => moveGroup(gi, -1)}>‹</button>
              <button className="btn icon ghost sm" disabled={gi === groups.length - 1} title="Move the group right" onClick={() => moveGroup(gi, 1)}>›</button>
            </div>
            {g.items.map((it, i) => (
              <div key={it.id} className="tbc-row">
                <label className="check tp">
                  <input type="checkbox" data-tbc-vis={it.id} checked={shownOf(prefs, it.id)} onChange={(e) => setVis(it.id, e.target.checked)} />
                  <span className="ck">{iconOf(it, 13)}</span> {it.label}{it.key && <span className="kb">{it.key}</span>}
                </label>
                <span className="grow" />
                <button className="btn icon ghost sm" disabled={i === 0} title="Earlier" onClick={() => moveItem(g, i, -1)}>↑</button>
                <button className="btn icon ghost sm" disabled={i === g.items.length - 1} title="Later" onClick={() => moveItem(g, i, 1)}>↓</button>
              </div>
            ))}
          </section>
        ))}
      </div>
      <div className="tbc-foot">
        <button className="btn sm" data-tbc-reset onClick={() => onSave({})}>Back to the default</button>
        <span className="grow" />
        <button className="btn sm primary" onClick={onClose}>Done</button>
      </div>
    </PopMenu>
  );
}
