// Folders on the project list: a tree shared by the whole team, kept in
// the accounts folder next to who may open which project. A project sits in one folder (field
// `fld` on its access record `proj:<id>`); everyone sees the same folders but only the projects
// they may open. Entities: `pf:<id>` {name, par, ord, kind 'qto', del} (folders of the earlier estimation app, kind 'est' or none, are not listed).
import { generateKeyBetween } from 'fractional-indexing';
import type { Store } from './store';
import type { Op } from './types';
import { randomId } from './ids';

export const PF = 'pf:';
export type FolderKind = 'qto';

export interface Folder {
  id: string;
  name: string;
  par: string | null;
  ord: string;
  depth: number;
  /** path of names from the top, for search and tooltips */
  path: string;
}

/** folders of one list, depth-first in order (a folder whose parent is gone sits at the top) */
type Raw = { id: string; name: string; par: string | null; ord: string };

export function listFolders(store: Store, kind: FolderKind): Folder[] {
  const raw = new Map<string, Raw>();
  for (const [id, ent] of store.ents) {
    if (!id.startsWith(PF) || ent.get('del')?.v === true) continue;
    if (ent.get('kind')?.v !== kind) continue;
    raw.set(id, { id, name: String(ent.get('name')?.v ?? 'Folder'), par: (ent.get('par')?.v as string) || null, ord: String(ent.get('ord')?.v ?? '') });
  }
  const kids = new Map<string | null, Raw[]>();
  for (const f of raw.values()) {
    const par = f.par && raw.has(f.par) ? f.par : null;
    (kids.get(par) ?? kids.set(par, []).get(par)!).push(f);
  }
  const out: Folder[] = [];
  const seen = new Set<string>();
  const walk = (par: string | null, depth: number, path: string) => {
    const list = (kids.get(par) ?? []).sort((a, b) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : a.name.localeCompare(b.name, undefined, { numeric: true })));
    for (const f of list) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      const p = path ? path + ' › ' + f.name : f.name;
      out.push({ id: f.id, name: f.name, par, ord: f.ord, depth, path: p });
      walk(f.id, depth + 1, p);
    }
  };
  walk(null, 0, '');
  // folders caught in a circle (two people moved them into each other at once): shown at the top
  for (const f of raw.values()) if (!seen.has(f.id)) { seen.add(f.id); out.push({ id: f.id, name: f.name, par: null, ord: f.ord, depth: 0, path: f.name }); walk(f.id, 1, f.name); }
  return out;
}

/** the folder a project is in (null: not in a folder, or its folder was removed) */
export function folderOf(store: Store, projectId: string, folders?: Folder[], kind: FolderKind = 'qto'): string | null {
  const f = store.get('proj:' + projectId, 'fld');
  if (typeof f !== 'string' || !f) return null;
  const list = folders ?? listFolders(store, kind);
  return list.some((x) => x.id === f) ? f : null;
}

/** a folder and every folder inside it */
export function subtree(folders: Folder[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.par && out.has(f.par) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

const lastOrd = (folders: Folder[], par: string | null) => {
  const sib = folders.filter((f) => f.par === par).map((f) => f.ord).filter(Boolean).sort();
  return sib[sib.length - 1] ?? null;
};

export function newFolderOps(store: Store, kind: FolderKind, name: string, par: string | null): { id: string; ops: Op[] } {
  const id = PF + randomId(10);
  const folders = listFolders(store, kind);
  let ord: string;
  try { ord = generateKeyBetween(lastOrd(folders, par), null); } catch { ord = generateKeyBetween(null, null); }
  return { id, ops: [[id, 'name', name.trim() || 'New folder'], [id, 'par', par], [id, 'ord', ord], [id, 'kind', kind]] };
}

export const renameFolderOps = (id: string, name: string): Op[] => [[id, 'name', name.trim() || 'Folder']];

/** into another folder (null = top level), at the end; refused (null) into itself or its own subfolders */
export function moveFolderOps(store: Store, kind: FolderKind, id: string, par: string | null): Op[] | null {
  const folders = listFolders(store, kind);
  if (par && subtree(folders, id).has(par)) return null;
  let ord: string;
  try { ord = generateKeyBetween(lastOrd(folders.filter((f) => f.id !== id), par), null); } catch { ord = generateKeyBetween(null, null); }
  return [[id, 'par', par], [id, 'ord', ord]];
}

/** removes a folder: what was in it (projects and folders) moves up to where the folder was */
export function deleteFolderOps(store: Store, kind: FolderKind, id: string, projectIds: string[]): Op[] {
  const folders = listFolders(store, kind);
  const f = folders.find((x) => x.id === id);
  const up = f?.par ?? null;
  const ops: Op[] = [[id, 'del', true]];
  for (const k of folders) if (k.par === id) ops.push([k.id, 'par', up]);
  for (const pid of projectIds) if (store.get('proj:' + pid, 'fld') === id) ops.push(['proj:' + pid, 'fld', up]);
  return ops;
}

export const placeProjectOps = (projectId: string, folder: string | null): Op[] => (folder ? [['proj:' + projectId, 'fld', folder]] : []);
export const moveProjectOps = (projectId: string, folder: string | null): Op[] => [['proj:' + projectId, 'fld', folder]];
