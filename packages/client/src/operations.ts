// The use cases of the skills as library functions, built on the client: each composes its calls
// and carries the traps the skills document, so no caller (the CLI, the MCP server's use-case
// tools, a library user) has to know them.
// - getFloodAlerts: the official warnings, ranked on the alerts scale (6 > 5 > 4 > 2), the
//   all-clears (class 1, Entwarnung) apart, never counted as a flood (the flood-alerts skill);
// - getFloodSituation: the gauges' classification per state, the no-data gauges (-1) and the
//   unclassified ones (null) apart, border gauges counted once as sites (the situation skill);
// - listGauges and findGauge: the gauges by state, water and class, or one by name or id, a
//   name matching several places reported as ambiguous (the situation skill's drill-down);
// - getFloodMap: alert areas or gauges as GeoJSON features, the ones left off named (the
//   GeoJSON export skill).
// Every result carries the attribution CC BY 4.0 asks for, with the data's time as German local
// time (the API's `updated` says +01:00 also in summer). No bare "not found": an empty answer
// says what was searched and why it is empty.

import type { HochwasserzentralenClient } from "./client.js";
import { HochwasserzentralenValidationError } from "./errors.js";
import { alertsToGeoJson, alertsWithoutGeometry, featuresBbox, stationsToGeoJson, stationsWithoutCoordinates, type GeoJsonFeature } from "./geojson.js";
import { foldName, stationClass } from "./stations.js";
import { STATE_CODES, STATION_CLASS_NAMES, type AlertArea, type Lang, type ResponseEnvelope, type Station, type StationsResponse } from "./types.js";
import { assertValid, minClassProblem, normalizeText, textProblem, tokenProblem, type Problem } from "./validate.js";

// ---- shared ---------------------------------------------------------------------------------

/** The states by code, with their German names. */
export const STATE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  BB: "Brandenburg",
  BE: "Berlin",
  BW: "Baden-Württemberg",
  BY: "Bayern",
  HB: "Bremen",
  HE: "Hessen",
  HH: "Hamburg",
  MV: "Mecklenburg-Vorpommern",
  NI: "Niedersachsen",
  NW: "Nordrhein-Westfalen",
  RP: "Rheinland-Pfalz",
  SH: "Schleswig-Holstein",
  SL: "Saarland",
  SN: "Sachsen",
  ST: "Sachsen-Anhalt",
  TH: "Thüringen",
});

/** Other names a state goes by (English, short forms), folded as {@link foldName} folds them. */
const STATE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  bavaria: "BY",
  hesse: "HE",
  "mecklenburg-western pomerania": "MV",
  "lower saxony": "NI",
  nrw: "NW",
  "north rhine-westphalia": "NW",
  "rhineland-palatinate": "RP",
  saxony: "SN",
  "saxony-anhalt": "ST",
  thuringia: "TH",
});

/**
 * The state codes for states given as codes ("BY") or names ("Bayern", "Bavaria", "NRW", any
 * case, umlauts or not): de-duplicated, in the order given. An unknown one is a validation error
 * naming the 16 codes, never a dropped filter (which would answer for all of Germany).
 */
