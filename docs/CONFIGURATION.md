# Configuring a dataset (`pti.yaml`)

One YAML file describes a country (or any study area): its spatial units, indicators, thematic PTIs and overlays. `prep/build_dataset.py` reads it and writes everything the app needs to `app/data/<id>/`.

```bash
python prep/build_dataset.py path/to/pti.yaml --check   # validate sources and joins only
python prep/build_dataset.py path/to/pti.yaml           # build
```

Paths in the file are relative to the file itself. The complete working example is [`prep/examples/demoland/pti.yaml`](../prep/examples/demoland/pti.yaml).

## Top level

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | dataset id; also the folder name under `app/data/` and the `?data=` URL parameter |
| `output` | no | output folder (default `../../app/data/<id>`) |
| `app` | yes | what the app shows; see below |
| `levels` | yes | spatial units, coarse → fine; the **last one is the base unit** |
| `population` | no | population per base unit, used for weighted aggregation and per-capita stats |
| `indicators` | yes | the indicator list |
| `overlays` | no | context and portfolio layers |
| `simplify` | no | per-level (or per-overlay) simplification tolerance in degrees, e.g. `{district: 0.001}` |

## `app`

| Key | Default | Meaning |
|---|---|---|
| `title` | Project Targeting Index | header title |
| `country`, `subtitle` | | header subtitle; `country` also names downloaded files |
| `default_level` | second-finest level | level shown first |
| `classes` | 5 | classes per indicator (3–9) |
| `classification` | quantile | `quantile`, `equal` or `natural` |
| `min_coverage` | 1.0 | share of selected weight a unit needs data for to be scored |
| `priority_labels` | Very low … Very high | names of the relative priority groups; their count sets the number of groups |
| `legend` | `{low: Lower priority, high: Higher priority}` | legend end labels |
| `categories` | | `[{name, color}]`, the sidebar order and colours |
| `scenarios` | | thematic PTIs: `[{id, label, description, weights: {indicator_id: pct}}]`; weights must sum to 100 |
| `about` | | `{disclaimer, contact}`, shown in About |
| `map` | fit to boundaries | `{center: [lat, lon], zoom}` |
| `basemap` | Esri Light Gray (no key needed) | `{tiles: [xyz url], labels: [xyz url], attribution}` |
| `arcgis_publish` | off | `{portal: https://…}` shows the **⬆ ArcGIS** publish button |
| `data_refresh_note` | | `{text, command}` shows a "Refreshing the data" note in the sidebar |

## `levels`

```yaml
levels:
  - key: state                 # short id, used in file names
    label: State               # shown in the app
    code: statecode            # canonical code column (output)
    name: statename            # canonical name column (output)
    boundaries:
      file: inputs/states.gpkg # any format GeoPandas reads (gpkg, shp, geojson, fgb …)
      code_field: ADM1_PCODE   # source column → `code` (default: same as code)
      name_field: ADM1_EN      # source column → `name`
  - key: ward
    …
    parents: {state: ADM1_PCODE, lga: ADM2_PCODE}   # optional, see below
```

Boundaries can also come from ArcGIS:

```yaml
    boundaries:
      arcgis: https://services.arcgis.com/…/FeatureServer/0
      where: "COUNTRY = 'NGA'"
      code_field: wardcode
```

**Parents.** Every base unit needs the code of each coarser level. If the base file carries them, map them with `parents:`. Otherwise each base unit is assigned to the parent polygon containing its representative point, and units that fall outside every parent go to the nearest one, with a warning. Spatial assignment is the right choice for grids and other non-administrative base units.

Duplicate codes are dissolved into multipart units, with a warning.

## `indicators`

