// The three commands over the LHP-PublicAPI: `alerts` and `stations` fetch one
// endpoint each and print the full envelope (which carries the CC-BY-required
// `source*` / `licence*` / `updated` fields — they are deliberately never
// stripped); `situation` renders the library's per-state aggregation over
// /data/stations (client.situation()).
//
// Client-side filters (--water / --min-class) filter the envelope's `data` array
// in place, so the surrounding attribution + timestamp always survive.

import type { Command } from "commander";
import { Option } from "commander";
import type { CliDeps } from "../io.js";
import { action, parseMinClass, parseNonEmpty, parseStates, renderGeoJson, renderJson } from "../shared.js";
import { LANGS, type Lang } from "../../client/types.js";
import { alertsToGeoJson, stationsToGeoJson } from "../../client/geojson.js";
import { stationClass } from "../../client/stations.js";

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

/**
 * Fold a water name for the case-insensitive --water match: NFC (a decomposed
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
    .description("Flood classification at the LHP gauges (no water levels — see pegel-online-cli)")
    .addOption(statesOption())
    .addOption(langOption())
    .option(
      "--water <name>",
      "only stations whose water (river) name contains this text (case-insensitive; ß = ss, umlauts in any Unicode form)",
      parseNonEmpty,
    )
    .option(
      "--min-class <n>",
      "only stations with lhpClass >= n (-1 no data .. 4 sehr großes Hochwasser; gauges without a class are dropped)",
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
          const needle = foldName(water.trim());
          res.data = res.data.filter((s) => typeof s.water === "string" && foldName(s.water).includes(needle));
        }
        const minClass = opts["minClass"] as number | undefined;
        if (minClass !== undefined) {
          res.data = res.data.filter((s) => {
            const cls = stationClass(s);
            return cls !== null && cls >= minClass;
          });
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
        renderJson(deps, global, await client.situation(commonParams(opts)));
      }),
    );
}
