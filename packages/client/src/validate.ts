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

import { HochwasserzentralenValidationError, cutForMessage, cutText, quoteValue } from "./errors.js";
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
  if (reason !== undefined) throw new HochwasserzentralenValidationError(`Invalid ${name}: ${cutForMessage(reason)}`);
  return value;
}

/**
 * A response handed to one of the exported pure transforms (`filterStations`,
 * `aggregateSituation`, `onlyStates`, the GeoJSON converters) must be an object with a
 * `data` array of objects, as the client returns it; anything else used to fail as a raw
 * TypeError ("Cannot read properties of undefined").
 */
export const responseArgProblem: Problem<unknown> = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Expected a response object with a data array.";
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return "Expected a response object with a data array.";
  const bad = data.findIndex((item) => typeof item !== "object" || item === null || Array.isArray(item));
  return bad === -1 ? undefined : `Expected a data array of objects; item ${bad} is not an object.`;
};

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
        return `Unknown key ${quoteValue(cutText(key, 60))}; expected one of ${known.join(", ")}.`;
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

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which a URL would carry as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. Such a value reads
 * as "no filter", or matches nothing, so it is refused as blank.
 */
function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be used as a text filter (`water`), or undefined when it can. Refused,
 * before any request, as it would match nothing or everything:
 * - a value that is blank once trimmed (Unicode whitespace, U+00A0 included), or that holds only
 *   invisible characters and combining marks;
 * - a lone surrogate (half of a character);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen from a hyphenated web page, a bidi control; ZWNJ and ZWJ are allowed): pasted along,
 *   it makes the search find nothing (`Mul\u00adde` found no "Mulde").
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/** A text filter as it is matched: without surrounding whitespace, in composed Unicode (NFC). */
export function normalizeText(value: string): string {
  return value.trim().normalize("NFC");
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is a code or an enum
 * value the API compares exactly (a state code). The rules apply to the value with surrounding
 * whitespace trimmed, as it is sent ({@link normalizeToken}): not blank (and not only invisible
 * characters or combining marks), no lone surrogate, and no control or format character at all
 * (a zero-width space, ZWJ, a soft hyphen, a bidi control), since an invisible character in a
 * code only ever makes it match nothing. The reason quotes the value visibly.
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The items of a comma-separated list option (`--states BY,SN`), as typed: each item is checked
 * (`listProblem`) and canonicalised on its own, so `"BY, SN"` sends `SN`, and `"BY,,SN"`, `"BY,"`
 * and `","` are refused rather than read as fewer items.
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all, or an item that `itemProblem` refuses (by default {@link tokenProblem}: a blank
 * item is refused, never dropped). The reason names the item (`item 2 of 3: …`).
 */
export function listProblem(items: readonly string[], itemProblem: Problem<string> = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
}

/** One state code: a token ({@link tokenProblem}) that is one of the 16 codes, in any case. */
const stateCodeProblem: Problem<string> = (value) =>
  tokenProblem(value) ??
  ((STATE_CODES as readonly string[]).includes(normalizeToken(value).toUpperCase())
    ? undefined
    : `Unknown state code ${quoteValue(value.trim())}. Expected one of: ${STATE_CODES.join(", ")}.`);

/**
 * A list of state codes must name at least one of the 16 known codes and nothing else: each
 * item a token ({@link tokenProblem}: an empty item, `BY,,SN`, or one with an invisible
 * character, `BY\u200b`, is refused, never dropped), trimmed and compared case-insensitively, so
 * a typo never becomes a silently-dropped filter that returns the full nationwide set.
 * `normalizeStates` returns the canonical form.
 */
export const statesProblem: Problem<readonly string[]> = (states) => {
  // A plain "BY" string would otherwise be read character by character.
  if (!Array.isArray(states) || !(states as readonly unknown[]).every((s) => typeof s === "string")) {
    return "Expected an array of state codes.";
  }
  if (states.length === 0) return `No state code given. Expected one or more of: ${STATE_CODES.join(", ")}.`;
  return listProblem(states, stateCodeProblem);
};
