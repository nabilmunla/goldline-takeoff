// Ids that earlier versions of this app (the company version it grew out of) wrote into project
// files, accounts folders, backups and notes on shared folders. Those files are still out there and
// must keep opening, so the old ids are RECOGNISED - by their SHA-256, not by spelling - and read as
// the ids written today. A project's project.json keeps the format it was made with (journals are
// append-only and an existing project is never rewritten for this).
// In a team folder set up by the earlier version the earlier ids are also WRITTEN (formatFor): PCs
// still on that version list, restore and follow only those, so a take-off, a backup or a moved-folder
// note made there by this version must carry them. A team folder set up by this version gets today's.
//
// Every check of a file's `format` goes through formatOf() / formatIs().

/** the format ids written today */
export const FORMAT = {
  takeoff: 'takeoff',
  hub: 'takeoff-boq',
  accounts: 'takeoff-accounts',
  backup: 'takeoff-backup',
  moved: 'takeoff-moved',
  /** a project of the earlier estimation app: listed nowhere, kept only so it is not mistaken for a take-off */
  estimation: 'estimation',
  library: 'library',
} as const;
export type FormatId = (typeof FORMAT)[keyof typeof FORMAT];

/** SHA-256 (hex) of an id written by the earlier company version -> the id it reads as now */
export const LEGACY_FORMATS: Record<string, FormatId> = {
  '3bff4c325acdf7386ddb4aefd98d85cb2435e76885990dac2cca2254934be626': FORMAT.takeoff,
  '8658ad2657c2b3937dcb0a185b42cd1b2abed50fd8d186627330864767f100fc': FORMAT.estimation,
  '6261a1d0475b776fa2a9abe67d00dd69ef1baded4d8da46eeeaf8ce7b752a37b': FORMAT.accounts,
  '0b6555ac51e3e34a456dc922ca2f5e26b31e8c6f702fdee069c2d1d1efb6e2ce': FORMAT.library,
  'dd443eea4a425af1fb6e67e05b07549720532655f49fb79b3d6678fded0abe9e': FORMAT.backup,
  '86d9914433c0f42b302d31eb665095d537e9f14e0af6ec97e218f399432ed6d6': FORMAT.moved,
};

/**
 * The salt of the ids made from a file or a tag (qto/revisions.ts idOf, qto/ops.ts doorIdFor). Those ids are
 * compared across PCs and versions: the same drawing brought in on two PCs makes ONE sheet, a bound set split
 * on any PC is found again by its page sheets' ids (model.ts, Sheets16.tsx). So the salt the earlier version
 * used is kept for good - a new one would give every drawing, page and schedule row a second id (duplicates,
 * page sheets and tabs lost after a split). Put together here, not spelled out: it names the product those
 * versions were (tests/sweep-b.test.ts pins ids the earlier version made).
 */
export const ID_SALT = ['g', 'c', 'c', '|'].join('');

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of a string (UTF-8), as lower-case hex. Pure JS, synchronous: ids are checked in the
 *  middle of reading a file, and the same code runs in the window and in Node. */
export function sha256Hex(text: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) { const d = text.charCodeAt(i + 1); if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } }
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 0xff);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < bytes.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = (bytes[o + i * 4] << 24) | (bytes[o + i * 4 + 1] << 16) | (bytes[o + i * 4 + 2] << 8) | bytes[o + i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

const NOW = new Set<string>(Object.values(FORMAT));

/** the ids as the earlier version spelled them (put together: they name the product it was). Each one's
 *  SHA-256 is its key in LEGACY_FORMATS (tests/sweep-b.test.ts checks it). */
const EARLIER_PRE = ['g', 'c', 'c', '-'].join('');
const EARLIER: Partial<Record<FormatId, string>> = {
  [FORMAT.takeoff]: EARLIER_PRE + 'takeoff',
  [FORMAT.accounts]: EARLIER_PRE + 'estimation-accounts',
  [FORMAT.backup]: EARLIER_PRE + 'backup',
  [FORMAT.moved]: EARLIER_PRE + 'moved',
};
/** a project.json / note / backup that carries an id the earlier version wrote */
export function isEarlierFormat(meta: { format?: unknown } | null | undefined): boolean {
  const v = meta && typeof meta === 'object' ? meta.format : undefined;
  return typeof v === 'string' && !!v && !NOW.has(v) && sha256Hex(v) in LEGACY_FORMATS;
}
/**
 * The format id to WRITE for something made in, or for, `like`: the team's accounts (a new take-off, a
 * moved-folder note), the project a backup is made of. Written the earlier version's way where `like`
 * carries an earlier id - PCs still on that version only list `takeoff`s, restore `backup`s and follow
 * `moved` notes spelled their way; today's otherwise (and for an id the earlier version did not have).
 */
export function formatFor(id: FormatId, like: { format?: unknown } | null | undefined): string {
  return isEarlierFormat(like) ? EARLIER[id] ?? id : id;
}

/** a format id as read from a file, read as the id written today ('' when it is no string / unknown) */
export function normFormat(v: unknown): string {
  if (typeof v !== 'string' || !v) return '';
  if (NOW.has(v)) return v;
  return LEGACY_FORMATS[sha256Hex(v)] ?? v;
}

/** the format of a project.json (or a note, a backup file): today's id, whichever version wrote it */
export function formatOf(meta: { format?: unknown } | null | undefined): string {
  return meta && typeof meta === 'object' ? normFormat(meta.format) : '';
}
export const formatIs = (meta: { format?: unknown } | null | undefined, id: FormatId): boolean => formatOf(meta) === id;
