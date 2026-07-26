// app.js — Renowise Locator
// Map, postcode selection (hard cap 10), self-documenting panel, i18n, offline,
// and the Renowise-ready export. Selection (a set of postcode codes) is the single
// source of truth; map polygons and list rows are two-way synced. See PRD §7.

import { provinceForPostcode, summarizeProvinces, provinceName } from './provinces.js';
import { resolveInitialLang, getLang, setLang, t } from './i18n.js';

/* ------------------------------------------------------------------ config */
const MAX = 10;
// Built in initMap(), not at module scope: touching L here would throw during
// import if Leaflet failed to load, killing the module before it can report why.
const BE_BOUNDS_LL = [[49.49, 2.55], [51.51, 6.41]];
let BE_BOUNDS = null;
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const STORE_SAVED = 'renowise.locator.saved';
const STORE_LAST = 'renowise.locator.last';
const STORE_HINT = 'renowise.locator.seenHint';

const STYLE_UNSELECTED = { color: '#0B2447', weight: 0.6, opacity: 0.35, fill: true, fillColor: '#0B2447', fillOpacity: 0 };
const STYLE_SELECTED   = { color: '#0B2447', weight: 2,   opacity: 1,    fill: true, fillColor: '#0B2447', fillOpacity: 0.35 };
const STYLE_HIGHLIGHT  = { color: '#0B2447', weight: 2.5, opacity: 1,    fill: true, fillColor: '#DCE3F1', fillOpacity: 0.55 };

const FLEMISH = new Set(['ANT', 'LIM', 'OVL', 'VBR', 'WVL']);
const WALLOON = new Set(['WBR', 'HAI', 'LIE', 'LUX', 'NAM']);

/* ------------------------------------------------------------------- state */
const selected = [];                 // postcode strings, in tap order
const layersByPostcode = new Map();  // pc -> [leaflet layers]
const metaByPostcode = new Map();    // pc -> { nl, fr, province }
const labelByPostcode = new Map();   // pc -> leaflet layer carrying the tooltip
let searchIndex = [];
let localities = {};                 // pc -> [village names] (data/localities.json)
let map, geoLayer;

/* --------------------------------------------------------------- dom refs */
const $ = (s) => document.querySelector(s);
const els = {};

/* ------------------------------------------------------------- utilities */
const byCode = (a, b) => parseInt(a, 10) - parseInt(b, 10);
const sortedSelection = () => [...selected].sort(byCode);
const isPortrait = () => window.matchMedia('(orientation: portrait)').matches;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// Municipality label in the region's own language (PRD §6): NL in Flanders,
// FR in Wallonia, both for bilingual Brussels; fall back to whatever exists.
function munLabel(pc) {
  const m = metaByPostcode.get(pc);
  if (!m) return '';
  const { nl, fr, province } = m;
  if (province === 'BRU') return (nl && fr && nl !== fr) ? `${nl} / ${fr}` : (nl || fr || '');
  if (WALLOON.has(province)) return fr || nl || '';
  return nl || fr || ''; // Flemish + default
}

// Province codes ordered primary-first, then the rest alphabetically.
function orderedProvinces(provinces, primary) {
  const rest = provinces.filter((p) => p !== primary).sort();
  return primary ? [primary, ...rest] : rest;
}
function provinceSummaryText() {
  const { provinces, primary } = summarizeProvinces(selected);
  if (!provinces.length) return '—';
  return orderedProvinces(provinces, primary).map((p) => provinceName(p, getLang())).join(', ');
}

/* ------------------------------------------------------------- selection */
function styleFor(feature) {
  return selected.includes(String(feature.properties.postcode)) ? STYLE_SELECTED : STYLE_UNSELECTED;
}
function restyle(pc) {
  const sel = selected.includes(pc);
  for (const l of (layersByPostcode.get(pc) || [])) l.setStyle(sel ? STYLE_SELECTED : STYLE_UNSELECTED);
}
function toggle(pc) {
  const i = selected.indexOf(pc);
  if (i >= 0) {
    selected.splice(i, 1);
    restyle(pc);
    removeLabel(pc);
  } else {
    if (selected.length >= MAX) {           // hard cap — reject the 11th (PRD §7.2)
      showToast(t('cap_reached', { max: MAX }), 'warn');
      return;
    }
    selected.push(pc);
    restyle(pc);
    addLabel(pc);
  }
  syncUI();
}

