// Take-off icons (same 16px / 1.6px stroke style as the rest of the app)
import type { ReactElement } from 'react';

const S = ({ children, size = 16 }: { children: ReactElement | ReactElement[]; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

const PATHS: Record<string, ReactElement | ReactElement[]> = {
  select: <path d="M3.5 2.5l8.5 5-3.8 1 2.3 4.2-1.6.8-2.3-4.2L4 12z" />,
  area: [<path key="a" d="M3 4.5l5-2 5 3-1 7.5-8.5-1z" />, <path key="b" d="M3 4.5l5-2 5 3-1 7.5-8.5-1z" fill="currentColor" opacity=".18" stroke="none" />],
  line: [<path key="a" d="M2.5 12.5l4-6 3 3 4-6.5" />, <circle key="b" cx="2.5" cy="12.5" r="1" fill="currentColor" />, <circle key="c" cx="13.5" cy="3" r="1" fill="currentColor" />],
  count: [<circle key="a" cx="4.5" cy="5" r="1.8" />, <circle key="b" cx="11" cy="4.5" r="1.8" />, <circle key="c" cx="7.5" cy="11" r="1.8" />],
  hole: [<rect key="a" x="2.5" y="2.5" width="11" height="11" rx="1" />, <rect key="b" x="6" y="6" width="4.5" height="4.5" strokeDasharray="1.6 1.6" />],
  scale: [<path key="a" d="M2 11l9-9 3 3-9 9z" />, <path key="b" d="M5 8l1.3 1.3M7 6l1.3 1.3M9 4l1.3 1.3" />],
  region: [<rect key="a" x="2.5" y="3.5" width="11" height="9" rx="1" strokeDasharray="2 1.6" />, <path key="b" d="M5.5 9.5l2-2 1.5 1.5 2-2.5" />],
  note: [<path key="a" d="M3 3h10v7.5H8l-3 2.5v-2.5H3z" />],
  snap: [<path key="a" d="M3 13V8a5 5 0 0110 0v5" />, <path key="b" d="M3 10.5h3M10 10.5h3" />],
  sidebar: [<rect key="a" x="2.5" y="3" width="11" height="10" rx="1.5" />, <path key="b" d="M6 3v10" />],
  undo: [<path key="a" d="M5.5 6.5H10a3 3 0 010 6H7" />, <path key="b" d="M7.5 4l-2.5 2.5L7.5 9" />],
  redo: [<path key="a" d="M10.5 6.5H6a3 3 0 000 6h3" />, <path key="b" d="M8.5 4l2.5 2.5L8.5 9" />],
  fit: [<path key="a" d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />],
  excel: [<rect key="a" x="2.5" y="2.5" width="11" height="11" rx="1.5" />, <path key="b" d="M5.5 5.5l5 5M10.5 5.5l-5 5" />],
  folder: <path d="M2 4.5h4l1.3 1.5H14v7H2z" />,
  file: [<path key="a" d="M4 2h5.5L12 4.5V14H4z" />, <path key="b" d="M9.5 2v2.5H12" />],
  link: [<path key="a" d="M6.5 9.5l3-3" />, <path key="b" d="M7 4.5l1-1a2.6 2.6 0 013.7 3.7l-1 1M9 11.5l-1 1a2.6 2.6 0 01-3.7-3.7l1-1" />],
  lock: [<rect key="a" x="3.5" y="7" width="9" height="6.5" rx="1.2" />, <path key="b" d="M5.5 7V5.5a2.5 2.5 0 015 0V7" />],
  warn: [<path key="a" d="M8 2.5l6 10.5H2z" />, <path key="b" d="M8 6.5v3M8 11.3v.1" />],
  eye: [<path key="a" d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />, <circle key="b" cx="8" cy="8" r="1.8" />],
  plus: <path d="M8 3v10M3 8h10" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3 8.5l3 3 7-7" />,
  pin: [<path key="a" d="M8 14s4.5-4.4 4.5-7.5a4.5 4.5 0 00-9 0C3.5 9.6 8 14 8 14z" />, <circle key="b" cx="8" cy="6.5" r="1.5" />],
  chev: <path d="M4 6l4 4 4-4" />,
  rect: [<rect key="a" x="2.5" y="4" width="11" height="8" rx=".5" />, <rect key="b" x="2.5" y="4" width="11" height="8" fill="currentColor" opacity=".18" stroke="none" />],
  circle: [<circle key="a" cx="8" cy="8" r="5.5" />, <circle key="b" cx="8" cy="8" r="5.5" fill="currentColor" opacity=".18" stroke="none" />, <path key="c" d="M8 8h5.5" />],
  arc: <path d="M2.5 12.5a7 7 0 0111 0" />,
  measure: [<path key="a" d="M1.8 10.5l8.7-8.7 3.7 3.7-8.7 8.7z" />, <path key="b" d="M4.3 8l1.2 1.2M6.3 6l1.8 1.8M8.3 4l1.2 1.2" />],
  list: [<path key="a" d="M6 4h7.5M6 8h7.5M6 12h7.5" />, <path key="b" d="M2.5 4h.1M2.5 8h.1M2.5 12h.1" />],
  wall: [<path key="a" d="M2 5h12M2 8h12M2 11h12M2 5v6M14 5v6" />, <path key="b" d="M6 5v3M10 5v3M4 8v3M8 8v3M12 8v3" />],
  // (v0.17 structural: a column in plan, a slab's edge, a drop panel under a slab, a shear wall, the Schedules / Finalize buttons)
  column: [<path key="a" d="M4.5 4.5h7v7h-7z" />, <path key="b" d="M4.5 4.5h7v7h-7z" fill="currentColor" opacity=".25" stroke="none" />, <path key="c" d="M2 8h2.5M11.5 8H14M8 2v2.5M8 11.5V14" />],
  slab: [<path key="a" d="M1.5 6.5l4-3h9l-4 3z" />, <path key="b" d="M1.5 6.5v3h9v-3M10.5 9.5l4-3v-3" />, <path key="c" d="M1.5 6.5l4-3h9l-4 3z" fill="currentColor" opacity=".18" stroke="none" />],
  drop: [<path key="a" d="M1.5 4.5h13v2.5h-13z" />, <path key="b" d="M5 7v3h6V7" />, <path key="c" d="M5 7v3h6V7z" fill="currentColor" opacity=".25" stroke="none" />],
  shear: [<path key="a" d="M5.5 2.5h5v11h-5z" />, <path key="b" d="M5.5 2.5h5v11h-5z" fill="currentColor" opacity=".25" stroke="none" />, <path key="c" d="M5.5 6l5-2M5.5 10l5-2M5.5 13.5l5-2" />],
  summary: [<path key="a" d="M3 2.5h10v11H3z" />, <path key="b" d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />],
  struct: [<path key="a" d="M2 13.5h12M3.5 13.5V6h9v7.5M2 6h12" />, <path key="b" d="M6.5 13.5V9h3v4.5" />],
  collapse: [<path key="a" d="M4 6l4-3.5L12 6M4 10l4 3.5L12 10" transform="rotate(180 8 8)" />, <path key="b" d="M2.5 8h11" />],
  expand: [<path key="a" d="M4 5.5L8 2l4 3.5M4 10.5L8 14l4-3.5" />, <path key="b" d="M2.5 8h11" opacity=".0" />],
  beam: [<path key="a" d="M1.5 5.5h13v2.5h-13z" />, <path key="b" d="M4 8v5M12 8v5" />, <path key="c" d="M1.5 5.5h13v2.5h-13z" fill="currentColor" opacity=".18" stroke="none" />],
  // (v0.16 g1: the Room tool - a plan of a room, its door gap in one wall)
  room: [<path key="a" d="M6.5 13.5H2.5v-11h11v11h-3" />, <path key="b" d="M6.5 13.5a4 4 0 014-4" />, <path key="c" d="M2.5 2.5h11v11h-11z" fill="currentColor" opacity=".14" stroke="none" />],
  door: [<path key="a" d="M3 13.5h10" />, <path key="b" d="M4.5 13.5V2.5h7v11" />, <path key="c" d="M9.3 8.3h.1" />],
  auto: [<circle key="a" cx="6.5" cy="6.5" r="4" />, <path key="b" d="M9.5 9.5l4 4" />, <path key="c" d="M5 6.5l1.2 1.2 2.2-2.4" />],
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v4M9.2 7v4" />,
  rotate: <path d="M12.5 8a4.5 4.5 0 11-1.6-3.4M12.8 2.5v2.6h-2.6" />,
  image: [<rect key="a" x="2.5" y="3" width="11" height="10" rx="1.2" />, <path key="b" d="M2.8 11l3-3 2.2 2.2 2-2 3.2 3.2" />, <circle key="c" cx="10.5" cy="6" r="1" />],
  overlay: [<rect key="a" x="2.5" y="2.5" width="8" height="8" rx="1" />, <rect key="b" x="5.5" y="5.5" width="8" height="8" rx="1" strokeDasharray="2 1.5" />],
  footing: [<path key="a" d="M2 13.5h12v-3H2z" />, <path key="b" d="M6 10.5v-7h4v7" />],
  // v0.18.1 slab on grade (on the ground), retaining wall (stem and base, soil on one side), customize
  sog: [<path key="a" d="M1.5 6.5l4-3h9l-4 3z" />, <path key="b" d="M1.5 6.5V9h9V6.5M10.5 9l4-3V3.5" />, <path key="c" d="M1 12h14M3 14.5l2-2.5M7 14.5l2-2.5M11 14.5l2-2.5" />],
  rw: [<path key="a" d="M6 2.5h2.5V12H13.5v2.5h-11V12H6z" />, <path key="b" d="M10.5 5l3-2M10.5 8l3-2M10.5 11l2.5-1.7" />],
  cog: [<circle key="a" cx="8" cy="8" r="2.4" />, <path key="b" d="M8 1.5v2.2M8 12.3v2.2M1.5 8h2.2M12.3 8h2.2M3.4 3.4l1.5 1.5M11.1 11.1l1.5 1.5M3.4 12.6l1.5-1.5M11.1 4.9l1.5-1.5" />],
  stair: <path d="M2 13.5h3v-3h3v-3h3v-3h3" />,
  swall: [<rect key="a" x="2.5" y="5.5" width="11" height="5" rx="0.6" />, <path key="b" d="M5 5.5v5M8 5.5v5M11 5.5v5" />],
  misc: [<rect key="a" x="2.5" y="6.5" width="11" height="6.5" rx="0.8" />, <path key="b" d="M8 6.5v6.5M5 9.5h1M10 9.5h1M4 6.5V4h8v2.5" />],
  copy: [<rect key="a" x="5" y="5" width="8.5" height="8.5" rx="1.2" />, <path key="b" d="M3 10.5V3.5A1 1 0 014 2.5h6.5" />],
  path: [<path key="a" d="M2.5 12l3-8 5 2.5 3 6.5z" />, <circle key="b" cx="2.5" cy="12" r=".9" fill="currentColor" />, <circle key="c" cx="5.5" cy="4" r=".9" fill="currentColor" />],
  layers: [<path key="a" d="M8 2.5l6 3-6 3-6-3z" />, <path key="b" d="M2 8.5l6 3 6-3M2 11.5l6 3 6-3" />],
};

export function TIcon({ k, size }: { k: string; size?: number }) {
  return <S size={size}>{(PATHS[k] ?? PATHS.select) as any}</S>;
}
