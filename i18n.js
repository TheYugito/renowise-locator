// i18n.js — UI string table (PRD Appendix A, verbatim) + t(key, vars).
// UI language is independent of the map/list municipality labels (which use the
// region's own language from the data). See PRD §6.

export const STRINGS = {
  en: {
    app_title: "Renowise Locator",
    name_label: "Subcontractor", name_placeholder: "Name…",
    date_label: "Date",
    counter: "{n} / {max} postcodes",
    cap_reached: "Maximum {max} postcodes. Remove one to add another.",
    empty_hint: "Tap postcodes on the map to add them.",
    provinces_label: "Provinces",
    search_placeholder: "Search postcode or town",
    fit_home: "Whole of Belgium",
    reset: "Reset", reset_confirm: "Clear all selected postcodes?",
    copy: "Copy", copied: "Copied to clipboard",
    share: "Share",
    save: "Save", saved: "Saved",
    saved_list_title: "Saved selections",
    load: "Load", rename: "Rename", delete: "Delete", export_all: "Export all",
    export: "Export", remove: "Remove",
    confirm: "Clear", cancel: "Cancel",
    offline: "Offline — using cached map",
    undo: "Undo", cleared: "Selection cleared",
    clear_search: "Clear search",
    first_hint: "Tap postcode areas on the map to add them — up to 10.",
    delete_confirm: "Delete this saved selection?", deleted: "Deleted",
    no_saved: "No saved selections yet.",
    toggle_list: "Expand or collapse the list", dismiss: "Dismiss"
  },
  nl: {
    app_title: "Renowise Locator",
    name_label: "Onderaannemer", name_placeholder: "Naam…",
    date_label: "Datum",
    counter: "{n} / {max} postcodes",
    cap_reached: "Maximaal {max} postcodes. Verwijder er een om een andere toe te voegen.",
    empty_hint: "Tik postcodes op de kaart aan om ze toe te voegen.",
    provinces_label: "Provincies",
    search_placeholder: "Zoek postcode of gemeente",
    fit_home: "Heel België",
    reset: "Wissen", reset_confirm: "Alle geselecteerde postcodes wissen?",
    copy: "Kopiëren", copied: "Gekopieerd naar klembord",
    share: "Delen",
    save: "Bewaren", saved: "Bewaard",
    saved_list_title: "Bewaarde selecties",
    load: "Laden", rename: "Hernoemen", delete: "Verwijderen", export_all: "Alles exporteren",
    export: "Exporteren", remove: "Verwijderen",
    confirm: "Wissen", cancel: "Annuleren",
    offline: "Offline — opgeslagen kaart",
    undo: "Ongedaan maken", cleared: "Selectie gewist",
    clear_search: "Zoekopdracht wissen",
    first_hint: "Tik postcodegebieden op de kaart aan om ze toe te voegen — max. 10.",
    delete_confirm: "Deze bewaarde selectie verwijderen?", deleted: "Verwijderd",
    no_saved: "Nog geen bewaarde selecties.",
    toggle_list: "Lijst openen of sluiten", dismiss: "Sluiten"
  },
  fr: {
    app_title: "Renowise Locator",
    name_label: "Sous-traitant", name_placeholder: "Nom…",
    date_label: "Date",
    counter: "{n} / {max} codes postaux",
    cap_reached: "Maximum {max} codes postaux. Retirez-en un pour en ajouter un autre.",
    empty_hint: "Touchez des codes postaux sur la carte pour les ajouter.",
    provinces_label: "Provinces",
    search_placeholder: "Rechercher code postal ou commune",
    fit_home: "Toute la Belgique",
    reset: "Réinitialiser", reset_confirm: "Effacer tous les codes postaux sélectionnés ?",
    copy: "Copier", copied: "Copié dans le presse-papiers",
    share: "Partager",
    save: "Enregistrer", saved: "Enregistré",
    saved_list_title: "Sélections enregistrées",
    load: "Charger", rename: "Renommer", delete: "Supprimer", export_all: "Tout exporter",
    export: "Exporter", remove: "Retirer",
    confirm: "Effacer", cancel: "Annuler",
    offline: "Hors ligne — carte en cache",
    undo: "Annuler", cleared: "Sélection effacée",
    clear_search: "Effacer la recherche",
    first_hint: "Touchez des zones de code postal sur la carte pour les ajouter — 10 max.",
    delete_confirm: "Supprimer cette sélection enregistrée ?", deleted: "Supprimé",
    no_saved: "Aucune sélection enregistrée.",
    toggle_list: "Ouvrir ou fermer la liste", dismiss: "Fermer"
  }
};

export const LANGS = ['en', 'nl', 'fr'];
const LANG_KEY = 'renowise.locator.lang';

let current = 'en';

// Resolve the initial UI language: saved choice → iPad locale clamped to the three
// → EN fallback (mirrors Renowise's resolveNewsLanguage).
export function resolveInitialLang() {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved && LANGS.includes(saved)) { current = saved; return current; }
  const nav = (navigator.languages && navigator.languages.length)
    ? navigator.languages : [navigator.language || 'en'];
  for (const l of nav) {
    const two = String(l).slice(0, 2).toLowerCase();
    if (LANGS.includes(two)) { current = two; return current; }
  }
  current = 'en';
  return current;
}

export function getLang() { return current; }

export function setLang(lang) {
  if (!LANGS.includes(lang)) return;
  current = lang;
  localStorage.setItem(LANG_KEY, lang);
}

// t('counter', {n:3, max:10}) → "3 / 10 postcodes"
export function t(key, vars) {
  const table = STRINGS[current] || STRINGS.en;
  let s = (table[key] != null ? table[key] : (STRINGS.en[key] != null ? STRINGS.en[key] : key));
  if (vars) {
    for (const k of Object.keys(vars)) {
      s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(vars[k]));
    }
  }
  return s;
}
