// The three commands over the LHP-PublicAPI: `alerts` and `stations` fetch one
// endpoint each and print the full envelope (which carries the CC-BY-required
// `source*` / `licence*` / `updated` fields — they are deliberately never
// stripped); `situation` renders the library's per-state aggregation over
// /data/stations (client.situation()).
//
// The client-side filters (--water / --min-class) are the library's
// (client.stations({ water, minClass })); they filter only the envelope's `data`
// array, so the surrounding attribution + timestamp always survive.

import type { Command } from "commander";
import { Option } from "commander";
import type { CliDeps } from "../io.js";
import {
  action,
  choiceOption,
  once,
  parseMinClass,
  parseNonEmpty,
  parseStates,
  renderGeoJson,
  renderJson,
} from "../shared.js";
import { LANGS, type Lang } from "../../client/types.js";
import {
  alertsToGeoJson,
  alertsWithoutGeometry,
  stationsToGeoJson,
  stationsWithoutCoordinates,
} from "../../client/geojson.js";
import { sanitizeServerText } from "../../client/engine.js";
import { cutText } from "../../client/errors.js";

/**
 * The shared --states option (validated comma-separated list, e.g. BY,SN). A
 * repeated option adds to the list (`--states BY --states SN` = `--states BY,SN`)
 * instead of silently keeping only the last value.
 */
function statesOption(): Option {
  return new Option(
    "--states <codes>",
    "only these states — comma-separated codes, e.g. BY,SN (case-insensitive; repeatable)",
  ).argParser((value: string, previous: string[] | undefined) => {
    const merged = [...(previous ?? [])];
    for (const code of parseStates(value)) if (!merged.includes(code)) merged.push(code);
    return merged;
  });
}

/** The shared --lang option, validated by commander's own .choices(), given at most once. */
function langOption(): Option {
  return choiceOption("--lang <lang>", `response language: ${LANGS.join(" | ")}`, LANGS);
}

/**
 * A short label for an item a GeoJSON export left out: its id, class and name (server
 * text, so sanitised and cut on a character boundary), e.g. `BY_577 (class 6, Sehr großes Hochwasser, Donau)`.
 */
function label(id: unknown, lhpClass: unknown, ...names: unknown[]): string {
  const text = (v: unknown): string => cutText(sanitizeServerText(String(v)), 80);
  const parts: string[] = lhpClass === undefined || lhpClass === null ? [] : [`class ${text(lhpClass)}`];
  for (const name of names) if (typeof name === "string" && name.trim() !== "") parts.push(text(name));
  const detail = parts.join(", ");
  return `${id === undefined ? "(no id)" : text(id)}${detail === "" ? "" : ` (${detail})`}`;
}

/** Read the states/lang pair off a parsed-options object. */
function commonParams(opts: Record<string, unknown>): { states?: string[]; lang?: Lang } {
  return {
    ...(opts["states"] !== undefined ? { states: opts["states"] as string[] } : {}),
    ...(opts["lang"] !== undefined ? { lang: opts["lang"] as Lang } : {}),
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
        if (opts["geojson"] === true) {
          renderGeoJson(deps, global, alertsToGeoJson(res), {
            noun: ["alert", "alerts"],
            reason: "no usable geometry",
            labels: alertsWithoutGeometry(res).map((a) => label(a.id, a.lhpClass, a.lhpClassName, a.areaDesc)),
          });
        } else renderJson(deps, global, res);
      }),
    );

  program
    .command("stations")
    .description("Flood classification at the LHP gauges (no water levels — see pegel-online-cli)")
    .addOption(statesOption())
    .addOption(langOption())
    .option(
      "--water <name>",
      "only stations whose water (river) name contains this text (case-insensitive; ß = ss, ä/ö/ü = ae/oe/ue, any whitespace run = one space)",
      once(parseNonEmpty),
    )
    .option(
      "--min-class <n>",
      "only stations with lhpClass >= n (-1 no data .. 4 sehr großes Hochwasser; gauges without a class are dropped)",
      once(parseMinClass),
    )
    .option("--geojson", "output the stations as a GeoJSON FeatureCollection of points")
    .action(
      action(deps, async ({ client, global, opts }) => {
        // The library applies --water / --min-class (filterStations) after the fetch.
        const res = await client.stations({
          ...commonParams(opts),
          ...(opts["water"] !== undefined ? { water: opts["water"] as string } : {}),
          ...(opts["minClass"] !== undefined ? { minClass: opts["minClass"] as number } : {}),
        });
        if (opts["geojson"] === true) {
          renderGeoJson(deps, global, stationsToGeoJson(res), {
            noun: ["station", "stations"],
            reason: "no usable coordinates",
            labels: stationsWithoutCoordinates(res).map((s) => label(s.id, s.lhpClass, s.name)),
          });
        } else renderJson(deps, global, res);
      }),
    );

  program
    .command("situation")
    .description("Per-state overview aggregated from the gauges: station count per lhpClass + worst class")
    .addOption(statesOption())
    .addOption(langOption())
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(deps, global, await client.situation(commonParams(opts)));
      }),
    );
}
