// File access used by the app (via preload), tests and stress runs.
// Written to behave well on Windows network shares:
//  - every read opens the file fresh, so we never trust cached sizes
//  - every append is open -> write -> flush (fsync) -> close
//  - "atomic" writes go to a temp file then rename; a rename that is blocked (a
//    program holding the file at that instant) is tried again for about 2 s, then
//    the write FAILS - never a direct write over the file instead: a write cut short
//    there (the disk full, the share gone) would leave the only copy half written
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'UNKNOWN']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!RETRYABLE.has(e && e.code)) throw e;
      await sleep(40 * (i + 1));
    }
  }
  throw last;
}

/** the temp file put in place of p; on failure the temp file goes and p is as it was */
async function putInPlace(tmp, p) {
  try {
    await retry(() => fsp.rename(tmp, p), 10);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

module.exports = {
  join: (...p) => path.join(...p),

  async mkdirp(p) {
    await fsp.mkdir(p, { recursive: true });
  },

  /** create one folder; false if it is already there (two people creating the same name at once) */
  async mkdirExcl(p) {
    try {
      await fsp.mkdir(p);
      return true;
    } catch (e) {
      if (e && e.code === 'EEXIST') return false;
      throw e;
    }
  },

  async list(dir) {
    try {
      const ents = await fsp.readdir(dir, { withFileTypes: true });
      return ents.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  },

  async readText(p) {
    try {
      return await retry(() => fsp.readFile(p, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  },

  async readFrom(p, offset, maxBytes) {
    let fh;
    try {
      fh = await retry(() => fsp.open(p, 'r'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    try {
      const st = await fh.stat();
      const size = st.size;
      if (size <= offset) return { size, data: new Uint8Array(0) };
      const len = Math.min(size - offset, maxBytes);
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const { bytesRead } = await fh.read(buf, got, len - got, offset + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      return { size, data: new Uint8Array(buf.buffer, buf.byteOffset, got) };
    } finally {
      await fh.close();
    }
  },

  async append(p, text) {
    const fh = await retry(() => fsp.open(p, 'a'));
    try {
      // every byte: a network file may take less than asked in one write
      const buf = Buffer.from(String(text), 'utf8');
      let off = 0;
      while (off < buf.length) {
        const { bytesWritten } = await fh.write(buf, off, buf.length - off);
        if (!bytesWritten) throw Object.assign(new Error('nothing could be written'), { code: 'EIO' });
        off += bytesWritten;
      }
      await fh.sync();
    } finally {
      await fh.close();
    }
  },

  async writeAtomic(p, text) {
    const tmp = p + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    // (a write cut short - the disk full - leaves nothing behind)
    try { await fsp.writeFile(tmp, text); } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
    await putInPlace(tmp, p);
  },

  async remove(p) {
    try {
      await fsp.unlink(p);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  },

  /** size and modified time, or null if missing */
  async stat(p) {
    try {
      const st = await retry(() => fsp.stat(p));
      return { size: st.size, mtime: Math.round(st.mtimeMs), isDir: st.isDirectory() };
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
      throw e;
    }
  },

  /** whole file as bytes, or null if missing */
  async readBytes(p) {
    try {
      const b = await retry(() => fsp.readFile(p));
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  },

  /** write bytes via temp file + rename (never leaves a half-written file under the real name) */
  /**
   * `under`: a folder on the share this file belongs in - the file's folders are only made below it
   * when it is there (a dropped drive or a moved folder must never be made again, empty, elsewhere)
   */
  async writeBytes(p, data, under) {
    if (under) {
      const st = await fsp.stat(under).catch(() => null);
      if (!st || !st.isDirectory()) throw Object.assign(new Error('The folder ' + under + ' is not reachable.'), { code: 'ENOENT' });
    }
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = p + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try { await fsp.writeFile(tmp, data); } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
    await putInPlace(tmp, p);
  },

  /** every PDF under a folder (recursive), skipping hidden/system folders */
  /**
   * Every PDF under a folder. When it had to stop (too many files, folders nested too deep) or a
   * folder could not be read, the last entry says so ({ truncated }) - nothing is left out silently.
   */
  async listPdfs(root, max = 20000, maxDepth = 24) {
    const out = [];
    let deep = 0, unreadable = 0;
    const walk = async (dir, depth) => {
      if (out.length >= max) return;
      if (depth > maxDepth) { deep++; return; }
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { unreadable++; return; }
      ents.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const e of ents) {
        if (out.length >= max) return;
        if (e.name.startsWith('.') || e.name.startsWith('~$') || e.name === '$RECYCLE.BIN') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else if (/\.pdf$/i.test(e.name)) {
          try {
            const st = await fsp.stat(full);
            out.push({ path: full, rel: path.relative(root, full), size: st.size, mtime: Math.round(st.mtimeMs) });
          } catch (_) { /* vanished */ }
        }
      }
    };
    await walk(root, 0);
    const why = [];
    if (out.length >= max) why.push(`stopped at ${max} files`);
    if (deep) why.push(`${deep} folder${deep > 1 ? 's' : ''} nested more than ${maxDepth} deep not looked in`);
    if (unreadable) why.push(`${unreadable} folder${unreadable > 1 ? 's' : ''} could not be read`);
    if (why.length) out.push({ path: '', rel: '', size: -1, mtime: 0, truncated: why.join('; ') });
    return out;
  },

  /** a file copied whole (temp + rename: never half a file under the real name) */
  async copy(src, dst) {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    const tmp = dst + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try { await retry(() => fsp.copyFile(src, tmp)); } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
    try {
      await retry(() => fsp.rename(tmp, dst), 2);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
  },

  /** an empty folder removed (a folder with anything in it stays) */
  async rmdir(p) {
    try {
      await fsp.rmdir(p);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') throw e;
    }
  },

  async exists(p) {
    try {
      await fsp.access(p);
      return true;
    } catch (_) {
      return false;
    }
  },
};