export function resolveStates(states: readonly string[]): string[] {
  if (!Array.isArray(states) || states.length === 0) {
    throw new HochwasserzentralenValidationError(`Invalid states: expected one or more of ${STATE_CODES.join(", ")} (or their names).`);
  }
  const codes: string[] = [];
  for (const raw of states) {
    const value = assertValid("states", raw, tokenProblem).trim();
    const folded = foldName(value);
    const code =
      (STATE_CODES as readonly string[]).find((c) => c === value.toUpperCase()) ??
      Object.entries(STATE_NAMES).find(([, name]) => foldName(name) === folded)?.[0] ??
      STATE_ALIASES[folded];
    if (code === undefined) {
      throw new HochwasserzentralenValidationError(
        `Invalid states: unknown state ${JSON.stringify(value)}. Expected a code or name: ${STATE_CODES.map((c) => `${c} (${STATE_NAMES[c]})`).join(", ")}.`,
      );
    }
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/** Where the data comes from, as CC BY 4.0 and the LHP ask it to be named. */
export interface Attribution {
  /** "Quelle: Länderübergreifendes Hochwasserportal (LHP), hochwasserzentralen.de — Stand: 19.11.2026, 16:11 MEZ". */
  text: string;
  sourceName: string;
  sourceUrl: string;
  licence: string;
  licenceName: string;
  /** The data's time as the API sent it (always with +01:00, also in summer); absent when it sent none. */
  updated?: string;
  /**
   * The same instant as German local time ("19.11.2026, 16:11 MEZ", "15.09.2026, 17:47 MESZ");
   * absent when `updated` is missing or no time, and `text` then says "Stand: unbekannt".
   */
  updatedLocal?: string;
}

const BERLIN = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

/**
 * An API time (`2026-09-15T16:47:47+01:00`) as German local time (`15.09.2026, 17:47 MESZ`): the
 * API writes +01:00 the whole year, so a summer time read as it stands is an hour behind the
 * clock. A text that is no time is returned as it is.
 */
export function germanLocalTime(updated: string): string {
  const ms = Date.parse(updated);
  return Number.isFinite(ms) ? BERLIN.format(new Date(ms)) : updated;
}

/** The data's time of an answer as German local time, or undefined when it sent none that is a time. */
function localTimeOf(res: ResponseEnvelope): string | undefined {
  return typeof res.updated === "string" && Number.isFinite(Date.parse(res.updated)) ? germanLocalTime(res.updated) : undefined;
}

/**
 * The attribution of an answer, from its envelope. Without a time the API sent (`updated` missing
 * or not a time), the credit says "Stand: unbekannt" and `updatedLocal` is absent (see
 * {@link envelopeNotes}).
 */
export function attributionOf(res: ResponseEnvelope): Attribution {
  const updatedLocal = localTimeOf(res);
  const sourceName = typeof res.sourceName === "string" && res.sourceName !== "" ? res.sourceName : "Länderübergreifendes Hochwasserportal (LHP)";
  return {
    text: `Quelle: ${sourceName}, hochwasserzentralen.de — Stand: ${updatedLocal ?? "unbekannt"}`,
    sourceName,
    sourceUrl: typeof res.source === "string" && res.source !== "" ? res.source : "https://www.hochwasserzentralen.de",
    licence: res.licence,
    licenceName: res.licenceName,
    ...(typeof res.updated === "string" ? { updated: res.updated } : {}),
    ...(updatedLocal === undefined ? {} : { updatedLocal }),
  };
}

/** A note when the answer carries no time for its data (the credit then says "Stand: unbekannt"). */
function timeNote(res: ResponseEnvelope): string[] {
  if (localTimeOf(res) !== undefined) return [];
  const sent = typeof res.updated === "string" ? `The API sent ${JSON.stringify(res.updated)} as the time of this data, which is no time` : "The API sent no time for this data";
  return [`${sent}: the credit says "Stand: unbekannt". Say that the data's time is unknown.`];
}

/** The notes every answer's envelope may need: another language than asked, no time. */
function envelopeNotes(asked: Lang | undefined, res: ResponseEnvelope): string[] {
  return [...languageNote(asked, res), ...timeNote(res)];
}

/** A note when the API answered in another language than asked (its cache ignores the language). */
function languageNote(asked: Lang | undefined, res: ResponseEnvelope): string[] {
  return asked !== undefined && res.lang !== asked
    ? [`Asked for lang ${asked}, the API sent ${JSON.stringify(res.lang)}: its cache ignores the language at times. The data is the same.`]
    : [];
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** A label with its HTML entities decoded: Rheinland-Pfalz sends "Kein Hochwasser bzw. &#60; 2-jährliches Hochwasser". */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] !== "#") return ENTITIES[body.toLowerCase()] ?? whole;
    const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

/** A problem for a whole number in [min, max]. */
const within = (min: number, max: number): Problem<number> => (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? undefined : `Expected a whole number from ${min} to ${max}.`;

/** The state code of an id ("BY_577" -> "BY"), or undefined. */
function stateOfId(id: string): string | undefined {
  const prefix = id.split("_")[0]?.toUpperCase() ?? "";
  return (STATE_CODES as readonly string[]).includes(prefix) ? prefix : undefined;
}

/** The state of a gauge: its `stateId` ("DE-BY"), else its id's prefix. */
function gaugeState(station: Station): string | undefined {
  if (typeof station.stateId === "string" && /^DE-[A-Z]{2}$/i.test(station.stateId)) return station.stateId.slice(3).toUpperCase();
  return stateOfId(station.id);
}

/** The class names of the stations answer's legend, else the built-in scale. */
function stationClassNamer(res: StationsResponse): (cls: number) => string {
  const byClass = new Map<number, string>();
  for (const item of res.legend?.items ?? []) if (typeof item.lhpClassName === "string") byClass.set(Number(item.lhpClass), item.lhpClassName);
  return (cls) => byClass.get(cls) ?? STATION_CLASS_NAMES[String(cls)] ?? `lhpClass ${cls}`;
}

/** The scope of a request, as an answer repeats it. */
function scopeOf(states: readonly string[] | undefined): string {
  return states === undefined ? "Germany" : states.map((s) => STATE_NAMES[s] ?? s).join(", ");
}

// ---- alerts ---------------------------------------------------------------------------------

/** The alerts scale: 6 Sehr großes Hochwasser, 5 Großes Hochwasser, 4 Hochwasser, 2 Vorwarnung, 1 Entwarnung. */
export const ALERT_CLASS_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "6": "Sehr großes Hochwasser",
  "5": "Großes Hochwasser",
  "4": "Hochwasser",
  "2": "Vorwarnung",
  "1": "Entwarnung",
});

/** The input of {@link getFloodAlerts}. */
export interface FloodAlertsInput {
  /** State codes or names; none: all of Germany. */
  states?: readonly string[] | undefined;
  /** With the CAP detail (severity, onset, expiry, the official instruction). */
  cap?: boolean | undefined;
  lang?: Lang | undefined;
}

