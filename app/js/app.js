/* ── PTI Builder — map-centric app ──────────────────────────
 * Everything country-specific comes from data/<dataset>/config.json, written
 * by prep/build_dataset.py. The method itself lives in pti-core.js.
 */
'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = v => typeof v === 'number' && Number.isFinite(v);

const S = {
  index: null, dsPath: '', cfg: null, units: [], ind: new Map(), levels: [], base: null,
  levelByKey: {}, geo: {}, overlayGeo: {}, overlayOn: new Set(),
  level: null, method: 'quantile', nClasses: 5, weightField: null,
  run: null, rows: [], robust: null, mapVar: 'pti', compare: null, savedRuns: [],
  mapRendered: false, aoiMode: false, drawerOpen: false, sortCol: 'score', sortAsc: false,
  portfolio: null,
};

const SCORE_SCALE = [[0, '#1a9641'], [.25, '#a6d96a'], [.5, '#ffffbf'], [.75, '#fdae61'], [1, '#d7191c']];
const ROBUST_SCALE = [[0, '#f1f5f9'], [.5, '#93c5fd'], [.8, '#2563eb'], [1, '#1e3a8a']];
const BADGE_CSS = ['need-very-low', 'need-low', 'need-moderate', 'need-high', 'need-very-high'];
const DEFAULT_BASEMAP = {
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
  labels: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}'],
  attribution: 'Esri, HERE, Garmin, © OpenStreetMap contributors',
};

document.addEventListener('DOMContentLoaded', init);

/* ── Loading ─────────────────────────────────────────────── */
async function init() {
  wireStatic();
  try {
    S.index = await fetchJSON('data/index.json');
    const ds = S.index.datasets || [];
    if (!ds.length) throw new Error('data/index.json lists no datasets');
    const want = new URLSearchParams(location.search).get('data');
    const pick = ds.find(d => d.id === want) || ds[0];
    if (ds.length > 1) {
      const sel = $('dataset-select');
      sel.innerHTML = ds.map(d => `<option value="${esc(d.id)}"${d.id === pick.id ? ' selected' : ''}>${esc(d.label || d.id)}</option>`).join('');
      sel.style.display = '';
      sel.addEventListener('change', () => { location.search = `?data=${encodeURIComponent(sel.value)}`; });
    }
    S.dsPath = `data/${pick.path || pick.id}`;
    S.cfg = await fetchJSON(`${S.dsPath}/config.json`);
    S.units = await fetchJSON(`${S.dsPath}/units.json`);
    setupDataset();
  } catch (err) {
    console.error(err);
    $('data-status').className = 'status-chip error';
    $('data-status').textContent = 'Data missing';
    $('indicator-panels').innerHTML = `<div class="ind-loading err">Could not load the dataset.<br><code>${esc(err.message)}</code><br>
      Build one with <code>python prep/build_dataset.py &lt;pti.yaml&gt;</code>, and serve the <code>app/</code> folder over HTTP.</div>`;
  }
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

function setupDataset() {
  const c = S.cfg;
  document.title = `${c.country ? c.country + ' — ' : ''}${c.title || 'Project Targeting Index'}`;
  $('app-title').textContent = c.title || 'Project Targeting Index';
  $('app-subtitle').textContent = [c.country, c.subtitle].filter(Boolean).join(' · ');

  S.levels = c.levels.map((l, i) => ({ ...l, rank: i }));
  S.base = S.levels[S.levels.length - 1];
  S.levelByKey = Object.fromEntries(S.levels.map(l => [l.key, l]));
  S.level = S.levelByKey[c.default_level] ? c.default_level : S.levels[Math.max(0, S.levels.length - 2)].key;
  S.method = ['quantile', 'equal', 'natural'].includes(c.classification) ? c.classification : 'quantile';
  S.nClasses = Math.max(3, Math.min(9, c.classes || 5));
  S.weightField = c.population_field || null;
  c.indicators.forEach(m => S.ind.set(m.id, m));
  try { S.savedRuns = JSON.parse(localStorage.getItem(runsKey()) || '[]'); } catch (_) { S.savedRuns = []; }

  // Level toggle, coarse → fine as configured
  $('admin-toggle').innerHTML = S.levels.map(l =>
    `<button class="tg${l.key === S.level ? ' active' : ''}" data-level="${esc(l.key)}">${esc(l.label)}</button>`).join('');
  $('admin-toggle').querySelectorAll('.tg').forEach(b => b.addEventListener('click', () => {
    setActive('#admin-toggle', b); S.level = b.dataset.level; S.robust = null; resetMapVar();
    hideUnitPanel(); if (S.run) renderAll();
  }));
  setActive('#reclass-toggle', document.querySelector(`#reclass-toggle [data-reclass="${S.method}"]`));
  $('nclass-select').value = String(S.nClasses);
  if (![...$('nclass-select').options].some(o => o.value === String(S.nClasses))) {
    $('nclass-select').insertAdjacentHTML('beforeend', `<option value="${S.nClasses}">${S.nClasses}</option>`);
    $('nclass-select').value = String(S.nClasses);
  }
  if (!S.weightField) {
    setActive('#weight-toggle', document.querySelector('#weight-toggle [data-weight="equal"]'));
    const pb = document.querySelector('#weight-toggle [data-weight="pop"]');
    pb.disabled = true; pb.title = 'No population in this dataset — aggregation is unweighted';
  }

  const leg = c.legend || {};
  $('legend-low').textContent = leg.low || 'Lower priority';
  $('legend-high').textContent = leg.high || 'Higher priority';

  buildScenarioSelect();
  buildIndicatorPanels();
  buildLayersPanel();
  if (c.arcgis_publish) $('agol-publish-btn').style.display = '';
  if (c.data_refresh_note) {
    $('refresh-section').style.display = '';
    $('refresh-note').textContent = c.data_refresh_note.text || c.data_refresh_note;
    if (c.data_refresh_note.command) $('refresh-cmd').textContent = c.data_refresh_note.command;
    else $('refresh-cmd').style.display = 'none';
  }

  // The status chip is only needed when loading fails; on success the counts
  // move to the subtitle tooltip to keep the top bar free for the controls
  $('data-status').style.display = 'none';
  $('app-subtitle').title = `${S.units.length.toLocaleString()} ${plural(S.base.label, S.units.length)} · ${c.indicators.length} indicators · built ${c.built || '?'}`;
  $('calc-btn').disabled = false;
  const first = (c.scenarios || [])[0];
  if (first) { $('scenario-select').value = first.id; applyScenario(first.id); }
  updateSavedRunsUI();
  if (S.portfolioLayer()) $('portfolio-tab').style.display = '';

  // Boundaries load in the background; the base level can be large
  for (const l of S.levels) {
    fetchJSON(`${S.dsPath}/boundaries_${l.key}.geojson`).then(gj => {
      S.geo[l.key] = gj;
      if (!S.mapRendered && l.rank === 0) drawEmptyMap();
      if (S.run && l.key === S.level) renderMap();
    }).catch(() => console.warn(`no boundaries for ${l.key}`));
  }
}

S.portfolioLayer = () => (S.cfg?.overlays || []).find(o => o.role === 'portfolio');
const runsKey = () => `pti_runs_${S.cfg.id}`;
const plural = (w, n) => (n === 1 ? w.toLowerCase() : w.toLowerCase().replace(/y$/, 'ie') + 's');
const levelOf = id => S.levelByKey[S.ind.get(id)?.level] || S.base;
function setActive(sel, btn) {
  document.querySelectorAll(`${sel} .tg`).forEach(x => x.classList.remove('active'));
  btn?.classList.add('active');
}

/* ── Static wiring (independent of the dataset) ─────────── */
function wireStatic() {
  $('scenario-select').addEventListener('change', e => applyScenario(e.target.value));
  $('calc-btn').addEventListener('click', runPTI);
  $('results-toggle').addEventListener('click', toggleDrawer);
  $('equalize-btn').addEventListener('click', equalizeWeights);
  $('aoi-btn').addEventListener('click', toggleAOI);
  $('aoi-clear-btn').addEventListener('click', clearAOI);
  $('aoi-close').addEventListener('click', clearAOI);
  $('unit-close').addEventListener('click', hideUnitPanel);
  $('layers-btn').addEventListener('click', () => { const p = $('layers-panel'); p.style.display = p.style.display === 'none' ? '' : 'none'; });
  $('layers-close').addEventListener('click', () => { $('layers-panel').style.display = 'none'; });
  $('about-btn').addEventListener('click', showAbout);
  $('table-search').addEventListener('input', () => buildTable(filterRows()));
  $('compare-select').addEventListener('change', onCompareSelect);
  $('compare-clear').addEventListener('click', () => { $('compare-select').value = ''; onCompareSelect(); });
  $('save-run-btn').addEventListener('click', saveRun);
  $('rob-run').addEventListener('click', runRobustness);
  $('agol-publish-btn').addEventListener('click', showAgolModal);
  $('agol-go-btn').addEventListener('click', runAgolPublish);
  $('dl-csv').addEventListener('click', downloadLevelCSV);
  $('dl-csv-base').addEventListener('click', downloadBaseCSV);
  $('dl-geojson').addEventListener('click', downloadGeoJSON);
  $('dl-meta').addEventListener('click', downloadRunNotes);
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { $(b.dataset.close).style.display = 'none'; }));
  document.querySelectorAll('.modal-bg').forEach(bg => bg.addEventListener('click', e => { if (e.target === bg) bg.style.display = 'none'; }));
  document.querySelectorAll('#reclass-toggle .tg').forEach(b => b.addEventListener('click', () => {
    setActive('#reclass-toggle', b); S.method = b.dataset.reclass;
  }));
  $('nclass-select').addEventListener('change', e => { S.nClasses = +e.target.value; });
  document.querySelectorAll('#weight-toggle .tg').forEach(b => b.addEventListener('click', () => {
    if (b.disabled) return;
    setActive('#weight-toggle', b);
    S.weightField = b.dataset.weight === 'pop' ? S.cfg.population_field : null;
    S.robust = null; resetMapVar();
    if (S.run) renderAll();
  }));
  document.querySelectorAll('input[name=mapvar]').forEach(r => r.addEventListener('change', () => {
    S.mapVar = r.value; renderMap(); updateLegend();
  }));
  $('drawer-handle').addEventListener('click', toggleDrawer);
  $('drawer-close').addEventListener('click', e => { e.stopPropagation(); closeDrawer(); });
  document.querySelectorAll('.dtab').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('.dtab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.drawer-panel').forEach(p => p.classList.remove('active'));
    $(`drawer-${btn.dataset.panel}`)?.classList.add('active');
    if (btn.dataset.panel === 'portfolio') renderPortfolio();
    if (btn.dataset.panel === 'dist' && S.run) renderDistribution();
  }));
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    hideTooltip(); hideUnitPanel(); if (S.aoiMode) toggleAOI();
    document.querySelectorAll('.modal-bg').forEach(m => { m.style.display = 'none'; });
  });
}

