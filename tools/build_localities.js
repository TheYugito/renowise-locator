// Build data/localities.json — village/locality aliases per postcode, from the
// GeoNames BE postal-code file (CC BY 4.0). The boundary data only carries
// MUNICIPALITY names, so villages like Maransart (in Lasne, 1380) are otherwise
// unfindable. Only postcodes that still have a polygon are kept, and names already
// equal to the municipality label are skipped so the file stays small.
const fs = require('fs');
const D = __dirname;
const TARGET = process.argv[2] || (D + '/../renowise-locator/data');

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

const geo = JSON.parse(fs.readFileSync(TARGET + '/be_postcodes.geojson', 'utf8'));
const known = new Map();                       // pc -> Set(names already searchable)
for (const f of geo.features) {
  const pc = String(f.properties.postcode);
  if (!known.has(pc)) known.set(pc, new Set());
  for (const n of [f.properties.nl, f.properties.fr]) if (n) known.get(pc).add(norm(n));
}

const out = {};
let added = 0, skippedNoPolygon = 0, skippedDuplicate = 0;
for (const line of fs.readFileSync(D + '/BE.txt', 'utf8').split('\n')) {
  const c = line.split('\t');
  if (c.length < 3) continue;
  const pc = (c[1] || '').trim(), place = (c[2] || '').trim();
  if (!pc || !place) continue;
  if (!known.has(pc)) { skippedNoPolygon++; continue; }        // dropped/service code
  const n = norm(place);
  if (known.get(pc).has(n)) { skippedDuplicate++; continue; }  // already findable
  (out[pc] = out[pc] || []).push(place);
  known.get(pc).add(n);
  added++;
}

fs.writeFileSync(TARGET + '/localities.json', JSON.stringify(out));
console.log('aliases:', added, 'across', Object.keys(out).length, 'postcodes',
  '| skipped: no-polygon', skippedNoPolygon, ', already-searchable', skippedDuplicate);
console.log('size:', Math.round(fs.statSync(TARGET + '/localities.json').size / 1024) + ' KB');
console.log('1380 ->', JSON.stringify(out['1380'] || []));