/** One warning of {@link FloodAlerts}. */
export interface FloodAlert {
  id: string;
  state?: string;
  area?: string;
  areaType?: string;
  /** The class on the alerts scale (6..1), a number; the API sends a string. */
  class: number | null;
  className: string;
  headline?: string;
  /** The state's page with the authoritative detail. */
  link?: string;
  /** Polygon, or LineString for a river reach. */
  geometryType?: string;
  /** With `cap`: what the CAP block says. */
  cap?: { severity?: string; urgency?: string; certainty?: string; onset?: string; effective?: string; expires?: string | null; sender?: string; headline?: string; description?: string; instruction?: string; web?: string };
}

/** The answer of {@link getFloodAlerts}. */
export interface FloodAlerts {
  status: "ok";
  searched: { states?: string[] };
  /** One sentence: how many active warnings, the worst class and where; or none. */
  verdict: string;
  /** Active warnings (classes 6, 5, 4 and 2, and any class off the scale), worst first. */
  active: FloodAlert[];
  /** All-clears (class 1, Entwarnung): a warning lifted, good news, never an active flood. */
  cleared: FloodAlert[];
  /** Active warnings per class name. */
  counts: Record<string, number>;
  lang: string;
  attribution: Attribution;
  notes: string[];
}

/** An alert's class as a number (the API sends "4"), or null when it isn't one. */
function alertClass(alert: AlertArea): number | null {
  const value = alert.lhpClass as unknown;
  const n = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isInteger(n) ? n : null;
}

function briefAlert(alert: AlertArea, withCap: boolean): FloodAlert {
  const cls = alertClass(alert);
  const info = alert.cap?.info;
  const state = stateOfId(alert.id);
  return {
    id: alert.id,
    ...(state === undefined ? {} : { state }),
    ...(alert.areaDesc === undefined ? {} : { area: alert.areaDesc }),
    ...(alert.areaType === undefined ? {} : { areaType: alert.areaType }),
    class: cls,
    className: alert.lhpClassName ?? (cls === null ? "unknown class" : (ALERT_CLASS_NAMES[String(cls)] ?? `lhpClass ${cls}`)),
    ...(alert.alertHeadline === undefined ? {} : { headline: alert.alertHeadline }),
    ...(alert.alertLink === undefined ? {} : { link: alert.alertLink }),
    ...(typeof alert.geometry?.type === "string" ? { geometryType: alert.geometry.type } : {}),
    ...(withCap && info !== undefined
      ? {
          cap: prune({
            severity: info.severity,
            urgency: info.urgency,
            certainty: info.certainty,
            onset: info.onset,
            effective: info.effective,
            expires: info.expires,
            sender: info.sendername,
            headline: info.headline,
            description: info.description,
            instruction: info.instruction,
            web: info.web,
          }),
        }
      : {}),
  };
}

/**
 * The official flood warnings of the states, for all of Germany or some states: the active ones
 * ranked worst first on the alerts scale (6 > 5 > 4 > 2: Vorwarnung is a pre-warning), the
 * all-clears (class 1, Entwarnung) apart, with a verdict. No warning is the usual, good answer
 * (`active` empty, the verdict says so), not an error. A class off the scale stays active, with a
 * note, never dropped.
 */
export async function getFloodAlerts(client: HochwasserzentralenClient, input: FloodAlertsInput = {}): Promise<FloodAlerts> {
  const states = input.states === undefined ? undefined : resolveStates(input.states);
  const res = await client.alerts({ ...(states === undefined ? {} : { states }), ...(input.cap === true ? { cap: true } : {}), ...(input.lang === undefined ? {} : { lang: input.lang }) });
  const all = res.data.map((a) => briefAlert(a, input.cap === true));
  const cleared = all.filter((a) => a.class === 1);
  const active = all.filter((a) => a.class !== 1).sort((a, b) => (b.class ?? 99) - (a.class ?? 99) || a.id.localeCompare(b.id));
  const counts: Record<string, number> = {};
  for (const a of active) counts[a.className] = (counts[a.className] ?? 0) + 1;
  const notes = envelopeNotes(input.lang, res);
  const odd = active.filter((a) => a.class === null || ALERT_CLASS_NAMES[String(a.class)] === undefined);
  if (odd.length > 0) {
    notes.push(`${odd.map((a) => a.id).join(", ")}: a class off the alerts scale (6, 5, 4, 2, 1); read its className and the state's page.`);
  }
  const scope = scopeOf(states);
  let verdict: string;
  if (active.length === 0) {
    verdict = `No active official flood warning for ${scope}${cleared.length > 0 ? ` (${cleared.length} all-clear${cleared.length === 1 ? "" : "s"}, Entwarnung)` : ""}.`;
  } else {
    const worst = active[0] as FloodAlert;
    const where = [...new Set(active.filter((a) => a.class === worst.class).map((a) => a.area ?? a.id))].slice(0, 5).join("; ");
    verdict = `${active.length} active official flood warning${active.length === 1 ? "" : "s"} for ${scope}; the worst is class ${worst.class ?? "?"} (${worst.className}) at ${where}.`;
  }
  return { status: "ok", searched: states === undefined ? {} : { states }, verdict, active, cleared, counts, lang: res.lang, attribution: attributionOf(res), notes };
}

