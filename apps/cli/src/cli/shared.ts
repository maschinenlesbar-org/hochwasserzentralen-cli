// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON / GeoJSON renderers.

import { constants } from "node:buffer";
import type { Command } from "commander";
import { InvalidArgumentError, Option } from "commander";
import { OutputError, isDirectoryError, logOf, nodeFiles, refuseOverwrite, writeFailure, type CliDeps } from "./io.js";
import type { HochwasserzentralenClientOptions } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/client";
import { HochwasserzentralenParseError, HochwasserzentralenValidationError } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/errors";
import { DEFAULT_BASE_URL, cleartextProblem, isBidiControl, type RetryEvent } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/engine";
import { baseUrlProblem, headerValueProblem, minClassProblem, nonBlankProblem, statesProblem } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/validate";
import { normalizeStates } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/client";
import type { GeoJsonFeatureCollection } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/geojson";

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

/**
 * Check `-o` before any request, so a refused target costs none (exit 2): `--force` without
 * `-o` is a usage error (`hochwasser.cli`); a directory, an existing path (a symlink, even
 * a dangling one) without `--force`, and a file whose directory is missing, not a directory or
 * not writable (`parentProblem`) are refused (`hochwasser.output`). A stream (`/dev/null`, a
 * FIFO, `/dev/stdout`, `>(…)`) needs no `--force`: it is written in place. `-o -` is stdout, also
 * with `--force`. The write checks again: a file (or directory) that appears during the
 * request is not overwritten either, a failed write then (exit 1).
 */
export function checkOutputTarget(deps: CliDeps, global: GlobalOptions): void {
  if (global.force === true && global.output === undefined) {
    throw new HochwasserzentralenValidationError("--force needs --output (it only allows overwriting the -o file).");
  }
  if (global.output === undefined || global.output === "-") return;
  const files = deps.files ?? nodeFiles;
  const state = files.state(global.output);
  if (state === "directory") throw isDirectoryError(global.output);
  // A device, a FIFO or `/dev/stdout` is written in place: nothing in it can be lost.
  if (state === "stream") return;
  if (state === "exists" && global.force !== true) throw refuseOverwrite(global.output);
  const problem = files.parentProblem(global.output, global.force === true);
  if (problem !== undefined) throw new OutputError(problem, { refused: true });
}

/**
 * Write bytes to the --output file through the file seam (`nodeFiles`: atomic, an exclusive
 * claim without --force, the old file's mode kept, --force writes through a symlink). Every
 * failure is an OutputError logged under `hochwasser.output` and exits 1 (a path that
 * appeared during the request too; only the check before the request exits 2); whatever
 * else a custom seam throws becomes a failed write, never an untyped "Unexpected error".
 */
function writeOutputFile(deps: CliDeps, global: GlobalOptions, path: string, data: Buffer): void {
  try {
    (deps.files ?? nodeFiles).write(path, data, global.force === true);
  } catch (err) {
    throw err instanceof OutputError ? err : writeFailure(path, err);
  }
}

/** True for a UTF-16 unit `escapeControlChars` writes as `\uXXXX`. */
function escaped(c: number): boolean {
  return (c >= 0x7f && c <= 0x9f) || isBidiControl(c);
}

/** How many input characters `escapeControlChars` turns into one piece of output at a time. */
const ESCAPE_CHUNK = 1 << 16;

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them.
 * It escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is
 * the 8-bit form of CSI) or the bidi formatting characters (isBidiControl), which
 * reorder the text that follows. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 *
 * Each such character becomes six, so the output is measured first: one longer than V8's
 * longest string is a HochwasserzentralenParseError ("too large to print"), before anything is
 * built. Then the output is built in chunks of ESCAPE_CHUNK characters, each made flat at once,
 * and joined once: one `+=` per character made a rope of 100 M pieces on an answer of DEL
 * characters, and the process died of a heap out-of-memory crash.
 */
export function escapeControlChars(json: string): string {
  let count = 0;
  for (let i = 0; i < json.length; i++) if (escaped(json.charCodeAt(i))) count++;
  if (count === 0) return json;
  const length = json.length + 5 * count;
  if (length > MAX_TEXT_LENGTH) {
    throw new HochwasserzentralenParseError(
      `The answer is too large to print (${length} characters once its control characters are escaped).`,
    );
  }
  const chunks: string[] = [];
  for (let start = 0; start < json.length; start += ESCAPE_CHUNK) {
    const end = Math.min(start + ESCAPE_CHUNK, json.length);
    const parts: string[] = [];
    let from = start;
    for (let i = start; i < end; i++) {
      const c = json.charCodeAt(i);
      if (!escaped(c)) continue;
      parts.push(json.slice(from, i), "\\u" + c.toString(16).padStart(4, "0"));
      from = i + 1;
    }
    parts.push(json.slice(from, end));
    chunks.push(parts.join(""));
  }
  return chunks.join("");
}

