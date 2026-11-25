// Drawings that are not PDFs. Consultants sometimes issue pictures (PNG, JPEG) named ".pdf" —
// on one tender every file in the "CAD" folders was a PNG. PDFium only reads PDFs, so a picture is
// wrapped in a one-page PDF on the fly (nothing is written back to the server).
// Page size from the picture's own resolution (PNG pHYs / JPEG JFIF) — default 150 dpi —
// so a picture printed to scale keeps its scale; otherwise set the scale on the sheet as usual.
import { zlibSync } from 'fflate';

export type FileKind = 'pdf' | 'png' | 'jpeg' | 'gif' | 'bmp' | 'webp' | 'tiff' | 'dwg' | 'zip' | 'office' | 'html' | 'unknown';

export function fileKind(b: Uint8Array): FileKind {
  const s = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  // a PDF may have some junk before %PDF (allowed in the first 1 KB)
  const head = String.fromCharCode(...b.subarray(0, Math.min(1024, b.length)));
  if (head.includes('%PDF-')) return 'pdf';
  if (b[0] === 0x89 && s(1, 3) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (s(0, 4) === 'GIF8') return 'gif';
  if (s(0, 2) === 'BM') return 'bmp';
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return 'webp';
  if (s(0, 4) === 'II*\0' || s(0, 4) === 'MM\0*') return 'tiff';
  if (s(0, 4) === 'AC10') return 'dwg';
  if (s(0, 4) === 'PK\x03\x04') return 'zip';
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'office';
  // a web page saved with a .pdf name (a download link that answered with an error page)
  if (/^\s*(\ufeff)?\s*<(!doctype html|html|head|body)\b/i.test(head.replace(/^\xef\xbb\xbf/, ''))) return 'html';
  return 'unknown';
}

const LABEL: Record<FileKind, string> = {
  pdf: 'a PDF', png: 'a PNG picture', jpeg: 'a JPEG picture', gif: 'a GIF picture', bmp: 'a BMP picture', webp: 'a WebP picture',
  tiff: 'a TIFF picture', dwg: 'an AutoCAD drawing (DWG)', zip: 'a zip / Office file', office: 'an old Office file',
  html: 'a web page (often an error page saved by a download link)', unknown: 'a file of an unknown kind',
};

/** PDF bytes for any drawing file we can show; throws a readable reason otherwise */
export async function asPdf(b: Uint8Array): Promise<{ pdf: Uint8Array; converted: FileKind | null }> {
  if (!b.length) throw new Error('This file is empty (0 bytes): it may still be being copied, or the copy failed. Click the sheet again in a moment, or ask for the file again.');
  const k = fileKind(b);
  if (k === 'pdf') return { pdf: b, converted: null };
  if (k === 'jpeg') return { pdf: jpegPdf(b), converted: k };
  if (k === 'png' || k === 'gif' || k === 'bmp' || k === 'webp') return { pdf: await rasterPdf(b, k), converted: k };
  throw new Error(`This is not a PDF: the file is ${LABEL[k]} with a .pdf name. Ask the consultant for the PDF, or open it in its own program.`);
}

// ------------------------------------------------------------------ JPEG: embedded as it is
function jpegPdf(b: Uint8Array): Uint8Array {
  let i = 2, w = 0, h = 0, comps = 3, dpi = 0;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xe0 && String.fromCharCode(...b.subarray(i + 4, i + 9)) === 'JFIF\0') {
      const unit = b[i + 11], dx = (b[i + 12] << 8) | b[i + 13];
      if (unit === 1 && dx > 10) dpi = dx;
      else if (unit === 2 && dx > 4) dpi = dx * 2.54;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      h = (b[i + 5] << 8) | b[i + 6];
      w = (b[i + 7] << 8) | b[i + 8];
      comps = b[i + 9];
      break;
    }
    i += 2 + len;
  }
  if (!w || !h) throw new Error('This JPEG picture is damaged (no size found).');
  const cs = comps === 1 ? '/DeviceGray' : comps === 4 ? '/DeviceCMYK' : '/DeviceRGB';
  return buildPdf(w, h, dpi || 150, `/Width ${w} /Height ${h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode${comps === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : ''}`, b);
}

// ------------------------------------------------------------------ PNG & co: decoded, flattened on white
/** a picture's size from its header, without decoding it (PNG; others: null) */
function headerSize(b: Uint8Array, k: FileKind): { w: number; h: number } | null {
  if (k === 'png' && b.length > 24) {
    const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const w = u32(16), h = u32(20);
    return w && h ? { w, h } : null;
  }
  if (k === 'gif' && b.length > 10) return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
  if (k === 'bmp' && b.length > 26) {
    const i32 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
    return { w: Math.abs(i32(18)), h: Math.abs(i32(22)) };
  }
  return null;
}

