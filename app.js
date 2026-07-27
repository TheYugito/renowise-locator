// app.js — Renowise Locator
// Map, postcode selection (cap, default 10, adjustable), self-documenting panel, i18n, offline,
// and the Renowise-ready export. Selection (a set of postcode codes) is the single
// source of truth; map polygons and list rows are two-way synced. See PRD §7.

import { provinceForPostcode, summarizeProvinces, provinceName } from './provinces.js';
import { resolveInitialLang, getLang, setLang, t } from './i18n.js';

/* ------------------------------------------------------------------ config */
// PRD §7.2 fixed this at 10; it is now an operator-adjustable setting that
// defaults to 10. Everything downstream reads MAX, and the Appendix A strings
// already interpolate {max}, so nothing else needs to know.
const DEFAULT_MAX = 10;
let MAX = DEFAULT_MAX;
// Built in initMap(), not at module scope: touching L here would throw during
// import if Leaflet failed to load, killing the module before it can report why.
const BE_BOUNDS_LL = [[49.49, 2.55], [51.51, 6.41]];
let BE_BOUNDS = null;
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const STORE_SAVED = 'renowise.locator.saved';
const STORE_LAST = 'renowise.locator.last';
const STORE_HINT = 'renowise.locator.seenHint';
const STORE_MAX = 'renowise.locator.max';

