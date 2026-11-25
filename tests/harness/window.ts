// A window-less stand-in for the app: window.gt built the way electron/preload.cjs builds it, on the
// real electron/nodefs.cjs and the real main-process handlers (electron/main.cjs, via ./main.cjs).
// Import this BEFORE anything from src/ui. (v0.12.5 review, debug run 1)
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const nodefs = require('../../electron/nodefs.cjs');
const loadMain = require('./main.cjs');

export const ROOT = mkdtempSync(join(tmpdir(), 'gt-harness-'));
export const userData = join(ROOT, 'userData');
mkdirSync(userData, { recursive: true });
export const main = loadMain(userData);

export const calls: { name: string; args: unknown[] }[] = [];
/** test hooks: replace a bridge function for one scenario */
export const hooks: { remove?: (p: string) => Promise<void>; heavy?: (...a: any[]) => Promise<any>; fetch?: (...a: any[]) => Promise<any> } = {};

const plain = (e: any) => { throw new Error(String((e && e.message) || e)); };
let seq = 0;
const listeners: ((e: any) => void)[] = [];
const win: any = {
  addEventListener: (t: string, f: any) => { if (t === 'message') listeners.push(f); },
  postMessage: (data: any, _o: string, ports?: any[]) => { const ev = { source: win, data, ports: ports ?? [] }; for (const f of listeners) f(ev); },
  gt: {
    fs: {
      join: (...p: string[]) => nodefs.join(...p),
      mkdirp: (p: string) => nodefs.mkdirp(p),
      list: (d: string) => nodefs.list(d),
      readText: (p: string) => nodefs.readText(p),
      readFrom: async (p: string, o: number, m: number) => { const r = await nodefs.readFrom(p, o, m); return r && { size: r.size, data: new Uint8Array(r.data) }; },
      writeAtomic: (p: string, t: string) => nodefs.writeAtomic(p, t),
      remove: (p: string) => { calls.push({ name: 'remove', args: [p] }); return hooks.remove ? hooks.remove(p) : nodefs.remove(p); },
      exists: (p: string) => nodefs.exists(p),
    },
    files: {
      stat: (p: string) => nodefs.stat(p),
      readBytes: async (p: string) => { const b = await nodefs.readBytes(p); return b && new Uint8Array(b); },
      writeBytes: (p: string, d: Uint8Array, u?: string) => nodefs.writeBytes(p, Buffer.from(d), u),
      listPdfs: (d: string) => nodefs.listPdfs(d),
    },
    pdf: {
      start: async () => true,
      restart: async () => true,
      stop: async () => true,
      fetch: (src: string, cache: string, mode: string, _onProgress?: any, onStart?: (id: string) => void) => {
        calls.push({ name: 'fetch', args: [src, mode] });
        const id = ++seq + '-x';
        onStart?.(id);
        if (hooks.fetch) return hooks.fetch(src, cache, mode, id);
        return main.invoke('pdf:fetch', id, String(src), String(cache), String(mode)).catch(plain);
      },
      heavy: (src: any, outBase: string, mode: string, pages: number[], bg?: boolean) => { calls.push({ name: 'heavy', args: [src, outBase, mode, pages, !!bg] }); return hooks.heavy ? hooks.heavy(src, outBase, mode, pages, bg) : Promise.resolve({ result: { pages: [], ms: 0 }, error: '' }); },
      drop: (p: string) => main.invoke('pdf:drop', String(p)),
      cancel: (id: string) => { calls.push({ name: 'cancel', args: [id] }); return main.invoke('pdf:cancel', String(id)); },
      setAside: (p: string) => { calls.push({ name: 'setAside', args: [p] }); return main.invoke('pdf:setAside', String(p)); },
    },
    drives: async () => ({}),
    log: (l: string) => calls.push({ name: 'log', args: [l] }),
  },
};
(globalThis as any).window = win;
