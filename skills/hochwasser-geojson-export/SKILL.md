---
name: hochwasser-geojson-export
description: >
  Export German flood-warning areas or gauge classifications as valid GeoJSON
  for mapping, using the hochwasserzentralen-cli. Trigger when the user asks to
  "map the flood warnings", "export the Hochwasser areas as GeoJSON", "plot the
  flooding gauges on a map", "Hochwasserkarte für Bayern", "show the alert
  polygons in QGIS", or wants LHP flood geodata for Leaflet / geojson.io /
  QGIS / Kibana. Uses the CLI's built-in FeatureCollection export with the
  overwrite guard, and reports path and feature count.
version: 1.0.0
userInvocable: true
---

# Flood Data → GeoJSON Export (LHP)

Turn the LHP flood data into a **valid GeoJSON `FeatureCollection`** ready for
geojson.io, Leaflet, QGIS, or Kibana — alert areas as polygons, gauges as
points — using the CLI's built-in `--geojson` export (no hand-rolled jq needed).

## Tooling

This skill drives the `hochwasser` command. **Before anything else, validate it is available** — run `command -v hochwasser` (or `hochwasser --version`). If it is not on your PATH, STOP and inform the user that the `hochwasser` CLI (`@maschinenlesbar.org/hochwasserzentralen-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

The API is read-only, needs **no API key**.

## Step 1 — Pick layer, scope, and output path

Two layers; filter *before* exporting so the map only carries what the user wants:

```bash
# Warning areas (polygons)
hochwasser alerts --geojson -o flood-alerts.geojson
hochwasser alerts --states BY,SN --geojson -o flood-alerts-by-sn.geojson

# Gauges (points)
hochwasser stations --geojson -o flood-stations.geojson
hochwasser stations --states BY --min-class 1 --geojson -o bayern-flooding.geojson
hochwasser stations --water elbe --geojson -o elbe-gauges.geojson
```

**Confirm the output path with the user first** (default to a descriptive name
like `./hochwasser-alerts-BY.geojson` in the current directory). The CLI
**refuses to overwrite an existing file** (exit 2 with a clear message) — that
is the built-in guard, not an error in your invocation. If the user wants to
refresh the same file, re-run with `--force`; otherwise pick a new name. Never
add `--force` on your own initiative.

## Step 2 — Verify and report

On success the CLI confirms on stderr, e.g.:

```text
Wrote 243 features (130359 bytes) to bayern-flooding.geojson
```

**Report the path and the feature count back to the user** — and sanity-check:

- the file parses as JSON and is a single `FeatureCollection`;
- coordinates are `[longitude, latitude]` (the CLI already emits x,y order —
  don't "fix" it);
- alert features are Polygons with `properties.areaDesc` / `.lhpClass` (string
  scale 6..1); station features are Points with `properties.name` / `.water` /
  `.lhpClass` (numeric scale 4..-1).

> **Traps.**
> - **Zero features is a valid export** when there are no active alerts (or the
>   filter matched nothing) — say "no active warning areas to map" rather than
>   implying a broken export. For a populated demo map, the fixed-data test
>   system works: add `--base-url https://api.hochwasserzentralen.de/public/v1/test`
>   — and label the map as test data.
> - The two layers use **different lhpClass scales** (alerts "6".."1" strings,
>   stations 4..-1 numbers) — when styling by class, style each layer
>   separately; never merge them into one colour ramp.
> - Stations without coordinates are skipped by the export automatically; the
>   reported feature count is the count actually written.
> - The full national station layer is ~1200 points — fine as a map layer, but
>   warn before pasting the raw GeoJSON inline as text; offer https://geojson.io.

## Step 3 — Attribution on the map (required)

The export carries `source`, `sourceName`, `licence`, `licenceName` and
`updated` as top-level members of the FeatureCollection — **keep them in the
file**, and put the credit on any rendered map (CC BY 4.0):

> Quelle: Länderübergreifendes Hochwasserportal (LHP), hochwasserzentralen.de — Stand: [the `updated` value]

Offer follow-ups: colour points by `lhpClass` for a severity map, or combine
both layers (alerts polygons under station points) into one view.
