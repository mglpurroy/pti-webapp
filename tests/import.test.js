/* End-to-end: a devPTIpack deployment bundle (metadata.xlsx + shapefiles.zip)
 * imported with prep/import_devptipack.py gives the same PTI as devPTIpack.
 *
 * Needs Python with the prep requirements; skipped otherwise.
 * Run with:  node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const C = require(path.join(__dirname, '../app/js/pti-core.js'));

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'prep', 'examples', 'devptipack_sample');
const FIXTURE = path.join(__dirname, 'fixtures', 'devptipack_ukr.json');

function importSample() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pti-import-'));
  const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const r = spawnSync(py, [path.join(ROOT, 'prep', 'import_devptipack.py'),
    path.join(SAMPLE, 'metadata.xlsx'), path.join(SAMPLE, 'shapefiles.zip'),
    '--id', 'ukr_sample', '--out', path.join(out, 'ukr_sample'), '--cross-level', 'devptipack_code'],
  { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  return { dir: path.join(out, 'ukr_sample'), r };
}

test('imported devPTIpack sample reproduces the R pipeline', (t) => {
  if (!fs.existsSync(FIXTURE)) return t.skip('no fixture');
  const { dir, r } = importSample();
  if (r.error || r.status !== 0) {
    if (r.error) return t.skip(`python not available: ${r.error.message}`);
    assert.fail(r.stdout + r.stderr);
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const data = Object.fromEntries(cfg.levels.map(l => [l.key, JSON.parse(fs.readFileSync(path.join(dir, `data_${l.key}.json`), 'utf8'))]));
  const model = C.buildModel(cfg.levels, data);
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

  let checked = 0;
  for (const [name, res] of Object.entries(fx.results)) {
    for (const na of ['na_keep', 'na_rm']) {
      for (const l of cfg.levels) {
        const expected = res[na][l.key];
        if (!expected) continue;
        const out = C.computePTI(model, l.key, res.weights, { crossLevel: cfg.cross_level, naRm: na === 'na_rm' });
        const T = model.byKey[l.key];
        const got = new Map(T.rows.map((row, i) => [row[l.code], out.score[i]]));
        for (const e of expected) {
          const g = got.get(e[l.code]), msg = `${name}/${na}/${l.key}/${e[l.code]}`;
          if (e.pti_score == null) assert.equal(g, null, msg);
          else assert.ok(Math.abs(g - e.pti_score) <= 1e-6 * Math.max(1, Math.abs(e.pti_score)), `${msg} ${g} != ${e.pti_score}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 10000, `only ${checked} compared`);
  assert.equal(cfg.method, 'devPTIpack');
  assert.ok(cfg.indicators.every(i => i.levels.length >= 1));
});