/* ----------------------------------------------------------- map labels */
function largestLayer(pc) {
  const ls = layersByPostcode.get(pc) || [];
  let best = ls[0], bestArea = -1;
  for (const l of ls) {
    const b = l.getBounds();
    const a = (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest());
    if (a > bestArea) { bestArea = a; best = l; }
  }
  return best;
}
function labelHTML(pc) {
  const mun = (map.getZoom() >= 11) ? `<br><span class="mun">${escapeHTML(munLabel(pc))}</span>` : '';
  return `<span class="tabular">${pc}</span>${mun}`;
}
function addLabel(pc) {
  const l = largestLayer(pc);
  if (!l) return;
  l.bindTooltip(labelHTML(pc), { permanent: true, direction: 'center', className: 'pc-label', opacity: 1 });
  l.openTooltip();
  labelByPostcode.set(pc, l);
}
function removeLabel(pc) {
  const l = labelByPostcode.get(pc);
  if (l) { l.unbindTooltip(); labelByPostcode.delete(pc); }
}
function refreshLabels() {
  for (const [pc, l] of labelByPostcode) l.setTooltipContent(labelHTML(pc));
}

/* --------------------------------------------------------------- panel */
function renderList() {
  els.list.textContent = '';
  for (const pc of sortedSelection()) {
    const prov = (metaByPostcode.get(pc) || {}).province || provinceForPostcode(pc);
    const li = document.createElement('li');
    li.className = 'sel-row';

    const code = document.createElement('span');
    code.className = 'pc tabular';
    code.textContent = pc;

    const mun = document.createElement('span');
    mun.className = 'mun';
    mun.textContent = munLabel(pc);

    li.append(code, mun);

    if (prov) {
      const chip = document.createElement('span');
      chip.className = 'prov-chip';
      chip.textContent = prov;
      li.append(chip);
    }

    const rm = document.createElement('button');
    rm.className = 'row-remove';
    rm.setAttribute('aria-label', t('remove'));
    rm.textContent = '×';
    rm.addEventListener('click', () => toggle(pc));
    li.append(rm);

    els.list.append(li);
  }
}
function syncUI() {
  els.counter.textContent = `${selected.length} / ${MAX}`;
  els.counter.classList.toggle('at-cap', selected.length >= MAX);
  els.provincesValue.textContent = provinceSummaryText();
  els.emptyHint.hidden = selected.length > 0;
  if (selected.length && els.firstHint && !els.firstHint.hidden) dismissHint();
  renderList();
  autosaveLast();
}

/* -------------------------------------------------------------- search */
// Accent-folded so "liege" matches "Liège" and "brugge" matches "Brugge".
const foldText = (s) => String(s == null ? '' : s)
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function buildSearchIndex() {
  searchIndex = [];
  for (const [pc, m] of metaByPostcode) {
    const aliases = localities[pc] || [];        // village names within this postcode
    searchIndex.push({
      pc,
      nl: foldText(m.nl), fr: foldText(m.fr),
      aliases, aliasNorm: aliases.map(foldText)
    });
  }
  searchIndex.sort((a, b) => byCode(a.pc, b.pc));
}

