// Accounts: who may sign in, their role, and their password hash.
// Stored in <shared folder>\_accounts and synced exactly like a project
// (append-only journals, one per writer), so two admins can work at once.
//
// Passwords are never stored. Only a PBKDF2-SHA256 hash (600,000 rounds, random
// salt) is kept. A new person gets a one-time setup code from an admin; they use
// it once to choose their own password.
//
// Honest limit: this controls who can use the APP. Someone with write access to
// the shared folder can still tamper with files outside the app. The real lock
// for that is Windows folder permissions.
import { Store } from './store';
import { encodeLine, splitBytes } from './codec';
import { Clock } from './hlc';
import { randomId, safeName } from './ids';
import { FORMAT } from './legacy';
import type { Batch, FsApi, Op, ProjectMeta, Value } from './types';

// Two roles: administrators (MAX_ADMINS at most - a person working alone simply stays the first one) and
// quantity surveyors. Accounts from the estimation versions: an estimator reads as a quantity surveyor (the
// stored value is never rewritten); a viewer stays view only (no new ones are made).
export type Role = 'admin' | 'qs' | 'viewer';
export const ROLE_LABEL: Record<Role, string> = { admin: 'Administrator', qs: 'Quantity surveyor', viewer: 'Viewer (view only)' };
export const isQs = (a: { role: Role }) => a.role === 'qs';
/** a stored role (any version) as this app reads it */
export const readRole = (v: unknown): Role => (v === 'admin' ? 'admin' : v === 'viewer' ? 'viewer' : 'qs');

export interface Account {
  username: string;
  name: string;
  role: Role;
  active: boolean;
  /** password hash, null until the person sets one */
  pw: string | null;
  /** hash of the one-time setup code, null once used */
  setup: string | null;
  created: number;
  createdBy: string;
  /** may see the tender price (markup, overhead, profit). Administrators always may. */
  price: boolean;
  /** last successful sign-in (ms) and the PC it was on */
  lastLogin: number;
  lastHost: string;
  /** the app version of that sign-in ('' before 0.13, which didn't say) */
  lastApp: string;
}

export const ACCOUNTS_FOLDER = '_accounts';
export const accountsDir = (fs: FsApi, dataRoot: string) => fs.join(dataRoot, ACCOUNTS_FOLDER);
export const userId = (username: string) => 'user:' + username;
export const MIN_PASSWORD = 8;
/** At most this many administrators; everyone else is an estimator or viewer (no limit). */
export const MAX_ADMINS = 3;

export function normUsername(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '').slice(0, 40);
}

/** titles in front of a name (Engr. Sara Khan): not part of a username or a first name */
const TITLE_RE = /^(?:eng|engr|mr|mrs|ms|miss|dr|arch|prof|sir|sheikh)\.*\s+/i;
export function withoutTitles(fullName: string): string {
  let n = fullName.trim();
  for (let i = 0; i < 4 && TITLE_RE.test(n); i++) n = n.replace(TITLE_RE, '');
  return n;
}
/** what to call someone in a sentence ("Give this to Sara") */
export const firstName = (fullName: string) => withoutTitles(fullName).split(/\s+/)[0] || fullName.trim();

export function suggestUsername(fullName: string): string {
  return normUsername(withoutTitles(fullName));
}

// ---------- hashing ----------
const PBKDF2_ITER = 600_000;
const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(secret: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return new Uint8Array(bits);
}

export async function hashSecret(secret: string, iter = PBKDF2_ITER): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const h = await derive(secret, salt, iter);
  return `pbkdf2-sha256$${iter}$${b64(salt)}$${b64(h)}`;
}

export async function verifySecret(secret: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [alg, iterS, saltS, hashS] = stored.split('$');
  if (alg !== 'pbkdf2-sha256') return false;
  const iter = Number(iterS);
  if (!Number.isFinite(iter) || iter < 1000) return false;
  const want = unb64(hashS);
  const got = await derive(secret, unb64(saltS), iter);
  if (want.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i];
  return diff === 0;
}

// ---------- one-time setup codes ----------
const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1

export function makeSetupCode(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  const c = [...b].map((x) => CODE_ALPHA[x % CODE_ALPHA.length]).join('');
  return c.slice(0, 4) + '-' + c.slice(4);
}

export const normCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');

