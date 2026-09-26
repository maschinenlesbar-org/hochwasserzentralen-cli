// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON / GeoJSON renderers.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { HochwasserzentralenClientOptions } from "../client/client.js";
import { HochwasserzentralenError, HochwasserzentralenValidationError } from "../client/errors.js";
import { STATE_CODES } from "../client/types.js";
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
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

/**
 * commander value-parser for --states: a comma-separated list of state codes.
 * Case-insensitive input is normalised to upper case; every code is validated
 * against the 16 known Bundesland codes so a typo fails at parse time (exit 2)
 * instead of becoming a silently-dropped filter that returns the nationwide set.
 */
export function parseStates(value: string): string[] {
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const code = raw.trim().toUpperCase();
    if (code === "") continue;
    if (!(STATE_CODES as readonly string[]).includes(code)) {
      throw new InvalidArgumentError(
        `Unknown state code "${raw.trim()}". Expected a comma-separated subset of: ${STATE_CODES.join(", ")}.`,
      );
    }
    if (!out.includes(code)) out.push(code);
  }
  if (out.length === 0) {
    throw new InvalidArgumentError(
      `Expected at least one state code (comma-separated subset of: ${STATE_CODES.join(", ")}).`,
    );
  }
  return out;
}

/**
 * commander value-parser for --min-class: an integer on the station lhpClass
 * scale, -1 (no data) .. 4 (Sehr großes Hochwasser). Accepts a leading minus for
 * -1 but otherwise stays as strict as parseIntArg.
 */
export function parseMinClass(value: string): number {
  if (!/^-?[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected an integer between -1 and 4.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < -1 || n > 4) {
    throw new InvalidArgumentError("Expected an integer between -1 and 4.");
  }
  return n;
}

/**
 * commander value-parser for --base-url. The base URL is trusted input, but only
 * `http:`/`https:` are accepted so a stray `file:`/`ftp:` value fails at parse
 * time (exit 2) with a clear message rather than deep in the transport.
 */
export function parseBaseUrl(value: string): string {
  if (value.trim() === "") throw new InvalidArgumentError("Expected a non-empty URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError("Expected a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidArgumentError("Only http: and https: base URLs are supported.");
  }
  // Paths are appended to the base URL as a string, so a query or fragment would
  // swallow every request path and the --states filter ("http://h/v1#f" requests
  // "/v1" for every command, "http://h/v1?x=1" requests "/v1?x=1/data/stations").
  if (/[?#]/.test(value)) {
    throw new InvalidArgumentError("A base URL cannot have a query (?) or fragment (#).");
  }
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (User-Agent).
 * Rejects control characters — a CR/LF (or other C0/DEL byte) would otherwise reach
 * Node's HTTP layer and throw an opaque `ERR_INVALID_CHAR`. Tab (0x09) is allowed;
 * checked by char code so the source stays free of control bytes.
 */
export function parseHeaderValue(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      throw new InvalidArgumentError("Value contains control characters.");
    }
  }
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

/** Translate resolved global CLI options into client options. */
export function toEngineOptions(global: GlobalOptions): HochwasserzentralenClientOptions {
  const options: HochwasserzentralenClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined && global.userAgent.trim().length > 0) {
    options.userAgent = global.userAgent;
  }
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Write bytes to the --output file, refusing to clobber an existing file unless
 * --force is set (fail-secure: no silent data loss), and wrapping raw filesystem
 * errors in a typed error instead of an untyped "Unexpected error: ENOENT: …".
 * The overwrite refusal is a usage condition (fix: pass --force or pick another
 * path), so it maps to exit code 2 via HochwasserzentralenValidationError.
 */
function writeOutputFile(deps: CliDeps, global: GlobalOptions, path: string, data: Buffer): void {
  if (!global.force && deps.io.fileExists(path)) {
    throw new HochwasserzentralenValidationError(
      `Refusing to overwrite existing file "${path}". Pass --force to overwrite, or choose a different --output path.`,
    );
  }
  try {
    deps.io.writeFile(path, data);
  } catch (err) {
    // A bad --output path (missing directory, a directory, no permission) is a
    // user error, not an internal fault — surface it cleanly. Drop the
    // `, open '<path>'` tail since we already name the path ourselves.
    const reason = err instanceof Error ? err.message.replace(/,\s*open\s+'.*'$/, "") : String(err);
    throw new HochwasserzentralenError(`Could not write to ${path}: ${reason}`);
  }
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * Render a JSON value, pretty by default and compact with --compact. Writes to the
 * file given by --output (with a short stderr confirmation so stdout stays clean
 * for piping), or to stdout otherwise. An existing --output file is never silently
 * overwritten — pass --force.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  if (global.output) {
    const data = Buffer.from(text + "\n", "utf8");
    writeOutputFile(deps, global, global.output, data);
    deps.io.err(`Wrote ${data.length} bytes to ${global.output}`);
  } else {
    deps.io.out(text);
  }
}

/**
 * Render a GeoJSON FeatureCollection. Same rules as renderJson, but the file
 * confirmation reports the FEATURE COUNT alongside the byte count so the user
 * knows what was exported without opening the file.
 */
export function renderGeoJson(deps: CliDeps, global: GlobalOptions, fc: GeoJsonFeatureCollection): void {
  const text = escapeControlChars(global.compact ? JSON.stringify(fc) : JSON.stringify(fc, null, 2));
  if (global.output) {
    const data = Buffer.from(text + "\n", "utf8");
    writeOutputFile(deps, global, global.output, data);
    deps.io.err(
      `Wrote ${fc.features.length} feature${fc.features.length === 1 ? "" : "s"} (${data.length} bytes) to ${global.output}`,
    );
  } else {
    deps.io.out(text);
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
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
