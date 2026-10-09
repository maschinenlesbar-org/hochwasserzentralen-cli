// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON / GeoJSON renderers.

import type { Command } from "commander";
import { InvalidArgumentError, Option } from "commander";
import { logOf, type CliDeps } from "./io.js";
import type { HochwasserzentralenClientOptions } from "../client/client.js";
import { HochwasserzentralenError, HochwasserzentralenValidationError } from "../client/errors.js";
import { DEFAULT_BASE_URL, cleartextProblem, isBidiControl } from "../client/engine.js";
import { baseUrlProblem, headerValueProblem, minClassProblem, nonBlankProblem, statesProblem } from "../client/validate.js";
import { normalizeStates } from "../client/client.js";
import type { GeoJsonFeatureCollection } from "../client/geojson.js";

/**
 * commander value-parser: a plain base-10 non-negative integer.
 *
 * Uses a strict regex rather than `Number()` coercion, which would otherwise
 * accept empty/whitespace strings (`Number("") === 0`), hex/binary/scientific
 * literals, signs, padding and decimals.
 */
export function parseIntArg(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/** Build a commander value-parser for an integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    return n;
  };
}

/** commander value-parser: a non-empty (after trimming) string. */
export function parseNonEmpty(value: string): string {
  const problem = nonBlankProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * Wrap a commander value-parser for a single-valued option so that a second
 * occurrence is a usage error. commander otherwise keeps only the last value, so
 * `--min-class 3 --min-class 1` silently became `--min-class 1`. (The option must have
 * no default: commander passes the default as `previous` on the first occurrence.)
 */
export function once<T>(parse: (value: string) => T): (value: string, previous: T | undefined) => T {
  return (value, previous) => {
    if (previous !== undefined) {
      throw new InvalidArgumentError("Given more than once; this option takes a single value.");
    }
    return parse(value);
  };
}

/** An Option constrained to a fixed set of choices, given at most once. */
export function choiceOption(flags: string, description: string, choices: readonly string[]): Option {
  const option = new Option(flags, description).choices([...choices]);
  // Keep commander's choice check (and the choices in --help), and reject a repeat.
  const check = option.parseArg as (value: string, previous: unknown) => string;
  return option.argParser(once((value: string) => check(value, undefined)));
}

/**
 * commander value-parser for `-o, --output <file>`. A blank or whitespace-only path
 * is a usage error: `-o ""` used to print to stdout silently. `-` is kept as is and
 * means stdout (see {@link action}).
 */
export function parseOutputPath(value: string): string {
  return parseNonEmpty(value);
}

/**
 * commander value-parser for --states: a comma-separated list of state codes. The
 * only CLI step is the comma split; the rule ({@link statesProblem}) and the
 * normalisation ({@link normalizeStates}: trim, upper case, de-duplicate) are the
 * library's, so a typo fails at parse time (exit 2) with the library's message
 * instead of becoming a silently-dropped filter that returns the nationwide set.
 */
export function parseStates(value: string): string[] {
  const codes = value.split(",");
  const problem = statesProblem(codes);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return normalizeStates(codes);
}

/**
 * commander value-parser for --min-class: an integer on the station lhpClass
 * scale, -1 (no data) .. 4 (Sehr großes Hochwasser) — the library's
 * {@link minClassProblem}. The argv text must be a plain integer (a leading minus
 * for -1, otherwise as strict as parseIntArg) before it is converted.
 */
export function parseMinClass(value: string): number {
  const n = /^-?[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  const problem = minClassProblem(n);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return n;
}

/**
 * commander value-parser for --base-url. The base URL is trusted input, but it must
 * pass the library's {@link baseUrlProblem} (non-blank, a URL, `http:`/`https:`
 * only, no query or fragment), so a bad value fails at parse time (exit 2) with a
 * clear message rather than deep in the transport. The CLI keeps no rules of its own.
 */
export function parseBaseUrl(value: string): string {
  const problem = baseUrlProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (User-Agent).
 * The rule is the library's {@link headerValueProblem} — blank, control characters
 * other than tab, and characters above U+00FF are rejected — so a bad value is a
 * usage error (exit 2) here instead of an opaque failure at request time.
 */
export function parseHeaderValue(value: string): string {
  const problem = headerValueProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
  output?: string;
  force?: boolean;
}

/**
 * Translate resolved global CLI options into client options. Every value that is
 * set is handed through as is; the library owns the rules and the defaults (only
 * an omitted userAgent selects the default, a blank one is rejected).
 */
export function toEngineOptions(global: GlobalOptions): HochwasserzentralenClientOptions {
  const options: HochwasserzentralenClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

function refuseOverwrite(path: string): HochwasserzentralenValidationError {
  return new HochwasserzentralenValidationError(
    `Refusing to overwrite existing file "${path}". Pass --force to overwrite, or choose a different --output path.`,
  );
}

/**
 * Write bytes to the --output file, refusing to clobber an existing file — or to
 * write through a symlink, dangling or not — unless --force is set (fail-secure: no
 * silent data loss), and wrapping raw filesystem errors in a typed error instead of
 * an untyped "Unexpected error: ENOENT: …". The overwrite refusal is a usage
 * condition (fix: pass --force or pick another path), so it maps to exit code 2 via
 * HochwasserzentralenValidationError.
 */
function writeOutputFile(deps: CliDeps, global: GlobalOptions, path: string, data: Buffer): void {
  const force = global.force === true;
  if (!force && deps.io.fileExists(path)) throw refuseOverwrite(path);
  try {
    // Without --force the write is an exclusive create, so a symlink (even a
    // dangling one) or a file that appeared since the check is refused too.
    deps.io.writeFile(path, data, force);
  } catch (err) {
    if (!force && (err as NodeJS.ErrnoException | undefined)?.code === "EEXIST") throw refuseOverwrite(path);
    // A bad --output path (missing directory, a directory, no permission) is a
    // user error, not an internal fault — surface it cleanly. Drop the
    // `, open '<path>'` tail since we already name the path ourselves.
    const reason = err instanceof Error ? err.message.replace(/,\s*open\s+'.*'$/, "") : String(err);
    throw new HochwasserzentralenError(`Could not write to ${path}: ${reason}`);
  }
}

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them.
 * It escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is
 * the 8-bit form of CSI) or the bidi formatting characters (isBidiControl), which
 * reorder the text that follows. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if ((c >= 0x7f && c <= 0x9f) || isBidiControl(c)) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. A deeply nested value (a hostile or broken
 * response) overflows the stack — the pretty form far sooner than the compact one,
 * which is why the message suggests --compact. The RangeError becomes a
 * HochwasserzentralenError so the CLI prints a clear message (exit 1) instead of
 * "Unexpected error: Maximum call stack size exceeded".
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new HochwasserzentralenError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Render a JSON value, pretty by default and compact with --compact. Writes to the
 * file given by --output (with a short stderr confirmation so stdout stays clean
 * for piping), or to stdout otherwise. An existing --output file is never silently
 * overwritten — pass --force.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  if (global.output) {
    const data = Buffer.from(text + "\n", "utf8");
    writeOutputFile(deps, global, global.output, data);
    logOf(deps).info("output", `Wrote ${data.length} bytes to ${global.output}`);
  } else {
    deps.io.out(text);
  }
}

/** What a GeoJSON export left out: how many items, of what kind, why, and which. */
export interface GeoJsonSkipped {
  /** Singular and plural noun, e.g. ["alert", "alerts"]. */
  noun: [string, string];
  /** Why they were left out, e.g. "no usable geometry". */
  reason: string;
  /** One short, printable label per item left out (id, class). */
  labels: string[];
}

/**
 * Render a GeoJSON FeatureCollection. Same rules as renderJson, but the file
 * confirmation reports the FEATURE COUNT alongside the byte count so the user
 * knows what was exported without opening the file. Items the converter left out
 * (`skipped`) are named on stderr — to stdout and to a file alike — so a map that
 * lacks a warning never looks complete.
 */
export function renderGeoJson(
  deps: CliDeps,
  global: GlobalOptions,
  fc: GeoJsonFeatureCollection,
  skipped?: GeoJsonSkipped,
): void {
  const text = escapeControlChars(stringifyJson(fc, global.compact === true));
  const left = skipped !== undefined && skipped.labels.length > 0 ? skipped : undefined;
  const leftCount = left === undefined ? "" : `${left.labels.length} ${left.noun[left.labels.length === 1 ? 0 : 1]}`;
  if (global.output) {
    const data = Buffer.from(text + "\n", "utf8");
    writeOutputFile(deps, global, global.output, data);
    logOf(deps).info(
      "output",
      `Wrote ${fc.features.length} feature${fc.features.length === 1 ? "" : "s"} (${data.length} bytes) to ${global.output}` +
        (left === undefined ? "" : `; ${leftCount} skipped (${left.reason})`),
    );
  } else {
    deps.io.out(text);
  }
  if (left !== undefined) {
    const shown = left.labels.slice(0, 20).join(", ");
    const more = left.labels.length > 20 ? `, and ${left.labels.length - 20} more` : "";
    logOf(deps).info("output", `${leftCount} left off the map (${left.reason}): ${shown}${more}`);
  }
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    // `-o -` means stdout, as in other Unix tools: from here on it is the same as no -o
    // (it used to create a file named "-", and the next run refused to overwrite it).
    if (global.output === "-") delete global.output;
    // Refuse an existing --output file before any request, so the refusal costs no
    // download (and no wait up to --timeout). writeOutputFile checks again at write
    // time with an exclusive create, which also catches a file that appears meanwhile.
    if (global.output !== undefined && global.force !== true && deps.io.fileExists(global.output)) {
      throw refuseOverwrite(global.output);
    }
    const client = deps.createClient(toEngineOptions(global));
    // One warning per run, before the first request, when the base URL is plain http: to
    // a host other than loopback. Help, version and usage errors never get here.
    const cleartext = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
    if (cleartext !== undefined) logOf(deps).warn("http", cleartext);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
