# Usage cookbook

Worked, use-case-driven examples for `hochwasser`. Everything prints JSON to
stdout; pipe into [`jq`](https://jqlang.github.io/jq/) at will. See the
[README](README.md) for the command/option reference and the
[GLOSSARY](GLOSSARY.md) for every domain term (especially the **two different
lhpClass scales**).

> **Attribution reminder (CC BY 4.0):** when you show this data to anyone, cite
> "Quelle: Länderübergreifendes Hochwasserportal (LHP)"
> (https://www.hochwasserzentralen.de) and display the `updated` timestamp.
> Every output of this CLI carries both.

## "Are there flood warnings right now?"

```bash
hochwasser alerts
```

An empty `data` array (exit 0) is the happy answer: no active alerts. An answer whose
envelope reports anything but `"status": "success"` is an error instead (exit 1, `The API
reported status "error" … : <the API's message>`), never printed as data or written to
`-o`. Headlines only:

```bash
hochwasser --compact alerts | jq -r '.data[] | [.id, .lhpClassName, .areaDesc] | @tsv'
```

## "Warnings in Bavaria and Saxony, with full detail"

```bash
hochwasser alerts --states BY,SN --cap
```

`--states` is validated (a typo exits 2 instead of silently returning
everything); `--cap` adds the Common Alerting Protocol block — the
`cap.info.instruction` field carries the "what should I do" text:

```bash
hochwasser --compact alerts --states BY --cap \
  | jq -r '.data[] | "\(.areaDesc): \(.cap.info.severity // "n/a") — \(.cap.info.instruction // "-")"'
```

## "How bad is it at the gauges?"

```bash
# Everything in Berlin
hochwasser stations --states BE

# Only gauges actually showing flood (class >= 1), nationwide
hochwasser stations --min-class 1

# Gauges on waters whose name contains "Elbe" (case-insensitive; ß = ss, so NEISSE finds "Lausitzer Neiße";
# ä/ö/ü = ae/oe/ue, so Roeder finds "Große Röder"; a double space, tab or no-break space counts as one space)
hochwasser stations --water elbe

# Combine: Saxon Elbe gauges at class >= 2, in English
hochwasser stations --states SN --water elbe --min-class 2 --lang en
```

Note: `stations` gives the flood **classification** only. For measured water
levels use the sibling `pegel-online-cli` (`pegel current DRESDEN`).

## "One-screen national overview"

```bash
hochwasser situation
```

Per state: station count per lhpClass (`classes`, keys in the order `"0"`..`"4"`,
then `"-1"` — read them by key, not by position) plus the state's worst class,
worst first.
Every state is listed (with `--states`, each requested one): a state without any
LHP gauge in the data (Hamburg, today) comes last with `stations: 0` and
`worstClass`/`worstClassName` `null` — "no gauges", not class -1 "no data". The
national `worstClass` is `null` only when no gauge was returned at all.
As a terminal table:

```bash
hochwasser --compact situation \
  | jq -r '.states[] | [.state, .stations, .worstClass, .worstClassName] | @tsv' \
  | column -t
```

The aggregate also carries the national `worstClass`, the `updated`
timestamp and the response's `lang` (the API cache can answer `--lang en` in
German; class names then stay German) — a one-liner health check:

```bash
hochwasser --compact situation | jq -r '"\(.worstClassName) (Stand: \(.updated))"'
```

## "Put it on a map" (GeoJSON)

```bash
# All alert areas (Polygons, or LineStrings for river reaches)
hochwasser alerts --geojson -o alerts.geojson

# Bavarian gauges as points, only those classified 0 or higher
# (drops "no data" (-1) and unclassified (lhpClass null) gauges)
hochwasser stations --states BY --min-class 0 --geojson -o bayern-pegel.geojson
```

The CLI refuses to overwrite an existing file (exit 2) unless you pass
`--force` — also when a symlink, even a dangling one, sits at that path — and
confirms what it wrote on stderr:

```text
Wrote 243 features (130359 bytes) to bayern-pegel.geojson
```

Items without a usable geometry (an alert area without a GeoJSON geometry, a gauge
without coordinates, a position outside ±180/±90) can't go on a map and are left out
— but never silently: the confirmation adds the count, and a note names them, to a
file and to stdout alike:

```text
Wrote 1 feature (13599 bytes) to map.geojson; 2 alerts skipped (no usable geometry)
Note: 2 alerts left off the map (no usable geometry): BY_1 (class 6, Sehr großes Hochwasser, Donau), BY_2 (class 2, …)
```

Open the file at https://geojson.io or load it into Leaflet/QGIS. Coordinates
are `[longitude, latitude]` (RFC 7946), and the collection's `bbox` is
`[west, south, east, north]` around the exported features. The collection's
top-level `source`, `licence` and `updated` members are your attribution — keep
them. `updated` always carries a `+01:00` offset, also in summer; convert it to
German local time before you show it.

## "Demo it without a flood" (test system)

The production alerts feed is usually empty (good!). The LHP test system serves
fixed data with plenty of alerts:

```bash
hochwasser --base-url https://api.hochwasserzentralen.de/public/v1/test alerts --cap
hochwasser --base-url https://api.hochwasserzentralen.de/public/v1/test stations --min-class 2
```

A `--base-url` on plain `http:` to a host other than loopback (a mirror) gets one stderr line
before the first request — `warning: requests to <host> are sent unencrypted (http:, not
https:)`, or "the base URL's credentials are sent unencrypted …" with a `user:password@` (never
printed). stdout and the exit code are unchanged.

## Scripting patterns

```bash
# Exit-code driven: 0 = call worked (an empty alert list still exits 0)
if hochwasser --compact alerts --states NW > alerts.json; then
  count=$(jq '.data | length' alerts.json)
  echo "NRW has $count active flood alert(s) (Stand: $(jq -r .updated alerts.json))"
fi

# Cron-friendly: alarm when any gauge in a state reaches class 3 — and fail closed:
# a check that could not run (no network, an API error, no gauge with data) alarms too,
# so "no alarm" always means "checked, and below class 3".
out=$(hochwasser --compact situation --states RP)
code=$?
if [ "$code" -ne 0 ]; then
  notify-send "Hochwasser RP: Prüfung fehlgeschlagen (Exit $code)"; exit "$code"
fi
worst=$(printf '%s\n' "$out" | jq -e '.worstClass') || {
  notify-send "Hochwasser RP: keine Einstufung erhalten"; exit 1   # worstClass null: no gauge
}
if [ "$worst" -lt 0 ]; then
  notify-send "Hochwasser RP: keine Daten an den Pegeln (Klasse $worst)"; exit 1
fi
if [ "$worst" -ge 3 ]; then notify-send "Hochwasser RP: Klasse $worst"; fi

# Save the raw response for later processing (refuses to clobber; --force to allow)
hochwasser stations -o stations-$(date +%F).json

# Robustness knobs for flaky networks
hochwasser --timeout 60000 --max-retries 5 stations
```

## Exit codes recap

| Code | Meaning |
| --- | --- |
| `0` | success (an empty result is success) |
| `2` | usage error: bad flag, unknown state code, bad `--min-class`, refused overwrite |
| `4` | HTTP 404 |
| `6` | network/transport failure |
| `1` | anything else (unfollowed 3xx redirect, non-JSON body, an envelope whose `status` isn't `success`, a nationwide station list without any gauge, server 5xx after retries) |
