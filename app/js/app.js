/* ── PTI Builder — map-centric app ──────────────────────────
 * Everything country-specific comes from data/<dataset>/config.json and
 * data_<level>.json, written by prep/build_dataset.py or
 * prep/import_devptipack.py. The method lives in pti-core.js.
 */
'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = v => typeof v === 'number' && Number.isFinite(v);

const S = {
  index: null, dsPath: '', cfg: null, levels: [], levelByKey: {}, model: null, ind: new Map(),
  geo: {}, overlayGeo: {}, overlayOn: new Set(),
  level: null, bins: 5, run: null, res: null, groups: null, rows: [], robust: null,
  mapVar: 'priority', explorerId: null, savedRuns: [], mapRendered: false, aoiMode: false,
  drawerOpen: false, sortCol: 'score', sortAsc: false, portfolio: null,
};

// RdYlBu, red = Priority 1 (devPTIpack's default palette, reversed so red is highest priority)
const RDYLBU = ['#a50026', '#d73027', '#f46d43', '#fdae61', '#fee090', '#e0f3f8', '#abd9e9', '#74add1', '#4575b4', '#313695'];
const NO_DATA = '#c8ccd2';
const ROBUST_SCALE = [[0, '#f1f5f9'], [.5, '#93c5fd'], [.8, '#2563eb'], [1, '#1e3a8a']];
const SEQ_SCALE = [[0, '#fff7ec'], [.25, '#fdd49e'], [.5, '#fc8d59'], [.75, '#d7301f'], [1, '#7f0000']];
const DIV_SCALE = [[0, '#313695'], [.25, '#74add1'], [.5, '#ffffbf'], [.75, '#f46d43'], [1, '#a50026']];
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
    // A dataset folder can be opened by URL without being listed in the
    // index — keeps private/internal datasets out of a published index.json
    if (want && /^[\w-]+$/.test(want) && !ds.some(d => d.id === want)) ds.push({ id: want, path: want, label: want });
    const pick = ds.find(d => d.id === want) || ds[0];
    if (ds.length > 1) {
      const sel = $('dataset-select');
      sel.innerHTML = ds.map(d => `<option value="${esc(d.id)}"${d.id === pick.id ? ' selected' : ''}>${esc(d.label || d.id)}</option>`).join('');
      sel.style.display = '';
      sel.addEventListener('change', () => { location.search = `?data=${encodeURIComponent(sel.value)}`; });
    }
    S.dsPath = `data/${pick.path || pick.id}`;
    S.cfg = await fetchJSON(`${S.dsPath}/config.json`);
    if (S.cfg.method !== 'devPTIpack') throw new Error('this dataset was built for an older version of the app — rebuild it with prep/build_dataset.py');
    const data = {};
    await Promise.all(S.cfg.levels.map(async l => { data[l.key] = await fetchJSON(`${S.dsPath}/data_${l.key}.json`); }));
    S.model = PTICore.buildModel(S.cfg.levels, data);
    setupDataset();
  } catch (err) {
    console.error(err);
    $('data-status').className = 'status-chip error';
    $('data-status').textContent = 'Data missing';
    $('indicator-panels').innerHTML = `<div class="ind-loading err">Could not load the dataset.<br><code>${esc(err.message)}</code><br>
      Build one with <code>python prep/build_dataset.py &lt;pti.yaml&gt;</code> and serve the <code>app/</code> folder over HTTP.</div>`;
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
  S.levels = S.model.levels;
  S.levelByKey = S.model.byKey;
  S.level = S.levelByKey[c.default_level] ? c.default_level : S.levels[Math.max(0, S.levels.length - 2)].key;
  S.bins = Math.max(2, Math.min(10, c.bins || 5));
  $('bins-select').value = String(S.bins);
  c.indicators.forEach(m => S.ind.set(m.id, m));
  try { S.savedRuns = JSON.parse(localStorage.getItem(runsKey()) || '[]'); } catch (_) { S.savedRuns = []; }

  $('admin-toggle').innerHTML = S.levels.map(l =>
    `<button class="tg${l.key === S.level ? ' active' : ''}" data-level="${esc(l.key)}">${esc(l.label)}</button>`).join('');
  $('admin-toggle').querySelectorAll('.tg').forEach(b => b.addEventListener('click', () => {
    setActive('#admin-toggle', b); S.level = b.dataset.level; S.robust = null; resetMapVar();
    hideUnitPanel(); if (S.run) renderAll(); else if (S.mapVar === 'indicator') renderMap();
  }));

  buildScenarioSelect();
  buildIndicatorPanels();
  buildExplorerSelect();
  buildLayersPanel();
  updateCompareSelect();
  if (c.arcgis_publish) $('agol-publish-btn').style.display = '';
  if (c.data_refresh_note) {
    $('refresh-section').style.display = '';
    $('refresh-note').textContent = c.data_refresh_note.text || c.data_refresh_note;
    if (c.data_refresh_note.command) $('refresh-cmd').textContent = c.data_refresh_note.command;
    else $('refresh-cmd').style.display = 'none';
  }
  if (portfolioLayer()) $('portfolio-tab').style.display = '';
  $('data-status').style.display = 'none';
  const base = S.levels[S.levels.length - 1];
  $('app-subtitle').title = `${base.rows.length.toLocaleString()} ${base.label.toLowerCase()} units · ${c.indicators.length} indicators · built ${c.built || '?'}`;
  $('calc-btn').disabled = false;

  const first = (c.scenarios || [])[0];
  if (first) { $('scenario-select').value = first.id; applyScenario(first.id); }

  for (const l of S.levels) {
    fetchJSON(`${S.dsPath}/boundaries_${l.key}.geojson`).then(gj => {
      S.geo[l.key] = gj;
      if (!S.mapRendered && l.rank === 0) drawBaseMap();
      if (l.key === S.level && (S.run || S.mapVar === 'indicator')) renderMap();
    }).catch(() => console.warn(`no boundaries for ${l.key}`));
  }
}

const runsKey = () => `pti_runs_${S.cfg.id}`;
const portfolioLayer = () => (S.cfg?.overlays || []).find(o => o.role === 'portfolio');
const opts = () => ({ crossLevel: S.cfg.cross_level || 'project', naRm: S.cfg.missing === 'ignore' });
const levelLabel = k => S.levelByKey[k]?.label || k;
function setActive(sel, btn) {
  document.querySelectorAll(`${sel} .tg`).forEach(x => x.classList.remove('active'));
  btn?.classList.add('active');
}

/* ── Static wiring ───────────────────────────────────────── */
function wireStatic() {
  $('scenario-select').addEventListener('change', e => applyScenario(e.target.value));
  $('calc-btn').addEventListener('click', runPTI);
  $('results-toggle').addEventListener('click', toggleDrawer);
  $('unit-weights-btn').addEventListener('click', unitWeights);
  $('clear-weights-btn').addEventListener('click', () => { for (const id of S.ind.keys()) setRow(id, 0); markCustom(); updateWeightSummary(); });
  $('bins-select').addEventListener('change', e => { S.bins = +e.target.value; if (S.run) renderAll(); });
  $('aoi-btn').addEventListener('click', toggleAOI);
  $('aoi-clear-btn').addEventListener('click', clearAOI);
  $('aoi-close').addEventListener('click', clearAOI);
  $('unit-close').addEventListener('click', hideUnitPanel);
  $('layers-btn').addEventListener('click', () => { const p = $('layers-panel'); p.style.display = p.style.display === 'none' ? '' : 'none'; });
  $('layers-close').addEventListener('click', () => { $('layers-panel').style.display = 'none'; });
  $('about-btn').addEventListener('click', showAbout);
  $('table-search').addEventListener('input', () => buildTable(filterRows()));
  $('compare-select').addEventListener('change', onCompare);
  $('save-run-btn').addEventListener('click', saveRun);
  $('rob-run').addEventListener('click', runRobustness);
  $('agol-publish-btn').addEventListener('click', showAgolModal);
  $('agol-go-btn').addEventListener('click', runAgolPublish);
  $('dl-csv').addEventListener('click', downloadLevelCSV);
  $('dl-csv-z').addEventListener('click', downloadIndicatorsCSV);
  $('dl-geojson').addEventListener('click', downloadGeoJSON);
  $('dl-meta').addEventListener('click', downloadRunNotes);
  $('explorer-select').addEventListener('change', e => {
    S.explorerId = e.target.value;
    document.querySelector('input[name=mapvar][value=indicator]').checked = true;
    S.mapVar = 'indicator'; renderMap();
  });
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { $(b.dataset.close).style.display = 'none'; }));
  document.querySelectorAll('.modal-bg').forEach(bg => bg.addEventListener('click', e => { if (e.target === bg) bg.style.display = 'none'; }));
  document.querySelectorAll('input[name=mapvar]').forEach(r => r.addEventListener('change', () => { S.mapVar = r.value; renderMap(); }));
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

