// Pure transforms over the /data/stations response, shared by the library and the
// CLI: the lhpClass scale check and the per-state situation overview. The API
// offers no server-side aggregation, so this is the one place it is computed.

import { HochwasserzentralenParseError } from "./errors.js";
import { sanitizeServerText } from "./engine.js";
import { STATE_CODES, STATION_CLASS_NAMES, type Station, type StationsResponse } from "./types.js";
import { assertValid, minClassProblem, nonBlankProblem } from "./validate.js";

/**
 * Fold a water name for the case-insensitive `water` match: NFC (a decomposed
 * umlaut typed or pasted on macOS matches the feed's composed text), lower case,
 * "ß" as "ss" ("NEISSE" is the upper-case form of "Neiße", and names occur in both
 * spellings, e.g. "…wasserstrasse" / "…wasserstraße"), and the Unicode dashes as "-".
 * Applied to both sides.
 */
export function foldName(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[\u2010-\u2015\u2212]/g, "-");
}

/** The client-side station filters (see {@link filterStations}). */
export interface StationFilter {
  /** Only stations whose water name contains this text (see {@link foldName}). */
  water?: string;
  /** Only stations with `lhpClass >= minClass` (-1..4); gauges without a class never match. */
  minClass?: number;
}

/**
 * Check a {@link StationFilter} before any request: `water` must be a non-blank
 * string and `minClass` an integer from -1 to 4, or a
 * HochwasserzentralenValidationError is thrown. `undefined` means "not given".
 */
export function assertStationFilter(filter: StationFilter): void {
  if (filter.water !== undefined) assertValid("water", filter.water, nonBlankProblem);
  if (filter.minClass !== undefined) assertValid("minClass", filter.minClass, minClassProblem);
}

/**
 * Filter a /data/stations response the way `stations --water / --min-class` does,
 * keeping the envelope (attribution, `updated`) and returning a new object; the
 * input is not changed. `water` is trimmed and matched as a substring on the
 * folded names ({@link foldName}); a station without a string `water` never
 * matches. `minClass` keeps stations whose {@link stationClass} is at least the
 * value: a null class never matches, an off-scale class throws a
 * HochwasserzentralenParseError. A bad filter value throws a
 * HochwasserzentralenValidationError.
 */
export function filterStations(res: StationsResponse, filter: StationFilter): StationsResponse {
  assertStationFilter(filter);
  let data = res.data;
  const { water, minClass } = filter;
  if (water !== undefined) {
    const needle = foldName(water.trim());
    data = data.filter((s) => typeof s.water === "string" && foldName(s.water).includes(needle));
  }
  if (minClass !== undefined) {
    data = data.filter((s) => {
      const cls = stationClass(s);
      return cls !== null && cls >= minClass;
    });
  }
  return { ...res, data };
}

/** The state code a station belongs to: "DE-BE" -> "BE", else the id prefix ("BE_5803500" -> "BE"). */
function stateOf(station: Station): string {
  if (typeof station.stateId === "string" && station.stateId.startsWith("DE-")) {
    return station.stateId.slice(3);
  }
  const idx = station.id.indexOf("_");
  return idx > 0 ? station.id.slice(0, idx) : station.id;
}

/**
 * A station's lhpClass on the documented station scale, shared by the `minClass`
 * filter and the situation overview so the two never disagree: an integer from -1
 * to 4, or `null` for a gauge without a flood classification (`lhpClass` null or
 * absent). Anything else (99, 2.5, the string "3") means the upstream scale or type
 * changed; counting it as "no data" or filtering it by number could hide a flood,
 * so it throws a {@link HochwasserzentralenParseError} instead (CLI exit 1).
 */
export function stationClass(station: Station): number | null {
  const value = station.lhpClass as unknown;
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= -1 && value <= 4) return value;
  const shown = sanitizeServerText(JSON.stringify(value) ?? String(value)).slice(0, 40);
  throw new HochwasserzentralenParseError(
    `Unexpected lhpClass ${shown} at station "${sanitizeServerText(station.id)}" from /data/stations: ` +
      `expected an integer from -1 to 4, or null. The API's class scale may have changed.`,
  );
}

