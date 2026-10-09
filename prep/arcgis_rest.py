"""Minimal ArcGIS REST client — optional, only used for `type: arcgis` sources.

No arcgis Python package needed: plain HTTPS against FeatureServer layers and
portal items. Works with ArcGIS Online and ArcGIS Enterprise.

Token, in order of precedence:
  1. the ARCGIS_TOKEN (or AGOL_TOKEN) environment variable
  2. the file written by arcgis_login.py (~/.pti-builder/arcgis_token.txt)
  3. none — public layers still work

Behind a TLS-inspecting proxy (e.g. some corporate networks) set
PTI_SSL_VERIFY=0. Verification is on by default.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import pandas as pd
import requests

TOKEN_FILE = Path.home() / ".pti-builder" / "arcgis_token.txt"
VERIFY = os.environ.get("PTI_SSL_VERIFY", "1").lower() not in {"0", "false", "no"}
if not VERIFY:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


class TokenExpired(RuntimeError):
    """ArcGIS rejected the token. Aborts the whole build — skipping the layer
    instead would produce a partial dataset that looks valid."""


def load_token() -> str | None:
    tok = os.environ.get("ARCGIS_TOKEN") or os.environ.get("AGOL_TOKEN")
    if tok:
        return tok.strip()
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text(encoding="utf-8").strip() or None
    return None


def _check(data: dict) -> dict:
    err = data.get("error")
    if err:
        code, msg = err.get("code"), str(err.get("message", ""))
        if code in (498, 499) or "token" in msg.lower():
            raise TokenExpired(f"ArcGIS rejected the token ({code}: {msg}). "
                               f"Run prep/arcgis_login.py or set ARCGIS_TOKEN.")
        raise ValueError(f"ArcGIS error {code}: {msg}")
    return data


def get_json(url: str, token: str | None = None, retries: int = 3, **params) -> dict:
    """GET with retries — proxies occasionally drop a connection mid-response."""
    params = {"f": "json", **params}
    if token:
        params["token"] = token
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, timeout=120, verify=VERIFY)
            return _check(r.json())
        except (requests.RequestException, ValueError) as e:
            if isinstance(e, ValueError) and "ArcGIS error" in str(e):
                raise
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"request to {url} failed after {retries} attempts: {last}")


def query_table(url: str, token: str | None = None, out_fields: str = "*",
                where: str = "1=1", page_size: int = 2000) -> pd.DataFrame:
    """All attribute rows of a FeatureServer layer, paginated."""
    url = url.rstrip("/")
    try:
        page_size = min(page_size, get_json(url, token).get("maxRecordCount", page_size))
    except TokenExpired:
        raise
    except Exception:
        pass
    frames, offset = [], 0
    while True:
        data = get_json(f"{url}/query", token, where=where, outFields=out_fields,
                        returnGeometry="false", resultOffset=offset,
                        resultRecordCount=page_size)
        feats = data.get("features", [])
        if not feats:
            break
        frames.append(pd.DataFrame([f["attributes"] for f in feats]))
        offset += len(feats)
        # Some services omit exceededTransferLimit; a short page is the real end
        if not data.get("exceededTransferLimit", False) and len(feats) < page_size:
            break
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def query_geojson(url: str, token: str | None = None, where: str = "1=1",
                  page_size: int = 500) -> dict:
    """All features of a layer as a WGS84 GeoJSON FeatureCollection."""
    url = url.rstrip("/")
    feats, offset = [], 0
    while True:
        gj = get_json(f"{url}/query", token, where=where, outFields="*", outSR="4326",
                      resultOffset=offset, resultRecordCount=page_size, f="geojson")
        batch = gj.get("features", [])
        feats.extend(batch)
        offset += len(batch)
        if not batch or (not gj.get("exceededTransferLimit", False) and len(batch) < page_size):
            break
    return {"type": "FeatureCollection", "features": feats}


def webmap_layers(portal: str, item_id: str, token: str | None = None) -> list[dict]:
    """Every feature layer in a web map, group layers flattened.

    Returns [{title, url, group}] — url points at a single layer
    (…/FeatureServer/N). Map-image and tile layers are listed with their url
    but flagged, since they carry no attributes to build indicators from.
    """
    data = get_json(f"{portal.rstrip('/')}/sharing/rest/content/items/{item_id}/data", token)
    out: list[dict] = []

    def walk(layers: list[dict], group: str = ""):
        for lyr in layers or []:
            title = lyr.get("title") or lyr.get("id") or ""
            if lyr.get("layerType") == "GroupLayer" or lyr.get("layers") and not lyr.get("url"):
                walk(lyr.get("layers"), f"{group}/{title}".strip("/"))
                continue
            url = lyr.get("url")
            if not url:
                continue
            kind = lyr.get("layerType", "")
            if "FeatureServer" in url and not url.rstrip("/").split("/")[-1].isdigit():
                # Service-level URL: expand to its sub-layers
                try:
                    svc = get_json(url, token)
                    for sub in svc.get("layers", []) + svc.get("tables", []):
                        out.append({"title": f"{title} / {sub['name']}", "url": f"{url.rstrip('/')}/{sub['id']}",
                                    "group": group, "feature": True})
                except TokenExpired:
                    raise
                except Exception as e:
                    out.append({"title": title, "url": url, "group": group, "feature": False, "error": str(e)})
                continue
            out.append({"title": title, "url": url, "group": group,
                        "feature": "FeatureServer" in url or kind == "ArcGISFeatureLayer"})

    walk(data.get("operationalLayers", []))
    walk(data.get("tables", []), "tables")
    return out


def layer_info(url: str, token: str | None = None) -> dict:
    """Name, geometry type and fields of one layer."""
    info = get_json(url, token)
    return {
        "name": info.get("name"),
        "geometry": info.get("geometryType"),
        "fields": [{"name": f["name"], "type": f.get("type"), "alias": f.get("alias")}
                   for f in info.get("fields", [])],
        "count": None,
    }
