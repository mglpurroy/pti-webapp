"""Import an existing devPTIpack dashboard's data into the PTI Builder.

Reads the two deployment files `compile_pti_data()` produces:

    metadata.xlsx     general / metadata / admin<N>_<Name> sheets (+ optional weights_table)
    shapefiles.zip    one GeoJSON per admin layer, named admin<N>_<Name>.geojson
                      (a folder of those GeoJSONs works too)

and writes app/data/<id>/ exactly as build_dataset.py does. No R needed.

Mapping:
    var_code / var_name / var_description / var_units  →  indicator id / label / description / unit
    pillar_name (ordered by pillar_group)              →  pillar
    fltr_exclude_pti                                   →  pti: false (Data Explorer only)
    legend_revert_colours                              →  higher_is_worse
    admin<N>_<Name> sheets                             →  values at that level
    weights_table ws<k>..name / ws<k>..value            →  weighting schemes

The admin0 (country) layer is skipped unless --keep-admin0 is given: a
single-unit level has no variation to rank.

Usage:
    python prep/import_devptipack.py metadata.xlsx shapefiles.zip --id ukraine
    python prep/import_devptipack.py metadata.xlsx shapes/ --id ukraine --cross-level devptipack_code
"""
from __future__ import annotations

import argparse
import re
import sys
import tempfile
import zipfile
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from build_dataset import BuildError, level_tables, load_levels, log, write_dataset  # noqa: E402

PALETTE = ["#e67e22", "#2980b9", "#8e44ad", "#16a085", "#c0392b", "#7f8c8d", "#d35400", "#27ae60"]
LAYER = re.compile(r"^admin(\d+)_(.+)$")


def truthy(v) -> bool:
    if isinstance(v, str):
        return v.strip().lower() in {"true", "t", "yes", "1"}
    return bool(v) and not pd.isna(v)


def shape_files(shapes: Path, tmp: Path) -> dict[int, tuple[str, Path]]:
    if shapes.suffix.lower() == ".zip":
        with zipfile.ZipFile(shapes) as z:
            z.extractall(tmp)
        shapes = tmp
    found = {}
    for p in sorted(shapes.rglob("*.geojson")):
        m = LAYER.match(p.stem)
        if m:
            found[int(m.group(1))] = (p.stem, p)
    if not found:
        raise BuildError(f"no admin<N>_<Name>.geojson layers in {shapes}")
    return dict(sorted(found.items()))


