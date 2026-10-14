/* Method tests for app/js/pti-core.js — run with:  node --test tests/
 *
 * 1. The worked examples in the devPTIpack methodology article
 *    (https://worldbank.github.io/devPTIpack/articles/methodology.html)
 * 2. Parity with devPTIpack's own R pipeline on its Rwanda and Ukraine
 *    samples (fixtures written by tests/fixtures/make_devptipack_fixtures.R)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require(path.join(__dirname, '../app/js/pti-core.js'));

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} != ${b}`);
const round2 = v => Math.round(v * 100) / 100;

/* ── Methodology article ───────────────────────────────────── */

test('z-scores at ADM 1: poverty 45 / 30 / 25', () => {
  const z = C.zscores([45, 30, 25]).map(round2);
  assert.deepEqual(z, [1.12, -0.32, -0.8]);
  const s = C.stats([45, 30, 25]);
  near(s.mean, 33.33, 0.01); near(s.sd, 10.41, 0.01);   // "Mean = 33.3%, SD = 10.4%"
});

test('z-scores at ADM 2: eight districts, computed among districts only', () => {
  const z = C.zscores([52, 43, 38, 35, 28, 25, 22, 60]).map(round2);
  assert.deepEqual(z, [1.06, 0.39, 0.01, -0.22, -0.74, -0.97, -1.19, 1.66]);
});

test('PTI with two indicators: +1 × poverty and −1 × electricity', () => {
  const pov = [1.06, 0.39, 0.01, -0.22, -0.74, -0.97, -1.19, 1.66];
  const elec = [-0.9, -0.4, 0.2, 0.6, 1.1, 0.8, 1.4, -1.5];
  const pti = C.combine([{ z: pov, weight: 1 }, { z: elec, weight: -1 }], 8).map(round2);
  assert.deepEqual(pti, [1.96, 0.79, -0.19, -0.82, -1.84, -1.77, -2.59, 3.16]);
});

test('weights greater than 1 change relative importance', () => {
  const a = [1, -1], b = [-1, 1];
  const eq = C.combine([{ z: a, weight: 1 }, { z: b, weight: 1 }], 2);
  const heavy = C.combine([{ z: a, weight: 2 }, { z: b, weight: 1 }], 2);
  assert.deepEqual(eq, [0, 0]);
  assert.deepEqual(heavy, [1, -1]);
});

test('projection ADM 1 → ADM 2 copies the parent z-score, not re-normalised', () => {
  const levels = [{ key: 'adm1', code: 'a1' }, { key: 'adm2', code: 'a2' }];
  const data = {
    adm1: [{ a1: 'N', enrol: 72 }, { a1: 'C', enrol: 85 }, { a1: 'S', enrol: 80 }],
    adm2: ['N', 'N', 'N', 'C', 'C', 'S', 'S', 'S'].map((p, i) => ({ a1: p, a2: `d${i}` })),
  };
  const m = C.buildModel(levels, data);
  const r = C.computePTI(m, 'adm2', { enrol: 1 });
  assert.equal(r.parts[0].via, 'projected');
  assert.deepEqual(r.score.map(round2), [-1.07, -1.07, -1.07, 0.91, 0.91, 0.15, 0.15, 0.15]);
});

test('no upward aggregation by default; devPTIpack code mode averages finer z-scores', () => {
  const levels = [{ key: 'adm1', code: 'a1' }, { key: 'adm2', code: 'a2' }];
  const data = {
    adm1: [{ a1: 'N' }, { a1: 'S' }],
    adm2: [{ a1: 'N', a2: 'n1', x: 1 }, { a1: 'N', a2: 'n2', x: 3 }, { a1: 'S', a2: 's1', x: 5 }],
  };
  const m = C.buildModel(levels, data);
  const doc = C.computePTI(m, 'adm1', { x: 1 });
  assert.deepEqual(doc.excluded, ['x']);
  const code = C.computePTI(m, 'adm1', { x: 1 }, { crossLevel: 'devptipack_code' });
  assert.equal(code.parts[0].via, 'aggregated');
  near(code.score[0], (-1 + 0) / 2, 1e-12);   // z of 1, 3 = −1, 0
  near(code.score[1], 1, 1e-12);
});

test('missing data: no priority by default, dropped from the sum with naRm', () => {
  const parts = [{ z: [1, null], weight: 1 }, { z: [1, 2], weight: 1 }];
  assert.deepEqual(C.combine(parts, 2), [2, null]);
  assert.deepEqual(C.combine(parts, 2, true), [2, 2]);
});

test('single unit or no variance gives z = 0', () => {
  assert.deepEqual(C.zscores([7]), [0]);
  assert.deepEqual(C.zscores([3, 3, null]), [0, 0, null]);
});

