// Response and parameter types for the LHP-PublicAPI v1
// (https://api.hochwasserzentralen.de/public/v1).
//
// The shapes below reflect what the API returns for `Accept: application/json`
// (the representation this client always requests, verified live 2026-07-13):
//   - /data/alerts  -> envelope + `data: AlertArea[]` — each alert area keeps its
//     GeoJSON-Feature form (`type: "Feature"` + `geometry`) even in plain JSON.
//   - /data/stations -> envelope + `data: Station[]` — stations are FLAT in plain
//     JSON: `coordinates` and the properties sit directly on the item (no
//     `geometry`/`properties`/`style` wrapper; that wrapper only appears in the
//     `application/geo+json` representation).

/** The 16 German state (Bundesland) codes accepted by the `states` filter. */
export const STATE_CODES = [
  "BB",
  "BE",
  "BW",
  "BY",
  "HB",
  "HE",
  "HH",
  "MV",
  "NI",
  "NW",
  "RP",
  "SH",
  "SL",
  "SN",
  "ST",
  "TH",
] as const;

export type StateCode = (typeof STATE_CODES)[number];

/** Response languages supported by the API (`Accept-Language`). */
export const LANGS = ["de", "en"] as const;
export type Lang = (typeof LANGS)[number];

/**
 * Fallback names for the station lhpClass scale (used when a response carries no
 * legend). Alerts use a DIFFERENT scale — see GLOSSARY.md.
 */
export const STATION_CLASS_NAMES: Readonly<Record<string, string>> = {
  "4": "Sehr großes Hochwasser",
  "3": "Großes Hochwasser",
  "2": "Mittleres Hochwasser",
  "1": "Kleines Hochwasser",
  "0": "Kein Hochwasser",
  "-1": "Derzeit keine Daten",
};

/** One legend entry: a class value with its display name and colour/style. */
export interface LegendItem {
  /** Numeric for stations (4..-1); the alerts legend also uses numbers (6..1). */
  lhpClass: number;
  lhpClassName: string;
  color?: string;
  cssStyle?: Record<string, string>;
}

export interface Legend {
  title: string;
  items: LegendItem[];
}

/**
 * Common envelope fields shared by both endpoints. Every response carries the
 * source / licence attribution and the data timestamp (`updated`) — the CLI
 * passes these through because CC BY 4.0 requires displaying them (see
 * DATA_LICENSE.md).
 */
export interface ResponseEnvelope {
  apiVersion: string;
  status: string;
  lang: string;
  source: string;
  sourceName: string;
  sourceLogo?: string;
  licence: string;
  licenceName: string;
  title: string;
  description: string;
  /** Data timestamp — display this when presenting the data (CC BY 4.0). */
  updated: string;
  lastModified?: string;
  eTag?: string;
  legend?: Legend;
  /** [west, north, east, south] per the live API. */
  bbox?: number[];
}

/** GeoJSON-ish geometry as delivered by the API (Polygon for alert areas). */
export interface AlertGeometry {
  type: string;
  coordinates: unknown;
}

/** The `<cap>.info` block of a CAP (Common Alerting Protocol) alert. */
export interface CapInfo {
  language?: string;
  category?: string;
  event?: string;
  responseType?: string;
  urgency?: string;
  severity?: string;
  certainty?: string;
  effective?: string;
  onset?: string;
  expires?: string | null;
  sendername?: string;
  headline?: string;
  description?: string;
  instruction?: string;
  web?: string;
  contact?: string;
  area?: unknown[];
}

/** The CAP detail block attached per alert when `cap=true` is requested. */
export interface CapBlock {
  identifier?: string;
  sender?: string;
  sent?: string;
  status?: string;
  msgType?: string;
  scope?: string;
  references?: string;
  info?: CapInfo;
}

/**
 * One regional flood alert area. NOTE: `lhpClass` is a STRING here (e.g. "4")
 * and uses the alerts scale (6 Sehr großes Hochwasser … 2 Vorwarnung,
 * 1 Entwarnung) — not the numeric station scale.
 */
export interface AlertArea {
  kind: "AlertArea";
  /** e.g. "BY_577" — state code prefix + area id. */
  id: string;
  type: "Feature";
  geometry?: AlertGeometry;
  areaDesc?: string;
  areaType?: string;
  alertHeadline?: string;
  alertLink?: string;
  lhpClass: string;
  lhpClassName?: string;
  cap?: CapBlock;
}

/** /data/alerts response (plain-JSON representation). */
export interface AlertsResponse extends ResponseEnvelope {
  data: AlertArea[];
}

/**
 * One gauge (Pegel) with its flood classification. The LHP publishes the
 * CLASSIFICATION only — no water levels; use pegel-online-cli for measured
 * levels. `lhpClass` is a NUMBER on the station scale 4..-1.
 */
export interface Station {
  kind: "Station";
  /** e.g. "BE_5803500" — state code prefix + gauge number. */
  id: string;
  /** [longitude, latitude] (WGS84). */
  coordinates?: number[];
  name?: string;
  water?: string;
  /** Local German time, e.g. "2026-07-13 11:15:00". */
  timestamp?: string;
  lhpClass: number;
  stateClassName?: string;
  stationLink?: string;
  /** ISO 3166-2 id of the reporting state, e.g. "DE-BE". */
  stateId?: string;
}

/** /data/stations response (plain-JSON representation). */
export interface StationsResponse extends ResponseEnvelope {
  data: Station[];
  /** Per-state links to the state's own flood portal, keyed by "DE-XX". */
  stateLinks?: Record<string, string>;
}

/** Parameters for `client.alerts()`. */
export interface AlertsParams {
  /** Subset of state codes; case-insensitive input is normalised to upper. */
  states?: readonly string[];
  /** Include the CAP (Common Alerting Protocol) detail block per alert. */
  cap?: boolean;
  /** Response language (Accept-Language). Default: de. */
  lang?: Lang;
}

/** Parameters for `client.stations()`. */
export interface StationsParams {
  states?: readonly string[];
  lang?: Lang;
}
