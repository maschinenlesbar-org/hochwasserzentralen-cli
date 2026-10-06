# Examples

Real examples for the Claude Code skills of the `hochwasser` plugin, one per skill: a request,
the `hochwasser` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 6 October 2026 with `hochwasser` 0.3.0.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [hochwasser-flood-alerts](#hochwasser-flood-alerts) · [hochwasser-geojson-export](#hochwasser-geojson-export) · [hochwasser-station-situation](#hochwasser-station-situation)

## hochwasser-flood-alerts

> Is there an official flood warning anywhere along the Elbe right now?

```bash
hochwasser --compact alerts --states SN,ST,NI,HH,SH,BB --cap
```

The skill mapped the Elbe to its six states and asked for CAP detail in case there were
warnings. The command exited 0 and the envelope said `"status": "success"` (since 0.3.0 any
other status is an error, never an empty answer), so the empty `data` array is the good-news
answer. The API writes its timestamps with a fixed `+01:00` offset, so `01:18` there is 02:18
German summer time.

```
Elbe states (SN, ST, NI, HH, SH, BB): no active official flood warnings.

  0 alert areas: no Hochwasser, Vorwarnung or Entwarnung entries
  Alert data last changed: 2026-10-06T01:00:47+01:00 (lastModified)

Quelle: Länderübergreifendes Hochwasserportal (LHP), hochwasserzentralen.de
Stand: 2026-10-06T01:18:47+01:00 (02:18 CEST)
For safety decisions, rely on the state flood portals and official emergency channels.
```

Next steps offered: the gauge classification along the Elbe (`hochwasser stations --water elbe`),
or a clearly labelled demo of what alerts look like from the LHP test system.

## hochwasser-geojson-export

> I need the Rhine gauges as GeoJSON for QGIS.

```bash
hochwasser stations --water rhein --geojson -o rhein-pegel.geojson   # Wrote 24 features (13443 bytes)
hochwasser stations --water rhein --geojson -o rhein-pegel.geojson   # second run: exit 2, refuses to overwrite
```

The skill proposed `rhein-pegel.geojson` and did not add `--force` when the file already existed.
The confirmation named no skipped stations, so every hit had usable coordinates and is on the
map. Checking the hits showed that Worms, Mainz and Kaub each appear twice, once for Hessen and
once for Rheinland-Pfalz, with identical coordinates. The top-level `bbox` is computed from the
exported points in `[west, south, east, north]` order (`bbox[1] <= bbox[3]`).

```
Wrote rhein-pegel.geojson: 24 Point features (13,443 bytes), one FeatureCollection, none skipped

  water:     all 24 features are "Rhein" (the substring matched no other water body)
  extent:    bbox [6.2456, 47.5814, 9.1729, 51.8293], Hauenstein (south) to Emmerich (north)
  states:    RP 11 · NW 7 · BW 3 · HE 3, i.e. 21 distinct gauges (Worms, Mainz, Kaub in HE and RP)
  classes:   21 × lhpClass 0, 3 × -1 "Derzeit keine Daten" (Worms on the Hessen side,
             Sankt Goar, Braubach)
  kept:      source, sourceName, licence, licenceName, updated as top-level members

Map credit: Quelle: Länderübergreifendes Hochwasserportal (LHP), hochwasserzentralen.de
            Stand: 2026-10-06T01:18:47+01:00 (02:18 CEST)
```

Next steps offered: colour the points by `lhpClass` (station scale 4..-1), or open the file in
https://geojson.io.

## hochwasser-station-situation

> What's the flood situation along the Danube (Donau)?

```bash
hochwasser --compact situation --states BW,BY
hochwasser --compact stations --water donau
hochwasser --compact stations --states BW | jq '[.data[] | select(.lhpClass == null)] | length'
```

All 26 hits had `water` exactly "Donau", so the substring filter caught nothing else. Two
Baden-Württemberg gauges came back with `lhpClass: null` ("Ohne Hochwasser-Einstufung"). The skill
listed them separately and did not count them as calm. In the state overview they fall into the
`-1` bucket; the third command split BW's 12 there into 9 unclassified gauges and 3 real data gaps
(Rottweil, Breitingen, Unterkirchberg).

```
Donau: no flooding at any reporting gauge (worst class 0)

  Overview BW + BY: 422 gauges, worst class 0
    BY  243 gauges: 243 × class 0
    BW  179 gauges: 167 × class 0, 12 in the -1 bucket (3 without data, 9 not classified)

  Donau gauges (26):
    BY  18 × class 0 "Keine Meldestufe": Neu-Ulm, Donauwörth, Ingolstadt Luitpoldstraße,
        Regensburg Eiserne Brücke, Straubing, Deggendorf, Passau … 11 more
    BW   6 × class 0 "Kein Hochwasser": Möhringen-Espenbrücke, Beuron, Berg … 3 more
         2 × not classified: Donaueschingen (Add.), Sigmaringen
  Gauge reports from 02:00–02:15 today; Passau:
  https://www.hnd.bayern.de/search/go?suche=pegel&id=10091008

Quelle: Länderübergreifendes Hochwasserportal (LHP), hochwasserzentralen.de
Stand: 2026-10-06T01:18:47+01:00 (02:18 CEST). Classification only; water levels are in
pegel-online-cli.
```
