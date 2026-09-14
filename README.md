# hochwasserzentralen-cli

[![CI](https://github.com/maschinenlesbar-org/hochwasserzentralen-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/hochwasserzentralen-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/hochwasserzentralen-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/hochwasserzentralen-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/hochwasserzentralen-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/hochwasserzentralen-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/hochwasserzentralen-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/hochwasserzentralen-cli/de/) — command reference, guides and API docs

Check Germany's official flood warnings and the flood situation at ~1200 gauges
from your terminal. `hochwasser` is a command-line tool over the official
**LHP-PublicAPI** (`api.hochwasserzentralen.de`) of the
[Länderübergreifendes Hochwasserportal (LHP)](https://www.hochwasserzentralen.de)
— the joint flood portal of the German states — as clean JSON you can pipe
straight into [`jq`](https://jqlang.github.io/jq/), or as ready-to-map GeoJSON.

- **Works out of the box** — no account, no API key, no configuration.
- **Regional flood alerts** — the states' current official warnings, optionally
  with full CAP (Common Alerting Protocol) detail per alert.
- **Gauge classification** — the flood class (lhpClass) at every LHP gauge, with
  client-side filters by river and severity.
- **Offline aggregation** — `situation` condenses ~1200 gauges into a per-state
  overview: station counts per class + each state's worst class.
- **GeoJSON export** — `--geojson` on alerts/stations emits a valid
  `FeatureCollection` for geojson.io / Leaflet / QGIS.

> **Classification, not water levels.** The LHP publishes *how bad* the flood
> situation is at a gauge (a class from -1 to 4) — it does **not** publish
> measured water levels. For live levels and measurement histories on the
> federal waterways, use the sibling
> [pegel-online-cli](https://github.com/maschinenlesbar-org/pegel-online-cli).
> The two are complementary: LHP = alerts + classification (all states),
> PEGELONLINE = measured values (federal waterways).

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/hochwasserzentralen-cli
```

This installs the **`hochwasser`** command. Requires **Node.js 20+**.

Check it works:

```bash
hochwasser --help
```

## Quickstart

```bash
# Are there flood warnings anywhere right now?
hochwasser alerts

# ...in Bavaria and Saxony, with the full CAP detail blocks?
hochwasser alerts --states BY,SN --cap

# The flood class at every gauge in Berlin
hochwasser stations --states BE

# One-screen national overview: per state, gauges per class + worst class
hochwasser situation
```

## Commands

```text
alerts      current regional flood alerts (Hochwasser-Warnungen) of the states
stations    flood classification at the ~1200 LHP gauges (no water levels)
situation   per-state aggregate: station count per lhpClass + worst class
```

### `alerts` options

| Flag | Meaning |
| --- | --- |
| `--states <codes>` | comma-separated state codes, e.g. `BY,SN` (case-insensitive; validated) |
| `--cap` | include the CAP (Common Alerting Protocol) detail block per alert |
| `--lang <de\|en>` | response language (default `de`) |
| `--geojson` | output the alert areas as a GeoJSON `FeatureCollection` |

### `stations` options

| Flag | Meaning |
| --- | --- |
| `--states <codes>` | comma-separated state codes (validated) |
| `--lang <de\|en>` | response language |
| `--water <name>` | only stations whose water (river) name contains this text, case-insensitive |
| `--min-class <n>` | only stations with `lhpClass >= n` (`-1` no data … `4` sehr großes Hochwasser) |
| `--geojson` | output the stations as a GeoJSON `FeatureCollection` of points |

### `situation` options

| Flag | Meaning |
| --- | --- |
| `--states <codes>` | restrict the aggregation to these states |
| `--lang <de\|en>` | response language (affects class names) |

The 16 state codes are `BB BE BW BY HB HE HH MV NI NW RP SH SL SN ST TH` — the
**[Glossary](GLOSSARY.md)** maps each to its Bundesland and explains every domain
term, including the two different `lhpClass` scales.

## GeoJSON export

`--geojson` turns the result into a valid `FeatureCollection` (alert areas as
polygons, stations as points, both `[lon, lat]`). Combine with `-o` to write a
file — the CLI **never silently overwrites** an existing file (pass `--force`) and
reports the feature count after writing:

```bash
hochwasser stations --states BY --geojson -o bayern-pegel.geojson
# stderr: Wrote 243 features (130359 bytes) to bayern-pegel.geojson
```

The exported collection carries `source`, `licence` and `updated` as top-level
foreign members — keep them: the data is CC BY 4.0 and requires attribution and
the data timestamp when passed on (see below).

## Output & scripting

Every command prints **pretty JSON to stdout** (errors and the `-o` confirmation
go to stderr). The full API envelope is preserved — including `updated` (the data
timestamp), `source`/`sourceName` and `licence`/`licenceName` — because the data
license requires displaying them.

```bash
# Alert headlines with their region
hochwasser --compact alerts | jq -r '.data[] | [.lhpClassName, .areaDesc] | @tsv'

# All gauges currently at class >= 2, name + river + class
hochwasser --compact stations --min-class 2 | jq -r '.data[] | [.name, .water, .lhpClass] | @tsv'

# The worst-hit states first
hochwasser --compact situation | jq -r '.states[] | [.state, .worstClass, .worstClassName] | @tsv'

# Data timestamp (show this when you present the data — CC BY 4.0)
hochwasser --compact stations | jq -r '.updated'
```

Use `--compact` for single-line JSON in pipelines. Global options work before
or after the command.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | success (also `--help` / `--version`) |
| `2` | bad usage / invalid argument / refused overwrite (nothing was sent or written) |
| `4` | resource not found (`404`) |
| `6` | network / transport failure (DNS, connection, timeout, size cap) |
| `1` | any other error (including a `3xx` — redirects are not followed — and bad JSON) |

## The test system

The LHP operates a test system with **fixed canned data** (it always has active
alerts) — ideal for demos and development:

```bash
hochwasser --base-url https://api.hochwasserzentralen.de/public/v1/test alerts --cap
```

## Troubleshooting

- **`command not found: hochwasser`** — the global npm bin directory isn't on
  your `PATH`. Run `npm bin -g` to find it and add it.
- **Exit `2` / "Unknown state code"** — `--states` takes a comma-separated subset
  of the 16 codes (`BY,SN`, case doesn't matter). A typo is rejected up front
  rather than silently returning the nationwide set.
- **Empty `data` array on `alerts`** — good news: no active flood alerts for the
  requested states. Use the test system (above) to see what alerts look like.
- **Exit `1` with a redirect hint** — the server answered `3xx`; this client does
  not follow redirects. Check `--base-url` points at
  `https://api.hochwasserzentralen.de/public/v1`.
- **Exit `6` / network error** — connectivity, DNS, or a timeout. Try again, or
  raise `--timeout 60000`.

## Global options

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--base-url <url>` | API base URL (default `https://api.hochwasserzentralen.de/public/v1`; append `/test` for the test system) |
| `--timeout <ms>` | Per-request timeout in milliseconds (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses, honouring `Retry-After` (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `-o, --output <file>` | Write output to this file instead of stdout |
| `--force` | Overwrite the `--output` file if it already exists |

## Learn more

- **[SKILLS.md](SKILLS.md)** — Claude Code Agent Skills that drive this CLI for live flood questions.
- **[Usage.md](Usage.md)** — use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — lhpClass scales, AlertArea vs Station, CAP, Meldestufen, state codes.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

## Data license

This CLI is a **client** — it accesses data it does not own or redistribute. The
upstream data is © its provider and licensed **separately from this tool's code**.
See **[DATA_LICENSE.md](DATA_LICENSE.md)**.

> **Länderübergreifendes Hochwasserportal (LHP)** — **CC BY 4.0**. When you pass
> the data on, name the source ("Quelle: Länderübergreifendes Hochwasserportal
> (LHP)", linking https://www.hochwasserzentralen.de) **and show the data
> timestamp** (the `updated` field). Unverified raw data, no warranty; online
> republication should refresh at least every 10 minutes.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
