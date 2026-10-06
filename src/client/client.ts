// HochwasserzentralenClient — a typed client over the official LHP-PublicAPI v1
// of the Länderübergreifendes Hochwasserportal (https://www.hochwasserzentralen.de).
// No auth, two GET endpoints:
//
//   const c = new HochwasserzentralenClient();
//   await c.alerts();                                  // current regional flood alerts
//   await c.alerts({ states: ["BY", "SN"], cap: true }); // with CAP detail blocks
//   await c.stations({ states: ["BE"], lang: "en" });  // flood class at the gauges
//   await c.situation({ states: ["BY", "HH"] });       // per-state overview of the gauges
//
// The client always requests `Accept: application/json` (the flat representation;
// see types.ts). The API also serves application/geo+json and text/xml — library
// users can fetch those via `engine.request` with a custom accept.

import { RequestEngine, envelopeMessage, sanitizeServerText, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import {
  HochwasserzentralenApiError,
  HochwasserzentralenParseError,
  HochwasserzentralenValidationError,
  cutForMessage,
} from "./errors.js";
import {
  LANGS,
  STATE_CODES,
  type AlertsParams,
  type AlertsResponse,
  type SituationParams,
  type StationsParams,
  type StationsResponse,
} from "./types.js";
import { assertValid, statesProblem } from "./validate.js";
import { aggregateSituation, assertStationFilter, filterStations, type Situation } from "./stations.js";

/** The endpoint paths (relative to the base URL). Both are GET. */
export const ENDPOINTS = {
  alerts: "/data/alerts",
  stations: "/data/stations",
} as const;

/**
 * Check the documented success envelope of a response before anyone reads it, and
 * return why it is unusable: `undefined` when it is fine, else a rejection raised by
 * the caller. Every LHP answer carries `"status": "success"` and a `data` array; the
 * API's own failures come as HTTP 4xx with `"status": "fail"` (JSend). Without this
 * check a `200` envelope saying `"status": "error"` with `data: []` read as the
 * documented "no active flood alerts" answer (exit 0), and `--geojson` turned it into
 * an empty map — a missed warning during an upstream fault.
 *
 * - a body that is not a JSON object, or has no `data` array: a
 *   HochwasserzentralenParseError naming the endpoint and the field (`data` is typed as
 *   an array, but only at compile time; a malformed body would otherwise surface as a
 *   raw "X is not iterable" TypeError deep inside the aggregation);
 * - a `status` other than `"success"`: a HochwasserzentralenApiError with the
 *   envelope's own message (`apiStatus` on the error), whatever `data` holds;
 * - a missing or non-string `status`: a HochwasserzentralenParseError.
 *
 * One known cause of a missing `data` is upstream and transient: the API's HTTP cache
 * varies only on Accept-Encoding, so for about a minute after anyone requests
 * `application/geo+json` it may serve that representation (a FeatureCollection with
 * `features`, no `data`) to our `Accept: application/json` request. The error names
 * that case so it is not mistaken for a CLI bug.
 */
function envelopeProblem(
  res: unknown,
  endpoint: string,
  requireId: boolean,
  rejected: (apiStatus: string, message: string | undefined) => Error,
): Error | undefined {
  if (!isObject(res)) {
    return new HochwasserzentralenParseError(
      `Unexpected response shape from ${endpoint}: expected a JSON object, got ${describeType(res)}.`,
    );
  }
  const status = res["status"];
  if (typeof status === "string" && status !== "success") return rejected(status, envelopeMessage(res));
  const data = res["data"];
  if (!Array.isArray(data)) {
    if (res["type"] === "FeatureCollection" && Array.isArray(res["features"])) {
      return new HochwasserzentralenParseError(
        `The API answered ${endpoint} with its GeoJSON representation ("features") instead of plain JSON ` +
          `("data"). This is a transient mix-up in the API's cache that usually clears within a minute or ` +
          `two; retry then.`,
      );
    }
    return new HochwasserzentralenParseError(
      `Expected "data" to be an array in the response from ${endpoint}, got ${describeType(data)}`,
    );
  }
  if (status !== "success") {
    return new HochwasserzentralenParseError(
      `Unexpected response shape from ${endpoint}: expected "status": "success", got ${describeType(status)}.`,
    );
  }
  assertItems(data, endpoint, requireId);
  return undefined;
}

/** `null`, `an array` or the `typeof` of a value, for shape messages. */
function describeType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;
}


function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every `data` item must be a JSON object (and a station must carry its string
 * `id`, from which the CLI derives the state): a `null` or scalar item would
 * otherwise reach the filters, the GeoJSON converter and the `situation`
 * aggregation untyped and crash there with a raw TypeError.
 */
function assertItems(data: readonly unknown[], endpoint: string, requireId: boolean): void {
  data.forEach((item, index) => {
    if (!isObject(item)) {
      throw new HochwasserzentralenParseError(
        `Unexpected response shape from ${endpoint}: expected every data item to be a JSON object, ` +
          `item ${index} is ${item === null ? "null" : Array.isArray(item) ? "an array" : typeof item}.`,
      );
    }
    if (requireId && typeof item["id"] !== "string") {
      throw new HochwasserzentralenParseError(
        `Unexpected response shape from ${endpoint}: expected every station to have a string id, ` +
          `item ${index} has none.`,
      );
    }
  });
}

