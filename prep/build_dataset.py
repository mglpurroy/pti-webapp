"""Build a PTI Builder dataset from a pti.yaml.

Reads boundaries, indicator sources and overlays, prepares every indicator at
each spatial level it should be available at, checks the result, and writes
the files the web app loads:

    app/data/<id>/config.json              app settings + indicator dictionary
    app/data/<id>/data_<level>.json        one row per unit of each level
    app/data/<id>/boundaries_<level>.geojson
    app/data/<id>/overlay_<id>.geojson
    app/data/index.json                    list of datasets the app offers

The app follows the devPTIpack methodology: indicators are z-scored among the
units of each level they are available at, and the app itself never
aggregates data upward. Values at coarser levels are therefore prepared here,
explicitly, per indicator — either supplied directly (`sources:`) or
aggregated straight from the level they were measured at (`aggregate_to:`),
with the function and weighting set per indicator, as devPTIpack does for
hexagon data.

Indicator sources (`source.type`):
    table    CSV / Excel / any attribute table, keyed by a unit code or name
    raster   GeoTIFF summarised over each unit (zonal statistics)
    points   point features counted per unit (count, per km², per 1,000 people)
    arcgis   an ArcGIS Online / Enterprise feature layer (optional; see arcgis_rest.py)

Usage:
    python prep/build_dataset.py prep/examples/demoland/pti.yaml
    python prep/build_dataset.py my_country/pti.yaml --check     # validate only

See docs/CONFIGURATION.md for every option.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
import warnings
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import yaml

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

EQUAL_AREA = "EPSG:6933"  # for areas in km²
APP_KEYS = {  # pti.yaml `app:` keys passed through to config.json
    "title", "country", "subtitle", "default_level", "bins", "missing", "cross_level",
    "legend", "map", "basemap", "pillars", "scenarios", "about", "arcgis_publish", "banner",
    "data_refresh_note",
}
AGG_FNS = {"mean", "sum", "min", "max", "median"}
AGG_WEIGHTS = {"population", "area", "none", None}


class BuildError(RuntimeError):
    pass


def log(msg: str = "") -> None:
    print(msg, flush=True)


# ── Reading sources ───────────────────────────────────────────

def _arcgis():
    try:
        import arcgis_rest
    except ImportError as e:  # requests missing
        raise BuildError(f"type: arcgis needs the 'requests' package ({e})")
    return arcgis_rest


def read_vector(spec: dict, base_dir: Path) -> gpd.GeoDataFrame:
    """A vector layer from a file path or an ArcGIS feature layer URL."""
    if spec.get("arcgis") or spec.get("type") == "arcgis":
        ag = _arcgis()
        url = spec.get("arcgis") or spec["url"]
        gj = ag.query_geojson(url, ag.load_token(), where=spec.get("where", "1=1"))
        if not gj["features"]:
            raise BuildError(f"{url} returned no features")
        return gpd.GeoDataFrame.from_features(gj["features"], crs="EPSG:4326")
    path = base_dir / spec["file"]
    if not path.exists():
        raise BuildError(f"file not found: {path}")
    gdf = gpd.read_file(path, layer=spec.get("layer"))
    if gdf.crs is None:
        warnings.warn(f"{path.name} has no CRS — assuming EPSG:4326")
        gdf = gdf.set_crs("EPSG:4326")
    return gdf.to_crs("EPSG:4326")


def read_table(spec: dict, base_dir: Path) -> pd.DataFrame:
    if spec.get("type") == "arcgis":
        ag = _arcgis()
        return ag.query_table(spec["url"], ag.load_token(), where=spec.get("where", "1=1"))
    path = base_dir / spec["file"]
    if not path.exists():
        raise BuildError(f"file not found: {path}")
    suf = path.suffix.lower()
    key_types = {k: str for k in (spec.get("key"), spec.get("name_key")) if k}
    if suf in {".csv", ".txt"}:
        return pd.read_csv(path, dtype=key_types)
    if suf in {".xlsx", ".xls"}:
        return pd.read_excel(path, sheet_name=spec.get("sheet", 0), dtype=key_types)
    if suf == ".parquet":
        return pd.read_parquet(path)
    return pd.DataFrame(gpd.read_file(path, layer=spec.get("layer")).drop(columns="geometry", errors="ignore"))


# ── Levels and boundaries ─────────────────────────────────────

def load_levels(cfg: dict, base_dir: Path) -> tuple[list[dict], dict[str, gpd.GeoDataFrame]]:
    levels = cfg.get("levels") or []
    if not levels:
        raise BuildError("no `levels` defined")
    keys = [lv["key"] for lv in levels]
    if len(set(keys)) != len(keys):
        raise BuildError(f"duplicate level keys: {keys}")
    geos: dict[str, gpd.GeoDataFrame] = {}
    for lv in levels:
        b = lv.get("boundaries")
        if not b:
            raise BuildError(f"level '{lv['key']}' has no `boundaries`")
        g = read_vector(b, base_dir)
        src_code = b.get("code_field", lv["code"])
        src_name = b.get("name_field", lv.get("name"))
        if src_code not in g.columns:
            raise BuildError(f"level '{lv['key']}': code field '{src_code}' not in {list(g.columns)[:15]}")
        keep = {src_code: lv["code"]}
        if src_name and src_name in g.columns:
            keep[src_name] = lv["name"]
        # Parent codes already on the file (e.g. a ward file that carries lga codes)
        parents = lv.get("parents") if isinstance(lv.get("parents"), dict) else {}
        for parent_key, field in parents.items():
            plv = next((x for x in levels if x["key"] == parent_key), None)
            if plv is None or field not in g.columns:
                raise BuildError(f"level '{lv['key']}': parent '{parent_key}' field '{field}' not found")
            keep[field] = plv["code"]
        g = g[list(keep) + ["geometry"]].rename(columns=keep)
        for c in keep.values():
            if c != lv.get("name"):
                g[c] = g[c].astype(str).str.strip()
        if lv["name"] not in g.columns:
            g[lv["name"]] = g[lv["code"]]
        if g[lv["code"]].duplicated().any():
            n = int(g[lv["code"]].duplicated().sum())
            log(f"  {lv['key']}: {n} duplicate code(s) — dissolving into multipart units")
            g = g.dissolve(by=lv["code"], as_index=False, aggfunc="first")
        g = g[~g.geometry.is_empty & g.geometry.notna()].reset_index(drop=True)
        g["geometry"] = g.geometry.make_valid()
        geos[lv["key"]] = g
        log(f"  {lv['label']:<12} {len(g):>7,} units  ({lv['key']})")
    return levels, geos


def level_tables(levels: list[dict], geos: dict[str, gpd.GeoDataFrame]) -> dict[str, pd.DataFrame]:
    """One table per level: its units with the code and name of every coarser level.

    Parent codes come from the boundary file when it has them (`parents:`);
    otherwise each unit is assigned to the parent polygon containing its
    representative point, or the nearest one if it falls outside them all.
    Also adds area_km2.
    """
    tables: dict[str, pd.DataFrame] = {}
    for k, lv in enumerate(levels):
        g = geos[lv["key"]].copy()
        pts = gpd.GeoDataFrame(g[[lv["code"]]], geometry=g.geometry.representative_point(), crs=g.crs)
        for plv in levels[:k]:
            pg = geos[plv["key"]]
            if plv["code"] not in g.columns:
                j = gpd.sjoin(pts, pg[[plv["code"], "geometry"]], how="left", predicate="within")
                j = j[~j.index.duplicated()]
                g[plv["code"]] = j[plv["code"]].values
                miss = g[plv["code"]].isna().values
                if miss.any():
                    near = gpd.sjoin_nearest(pts[miss].to_crs(EQUAL_AREA),
                                             pg[[plv["code"], "geometry"]].to_crs(EQUAL_AREA), how="left")
                    near = near[~near.index.duplicated()]
                    g.loc[near.index, plv["code"]] = near[plv["code"]].values
                    log(f"  {lv['label']} → {plv['label']}: {int(miss.sum())} unit(s) outside every "
                        f"{plv['label'].lower()} polygon, assigned to the nearest")
            names = pg.set_index(plv["code"])[plv["name"]]
            g[plv["name"]] = g[plv["code"]].map(names)
            orphan = int(g[plv["name"]].isna().sum())
            if orphan:
                log(f"  WARNING: {orphan} {lv['label'].lower()} unit(s) have a {plv['label']} code "
                    f"not found in the {plv['label'].lower()} boundaries")
        cols = [c for p in levels[:k + 1] for c in (p["code"], p["name"])]
        t = pd.DataFrame(g[cols]).reset_index(drop=True)
        t["area_km2"] = g.to_crs(EQUAL_AREA).area.values / 1e6
        tables[lv["key"]] = t
    return tables


def level_of(levels: list[dict], key: str) -> dict:
    lv = next((x for x in levels if x["key"] == key), None)
    if lv is None:
        raise BuildError(f"unknown level '{key}' (levels: {[x['key'] for x in levels]})")
    return lv


# ── Indicator values ──────────────────────────────────────────

def values_from_table(src: dict, lv: dict, geos, base_dir: Path) -> pd.Series:
    df = read_table(src, base_dir)
    col = src.get("column")
    if col not in df.columns:
        raise BuildError(f"column '{col}' not in table ({list(df.columns)[:15]})")
    if src.get("name_key"):
        # Join on unit names when the source has no usable code. Exact,
        # case-insensitive match only — fuzzy matching would silently pair the
        # wrong units; unmatched rows are reported and dropped.
        nk = src["name_key"]
        lookup = (geos[lv["key"]][[lv["code"], lv["name"]]]
                  .assign(_n=lambda d: d[lv["name"]].astype(str).str.strip().str.lower())
                  .drop_duplicates("_n").set_index("_n")[lv["code"]])
        df["_code"] = df[nk].astype(str).str.strip().str.lower().map(lookup)
        n, m = int(df[nk].notna().sum()), int(df["_code"].notna().sum())
        log(f"      name join on '{nk}': {m:,} of {n:,} source rows matched, "
            f"covering {df['_code'].nunique():,} of {len(lookup):,} {lv['label'].lower()} names")
        key = "_code"
    else:
        key = src.get("key", lv["code"])
        if key not in df.columns:
            raise BuildError(f"key '{key}' not in table ({list(df.columns)[:15]})")
        df = df[df[key].notna()].copy()
        df[key] = df[key].astype(str).str.strip()
    vals = pd.to_numeric(df[col], errors="coerce")
    s = pd.Series(vals.values, index=df[key].values).dropna()
    s = s[s.index.notna()]
    if s.index.duplicated().any():
        agg = src.get("agg", "mean")
        log(f"      {int(s.index.duplicated().sum())} duplicate key(s) — {agg} per unit")
        s = s.groupby(level=0).agg(agg)
    return s


def values_from_raster(src: dict, lv: dict, geos, base_dir: Path) -> pd.Series:
    try:
        from rasterstats import zonal_stats
        import rasterio
    except ImportError:
        raise BuildError("raster sources need `pip install rasterstats rasterio`")
    path = base_dir / src["file"]
    stat = src.get("stat", "mean")
    g = geos[lv["key"]]
    with rasterio.open(path) as r:
        crs = r.crs
    gp = g.to_crs(crs) if crs else g
    zs = zonal_stats(gp.geometry, str(path), stats=[stat], all_touched=src.get("all_touched", False),
                     nodata=src.get("nodata"))
    return pd.Series([z.get(stat) for z in zs], index=g[lv["code"]].values, dtype="float64")


# ── Grid summaries ────────────────────────────────────────────
# Population-weighted statistics computed from a raster's own cells for
# every unit of a level — directly from the grid at each level, never from
# another level's summaries. Weights come from `population_raster`, summed
# onto the indicator's grid.
GRID_STATS = {"mean", "share_worst", "share_best", "share_above", "share_below", "percentile"}
_CTX: dict = {}          # set by build(): population_raster path
_GRID_CACHE: dict = {}   # raster path → (values, weights, transform, crs, shape)
_LABEL_CACHE: dict = {}  # (raster path, level) → (labels, fallback cells)
_CUTOFFS: dict = {}      # national cut-offs, so every level uses the same one
GRID_NOTES: dict = {}    # human-readable cut-offs for the data dictionary


def _grid(path: Path, src: dict):
    import rasterio
    from rasterio.warp import Resampling, reproject
    key = (str(path), src.get("weight", "population"))
    if key in _GRID_CACHE:
        return _GRID_CACHE[key]
    with rasterio.open(path) as r:
        a = r.read(1).astype("float64")
        nd = src.get("nodata", r.nodata)
        if nd is not None:
            a[a == nd] = np.nan
        a[~np.isfinite(a)] = np.nan
        transform, crs, shape = r.transform, r.crs, r.shape
    w = None
    pop = _CTX.get("population_raster")
    if pop is not None and src.get("weight", "population") == "population":
        w = np.zeros(shape, dtype="float64")
        with rasterio.open(pop) as p:
            reproject(source=rasterio.band(p, 1), destination=w, src_transform=p.transform, src_crs=p.crs,
                      src_nodata=p.nodata, dst_transform=transform, dst_crs=crs, dst_nodata=0,
                      resampling=Resampling.sum)
        w[~np.isfinite(w) | (w < 0)] = 0
    _GRID_CACHE[key] = (a, w, transform, crs, shape)
    return _GRID_CACHE[key]


def _labels(path: Path, lv: dict, g: gpd.GeoDataFrame, transform, crs, shape):
    """Unit index (1-based) of every cell whose centre falls in a unit. Units
    too small to contain a cell centre take the cell at their representative
    point."""
    import rasterio
    from rasterio import features
    key = (str(path), lv["key"])
    if key in _LABEL_CACHE:
        return _LABEL_CACHE[key]
    gp = g.to_crs(crs)
    lab = features.rasterize(((geom, i + 1) for i, geom in enumerate(gp.geometry)), out_shape=shape,
                             transform=transform, fill=0, dtype="int32")
    present = np.zeros(len(gp) + 1, dtype=bool)
    present[np.unique(lab)] = True
    missing = [i for i in range(len(gp)) if not present[i + 1]]
    extra = []
    if missing:
        pts = gp.geometry.iloc[missing].representative_point()
        rows, cols = rasterio.transform.rowcol(transform, pts.x.values, pts.y.values)
        extra = [(i, r, c) for i, r, c in zip(missing, rows, cols) if 0 <= r < shape[0] and 0 <= c < shape[1]]
        log(f"      {len(extra)} {lv['label'].lower()} unit(s) smaller than a cell — using the cell at their centre")
    _LABEL_CACHE[key] = (lab, extra)
    return _LABEL_CACHE[key]


def _wquantile(v: np.ndarray, w: np.ndarray, q: float) -> float:
    o = np.argsort(v)
    cw = np.cumsum(w[o])
    return float(v[o][np.searchsorted(cw, q * cw[-1])])


def values_from_grid(src: dict, lv: dict, geos, base_dir: Path) -> pd.Series:
    """Population-weighted summary of a raster per unit.

    stat: mean          weighted mean
          share_worst   % of people in the country's worst `share` (default 20%) of
                        the population distribution; "worst" follows higher_is_worse
          share_best    the same at the other end
          share_above / share_below   % of people above / below `threshold`
          percentile    weighted `p`-th percentile within the unit (default 80)
    """
    path = (base_dir / src["file"]).resolve()
    a, w, transform, crs, shape = _grid(path, src)
    g = geos[lv["key"]]
    lab, extra = _labels(path, lv, g, transform, crs, shape)
    m = lab > 0
    df = pd.DataFrame({"u": lab[m] - 1, "v": a[m], "w": w[m] if w is not None else 1.0})
    if extra:
        df = pd.concat([df, pd.DataFrame({"u": [e[0] for e in extra], "v": [a[e[1], e[2]] for e in extra],
                                          "w": [w[e[1], e[2]] if w is not None else 1.0 for e in extra]})])
    df = df[np.isfinite(df["v"])]
    # A unit with no people in any cell is summarised by area instead
    tot = df.groupby("u")["w"].transform("sum")
    df.loc[tot <= 0, "w"] = 1.0
    stat = src.get("stat", "mean")
    hiw = src.get("_higher_is_worse", True)
    W = df.groupby("u")["w"].sum()

    def share(cond):
        return (df["w"] * cond).groupby(df["u"]).sum() / W * 100

    if stat == "mean":
        res = (df["v"] * df["w"]).groupby(df["u"]).sum() / W
    elif stat in ("share_worst", "share_best"):
        q = float(src.get("share", 0.2))
        high = hiw if stat == "share_worst" else not hiw
        ck = (str(path), stat, q, high)
        if ck not in _CUTOFFS:   # national, computed once so every level shares it
            _CUTOFFS[ck] = _wquantile(df["v"].values, df["w"].values, 1 - q if high else q)
            GRID_NOTES[(str(path), stat, q)] = (_CUTOFFS[ck], high)
        cut = _CUTOFFS[ck]
        res = share(df["v"] >= cut if high else df["v"] <= cut)
    elif stat in ("share_above", "share_below"):
        t = float(src["threshold"])
        res = share(df["v"] > t if stat == "share_above" else df["v"] < t)
    elif stat == "percentile":
        p = float(src.get("p", 80)) / 100
        d = df.sort_values(["u", "v"])
        cum = d.groupby("u")["w"].cumsum()
        tot = d.groupby("u")["w"].transform("sum")
        res = d[cum >= p * tot].groupby("u")["v"].first()
    else:
        raise BuildError(f"unknown grid stat '{stat}'")
    out = pd.Series(np.nan, index=g[lv["code"]].astype(str).values, dtype="float64")
    out.iloc[res.index.values] = res.values
    return out


def values_from_points(src: dict, lv: dict, geos, base_dir: Path, tables, population) -> pd.Series:
    pts = read_vector(src, base_dir)
    if src.get("filter"):
        pts = pts.query(src["filter"])
    g = geos[lv["key"]]
    j = gpd.sjoin(pts[["geometry"]], g[[lv["code"], "geometry"]], how="inner", predicate="within")
    counts = j.groupby(lv["code"]).size().reindex(g[lv["code"]].values, fill_value=0).astype(float)
    stat = src.get("stat", "count")
    if stat == "count":
        return counts
    t = tables[lv["key"]].set_index(lv["code"])
    if stat == "per_km2":
        return counts / t["area_km2"].reindex(counts.index)
    if stat == "per_1000_pop":
        if population is None:
            raise BuildError("stat per_1000_pop needs a `population:` source")
        pop = population[lv["key"]].reindex(counts.index)
        return (counts / pop * 1000).replace([np.inf, -np.inf], np.nan)
    raise BuildError(f"unknown points stat '{stat}' (count | per_km2 | per_1000_pop)")


def values_at(src: dict, lv: dict, geos, base_dir: Path, tables, population) -> pd.Series:
    t = src.get("type", "table")
    if t in ("table", "arcgis"):
        return values_from_table(src, lv, geos, base_dir)
    if t == "raster":
        if src.get("stat", "mean") in GRID_STATS:
            return values_from_grid(src, lv, geos, base_dir)
        return values_from_raster(src, lv, geos, base_dir)
    if t == "points":
        return values_from_points(src, lv, geos, base_dir, tables, population)
    raise BuildError(f"unknown source type '{t}'")


def aggregate(values: pd.Series, src_lv: dict, dst_lv: dict, tables, population,
              fn: str = "mean", weight: str | None = None) -> pd.Series:
    """Aggregate values of one level directly to a coarser level.

    Always straight from the measured level to each target (never chained
    through intermediate levels), with the function and weighting chosen per
    indicator — the rule devPTIpack applies to hexagon data.
    """
    t = tables[src_lv["key"]][[src_lv["code"], dst_lv["code"], "area_km2"]].copy()
    t["v"] = t[src_lv["code"]].map(values)
    if weight == "population":
        if population is None:
            raise BuildError("aggregate weight 'population' needs a `population:` source")
        t["w"] = t[src_lv["code"]].map(population[src_lv["key"]])
    elif weight == "area":
        t["w"] = t["area_km2"]
    else:
        t["w"] = 1.0
    t = t.dropna(subset=["v", dst_lv["code"]])
    g = t.groupby(dst_lv["code"])
    if fn == "mean":
        if weight in ("population", "area"):
            t = t[t["w"] > 0]
            return t.groupby(dst_lv["code"]).apply(lambda d: np.average(d["v"], weights=d["w"]), include_groups=False)
        return g["v"].mean()
    return g["v"].agg(fn)


def fill_value(values: pd.Series, rule):
    if rule is None:
        return None
    if isinstance(rule, (int, float)) and not isinstance(rule, bool):
        return float(rule)
    v = values.dropna()
    return {"zero": 0.0, "min": v.min(), "max": v.max(), "mean": v.mean(), "median": v.median()}.get(rule)


def describe_source(src: dict) -> str:
    t = src.get("type", "table")
    if t == "raster":
        name, stat = Path(src["file"]).name, src.get("stat", "mean")
        wtd = "population-weighted " if _CTX.get("population_raster") and src.get("weight", "population") == "population" else ""
        if stat in ("share_worst", "share_best"):
            q = float(src.get("share", 0.2))
            note = GRID_NOTES.get((str((_CTX["base_dir"] / src["file"]).resolve()), stat, q))
            cut = f" ({'≥' if note[1] else '≤'} {note[0]:.4g}, national cut-off)" if note else ""
            return f"% of people in the country's {'worst' if stat == 'share_worst' else 'best'} {q:.0%}{cut} of {name}"
        if stat in ("share_above", "share_below"):
            return f"% of people {'above' if stat == 'share_above' else 'below'} {src['threshold']} in {name}"
        if stat == "percentile":
            return f"{wtd}{src.get('p', 80)}th percentile of {name} within the unit"
        return f"raster {wtd}{stat} of {name}"
    if t == "points":
        return f"points ({src.get('stat', 'count')}) from {Path(src['file']).name}"
    if t == "arcgis":
        return f"ArcGIS layer {src.get('url', '')}"
    return f"table {Path(src.get('file', '')).name}"


# ── Output helpers ────────────────────────────────────────────

def sig(v, digits: int = 10):
    """Round to significant digits (area, population)."""
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return None
    if isinstance(v, (int, np.integer)):
        return int(v)
    if isinstance(v, (float, np.floating)):
        if v == 0:
            return 0
        return float(f"{float(v):.{digits}g}")
    return v


def full(v):
    """A float as JSON-safe Python float (shortest exact repr), or None."""
    if v is None:
        return None
    v = float(v)
    return v if math.isfinite(v) else None


def round_coords(obj, nd: int = 5):
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, list):
        return [round_coords(x, nd) for x in obj]
    return obj


def write_geojson(gdf: gpd.GeoDataFrame, path: Path, props: list[str], tolerance: float | None) -> int:
    g = gdf[props + ["geometry"]].copy()
    if tolerance:
        g["geometry"] = g.geometry.simplify(tolerance, preserve_topology=True)
    feats = []
    for rec, geom in zip(g[props].to_dict("records"), g.geometry):
        if geom is None or geom.is_empty:
            continue
        gj = geom.__geo_interface__
        feats.append({"type": "Feature",
                      "properties": {k: (None if (isinstance(v, float) and not math.isfinite(v)) else v)
                                     for k, v in rec.items()},
                      "geometry": {"type": gj["type"],
                                   "coordinates": round_coords(json.loads(json.dumps(gj["coordinates"])))}})
    path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")),
                    encoding="utf-8")
    return path.stat().st_size


def write_dataset(out: Path, ds_id: str, app: dict, levels: list[dict], geos, tables,
                  values: dict[str, dict[str, pd.Series]], indicators_meta: list[dict],
                  population: dict[str, pd.Series] | None, overlays: list[tuple[dict, gpd.GeoDataFrame]],
                  simplify: dict | None = None) -> None:
    """Write everything the app reads. Shared by build_dataset and import_devptipack."""
    out.mkdir(parents=True, exist_ok=True)
    log(f"\nWriting {out}")
    simplify = simplify or {}
    for lv in levels:
        size = write_geojson(geos[lv["key"]], out / f"boundaries_{lv['key']}.geojson",
                             [lv["code"], lv["name"]], simplify.get(lv["key"]))
        log(f"  boundaries_{lv['key']}.geojson  {size / 1e6:.1f} MB")
    for meta, g in overlays:
        size = write_geojson(g, out / meta["file"], meta["fields"], simplify.get(meta["id"]))
        log(f"  {meta['file']}  {size / 1e6:.2f} MB")

    for lv in levels:
        t = tables[lv["key"]].copy()
        code = t[lv["code"]]
        if population is not None:
            t["population"] = code.map(population[lv["key"]]).values
        ind_cols = []
        for iid, by_level in values.items():
            if lv["key"] in by_level:
                t[iid] = code.map(by_level[lv["key"]]).astype(float).values
                ind_cols.append(iid)
        # Indicator values are written at full precision: z-scores depend on
        # the spread, which rounding can erase when values share a large offset
        exact = set(ind_cols)
        rows = [{k: (full(v) if k in exact else sig(v) if k in {"area_km2", "population"} else v)
                 for k, v in rec.items()} for rec in t.to_dict("records")]
        p = out / f"data_{lv['key']}.json"
        p.write_text(json.dumps(rows, separators=(",", ":"), allow_nan=False), encoding="utf-8")
        log(f"  data_{lv['key']}.json  {len(rows):,} rows × {len(ind_cols)} indicators  {p.stat().st_size / 1e6:.1f} MB")

    config = {
        "id": ds_id,
        **app,
        "method": "devPTIpack",
        "levels": [{k: lv[k] for k in ("key", "label", "code", "name") if k in lv} for lv in levels],
        "population": population is not None,
        "indicators": indicators_meta,
        "overlays": [m for m, _ in overlays],
        "built": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    (out / "config.json").write_text(json.dumps(config, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    log("  config.json")

    index_path = out.parent / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {"datasets": []}
    entry = {"id": ds_id, "path": out.name, "label": app.get("country") or ds_id}
    index["datasets"] = [d for d in index["datasets"] if d["id"] != ds_id] + [entry]
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"  index.json  ({len(index['datasets'])} dataset(s))")


# ── Validation ────────────────────────────────────────────────

def validate_config(cfg: dict, levels: list[dict], indicators: list[dict]) -> list[str]:
    """Problems that would make the app misbehave. Returned, not raised, so
    every one is reported in a single run."""
    errs: list[str] = []
    ids = [i["id"] for i in indicators]
    keys = [lv["key"] for lv in levels]
    rank = {k: r for r, k in enumerate(keys)}
    for i in indicators:
        iid = i.get("id", "?")
        lvl = i.get("level", keys[-1])
        if lvl not in rank:
            errs.append(f"indicator '{iid}': unknown level '{lvl}'")
            continue
        for t in i.get("aggregate_to") or []:
            if t not in rank:
                errs.append(f"indicator '{iid}': aggregate_to unknown level '{t}'")
            elif rank[t] >= rank[lvl]:
                errs.append(f"indicator '{iid}': aggregate_to '{t}' is not coarser than '{lvl}'")
        agg = i.get("aggregate") or {}
        if agg.get("fn", "mean") not in AGG_FNS:
            errs.append(f"indicator '{iid}': aggregate.fn must be one of {sorted(AGG_FNS)}")
        if agg.get("weight") not in AGG_WEIGHTS:
            errs.append(f"indicator '{iid}': aggregate.weight must be population, area or none")
        for k in (i.get("sources") or {}):
            if k not in rank:
                errs.append(f"indicator '{iid}': sources has unknown level '{k}'")
        if "scoring" in i or "direction" in i:
            errs.append(f"indicator '{iid}': 'scoring'/'direction' are not part of the devPTIpack method — "
                        f"set the sign of the weight in each scenario instead (higher_is_worse is an optional hint)")
    if len(set(ids)) != len(ids):
        errs.append("duplicate indicator ids")
    app = cfg.get("app", {})
    pti_ids = {i["id"] for i in indicators if i.get("pti", True)}
    for sc in app.get("scenarios", []):
        w = sc.get("weights") or {}
        unknown = [k for k in w if k not in pti_ids]
        if unknown:
            errs.append(f"scenario '{sc.get('id')}': unknown or explorer-only indicators {unknown}")
        bad = [k for k, v in w.items() if not isinstance(v, (int, float)) or isinstance(v, bool)]
        if bad:
            errs.append(f"scenario '{sc.get('id')}': non-numeric weights for {bad}")
        elif w and not any(w.values()):
            errs.append(f"scenario '{sc.get('id')}': every weight is 0")
    if app.get("default_level") and app["default_level"] not in rank:
        errs.append(f"default_level '{app['default_level']}' is not a level key")
    if app.get("missing", "no_priority") not in {"no_priority", "ignore"}:
        errs.append("app.missing must be no_priority or ignore")
    if app.get("cross_level", "project") not in {"project", "devptipack_code"}:
        errs.append("app.cross_level must be project or devptipack_code")
    return errs


# ── Main build ────────────────────────────────────────────────

def build(yaml_path: Path, check_only: bool = False) -> None:
    cfg = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    base_dir = yaml_path.parent
    ds_id = cfg.get("id") or yaml_path.parent.name
    out = (base_dir / cfg.get("output", f"../../app/data/{ds_id}")).resolve()
    indicators: list[dict] = cfg.get("indicators") or []
    log(f"Dataset '{ds_id}' — {len(indicators)} indicator(s)")

    log("\nBoundaries")
    levels, geos = load_levels(cfg, base_dir)
    errs = validate_config(cfg, levels, indicators)
    if errs:
        raise BuildError("config problems:\n  - " + "\n  - ".join(errs))
    tables = level_tables(levels, geos)
    base = levels[-1]

    _CTX.clear(); _GRID_CACHE.clear(); _LABEL_CACHE.clear(); _CUTOFFS.clear(); GRID_NOTES.clear()
    _CTX["base_dir"] = base_dir
    if cfg.get("population_raster"):
        pr = (base_dir / cfg["population_raster"]["file"]).resolve()
        if not pr.exists():
            raise BuildError(f"population_raster not found: {pr}")
        _CTX["population_raster"] = pr

    population = None
    if cfg.get("population"):
        log("\nPopulation")
        pc = cfg["population"]
        plv = level_of(levels, pc.get("level", base["key"]))
        s = values_at(pc["source"], plv, geos, base_dir, tables, None)
        population = {plv["key"]: s}
        for lv in levels:   # population counts sum directly to every coarser level
            if lv["key"] != plv["key"] and levels.index(lv) < levels.index(plv):
                population[lv["key"]] = aggregate(s, plv, lv, tables, None, "sum")
        log(f"  total {np.nansum(s.values):,.0f} at {plv['key']} level")

    log("\nIndicators")
    values: dict[str, dict[str, pd.Series]] = {}
    meta_out: list[dict] = []
    report: list[tuple] = []
    for ind in indicators:
        iid = ind["id"]
        lvl = level_of(levels, ind.get("level", base["key"]))
        prov: dict[str, str] = {}
        by_level: dict[str, pd.Series] = {}
        filled: dict[str, int] = {}

        def finalize(k: str, s: pd.Series) -> pd.Series:
            """Check the join, align to the level's units and apply the fill rule."""
            lv = level_of(levels, k)
            codes = set(geos[k][lv["code"]].astype(str))
            s.index = s.index.astype(str)
            s = s.groupby(level=0).first()
            if not set(s.dropna().index) & codes:
                raise BuildError(f"no values matched any {lv['label']} code. "
                                 f"Source sample {list(s.index[:3])}, boundary sample {sorted(codes)[:3]}")
            s = s.reindex(sorted(codes))
            fv = fill_value(s, ind.get("fill"))
            if fv is not None and s.isna().any():
                filled[k] = int(s.isna().sum())
                s = s.fillna(fv)
            report.append((iid, k, float(s.notna().mean()), filled.get(k), len(codes)))
            return s

        try:
            src0 = {**ind["source"], "_higher_is_worse": ind.get("higher_is_worse", True)} if ind.get("source") else None
            if src0:
                log(f"  {iid}  [{lvl['key']}, {src0.get('type', 'table')}]")
                # Filled before aggregating, so coarser levels summarise the
                # same values the measured level shows
                by_level[lvl["key"]] = finalize(lvl["key"], values_at(src0, lvl, geos, base_dir, tables, population))
                prov[lvl["key"]] = describe_source(src0)
            agg = ind.get("aggregate") or {}
            for t in ind.get("aggregate_to") or []:
                tl = level_of(levels, t)
                if src0 and src0.get("type") == "raster":
                    # Rasters are summarised straight from the grid at every level
                    by_level[t] = finalize(t, values_at(src0, tl, geos, base_dir, tables, population))
                    prov[t] = describe_source(src0) + " (from the grid)"
                    log(f"      → {t}: {prov[t]}")
                    continue
                fn, w = agg.get("fn", "mean"), agg.get("weight")
                by_level[t] = finalize(t, aggregate(by_level[lvl["key"]], lvl, tl, tables, population, fn, w))
                prov[t] = f"{'population-weighted ' if w == 'population' else 'area-weighted ' if w == 'area' else ''}"                           f"{fn} of {lvl['label'].lower()} values"
                log(f"      → {t}: {prov[t]}")
            for k, src in (ind.get("sources") or {}).items():
                sl = level_of(levels, k)
                log(f"      + {k}: {src.get('type', 'table')}")
                by_level[k] = finalize(k, values_at(src, sl, geos, base_dir, tables, population))
                prov[k] = describe_source(src)
        except Exception as e:
            if type(e).__name__ == "TokenExpired":
                raise
            raise BuildError(f"indicator '{iid}': {e}") from e
        if not by_level:
            raise BuildError(f"indicator '{iid}': no `source` or `sources`")
        values[iid] = by_level

        meta = {k: v for k, v in ind.items() if k not in {"source", "sources", "aggregate", "aggregate_to", "level"}}
        meta["levels"] = [lv["key"] for lv in levels if lv["key"] in by_level]
        meta["provenance"] = prov
        if filled:
            meta["filled"] = filled
        meta_out.append(meta)

    log("\nCoverage at each level an indicator is prepared for (devPTIpack gives units with missing\n"
        "values no priority — fill gaps here, or set app.missing: ignore)")
    for iid, k, cov, nfill, n in report:
        flag = f"  ({nfill} filled with {next(i.get('fill') for i in indicators if i['id'] == iid)})" if nfill else \
            ("" if cov >= 0.999 else "  ← gaps")
        log(f"  {iid:<30} {k:<10} {cov:6.1%} of {n:,}{flag}")

    overlays = []
    for ov in cfg.get("overlays") or []:
        g = read_vector(ov, base_dir)
        fields = [f for f in (ov.get("fields") or []) if f in g.columns]
        lf = ov.get("label_field")
        if lf and lf in g.columns and lf not in fields:
            fields.insert(0, lf)
        g = g[fields + ["geometry"]].copy()
        gt = ov.get("geometry") or str(g.geom_type.mode().iat[0]).lower().replace("multi", "")
        gt = {"linestring": "line"}.get(gt, gt)
        if ov.get("role") == "portfolio":
            # Tag each project with the base unit it falls in, so the app can
            # count projects per unit at any level without a spatial join
            gb = geos[base["key"]][[base["code"], "geometry"]]
            pts = g.copy()
            pts["geometry"] = g.geometry.representative_point()
            j = gpd.sjoin(pts, gb, how="left", predicate="within")
            j = j[~j.index.duplicated()]
            g["_unit"] = j[base["code"]].values
            log(f"  overlay {ov['id']}: {len(g)} feature(s), {int(g['_unit'].isna().sum())} outside the study area")
            fields.append("_unit")
        else:
            log(f"  overlay {ov['id']}: {len(g)} feature(s)")
        m = {k: v for k, v in ov.items() if k not in {"file", "arcgis", "url", "layer", "where", "fields"}}
        m.update({"geometry": gt, "file": f"overlay_{ov['id']}.geojson", "fields": fields})
        overlays.append((m, g))

    if check_only:
        log("\nCheck passed — nothing written (--check).")
        return

    app = {k: v for k, v in (cfg.get("app") or {}).items() if k in APP_KEYS}
    unknown_app = set(cfg.get("app") or {}) - APP_KEYS
    if unknown_app:
        log(f"  NOTE: ignoring unknown app keys {sorted(unknown_app)}")
    write_dataset(out, ds_id, app, levels, geos, tables, values, meta_out, population, overlays,
                  cfg.get("simplify"))
    log("\nDone.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("config", type=Path, help="path to pti.yaml")
    ap.add_argument("--check", action="store_true", help="validate sources and joins, write nothing")
    a = ap.parse_args()
    try:
        build(a.config.resolve(), a.check)
    except BuildError as e:
        raise SystemExit(f"\nBUILD FAILED: {e}")
