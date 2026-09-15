# Glossary

Domain terms for `hochwasserzentralen-cli` and the LHP-PublicAPI. Library and
technical terms (Transport, RequestEngine, …) live in
[DEVELOPING.md](DEVELOPING.md).

## LHP (Länderübergreifendes Hochwasserportal)

The joint flood portal of the German states (Bundesländer), online at
https://www.hochwasserzentralen.de. Each state runs its own flood warning
service (Hochwasserzentrale); the LHP aggregates their warnings and gauge
classifications into one national picture and publishes it via the
**LHP-PublicAPI** that this CLI wraps. The data is **CC BY 4.0** — see
[DATA_LICENSE.md](DATA_LICENSE.md).

## AlertArea vs Station

The API's two kinds of items:

- **AlertArea** (`hochwasser alerts`) — a *regional warning area*: a polygon
  (river reach, region, or a whole state) with the state's current official
  flood warning for it: headline, link to the state's portal, warning class,
  optionally a full **CAP** block. Zero alert areas = no active warnings.
- **Station** (`hochwasser stations`) — a single *gauge* (Pegel) with its
  current flood **classification**. About 1600 stations nationwide (1573 on
  2026-09-15; `situation` reports the current count as `totalStations`). **No water
  levels** — the LHP publishes only the class. For measured levels use
  [pegel-online-cli](https://github.com/maschinenlesbar-org/pegel-online-cli)
  (many `stationLink`s even point to pegelonline.wsv.de). A gauge on a state
  border can be listed twice, once per reporting state, with the same
  coordinates and different ids (e.g. `HE_25700100` and `RP_25700100`, Kaub).
  `stateClassName` is the state's own label for the class: it is not
  translated by `--lang en`, and Rheinland-Pfalz sends it with an HTML entity
  (`&#60;` for `<`).

## lhpClass — two different scales!

The single most important trap in this API: **alerts and stations use different
`lhpClass` scales, and different types.**

**Station scale** (`stations`, numeric `lhpClass`, also used by `--min-class`
and `situation`):

| lhpClass | Meaning |
| --- | --- |
| `4` | Sehr großes Hochwasser (very large flood) |
| `3` | Großes Hochwasser (large flood) |
| `2` | Mittleres Hochwasser (medium flood) |
| `1` | Kleines Hochwasser (small flood) |
| `0` | Kein Hochwasser (no flood) |
| `-1` | Derzeit keine Daten (currently no data) |
| `null` | Ohne Hochwasser-Einstufung (gauge without a flood classification) |

`null` is not in the `legend`, but it occurs live (216 of 1573 gauges on
2026-09-15, most of them in MV). `situation` counts these gauges in its `"-1"`
bucket, `--min-class` drops them whatever the value, and the GeoJSON export
leaves out the `lhpClass` property for them.

**Alert scale** (`alerts`, `lhpClass` is a **string**, e.g. `"4"`):

| lhpClass | Meaning |
| --- | --- |
| `"6"` | Sehr großes Hochwasser |
| `"5"` | Großes Hochwasser |
| `"4"` | Hochwasser |
| `"2"` | Vorwarnung (pre-warning) |
| `"1"` | Entwarnung (all-clear) |

Never compare an alert's class to a station's class numerically, and remember an
alert `lhpClass: "1"` is *good* news (Entwarnung) while a station `lhpClass: 1`
is a small flood. Every response carries its own `legend` mapping classes to
names and colours — prefer it over hard-coding.

## lhpClass vs Meldestufen

Each German state defines its own local warning levels (**Meldestufen** /
Alarmstufen — e.g. Bavaria's Meldestufe 1–4, Brandenburg's Alarmstufe I–IV).
The LHP class is the **harmonised, nationwide** scale the portal maps those
onto so states are comparable. The state's own portal (the `alertLink` /
`stationLink` / `stateLinks` targets) speaks in local Meldestufen; this API
speaks lhpClass. Don't treat them as interchangeable numbers.

## CAP (Common Alerting Protocol)

The international OASIS standard format for public warnings (also used by
DWD and BBK/NINA). With `--cap`, each alert carries a `cap` block:
`identifier`, `sender`, `sent`, `status`, `msgType` (`Alert`/`Update`/`Cancel`),
`references`, and an `info` object with `severity` (`Minor`/`Moderate`/
`Severe`/`Extreme`), `urgency`, `certainty`, `onset`/`expires`, `headline`,
`description`, `instruction` (what to do), `web` and `contact`. The
`instruction` field is the actionable part for end users.

## State codes (Bundesländer)

The `--states` filter takes a comma-separated subset of these 16 codes
(case-insensitive; validated — a typo exits 2 rather than silently returning
everything):

| Code | Land | Code | Land |
| --- | --- | --- | --- |
| `BB` | Brandenburg | `NI` | Niedersachsen |
| `BE` | Berlin | `NW` | Nordrhein-Westfalen |
| `BW` | Baden-Württemberg | `RP` | Rheinland-Pfalz |
| `BY` | Bayern | `SH` | Schleswig-Holstein |
| `HB` | Bremen | `SL` | Saarland |
| `HE` | Hessen | `SN` | Sachsen |
| `HH` | Hamburg | `ST` | Sachsen-Anhalt |
| `MV` | Mecklenburg-Vorpommern | `TH` | Thüringen |

Item ids are prefixed with the state code (`BY_577`, `BE_5803500`); the
station `stateId` uses ISO 3166-2 form (`DE-BE`), and `stateLinks` maps those
ids to each state's own flood portal.

## Envelope fields (attribution & freshness)

Every response wraps its `data` in an envelope with `source` / `sourceName`
(the LHP), `licence` / `licenceName` (CC BY 4.0), `updated` (the **data
timestamp** — display it, the licence requires it), `lastModified`, a `legend`,
and a `bbox` (`[west, north, east, south]` in the live API, a fixed box around
Germany whatever the filter). `updated` and `lastModified` always carry a
`+01:00` offset, also in summer; the instant is right, so convert it to German
local time before you display it. This CLI never strips these fields. Its
GeoJSON export carries the attribution and `updated` as foreign members, and
computes its own `bbox` from the exported features in the RFC 7946 order
`[west, south, east, north]`.

## Pegel / water level (what this API does NOT have)

A *Pegel* is a gauge. The LHP tells you each gauge's flood **class**, not its
water level in centimetres. Levels, discharge and measurement histories for the
federal waterways come from PEGELONLINE (WSV) — sibling CLI:
`pegel-online-cli` (`pegel current BONN` etc.).

## Test system

`https://api.hochwasserzentralen.de/public/v1/test` — same API, fixed canned
data that always includes active alerts. Reach it with
`--base-url …/public/v1/test`. Never treat its output as the real situation.
