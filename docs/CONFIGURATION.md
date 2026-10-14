# Configuring a dataset (`pti.yaml`)

One YAML file describes a country (or any study area): its spatial levels, indicators, weighting schemes and overlays. `prep/build_dataset.py` reads it and writes everything the app needs to `app/data/<id>/`.

```bash
python prep/build_dataset.py path/to/pti.yaml --check   # validate sources and joins only
python prep/build_dataset.py path/to/pti.yaml           # build
```

Paths are relative to the YAML file. The complete working example is [`prep/examples/demoland/pti.yaml`](../prep/examples/demoland/pti.yaml).

**Already have a devPTIpack dashboard?** Skip the YAML and import its `metadata.xlsx` and `shapefiles.zip`:

```bash
python prep/import_devptipack.py metadata.xlsx shapefiles.zip --id <country>
```

## Top level

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | dataset id; also the folder name under `app/data/` and the `?data=` URL parameter |
| `output` | no | output folder (default `../../app/data/<id>`) |
| `app` | yes | what the app shows; see below |
| `levels` | yes | spatial levels, coarse → fine |
| `population` | no | population, used for population-weighted aggregation, per-capita point stats and the portfolio view |
| `indicators` | yes | the indicator list |
| `overlays` | no | context and portfolio layers |
| `simplify` | no | per-level (or per-overlay) simplification tolerance in degrees, e.g. `{district: 0.001}` |

## `app`

| Key | Default | Meaning |
|---|---|---|
| `title` | Project Targeting Index | header title |
| `country`, `subtitle` | | header subtitle; `country` also names downloaded files |
| `default_level` | second-finest level | level shown first |
| `bins` | 5 | number of priority groups (2–10) |
| `missing` | `no_priority` | `no_priority`: units missing a selected indicator get no score (devPTIpack default); `ignore`: missing terms are left out of the sum (`na_rm_pti`) |
| `cross_level` | `project` | `project`: coarser z-scores are copied down and finer data is never used upward (methodology); `devptipack_code`: also average finer z-scores up, as the R code does |
| `pillars` | | `[{name, color}]`: thematic areas, in sidebar order |
| `scenarios` | | weighting schemes: `[{id, label, description, weights: {indicator_id: w}}]` with **signed** weights |
| `about` | | `{disclaimer, contact}`, shown in About |
| `map` | fit to boundaries | `{center: [lat, lon], zoom}` |
| `basemap` | Esri Light Gray (no key needed) | `{tiles: [xyz url], labels: [xyz url], attribution}` |
| `arcgis_publish` | off | `{portal: https://…}` shows the **⬆ ArcGIS** publish button |
| `data_refresh_note` | | `{text, command}` shows a "Refreshing the data" note in the sidebar |

Weights: a positive value means higher values raise priority; a negative value means they lower it; the size is relative importance (2 = twice as influential as 1). See [METHODOLOGY.md](METHODOLOGY.md).

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

**Parents.** Every unit needs the code of each coarser level it lies in. If the boundary file carries them, map them with `parents:`. Otherwise each unit is assigned to the coarser polygon containing its representative point, and units outside every polygon go to the nearest one, with a warning. A grid or hexagon level works the same way.

Duplicate codes are dissolved into multipart units, with a warning.

## `indicators`

```yaml
- id: poverty_rate             # column name; letters, digits, underscore
  label: Poverty rate
  pillar: Poverty & Welfare
  higher_is_worse: true        # optional hint: default sign when ticked, and explorer colours
  unit: "%"
  year: 2023
  source_note: Small-area estimate, LSS 2023
  description: …               # optional, shown on hover
  level: ward                  # where `source` is measured (default: finest level)
  source: …                    # see below
  aggregate_to: [lga, state]   # optional: coarser levels computed from `level`
  aggregate: {fn: mean, weight: population}
  sources:                     # optional: values supplied directly at other levels
    state: {type: table, file: inputs/state_survey.csv, key: statecode, column: pov}
  fill: median                 # optional: number | zero | min | max | mean | median
  pti: true                    # false = Data Explorer only, not offered in the PTI
```

An indicator is available at `level`, each `aggregate_to` level, and each `sources` level, and nowhere else. In the app, a level without the indicator takes the z-score of the finest coarser level that has it. Finer-only indicators are not used at coarser levels.

`aggregate` goes **directly** from `level` to each target, with `fn` one of `mean | sum | min | max | median` and `weight` one of `population | area | none`. Choose by the indicator's nature: rates take a population-weighted mean, counts a sum, indices an area-weighted mean.

`fill` is applied at the measured level before aggregating, and again at any other level that still has gaps. It is recorded in the data dictionary.

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

**raster**: a GeoTIFF summarised over each unit (zonal statistics):

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

`python prep/list_webmap_layers.py <webmap item id> --yaml draft.yaml` lists every layer of a web map (for example the one behind a Hub site or Data Explorer) and drafts these entries.

## `population`

```yaml
population:
  level: ward                  # default: finest level
  source: {type: table, file: inputs/pop.csv, key: ward_code, column: pop_2025}
```

Any source type works; a WorldPop raster with `stat: sum` is common. Population is summed to every coarser level.

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

## What the build checks

- every level's code field exists; parent assignment and orphans
- every indicator source's key and column exist, and at least one value joins at each level
- coverage per indicator at every level it is prepared for, with gaps flagged
- `aggregate_to` levels are coarser than `level`; `aggregate` options are valid
- scheme weights reference PTI indicators, are numeric and not all zero
- leftover PTI 2.0 keys (`direction`, `scoring`) are rejected with an explanation

## Output files

| File | Content |
|---|---|
| `config.json` | the `app` settings, levels, indicator dictionary (levels, provenance, fills) and overlay list |
| `data_<level>.json` | one row per unit: own and ancestor codes and names, area, population, and the values of indicators available at that level |
| `boundaries_<level>.geojson` | polygons per level (code and name only), simplified, 5-decimal coordinates |
| `overlay_<id>.geojson` | overlays |
| `../index.json` | datasets the app offers; several can sit side by side |

Indicator values are written at full precision, because z-scores depend on the spread and rounding can erase it. The app only reads these files, so they can also come from another pipeline.