test('priority groups: equal-size quantile groups, Priority 1 = highest', () => {
  const v = Array.from({ length: 10 }, (_, i) => i + 0.5);
  const g = C.priorityGroups(v, 5);
  assert.equal(g.groups, 5);
  assert.deepEqual(g.priority, [5, 5, 4, 4, 3, 3, 2, 2, 1, 1]);
  near(g.breaks[1], C.quantile7(v.slice().sort((a, b) => a - b), 0.2), 1e-12);
});

test('priority groups: R type-7 quantiles', () => {
  // quantile(c(1, 2, 4, 8), 0.5) == 3 in R
  near(C.quantile7([1, 2, 4, 8], 0.5), 3, 1e-12);
  near(C.quantile7([1, 2, 4, 8], 0.2), 1.6, 1e-12);
});

test('spearman handles ties and reversal', () => {
  near(C.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1, 1e-12);
  near(C.spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1, 1e-12);
});

test('robustness: a single indicator is perfectly stable', () => {
  const z = Array.from({ length: 50 }, (_, i) => i / 10);
  const r = C.robustness([{ z, weight: 2 }], 50, { draws: 30 });
  near(r.spearman.mean, 1, 1e-12);
  assert.equal(r.stableShare, 1);
});

/* ── Parity with devPTIpack (R) ────────────────────────────── */

function modelFromFixture(fx) {
  const pcods = Object.keys(fx.mapping[0]).filter(k => /^admin\d+Pcod$/.test(k))
    .sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)));
  const levels = pcods.map(p => ({ key: p.replace('Pcod', ''), code: p }));
  const sheets = Object.fromEntries(Object.keys(fx.data).map(s => [s.match(/^admin\d+/)[0], fx.data[s]]));
  const data = {};
  levels.forEach((l, k) => {
    const own = new Map();
    for (const row of fx.mapping) {
      const c = row[l.code];
      if (!own.has(c)) own.set(c, Object.fromEntries(pcods.slice(0, k + 1).map(p => [p, row[p]])));
    }
    // Units are those in the shapes mapping plus any extra rows of the data
    // sheet. devPTIpack z-scores over every row of the sheet, but its
    // mapping table drops units without descendants at the finest level, so
    // those take part in normalisation only: keep just their own code
    for (const r of sheets[l.key] || []) {
      if (!own.has(r[l.code])) own.set(r[l.code], { [l.code]: r[l.code] });
    }
    const vals = new Map((sheets[l.key] || []).map(r => [r[l.code], r]));
    data[l.key] = [...own.values()].map(r => {
      const v = vals.get(r[l.code]) || {};
      const out = { ...r };
      for (const ind of fx.indicators) if (typeof v[ind.var_code] === 'number') out[ind.var_code] = v[ind.var_code];
      return out;
    });
  });
  return { model: C.buildModel(levels, data), levels };
}

function compare(fx, model, levels, mode, onlyLevel) {
  let checked = 0;
  for (const [name, res] of Object.entries(fx.results)) {
    for (const na of ['na_keep', 'na_rm']) {
      for (const l of levels) {
        if (onlyLevel && !onlyLevel(l, res.weights)) continue;
        const expected = res[na][l.key];
        if (!expected) continue;
        const r = C.computePTI(model, l.key, res.weights, { crossLevel: mode, naRm: na === 'na_rm' });
        const T = model.byKey[l.key];
        const got = new Map(T.rows.map((row, i) => [row[l.code], r.score[i]]));
        for (const e of expected) {
          const g = got.get(e[l.code]);
          const msg = `${name}/${na}/${l.key}/${e[l.code]}`;
          if (e.pti_score == null) assert.equal(g, null, msg);
          else near(g, e.pti_score, 1e-8 * Math.max(1, Math.abs(e.pti_score)), msg);
          checked++;
        }
      }
    }
  }
  return checked;
}

for (const tag of ['rwa', 'ukr']) {
  const file = path.join(__dirname, 'fixtures', `devptipack_${tag}.json`);
  if (!fs.existsSync(file)) continue;
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));

  test(`devPTIpack parity (${tag}): code mode matches the R pipeline at every level`, () => {
    const { model, levels } = modelFromFixture(fx);
    const n = compare(fx, model, levels, 'devptipack_code');
    assert.ok(n > 1000, `only ${n} values compared`);
  });

  test(`devPTIpack parity (${tag}): methodology mode matches wherever no finer-only data is involved`, () => {
    const { model, levels } = modelFromFixture(fx);
    // Levels where every weighted indicator is native or available coarser
    const ok = (l, weights) => Object.entries(weights).every(([id, w]) => {
      if (!w) return true;
      const avail = C.availableLevels(model, id).map(k => model.byKey[k].rank);
      return avail.some(r => r <= model.byKey[l.key].rank);
    });
    const n = compare(fx, model, levels, 'project', ok);
    assert.ok(n > 500, `only ${n} values compared`);
  });
}
