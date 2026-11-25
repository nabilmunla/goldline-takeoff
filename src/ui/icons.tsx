// Small inline icon set (1.6px strokes, 16px box)
import type { ReactElement } from 'react';

const S = (p: { d: ReactElement | ReactElement[]; size?: number }) => (
  <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {p.d}
  </svg>
);

export const IChevron = () => <S size={14} d={<path d="M4 6l4 4 4-4" />} />;
export const IPlus = () => <S d={<path d="M8 3v10M3 8h10" />} />;
export const IHeading = () => <S d={[<path key="a" d="M3 4h10" />, <path key="b" d="M3 8h6M3 12h8" />]} />;
export const ITrash = () => <S d={[<path key="a" d="M3 4.5h10M6.5 4.5V3h3v1.5" />, <path key="b" d="M4.5 4.5l.6 8.5h5.8l.6-8.5" />]} />;
export const IUndo = () => <S d={[<path key="a" d="M5.5 6.5H10a3 3 0 010 6H7" />, <path key="b" d="M7.5 4l-2.5 2.5L7.5 9" />]} />;
export const IRedo = () => <S d={[<path key="a" d="M10.5 6.5H6a3 3 0 000 6h3" />, <path key="b" d="M8.5 4l2.5 2.5L8.5 9" />]} />;
export const ISearch = () => <S size={14} d={[<circle key="a" cx="7" cy="7" r="4.2" />, <path key="b" d="M10.2 10.2L13.5 13.5" />]} />;
export const IPanel = () => <S d={[<rect key="a" x="2.5" y="3" width="11" height="10" rx="1.5" />, <path key="b" d="M10 3v10" />]} />;
export const ISidebar = () => <S d={[<rect key="a" x="2.5" y="3" width="11" height="10" rx="1.5" />, <path key="b" d="M6 3v10" />]} />;
export const ISun = () => <S d={[<circle key="a" cx="8" cy="8" r="2.8" />, <path key="b" d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1" />]} />;
export const IMoon = () => <S d={<path d="M12.8 9.6A5.2 5.2 0 016.4 3.2a5.2 5.2 0 106.4 6.4z" />} />;
export const IFolder = () => <S d={<path d="M2.5 4.5a1 1 0 011-1h3l1.5 1.5h4.5a1 1 0 011 1v6a1 1 0 01-1 1h-9a1 1 0 01-1-1z" />} />;
export const IBin = () => <S d={[<path key="a" d="M2.5 5.5h11l-1 7.5h-9z" />, <path key="b" d="M5 5.5l1-2.5h4l1 2.5" />]} />;
export const IRefresh = () => <S d={[<path key="a" d="M13 8a5 5 0 11-1.5-3.6" />, <path key="b" d="M13 3v2.5h-2.5" />]} />;
export const IBack = () => <S d={<path d="M9.5 3.5L5 8l4.5 4.5" />} />;
export const IRestore = () => <S size={13} d={[<path key="a" d="M3 8a5 5 0 105-5H5.5" />, <path key="b" d="M7 1.5L5.3 3 7 4.5" />]} />;
export const IUsers = () => <S d={[<circle key="a" cx="6" cy="6" r="2.3" />, <path key="b" d="M2 13c.6-2.2 2.2-3.3 4-3.3s3.4 1.1 4 3.3" />, <path key="c" d="M10.5 3.9a2.2 2.2 0 010 4.2M12 9.9c1 .5 1.7 1.6 2 3.1" />]} />;
export const IMore = () => <S d={[<circle key="a" cx="3.5" cy="8" r="0.9" />, <circle key="b" cx="8" cy="8" r="0.9" />, <circle key="c" cx="12.5" cy="8" r="0.9" />]} />;
export const ISettings = () => <S size={14} d={[<circle key="a" cx="8" cy="8" r="2.2" />, <path key="b" d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3" />]} />;
export const ICheck = () => <S size={14} d={<path d="M3.5 8.5l3 3 6-7" />} />;
export const IImport = () => <S d={[<path key="a" d="M8 2.5v7" />, <path key="b" d="M5 6.8L8 9.8l3-3" />, <path key="c" d="M2.8 10.5v2a1 1 0 001 1h8.4a1 1 0 001-1v-2" />]} />;
export const IFile = () => <S size={14} d={[<path key="a" d="M4 1.8h5l3 3V14a.6.6 0 01-.6.6H4a.6.6 0 01-.6-.6V2.4a.6.6 0 01.6-.6z" />, <path key="b" d="M9 1.8v3h3" />]} />;
export const ILink = () => <S size={14} d={[<path key="a" d="M6.6 9.4l2.8-2.8" />, <path key="b" d="M7.4 4.6l1-1a2.6 2.6 0 013.7 3.7l-1 1" />, <path key="c" d="M8.6 11.4l-1 1a2.6 2.6 0 01-3.7-3.7l1-1" />]} />;
export const IWarn = () => <S size={14} d={[<path key="a" d="M8 2.2l6 10.8H2z" />, <path key="b" d="M8 6.6v3M8 11.4v.2" />]} />;
export const IStack = () => <S d={[<path key="a" d="M8 2.5l5.5 3L8 8.5 2.5 5.5z" />, <path key="b" d="M2.5 8.2L8 11.2l5.5-3M2.5 10.9L8 13.9l5.5-3" />]} />;
export const ICopy = () => <S d={[<rect key="a" x="5.5" y="5.5" width="8" height="8" rx="1.5" />, <path key="b" d="M10.5 5.5V3.8a1.3 1.3 0 00-1.3-1.3H3.8a1.3 1.3 0 00-1.3 1.3v5.4a1.3 1.3 0 001.3 1.3h1.7" />]} />;
export const IPaste = () => <S d={[<rect key="a" x="3.5" y="3" width="9" height="11" rx="1.5" />, <path key="b" d="M6 3V2h4v1M6 7.5h4M6 10h3" />]} />;
export const IExport = () => <S d={[<path key="a" d="M8 2.5v8M5 5.5l3-3 3 3" />, <path key="b" d="M3 9.5v3a1 1 0 001 1h8a1 1 0 001-1v-3" />]} />;
export const IClose = () => <S size={14} d={<path d="M4 4l8 8M12 4l-8 8" />} />;
export const IUp = () => <S size={12} d={<path d="M4 10l4-4 4 4" />} />;
export const IDown = () => <S size={12} d={<path d="M4 6l4 4 4-4" />} />;
export const IEq = () => <S d={<path d="M3.5 6h9M3.5 10h9" />} />;
export const IBox = () => <S d={[<path key="a" d="M2.5 5L8 2.5 13.5 5v6L8 13.5 2.5 11z" />, <path key="b" d="M2.5 5L8 7.5 13.5 5M8 7.5v6" />]} />;
export const ILock = () => <S d={[<rect key="a" x="3.5" y="7" width="9" height="6.5" rx="1.3" />, <path key="b" d="M5.5 7V5.2a2.5 2.5 0 015 0V7" />]} />;
export const IUnlock = () => <S d={[<rect key="a" x="3.5" y="7" width="9" height="6.5" rx="1.3" />, <path key="b" d="M5.5 7V5.2a2.5 2.5 0 014.8-1" />]} />;
