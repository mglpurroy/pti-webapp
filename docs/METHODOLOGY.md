# Method

The PTI Builder follows the World Bank **devPTIpack methodology**:
<https://worldbank.github.io/devPTIpack/articles/methodology.html> (package: <https://github.com/worldbank/devPTIpack>).
It reproduces the R package's results exactly; see [Testing against devPTIpack](#testing-against-devptipack).

The index is computed in the browser by [`app/js/pti-core.js`](../app/js/pti-core.js). The data preparation that devPTIpack does in R (the metadata workbook, zonal statistics, hexagon aggregation) is done by [`prep/build_dataset.py`](../prep/build_dataset.py). An existing devPTIpack dashboard can also be loaded directly with [`prep/import_devptipack.py`](../prep/import_devptipack.py).

## 1. Spatial levels

A dataset has one or more spatial levels, ordered coarse to fine: regions → districts → wards, optionally down to a hexagonal or square grid. Every unit carries the code of the unit it lies in at each coarser level.

Each indicator is prepared at the levels it should be available at. Values come either from data published at that level (a survey representative at region level, say) or from aggregation done during preparation (see §5).

## 2. Normalisation: z-scores, per level

Each indicator *j* is standardised among the units *i* of a level:

```
z_ij = (x_ij − mean_j) / sd_j
```

- The mean and standard deviation are computed **separately at every level**. Districts are compared with districts and regions with regions, so the same raw value can have a different z-score at different levels.
- `sd` is the sample standard deviation (n − 1), as R's `sd()`.
- A level with one unit, or with identical values, gives every unit z = 0 (no information), as devPTIpack does.
- Missing values stay missing.

## 3. The index: signed, weighted sum

```
PTI_i = Σ_j  w_j · z_ij
```

- **The sign of the weight is the direction.** A positive weight means higher values push a unit toward higher priority (poverty rate). A negative weight means higher values push it toward lower priority (electricity access).
- **The size of the weight is relative importance.** A weight of 2 counts twice as much as a weight of 1. Weights don't need to sum to anything.
- A weight of 0 leaves the indicator out.

A dataset ships **weighting schemes** (the devPTIpack `weights_table`). Users can start from one, change any weight, or build their own.

## 4. Projection across levels

At level *L*, each selected indicator contributes:

| Indicator available… | Contribution at *L* |
|---|---|
| at *L* | its z-score at *L* |
| not at *L*, but at a coarser level | the z-score of the **finest coarser level** that has it, copied to every unit inside: **top-down projection**, normalised at the coarser level and **not re-normalised** |
| only at finer levels | nothing: the indicator is **not used at *L*** and the app says so |

The methodology states that data is **not aggregated upward**. Where an indicator should count at a coarser level, its values for that level are prepared explicitly during data preparation (§5).

> **devPTIpack code mode.** The R code (`expand_adm_levels()` / `agg_pti_scores()`) does aggregate upward. Where an indicator is missing at the target level, it takes the finest level available, coarser or finer, and averages finer-level z-scores within each target unit (unweighted). Set `app.cross_level: devptipack_code` to reproduce this, for example when comparing with an existing devPTIpack dashboard. The default, `project`, follows the methodology.

## 5. Preparing data at coarser levels

Values for a level come from one of:

- **a source at that level** (`sources:` in the configuration): a table, a raster summarised with zonal statistics, counted points, or an ArcGIS layer
- **aggregation from the level it was measured at** (`aggregate_to:`), done **directly** from that level to each target, never chained through intermediate levels. The function (`mean`, `sum`, `min`, `max`, `median`) and weighting (`population`, `area` or none) are set per indicator, the same rule devPTIpack applies to hexagon data:

| Indicator | Function | Weighting |
|---|---|---|
| Poverty rate | mean | population |
| Population count | sum | none |
| Night-time lights | mean | none |
| Flood exposure (index) | mean | area |

The data dictionary in the app shows how every level of every indicator was prepared.

## 6. Missing data

devPTIpack's default: **a unit missing any selected indicator gets no score and no priority** ("No data" on the map). Setting `app.missing: ignore` corresponds to devPTIpack's `na_rm_pti = TRUE`: missing terms are dropped from that unit's sum.

Gaps can also be filled during preparation with an explicit, documented rule per indicator (`fill: zero | min | max | mean | median | <number>`). The fill is applied at the measured level *before* aggregating, so coarser levels summarise the same values. The data dictionary records how many units were filled.

## 7. Priority groups

