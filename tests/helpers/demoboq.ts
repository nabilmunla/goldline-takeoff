// Dummy take-off BOQ for tests - realistic structure, made-up quantities (no pricing, no company names).
import { generateNKeysBetween } from 'fractional-indexing';
import { randomId } from '../../src/engine/ids';
import type { Op } from '../../src/engine/types';

type ItemDef = [desc: string, unit: string, qty: number | null, kind?: 'note' | 'item'];
type SectionDef = [title: string, items: ItemDef[], opts?: unknown];
type BillDef = [title: string, sections: SectionDef[], opts?: unknown];

const LONG_EXC =
  'Excavation in any material other than rock for raft foundation, commencing from existing ground level, not exceeding 3.00 m deep, including levelling, trimming, compacting bottom of excavation, keeping excavation free from water and supporting sides as necessary';

const BILLS: BillDef[] = [
  ['PRELIMINARIES AND GENERAL REQUIREMENTS', [
    ['General Requirements', [
      ['Performance bond (10% of Contract Sum)', 'item', 1],
      ['Advance payment guarantee', 'item', 1],
      ['Contractor\'s All Risks insurance', 'item', 1],
      ['Workmen\'s compensation insurance', 'item', 1],
      ['Third party liability insurance', 'item', 1],
    ]],
    ['Site Establishment', [
      ['Mobilisation of plant, equipment and personnel to site', 'item', 1],
      ['Engineer\'s site office including furniture, IT and maintenance', 'month', 24],
      ['Contractor\'s site offices, stores and welfare facilities', 'month', 24],
      ['Temporary hoarding 2.4 m high including gates and signage', 'm', 420],
      ['Temporary electricity supply including generator and fuel', 'month', 24],
      ['Temporary water supply and distribution', 'month', 24],
      ['Project signboard as per Client standard', 'nr', 2],
      ['Demobilisation and site clearance on completion', 'item', 1],
    ]],
    ['Staff and Supervision', [
      ['Project Manager', 'month', 24],
      ['Construction Manager', 'month', 24],
      ['HSE Manager', 'month', 24],
      ['QA/QC Engineer', 'month', 24],
      ['Quantity Surveyor', 'month', 24],
      ['Planning Engineer', 'month', 24],
    ]],
  ]],
  ['SUBSTRUCTURE', [
    ['Earthworks', [
      ['Note: rates for excavation shall include working space, earthwork support and keeping excavations free of water', '', null],
      [LONG_EXC, 'm3', 18450],
      ['Extra over excavation for excavating in rock', 'm3', 1200],
      ['Dewatering for the duration of substructure works', 'item', 1],
      ['Backfilling with approved excavated material in layers not exceeding 250 mm, compacted to 95% MDD', 'm3', 6200],
      ['Imported fill material compacted in layers to 98% MDD', 'm3', 2400],
      ['Disposal of surplus excavated material off site to Municipality approved tip', 'm3', 12250],
      ['Anti-termite treatment to bottom and sides of excavation', 'm2', 6800],
      ['Polyethylene sheet 1000 gauge under blinding', 'm2', 6800],
    ]],
    ['Plain and Reinforced Concrete', [
      ['All concrete to be ready-mixed from an approved supplier; rates to include sampling and testing', '', null, 'note'],
      ['Blinding concrete Grade C20, 75 mm thick under foundations', 'm2', 6800],
      ['Reinforced concrete Grade C45/20 SRC in raft foundation', 'm3', 5400],
      ['Reinforced concrete Grade C45/20 SRC in pile caps and ground beams', 'm3', 860],
      ['Reinforced concrete Grade C50/20 in columns and walls below ground', 'm3', 640],
      ['Reinforced concrete Grade C40/20 in ground floor slab 250 mm thick', 'm3', 1350],
      ['Reinforced concrete Grade C40/20 in lift pits and sumps', 'm3', 85],
    ]],
    ['Reinforcement', [
      ['High yield deformed bars to BS 4449 Grade B500B, all diameters, cut, bent and fixed', 'ton', 1180],
      ['Extra over for couplers 32 mm diameter', 'nr', 2400],
      ['Welded steel fabric mesh A252 in slab on grade', 'm2', 5400],
    ]],
    ['Formwork', [
      ['Formwork to sides of raft foundation', 'm2', 720],
      ['Formwork to sides of pile caps and ground beams', 'm2', 2100],
      ['Formwork to columns and walls below ground', 'm2', 4300],
      ['Formwork to soffit of suspended slabs', 'm2', 680],
    ]],
    ['Waterproofing', [
      ['Bituminous membrane waterproofing 4 mm thick to underside of raft', 'm2', 6800],
      ['Ditto to vertical faces of retaining walls including protection board', 'm2', 3150],
      ['PVC waterstop 250 mm wide to construction joints', 'm', 1450],
      ['Hydrophilic swellable waterbar', 'm', 980],
    ]],
  ]],
  ['SUPERSTRUCTURE', [
    ['Reinforced Concrete', [
      ['Reinforced concrete Grade C50/20 in columns', 'm3', 2150],
      ['Reinforced concrete Grade C50/20 in shear walls and core walls', 'm3', 3900],
      ['SLABS AND BEAMS', '', null],
      ['Reinforced concrete Grade C40/20 in post-tensioned slabs', 'm3', 9800],
      ['Reinforced concrete Grade C40/20 in beams and upstands', 'm3', 1100],
      ['Reinforced concrete Grade C40/20 in staircases', 'm3', 260],
    ]],
    ['Reinforcement and Post-Tensioning', [
      ['High yield deformed bars Grade B500B in superstructure', 'ton', 2650],
      ['Post-tensioning to slabs including tendons, anchorages and stressing', 'kg', 168000],
    ]],
    ['Formwork', [
      ['Formwork to columns', 'm2', 14800],
      ['Formwork to walls including climbing system to core', 'm2', 31000],
      ['Formwork to soffit of slabs', 'm2', 39000],
      ['Formwork to edges of slabs not exceeding 300 mm high', 'm', 6200],
    ]],
  ]],
  ['MASONRY', [
    ['Blockwork', [
      ['100 mm thick solid concrete blockwork in cement mortar', 'm2', 6400],
      ['150 mm thick hollow concrete blockwork', 'm2', 2100],
      ['200 mm thick hollow concrete blockwork', 'm2', 12800],
      ['200 mm thick thermal insulated blockwork to external walls', 'm2', 9400],
      ['250 mm thick hollow concrete blockwork', 'm2', 1800],
    ]],
    ['Lintels, Bands and Accessories', [
      ['Precast concrete lintels 200 x 200 mm', 'm', 2600],
      ['Cast in-situ RC tie beams 200 x 200 mm', 'm', 3900],
      ['Galvanised wall ties and expanded metal lath at junctions', 'm', 7400],
    ]],
    ['Plaster', [
      ['Internal cement plaster 15 mm thick in two coats', 'm2', 58000],
      ['External cement plaster 20 mm thick with waterproof additive', 'm2', 17500],
      ['Angle beads and stop beads', 'm', 24000],
    ]],
  ]],
  ['FINISHES', [
    ['Floor Finishes', [
      ['Porcelain tiles 600 x 600 mm to apartments', 'm2', 21500],
      ['Marble flooring to main lobby', 'm2', 850],
      ['Cement screed 75 mm thick', 'm2', 26800],
      ['Epoxy floor coating to car park', 'm2', 14200],
      ['Skirting to match floor tiles 100 mm high', 'm', 19800],
    ]],
    ['Wall Finishes', [
      ['Emulsion paint to internal walls, one primer and two finishing coats', 'm2', 58000],
      ['Ceramic wall tiles to wet areas full height', 'm2', 9600],
      ['External textured paint system', 'm2', 17500],
    ]],
    ['Ceiling Finishes', [
      ['Gypsum board false ceiling including suspension system', 'm2', 16400],
      ['Moisture resistant gypsum board ceiling to wet areas', 'm2', 3900],
      ['Access panels 600 x 600 mm', 'nr', 680],
    ]],
  ]],
  ['DOORS, WINDOWS AND JOINERY', [
    ['Doors', [
      ['Apartment entrance door, 60 min fire rated, solid core, veneer finish, complete with ironmongery', 'nr', 412],
      ['Internal flush door 2100 x 900 mm complete with frame and ironmongery', 'nr', 1640],
      ['Steel fire door double leaf 2 hour rated to stair cores', 'nr', 96],
    ]],
    ['Windows and Glazing', [
      ['Aluminium sliding windows with double glazed units, thermally broken', 'm2', 6800],
      ['Curtain wall system unitised, including brackets and sealants', 'm2', 9200],
      ['Glass balustrade 12 mm toughened laminated with stainless steel handrail', 'm', 640],
      ['Aluminium louvres to plant areas', 'm2', 420],
    ]],
  ]],
  ['MECHANICAL, ELECTRICAL AND PLUMBING SERVICES', [
    ['Lighting Fixtures – Internal', [
      ['LED downlight 12 W, 3000 K, IP44, recessed', 'nr', 2400],
      ['LED linear profile in gypsum cove', 'm', 1800],
      ['Decorative pendant to main lobby', 'nr', 12],
    ], {}],
    ['Lighting Fixtures – Facade', [
      ['Linear LED wall washer, IP66, RGBW', 'm', 640],
      ['In-ground facade uplighter, IP67', 'nr', 90],
    ]],
    ['Lighting Fixtures – Landscape', [
      ['Bollard light 900 mm', 'nr', 75],
      ['Tree uplighter', 'nr', 60],
    ]],
    ['Lighting Fixtures – BOH', [
      ['LED batten 1200 mm, IP65', 'nr', 520],
    ]],
    ['Sanitary Wares', [
      ['Wall-hung WC with concealed cistern and flush plate', 'nr', 420],
      ['Counter-top washbasin with mixer', 'nr', 410],
      ['Thermostatic shower mixer set', 'nr', 380],
      ['Acrylic bathtub 1700 mm', 'nr', 120],
    ]],
    ['Kitchen Appliances', [
      ['Built-in oven 60 cm', 'nr', 206],
      ['Induction hob', 'nr', 206],
      ['Cooker hood', 'nr', 206],
      ['Integrated refrigerator', 'nr', 206],
    ]],
    ['Home Automation', [
      ['Smart home controller per apartment', 'nr', 206],
      ['Smart switch panel', 'nr', 1640],
    ]],
    ['Electrical Installation', [
      ['Main LV switchboard', 'item', 1],
      ['Final distribution boards', 'nr', 220],
    ]],
    ['Plumbing and Drainage', [
      ['uPVC drainage pipework 110 mm', 'm', 4200],
      ['Booster pump set', 'nr', 2],
    ]],
  ]],
  ['PROVISIONAL SUMS', [
    ['Provisional Sums', [
      ['Provisional sum for statutory authority fees (DEWA, Du, Civil Defence)', 'item', 1],
      ['Provisional sum for testing and commissioning', 'item', 1],
      ['Provisional sum for contingencies', 'item', 1],
    ]],
  ]],
];

