// HochwasserzentralenClient — a typed client over the official LHP-PublicAPI v1
// of the Länderübergreifendes Hochwasserportal (https://www.hochwasserzentralen.de).
// No auth, two GET endpoints:
//
//   const c = new HochwasserzentralenClient();
//   await c.alerts();                                  // current regional flood alerts
//   await c.alerts({ states: ["BY", "SN"], cap: true }); // with CAP detail blocks
//   await c.stations({ states: ["BE"], lang: "en" });  // flood class at the gauges
//
// The client always requests `Accept: application/json` (the flat representation;
// see types.ts). The API also serves application/geo+json and text/xml — library
// users can fetch those via `engine.request` with a custom accept.

import { RequestEngine, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import { HochwasserzentralenParseError, HochwasserzentralenValidationError } from "./errors.js";
import {
  STATE_CODES,
  type AlertsParams,
  type AlertsResponse,
  type StationsParams,
  type StationsResponse,
} from "./types.js";

/** The endpoint paths (relative to the base URL). Both are GET. */
export const ENDPOINTS = {
  alerts: "/data/alerts",
  stations: "/data/stations",
} as const;

/**
 * `data` is typed as an array (AlertArea[] / Station[]), but that's only a
 * compile-time cast over whatever JSON the API actually returned — nothing
 * upstream checks the runtime shape. Callers (both CLI commands and library
 * consumers) iterate `res.data` immediately, so a malformed/unexpected body
 * would otherwise surface as a raw "X is not iterable" TypeError deep inside
 * unrelated aggregation code. Fail fast at the client boundary instead, with
 * a typed error that names the endpoint and the field.
 */
function assertDataArray(value: unknown, endpoint: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new HochwasserzentralenParseError(
      `Expected "data" to be an array in the response from ${endpoint}, got ${typeof value}`,
    );
  }
}

/**
 * Normalise and validate a list of state codes: trims, upper-cases, de-duplicates
 * (preserving order) and rejects anything not among the 16 known codes with a
 * HochwasserzentralenValidationError — so a typo never becomes a silently-dropped
 * filter that returns the full nationwide set.
 */
export function normalizeStates(states: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of states) {
    const code = raw.trim().toUpperCase();
    if (code === "") continue;
    if (!(STATE_CODES as readonly string[]).includes(code)) {
      throw new HochwasserzentralenValidationError(
        `Unknown state code "${raw}". Expected one of: ${STATE_CODES.join(", ")}.`,
      );
    }
    if (!out.includes(code)) out.push(code);
  }
  if (out.length === 0) {
    throw new HochwasserzentralenValidationError(
      `No usable state code given. Expected one or more of: ${STATE_CODES.join(", ")}.`,
    );
  }
  return out;
}

/** Options for the client (engine options only — the API needs no auth). */
export type HochwasserzentralenClientOptions = EngineOptions;

export class HochwasserzentralenClient {
  private readonly engine: RequestEngine;

  constructor(options: HochwasserzentralenClientOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /**
   * Current regional flood alerts (Hochwasser-Warnungen) of the German states.
   * `cap: true` adds the Common Alerting Protocol detail block per alert.
   */
  async alerts(params: AlertsParams = {}): Promise<AlertsResponse> {
    const query: QueryParams = {};
    if (params.states !== undefined) query["states"] = normalizeStates(params.states).join(",");
    if (params.cap === true) query["cap"] = true;
    const res = await this.engine.getJson<AlertsResponse>(ENDPOINTS.alerts, query, {
      ...(params.lang !== undefined ? { language: params.lang } : {}),
    });
    assertDataArray(res.data, ENDPOINTS.alerts);
    return res;
  }

  /**
   * The current flood situation at the ~1200 LHP gauges — classification only
   * (lhpClass 4..-1), NO water levels. For measured levels use PEGELONLINE
   * (pegel-online-cli).
   */
  async stations(params: StationsParams = {}): Promise<StationsResponse> {
    const query: QueryParams = {};
    if (params.states !== undefined) query["states"] = normalizeStates(params.states).join(",");
    const res = await this.engine.getJson<StationsResponse>(ENDPOINTS.stations, query, {
      ...(params.lang !== undefined ? { language: params.lang } : {}),
    });
    assertDataArray(res.data, ENDPOINTS.stations);
    return res;
  }
}
