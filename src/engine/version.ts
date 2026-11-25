// Versions.
//
// App versions ("0.12.0", "0.13.0-rc1"): compared number by number; a pre-release ("-rc1", "-beta")
// comes before the release of the same number.
//
// The DATA FORMAT is separate: a whole number raised only when a new version writes projects in a
// way older versions would misread. A project remembers the highest format that has written it
// (`project.fmt`, with the app version that did it in `project.fmtBy`); an older app opens it view
// only. Ordinary updates don't change it, so a test build or a quick fix never locks anyone out.
//   1  every project up to 0.12.4
//   2  a take-off with a separate up-down (Y) scale (0.12.5): an older app would count Y at the across
//      scale. Marked only on a take-off that uses one (BASE_FORMAT is what opening a project marks),
//      so an update never locks out PCs still on 0.12.4 from projects that don't need it.
//   3  a take-off with walls, beams, segment tags, doors / openings on walls, a door schedule or beam
//      types (0.15.0): an older app would read a wall as an area and miss every opening and tag. Marked
//      only on a take-off that uses one of them (`needsFormat3`).
//   4  v0.16.0: a take-off with rooms / finishes (portion links, saved breakdowns, room parts, sills),
//      binder pages shown as sheets (dwg fp), or additional items (dm add) - an older app would count a room
//      as a plain area, miss every portion link and write the estimate's Take-off column without them; and
//      an estimate holding additional-item lines from a take-off (qx_ / qa_), which an older app would
//      empty. Marked only on projects that use them (`needsFormat16`, EstSync).
//   5  v0.16.4: a room with a soffit, a bulkhead or a higher waterproofing upturn - an older app would count the
//      upturn as an additional wall finish (taken off the wall), the bulkhead as an empty additional ceiling and the
//      soffit as a full ceiling. Marked only on a take-off that uses one (`needsFormat164`).
//   6  v0.16.5: an additional wall finish drawn as an area (cladding on an elevation) - a 0.16.4 app would count it
//      0 m² (it reads only lengths along the walls). Marked only on a take-off that has one (`needsFormat165`).
//   7  v0.17.0: structural elements - slabs, drop panels, columns, shear walls (an area / count / wall with `sk`),
//      upstand beams, column and shear wall types, steel ratios on take-offs - a 0.16 app would count them as plain
//      areas, counts and walls (no concrete, formwork or steel). Marked only on a take-off that has one (`needsFormat17`).
//   8  v0.18.0: rooms with a Room height (walls measured by the ceiling over each stretch, plaster, the walls above the
//      false ceiling), miscellaneous items, an elevation that stands for plan edges; shear walls counted, footings,
//      rafts, stairs; an element's own figures; doors on a length; images and overlays on a sheet. A 0.17 app would
//      measure those rooms with no wall height and ignore the rest. Marked only where used (`needsFormat18`).
//   9  v0.18.1: slabs on grade, retaining walls, waterproofing / blinding / polythene and links on them, stair types,
//      a beam / wall segment's own figures, a slab's soffit less drop panels and beams. Marked only where used
//      (`needsFormat181`).
//  10  v0.19.0: build-up variables (item and project), quantity formulas with names, groups, notes, lines
//      switched off, templates. A 0.18 app would price a formula line at the figure it had when typed, a group as
//      a typed line with no rate and an off line as on. Marked only on projects that use them (`needsFormat19`).
//  11  v0.20.0: composite resources (lines owned by a resource) and subcontract packages - a 0.19 app would
//      price a composite at the rate typed before it had a make-up and ignore awards. Marked when used.
//      Also: a project variable that FOLLOWS a live quantity (BUA, Σ qty of a trade + unit) - a 0.19 app would price
//      it at the figure typed.
//  12  v0.21.0: preliminaries lines "% of the tender (contract) price" - a 0.20 app would price them at 0.
//      Also take-off names in formulas (TQ, TQFORM, TQKG...) - a 0.20 app would not know them. Marked when used.
//      (Tender settings, markup rules, rate dates / sources and cost codes need no mark: they change no cost.)
//  13  v0.22.0: selling rules a 0.21 app doesn't know - an item sold as "% of the provisional sums" or at an amount
//      typed, the overhead front-loaded on a trade / bill - it would print other selling rates. Marked when used.
//      (0.22.1, review M5) also: the company library when a "% of" line with a formula percent goes in (R2), and a 0.21
//      project with a "% of cost" line and no tender set, when 0.22 opens it (R14). A line's "count to check" flag
//      (`pc`, R4) needs no mark: it changes no money, and an older app ignores the field (at worst a count it edits stays
//      flagged in 0.22 - shown once more, never lost).
//  14  Goldline Takeoff: a BOQ hub and every take-off that pulls its BOQ from one (engine/hub.ts). An estimation
//      version's background sync would write its estimate's BOQ over the hub's copy and mark new lines deleted.
//      Marked only on hubs and the take-offs attached to one; take-offs from before stay 13 until attached.
export const DATA_FORMAT = 14;
/** what opening a project marks it with (the formats above it are marked by what needs them) */
export const BASE_FORMAT = 1;
/** a take-off with a separate up-down scale */
export const FORMAT_XY_SCALES = 2;
/** a take-off with walls / beams / segment tags / openings / a door schedule / beam types */
export const FORMAT_WALLS = 3;
/** a take-off with rooms / finishes / binder pages / additional items, or an estimate with additional-item lines */
export const FORMAT_V16 = 4;
/** a take-off with a soffit, bulkheads or higher waterproofing upturns (v0.16.4) */
export const FORMAT_V164 = 5;
/** a take-off with an additional wall finish drawn as an area (v0.16.5) */
export const FORMAT_V165 = 6;
/** a take-off with structural elements (v0.17.0) */
export const FORMAT_V17 = 7;
/** a take-off with anything new in v0.18.0 (see 8 above) */
export const FORMAT_V18 = 8;
/** a take-off with anything new in v0.18.1 (see 9 above) */
export const FORMAT_V181 = 9;
/** build-up variables, formulas with names, groups, notes, off lines, templates (0.19.0) */
export const FORMAT_V19 = 10;
/** composite resources, subcontract packages / awards (0.20.0) */
export const FORMAT_V20 = 11;
/** preliminaries "% of tender / cost" lines (0.21.0) */
export const FORMAT_V21 = 12;
/** selling rules "% of the PS", "amount", front-loaded overhead (0.22.0) */
export const FORMAT_V22 = 13;
/** Goldline Takeoff: a BOQ hub and the take-offs pulling from one (engine/hub.ts) - an estimation version's
 *  background sync would put its estimate's BOQ over the hub's and mark new lines deleted */
export const FORMAT_HUB = 14;

export function cmpVersion(a: string, b: string): number {
  const split = (v: string) => {
    const s = String(v).trim();
    const dash = s.indexOf('-');
    return { nums: (dash < 0 ? s : s.slice(0, dash)).split('.').map((x) => parseInt(x, 10) || 0), pre: dash < 0 ? '' : s.slice(dash + 1) };
  };
  const A = split(a), B = split(b);
  for (let i = 0; i < Math.max(A.nums.length, B.nums.length); i++) {
    const d = (A.nums[i] ?? 0) - (B.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1; // the release is after its pre-releases
  if (!B.pre) return -1;
  const c = A.pre.localeCompare(B.pre, undefined, { numeric: true });
  if (c) return c < 0 ? -1 : 1;
  // "rc01" and "rc1" count the same above: plain text decides, so a < b always means b > a
  return A.pre < B.pre ? -1 : 1;
}
