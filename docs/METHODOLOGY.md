# Method

The PTI Builder implements the analytical logic of **PTI 2.0** (*Technical Note: Project Targeting Index 2.0 — Advancing Spatial Targeting for Operational Decision-Making and Portfolio Balancing*, World Bank Poverty & Equity GP). The note implements PTI 2.0 with ArcGIS Pro's Weighted Raster Overlay and the Experience Builder Suitability Modeler. This tool keeps the method and drops the platform dependency: it runs in any browser, from a static website, on data prepared with open-source Python.

Where the two differ, it is noted below.

## 1. Spatial units, not just administrative boundaries

PTI 2.0 moves from fixed administrative polygons to a surface that can hold data at any scale. Here the **base unit** is whatever the dataset declares as its finest level:

- administrative units (wards, communes, districts)
- a regular grid, which is the raster-cell equivalent (the Demoland example uses ~5 km cells)
- settlements, catchments or any other polygon set

Coarser levels (district, region …) are derived by aggregating base-unit scores, so the same run can be read at any level.

Indicators can be measured at any level. A district-level survey estimate is stored on every base unit in the district, and the app labels it with the level it was measured at. Classification is done **at the indicator's native level** (one value per district, not one per grid cell). Otherwise a district containing 900 cells would pull the class breaks toward its own value.

> *Difference from the note:* WRO rasterises everything to cells first. Zonal statistics (`type: raster`) bring raster inputs onto the base units instead. With a fine grid as the base unit, the two converge.

## 2. Categorisation

Each selected indicator is split into **N classes** (default 5, configurable 3–9):

| Method | Breaks | Use when |
|---|---|---|
| **Quantile** (default) | equal number of units per class | most indicators; robust to skew and outliers |
| **Equal interval** | equal-width value ranges | values with a meaningful linear scale |
| **Natural breaks** | optimal 1-D clustering (Jenks / ckmeans) | clearly clustered distributions |
| **Fixed thresholds** (`scoring.type: breaks`) | set in the configuration | policy or sector thresholds (e.g. IPC, WHO cut-offs) |
| **Category scores** (`scoring.type: categories`) | each value mapped to a score | categorical or binary layers: constraints, masks, phases |

Ties are allowed. Breaks are inclusive upper bounds. An indicator with no variation cannot be classified; the app warns and it contributes nothing.

## 3. Scoring and direction

Classes are scored **1 to N**. Each indicator has a **direction**:

- **ascending** (↑): a higher value means a higher score, i.e. higher priority (poverty rate, travel time)
- **descending** (↓): a higher value means a lower score (enrolment, electricity access)

Directions are set per indicator in the configuration and can be flipped in the app. Values can be negative (vegetation change, growth rates), because classification works on any real numbers. PTI 1.0 needed data pre-flipped to "higher = priority"; that is no longer necessary.

A layer scored with fixed thresholds that define fewer than N classes is rescaled linearly onto 1..N, so it combines on the same scale as everything else. Category scores are used as given and ignore direction.

## 4. Weighting and combination

Weights are percentages that must sum to 100. The composite for unit *i* is the weighted mean of its class scores:

```
raw_i   = Σ_k  w_k · s_ik            (Σ w_k = 1, s in 1..N)
index_i = (raw_i − 1) / (N − 1) × 100
```

The 0–100 **PTI score** is a linear rescaling of the weighted 1..N suitability score. 0 means the lowest class on every selected indicator and 100 the highest. Rankings are identical to the raw WRO-style score.

Worked example from the note (two inputs on a 1–3 scale, weights 75/25, cell scores 2 and 3): `2 × 0.75 + 3 × 0.25 = 2.25`. This is checked in `tests/core.test.js`.

> *Difference from the note:* WRO rounds the output to an integer raster. The score here is kept continuous, so ties are rarer and rankings finer.

## 5. Missing data

PTI 2.0 requires inputs to be **filled inside the study area**. Here that is an explicit, documented choice per indicator (`fill:` in the configuration):

| fill | Meaning |
|---|---|
| a number, `zero` | a known default, e.g. no recorded events = 0 |
| `median`, `mean`, `min`, `max` | computed over the indicator's native units |
| *(none)* | leave the gap |

Remaining gaps count against the unit's **coverage**, the share of the selected weight it has data for. A unit is scored only if coverage ≥ `min_coverage` (default 1.0, i.e. complete data). Above that threshold its weights are renormalised over the indicators it has. The app reports how many units were filled, partly scored or left unscored, and the run notes record it per indicator.

## 6. Aggregation

A district (or region) score is the mean of its base-unit scores, **population-weighted** when the dataset has population. Population weighting describes the average person rather than the average unit; switch it off in the app for an unweighted mean.

**Priority groups** ("Very low" … "Very high") are quantile groups of the scores shown, so they are relative to the run, not fixed thresholds.

## 7. Thematic PTIs

Instead of one index, a dataset defines several **thematic PTIs** (Energy, Nutrition, Social Development, …). Each is a named set of indicators and weights built with the same method. They appear in the PTI selector, and any of them can be edited into a custom run.

## 8. Political-economy and operational constraints

Where a constraint has a spatial dimension (restricted access, conflict-affected zones, funding quotas), add it as a layer, usually with category scores. The Demoland example scores `operational_access` as 5 (open) or 1 (restricted), and its "Core PTI + operational access" thematic PTI shows the effect. Constraints without a spatial form still have to be weighed outside the tool.

## 9. Testing sensitivity and robustness

The note asks users to *test sensitivity*, *assess robustness* and *identify gaps*. The app supports all three:

- **Compare runs.** Save a run and compare later ones against it: rank correlation (Spearman), top-20% overlap, and overlaid score distributions.
- **Robustness test.** Re-runs the PTI 200 times with every weight multiplied by a random factor (±25/50/75%) and renormalised. For each unit it reports the share of runs in which the unit lands in the top group (top 10/20/30%). It also reports the mean rank correlation with the baseline and the share of the baseline top group that stays there in at least 80% of runs. Units in the top group 20–80% of the time are **borderline**: their priority depends on the weights. Class breaks are held fixed, because they don't depend on weights.
- **Unit profile.** Click any unit to see each indicator's value, class, weight and points. The points sum to the score. This is the "layer query" listed as a future enhancement in the note.

## 10. Portfolio balance

When a dataset includes a portfolio layer (`role: portfolio`, e.g. project locations from GEMS or the Operations Portal), the Portfolio tab compares where projects are with where the index points:

- share of projects against share of population, by priority group
- share of projects in the lowest-priority groups
- **gaps**: highest-priority units with no project

These are prompts for discussion, not siting decisions.

## 11. Communicating results

The app follows section 6.6 of the note:

- The legend and exports describe the output as a *relative composite index, conditional on the selected indicators and weights*.
- The data dictionary (About → Data dictionary) lists every indicator's source, year, level, direction, unit, fill rule and scoring, and can be downloaded.
- **Run notes** (↓ Run notes) record everything needed to reproduce or cite a run: method, classes, weights, directions, the actual class breaks, fill and missing counts, aggregation and robustness settings.

## Limitations

- Results are only as current and consistent as the inputs. Countries without recent census or survey data may need proxies or partial coverage.
- Quantile classes discard magnitude: a unit just inside the top class scores the same as the most extreme one. Use fixed thresholds where magnitude matters.
- Weights are a judgement. The robustness test shows how much rankings depend on them, but it does not choose them.
- Broadcast coarse indicators add no variation within their parent units. The app warns when the map is shown below the coarsest selected indicator's level.
