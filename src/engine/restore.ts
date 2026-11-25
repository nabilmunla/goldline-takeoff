// A take-off brought back from a backup as a NEW project next to the others (Backups.tsx): made, then
// shared as the original was (or with everyone), in the same folder of the list. The sharing goes into
// the accounts: when they can't be written from this PC (view only, or a newer version wrote them),
// nothing is made - a take-off nobody but the administrators can see, "owned" by nobody, is not a
// restore (sweep B 8).
import { readBackup, restoreOps, type BackupFile, type BackupFs } from './backups';
import { createProject } from './projects';
import { FORMAT, formatFor } from './legacy';
import { newProjectAclOps, projId, setEveryoneOps } from './access';
import { trustedGet } from './accounts';
import { folderOf, listFolders, placeProjectOps } from './folders';
import type { Store } from './store';
import type { FsApi, Op, ProjectMeta } from './types';

export interface RestoreAccounts {
  store: Store;
  readOnly: boolean;
  newerApp?: string | null;
  meta?: { format?: unknown };
  commit(ops: Op[], label?: string): unknown;
}

export async function restoreTakeoff(o: {
  fs: FsApi;
  bfs: BackupFs;
  root: string;
  file: string;
  name: string;
  me: { name: string; username: string };
  host: string;
  accounts: RestoreAccounts;
}): Promise<{ dir: string; meta: ProjectMeta; backup: BackupFile }> {
  const b = await readBackup(o.bfs, o.file);
  if (b.kind !== 'qto') throw new Error('This is a backup of the accounts: restore it from that list.');
  if (o.accounts.readOnly) {
    throw new Error(o.accounts.newerApp
      ? `A newer Goldline Takeoff (${o.accounts.newerApp}) has changed the accounts: update this copy first - nothing was restored.`
      : 'The accounts can\'t be changed from this PC right now, so the copy could not be shared - nothing was restored.');
  }
  const ops = restoreOps(b);
  const { dir, meta } = await createProject(o.fs, o.root, o.name, o.me.name, o.host, ops, o.me.username, formatFor(FORMAT.takeoff, o.accounts.meta));
  // the same people can open it as could open the original (you own it); same folder of the list
  const acl: Op[] = [...newProjectAclOps(meta, o.me.username, 'qto')];
  const orig = o.accounts.store.ents.get(projId(b.projectId));
  let shared = false;
  if (orig) {
    // only what the app honours on the original (set by its owner or an administrator)
    for (const f of orig.keys()) {
      if (f !== 'everyone' && !f.startsWith('u:')) continue;
      const v = trustedGet(o.accounts.store, projId(b.projectId), f);
      if (v) { acl.push([projId(meta.id), f, v]); shared = true; }
    }
  }
  if (!shared) acl.push(...setEveryoneOps(meta.id, 'edit'));
  const fld = folderOf(o.accounts.store, b.projectId, listFolders(o.accounts.store, 'qto'), 'qto');
  acl.push(...placeProjectOps(meta.id, fld));
  if (!o.accounts.commit(acl, `Restored ${b.projectName} from the backup of ${b.day} as ${o.name}`)) {
    throw new Error(`${o.name} was made in the take-off folder but could not be shared (the accounts could not be changed): only administrators see it until it is shared from the list.`);
  }
  return { dir, meta, backup: b };
}
