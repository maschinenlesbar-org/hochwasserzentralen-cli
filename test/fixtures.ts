// Canned LHP-PublicAPI responses, modelled on the live plain-JSON
// (`Accept: application/json`) representation verified 2026-07-13:
//   - alerts keep their GeoJSON-Feature form even in plain JSON;
//   - stations are FLAT (coordinates + properties directly on the item).

import type { AlertsResponse, StationsResponse } from "../src/client/types.js";

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
