"""Build smoke test: Demoland builds, every indicator lands on its levels,
and the files the app reads are there."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "prep" / "examples" / "demoland"


def build(tmp_path):
    work = tmp_path / "demoland"
    shutil.copytree(DEMO, work)
    cfg = (work / "pti.yaml").read_text(encoding="utf-8")
    (work / "pti.yaml").write_text(cfg.replace("output: ../../../app/data/demoland", "output: out/demoland"),
                                   encoding="utf-8")
    r = subprocess.run([sys.executable, str(ROOT / "prep" / "build_dataset.py"), str(work / "pti.yaml")],
                       capture_output=True, text=True, encoding="utf-8")
    assert r.returncode == 0, r.stdout + r.stderr
    return work / "out" / "demoland"


def test_demoland_builds(tmp_path):
    out = build(tmp_path)
    config = json.loads((out / "config.json").read_text(encoding="utf-8"))
    assert config["method"] == "devPTIpack"
    keys = [lv["key"] for lv in config["levels"]]
    assert keys == ["region", "district", "cell"]
    data = {k: json.loads((out / f"data_{k}.json").read_text(encoding="utf-8")) for k in keys}
    assert len(data["cell"]) > 1000 and len(data["district"]) == 30 and len(data["region"]) == 6

    for ind in config["indicators"]:
        assert ind["levels"], ind["id"]
        for k in keys:
            has = any(r.get(ind["id"]) is not None for r in data[k])
            assert has == (k in ind["levels"]), (ind["id"], k)   # values only where declared

    # every unit carries the codes of all coarser levels
    for r in data["cell"][:50]:
        assert r["district_code"] and r["region_code"]
    # population sums down to coarser levels
    assert abs(sum(r["population"] for r in data["region"]) - sum(r["population"] for r in data["cell"])) < 1

    # aggregate_to is direct and weighted as declared: check one district
    d = data["district"][0]
    cells = [r for r in data["cell"] if r["district_code"] == d["district_code"]]
    w = sum(c["population"] for c in cells)
    expect = sum(c["poverty_headcount"] * c["population"] for c in cells) / w
    assert abs(d["poverty_headcount"] - expect) < 1e-6

    for s in config["scenarios"]:
        assert any(s["weights"].values())
    index = json.loads((out.parent / "index.json").read_text(encoding="utf-8"))
    assert index["datasets"][0]["id"] == "demoland"


def test_rejects_pti2_scoring_keys(tmp_path):
    work = tmp_path / "bad"
    shutil.copytree(DEMO, work)
    cfg = (work / "pti.yaml").read_text(encoding="utf-8")
    cfg = cfg.replace("    higher_is_worse: true\n    unit: \"%\"\n    year: 2024",
                      "    direction: ascending\n    unit: \"%\"\n    year: 2024", 1)
    (work / "pti.yaml").write_text(cfg, encoding="utf-8")
    r = subprocess.run([sys.executable, str(ROOT / "prep" / "build_dataset.py"), str(work / "pti.yaml"), "--check"],
                       capture_output=True, text=True, encoding="utf-8")
    assert r.returncode != 0 and "not part of the devPTIpack method" in (r.stdout + r.stderr)
