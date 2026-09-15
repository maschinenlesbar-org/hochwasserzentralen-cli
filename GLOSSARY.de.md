# Glossar

Fachbegriffe für `hochwasserzentralen-cli` und die LHP-PublicAPI. Bibliotheks- und technische
Begriffe (Transport, RequestEngine, …) stehen in
[DEVELOPING.md](DEVELOPING.md).

## LHP (Länderübergreifendes Hochwasserportal)

Das gemeinsame Hochwasserportal der Bundesländer, online unter
https://www.hochwasserzentralen.de. Jedes Land betreibt eine eigene Hochwasserzentrale;
das LHP bündelt deren Warnungen und Pegeleinstufungen zu einem bundesweiten Gesamtbild und
veröffentlicht es über die **LHP-PublicAPI**, die diese CLI einbindet. Die Daten stehen unter
**CC BY 4.0** – siehe [DATA_LICENSE.md](DATA_LICENSE.md).

## AlertArea vs. Station

Die zwei Arten von Einträgen der API:

- **AlertArea** (`hochwasser alerts`) – ein *regionales Warngebiet*: ein Polygon
  (Flussabschnitt, Region oder ein ganzes Land) mit der aktuellen amtlichen Hochwasserwarnung des
  Landes dafür: Überschrift, Link zum Portal des Landes, Warnklasse, optional ein vollständiger
  **CAP**-Block. Null Warngebiete = keine aktiven Warnungen.
- **Station** (`hochwasser stations`) – ein einzelner *Pegel* mit seiner aktuellen
  Hochwasser-**Einstufung**. Rund 1.600 Pegel bundesweit (1.573 am 15.09.2026; `situation` nennt
  die aktuelle Zahl als `totalStations`). **Keine Wasserstände** – das LHP veröffentlicht nur die
  Klasse. Gemessene Wasserstände liefert
  [pegel-online-cli](https://github.com/maschinenlesbar-org/pegel-online-cli)
  (viele `stationLink`s verweisen sogar auf pegelonline.wsv.de).

## lhpClass – zwei verschiedene Skalen!

Die wichtigste Falle dieser API: **Warnungen und Pegel verwenden unterschiedliche
`lhpClass`-Skalen und unterschiedliche Typen.**

**Pegelskala** (`stations`, numerische `lhpClass`, auch von `--min-class`
und `situation` verwendet):

| lhpClass | Bedeutung |
| --- | --- |
| `4` | Sehr großes Hochwasser |
| `3` | Großes Hochwasser |
| `2` | Mittleres Hochwasser |
| `1` | Kleines Hochwasser |
| `0` | Kein Hochwasser |
| `-1` | Derzeit keine Daten |

**Warnskala** (`alerts`, `lhpClass` ist ein **String**, z. B. `"4"`):

| lhpClass | Bedeutung |
| --- | --- |
| `"6"` | Sehr großes Hochwasser |
| `"5"` | Großes Hochwasser |
| `"4"` | Hochwasser |
| `"2"` | Vorwarnung |
| `"1"` | Entwarnung |

Vergleichen Sie die Klasse einer Warnung nie numerisch mit der Klasse eines Pegels, und denken
Sie daran: `lhpClass: "1"` bei einer Warnung ist eine *gute* Nachricht (Entwarnung), während
`lhpClass: 1` bei einem Pegel ein kleines Hochwasser bedeutet. Jede Antwort enthält eine eigene
`legend`, die den Klassen Namen und Farben zuordnet – nutzen Sie sie, statt Werte fest
einzuprogrammieren.

## lhpClass vs. Meldestufen

Jedes Bundesland legt eigene lokale Warnstufen fest (**Meldestufen** / Alarmstufen – z. B.
Meldestufe 1–4 in Bayern, Alarmstufe I–IV in Brandenburg). Die LHP-Klasse ist die
**vereinheitlichte, bundesweite** Skala, auf die das Portal diese abbildet, damit die Länder
vergleichbar sind. Das Portal des jeweiligen Landes (die Ziele von `alertLink` /
`stationLink` / `stateLinks`) spricht in lokalen Meldestufen, diese API in lhpClass. Behandeln
Sie sie nicht als austauschbare Zahlen.

## CAP (Common Alerting Protocol)

Das internationale OASIS-Standardformat für öffentliche Warnungen (auch von DWD und BBK/NINA
verwendet). Mit `--cap` enthält jede Warnung einen `cap`-Block:
`identifier`, `sender`, `sent`, `status`, `msgType` (`Alert`/`Update`/`Cancel`),
`references` und ein `info`-Objekt mit `severity` (`Minor`/`Moderate`/`Severe`/`Extreme`),
`urgency`, `certainty`, `onset`/`expires`, `headline`, `description`, `instruction`
(Handlungsempfehlung), `web` und `contact`. Das Feld `instruction` ist für Endnutzer der Teil,
nach dem sie handeln können.

## Länderkürzel der Bundesländer

Der Filter `--states` akzeptiert eine kommagetrennte Teilmenge dieser 16 Kürzel
(Groß-/Kleinschreibung egal; validiert – ein Tippfehler endet mit Exit-Code 2, statt
stillschweigend alles zurückzugeben):

| Kürzel | Land | Kürzel | Land |
| --- | --- | --- | --- |
| `BB` | Brandenburg | `NI` | Niedersachsen |
| `BE` | Berlin | `NW` | Nordrhein-Westfalen |
| `BW` | Baden-Württemberg | `RP` | Rheinland-Pfalz |
| `BY` | Bayern | `SH` | Schleswig-Holstein |
| `HB` | Bremen | `SL` | Saarland |
| `HE` | Hessen | `SN` | Sachsen |
| `HH` | Hamburg | `ST` | Sachsen-Anhalt |
| `MV` | Mecklenburg-Vorpommern | `TH` | Thüringen |

Die IDs der Einträge beginnen mit dem Länderkürzel (`BY_577`, `BE_5803500`); die `stateId`
eines Pegels hat die Form nach ISO 3166-2 (`DE-BE`), und `stateLinks` ordnet diese IDs dem
jeweiligen Hochwasserportal des Landes zu.

## Envelope-Felder (Namensnennung & Aktualität)

Jede Antwort verpackt ihr `data` in einen Envelope mit `source` / `sourceName` (das LHP),
`licence` / `licenceName` (CC BY 4.0), `updated` (der **Zeitstempel der Daten** – zeigen Sie
ihn an, die Lizenz verlangt es), `lastModified`, einer `legend` und einer `bbox`
(in der Live-API `[west, north, east, south]`). Diese CLI entfernt diese Felder nie, und ihr
GeoJSON-Export übernimmt sie als Foreign Members.

## Pegel / Wasserstand (was diese API NICHT hat)

Ein *Pegel* ist eine Messstelle für den Wasserstand. Das LHP nennt Ihnen die Hochwasser-**Klasse**
jedes Pegels, nicht seinen Wasserstand in Zentimetern. Wasserstände, Abflüsse und Messverläufe
für die Bundeswasserstraßen kommen von PEGELONLINE (WSV) – Schwester-CLI:
`pegel-online-cli` (`pegel current BONN` usw.).

## Testsystem

`https://api.hochwasserzentralen.de/public/v1/test` – dieselbe API mit festen, vorgefertigten
Daten, die immer aktive Warnungen enthalten. Erreichbar mit
`--base-url …/public/v1/test`. Behandeln Sie die Ausgabe nie als tatsächliche Lage.