At each level the PTI values are split into **equal-size groups (quantiles)**, 5 by default (2–10 in the app). **Priority 1 is the highest PTI.** As in devPTIpack's legend:

- breaks are R type-7 quantiles at 0, 1/n, …, 1, with duplicate breaks dropped
- intervals are right-closed, with the lowest value included
- integer-valued scores with fewer than 12 distinct values are grouped by value

## 8. Choosing weights: sensitivity

Weights are agreed by consensus: experiment, check sensitivity, then settle them with the project team and counterparts. The app supports each step:

- **Experiment.** Change any weight and re-run; the map, table and distribution update.
- **Compare schemes** (Sensitivity tab). Against any shipped scheme or saved run, at the level shown: Spearman rank correlation, Priority 1 overlap, and how many units change group.
- **Random weights** (Sensitivity tab). 200 re-runs with every weight multiplied by a random factor (±25/50/75%, signs kept). The tab reports mean and minimum rank correlation, the share of the top group that stays there in at least 80% of draws, and which units are **borderline** (in the top group in 20–80% of draws). These can also be mapped.
- **Unit profile.** Click a unit to see each indicator's value, z-score, weight and term *w·z*. The terms sum to the PTI, and projected indicators show the level they came from.

Rankings are most sensitive when few indicators are used or when they are only loosely correlated.

## 9. Beyond the index

These features don't change the index:

- **Data explorer.** Map any indicator's raw values at any level: the "one-stop shop" role of a PTI dashboard.
- **Portfolio balance.** With a project layer (`role: portfolio`): share of projects against share of population by priority group, and Priority 1 units without a project.
- **Overlays.** Roads, facilities, settlements.
- **Run notes.** Everything needed to reproduce or cite a run: weights, how each indicator was used, the mean and sd it was normalised with, group breaks and missing-data handling.

As the methodology stresses, identifying priority areas should not rest on the PTI alone. Complement it with field knowledge, and record site-level implementation challenges.

## Differences from the devPTIpack code

The published methodology and the R code differ in two places. This implementation follows the **methodology**.

1. **Weight magnitude.** The methodology says a weight of +2 makes an indicator twice as influential. The R code multiplies values by the weight *before* z-scoring (`get_weighted_data()` → `get_scores_data()`). Since z(w·x) = sign(w)·z(x), only the sign survives, and +2 gives exactly the same PTI as +1. This was confirmed by running the package on its Rwanda sample: identical scores at every level. Here the weight multiplies the z-score, as the methodology states.
2. **Upward aggregation.** The methodology says finer data is not aggregated upward (except hexagon data, during preparation). The R code averages finer z-scores into coarser units when an indicator is missing at the target level, and its own tests assert this. Here that behaviour is opt-in (`cross_level: devptipack_code`).

With weights of ±1 (where the two readings coincide) and `cross_level: devptipack_code`, results match the R package exactly.

## Testing against devPTIpack

`tests/fixtures/make_devptipack_fixtures.R` runs devPTIpack's own calculation functions on its bundled **Rwanda** and **Ukraine** samples. The Ukraine sample is an edge-case set: indicators only at ADM1, at ADM1+2, at ADM2+4 and only at the hexagon level, with missing values and a zero-variance indicator. The script uses four weighting schemes and both missing-data modes, and saves the inputs and PTI scores.

`tests/core.test.js` checks:

- the worked examples in the methodology article: z-scores at ADM1 and ADM2, the two-indicator PTI, projection from ADM1 to ADM2
- **code mode equals the R pipeline at every level**, for all schemes and both missing-data modes, on both samples (tolerance 1e-8 relative)
- **methodology mode equals the R pipeline** wherever no finer-only indicator is involved

`tests/import.test.js` imports devPTIpack's sample deployment bundle (`metadata.xlsx` + `shapefiles.zip`) with `import_devptipack.py`, runs the index on the imported files, and compares more than 10,000 unit scores with the R results.

## References

- devPTIpack methodology: <https://worldbank.github.io/devPTIpack/articles/methodology.html>
- Finn, A., & Masaki, T. (2020). *Subnational Targeting of Project Sites Using Project Targeting Index (PTI)*. Poverty and Equity Notes No. 33. World Bank.
- Masaki, T., Bosch, L., Finn, A., Meyer, M., Haider, S. Z., & Bukin, E. (2022). *Dashboards for development: the power of geospatial data at your fingertips*. Poverty and Equity Notes No. 47. World Bank.
- World Bank (2019). *Approaches to targeting in South Sudan*.
