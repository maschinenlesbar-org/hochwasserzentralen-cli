// Public entry point for the API client library.

export { HochwasserzentralenClient, ENDPOINTS, normalizeStates } from "./client.js";
export type { HochwasserzentralenClientOptions } from "./client.js";
export { RequestEngine, DEFAULT_BASE_URL, TEST_BASE_URL, parseRetryAfter } from "./engine.js";
export type { EngineOptions, RawResponse, RequestOptions } from "./engine.js";
export { nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export { alertsToGeoJson, stationsToGeoJson } from "./geojson.js";
export type { GeoJsonFeature, GeoJsonFeatureCollection } from "./geojson.js";
export {
  HochwasserzentralenError,
  HochwasserzentralenApiError,
  HochwasserzentralenNetworkError,
  HochwasserzentralenValidationError,
  HochwasserzentralenParseError,
} from "./errors.js";

export * from "./types.js";