/* ── Weighting schemes ───────────────────────────────────── */
function buildScenarioSelect() {
  const sc = S.cfg.scenarios || [];
  $('scenario-select').innerHTML =
    sc.map(s => `<option value="${esc(s.id)}">${esc(s.label || s.id)}</option>`).join('') +
    `<option value="__custom">Custom</option>`;
}

function applyScenario(key) {
  const hint = $('scenario-hint');
  if (key === '__custom') { hint.textContent = 'Set your own indicators and weights.'; return; }
  const sc = (S.cfg.scenarios || []).find(s => s.id === key);
  if (!sc) return;
  const w = sc.weights || {};
  for (const id of S.ind.keys()) setRow(id, w[id] || 0);
  hint.textContent = sc.description || '';
  updateWeightSummary();
}

/* ── Indicator sidebar ───────────────────────────────────── */
function buildIndicatorPanels() {
  const pillars = S.cfg.pillars || [];
  const order = pillars.map(c => c.name);
  const color = Object.fromEntries(pillars.map(c => [c.name, c.color]));
  const grouped = {};
  for (const m of S.ind.values()) if (m.pti !== false) (grouped[m.pillar || 'Other'] ||= []).push(m);
  const names = [...new Set([...order, ...Object.keys(grouped).sort()])].filter(n => grouped[n]);
  $('indicator-panels').innerHTML = names.map(p => {
    const collapsed = grouped[p].length > 15;
    return `<div class="cat-section" data-cat="${esc(p)}">
      <button class="cat-toggle" aria-expanded="${!collapsed}">
        <span class="cat-dot" style="background:${esc(color[p] || '#7f8c8d')}"></span>
        <span class="cat-name">${esc(p)}</span>
        <span class="cat-sel-count"></span>
        <span class="cat-arrow">▼</span>
      </button>
      <div class="cat-rows${collapsed ? '' : ' open'}">${grouped[p].map(indRow).join('')}</div></div>`;
  }).join('');
  wireRows();
}

function levelBadges(m) {
  return `<span class="lvl-badges" title="Available at: ${esc(m.levels.map(levelLabel).join(', '))}">${
    S.levels.map(l => `<span class="lvl-b${m.levels.includes(l.key) ? ' on' : ''}">${esc(l.label[0])}</span>`).join('')}</span>`;
}

function indRow(m) {
  const sub = [m.unit, m.year].filter(Boolean).join(' · ');
  const tip = [m.label, m.description, m.source_note, m.unit && `Unit: ${m.unit}`,
    `Available at: ${m.levels.map(levelLabel).join(', ')}`].filter(Boolean).join('\n');
  return `<div class="ind-row dimmed" id="row-${esc(m.id)}">
    <div class="ind-check"><input type="checkbox" id="chk-${esc(m.id)}" data-id="${esc(m.id)}"/></div>
    <label class="ind-name-wrap" for="chk-${esc(m.id)}" title="${esc(tip)}">
      <div class="ind-name">${esc(m.label || m.id)}</div>
      <div class="ind-source">${levelBadges(m)}${sub ? ` ${esc(sub)}` : ''}</div>
    </label>
    <div class="ind-weight">
      <input type="number" class="weight-num" id="wnum-${esc(m.id)}" data-id="${esc(m.id)}" step="0.5" value="0"/>
      <input type="range" class="weight-slider" id="wsl-${esc(m.id)}" data-id="${esc(m.id)}" min="-3" max="3" step="0.5" value="0"/>
    </div>
  </div>`;
}

function setRow(id, w) {
  const cb = $(`chk-${id}`);
  if (!cb) return;
  w = +w || 0;
  cb.checked = w !== 0;
  $(`wnum-${id}`).value = w;
  $(`wsl-${id}`).value = Math.max(-3, Math.min(3, w));
  const row = $(`row-${id}`);
  row.classList.toggle('dimmed', w === 0);
  row.classList.toggle('w-pos', w > 0);
  row.classList.toggle('w-neg', w < 0);
}

function wireRows() {
  document.querySelectorAll('.cat-toggle').forEach(btn => btn.addEventListener('click', () => {
    const exp = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!exp));
    btn.nextElementSibling.classList.toggle('open', !exp);
  }));
  document.querySelectorAll('#indicator-panels input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
    const id = cb.dataset.id, m = S.ind.get(id);
    // Ticking suggests a sign from the indicator's hint; unticking clears it
    setRow(id, cb.checked ? (m.higher_is_worse === false ? -1 : 1) : 0);
    markCustom(); updateWeightSummary();
  }));
  document.querySelectorAll('.weight-slider').forEach(sl => sl.addEventListener('input', () => {
    setRow(sl.dataset.id, +sl.value); markCustom(); updateWeightSummary();
  }));
  document.querySelectorAll('.weight-num').forEach(n => n.addEventListener('change', () => {
    setRow(n.dataset.id, +n.value); markCustom(); updateWeightSummary();
  }));
}

function markCustom() {
  if ($('scenario-select').value !== '__custom') { $('scenario-select').value = '__custom'; $('scenario-hint').textContent = 'Custom weights.'; }
}

function currentWeights() {
  const w = {};
  document.querySelectorAll('.weight-num').forEach(n => { const v = +n.value; if (v) w[n.dataset.id] = v; });
  return w;
}

function updateWeightSummary() {
  const w = currentWeights(), n = Object.keys(w).length;
  $('sel-count').textContent = `${n} selected`;
  document.querySelectorAll('.cat-section').forEach(sec => {
    const c = [...sec.querySelectorAll('.weight-num')].filter(x => +x.value).length;
    sec.querySelector('.cat-sel-count').textContent = c ? `${c} ✓` : '';
  });
}

function unitWeights() {
  for (const [id, v] of Object.entries(currentWeights())) setRow(id, Math.sign(v));
  markCustom(); updateWeightSummary();
}

