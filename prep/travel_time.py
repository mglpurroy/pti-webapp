"""Travel time to the nearest destination, as a raster.

Turns point destinations (health facilities, schools, markets …) and a road
network into a gridded travel-time surface in minutes, which build_dataset.py
can then summarise per unit (mean, % of people in the worst 20%, …).

Model — deliberately simple and transparent:
  * a square grid in an equal-area projection centred on the study area
  * each cell's speed is the fastest road crossing it (km/h, from a speed
    field or a per-class table), otherwise an off-road walking speed
  * minutes to the nearest destination along the cheapest path through the
    grid (8-connected, diagonal steps cost √2), via scikit-image's
    MCP_Geometric

Not modelled: rivers and water bodies, terrain, land cover, congestion,
border crossings. Treat results as relative accessibility.

Usage:
    python prep/travel_time.py --boundary admin.geojson \\
        --roads roads.gdb --roads-layer Road_and_transport_networks --speed-field speed_estimate \\
        --dest facilities.gpkg [--dest-filter "facility_level in ('Secondary','Tertiary')"] \\
        --res 500 --offroad-kmh 5 --out travel_time_hospital.tif
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import pyogrio
import rasterio
from rasterio import features
from rasterio.transform import from_origin


def log(m):
    print(m, flush=True)


def grid_for(boundary: gpd.GeoDataFrame, res: float):
    c = boundary.to_crs("EPSG:4326").union_all().centroid
    crs = f"+proj=laea +lat_0={c.y:.4f} +lon_0={c.x:.4f} +datum=WGS84 +units=m +no_defs"
    b = boundary.to_crs(crs)
    x0, y0, x1, y1 = b.total_bounds
    pad = 10 * res
    x0, y0, x1, y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    w, h = int(np.ceil((x1 - x0) / res)), int(np.ceil((y1 - y0) / res))
    return crs, from_origin(x0, y1, res, res), (h, w), b


def speed_grid(roads: gpd.GeoDataFrame, speed_col: str, transform, shape, offroad: float) -> np.ndarray:
    """km/h per cell: the fastest road in the cell, else off-road speed."""
    sp = np.full(shape, offroad, dtype="float32")
    r = roads[[speed_col, "geometry"]].dropna()
    r = r[r[speed_col] > offroad].sort_values(speed_col)   # faster roads burnt last, so they win
    if len(r):
        burnt = features.rasterize(zip(r.geometry, r[speed_col].astype("float32")), out_shape=shape,
                                   transform=transform, fill=0, dtype="float32", all_touched=True)
        sp = np.maximum(sp, burnt)
    return sp


def travel_time(speed_kmh: np.ndarray, starts: list[tuple[int, int]], res: float) -> np.ndarray:
    from skimage.graph import MCP_Geometric
    minutes_per_m = 60.0 / (speed_kmh.astype("float64") * 1000.0)
    mcp = MCP_Geometric(minutes_per_m, sampling=(res, res), fully_connected=True)
    cost, _ = mcp.find_costs(starts)
    return cost


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--boundary", required=True, help="study-area polygons (any vector file)")
    ap.add_argument("--roads", required=True)
    ap.add_argument("--roads-layer")
    ap.add_argument("--speed-field", default="speed_estimate", help="km/h per road segment")
    ap.add_argument("--dest", required=True, help="destination points (any vector file)")
    ap.add_argument("--dest-layer")
    ap.add_argument("--dest-filter", help="pandas query on destination attributes")
    ap.add_argument("--res", type=float, default=500, help="cell size in metres")
    ap.add_argument("--offroad-kmh", type=float, default=5.0, help="speed off the road network")
    ap.add_argument("--max-road-kmh", type=float, default=None, help="cap road speeds, e.g. 5 for walking-only")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    t0 = time.time()
    boundary = gpd.read_file(a.boundary)
    crs, transform, shape, b = grid_for(boundary, a.res)
    log(f"grid {shape[1]} × {shape[0]} cells at {a.res:.0f} m")

    log("reading roads…")
    roads = pyogrio.read_dataframe(a.roads, layer=a.roads_layer, columns=[a.speed_field])
    roads = roads.to_crs(crs)
    if a.max_road_kmh:
        roads[a.speed_field] = roads[a.speed_field].clip(upper=a.max_road_kmh)
    log(f"  {len(roads):,} segments ({time.time() - t0:.0f}s)")
    speed = speed_grid(roads, a.speed_field, transform, shape, a.offroad_kmh)
    del roads

    dest = gpd.read_file(a.dest, layer=a.dest_layer)
    if a.dest_filter:
        dest = dest.query(a.dest_filter)
    dest = dest[dest.geometry.notna() & ~dest.geometry.is_empty].to_crs(crs)
    rows, cols = rasterio.transform.rowcol(transform, dest.geometry.x.values, dest.geometry.y.values)
    starts = sorted({(r, c) for r, c in zip(rows, cols) if 0 <= r < shape[0] and 0 <= c < shape[1]})
    log(f"{len(dest):,} destinations in {len(starts):,} cells")

    tt = travel_time(speed, starts, a.res)
    inside = features.rasterize(((g, 1) for g in b.geometry), out_shape=shape, transform=transform, fill=0, dtype="uint8")
    tt = np.where(inside == 1, tt, np.nan).astype("float32")
    log(f"travel time: median {np.nanmedian(tt):.0f} min, 95th pct {np.nanpercentile(tt, 95):.0f} min ({time.time() - t0:.0f}s)")

    out = Path(a.out)
    with rasterio.open(out, "w", driver="GTiff", height=shape[0], width=shape[1], count=1, dtype="float32",
                       crs=crs, transform=transform, nodata=np.nan, compress="deflate", tiled=True) as d:
        d.write(tt, 1)
        d.update_tags(units="minutes", model=f"roads {a.speed_field}, off-road {a.offroad_kmh} km/h, {a.res:.0f} m",
                      destinations=f"{a.dest} {a.dest_filter or ''}".strip())
    log(f"wrote {out}")


if __name__ == "__main__":
    main()
