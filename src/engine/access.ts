// Who may see and change which project, and the activity log of the accounts folder.
//
// Rules:
// - Administrators see and edit every project, and are the ones who update a BOQ.
// - Quantity surveyors start take-offs and see their own, plus any project an
//   administrator shared with them (view or edit).
// - View-only accounts from earlier versions never edit; they see only what is shared with them.
//
// Access lives in the accounts folder (entity "proj:<project id>"), not in the
// project, so a person who can't open a project can't change who may open it.
// Honest limit, as with passwords: this is control inside the app. Windows folder
// permissions remain the real lock against someone browsing the share directly.
import type { Store } from './store';
import { FORMAT, formatOf } from './legacy';
import type { Op, Value } from './types';
import { listAccounts, trustedGet, ROLE_LABEL, type Account, type Role } from './accounts';

export type Access = 'none' | 'view' | 'edit';
export const ACCESS_LABEL: Record<Access, string> = { none: 'No access', view: 'View', edit: 'Edit' };
const RANK: Record<Access, number> = { none: 0, view: 1, edit: 2 };
export const maxAccess = (a: Access, b: Access): Access => (RANK[a] >= RANK[b] ? a : b);

export const projId = (projectId: string) => 'proj:' + projectId;
const asAccess = (v: Value | undefined): Access => (v === 'edit' ? 'edit' : v === 'view' ? 'view' : 'none');

export interface ProjectAcl {
  /** username of the owner (usually whoever created it) */
  owner: string | null;
  /** access for everybody not listed */
  everyone: Access;
  /** per-person access */
  people: Map<string, Access>;
}

export interface ProjectRef {
  id: string;
  name: string;
  /** owner username written into project.json at creation (fallback) */
  owner?: string;
  /** display name of the creator (old projects only) */
  createdBy?: string;
  /** what kind of project (see engine/legacy.ts) */
  format?: string;
}

// (a BOQ hub counts as a take-off: its take-offs' people read and write it)
export const isTakeoff = (p: ProjectRef) => { const f = formatOf(p); return f === FORMAT.takeoff || f === FORMAT.hub; };

/** Owner as recorded in the accounts folder; falls back to project.json, then (old projects) to the creator's name. */
export function ownerOf(store: Store, p: ProjectRef, accounts?: Account[]): string | null {
  const o = trustedGet(store, projId(p.id), 'owner');
  if (typeof o === 'string' && o) return o;
  if (p.owner) return p.owner;
  if (p.createdBy) {
    // only an account that is the one with that username, or the only one with that name: two people
    // of the same name ("Ahmed") would otherwise make whichever this PC read first the owner, and a
    // different one on another PC (BH-029). No owner then - an administrator can set one.
    const list = accounts ?? listAccounts(store);
    const byUser = list.filter((a) => a.username === p.createdBy);
    if (byUser.length === 1) return byUser[0].username;
    const byName = list.filter((a) => a.name === p.createdBy);
    if (byName.length === 1) return byName[0].username;
  }
  return null;
}

export function getAcl(store: Store, p: ProjectRef, accounts?: Account[]): ProjectAcl {
  const ent = store.ents.get(projId(p.id));
  const people = new Map<string, Access>();
  if (ent) {
    for (const f of ent.keys()) {
      if (f.startsWith('u:')) {
        const a = asAccess(trustedGet(store, projId(p.id), f) ?? null);
        if (a !== 'none') people.set(f.slice(2), a);
      }
    }
  }
  return { owner: ownerOf(store, p, accounts), everyone: asAccess(trustedGet(store, projId(p.id), 'everyone') ?? null), people };
}

/** What this person may do with this project. */
export function accessFor(store: Store, admins: Set<string>, acc: Account, p: ProjectRef, accounts?: Account[]): Access {
  if (!acc.active) return 'none';
  if (admins.has(acc.username)) return 'edit';
  // a QS only opens take-offs (a project of the earlier estimation app is nothing to them), whatever anyone ticked
  if (acc.role === 'qs' && !isTakeoff(p)) return 'none';
  const acl = getAcl(store, p, accounts);
  let a: Access = 'none';
  if (acl.owner === acc.username && acc.role !== 'viewer') a = 'edit';
  a = maxAccess(a, acl.everyone);
  a = maxAccess(a, acl.people.get(acc.username) ?? 'none');
  if (acc.role === 'viewer' && a === 'edit') a = 'view';
  return a;
}

/** Why a person has access – for the access dialog and the project list. */
export function accessReason(store: Store, admins: Set<string>, acc: Account, p: ProjectRef, accounts?: Account[]): string {
  if (admins.has(acc.username)) return 'Administrator';
  if (acc.role === 'qs' && !isTakeoff(p)) return '';
  const acl = getAcl(store, p, accounts);
  if (acl.owner === acc.username && acc.role !== 'viewer') return 'Owner';
  const mine = acl.people.get(acc.username);
  if (mine) return 'Shared with them';
  if (acl.everyone !== 'none') return 'Shared with everyone';
  return '';
}