/* ── Run ─────────────────────────────────────────────────── */
function runPTI() {
  const weights = currentWeights();
  if (!Object.keys(weights).length) return alert('Give at least one indicator a non-zero weight.');
  S.run = { weights, scheme: $('scenario-select').value, schemeLabel: $('scenario-select').selectedOptions[0]?.text, date: new Date() };
  S.robust = null; resetMapVar();
  renderAll();
  $('results-toggle').style.display = ''; $('save-run-btn').style.display = '';
  $('last-run-label').textContent = `Run at ${S.run.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  $('last-run-label').style.display = 'inline';
  openDrawer();
  const btn = $('calc-btn');
  btn.innerHTML = '✓ Done'; btn.style.background = '#27ae60';
  setTimeout(() => { btn.style.background = ''; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polygon points="3,1 13,7 3,13" fill="currentColor"/></svg> Run PTI'; }, 1200);
}

/* Compute the PTI at the level shown and build the result rows */
function renderAll() {
  if (!S.run) return;
  const T = S.levelByKey[S.level];
  S.res = PTICore.computePTI(S.model, S.level, S.run.weights, opts());
  S.groups = PTICore.priorityGroups(S.res.score, S.bins);
  const parents = S.levels.slice(0, T.rank);
  const missingIds = i => S.res.parts.filter(p => p.z[i] == null).map(p => p.id);
  S.rows = T.rows.map((r, i) => ({
    i, code: r[T.code], name: r[T.name], parents: parents.map(p => r[p.name]),
    score: S.res.score[i], priority: S.groups.priority[i], population: r.population ?? null,
    missing: S.res.score[i] == null || S.cfg.missing === 'ignore' ? missingIds(i) : [],
  }));
  if (S.robust) S.rows.forEach(r => { r.robust = S.robust.freq[r.i]; });
  if (S.portfolio) attachPortfolio();
  rankRows();
  updateLevelNote(); updateCoverageChip();
  renderMap(); buildTable(filterRows());
  if ($('drawer-dist').classList.contains('active')) renderDistribution();
  if ($('drawer-portfolio').classList.contains('active')) renderPortfolio();
  if ($('compare-select').value) onCompare();
  $('map-empty').classList.add('hidden');
}

function rankRows() {
  const scored = S.rows.filter(r => r.score != null).sort((a, b) => b.score - a.score);
  scored.forEach((r, k) => { r.rank = k + 1; });
  S.rows.filter(r => r.score == null).forEach(r => { r.rank = null; });
  S.rows.sort((a, b) => (a.rank ?? 1e12) - (b.rank ?? 1e12));
}

/* Which indicators are native, projected from a coarser level, or excluded */
function updateLevelNote() {
  const el = $('level-note');
  const proj = S.res.parts.filter(p => p.via === 'projected');
  const agg = S.res.parts.filter(p => p.via === 'aggregated');
  const lines = [];
  if (proj.length) lines.push(`Projected from a coarser level (same value for every unit inside it): ${proj.map(p => `${S.ind.get(p.id).label} (${levelLabel(p.from)})`).join(', ')}.`);
  if (agg.length) lines.push(`Averaged from finer-level z-scores (devPTIpack code mode): ${agg.map(p => `${S.ind.get(p.id).label} (${levelLabel(p.from)})`).join(', ')}.`);
  if (S.res.excluded.length) lines.push(`<b>Not used at ${esc(levelLabel(S.level))} level</b> — only available at finer levels: ${S.res.excluded.map(id => esc(S.ind.get(id).label)).join(', ')}.`);
  el.innerHTML = lines.map(l => `<div>${l.startsWith('<b>') ? l : esc(l)}</div>`).join('');
  el.className = lines.length ? 'level-note warn' : 'level-note';
}

function updateCoverageChip() {
  const chip = $('coverage-chip');
  const none = S.rows.filter(r => r.score == null).length;
  if (!none && S.cfg.missing !== 'ignore') { chip.style.display = 'none'; return; }
  const counts = {};
  for (const r of S.rows) for (const id of r.missing) counts[id] = (counts[id] || 0) + 1;
  const detail = Object.entries(counts).map(([id, n]) => `${S.ind.get(id).label}: ${n.toLocaleString()} missing`);
  if (!detail.length && !none) { chip.style.display = 'none'; return; }
  chip.style.display = '';
  chip.textContent = S.cfg.missing === 'ignore'
    ? `${Object.values(counts).reduce((a, b) => Math.max(a, b), 0).toLocaleString()} scored without some data`
    : `${none.toLocaleString()} of ${S.rows.length.toLocaleString()} have no data`;
  chip.title = (S.cfg.missing === 'ignore'
    ? 'Missing values are left out of the sum for those units (missing: ignore).'
    : 'Units missing any selected indicator get no score and no priority (devPTIpack default).') + '\n\n' + detail.join('\n');
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
  return {
    under: [{ sourcetype: 'raster', below: 'traces', source: bm.tiles, sourceattribution: bm.attribution || '' }],
    labels: bm.labels ? [{ sourcetype: 'raster', source: bm.labels }] : [],
  };
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

function drawBaseMap() {
  const { under, labels } = baseLayers(), ov = overlayLayersAndTraces();
  Plotly.react('map-plotly', [{ type: 'scattermap', lat: [], lon: [], showlegend: false }, ...ov.traces],
    { map: { style: 'white-bg', layers: [...under, ...ov.layers, ...labels], ...mapView() }, margin: { t: 0, b: 0, l: 0, r: 0 }, uirevision: S.cfg.id, showlegend: false },
    { responsive: true, displayModeBar: false });
}

/* Discrete colours for m priority groups, Priority 1 first */
function groupColors(m) {
  if (m <= 1) return [RDYLBU[1]];
  return Array.from({ length: m }, (_, k) => RDYLBU[Math.round(k * (RDYLBU.length - 1) / (m - 1))]);
}

/* Values for the map variable at the level shown: { z, text, scale, legend } */
function mapValues(T) {
  const look = new Map(S.rows.map(r => [String(r.code), r]));
  if (S.mapVar === 'indicator') return explorerValues(T);
  if (!S.run) return null;
  if (S.mapVar === 'robust' && S.robust) {
    return { get: r => (r.robust != null ? r.robust * 100 : null), scale: ROBUST_SCALE, zmin: 0, zmax: 100, look,
      legend: { title: `Robustness — in top ${Math.round(S.robust.topShare * 100)}%`, ticks: ['0%', '50%', '100%'], low: 'Rarely', high: 'Always' } };
  }
  if (S.mapVar === 'score') {
    const v = S.rows.map(r => r.score).filter(isNum), a = Math.max(1e-9, ...v.map(Math.abs));
    return { get: r => r.score, scale: DIV_SCALE, zmin: -a, zmax: a, look,
      legend: { title: 'PTI score (Σ weight × z)', ticks: [fmt(-a, 2), '0', fmt(a, 2)], low: 'Lower priority', high: 'Higher priority' } };
  }
  const m = S.groups.groups, cols = groupColors(m);
  const steps = [];
  [...cols, NO_DATA].forEach((c, k, arr) => { steps.push([k / arr.length, c], [(k + 1) / arr.length, c]); });
  return { get: r => (r.priority ?? m + 1), scale: steps, zmin: 0.5, zmax: m + 1.5, look, discrete: { m, cols } };
}

/* Data explorer: one indicator's values, at this level if available there,
 * else the coarser level it would be projected from */
function explorerValues(T) {
  const id = S.explorerId;
  const m = S.ind.get(id);
  if (!m) return null;
  let src = T, note = '';
  if (!m.levels.includes(T.key)) {
    const coarser = S.levels.slice(0, T.rank).filter(l => m.levels.includes(l.key));
    if (!coarser.length) return { empty: `${m.label} is not available at ${T.label} level or coarser.` };
    src = coarser[coarser.length - 1]; note = ` (${src.label} value)`;
  }
  const val = r => {
    if (src === T) return isNum(r[id]) ? r[id] : null;
    const i = src.index.get(String(r[src.code]));
    return i === undefined ? null : (isNum(src.rows[i][id]) ? src.rows[i][id] : null);
  };
  const vals = T.rows.map(val), f = vals.filter(isNum);
  const lo = Math.min(...f), hi = Math.max(...f);
  const look = new Map(T.rows.map((r, i) => [String(r[T.code]), { code: r[T.code], name: r[T.name], value: vals[i] }]));
  const scale = m.higher_is_worse === false ? SEQ_SCALE.map(([t, c], k, a) => [t, a[a.length - 1 - k][1]]) : SEQ_SCALE;
  return { get: r => r.value, scale, zmin: lo, zmax: hi === lo ? lo + 1 : hi, look, explorer: true,
    legend: { title: `${m.label}${note}${m.unit ? ` · ${m.unit}` : ''}`, ticks: [fmt(lo), fmt((lo + hi) / 2), fmt(hi)],
      low: m.higher_is_worse === false ? 'worse' : '', high: m.higher_is_worse === false ? 'better' : (m.higher_is_worse ? 'worse' : '') } };
}

function renderMap() {
  const T = S.levelByKey[S.level];
  const gj = S.geo[T.key];
  if (!gj) {
    if (S.run) {
      $('map-empty').classList.remove('hidden');
      $('map-empty').querySelector('.empty-sub').textContent = `${T.label} boundaries loading… results are in the drawer below.`;
    }
    return;
  }
  const mv = mapValues(T);
  if (!mv) return;
  if (mv.empty) { alert(mv.empty); return; }
  const ids = [], z = [], text = [];
  for (const f of gj.features) {
    const id = String(f.properties[T.code]);
    const r = mv.look.get(id);
    ids.push(id);
    z.push(r ? mv.get(r) : null);
    const nm = esc(f.properties[T.name] ?? id);
    if (mv.explorer) text.push(`<b>${nm}</b><br>${r && r.value != null ? fmt(r.value) : 'No data'}`);
    else text.push(r ? `<b>${nm}</b><br>PTI ${r.score == null ? 'no data' : fmt(r.score, 3)}${r.priority ? ` · Priority ${r.priority}${r.priority === 1 ? ' (highest)' : ''}` : ''}${r.robust != null ? `<br>Top group in ${Math.round(r.robust * 100)}% of draws` : ''}` : `<b>${nm}</b>`);
  }
  const trace = {
    type: 'choroplethmap', geojson: gj, locations: ids, z, text, hoverinfo: 'text',
    featureidkey: `properties.${T.code}`, colorscale: mv.scale, zmin: mv.zmin, zmax: mv.zmax,
    marker: { opacity: 0.82, line: { width: T.rank === S.levels.length - 1 ? 0.2 : 0.6, color: '#fff' } }, showscale: false,
  };
  const { under, labels } = baseLayers(), ov = overlayLayersAndTraces();
  const div = $('map-plotly');
  const view = S.mapRendered && div._fullLayout?.map ? { center: div._fullLayout.map.center, zoom: div._fullLayout.map.zoom } : mapView();
  const layout = {
    map: { style: 'white-bg', layers: [...under, ...ov.layers, ...labels], ...view },
    margin: { t: 0, b: 0, l: 0, r: 0 }, uirevision: S.cfg.id, showlegend: false, dragmode: S.aoiMode ? 'lasso' : 'pan',
  };
  const cfg = { responsive: true, displayModeBar: false };
  if (!S.mapRendered) {
    Plotly.newPlot(div, [trace, ...ov.traces], layout, cfg);
    S.mapRendered = true;
    div.on('plotly_click', onMapClick);
    div.on('plotly_selected', onAOISelected);
    div.on('plotly_deselect', clearAOI);
  } else {
    Plotly.react(div, [trace, ...ov.traces], layout, cfg);
  }
  S.mapIds = ids;
  updateLegend(mv);
  $('map-empty').classList.add('hidden');
}

function updateLegend(mv) {
  $('map-legend').classList.add('visible');
  if (mv.discrete) {
    $('legend-title').textContent = `PTI priority · ${levelLabel(S.level)}`;
    $('legend-continuous').style.display = 'none';
    const counts = {};
    S.rows.forEach(r => { const k = r.priority ?? 0; counts[k] = (counts[k] || 0) + 1; });
    const g = S.groups;
    const items = mv.discrete.cols.map((c, k) => {
      const p = k + 1, lab = g.categorical ? g.labels[k] : `${fmt(g.labels[k][0], 2)} – ${fmt(g.labels[k][1], 2)}`;
      return `<div class="lg-row"><span class="lg-sw" style="background:${c}"></span><span class="lg-name">Priority ${p}${p === 1 ? ' <i>(highest)</i>' : ''}</span><span class="lg-int">${lab}</span><span class="lg-n">${counts[p] || 0}</span></div>`;
    });
    if (counts[0]) items.push(`<div class="lg-row"><span class="lg-sw" style="background:${NO_DATA}"></span><span class="lg-name">No data</span><span class="lg-int"></span><span class="lg-n">${counts[0]}</span></div>`);
    $('legend-classes').innerHTML = items.join('');
    $('legend-classes').style.display = '';
    $('legend-caveat').textContent = 'Equal-size quantile groups of the PTI at this level. Relative ranking — depends on the indicators and weights chosen.';
  } else {
    $('legend-classes').style.display = 'none';
    $('legend-continuous').style.display = '';
    $('legend-title').textContent = mv.legend.title;
    $('legend-gradient').style.background = `linear-gradient(to right, ${mv.scale.map(s => s[1]).join(',')})`;
    $('legend-ticks').innerHTML = mv.legend.ticks.map(t => `<span>${esc(t)}</span>`).join('');
    $('legend-low').textContent = mv.legend.low; $('legend-high').textContent = mv.legend.high;
    $('legend-caveat').textContent = mv.explorer ? 'Data explorer — raw indicator values.' : 'Relative ranking — depends on the indicators and weights chosen.';
  }
}

function onMapClick(ev) {
  if (S.aoiMode) return;
  const pt = ev.points[0];
  if (!pt) return;
  if (pt.curveNumber !== 0) {
    const rect = $('map-area').getBoundingClientRect();
    showTooltip((pt.bbox?.x1 ?? 200) - rect.left, (pt.bbox?.y1 ?? 200) - rect.top, pt.text);
    return;
  }
  hideTooltip();
  if (S.run) showUnitPanel(S.mapIds[pt.pointIndex]);
}

function showTooltip(x, y, html) {
  const tt = $('map-tooltip');
  tt.innerHTML = `${html}<div class="tt-row" style="margin-top:6px;font-size:10px;opacity:.5">Esc to close</div>`;
  tt.style.display = 'block';
  tt.style.left = Math.min(x + 14, $('map-area').offsetWidth - 240) + 'px';
  tt.style.top = Math.min(y + 10, $('map-area').offsetHeight - 140) + 'px';
}
function hideTooltip() { $('map-tooltip').style.display = 'none'; }

/* ── Unit profile ────────────────────────────────────────── */
/* Raw value of indicator `id` behind unit i's z-score (native or parent's) */
function rawValue(part, T, i) {
  if (part.via === 'native') return T.rows[i][part.id];
  if (part.via === 'projected') {
    const P = S.levelByKey[part.from], j = P.index.get(String(T.rows[i][P.code]));
    return j === undefined ? null : P.rows[j][part.id];
  }
  return null;
}

function showUnitPanel(code) {
  const T = S.levelByKey[S.level];
  const r = S.rows.find(x => String(x.code) === String(code));
  if (!r) return;
  const terms = PTICore.contributions(S.res.parts, r.i).sort((a, b) => Math.abs(b.term ?? 0) - Math.abs(a.term ?? 0));
  const maxAbs = Math.max(1e-9, ...terms.map(t => Math.abs(t.term ?? 0)));
  $('unit-title').textContent = T.label;
  const pf = r.projects != null ? `<span><span>Projects</span><b>${r.projects}</b></span>` : '';
  $('unit-body').innerHTML = `
    <div class="unit-head"><b>${esc(r.name ?? r.code)}</b>${r.parents?.length ? `<div class="muted small">${esc(r.parents.filter(Boolean).join(' · '))}</div>` : ''}</div>
    <div class="unit-score"><span class="tt-score">${r.score == null ? '—' : fmt(r.score, 3)}</span>
      ${r.priority ? `<span class="prio-badge" style="background:${groupColors(S.groups.groups)[r.priority - 1]}">Priority ${r.priority}</span>` : '<span class="prio-badge nodata">No data</span>'}
      ${r.rank ? `<span class="muted small">rank ${r.rank} of ${S.rows.filter(x => x.rank).length.toLocaleString()}</span>` : ''}</div>
    <div class="unit-kv">
      ${r.population != null ? `<span><span>Population</span><b>${Math.round(r.population).toLocaleString()}</b></span>` : ''}
      ${r.missing.length ? `<span><span>Missing</span><b>${esc(r.missing.map(id => S.ind.get(id).label).join(', '))}</b></span>` : ''}
      ${r.robust != null ? `<span><span>Top group in</span><b>${Math.round(r.robust * 100)}% of draws</b></span>` : ''}
      ${pf}
    </div>
    <div class="unit-sub">PTI = Σ weight × z-score</div>
    <table class="unit-table"><thead><tr><th>Indicator</th><th>Value</th><th>z</th><th>w</th><th>w × z</th></tr></thead><tbody>
    ${terms.map(t => {
      const m = S.ind.get(t.id), part = S.res.parts.find(p => p.id === t.id), raw = rawValue(part, T, r.i);
      const via = t.via === 'native' ? '' : `<span class="via" title="${t.via === 'projected' ? 'Projected: the ' + esc(levelLabel(t.from)) + "'s z-score, normalised among " + esc(levelLabel(t.from).toLowerCase()) + ' units' : 'Mean of ' + esc(levelLabel(t.from).toLowerCase()) + ' z-scores'}">${esc(levelLabel(t.from))}</span>`;
      const bar = t.term == null ? '' : `<div class="term-bar"><div class="${t.term >= 0 ? 'pos' : 'neg'}" style="width:${Math.abs(t.term) / maxAbs * 50}%;${t.term >= 0 ? 'left:50%' : `right:50%`}"></div></div>`;
      return `<tr><td title="${esc(m.source_note || '')}">${esc(m.label)}${via}</td>
        <td>${raw == null || !isNum(raw) ? '<span class="muted">—</span>' : fmt(raw)}${m.unit && isNum(raw) ? ` <span class="muted">${esc(m.unit)}</span>` : ''}</td>
        <td>${t.z == null ? '<span class="muted">n/a</span>' : fmt(t.z, 2)}</td>
        <td class="${t.weight > 0 ? 'wpos' : 'wneg'}">${t.weight > 0 ? '+' : ''}${t.weight}</td>
        <td>${bar}${t.term == null ? '' : fmt(t.term, 2)}</td></tr>`;
    }).join('')}
    </tbody></table>
    <div class="muted small unit-foot">z = how many standard deviations the value is from the mean of all ${esc((terms.length ? levelLabel(terms[0].from) : T.label).toLowerCase())}-level units it is normalised among.${S.res.excluded.length ? ` Not used at this level: ${esc(S.res.excluded.map(id => S.ind.get(id).label).join(', '))}.` : ''}</div>`;
  $('unit-panel').style.display = '';
}
function hideUnitPanel() { $('unit-panel').style.display = 'none'; }

function fmt(v, d) {
  if (!isNum(v)) return '—';
  if (d != null) return (+v.toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d });
  const a = Math.abs(v);
  return a >= 1000 ? Math.round(v).toLocaleString() : a >= 100 ? v.toFixed(0) : a >= 1 ? String(+v.toFixed(2)) : String(+v.toPrecision(3));
}

/* ── Table ───────────────────────────────────────────────── */
function buildTable(rows) {
  const T = S.levelByKey[S.level];
  const parents = S.levels.slice(0, T.rank);
  const hasPop = rows.some(r => r.population != null);
  const hasRob = rows.some(r => r.robust != null);
  const hasPf = rows.some(r => r.projects != null);
  const cols = groupColors(S.groups.groups);
  const th = (k, t, tip = '') => `<th data-sort="${k}"${tip ? ` title="${esc(tip)}"` : ''}>${esc(t)}</th>`;
  let head = th('rank', 'Rank') + th('name', T.label) + parents.map((p, k) => th(`p${k}`, p.label)).join('') +
    th('score', 'PTI score', 'Σ weight × z-score') + th('priority', 'Priority', 'Priority 1 = highest PTI group');
  if (hasPop) head += th('population', 'Population');
  if (hasRob) head += th('robust', 'Robustness', 'Share of random-weight runs with the unit in the top group');
  if (hasPf) head += th('projects', 'Projects');
  head += th('missing', 'Missing data');
  const body = rows.slice(0, 3000).map(r => {
    let t = `<tr data-code="${esc(r.code)}"><td class="muted"><b>${r.rank ?? '—'}</b></td><td>${esc(r.name ?? r.code)}</td>` +
      parents.map((_, k) => `<td class="muted">${esc(r.parents?.[k] ?? '')}</td>`).join('') +
      `<td class="num">${r.score == null ? '<span class="muted">no data</span>' : fmt(r.score, 3)}</td>
       <td>${r.priority ? `<span class="prio-badge" style="background:${cols[r.priority - 1]}">Priority ${r.priority}</span>` : '<span class="prio-badge nodata">No data</span>'}</td>`;
    if (hasPop) t += `<td class="muted num">${r.population != null ? Math.round(r.population).toLocaleString() : '—'}</td>`;
    if (hasRob) t += `<td class="muted">${r.robust != null ? Math.round(r.robust * 100) + '%' : '—'}</td>`;
    if (hasPf) t += `<td class="muted">${r.projects ?? ''}</td>`;
    t += `<td class="muted small">${esc(r.missing.map(id => S.ind.get(id).label).join(', '))}</td>`;
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
  return S.rows.filter(r => [r.name, r.code, r.priority && `priority ${r.priority}`, ...(r.parents || [])].some(x => String(x ?? '').toLowerCase().includes(q)));
}

function sortBy(col) {
  if (S.sortCol === col) S.sortAsc = !S.sortAsc; else { S.sortCol = col; S.sortAsc = ['name', 'rank', 'priority'].includes(col) || /^p\d+$/.test(col); }
  const get = r => (/^p\d+$/.test(col) ? r.parents?.[+col.slice(1)] : col === 'missing' ? r.missing.length : r[col]);
  S.rows.sort((a, b) => {
    const av = get(a), bv = get(b);
    if (av == null) return 1; if (bv == null) return -1;
    const c = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return S.sortAsc ? c : -c;
  });
  buildTable(filterRows());
}

/* ── Distribution ────────────────────────────────────────── */
function renderDistribution() {
  if (!S.run) return;
  const T = S.levelByKey[S.level], m = S.groups.groups, cols = groupColors(m);
  const scored = S.rows.filter(r => r.score != null);
  const traces = Array.from({ length: m }, (_, k) => {
    const p = k + 1, v = scored.filter(r => r.priority === p).map(r => r.score);
    return { type: 'histogram', x: v, name: `Priority ${p}`, marker: { color: cols[k] }, nbinsx: 40, opacity: 0.9 };
  });
  Plotly.react('dist-hist-div', traces, {
    barmode: 'stack', xaxis: { title: 'PTI score (Σ weight × z)' }, yaxis: { title: `${T.label} units` },
    title: { text: 'PTI distribution by priority group', font: { size: 13 } }, legend: { x: 1, xanchor: 'right', y: 1, font: { size: 10 } },
    margin: { t: 36, b: 44, l: 50, r: 20 }, height: 248, bargap: 0.05, plot_bgcolor: '#fff', paper_bgcolor: '#fff',
  }, { responsive: true, displayModeBar: false });

  const hasPop = scored.some(r => r.population != null);
  const by = Array.from({ length: m }, (_, k) => {
    const g = scored.filter(r => r.priority === k + 1);
    return { n: g.length, pop: g.reduce((s, r) => s + (r.population || 0), 0) };
  });
  const totPop = by.reduce((s, b) => s + b.pop, 0);
  Plotly.react('dist-bar-div', [{
    type: 'bar', x: by.map((_, k) => `Priority ${k + 1}`), y: hasPop ? by.map(b => b.pop / totPop * 100) : by.map(b => b.n),
    marker: { color: cols }, text: by.map(b => `${b.n} units`), textposition: 'auto',
    hovertemplate: hasPop ? '%{x}: %{y:.1f}% of population<extra></extra>' : '%{x}: %{y} units<extra></extra>',
  }], {
    yaxis: { title: hasPop ? '% of population' : 'units' }, title: { text: hasPop ? 'Population by priority group' : 'Units by priority group', font: { size: 13 } },
    margin: { t: 36, b: 44, l: 50, r: 20 }, height: 248, plot_bgcolor: '#fff', paper_bgcolor: '#fff',
  }, { responsive: true, displayModeBar: false });
}

/* ── Sensitivity: compare schemes, random weights ────────── */
function saveRun() {
  if (!S.run) return;
  const def = `${S.run.schemeLabel || 'Custom'} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const name = prompt('Name these weights:', def);
  if (!name || !name.trim()) return;
  S.savedRuns.push({ name: name.trim(), date: new Date().toISOString(), weights: S.run.weights });
  if (S.savedRuns.length > 20) S.savedRuns.shift();
  try { localStorage.setItem(runsKey(), JSON.stringify(S.savedRuns)); } catch (_) { alert('Could not store the weights in this browser.'); }
  updateCompareSelect();
}

