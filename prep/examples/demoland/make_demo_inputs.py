"""Generate the synthetic 'Demoland' inputs used by the example pti.yaml.

Demoland is a fictional island in the Gulf of Guinea. Every number here is
invented — the point is to exercise each kind of input the build supports:

    cells        ~5 km grid cells as the base unit (a raster-like surface,
                 not an administrative boundary)
    districts    Voronoi districts; regions group the districts
    tables       cell-level CSV with gaps, district CSV, region CSV keyed by
                 *name* (to exercise the name join)
    raster       travel time to the nearest health facility (GeoTIFF)
    points       health facilities (counted per unit), towns
    overlays     roads (lines) and a project portfolio (points)

Run:  python prep/examples/demoland/make_demo_inputs.py
Then: python prep/build_dataset.py prep/examples/demoland/pti.yaml
"""
from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from rasterio.transform import from_origin
from shapely import voronoi_polygons
from shapely.geometry import LineString, MultiPoint, Point, Polygon, box

OUT = Path(__file__).parent / "inputs"
OUT.mkdir(exist_ok=True)
rng = np.random.default_rng(7)

CX, CY = -3.0, 0.0          # island centre (open sea, no real land)
CELL = 0.045                # grid cell size in degrees (~5 km)

# ── Island outline ────────────────────────────────────────────
theta = np.linspace(0, 2 * np.pi, 240, endpoint=False)
r = 1 + 0.10 * np.sin(3 * theta + 0.4) + 0.07 * np.sin(5 * theta + 1.3) + 0.04 * np.sin(9 * theta)
island = Polygon(zip(CX + 1.35 * r * np.cos(theta), CY + 0.95 * r * np.sin(theta))).buffer(0)

# ── Towns ─────────────────────────────────────────────────────
town_xy = [(-3.05, 0.05), (-3.85, 0.35), (-2.20, -0.35), (-2.55, 0.55), (-3.60, -0.45),
           (-4.05, -0.05), (-2.05, 0.20), (-3.20, -0.70), (-3.15, 0.75), (-2.75, -0.05),
           (-3.95, 0.70), (-2.40, -0.70)]
town_names = ["Port Aster", "Belmor", "Kessa", "Ondaro", "Vilu", "Tamsin", "Rheno",
              "Sudra", "Norvik", "Amari", "Halden", "Coro"]
town_size = np.array([9, 4, 5, 3, 3, 2, 2, 2, 2, 3, 1.5, 1.5])
towns = gpd.GeoDataFrame({"name": town_names, "population_k": (town_size * 40).round()},
                         geometry=[Point(xy) for xy in town_xy], crs="EPSG:4326")


def dist_to(points_xy, x, y):
    p = np.array(points_xy)
    return np.sqrt((x[..., None] - p[:, 0]) ** 2 + (y[..., None] - p[:, 1]) ** 2)


# ── Districts and regions ─────────────────────────────────────
seeds = []
while len(seeds) < 30:
    p = Point(rng.uniform(CX - 1.5, CX + 1.5), rng.uniform(CY - 1.1, CY + 1.1))
    if island.contains(p):
        seeds.append(p)
vor = voronoi_polygons(MultiPoint(seeds), extend_to=island.buffer(0.5).envelope)
dpolys = [g.intersection(island) for g in vor.geoms]
dpolys = [g for g in dpolys if not g.is_empty]
dc = np.array([[g.centroid.x, g.centroid.y] for g in dpolys])
ang = np.arctan2(dc[:, 1] - CY, dc[:, 0] - CX)
inner = np.hypot((dc[:, 0] - CX) / 1.35, (dc[:, 1] - CY) / 0.95) < 0.38
region_idx = np.where(inner, 0, 1 + ((ang + np.pi) / (2 * np.pi) * 5).astype(int) % 5)
region_names = ["Central", "Western Coast", "Southern Hills", "Eastern Plains", "Northeast", "Northern Lakes"]
syll = ["ka", "lo", "mi", "ra", "sen", "tu", "vo", "da", "ne", "bi", "or", "pe", "sa", "ul"]
dnames = set()
while len(dnames) < len(dpolys):
    dnames.add("".join(rng.choice(syll, 3)).capitalize())
