"""Grid summaries: population-weighted statistics of a raster per unit."""
import sys
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "prep"))
import build_dataset as b  # noqa: E402


def write(path, arr):
    with rasterio.open(path, "w", driver="GTiff", height=arr.shape[0], width=arr.shape[1], count=1,
                       dtype="float64", crs="EPSG:4326", nodata=-9999, transform=from_origin(0, 2, 1, 1)) as d:
        d.write(arr, 1)


def run(tmp_path, stat, **kw):
    # 2 x 4 grid; unit A = left two columns, unit B = right two columns
    write(tmp_path / "v.tif", np.array([[10, 20, 30, 40], [10, 20, 50, 60]], dtype="float64"))
    write(tmp_path / "p.tif", np.array([[1, 3, 1, 1], [1, 3, 0, 2]], dtype="float64"))
    g = gpd.GeoDataFrame({"code": ["A", "B"], "name": ["A", "B"]},
                         geometry=[box(0, 0, 2, 2), box(2, 0, 4, 2)], crs="EPSG:4326")
    for c in (b._CTX, b._GRID_CACHE, b._LABEL_CACHE, b._CUTOFFS, b.GRID_NOTES):
        c.clear()
    b._CTX["population_raster"] = tmp_path / "p.tif"
    b._CTX["base_dir"] = tmp_path
    lv = {"key": "u", "label": "Unit", "code": "code", "name": "name"}
    return b.values_from_grid({"file": "v.tif", "stat": stat, **kw}, lv, {"u": g}, tmp_path)


def test_population_weighted_mean(tmp_path):
    r = run(tmp_path, "mean")
    assert abs(r["A"] - (10 + 60 + 10 + 60) / 8) < 1e-9      # weights 1,3,1,3
    assert abs(r["B"] - (30 + 40 + 120) / 4) < 1e-9          # 50 has no people


def test_share_above_threshold(tmp_path):
    r = run(tmp_path, "share_above", threshold=15)
    assert abs(r["A"] - 75) < 1e-9 and abs(r["B"] - 100) < 1e-9


def test_share_in_national_worst(tmp_path):
    # national population-weighted 80th percentile is 40 → people at ≥ 40
    r = run(tmp_path, "share_worst", share=0.2, _higher_is_worse=True)
    assert r["A"] == 0 and abs(r["B"] - 75) < 1e-9


def test_weighted_percentile(tmp_path):
    r = run(tmp_path, "percentile", p=50)
    assert r["A"] == 20 and r["B"] == 40