function updateCompareSelect() {
  const sel = $('compare-select'), cur = sel.value;
  const sc = (S.cfg?.scenarios || []).map(s => `<option value="s:${esc(s.id)}">${esc(s.label)}</option>`).join('');
  const sv = S.savedRuns.map((r, i) => `<option value="r:${i}">${esc(r.name)} (saved)</option>`).join('');
  sel.innerHTML = `<option value="">— pick a scheme or saved run —</option>${sc ? `<optgroup label="Schemes">${sc}</optgroup>` : ''}${sv ? `<optgroup label="Saved">${sv}</optgroup>` : ''}`;
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}

/* Rank correlation and Priority 1 overlap with another set of weights */
function onCompare() {
  const v = $('compare-select').value, out = $('compare-stats');
  if (!v || !S.run) { out.textContent = ''; return; }
  const w = v.startsWith('s:') ? (S.cfg.scenarios.find(s => s.id === v.slice(2)) || {}).weights : S.savedRuns[+v.slice(2)]?.weights;
  if (!w) return;
  const other = PTICore.computePTI(S.model, S.level, w, opts());
  const g2 = PTICore.priorityGroups(other.score, S.bins);
  const rho = PTICore.spearman(S.res.score, other.score);
  const a = new Set(), b = new Set();
  S.groups.priority.forEach((p, i) => { if (p === 1) a.add(i); });
  g2.priority.forEach((p, i) => { if (p === 1) b.add(i); });
  let both = 0; for (const i of a) if (b.has(i)) both++;
  let moved = 0; S.groups.priority.forEach((p, i) => { if (p != null && g2.priority[i] != null && p !== g2.priority[i]) moved++; });
  out.innerHTML = `Spearman <b>${rho == null ? '—' : rho.toFixed(2)}</b> · Priority 1 overlap <b>${a.size ? Math.round(both / a.size * 100) : 0}%</b> (${both} of ${a.size}) · ${moved.toLocaleString()} units change group`;
}

