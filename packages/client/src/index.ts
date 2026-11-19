// Public entry point for the API client library.

export { HochwasserzentralenClient, ENDPOINTS, normalizeStates } from "./client.js";
export type { HochwasserzentralenClientOptions } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  ENGINE_OPTION_KEYS,
  cleartextProblem,
  TEST_BASE_URL,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  assertHeaderValue,
  isBidiControl,
  parseRetryAfter,
  sanitizeServerText,
  validateBaseUrl,
} from "./engine.js";
export type { EngineOptions, RawResponse, RequestOptions, RetryEvent } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export {
  assertValid,
  baseUrlProblem,
  headerNameProblem,
  headerValueProblem,
  knownKeysProblem,
  listProblem,
  minClassProblem,
  nonBlankProblem,
  normalizeText,
  normalizeToken,
  responseArgProblem,
  splitList,
  statesProblem,
  textProblem,
  tokenProblem,
} from "./validate.js";
export type { Problem } from "./validate.js";
export type { QueryParams, QueryValue } from "./query.js";
export { alertsToGeoJson, alertsWithoutGeometry, stationsToGeoJson, stationsWithoutCoordinates } from "./geojson.js";
export { aggregateSituation, alertsOnlyStates, filterStations, foldName, onlyStates, stationClass } from "./stations.js";
export type { Situation, StateSituation, StationFilter } from "./stations.js";
export type { GeoJsonFeature, GeoJsonFeatureCollection } from "./geojson.js";
export {
  HochwasserzentralenError,
  HochwasserzentralenApiError,
  HochwasserzentralenNetworkError,
  HochwasserzentralenValidationError,
  HochwasserzentralenParseError,
  MAX_MESSAGE_VALUE_LENGTH,
  credentialsIn,
  cutForMessage,
  isRedirectStatus,
  quoteValue,
  redactCredentials,
  redactUrl,
} from "./errors.js";

export {
  ALERT_CLASS_NAMES,
  attributionOf,
  decodeEntities,
  findGauge,
  getFloodAlerts,
  getFloodMap,
  getFloodSituation,
  germanLocalTime,
  listGauges,
  MAP_LAYERS,
  resolveStates,
  STATE_NAMES,
} from "./operations.js";
export type {
  Attribution,
  FindGaugeInput,
  FloodAlert,
  FloodAlerts,
  FloodAlertsInput,
  FloodMap,
  FloodMapInput,
  FloodSituation,
  FloodSituationInput,
  Gauge,
  GaugeList,
  GaugeLookup,
  GaugeSearch,
  GaugesInput,
  LeftOff,
  MapLayer,
  StateFloodSituation,
} from "./operations.js";

export * from "./types.js";