/* ── Scenarios (thematic PTIs) ───────────────────────────── */
function buildScenarioSelect() {
  const sc = S.cfg.scenarios || [];
  $('scenario-select').innerHTML =
    sc.map(s => `<option value="${esc(s.id)}">${esc(s.label || s.id)}</option>`).join('') +
    `<option value="__equal">Equal weights (all indicators)</option><option value="__custom">Custom</option>`;
}

function applyScenario(key) {
  let weights;
  const hint = $('scenario-hint');
  if (key === '__custom') { hint.textContent = 'Set your own indicators and weights.'; return; }
  if (key === '__equal') {
    const ids = [...S.ind.keys()];
    weights = equalSplit(ids);
    hint.textContent = 'Every indicator at equal weight — a neutral baseline, not a recommendation.';
  } else {
    const sc = (S.cfg.scenarios || []).find(s => s.id === key);
    if (!sc) return;
    weights = sc.weights || {};
    hint.textContent = sc.description || '';
  }
  for (const id of S.ind.keys()) setRow(id, weights[id] || 0, id in weights);
  // Restore configured directions — a scenario defines the model, not just weights
  for (const [id, m] of S.ind) setDirection(id, m.direction);
  updateWeightSummary();
}

function equalSplit(ids) {
  const n = ids.length, base = Math.floor(100 / n), extra = 100 - base * n;
  return Object.fromEntries(ids.map((id, i) => [id, base + (i < extra ? 1 : 0)]));
}

/* ── Indicator sidebar ───────────────────────────────────── */
function buildIndicatorPanels() {
  const cats = S.cfg.categories || [];
  const order = cats.map(c => c.name);
  const color = Object.fromEntries(cats.map(c => [c.name, c.color]));
  const grouped = {};
  for (const m of S.ind.values()) (grouped[m.category || 'Other'] ||= []).push(m);
  const names = [...new Set([...order, ...Object.keys(grouped).sort()])].filter(n => grouped[n]);
  let html = '';
  for (const cat of names) {
    const collapsed = grouped[cat].length > 15;
    html += `<div class="cat-section" data-cat="${esc(cat)}">
      <button class="cat-toggle" aria-expanded="${!collapsed}">
        <span class="cat-dot" style="background:${esc(color[cat] || '#7f8c8d')}"></span>
        <span class="cat-name">${esc(cat)}</span>
        <span class="cat-sel-count"></span>
        <span class="cat-arrow">▼</span>
      </button>
      <div class="cat-rows${collapsed ? '' : ' open'}">${grouped[cat].map(indRow).join('')}</div></div>`;
  }
  $('indicator-panels').innerHTML = html;
  wireRows();
}

function indRow(m) {
  const lv = levelOf(m.id);
  const badge = lv.rank < S.base.rank
    ? `<span class="ind-level" title="Measured at ${esc(lv.label)} level — the same value applies to every ${esc(S.base.label.toLowerCase())} in the ${esc(lv.label.toLowerCase())}">${esc(lv.label)}</span>` : '';
  const sc = m.scoring?.type;
  const sBadge = sc === 'categories' ? '<span class="ind-level ind-cat" title="Categorical: each value has a fixed score">cat</span>'
    : sc === 'breaks' ? '<span class="ind-level ind-cat" title="Classed on fixed thresholds set in the configuration">fixed</span>' : '';
  const sub = [m.unit, m.year].filter(Boolean).join(' · ');
  const tip = [m.label, m.description, m.source_note, m.unit && `Unit: ${m.unit}`, m.fill != null && `Missing values filled with: ${m.fill}`]
    .filter(Boolean).join('\n');
  const cat = sc === 'categories';
  return `<div class="ind-row dimmed" id="row-${esc(m.id)}">
    <div class="ind-check"><input type="checkbox" id="chk-${esc(m.id)}" data-id="${esc(m.id)}"/></div>
    <label class="ind-name-wrap" for="chk-${esc(m.id)}" title="${esc(tip)}">
      <div class="ind-name">${esc(m.label || m.id)}${badge}${sBadge}</div>
      ${sub ? `<div class="ind-source">${esc(sub)}</div>` : ''}
    </label>
    <div class="ind-weight">
      <input type="number" class="weight-num" id="wnum-${esc(m.id)}" data-id="${esc(m.id)}" min="0" max="100" value="0"/>
      <input type="range" class="weight-slider" id="wsl-${esc(m.id)}" data-id="${esc(m.id)}" min="0" max="100" value="0"/>
    </div>
    <button class="dir-btn" id="dir-${esc(m.id)}" data-id="${esc(m.id)}" ${cat ? 'disabled title="Categorical scores set the direction"' : ''}></button>
  </div>`;
}

function setDirection(id, dir) {
  const b = $(`dir-${id}`);
  if (!b) return;
  const d = dir === 'descending' || dir === 'desc' ? 'descending' : 'ascending';
  b.dataset.dir = d;
  b.textContent = d === 'ascending' ? '↑' : '↓';
  if (!b.disabled) b.title = d === 'ascending' ? 'Higher value → higher PTI score' : 'Higher value → lower PTI score';
}

function setRow(id, w, on) {
  const cb = $(`chk-${id}`);
  if (!cb) return;
  cb.checked = on;
  $(`wnum-${id}`).value = w; $(`wsl-${id}`).value = w;
  $(`row-${id}`).classList.toggle('dimmed', !on);
}

function wireRows() {
  document.querySelectorAll('.cat-toggle').forEach(btn => btn.addEventListener('click', () => {
    const exp = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!exp));
    btn.nextElementSibling.classList.toggle('open', !exp);
  }));
  document.querySelectorAll('#indicator-panels input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
    $(`row-${cb.dataset.id}`).classList.toggle('dimmed', !cb.checked); markCustom(); updateWeightSummary();
  }));
  document.querySelectorAll('.weight-slider').forEach(sl => sl.addEventListener('input', () => {
    $(`wnum-${sl.dataset.id}`).value = sl.value; autoCheck(sl.dataset.id, +sl.value); markCustom(); updateWeightSummary();
  }));
  document.querySelectorAll('.weight-num').forEach(n => n.addEventListener('change', () => {
    $(`wsl-${n.dataset.id}`).value = n.value; autoCheck(n.dataset.id, +n.value); markCustom(); updateWeightSummary();
  }));
  document.querySelectorAll('.dir-btn').forEach(btn => btn.addEventListener('click', () => {
    if (btn.disabled) return;
    setDirection(btn.dataset.id, btn.dataset.dir === 'ascending' ? 'descending' : 'ascending'); markCustom();
  }));
  for (const [id, m] of S.ind) setDirection(id, m.direction);
}

function autoCheck(id, w) { if (w > 0 && !$(`chk-${id}`).checked) { $(`chk-${id}`).checked = true; $(`row-${id}`).classList.remove('dimmed'); } }
function markCustom() { if ($('scenario-select').value !== '__custom') { $('scenario-select').value = '__custom'; $('scenario-hint').textContent = 'Custom configuration.'; } }

function selectedConfig() {
  const out = [];
  document.querySelectorAll('#indicator-panels input[type=checkbox]').forEach(cb => {
    if (!cb.checked) return;
    const id = cb.dataset.id, w = +($(`wnum-${id}`).value || 0);
    if (w > 0) out.push({ id, weight: w, direction: $(`dir-${id}`).dataset.dir });
  });
  return out;
}

function updateWeightSummary() {
  let total = 0, n = 0;
  document.querySelectorAll('#indicator-panels input[type=checkbox]').forEach(cb => {
    if (!cb.checked) return; n++; total += +($(`wnum-${cb.dataset.id}`).value || 0);
  });
  const ok = Math.abs(total - 100) < 1e-9;
  $('weight-total').textContent = total;
  $('weight-total').style.color = ok ? '#27ae60' : total > 100 ? '#e74c3c' : '';
  $('sel-count').textContent = `${n} selected`;
  $('wbar-fill').style.width = Math.min(100, total) + '%';
  $('wbar-fill').style.background = ok ? '#27ae60' : total > 100 ? '#e74c3c' : '';
  document.querySelectorAll('.cat-section').forEach(sec => {
    const c = sec.querySelectorAll('input[type=checkbox]:checked').length;
    sec.querySelector('.cat-sel-count').textContent = c ? `${c} ✓` : '';
  });
}

function equalizeWeights() {
  const ids = selectedIds();
  if (!ids.length) return;
  const w = equalSplit(ids);
  ids.forEach(id => setRow(id, w[id], true));
  markCustom(); updateWeightSummary();
}
const selectedIds = () => [...document.querySelectorAll('#indicator-panels input[type=checkbox]:checked')].map(c => c.dataset.id);