districts = gpd.GeoDataFrame({
    "district_code": [f"D{i + 1:02d}" for i in range(len(dpolys))],
    "district_name": sorted(dnames),
    "region_code": [f"R{k + 1}" for k in region_idx],
}, geometry=dpolys, crs="EPSG:4326")
regions = districts.dissolve(by="region_code", as_index=False)[["region_code", "geometry"]]
regions["region_name"] = regions["region_code"].map(lambda c: region_names[int(c[1:]) - 1])

# ── Grid cells (base unit) ────────────────────────────────────
minx, miny, maxx, maxy = island.bounds
xs = np.arange(minx, maxx, CELL)
ys = np.arange(miny, maxy, CELL)
cells = [box(x, y, x + CELL, y + CELL) for y in ys for x in xs]
cells = [c for c in cells if island.contains(c.centroid)]
cx = np.array([c.centroid.x for c in cells])
cy = np.array([c.centroid.y for c in cells])
cellg = gpd.GeoDataFrame({"cell_id": [f"C{i + 1:05d}" for i in range(len(cells))]},
                         geometry=cells, crs="EPSG:4326")
cellg["cell_name"] = [f"Cell {i + 1}" for i in range(len(cells))]

# ── Smooth synthetic fields ───────────────────────────────────
d_town = dist_to(town_xy, cx, cy)
near = (np.exp(-(d_town / 0.18) ** 2) * town_size).sum(axis=1)       # urban pull
remote = np.clip(d_town.min(axis=1) / 0.6, 0, 1.5)
coast = np.array([island.exterior.distance(Point(x, y)) for x, y in zip(cx, cy)])
hot = np.exp(-(((cx + 2.3) / 0.35) ** 2 + ((cy - 0.55) / 0.25) ** 2))  # northeast hotspot
noise = lambda s: rng.normal(0, s, len(cells))

population = np.round(800 + 9000 * near + rng.gamma(2, 400, len(cells)))
poverty = np.clip(25 + 38 * remote + 18 * hot - 4 * np.log1p(near) + noise(6), 3, 97)
electricity = np.clip(85 - 55 * remote + 6 * np.log1p(near) - 15 * hot + noise(7), 0, 100)
enrolment = np.clip(88 - 30 * remote - 20 * hot + noise(6), 15, 100)
flood = np.clip(1 - coast / 0.25, 0, 1) * 70 + rng.gamma(1.5, 4, len(cells))
conflict = rng.poisson(0.2 + 14 * hot + 0.6 * near)
ndvi_change = np.clip(0.05 - 0.18 * hot + 0.06 * np.sin(cx * 5) + noise(0.05), -0.4, 0.3)
restricted = (hot > 0.45).astype(int)

# Survey gaps: a few cells lack poverty and electricity estimates
poverty[rng.random(len(cells)) < 0.03] = np.nan
electricity[rng.random(len(cells)) < 0.05] = np.nan

pd.DataFrame({
    "cell_id": cellg["cell_id"], "population": population,
    "poverty_headcount": poverty.round(1), "electricity_access": electricity.round(1),
    "net_enrolment": enrolment.round(1), "flood_exposure": flood.round(2),
    "conflict_events_3y": conflict, "ndvi_change": ndvi_change.round(3),
    "restricted_access": restricted,
}).to_csv(OUT / "cell_indicators.csv", index=False)

# District-level: stunting (from a survey representative only at district level)
dcent = districts.geometry.representative_point()
d_remote = np.clip(dist_to(town_xy, dcent.x.values, dcent.y.values).min(axis=1) / 0.6, 0, 1.5)
pd.DataFrame({"district_code": districts["district_code"],
              "stunting_rate": np.clip(18 + 16 * d_remote + rng.normal(0, 3, len(districts)), 8, 55).round(1)}
             ).to_csv(OUT / "district_stats.csv", index=False)

# Region-level, keyed by NAME only (no code) — the build joins it by name
pd.DataFrame({"Region": regions["region_name"].str.upper(),
              "food_insecurity_phase": regions["region_code"].map(
                  {"R1": 2, "R2": 3, "R3": 2, "R4": 4, "R5": 3, "R6": 2})}).to_csv(OUT / "region_food_security.csv", index=False)

