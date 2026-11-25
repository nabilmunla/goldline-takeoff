// What a BOQ unit measures, so a link picks the right quantity by itself
// ("m2" -> area, "Lm" -> length, "nr" -> count) and a wrong pairing is flagged.
import { MEASURE_BASE, type Measure } from './model';

const norm = (unit: string) => unit.trim().toLowerCase().replace(/[.\s'’]/g, '').replace('²', '2').replace('³', '3');
// feet, square feet, cubic feet (and yards): BOQ lines priced that way get the metres converted
const IMPERIAL: [RegExp, Measure, number][] = [
  [/^(sqft|sft|ft2|sqfeet|squarefeet|squarefoot|ft\^2)$/, 'area', 10.763910416709722],
  [/^(cft|cuft|ft3|cubicfeet|cubicfoot|ft\^3)$/, 'vol', 35.31466672148859],
  [/^(ft|rft|lft|runningfeet|runningfoot|linft|feet|foot)$/, 'len', 3.280839895013123],
  [/^(sqyd|syd|yd2|squareyards?)$/, 'area', 1.1959900463010802],
  [/^(cuyd|cyd|yd3|cubicyards?)$/, 'vol', 1.3079506193143922],
  [/^(yd|yds|yards?|lyd|rydd?)$/, 'len', 1.0936132983377078],
];

const TONNES = /^(t|ton|tons|tonne|tonnes|mton|tn|tns|metricton|metrictons|metrictonne|metrictonnes)$/;
// "MT" is metric tonnes on a steel line - how most BOQs here write reinforcement - but metres on a few
// others: steel linked to it is converted (it reached such a line in kg, 1000 times the tonnes, with no
// warning), but it is not taken as a weight when guessing what a line measures
const STEEL_MT = /^mt$/;
/** metres (m², m³) to the BOQ line's unit: 1 unless the line is in feet or yards (or steel in tonnes) */
export function unitFactor(unit: string, q: Measure): number {
  const u = norm(unit);
  if (MEASURE_BASE[q] === 'kg' && (TONNES.test(u) || STEEL_MT.test(u))) return 0.001;
  for (const [re, ms, f] of IMPERIAL) if (re.test(u)) return ms === MEASURE_BASE[q] ? f : 1;
  return 1;
}

export function measureForUnit(unit: string): Measure | null {
  const u = norm(unit);
  if (!u) return null;
  for (const [re, ms] of IMPERIAL) if (re.test(u)) return ms;
  if (/^(m2|sqm|sm|sq\.?m|squaremetres?|squaremeters?|m\^2)$/.test(u)) return 'area';
  if (/^(m3|cum|cm|cubm|cubicmetres?|cubicmeters?|m\^3)$/.test(u)) return 'vol';
  if (/^(m|lm|rm|lin\.?m|linm|rmt|mtr|metres?|meters?|run|lnm)$/.test(u)) return 'len';
  if (/^(nr|no|nos|num|each|ea|pcs|pc|set|sets|unit|units|item|pair|pr)$/.test(u)) return 'cnt';
  if (/^(kg|kgs|kilograms?)$/.test(u) || TONNES.test(u)) return 'kg';
  return null;
}

/** true when the BOQ unit and what is linked clearly don't match (m² line fed with metres) */
export function unitMismatch(unit: string, q: Measure): boolean {
  const m = measureForUnit(unit);
  if (!m) return false;
  // perimeter and lintel length are lengths, formwork an area, lintel volume a volume...
  return MEASURE_BASE[m] !== MEASURE_BASE[q];
}

/** Plain-text similarity between a dummy line and a BOQ line (0..1), for match suggestions. */
export function similarity(a: { desc: string; unit: string; ref?: string }, b: { desc: string; unit: string; ref?: string }): number {
  const words = (s: string) =>
    new Set(
      s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w)),
    );
  const A = words(a.desc), B = words(b.desc);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  let s = inter / (A.size + B.size - inter);
  const ma = measureForUnit(a.unit), mb = measureForUnit(b.unit);
  if (ma && mb) s *= ma === mb ? 1.25 : 0.5;
  if (a.ref && b.ref && a.ref.trim().toLowerCase() === b.ref.trim().toLowerCase()) s += 0.15;
  return Math.min(1, s);
}

const STOP = new Set(['the', 'and', 'with', 'for', 'all', 'including', 'incl', 'as', 'per', 'specified', 'details', 'drawings', 'to', 'of', 'in', 'on', 'or', 'be', 'shall', 'thick', 'mm']);
