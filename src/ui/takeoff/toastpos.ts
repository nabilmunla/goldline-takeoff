import type { CSSProperties } from 'react';

/**
 * v0.17.1 (the audit: messages popped up over the settings fields they talk about) - a take-off's messages sit over
 * the drawing, above its bottom strip, wherever the side panels are: the style for `.toasts.side`
 */
export function overDrawing(): CSSProperties | undefined {
  const el = document.querySelector('.qto-center[data-place="main"] .qto-stage') as HTMLElement | null;
  const r = el?.getBoundingClientRect();
  if (!r || r.width < 220) return undefined;
  return { left: r.left + r.width / 2, right: 'auto', transform: 'translateX(-50%)', bottom: Math.max(16, window.innerHeight - r.bottom + 62), alignItems: 'center', maxWidth: Math.min(520, r.width - 24) };
}

