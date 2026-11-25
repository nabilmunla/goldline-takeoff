// The BOQ hub: where a take-off's BOQ lives (Goldline Takeoff, replaces the estimation project's part).
//
// A hub is a small project of its own (format HUB_FORMAT, folder "BOQ-<id>" next to the take-offs) that holds
// only the BOQ: lines, headings, the import records - no prices. Every take-off made from it keeps a copy of
// the BOQ (the `b:<id>` rows, bridge.ts mirrorOps), written by the app that has the take-off OPEN: on opening
// and whenever the hub changes (pullOps). Several take-offs can share one hub; the combined filled BOQ adds
// them up (combinedTargets), worked out when asked - nothing is stored for it.
//
// Who writes the hub:
//   - the BOQ (import, a new issue, line edits): an administrator - or the person who made the take-off,
//     until a first BOQ is in it (canEditBoq). The app enforces it; each such commit bumps `project.rev`.
//   - additional items (a QS's line not in the BOQ): the take-off apps, as before (bridge.ts additionalOps,
//     each for its own take-off - pushAdditionalOps).
//   - attach rows (`qto:<id>`): whoever makes or attaches a take-off.
//
// Take-offs from before (linked to an estimate the take-off app can't read - `project.est`) are frozen: they
// keep the copy they hold. The first time an administrator updates their BOQ or asks for the combined copy,
// a hub is made from the freshest copy among them (legacySeedOps; same line ids, so every link stays) at a
// fixed place (legacyHubId), so two administrators doing it at once end up with one hub.
import type { FsApi, Op, ProjectMeta, Value } from './types';
import { Store } from './store';
import { encodeLine } from './codec';
import { encodeStamp } from './hlc';
import { buildModel, type BoqModel, type PurgeCheck } from './boq';
import { mirrorOps, additionalOps, attachedQtos, takeoffTotals, type SyncTakeoff } from './qto/bridge';
import { FORMAT_HUB } from './version';
import { buildQtoModel } from './qto/model';
import { targetsFromBoq, type FillTarget } from './boqfill';

export const HUB_FORMAT = 'takeoff-boq';
export { FORMAT_HUB };
export const hubFolder = (hubId: string) => 'BOQ-' + hubId;
/** the hub of the take-offs that were linked to one estimate: the same for every PC */
export const legacyHubId = (estId: string) => 'est-' + String(estId).replace(/[^A-Za-z0-9_-]/g, '');
/** the hub made for a take-off that has none yet: the same for every PC (two clicks at once make one) */
export const ownHubId = (takeoffId: string) => 'q-' + String(takeoffId).replace(/[^A-Za-z0-9_-]/g, '');
/** what a hub's roll back leaves alone: the take-offs' additional items and attach rows (only the BOQ goes back) */
export const HUB_ROLLBACK_SKIP = ['qx_', 'qa_', 'qto:'];

