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
version: 1.0.0
userInvocable: true
---

# Station Flood-Situation Check (LHP)

Answer "how bad is the flood situation?" from the LHP gauges (about 1600;
`situation` reports the live count as `totalStations`) — as a per-state
overview or a per-river drill-down — using the harmonised nationwide
classification, and report it with the data timestamp.

## Tooling

This skill drives the `hochwasser` command. **Before anything else, validate it is available** — run `command -v hochwasser` (or `hochwasser --version`). If it is not on your PATH, STOP and inform the user that the `hochwasser` CLI (`@maschinenlesbar.org/hochwasserzentralen-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

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
the verdict is "no flooding at any reporting gauge" — say it plainly.

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
| `water` | The river/water body — what `--water` matches (substring, case-insensitive). |
| `lhpClass` | **Number**: `4` Sehr großes / `3` Großes / `2` Mittleres / `1` Kleines Hochwasser / `0` Kein Hochwasser / `-1` Derzeit keine Daten. |
| `stateClassName` | Display name for the class (localised via `--lang`). |
| `timestamp` | The gauge's own report time (local German time). |
| `stationLink` | The state portal / PEGELONLINE page for this gauge — offer it. |
| `stateId` | ISO form of the state, e.g. `DE-BY`. |

> **Traps.**
> - **No water levels here.** The LHP publishes the *classification* only. If
>   the user wants centimetres or trends ("wie hoch steht der Rhein bei
>   Bonn?"), that is the `pegel` CLI (pegel-online-cli), not this one — many
>   `stationLink`s even point at PEGELONLINE.
> - `lhpClass -1` means **no data**, not "no flood" — never count it as calm.
>   `--min-class 1` is the right filter for "actually flooding"; `--min-class 0`
>   excludes only the no-data gauges.
> - The station scale (4..-1) is **not** the alerts scale (6..1 with
>   Vorwarnung/Entwarnung) — don't mix the two in one summary.
> - lhpClass is the LHP's harmonised scale, **not** the state's local
>   Meldestufe/Alarmstufe — the number on the state's own portal may differ.
> - `--water` matches by substring: `--water oder` also hits
>   "Spree-Oder-Wasserstrasse". Check the `water` field of the hits before
>   attributing them all to one river.
> - A gauge count alone misleads: 3 flooding gauges out of 4 on a small river
>   is worse than 3 out of 300 on the Rhine — report counts with their base.

## Step 3 — Report

Lead with the verdict (worst class + where), then a compact ranking: state or
river, gauges at each class (ignore the `-1` bucket except to note data gaps),
worst gauge by name. Mention each gauge's `timestamp` when it matters.

**Attribution is mandatory (CC BY 4.0):** close with
"Quelle: Länderübergreifendes Hochwasserportal (LHP), hochwasserzentralen.de —
Stand: …" using the response's `updated` field. This is unverified raw data —
for safety decisions, refer to the state portals (`stationLink`) and official
warnings (the flood-alerts skill covers those).