// ---------- who may change what ----------
/**
 * Roles, deactivation, the tender-price tick, where the projects live and who may open a project
 * count only when changed by someone allowed to: an administrator (at that moment), or for a
 * project the person who created it (sharing their own project). A change written any other way
 * (an old or tampered copy of the app) is kept in the history but ignored. Worked out from the
 * history in time order, so every PC gets the same answer whatever order it read the journals in.
 * (The names on changes are written by the app itself: real protection is the folder permissions.)
 */
interface Trusted { v: Value; s: string }
// (kept per store against how many changes it has taken in - not against `version`, which moves only when a
// value does: a change read late that loses to a newer one changes no value but is part of the history this
// is worked out from - who was an administrator when, BH-038)
const trustCache = new WeakMap<Store, { ver: number; map: Map<string, Trusted>; accepted: Set<string> }>();
const GUARDED_USER = new Set(['role', 'active', 'price']);
const guarded = (eid: string, f: string) =>
  (eid.startsWith('user:') && GUARDED_USER.has(f)) || eid === CFG || (eid.startsWith('proj:') && (f === 'owner' || f === 'everyone' || f.startsWith('u:')));

/** a change to this field counts only when an administrator made it (see trustedValues) */
export const isGuarded = guarded;

export function trustedValues(store: Store): Map<string, Trusted> {
  const c = trustCache.get(store);
  if (c && c.ver === store.batchCount) return c.map;
  const ev: { eid: string; f: string; v: Value; s: string; a: string }[] = [];
  for (const [eid, hs] of store.hist) {
    if (!(eid.startsWith('user:') || eid === CFG || eid.startsWith('proj:'))) continue;
    for (const h of hs) if (guarded(eid, h.f)) ev.push({ eid, f: h.f, v: h.v, s: h.s, a: h.a ?? '' });
  }
  ev.sort((x, y) => (x.s < y.s ? -1 : x.s > y.s ? 1 : 0));
  const map = new Map<string, Trusted>();
  const accepted = new Set<string>();
  const val = (eid: string, f: string) => map.get(eid + '\u0000' + f)?.v;
  const admins = () => {
    const out: { u: string; s: string }[] = [];
    for (const [k, t] of map) {
      if (!k.endsWith('\u0000role') || t.v !== 'admin') continue;
      const eid = k.slice(0, -5);
      if (val(eid, 'active') === false) continue;
      out.push({ u: eid.slice(5), s: t.s });
    }
    return new Set(out.sort((a, b) => (a.s < b.s ? -1 : 1)).slice(0, MAX_ADMINS).map((x) => x.u));
  };
  let cur = new Set<string>();
  // the setup rule holds only while there has never been an administrator: accounts that lost
  // their last one (two administrators demoting each other at once) can't be taken by anybody
  let everAdmin = false;
  for (let i = 0; i < ev.length; ) {
    // one change (one stamp) at a time
    let j = i;
    while (j < ev.length && ev[j].s === ev[i].s) j++;
    const group = ev.slice(i, j);
    // the very first administrator sets the accounts up: their own change makes them one
    const setup = !everAdmin && cur.size === 0 && group.some((e) => e.eid === userId(e.a) && e.f === 'role' && e.v === 'admin');
    for (const e of group) {
      const isAdmin = setup || cur.has(e.a);
      let ok = isAdmin;
      if (!ok && e.eid.startsWith('proj:')) {
        const owner = val(e.eid, 'owner');
        if (e.f === 'owner') ok = owner === undefined && e.v === e.a; // the creator, once
        else ok = !!e.a && owner === e.a; // owners share their own project
      }
      if (ok) { map.set(e.eid + '\u0000' + e.f, { v: e.v, s: e.s }); accepted.add(e.s + '\u0000' + e.eid + '\u0000' + e.f); }
    }
    cur = admins();
    if (cur.size) everAdmin = true;
    i = j;
  }
  trustCache.set(store, { ver: store.batchCount, map, accepted });
  return map;
}
/** the guarded changes that counted: "stamp \0 entity \0 field" */
function trustedHistory(store: Store): Set<string> {
  trustedValues(store);
  return trustCache.get(store)!.accepted;
}
/** a guarded field as it counts (see trustedValues); any other field as it stands */
export function trustedGet(store: Store, eid: string, f: string): Value | undefined {
  if (!guarded(eid, f)) return store.get(eid, f);
  return trustedValues(store).get(eid + '\u0000' + f)?.v;
}