// ---- gauges ---------------------------------------------------------------------------------

/** One gauge, as the gauge answers list it. */
export interface Gauge {
  id: string;
  name?: string;
  water?: string;
  state?: string;
  /** The LHP's harmonised class 4..-1 (-1: no data), or null: the gauge has no flood classification. */
  class: number | null;
  className: string;
  /** The state's own label (its HTML entities decoded); stays German whatever the language. */
  stateClassName?: string;
  /** The gauge's report time, German local time. */
  timestamp?: string;
  link?: string;
  /** [longitude, latitude]. */
  coordinates?: number[];
  /** The same site reported by another state (a border gauge), by id. */
  sameSiteAs?: string[];
}

/** The input of {@link listGauges}. */
export interface GaugesInput {
  /** State codes or names; none: all of Germany. */
  states?: readonly string[] | undefined;
  /** Only gauges on a water whose name contains this ("rhein", "Neiße" = "neisse"). */
  water?: string | undefined;
  /** Only gauges at this class or above (-1..4); 1: actually flooding. Unclassified gauges never match. */
  minClass?: number | undefined;
  lang?: Lang | undefined;
}

/** The answer of {@link listGauges}. */
export type GaugeList =
  | {
      status: "ok";
      searched: GaugeSearch;
      /** Gauges listed; a border gauge counts once per reporting state. */
      total: number;
      /** Distinct sites (by position): border gauges once. */
      sites: number;
      /** Worst first, then by water and name. */
      gauges: Gauge[];
      /** With a water search: the waters it matched, with their counts (it matches parts of names). */
      waters?: Record<string, number>;
      attribution: Attribution;
      notes: string[];
    }
  | { status: "empty"; searched: GaugeSearch; reason: string; attribution: Attribution; notes: string[] };

/** What a gauge search asked for. */
export interface GaugeSearch {
  states?: string[];
  water?: string;
  minClass?: number;
  gauge?: string;
}

/** The gauges of an answer as {@link Gauge}s, border gauges linked to each other, worst first. */
function toGauges(res: StationsResponse, scrub?: (text: string) => string): Gauge[] {
  const nameOf = stationClassNamer(res);
  const bySite = new Map<string, string[]>();
  for (const s of res.data) {
    const key = siteKey(s);
    if (key !== undefined) bySite.set(key, [...(bySite.get(key) ?? []), s.id]);
  }
  const gauges = res.data.map((s): Gauge => {
    const cls = stationClass(s, scrub);
    const state = gaugeState(s);
    const key = siteKey(s);
    const others = key === undefined ? [] : (bySite.get(key) ?? []).filter((id) => id !== s.id);
    return {
      id: s.id,
      ...(s.name === undefined ? {} : { name: s.name }),
      ...(s.water === undefined ? {} : { water: s.water }),
      ...(state === undefined ? {} : { state }),
      class: cls,
      className: cls === null ? "Ohne Hochwasser-Einstufung (unclassified)" : nameOf(cls),
      ...(typeof s.stateClassName === "string" ? { stateClassName: decodeEntities(s.stateClassName) } : {}),
      ...(s.timestamp === undefined ? {} : { timestamp: s.timestamp }),
      ...(s.stationLink === undefined ? {} : { link: s.stationLink }),
      ...(Array.isArray(s.coordinates) ? { coordinates: s.coordinates } : {}),
      ...(others.length > 0 ? { sameSiteAs: others } : {}),
    };
  });
  return gauges.sort((a, b) => (b.class ?? -2) - (a.class ?? -2) || (a.water ?? "").localeCompare(b.water ?? "", "de") || (a.name ?? "").localeCompare(b.name ?? "", "de"));
}

/** A gauge's site: its position, rounded to about a metre; undefined without one. */
function siteKey(s: Station): string | undefined {
  const c = s.coordinates;
  return Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number" ? `${c[0].toFixed(5)},${c[1].toFixed(5)}` : undefined;
}

function countSites(gauges: readonly Gauge[]): number {
  const seen = new Set<string>();
  let alone = 0;
  for (const g of gauges) {
    if (g.coordinates === undefined) alone++;
    else seen.add([g.id, ...(g.sameSiteAs ?? [])].sort()[0] as string);
  }
  return seen.size + alone;
}

const GAUGE_NOTES = [
  "Classification only: the LHP publishes no water levels; for centimetres and trends use PEGELONLINE (pegel-online-cli).",
  "The station scale (4..-1) is the LHP's harmonised one, not the alerts scale and not the state's own Meldestufe.",
];

/**
 * The gauges of some states, on a water, at a class or above: each with its class (null:
 * unclassified, -1: no data, apart), the state's own label decoded, and the other state's id of a
 * border gauge (`sameSiteAs`), with the count of distinct sites and, for a water search, the
 * waters it matched. None
 * is `empty`, saying why (with `minClass` 1 or more, that no gauge is flooding is the good news).
 */
