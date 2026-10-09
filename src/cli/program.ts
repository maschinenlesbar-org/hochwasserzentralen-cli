// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { HochwasserzentralenClient } from "../client/client.js";
import { DEFAULT_BASE_URL, MAX_RETRIES } from "../client/engine.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { once, parseBaseUrl, parseBoundedInt, parseHeaderValue, parseIntArg, parseOutputPath } from "./shared.js";
import { registerCommands } from "./commands/data.js";
import { DEFAULT_LOG_FORMAT, logFormatProblem } from "./log.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new HochwasserzentralenClient(options),
};

/** commander value-parser for `--log-format`. */
function parseLogFormat(value: string): string {
  const problem = logFormatProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("hochwasser")
    .description(
      "CLI for the LHP-PublicAPI of hochwasserzentralen.de (Länderübergreifendes " +
        "Hochwasserportal). No API key needed. `alerts` shows the states' current " +
        "regional flood alerts (optionally with CAP detail); `stations` the flood " +
        "classification at the LHP gauges (classification only — measured water levels " +
        "live in pegel-online-cli); `situation` a per-state aggregate overview. " +
        "Data: CC BY 4.0 — outputs keep the source and `updated` timestamp fields " +
        "(see DATA_LICENSE.md).",
    )
    .version(VERSION)
    // Every value option takes one value: a repeat is a usage error (once), not "last
    // one wins". --base-url therefore has no commander default; the library's applies.
    .option(
      "--base-url <url>",
      `API base URL (default: ${DEFAULT_BASE_URL}; append /test for the LHP test system)`,
      once(parseBaseUrl),
    )
    .option(
      "--timeout <ms>",
      "time limit per request in ms, whole response included (0 = no timeout)",
      once(parseBoundedInt(0, MAX_TIMEOUT_MS)),
    )
    .option("--user-agent <ua>", "User-Agent header value", once(parseHeaderValue))
    .option(
      "--max-retries <n>",
      "retries for transient 429/503 responses and reset connections (0..10)",
      once(parseBoundedInt(0, MAX_RETRIES)),
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      once(parseIntArg),
    )
    .option(
      "--log-format <format>",
      `how errors, warnings and notes are written to stderr: text (log4j style: time, level, [topic], message) or jsonl (one JSON object per line: ts, level, topic, msg); default ${DEFAULT_LOG_FORMAT}`,
      once(parseLogFormat),
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .option("-o, --output <file>", "write output to this file instead of stdout (- = stdout)", once(parseOutputPath))
    .option("--force", "overwrite the --output file if it already exists")
    .showHelpAfterError();

  registerCommands(program, deps);

  return program;
}