export function demoBoqOps(): Op[] {
  const ops: Op[] = [];
  const billKeys = generateNKeysBetween(null, null, BILLS.length);
  BILLS.forEach(([title, sections], bi) => {
    const billId = 'g' + randomId(10);
    ops.push([billId, 'type', 'group'], [billId, 'parent', null], [billId, 'ord', billKeys[bi]],
      [billId, 'ref', 'Bill ' + (bi + 1)], [billId, 'desc', title]);
    const secKeys = generateNKeysBetween(null, null, sections.length);
    sections.forEach(([stitle, items], si) => {
      const secId = 'g' + randomId(10);
      ops.push([secId, 'type', 'group'], [secId, 'parent', billId], [secId, 'ord', secKeys[si]],
        [secId, 'ref', `${bi + 1}.${si + 1}`], [secId, 'desc', stitle]);
      const itemKeys = generateNKeysBetween(null, null, items.length);
      let letter = 0;
      items.forEach(([desc, unit, qty, kind], ii) => {
        const id = (kind === 'note' ? 'n' : 'i') + randomId(10);
        const ref = kind === 'note' ? '' : letter < 26 ? String.fromCharCode(65 + letter) : 'A' + String.fromCharCode(65 + letter - 26);
        if (kind !== 'note') letter++;
        ops.push([id, 'type', kind === 'note' ? 'note' : 'item'], [id, 'parent', secId], [id, 'ord', itemKeys[ii]], [id, 'ref', ref],
          [id, 'desc', desc], [id, 'unit', unit], [id, 'qty', qty]);
      });
    });
  });
  return ops;
}

