/// <reference lib="webworker" />
// Picture work off the interface thread (v0.12.5: the PDF engines themselves are background
// processes now, see pdfengine.ts):
//  - encode: a sheet's preview as WebP (kept on this PC and in the project for everyone)
//  - asPdf: a picture named .pdf (PNG, JPEG...) wrapped in a one-page PDF the engines can read
import { asPdf } from './imagepdf';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  const { id, t } = msg;
  try {
    if (t === 'encode') {
      const c = new OffscreenCanvas(msg.bmp.width, msg.bmp.height);
      c.getContext('2d')!.drawImage(msg.bmp, 0, 0);
      msg.bmp.close?.();
      const blob = await c.convertToBlob({ type: 'image/webp', quality: msg.quality ?? 0.88 });
      const buf = await blob.arrayBuffer();
      self.postMessage({ id, ok: true, data: buf }, [buf]);
      return;
    }
    if (t === 'asPdf') {
      const { pdf, converted } = await asPdf(new Uint8Array(msg.data));
      const buf = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
      self.postMessage({ id, ok: true, pdf: buf, converted }, [buf]);
      return;
    }
    throw new Error('unknown request ' + t);
  } catch (err: any) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
};
