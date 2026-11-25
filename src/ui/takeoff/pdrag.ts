// v0.18.1 (Feedback 3: "while dragging an item, the mouse wheel should scroll the list") - the take-off and drawing
// lists drag with the pointer instead of the browser's own drag and drop: during that one Windows holds the mouse and
// the wheel does nothing. Rows marked data-pdrag keep their drag handlers (dragstart / dragover / drop / dragend):
// this sends them the same events, made from the pointer - so the wheel scrolls the list under it meanwhile, and
// dragging near the top / bottom edge still scrolls it (the list's own dragover handler).
const done = new WeakSet<Document>();

interface St {
  src: HTMLElement; id: number; x0: number; y0: number; on: boolean;
  dt: DataTransfer | null; over: Element | null; ok: boolean; x: number; y: number;
  ghost: HTMLElement | null; tick: number;
}

export function installPointerDrag(doc: Document) {
  if (done.has(doc)) return;
  done.add(doc);
  const win = doc.defaultView;
  if (!win) return;
  let st: St | null = null;
  const fire = (s: St, el: Element | null, type: string, rel?: Element | null): boolean => {
    if (!el || !s.dt) return false;
    const ev = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: s.x, clientY: s.y, dataTransfer: s.dt, relatedTarget: rel ?? null });
    return !el.dispatchEvent(ev);
  };
  const move = (s: St) => {
    if (s.ghost) { s.ghost.style.left = s.x + 14 + 'px'; s.ghost.style.top = s.y + 10 + 'px'; }
    const el = doc.elementFromPoint(s.x, s.y);
    if (el !== s.over) {
      if (s.over) fire(s, s.over, 'dragleave', el);
      if (el) fire(s, el, 'dragenter', s.over);
      s.over = el;
    }
    s.ok = fire(s, el, 'dragover');
    doc.body.style.cursor = s.ok ? 'grabbing' : 'no-drop';
  };
  const end = (drop: boolean, s0?: St) => {
    const s = s0 ?? st;
    if (!s0) st = null;
    if (!s || !s.on) return;
    win.clearInterval(s.tick);
    s.ghost?.remove();
    doc.body.classList.remove('pdragging');
    doc.body.style.cursor = '';
    if (drop && s.ok && s.over) fire(s, s.over, 'drop');
    else if (s.over) fire(s, s.over, 'dragleave', null);
    fire(s, s.src, 'dragend');
  };
  /** the click that follows letting go is not a click on the row */
  const killClick = () => {
    const kill = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
    win.addEventListener('click', kill, { capture: true, once: true });
    win.setTimeout(() => win.removeEventListener('click', kill, true), 50);
  };
  doc.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || st) return;
    const tg = e.target as Element | null;
    const src = tg?.closest?.('[data-pdrag]') as HTMLElement | null;
    if (!src || tg?.closest('input, textarea, select, [contenteditable="true"]')) return;
    st = { src, id: e.pointerId, x0: e.clientX, y0: e.clientY, on: false, dt: null, over: null, ok: false, x: e.clientX, y: e.clientY, ghost: null, tick: 0 };
  }, true);
  doc.addEventListener('pointermove', (e) => {
    const s = st;
    if (!s || e.pointerId !== s.id) return;
    s.x = e.clientX; s.y = e.clientY;
    let just = false;
    if (!s.on) {
      just = true;
      if (!(e.buttons & 1)) { st = null; return; }
      if (Math.hypot(s.x - s.x0, s.y - s.y0) < 5) return;
      s.on = true;
      s.dt = new DataTransfer();
      // (the moves and the letting go come here even outside the list or the window)
      try { s.src.setPointerCapture(s.id); } catch { /* gone */ }
      const x = s.x, y = s.y;
      s.x = s.x0; s.y = s.y0;
      fire(s, s.src, 'dragstart');
      s.x = x; s.y = y;
      // (the list takes in what dragstart set before the first dragover: React updates after this event)
      win.setTimeout(() => { if (st === s) move(s); }, 0);
      win.getSelection()?.removeAllRanges();
      doc.body.classList.add('pdragging');
      const g = doc.createElement('div');
      g.className = 'pdrag-ghost';
      const txt = (s.src.querySelector('[data-pdrag-label]')?.textContent || s.src.textContent || '').trim().replace(/\s+/g, ' ');
      g.textContent = txt.length > 46 ? txt.slice(0, 45) + '…' : txt;
      doc.body.appendChild(g);
      s.ghost = g;
      // (as the browser's own: dragover again and again while held still - the edge scrolling needs it)
      s.tick = win.setInterval(() => { if (st === s) move(s); }, 70);
    }
    e.preventDefault();
    if (!just) move(s);
  }, true);
  // (let go: where it is over is asked once more after the list has caught up, then dropped there)
  doc.addEventListener('pointerup', (e) => {
    const s = st;
    if (!s || e.pointerId !== s.id) return;
    st = null;
    if (!s.on) return;
    killClick();
    s.x = e.clientX; s.y = e.clientY;
    win.setTimeout(() => { move(s); end(true, s); }, 0);
  }, true);
  doc.addEventListener('pointercancel', (e) => { if (st && e.pointerId === st.id) end(false); }, true);
  win.addEventListener('blur', () => end(false));
  doc.addEventListener('keydown', (e) => { if (st?.on && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); } }, true);
  // (the wheel scrolls the list under the pointer: where it is over has moved)
  doc.addEventListener('wheel', () => { const s = st; if (s?.on) win.requestAnimationFrame(() => { if (st === s) move(s); }); }, { capture: true, passive: true });
}
