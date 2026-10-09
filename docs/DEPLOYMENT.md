# Running and deploying

The app is a static site: `app/` holds HTML, CSS, JavaScript and data files, and there is no server code. All libraries (Plotly with MapLibre, simple-statistics) are bundled in `app/js/vendor/`, so it works where CDNs are blocked.

## Locally

```bash
python -m http.server 8000 --directory app
# open http://localhost:8000          (first dataset)
#      http://localhost:8000/?data=demoland
```

Opening `index.html` directly from disk won't work, because browsers block `fetch` on `file://`.

## Posit Connect

```bash
pip install rsconnect-python
rsconnect deploy html app/ --server https://<connect-server> --api-key "$CONNECT_API_KEY" --title "PTI Builder"
```

Keep the API key in an environment variable, not in a script that sits in a shared folder or repository. On later deploys rsconnect reuses the stored target and updates the same content item.

## GitHub Pages, S3, any web server

Publish the contents of `app/`. On GitHub Pages: *Settings → Pages → Deploy from a branch*, then pick the folder. Pages only serves from `/` or `/docs`, so either move `app/` or use a small Pages workflow that uploads `app/`.

Only publish datasets that may be public. Anything under `app/data/` is downloadable by whoever can open the page.

## Several countries in one deployment

Build each dataset into `app/data/<id>/`. `app/data/index.json` lists them all, and the app shows a dataset selector. Link straight to one with `?data=<id>`.

## Data size

- `units.json` grows with base units × indicators: about 16 MB for 9,300 wards × 50 indicators, compressed well by the server.
- Base-level boundaries are usually the largest file. Use `simplify:` (0.0005–0.002 degrees) for anything above a few MB. They load in the background, so the coarser levels are usable straight away.
- Robustness tests run in the browser: 200 draws over 10,000 units take well under a second.

## ArcGIS (optional)

Nothing here needs ArcGIS. Two optional integrations are included for teams whose data lives in ArcGIS Online or Enterprise.

**Pull data from ArcGIS.** Use `type: arcgis` sources for boundaries, indicators or overlays:

```bash
pip install requests
python prep/arcgis_login.py --portal https://<org>.maps.arcgis.com --client-id <app id>   # OAuth (PKCE)
python prep/arcgis_login.py --paste                                                     # or paste a token
python prep/list_webmap_layers.py <webmap item id> --yaml draft.yaml                    # draft indicator entries
python prep/build_dataset.py my_country/pti.yaml
```

- The token is saved to `~/.pti-builder/arcgis_token.txt`, outside the repository. `ARCGIS_TOKEN` (or `AGOL_TOKEN`) overrides it.
- If the token expires mid-build, the build stops rather than continuing with a partial dataset.
- On networks with TLS inspection (certificate errors), set `PTI_SSL_VERIFY=0` for the build.

**Publish results back.** Add to `pti.yaml`:

```yaml
app:
  arcgis_publish: {portal: https://<org>.maps.arcgis.com}
```

The results drawer then shows **⬆ ArcGIS**. It uploads the scored polygons (GeoJSON) or a table (CSV) at the level shown and publishes them as a hosted feature layer owned by the signed-in user. The item is private until the user shares it. The user pastes a token, which is used once and not stored.

To show users how the data is refreshed, add:

```yaml
app:
  data_refresh_note:
    text: Data is pulled from the country Data Explorer web map. Sign in, rebuild and redeploy.
    command: python prep/build_dataset.py countries/nigeria/pti.yaml
```

## Tests

```bash
node --test tests/core.test.js   # method tests (pti-core.js), Node 18+
python -m pytest tests/          # build smoke test (builds Demoland into a temp folder)
```
