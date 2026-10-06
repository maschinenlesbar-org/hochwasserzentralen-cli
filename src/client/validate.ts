// Input validation shared by the library and the CLI. Every rule about what a
// request may contain lives in src/client as a pure, exported function, so the CLI
// calls the very same rule instead of keeping a copy.
//
// - A `Problem` returns the reason a value is invalid ("Expected a non-empty
//   value."), or `undefined` when it is valid. The CLI's commander parsers turn
//   that reason into an `InvalidArgumentError` (exit 2).
// - `assertValid` runs a `Problem` in the library and throws a
//   `HochwasserzentralenValidationError` ("Invalid <name>: <reason>") before any
//   request is made. Methods that return a promise call it inside the async body,
//   so they reject rather than throw synchronously; constructors throw.

import { HochwasserzentralenValidationError } from "./errors.js";
import { STATE_CODES } from "./types.js";

/** A validation rule: the reason `value` is invalid, or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Check `value` against `problem` and return it unchanged when it is valid.
 * Otherwise throw a {@link HochwasserzentralenValidationError} with the message
 * `Invalid <name>: <reason>`.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new HochwasserzentralenValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/**
 * An options object must be a plain object (or `undefined`, for "none") whose own keys
 * are all in `known`. A misspelled or unknown key (`States`, `timeout`, `minclass`), or a
 * `__proto__` key from `JSON.parse`, used to be ignored without a word, so
 * `stations({ Water: "elbe" })` returned every gauge in Germany. Returns a `Problem`
 * naming the first unknown key (cut, JSON-quoted) and the known ones.
 */
export function knownKeysProblem(known: readonly string[]): Problem<unknown> {
  return (value) => {
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "Expected an object.";
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) {
        return `Unknown key ${JSON.stringify(key.slice(0, 60))}; expected one of ${known.join(", ")}.`;
      }
    }
    return undefined;
  };
}

/**
 * A free-text or filter value must be a string with something besides whitespace
 * in it: a blank `water` filter would otherwise match every station (or none).
 */
export const nonBlankProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (value.trim() === "") return "Expected a non-empty value.";
  return undefined;
};

/**
 * A `minClass` filter must be an integer on the station lhpClass scale, -1 (no
 * data) .. 4 (Sehr großes Hochwasser).
 */
export const minClassProblem: Problem<unknown> = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= -1 && value <= 4
    ? undefined
    : "Expected an integer between -1 and 4.";

/**
 * A value that ends up in an HTTP header (the User-Agent, a default header) must
 * be a non-blank string of Latin-1 characters without control characters (tab is
 * allowed, as in HTTP). Node's HTTP layer would otherwise throw an opaque "Invalid
 * character in header content" at request time, and a custom transport would get
 * a CR/LF through (header injection). Checked by char code so the source stays
 * free of control bytes.
 */
export const headerValueProblem: Problem<unknown> = (value) => {
  const blank = nonBlankProblem(value);
  if (blank !== undefined) return blank;
  const text = value as string;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/** An HTTP header name must be a non-empty RFC 9110 token. */
export const headerNameProblem: Problem<unknown> = (value) =>
  typeof value === "string" && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)
    ? undefined
    : "Expected an HTTP header name (a token such as X-Request-Id).";

/**
 * Every rule for a base URL, in order: a non-blank string without surrounding
 * whitespace or control characters, a parseable URL, the `http:` or `https:` scheme,
 * no query or fragment, and userinfo that decodes. Request paths are appended to the
 * base URL as a string, so a `?` or `#` would swallow every path and the `states`
 * filter (`http://h/v1?x=1` requests `/v1?x=1/data/stations`, `http://h/v1#f`
 * requests `/v1`), and a trailing space would land in the path: `new URL()` trims
 * surrounding whitespace and drops tab/CR/LF silently, so the raw string is checked.
 * Node decodes a `user:password@` into the Authorization header and fails at request
 * time on a `%` that isn't an escape, so that is rejected here too (write a literal
 * `%` as `%25`). The reasons never echo the URL, so a credential in it cannot leak.
 */
export const baseUrlProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (value.trim() === "") return "Expected a non-empty URL.";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return "A base URL cannot contain control characters.";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected a valid URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http: and https: base URLs are supported.";
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};

/**
 * A list of state codes must name at least one of the 16 known codes and nothing
 * else (each entry trimmed and compared case-insensitively; blank entries are
 * skipped), so a typo never becomes a silently-dropped filter that returns the full
 * nationwide set. `normalizeStates` returns the canonical form.
 */
export const statesProblem: Problem<readonly string[]> = (states) => {
  let usable = false;
  for (const raw of states as readonly unknown[]) {
    if (typeof raw !== "string") return "Expected an array of state codes.";
    const code = raw.trim().toUpperCase();
    if (code === "") continue;
    if (!(STATE_CODES as readonly string[]).includes(code)) {
      return `Unknown state code "${raw.trim()}". Expected one of: ${STATE_CODES.join(", ")}.`;
    }
    usable = true;
  }
  return usable ? undefined : `No usable state code given. Expected one or more of: ${STATE_CODES.join(", ")}.`;
};
