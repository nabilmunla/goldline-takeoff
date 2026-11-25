// v0.16 (group e, item 27): each person's measurements on a shared drawing.
//  - People ▾ on the sheet bar: a QS has one switch (show other people's take-offs, to look at only);
//    estimators and administrators tick whose shapes are shown, and can switch on "Edit other people's shapes".
//  - "Also in use by <name>" for the sheet open.
//  - In the properties of a take-off: who drew the selected shape (and who edited it since), and the split of
//    a total the shapes on screen don't explain.
// What is counted never changes: every total, the BOQ and the estimate are everyone's.
import { useRef, useState } from 'react';
import type { PresenceInfo } from '../../engine/types';
import { MEASURE_UNIT, type QtoModel, type Shape, type TItem } from '../../engine/qto/model';
import { isMine, ownerSplit, ownerText } from '../../engine/qto/owners';
import { colorFor } from '../../engine/ids';
import { initials } from '../format';
import { useDismiss } from './Aids16';
import { q as fq, useQtoFmt } from './numfmt';

const Ico = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
    <circle cx="6" cy="5.5" r="2.4" /><path d="M1.8 13.5c.4-2.4 2.1-3.8 4.2-3.8s3.8 1.4 4.2 3.8" />
    <circle cx="11.6" cy="6.2" r="1.9" /><path d="M11.2 9.8c1.7 0 3 1.1 3.3 3" />
  </svg>
);

/** the choice of whose shapes are shown, said in two words on the button */
function stateText(p: { qs: boolean; me: string; showOthers: boolean; pick: ReadonlySet<string> | null; people: { username: string }[] }) {
  if (p.qs) return p.showOthers ? "everyone's" : 'mine';
  if (!p.pick) return 'everyone';
  if (p.pick.size === 1 && p.pick.has(p.me)) return 'mine';
  const n = p.people.filter((x) => p.pick!.has(x.username)).length;
  return `${n} of ${p.people.length}`;
}

