// Decimals and size of the measured numbers - in the sheet's tool bar, usable in the middle of drawing
// a shape (clicking here does not take the keyboard from the sheet, so Enter / Backspace still go to
// the shape being drawn).
import { FMT_DEFAULTS, SIZES, LINE_WIDTHS, FILLS, DIMS, fixed, setQtoFmt, useQtoFmt, type QtoFmt } from './numfmt';

const ROWS: { k: 'dm' | 'da' | 'dv' | 'dmm'; label: string; unit: string; max: number; sample: number }[] = [
  { k: 'dm', label: 'Lengths', unit: 'm', max: 4, sample: 3.5 },
  { k: 'da', label: 'Areas', unit: 'm²', max: 4, sample: 12.25 },
  { k: 'dv', label: 'Volumes', unit: 'm³', max: 4, sample: 1.125 },
  { k: 'dmm', label: 'Millimetres', unit: 'mm', max: 2, sample: 3500 },
];

/** v0.18.1 the Display button's face in the grouped tool bar: the sample number and its name */
export function NumFmtFace() {
  const f = useQtoFmt();
  return <><span className="nf-sample">{fixed(0, f.dm)}</span><span>Display</span></>;
}

export function NumFmtButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const f = useQtoFmt();
  return (
    <button
      className={'qtool aux' + (open ? ' on' : '')}
      data-numfmt
      title="Display: decimals and size of the measured numbers, thickness of the lines, area fill, labels, highlighting. This PC; quantities are always calculated in full."
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
    >
      <span className="nf-sample">{fixed(0, f.dm)}</span>
      <span>Display</span>
    </button>
  );
}

export function NumFmtPop({ onClose }: { onClose: () => void }) {
  const f = useQtoFmt();
  const isDefault = (Object.keys(FMT_DEFAULTS) as (keyof QtoFmt)[]).every((k) => f[k] === FMT_DEFAULTS[k]);
  return (
    <div className="numfmt-pop" onMouseDown={(e) => e.preventDefault()} onMouseLeave={onClose} role="dialog" aria-label="Decimals">
      <h5>Decimals shown</h5>
      {ROWS.map((r) => (
        <div className="nf-row" key={r.k}>
          <span className="nf-l">{r.label}</span>
          <span className="seg">
            {Array.from({ length: r.max + 1 }, (_, d) => (
              <button key={d} className={f[r.k] === d ? 'on' : ''} data-k={r.k} data-d={d} onClick={() => setQtoFmt({ [r.k]: d })}>{d}</button>
            ))}
          </span>
          <span className="nf-eg num">{fixed(r.sample, f[r.k])} {r.unit}</span>
        </div>
      ))}
      <h5>Numbers on the drawing</h5>
      <div className="nf-row">
        <span className="seg">
          {SIZES.map((s) => (
            <button key={s.k} className={f.size === s.k ? 'on' : ''} data-size={s.k} onClick={() => setQtoFmt({ size: s.k })}>{s.label}</button>
          ))}
        </span>
      </div>
      <div className="nf-row">
        <span className="nf-l">Show them</span>
        <span className="seg">
          {(['hover', 'always', 'never'] as const).map((v) => (
            <button key={v} className={f.labels === v ? 'on' : ''} data-labels={v} onClick={() => setQtoFmt({ labels: v })} title={v === 'hover' ? 'On the shape under the pointer and the selected ones' : v === 'always' ? 'On every shape (busy on a full sheet)' : 'Only on the selected shapes'}>{v === 'hover' ? 'On hover' : v === 'always' ? 'Always' : 'Selected only'}</button>
          ))}
        </span>
      </div>
      <div className="nf-row">
        <span className="nf-l">Segment tags</span>
        <span className="seg">
          <button className={f.tags === 'sel' ? 'on' : ''} data-tags="sel" onClick={() => setQtoFmt({ tags: 'sel' })}>Selected shape</button>
          <button className={f.tags === 'always' ? 'on' : ''} data-tags="always" onClick={() => setQtoFmt({ tags: 'always' })}>Always</button>
        </span>
      </div>
      <h5>Lines and areas</h5>
      <div className="nf-row">
        <span className="nf-l">Lines</span>
        <span className="seg">
          {LINE_WIDTHS.map((s) => <button key={s.k} className={f.lw === s.k ? 'on' : ''} data-lw={s.k} onClick={() => setQtoFmt({ lw: s.k })}>{s.label}</button>)}
        </span>
      </div>
      <div className="nf-row">
        <span className="nf-l">Area fill</span>
        <span className="seg">
          {FILLS.map((s) => <button key={s.k} className={f.fill === s.k ? 'on' : ''} data-fill={s.k} onClick={() => setQtoFmt({ fill: s.k })}>{s.label}</button>)}
        </span>
      </div>
      <div className="nf-row">
        <span className="nf-l" title="Ctrl+click several take-offs in the list to highlight them on the drawing">Fade the others</span>
        <span className="seg">
          {DIMS.map((s) => <button key={s.k} className={f.dim === s.k ? 'on' : ''} data-dim={s.k} onClick={() => setQtoFmt({ dim: s.k })}>{s.label}</button>)}
        </span>
      </div>
      <p className="faint">
        Numbers keep the same size on the screen at any zoom. Only what is shown changes: quantities are always calculated in full,
        and the Excel export keeps every decimal. This PC, every take-off. A take-off's own colour, line and fill: in its details.
        Highlight some: Ctrl+click them in the list — the rest fade.
      </p>
      <div className="nf-foot">
        <button className="btn sm ghost" disabled={isDefault} onClick={() => setQtoFmt({ ...FMT_DEFAULTS })}>Back to the defaults</button>
        <button className="btn sm" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