/**
 * Normalise and validate a list of state codes: trims, upper-cases, de-duplicates
 * (preserving order) and rejects anything not among the 16 known codes (see
 * {@link statesProblem}) with a HochwasserzentralenValidationError ("Invalid
 * states: <reason>") — so a typo never becomes a silently-dropped filter that
 * returns the full nationwide set. Idempotent; the CLI's --states uses it too.
 */
export function normalizeStates(states: readonly string[]): string[] {
  assertValid("states", states, statesProblem);
  const out: string[] = [];
  for (const raw of states) {
    const code = raw.trim().toUpperCase();
    if (code !== "" && !out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * Check the library parameters before any request: `states` must be an array of
 * strings (a plain "BY" string would otherwise be split into characters) and
 * `lang` one of LANGS (an unsupported value was silently ignored upstream, and a
 * CR/LF in it failed as an untyped header TypeError).
 */
function checkParams(params: { states?: unknown; lang?: unknown }): void {
  const { states, lang } = params;
  if (states !== undefined && (!Array.isArray(states) || !states.every((s) => typeof s === "string"))) {
    throw new HochwasserzentralenValidationError(
      `Invalid states: expected an array of state codes, got ${JSON.stringify(states) ?? String(states)}.`,
    );
  }
  if (lang !== undefined && !(LANGS as readonly unknown[]).includes(lang)) {
    throw new HochwasserzentralenValidationError(
      `Invalid lang: expected one of ${LANGS.join(", ")}, got ${JSON.stringify(lang) ?? String(lang)}.`,
    );
  }
}

/** Options for the client (engine options only — the API needs no auth). */
export type HochwasserzentralenClientOptions = EngineOptions;

export class HochwasserzentralenClient {
  private readonly engine: RequestEngine;

  constructor(options: HochwasserzentralenClientOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /** Throw the envelope's problem (see {@link envelopeProblem}), if it has one. */
  private checkEnvelope(res: unknown, endpoint: string, query: QueryParams, requireId: boolean): void {
    const problem = envelopeProblem(res, endpoint, requireId, (apiStatus, message) => {
      const detail = message === undefined ? undefined : cutForMessage(sanitizeServerText(this.engine.scrub(message)));
      return new HochwasserzentralenApiError({
        status: 200,
        apiStatus: sanitizeServerText(this.engine.scrub(apiStatus)).slice(0, 40),
        url: this.engine.buildUrl(endpoint, query),
        method: "GET",
        body: this.engine.scrub(JSON.stringify(res)),
        ...(detail !== undefined ? { detail } : {}),
      });
    });
    if (problem !== undefined) throw problem;
  }

  /**
   * Current regional flood alerts (Hochwasser-Warnungen) of the German states.
   * `cap: true` adds the Common Alerting Protocol detail block per alert.
   */
  async alerts(params: AlertsParams = {}): Promise<AlertsResponse> {
    checkParams(params);
    const query: QueryParams = {};
    if (params.states !== undefined) query["states"] = normalizeStates(params.states).join(",");
    if (params.cap === true) query["cap"] = true;
    const res = await this.engine.getJson<AlertsResponse>(ENDPOINTS.alerts, query, {
      ...(params.lang !== undefined ? { language: params.lang } : {}),
    });
    this.checkEnvelope(res, ENDPOINTS.alerts, query, false);
    return res;
  }

  /**
   * The current flood situation at the LHP gauges (1573 on 2026-09-15) — classification only
   * (lhpClass 4..-1), NO water levels. For measured levels use PEGELONLINE
   * (pegel-online-cli). `water` / `minClass` filter the result after the fetch (see
   * {@link filterStations}); a bad value rejects before any request.
   */
  async stations(params: StationsParams = {}): Promise<StationsResponse> {
    checkParams(params);
    assertStationFilter(params);
    const query: QueryParams = {};
    if (params.states !== undefined) query["states"] = normalizeStates(params.states).join(",");
    const res = await this.engine.getJson<StationsResponse>(ENDPOINTS.stations, query, {
      ...(params.lang !== undefined ? { language: params.lang } : {}),
    });
    this.checkEnvelope(res, ENDPOINTS.stations, query, true);
    // About 1600 gauges report nationwide; an answer for all of Germany without a single
    // station is an upstream fault, not the "no gauges" verdict `situation` would print.
    if (params.states === undefined && res.data.length === 0) {
      throw new HochwasserzentralenParseError(
        `The API answered ${ENDPOINTS.stations} for all of Germany without a single station; ` +
          `the LHP lists about 1600 gauges, so this is an upstream fault. Try again later.`,
      );
    }
    if (params.water === undefined && params.minClass === undefined) return res;
    return filterStations(res, params);
  }

  /**
   * A per-state flood overview aggregated from /data/stations (one request): station
   * count per lhpClass and the worst class per state and nationwide, with the CC BY
   * attribution and `updated` timestamp of the response. Every requested state (or
   * all 16) is listed, also one without a gauge (`stations: 0`, `worstClass: null`);
   * a null lhpClass counts in "-1"; an off-scale lhpClass rejects with a
   * HochwasserzentralenParseError. See {@link aggregateSituation}.
   */
  async situation(params: SituationParams = {}): Promise<Situation> {
    checkParams(params);
    const states = params.states !== undefined ? normalizeStates(params.states) : undefined;
    const res = await this.stations({
      ...(states !== undefined ? { states } : {}),
      ...(params.lang !== undefined ? { lang: params.lang } : {}),
    });
    return aggregateSituation(res, states ?? STATE_CODES);
  }
}
