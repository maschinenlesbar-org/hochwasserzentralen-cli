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
compatibility: >
  Requires the `hochwasser` CLI (npm package
  @maschinenlesbar.org/hochwasserzentralen-cli) on PATH, installed by the user;
  the skill never installs it. Uses jq for JSON filtering. Network access to
  api.hochwasserzentralen.de.
---

# Flood Data → GeoJSON Export (LHP)

Turn the LHP flood data into a **valid GeoJSON `FeatureCollection`** ready for
geojson.io, Leaflet, QGIS, or Kibana — alert areas as polygons, gauges as
points — using the CLI's built-in `--geojson` export (no hand-rolled jq needed).

## Tooling

This skill drives the `hochwasser` command. **Before anything else, validate it is available** — run `command -v hochwasser` (or `hochwasser --version`). If it is not on your PATH, STOP and inform the user that the `hochwasser` CLI (`@maschinenlesbar.org/hochwasserzentralen-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

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
  `.lhpClass` (numeric scale 4..-1). Gauges without a flood classification
  (`lhpClass: null` in the API, `stateClassName` "Ohne Hochwasser-Einstufung")
  have **no `lhpClass` property** — style them as unclassified, not as `0` or
  `-1`;
- `bbox` is `[west, south, east, north]` around the written features, so
  `bbox[1] <= bbox[3]`, and it is absent when nothing was written.
  hochwasser 0.0.3 and older copied the API's fixed Germany box in
  `[west, north, east, south]` order instead. If `bbox[1] > bbox[3]`, write a
  copy without it under a new, confirmed name
  (`jq 'del(.bbox)' in.geojson > out.geojson`) before handing the file on.

> **Traps.**
> - **Zero features is a valid export** when there are no active alerts (or the
>   filter matched nothing) — say "no active warning areas to map" rather than
>   implying a broken export. For a populated demo map, the fixed-data test
>   system works: add `--base-url https://api.hochwasserzentralen.de/public/v1/test`
>   — and label the map as test data.
> - The two layers use **different lhpClass scales** (alerts "6".."1" strings,
>   stations 4..-1 numbers) — when styling by class, style each layer
>   separately; never merge them into one colour ramp.
> - Stations without usable coordinates, and alert areas without a valid
>   geometry (not a GeoJSON geometry, or a position outside ±180/±90), are
>   skipped by the export automatically; the reported feature count is the
>   count actually written.
> - **Border gauges are exported twice**, once per reporting state, as two
>   points on the same spot with different ids (e.g. Worms, Mainz, Kaub as
>   `HE_…` and `RP_…`). On 2026-09-15 the Rhine export had 24 features for 21
>   sites. Say so when you report the feature count.
> - Rheinland-Pfalz labels carry an HTML entity: `stateClassName` "Kein
>   Hochwasser bzw. &#60; 2-jährliches Hochwasser" (`&#60;` is `<`). Mind it
>   when you use that property as a map label.
> - **Exit 1 saying "The API answered … with its GeoJSON representation"**
>   (older CLI versions: `Expected "data" to be an array … got undefined`) is a
>   transient mix-up in the API's cache. Nothing was written; wait a minute
>   and retry once.
> - The full national station layer is about 1600 points (1573 on 2026-09-15) —
>   fine as a map layer, but warn before pasting the raw GeoJSON inline as
>   text; offer https://geojson.io.

## Step 3 — Attribution on the map (required)

The export carries `source`, `sourceName`, `licence`, `licenceName` and
`updated` as top-level members of the FeatureCollection — **keep them in the
file**, and put the credit on any rendered map (CC BY 4.0):

> Quelle: Länderübergreifendes Hochwasserportal (LHP), hochwasserzentralen.de — Stand: [the `updated` value]

`updated` always carries a `+01:00` offset, also in summer: on the map, write
it as German local time (`2026-09-15T16:47:47+01:00` is 17:47:47 MESZ) or with
its offset.

Offer follow-ups: colour points by `lhpClass` for a severity map, or combine
both layers (alerts polygons under station points) into one view.