// ---------- reading ----------
export function listAccounts(store: Store): Account[] {
  const out: Account[] = [];
  for (const [id, ent] of store.ents) {
    if (!id.startsWith('user:') || !ent.has('name')) continue;
    const role = trustedGet(store, id, 'role');
    out.push({
      username: id.slice(5),
      name: String(ent.get('name')?.v ?? id.slice(5)),
      role: readRole(role),
      active: trustedGet(store, id, 'active') !== false,
      pw: (ent.get('pw')?.v as string) || null,
      setup: (ent.get('setup')?.v as string) || null,
      created: Number(ent.get('created')?.v ?? 0),
      createdBy: String(ent.get('createdBy')?.v ?? ''),
      price: trustedGet(store, id, 'price') === true,
      lastLogin: Number(ent.get('lastLogin')?.v ?? 0),
      lastHost: String(ent.get('lastHost')?.v ?? ''),
      lastApp: String(ent.get('lastApp')?.v ?? ''),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getAccount(store: Store, username: string): Account | null {
  return listAccounts(store).find((a) => a.username === normUsername(username)) ?? null;
}

/**
 * Usernames that really are administrators. The app never lets a 4th admin be made,
 * but if two admins promote people at the same moment on different PCs, only the
 * first 3 promoted (by change order) count - the rest act as estimators.
 */
export function adminSet(store: Store): Set<string> {
  const admins = listAccounts(store)
    .filter((a) => a.role === 'admin' && a.active)
    .map((a) => ({ u: a.username, s: trustedValues(store).get(userId(a.username) + '\u0000role')?.s ?? '' }))
    .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0))
    .slice(0, MAX_ADMINS);
  return new Set(admins.map((a) => a.u));
}

/**
 * Was this person an (active) administrator when a change with this stamp was made? Used for
 * "Empty recycle bin": a purge stays a purge after its admin is demoted or leaves. One function
 * per accounts store; its answers follow the store as it changes.
 */
export function adminAtFn(store: Store): (username: string, stamp: string) => boolean {
  let ver = -1;
  const cache = new Map<string, { s: string; admin: boolean }[]>();
  return (u: string, stamp: string) => {
    if (ver !== store.batchCount) { cache.clear(); ver = store.batchCount; }
    let tl = cache.get(u);
    if (!tl) {
      // only the changes that counted (made by an administrator)
      const trust = trustedHistory(store);
      const ev = (store.hist.get(userId(u)) ?? []).filter((e) => (e.f === 'role' || e.f === 'active') && trust.has(e.s + '\u0000' + userId(u) + '\u0000' + e.f)).sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
      let role: unknown = null, active = true;
      tl = [];
      for (const e of ev) {
        if (e.f === 'role') role = e.v; else active = e.v !== false;
        tl.push({ s: e.s, admin: role === 'admin' && active });
      }
      cache.set(u, tl);
    }
    let ok = false;
    for (const x of tl) { if (x.s <= stamp) ok = x.admin; else break; }
    return ok;
  };
}

/** One-shot read of all account journals (used before anyone is signed in). */
export async function loadAccountStore(fs: FsApi, dataRoot: string): Promise<{ exists: boolean; store: Store }> {
  const dir = accountsDir(fs, dataRoot);
  const store = new Store();
  const meta = await fs.readText(fs.join(dir, 'project.json'));
  // accounts exist when either the folder's description or any journal is there (a first set-up
  // that wrote its journal but not project.json must not offer "create the administrator" again)
  const ents = await fs.list(fs.join(dir, 'journals')).catch(() => []);
  const logs = ents.filter((e) => !e.isDir && e.name.endsWith('.log'));
  if (!meta && !logs.length) return { exists: false, store };
  for (const e of logs) {
    const r = await fs.readFrom(fs.join(dir, 'journals', e.name), 0, 256 * 1024 * 1024);
    if (!r) continue;
    for (const b of splitBytes(r.data).batches) store.apply(b);
  }
  return { exists: true, store };
}

/**
 * Writes one batch into its own new journal file (for sign-in time, before a session exists).
 * The stamp comes after everything in `seen` (the accounts as just read), so it wins over the
 * changes it follows even when this PC's clock is behind the admin's.
 */
export async function appendOneOff(fs: FsApi, dir: string, user: string, account: string, host: string, ops: Op[], label: string, seen?: Store): Promise<void> {
  const writer = safeName(account) + '@' + safeName(host) + '~' + randomId(6);
  const clock = new Clock(writer);
  if (seen?.top) clock.observe(seen.top);
  const b: Batch = { s: clock.tick(), w: writer, u: user, t: Date.now(), o: ops, m: label, a: account };
  await fs.mkdirp(fs.join(dir, 'journals'));
  await fs.append(fs.join(dir, 'journals', 'j_' + safeName(account) + '_' + Date.now().toString(36) + '_' + randomId(4) + '.log'), encodeLine(b));
}

// ---------- where the projects live ----------
/**
 * The folder people sign in to (the "team folder") holds the accounts. The take-off projects
 * can live elsewhere: administrators set the take-off folder.
 */
export interface Roots {
  team: string;
  qto: string;
  /**
   * the backups folder an administrator chose for the take-offs and the accounts (null: `_backups`
   * next to the projects / in the team folder)
   */
  bak: { team: string | null; /** folders chosen before (their leftovers are still listed) */ prev: { team: string[] } };
}
export const CFG = 'cfg';

const cfgPath = (store: Store, f: string) => {
  const v = trustedGet(store, CFG, f);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

const cfgList = (store: Store, f: string): string[] => {
  const v = trustedGet(store, CFG, f);
  try {
    const a = typeof v === 'string' ? JSON.parse(v) : null;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 10) : [];
  } catch {
    return [];
  }
};

export function rootsOf(store: Store, team: string): Roots {
  return {
    team, qto: cfgPath(store, 'qtoRoot') ?? team,
    bak: { team: cfgPath(store, 'bakTeam'), prev: { team: cfgList(store, 'bakPrevTeam') } },
  };
}

/** the backups folder chosen for this kind (undefined: the usual place) */
export const backupBase = (r: Roots, _kind: 'qto' | 'accounts') => r.bak.team ?? undefined;

/** a new backups folder (null: the usual place); the one it replaces is remembered with the earlier ones */
export function setBackupFolderOps(which: 'team', path: string | null, r?: Roots): Op[] {
  const next = path && path.trim() ? path.trim() : null;
  const ops: Op[] = [[CFG, 'bakTeam', next]];
  if (r) {
    const cur = r.bak.team;
    const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
    const prev = [...(cur ? [cur] : []), ...r.bak.prev.team]
      .filter((p, i, a) => (!next || norm(p) !== norm(next)) && a.findIndex((q) => norm(q) === norm(p)) === i).slice(0, 10);
    ops.push([CFG, 'bakPrevTeam', prev.length ? JSON.stringify(prev) : null]);
  }
  return ops;
}

export function setRootsOps(r: { qto: string | null }): Op[] {
  return [[CFG, 'qtoRoot', r.qto && r.qto.trim() ? r.qto.trim() : null]];
}

// ---------- operations ----------
export type LoginResult =
  | { ok: true; account: Account }
  | { ok: false; reason: 'unknown' | 'inactive' | 'needs-setup' | 'wrong' };

export async function checkLogin(store: Store, username: string, password: string): Promise<LoginResult> {
  const acc = getAccount(store, username);
  if (!acc) return { ok: false, reason: 'unknown' };
  if (!acc.active) return { ok: false, reason: 'inactive' };
  if (!acc.pw) return { ok: false, reason: 'needs-setup' };
  return (await verifySecret(password, acc.pw)) ? { ok: true, account: acc } : { ok: false, reason: 'wrong' };
}

/** First run on a shared folder: create the accounts folder and the first administrator. */
export async function initAccounts(fs: FsApi, dataRoot: string, host: string, admin: { username: string; name: string; password: string }): Promise<Account> {
  const dir = accountsDir(fs, dataRoot);
  const username = normUsername(admin.username);
  // someone else set the folder up meanwhile (two first starts at once): don't make a second administrator
  if ((await loadAccountStore(fs, dataRoot)).exists) throw new Error('Accounts were set up on this folder meanwhile. Sign in instead.');
  await fs.mkdirp(fs.join(dir, 'journals'));
  await fs.mkdirp(fs.join(dir, 'presence'));
  const ops: Op[] = [
    [userId(username), 'name', admin.name.trim()],
    [userId(username), 'role', 'admin'],
    [userId(username), 'active', true],
    [userId(username), 'pw', await hashSecret(admin.password)],
    [userId(username), 'setup', null],
    [userId(username), 'created', Date.now()],
    [userId(username), 'createdBy', username],
  ];
  await appendOneOff(fs, dir, admin.name.trim(), username, host, ops, 'Accounts set up');
  const meta: ProjectMeta = { format: FORMAT.accounts, formatVersion: 1, id: 'accounts-' + randomId(8), name: 'Accounts', created: Date.now(), createdBy: username };
  if (!(await fs.exists(fs.join(dir, 'project.json')))) await fs.writeAtomic(fs.join(dir, 'project.json'), JSON.stringify(meta, null, 2));
  const { store } = await loadAccountStore(fs, dataRoot);
  return getAccount(store, username)!;
}

/** Ops an admin commits to add a person. Returns the setup code to hand over (shown once). */
export async function newAccountOps(by: string, p: { username: string; name: string; role: Role }): Promise<{ ops: Op[]; code: string }> {
  const code = makeSetupCode();
  const id = userId(normUsername(p.username));
  return {
    code,
    ops: [
      [id, 'name', p.name.trim()], [id, 'role', p.role], [id, 'active', true], [id, 'pw', null],
      [id, 'setup', await hashSecret(code)], [id, 'created', Date.now()], [id, 'createdBy', by],
    ],
  };
}

/** Recorded by the person's own app right after a successful sign-in. */
export function signInOps(username: string, host: string, now = Date.now(), app?: string): Op[] {
  const ops: Op[] = [[userId(username), 'lastLogin', now], [userId(username), 'lastHost', host]];
  if (app) ops.push([userId(username), 'lastApp', app]);
  return ops;
}

export async function resetPasswordOps(username: string): Promise<{ ops: Op[]; code: string }> {
  const code = makeSetupCode();
  return { code, ops: [[userId(username), 'pw', null], [userId(username), 'setup', await hashSecret(code)]] };
}

/** The new person proves they hold the setup code, then sets a password. */
export async function claimAccount(fs: FsApi & { rmdir?(path: string): Promise<void> }, dataRoot: string, host: string, store: Store, username: string, code: string, password: string): Promise<{ ok: true; account: Account } | { ok: false; reason: string }> {
  // read the accounts again: the code may have been reset meanwhile, and the new password must be
  // stamped after the latest change to this account
  const fresh = await loadAccountStore(fs, dataRoot).then((r) => (r.exists ? r.store : store)).catch(() => store);
  store = fresh;
  const acc = getAccount(store, username);
  if (!acc) return { ok: false, reason: 'No account with that username.' };
  if (!acc.active) return { ok: false, reason: 'This account is deactivated. Ask an administrator.' };
  if (!acc.setup) return { ok: false, reason: 'This account already has a password. Ask an administrator to reset it if you forgot it.' };
  if (!(await verifySecret(normCode(code), acc.setup))) return { ok: false, reason: 'That setup code is not right. Check it with your administrator.' };
  if (password.length < MIN_PASSWORD) return { ok: false, reason: `Password must be at least ${MIN_PASSWORD} characters.` };
  // The code works once: whoever creates this folder first (one create that only one PC can win, on
  // the share) uses it up. Two claims at the same moment (two PCs, a code passed on) both passed the
  // checks above, as the first one's password had not landed yet; without this the later stamp
  // would quietly replace the first person's password (BH-011). One folder per code (its scrambled
  // form), so a new code for the same person works again.
  let token: string | null = null;
  if (fs.mkdirExcl) {
    const claims = fs.join(accountsDir(fs, dataRoot), 'claims');
    await fs.mkdirp(claims);
    token = fs.join(claims, safeName(acc.username).slice(0, 40) + '-' + (acc.setup.split('$').pop() ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16));
    if (!(await fs.mkdirExcl(token))) return { ok: false, reason: 'That setup code has just been used. If that was not you, ask your administrator for a new one.' };
  }
  try {
    await appendOneOff(fs, accountsDir(fs, dataRoot), acc.name, acc.username, host,
      [[userId(acc.username), 'pw', await hashSecret(password)], [userId(acc.username), 'setup', null]], 'Password set', store);
  } catch (e) {
    // not written: the code is not used up (where the bridge can remove a folder)
    if (token) await fs.rmdir?.(token).catch(() => {});
    throw e;
  }
  return { ok: true, account: { ...acc, setup: null, pw: 'set' } };
}