export async function listGauges(client: HochwasserzentralenClient, input: GaugesInput = {}): Promise<GaugeList> {
  const states = input.states === undefined ? undefined : resolveStates(input.states);
  const water = input.water === undefined ? undefined : normalizeText(assertValid("water", input.water, textProblem));
  const minClass = input.minClass === undefined ? undefined : assertValid("minClass", input.minClass, minClassProblem as Problem<number>);
  const searched: GaugeSearch = { ...(states === undefined ? {} : { states }), ...(water === undefined ? {} : { water }), ...(minClass === undefined ? {} : { minClass }) };
  const res = await client.stations({
    ...(states === undefined ? {} : { states }),
    ...(water === undefined ? {} : { water }),
    ...(minClass === undefined ? {} : { minClass }),
    ...(input.lang === undefined ? {} : { lang: input.lang }),
  });
  const attribution = attributionOf(res);
  const notes = [...envelopeNotes(input.lang, res), ...GAUGE_NOTES];
  const gauges = toGauges(res);
  if (gauges.length === 0) {
    const scope = scopeOf(states);
    const reason =
      water !== undefined
        ? `No LHP gauge in ${scope} is on a water whose name contains ${JSON.stringify(water)}${minClass === undefined ? "" : ` at class ${minClass} or above`}. Check the spelling (a part of the name is enough), or drop the states.`
        : minClass !== undefined
          ? `No gauge in ${scope} is at class ${minClass} or above${minClass >= 1 ? ": no reporting gauge is flooding (good news, not missing data)" : ""}.`
          : `The LHP lists no gauge in ${scope}.`;
    return { status: "empty", searched, reason, attribution, notes };
  }
  const waters: Record<string, number> = {};
  for (const g of gauges) if (g.water !== undefined) waters[g.water] = (waters[g.water] ?? 0) + 1;
  const sites = countSites(gauges);
  if (sites < gauges.length) notes.push(`${gauges.length - sites} border gauge entr${gauges.length - sites === 1 ? "y is" : "ies are"} the same site reported by two states (sameSiteAs): count sites, not entries.`);
  return { status: "ok", searched, total: gauges.length, sites, gauges, ...(water === undefined ? {} : { waters }), attribution, notes };
}

/** The input of {@link findGauge}. */
export interface FindGaugeInput {
  /** A gauge's id ("BY_10088003") or its name or part of it ("Kaub", "Dresden"). */
  gauge: string;
  states?: readonly string[] | undefined;
  water?: string | undefined;
  /** At most this many candidates when several sites match (1-25, default 10). */
  limit?: number | undefined;
  lang?: Lang | undefined;
}

/** The answer of {@link findGauge}. */
export type GaugeLookup =
  | { status: "ok"; searched: GaugeSearch; gauge: Gauge; sameSite: Gauge[]; attribution: Attribution; notes: string[] }
  | { status: "ambiguous"; searched: GaugeSearch; total: number; candidates: Gauge[]; complete: boolean; attribution: Attribution; notes: string[] }
  | { status: "empty"; searched: GaugeSearch; reason: string; attribution: Attribution; notes: string[] };

/**
 * One gauge by its id or name, with its class: an id is matched exactly; a name as a part of the
 * gauge names (folded: case, umlauts, ß). One site is the answer, a border gauge's other entry
 * beside it (`sameSite`); so is one name equal to the search when no other site has the search as
 * a word of its name ("Kaub" beside "Kaubach", not "Passau" beside "Passau Marienbrücke"). Several
 * sites are `ambiguous`, with the candidates (exact names first), never one picked; none is
 * `empty`, saying what was searched.
 */
