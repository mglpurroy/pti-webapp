/* ── PTI core — the method, with no DOM or map code ──────────
 *
 * Implements the World Bank devPTIpack methodology
 * (https://worldbank.github.io/devPTIpack/articles/methodology.html):
 *
 *   1. Normalisation  every indicator is z-scored, (x − mean) / sd, among the
 *                     units of each spatial level it is available at,
 *                     independently per level
 *   2. Projection     at a level where an indicator is not available, the
 *                     z-score of the finest coarser level that has it is
 *                     copied to every child unit — never re-normalised
 *   3. Index          PTI = Σ wⱼ · zⱼ with signed weights: a positive weight
 *                     means higher values → higher priority, a negative one
 *                     the reverse; |w| sets relative importance
 *   4. Priority       units are split into equal-size quantile groups;
 *                     Priority 1 = highest PTI
 *
 * Missing data: a unit missing any selected indicator gets no score (no
 * priority), unless naRm is set, in which case missing terms are dropped
 * from the sum (devPTIpack's na_rm_pti option).
 *
 * crossLevel 'devptipack_code' reproduces the devPTIpack R code, which also
 * averages finer-level z-scores up to coarser units when an indicator is
 * missing at the target level (preferring the finest level available). The
 * published methodology says data is not aggregated upward, which is the
 * default here ('project').
 *
 * Loaded in the browser as window.PTICore and in Node via require().
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PTICore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const isNum = v => typeof v === 'number' && Number.isFinite(v);

  /* ── Normalisation ─────────────────────────────────────────
   * Sample standard deviation (n − 1), as R's sd(). One unit, or no
   * variance, gives the neutral score 0; missing stays missing.
   */
  function zscores(values) {
    let n = 0, sum = 0, lo = Infinity, hi = -Infinity;
    for (const v of values) if (isNum(v)) { n++; sum += v; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!n) return values.map(() => null);
    const mean = sum / n;
    // Identical values: test exactly, since a floating-point mean can be an
    // ulp off and leave a spurious near-zero sd
    if (n < 2 || lo === hi) return values.map(v => (isNum(v) ? 0 : null));
    let ss = 0;
    for (const v of values) if (isNum(v)) ss += (v - mean) ** 2;
    const sd = Math.sqrt(ss / (n - 1));
    if (!(sd > 0)) return values.map(v => (isNum(v) ? 0 : null));
    return values.map(v => (isNum(v) ? (v - mean) / sd : null));
  }

  function stats(values) {
    const f = values.filter(isNum), n = f.length;
    if (!n) return { n: 0, mean: null, sd: null };
    const mean = f.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(f.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : null;
    return { n, mean, sd };
  }

  /* ── Model ────────────────────────────────────────────────
   * levels: [{ key, code }] ordered coarse → fine
   * data:   { levelKey: rows } — one row per unit of that level, carrying
   *         its own code, the codes of every coarser level, and the values
   *         of the indicators available at that level
   */
  function buildModel(levels, data) {
    const L = levels.map((l, rank) => {
      const rows = data[l.key] || [];
      const index = new Map();
      rows.forEach((r, i) => index.set(String(r[l.code]), i));
      return { ...l, rank, rows, index };
    });
    return { levels: L, byKey: Object.fromEntries(L.map(l => [l.key, l])), z: new Map(), has: new Map() };
  }

  function hasData(model, level, id) {
    const k = `${level.key}|${id}`;
    if (!model.has.has(k)) model.has.set(k, level.rows.some(r => isNum(r[id])));
    return model.has.get(k);
  }

  function zAt(model, level, id) {
    const k = `${level.key}|${id}`;
    if (!model.z.has(k)) model.z.set(k, zscores(level.rows.map(r => r[id])));
    return model.z.get(k);
  }

  function availableLevels(model, id) {
    return model.levels.filter(l => hasData(model, l, id)).map(l => l.key);
  }

  /* z-scores of indicator `id` for every unit of the target level, and
   * where they came from: { via: native|projected|aggregated|none, from, z } */
  function indicatorAt(model, targetKey, id, crossLevel = 'project') {
    const T = model.byKey[targetKey];
    if (hasData(model, T, id)) return { via: 'native', from: T.key, z: zAt(model, T, id) };
    const coarser = model.levels.slice(0, T.rank).filter(l => hasData(model, l, id));
    const finer = model.levels.slice(T.rank + 1).filter(l => hasData(model, l, id));

    if (crossLevel === 'devptipack_code' && finer.length) {
      // Mean of the finest level's z-scores within each target unit
      const F = finer[finer.length - 1], zf = zAt(model, F, id);
      const s = new Map(), c = new Map();
      F.rows.forEach((r, i) => {
        const key = String(r[T.code]);
        if (r[T.code] == null || zf[i] == null) return;
        s.set(key, (s.get(key) || 0) + zf[i]); c.set(key, (c.get(key) || 0) + 1);
      });
      const z = T.rows.map(r => { const k = String(r[T.code]); return c.get(k) ? s.get(k) / c.get(k) : null; });
      return { via: 'aggregated', from: F.key, z };
    }
    if (coarser.length) {
      // Projection: copy the parent's z-score, as normalised at its own level
      const P = coarser[coarser.length - 1], zp = zAt(model, P, id);
      const z = T.rows.map(r => { const i = P.index.get(String(r[P.code])); return i === undefined ? null : zp[i]; });
      return { via: 'projected', from: P.key, z };
    }
    return { via: 'none', from: null, z: T.rows.map(() => null) };
  }

  /* ── Index ────────────────────────────────────────────────
   * weights: { id: w } (signed; 0 = not selected)
   * Returns { score[], parts[{ id, weight, via, from, z }], excluded[] }
   */
  function computePTI(model, targetKey, weights, opts = {}) {
    const T = model.byKey[targetKey];
    const parts = [], excluded = [];
    for (const [id, w] of Object.entries(weights)) {
      if (!isNum(w) || w === 0) continue;
      const a = indicatorAt(model, targetKey, id, opts.crossLevel);
      if (a.via === 'none') { excluded.push(id); continue; }
      parts.push({ id, weight: w, ...a });
    }
    return { score: combine(parts, T.rows.length, opts.naRm), parts, excluded };
  }

  function combine(parts, n, naRm, weightsOverride) {
    const score = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, ok = true;
      for (let k = 0; k < parts.length; k++) {
        const z = parts[k].z[i];
        if (z == null) { if (!naRm) { ok = false; break; } continue; }
        s += (weightsOverride ? weightsOverride[k] : parts[k].weight) * z;
      }
      score[i] = ok ? s : null;
    }
    return score;
  }

  /* ── Priority groups ──────────────────────────────────────
   * As devPTIpack's legend: breaks are R type-7 quantiles at 0, 1/n … 1
   * (duplicates dropped), intervals are right-closed with the lowest
   * included. Integer-valued scores with fewer than 12 distinct values are
   * grouped by value. Priority 1 = highest group.
   * Returns { priority[], groups, breaks, labels } where labels[p-1]
   * describes Priority p.
   */
  function quantile7(sorted, p) {
    const h = (sorted.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
    return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
  }

  function priorityGroups(scores, nBins = 5) {
    const f = scores.filter(isNum).sort((a, b) => a - b);
    const uniq = [...new Set(f)];
    if (!uniq.length) return { priority: scores.map(() => null), groups: 0, breaks: [], labels: [] };
    if (uniq.length === 1) return { priority: scores.map(s => (isNum(s) ? 1 : null)), groups: 1, breaks: [uniq[0]], labels: [String(uniq[0])] };

    if (uniq.length < 12 && uniq.every(v => Math.floor(v) === v)) {
      const m = uniq.length, rank = new Map(uniq.map((v, i) => [v, i + 1]));
      return { priority: scores.map(s => (isNum(s) ? m + 1 - rank.get(s) : null)), groups: m,
               breaks: uniq, labels: [...uniq].reverse().map(String), categorical: true };
    }

    const anyNA = scores.some(s => !isNum(s));
    const nb = Math.max(1, Math.min(nBins, uniq.length + (anyNA ? 1 : 0)));
    const breaks = [...new Set(Array.from({ length: nb + 1 }, (_, k) => quantile7(f, k / nb)))];
    const m = breaks.length - 1;
    const group = v => {
      if (v <= breaks[1]) return 1;
      for (let k = 2; k < breaks.length; k++) if (v <= breaks[k]) return k;
      return m;
    };
    const priority = scores.map(s => (isNum(s) ? m + 1 - group(s) : null));
    const labels = Array.from({ length: m }, (_, p) => { const g = m - p; return [breaks[g - 1], breaks[g]]; });
    return { priority, groups: m, breaks, labels };
  }

  /* ── Sensitivity ──────────────────────────────────────── */
  function ranks(values) {
    const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(values.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let t = i; t <= j; t++) r[idx[t][1]] = avg;
      i = j + 1;
    }
    return r;
  }

  /* Spearman rank correlation over units scored in both */
  function spearman(a, b) {
    const pa = [], pb = [];
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (isNum(a[i]) && isNum(b[i])) { pa.push(a[i]); pb.push(b[i]); }
    const n = pa.length;
    if (n < 3) return null;
    const ra = ranks(pa), rb = ranks(pb), m = (n + 1) / 2;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { const x = ra[i] - m, y = rb[i] - m; num += x * y; da += x * x; db += y * y; }
    return da && db ? num / Math.sqrt(da * db) : null;
  }

  /* Indices of the top `share` of scored units */
  function topSet(values, share) {
    const s = values.map((v, i) => [v, i]).filter(p => isNum(p[0])).sort((a, b) => b[0] - a[0]);
    return new Set(s.slice(0, Math.max(1, Math.round(s.length * share))).map(p => p[1]));
  }

  /* Re-run the index `draws` times with every weight multiplied by a random
   * factor in [1 − spread, 1 + spread] (signs kept) and record how often each
   * unit lands in the top `topShare`. z-scores do not depend on the weights,
   * so each draw is one weighted sum. */
  function robustness(parts, n, opts = {}) {
    const draws = opts.draws || 200, spread = opts.spread ?? 0.5, topShare = opts.topShare || 0.2;
    let seed = opts.seed || 12345;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const base = combine(parts, n, opts.naRm);
    const baseTop = topSet(base, topShare);
    const hits = new Float64Array(n), rhos = [];
    for (let d = 0; d < draws; d++) {
      const w = parts.map(p => p.weight * (1 - spread + 2 * spread * rand()));
      const v = combine(parts, n, opts.naRm, w);
      for (const i of topSet(v, topShare)) hits[i]++;
      const rho = spearman(base, v);
      if (rho != null) rhos.push(rho);
    }
    const freq = Array.from(hits, (h, i) => (isNum(base[i]) ? h / draws : null));
    let stable = 0;
    for (const i of baseTop) if (freq[i] >= 0.8) stable++;
    return {
      freq, baseline: base, baselineTop: baseTop,
      stableShare: baseTop.size ? stable / baseTop.size : null,
      spearman: rhos.length ? { mean: rhos.reduce((a, b) => a + b, 0) / rhos.length, min: Math.min(...rhos) } : null,
      draws, spread, topShare,
    };
  }

  /* Each indicator's term wⱼ·zⱼ for unit i — they sum to the PTI */
  function contributions(parts, i) {
    return parts.map(p => ({ id: p.id, weight: p.weight, via: p.via, from: p.from, z: p.z[i],
                             term: p.z[i] == null ? null : p.weight * p.z[i] }));
  }

  return {
    zscores, stats, buildModel, availableLevels, indicatorAt, computePTI, combine,
    priorityGroups, quantile7, spearman, topSet, robustness, contributions,
  };
});
