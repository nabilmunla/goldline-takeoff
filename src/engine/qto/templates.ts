// Ready-made take-off types with sensible measurement defaults.
// Deductions follow common practice under POMI as it is usually applied ("what makes
// sense"), not a literal reading: openings up to 1 m² are left in for wall and
// floor finishes, door openings always come off skirting. Every value can be
// changed per take-off.
import type { Kind } from './model';

export interface Template {
  key: string;
  group: string;
  name: string;
  kind: Kind;
  h?: number;
  d?: number;
  /** openings/holes up to this many m² are left in (null = deduct every one) */
  dmin?: number | null;
  /** count items used as openings */
  ow?: number;
  oh?: number;
  x?: number;
  /** what the template is for, shown in the menu */
  hint: string;
}

export const TEMPLATES: Template[] = [
  { key: 'blk', group: 'Masonry', name: 'Blockwork 200 mm', kind: 'wall', h: 3, d: 0.2, dmin: 1, hint: 'Wall: length × height; doors (D) and openings (O) placed on it deducted, lintels counted' },
  { key: 'blk100', group: 'Masonry', name: 'Blockwork 100 mm', kind: 'wall', h: 3, d: 0.1, dmin: 1, hint: 'Wall: length × height; doors (D) and openings (O) placed on it deducted, lintels counted' },
  { key: 'pla', group: 'Wall finishes', name: 'Internal plaster', kind: 'line', h: 3, dmin: 1, hint: 'Length × height; set ×2 for both faces' },
  { key: 'pnt', group: 'Wall finishes', name: 'Emulsion paint', kind: 'line', h: 3, dmin: 1, hint: 'Length × height, openings over 1 m² deducted' },
  { key: 'wtl', group: 'Wall finishes', name: 'Wall tiling', kind: 'line', h: 2.4, dmin: 1, hint: 'Length × tiling height' },
  { key: 'flr', group: 'Floor finishes', name: 'Floor tiling', kind: 'area', dmin: 1, hint: 'Room areas, columns/shafts over 1 m² cut out' },
  { key: 'scr', group: 'Floor finishes', name: 'Screed 75 mm', kind: 'area', d: 0.075, dmin: 1, hint: 'Area, volume at 75 mm' },
  { key: 'skt', group: 'Floor finishes', name: 'Skirting', kind: 'line', dmin: null, hint: 'Length, door widths deducted' },
  { key: 'clg', group: 'Ceilings', name: 'Gypsum ceiling', kind: 'area', dmin: 1, hint: 'Ceiling areas from the RCP' },
  { key: 'wp', group: 'Waterproofing', name: 'Waterproofing', kind: 'area', dmin: 1, hint: 'Wet areas, roofs, podium' },
  { key: 'slab', group: 'Concrete', name: 'Slab 250 mm', kind: 'area', d: 0.25, dmin: null, hint: 'Area, volume at 250 mm; all openings deducted' },
  { key: 'door', group: 'Openings', name: 'Door D1 (0.9 × 2.1)', kind: 'count', ow: 0.9, oh: 2.1, hint: 'Count; deducts 0.9 m from skirting, 1.89 m² from walls' },
  { key: 'win', group: 'Openings', name: 'Window W1 (1.5 × 2.0)', kind: 'count', ow: 1.5, oh: 2, hint: 'Count; deducts 3.0 m² from walls' },
  { key: 'cnt', group: 'Fixtures', name: 'Light fittings', kind: 'count', hint: 'Plain count' },
  { key: 'sw', group: 'Fixtures', name: 'Sanitary fixtures', kind: 'count', hint: 'Plain count' },
];