```yaml
- id: poverty_headcount        # column name; letters, digits, underscore
  label: Poverty headcount
  category: Poverty & Welfare
  direction: ascending         # ascending: higher value → higher PTI score; descending: the reverse
  level: ward                  # native level (default: base level)
  unit: "%"
  year: 2023
  source_note: Small-area estimate, LSS 2023
  description: …               # optional, shown on hover
  fill: median                 # optional: number | zero | min | max | mean | median
  scoring: …                   # optional, see below
  source: …                    # where the values come from, see below
```

### `source` types

**table**: CSV, Excel, Parquet or a vector file's attributes, keyed by unit code:

```yaml
source: {type: table, file: inputs/stats.csv, key: district_code, column: stunting_rate}
# Excel: add sheet: "Sheet1".  Duplicate keys: agg: mean | sum | max | min
```

Join on names when the source has no usable code. Matching is exact and case-insensitive; match rates are reported:

```yaml
source: {type: table, file: inputs/ipc.csv, name_key: Region, column: phase}
```

**raster**: a GeoTIFF summarised over each unit of `level`:

```yaml
source: {type: raster, file: inputs/travel_time.tif, stat: mean}   # mean | median | sum | min | max | count …
# optional: nodata: -9999, all_touched: true
```

**points**: point features counted per unit:

```yaml
source: {type: points, file: inputs/facilities.gpkg, stat: per_1000_pop, filter: "type == 'clinic'"}
# stat: count | per_km2 | per_1000_pop (needs `population:`)
```

**arcgis**: an ArcGIS Online / Enterprise feature layer or table (see [DEPLOYMENT.md](DEPLOYMENT.md#arcgis-optional) for sign-in):

```yaml
source:
  type: arcgis
  url: https://services.arcgis.com/…/FeatureServer/3
  key: wardcode                # or name_key: adm2_name
  column: perc_pov_2023
  where: "year = 2023"         # optional
  agg: mean                    # optional, for several rows per unit
```

`python prep/list_webmap_layers.py <webmap item id> --yaml draft.yaml` lists every layer of a web map (for example the one behind a Hub site or Data Explorer) and drafts these entries for you.

### `scoring` overrides

Fixed thresholds instead of data-driven breaks. N−1 ascending upper bounds give N classes; fewer bounds give fewer classes, which are rescaled onto 1..N:

```yaml
scoring: {type: breaks, breaks: [10, 25, 40, 60]}
```

Category scores, for categorical or binary layers (on the 1..N scale; direction is ignored):

```yaml
scoring: {type: categories, scores: {"0": 5, "1": 1}}   # open = 5, restricted = 1
```

## `population`

```yaml
population:
  source: {type: table, file: inputs/pop.csv, key: ward_code, column: pop_2025}
```

Any source type works (a WorldPop raster with `stat: sum` is common).

## `overlays`

```yaml
overlays:
  - id: projects
    label: Project portfolio
    file: inputs/projects.gpkg          # or  arcgis: https://…/FeatureServer/0
    role: portfolio                     # enables the Portfolio tab; omit for context layers
    label_field: project_name
    fields: [project_id, sector, status]
    color: "#1e3a8a"
```

Points become hoverable markers; lines and polygons are drawn as outlines. Portfolio features are tagged with the base unit they fall in at build time.

## What the build checks

- every level's code field exists; parent assignment and orphans
- every indicator's key and column exist, and at least one value joins (a key that looks right but holds different values fails loudly instead of producing an all-empty column)
- coverage per indicator at its native level and at the base level, with any gap that has no fill rule flagged
- scenario weights reference real indicators and sum to 100
- direction and scoring values are valid

## Output files

| File | Content |
|---|---|
| `config.json` | the `app` settings, levels, indicator dictionary and overlay list |
| `units.json` | one row per base unit: all level codes and names, population, indicator values |
| `boundaries_<level>.geojson` | polygons per level (code and name only), simplified, 5-decimal coordinates |
| `overlay_<id>.geojson` | overlays |
| `../index.json` | datasets the app offers; several datasets can sit side by side |

The app only reads these files, so you can also produce them with your own pipeline.
