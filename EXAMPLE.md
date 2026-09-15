# Examples

Real examples for the Claude Code skills of the `hochwasser` plugin, one per skill: a request,
the `hochwasser` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `hochwasser` 0.0.3.
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
warnings. The `data` array was empty, which is the good-news answer. The API writes its
timestamps with a fixed `+01:00` offset, so `16:47` there is 17:47 German summer time.

```
Elbe states (SN, ST, NI, HH, SH, BB): no active official flood warnings.

  0 alert areas: no Hochwasser, Vorwarnung or Entwarnung entries
  Alert data last changed: 2026-09-15T16:00:47+01:00 (lastModified)

Quelle: Länderübergreifendes Hochwasserportal (LHP), hochwasserzentralen.de
Stand: 2026-09-15T16:47:47+01:00 (17:47 CEST)
For safety decisions, rely on the state flood portals and official emergency channels.
```

Next steps offered: the gauge classification along the Elbe (`hochwasser stations --water elbe`),
or a clearly labelled demo of what alerts look like from the LHP test system.

## hochwasser-geojson-export

> I need the Rhine gauges as GeoJSON for QGIS.

```bash
hochwasser stations --water rhein --geojson -o rhein-pegel.geojson   # Wrote 24 features (13438 bytes)
hochwasser stations --water rhein --geojson -o rhein-pegel.geojson   # second run: exit 2, refuses to overwrite
```

The skill proposed `rhein-pegel.geojson` and did not add `--force` when the file already existed.
Checking the hits showed that Worms, Mainz and Kaub each appear twice, once for Hessen and once for
Rheinland-Pfalz, with identical coordinates. The top-level `bbox` is the API's Germany-wide box,
copied as-is.

```
Wrote rhein-pegel.geojson: 24 Point features (13,438 bytes), one FeatureCollection

  water:     all 24 features are "Rhein" (the substring matched no other water body)
  extent:    Hauenstein and Konstanz in the south to Emmerich in the north (lat 47.58–51.83)
  states:    RP 11 · NW 7 · BW 3 · HE 3, i.e. 21 distinct gauges (Worms, Mainz, Kaub in HE and RP)
  classes:   22 × lhpClass 0, 2 × -1 "Derzeit keine Daten" (Sankt Goar, Braubach)
  kept:      source, sourceName, licence, licenceName, updated as top-level members

Map credit: Quelle: Länderübergreifendes Hochwasserportal (LHP), hochwasserzentralen.de
            Stand: 2026-09-15T16:47:47+01:00
```

Next steps offered: colour the points by `lhpClass` (station scale 4..-1), or open the file in
https://geojson.io.

## hochwasser-station-situation

> What's the flood situation along the Danube (Donau)?

```bash
hochwasser --compact situation --states BW,BY
hochwasser --compact stations --water donau
```

All 26 hits had `water` exactly "Donau", so the substring filter caught nothing else. Two
Baden-Württemberg gauges came back with `lhpClass: null` ("Ohne Hochwasser-Einstufung"). The skill
listed them separately and did not count them as calm. In the state overview they fall into the
`-1` bucket (BW: 2 without data plus 9 unclassified).

```
Donau: no flooding at any reporting gauge (worst class 0)

  Overview BW + BY: 422 gauges, worst class 0
    BY  243 gauges: 243 × class 0
    BW  179 gauges: 168 × class 0, 11 in the -1 bucket (no data or no classification)

  Donau gauges (26):
    BY  18 × class 0 "Keine Meldestufe": Neu-Ulm, Donauwörth, Ingolstadt Luitpoldstraße,
        Regensburg Eiserne Brücke, Straubing, Deggendorf, Passau … 11 more
    BW   6 × class 0 "Kein Hochwasser": Möhringen-Espenbrücke, Beuron, Berg … 3 more
         2 × not classified: Donaueschingen (Add.), Sigmaringen
  Gauge reports from 17:30–17:35 today; Passau:
  https://www.hnd.bayern.de/search/go?suche=pegel&id=10091008

Quelle: Länderübergreifendes Hochwasserportal (LHP), hochwasserzentralen.de
Stand: 2026-09-15T16:47:47+01:00 (17:47 CEST). Classification only; water levels are in
pegel-online-cli.
```
