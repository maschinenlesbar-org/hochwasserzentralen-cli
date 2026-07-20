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

An empty `data` array is the happy answer: no active alerts. Headlines only:

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

# Gauges on waters whose name contains "Elbe" (case-insensitive)
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

Per state: station count per lhpClass plus the state's worst class, worst first.
As a terminal table:

```bash
hochwasser --compact situation \
  | jq -r '.states[] | [.state, .stations, .worstClass, .worstClassName] | @tsv' \
  | column -t
```

The aggregate also carries the national `worstClass` and the `updated`
timestamp — a one-liner health check:

```bash
hochwasser --compact situation | jq -r '"\(.worstClassName) (Stand: \(.updated))"'
```

## "Put it on a map" (GeoJSON)

```bash
# All alert areas as polygons
hochwasser alerts --geojson -o alerts.geojson

# Bavarian gauges as points, only those with data
hochwasser stations --states BY --min-class 0 --geojson -o bayern-pegel.geojson
```

The CLI refuses to overwrite an existing file (exit 2) unless you pass
`--force`, and confirms what it wrote on stderr:

```text
Wrote 243 features (130359 bytes) to bayern-pegel.geojson
```

Open the file at https://geojson.io or load it into Leaflet/QGIS. Coordinates
are `[longitude, latitude]` (RFC 7946). The collection's top-level `source`,
`licence` and `updated` members are your attribution — keep them.

## "Demo it without a flood" (test system)

The production alerts feed is usually empty (good!). The LHP test system serves
fixed data with plenty of alerts:

```bash
hochwasser --base-url https://api.hochwasserzentralen.de/public/v1/test alerts --cap
hochwasser --base-url https://api.hochwasserzentralen.de/public/v1/test stations --min-class 2
```

## Scripting patterns

```bash
# Exit-code driven: 0 = call worked (an empty alert list still exits 0)
if hochwasser --compact alerts --states NW > alerts.json; then
  count=$(jq '.data | length' alerts.json)
  echo "NRW has $count active flood alert(s) (Stand: $(jq -r .updated alerts.json))"
fi

# Cron-friendly: alarm when any gauge in a state reaches class 3
worst=$(hochwasser --compact situation --states RP | jq '.worstClass')
[ "$worst" -ge 3 ] && notify-send "Hochwasser RP: Klasse $worst"

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
| `1` | anything else (unfollowed 3xx redirect, non-JSON body, server 5xx after retries) |
