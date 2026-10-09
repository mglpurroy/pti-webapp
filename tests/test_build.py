"""Build smoke test: Demoland builds, joins every indicator, and writes what the app reads."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "prep" / "examples" / "demoland"


def test_demoland_builds(tmp_path):
    work = tmp_path / "demoland"
    shutil.copytree(DEMO, work)
    cfg = (work / "pti.yaml").read_text(encoding="utf-8")
    (work / "pti.yaml").write_text(cfg.replace("output: ../../../app/data/demoland", "output: out/demoland"),
                                   encoding="utf-8")
    r = subprocess.run([sys.executable, str(ROOT / "prep" / "build_dataset.py"), str(work / "pti.yaml")],
                       capture_output=True, text=True, encoding="utf-8")
    assert r.returncode == 0, r.stdout + r.stderr
    out = work / "out" / "demoland"
    config = json.loads((out / "config.json").read_text(encoding="utf-8"))
    units = json.loads((out / "units.json").read_text(encoding="utf-8"))
    ids = [i["id"] for i in config["indicators"]]
    assert len(units) > 1000
    for i in ids:  # every indicator joined onto most units
        assert sum(u.get(i) is not None for u in units) / len(units) > 0.9, i
    assert {l["key"] for l in config["levels"]} == {"region", "district", "cell"}
    for l in config["levels"]:
        assert (out / f"boundaries_{l['key']}.geojson").exists()
    for s in config["scenarios"]:
        assert abs(sum(s["weights"].values()) - 100) < 1e-9
    index = json.loads((out.parent / "index.json").read_text(encoding="utf-8"))
    assert index["datasets"][0]["id"] == "demoland"
