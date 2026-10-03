// Public entry point for the API client library.

export { HochwasserzentralenClient, ENDPOINTS, normalizeStates } from "./client.js";
export type { HochwasserzentralenClientOptions } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  TEST_BASE_URL,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  assertHeaderValue,
  isBidiControl,
  parseRetryAfter,
  sanitizeServerText,
  validateBaseUrl,
} from "./engine.js";
export type { EngineOptions, RawResponse, RequestOptions } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export {
  assertValid,
  baseUrlProblem,
  headerNameProblem,
  headerValueProblem,
  minClassProblem,
  nonBlankProblem,
} from "./validate.js";
export type { Problem } from "./validate.js";
export type { QueryParams, QueryValue } from "./query.js";
export { alertsToGeoJson, stationsToGeoJson } from "./geojson.js";
export { aggregateSituation, filterStations, foldName, stationClass } from "./stations.js";
export type { Situation, StateSituation, StationFilter } from "./stations.js";
export type { GeoJsonFeature, GeoJsonFeatureCollection } from "./geojson.js";
export {
  HochwasserzentralenError,
  HochwasserzentralenApiError,
  HochwasserzentralenNetworkError,
  HochwasserzentralenValidationError,
  HochwasserzentralenParseError,
} from "./errors.js";

export * from "./types.js";
