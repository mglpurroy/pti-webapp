"""Sign in to ArcGIS Online / Enterprise and save a token for the build.

Optional — only needed when the build reads `type: arcgis` sources that are
not public.

OAuth (PKCE) needs an app registration (client ID) in your portal; many
organisations already have one for internal tools. Without one, paste a token
instead (--paste): sign in to the portal in a browser and copy one from
  <portal>/sharing/rest/generateToken
or from the 'token=' parameter of any request in the browser's dev tools.

Usage:
    python prep/arcgis_login.py --portal https://myorg.maps.arcgis.com --client-id ABC123
    python prep/arcgis_login.py --paste

Either way the token is saved to ~/.pti-builder/arcgis_token.txt (never in
the repo). Tokens typically last about two hours.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import os
import secrets
import urllib.parse
import webbrowser

import requests

from arcgis_rest import TOKEN_FILE, VERIFY

REDIRECT = "urn:ietf:wg:oauth:2.0:oob"


def pkce_login(portal: str, client_id: str) -> str:
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    url = f"{portal}/sharing/rest/oauth2/authorize?" + urllib.parse.urlencode({
        "client_id": client_id, "response_type": "code", "redirect_uri": REDIRECT,
        "code_challenge": challenge, "code_challenge_method": "S256",
    })
    print("Opening the portal sign-in page. After signing in, copy the code it shows.")
    webbrowser.open(url)
    code = input("Paste the code and press Enter:\n> ").strip()
    r = requests.post(f"{portal}/sharing/rest/oauth2/token", data={
        "client_id": client_id, "grant_type": "authorization_code", "code": code,
        "redirect_uri": REDIRECT, "code_verifier": verifier,
    }, timeout=30, verify=VERIFY)
    d = r.json()
    if "access_token" not in d:
        raise SystemExit(f"Token exchange failed: {d}")
    return d["access_token"]


def whoami(portal: str, token: str) -> str:
    r = requests.get(f"{portal}/sharing/rest/portals/self",
                     params={"f": "json", "token": token}, timeout=15, verify=VERIFY)
    return r.json().get("user", {}).get("username", "unknown")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--portal", default=os.environ.get("ARCGIS_PORTAL", "https://www.arcgis.com"))
    ap.add_argument("--client-id", default=os.environ.get("ARCGIS_CLIENT_ID"))
    ap.add_argument("--paste", action="store_true", help="paste an existing token instead of OAuth")
    a = ap.parse_args()
    portal = a.portal.rstrip("/")

    if a.paste or not a.client_id:
        if not a.paste:
            print("No --client-id given (or ARCGIS_CLIENT_ID), so falling back to pasting a token.")
        token = input("Paste your ArcGIS token:\n> ").strip()
    else:
        token = pkce_login(portal, a.client_id)

    user = whoami(portal, token)
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(token, encoding="utf-8")
    print(f"Signed in as {user}. Token saved to {TOKEN_FILE}")
