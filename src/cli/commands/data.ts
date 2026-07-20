// The three commands over the LHP-PublicAPI: `alerts` and `stations` fetch one
// endpoint each and print the full envelope (which carries the CC-BY-required
// `source*` / `licence*` / `updated` fields — they are deliberately never
// stripped); `situation` is an offline aggregation over /data/stations.
//
// Client-side filters (--water / --min-class) filter the envelope's `data` array
// in place, so the surrounding attribution + timestamp always survive.

import type { Command } from "commander";
import { Option } from "commander";
import type { CliDeps } from "../io.js";
import { action, parseMinClass, parseNonEmpty, parseStates, renderGeoJson, renderJson } from "../shared.js";
import { LANGS, STATION_CLASS_NAMES, type Lang, type Station, type StationsResponse } from "../../client/types.js";
import { alertsToGeoJson, stationsToGeoJson } from "../../client/geojson.js";

/** The shared --states option (validated comma-separated list, e.g. BY,SN). */
function statesOption(): Option {
  return new Option(
    "--states <codes>",
    "only these states — comma-separated codes, e.g. BY,SN (case-insensitive)",
  ).argParser(parseStates);
}

/** The shared --lang option, validated by commander's own .choices(). */
function langOption(): Option {
  return new Option("--lang <lang>", `response language: ${LANGS.join(" | ")}`).choices([...LANGS]);
}

/** Read the states/lang pair off a parsed-options object. */
function commonParams(opts: Record<string, unknown>): { states?: string[]; lang?: Lang } {
  return {
    ...(opts["states"] !== undefined ? { states: opts["states"] as string[] } : {}),
    ...(opts["lang"] !== undefined ? { lang: opts["lang"] as Lang } : {}),
  };
}

/** The state code a station belongs to: "DE-BE" -> "BE", else the id prefix ("BE_5803500" -> "BE"). */
function stateOf(station: Station): string {
  if (typeof station.stateId === "string" && station.stateId.startsWith("DE-")) {
    return station.stateId.slice(3);
  }
  const idx = station.id.indexOf("_");
  return idx > 0 ? station.id.slice(0, idx) : station.id;
}

interface StateSituation {
  state: string;
  stateId: string;
  stations: number;
  worstClass: number;
  worstClassName: string;
  /** Station count per lhpClass, keys "-1".."4" (always all six, zero-filled). */
  classes: Record<string, number>;
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

/** Aggregate /data/stations into a per-state overview (pure; unit-tested via the CLI). */
export function aggregateSituation(res: StationsResponse): {
  title: string;
  source: string;
  sourceName: string;
  licence: string;
  licenceName: string;
  updated: string;
  totalStations: number;
  worstClass: number;
  worstClassName: string;
  states: StateSituation[];
} {
  const nameOf = classNamer(res);
  const emptyClasses = (): Record<string, number> => ({ "-1": 0, "0": 0, "1": 0, "2": 0, "3": 0, "4": 0 });

  const byState = new Map<string, StateSituation>();
  for (const s of res.data) {
    const state = stateOf(s);
    let entry = byState.get(state);
    if (!entry) {
      entry = {
        state,
        stateId: s.stateId ?? `DE-${state}`,
        stations: 0,
        worstClass: -1,
        worstClassName: nameOf(-1),
        classes: emptyClasses(),
      };
      byState.set(state, entry);
    }
    entry.stations += 1;
    // Clamp anything outside the documented -1..4 scale into "-1" (no data)
    // rather than inventing new buckets.
    const cls = Number.isInteger(s.lhpClass) && s.lhpClass >= -1 && s.lhpClass <= 4 ? s.lhpClass : -1;
    entry.classes[String(cls)] = (entry.classes[String(cls)] ?? 0) + 1;
    if (cls > entry.worstClass) {
      entry.worstClass = cls;
      entry.worstClassName = nameOf(cls);
    }
  }

  // Worst first, then alphabetically — the flooded states lead the overview.
  const states = [...byState.values()].sort(
    (a, b) => b.worstClass - a.worstClass || a.state.localeCompare(b.state),
  );
  const worstClass = states.length > 0 ? Math.max(...states.map((s) => s.worstClass)) : -1;

  return {
    title: "Hochwasser-Lageübersicht (aggregiert aus /data/stations)",
    source: res.source,
    sourceName: res.sourceName,
    licence: res.licence,
    licenceName: res.licenceName,
    updated: res.updated,
    totalStations: res.data.length,
    worstClass,
    worstClassName: nameOf(worstClass),
    states,
  };
}

export function registerCommands(program: Command, deps: CliDeps): void {
  program
    .command("alerts")
    .description("Current regional flood alerts (Hochwasser-Warnungen) of the German states")
    .addOption(statesOption())
    .option("--cap", "include the Common Alerting Protocol (CAP) detail block per alert")
    .addOption(langOption())
    .option("--geojson", "output the alert areas as a GeoJSON FeatureCollection")
    .action(
      action(deps, async ({ client, global, opts }) => {
        const res = await client.alerts({
          ...commonParams(opts),
          ...(opts["cap"] === true ? { cap: true } : {}),
        });
        if (opts["geojson"] === true) renderGeoJson(deps, global, alertsToGeoJson(res));
        else renderJson(deps, global, res);
      }),
    );

  program
    .command("stations")
    .description("Flood classification at the ~1200 LHP gauges (no water levels — see pegel-online-cli)")
    .addOption(statesOption())
    .addOption(langOption())
    .option(
      "--water <name>",
      "only stations whose water (river) name contains this text, case-insensitive",
      parseNonEmpty,
    )
    .option(
      "--min-class <n>",
      "only stations with lhpClass >= n (-1 no data .. 4 sehr großes Hochwasser)",
      parseMinClass,
    )
    .option("--geojson", "output the stations as a GeoJSON FeatureCollection of points")
    .action(
      action(deps, async ({ client, global, opts }) => {
        const res = await client.stations(commonParams(opts));
        // Client-side filters. Field types are guarded so a filter never silently
        // matches nothing because of a non-string/non-number field.
        const water = opts["water"] as string | undefined;
        if (water !== undefined) {
          const needle = water.trim().toLowerCase();
          res.data = res.data.filter(
            (s) => typeof s.water === "string" && s.water.toLowerCase().includes(needle),
          );
        }
        const minClass = opts["minClass"] as number | undefined;
        if (minClass !== undefined) {
          res.data = res.data.filter((s) => typeof s.lhpClass === "number" && s.lhpClass >= minClass);
        }
        if (opts["geojson"] === true) renderGeoJson(deps, global, stationsToGeoJson(res));
        else renderJson(deps, global, res);
      }),
    );

  program
    .command("situation")
    .description("Per-state overview aggregated from the gauges: station count per lhpClass + worst class")
    .addOption(statesOption())
    .addOption(langOption())
    .action(
      action(deps, async ({ client, global, opts }) => {
        const res = await client.stations(commonParams(opts));
        renderJson(deps, global, aggregateSituation(res));
      }),
    );
}
