# PTI Builder

An interactive **Project Targeting Index** for any country. Pick indicators, set weights, and see on a map where conditions line up with a programme's objectives, then check how robust that picture is and how the current portfolio compares.

It implements the method of **PTI 2.0** (World Bank, Poverty & Equity GP): categorise each indicator into classes, score the classes with a direction, combine them with percentage weights. It does so in a static web app that needs no ArcGIS licence and no server. It grew out of the Nigeria PTI Builder.

> The output is a **relative index, conditional on the selected indicators and weights**. It supports discussion of where to look more closely; it does not decide where projects go.

**Try it:** `python -m http.server 8000 --directory app`, then open <http://localhost:8000>. It loads **Demoland**, a synthetic example country.

## What it does

| | |
|---|---|
| **Any spatial unit** | admin units, a regular grid, settlements; indicators at any level, classified at the level they were measured |
| **PTI 2.0 classification** | quantile, equal interval or natural breaks into 3–9 classes; fixed policy thresholds; category scores for constraint layers |
| **Direction** | ascending or descending per indicator; negative values are fine |
| **Thematic PTIs** | several named indicator/weight sets per country (Energy, Nutrition, Social Development …) |
| **Explicit no-data rules** | per-indicator fill (zero, median …) and a minimum-coverage threshold, reported in the app |
| **Levels** | switch between base units and coarser levels; population-weighted or unweighted aggregation |
| **Unit profile** | click a unit to see each indicator's value, class, weight and points |
| **Robustness** | 200 weight-perturbed re-runs: rank stability, and which units are robustly or only borderline high priority |
| **Compare runs** | save runs; rank correlation, top-group overlap, overlaid distributions |
| **Portfolio balance** | projects against priority groups; high-priority units without a project |
| **Context layers** | roads, facilities, settlements, any GeoJSON-able layer |
| **Area selection** | lasso a sub-area for its statistics |
| **Exports** | CSV, full base-unit CSV with class scores, GeoJSON, run notes (method, weights, breaks), data dictionary |
| **ArcGIS (optional)** | pull indicators from a web map or feature services; publish results back as a hosted layer |

## Set up a country

```bash
pip install -r prep/requirements.txt
cp -r prep/examples/demoland prep/countries/<your-country>   # or start from prep/examples/arcgis_template
# edit pti.yaml: levels, indicators, thematic PTIs, overlays
python prep/build_dataset.py prep/countries/<your-country>/pti.yaml --check
python prep/build_dataset.py prep/countries/<your-country>/pti.yaml
python -m http.server 8000 --directory app                  # ?data=<id>
```

Inputs can be CSV/Excel tables keyed by unit code or name, GeoTIFF rasters (zonal statistics), point layers (counts, densities, per-capita), or ArcGIS feature layers. The build validates every join and reports coverage before writing anything.

## Repository

```
app/                  the web app (static — deploy this folder)
  js/pti-core.js      the method: classification, scoring, weighting, aggregation, robustness
  js/app.js           interface
  data/<id>/          built datasets (config.json, units.json, boundaries, overlays)
prep/
  build_dataset.py    pti.yaml → app/data/<id>/
  arcgis_rest.py      optional ArcGIS REST client
  arcgis_login.py     optional sign-in (OAuth PKCE or pasted token)
  list_webmap_layers.py  draft indicator entries from a web map
  examples/demoland/  synthetic example: inputs generator + pti.yaml
  examples/arcgis_template/  template for ArcGIS-hosted data
docs/
  METHODOLOGY.md      the method, and how it maps to PTI 2.0
  CONFIGURATION.md    every pti.yaml option
  DEPLOYMENT.md       local, Posit Connect, GitHub Pages, ArcGIS options
tests/                method tests (Node) and a build smoke test (pytest)
```

## Deploy

`app/` is plain static files with all libraries bundled, so it works on Posit Connect (`rsconnect deploy html app/`), GitHub Pages or any web server. Everything under `app/data/` is public to whoever can open the page. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Tests

```bash
node --test tests/core.test.js
python -m pytest tests/
```
