---
name: hochwasser-station-situation
description: >
  Check the flood situation at Germany's gauges using the
  hochwasserzentralen-cli. Trigger when the user asks "flood situation on the
  Rhine?", "wie ist die Hochwasserlage?", "sind Pegel an der Elbe über
  Meldestufe?", "which rivers are flooding right now?", "Hochwasser-Übersicht
  für Deutschland?", or wants a per-state or per-river flood classification
  overview. Uses the LHP gauge classification (lhpClass 4..-1) and the built-in
  per-state aggregation — classification only, not water levels.
compatibility: >
  Requires the `hochwasser` CLI (npm package
  @maschinenlesbar.org/hochwasserzentralen-cli) on PATH, installed by the user;
  the skill never installs it. Uses jq for JSON filtering. Network access to
  api.hochwasserzentralen.de.
---

# Station Flood-Situation Check (LHP)

Answer "how bad is the flood situation?" from the LHP gauges (about 1600;
`situation` reports the live count as `totalStations`) — as a per-state
overview or a per-river drill-down — using the harmonised nationwide
classification, and report it with the data timestamp.

## Tooling

This skill drives the `hochwasser` command. **Before anything else, validate it is available** — run `command -v hochwasser` (or `hochwasser --version`). If it is not on your PATH, STOP and inform the user that the `hochwasser` CLI (`@maschinenlesbar.org/hochwasserzentralen-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

The API is read-only, needs **no API key**. Always pass `--compact`.

## Step 1 — Overview first

For any broad question ("wie ist die Lage?"), start with the aggregate:

```bash
hochwasser --compact situation                 # nationwide, per state
hochwasser --compact situation --states BY,BW  # scoped
```

Returns `worstClass`/`worstClassName` overall plus `.states[]`, worst-first:
`state`, `stations`, `worstClass`, `worstClassName`, and `classes` (station
count per class, keys `"-1"`..`"4"`). If the national `worstClass` is `0`,
the verdict is "no flooding at any reporting gauge" — say it plainly. Every
state is listed (or each one asked for with `--states`); a state without any LHP
gauge (Hamburg, today) comes last with `stations: 0` and `worstClass: null` —
report it as "no LHP gauges", not as "no data" or "no flooding". The
`"-1"` bucket also holds the gauges without any flood classification
(`lhpClass: null`, see the Traps), so don't read it as "no data" alone.

## Step 2 — Drill down where it's interesting

```bash
hochwasser --compact stations --states SN --min-class 1        # flooding gauges in Saxony
hochwasser --compact stations --water rhein --min-class 2      # Rhine gauges at class 2+
hochwasser --compact stations --water elbe                     # all Elbe gauges
```

Each entry in `.data[]` is a **Station**:

| Field | Meaning |
|---|---|
| `name` | Gauge name (e.g. "Regensburg Eiserne Brücke"). |
| `water` | The river/water body — what `--water` matches (substring, case-insensitive; `ß` = `ss`, so `--water neisse` finds "Lausitzer Neiße"). |
| `lhpClass` | **Number**: `4` Sehr großes / `3` Großes / `2` Mittleres / `1` Kleines Hochwasser / `0` Kein Hochwasser / `-1` Derzeit keine Daten — or **`null`**: the gauge has no flood classification at all (`stateClassName` "Ohne Hochwasser-Einstufung"). |
| `stateClassName` | The state's own label for the class. Stays German with `--lang en` (only `legend` and titles are translated). Rheinland-Pfalz sends an HTML entity: "Kein Hochwasser bzw. &#60; 2-jährliches Hochwasser" — `&#60;` is `<`. |
| `timestamp` | The gauge's own report time (local German time). |
| `stationLink` | The state portal / PEGELONLINE page for this gauge — offer it. |
| `stateId` | ISO form of the state, e.g. `DE-BY`. |

> **Traps.**
> - **No water levels here.** The LHP publishes the *classification* only. If
>   the user wants centimetres or trends ("wie hoch steht der Rhein bei
>   Bonn?"), that is the `pegel` CLI (pegel-online-cli), not this one — many
>   `stationLink`s even point at PEGELONLINE.
> - `lhpClass -1` means **no data**, not "no flood" — never count it as calm.
>   `lhpClass: null` is a third case: a gauge the state doesn't classify for
>   floods (216 of 1573 gauges on 2026-09-15, 180 of them in MV). `situation`
>   counts these in its `"-1"` bucket, so MV's `"-1": 189` was 9 real data gaps
>   plus 180 unclassified gauges. Split them before calling it a data gap:
>   `hochwasser --compact stations --states MV | jq '[.data[] | select(.lhpClass == null)] | length'`.
> - `--min-class 1` is the right filter for "actually flooding"; `--min-class 0`
>   drops the no-data gauges **and** the unclassified (`null`) ones.
> - The station scale (4..-1) is **not** the alerts scale (6..1 with
>   Vorwarnung/Entwarnung) — don't mix the two in one summary.
> - lhpClass is the LHP's harmonised scale, **not** the state's local
>   Meldestufe/Alarmstufe — the number on the state's own portal may differ.
> - `--water` matches by substring: `--water oder` also hits
>   "Spree-Oder-Wasserstrasse". Check the `water` field of the hits before
>   attributing them all to one river.
> - A gauge count alone misleads: 3 flooding gauges out of 4 on a small river
>   is worse than 3 out of 300 on the Rhine — report counts with their base.
> - **Border gauges are listed twice**, once per reporting state, with the same
>   coordinates and different ids: e.g. Worms, Mainz and Kaub (`HE_…` and
>   `RP_…`), Obernau (BY/HE), Havelberg Stadt (BB/ST). A river list therefore
>   double-counts them (on 2026-09-15, `--water rhein` gave 24 entries for 21
>   sites), and so do per-state `situation` counts. Count sites with
>   `jq '.data | unique_by(.coordinates) | length'`.
> - **Exit 1 with "The API answered /data/stations with its GeoJSON
>   representation"** (older CLI versions: `Expected "data" to be an array …
>   got undefined`) is a transient mix-up in the API's cache, not missing
>   data. Wait a minute, retry once, and say so if it persists.

## Step 3 — Report

Lead with the verdict (worst class + where), then a compact ranking: state or
river, gauges at each class (ignore the `-1` bucket except to note data gaps,
and count unclassified `null` gauges apart from those), worst gauge by name. Mention each gauge's `timestamp` when it matters.

**Attribution is mandatory (CC BY 4.0):** close with
"Quelle: Länderübergreifendes Hochwasserportal (LHP), hochwasserzentralen.de —
Stand: …" using the response's `updated` field. `updated` always carries a
`+01:00` offset, also in summer: convert it to German local time before
writing it (`2026-09-15T16:47:47+01:00` is 17:47:47 MESZ), or quote it with
its offset. The gauges' own `timestamp` is already local time. This is
unverified raw data — for safety decisions, refer to the state portals
(`stationLink`) and official warnings (the flood-alerts skill covers those).