function runRobustness() {
  if (!S.run) return alert('Run the PTI first.');
  const T = S.levelByKey[S.level];
  $('robust-body').innerHTML = '<div class="muted panel-empty">Running 200 weight draws…</div>';
  setTimeout(() => {
    S.robust = PTICore.robustness(S.res.parts, T.rows.length,
      { draws: 200, spread: +$('rob-spread').value, topShare: +$('rob-top').value, naRm: opts().naRm });
    const rb = document.querySelector('input[name=mapvar][value=robust]');
    rb.disabled = false; rb.nextElementSibling.textContent = 'Robustness (share of draws in top group)';
    renderAll();
    renderRobustPanel();
  }, 20);
}

function renderRobustPanel() {
  const r = S.robust, T = S.levelByKey[S.level];
  const always = S.rows.filter(x => x.robust >= 0.8).length;
  const unstable = S.rows.filter(x => x.robust > 0.2 && x.robust < 0.8).sort((a, b) => b.score - a.score);
  $('robust-body').innerHTML = `
    <div class="kpi-row">
      <div class="kpi"><b>${r.spearman ? r.spearman.mean.toFixed(2) : '—'}</b><span>mean rank correlation with these weights${r.spearman ? ` (min ${r.spearman.min.toFixed(2)})` : ''}</span></div>
      <div class="kpi"><b>${r.stableShare == null ? '—' : Math.round(r.stableShare * 100) + '%'}</b><span>of the top ${Math.round(r.topShare * 100)}% stay there in ≥80% of draws</span></div>
      <div class="kpi"><b>${always.toLocaleString()}</b><span>${esc(T.label.toLowerCase())} units robustly in the top group</span></div>
      <div class="kpi"><b>${unstable.length.toLocaleString()}</b><span>borderline — in the top group in 20–80% of draws</span></div>
    </div>
    <div class="robust-split">
      <div id="robust-hist"></div>
      <div class="robust-list"><div class="unit-sub">Borderline — their priority depends on the weights</div>
        ${unstable.slice(0, 40).map(x => `<div class="rl-row" data-code="${esc(x.code)}"><span>${esc(x.name ?? x.code)}</span><span class="muted">${fmt(x.score, 2)} · ${Math.round(x.robust * 100)}%</span></div>`).join('') || '<div class="muted small">None — the top group is stable.</div>'}
      </div>
    </div>
    <div class="muted small panel-foot">${r.draws} draws, each weight multiplied by a random factor in [${(1 - r.spread).toFixed(2)}, ${(1 + r.spread).toFixed(2)}]; signs and z-scores held fixed. Few or loosely correlated indicators make rankings more sensitive to weights.</div>`;
  $('robust-body').querySelectorAll('.rl-row').forEach(el => el.addEventListener('click', () => showUnitPanel(el.dataset.code)));
  const f = S.rows.map(x => x.robust).filter(isNum).map(x => x * 100);
  Plotly.newPlot('robust-hist', [{ type: 'histogram', x: f, xbins: { start: 0, end: 100.01, size: 5 }, marker: { color: '#3b82f6' } }], {
    xaxis: { title: `% of draws in the top ${Math.round(r.topShare * 100)}%`, range: [0, 100] }, yaxis: { title: `${T.label} units` },
    margin: { t: 10, b: 40, l: 50, r: 10 }, height: 170, plot_bgcolor: '#fff', paper_bgcolor: '#fff',
  }, { responsive: true, displayModeBar: false });
}

