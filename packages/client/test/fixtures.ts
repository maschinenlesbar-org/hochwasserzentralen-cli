// Canned LHP-PublicAPI responses, modelled on the live plain-JSON
// (`Accept: application/json`) representation verified 2026-07-13:
//   - alerts keep their GeoJSON-Feature form even in plain JSON;
//   - stations are FLAT (coordinates + properties directly on the item).

import type { AlertArea, AlertsResponse, Station, StationsResponse } from "../src/types.js";
import type { HttpRequest, HttpResponse } from "../src/http.js";
import { jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";

const envelope = {
  apiVersion: "1.0 beta, 2025-02-04",
  status: "success",
  lang: "de",
  source: "https://www.hochwasserzentralen.de",
  sourceName: "Länderübergreifendes Hochwasserportal (LHP)",
  sourceLogo: "https://api.hochwasserzentralen.de/public/v1/images/logo",
  licence: "https://creativecommons.org/licenses/by/4.0/deed.de",
  licenceName: "CC BY 4.0 - Namensnennung",
  updated: "2026-07-13T10:43:47+01:00",
  lastModified: "2026-07-13T10:00:49+01:00",
  bbox: [5.839, 55.0933, 15.0916, 47.2318] as number[],
} as const;

export const alertsJson: AlertsResponse = {
  ...envelope,
  title: "Aktuelle Hochwasser-Warnungen",
  description: "Aktuelle regionale Hochwasser-Warnungen der deutschen Bundesländer",
  legend: {
    title: "Hochwasser-Warnungen",
    items: [
      { lhpClass: 6, lhpClassName: "Sehr großes Hochwasser", color: "#765e9c" },
      { lhpClass: 5, lhpClassName: "Großes Hochwasser", color: "#e53935" },
      { lhpClass: 4, lhpClassName: "Hochwasser", color: "#fb8c00" },
      { lhpClass: 2, lhpClassName: "Vorwarnung" },
      { lhpClass: 1, lhpClassName: "Entwarnung", color: "#60bf41" },
    ],
  },
  data: [
    {
      kind: "AlertArea",
      id: "BY_577",
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [12.1, 48.9],
            [12.2, 48.9],
            [12.2, 49.0],
            [12.1, 48.9],
          ],
        ],
      },
      areaDesc: "Donau von Regensburg bis Straubing",
      areaType: "Region",
      alertHeadline: "Es liegt eine amtliche Hochwasserwarnung vor",
      alertLink: "https://www.hnd.bayern.de/",
      lhpClass: "4",
      lhpClassName: "Hochwasser",
      cap: {
        identifier: "LHP.BY.20260713_577",
        sender: "hnd@bayern.de",
        sent: "2026-07-13 08:00:00",
        status: "Actual",
        msgType: "Alert",
        scope: "Public",
        info: {
          language: "de-DE",
          category: "Met",
          event: "Flood",
          urgency: "Immediate",
          severity: "Moderate",
          certainty: "Observed",
          effective: "2026-07-13 08:00:00",
          onset: "2026-07-13 06:00:00",
          expires: null,
          sendername: "Hochwassernachrichtendienst Bayern",
          headline: "Es liegt eine amtliche Hochwasserwarnung vor",
          description: "Die Wasserstände steigen weiter.",
          instruction: "Meiden Sie Ufernähe.",
          web: "https://www.hnd.bayern.de/",
          contact: "HND Bayern",
        },
      },
    },
    {
      kind: "AlertArea",
      id: "SN_12",
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [13.5, 51.0],
            [13.6, 51.0],
            [13.6, 51.1],
            [13.5, 51.0],
          ],
        ],
      },
      areaDesc: "Elbe von Schöna bis Dresden",
      areaType: "Region",
      alertHeadline: "Vorwarnung",
      alertLink: "https://www.umwelt.sachsen.de/umwelt/infosysteme/hwims/portal/web/wasserstand-uebersicht",
      lhpClass: "2",
      lhpClassName: "Vorwarnung",
    },
  ],
};

