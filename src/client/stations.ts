// Pure transforms over the /data/stations response, shared by the library and the
// CLI: the lhpClass scale check and the per-state situation overview. The API
// offers no server-side aggregation, so this is the one place it is computed.

import { HochwasserzentralenParseError, HochwasserzentralenValidationError, cutText } from "./errors.js";
import { sanitizeServerText } from "./engine.js";
import { STATE_CODES, STATION_CLASS_NAMES, type Station, type StationsResponse } from "./types.js";
import {
  assertValid,
  knownKeysProblem,
  minClassProblem,
  nonBlankProblem,
  responseArgProblem,
  statesProblem,
} from "./validate.js";

/**
 * Fold a water name for the case-insensitive `water` match, applied to both sides:
 * NFC (a decomposed umlaut typed or pasted on macOS matches the feed's composed text),
 * lower case, every whitespace run (a double space, a tab, a no-break space from a web
 * page) as one space and the ends trimmed, "ß" as "ss" ("NEISSE" is the upper-case form
 * of "Neiße", and names occur in both spellings, e.g. "…wasserstrasse" /
 * "…wasserstraße"), "ä"/"ö"/"ü" as "ae"/"oe"/"ue" (a keyboard without umlauts writes
 * "Roeder" for "Röder", as it writes "Weisse" for "Weiße"), and the Unicode dashes as "-".
 */
export function foldName(text: string): string {
  return baseFold(text).replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue");
}

/** The fold shared by both match forms: NFC, lower case, whitespace, ß, dashes. */
function baseFold(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ß/g, "ss")
    .replace(/[\u2010-\u2015\u2212]/g, "-");
}

/** The second match form: {@link baseFold} with every diacritic dropped ("Müritz" -> "muritz"). */
function plainFold(text: string): string {
  return baseFold(text).normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
}

/**
 * True when `name` contains the `water` needle in either folded form: transliterated
 * ({@link foldName}: "Roeder" and "Röder" both find "Große Röder") or with diacritics
 * dropped ("Muritz" finds "Müritz").
 */
function waterMatches(name: string, needle: string): boolean {
  return foldName(name).includes(foldName(needle)) || plainFold(name).includes(plainFold(needle));
}

/** The keys a {@link StationFilter} has; any other key is a validation error. */
const STATION_FILTER_KEYS = ["water", "minClass"] as const;

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
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
    throw new HochwasserzentralenValidationError("Invalid filter: Expected an object.");
  }
  if (filter.water !== undefined) assertValid("water", filter.water, nonBlankProblem);
  if (filter.minClass !== undefined) assertValid("minClass", filter.minClass, minClassProblem);
}

/**
 * Filter a /data/stations response the way `stations --water / --min-class` does,
 * keeping the envelope (attribution, `updated`) and returning a new object; the
 * input is not changed. `water` is matched as a substring on the folded names
 * ({@link foldName}: case, whitespace, ß, umlauts in either spelling, dashes; or with
 * diacritics dropped); a station without a string `water` never
 * matches. `minClass` keeps stations whose {@link stationClass} is at least the
 * value: a null class never matches, an off-scale class throws a
 * HochwasserzentralenParseError. A bad filter value throws a
 * HochwasserzentralenValidationError.
 */
export function filterStations(res: StationsResponse, filter: StationFilter): StationsResponse {
  assertValid("res", res as unknown, responseArgProblem);
  // A misspelled key (`Water`, `minclass`) used to be ignored, returning every station.
  assertValid("filter", filter as unknown, knownKeysProblem(STATION_FILTER_KEYS));
  assertStationFilter(filter);
  let data = res.data;
  const { water, minClass } = filter;
  if (water !== undefined) {
    data = data.filter((s) => typeof s.water === "string" && waterMatches(s.water, water));
  }
  if (minClass !== undefined) {
    data = data.filter((s) => {
      const cls = stationClass(s);
      return cls !== null && cls >= minClass;
    });
  }
  return { ...res, data };
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
 * The state code a station belongs to, upper-cased: from its `stateId` ("DE-BE" -> "BE",
 * also "DE-be"), else from the id prefix ("BE_5803500" -> "BE"). A station whose state
 * can't be read that way keeps what it has (an unknown "DE-XX" gives "XX", an id without
 * "_" the whole id), so the nationwide overview lists it rather than losing a gauge.
 */
function stateOf(station: Station): string {
  if (typeof station.stateId === "string" && /^DE-/i.test(station.stateId)) {
    return station.stateId.slice(3).toUpperCase();
  }
  const idx = station.id.indexOf("_");
  return (idx > 0 ? station.id.slice(0, idx) : station.id).toUpperCase();
}

/**
 * The response with only the stations of `states` (upper-case codes as `normalizeStates`
 * returns them), by {@link stateOf}; the envelope is kept, the input not changed. The
 * client applies it to every `states` request, so the answer never depends on the server
 * honouring `?states=`.
 */
export function onlyStates(res: StationsResponse, states: readonly string[]): StationsResponse {
  assertValid("res", res as unknown, responseArgProblem);
  const wanted = new Set(normalizeStates(states));
  return { ...res, data: res.data.filter((s) => wanted.has(stateOf(s))) };
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
  if (typeof station !== "object" || station === null || Array.isArray(station)) {
    throw new HochwasserzentralenValidationError("Invalid station: Expected a station object.");
  }
  const value = station.lhpClass as unknown;
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= -1 && value <= 4) return value;
  const shown = cutText(sanitizeServerText(JSON.stringify(value) ?? String(value)), 40);
  throw new HochwasserzentralenParseError(
    `Unexpected lhpClass ${shown} at station "${cutText(sanitizeServerText(String(station.id)), 100)}" from /data/stations: ` +
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
 * Aggregate a /data/stations response into a per-state overview (pure). With `states`
 * (normalised like `normalizeStates`: trimmed, upper-cased, checked against the 16
 * codes, else a HochwasserzentralenValidationError), the overview covers exactly those
 * states: each is listed, also one without a gauge in the data (`stations: 0`,
 * `worstClass: null` — "no gauges" is not the same as class -1 "Derzeit keine Daten"),
 * and a gauge of any other state in the body is left out of the counts and the national
 * worst class (a server that ignored `?states=` can't change the answer). Without
 * `states`, all 16 are listed and every gauge counts; one whose state isn't among the 16
 * gets an entry of its own rather than being lost. A null `lhpClass` counts in the "-1"
 * bucket; an off-scale one throws (see {@link stationClass}). `client.situation()`
 * fetches and aggregates in one call.
 */
export function aggregateSituation(res: StationsResponse, states?: readonly string[]): Situation {
  assertValid("res", res as unknown, responseArgProblem);
  const requested = states === undefined ? undefined : normalizeStates(states);
  const included = requested === undefined ? res : onlyStates(res, requested);
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
  for (const state of requested ?? STATE_CODES) entryFor(state, `DE-${state}`);
  for (const s of included.data) {
    const state = stateOf(s);
    const known = (STATE_CODES as readonly string[]).includes(state);
    const entry = entryFor(state, known ? `DE-${state}` : (s.stateId ?? state));
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
    totalStations: included.data.length,
    worstClass,
    worstClassName: worstClass === null ? null : nameOf(worstClass),
    states: sorted,
  };
}
