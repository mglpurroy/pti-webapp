"""List the layers of an ArcGIS web map and draft build-config entries for them.

Point it at the web map behind a Hub site or Data Explorer, pick the layers
that are indicators, and paste the drafted entries into your pti.yaml.

Usage:
    python prep/list_webmap_layers.py <webmap item id> [--portal URL] [--yaml out.yaml]

Each numeric field of each feature layer becomes a commented draft indicator.
Fill in label, category, direction and level, and set `key` to the field that
holds the unit code (or `name_key` to join on unit names).
"""
from __future__ import annotations

import argparse
import os
import re
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from arcgis_rest import TokenExpired, layer_info, load_token, webmap_layers

NUMERIC = {"esriFieldTypeDouble", "esriFieldTypeSingle", "esriFieldTypeInteger",
           "esriFieldTypeSmallInteger", "esriFieldTypeBigInteger"}
# Bookkeeping fields that are numeric but never indicators
SKIP = re.compile(r"^(objectid|fid|oid|shape|globalid|uniq_?id|.*_id$|shape__|st_area|st_length)", re.I)


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")[:48]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("item_id")
    ap.add_argument("--portal", default=os.environ.get("ARCGIS_PORTAL", "https://www.arcgis.com"))
    ap.add_argument("--yaml", help="write drafted indicator entries to this file")
    a = ap.parse_args()

    token = load_token()
    try:
        layers = webmap_layers(a.portal, a.item_id, token)
    except TokenExpired as e:
        raise SystemExit(str(e))

    drafts: list[str] = []
    print(f"{len(layers)} layer(s) in web map {a.item_id}\n")
    for lyr in layers:
        where = f"{lyr['group']}/" if lyr["group"] else ""
        if not lyr.get("feature"):
            print(f"  - {where}{lyr['title']}  (not a feature layer — skipped)")
            continue
        try:
            info = layer_info(lyr["url"], token)
        except TokenExpired as e:
            raise SystemExit(str(e))
        except Exception as e:
            print(f"  ! {where}{lyr['title']}: {e}")
            continue
        nums = [f for f in info["fields"] if f["type"] in NUMERIC and not SKIP.match(f["name"])]
        others = [f["name"] for f in info["fields"] if f["type"] == "esriFieldTypeString"]
        print(f"  + {where}{lyr['title']}  [{info['geometry'] or 'table'}]")
        print(f"      {lyr['url']}")
        print(f"      numeric: {', '.join(f['name'] for f in nums) or '-'}")
        print(f"      text (candidate keys): {', '.join(others[:10]) or '-'}")
        for f in nums:
            drafts.append(
                f"# from: {where}{lyr['title']}\n"
                f"- id: {slug(f['alias'] or f['name'])}\n"
                f"  label: \"{f['alias'] or f['name']}\"\n"
                f"  category: TODO\n"
                f"  direction: ascending      # or descending\n"
                f"  level: TODO               # one of your level keys\n"
                f"  source:\n"
                f"    type: arcgis\n"
                f"    url: {lyr['url']}\n"
                f"    column: {f['name']}\n"
                f"    key: TODO               # field holding the unit code (or name_key: …)\n")

    if a.yaml:
        with open(a.yaml, "w", encoding="utf-8") as fh:
            fh.write("# Draft indicator entries — review before use\n")
            fh.write("\n".join(drafts))
        print(f"\n{len(drafts)} draft indicator(s) written to {a.yaml}")


if __name__ == "__main__":
    main()