export function PeopleButton(p: {
  qs: boolean;
  me: string;
  nameOf: (u: string) => string;
  /** people with shapes in this take-off (and how many) */
  people: { username: string; n: number }[];
  /** QS: other people's take-offs shown (view only) */
  showOthers: boolean;
  onShowOthers: (v: boolean) => void;
  /** estimators / administrators: whose shapes are shown (null = everyone's) */
  pick: ReadonlySet<string> | null;
  onPick: (v: Set<string> | null) => void;
  editOthers: boolean;
  /** null: may not edit other people's shapes (a QS, view only) */
  onEditOthers: ((v: boolean) => void) | null;
  /** shapes on this sheet not shown because of the choice */
  hiddenHere: number;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  const notDefault = p.qs ? p.showOthers : !!p.pick;
  const people = p.people.some((x) => x.username === p.me) ? p.people : [{ username: p.me, n: 0 }, ...p.people];
  // me first, then the others as listed (most shapes first)
  const list = [...people.filter((x) => x.username === p.me), ...people.filter((x) => x.username !== p.me)];
  const ticked = (u: string) => !p.pick || p.pick.has(u);
  const tick = (u: string, on: boolean) => {
    const n = new Set(p.pick ?? list.map((x) => x.username));
    on ? n.add(u) : n.delete(u);
    // everyone ticked: everyone's (people who measure later are shown too)
    p.onPick(list.every((x) => n.has(x.username)) ? null : n);
  };
  return (
    <div className="tplwrap" ref={box}>
      <button
        className={'btn sm ghost peoplebtn' + (notDefault ? ' on' : '') + (open ? ' open' : '')}
        data-people-btn
        title={(p.qs ? "Whose take-offs are on the drawing: yours; other people's can be shown to look at" : 'Whose take-offs are on the drawing') + (p.hiddenHere ? ` — ${p.hiddenHere} shape${p.hiddenHere === 1 ? '' : 's'} of other people not shown on this sheet (still counted)` : '')}
        onClick={() => setOpen((x) => !x)}
      >
        <Ico />
        <span>People</span>
        <span className="pst">{stateText({ ...p, people: list })}</span>
        <span className="car">▾</span>
      </button>
      {open && (
        <div className="peoplemenu" data-people-menu>
          {p.qs ? (
            <>
              <label className="pm-row check tp" data-people-others>
                <input type="checkbox" checked={p.showOthers} onChange={(e) => p.onShowOthers(e.target.checked)} />
                <span className="lb"><b>Show other people's take-offs</b><span className="d">To look at only — they can't be changed. Remembered on this PC.</span></span>
              </label>
              <div className="pm-note">Totals always count everyone's take-offs.</div>
            </>
          ) : (
            <>
              <div className="msec">Shown on the drawing</div>
              <button className={'mi' + (!p.pick ? ' on' : '')} data-people-all onClick={() => p.onPick(null)}><span className="ck">{!p.pick ? '✓' : ''}</span><span className="lb">Everyone</span></button>
              <button className={'mi' + (p.pick && p.pick.size === 1 && p.pick.has(p.me) ? ' on' : '')} data-people-mine onClick={() => p.onPick(new Set([p.me]))}><span className="ck">{p.pick && p.pick.size === 1 && p.pick.has(p.me) ? '✓' : ''}</span><span className="lb">Only mine</span></button>
              <div className="msep" />
              {list.map((x) => (
                <label key={x.username} className="pm-row check tp" data-people-user={x.username}>
                  <input type="checkbox" checked={ticked(x.username)} onChange={(e) => tick(x.username, e.target.checked)} />
                  <span className="avatar xs" style={{ background: colorFor(x.username) }}>{initials(p.nameOf(x.username))}</span>
                  <span className="lb">{p.nameOf(x.username)}{x.username === p.me ? ' (you)' : ''}</span>
                  <span className="faint num">{x.n} shape{x.n === 1 ? '' : 's'}</span>
                </label>
              ))}
              {p.onEditOthers && (
                <>
                  <div className="msep" />
                  <label className={'pm-row check tp editsw' + (p.editOthers ? ' on' : '')} data-people-edit>
                    <input type="checkbox" checked={p.editOthers} onChange={(e) => p.onEditOthers!(e.target.checked)} />
                    <span className="lb"><b>Edit other people's shapes</b><span className="d">Off: theirs are view only. On (until the project is closed): a change keeps the shape theirs and adds you as a joint owner, in its history.</span></span>
                  </label>
                </>
              )}
              <div className="pm-note">Totals always count everyone's take-offs.</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** "Editing other people's shapes ✕" on the sheet bar while the switch is on: the state always in sight */
export function EditOthersChip({ onOff }: { onOff: () => void }) {
  return (
    <button className="btn sm editothers" data-edit-others title="Other people's shapes can be changed now (you become a joint owner of what you change). Click to make them view only again." onClick={onOff}>
      <span className="t">✎ Editing others' shapes</span> <span className="x">✕</span>
    </button>
  );
}

/** "Also in use by Sara Khan" (+N) for the sheet open */
export function InUseBy({ people }: { people: PresenceInfo[] }) {
  if (!people.length) return null;
  const names = [...new Set(people.map((o) => o.u))];
  return (
    <span className="inuse" data-inuse title={'Also on this sheet now: ' + names.join(', ') + ' — check you are not taking off the same things twice'}>
      <span className="avatars">{people.slice(0, 3).map((o) => <span key={o.w} className="avatar xs" style={{ background: o.color }}>{initials(o.u)}</span>)}</span>
      <span>Also in use by <b>{names[0]}</b>{names.length > 1 ? ` +${names.length - 1}` : ''}</span>
    </span>
  );
}

/**
 * In the properties of a take-off: who drew the selected shapes of it (and who edited them since), and - when some
 * of its shapes are not shown - its total split between what is shown and what is not.
 */
export function OwnerBits({ model, it, me, nameOf, selected, shown, qs, locked }: {
  model: QtoModel;
  it: TItem;
  me: string;
  nameOf: (u: string) => string;
  selected: Set<string>;
  /** shown on the drawing for the people chosen (People ▾) */
  shown: (s: Shape) => boolean;
  /** a QS on his own shapes: "Yours · others"; else "Shown · not shown" */
  qs: boolean;
  /** view only for this person */
  locked: (s: Shape) => boolean;
}) {
  useQtoFmt();
  const all = model.shapesByItem.get(it.id) ?? [];
  const sel = all.filter((s) => selected.has(s.id));
  const hidden = all.some((s) => !shown(s));
  const split = hidden ? ownerSplit(model, it, qs ? (s) => isMine(model, s, me) : shown) : null;
  const byText = new Map<string, number>();
  for (const s of sel) { const t = ownerText(model, s, nameOf); byText.set(t, (byText.get(t) ?? 0) + 1); }
  if (!split && !byText.size) return null;
  const nLocked = sel.filter(locked).length;
  return (
    <div className="ownerbits" data-owner-bits>
      {byText.size > 0 && (
        <div className="ob-by" data-owner={[...byText.keys()].join(' | ')}>
          <span className="k">{sel.length === 1 ? 'This shape' : `${sel.length} shapes selected`}</span>
          <span className="v">{[...byText].map(([t, n]) => (byText.size > 1 || sel.length > 1 ? `${t} (${n})` : t)).join('; ')}{nLocked ? <span className="vo"> · view only</span> : null}</span>
        </div>
      )}
      {split && (
        <div className="ob-split" data-owner-split title={qs ? "The total counts everyone's shapes. Other people's are not on your drawing (People ▾ shows them)." : 'The total counts everyone’s shapes, also those not on the drawing now (People ▾).'}>
          <span>{qs ? 'Yours' : 'Shown'} <b className="num">{fq(split.mine, split.ms)}</b> {MEASURE_UNIT[split.ms]}</span>
          <span className="sep">·</span>
          <span>{qs ? 'others' : 'not shown'} <b className="num">{fq(split.others, split.ms)}</b> {MEASURE_UNIT[split.ms]}</span>
          <span className="faint">({split.nOthers} shape{split.nOthers === 1 ? '' : 's'})</span>
        </div>
      )}
    </div>
  );
}