/** A large BOQ for performance testing (~n items) */
export function bigBoqOps(n: number): Op[] {
  const ops: Op[] = [];
  const bills = Math.max(1, Math.round(n / 400));
  const bk = generateNKeysBetween(null, null, bills);
  let made = 0;
  for (let b = 0; b < bills && made < n; b++) {
    const bid = 'g' + randomId(10);
    ops.push([bid, 'type', 'group'], [bid, 'parent', null], [bid, 'ord', bk[b]], [bid, 'ref', 'Bill ' + (b + 1)], [bid, 'desc', 'BILL ' + (b + 1)]);
    const sk = generateNKeysBetween(null, null, 8);
    for (let s = 0; s < 8 && made < n; s++) {
      const sid = 'g' + randomId(10);
      ops.push([sid, 'type', 'group'], [sid, 'parent', bid], [sid, 'ord', sk[s]], [sid, 'ref', `${b + 1}.${s + 1}`], [sid, 'desc', 'Section ' + (s + 1)]);
      const ik = generateNKeysBetween(null, null, 50);
      for (let i = 0; i < 50 && made < n; i++, made++) {
        const id = 'i' + randomId(10);
        ops.push([id, 'type', 'item'], [id, 'parent', sid], [id, 'ord', ik[i]], [id, 'ref', String(i + 1)],
          [id, 'desc', 'Item ' + made + ' lorem ipsum construction description'], [id, 'unit', 'm2'], [id, 'qty', 100 + i]);
      }
    }
  }
  return ops;
}
