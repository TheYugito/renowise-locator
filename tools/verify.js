// End-to-end verification of the rebuilt data + the REAL search code from app.js.
const fs = require('fs');
const APP = process.env.HOME + '/renowise-locator';
let pass = 0, fail = 0;
const chk = (ok, label, detail) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '  ' + detail : '')); };

/* ------------------------------------------------------------------ geometry */
const F = JSON.parse(fs.readFileSync(APP + '/data/be_postcodes.geojson', 'utf8')).features;
function pir(p, r) { let s = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1]; if (((yi > p[1]) != (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / ((yj - yi) || 1e-12) + xi)) s = !s; } return s; }
function ph(p, rs) { if (!pir(p, rs[0])) return false; for (let k = 1; k < rs.length; k++) if (pir(p, rs[k])) return false; return true; }
function hit(p, g) { return g && (g.type === 'Polygon' ? ph(p, g.coordinates) : g.type === 'MultiPolygon' ? g.coordinates.some((x) => ph(p, x)) : false); }
const at = (p) => [...new Set(F.filter((f) => hit(p, f.geometry)).map((f) => f.properties.postcode))].sort();

console.log('--- coverage (the reported problems) ---');
chk(at([4.4560, 50.6561]).join() === '1380', 'Maransart selects 1380 Lasne (rural gap)', at([4.4560, 50.6561]).join(', '));
chk(at([4.3720, 50.8275]).join() === '1050', 'Ixelles/Flagey is ONLY 1050 (was 1000+1047+1050)', at([4.3720, 50.8275]).join(', '));
const bru = at([4.3517, 50.8467]);
chk(bru.length <= 5 && bru.includes('1000'), 'Brussels centre down from 17 overlaps', bru.join(', '));

console.log('\n--- cities must stay intact ---');
for (const [n, p, e] of [['Antwerp', [4.4025, 51.2194], '2000'], ['Ghent', [3.7250, 51.0536], '9000'], ['Bruges', [3.2247, 51.2093], '8000'], ['Liege', [5.5797, 50.6402], '4000'], ['Charleroi', [4.4446, 50.4114], '6000'], ['Leuven', [4.7009, 50.8798], '3000']])
  chk(at(p).includes(e), n + ' -> ' + e, at(p).join(', ') || '(gap)');

console.log('\n--- data hygiene ---');
chk(F.every((f) => f.geometry), 'no null geometry');
chk(F.every((f) => f.properties.nl || f.properties.fr), 'every feature named');
chk(F.every((f) => /^\d{4}$/.test(f.properties.postcode)), 'all postcodes are 4 digits');
const pcs = new Set(F.map((f) => f.properties.postcode));
chk(!pcs.has('1048') && !pcs.has('1099') && !pcs.has('2099'), 'service/PO-box codes removed (1048, 1099, 2099)');
console.log('      features: ' + F.length + ' | distinct postcodes: ' + pcs.size);

/* -------------------------------------------------- search (real app.js code) */
const src = fs.readFileSync(APP + '/app.js', 'utf8');
const foldSrc = src.match(/const foldText = [\s\S]*?\n/)[0] + src.match(/\s*\.toLowerCase\(\)\.normalize[^\n]*\n/)[0];
const loopSrc = src.match(/const hits = \[\];[\s\S]*?hits\.sort\([^\n]*\);/)[0];
const byCode = (a, b) => parseInt(a, 10) - parseInt(b, 10);
const fold = new Function(foldSrc + '\nreturn foldText;')();
const runQuery = new Function('searchIndex', 'q', 'byCode', foldSrc + '\n' + loopSrc + '\nreturn hits;');

const localities = JSON.parse(fs.readFileSync(APP + '/data/localities.json', 'utf8'));
const meta = new Map();
for (const f of F) { const pc = f.properties.postcode; if (!meta.has(pc)) meta.set(pc, f.properties); }
const searchIndex = [];
for (const [pc, m] of meta) {
  const aliases = localities[pc] || [];
  searchIndex.push({ pc, nl: fold(m.nl), fr: fold(m.fr), aliases, aliasNorm: aliases.map(fold) });
}
searchIndex.sort((a, b) => byCode(a.pc, b.pc));
const q = (s) => runQuery(searchIndex, fold(s), byCode).slice(0, 3).map((h) => h.pc + (h.alias ? '(' + h.alias + ')' : ''));

console.log('\n--- search (executing the shipped ranking code) ---');
for (const [query, want] of [['maransart', '1380'], ['ohain', '1380'], ['plancenoit', '1380'], ['gent', '9000'], ['liege', '4000'], ['liège', '4000'], ['brussel', '1000'], ['lasne', '1380'], ['1380', '1380'], ['ixelles', '1050']])
  chk((q(query)[0] || '').startsWith(want), '"' + query + '" -> ' + want, JSON.stringify(q(query)));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