// Ranked so the obvious hit wins: without this an alias containing the query
// ("ArGENTeau" for "gent") could outrank the town itself, since ties fall back
// to ascending postcode.
function onSearchInput() {
  const raw = els.search.value.trim();
  els.searchClear.hidden = raw === '';
  const q = foldText(raw);
  if (!q) { hideResults(); return; }
  const hits = [];
  for (const item of searchIndex) {
    let score = -1, alias = null, i;
    if (item.pc === q) score = 0;                                        // exact postcode
    else if (item.pc.startsWith(q)) score = 1;                           // postcode prefix
    else if (item.nl.startsWith(q) || item.fr.startsWith(q)) score = 2;  // town starts with
    else if ((i = item.aliasNorm.findIndex((a) => a.startsWith(q))) >= 0) {
      score = 3; alias = item.aliases[i];                                // village starts with
    } else if (item.nl.includes(q) || item.fr.includes(q)) score = 4;    // town contains
    else if ((i = item.aliasNorm.findIndex((a) => a.includes(q))) >= 0) {
      score = 5; alias = item.aliases[i];                                // village contains
    }
    if (score >= 0) hits.push({ pc: item.pc, alias, score });
  }
  hits.sort((a, b) => a.score - b.score || byCode(a.pc, b.pc));
  showResults(hits.slice(0, 20));
}
function showResults(res) {
  els.searchResults.textContent = '';
  if (!res.length) { els.searchResults.hidden = true; return; }
  for (const hit of res) {
    const li = document.createElement('li');
    const pc = document.createElement('span'); pc.className = 'pc tabular'; pc.textContent = hit.pc;
    const mun = document.createElement('span'); mun.className = 'mun';
    const town = munLabel(hit.pc);
    // Matched via a village name → show it, so "Maransart" explains why 1380 is here.
    mun.textContent = hit.alias ? (town ? `${hit.alias} · ${town}` : hit.alias) : town;
    li.append(pc, mun);
    li.addEventListener('click', () => jumpTo(hit.pc));
    els.searchResults.append(li);
  }
  els.searchResults.hidden = false;
}
function hideResults() { els.searchResults.hidden = true; els.searchResults.textContent = ''; }
function jumpTo(pc) {
  const ls = layersByPostcode.get(pc);
  if (ls && ls.length) {
    let b = null;
    for (const l of ls) b = b ? b.extend(l.getBounds()) : l.getBounds();
    map.fitBounds(b.pad(0.4), { maxZoom: 13 });
    flash(pc);
  }
  hideResults();
  els.search.value = '';
  els.searchClear.hidden = true;
  els.search.blur();
}
function flash(pc) {
  if (selected.includes(pc)) return;              // never override a real selection
  const ls = layersByPostcode.get(pc) || [];
  for (const l of ls) l.setStyle(STYLE_HIGHLIGHT);
  setTimeout(() => { if (!selected.includes(pc)) restyle(pc); }, 1600);
}

/* --------------------------------------------------------------- toast */
let toastTimer = null;
function showToast(msg, variant, action) {
  els.toast.textContent = '';
  const span = document.createElement('span');
  span.textContent = msg;
  els.toast.append(span);
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action'; btn.type = 'button'; btn.textContent = action.label;
    btn.addEventListener('click', () => {
      clearTimeout(toastTimer);
      els.toast.hidden = true;
      action.onClick();
    });
    els.toast.append(btn);
  }
  els.toast.className = 'toast' + (variant === 'info' ? ' info' : '');
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, action ? 6000 : 2400);
}

/* ---------------------------------------------------------- copy/share */
function buildText() {
  const name = els.name.value.trim() || '—';
  const date = els.date.value || today();
  const codes = sortedSelection();
  const header = `${name} — ${date} — ${selected.length} postcodes — Provinces: ${provinceSummaryText()}`;
  const descriptive = selected.map((pc) => `${pc} ${munLabel(pc)}`.trim()).join(', ');
  return `${header}\n${descriptive}\n\nCodes: ${codes.join(', ')}`;
}
async function doCopy() {
  const text = buildText();
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch (__) {}
    ta.remove();
  }
  showToast(t('copied'), 'info');
}
async function doShare() {
  const text = buildText();
  if (navigator.share) {
    try { await navigator.share({ text }); } catch (_) {}
  } else {
    doCopy();
  }
}