export async function findGauge(client: HochwasserzentralenClient, input: FindGaugeInput): Promise<GaugeLookup> {
  const wanted = normalizeText(assertValid("gauge", input.gauge, textProblem));
  const limit = assertValid("limit", input.limit ?? 10, within(1, 25));
  const list = await listGauges(client, { states: input.states, water: input.water, lang: input.lang });
  const searched: GaugeSearch = { ...list.searched, gauge: wanted };
  const { attribution } = list;
  // The list's count of border gauges is about all the gauges searched, not this one.
  const notes = list.notes.filter((note) => !note.includes("sameSiteAs"));
  if (list.status === "empty") return { status: "empty", searched, reason: list.reason, attribution, notes };
  const byId = list.gauges.filter((g) => g.id.toUpperCase() === wanted.toUpperCase());
  const folded = foldName(wanted);
  const matches = byId.length > 0 ? byId : list.gauges.filter((g) => g.name !== undefined && foldName(g.name).includes(folded));
  if (matches.length === 0) {
    return {
      status: "empty",
      searched,
      reason: `No LHP gauge${list.searched.states === undefined ? "" : ` in ${scopeOf(list.searched.states)}`} has an id or name containing ${JSON.stringify(wanted)}. Try a shorter part of the name, the place's own name, or listGauges with the water. Not every Pegel is an LHP gauge.`,
      attribution,
      notes,
    };
  }
  // One site (a border gauge's two entries), or one exact name that no other place has as a word
  // of its own name: the answer. "Kaub" beside "Kaubach" is Kaub; "Gießen" beside
  // "Gießen-Klärwerk", or "Passau" beside "Passau Marienbrücke", are places of that name too.
  const siteOf = (g: Gauge): string => [g.id, ...(g.sameSiteAs ?? [])].sort()[0] as string;
  const sites = new Set(matches.map(siteOf));
  const exact = matches.filter((g) => g.name !== undefined && foldName(g.name) === folded);
  const exactSites = new Set(exact.map(siteOf));
  const exactSite = exact[0] === undefined ? undefined : siteOf(exact[0]);
  const namedSoElsewhere = matches.some((g) => siteOf(g) !== exactSite && g.name !== undefined && hasWord(foldName(g.name), folded));
  const pick = sites.size === 1 ? matches[0] : exactSites.size === 1 && !namedSoElsewhere ? exact[0] : undefined;
  if (pick !== undefined) {
    const sameSite = list.gauges.filter((g) => g.id !== pick.id && siteOf(g) === siteOf(pick));
    return { status: "ok", searched, gauge: pick, sameSite, attribution, notes };
  }
  const ranked = [...exact, ...matches.filter((g) => !exact.includes(g))];
  return { status: "ambiguous", searched, total: matches.length, candidates: ranked.slice(0, limit), complete: matches.length <= limit, attribution, notes };
}

/** True when `text` holds `word` with no letter or digit right before or after it. */
function hasWord(text: string, word: string): boolean {
  const wordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    if (!wordChar(text[at - 1]) && !wordChar(text[at + word.length])) return true;
  }
  return false;
}

// ---- situation ------------------------------------------------------------------------------

/** The input of {@link getFloodSituation}. */
export interface FloodSituationInput {
  states?: readonly string[] | undefined;
  /** At most this many flooding gauges listed (class 1 or above, worst first; 0-50, default 10). */
  worstGauges?: number | undefined;
  lang?: Lang | undefined;
}

/** One state of {@link FloodSituation}. */
export interface StateFloodSituation {
  state: string;
  name: string;
  /** Gauges the state reports (a border gauge counts in both states). */
  gauges: number;
  /** The worst class at its classified gauges with data; null: no LHP gauge, or none with a class. */
  worstClass: number | null;
  worstClassName: string | null;
  /** Gauges at class 1 or above. */
  flooding: number;
  /** Gauges per class, worst first, only the classes that occur (4..0). */
  classes: { class: number; name: string; gauges: number }[];
  /** Gauges at -1: no current data (a gap, never calm). */
  noData: number;
  /** Gauges without a flood classification (lhpClass null, "Ohne Hochwasser-Einstufung"). */
  unclassified: number;
}

/** The answer of {@link getFloodSituation}. */
export interface FloodSituation {
  status: "ok";
  searched: { states?: string[] };
  verdict: string;
  /** Gauge entries in all; a border gauge counts once per reporting state. */
  totalGauges: number;
  sites: number;
  worstClass: number | null;
  worstClassName: string | null;
  /** Worst first, then by name; a state without a gauge last. */
  states: StateFloodSituation[];
  /** The worst gauges, class 1 or above, a border gauge's second entry left out. */
  worstGauges: Gauge[];
  attribution: Attribution;
  notes: string[];
}

/**
 * The flood situation at the gauges, per state and for all, from one request: the worst class
 * and the count per class, the no-data gauges (-1) and the unclassified ones (null) apart (the
 * API's own overview counts both as -1), the worst gauges by name, border gauges once, and a
 * verdict. A state without an LHP gauge is listed with `gauges: 0`, which is "no LHP gauges",
 * not "no data" or "no flooding".
 */
