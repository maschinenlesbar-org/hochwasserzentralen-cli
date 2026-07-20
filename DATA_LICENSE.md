# Data license

> **This tool does not include, host, or redistribute any data.**
> `hochwasserzentralen-cli` is a *client*. It only accesses data served live by
> the **Länderübergreifendes Hochwasserportal (LHP)** via its public API. That
> data is the LHP's / the states' and is governed by **their** terms, summarized
> below. The license of this CLI's own source code is a separate matter — see
> [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data provider** | Länderübergreifendes Hochwasserportal (LHP) — the joint flood portal of the German states |
| **API / source** | `https://api.hochwasserzentralen.de/public/v1` (LHP-PublicAPI v1) · portal: https://www.hochwasserzentralen.de |
| **Data license** | **CC BY 4.0** (Namensnennung) — https://creativecommons.org/licenses/by/4.0/deed.de |
| **Attribution** | **Required** — see exactly how below. |
| **Commercial use & redistribution** | Permitted under CC BY 4.0, with attribution and timestamp. |
| **Warranty** | None — unverified raw data (ungeprüfte Rohdaten). |

## Required attribution

When you pass the data on (display it, publish it, embed it in a product), the
LHP requires:

1. **Name the source:**
   > Quelle: Länderübergreifendes Hochwasserportal (LHP)

   with a link to https://www.hochwasserzentralen.de.

2. **Show the data timestamp** — "Stand: TT.MM.JJJJ hh:mm", taken from the
   `updated` field every API response carries.

This CLI is built to make that easy: the `updated`, `source`/`sourceName` and
`licence`/`licenceName` fields are **never stripped** from any output — they
survive `--water`/`--min-class` filtering, appear in the `situation` aggregate,
and ride along as foreign members in every `--geojson` export. Keep them when
you process the output.

## Freshness

The data is updated continuously. If you **republish it online**, refresh from
the API **at least every 10 minutes** so stale warnings are never presented as
current. (The API supports `ETag`/`If-None-Match`, so frequent polling is cheap
for the server; see DEVELOPING.md.)

## Notes & caveats

- **Unverified raw data, no warranty** — the classifications and warnings are
  live operational data from the states' flood services; accuracy, completeness
  and availability are not guaranteed. For decisions with safety impact, follow
  the responsible state authority's own portal (the `alertLink`/`stationLink`
  targets) and official emergency channels.
- The API is versioned (`v1`, currently "1.0 beta"); shapes may still evolve.
- The per-state links (`stateLinks`) lead to the states' own portals, whose
  content is governed by each state's own terms — CC BY 4.0 applies to the LHP
  API data, not to whatever a linked portal serves.
- The legacy `www.hochwasserzentralen.de/webservices/*.php` endpoints are defunct
  and are not used by this tool.

## Sources

- https://www.hochwasserzentralen.de — the portal (footer/Impressum, API notes)
- `licence` / `licenceName` fields of every API response ("CC BY 4.0 - Namensnennung")
- https://creativecommons.org/licenses/by/4.0/deed.de — the license text

---

*Good-faith summary compiled 2026-07-13; not legal advice. The provider's terms
are authoritative and can change — verify at the source before relying on the
data, especially for any commercial or redistribution use.*
