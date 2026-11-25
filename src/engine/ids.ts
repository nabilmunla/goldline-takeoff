const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyz';

export function randomId(len = 10): string {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHA[bytes[i] % 36];
  return s;
}

/** Safe for file names on Windows shares */
export function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'user';
}

const PALETTE = ['#2f7dd1', '#c2410c', '#0f8a5f', '#9333ea', '#d61f69', '#0e7490', '#b45309', '#4f46e5', '#15803d', '#be123c'];

export function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
