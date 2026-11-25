// v0.18 (Feedback 3, 14: "import an image into the drawing, move, resize, move/copy to another sheet; the original PDF
// not affected; not visible to other users unless allowed") - images on a sheet: the menu that adds one, lists those
// here (put it somewhere else / another size, share it, remove it) and the viewer's images on other sheets (copy or
// move one here). Where it goes is drawn as a rectangle on the sheet (TakeoffView).
import { useMemo, useRef } from 'react';
import type { QtoModel, SheetImage } from '../../engine/qto/model';
import { sheetLabel } from './Panels';
import { useDismiss } from './ListBits';
import { TIcon } from './ticons';

export type ImagePlace = { k: 'new' | 'again' | 'copy' | 'move'; id?: string; file: string; name: string; ar: number };

export function ImagesMenu({ model, cur, me, readOnly, onAdd, onPlace, onShare, onRemove, onHover, onClose }: {
  model: QtoModel;
  cur: { dwg: string; pg: number };
  me: string;
  readOnly: boolean;
  onAdd: () => void;
  onPlace: (im: SheetImage, k: 'again' | 'copy' | 'move') => void;
  onShare: (im: SheetImage, on: boolean) => void;
  onRemove: (im: SheetImage) => void;
  onHover: (id: string | null) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // (its own button keeps it: the press closed it and the click opened it again - 0.23.2, DeepSeek #44)
  const button = useMemo(() => ({ get current() { return (box.current?.ownerDocument.querySelector('[data-images]') ?? null) as HTMLElement | null; } }), []);
  useDismiss(true, onClose, box, button);
  const here = model.images.filter((x) => x.dwg === cur.dwg && x.pg === cur.pg);
  const mineElsewhere = model.images.filter((x) => x.by === me && !(x.dwg === cur.dwg && x.pg === cur.pg));
  return (
    <div className="tplmenu img-menu" ref={box} data-imgmenu>
      <div className="mh">Images on this sheet</div>
      {here.map((x) => (
        <div key={x.id} className="img-row" data-imgrow={x.name} onMouseEnter={() => onHover(x.id)} onMouseLeave={() => onHover(null)}>
          <span className="lb" title={x.by === me ? 'Yours' : 'Shared by ' + x.by}>{x.name}{x.by !== me && <span className="faint"> · {x.by}</span>}</span>
          {x.by === me && !readOnly && (
            <>
              <label className="check tp" title="Off: only you see it. On: everyone who opens this sheet sees it"><input type="checkbox" data-imgshare checked={x.pub} onChange={(e) => onShare(x, e.target.checked)} /> shared</label>
              <button className="btn sm" data-imgagain title="Draw a new rectangle for it: another place, another size" onClick={() => onPlace(x, 'again')}>Move / resize</button>
              <button className="btn icon ghost sm" data-imgdel title="Remove it from this sheet · Ctrl+Z brings it back" onClick={() => onRemove(x)}><TIcon k="trash" size={13} /></button>
            </>
          )}
        </div>
      ))}
      {!here.length && <div className="faint" style={{ padding: '4px 8px' }}>None yet.</div>}
      {!readOnly && <button className="mi" data-imgadd onClick={onAdd}><span className="ck"><TIcon k="plus" size={13} /></span><span className="lb">Add an image… (PNG, JPG)</span></button>}
      {mineElsewhere.length > 0 && !readOnly && (
        <>
          <div className="mh sub">Your images on other sheets</div>
          <div className="img-list">
            {mineElsewhere.map((x) => (
              <div key={x.id} className="img-row" data-imgother={x.name}>
                <span className="lb" title={sheetLabel(model, x.dwg, x.pg)}>{x.name} <span className="faint">· {sheetLabel(model, x.dwg, x.pg)}</span></span>
                <button className="btn sm" data-imgcopy onClick={() => onPlace(x, 'copy')}>Copy here</button>
                <button className="btn sm" data-imgmove onClick={() => onPlace(x, 'move')}>Move here</button>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="faint ovr-foot">A picture over the sheet: the PDF is never changed. Only you see yours until you share it.</div>
    </div>
  );
}