function resetMapVar() {
  if (S.mapVar === 'robust') { S.mapVar = 'priority'; document.querySelector('input[name=mapvar][value=priority]').checked = true; }
  const rb = document.querySelector('input[name=mapvar][value=robust]');
  if (rb) { rb.disabled = true; rb.nextElementSibling.textContent = 'Robustness (run it first)'; }
  if ($('robust-body')) $('robust-body').innerHTML = '<div class="muted panel-empty">Run the random-weights test for the current weights and level.</div>';
}

/* ── Layers & data explorer ──────────────────────────────── */
function buildExplorerSelect() {
  const list = [...S.ind.values()].filter(m => m.explorer !== false);
  $('explorer-select').innerHTML = list.map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
  S.explorerId = list[0]?.id || null;
}

function buildLayersPanel() {
  const ovs = S.cfg.overlays || [];
  $('layers-list').innerHTML = ovs.length ? ovs.map(o => `<label class="lyr-row">
      <input type="checkbox" data-ov="${esc(o.id)}"/> <span class="lyr-swatch lyr-${esc(o.geometry)}" style="background:${esc(o.color || '#334155')}"></span>${esc(o.label || o.id)}
      ${o.role === 'portfolio' ? '<span class="ind-level">portfolio</span>' : ''}</label>`).join('')
    : '<div class="muted small" style="padding:8px 12px">No overlays configured.</div>';
  $('layers-list').querySelectorAll('input[data-ov]').forEach(cb => cb.addEventListener('change', async () => {
    const id = cb.dataset.ov;
    if (cb.checked) { await loadOverlay(id); S.overlayOn.add(id); } else S.overlayOn.delete(id);
    if (S.run || S.mapVar === 'indicator') renderMap(); else drawBaseMap();
  }));
}

async function loadOverlay(id) {
  if (S.overlayGeo[id]) return S.overlayGeo[id];
  const ov = S.cfg.overlays.find(o => o.id === id);
  S.overlayGeo[id] = await fetchJSON(`${S.dsPath}/${ov.file}`);
  return S.overlayGeo[id];
}