/** at most this many pixels: sharp enough to measure on, without gigabytes of memory */
const MAX_PX = 64e6;

/**
 * RGBA pixels with no colour (R = G = B everywhere). Every pixel is looked at (BH-053: one in seven was,
 * and a small coloured mark between two of them was stored grey); a colour picture stops at its first
 * coloured pixel.
 */
export function isGrey(px: Uint8ClampedArray | Uint8Array): boolean {
  for (let i = 0; i < px.length; i += 4) if (px[i] !== px[i + 1] || px[i] !== px[i + 2]) return false;
  return true;
}

async function rasterPdf(b: Uint8Array, k: FileKind): Promise<Uint8Array> {
  const type = k === 'png' ? 'image/png' : k === 'gif' ? 'image/gif' : k === 'bmp' ? 'image/bmp' : 'image/webp';
  const blob = new Blob([b as BlobPart], { type });
  // decoded straight to the size kept (a 16000 × 11000 scan is never held whole)
  const hs = headerSize(b, k);
  const f0 = hs ? Math.min(1, Math.sqrt(MAX_PX / (hs.w * hs.h))) : 1;
  const bmp = hs && f0 < 1
    ? await createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(hs.w * f0)), resizeHeight: Math.max(1, Math.round(hs.h * f0)), resizeQuality: 'high' })
    : await createImageBitmap(blob);
  const w0 = hs?.w ?? bmp.width, h0 = hs?.h ?? bmp.height;
  const f1 = Math.min(1, Math.sqrt(MAX_PX / (bmp.width * bmp.height)));
  const W = Math.max(1, Math.round(bmp.width * f1)), H = Math.max(1, Math.round(bmp.height * f1));
  const f = W / w0;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  // read back in bands (never a second full copy of the picture); grey pictures (most drawings)
  // stored as grey: a third of the size
  const BAND = 256;
  let grey = true;
  for (let y = 0; y < H && grey; y += BAND) grey = isGrey(ctx.getImageData(0, y, W, Math.min(BAND, H - y)).data);
  const n = W * H;
  const raw = new Uint8Array(grey ? n : n * 3);
  for (let y = 0; y < H; y += BAND) {
    const rows = Math.min(BAND, H - y);
    const px = ctx.getImageData(0, y, W, rows).data;
    if (grey) { let j = y * W; for (let i = 0; i < px.length; i += 4) { raw[j++] = px[i]; } }
    else { let j = y * W * 3; for (let i = 0; i < px.length; i += 4) { raw[j++] = px[i]; raw[j++] = px[i + 1]; raw[j++] = px[i + 2]; } }
  }
  c.width = c.height = 1;
  const z = zlibSync(raw, { level: 6 });
  const dpi = (k === 'png' ? pngDpi(b) : 0) || 150;
  return buildPdf(W, H, dpi * f, `/Width ${W} /Height ${H} /ColorSpace ${grey ? '/DeviceGray' : '/DeviceRGB'} /BitsPerComponent 8 /Filter /FlateDecode`, z);
}

function pngDpi(b: Uint8Array): number {
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const t = String.fromCharCode(...b.subarray(i + 4, i + 8));
    if (t === 'pHYs' && len >= 9) {
      const ppm = ((b[i + 8] << 24) | (b[i + 9] << 16) | (b[i + 10] << 8) | b[i + 11]) >>> 0;
      if (b[i + 16] === 1 && ppm > 400) return ppm * 0.0254;
      return 0;
    }
    if (t === 'IDAT' || t === 'IEND') return 0;
    i += 12 + len;
  }
  return 0;
}

// ------------------------------------------------------------------ a one-page PDF around an image
function buildPdf(w: number, h: number, dpi: number, imageDict: string, data: Uint8Array): Uint8Array {
  const pw = (w * 72) / dpi, ph = (h * 72) / dpi;
  const fmt = (x: number) => x.toFixed(3);
  const content = `q ${fmt(pw)} 0 0 ${fmt(ph)} 0 0 cm /Im0 Do Q`;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let pos = 0;
  const offsets: number[] = [];
  const put = (x: string | Uint8Array) => { const u = typeof x === 'string' ? enc.encode(x) : x; parts.push(u); pos += u.length; };
  put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const obj = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = pos;
    put(`${n} 0 obj\n${body}\n`);
    if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
    put('endobj\n');
  };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(pw)} ${fmt(ph)}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`);
  obj(4, `<< /Length ${content.length} >>`, enc.encode(content));
  obj(5, `<< /Type /XObject /Subtype /Image ${imageDict} /Length ${data.length} >>`, data);
  const xref = pos;
  let x = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  put(x + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(pos);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
