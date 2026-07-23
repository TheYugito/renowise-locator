// provinces.js — faithful port of Renowise's BelgianGeo
// (apps/mobile/lib/services/belgian_geo.dart). Postcode → one of 11 region codes.
// This MUST match Renowise exactly so the export lines up (PRD Appendix B).

// Returns one of the 11 Renowise region codes, or null.
export function provinceForPostcode(code) {
  const t = String(code).trim();
  if (!/^\d{4}$/.test(t)) return null;
  const z = parseInt(t, 10);
  if (z < 1000) return null;
  if (z <= 1299) return 'BRU'; // Brussels-Capital
  if (z <= 1499) return 'WBR'; // Walloon Brabant
  if (z <= 1999) return 'VBR'; // Flemish Brabant (Halle-Vilvoorde)
  if (z <= 2999) return 'ANT'; // Antwerp
  if (z <= 3499) return 'VBR'; // Flemish Brabant (Leuven)
  if (z <= 3999) return 'LIM'; // Limburg
  if (z <= 4999) return 'LIE'; // Liège
  if (z <= 5999) return 'NAM'; // Namur
  if (z <= 6599) return 'HAI'; // Hainaut (Charleroi/Thuin)
  if (z <= 6999) return 'LUX'; // Luxembourg
  if (z <= 7999) return 'HAI'; // Hainaut (Mons/Tournai)
  if (z <= 8999) return 'WVL'; // West Flanders
  if (z <= 9999) return 'OVL'; // East Flanders
  return null;
}

export const PROVINCE_NAMES = {
  ANT: { nl: 'Antwerpen',       fr: 'Anvers',              en: 'Antwerp' },
  LIM: { nl: 'Limburg',         fr: 'Limbourg',            en: 'Limburg' },
  OVL: { nl: 'Oost-Vlaanderen', fr: 'Flandre orientale',   en: 'East Flanders' },
  VBR: { nl: 'Vlaams-Brabant',  fr: 'Brabant flamand',     en: 'Flemish Brabant' },
  WVL: { nl: 'West-Vlaanderen', fr: 'Flandre occidentale', en: 'West Flanders' },
  WBR: { nl: 'Waals-Brabant',   fr: 'Brabant wallon',      en: 'Walloon Brabant' },
  HAI: { nl: 'Henegouwen',      fr: 'Hainaut',             en: 'Hainaut' },
  LIE: { nl: 'Luik',            fr: 'Liège',               en: 'Liège' },
  LUX: { nl: 'Luxemburg',       fr: 'Luxembourg',          en: 'Luxembourg' },
  NAM: { nl: 'Namen',           fr: 'Namur',               en: 'Namur' },
  BRU: { nl: 'Brussel',         fr: 'Bruxelles',           en: 'Brussels' },
};

// primary province = mode of the selected postcodes' provinces
export function summarizeProvinces(postcodes) {
  const counts = {};
  for (const p of postcodes) {
    const prov = provinceForPostcode(p);
    if (prov) counts[prov] = (counts[prov] || 0) + 1;
  }
  const provinces = Object.keys(counts);
  const primary = provinces.sort((a, b) => counts[b] - counts[a])[0] || null;
  return { provinces, primary };
}

// Localized province name for a code, falling back to the code itself.
export function provinceName(code, lang) {
  const entry = PROVINCE_NAMES[code];
  if (!entry) return code;
  return entry[lang] || entry.en || code;
}