/* ── Run ─────────────────────────────────────────────────── */
function runPTI() {
  const sel = selectedConfig();
  if (!sel.length) return alert('Select at least one indicator with a weight above 0.');
  const total = sel.reduce((s, c) => s + c.weight, 0);
  if (Math.abs(total - 100) > 1e-9) return alert(`Weights must sum to 100 (currently ${total}).\nAdjust them, use "= Equal", or pick a thematic PTI.`);

  const btn = $('calc-btn');
  btn.disabled = true; btn.textContent = 'Calculating…';
  setTimeout(() => {
    try {
      const opts = { method: S.method, nClasses: S.nClasses };
      const parts = sel.map(c => {
        const m = S.ind.get(c.id);
        const r = PTICore.scoreIndicator(S.units, { ...m, direction: c.direction, codeField: levelOf(c.id).code }, opts);
        return { ...c, ...r, meta: m };
      });
      const degenerate = parts.filter(p => p.degenerate).map(p => p.meta.label);
      const minCov = S.cfg.min_coverage ?? 1;
      const comp = PTICore.composite(parts, S.nClasses, minCov);
      S.run = { parts, comp, method: S.method, nClasses: S.nClasses, minCoverage: minCov,
        scenario: $('scenario-select').value, scenarioLabel: $('scenario-select').selectedOptions[0]?.text,
        date: new Date() };
      S.robust = null; resetMapVar();
      renderAll();
      if (degenerate.length) alert(`These indicators have no variation under this classification and score nothing:\n• ${degenerate.join('\n• ')}`);
      $('results-toggle').style.display = ''; $('save-run-btn').style.display = '';
      $('last-run-label').textContent = `Run at ${S.run.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      $('last-run-label').style.display = 'inline';
      openDrawer();
      btn.innerHTML = '✓ Done'; btn.style.background = '#27ae60';
    } catch (err) {
      console.error(err); alert('PTI error: ' + err.message); S.run = null;
    }
    setTimeout(() => { btn.disabled = false; btn.style.background = ''; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polygon points="3,1 13,7 3,13" fill="currentColor"/></svg> Run PTI'; }, 1200);
  }, 20);
}

/* ── Level rows ──────────────────────────────────────────── */
/* Rows at the level shown. Base level: one per unit with its parents.
 * Coarser: base-unit scores aggregated (population-weighted if chosen). */
function levelRows(values) {
  const L = S.levelByKey[S.level];
  const labels = S.cfg.priority_labels || ['Very low', 'Low', 'Moderate', 'High', 'Very high'];
  let rows;
  if (L === S.base) {
    rows = S.units.map((u, i) => ({
      code: u[L.code], name: u[L.name], i, score: values[i], coverage: S.run.comp.coverage[i],
      parents: S.levels.slice(0, -1).map(p => u[p.name]), weight: S.weightField ? u[S.weightField] : null, count: 1,
    })).filter(r => r.score != null);
  } else {
    rows = PTICore.aggregate(S.units, values, L.code, L.name, S.weightField)
      .map(r => ({ ...r, score: r.mean }));
    if (L.rank > 0) {
      const parentOf = {};
      S.units.forEach(u => { parentOf[u[L.code]] ||= S.levels.slice(0, L.rank).map(p => u[p.name]); });
      rows.forEach(r => { r.parents = parentOf[r.code]; });
    }
  }
  const cls = PTICore.priorityClasses(rows.map(r => r.score), labels.length);
  rows.forEach((r, k) => { r.cls = cls[k]; r.priority = cls[k] ? labels[cls[k] - 1] : ''; });
  rows.sort((a, b) => b.score - a.score);
  rows.forEach((r, k) => { r.rank = k + 1; });
  return rows;
}

function renderAll() {
  if (!S.run) return;
  S.rows = levelRows(S.run.comp.index);
  if (S.robust) S.rows.forEach(r => { r.robust = S.robust.byCode.get(r.code); });
  const pf = S.portfolio;
  if (pf) attachPortfolio();
  updateLevelNote(); updateCoverageChip();
  renderMap(); buildTable(filterRows()); updateLegend();
  if ($('drawer-dist').classList.contains('active')) renderDistribution();
  if ($('drawer-portfolio').classList.contains('active')) renderPortfolio();
  $('map-empty').classList.add('hidden');
}

/* At a level finer than the coarsest selected indicator, part of the score
 * is a constant broadcast from the parent — say so. */
function updateLevelNote() {
  const el = $('level-note');
  if (!S.run) { el.textContent = ''; return; }
  const coarse = S.run.parts.reduce((a, p) => Math.min(a, levelOf(p.id).rank), S.base.rank);
  const shown = S.levelByKey[S.level].rank;
  if (shown <= coarse) { el.textContent = ''; el.className = 'level-note'; return; }
  const lv = S.levels[coarse], n = S.run.parts.filter(p => levelOf(p.id).rank === coarse).length;
  el.className = 'level-note warn';
  el.textContent = `${n} indicator${n > 1 ? 's' : ''} measured at ${lv.label} level — below that the score varies only with the finer indicators.`;
}

function updateCoverageChip() {
  const c = S.run.comp, n = S.units.length;
  const unscored = c.index.filter(v => v == null).length;
  const partial = c.coverage.filter((v, i) => c.index[i] != null && v < 0.999).length;
  const chip = $('coverage-chip');
  if (!unscored && !partial) { chip.style.display = 'none'; return; }
  const gaps = S.run.parts.filter(p => p.missing).map(p => `${p.meta.label}: ${p.missing.toLocaleString()} missing`);
  const filled = S.run.parts.filter(p => p.filled).map(p => `${p.meta.label}: ${p.filled.toLocaleString()} filled (${p.meta.fill})`);
  chip.style.display = '';
  chip.textContent = unscored ? `${unscored.toLocaleString()} of ${n.toLocaleString()} unscored` : `${partial.toLocaleString()} partly scored`;
  chip.title = [`Units need ≥${Math.round((S.run.minCoverage) * 100)}% of the selected weight present to be scored;`,
    'partly scored units are renormalised over the indicators they have.', '', ...gaps, ...filled].join('\n');
}

/* ── Map ─────────────────────────────────────────────────── */
function mapView() {
  const m = S.cfg.map;
  if (m?.center && m.zoom != null) return { center: { lat: m.center[0], lon: m.center[1] }, zoom: m.zoom };
  const gj = S.geo[S.levels[0].key] || S.geo[S.level];
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  const walk = c => { if (typeof c[0] === 'number') { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); } else c.forEach(walk); };
  (gj?.features || []).forEach(f => f.geometry && walk(f.geometry.coordinates));
  if (x0 > x1) return { center: { lat: 0, lon: 0 }, zoom: 1 };
  const W = $('map-area').clientWidth || 800, H = $('map-area').clientHeight || 600;
  // Fit into the part of the map left visible above the results drawer
  const drawer = H > 560 ? 300 : 0, Hv = H - drawer;
  // Web Mercator: the world is 512·2^z px wide; latitude spans in projected units
  const merc = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const zx = Math.log2(360 * W / 512 / Math.max(x1 - x0, 1e-6));
  const zy = Math.log2(2 * Math.PI * Hv / 512 / Math.max(merc(y1) - merc(y0), 1e-6));
  const zoom = Math.min(zx, zy) - 0.2;
  const ym = (merc(y0) + merc(y1)) / 2 - (drawer / 2) * 2 * Math.PI / (512 * 2 ** zoom);
  return { center: { lat: Math.atan(Math.sinh(ym)) * 180 / Math.PI, lon: (x0 + x1) / 2 }, zoom };
}

function baseLayers() {
  const bm = S.cfg.basemap || DEFAULT_BASEMAP;
  const out = [{ sourcetype: 'raster', below: 'traces', source: bm.tiles, sourceattribution: bm.attribution || '' }];
  return { under: out, labels: bm.labels ? [{ sourcetype: 'raster', source: bm.labels }] : [] };
}

function overlayLayersAndTraces() {
  const layers = [], traces = [];
  for (const ov of S.cfg.overlays || []) {
    if (!S.overlayOn.has(ov.id) || !S.overlayGeo[ov.id]) continue;
    const gj = S.overlayGeo[ov.id], color = ov.color || '#334155';
    if (ov.geometry === 'point') {
      const f = gj.features.filter(x => x.geometry?.type === 'Point');
      traces.push({
        type: 'scattermap', mode: 'markers', name: ov.label, meta: ov.id,
        lat: f.map(x => x.geometry.coordinates[1]), lon: f.map(x => x.geometry.coordinates[0]),
        marker: { size: ov.role === 'portfolio' ? 9 : 6, color, opacity: 0.9 },
        text: f.map(x => featureLabel(ov, x.properties)), hoverinfo: 'text', showlegend: false,
      });
    } else {
      layers.push({ sourcetype: 'geojson', source: gj, type: 'line', color, line: { width: ov.geometry === 'line' ? 2 : 1.2 } });
    }
  }
  return { layers, traces };
}

function featureLabel(ov, p) {
  const head = ov.label_field ? p[ov.label_field] : ov.label;
  const rest = (ov.fields || []).filter(f => f !== ov.label_field && f !== '_unit' && p[f] != null).map(f => `${f}: ${p[f]}`);
  return [`<b>${esc(head ?? '')}</b>`, ...rest.map(esc)].join('<br>');
}

function drawEmptyMap() {
  const { under, labels } = baseLayers();
  const v = mapView();
  Plotly.newPlot('map-plotly', [{ type: 'scattermap', lat: [], lon: [], showlegend: false }],
    { map: { style: 'white-bg', layers: [...under, ...labels], ...v }, margin: { t: 0, b: 0, l: 0, r: 0 }, uirevision: S.cfg.id, showlegend: false },
    { responsive: true, displayModeBar: false });
}

function renderMap() {
  if (!S.run) return;
  const L = S.levelByKey[S.level];
  const gj = S.geo[L.key];
  if (!gj) {
    $('map-empty').classList.remove('hidden');
    $('map-empty').querySelector('.empty-sub').textContent = `${L.label} boundaries loading… results are in the drawer below.`;
    return;
  }
  const robust = S.mapVar === 'robust' && S.robust;
  const look = new Map(S.rows.map(r => [String(r.code), r]));
  const ids = [], z = [], text = [];
  for (const f of gj.features) {
    const id = String(f.properties[L.code]);
    const r = look.get(id);
    ids.push(id);
    const val = r ? (robust ? (r.robust != null ? r.robust * 100 : null) : r.score) : null;
    z.push(val);
    const nm = f.properties[L.name] ?? id;
    text.push(r ? `<b>${esc(nm)}</b><br>PTI ${r.score.toFixed(1)} · ${esc(r.priority)}${r.robust != null ? `<br>Top group in ${Math.round(r.robust * 100)}% of draws` : ''}` : `<b>${esc(nm)}</b><br>not scored`);
  }
  const trace = {
    type: 'choroplethmap', geojson: gj, locations: ids, z, text, hoverinfo: 'text',
    featureidkey: `properties.${L.code}`,
    colorscale: robust ? ROBUST_SCALE : SCORE_SCALE, zmin: 0, zmax: 100,
    marker: { opacity: 0.82, line: { width: L === S.base ? 0.2 : 0.6, color: '#fff' } }, showscale: false,
  };
  const { under, labels } = baseLayers();
  const ov = overlayLayersAndTraces();
  const layout = {
    map: { style: 'white-bg', layers: [...under, ...ov.layers, ...labels], ...(S.mapRendered ? {} : mapView()) },
    margin: { t: 0, b: 0, l: 0, r: 0 }, uirevision: S.cfg.id, showlegend: false,
    dragmode: S.aoiMode ? 'lasso' : 'pan',
  };
  if (S.mapRendered) delete layout.map.center;
  const cfg = { responsive: true, displayModeBar: false };
  const div = $('map-plotly');
  if (!S.mapRendered) {
    Plotly.newPlot(div, [trace, ...ov.traces], { ...layout, map: { ...layout.map, ...mapView() } }, cfg);
    S.mapRendered = true;
    div.on('plotly_click', onMapClick);
    div.on('plotly_selected', onAOISelected);
    div.on('plotly_deselect', clearAOI);
  } else {
    Plotly.react(div, [trace, ...ov.traces], { ...layout, map: { ...layout.map, center: div._fullLayout?.map?.center, zoom: div._fullLayout?.map?.zoom } }, cfg);
  }
  S.mapIds = ids;
  $('map-legend').classList.add('visible');
  $('map-empty').classList.add('hidden');
}

function onMapClick(ev) {
  if (S.aoiMode) return;
  const pt = ev.points[0];
  if (!pt) return;
  if (pt.curveNumber !== 0) { // overlay feature
    const rect = $('map-area').getBoundingClientRect();
    showTooltip((pt.bbox?.x1 ?? 200) - rect.left, (pt.bbox?.y1 ?? 200) - rect.top, pt.text);
    return;
  }
  hideTooltip();
  showUnitPanel(S.mapIds[pt.pointIndex]);
}

function showTooltip(x, y, html) {
  const tt = $('map-tooltip');
  tt.innerHTML = `${html}<div class="tt-row" style="margin-top:6px;font-size:10px;opacity:.5">Esc to close</div>`;
  tt.style.display = 'block';
  tt.style.left = Math.min(x + 14, $('map-area').offsetWidth - 240) + 'px';
  tt.style.top = Math.min(y + 10, $('map-area').offsetHeight - 140) + 'px';
}
function hideTooltip() { $('map-tooltip').style.display = 'none'; }

function updateLegend() {
  if (!S.run) return;
  const robust = S.mapVar === 'robust' && S.robust;
  const leg = S.cfg.legend || {};
  $('legend-title').textContent = robust ? `Robustness — in top ${Math.round(S.robust.topShare * 100)}%` : 'PTI score';
  $('legend-gradient').style.background = `linear-gradient(to right, ${(robust ? ROBUST_SCALE : SCORE_SCALE).map(s => s[1]).join(',')})`;
  $('legend-ticks').innerHTML = robust ? '<span>0%</span><span>50%</span><span>100%</span>' : '<span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>';
  $('legend-low').textContent = robust ? 'Rarely' : (leg.low || 'Lower priority');
  $('legend-high').textContent = robust ? 'Always' : (leg.high || 'Higher priority');
  const v = S.rows.map(r => r.score);
  if (!v.length) { $('legend-stats').innerHTML = ''; return; }
  const L = S.levelByKey[S.level];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  $('legend-stats').innerHTML = `
    <span><span>Mean</span><b>${mean.toFixed(1)}</b></span>
    <span><span>Min – Max</span><b>${Math.min(...v).toFixed(1)} – ${Math.max(...v).toFixed(1)}</b></span>
    <span><span>${esc(L.label)}s scored</span><b>${v.length.toLocaleString()}</b></span>
    <span><span>Classes</span><b>${S.run.nClasses} · ${S.run.method}</b></span>`;
}

/* ── Unit profile ("layer query") ────────────────────────── */
function membersOf(code) {
  const L = S.levelByKey[S.level];
  if (L === S.base) return S.units.map((u, i) => (String(u[L.code]) === String(code) ? i : -1)).filter(i => i >= 0);
  const out = [];
  S.units.forEach((u, i) => { if (String(u[L.code]) === String(code)) out.push(i); });
  return out;
}

function showUnitPanel(code) {
  const r = S.rows.find(x => String(x.code) === String(code));
  const L = S.levelByKey[S.level];
  $('unit-title').textContent = `${L.label}`;
  if (!r) {
    $('unit-body').innerHTML = `<div class="unit-head"><b>${esc(code)}</b></div><div class="muted small">Not scored — too little of the selected weight has data here.</div>`;
    $('unit-panel').style.display = '';
    return;
  }
  const idx = membersOf(code).filter(i => S.run.comp.index[i] != null);
  const wt = i => (S.weightField && isNum(S.units[i][S.weightField]) && S.units[i][S.weightField] > 0 ? S.units[i][S.weightField] : (S.weightField ? 0 : 1));
  const avg = get => {
    let s = 0, w = 0;
    for (const i of idx) { const v = get(i); if (v == null) continue; const k = wt(i) || (S.weightField ? 0 : 1); s += v * k; w += k; }
    if (!w) { const vs = idx.map(get).filter(v => v != null); return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null; }
    return s / w;
  };
  const total = S.run.parts.reduce((s, p) => s + p.weight, 0);
  const n = S.run.nClasses;
  const lines = S.run.parts.map(p => {
    const score = avg(i => p.scores[i]);
    const raw = avg(i => (isNum(S.units[i][p.id]) ? S.units[i][p.id] : null));
    const pts = score == null ? null : (score - 1) / (n - 1) * 100 * p.weight / total;
    return { p, score, raw, pts };
  }).sort((a, b) => (b.pts ?? -1) - (a.pts ?? -1));
  const pfCount = r.projects != null ? `<span><span>Projects</span><b>${r.projects}</b></span>` : '';
  $('unit-body').innerHTML = `
    <div class="unit-head"><b>${esc(r.name ?? r.code)}</b>${r.parents ? `<div class="muted small">${esc(r.parents.filter(Boolean).join(' · '))}</div>` : ''}</div>
    <div class="unit-score"><span class="tt-score">${r.score.toFixed(1)}</span>
      <span class="need-badge ${badgeCss(r.cls)}">${esc(r.priority)}</span>
      <span class="muted small">rank ${r.rank} of ${S.rows.length.toLocaleString()}</span></div>
    <div class="unit-kv">
      ${L !== S.base ? `<span><span>${esc(S.base.label)}s</span><b>${r.count.toLocaleString()}</b></span>` : ''}
      ${r.weight ? `<span><span>Population</span><b>${Math.round(r.weight).toLocaleString()}</b></span>` : ''}
      ${r.coverage != null && r.coverage < 0.999 ? `<span><span>Data coverage</span><b>${Math.round(r.coverage * 100)}% of weight</b></span>` : ''}
      ${r.robust != null ? `<span><span>Top group in</span><b>${Math.round(r.robust * 100)}% of draws</b></span>` : ''}
      ${pfCount}
    </div>
    <div class="unit-sub">Contribution to the score${L !== S.base ? ` <span class="muted">(${S.weightField ? 'population-weighted ' : ''}average of ${S.base.label.toLowerCase()}s)</span>` : ''}</div>
    <table class="unit-table"><thead><tr><th>Indicator</th><th>Value</th><th>Class</th><th>Wt</th><th>Points</th></tr></thead><tbody>
    ${lines.map(({ p, score, raw, pts }) => `<tr>
      <td title="${esc(p.meta.source_note || '')}">${esc(p.meta.label)}<span class="dir-mini">${p.direction === 'ascending' ? '↑' : '↓'}</span></td>
      <td>${raw == null ? '<span class="muted">—</span>' : fmt(raw)}${p.meta.unit && raw != null ? ` <span class="muted">${esc(p.meta.unit)}</span>` : ''}</td>
      <td>${score == null ? '<span class="muted">n/a</span>' : `${fmt(score, 1)}/${n}`}</td>
      <td>${Math.round(p.weight / total * 100)}%</td>
      <td><div class="pts-bar"><div style="width:${pts == null ? 0 : Math.max(2, pts)}%;background:${scoreColor(score == null ? null : (score - 1) / (n - 1) * 100)}"></div></div>${pts == null ? '' : pts.toFixed(1)}</td></tr>`).join('')}
    </tbody></table>
    <div class="muted small unit-foot">Points sum to the PTI score (0–100). Class ${n} = highest priority on that indicator.</div>`;
  $('unit-panel').style.display = '';
}
function hideUnitPanel() { $('unit-panel').style.display = 'none'; }

const badgeCss = cls => {
  const k = (S.cfg.priority_labels || [1, 2, 3, 4, 5]).length;
  return cls ? BADGE_CSS[Math.round((cls - 1) * 4 / Math.max(1, k - 1))] : '';
};
function fmt(v, d) {
  if (!isNum(v)) return '—';
  if (d != null) return v.toFixed(d).replace(/\.0$/, '');
  const a = Math.abs(v);
  return a >= 1000 ? Math.round(v).toLocaleString() : a >= 100 ? v.toFixed(0) : a >= 1 ? (+v.toFixed(2)).toString() : (+v.toPrecision(3)).toString();
}
function scoreColor(score, alpha = 1) {
  if (score == null) return `rgba(200,200,200,${alpha})`;
  const t = Math.max(0, Math.min(1, score / 100));
  const stops = SCORE_SCALE.map(s => [s[0], parseInt(s[1].slice(1, 3), 16), parseInt(s[1].slice(3, 5), 16), parseInt(s[1].slice(5, 7), 16)]);
  let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
  const [t0, r0, g0, b0] = stops[k], [t1, r1, g1, b1] = stops[k + 1], f = (t - t0) / (t1 - t0 || 1);
  return `rgba(${Math.round(r0 + f * (r1 - r0))},${Math.round(g0 + f * (g1 - g0))},${Math.round(b0 + f * (b1 - b0))},${alpha})`;
}

/* ── Table ───────────────────────────────────────────────── */
function buildTable(rows) {
  const L = S.levelByKey[S.level], isBase = L === S.base;
  const parents = S.levels.slice(0, L.rank);
  const hasCov = isBase && rows.some(r => r.coverage < 0.999);
  const hasW = rows.some(r => r.weight != null && !isBase);
  const hasRob = rows.some(r => r.robust != null);
  const hasPf = rows.some(r => r.projects != null);
  const th = (k, t, tip = '') => `<th data-sort="${k}"${tip ? ` title="${esc(tip)}"` : ''}>${esc(t)}</th>`;
  let head = th('rank', 'Rank') + th('name', L.label) + parents.map((p, k) => th(`p${k}`, p.label)).join('') +
    th('score', 'PTI score') + th('cls', 'Priority', 'Relative group of this run — quantiles of the scores shown');
  if (!isBase) head += th('count', `${S.base.label}s`);
  if (hasW) head += th('weight', 'Population');
  if (hasCov) head += th('coverage', 'Coverage', 'Share of the selected weight with data');
  if (hasRob) head += th('robust', 'Robustness', 'Share of weight-perturbed runs in which the unit is in the top group');
  if (hasPf) head += th('projects', 'Projects');
  const body = rows.slice(0, 3000).map(r => {
    let t = `<tr data-code="${esc(r.code)}"><td class="muted"><b>${r.rank}</b></td><td>${esc(r.name ?? r.code)}</td>` +
      parents.map((_, k) => `<td class="muted">${esc(r.parents?.[k] ?? '')}</td>`).join('') +
      `<td><div class="score-cell"><div class="score-bar" style="width:${Math.round(r.score * 0.7)}px;background:${scoreColor(r.score)}"></div>
        <span class="score-val">${r.score.toFixed(1)}</span></div></td>
       <td><span class="need-badge ${badgeCss(r.cls)}">${esc(r.priority)}</span></td>`;
    if (!isBase) t += `<td class="muted">${r.count}</td>`;
    if (hasW) t += `<td class="muted">${r.weight != null ? Math.round(r.weight).toLocaleString() : '—'}</td>`;
    if (hasCov) t += `<td class="muted">${Math.round(r.coverage * 100)}%</td>`;
    if (hasRob) t += `<td class="muted">${r.robust != null ? Math.round(r.robust * 100) + '%' : '—'}</td>`;
    if (hasPf) t += `<td class="muted">${r.projects ?? ''}</td>`;
    return t + '</tr>';
  }).join('');
  const more = rows.length > 3000 ? `<div class="muted small table-more">Showing 3,000 of ${rows.length.toLocaleString()} — filter, or download the CSV.</div>` : '';
  $('results-table-wrap').innerHTML = `<table class="r-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}`;
  $('results-table-wrap').querySelectorAll('th[data-sort]').forEach(h => h.addEventListener('click', () => sortBy(h.dataset.sort)));
  $('results-table-wrap').querySelectorAll('tr[data-code]').forEach(tr => tr.addEventListener('click', () => showUnitPanel(tr.dataset.code)));
}

function filterRows() {
  const q = $('table-search').value.trim().toLowerCase();
  if (!q) return S.rows;
  return S.rows.filter(r => [r.name, r.code, r.priority, ...(r.parents || [])].some(x => String(x ?? '').toLowerCase().includes(q)));
}

function sortBy(col) {
  if (S.sortCol === col) S.sortAsc = !S.sortAsc; else { S.sortCol = col; S.sortAsc = col === 'name' || col === 'rank' || /^p\d+$/.test(col); }
  const get = r => (/^p\d+$/.test(col) ? r.parents?.[+col.slice(1)] : r[col]);
  S.rows.sort((a, b) => {
    const av = get(a), bv = get(b);
    if (av == null) return 1; if (bv == null) return -1;
    const c = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return S.sortAsc ? c : -c;
  });
  buildTable(filterRows());
}

/* ── Distribution & comparison ───────────────────────────── */
function kde(values, xs, bw) {
  const n = values.length, k = Math.sqrt(2 * Math.PI);
  return xs.map(x => { let s = 0; for (const v of values) { const u = (x - v) / bw; s += Math.exp(-0.5 * u * u) / k; } return s / (n * bw); });
}

function renderDistribution() {
  if (!S.run) return;
  const v = S.rows.map(r => r.score);
  if (!v.length) return;
  const L = S.levelByKey[S.level];
  const xs = Array.from({ length: 101 }, (_, i) => i), binW = 2;
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const dens = kde(v, xs, 4).map(d => d * v.length * binW);
  const traces = [
    { type: 'histogram', x: v, xbins: { start: 0, end: 100, size: binW }, marker: { color: v.map(s => scoreColor(s, 0.75)) }, name: 'Current', opacity: 0.85 },
    { type: 'scatter', mode: 'lines', x: xs, y: dens, line: { color: '#1e3a5f', width: 2 }, name: 'Density', hoverinfo: 'skip' },
    { type: 'scatter', mode: 'lines', x: [avg, avg], y: [0, Math.max(...dens) * 1.05], line: { color: '#e74c3c', dash: 'dash', width: 1.5 }, name: `Mean ${avg.toFixed(1)}` },
  ];
  if (S.compare) {
    const cv = compareValuesAtLevel(S.compare);
    if (cv.length) {
      const cd = kde(cv, xs, 4).map(d => d * cv.length * binW);
      traces.push({ type: 'scatter', mode: 'lines', x: xs, y: cd, line: { color: '#94a3b8', width: 2, dash: 'dot' }, name: S.compare.name, hoverinfo: 'skip' });
    }
  }
  Plotly.react('dist-hist-div', traces, {
    xaxis: { title: 'PTI score', range: [0, 100], dtick: 10 }, yaxis: { title: `${L.label}s` },
    title: { text: 'Score distribution', font: { size: 13 } }, legend: { x: 1, xanchor: 'right', y: 1 },
    margin: { t: 36, b: 44, l: 50, r: 20 }, height: 248, bargap: 0.05, plot_bgcolor: '#fff', paper_bgcolor: '#fff',
  }, { responsive: true, displayModeBar: false });

  const top = S.levels[0];
  const st = PTICore.aggregate(S.units, S.run.comp.index, top.code, top.name, S.weightField).sort((a, b) => a.mean - b.mean);
  Plotly.react('dist-bar-div', [{
    type: 'bar', orientation: 'h', x: st.map(s => s.mean), y: st.map(s => s.name),
    marker: { color: st.map(s => scoreColor(s.mean)) }, text: st.map(s => s.mean.toFixed(1)), textposition: 'outside',
    hovertemplate: '%{y}: %{x:.1f}<extra></extra>',
  }], {
    xaxis: { title: S.weightField ? 'Population-weighted mean PTI' : 'Mean PTI', range: [0, 108] }, yaxis: { automargin: true },
    title: { text: `By ${top.label}`, font: { size: 13 } }, margin: { t: 36, b: 44, l: 10, r: 50 },
    height: Math.max(248, st.length * 22), plot_bgcolor: '#fff', paper_bgcolor: '#fff',
  }, { responsive: true, displayModeBar: false });
}

function compareValuesAtLevel(run) {
  const L = S.levelByKey[S.level];
  if (L === S.base) return run.scores.filter(isNum);
  return PTICore.aggregate(S.units, run.scores, L.code, L.name, S.weightField).map(r => r.mean);
}

function saveRun() {
  if (!S.run) return;
  const def = `${S.run.scenarioLabel || 'Custom'} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const name = prompt('Name this saved run:', def);
  if (!name || !name.trim()) return;
  S.savedRuns.push({ name: name.trim(), date: new Date().toISOString(),
    weights: Object.fromEntries(S.run.parts.map(p => [p.id, p.weight])),
    scores: S.run.comp.index.map(s => (s == null ? null : +s.toFixed(2))) });
  if (S.savedRuns.length > 10) S.savedRuns.shift();
  try { localStorage.setItem(runsKey(), JSON.stringify(S.savedRuns)); } catch (_) { alert('Could not store the run in this browser (storage full or blocked).'); }
  updateSavedRunsUI();
}

function updateSavedRunsUI() {
  const sel = $('compare-select'), cur = sel.value;
  sel.innerHTML = '<option value="">— none —</option>' + S.savedRuns.map((r, i) => `<option value="${i}">${esc(r.name)}</option>`).join('');
  if (cur && S.savedRuns[+cur]) sel.value = cur;
  $('compare-bar').style.display = S.savedRuns.length ? 'flex' : 'none';
}

/* Sensitivity between two runs: rank agreement and top-group overlap */
function onCompareSelect() {
  const i = $('compare-select').value;
  S.compare = i !== '' ? S.savedRuns[+i] : null;
  $('compare-clear').style.display = S.compare ? '' : 'none';
  $('compare-stats').textContent = '';
  if (S.compare && S.run) {
    const a = S.run.comp.index, b = S.compare.scores;
    if (b.length !== a.length) { $('compare-stats').textContent = 'saved with different data — not comparable'; }
    else {
      const rho = PTICore.spearman(a, b);
      const ta = PTICore.topSet(a, 0.2), tb = PTICore.topSet(b, 0.2);
      let both = 0; for (const x of ta) if (tb.has(x)) both++;
      $('compare-stats').textContent = `rank correlation ${rho == null ? '—' : rho.toFixed(2)} · top 20% overlap ${Math.round(both / Math.max(1, ta.size) * 100)}% (${S.base.label.toLowerCase()} level)`;
    }
  }
  if (S.run) renderDistribution();
}

/* ── Robustness ──────────────────────────────────────────── */
function runRobustness() {
  if (!S.run) return alert('Run the PTI first.');
  const L = S.levelByKey[S.level];
  const spread = +$('rob-spread').value, top = +$('rob-top').value;
  $('robust-body').innerHTML = '<div class="muted panel-empty">Running 200 weight draws…</div>';
  setTimeout(() => {
    const grouper = L === S.base ? null : PTICore.makeGrouper(S.units, L.code, S.weightField);
    const res = PTICore.robustness(S.run.parts, S.run.nClasses, S.run.minCoverage, { draws: 200, spread, topShare: top, grouper });
    const codes = grouper ? grouper.codes : S.units.map(u => u[L.code]);
    res.byCode = new Map(codes.map((c, i) => [c, res.freq[i]]));
    S.robust = res;
    $('mapvar-list').querySelector('input[value=robust]').disabled = false;
    $('mapvar-list').querySelector('input[value=robust]').parentElement.lastChild.textContent = ' Robustness (share of draws in top group)';
    renderAll();
    renderRobustPanel();
  }, 20);
}

function renderRobustPanel() {
  const r = S.robust, L = S.levelByKey[S.level];
  const always = S.rows.filter(x => x.robust >= 0.8).length, never = S.rows.filter(x => x.robust === 0).length;
  const unstable = S.rows.filter(x => x.robust > 0.2 && x.robust < 0.8).sort((a, b) => b.score - a.score);
  $('robust-body').innerHTML = `
    <div class="kpi-row">
      <div class="kpi"><b>${r.spearman ? r.spearman.mean.toFixed(2) : '—'}</b><span>mean rank correlation with the baseline${r.spearman ? ` (min ${r.spearman.min.toFixed(2)})` : ''}</span></div>
      <div class="kpi"><b>${r.stableShare == null ? '—' : Math.round(r.stableShare * 100) + '%'}</b><span>of the baseline top ${Math.round(r.topShare * 100)}% stay there in ≥80% of draws</span></div>
      <div class="kpi"><b>${always.toLocaleString()}</b><span>${esc(L.label.toLowerCase())}s robustly in the top group</span></div>
      <div class="kpi"><b>${unstable.length.toLocaleString()}</b><span>borderline (in the top group in 20–80% of draws)</span></div>
    </div>
    <div class="robust-split">
      <div id="robust-hist"></div>
      <div class="robust-list"><div class="unit-sub">Borderline ${esc(L.label.toLowerCase())}s — their priority depends on the weights</div>
        ${unstable.slice(0, 40).map(x => `<div class="rl-row" data-code="${esc(x.code)}"><span>${esc(x.name ?? x.code)}</span><span class="muted">${x.score.toFixed(1)} · ${Math.round(x.robust * 100)}%</span></div>`).join('') || '<div class="muted small">None — the top group is stable.</div>'}
      </div>
    </div>
    <div class="muted small panel-foot">${r.draws} draws, each weight multiplied by a random factor in [${(1 - r.spread).toFixed(2)}, ${(1 + r.spread).toFixed(2)}] and renormalised. Indicator classes are held fixed. ${never.toLocaleString()} ${esc(L.label.toLowerCase())}s never reach the top group.</div>`;
  $('robust-body').querySelectorAll('.rl-row').forEach(el => el.addEventListener('click', () => showUnitPanel(el.dataset.code)));
  const f = S.rows.map(x => x.robust).filter(isNum).map(x => x * 100);
  Plotly.newPlot('robust-hist', [{ type: 'histogram', x: f, xbins: { start: 0, end: 100.01, size: 5 }, marker: { color: '#3b82f6' } }], {
    xaxis: { title: `% of draws in the top ${Math.round(r.topShare * 100)}%`, range: [0, 100] }, yaxis: { title: `${L.label}s` },
    margin: { t: 10, b: 40, l: 50, r: 10 }, height: 180, plot_bgcolor: '#fff', paper_bgcolor: '#fff',
  }, { responsive: true, displayModeBar: false });
}

function resetMapVar() {
  S.mapVar = 'pti';
  const rb = document.querySelector('input[name=mapvar][value=robust]');
  if (rb) { rb.disabled = true; rb.parentElement.lastChild.textContent = ' Robustness (run it first)'; }
  const pt = document.querySelector('input[name=mapvar][value=pti]'); if (pt) pt.checked = true;
  if ($('robust-body') && !S.robust) $('robust-body').innerHTML = '<div class="muted panel-empty">Run the robustness test for the current settings.</div>';
}

/* ── Layers ──────────────────────────────────────────────── */
function buildLayersPanel() {
  const ovs = S.cfg.overlays || [];
  $('layers-list').innerHTML = ovs.length ? ovs.map(o => `<label class="lyr-row">
      <input type="checkbox" data-ov="${esc(o.id)}"/> <span class="lyr-swatch lyr-${esc(o.geometry)}" style="background:${esc(o.color || '#334155')}"></span>${esc(o.label || o.id)}
      ${o.role === 'portfolio' ? '<span class="ind-level">portfolio</span>' : ''}</label>`).join('')
    : '<div class="muted small" style="padding:8px 12px">No overlays configured.</div>';
  $('layers-list').querySelectorAll('input[data-ov]').forEach(cb => cb.addEventListener('change', async () => {
    const id = cb.dataset.ov;
    if (cb.checked) { await loadOverlay(id); S.overlayOn.add(id); } else S.overlayOn.delete(id);
    if (S.run) renderMap(); else if (S.mapRendered || S.geo[S.levels[0].key]) drawOverlaysOnly();
  }));
}

async function loadOverlay(id) {
  if (S.overlayGeo[id]) return S.overlayGeo[id];
  const ov = S.cfg.overlays.find(o => o.id === id);
  S.overlayGeo[id] = await fetchJSON(`${S.dsPath}/${ov.file}`);
  return S.overlayGeo[id];
}

function drawOverlaysOnly() {
  const { under, labels } = baseLayers(), ov = overlayLayersAndTraces();
  Plotly.react('map-plotly', [{ type: 'scattermap', lat: [], lon: [] }, ...ov.traces],
    { map: { style: 'white-bg', layers: [...under, ...ov.layers, ...labels], ...mapView() }, margin: { t: 0, b: 0, l: 0, r: 0 }, uirevision: S.cfg.id, showlegend: false },
    { responsive: true, displayModeBar: false });
  $('map-empty').classList.add('hidden');
}

/* ── Portfolio balance ───────────────────────────────────── */
async function ensurePortfolio() {
  const ov = S.portfolioLayer();
  if (!ov) return null;
  if (S.portfolio) return S.portfolio;
  const gj = await loadOverlay(ov.id);
  const unitOf = new Map(S.units.map((u, i) => [String(u[S.base.code]), i]));
  const perUnit = new Float64Array(S.units.length);
  let outside = 0, located = 0;
  for (const f of gj.features) {
    let i = f.properties?._unit != null ? unitOf.get(String(f.properties._unit)) : undefined;
    if (i === undefined && f.geometry?.type === 'Point') i = locatePoint(f.geometry.coordinates);
    if (i === undefined || i === null) { outside++; continue; }
    perUnit[i]++; located++;
  }
  S.portfolio = { ov, perUnit, outside, located };
  return S.portfolio;
}

/* Point-in-polygon fallback for portfolios not tagged by the build */
function locatePoint([x, y]) {
  const gj = S.geo[S.base.key];
  if (!gj) return null;
  const inRing = r => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  const inPoly = p => inRing(p[0]) && !p.slice(1).some(inRing);
  const unitOf = new Map(S.units.map((u, i) => [String(u[S.base.code]), i]));
  for (const f of gj.features) {
    const g = f.geometry; if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    if (polys.some(inPoly)) return unitOf.get(String(f.properties[S.base.code])) ?? null;
  }
  return null;
}

function attachPortfolio() {
  const pf = S.portfolio, L = S.levelByKey[S.level];
  const counts = new Map();
  S.units.forEach((u, i) => { if (pf.perUnit[i]) counts.set(String(u[L.code]), (counts.get(String(u[L.code])) || 0) + pf.perUnit[i]); });
  S.rows.forEach(r => { r.projects = counts.get(String(r.code)) || 0; });
}

async function renderPortfolio() {
  const body = $('portfolio-body');
  if (!S.run) { body.innerHTML = '<div class="muted panel-empty">Run the PTI first.</div>'; return; }
  const pf = await ensurePortfolio();
  if (!pf) return;
  attachPortfolio(); buildTable(filterRows());
  const L = S.levelByKey[S.level], labels = S.cfg.priority_labels || ['Very low', 'Low', 'Moderate', 'High', 'Very high'];
  const k = labels.length;
  const byCls = Array.from({ length: k }, () => ({ units: 0, pop: 0, proj: 0, withProj: 0 }));
  let popTot = 0, projTot = 0;
  for (const r of S.rows) {
    if (!r.cls) continue;
    const b = byCls[r.cls - 1], pop = r.weight ?? (r.count || 1);
    b.units++; b.pop += pop; b.proj += r.projects; if (r.projects) b.withProj++;
    popTot += pop; projTot += r.projects;
  }
  const popLabel = S.weightField ? 'population' : `${S.base.label.toLowerCase()}s`;
  const gaps = S.rows.filter(r => r.cls === k && !r.projects).sort((a, b) => b.score - a.score);
  const lowShare = projTot ? (byCls[0].proj + (k > 1 ? byCls[1].proj : 0)) / projTot : 0;
  const topShare = projTot ? byCls[k - 1].proj / projTot : 0;
  body.innerHTML = `
    <div class="kpi-row">
      <div class="kpi"><b>${pf.located}</b><span>${esc(pf.ov.label)} located${pf.outside ? ` (${pf.outside} outside the study area)` : ''}</span></div>
      <div class="kpi"><b>${Math.round(topShare * 100)}%</b><span>of projects in "${esc(labels[k - 1])}" ${esc(L.label.toLowerCase())}s, which hold ${popTot ? Math.round(byCls[k - 1].pop / popTot * 100) : 0}% of ${popLabel}</span></div>
      <div class="kpi"><b>${Math.round(lowShare * 100)}%</b><span>of projects in the two lowest-priority groups</span></div>
      <div class="kpi"><b>${gaps.length.toLocaleString()}</b><span>"${esc(labels[k - 1])}" ${esc(L.label.toLowerCase())}s with no project</span></div>
    </div>
    <div class="robust-split">
      <div id="portfolio-chart"></div>
      <div class="robust-list"><div class="unit-sub">Gaps — highest-priority ${esc(L.label.toLowerCase())}s without a project</div>
        ${gaps.slice(0, 40).map(x => `<div class="rl-row" data-code="${esc(x.code)}"><span>${esc(x.name ?? x.code)}</span><span class="muted">${x.score.toFixed(1)}</span></div>`).join('') || '<div class="muted small">None.</div>'}
      </div>
    </div>
    <div class="muted small panel-foot">Priority groups are relative to this run. A gap is a prompt for discussion, not a siting decision — check operational and political-economy constraints.</div>`;
  body.querySelectorAll('.rl-row').forEach(el => el.addEventListener('click', () => showUnitPanel(el.dataset.code)));
  Plotly.newPlot('portfolio-chart', [
    { type: 'bar', name: `Share of ${popLabel}`, x: labels, y: byCls.map(b => (popTot ? b.pop / popTot * 100 : 0)), marker: { color: '#cbd5e1' } },
    { type: 'bar', name: 'Share of projects', x: labels, y: byCls.map(b => (projTot ? b.proj / projTot * 100 : 0)), marker: { color: pf.ov.color || '#1e3a8a' } },
  ], {
    barmode: 'group', yaxis: { title: '%', rangemode: 'tozero' }, xaxis: { title: `Priority group (${L.label.toLowerCase()} level)` },
    legend: { orientation: 'h', y: 1.15 }, margin: { t: 20, b: 44, l: 44, r: 10 }, height: 200, plot_bgcolor: '#fff', paper_bgcolor: '#fff',
  }, { responsive: true, displayModeBar: false });
}

/* ── AOI lasso ───────────────────────────────────────────── */
function toggleAOI() {
  if (!S.mapRendered) return;
  S.aoiMode = !S.aoiMode;
  $('aoi-btn').classList.toggle('active', S.aoiMode);
  $('aoi-btn').innerHTML = S.aoiMode ? '&#9638; Drawing…' : '&#9638; Select Area';
  Plotly.relayout('map-plotly', { dragmode: S.aoiMode ? 'lasso' : 'pan' });
  if (!S.aoiMode) clearAOI();
}
function clearAOI() {
  $('aoi-panel').style.display = 'none'; $('aoi-clear-btn').style.display = 'none';
  if (S.mapRendered) Plotly.restyle('map-plotly', { selectedpoints: [null] }, [0]);
}
function onAOISelected(ev) {
  const pts = (ev?.points || []).filter(p => p.curveNumber === 0);
  const sel = pts.map(p => S.rows.find(r => String(r.code) === String(S.mapIds[p.pointIndex]))).filter(Boolean);
  if (!sel.length) return;
  const v = sel.map(r => r.score).sort((a, b) => a - b), n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const k = (S.cfg.priority_labels || [1, 2, 3, 4, 5]).length;
  const hi = sel.filter(r => r.cls >= k - 1).length;
  const pop = sel.reduce((s, r) => s + (r.weight || 0), 0);
  $('aoi-clear-btn').style.display = '';
  $('aoi-title').textContent = `${n.toLocaleString()} ${S.levelByKey[S.level].label.toLowerCase()}s selected`;
  $('aoi-stats').innerHTML = `<div class="aoi-grid">
    <span>Mean PTI</span><b>${mean.toFixed(1)}</b>
    <span>P25 – P75</span><b>${v[Math.floor(n * 0.25)].toFixed(1)} – ${v[Math.floor(n * 0.75)].toFixed(1)}</b>
    <span>Top two groups</span><b>${Math.round(hi / n * 100)}%</b>
    ${pop ? `<span>Population</span><b>${Math.round(pop).toLocaleString()}</b>` : ''}
    ${sel[0].projects != null ? `<span>Projects</span><b>${sel.reduce((s, r) => s + (r.projects || 0), 0)}</b>` : ''}</div>`;
  Plotly.newPlot('aoi-hist', [{ type: 'histogram', x: v, xbins: { start: 0, end: 100, size: 5 }, marker: { color: v.map(s => scoreColor(s, 0.8)) } }],
    { margin: { t: 4, b: 26, l: 28, r: 4 }, height: 100, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', xaxis: { range: [0, 100], dtick: 20, tickfont: { size: 9 } }, yaxis: { tickfont: { size: 9 } } },
    { displayModeBar: false, responsive: true });
  $('aoi-panel').style.display = '';
}

/* ── Drawer ──────────────────────────────────────────────── */
function toggleDrawer() { S.drawerOpen ? closeDrawer() : openDrawer(); }
function openDrawer() { $('results-drawer').className = 'drawer-open'; S.drawerOpen = true; $('map-legend').style.bottom = '320px'; }
function closeDrawer() { $('results-drawer').className = 'drawer-closed'; S.drawerOpen = false; $('map-legend').style.bottom = '20px'; }

/* ── About / data dictionary ─────────────────────────────── */
function dictionaryRows() {
  return [...S.ind.values()].map(m => ({
    id: m.id, label: m.label, category: m.category || '', level: levelOf(m.id).label, direction: m.direction,
    unit: m.unit || '', source: m.source_note || '', year: m.year ?? '',
    fill: m.fill ?? 'none', scoring: m.scoring ? m.scoring.type : `${S.cfg.classification || 'quantile'} classes`,
  }));
}

function showAbout() {
  if (!S.cfg) return;
  const c = S.cfg, n = S.nClasses;
  const sc = (c.scenarios || []).map(s => `<li><b>${esc(s.label)}</b>${s.description ? ` — ${esc(s.description)}` : ''}</li>`).join('');
  const dict = dictionaryRows();
  $('about-body').innerHTML = `
    <p class="about-lead">The Project Targeting Index combines several spatial indicators into one relative index of where conditions
    align with a programme's objectives. It supports discussion of where to look more closely; it does not decide where projects go.</p>
    <h4>How the score is built</h4>
    <ol class="about-steps">
      <li><b>Categorise.</b> Each indicator is split into ${n} classes — by quantile (equal number of units per class), equal interval,
        or natural breaks — at the level it was measured, so a district-level figure is classed across districts, not across every
        ${esc(S.base.label.toLowerCase())} in them. Some indicators use fixed thresholds or category scores set in the configuration.</li>
      <li><b>Score.</b> Classes are scored 1 to ${n}. <i>Ascending</i> (↑): a higher value scores higher; <i>descending</i> (↓): lower.
        Negative values are fine.</li>
      <li><b>Weight and combine.</b> Weights sum to 100%. The weighted mean score is rescaled to 0–100: 0 = lowest class on every
        indicator, 100 = highest. Units missing more than ${Math.round((1 - (c.min_coverage ?? 1)) * 100)}% of the selected weight are left unscored.</li>
      <li><b>Aggregate.</b> Coarser levels average their ${esc(S.base.label.toLowerCase())}s${c.population_field ? ', weighted by population if chosen' : ''}.
        Priority groups are quantiles of the scores shown — relative to the run, not absolute thresholds.</li>
    </ol>
    ${sc ? `<h4>Thematic PTIs</h4><ul class="about-list">${sc}</ul>` : ''}
    <h4>Data dictionary <button class="dl-btn" id="dl-dict" style="margin-left:8px">↓ CSV</button></h4>
    <div class="about-table-wrap"><table class="r-table about-table"><thead><tr>
      <th>Indicator</th><th>Category</th><th>Level</th><th>Dir.</th><th>Unit</th><th>Source</th><th>Year</th><th>Missing values</th><th>Scoring</th>
    </tr></thead><tbody>${dict.map(d => `<tr><td>${esc(d.label)}</td><td>${esc(d.category)}</td><td>${esc(d.level)}</td>
      <td>${d.direction === 'descending' ? '↓' : '↑'}</td><td>${esc(d.unit)}</td><td>${esc(d.source)}</td><td>${esc(d.year)}</td>
      <td>${esc(d.fill)}</td><td>${esc(d.scoring)}</td></tr>`).join('')}</tbody></table></div>
    <h4>Using the results responsibly</h4>
    <ul class="about-list">
      <li>Describe the output as a composite index conditional on the selected indicators and weights — not as who is "more deserving".</li>
      <li>Test sensitivity: compare saved runs and use the Robustness tab before relying on a ranking.</li>
      <li>Political-economy and operational constraints with a spatial dimension can be added as indicators; the rest still need to be weighed outside the tool.</li>
      <li>Cite the indicator sources and dates above, and the run notes (↓ Run notes) for any figure you share.</li>
    </ul>
    ${c.about?.disclaimer ? `<p class="about-disclaimer">${esc(c.about.disclaimer)}</p>` : ''}
    <p class="muted small">Dataset built ${esc(c.built || '')}${c.about?.contact ? ` · Contact: ${esc(c.about.contact)}` : ''}</p>`;
  $('dl-dict').addEventListener('click', () => dl(toCSV(dict), 'text/csv', `${fileStem()}_data_dictionary.csv`));
  $('about-modal-bg').style.display = 'flex';
}

/* ── Downloads ───────────────────────────────────────────── */
const fileStem = () => `${(S.cfg.country || S.cfg.id).toLowerCase().replace(/\W+/g, '_')}_pti`;
const today = () => new Date().toISOString().slice(0, 10);
function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
}
function dl(content, type, name) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function levelExportRows() {
  const L = S.levelByKey[S.level];
  return [...S.rows].sort((a, b) => a.rank - b.rank).map(r => {
    const o = { rank: r.rank, [L.code]: r.code, [L.name]: r.name ?? '' };
    S.levels.slice(0, L.rank).forEach((p, k) => { o[p.name] = r.parents?.[k] ?? ''; });
    Object.assign(o, { pti_score: +r.score.toFixed(2), priority_group: r.cls, priority: r.priority });
    if (L !== S.base) o[`n_${S.base.key}`] = r.count;
    if (r.weight != null) o.population = Math.round(r.weight);
    if (r.coverage != null) o.coverage = +r.coverage.toFixed(3);
    if (r.robust != null) o.robustness = +r.robust.toFixed(3);
    if (r.projects != null) o.projects = r.projects;
    return o;
  });
}

function downloadLevelCSV() {
  if (!S.run) return alert('Run the PTI first.');
  dl(toCSV(levelExportRows()), 'text/csv', `${fileStem()}_${S.level}_${today()}.csv`);
}

function downloadBaseCSV() {
  if (!S.run) return alert('Run the PTI first.');
  const rows = S.units.map((u, i) => {
    const o = {};
    S.levels.forEach(l => { o[l.code] = u[l.code]; o[l.name] = u[l.name]; });
    if (S.cfg.population_field) o.population = u[S.cfg.population_field];
    o.pti_score = S.run.comp.index[i] == null ? null : +S.run.comp.index[i].toFixed(2);
    o.coverage = +S.run.comp.coverage[i].toFixed(3);
    for (const p of S.run.parts) { o[p.id] = u[p.id]; o[`${p.id}_class`] = p.scores[i] == null ? null : +p.scores[i].toFixed(2); }
    return o;
  });
  dl(toCSV(rows), 'text/csv', `${fileStem()}_${S.base.key}_full_${today()}.csv`);
}

function levelGeoJSON() {
  const L = S.levelByKey[S.level], gj = S.geo[L.key];
  if (!gj) return null;
  const look = new Map(levelExportRows().map(r => [String(r[L.code]), r]));
  return { type: 'FeatureCollection', features: gj.features.filter(f => look.has(String(f.properties[L.code])))
    .map(f => ({ type: 'Feature', geometry: f.geometry, properties: look.get(String(f.properties[L.code])) })) };
}

function downloadGeoJSON() {
  if (!S.run) return alert('Run the PTI first.');
  const gj = levelGeoJSON();
  if (!gj) return alert('Boundaries are still loading — try again in a moment.');
  dl(JSON.stringify(gj), 'application/geo+json', `${fileStem()}_${S.level}_${today()}.geojson`);
}

/* Everything needed to reproduce or cite a run */
function runNotes() {
  const total = S.run.parts.reduce((s, p) => s + p.weight, 0);
  return {
    dataset: S.cfg.id, country: S.cfg.country, dataset_built: S.cfg.built, run_at: S.run.date.toISOString(),
    thematic_pti: S.run.scenarioLabel,
    method: { classification: S.run.method, classes: S.run.nClasses, score_scale: `1-${S.run.nClasses}`,
      composite: '0-100 = (weighted mean class score - 1) / (classes - 1) * 100',
      min_coverage: S.run.minCoverage, aggregation: S.weightField ? `population-weighted (${S.weightField})` : 'unweighted mean',
      level_shown: S.level },
    indicators: S.run.parts.map(p => ({ id: p.id, label: p.meta.label, weight_pct: +(p.weight / total * 100).toFixed(2),
      direction: p.direction, native_level: levelOf(p.id).key, scoring: p.meta.scoring || 'classes',
      breaks: p.breaks, filled: p.filled, missing: p.missing, fill_rule: p.meta.fill ?? null,
      unit: p.meta.unit, source: p.meta.source_note, year: p.meta.year })),
    robustness: S.robust ? { draws: S.robust.draws, spread: S.robust.spread, top_share: S.robust.topShare,
      mean_rank_correlation: S.robust.spearman?.mean, stable_share: S.robust.stableShare, level: S.level } : null,
    interpretation: 'Relative composite index conditional on the selected indicators and weights. It highlights where to look more closely and does not by itself determine project locations.',
    disclaimer: S.cfg.about?.disclaimer || null,
  };
}
function downloadRunNotes() {
  if (!S.run) return alert('Run the PTI first.');
  dl(JSON.stringify(runNotes(), null, 2), 'application/json', `${fileStem()}_run_notes_${today()}.json`);
}

/* ── Publish to ArcGIS (optional) ────────────────────────── */
function showAgolModal() {
  if (!S.run) return alert('Run the PTI first.');
  const L = S.levelByKey[S.level];
  $('agol-title').value = `${S.cfg.country || S.cfg.id} PTI ${L.label} ${today()}`;
  $('agol-portal').value = S.cfg.arcgis_publish?.portal || 'https://www.arcgis.com';
  $('agol-status').textContent = ''; $('agol-status').className = '';
  $('agol-modal-bg').style.display = 'flex';
  $('agol-token').focus();
}

async function runAgolPublish() {
  const token = $('agol-token').value.trim();
  const title = $('agol-title').value.trim() || `PTI ${today()}`;
  const portal = $('agol-portal').value.trim().replace(/\/$/, '');
  const withGeom = $('agol-with-geom').checked;
  const st = $('agol-status'), btn = $('agol-go-btn');
  if (!token) { st.className = 'err'; st.textContent = 'Paste your ArcGIS token.'; return; }
  btn.disabled = true; st.className = ''; st.textContent = 'Checking sign-in…';
  try {
    const self = await (await fetch(`${portal}/sharing/rest/community/self?f=json&token=${encodeURIComponent(token)}`)).json();
    if (self.error) throw new Error(`Sign-in failed: ${self.error.message}`);
    const user = self.username;
    let blob, fileName, itemType;
    if (withGeom) {
      const gj = levelGeoJSON();
      if (!gj) throw new Error('Boundaries not loaded yet — wait, or untick polygons.');
      blob = new Blob([JSON.stringify(gj)], { type: 'application/json' }); fileName = `${title}.geojson`; itemType = 'GeoJson';
    } else {
      blob = new Blob([toCSV(levelExportRows())], { type: 'text/csv' }); fileName = `${title}.csv`; itemType = 'CSV';
    }
    st.textContent = `Uploading ${(blob.size / 1e6).toFixed(1)} MB as ${user}…`;
    const form = new FormData();
    Object.entries({ f: 'json', token, title, type: itemType, overwrite: 'false',
      description: runNotes().interpretation, tags: 'PTI,targeting', snippet: `${S.run.scenarioLabel || 'Custom'} · ${S.run.nClasses} ${S.run.method} classes` })
      .forEach(([k, v]) => form.append(k, v));
    form.append('file', blob, fileName);
    const added = await (await fetch(`${portal}/sharing/rest/content/users/${encodeURIComponent(user)}/addItem`, { method: 'POST', body: form })).json();
    if (!added.success) throw new Error(added.error?.message || JSON.stringify(added));
    st.textContent = 'Publishing as a hosted feature layer…';
    const pub = new FormData();
    pub.append('f', 'json'); pub.append('token', token); pub.append('itemID', added.id); pub.append('filetype', itemType === 'GeoJson' ? 'geojson' : 'csv');
    const params = { name: title.replace(/\W+/g, '_'), hasStaticData: true };
    if (itemType === 'CSV') Object.assign(params, { locationType: 'none' });
    pub.append('publishParameters', JSON.stringify(params));
    const res = await (await fetch(`${portal}/sharing/rest/content/users/${encodeURIComponent(user)}/publish`, { method: 'POST', body: pub })).json();
    const svc = res.services?.[0];
    if (svc?.error || res.error) throw new Error((svc?.error || res.error).message);
    const url = `${portal}/home/item.html?id=${svc?.serviceItemId || added.id}`;
    st.className = 'ok';
    st.innerHTML = `✓ Published. <a href="${esc(url)}" target="_blank" rel="noopener">Open in ArcGIS →</a> (shared only with you until you change it)`;
  } catch (e) {
    st.className = 'err'; st.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false; $('agol-token').value = '';
  }
}
