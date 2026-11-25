import { randomId, safeName } from './ids';
import { encodeLine, splitBytes } from './codec';
import { Store } from './store';
import type { Batch, FsApi, Op, ProjectMeta } from './types';
import { encodeStamp } from './hlc';
import { formatOf } from './legacy';

export interface ProjectEntry {
  dir: string;
  folder: string;
  meta: ProjectMeta;
  activeUsers: string[];
}

export function projectsRoot(fs: FsApi, dataRoot: string) {
  return fs.join(dataRoot, 'Projects');
}

export type ProjectFormat = 'takeoff' | 'takeoff-boq';

/**
 * Projects of one kind in a folder (take-offs and BOQ hubs can share a folder). A project made by an
 * earlier version still counts: its format is read through formatOf().
 */
/** how many projects are read at once: one at a time is a round trip per file on a slow share (VPN) */
const LIST_PARALLEL = 8;

/** f over every item, at most `n` at a time; the results in the items' order */
async function mapLimit<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await f(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export async function listProjects(fs: FsApi, dataRoot: string, now = Date.now(), format: ProjectFormat = 'takeoff', o: { presence?: boolean } = {}): Promise<ProjectEntry[]> {
  const root = projectsRoot(fs, dataRoot);
  const ents = (await fs.list(root)).filter((e) => e.isDir);
  // each project is read on its own (its description, then who is in it): several at once, the list in
  // the folder's order as before
  const one = async (name: string): Promise<ProjectEntry | null> => {
    const dir = fs.join(root, name);
    const txt = await fs.readText(fs.join(dir, 'project.json')).catch(() => null);
    if (!txt) return null;
    let meta: ProjectMeta;
    try { meta = JSON.parse(txt); } catch { return null; }
    // (a damaged project.json - null, a list, no name - is left out, never the whole list)
    if (!meta || typeof meta !== 'object' || formatOf(meta) !== format) return null;
    if (typeof meta.name !== 'string') meta.name = name;
    const users = new Set<string>();
    // (who is in it: only for a list that shows it - a listing in the background leaves those files alone)
    const pres = o.presence === false ? [] : await fs.list(fs.join(dir, 'presence')).catch(() => []);
    for (const p of pres) {
      if (!p.name.endsWith('.json')) continue;
      const t = await fs.readText(fs.join(dir, 'presence', p.name)).catch(() => null);
      try {
        const info = t ? JSON.parse(t) : null;
        // (one that closed the project says so: not counted as still in it)
        if (info && !info.gone && Math.abs(now - info.ts) < 30000) users.add(info.u);
      } catch { /* partial file */ }
    }
    return { dir, folder: name, meta, activeUsers: [...users] };
  };
  const out = (await mapLimit(ents.map((e) => e.name), LIST_PARALLEL, one)).filter((x): x is ProjectEntry => !!x);
  out.sort((a, b) => b.meta.created - a.meta.created);
  return out;
}

/** Creates the project folder and, optionally, a first journal with initial content. */
export async function createProject(
  fs: FsApi,
  dataRoot: string,
  name: string,
  user: string,
  host: string,
  initialOps: Op[] = [],
  account?: string,
  /** as written in project.json: today's id, or the earlier spelling in a team folder of the earlier version (legacy.ts formatFor) */
  format: string = 'takeoff',
): Promise<{ dir: string; meta: ProjectMeta }> {
  // the folder itself must be there: a drive letter that means another share on this PC (or none)
  // must not quietly create the whole path somewhere else
  if (!(await fs.exists(dataRoot))) throw new Error(`The folder ${dataRoot} can't be reached from this PC — check the network drive (or ask an administrator where projects are kept).`);
  const root = projectsRoot(fs, dataRoot);
  await fs.mkdirp(root);
  let folder = safeName(name) || 'Project';
  let dir = fs.join(root, folder);
  let i = 2;
  // claim the folder in one step: two people creating "Tower" at the same moment get two folders
  if (fs.mkdirExcl) {
    while (!(await fs.mkdirExcl(dir))) dir = fs.join(root, folder + '-' + i++);
  } else {
    while (await fs.exists(dir)) dir = fs.join(root, folder + '-' + i++);
  }
  await fs.mkdirp(fs.join(dir, 'journals'));
  await fs.mkdirp(fs.join(dir, 'presence'));
  const meta: ProjectMeta = {
    format, formatVersion: 1, id: randomId(12), name, created: Date.now(), createdBy: user,
  };
  if (account) meta.owner = account;
  const ops: Op[] = [['project', 'name', name], ...initialOps];
  const writer = safeName(user) + '@' + safeName(host) + '~' + randomId(6);
  // a big starting BOQ goes in several lines (no reader has to swallow one huge line)
  const now = Date.now();
  const lines: string[] = [];
  for (let k = 0, c = 0; k < ops.length; k += 4000, c++) {
    const b: Batch = { s: encodeStamp(now, c, writer), w: writer, u: user, t: now, o: ops.slice(k, k + 4000), m: 'Created project' };
    if (account) b.a = account;
    lines.push(encodeLine(b));
  }
  await fs.append(fs.join(dir, 'journals', 'j_' + safeName(user) + '_' + now.toString(36) + '_init.log'), lines.join(''));
  // project.json is written last: a half-created project never shows up in the list
  await fs.writeAtomic(fs.join(dir, 'project.json'), JSON.stringify(meta, null, 2));
  return { dir, meta };
}

/**
 * A project's state read straight from its journals (no session: nothing is written, nobody
 * sees you in it) - for copying a project from the list.
 */
export async function readProjectStore(fs: FsApi, dir: string): Promise<Store> {
  const store = new Store();
  const ents = await fs.list(fs.join(dir, 'journals'));
  for (const e of ents) {
    if (e.isDir || !e.name.endsWith('.log')) continue;
    const r = await fs.readFrom(fs.join(dir, 'journals', e.name), 0, 512 * 1024 * 1024);
    if (!r) continue;
    for (const b of splitBytes(r.data).batches) store.apply(b);
  }
  return store;
}