export async function getFloodSituation(client: HochwasserzentralenClient, input: FloodSituationInput = {}): Promise<FloodSituation> {
  const states = input.states === undefined ? undefined : resolveStates(input.states);
  const top = assertValid("worstGauges", input.worstGauges ?? 10, within(0, 50));
  const res = await client.stations({ ...(states === undefined ? {} : { states }), ...(input.lang === undefined ? {} : { lang: input.lang }) });
  const nameOf = stationClassNamer(res);
  const gauges = toGauges(res);
  const byState = new Map<string, StateFloodSituation>();
  const entry = (code: string): StateFloodSituation => {
    let e = byState.get(code);
    if (e === undefined) {
      e = { state: code, name: STATE_NAMES[code] ?? code, gauges: 0, worstClass: null, worstClassName: null, flooding: 0, classes: [], noData: 0, unclassified: 0 };
      byState.set(code, e);
    }
    return e;
  };
  for (const code of states ?? STATE_CODES) entry(code);
  for (const g of gauges) {
    const e = entry(g.state ?? "unknown");
    e.gauges++;
    if (g.class === null) e.unclassified++;
    else if (g.class === -1) e.noData++;
    else {
      if (g.class >= 1) e.flooding++;
      const slot = e.classes.find((c) => c.class === g.class);
      if (slot === undefined) e.classes.push({ class: g.class, name: nameOf(g.class), gauges: 1 });
      else slot.gauges++;
    }
  }
  for (const e of byState.values()) {
    e.classes.sort((a, b) => b.class - a.class);
    const worst = e.classes[0]?.class ?? (e.noData > 0 ? -1 : null);
    e.worstClass = worst;
    e.worstClassName = worst === null ? null : nameOf(worst);
  }
  const ranked = [...byState.values()].sort((a, b) => (b.worstClass ?? -2) - (a.worstClass ?? -2) || (b.gauges === 0 ? -1 : 0) - (a.gauges === 0 ? -1 : 0) || a.state.localeCompare(b.state));
  const classes = ranked.map((e) => e.worstClass).filter((c): c is number => c !== null);
  const worstClass = classes.length > 0 ? Math.max(...classes) : null;
  const seen = new Set<string>();
  const flooding = gauges.filter((g) => {
    if (g.class === null || g.class < 1) return false;
    const site = [g.id, ...(g.sameSiteAs ?? [])].sort()[0] as string;
    if (seen.has(site)) return false;
    seen.add(site);
    return true;
  });
  const scope = scopeOf(states);
  const floodingStates = ranked.filter((e) => e.flooding > 0);
  // A state whose gauges all report -1 is dark: a data gap, which is when gauges fail in a real
  // flood, so the verdict says it and never reads it as calm.
  const dark = ranked.filter((e) => e.gauges > 0 && e.worstClass === -1);
  const darkNote = dark.length === 0 ? "" : ` No current data from any gauge in ${dark.map((e) => e.name).join(", ")}: a data gap, not calm.`;
  const noDataGauges = ranked.reduce((n, e) => n + e.noData, 0);
  const verdict =
    worstClass === null
      ? `No LHP gauge with a class in ${scope}.`
      : worstClass === -1
        ? `No current data from any gauge in ${scope} (${noDataGauges} gauge${noDataGauges === 1 ? "" : "s"} at -1, ${nameOf(-1)}): a data gap, not calm. Check the ${dark.length === 1 ? "state's flood service" : "states' flood services"}.`
        : worstClass < 1
          ? `No flooding at any reporting gauge in ${scope} (worst class ${worstClass}, ${nameOf(worstClass)}).${darkNote}`
          : `${flooding.length} gauge site${flooding.length === 1 ? "" : "s"} in ${scope} at class 1 or above; the worst is class ${worstClass} (${nameOf(worstClass)}), in ${floodingStates
              .filter((e) => e.worstClass === worstClass)
              .map((e) => e.name)
              .join(", ")}.${darkNote}`;
  const notes = [
    ...envelopeNotes(input.lang, res),
    ...GAUGE_NOTES,
    "The states' official flood warnings (the alerts) are separate: a warning can be in force while the gauges are calm, and the other way round. Report both.",
  ];
  const noData = noDataGauges;
  const unclassified = ranked.reduce((n, e) => n + e.unclassified, 0);
  if (noData > 0) notes.push(`${noData} gauge${noData === 1 ? " has" : "s have"} no current data (-1): a data gap, not calm.`);
  if (unclassified > 0) notes.push(`${unclassified} gauge${unclassified === 1 ? " has" : "s have"} no flood classification at all (unclassified): not a data gap.`);
  const sites = countSites(gauges);
  if (sites < gauges.length) notes.push(`Border gauges count in both reporting states: ${gauges.length} entries are ${sites} sites.`);
  return {
    status: "ok",
    searched: states === undefined ? {} : { states },
    verdict,
    totalGauges: gauges.length,
    sites,
    worstClass,
    worstClassName: worstClass === null ? null : nameOf(worstClass),
    states: ranked,
    worstGauges: flooding.slice(0, top),
    attribution: attributionOf(res),
    notes,
  };
}

// ---- map ------------------------------------------------------------------------------------

/** The two layers of {@link getFloodMap}. */
export const MAP_LAYERS = ["alerts", "gauges"] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

/** The input of {@link getFloodMap}. */
export interface FloodMapInput {
  layer: MapLayer;
  states?: readonly string[] | undefined;
  /** Gauges only: on a water whose name contains this. */
  water?: string | undefined;
  /** Gauges only: at this class or above (-1..4). */
  minClass?: number | undefined;
  lang?: Lang | undefined;
}

/** A warning or gauge the map leaves out: it has no usable geometry. */
export interface LeftOff {
  id: string;
  class: number | string | null;
  className?: string;
  area?: string;
}

/** The answer of {@link getFloodMap}: a GeoJSON FeatureCollection with what it leaves out named. */
export interface FloodMap {
  status: "ok" | "empty";
  searched: { layer: MapLayer; states?: string[]; water?: string; minClass?: number };
  type: "FeatureCollection";
  /** [west, south, east, north] around the features (RFC 7946), absent without any. */
  bbox?: number[];
  features: GeoJsonFeature[];
  /** Left off the map: no usable geometry. A map without them reads as complete; say so. */
  leftOff: LeftOff[];
  reason?: string;
  attribution: Attribution;
  notes: string[];
}

