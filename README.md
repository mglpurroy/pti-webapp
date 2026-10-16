# PTI Builder

An interactive **Project Targeting Index** for any country: give indicators signed weights, see priority areas on a map at every administrative level, test how sensitive the ranking is, and compare it with the project portfolio.

It follows the World Bank **[devPTIpack methodology](https://worldbank.github.io/devPTIpack/articles/methodology.html)**:
- z-score each indicator among the units of each spatial level
- project coarser z-scores down to finer units
- sum the z-scores with signed weights
- split units into equal-size priority groups, Priority 1 being the highest

It reproduces the [devPTIpack](https://github.com/worldbank/devPTIpack) R package's results exactly; the tests check this against the package's own output. It runs as a static web app, with no R, Shiny server or ArcGIS licence needed. It grew out of the Nigeria PTI Builder.

> The PTI is a relative ranking that depends on the indicators and weights chosen. It informs geographic targeting; it does not replace field knowledge.

**Try it:** `python -m http.server 8000 --directory app`, then open <http://localhost:8000>. It loads **Demoland**, a synthetic example country.

## What it does

| | |
|---|---|
| **devPTIpack method** | per-level z-scores, top-down projection, signed weights, quantile priority groups; missing data means no priority (or optionally ignored) |
| **Any spatial levels** | admin levels plus an optional grid or hexagon level; each indicator at the levels it is prepared for |
| **Weighting schemes** | several named schemes per country, editable in the app |
| **Unit profile** | click a unit: value, z-score, weight and w·z for every indicator, summing to its PTI |
| **Data explorer** | map any indicator's raw values at any level |
| **Sensitivity** | compare schemes (rank correlation, Priority 1 overlap) and random-weight robustness |
| **Portfolio balance** | projects against priority groups; Priority 1 units with no project |
| **Gridded access** | travel-time surfaces from roads + destinations (`prep/travel_time.py`), summarised per unit by population: mean, % of people in the national worst 20%, % over a threshold, percentiles |
| **Context layers** | roads, facilities, settlements, any GeoJSON-able layer |
| **Exports** | CSV, indicators CSV (values, z, terms), GeoJSON, run notes, data dictionary |
| **devPTIpack import** | load an existing dashboard's `metadata.xlsx` + `shapefiles.zip` |
| **ArcGIS (optional)** | pull indicators from a web map or feature services; publish results back |

## Set up a country

From an existing devPTIpack dashboard:

```bash
pip install -r prep/requirements.txt
python prep/import_devptipack.py metadata.xlsx shapefiles.zip --id <country>
```

From your own data:

```bash
cp -r prep/examples/demoland prep/countries/<country>      # or prep/examples/arcgis_template
# edit pti.yaml: levels, indicators (and the levels each is prepared at), weighting schemes, overlays
python prep/build_dataset.py prep/countries/<country>/pti.yaml --check
python prep/build_dataset.py prep/countries/<country>/pti.yaml
python -m http.server 8000 --directory app                 # ?data=<id>
```

Inputs can be tables keyed by unit code or name, GeoTIFF rasters (zonal statistics), point layers, or ArcGIS feature layers. Coarser levels are either supplied directly or aggregated during preparation, with the function and weighting chosen per indicator. The build validates every join and reports coverage.

## Repository

```
app/                       the web app (static — deploy this folder)
  js/pti-core.js           the method: z-scores, projection, index, priority groups, sensitivity
  js/app.js                interface
  data/<id>/               built datasets
prep/
  build_dataset.py         pti.yaml → app/data/<id>/
  import_devptipack.py     devPTIpack metadata.xlsx + shapefiles.zip → app/data/<id>/
  travel_time.py           roads + destination points → travel-time raster
  arcgis_rest.py, arcgis_login.py, list_webmap_layers.py   optional ArcGIS helpers
  examples/demoland/       synthetic example: inputs generator + pti.yaml
  examples/devptipack_sample/   devPTIpack's sample bundle (import test)
  examples/arcgis_template/     template for ArcGIS-hosted data
docs/
  METHODOLOGY.md           the method, how it maps to devPTIpack, and where its code and docs differ
  CONFIGURATION.md         every pti.yaml option
  DEPLOYMENT.md            local, Posit Connect, GitHub Pages, ArcGIS options
tests/                     method + devPTIpack parity tests (Node), build tests (pytest)
```

## Deploy

`app/` is plain static files with the one library (Plotly, which includes MapLibre) bundled, so it works on Posit Connect (`rsconnect deploy html app/`), GitHub Pages or any web server. Everything under `app/data/` is public to whoever can open the page. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Tests

```bash
npm test                    # method, devPTIpack parity, import (Node 18+, Python for the import test)
python -m pytest tests/     # build
Rscript tests/fixtures/make_devptipack_fixtures.R <path to devPTIpack>   # regenerate the R reference results
```
