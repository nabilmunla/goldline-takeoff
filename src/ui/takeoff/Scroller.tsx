// v0.17.1 (Feedback 3: "when resizing the side panels, the top tools bar gets hidden") - a strip that scrolls
// sideways when it is too narrow for what is in it: ‹ › at its ends, the mouse wheel scrolls it too. Used by the
// tool bar and the sheet tabs.
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function HScroll({ className, wrapClass, children, attrs }: { className: string; wrapClass?: string; children: ReactNode; attrs?: Record<string, string | boolean | undefined> }) {
  const el = useRef<HTMLDivElement>(null);
  const [ovf, setOvf] = useState<{ l: boolean; r: boolean }>({ l: false, r: false });
  const measure = () => {
    const t = el.current;
    if (!t) return;
    const l = t.scrollLeft > 2, r = t.scrollLeft + t.clientWidth < t.scrollWidth - 2;
    setOvf((o) => (o.l === l && o.r === r ? o : { l, r }));
  };
  useEffect(() => {
    const t = el.current;
    if (!t) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(t);
    for (const c of Array.from(t.children)) ro.observe(c);
    t.addEventListener('scroll', measure, { passive: true });
    return () => { ro.disconnect(); t.removeEventListener('scroll', measure); };
  });
  const by = (dx: number) => el.current?.scrollBy({ left: dx, behavior: 'smooth' });
  return (
    <div className={'hscroll' + (wrapClass ? ' ' + wrapClass : '') + (ovf.l ? ' ovl' : '') + (ovf.r ? ' ovr' : '')}>
      {ovf.l && <button className="hs-btn l" data-hscroll="l" title="More to the left" onClick={() => by(-200)}>‹</button>}
      <div
        className={className}
        ref={el}
        {...attrs}
        onWheel={(e) => { const t = el.current; if (t && t.scrollWidth > t.clientWidth + 2 && !e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) t.scrollLeft += e.deltaY; }}
      >
        {children}
      </div>
      {ovf.r && <button className="hs-btn r" data-hscroll="r" title="More to the right" onClick={() => by(200)}>›</button>}
    </div>
  );
}
