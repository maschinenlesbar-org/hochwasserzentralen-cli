---
name: hochwasser-flood-alerts
description: >
  Check Germany's current official flood warnings using the
  hochwasserzentralen-cli. Trigger when the user asks "gibt es gerade
  Hochwasserwarnungen in Bayern?", "any flood warnings in Germany right now?",
  "ist Hochwasser in Sachsen?", "is there a flood alert for the Elbe region?",
  "Hochwasserlage in NRW?", or wants the states' official warning text and
  instructions. Pulls the LHP alert areas (optionally with full CAP detail),
  reads the right warning scale, and reports with source and data timestamp.
version: 1.0.0
userInvocable: true
---

# Flood Alerts Lookup (LHP)

Answer "is there an official flood warning?" from the Länderübergreifendes
Hochwasserportal — the states' own warnings, not a guess — and report it with
the warning class, the official instruction text, and the data timestamp.

## Tooling

This skill drives the `hochwasser` command. **Before anything else, validate it is available** — run `command -v hochwasser` (or `hochwasser --version`). If it is not on your PATH, STOP and inform the user that the `hochwasser` CLI (`@maschinenlesbar.org/hochwasserzentralen-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

The API is read-only, needs **no API key**. Always pass `--compact`.

## Step 1 — Scope and fetch

Map the user's region to state codes (`BB BE BW BY HB HE HH MV NI NW RP SH SL
SN ST TH`); a river or city belongs to its state(s) — Rhine questions usually
mean `BW,RP,HE,NW`, Elbe `SN,ST,NI,HH,SH,BB`. No region means all of Germany.

```bash
hochwasser --compact alerts                        # nationwide
hochwasser --compact alerts --states BY,SN         # specific states
hochwasser --compact alerts --states BY --cap      # + full CAP detail blocks
hochwasser --compact alerts --lang en              # English class/label names
```

An **empty `data` array is the happy answer**: no active official flood
warnings for that scope. Say so plainly — it is a valid, reassuring result, not
an error. (Exit code 0 either way; exit 2 means a bad state code.)

## Step 2 — Read the alerts

Each entry in `.data[]` is an **AlertArea**:

| Field | Meaning |
|---|---|
| `id` | Area id, state-prefixed (e.g. `BY_577`). |
| `areaDesc` | Human name of the warned area (river reach / region). **Lead with this.** |
| `alertHeadline` | The state's official headline. |
| `alertLink` | The state portal page with the authoritative detail — always offer it. |
| `lhpClass` | Warning class as a **string** — see the scale below. |
| `lhpClassName` | Display name for the class (localised via `--lang`). |
| `cap` | Only with `--cap`: CAP block — `cap.info.severity`, `.urgency`, `.onset`, `.expires`, `.description`, and **`.instruction`** (the "what to do" text). |

> **Traps.**
> - **The alert scale is NOT the station scale.** Alerts: `"6"` Sehr großes /
>   `"5"` Großes / `"4"` Hochwasser / `"2"` **Vorwarnung** (pre-warning) / `"1"`
>   **Entwarnung** (all-clear). An alert `lhpClass` of `"1"` is GOOD news —
>   never report an Entwarnung as an active flood. Stations use a different
>   numeric 4..-1 scale.
> - `lhpClass` is a **string** here (`"4"`), not a number — compare as strings
>   or parse deliberately.
> - `--states` codes are validated; a typo exits 2 with the allowed list —
>   fix the code, don't retry blindly.
> - Production often has **zero alerts**. For a demo of what alerts look like,
>   use the fixed-data test system:
>   `hochwasser --base-url https://api.hochwasserzentralen.de/public/v1/test alerts --cap`
>   — and say clearly it is canned test data, never the real situation.

## Step 3 — Report

Lead with a one-line verdict, then enumerate warnings worst-first (6 → 5 → 4 →
2; list Entwarnungen separately as "cleared"). For each: area, class name,
headline, and — when `--cap` was used — the severity and the instruction text.
Offer the `alertLink` for authoritative detail.

**Attribution is mandatory (CC BY 4.0):** close with
"Quelle: Länderübergreifendes Hochwasserportal (LHP), hochwasserzentralen.de —
Stand: …" using the response's `updated` field for the timestamp. For safety
decisions, point the user to the state portal (`alertLink`) and official
emergency channels — this data is unverified raw data.

For "how bad is it at the gauges" follow-ups, use the station-situation skill
(`hochwasser stations` / `situation`); for a map, the geojson-export skill.