/**
 * Alert areas (Polygons, river reaches as LineStrings; `lhpClass` the alerts scale, a string) or
 * gauges (Points; `lhpClass` the station scale, a number, absent when unclassified) as GeoJSON
 * features in [longitude, latitude], with the bbox and the attribution, and the items without a
 * usable geometry named (worst first). `water` and `minClass` filter gauges only; on the alerts
 * layer they are refused, never ignored.
 */
export async function getFloodMap(client: HochwasserzentralenClient, input: FloodMapInput): Promise<FloodMap> {
  if (!(MAP_LAYERS as readonly unknown[]).includes(input.layer)) {
    throw new HochwasserzentralenValidationError(`Invalid layer: expected ${MAP_LAYERS.join(" or ")}.`);
  }
  if (input.layer === "alerts" && (input.water !== undefined || input.minClass !== undefined)) {
    throw new HochwasserzentralenValidationError("Invalid filter: water and minClass apply to the gauges layer only; the alerts layer takes states.");
  }
  const states = input.states === undefined ? undefined : resolveStates(input.states);
  const lang = input.lang === undefined ? {} : { lang: input.lang };
  const scope = { ...(states === undefined ? {} : { states }) };
  if (input.layer === "alerts") {
    const res = await client.alerts({ ...scope, ...lang });
    const fc = alertsToGeoJson(res);
    const leftOff = alertsWithoutGeometry(res)
      .map((a) => ({ id: a.id, class: alertClass(a), ...(a.lhpClassName === undefined ? {} : { className: a.lhpClassName }), ...(a.areaDesc === undefined ? {} : { area: a.areaDesc }) }))
      .sort((a, b) => (b.class ?? 99) - (a.class ?? 99));
    const notes = [...envelopeNotes(input.lang, res), "Alert lhpClass is the alerts scale as a string: \"6\" Sehr großes, \"5\" Großes Hochwasser, \"4\" Hochwasser, \"2\" Vorwarnung, \"1\" Entwarnung (all-clear). Style river reaches (LineString) as lines."];
    return mapAnswer({ layer: "alerts", ...scope }, fc.features, leftOff, attributionOf(res), notes, `No alert area in ${scopeOf(states)}: no active official flood warning to map.`);
  }
  const water = input.water === undefined ? undefined : normalizeText(assertValid("water", input.water, textProblem));
  const minClass = input.minClass === undefined ? undefined : assertValid("minClass", input.minClass, minClassProblem as Problem<number>);
  const filters = { ...(water === undefined ? {} : { water }), ...(minClass === undefined ? {} : { minClass }) };
  const res = await client.stations({ ...scope, ...filters, ...lang });
  const fc = stationsToGeoJson(res);
  const leftOff = stationsWithoutCoordinates(res).map((s) => ({ id: s.id, class: s.lhpClass ?? null, ...(s.name === undefined ? {} : { area: s.name }) }));
  const notes = [...envelopeNotes(input.lang, res), "Gauge lhpClass is the station scale as a number: 4..1 flooding, 0 none, -1 no data; a gauge without a flood classification has no lhpClass. Never style both layers with one colour ramp."];
  if (res.data.some((s) => typeof s.stateClassName === "string" && /&#?\w+;/.test(s.stateClassName))) {
    notes.push("Some stateClassName labels carry HTML entities as the API sends them (Rheinland-Pfalz: \"&#60;\" is \"<\"); decode them for a label.");
  }
  const sites = new Set(fc.features.map((f) => JSON.stringify((f.geometry as { coordinates?: unknown }).coordinates))).size;
  if (sites < fc.features.length) notes.push(`Border gauges are two points on one spot: ${fc.features.length} features, ${sites} sites.`);
  const reason =
    minClass !== undefined && minClass >= 1 && water === undefined
      ? `No gauge in ${scopeOf(states)} at class ${minClass} or above: nothing flooding to map.`
      : `No gauge in ${scopeOf(states)} matches${water === undefined ? "" : ` the water ${JSON.stringify(water)}`}${minClass === undefined ? "" : ` at class ${minClass} or above`}.`;
  return mapAnswer({ layer: "gauges", ...scope, ...filters }, fc.features, leftOff, attributionOf(res), notes, reason);
}

function mapAnswer(searched: FloodMap["searched"], features: GeoJsonFeature[], leftOff: LeftOff[], attribution: Attribution, notes: string[], emptyReason: string): FloodMap {
  const bbox = featuresBbox(features);
  return {
    status: features.length === 0 && leftOff.length === 0 ? "empty" : "ok",
    searched,
    type: "FeatureCollection",
    ...(bbox === undefined ? {} : { bbox }),
    features,
    leftOff,
    ...(features.length === 0 && leftOff.length === 0 ? { reason: emptyReason } : {}),
    attribution,
    notes,
  };
}

/** An object without its undefined members. */
function prune<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
