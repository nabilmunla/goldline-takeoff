/// <reference types="node" />
// File access for the PDF engines (each runs as a Node process of its own, see host.ts): a drawing
// is read on demand - only the bytes the pages being drawn need - so a 350 MB bound set costs a few
// MB of memory, not 350 MB (as the PDF Editor does it).
//
// A source is a file on disk, optionally "a file plus changes": the first `size` bytes of `path`
// followed by the bytes of `delta` (a monster sheet's simplified line work is written as an
// incremental update: the original + appended changes - only the appended part is kept).
import fs from 'node:fs';

/** mtime: the base file as it was when the changes (delta) were written against it - a file saved
 *  over in between is refused (its start is not what the changes belong to) */
export interface FileSrc { path: string; size?: number; delta?: string; mtime?: number }
export const isFileSrc = (s: unknown): s is FileSrc => !!s && typeof s === 'object' && !ArrayBuffer.isView(s) && typeof (s as FileSrc).path === 'string';

/** what an engine reads a document from */
export interface Reader { readonly size: number; read(buf: Uint8Array, off: number, len: number, pos: number): number; close(): void }

interface Part { fd: number; start: number; len: number }

/** a source read in pieces; a file, or a file and its changes back to back */
export class VFile implements Reader {
  readonly parts: Part[] = [];
  readonly size: number;
  /** the file as it was when opened (from the open handle: describes exactly the bytes read) */
  readonly opened: { size: number; mtime: number };
  private closed = false;
  constructor(src: FileSrc) {
    const fds: number[] = [];
    try {
      const a = fs.openSync(src.path, 'r');
      fds.push(a);
      const st = fs.fstatSync(a);
      this.opened = { size: st.size, mtime: st.mtimeMs };
      if (src.delta && src.mtime != null && Math.abs(st.mtimeMs - src.mtime) > 1) throw new Error('The file was changed meanwhile');
      if (src.delta && src.size != null && st.size < src.size) throw new Error('The file was changed meanwhile');
      const baseLen = src.delta ? Math.min(st.size, src.size ?? st.size) : st.size;
      this.parts.push({ fd: a, start: 0, len: baseLen });
      if (src.delta) {
        const b = fs.openSync(src.delta, 'r');
        fds.push(b);
        this.parts.push({ fd: b, start: baseLen, len: fs.fstatSync(b).size });
      }
    } catch (e) {
      for (const f of fds) try { fs.closeSync(f); } catch { /* */ }
      throw e;
    }
    this.size = this.parts.reduce((s, p) => s + p.len, 0);
  }
  /** read len bytes at pos into buf[off..]; returns the bytes read (short only at the end) */
  read(buf: Uint8Array, off: number, len: number, pos: number): number {
    if (this.closed) return 0;
    let done = 0;
    for (const p of this.parts) {
      if (done >= len) break;
      const at = pos + done;
      if (at >= p.start + p.len || at < p.start) continue;
      const want = Math.min(len - done, p.start + p.len - at);
      let got = 0;
      while (got < want) {
        const n = fs.readSync(p.fd, buf, off + done + got, want - got, at - p.start + got);
        if (n <= 0) break; // the file is shorter than it was
        got += n;
      }
      done += got;
      if (got < want) break;
    }
    return done;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.parts) try { fs.closeSync(p.fd); } catch { /* already closed */ }
  }
}