/** One state in the {@link Situation} overview. */
export interface StateSituation {
  state: string;
  stateId: string;
  stations: number;
  /** The worst lhpClass at the state's gauges; `null` when the state has no gauge in the data. */
  worstClass: number | null;
  worstClassName: string | null;
  /**
   * Station count per lhpClass, all six keys zero-filled. JSON key order is
   * "0","1","2","3","4","-1": JS puts integer-like keys first, so "-1" comes last
   * whatever the literal's order. Address the counts by key, not by position.
   */
  classes: Record<string, number>;
}

/** The per-state flood overview aggregated from /data/stations. */
export interface Situation {
  title: string;
  /** The response language the API actually sent (its cache can answer `lang: "en"` in German). */
  lang: string;
  source: string;
  sourceName: string;
  licence: string;
  licenceName: string;
  updated: string;
  totalStations: number;
  worstClass: number | null;
  worstClassName: string | null;
  /** Worst class first, then alphabetically; states without a gauge come last. */
  states: StateSituation[];
}

/** Resolve a class name from the response legend, falling back to the built-in scale. */
function classNamer(res: StationsResponse): (lhpClass: number) => string {
  const byClass = new Map<number, string>();
  for (const item of res.legend?.items ?? []) {
    if (typeof item.lhpClass === "number" && typeof item.lhpClassName === "string") {
      byClass.set(item.lhpClass, item.lhpClassName);
    }
  }
  return (n) => byClass.get(n) ?? STATION_CLASS_NAMES[String(n)] ?? `lhpClass ${n}`;
}

/**
 * Aggregate a /data/stations response into a per-state overview (pure). Every
 * state in `states` (upper-case codes as `normalizeStates` returns them; default
 * all 16) is listed, also one without a gauge in the data: `stations: 0`,
 * `worstClass: null` — "no gauges" is not the same as class -1 "Derzeit keine
 * Daten". A null `lhpClass` counts in the "-1" bucket; an off-scale one throws
 * (see {@link stationClass}). `client.situation()` fetches and aggregates in one call.
 */
export function aggregateSituation(res: StationsResponse, states: readonly string[] = STATE_CODES): Situation {
  const nameOf = classNamer(res);
  // Serialises as "0".."4","-1" (see StateSituation.classes).
  const emptyClasses = (): Record<string, number> => ({ "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "-1": 0 });

  const byState = new Map<string, StateSituation>();
  const entryFor = (state: string, stateId: string): StateSituation => {
    let entry = byState.get(state);
    if (!entry) {
      entry = { state, stateId, stations: 0, worstClass: null, worstClassName: null, classes: emptyClasses() };
      byState.set(state, entry);
    }
    return entry;
  };
  for (const state of states) entryFor(state, `DE-${state}`);
  for (const s of res.data) {
    const state = stateOf(s);
    const entry = entryFor(state, s.stateId ?? `DE-${state}`);
    entry.stations += 1;
    // `lhpClass: null` ("Ohne Hochwasser-Einstufung"), which occurs live, counts
    // in "-1" — see GLOSSARY.md. An off-scale value throws (stationClass).
    const cls = stationClass(s) ?? -1;
    entry.classes[String(cls)] = (entry.classes[String(cls)] ?? 0) + 1;
    if (entry.worstClass === null || cls > entry.worstClass) {
      entry.worstClass = cls;
      entry.worstClassName = nameOf(cls);
    }
  }

  // Worst first, then alphabetically — the flooded states lead the overview;
  // states without a gauge come last.
  const rank = (s: StateSituation): number => s.worstClass ?? -2;
  const sorted = [...byState.values()].sort((a, b) => rank(b) - rank(a) || a.state.localeCompare(b.state));
  const withGauges = sorted.filter((s) => s.worstClass !== null).map((s) => s.worstClass as number);
  const worstClass = withGauges.length > 0 ? Math.max(...withGauges) : null;

  return {
    title: "Hochwasser-Lageübersicht (aggregiert aus /data/stations)",
    lang: res.lang,
    source: res.source,
    sourceName: res.sourceName,
    licence: res.licence,
    licenceName: res.licenceName,
    updated: res.updated,
    totalStations: res.data.length,
    worstClass,
    worstClassName: worstClass === null ? null : nameOf(worstClass),
    states: sorted,
  };
}
