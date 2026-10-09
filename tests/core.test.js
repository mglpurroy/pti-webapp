/* Method tests for app/js/pti-core.js — run with:  node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

globalThis.ss = require(path.join(__dirname, '../app/js/vendor/simple-statistics.min.js'));
const C = require(path.join(__dirname, '../app/js/pti-core.js'));

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('worked example from the PTI 2.0 note: 75/25 weights on a 1-3 scale', () => {
  // Upper-left cell: scores 2 and 3 → 2*0.75 + 3*0.25 = 2.25
  const r = C.composite([{ scores: [2], weight: 75 }, { scores: [3], weight: 25 }], 3);
  close(r.raw[0], 2.25);
  close(r.index[0], (2.25 - 1) / 2 * 100);
});

test('quantile classes put an equal count in each class', () => {
  const v = Array.from({ length: 100 }, (_, i) => i);
  const { scores } = C.scoreIndicator(v.map(x => ({ x })), { id: 'x', direction: 'ascending' }, { method: 'quantile', nClasses: 5 });
  const counts = [1, 2, 3, 4, 5].map(k => scores.filter(s => s === k).length);
  assert.deepEqual(counts, [20, 20, 20, 20, 20]);
});

test('descending direction reverses the scores', () => {
  const rows = [1, 2, 3, 4, 5].map(x => ({ x }));
  const up = C.scoreIndicator(rows, { id: 'x', direction: 'ascending' }, { method: 'quantile', nClasses: 5 }).scores;
  const dn = C.scoreIndicator(rows, { id: 'x', direction: 'descending' }, { method: 'quantile', nClasses: 5 }).scores;
  assert.deepEqual(up, [1, 2, 3, 4, 5]);
  assert.deepEqual(dn, [5, 4, 3, 2, 1]);
});

test('negative values classify like any other values', () => {
  const rows = [-0.4, -0.2, 0, 0.2, 0.4].map(x => ({ x }));
  const { scores } = C.scoreIndicator(rows, { id: 'x', direction: 'ascending' }, { method: 'equal', nClasses: 5 });
  assert.deepEqual(scores, [1, 2, 3, 4, 5]);
});

test('coarse indicators get breaks from one value per native unit', () => {
  // District A has 8 cells at value 1; districts B..E one cell each.
  const rows = [
    ...Array(8).fill({ d: 'A', x: 1 }),
    { d: 'B', x: 2 }, { d: 'C', x: 3 }, { d: 'D', x: 4 }, { d: 'E', x: 5 },
  ];
  const r = C.scoreIndicator(rows, { id: 'x', direction: 'ascending', codeField: 'd' }, { method: 'quantile', nClasses: 5 });
  assert.deepEqual(r.breaks, [1, 2, 3, 4]);
  assert.equal(r.scores[0], 1);
  assert.equal(r.scores[rows.length - 1], 5);
});

test('fill rules fill gaps and are counted', () => {
  const rows = [{ x: 1 }, { x: null }, { x: 3 }, { x: 5 }, { x: 7 }, { x: 9 }];
  const r = C.scoreIndicator(rows, { id: 'x', direction: 'ascending', fill: 'zero' }, { method: 'quantile', nClasses: 5 });
  assert.equal(r.filled, 1);
  assert.equal(r.scores[1], 1);
  const g = C.scoreIndicator(rows, { id: 'x', direction: 'ascending', fill: null }, { method: 'quantile', nClasses: 5 });
  assert.equal(g.missing, 1);
  assert.equal(g.scores[1], null);
  close(C.fillValue([1, 2, 3, 4], 'median'), 2.5);
});

test('minimum coverage leaves units with too much missing weight unscored', () => {
  const parts = [{ scores: [5, 5], weight: 60 }, { scores: [1, null], weight: 40 }];
  assert.equal(C.composite(parts, 5, 1).index[1], null);
  const partial = C.composite(parts, 5, 0.5);
  close(partial.index[1], 100);       // renormalised over the 60% present
  close(partial.coverage[1], 0.6);
});

test('categorical scoring maps values directly and ignores direction', () => {
  const rows = [{ x: 0 }, { x: 1 }, { x: 1 }, { x: 0 }];
  const r = C.scoreIndicator(rows, { id: 'x', direction: 'descending', scoring: { type: 'categories', scores: { 0: 1, 1: 5 } } },
    { method: 'quantile', nClasses: 5 });
  assert.deepEqual(r.scores, [1, 5, 5, 1]);
});

test('fixed breaks with fewer classes are rescaled onto the 1..N scale', () => {
  const rows = [{ x: 10 }, { x: 50 }, { x: 90 }];
  const r = C.scoreIndicator(rows, { id: 'x', direction: 'ascending', scoring: { type: 'breaks', breaks: [30, 60] } },
    { method: 'quantile', nClasses: 5 });
  assert.deepEqual(r.scores, [1, 3, 5]);
});

test('natural breaks separate obvious clusters', () => {
  const v = [1, 1.1, 1.2, 5, 5.1, 5.2, 9, 9.1, 9.2];
  const b = C.naturalBreaks(v, 3);
  assert.deepEqual(b, [1.2, 5.2]);
});

test('population-weighted aggregation', () => {
  const rows = [{ g: 'a', p: 1 }, { g: 'a', p: 3 }, { g: 'b', p: 0 }];
  const out = C.aggregate(rows, [0, 100, 40], 'g', null, 'p');
  const a = out.find(r => r.code === 'a'), b = out.find(r => r.code === 'b');
  close(a.mean, 75);
  assert.equal(b.weighted, false);   // no usable weight → unweighted fallback
  close(b.mean, 40);
  const grouper = C.makeGrouper(rows, 'g', 'p');
  close(grouper.mean([0, 100, 40])[0], 75);
});

test('robustness: identical indicators are perfectly stable', () => {
  const s = Array.from({ length: 50 }, (_, i) => 1 + (i % 5));
  const r = C.robustness([{ scores: s, weight: 50 }, { scores: s, weight: 50 }], 5, 1, { draws: 30 });
  close(r.spearman.mean, 1);
  assert.equal(r.stableShare, 1);
});

test('spearman handles ties and reversal', () => {
  close(C.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  close(C.spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
});