/** take-off projects: administrators and quantity surveyors (not the view-only accounts from before) */
export const canCreateTakeoffs = (acc: Account) => acc.active && acc.role !== 'viewer';

// ---------- ops ----------
/**
 * `kind`: 'qto' marks the record of a take-off (records from before it say nothing)
 */
export function newProjectAclOps(p: { id: string; name: string }, owner: string, kind?: 'qto'): Op[] {
  const ops: Op[] = [[projId(p.id), 'name', p.name], [projId(p.id), 'owner', owner], [projId(p.id), 'created', Date.now()]];
  if (kind) ops.push([projId(p.id), 'kind', kind]);
  return ops;
}
export function setPersonAccessOps(projectId: string, username: string, a: Access): Op[] {
  return [[projId(projectId), 'u:' + username, a === 'none' ? null : a]];
}
export function setEveryoneOps(projectId: string, a: Access): Op[] {
  return [[projId(projectId), 'everyone', a === 'none' ? null : a]];
}
export function setOwnerOps(projectId: string, owner: string): Op[] {
  return [[projId(projectId), 'owner', owner]];
}

// ---------- activity log ----------
export interface ActivityEvent {
  s: string;
  t: number;
  /** who did it: account username (if known) and display name */
  by: string;
  byName: string;
  text: string;
  kind: 'people' | 'access' | 'signin' | 'password';
}

/**
 * Everything that happened in the accounts folder, newest first. Built from the
 * change history, so it can't drift from what really happened. Password hashes and
 * setup-code hashes are never shown.
 */
export function activityLog(store: Store, limit = 500): ActivityEvent[] {
  const accounts = listAccounts(store);
  const nameOf = (u: string) => accounts.find((a) => a.username === u)?.name ?? u;
  const groups = new Map<string, { t: number; a?: string; u: string; m?: string; ops: { e: string; f: string; v: Value }[] }>();
  for (const [eid, h] of store.hist) {
    for (const e of h) {
      let g = groups.get(e.s);
      if (!g) groups.set(e.s, (g = { t: e.t, a: e.a, u: e.u, m: e.m, ops: [] }));
      g.ops.push({ e: eid, f: e.f, v: e.v });
    }
  }
  const out: ActivityEvent[] = [];
  for (const [s, g] of groups) {
    // housekeeping (which kind each project record is): nothing to read
    if (g.m === 'Project kinds') continue;
    const userEnts = [...new Set(g.ops.filter((o) => o.e.startsWith('user:')).map((o) => o.e.slice(5)))];
    const target = userEnts[0] ?? '';
    const tName = nameOf(target);
    const by = g.a ?? '';
    const byName = by ? nameOf(by) : g.u;
    const val = (f: string) => g.ops.find((o) => o.f === f)?.v;
    let text = g.m ?? 'Changed accounts';
    let kind: ActivityEvent['kind'] = 'people';
    switch (g.m) {
      case 'Accounts set up': text = 'set up the accounts and became the first administrator'; break;
      case 'Add person': text = `added ${tName} as ${(ROLE_LABEL[(val('role') as Role) ?? 'estimator'] ?? 'Estimator').toLowerCase()}`; break;
      case 'Reset password': text = `reset the password of ${tName}`; kind = 'password'; break;
      case 'Made administrator': text = `made ${tName} an administrator`; break;
      case 'Made estimator': text = `made ${tName} an estimator`; break;
      case 'Made viewer': text = `made ${tName} a viewer`; break;
      case 'Made quantity surveyor': text = `made ${tName} a quantity surveyor`; break;
      case 'Folders': text = 'changed where projects are kept'; kind = 'access'; break;
      case 'Deactivated': text = `deactivated ${tName}`; break;
      case 'Reactivated': text = `reactivated ${tName}`; break;
      case 'Password set': text = 'chose a password (first sign-in)'; kind = 'password'; break;
      case 'Password changed': text = 'changed their password'; kind = 'password'; break;
      case 'Signed in': text = `signed in${val('lastHost') ? ' on ' + val('lastHost') : ''}`; kind = 'signin'; break;
      default:
        // (a take-off's access record counts as project access)
        if (g.ops.some((o) => o.e.startsWith('proj:') || o.e.startsWith('ql:'))) kind = 'access';
        text = g.m ? g.m.charAt(0).toLowerCase() + g.m.slice(1) : text;
    }
    out.push({ s, t: g.t, by, byName, text, kind });
  }
  out.sort((x, y) => (x.s < y.s ? 1 : x.s > y.s ? -1 : 0));
  return out.slice(0, limit);
}
