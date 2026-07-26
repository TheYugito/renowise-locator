// Rebuild data/be_postcodes.geojson from source.
//
// The bpost source has no true postcode boundaries: each record is a
// (postcode x municipality) pair carrying that MUNICIPALITY's whole outline.
// That creates two phantoms this script removes:
//   A. a postcode that appears in a neighbouring municipality's records inherits
//      that municipality's entire shape (postcode 1000 covering all of Ixelles).
//   B. service / PO-box codes (Parliament, EU, mail centres) have no geography at
//      all and are emitted as full-size copies of the city.
// It then re-applies the gap fix: single-postcode municipalities get the official
// gapless municipality outline, so rural villages like Maransart stay tappable.
const fs = require('fs');
const D = __dirname;

const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const a1 = (v) => (Array.isArray(v) ? v[0] : v);

/* ---------------------------------------------- GeoNames: the naming authority */
const gn = new Map();                                    // pc -> [place names]
for (const line of fs.readFileSync(D + '/BE.txt', 'utf8').split('\n')) {
  const c = line.split('\t');
  if (c.length < 3) continue;
  const pc = (c[1] || '').trim(), place = (c[2] || '').trim();
  if (!pc || !place) continue;
  if (!gn.has(pc)) gn.set(pc, []);
  gn.get(pc).push(place);
}

/* ------------------------------------------------------------- raw postcodes */
const raw = JSON.parse(fs.readFileSync(D + '/raw_pc.geojson', 'utf8'));
let feats = raw.features
  .filter((f) => f.geometry && /^\d{4}$/.test(String(f.properties.postcode)) && parseInt(f.properties.postcode, 10) >= 1000)
  .map((f) => ({
    pc: String(f.properties.postcode),
    munCode: a1(f.properties.mun_code),
    nl: a1(f.properties.mun_name_nl),
    fr: a1(f.properties.mun_name_fr),
    geometry: f.geometry
  }));
console.log('raw usable features:', feats.length);

/* ------------- Fix A: drop features whose municipality isn't the postcode's own */
const byPc = new Map();
for (const f of feats) { if (!byPc.has(f.pc)) byPc.set(f.pc, []); byPc.get(f.pc).push(f); }

let droppedA = 0, ambiguous = [];
const kept = [];
for (const [pc, arr] of byPc) {
  const variants = [...new Set(arr.map((f) => fold(f.nl) + '|' + fold(f.fr)))];
  if (variants.length < 2) { kept.push(...arr); continue; }

  const truth = (gn.get(pc) || []).map(fold);
  // the canonical municipality is the variant GeoNames names for this postcode
  const match = (f) => [fold(f.nl), fold(f.fr)].filter(Boolean)
    .some((c) => truth.some((tn) => c === tn || c.includes(tn) || tn.includes(c)));
  const winners = truth.length ? arr.filter(match) : [];

  if (!winners.length) {            // can't tell — keep everything rather than lose data
    ambiguous.push(pc + ' ' + JSON.stringify(variants));
    kept.push(...arr);
    continue;
  }
  const canon = fold(winners[0].nl) + '|' + fold(winners[0].fr);
  const sub = arr.filter((f) => fold(f.nl) + '|' + fold(f.fr) === canon);
  droppedA += arr.length - sub.length;
  kept.push(...sub);
}
feats = kept;
console.log('Fix A — phantom cross-municipality polygons dropped:', droppedA);
if (ambiguous.length) console.log('  ambiguous, left untouched:', ambiguous.join('; '));

/* ------------------- gap fix: single-postcode municipalities get the outline */
const munPostcodes = new Map();                          // munCode -> Set(pc)
for (const f of feats) {
  if (!munPostcodes.has(f.munCode)) munPostcodes.set(f.munCode, new Set());
  munPostcodes.get(f.munCode).add(f.pc);
}
const singleMun = new Map();                             // munCode -> the one pc
for (const [mc, set] of munPostcodes) if (set.size === 1) singleMun.set(mc, [...set][0]);
console.log('single-postcode municipalities:', singleMun.size, '| multi:', munPostcodes.size - singleMun.size);

const mun = JSON.parse(fs.readFileSync(D + '/raw_mun.geojson', 'utf8'));
const nameFor = new Map();                               // pc -> {nl,fr} from the kept features
for (const f of feats) if (!nameFor.has(f.pc)) nameFor.set(f.pc, { nl: f.nl, fr: f.fr });

const out = [];
const substituted = new Set();
for (const m of mun.features) {
  const mc = a1(m.properties.mun_code);
  if (!singleMun.has(mc) || !m.geometry) continue;
  const pc = singleMun.get(mc);
  const nm = nameFor.get(pc) || {};
  out.push({ pc, nl: nm.nl || a1(m.properties.mun_name_nl), fr: nm.fr || a1(m.properties.mun_name_fr), geometry: m.geometry });
  substituted.add(mc);
}
for (const f of feats) if (!substituted.has(f.munCode)) out.push(f);
console.log('municipality outlines substituted:', substituted.size, '| features now:', out.length);

/* ------- Fix B: service / PO-box codes whose shape duplicates another postcode */
function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * r[i][1] - r[i][0] * r[j][1]); return Math.abs(a / 2); }
function area(g) { if (!g) return 0; if (g.type === 'Polygon') return ringArea(g.coordinates[0]); if (g.type === 'MultiPolygon') return g.coordinates.reduce((s, p) => s + ringArea(p[0]), 0); return 0; }

const shapeCount = new Map();
for (const f of out) { const k = area(f.geometry).toExponential(6); shapeCount.set(k, (shapeCount.get(k) || 0) + 1); }

const final = [];
const droppedPcs = new Set();
for (const f of out) {
  const dup = shapeCount.get(area(f.geometry).toExponential(6)) > 1;
  if (dup && !gn.has(f.pc)) { droppedPcs.add(f.pc); continue; }   // no real place behind it
  final.push(f);
}
// safety: never let a postcode vanish that GeoNames knows about
const survivors = new Set(final.map((f) => f.pc));
for (const pc of droppedPcs) if (gn.has(pc) && !survivors.has(pc)) console.log('  WARNING would have lost real postcode', pc);
console.log('Fix B — service/PO-box postcodes dropped:', droppedPcs.size);
console.log('  ' + [...droppedPcs].sort().join(', '));

/* -------------------------------------------------------------------- write */
const fc = {
  type: 'FeatureCollection',
  features: final.map((f) => {
    // a few source records carry no municipality name (e.g. 2322) — GeoNames has one
    const alt = (gn.get(f.pc) || [])[0] || null;
    return {
      type: 'Feature',
      properties: { postcode: f.pc, nl: f.nl || alt, fr: f.fr || alt },
      geometry: f.geometry
    };
  })
};
fs.writeFileSync(D + '/merged.geojson', JSON.stringify(fc));
console.log('\nfinal features:', fc.features.length, '| distinct postcodes:', new Set(fc.features.map((f) => f.properties.postcode)).size);
