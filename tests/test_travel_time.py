"""Travel-time surface: a straight road between two points behaves as expected."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "prep"))
import travel_time as tt  # noqa: E402


def test_off_road_walking_time():
    speed = np.full((1, 11), 5.0, dtype="float32")           # 10 steps of 500 m at 5 km/h
    t = tt.travel_time(speed, [(0, 0)], 500)
    assert abs(t[0, 10] - 5000 / 5000 * 60) < 1e-6           # 5 km at 5 km/h = 60 min


def test_road_speeds_up_travel():
    walk = np.full((3, 21), 5.0, dtype="float32")
    road = walk.copy()
    road[1, :] = 60.0                                          # a 60 km/h road along the middle row
    t_walk = tt.travel_time(walk, [(1, 0)], 500)[1, 20]
    t_road = tt.travel_time(road, [(1, 0)], 500)[1, 20]
    assert abs(t_road - 10 * 60 / 60) < 1e-6                  # 10 km at 60 km/h = 10 min
    assert t_walk / t_road == 12                               # 60 / 5 km/h


def test_nearest_destination_wins():
    speed = np.full((1, 11), 5.0, dtype="float32")
    t = tt.travel_time(speed, [(0, 0), (0, 10)], 500)
    assert abs(t[0, 5] - 30) < 1e-6 and abs(t[0, 9] - 6) < 1e-6