/* ── Portfolio balance ───────────────────────────────────── */
async function ensurePortfolio() {
  const ov = portfolioLayer();
  if (!ov) return null;
  if (S.portfolio) return S.portfolio;
  const gj = await loadOverlay(ov.id);
  const B = S.levels[S.levels.length - 1];
  const units = [];
  let outside = 0;
  for (const f of gj.features) {
    const i = f.properties?._unit != null ? B.index.get(String(f.properties._unit)) : undefined;
    if (i === undefined) { outside++; continue; }
    units.push(i);
  }
  S.portfolio = { ov, baseIdx: units, outside, located: units.length };
  return S.portfolio;
}

function attachPortfolio() {
  const B = S.levels[S.levels.length - 1], T = S.levelByKey[S.level];
  const counts = new Map();
  for (const i of S.portfolio.baseIdx) { const c = String(B.rows[i][T.code]); counts.set(c, (counts.get(c) || 0) + 1); }
  S.rows.forEach(r => { r.projects = counts.get(String(r.code)) || 0; });
}

async function renderPortfolio() {
  const body = $('portfolio-body');
  if (!S.run) { body.innerHTML = '<div class="muted panel-empty">Run the PTI first.</div>'; return; }
  const pf = await ensurePortfolio();
  if (!pf) return;
  attachPortfolio(); buildTable(filterRows());
  const T = S.levelByKey[S.level], m = S.groups.groups, cols = groupColors(m);
  const hasPop = S.rows.some(r => r.population != null);
  const by = Array.from({ length: m }, () => ({ base: 0, proj: 0 }));
  let tb = 0, tp = 0;
  for (const r of S.rows) {
    if (!r.priority) continue;
    const b = by[r.priority - 1], x = hasPop ? (r.population || 0) : 1;
    b.base += x; b.proj += r.projects; tb += x; tp += r.projects;
  }
  const gaps = S.rows.filter(r => r.priority === 1 && !r.projects).sort((a, b) => b.score - a.score);
  const lbl = hasPop ? 'population' : `${T.label.toLowerCase()} units`;
  body.innerHTML = `
    <div class="kpi-row">
      <div class="kpi"><b>${pf.located}</b><span>${esc(pf.ov.label)} located${pf.outside ? ` (${pf.outside} outside the study area)` : ''}</span></div>
      <div class="kpi"><b>${tp ? Math.round(by[0].proj / tp * 100) : 0}%</b><span>of projects in Priority 1 ${esc(T.label.toLowerCase())} units, which hold ${tb ? Math.round(by[0].base / tb * 100) : 0}% of ${lbl}</span></div>
      <div class="kpi"><b>${tp ? Math.round(by.slice(Math.max(1, m - 2)).reduce((s, b) => s + b.proj, 0) / tp * 100) : 0}%</b><span>of projects in the two lowest-priority groups</span></div>
      <div class="kpi"><b>${gaps.length.toLocaleString()}</b><span>Priority 1 ${esc(T.label.toLowerCase())} units with no project</span></div>
    </div>
    <div class="robust-split">
      <div id="portfolio-chart"></div>
      <div class="robust-list"><div class="unit-sub">Priority 1 without a project</div>
        ${gaps.slice(0, 40).map(x => `<div class="rl-row" data-code="${esc(x.code)}"><span>${esc(x.name ?? x.code)}</span><span class="muted">${fmt(x.score, 2)}</span></div>`).join('') || '<div class="muted small">None.</div>'}
      </div>
    </div>
    <div class="muted small panel-foot">Project sites should not be chosen on the PTI alone — complement it with field knowledge and record site-level challenges.</div>`;
  body.querySelectorAll('.rl-row').forEach(el => el.addEventListener('click', () => showUnitPanel(el.dataset.code)));
  const xs = by.map((_, k) => `Priority ${k + 1}`);
  Plotly.newPlot('portfolio-chart', [
    { type: 'bar', name: `Share of ${lbl}`, x: xs, y: by.map(b => (tb ? b.base / tb * 100 : 0)), marker: { color: '#cbd5e1' } },
    { type: 'bar', name: 'Share of projects', x: xs, y: by.map(b => (tp ? b.proj / tp * 100 : 0)), marker: { color: cols } },
  ], {
    barmode: 'group', yaxis: { title: '%', rangemode: 'tozero' }, legend: { orientation: 'h', y: 1.15 },
    margin: { t: 20, b: 40, l: 44, r: 10 }, height: 200, plot_bgcolor: '#fff', paper_bgcolor: '#fff',
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
  if (!S.run) return;
  const pts = (ev?.points || []).filter(p => p.curveNumber === 0);
  const sel = pts.map(p => S.rows.find(r => String(r.code) === String(S.mapIds[p.pointIndex]))).filter(Boolean);
  if (!sel.length) return;
  const sc = sel.filter(r => r.score != null), v = sc.map(r => r.score).sort((a, b) => a - b), n = v.length;
  const p1 = sel.filter(r => r.priority === 1).length;
  const pop = sel.reduce((s, r) => s + (r.population || 0), 0);
  $('aoi-clear-btn').style.display = '';
  $('aoi-title').textContent = `${sel.length.toLocaleString()} ${S.levelByKey[S.level].label.toLowerCase()} units selected`;
  $('aoi-stats').innerHTML = `<div class="aoi-grid">
    ${n ? `<span>Mean PTI</span><b>${fmt(v.reduce((a, b) => a + b, 0) / n, 2)}</b>
    <span>Median</span><b>${fmt(v[Math.floor(n / 2)], 2)}</b>` : ''}
    <span>Priority 1</span><b>${Math.round(p1 / sel.length * 100)}%</b>
    ${pop ? `<span>Population</span><b>${Math.round(pop).toLocaleString()}</b>` : ''}
    ${sel[0].projects != null ? `<span>Projects</span><b>${sel.reduce((s, r) => s + (r.projects || 0), 0)}</b>` : ''}</div>`;
  const m = S.groups.groups, cols = groupColors(m);
  Plotly.newPlot('aoi-hist', [{ type: 'bar', x: cols.map((_, k) => `P${k + 1}`), y: cols.map((_, k) => sel.filter(r => r.priority === k + 1).length), marker: { color: cols } }],
    { margin: { t: 4, b: 22, l: 28, r: 4 }, height: 100, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', xaxis: { tickfont: { size: 9 } }, yaxis: { tickfont: { size: 9 } } },
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
    id: m.id, label: m.label, pillar: m.pillar || '', levels: m.levels.map(levelLabel).join(', '),
    prepared: Object.entries(m.provenance || {}).map(([k, v]) => `${levelLabel(k)}: ${v}`).join('; '),
    unit: m.unit || '', source: m.source_note || '', year: m.year ?? '',
    filled: Object.entries(m.filled || {}).map(([k, n]) => `${n} at ${levelLabel(k)} (${m.fill})`).join('; '),
    in_pti: m.pti === false ? 'no (explorer only)' : 'yes',
    higher_is: m.higher_is_worse == null ? '' : m.higher_is_worse ? 'worse' : 'better',
  }));
}

function showAbout() {
  if (!S.cfg) return;
  const c = S.cfg;
  const sc = (c.scenarios || []).map(s => `<li><b>${esc(s.label)}</b>${s.description ? ` — ${esc(s.description)}` : ''}<br><span class="muted small">${
    Object.entries(s.weights).map(([id, w]) => `${esc(S.ind.get(id)?.label || id)} ${w > 0 ? '+' : ''}${w}`).join(' · ')}</span></li>`).join('');
  const dict = dictionaryRows();
  $('about-body').innerHTML = `
    <p class="about-lead">The Project Targeting Index (PTI) combines development indicators into one composite index to inform
    geographic targeting, following the World Bank's <a href="https://worldbank.github.io/devPTIpack/articles/methodology.html" target="_blank" rel="noopener">devPTIpack methodology</a>.
    It is a tool for evidence-based discussion; site selection should also draw on field knowledge.</p>
    <h4>How the index is built</h4>
    <ol class="about-steps">
      <li><b>Normalise.</b> Each indicator is converted to a z-score, (value − mean) / standard deviation, among the units of each
        spatial level separately — districts are compared with districts, regions with regions.</li>
      <li><b>Project.</b> At a level where an indicator is not available, each unit takes the z-score of the coarser unit it lies in,
        as normalised at that coarser level.${c.cross_level === 'devptipack_code'
          ? ' This dataset also averages finer-level z-scores up to coarser units where an indicator is only available finer (as the devPTIpack R code does).'
          : ' Finer-level data is not aggregated upward; coarser-level values are prepared in advance where needed.'}</li>
      <li><b>Weight and sum.</b> PTI = Σ weight × z-score. A positive weight means higher values raise priority; a negative weight
        means they lower it. A weight of 2 counts twice as much as a weight of 1.</li>
      <li><b>Group.</b> Units are ranked and split into ${S.bins} equal-size groups (quantiles). Priority 1 is the highest PTI.
        ${c.missing === 'ignore' ? 'Units missing an indicator are scored on the indicators they have.' : 'Units missing any selected indicator get no score and no priority.'}</li>
    </ol>
    <h4>Choosing weights</h4>
    <p>Weights are agreed by consensus: experiment with combinations, check how sensitive the ranking is (Sensitivity tab: scheme
    comparison and random weights), then settle on weights with the project team and government counterparts. A ranking is robust
    when the top-priority areas stay largely the same under reasonable changes in weights. Rankings are most sensitive when few, or
    loosely correlated, indicators are used.</p>
    ${sc ? `<h4>Weighting schemes</h4><ul class="about-list">${sc}</ul>` : ''}
    <h4>Data dictionary <button class="dl-btn" id="dl-dict" style="margin-left:8px">↓ CSV</button></h4>
    <div class="about-table-wrap"><table class="r-table about-table"><thead><tr>
      <th>Indicator</th><th>Pillar</th><th>Levels</th><th>How each level was prepared</th><th>Unit</th><th>Source</th><th>Year</th><th>Filled</th>
    </tr></thead><tbody>${dict.map(d => `<tr><td>${esc(d.label)}${d.in_pti !== 'yes' ? ' <span class="muted">(explorer only)</span>' : ''}</td><td>${esc(d.pillar)}</td><td>${esc(d.levels)}</td>
      <td class="small">${esc(d.prepared)}</td><td>${esc(d.unit)}</td><td class="small">${esc(d.source)}</td><td>${esc(d.year)}</td><td class="small">${esc(d.filled)}</td></tr>`).join('')}</tbody></table></div>
    <h4>Keeping it current</h4>
    <p>Revisit indicators and weights as conditions and objectives change, and document site-level implementation challenges so
    future targeting draws on both the index and operational experience.</p>
    ${c.about?.disclaimer ? `<p class="about-disclaimer">${esc(c.about.disclaimer)}</p>` : ''}
    <p class="muted small">References: Finn &amp; Masaki (2020), <i>Subnational Targeting of Project Sites Using Project Targeting Index (PTI)</i>,
    Poverty and Equity Notes No. 33, World Bank · Masaki et al. (2022), <i>Dashboards for development</i>, Poverty and Equity Notes No. 47.
    · Dataset built ${esc(c.built || '')}${c.about?.contact ? ` · Contact: ${esc(c.about.contact)}` : ''}</p>`;
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
  const T = S.levelByKey[S.level];
  return [...S.rows].sort((a, b) => (a.rank ?? 1e12) - (b.rank ?? 1e12)).map(r => {
    const o = { rank: r.rank, [T.code]: r.code, [T.name]: r.name ?? '' };
    S.levels.slice(0, T.rank).forEach((p, k) => { o[p.name] = r.parents?.[k] ?? ''; });
    Object.assign(o, { pti_score: r.score, priority: r.priority });
    if (r.population != null) o.population = Math.round(r.population);
    if (r.robust != null) o.robustness = +r.robust.toFixed(3);
    if (r.projects != null) o.projects = r.projects;
    o.missing = r.missing.join(' ');
    return o;
  });
}

function downloadLevelCSV() {
  if (!S.run) return alert('Run the PTI first.');
  dl(toCSV(levelExportRows()), 'text/csv', `${fileStem()}_${S.level}_${today()}.csv`);
}

function downloadIndicatorsCSV() {
  if (!S.run) return alert('Run the PTI first.');
  const T = S.levelByKey[S.level];
  const rows = S.rows.map(r => {
    const o = { [T.code]: r.code, [T.name]: r.name ?? '', pti_score: r.score, priority: r.priority };
    for (const p of S.res.parts) {
      o[`${p.id}_value`] = rawValue(p, T, r.i);
      o[`${p.id}_from`] = p.from;
      o[`${p.id}_z`] = p.z[r.i];
      o[`${p.id}_weight`] = p.weight;
      o[`${p.id}_term`] = p.z[r.i] == null ? null : p.weight * p.z[r.i];
    }
    return o;
  });
  dl(toCSV(rows), 'text/csv', `${fileStem()}_${S.level}_indicators_${today()}.csv`);
}

function levelGeoJSON() {
  const T = S.levelByKey[S.level], gj = S.geo[T.key];
  if (!gj) return null;
  const look = new Map(levelExportRows().map(r => [String(r[T.code]), r]));
  return { type: 'FeatureCollection', features: gj.features.filter(f => look.has(String(f.properties[T.code])))
    .map(f => ({ type: 'Feature', geometry: f.geometry, properties: look.get(String(f.properties[T.code])) })) };
}

function downloadGeoJSON() {
  if (!S.run) return alert('Run the PTI first.');
  const gj = levelGeoJSON();
  if (!gj) return alert('Boundaries are still loading — try again in a moment.');
  dl(JSON.stringify(gj), 'application/geo+json', `${fileStem()}_${S.level}_${today()}.geojson`);
}

/* Everything needed to reproduce or cite a run */
function runNotes() {
  const T = S.levelByKey[S.level];
  return {
    dataset: S.cfg.id, country: S.cfg.country, dataset_built: S.cfg.built, run_at: S.run.date.toISOString(),
    weighting_scheme: S.run.schemeLabel,
    method: {
      standard: 'devPTIpack methodology — https://worldbank.github.io/devPTIpack/articles/methodology.html',
      normalisation: 'z-score per indicator among the units of each spatial level (sample standard deviation)',
      index: 'PTI = sum of weight × z-score (signed weights)',
      cross_level: S.cfg.cross_level === 'devptipack_code' ? 'project coarser z-scores down; average finer z-scores up (devPTIpack R code)' : 'project coarser z-scores down; no upward aggregation',
      missing: S.cfg.missing === 'ignore' ? 'missing terms dropped from the sum' : 'units missing any selected indicator get no score',
      level: S.level, priority_groups: S.groups.groups, group_breaks: S.groups.breaks,
    },
    indicators: S.res.parts.map(p => {
      const src = S.levelByKey[p.from], st = PTICore.stats(src.rows.map(r => r[p.id]));
      const m = S.ind.get(p.id);
      return { id: p.id, label: m.label, weight: p.weight, used_as: p.via, normalised_at: p.from,
        mean: st.mean, sd: st.sd, n_units: st.n, unit: m.unit, source: m.source_note, year: m.year,
        prepared: m.provenance?.[p.from] };
    }),
    not_used_at_this_level: S.res.excluded,
    units: { total: T.rows.length, scored: S.rows.filter(r => r.score != null).length },
    robustness: S.robust ? { draws: S.robust.draws, spread: S.robust.spread, top_share: S.robust.topShare,
      mean_rank_correlation: S.robust.spearman?.mean, stable_share: S.robust.stableShare } : null,
    interpretation: 'Relative composite index for geographic targeting; depends on the indicators and weights chosen. Complement with field knowledge.',
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
  $('agol-title').value = `${S.cfg.country || S.cfg.id} PTI ${levelLabel(S.level)} ${today()}`;
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
      description: runNotes().interpretation, tags: 'PTI,targeting,devPTIpack', snippet: `${S.run.schemeLabel || 'Custom'} · ${levelLabel(S.level)} · ${S.groups.groups} priority groups` })
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
