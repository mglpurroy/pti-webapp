"""Build a PTI Builder dataset from a pti.yaml.

Reads boundaries, indicator sources and overlays, joins everything onto the
base unit, checks the result, and writes the files the web app loads:

    app/data/<id>/config.json              app settings + data dictionary
    app/data/<id>/units.json               one row per base unit
    app/data/<id>/boundaries_<level>.geojson
    app/data/<id>/overlay_<id>.geojson
    app/data/index.json                    list of datasets the app offers

Indicator sources (per indicator, `source.type`):
    table    CSV / Excel / any attribute table, keyed by a unit code
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
    "title", "country", "subtitle", "default_level", "classes", "classification",
    "min_coverage", "priority_labels", "legend", "map", "basemap", "categories",
    "scenarios", "about", "arcgis_publish", "data_refresh_note",
}


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
    if suf in {".csv", ".txt"}:
        return pd.read_csv(path, dtype={spec.get("key", ""): str})
    if suf in {".xlsx", ".xls"}:
        return pd.read_excel(path, sheet_name=spec.get("sheet", 0), dtype={spec.get("key", ""): str})
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
        for parent_key, field in (lv.get("parents") or {}).items() if isinstance(lv.get("parents"), dict) else []:
            plv = next((x for x in levels if x["key"] == parent_key), None)
            if plv is None or field not in g.columns:
                raise BuildError(f"level '{lv['key']}': parent '{parent_key}' field '{field}' not found")
            keep[field] = plv["code"]
        g = g[list(keep) + ["geometry"]].rename(columns=keep)
        g[lv["code"]] = g[lv["code"]].astype(str).str.strip()
        if lv["name"] not in g.columns:
            g[lv["name"]] = g[lv["code"]]
        if g[lv["code"]].duplicated().any():
            n = int(g[lv["code"]].duplicated().sum())
            log(f"  {lv['key']}: {n} duplicate code(s) — dissolving into multipart units")
            g = g.dissolve(by=lv["code"], as_index=False, aggfunc="first")
        g = g[~g.geometry.is_empty & g.geometry.notna()]
        g["geometry"] = g.geometry.make_valid()
        geos[lv["key"]] = g
        log(f"  {lv['label']:<12} {len(g):>7,} units  ({lv['key']})")
    return levels, geos


def attach_parents(levels: list[dict], geos: dict[str, gpd.GeoDataFrame]) -> pd.DataFrame:
    """Base-unit table carrying every parent level's code and name.

    Parent codes come from the base file when it has them (`parents:` mapping);
    otherwise each base unit is assigned to the parent polygon containing its
    representative point.
    """
    base = levels[-1]
    g = geos[base["key"]].copy()
    pts = gpd.GeoDataFrame(g[[base["code"]]], geometry=g.geometry.representative_point(), crs=g.crs)
    for lv in levels[:-1]:
        pg = geos[lv["key"]]
        if lv["code"] not in g.columns:
            j = gpd.sjoin(pts, pg[[lv["code"], "geometry"]], how="left", predicate="within")
            j = j[~j.index.duplicated()]
            g[lv["code"]] = j[lv["code"]].values
            miss = int(g[lv["code"]].isna().sum())
            if miss:
                # Points on a shared edge or slightly outside: take the nearest parent
                near = gpd.sjoin_nearest(pts[g[lv["code"]].isna().values].to_crs(EQUAL_AREA),
                                         pg[[lv["code"], "geometry"]].to_crs(EQUAL_AREA), how="left")
                near = near[~near.index.duplicated()]
                g.loc[near.index, lv["code"]] = near[lv["code"]].values
                log(f"  {base['label']} → {lv['label']}: {miss} unit(s) outside every "
                    f"{lv['label'].lower()} polygon, assigned to the nearest")
        else:
            g[lv["code"]] = g[lv["code"]].astype(str).str.strip()
        names = pg.set_index(lv["code"])[lv["name"]]
        g[lv["name"]] = g[lv["code"]].map(names)
        orphan = int(g[lv["name"]].isna().sum())
        if orphan:
            log(f"  WARNING: {orphan} {base['label'].lower()}(s) have a {lv['label']} code "
                f"not found in the {lv['label'].lower()} boundaries")
    cols = [c for lv in levels for c in (lv["code"], lv["name"])]
    return pd.DataFrame(g[cols]).reset_index(drop=True)


# ── Indicator values ──────────────────────────────────────────

def level_of(levels: list[dict], key: str) -> dict:
    lv = next((x for x in levels if x["key"] == key), None)
    if lv is None:
        raise BuildError(f"unknown level '{key}' (levels: {[x['key'] for x in levels]})")
    return lv


def values_from_table(src: dict, lv: dict, geos, base_dir: Path, units: pd.DataFrame) -> pd.Series:
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
        units_hit, units_all = df["_code"].nunique(), len(lookup)
        log(f"      name join on '{nk}': {m:,} of {n:,} source rows matched, "
            f"covering {units_hit:,} of {units_all:,} {lv['label'].lower()} names")
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


def values_from_raster(src: dict, lv: dict, geos, base_dir: Path, units) -> pd.Series:
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


def values_from_points(src: dict, lv: dict, geos, base_dir: Path, units: pd.DataFrame,
                       population: pd.Series | None) -> pd.Series:
    pts = read_vector(src, base_dir)
    if src.get("filter"):
        pts = pts.query(src["filter"])
    g = geos[lv["key"]]
    j = gpd.sjoin(pts[["geometry"]], g[[lv["code"], "geometry"]], how="inner", predicate="within")
    counts = j.groupby(lv["code"]).size().reindex(g[lv["code"]].values, fill_value=0).astype(float)
    stat = src.get("stat", "count")
    if stat == "count":
        return counts
    if stat == "per_km2":
        area = g.to_crs(EQUAL_AREA).area.values / 1e6
        return counts / pd.Series(area, index=g[lv["code"]].values)
    if stat == "per_1000_pop":
        if population is None:
            raise BuildError("stat per_1000_pop needs a `population:` source")
        pop = population.groupby(units[lv["code"]].values).sum() if lv is not None else population
        return (counts / pop.reindex(counts.index) * 1000).replace([np.inf, -np.inf], np.nan)
    raise BuildError(f"unknown points stat '{stat}' (count | per_km2 | per_1000_pop)")


def indicator_values(ind: dict, levels, geos, base_dir, units, population) -> pd.Series:
    """Values at the indicator's native level, indexed by that level's code."""
    lv = level_of(levels, ind.get("level", levels[-1]["key"]))
    src = ind.get("source") or {}
    t = src.get("type", "table")
    if t in ("table", "arcgis"):
        return values_from_table(src, lv, geos, base_dir, units)
    if t == "raster":
        return values_from_raster(src, lv, geos, base_dir, units)
    if t == "points":
        return values_from_points(src, lv, geos, base_dir, units, population)
    raise BuildError(f"unknown source type '{t}'")


# ── Output helpers ────────────────────────────────────────────

def sig(v, digits: int = 5):
    """Round to significant digits; keeps small densities and large counts precise."""
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return None
    if isinstance(v, (int, np.integer)):
        return int(v)
    if v == 0:
        return 0
    return float(f"{float(v):.{digits}g}")


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
                      "geometry": {"type": gj["type"], "coordinates": round_coords(json.loads(json.dumps(gj["coordinates"])))}})
    path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")),
                    encoding="utf-8")
    return path.stat().st_size


# ── Validation ────────────────────────────────────────────────

def validate_config(cfg: dict, levels: list[dict], indicators: list[dict]) -> list[str]:
    """Problems that would make the app misbehave. Returned, not raised, so
    every one is reported in a single run."""
    errs: list[str] = []
    ids = [i["id"] for i in indicators]
    level_keys = {lv["key"] for lv in levels}
    for i in indicators:
        if i.get("direction") not in {"ascending", "descending"}:
            errs.append(f"indicator '{i['id']}': direction must be ascending or descending")
        if i.get("level", levels[-1]["key"]) not in level_keys:
            errs.append(f"indicator '{i['id']}': unknown level '{i.get('level')}'")
        sc = i.get("scoring")
        if sc and sc.get("type") not in {"breaks", "categories"}:
            errs.append(f"indicator '{i['id']}': scoring.type must be breaks or categories")
    if len(set(ids)) != len(ids):
        errs.append("duplicate indicator ids")
    app = cfg.get("app", {})
    for sc in app.get("scenarios", []):
        w = sc.get("weights") or {}
        unknown = [k for k in w if k not in ids]
        if unknown:
            errs.append(f"scenario '{sc.get('id')}': unknown indicators {unknown}")
        if w and round(sum(w.values()), 6) != 100:
            errs.append(f"scenario '{sc.get('id')}': weights sum to {sum(w.values())}, not 100")
    dl = app.get("default_level")
    if dl and dl not in level_keys:
        errs.append(f"default_level '{dl}' is not a level key")
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

    units = attach_parents(levels, geos)
    base = levels[-1]

    population = None
    pop_cfg = cfg.get("population")
    if pop_cfg:
        log("\nPopulation")
        pop_ind = {"id": "population", "level": base["key"], **pop_cfg}
        s = indicator_values(pop_ind, levels, geos, base_dir, units, None)
        population = units[base["code"]].map(s).astype(float)
        population.index = units[base["code"]].values
        units["population"] = population.values
        log(f"  total {np.nansum(units['population']):,.0f}; "
            f"{int(units['population'].isna().sum())} unit(s) without population")

    log("\nIndicators")
    meta_out: list[dict] = []
    report: list[tuple] = []
    for ind in indicators:
        lv = level_of(levels, ind.get("level", base["key"]))
        log(f"  {ind['id']}  [{lv['key']}, {ind.get('source', {}).get('type', 'table')}]")
        try:
            s = indicator_values(ind, levels, geos, base_dir, units, population)
        except Exception as e:
            if type(e).__name__ == "TokenExpired":
                raise
            raise BuildError(f"indicator '{ind['id']}': {e}") from e
        native_codes = set(geos[lv["key"]][lv["code"]])
        matched = len(set(s.dropna().index.astype(str)) & native_codes)
        if matched == 0:
            raise BuildError(f"indicator '{ind['id']}': no values matched any {lv['label']} code. "
                             f"Source sample {list(s.index[:3])}, boundary sample {sorted(native_codes)[:3]}")
        units[ind["id"]] = units[lv["code"]].map(s.groupby(level=0).first()).astype(float)
        cov = float(units[ind["id"]].notna().mean())
        native_cov = matched / max(len(native_codes), 1)
        report.append((ind["id"], lv["key"], native_cov, cov, ind.get("fill")))
        meta = {k: v for k, v in ind.items() if k != "source"}
        meta["level"] = lv["key"]
        src = ind.get("source") or {}
        meta.setdefault("source_type", src.get("type", "table"))
        meta_out.append(meta)

    log("\nCoverage (share of units with a value — gaps are filled in the app only "
        "where the indicator has a `fill` rule)")
    for iid, lvk, ncov, cov, fill in report:
        flag = "" if cov >= 0.999 else ("  ← gaps, fill: " + str(fill) if fill is not None
                                        else "  ← gaps and no fill rule")
        log(f"  {iid:<34} {lvk:<10} {ncov:6.1%} of {lvk} units, {cov:6.1%} of {base['label'].lower()} units{flag}")

    # Overlays
    overlays_meta: list[dict] = []
    overlay_geo: dict[str, gpd.GeoDataFrame] = {}
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
            # count projects per unit without a point-in-polygon pass
            gb = geos[base["key"]][[base["code"], "geometry"]]
            pts = g.copy()
            pts["geometry"] = g.geometry.representative_point()
            j = gpd.sjoin(pts, gb, how="left", predicate="within")
            j = j[~j.index.duplicated()]
            g["_unit"] = j[base["code"]].values
            n_out = int(g["_unit"].isna().sum())
            log(f"  overlay {ov['id']}: {len(g)} feature(s), {n_out} outside the study area")
            fields.append("_unit")
        else:
            log(f"  overlay {ov['id']}: {len(g)} feature(s)")
        overlay_geo[ov["id"]] = g
        m = {k: v for k, v in ov.items() if k not in {"file", "arcgis", "url", "layer", "where", "fields"}}
        m.update({"geometry": gt, "file": f"overlay_{ov['id']}.geojson", "fields": fields})
        overlays_meta.append(m)

    if check_only:
        log("\nCheck passed — nothing written (--check).")
        return

    # ── Write ──
    out.mkdir(parents=True, exist_ok=True)
    log(f"\nWriting {out}")
    simplify = cfg.get("simplify") or {}
    for lv in levels:
        size = write_geojson(geos[lv["key"]], out / f"boundaries_{lv['key']}.geojson",
                             [lv["code"], lv["name"]], simplify.get(lv["key"]))
        log(f"  boundaries_{lv['key']}.geojson  {size / 1e6:.1f} MB")
    for ov in overlays_meta:
        g = overlay_geo[ov["id"]]
        size = write_geojson(g, out / ov["file"], ov["fields"], (cfg.get("simplify") or {}).get(ov["id"]))
        log(f"  {ov['file']}  {size / 1e6:.2f} MB")

    rows = []
    value_cols = [c for c in units.columns if c not in {x for lv in levels for x in (lv["code"], lv["name"])}]
    for rec in units.to_dict("records"):
        rows.append({k: (sig(v) if k in value_cols else v) for k, v in rec.items()})
    (out / "units.json").write_text(json.dumps(rows, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    log(f"  units.json  {len(rows):,} rows  {(out / 'units.json').stat().st_size / 1e6:.1f} MB")

    app = {k: v for k, v in (cfg.get("app") or {}).items() if k in APP_KEYS}
    unknown_app = set((cfg.get("app") or {})) - APP_KEYS
    if unknown_app:
        log(f"  NOTE: ignoring unknown app keys {sorted(unknown_app)}")
    config = {
        "id": ds_id,
        **app,
        "levels": [{k: lv[k] for k in ("key", "label", "code", "name") if k in lv} for lv in levels],
        "population_field": "population" if pop_cfg else None,
        "indicators": meta_out,
        "overlays": overlays_meta,
        "built": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    (out / "config.json").write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")
    log("  config.json")

    # Register in the app's dataset index
    index_path = out.parent / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {"datasets": []}
    entry = {"id": ds_id, "path": out.name, "label": app.get("country") or ds_id}
    index["datasets"] = [d for d in index["datasets"] if d["id"] != ds_id] + [entry]
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"  index.json  ({len(index['datasets'])} dataset(s))")
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