const str = (v: Value | undefined) => (typeof v === 'string' ? v : null);
const num = (v: Value | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** the hub a take-off pulls its BOQ from (null: none - frozen, or not made yet) */
export const hubOf = (qto: Store): string | null => str(qto.get('project', 'hub'));
/** the estimate a take-off from before was linked to (its group, for the legacy hub) */
export const legacyEstOf = (qto: Store): string | null => str(qto.get('project', 'est'));

/** the rows that tie a take-off to a hub, on both sides */
export function attachHubOps(hub: { id: string; name: string }, qto: { id: string; name: string; folder: string }): { hub: Op[]; qto: Op[] } {
  return {
    hub: [['qto:' + qto.id, 'name', qto.name], ['qto:' + qto.id, 'folder', qto.folder], ['qto:' + qto.id, 'del', null]],
    qto: [['project', 'hub', hub.id], ['project', 'hubName', hub.name]],
  };
}
export const attachedTakeoffs = (hub: Store) => attachedQtos(hub);
/** the hub's row for this take-off, where it is missing or out of date (written by the take-off's app on opening) */
export function ensureAttachedOps(hub: Store, qto: { id: string; name: string; folder: string }): Op[] {
  const want = attachHubOps({ id: '', name: '' }, qto).hub;
  return want.filter(([e, f, v]) => (hub.get(e, f) ?? null) !== (v ?? null));
}
/** the take-off's side: which hub it pulls from (empty when it already says so) */
export function takeoffAttachOps(qto: Store, hub: { id: string; name: string }): Op[] {
  return attachHubOps(hub, { id: '', name: '', folder: '' }).qto.filter(([e, f, v]) => (qto.get(e, f) ?? null) !== (v ?? null));
}

/** a BOQ change in the hub (an administrator's): bumps the hub's revision so a PC with an older view of it
 *  doesn't put an older copy back into a take-off (pullOps) */
export function bumpRevOps(hub: Store, now = Date.now()): Op[] {
  return [['project', 'rev', Math.max(num(hub.get('project', 'rev')) + 1, now)]];
}

/**
 * What a take-off needs to match its hub: the BOQ copy brought up to date and the hub revision it now holds.
 * Empty when it already matches - or when this PC's view of the hub is older than what the take-off already
 * got from another PC (a later look at the hub catches up).
 */
export function pullOps(hub: Store, qto: Store, admins?: PurgeCheck): Op[] {
  // a hub not read yet (its project.json can reach a PC before its journals) gives nothing - it never empties a copy
  if (hub.get('project', 'fmt') === undefined) return [];
  const rev = num(hub.get('project', 'rev'));
  const brev = num(qto.get('project', 'brev'));
  if (rev < brev) return [];
  // a line is marked deleted in the copy only when the hub says so (deleted or emptied from the bin there) - never
  // because this PC's view of the hub doesn't know it (yet)
  const ops = mirrorOps(buildModel(hub, admins), qto).filter(([e, f, v]) => !(f === 'del' && v === true && e.startsWith('b:') && !hub.ents.has(e.slice(2))));
  if (rev !== brev) ops.push(['project', 'brev', rev]);
  return ops;
}

/** this take-off's additional items and temporary lines, as the hub's lines (bridge.ts additionalOps, for one take-off) */
export function pushAdditionalOps(hub: Store, qto: { id: string; store: Store }, admins?: PurgeCheck): Op[] {
  const side: SyncTakeoff[] = [{ id: qto.id, model: buildQtoModel(qto.store, null) }];
  return additionalOps(buildModel(hub, admins), hub, side, takeoffTotals(side), false);
}

/** who may change the BOQ: an administrator; the person who made the take-off while no BOQ is in it yet */
export function canEditBoq(hub: Store, who: { username: string; isAdmin: boolean }): boolean {
  if (who.isAdmin) return true;
  return !hasBoq(hub) && str(hub.get('project', 'creator')) === who.username;
}
export function hasBoq(hub: Store): boolean {
  for (const [id, ent] of hub.ents) {
    if (id.startsWith('imp:') && typeof ent.get('files')?.v === 'string') return true;
    if (ent.get('type')?.v === 'item' && ent.get('del')?.v !== true && !ent.get('qa')?.v) return true;
  }
  return false;
}

/**
 * The combined filled BOQ: the hub's lines with what every attached take-off measured, and their additional
 * items - worked out on a copy, nothing written. `qtos`: every take-off attached to the hub, with its state
 * (null: could not be read - its figures are missing, `unread` says how many).
 */
export function combinedTargets(hub: Store, qtos: { id: string; store: Store | null }[], admins?: PurgeCheck): { targets: FillTarget[]; model: BoqModel; unread: number } {
  const side: SyncTakeoff[] = qtos.filter((q) => q.store).map((q) => ({ id: q.id, model: buildQtoModel(q.store!, null) }));
  const unread = qtos.length - side.length;
  const totals = takeoffTotals(side);
  const copy = cloneStore(hub);
  const add = additionalOps(buildModel(copy, admins), copy, side, totals, unread === 0);
  if (add.length) applyLocal(copy, add);
  const model = buildModel(copy, admins, { tq: totals });
  return { targets: targetsFromBoq(model), model, unread };
}

/** the BOQ copy kept in a take-off -> the hub's own rows (same ids). Lines that came from additional items
 *  are left out: the take-off apps put them back from the take-offs themselves (pushAdditionalOps). */
const BACK: Record<string, string> = { bt: 'type', par: 'parent', ord: 'ord', ref: 'ref', desc: 'desc', unit: 'unit', qty: 'qty', page: 'page', src: 'src', q0: 'q0' };
export function legacySeedOps(mirrors: Store[]): Op[] {
  const fresh = freshest(mirrors);
  if (!fresh) return [];
  const ops: Op[] = [];
  for (const [eid, ent] of fresh.ents) {
    if (eid.startsWith('bi:')) {
      const f = ent.get('files')?.v;
      if (typeof f === 'string') ops.push(['imp:' + eid.slice(3), 'files', f]);
      continue;
    }
    if (!eid.startsWith('b:') || !ent.has('bt')) continue;
    const qa = ent.get('qa')?.v;
    if (qa === 'a' || qa === 'n' || qa === 'g') continue;
    const id = eid.slice(2);
    for (const [mf, hf] of Object.entries(BACK)) {
      const v = ent.get(mf)?.v;
      if (v !== undefined && v !== null) ops.push([id, hf, v]);
    }
    if (ent.get('del')?.v === true) ops.push([id, 'del', true]);
  }
  return ops;
}
/** the copy changed last (the take-offs stopped being updated at different moments) */
export function freshest(mirrors: Store[]): Store | null {
  let best: Store | null = null, bestS = '';
  for (const m of mirrors) {
    let s = '';
    for (const [eid, ent] of m.ents) {
      if (!eid.startsWith('b:') && !eid.startsWith('bi:')) continue;
      for (const c of ent.values()) if (c.s > s) s = c.s;
    }
    if (s && (!best || s > bestS)) { best = m; bestS = s; }
  }
  return best;
}

// ---------------------------------------------------------------- files

/**
 * Makes the hub's folder (or finds it, when another PC made it first: `existed`). The folder is claimed in one
 * step, so two PCs making the same legacy hub end up with one.
 */
export async function createHub(fs: FsApi, projectsDir: string, o: { hubId: string; name: string; user: string; account: string; initialOps?: Op[]; waitTries?: number }): Promise<{ dir: string; existed: boolean; meta: ProjectMeta | null }> {
  await fs.mkdirp(projectsDir);
  const dir = fs.join(projectsDir, hubFolder(o.hubId));
  const claimed = fs.mkdirExcl ? await fs.mkdirExcl(dir) : !(await fs.exists(dir));
  if (!claimed) {
    // made by another PC: wait for its project.json (written last)
    for (let i = 0; i < (o.waitTries ?? 20); i++) {
      const t = await fs.readText(fs.join(dir, 'project.json')).catch(() => null);
      if (t) { try { return { dir, existed: true, meta: JSON.parse(t) as ProjectMeta }; } catch { /* half written: wait */ } }
      await new Promise((r) => setTimeout(r, 250));
    }
    // still none: the PC that claimed the folder stopped half way - finish it here (same id, so a late
    // finish by that PC only adds its own journal: one hub either way)
  }
  await fs.mkdirp(fs.join(dir, 'journals'));
  await fs.mkdirp(fs.join(dir, 'presence'));
  const now = Date.now();
  const meta: ProjectMeta = { format: HUB_FORMAT, formatVersion: 1, id: o.hubId, name: o.name, created: now, createdBy: o.user, owner: o.account };
  const ops: Op[] = [['project', 'name', o.name], ['project', 'creator', o.account], ['project', 'fmt', FORMAT_HUB], ...(o.initialOps ?? [])];
  const writer = 'hub@' + o.account.replace(/[^A-Za-z0-9_-]/g, '') + '~' + now.toString(36) + Math.random().toString(36).slice(2, 6);
  const lines: string[] = [];
  for (let k = 0, c = 0; k < ops.length; k += 4000, c++) {
    lines.push(encodeLine({ s: encodeStamp(now, c, writer), w: writer, u: o.user, a: o.account, t: now, o: ops.slice(k, k + 4000), m: 'BOQ made' }));
  }
  await fs.append(fs.join(dir, 'journals', 'j_hub_' + writer.split('~')[1] + '_init.log'), lines.join(''));
  await fs.writeAtomic(fs.join(dir, 'project.json'), JSON.stringify(meta, null, 2));
  return { dir, existed: false, meta };
}

// ---------------------------------------------------------------- helpers

function cloneStore(s: Store): Store {
  const c = new Store();
  // one batch per writer/stamp is not needed: a copy only has to read the same
  const ops: Op[] = [];
  for (const [eid, ent] of s.ents) for (const [f, cell] of ent) ops.push([eid, f, cell.v]);
  c.apply({ s: '0000000000~copy', w: 'copy', u: 'copy', t: 0, o: ops });
  // the cells keep who set them where buildModel needs it (purge checks): copy them over
  for (const [eid, ent] of s.ents) {
    const ce = c.ents.get(eid);
    if (!ce) continue;
    for (const [f, cell] of ent) { const x = ce.get(f); if (x) Object.assign(x, { s: cell.s, u: cell.u, w: cell.w, a: cell.a }); }
  }
  return c;
}
let localN = 0;
function applyLocal(s: Store, ops: Op[]) {
  s.apply({ s: 'zzzzzzzzzz' + String(++localN).padStart(6, '0') + '~local', w: 'local', u: 'local', t: 0, o: ops });
}
