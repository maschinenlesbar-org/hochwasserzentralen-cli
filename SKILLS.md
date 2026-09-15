# hochwasserzentralen-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for
Germany's official flood-warning picture, all powered by the **[hochwasser](README.md)**
CLI over the official [LHP-PublicAPI](https://api.hochwasserzentralen.de/public/v1) of the
[Länderübergreifendes Hochwasserportal](https://www.hochwasserzentralen.de) — the joint
flood portal of the German states.

Each skill teaches Claude how to drive the `hochwasser` CLI to answer a specific,
real-world question — "gibt es gerade Hochwasserwarnungen in Bayern?", "flood situation
on the Rhine?", "map the warning areas" — and to report the answer with evidence and the
mandatory CC-BY attribution rather than guesswork. They encode the parts that are easy to
get wrong (the **two different lhpClass scales**, `-1` meaning "no data" not "no flood",
classification-vs-water-level) so Claude doesn't have to rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **hochwasser-flood-alerts** | Pulls the states' current official flood warnings (optionally with full CAP detail) and reports them worst-first with the official instructions. | "gibt es gerade Hochwasserwarnungen in Bayern?", "any flood alerts in Germany?", "Hochwasserlage in Sachsen?" |
| **hochwasser-station-situation** | Condenses the LHP gauges (about 1600) into a per-state or per-river flood-classification verdict via the built-in `situation` aggregate. | "flood situation on the Rhine?", "wie ist die Hochwasserlage?", "which rivers are flooding?" |
| **hochwasser-geojson-export** | Exports alert polygons or gauge points as a valid GeoJSON `FeatureCollection` (overwrite-guarded), reporting path + feature count. | "map the flood warnings", "export the Hochwasser areas as GeoJSON", "Hochwasserkarte für Bayern" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `hochwasser` CLI** installed globally and on your PATH:
  ```bash
  npm i -g @maschinenlesbar.org/hochwasserzentralen-cli   # installs the `hochwasser` bin
  ```
  No API key is required — the LHP-PublicAPI is free, open (CC BY 4.0 data), and read-only.

## Installation

### Plugin marketplace (recommended)

The skills are published as the `hochwasser` plugin in the
[maschinenlesbar.org plugin marketplace](https://github.com/maschinenlesbar-org/plugins),
which lists the plugins for all maschinenlesbar.org CLIs. Installation is two commands
inside Claude Code:

```
/plugin marketplace add maschinenlesbar-org/plugins
/plugin install hochwasser@maschinenlesbar
```

The first command registers the marketplace (once, for all maschinenlesbar.org plugins);
the second installs the `hochwasser` plugin, which bundles all three skills. Update later
with `/plugin marketplace update maschinenlesbar`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/hochwasserzentralen-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/hochwasser-flood-alerts/SKILL.md`. Start a new Claude Code session and the skills
are picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> Gibt es gerade Hochwasserwarnungen in Bayern?

> How is the flood situation on the Elbe — any gauges above a warning class?

> Export the current flood warning areas as GeoJSON so I can open them in QGIS.

You can also invoke a skill explicitly with its slash command, e.g. `/hochwasser-flood-alerts`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`hochwasser` subcommands to call, in what order, and how to interpret the JSON. The
skills encode the non-obvious parts of this API, for example:

- **alerts and stations use two different `lhpClass` scales** — alerts are strings
  `"6"`..`"1"` where `"2"` is a *Vorwarnung* and `"1"` an *Entwarnung* (all-clear!),
  stations are numbers `4`..`-1` where `-1` means "no data", not "no flood";
- the LHP publishes the **classification only, never water levels** — level questions
  belong to the sibling `pegel-online-cli`, and many `stationLink`s point straight at
  PEGELONLINE;
- an **empty alerts array is the happy path** (no warnings), and the fixed-data **test
  system** (`--base-url …/public/v1/test`) is the way to demo populated output;
- `--states` codes are **validated** — a typo exits 2 with the allowed list instead of
  silently returning the nationwide set;
- `-o` **never silently overwrites** — the CLI exits 2 and asks for `--force`;
- the data is **CC BY 4.0**: every answer must cite "Quelle: Länderübergreifendes
  Hochwasserportal (LHP)" and show the `updated` timestamp, which every CLI output keeps.

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option. The upstream data is CC BY 4.0 — see
[DATA_LICENSE.md](DATA_LICENSE.md).
