# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `hochwasser`, eines pro Skill: eine
Anfrage, die `hochwasser`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `hochwasser` 0.0.3 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [hochwasser-flood-alerts](#hochwasser-flood-alerts) · [hochwasser-geojson-export](#hochwasser-geojson-export) · [hochwasser-station-situation](#hochwasser-station-situation)

## hochwasser-flood-alerts

> Gibt es gerade irgendwo an der Elbe eine amtliche Hochwasserwarnung?

```bash
hochwasser --compact alerts --states SN,ST,NI,HH,SH,BB --cap
```

Der Skill hat die Elbe ihren sechs Ländern zugeordnet und für den Fall von Warnungen die
CAP-Details mit angefordert. Das `data`-Array war leer – die gute Nachricht. Die API schreibt ihre
Zeitstempel mit festem Offset `+01:00`, `16:47` entspricht also 17:47 Uhr Sommerzeit.

```
Elbe-Länder (SN, ST, NI, HH, SH, BB): keine aktiven amtlichen Hochwasserwarnungen.

  0 Warngebiete: keine Einträge zu Hochwasser, Vorwarnung oder Entwarnung
  Warndaten zuletzt geändert: 2026-09-15T16:00:47+01:00 (lastModified)

Quelle: Länderübergreifendes Hochwasserportal (LHP), hochwasserzentralen.de
Stand: 2026-09-15T16:47:47+01:00 (17:47 MESZ)
Für Sicherheitsentscheidungen gelten die Hochwasserportale der Länder und die amtlichen Warnkanäle.
```

Als Nächstes angeboten: die Einstufung der Pegel an der Elbe (`hochwasser stations --water elbe`)
oder eine klar gekennzeichnete Demo mit Warnungen aus dem LHP-Testsystem.

## hochwasser-geojson-export

> Die Rhein-Pegel als GeoJSON für QGIS, bitte.

```bash
hochwasser stations --water rhein --geojson -o rhein-pegel.geojson   # Wrote 24 features (13438 bytes)
hochwasser stations --water rhein --geojson -o rhein-pegel.geojson   # zweiter Lauf: Exit 2, überschreibt nicht
```

Der Skill hat `rhein-pegel.geojson` vorgeschlagen und `--force` nicht ergänzt, als die Datei schon
existierte. Bei der Prüfung der Treffer fiel auf: Worms, Mainz und Kaub stehen je zweimal in der
Liste, einmal für Hessen und einmal für Rheinland-Pfalz, mit identischen Koordinaten. Die
`bbox` auf oberster Ebene ist die deutschlandweite Box der API, unverändert übernommen.

```
rhein-pegel.geojson geschrieben: 24 Punkt-Features (13.438 Bytes), eine FeatureCollection

  Gewässer:  alle 24 Features sind "Rhein" (die Teilzeichenkette traf kein anderes Gewässer)
  Ausdehnung: Hauenstein und Konstanz im Süden bis Emmerich im Norden (Breite 47,58–51,83)
  Länder:    RP 11 · NW 7 · BW 3 · HE 3, also 21 verschiedene Pegel (Worms, Mainz, Kaub in HE und RP)
  Klassen:   22 × lhpClass 0, 2 × -1 "Derzeit keine Daten" (Sankt Goar, Braubach)
  Erhalten:  source, sourceName, licence, licenceName, updated als Felder auf oberster Ebene

Kartenvermerk: Quelle: Länderübergreifendes Hochwasserportal (LHP), hochwasserzentralen.de
               Stand: 2026-09-15T16:47:47+01:00
```

Als Nächstes angeboten: die Punkte nach `lhpClass` einfärben (Pegelskala 4..-1) oder die Datei in
https://geojson.io öffnen.

## hochwasser-station-situation

> Wie ist die Hochwasserlage an der Donau?

```bash
hochwasser --compact situation --states BW,BY
hochwasser --compact stations --water donau
```

Alle 26 Treffer hatten als `water` genau "Donau", der Teilzeichenketten-Filter hat also nichts
anderes erfasst. Zwei Pegel in Baden-Württemberg kamen mit `lhpClass: null` zurück („Ohne
Hochwasser-Einstufung"). Der Skill hat sie getrennt aufgeführt und nicht als ruhig gezählt. In der
Länderübersicht landen sie im Topf `-1` (BW: 2 ohne Daten und 9 ohne Einstufung).

```
Donau: an keinem meldenden Pegel Hochwasser (höchste Klasse 0)

  Übersicht BW + BY: 422 Pegel, höchste Klasse 0
    BY  243 Pegel: 243 × Klasse 0
    BW  179 Pegel: 168 × Klasse 0, 11 im Topf -1 (keine Daten oder keine Einstufung)

  Donau-Pegel (26):
    BY  18 × Klasse 0 "Keine Meldestufe": Neu-Ulm, Donauwörth, Ingolstadt Luitpoldstraße,
        Regensburg Eiserne Brücke, Straubing, Deggendorf, Passau … 11 weitere
    BW   6 × Klasse 0 "Kein Hochwasser": Möhringen-Espenbrücke, Beuron, Berg … 3 weitere
         2 × ohne Einstufung: Donaueschingen (Add.), Sigmaringen
  Pegelmeldungen von heute 17:30–17:35; Passau:
  https://www.hnd.bayern.de/search/go?suche=pegel&id=10091008

Quelle: Länderübergreifendes Hochwasserportal (LHP), hochwasserzentralen.de
Stand: 2026-09-15T16:47:47+01:00 (17:47 MESZ). Nur die Einstufung; Wasserstände liefert
pegel-online-cli.
```