# ── Health facilities and travel-time raster ──────────────────
fac = []
for (x, y), s in zip(town_xy, town_size):
    for _ in range(int(s * 2)):
        fac.append((x + rng.normal(0, 0.05), y + rng.normal(0, 0.05)))
while len(fac) < 110:
    p = Point(rng.uniform(minx, maxx), rng.uniform(miny, maxy))
    if island.contains(p) and rng.random() > 0.5:
        fac.append((p.x, p.y))
facilities = gpd.GeoDataFrame({"type": ["clinic"] * len(fac)},
                              geometry=[Point(xy) for xy in fac], crs="EPSG:4326")
facilities = facilities[facilities.within(island)]
facilities.loc[facilities.index[:12], "type"] = "hospital"

RES = 0.01
gx = np.arange(minx - 0.05, maxx + 0.05, RES) + RES / 2
gy = np.arange(maxy + 0.05, miny - 0.05, -RES) - RES / 2
GX, GY = np.meshgrid(gx, gy)
fxy = np.array([(p.x, p.y) for p in facilities.geometry])
dmin = np.full(GX.shape, np.inf)
for fx, fy in fxy:
    dmin = np.minimum(dmin, np.hypot(GX - fx, GY - fy))
tt = (dmin * 111 / 25 * 60) * (1 + 0.6 * np.exp(-((GX + 2.3) ** 2 / 0.12 + (GY - 0.55) ** 2 / 0.06)))
with rasterio.open(OUT / "travel_time_health.tif", "w", driver="GTiff", height=tt.shape[0], width=tt.shape[1],
                   count=1, dtype="float32", crs="EPSG:4326", nodata=-9999,
                   transform=from_origin(gx[0] - RES / 2, gy[0] + RES / 2, RES, RES)) as dst:
    dst.write(tt.astype("float32"), 1)

# ── Roads (lines) and portfolio (points) ──────────────────────
edges = set()
for i, (x, y) in enumerate(town_xy):
    d = np.hypot(np.array(town_xy)[:, 0] - x, np.array(town_xy)[:, 1] - y)
    for j in np.argsort(d)[1:3]:
        edges.add(tuple(sorted((i, int(j)))))
roads = gpd.GeoDataFrame({"class": ["primary" if 0 in e else "secondary" for e in edges]},
                         geometry=[LineString([town_xy[a], town_xy[b]]) for a, b in edges], crs="EPSG:4326")

sectors = ["Health", "Education", "Energy", "Water", "Agriculture", "Social Protection"]
proj = []
while len(proj) < 48:
    if rng.random() < 0.7:   # most projects cluster near towns
        tx, ty = town_xy[rng.choice(len(town_xy), p=town_size / town_size.sum())]
        p = Point(tx + rng.normal(0, 0.12), ty + rng.normal(0, 0.12))
    else:
        p = Point(rng.uniform(minx, maxx), rng.uniform(miny, maxy))
    if island.contains(p):
        proj.append(p)
projects = gpd.GeoDataFrame({
    "project_id": [f"P{170000 + i * 37}" for i in range(len(proj))],
    "name": [f"{rng.choice(sectors)} Project {i + 1}" for i in range(len(proj))],
    "status": rng.choice(["Active", "Active", "Pipeline", "Closed"], len(proj)),
}, geometry=proj, crs="EPSG:4326")
projects["sector"] = projects["name"].str.replace(r" Project \d+$", "", regex=True)

# ── Write ─────────────────────────────────────────────────────
cellg.to_file(OUT / "cells.gpkg", driver="GPKG")
districts.to_file(OUT / "districts.gpkg", driver="GPKG")
regions.to_file(OUT / "regions.gpkg", driver="GPKG")
facilities.to_file(OUT / "health_facilities.gpkg", driver="GPKG")
towns.to_file(OUT / "towns.gpkg", driver="GPKG")
roads.to_file(OUT / "roads.gpkg", driver="GPKG")
projects.to_file(OUT / "projects.gpkg", driver="GPKG")
print(f"{len(cells):,} cells, {len(districts)} districts, {len(regions)} regions, "
      f"{len(facilities)} facilities, {len(projects)} projects -> {OUT}")
