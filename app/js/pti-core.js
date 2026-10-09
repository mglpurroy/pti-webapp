/* ── PTI core — the method, with no DOM or map code ──────────
 *
 * Implements the three-stage PTI 2.0 logic on a table of spatial units
 * (one row per base unit — ward, grid cell, settlement, catchment…):
 *
 *   1. Categorization  each indicator is split into N classes
 *                      (quantile by default; equal interval, natural
 *                      breaks, fixed policy thresholds or explicit
 *                      category scores are also supported)
 *   2. Scoring         each class gets a score 1..N, ascending or
 *                      descending with the indicator's direction
 *   3. Weighting       scores are combined by percentage weights that
 *                      sum to 100 into a composite surface
 *
 * The composite is reported as a 0–100 index: 0 means the lowest class on
 * every selected indicator, 100 the highest. It is a linear rescaling of the
 * weighted 1..N score, so rankings are identical to the raw suitability scale.
 *
 * Loaded in the browser as window.PTICore and in Node via require().
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PTICore = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const finite = arr => arr.filter(isNum);

  /* ── Class breaks ─────────────────────────────────────────
   * Each returns N-1 upper bounds for classes 1..N-1; anything above the
   * last bound is class N. null means the indicator cannot be classified
   * (too few values, or no variation).
   */
  function quantileBreaks(values, n) {
    const s = finite(values).sort((a, b) => a - b);
    if (s.length < n) return null;
    const b = [];
    for (let i = 1; i < n; i++) b.push(s[Math.min(Math.ceil(s.length * i / n) - 1, s.length - 1)]);
    return s[0] === s[s.length - 1] ? null : b;
  }

  function equalIntervalBreaks(values, n) {
    const f = finite(values);
    if (!f.length) return null;
    let mn = Infinity, mx = -Infinity;
    for (const v of f) { if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mn === mx) return null;
    const step = (mx - mn) / n;
    return Array.from({ length: n - 1 }, (_, i) => mn + step * (i + 1));
  }

  /* Natural breaks via simple-statistics' ckmeans (optimal 1-D clustering,
   * the modern form of Jenks). Large inputs are sampled — ckmeans is O(n²)
   * memory — which moves the breaks by a negligible amount. */
  function naturalBreaks(values, n) {
    const f = finite(values);
    if (f.length < n) return null;
    const ss = root && root.ss;
    if (!ss || !ss.ckmeans) return quantileBreaks(values, n);
    let sample = f;
    if (f.length > 4000) {
      const s = [...f].sort((a, b) => a - b), step = s.length / 4000;
      sample = Array.from({ length: 4000 }, (_, i) => s[Math.floor(i * step)]);
    }
    const clusters = ss.ckmeans(sample, Math.min(n, new Set(sample).size));
    if (clusters.length < 2) return null;
    const b = clusters.slice(0, -1).map(c => c[c.length - 1]);
    while (b.length < n - 1) b.push(b[b.length - 1]);
    return b;
  }

  function computeBreaks(values, method, n) {
    if (method === 'equal') return equalIntervalBreaks(values, n);
    if (method === 'natural' || method === 'jenks') return naturalBreaks(values, n);
    return quantileBreaks(values, n);
  }

  function classify(v, breaks) {
    if (!isNum(v)) return null;
    for (let i = 0; i < breaks.length; i++) if (v <= breaks[i]) return i + 1;
    return breaks.length + 1;
  }

  /* ── No-data fill ─────────────────────────────────────────
   * PTI 2.0 requires every input to be filled inside the study area. The
   * fill rule is an explicit, documented choice per indicator: a number, or
   * one of zero | min | max | mean | median. null leaves gaps, which then
   * count against the unit's coverage.
   */
  function fillValue(values, rule) {
    if (rule == null || rule === 'none') return null;
    if (isNum(rule)) return rule;
    if (rule === 'zero') return 0;
    const f = finite(values).sort((a, b) => a - b);
    if (!f.length) return null;
    if (rule === 'min') return f[0];
    if (rule === 'max') return f[f.length - 1];
    if (rule === 'mean') return f.reduce((a, b) => a + b, 0) / f.length;
    if (rule === 'median') {
      const m = f.length >> 1;
      return f.length % 2 ? f[m] : (f[m - 1] + f[m]) / 2;
    }
    throw new Error(`Unknown fill rule '${rule}'`);
  }

  /* Values of one indicator at its native level.
   *
   * A coarse indicator (district poverty, say) is stored repeated on every
   * base unit in the district. Classifying the repeated column would let a
   * district of 900 cells pull the breaks toward itself, so breaks and fill
   * statistics are computed over one value per native unit. For base-level
   * indicators every code is unique and this changes nothing.
   */
  function nativeValues(rows, col, codeField) {
    if (!codeField || !rows.length || rows[0][codeField] === undefined) return rows.map(r => r[col]);
    const seen = new Set(), out = [];
    for (const r of rows) {
      const c = r[codeField];
      if (c == null || seen.has(c)) continue;
      seen.add(c); out.push(r[col]);
    }
    return out;
  }

  /* ── Score one indicator ──────────────────────────────────
   * ind: { id, direction, fill, scoring, codeField }
   *   direction  'ascending'  higher value → higher score (higher priority)
   *              'descending' higher value → lower score
   *   scoring    optional override of the global classification:
   *              { type: 'breaks', breaks: [b1..bN-1] }  fixed thresholds
   *              { type: 'categories', scores: { value: score } }
   *                for categorical / binary layers (constraints, masks);
   *                scores are on the 1..N scale and ignore direction
   * opts: { method, nClasses }
   * Returns { scores, breaks, filled, missing } with scores[i] in 1..N or null.
   */
  function scoreIndicator(rows, ind, opts) {
    const n = opts.nClasses, col = ind.id;
    const sc = ind.scoring || null;
    const native = nativeValues(rows, col, ind.codeField);
    const fv = fillValue(native, ind.fill);
    let filled = 0, missing = 0;
    const vals = rows.map(r => {
      const v = r[col];
      if (isNum(v)) return v;
      if (fv != null) { filled++; return fv; }
      missing++; return null;
    });

    if (sc && sc.type === 'categories') {
      const map = sc.scores || {};
      const scores = vals.map(v => {
        if (v == null) return null;
        const s = map[String(v)];
        return isNum(s) ? Math.max(1, Math.min(n, s)) : null;
      });
      return { scores, breaks: null, filled, missing, categorical: true };
    }

    let breaks;
    if (sc && sc.type === 'breaks' && Array.isArray(sc.breaks)) {
      breaks = [...sc.breaks].sort((a, b) => a - b);
    } else {
      const nat = fv == null ? native : native.map(v => (isNum(v) ? v : fv));
      breaks = computeBreaks(nat, opts.method, n);
    }
    if (!breaks || !breaks.length) return { scores: rows.map(() => null), breaks: null, filled, missing, degenerate: true };
    const k = breaks.length + 1; // fixed breaks may define fewer than N classes
    const desc = ind.direction === 'descending' || ind.direction === 'desc';
    const scores = vals.map(v => {
      const c = classify(v, breaks);
      if (c == null) return null;
      const s = desc ? k + 1 - c : c;
      // Rescale a k-class result onto the 1..N scale so mixed schemes combine
      return k === n ? s : 1 + (s - 1) * (n - 1) / (k - 1);
    });
    return { scores, breaks, filled, missing };
  }

  /* ── Weighted combination ─────────────────────────────────
   * parts: [{ scores, weight }] with weights in percent.
   * Units missing an indicator lose that weight; the remaining weights are
   * renormalised only while the unit keeps at least minCoverage (0–1) of the
   * total. Below that the unit is left unscored rather than scored on a
   * partial, different index.
   */
  function composite(parts, nClasses, minCoverage = 1) {
    const total = parts.reduce((s, p) => s + p.weight, 0);
    const len = parts.length ? parts[0].scores.length : 0;
    const raw = new Array(len).fill(null), index = new Array(len).fill(null);
    const coverage = new Float64Array(len);
    if (!total) return { raw, index, coverage: Array.from(coverage) };
    const sum = new Float64Array(len);
    for (const p of parts) {
      const w = p.weight / total;
      for (let i = 0; i < len; i++) {
        const s = p.scores[i];
        if (s != null) { sum[i] += s * w; coverage[i] += w; }
      }
    }
    const tol = 1e-9;
    for (let i = 0; i < len; i++) {
      if (coverage[i] <= 0 || coverage[i] + tol < minCoverage) continue;
      raw[i] = sum[i] / coverage[i];
      index[i] = (raw[i] - 1) / (nClasses - 1) * 100;
    }
    return { raw, index, coverage: Array.from(coverage) };
  }

  /* ── Aggregation to coarser levels ──────────────────────── */
  function weightedMean(vals, wts) {
    let sw = 0, swv = 0;
    for (let i = 0; i < vals.length; i++) { sw += wts[i]; swv += vals[i] * wts[i]; }
    return sw > 0 ? swv / sw : null;
  }

  function weightedMedian(vals, wts) {
    const pairs = vals.map((v, i) => [v, wts[i]]).sort((a, b) => a[0] - b[0]);
    const total = pairs.reduce((s, p) => s + p[1], 0);
    if (total <= 0) return null;
    let cum = 0;
    for (const [v, w] of pairs) { cum += w; if (cum >= total / 2) return v; }
    return pairs[pairs.length - 1][0];
  }

  /* Group base-unit values by a parent code. weightField (normally
   * population) makes the result describe the average person rather than
   * the average unit; groups with no usable weight fall back to unweighted
   * and report weighted:false. */
  function aggregate(rows, values, codeField, nameField, weightField) {
    const groups = new Map();
    rows.forEach((r, i) => {
      const code = r[codeField], v = values[i];
      if (code == null || v == null) return;
      let g = groups.get(code);
      if (!g) groups.set(code, g = { code, name: nameField ? r[nameField] : code, vals: [], wts: [] });
      g.vals.push(v);
      const w = weightField ? r[weightField] : null;
      g.wts.push(isNum(w) && w > 0 ? w : 0);
    });
    return [...groups.values()].map(g => {
      const totalW = g.wts.reduce((a, b) => a + b, 0);
      const useW = !!weightField && totalW > 0;
      const ones = g.vals.map(() => 1);
      return {
        code: g.code, name: g.name,
        mean: weightedMean(g.vals, useW ? g.wts : ones),
        median: weightedMedian(g.vals, useW ? g.wts : ones),
        count: g.vals.length,
        weight: useW ? totalW : null,
        weighted: useW,
      };
    });
  }

  /* Fast grouped mean for repeated use (robustness draws): precompute
   * group membership once, then each call is a single pass. */
  function makeGrouper(rows, codeField, weightField) {
    const idx = new Map(), gid = new Int32Array(rows.length).fill(-1), codes = [];
    const w = new Float64Array(rows.length);
    rows.forEach((r, i) => {
      const c = r[codeField];
      if (c == null) return;
      if (!idx.has(c)) { idx.set(c, codes.length); codes.push(c); }
      gid[i] = idx.get(c);
      const x = weightField ? r[weightField] : 1;
      w[i] = isNum(x) && x > 0 ? x : (weightField ? 0 : 1);
    });
    return {
      codes,
      mean(values) {
        const s = new Float64Array(codes.length), sw = new Float64Array(codes.length);
        const s1 = new Float64Array(codes.length), n1 = new Float64Array(codes.length);
        for (let i = 0; i < values.length; i++) {
          const g = gid[i], v = values[i];
          if (g < 0 || v == null) continue;
          s[g] += v * w[i]; sw[g] += w[i]; s1[g] += v; n1[g]++;
        }
        return Array.from(s, (x, g) => (sw[g] > 0 ? x / sw[g] : n1[g] > 0 ? s1[g] / n1[g] : null));
      },
    };
  }

  /* ── Relative priority classes of the composite ──────────
   * Quantile groups of the displayed scores (1 = lowest … k = highest).
   * These describe position in this run only, not an absolute threshold.
   */
  function priorityClasses(scores, k = 5) {
    const v = finite(scores).sort((a, b) => a - b);
    if (v.length < k) return scores.map(() => null);
    const th = Array.from({ length: k - 1 }, (_, i) => v[Math.floor(v.length * (i + 1) / k)]);
    return scores.map(s => {
      if (!isNum(s)) return null;
      for (let i = 0; i < th.length; i++) if (s < th[i]) return i + 1;
      return k;
    });
  }

  /* ── Rank agreement ───────────────────────────────────── */
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

  /* Spearman correlation over units scored in both runs */
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

  /* ── Robustness to the weights ───────────────────────────
   * Re-runs the composite `draws` times with every weight multiplied by a
   * random factor in [1-spread, 1+spread] (then renormalised), and records
   * how often each unit lands in the top `topShare` of units. Class scores
   * do not depend on weights, so each draw is a single weighted sum.
   *
   * grouper (optional) evaluates robustness at a coarser level.
   * Returns { freq[], spearman: {mean,min}, stableShare, baselineTop }.
   */
  function robustness(parts, nClasses, minCoverage, opts = {}) {
    const draws = opts.draws || 200, spread = opts.spread ?? 0.5, topShare = opts.topShare || 0.2;
    let seed = opts.seed || 12345;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const level = v => (opts.grouper ? opts.grouper.mean(v) : v);

    const base = level(composite(parts, nClasses, minCoverage).index);
    const baseTop = topSet(base, topShare);
    const hits = new Float64Array(base.length);
    const rhos = [];
    for (let d = 0; d < draws; d++) {
      const p = parts.map(x => ({ scores: x.scores, weight: x.weight * (1 - spread + 2 * spread * rand()) }));
      const v = level(composite(p, nClasses, minCoverage).index);
      for (const i of topSet(v, topShare)) hits[i]++;
      const rho = spearman(base, v);
      if (rho != null) rhos.push(rho);
    }
    const freq = Array.from(hits, (h, i) => (isNum(base[i]) ? h / draws : null));
    let stable = 0;
    for (const i of baseTop) if (freq[i] >= 0.8) stable++;
    return {
      freq,
      baseline: base,
      baselineTop: baseTop,
      stableShare: baseTop.size ? stable / baseTop.size : null,
      spearman: rhos.length ? { mean: rhos.reduce((a, b) => a + b, 0) / rhos.length, min: Math.min(...rhos) } : null,
      draws, spread, topShare,
    };
  }

  /* Per-indicator contribution of one unit: weight share × class score */
  function contributions(parts, i) {
    const total = parts.reduce((s, p) => s + p.weight, 0);
    let cov = 0;
    for (const p of parts) if (p.scores[i] != null) cov += p.weight / total;
    return parts.map(p => {
      const s = p.scores[i];
      return { id: p.id, score: s, weightShare: p.weight / total,
               points: s == null || !cov ? null : (s * p.weight / total) / cov };
    });
  }

  return {
    quantileBreaks, equalIntervalBreaks, naturalBreaks, computeBreaks, classify,
    fillValue, nativeValues, scoreIndicator, composite, aggregate, makeGrouper,
    priorityClasses, spearman, topSet, robustness, contributions,
  };
});
