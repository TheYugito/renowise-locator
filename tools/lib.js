// Shared helpers for the data tools. Resolves paths from the repo itself, so the
// scripts work wherever the repo is cloned (they used to hardcode $HOME).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

// The shipped map data is TopoJSON; decode it with the same vendored client the
// browser uses, so tooling and app can never disagree about the geometry.
function loadFeatures() {
  const topojson = require(path.join(ROOT, 'vendor', 'topojson-client.min.js'));
  const topo = JSON.parse(fs.readFileSync(path.join(DATA, 'be_postcodes.topojson'), 'utf8'));
  const key = Object.keys(topo.objects)[0];
  return topojson.feature(topo, topo.objects[key]).features;
}

const fold = (s) => String(s == null ? '' : s)
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// point-in-polygon (ray casting), honouring holes
function pointInRing(p, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
  }
  return inside;
}
function pointInPolygon(p, rings) {
  if (!pointInRing(p, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (pointInRing(p, rings[k])) return false;
  return true;
}
function hit(p, g) {
  if (!g) return false;
  if (g.type === 'Polygon') return pointInPolygon(p, g.coordinates);
  if (g.type === 'MultiPolygon') return g.coordinates.some((poly) => pointInPolygon(p, poly));
  return false;
}
const postcodesAt = (features, p) =>
  [...new Set(features.filter((f) => hit(p, f.geometry)).map((f) => f.properties.postcode))].sort();

module.exports = { ROOT, DATA, loadFeatures, fold, hit, postcodesAt };