const STYLE_UNSELECTED = { color: '#0B2447', weight: 0.6, opacity: 0.35, fill: true, fillColor: '#0B2447', fillOpacity: 0 };
const STYLE_SELECTED   = { color: '#0B2447', weight: 2,   opacity: 1,    fill: true, fillColor: '#0B2447', fillOpacity: 0.35 };
const STYLE_HIGHLIGHT  = { color: '#0B2447', weight: 2.5, opacity: 1,    fill: true, fillColor: '#DCE3F1', fillOpacity: 0.55 };

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
  // sortedSelection(), NOT selected: summarizeProvinces breaks a count tie by
  // input order (Appendix B's comparator returns 0 on ties), so passing tap
  // order here while the export passes sorted order made the panel and the
  // exported primary_province disagree for the same selection.
  const { provinces, primary } = summarizeProvinces(sortedSelection());
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
    if (selected.length >= MAX) {           // cap — reject the tap past the limit (PRD §7.2)
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
  updateCounterLabel();
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
// Each result is two real buttons rather than a clickable <li>. The map draws its
// polygons to a canvas, so they have no DOM node to focus — before this there was
// no way to select a postcode at all without a pointer. The second button gives
// keyboard (and screen-reader) users an add/remove path, while the first keeps the
// PRD's behaviour that searching only pans, never auto-selects.
function showResults(res) {
  els.searchResults.textContent = '';
  if (!res.length) {
    els.searchResults.hidden = true;
    els.search.setAttribute('aria-expanded', 'false');
    return;
  }
  for (const hit of res) {
    const li = document.createElement('li');

    const go = document.createElement('button');
    go.type = 'button'; go.className = 'result-go';
    const pc = document.createElement('span'); pc.className = 'pc tabular'; pc.textContent = hit.pc;
    const mun = document.createElement('span'); mun.className = 'mun';
    const town = munLabel(hit.pc);
    // Matched via a village name → show it, so "Maransart" explains why 1380 is here.
    mun.textContent = hit.alias ? (town ? `${hit.alias} · ${town}` : hit.alias) : town;
    go.append(pc, mun);
    go.addEventListener('click', () => jumpTo(hit.pc));

    const on = selected.includes(hit.pc);
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'result-add' + (on ? ' on' : '');
    add.textContent = on ? '−' : '+';
    add.setAttribute('aria-label', `${on ? t('remove') : t('add')} ${hit.pc}`);
    // Update this button in place rather than re-rendering the list: rebuilding
    // detaches the very node being clicked, and the document-level
    // "click outside closes the results" handler then sees a detached target
    // whose closest('.search-wrap') is null — and closed the list every time.
    add.addEventListener('click', () => {
      const before = selected.length;
      toggle(hit.pc);
      if (selected.length === before) return;            // rejected by the cap
      const nowOn = selected.includes(hit.pc);
      add.classList.toggle('on', nowOn);
      add.textContent = nowOn ? '−' : '+';
      add.setAttribute('aria-label', `${nowOn ? t('remove') : t('add')} ${hit.pc}`);
    });

    li.append(go, add);
    els.searchResults.append(li);
  }
  els.searchResults.hidden = false;
  els.search.setAttribute('aria-expanded', 'true');
}
function hideResults() {
  els.searchResults.hidden = true;
  els.searchResults.textContent = '';
  els.search.setAttribute('aria-expanded', 'false');
}
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
// Reports what actually happened. It used to toast "Copied to clipboard"
// unconditionally, so on a plain-http LAN origin (where navigator.clipboard is
// undefined) the user was told it worked and pasted nothing.
async function doCopy() {
  const text = buildText();
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (_) { ok = false; }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch (__) { ok = false; }
    ta.remove();
  }
  showToast(ok ? t('copied') : t('copy_failed'), ok ? 'info' : 'warn');
  return ok;
}
async function doShare() {
  const text = buildText();
  if (!navigator.share) return doCopy();
  try {
    await navigator.share({ text });
  } catch (err) {
    // A real failure (share unsupported for this payload, gesture chain broken)
    // used to be swallowed exactly like a user cancel, so the button just did
    // nothing forever. A cancel is an AbortError and stays silent.
    if (err && err.name !== 'AbortError') doCopy();
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
// Returns false instead of throwing: an unguarded quota error here escaped the
// click handler, so Save showed no confirmation and Delete left the sheet in a
// half-updated state with the record still on disk.
function writeSaved(arr) {
  try { localStorage.setItem(STORE_SAVED, JSON.stringify(arr)); return true; }
  catch (_) { return false; }
}
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
// Returns how many codes were dropped (unknown postcode, or over the limit) so
// callers can say so — loading a 30-postcode record under a limit of 10 used to
// silently keep 10 and discard 20 with no indication at all.
function applySelection(codes) {
  for (const pc of [...selected]) { removeLabel(pc); }
  selected.length = 0;
  let dropped = 0;
  for (const raw of codes) {
    const pc = String(raw);
    if (layersByPostcode.has(pc) && !selected.includes(pc) && selected.length < MAX) {
      selected.push(pc); addLabel(pc);
    } else if (!selected.includes(pc)) {
      dropped++;
    }
  }
  for (const [pc] of layersByPostcode) restyle(pc);
  syncUI();
  return dropped;
}

/* --------------------------------------------------------------- modals */
// Escape and backdrop-click used to call closeModal() directly, skipping the
// dialog's own cancel path — so dismissing a nested confirm (Saved… → Delete)
// closed everything instead of returning to the list the Cancel button does.
let modalDismiss = null;
let modalReturnFocus = null;
let modalTitleSeq = 0;

function openModal(node, onDismiss) {
  // Only remember the outside element on the *first* open: a nested dialog
  // (Saved… → Delete) replaces the root's contents, so capturing again would
  // store a node that is about to be detached and focus would land on <body>.
  if (els.modalRoot.hidden) modalReturnFocus = document.activeElement;
  els.modalRoot.textContent = '';
  els.modalRoot.append(node);
  els.modalRoot.hidden = false;
  modalDismiss = onDismiss || null;

  els.modalRoot.setAttribute('role', 'dialog');
  els.modalRoot.setAttribute('aria-modal', 'true');
  const h = node.querySelector('h2');
  if (h) {
    if (!h.id) h.id = 'modal-title-' + (++modalTitleSeq);
    els.modalRoot.setAttribute('aria-labelledby', h.id);
  } else {
    els.modalRoot.removeAttribute('aria-labelledby');
  }
  const first = node.querySelector('input, button');
  if (first) setTimeout(() => first.focus(), 0);
}

function closeModal() {
  els.modalRoot.hidden = true;
  els.modalRoot.textContent = '';
  modalDismiss = null;
  els.modalRoot.removeAttribute('aria-labelledby');
  const back = modalReturnFocus;
  modalReturnFocus = null;
  if (back && back.isConnected && typeof back.focus === 'function') back.focus();
}

const focusablesIn = (root) =>
  [...root.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
function dismissModal() {
  const after = modalDismiss;
  closeModal();
  if (after) after();
}
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
  openModal(modal, onCancel);
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
      // count only — the limit is now adjustable, so "12 / 8" could read as broken
      meta.textContent = `${rec.date} · ${rec.postcodes.length}`;
      const rowActions = document.createElement('div'); rowActions.className = 'row-actions';
      rowActions.append(
        mkBtn(t('load'), 'btn-primary', () => {
          els.name.value = rec.name || '';
          els.date.value = rec.date || today();
          const dropped = applySelection(rec.postcodes || []);
          closeModal();
          // a record saved under a higher limit would otherwise load partially
          // and silently — the user would never know postcodes went missing
          if (dropped) showToast(t('some_dropped', { n: dropped }), 'warn');
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
    const ok = writeSaved(before.filter((r) => r.id !== rec.id));
    openSaved();
    if (!ok) { showToast(t('save_failed'), 'warn'); return; }   // nothing was deleted
    showToast(t('deleted'), 'info', {
      label: t('undo'),
      onClick: () => {
        const arr = loadSaved();
        arr.splice(at < 0 ? 0 : Math.min(at, arr.length), 0, rec);
        const back = writeSaved(arr);
        openSaved();
        if (!back) showToast(t('save_failed'), 'warn');
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
  const ok = writeSaved(arr);
  showToast(ok ? t('saved') : t('save_failed'), ok ? 'info' : 'warn');
}

/* ---------------------------------------------------- i18n application */
function applyI18n() {
  document.documentElement.lang = getLang();
  // vars must be passed: first_hint interpolates {max}, and without this it
  // would render the literal placeholder.
  const vars = { max: MAX, n: selected.length };
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n'), vars); });
  document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.getAttribute('data-i18n-attr').split(';').forEach((pair) => {
      const [attr, key] = pair.split(':');
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
  els.langBtns.forEach((b) => {
    const on = b.dataset.lang === getLang();
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');   // otherwise the choice is invisible to a screen reader
  });
  els.provincesValue.textContent = provinceSummaryText();
  // Rows are built imperatively, so their aria-labels kept the old language
  // until the next selection change.
  renderList();
  updateCounterLabel();
  refreshLabels();
}

// The chip's own text ("3 / 10") is overridden for assistive tech by its
// aria-label, so the label has to carry the value — this is what Appendix A's
// `counter` string was for.
function updateCounterLabel() {
  els.counter.setAttribute('aria-label', t('counter', { n: selected.length, max: MAX }));
  els.counter.setAttribute('title', t('max_label'));
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
  // A system gesture can interrupt a drag; without this, `dragging` and the
  // .dragging class stay stuck (killing the transition and leaving the sheet
  // unselectable) until the next touch on the handle.
  const cancel = () => {
    if (!dragging) return;
    dragging = false; panel.classList.remove('dragging');
    snap(startPct < PEEK / 2 ? OPEN : PEEK);
  };

  // iOS fires a compatibility mousedown/mouseup after a tap that nothing called
  // preventDefault on — and a tap never does, since touchstart is passive and
  // touchmove only prevents past 4px. The handle is a div[role=button], so the
  // closest('button') guard in down() doesn't stop it either: the synthesized
  // pair re-ran the whole tap and toggled the sheet straight back, which made
  // handle taps look dead. Ignore mouse input that follows a recent touch.
  let lastTouch = -Infinity;
  const afterTouch = () => (now() - lastTouch) < 600;
  const mark = () => { lastTouch = now(); };

  for (const surface of [handle, header]) {
    surface.addEventListener('touchstart', (e) => { mark(); down(e); }, { passive: true });
    surface.addEventListener('touchmove', (e) => { mark(); move(e); }, { passive: false });
    surface.addEventListener('touchend', (e) => { mark(); up(e); });
    surface.addEventListener('touchcancel', () => { mark(); cancel(); });
    surface.addEventListener('mousedown', (e) => { if (!afterTouch()) down(e); });
  }
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  window.addEventListener('mousemove', (e) => { if (!afterTouch()) move(e); });
  window.addEventListener('mouseup', (e) => { if (!afterTouch()) up(e); });
}
function resetSheet() { els.panel.style.removeProperty('--sheet-y'); els.panel.classList.remove('expanded'); }

/* ------------------------------------------------------ online/offline */
function updateOnline() { els.offlineChip.hidden = navigator.onLine; }

/* ------------------------------------------- adjustable postcode limit */
// No fixed ceiling was requested, so the only bound is reality: you cannot
// select more postcodes than exist. Before the data loads, fall back to a
// sane number and re-clamp once the layers are built.
const hardCeiling = () => layersByPostcode.size || 1000;
const clampMax = (n) => Math.max(1, Math.min(hardCeiling(), Math.round(Number(n)) || 1));

function loadMax() {
  try {
    const v = parseInt(localStorage.getItem(STORE_MAX), 10);
    if (Number.isFinite(v) && v >= 1) MAX = v;
  } catch (_) {}
}
function setMax(n) {
  MAX = clampMax(n);
  try { localStorage.setItem(STORE_MAX, String(MAX)); } catch (_) {}
  syncUI();
}

// Lowering the limit below the current selection trims the most recently added
// (selected is in tap order) after confirming, with Undo — same contract as
// Reset and Delete.
function applyMax(n) {
  const next = clampMax(n);
  if (next === MAX) return;
  if (next < selected.length) {
    const prevMax = MAX, prevSel = [...selected];
    confirmDialog(t('max_confirm', { max: next }), t('apply'), () => {
      const keep = selected.slice(0, next);
      setMax(next);
      applySelection(keep);
      showToast(t('max_updated', { max: next }), 'info', {
        label: t('undo'),
        onClick: () => { setMax(prevMax); applySelection(prevSel); }
      });
    }, true, openMaxPicker);
    return;
  }
  setMax(next);
  showToast(t('max_updated', { max: next }), 'info');
}

function openMaxPicker() {
  const { modal, body, actions } = modalShell(t('max_label'));
  const PRESETS = [5, 10, 15, 20, 30, 50];
  let value = MAX;

  const row = document.createElement('div'); row.className = 'max-row';
  const dec = document.createElement('button'); dec.type = 'button'; dec.className = 'max-step'; dec.textContent = '−';
  dec.setAttribute('aria-label', '-1');
  const inp = document.createElement('input');
  inp.type = 'number'; inp.min = '1'; inp.inputMode = 'numeric'; inp.value = String(value);
  inp.setAttribute('aria-label', t('max_label'));
  const inc = document.createElement('button'); inc.type = 'button'; inc.className = 'max-step'; inc.textContent = '+';
  inc.setAttribute('aria-label', '+1');
  row.append(dec, inp, inc);

  const presets = document.createElement('div'); presets.className = 'max-presets';
  const chips = PRESETS.map((n) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'max-preset'; b.textContent = String(n);
    b.addEventListener('click', () => set(n));
    return b;
  });
  presets.append(...chips);

  const note = document.createElement('p'); note.className = 'max-note';

  function set(n) {
    value = clampMax(n);
    if (inp.value !== String(value)) inp.value = String(value);
    chips.forEach((c, i) => c.classList.toggle('active', PRESETS[i] === value));
    note.textContent = value < selected.length ? t('max_confirm', { max: value }) : '';
  }
  dec.addEventListener('click', () => set(value - 1));
  inc.addEventListener('click', () => set(value + 1));
  // Track the typed value without rewriting the field mid-entry: clamping on
  // every keystroke turned a cleared field + "0" into "1", so the next digit
  // produced 15 instead of 5. The clamp happens on blur and on Apply.
  inp.addEventListener('input', () => {
    const v = parseInt(inp.value, 10);
    if (Number.isFinite(v)) { value = v; note.textContent = v < selected.length ? t('max_confirm', { max: clampMax(v) }) : ''; }
  });
  inp.addEventListener('blur', () => set(value));
  set(value);

  body.append(row, presets, note);
  actions.append(
    mkBtn(t('cancel'), '', closeModal),
    mkBtn(t('apply'), 'btn-primary', () => { closeModal(); applyMax(value); })
  );
  openModal(modal);
}

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
// Shipped as TopoJSON: adjacent postcode areas share their borders instead of
// each storing a duplicate copy, which cuts the download from ~380 KB to ~164 KB
// gzipped. Decoded to GeoJSON here, so everything downstream is unchanged.
async function loadData() {
  const res = await fetch('data/be_postcodes.topojson');
  if (!res.ok) throw new Error('topojson ' + res.status);
  const topo = await res.json();
  const obj = topo.objects && topo.objects.be_postcodes;
  if (!obj || typeof topojson === 'undefined') throw new Error('topojson decode unavailable');
  return topojson.feature(topo, obj);
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

  els.counter.addEventListener('click', openMaxPicker);

  els.search.addEventListener('input', onSearchInput);
  els.search.addEventListener('focus', onSearchInput);
  els.searchClear.addEventListener('click', () => {
    els.search.value = ''; hideResults(); els.searchClear.hidden = true; els.search.focus();
  });

  // Keyboard path into the results: ↓ from the field, ↑/↓ between rows, Enter on
  // the field activates the first hit.
  const resultButtons = () => [...els.searchResults.querySelectorAll('.result-go, .result-add')];
  els.search.addEventListener('keydown', (e) => {
    if (els.searchResults.hidden) return;
    if (e.key === 'ArrowDown') {
      const first = els.searchResults.querySelector('.result-go');
      if (first) { e.preventDefault(); first.focus(); }
    } else if (e.key === 'Enter') {
      const first = els.searchResults.querySelector('.result-go');
      if (first) { e.preventDefault(); first.click(); }
    }
  });
  els.searchResults.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const btns = resultButtons();
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
    if (next < 0) els.search.focus();
    else if (btns[next]) btns[next].focus();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) hideResults();
  });

  const hintClose = $('#first-hint-close');
  if (hintClose) hintClose.addEventListener('click', dismissHint);

  els.name.addEventListener('input', autosaveLast);
  els.date.addEventListener('input', autosaveLast);

  els.modalRoot.addEventListener('click', (e) => { if (e.target === els.modalRoot) dismissModal(); });
  // Keep Tab inside the dialog — it used to walk into the buttons behind the
  // overlay and activate them.
  els.modalRoot.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || els.modalRoot.hidden) return;
    const f = focusablesIn(els.modalRoot);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!els.modalRoot.hidden) { dismissModal(); return; }
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
  loadMax();
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
    MAX = clampMax(MAX);          // ceiling is now known
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