/* ------------------------------------------------------- Renowise export */
function csvQuote(s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; }
function recordToCsvRow(rec) {
  const codes = [...rec.postcodes].sort(byCode);
  const { provinces, primary } = summarizeProvinces(codes);
  return [csvQuote(rec.name), rec.date, primary || '', orderedProvinces(provinces, primary).join(';'), codes.join(';')].join(',');
}
function csvFor(records) {
  const header = 'name,date,primary_province,provinces,coverage_postcodes';
  return [header, ...records.map(recordToCsvRow)].join('\n') + '\n';
}
function currentRecord() {
  return { name: els.name.value.trim(), date: els.date.value || today(), postcodes: sortedSelection() };
}
function jsonForCurrent() {
  const codes = sortedSelection();
  const { provinces, primary } = summarizeProvinces(codes);
  return JSON.stringify({
    name: els.name.value.trim(),
    date: els.date.value || today(),
    primary_province: primary,
    provinces: orderedProvinces(provinces, primary),
    coverage_postcodes: codes
  }, null, 2);
}
function slug(s) { return (s || 'selection').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'selection'; }
function downloadFile(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------------------------------------------------------- localStorage */
function loadSaved() {
  try { const v = JSON.parse(localStorage.getItem(STORE_SAVED)); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}
function writeSaved(arr) { localStorage.setItem(STORE_SAVED, JSON.stringify(arr)); }
function autosaveLast() {
  try { localStorage.setItem(STORE_LAST, JSON.stringify({ name: els.name.value, date: els.date.value, postcodes: [...selected] })); }
  catch (_) {}
}
function restoreLast() {
  let last;
  try { last = JSON.parse(localStorage.getItem(STORE_LAST)); } catch (_) { return; }
  if (!last) return;
  if (last.name) els.name.value = last.name;
  if (last.date) els.date.value = last.date;
  if (Array.isArray(last.postcodes)) applySelection(last.postcodes);
}
function applySelection(codes) {
  for (const pc of [...selected]) { removeLabel(pc); }
  selected.length = 0;
  for (const raw of codes) {
    const pc = String(raw);
    if (layersByPostcode.has(pc) && !selected.includes(pc) && selected.length < MAX) {
      selected.push(pc); addLabel(pc);
    }
  }
  for (const [pc] of layersByPostcode) restyle(pc);
  syncUI();
}

/* --------------------------------------------------------------- modals */
function openModal(node) {
  els.modalRoot.textContent = '';
  els.modalRoot.append(node);
  els.modalRoot.hidden = false;
}
function closeModal() { els.modalRoot.hidden = true; els.modalRoot.textContent = ''; }
function modalShell(titleText) {
  const modal = document.createElement('div'); modal.className = 'modal';
  const h = document.createElement('h2'); h.textContent = titleText;
  const body = document.createElement('div'); body.className = 'modal-body';
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  modal.append(h, body, actions);
  return { modal, body, actions };
}
function mkBtn(label, cls, onClick) {
  const b = document.createElement('button'); b.className = 'btn' + (cls ? ' ' + cls : '');
  b.textContent = label; if (onClick) b.addEventListener('click', onClick); return b;
}

function confirmDialog(message, confirmLabel, onConfirm, danger, onCancel) {
  const { modal, body, actions } = modalShell(message);
  body.remove(); // message lives in the title for a compact confirm
  actions.append(
    mkBtn(t('cancel'), '', () => { closeModal(); if (onCancel) onCancel(); }),
    mkBtn(confirmLabel, danger ? 'btn-danger' : 'btn-primary', () => { closeModal(); onConfirm(); })
  );
  openModal(modal);
}

function doReset() {
  if (!selected.length && !els.name.value) return;
  confirmDialog(t('reset_confirm'), t('confirm'), () => {
    const prev = { name: els.name.value, date: els.date.value, postcodes: [...selected] };
    applySelection([]);
    els.name.value = '';
    els.date.value = today();
    syncUI();
    showToast(t('cleared'), 'info', {
      label: t('undo'),
      onClick: () => {
        els.name.value = prev.name || '';
        els.date.value = prev.date || today();
        applySelection(prev.postcodes);
      }
    });
  }, true);
}

function doExport() {
  if (!selected.length) return;
  const { modal, body, actions } = modalShell(t('export'));
  const base = `renowise-${slug(els.name.value)}-${els.date.value || today()}`;
  const csv = csvFor([currentRecord()]);
  const json = jsonForCurrent();

  for (const [label, ext, mime, content] of [['CSV', 'csv', 'text/csv', csv], ['JSON', 'json', 'application/json', json]]) {
    const block = document.createElement('div'); block.style.marginBottom = '14px';
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;';
    const tag = document.createElement('strong'); tag.textContent = label; tag.style.flex = '1';
    row.append(tag,
      mkBtn(t('copy'), '', async () => { try { await navigator.clipboard.writeText(content); showToast(t('copied'), 'info'); } catch (_) {} }),
      mkBtn(t('export'), 'btn-primary', () => downloadFile(`${base}.${ext}`, mime, content)));
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;padding:10px;background:#fff;border:1px solid rgba(11,36,71,.12);border-radius:10px;overflow:auto;font-size:12px;max-height:26vh;white-space:pre-wrap;word-break:break-word;';
    pre.textContent = content;
    block.append(row, pre); body.append(block);
  }
  actions.append(mkBtn(t('cancel'), '', closeModal));
  openModal(modal);
}

function openSaved() {
  const { modal, body, actions } = modalShell(t('saved_list_title'));
  const records = loadSaved();
  if (!records.length) {
    const p = document.createElement('p'); p.className = 'saved-empty'; p.textContent = t('no_saved');
    body.append(p);
  } else {
    const ul = document.createElement('ul'); ul.className = 'saved-list';
    for (const rec of records) {
      const li = document.createElement('li'); li.className = 'saved-item';
      const title = document.createElement('div'); title.className = 'title'; title.textContent = rec.name || '—';
      const meta = document.createElement('div'); meta.className = 'meta';
      meta.textContent = `${rec.date} · ${rec.postcodes.length} / ${MAX}`;
      const rowActions = document.createElement('div'); rowActions.className = 'row-actions';
      rowActions.append(
        mkBtn(t('load'), 'btn-primary', () => {
          els.name.value = rec.name || '';
          els.date.value = rec.date || today();
          applySelection(rec.postcodes);
          closeModal();
        }),
        mkBtn(t('rename'), '', () => renameSaved(rec.id)),
        mkBtn(t('delete'), 'btn-danger', () => deleteSaved(rec))
      );
      li.append(title, meta, rowActions);
      ul.append(li);
    }
    body.append(ul);
    actions.append(mkBtn(t('export_all'), '', () => downloadFile(`renowise-all-${today()}.csv`, 'text/csv', csvFor(records))));
  }
  actions.append(mkBtn(t('cancel'), '', closeModal));
  openModal(modal);
}
// Deleting a saved selection is destructive and was previously instant — it now
// confirms, and the toast offers an Undo that puts the record back where it was.
function deleteSaved(rec) {
  confirmDialog(t('delete_confirm'), t('delete'), () => {
    const before = loadSaved();
    const at = before.findIndex((r) => r.id === rec.id);
    writeSaved(before.filter((r) => r.id !== rec.id));
    openSaved();
    showToast(t('deleted'), 'info', {
      label: t('undo'),
      onClick: () => {
        const arr = loadSaved();
        arr.splice(at < 0 ? 0 : Math.min(at, arr.length), 0, rec);
        writeSaved(arr);
        openSaved();
      }
    });
  }, true, openSaved);   // cancel returns to the Saved list
}

function renameSaved(id) {
  const records = loadSaved();
  const rec = records.find((r) => r.id === id);
  if (!rec) return;
  const { modal, body, actions } = modalShell(t('rename'));
  const input = document.createElement('input'); input.type = 'text'; input.value = rec.name || '';
  body.append(input);
  actions.append(
    mkBtn(t('cancel'), '', openSaved),
    mkBtn(t('save'), 'btn-primary', () => { rec.name = input.value.trim(); writeSaved(records); openSaved(); })
  );
  openModal(modal);
  setTimeout(() => input.focus(), 50);
}
function doSave() {
  if (!selected.length) return;
  const arr = loadSaved();
  arr.unshift({ id: genId(), name: els.name.value.trim() || '—', date: els.date.value || today(), postcodes: sortedSelection() });
  writeSaved(arr);
  showToast(t('saved'), 'info');
}

/* ---------------------------------------------------- i18n application */
function applyI18n() {
  document.documentElement.lang = getLang();
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.getAttribute('data-i18n-attr').split(';').forEach((pair) => {
      const [attr, key] = pair.split(':');
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
  els.langBtns.forEach((b) => b.classList.toggle('active', b.dataset.lang === getLang()));
  els.provincesValue.textContent = provinceSummaryText();
  refreshLabels();
}

/* ------------------------------------------------- portrait bottom sheet */
// Portrait bottom sheet. Two snap points: peek (62%) and open (0%). The whole top
// (handle + header) is draggable. Committing is INTENT-based so it never springs
// straight back: a quick flick, a modest drag in a direction, or a tap on the
// handle all commit — only a tiny stray drag returns to where it started. Taps
// that start on a form control are left alone so the fields stay usable.
function initSheet() {
  const handle = els.sheetHandle, panel = els.panel;
  const header = panel.querySelector('.panel-header');
  const PEEK = 72, OPEN = 0;   // keep in sync with the --sheet-y fallback in styles.css
  const now = () => (window.performance && performance.now ? performance.now() : Date.now());
  let startY = 0, startPct = PEEK, dragging = false, moved = 0, H = 0, fromHandle = false;
  let lastY = 0, lastT = 0, vel = 0;

  const getPct = () => {
    const v = getComputedStyle(panel).getPropertyValue('--sheet-y').trim();
    if (v.endsWith('%')) return parseFloat(v);
    if (v.endsWith('px')) return (parseFloat(v) / (panel.offsetHeight || 1)) * 100;
    return PEEK;
  };
  const snap = (state) => {
    panel.style.setProperty('--sheet-y', state + '%');
    panel.classList.toggle('expanded', state === OPEN);
  };
  const toggle = () => snap(getPct() < PEEK / 2 ? PEEK : OPEN);
  const point = (e) => (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY);

  const down = (e) => {
    if (!isPortrait()) return;
    if (e.target.closest('input, textarea, select, button, a')) return;
    dragging = true; moved = 0; H = panel.offsetHeight || 1;
    startY = lastY = point(e); startPct = getPct(); lastT = now(); vel = 0;
    fromHandle = handle === e.target || handle.contains(e.target);
    panel.classList.add('dragging');
  };
  const move = (e) => {
    if (!dragging) return;
    const y = point(e), tNow = now(), dt = tNow - lastT;   // not `t` — that's the i18n fn
    moved = Math.abs(y - startY);
    if (dt > 0) vel = (y - lastY) / dt;   // px/ms; negative = moving up
    lastY = y; lastT = tNow;
    if (moved > 4 && e.cancelable) e.preventDefault();
    panel.style.setProperty('--sheet-y', Math.min(PEEK, Math.max(OPEN, startPct + ((y - startY) / H) * 100)) + '%');
  };
  const up = () => {
    if (!dragging) return;
    dragging = false; panel.classList.remove('dragging');
    const startedOpen = startPct < PEEK / 2;
    const netUp = startY - lastY;          // > 0 means moved up overall
    const FLICK = 0.35, COMMIT = 26;       // px/ms, px
    let target;
    if (moved < 6) {                                       // a tap
      target = fromHandle ? (startedOpen ? PEEK : OPEN)    // handle taps toggle
                          : startPct;                      // taps elsewhere leave it be
    } else if (Math.abs(vel) > FLICK) {
      target = vel < 0 ? OPEN : PEEK;                      // a flick decides by direction
    } else if (Math.abs(netUp) > COMMIT) {
      target = netUp > 0 ? OPEN : PEEK;                    // a committed drag follows its direction
    } else {
      target = startedOpen ? OPEN : PEEK;                  // tiny stray drag → back to start
    }
    snap(target);
  };
  for (const surface of [handle, header]) {
    surface.addEventListener('touchstart', down, { passive: true });
    surface.addEventListener('touchmove', move, { passive: false });
    surface.addEventListener('touchend', up);
    surface.addEventListener('mousedown', down);
  }
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}
function resetSheet() { els.panel.style.removeProperty('--sheet-y'); els.panel.classList.remove('expanded'); }

/* ------------------------------------------------------ online/offline */
function updateOnline() { els.offlineChip.hidden = navigator.onLine; }

/* -------------------------------------------------- first-run hint */
function maybeShowHint() {
  let seen = false;
  try { seen = !!localStorage.getItem(STORE_HINT); } catch (_) {}
  if (!seen && selected.length === 0 && els.firstHint) els.firstHint.hidden = false;
}
function dismissHint() {
  if (els.firstHint) els.firstHint.hidden = true;
  try { localStorage.setItem(STORE_HINT, '1'); } catch (_) {}
}

/* ---------------------------------------------------------------- init */
async function loadData() {
  const res = await fetch('data/be_postcodes.geojson');
  if (!res.ok) throw new Error('geojson ' + res.status);
  return res.json();
}
// Village aliases are an enhancement, never a hard dependency: if this fails,
// search still works on postcodes and municipality names.
async function loadLocalities() {
  try {
    const res = await fetch('data/localities.json');
    return res.ok ? await res.json() : {};
  } catch (_) { return {}; }
}
function buildLayer(data) {
  geoLayer = L.geoJSON(data, {
    renderer: L.canvas({ padding: 0.5 }),
    style: styleFor,
    onEachFeature: (feature, layer) => {
      const pc = String(feature.properties.postcode);
      if (!layersByPostcode.has(pc)) layersByPostcode.set(pc, []);
      layersByPostcode.get(pc).push(layer);
      if (!metaByPostcode.has(pc)) {
        metaByPostcode.set(pc, { nl: feature.properties.nl, fr: feature.properties.fr, province: provinceForPostcode(pc) });
      }
      layer.on('click', () => toggle(pc));
    }
  }).addTo(map);
}
function initMap() {
  BE_BOUNDS = L.latLngBounds(BE_BOUNDS_LL);
  map = L.map('map', {
    preferCanvas: true,
    minZoom: 7, maxZoom: 16,
    maxBounds: BE_BOUNDS.pad(0.25), maxBoundsViscosity: 0.85,
    zoomControl: true
  });
  // No crossOrigin: raster tiles render as <img> (canvas mode only affects the
  // polygons), so a CORS request buys nothing and a CDN hiccup would blank the
  // tile with no retry. Plain no-cors loading is more robust.
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
  map.fitBounds(BE_BOUNDS);
  map.on('zoomend', refreshLabels);
  // Re-measure after layout settles — if the map sizes its container too early
  // (grid/orientation not final) it only loads tiles for part of the view.
  requestAnimationFrame(() => map.invalidateSize());
  setTimeout(() => map.invalidateSize(), 400);
}
function cacheEls() {
  Object.assign(els, {
    panel: $('#panel'), sheetHandle: $('#sheet-handle'),
    name: $('#name-input'), date: $('#date-input'),
    counter: $('#counter'), provincesValue: $('#provinces-value'),
    list: $('#list'), emptyHint: $('#empty-hint'),
    search: $('#search'), searchResults: $('#search-results'), searchClear: $('#search-clear'),
    toast: $('#toast'), offlineChip: $('#offline-chip'), modalRoot: $('#modal-root'),
    firstHint: $('#first-hint'),
    langBtns: Array.from(document.querySelectorAll('.lang-btn'))
  });
}
function wireEvents() {
  $('#home-btn').addEventListener('click', () => map.fitBounds(BE_BOUNDS));
  $('#reset-btn').addEventListener('click', doReset);
  $('#copy-btn').addEventListener('click', doCopy);
  $('#share-btn').addEventListener('click', doShare);
  $('#save-btn').addEventListener('click', doSave);
  $('#saved-btn').addEventListener('click', openSaved);
  $('#export-btn').addEventListener('click', doExport);

  els.langBtns.forEach((b) => b.addEventListener('click', () => { setLang(b.dataset.lang); applyI18n(); }));

  els.search.addEventListener('input', onSearchInput);
  els.search.addEventListener('focus', onSearchInput);
  els.searchClear.addEventListener('click', () => {
    els.search.value = ''; hideResults(); els.searchClear.hidden = true; els.search.focus();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) hideResults();
  });

  const hintClose = $('#first-hint-close');
  if (hintClose) hintClose.addEventListener('click', dismissHint);

  els.name.addEventListener('input', autosaveLast);
  els.date.addEventListener('input', autosaveLast);

  els.modalRoot.addEventListener('click', (e) => { if (e.target === els.modalRoot) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!els.modalRoot.hidden) { closeModal(); return; }
    if (!els.searchResults.hidden) { hideResults(); els.search.blur(); }
  });

  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);

  // Keep the map sized to its container. iOS settles layout unpredictably after a
  // rotation, so a single re-measure can fire too early and leave the base tiles
  // covering only part of the view — nudge several times as the layout settles.
  const refit = () => { if (map) map.invalidateSize(); };
  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', () => {
    resetSheet();
    [60, 200, 450, 800].forEach((d) => setTimeout(refit, d));
  });
}

async function init() {
  resolveInitialLang();
  cacheEls();
  if (typeof L === 'undefined') {          // bundled Leaflet missing/blocked
    showToast('Map library failed to load', 'warn');
    return;
  }
  els.date.value = today();
  initMap();
  wireEvents();
  initSheet();
  updateOnline();
  applyI18n();

  try {
    const [data, locs] = await Promise.all([loadData(), loadLocalities()]);
    buildLayer(data);
    localities = locs;
    buildSearchIndex();
    restoreLast();
    syncUI();
    maybeShowHint();
  } catch (err) {
    showToast('GeoJSON failed to load', 'warn');
    console.error(err);
  }

  // Register directly (not gated on window 'load' — init() awaits the GeoJSON first,
  // by which point 'load' has already fired and a late listener would never run).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