export const stationsJson: StationsResponse = {
  ...envelope,
  title: "Aktuelle Hochwassersituation",
  description: "Aktuelle Hochwassersituation an den Pegeln in Deutschland",
  legend: {
    title: "Situation am Pegel",
    items: [
      { lhpClass: 4, lhpClassName: "Sehr großes Hochwasser", color: "#941094" },
      { lhpClass: 3, lhpClassName: "Großes Hochwasser", color: "#de0000" },
      { lhpClass: 2, lhpClassName: "Mittleres Hochwasser", color: "#ffa500" },
      { lhpClass: 1, lhpClassName: "Kleines Hochwasser", color: "#ffff00" },
      { lhpClass: 0, lhpClassName: "Kein Hochwasser", color: "#7CBD5C" },
      { lhpClass: -1, lhpClassName: "Derzeit keine Daten", color: "#7b7b7b" },
    ],
  },
  stateLinks: {
    "DE-BE": "https://wasserportal.berlin.de",
    "DE-BY": "https://www.hnd.bayern.de",
  },
  data: [
    {
      kind: "Station",
      id: "BE_5803500",
      coordinates: [13.1239, 52.4303],
      name: "Pfaueninsel",
      water: "Havel",
      timestamp: "2026-07-13 11:15:00",
      lhpClass: 0,
      stateClassName: "Kein Hochwasser",
      stationLink: "https://wasserportal.berlin.de/station.php?station=5803500",
      stateId: "DE-BE",
    },
    {
      kind: "Station",
      id: "BE_586290",
      coordinates: [13.574, 52.4297],
      name: "Berlin-Köpenick",
      water: "Spree-Oder-Wasserstrasse",
      timestamp: "2026-07-13 11:30:00",
      lhpClass: 2,
      stateClassName: "Mittleres Hochwasser",
      stateId: "DE-BE",
    },
    {
      kind: "Station",
      id: "BY_10088003",
      coordinates: [12.1211, 49.0342],
      name: "Regensburg Eiserne Brücke",
      water: "Donau",
      timestamp: "2026-07-13 11:00:00",
      lhpClass: 3,
      stateClassName: "Großes Hochwasser",
      stateId: "DE-BY",
    },
    {
      kind: "Station",
      id: "BY_16005701",
      coordinates: [11.5581, 48.1421],
      name: "München",
      water: "Isar",
      timestamp: "2026-07-13 10:45:00",
      lhpClass: -1,
      stateClassName: "Derzeit keine Daten",
      stateId: "DE-BY",
    },
  ],
};

// ---- a mock LHP API for the use cases (operations.ts) and the MCP server's tests ----------------


/** A square around a point, as the API sends an alert area's polygon. */
function square(lon: number, lat: number): AlertArea["geometry"] {
  return { type: "Polygon", coordinates: [[[lon, lat], [lon + 0.1, lat], [lon + 0.1, lat + 0.1], [lon, lat + 0.1], [lon, lat]]] };
}

/** An alert area as the live API sent them on 2026-11-19 (plain JSON, no CAP). */
export function alertArea(id: string, lhpClass: string, areaDesc: string, extra: Partial<AlertArea> = {}): AlertArea {
  const names: Record<string, string> = { "6": "Sehr großes Hochwasser", "5": "Großes Hochwasser", "4": "Hochwasser", "2": "Vorwarnung", "1": "Entwarnung" };
  return {
    kind: "AlertArea",
    id,
    type: "Feature",
    geometry: square(11 + id.length / 10, 50),
    areaDesc,
    areaType: "Region",
    alertHeadline: lhpClass === "1" ? "Entwarnung" : "Hochwasserwarnung vor Überschwemmungsgefahr für bebaute Gebiete",
    alertLink: "https://www.hnd.bayern.de",
    lhpClass,
    lhpClassName: names[lhpClass] ?? `Klasse ${lhpClass}`,
    ...extra,
  };
}

/** A gauge as the live API sent them on 2026-11-19. */
export function gauge(id: string, name: string, water: string, lhpClass: number | null, coordinates: number[], extra: Partial<Station> = {}): Station {
  const state = id.split("_")[0] ?? "BY";
  return {
    kind: "Station",
    id,
    coordinates,
    name,
    water,
    timestamp: "2026-11-19 16:00:00",
    lhpClass: lhpClass as number,
    stateClassName: lhpClass === null ? "Ohne Hochwasser-Einstufung" : lhpClass >= 1 ? `Meldestufe ${lhpClass}` : lhpClass === 0 ? "Kein Hochwasser" : "Derzeit keine Daten",
    stationLink: `https://example.org/pegel/${id}`,
    stateId: `DE-${state}`,
    ...extra,
  };
}