/** The longest string V8 makes (2^29 - 24 characters on 64-bit): a longer JSON text can't be printed at once. */
const MAX_TEXT_LENGTH = constants.MAX_STRING_LENGTH;

/**
 * JSON.stringify, pretty or compact. Printing can fail two ways, both a
 * HochwasserzentralenParseError (an answer the CLI can't use, logged under `hochwasser.api`,
 * exit 1) that names the cause, never "Unexpected error":
 * - an answer nested too deeply (hostile or broken) overflows the stack: "nested too deeply";
 * - a text longer than V8's longest string ("Invalid string length"): "too large to print".
 * "try --compact" is added only when the compact form of this very answer prints: it is probed,
 * not assumed, because whether compact output survives deep nesting depends on the Node version
 * (on Node 26 only the fast path is iterative) and on the machine's stack.
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on Node 26
 * the fast path aborts the process ("Zone Allocation failed", exit 134, a native dump on stderr)
 * on a string of some 250 MB that JSON.parse made, while the gap path (an empty gap, the same
 * text) prints it. The fast path stays the default because on Node 26 only it is iterative and
 * prints nesting the gap path refuses (~7,000 levels).
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? stringifyCompact(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    const deep = /call stack/i.test(err.message);
    const cause = deep ? "nested too deeply" : `too large (more than ${MAX_TEXT_LENGTH} characters of JSON)`;
    const hint = !compact && compactPrints(value) ? "; try --compact" : "";
    throw new HochwasserzentralenParseError(`The answer is ${cause} to ${compact ? "print" : "pretty-print"}${hint}.`, { cause: err });
  }
}

/** Compact JSON: the fast path, or the gap path for an answer holding a huge string. */
function stringifyCompact(value: unknown): string {
  return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
}

/** Whether `--compact` prints this answer on this runtime (the hint after a failed pretty-print). */
function compactPrints(value: unknown): boolean {
  try {
    return stringifyCompact(value).length <= MAX_TEXT_LENGTH;
  } catch {
    return false;
  }
}

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/**
 * Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting
 * costs no stack, linear, and without an allocation per value: an array is walked by index, an
 * object by `for…in` (own keys only: an answer's objects have none inherited), and only nested
 * objects and arrays are kept for later. (`Object.entries` made a pair per element: on an array
 * of 48M numbers that took 7 GB and crashed.)
 */
function holdsHugeString(value: unknown): boolean {
  if (typeof value === "string") return value.length >= HUGE_STRING_LENGTH;
  const pending: object[] = [];
  if (typeof value === "object" && value !== null) pending.push(value);
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        const element: unknown = item[i];
        if (typeof element === "string") {
          if (element.length >= HUGE_STRING_LENGTH) return true;
        } else if (typeof element === "object" && element !== null) pending.push(element);
      }
      continue;
    }
    const record = item as Record<string, unknown>;
    for (const key in record) {
      if (key.length >= HUGE_STRING_LENGTH) return true;
      const element = record[key];
      if (typeof element === "string") {
        if (element.length >= HUGE_STRING_LENGTH) return true;
      } else if (typeof element === "object" && element !== null) pending.push(element);
    }
  }
  return false;
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

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
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
    // Refuse a bad --output target before any request, so the refusal costs no download
    // (and no wait up to --timeout). writeOutputFile checks again at write time with an
    // exclusive create, which also catches a file that appears meanwhile.
    checkOutputTarget(deps, global);
    // `-o -` means stdout, as in other Unix tools: from here on it is the same as no -o
    // (it used to create a file named "-", and the next run refused to overwrite it).
    if (global.output === "-") delete global.output;
    const options = toEngineOptions(global);
    options.onRetry = (event) => logOf(deps).warn("http", retryMessage(event));
    // An answer delivered changed (invalid text replaced with U+FFFD) is never silent.
    options.onWarning = (message) => logOf(deps).warn("api", message);
    const client = deps.createClient(options);
    // One warning per run, before the first request, when the base URL is plain http: to
    // a host other than loopback. Help, version and usage errors never get here.
    const cleartext = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
    if (cleartext !== undefined) logOf(deps).warn("http", cleartext);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