def weight_schemes(wt: pd.DataFrame | None, ids: set[str]) -> list[dict]:
    if wt is None or wt.empty or "var_code" not in wt.columns:
        return []
    groups = sorted({m.group(1) for c in wt.columns if (m := re.match(r"^(ws\d+)\.\.", c))})
    out = []
    for g in groups:
        name_col, val_col = f"{g}..name", f"{g}..value"
        if val_col not in wt.columns:
            continue
        name = wt[name_col].dropna().astype(str).iloc[0] if name_col in wt.columns and wt[name_col].notna().any() else g
        w = {str(r.var_code): float(r[val_col]) for _, r in wt.iterrows()
             if str(r.var_code) in ids and pd.notna(r[val_col]) and float(r[val_col]) != 0}
        if w:
            out.append({"id": g, "label": name, "weights": w})
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("metadata", type=Path, help="metadata.xlsx")
    ap.add_argument("shapes", type=Path, help="shapefiles.zip, or a folder of admin<N>_<Name>.geojson")
    ap.add_argument("--id", required=True, help="dataset id (folder under app/data/)")
    ap.add_argument("--out", type=Path, help="output folder (default app/data/<id>)")
    ap.add_argument("--title", default="Project Targeting Index")
    ap.add_argument("--keep-admin0", action="store_true")
    ap.add_argument("--cross-level", default="project", choices=["project", "devptipack_code"],
                    help="devptipack_code reproduces the R package's upward averaging (see docs/METHODOLOGY.md)")
    ap.add_argument("--simplify", type=float, default=None, help="simplification tolerance (degrees) for every level")
    a = ap.parse_args()
    out = a.out or Path(__file__).resolve().parents[1] / "app" / "data" / a.id

    sheets = pd.read_excel(a.metadata, sheet_name=None)
    if "metadata" not in sheets:
        raise BuildError("metadata.xlsx has no 'metadata' sheet")
    md = sheets["metadata"]
    country = str(sheets.get("general", pd.DataFrame({"country": [a.id]}))["country"].iloc[0])
    log(f"Importing devPTIpack data for {country}: {len(md)} indicator(s)")

    with tempfile.TemporaryDirectory() as tmp:
        layers = shape_files(a.shapes, Path(tmp))
        nums = [n for n in layers if a.keep_admin0 or n != 0]
        levels = []
        for k, n in enumerate(nums):
            stem, path = layers[n]
            levels.append({
                "key": f"admin{n}", "label": LAYER.match(stem).group(2).replace("_", " "),
                "code": f"admin{n}Pcod", "name": f"admin{n}Name",
                "boundaries": {"file": str(path)},
                "parents": {f"admin{p}": f"admin{p}Pcod" for p in nums[:k]},
            })
        log("\nBoundaries")
        cfg = {"levels": levels}
        levels, geos = load_levels(cfg, Path("/"))
        tables = level_tables(levels, geos)

    by_num = {int(re.match(r"admin(\d+)", lv["key"]).group(1)): lv for lv in levels}
    data_sheets = {}
    for name, df in sheets.items():
        m = LAYER.match(name)
        if m and int(m.group(1)) in by_num:
            data_sheets[int(m.group(1))] = df
        elif m:
            log(f"  NOTE: sheet {name} has no matching boundary layer — skipped")

    log("\nIndicators")
    values, meta_out, ids = {}, [], set()
    pillars = (md[["pillar_group", "pillar_name"]].drop_duplicates().sort_values("pillar_group")
               if {"pillar_group", "pillar_name"} <= set(md.columns) else pd.DataFrame(columns=["pillar_name"]))
    for _, r in md.sort_values([c for c in ("pillar_group", "var_order") if c in md.columns]).iterrows():
        iid = str(r["var_code"])
        by_level, prov = {}, {}
        for n, df in data_sheets.items():
            lv = by_num[n]
            if iid in df.columns and lv["code"] in df.columns and df[iid].notna().any():
                s = pd.Series(pd.to_numeric(df[iid], errors="coerce").values,
                              index=df[lv["code"]].astype(str).str.strip().values)
                s = s[~s.index.duplicated()]
                codes = set(geos[lv["key"]][lv["code"]].astype(str))
                extra = len(set(s.dropna().index) - codes)
                if extra:
                    log(f"  NOTE: {iid} at {lv['key']}: {extra} sheet row(s) have no boundary — "
                        f"devPTIpack still counts them when z-scoring; they are dropped here")
                by_level[lv["key"]] = s.reindex(sorted(codes))
                prov[lv["key"]] = f"devPTIpack metadata sheet {LAYER.match(next(k for k in sheets if k.startswith(lv['key'] + '_'))).group(0)}"
        if not by_level:
            log(f"  SKIP {iid}: no values on any imported level")
            continue
        values[iid] = by_level
        ids.add(iid)
        meta = {"id": iid, "label": str(r.get("var_name", iid)),
                "pillar": str(r.get("pillar_name", "Other")),
                "levels": [lv["key"] for lv in levels if lv["key"] in by_level], "provenance": prov}
        for src, dst in (("var_description", "description"), ("var_units", "unit")):
            if src in r and pd.notna(r[src]):
                meta[dst] = str(r[src])
        if "legend_revert_colours" in r:
            meta["higher_is_worse"] = truthy(r["legend_revert_colours"])
        if "fltr_exclude_pti" in r and truthy(r["fltr_exclude_pti"]):
            meta["pti"] = False
        if "fltr_exclude_explorer" in r and truthy(r["fltr_exclude_explorer"]):
            meta["explorer"] = False
        meta_out.append(meta)
        log(f"  {iid:<34} {', '.join(meta['levels'])}")

    scenarios = weight_schemes(sheets.get("weights_table"), {m["id"] for m in meta_out if m.get("pti", True)})
    app = {
        "title": a.title, "country": country, "subtitle": "Imported from devPTIpack",
        "default_level": levels[min(1, len(levels) - 1)]["key"], "bins": 5,
        "missing": "no_priority", "cross_level": a.cross_level,
        "pillars": [{"name": str(p), "color": PALETTE[i % len(PALETTE)]} for i, p in enumerate(pillars["pillar_name"])],
        "scenarios": scenarios,
    }
    log(f"\n{len(scenarios)} weighting scheme(s) from weights_table")
    simplify = {lv["key"]: a.simplify for lv in levels} if a.simplify else None
    write_dataset(out, a.id, app, levels, geos, tables, values, meta_out, None, [], simplify)
    log("\nDone.")


if __name__ == "__main__":
    try:
        main()
    except BuildError as e:
        raise SystemExit(f"\nIMPORT FAILED: {e}")