/** Alerts like the live ones of 2026-11-19: Bavarian 5s and 4s, pre-warnings, one all-clear, a river reach. */
export function liveAlerts(): AlertsResponse {
  return {
    ...alertsJson,
    updated: "2026-11-19T16:11:47+01:00",
    data: [
      alertArea("BY_472", "2", "Stadt und Lkr. Bayreuth"),
      alertArea("BY_471", "4", "Stadt und Lkr. Bamberg"),
      alertArea("BY_473", "5", "Stadt und Lkr. Coburg"),
      alertArea("BY_476", "5", "Lkr. Kronach"),
      alertArea("RP_17", "4", "Prüm- und Our-Einzugsgebiet"),
      alertArea("RP_18", "1", "Rhein: Worms bis Nahemündung", { geometry: { type: "LineString", coordinates: [[8.36, 49.63], [7.9, 49.97]] } }),
      alertArea("ST_568", "2", "Flussgebiet Bode mit Nebenflüssen Holtemme, Selke, Großer Graben"),
    ],
  };
}

/** Gauges like the live ones: a flooding one, border gauges (HE/RP Kaub, BY/HE Obernau), no data, unclassified, an RP label with an entity. */
export function liveStations(): StationsResponse {
  return {
    ...stationsJson,
    updated: "2026-09-15T16:47:47+01:00",
    data: [
      gauge("BY_24149208", "Fürth am Berg", "Steinach", 1, [11.1594, 50.2773]),
      gauge("BY_10088003", "Regensburg Eiserne Brücke", "Donau", 0, [12.1211, 49.0342]),
      gauge("BY_24070006", "Obernau", "Main", 0, [9.1281, 49.9425]),
      gauge("HE_24700302", "Obernau", "Main", 0, [9.1281, 49.9425]),
      gauge("HE_25100100", "Kaub", "Rhein", 2, [7.7648, 50.0855]),
      gauge("RP_25100100", "Kaub", "Rhein", 2, [7.7648, 50.0855], { stateClassName: "Kein Hochwasser bzw. &#60; 2-jährliches Hochwasser" }),
      gauge("RP_23720305", "Bobenthal", "Wieslauter", 0, [7.8784, 49.049], { stateClassName: "Kein Hochwasser bzw. &#60; 2-jährliches Hochwasser" }),
      gauge("NW_2710080", "Köln", "Rhein", 0, [6.9633, 50.9369]),
      gauge("BE_586290", "Berlin-Köpenick", "Spree-Oder-Wasserstrasse", 0, [13.574, 52.4297]),
      gauge("BB_6030800", "Frankfurt (Oder)", "Oder", -1, [14.5532, 52.3372]),
      gauge("MV_9650030", "Zarrentin", "Schaalsee", null, [10.9157, 53.5503]),
      gauge("MV_9670010", "Dömitz", "Elde", null, [11.2483, 53.1386]),
      gauge("SN_501060", "Dresden", "Elbe", 0, [13.7383, 51.0547]),
      gauge("ST_502180", "Dessau-Roßlau", "Mulde", 0, [12.2441, 51.8418]),
    ],
  };
}

/**
 * A mock of the LHP API: `/data/alerts` and `/data/stations` answer `alerts` and `stations`,
 * filtered by `states` as the live API does; any other path is a JSend 404.
 */
export function lhpApi(sets: { alerts?: AlertsResponse; stations?: StationsResponse } = {}): MockTransport {
  const alerts = sets.alerts ?? liveAlerts();
  const stations = sets.stations ?? liveStations();
  return makeMockTransport((request: HttpRequest): HttpResponse => {
    const url = new URL(request.url);
    const states = url.searchParams.get("states")?.split(",");
    const inStates = (id: string) => states === undefined || states.includes(id.split("_")[0] ?? "");
    if (url.pathname.endsWith("/data/alerts")) return jsonResponse({ ...alerts, data: alerts.data.filter((a) => inStates(a.id)) });
    if (url.pathname.endsWith("/data/stations")) return jsonResponse({ ...stations, data: stations.data.filter((s) => inStates(s.id)) });
    return jsonResponse({ status: "fail", data: { message: "Not found" } }, 404);
  });
}
