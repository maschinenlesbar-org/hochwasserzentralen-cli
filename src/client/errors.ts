// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/** Base class for every error originating from this client. */
export class HochwasserzentralenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL (a mirror behind a login) never reaches an error message,
 * a log or CI output. A value that doesn't parse is cut by text (see
 * {@link credentialsIn}); a URL without userinfo is returned unchanged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A value that doesn't parse (a port typo, an unencoded "#" in the password) can still
    // carry credentials: cut them out by text.
    return redactCredentials(url, credentialsIn(url));
  }
  // A URL without userinfo, or `user:pw@host` without a scheme (it parses as a URL with
  // the scheme "user:"), which is no URL with credentials at all.
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * The userinfo a URL carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. Only a value that starts
 * with a scheme (`^[A-Za-z][A-Za-z0-9+.-]*://`) counts: a bare `a:b@c` is a file name
 * (`-o flood:map@v2.geojson`), a search text or a User-Agent as often as a credential,
 * and the base URL always has a scheme. It works on URLs that don't parse too: the
 * userinfo is everything between `://` and the last `@` before the host. Used to redact
 * those exact strings from text that echoes the value (usage errors, help), whatever
 * characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
  if (scheme === null) return [];
  const rest = value.slice(scheme[0].length);
  let parses = false;
  try {
    new URL(value);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#"); in one that doesn't, at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(/[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/**
 * The forms in which a server may echo the credentials of a userinfo (`user:password`,
 * as {@link credentialsIn} returns it) back in an error body: the `Authorization: Basic`
 * value (base64 of the decoded `user:password`, UTF-8 as Node sends it for a URL with
 * userinfo), the decoded `user:password` itself, and the password alone when it is at
 * least 4 characters long. `[]` for a userinfo without a password. None of them has an
 * `@` to anchor on, so they are replaced as exact strings ({@link redactSecrets}).
 */
export function echoedCredentialForms(userinfo: string): string[] {
  const colon = userinfo.indexOf(":");
  if (colon < 0) return [];
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const user = decode(userinfo.slice(0, colon));
  const password = decode(userinfo.slice(colon + 1));
  if (password === "") return [];
  const pair = `${user}:${password}`;
  const forms = [Buffer.from(pair, "utf8").toString("base64"), pair];
  if (password.length >= 4) forms.push(password);
  return forms;
}

/**
 * `text` with every occurrence of each secret (a form a server echoes a credential in,
 * which has no `@` to anchor on) replaced by `***`. Secrets shorter than 4 characters are
 * skipped: they are not credentials, and replacing them would garble the rest of the text.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.trim().length < 4) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/**
 * `text` with every occurrence of each credential (as `credentialsIn` returns them) that is
 * followed by `@` replaced by `***`. Matching the exact strings, not a pattern, covers
 * passwords with spaces, quotes, `#`, `?` or `/` that no URL pattern can delimit. The CLI also
 * passes the escaped forms of each credential, as its messages escape values.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/**
 * Longest echoed value or server text (in characters) an error message shows. A huge
 * value or a hostile body would otherwise put kilobytes on one stderr line; the error's
 * own properties (`url`, `body`) keep the full value.
 */
export const MAX_MESSAGE_VALUE_LENGTH = 500;

/** `text` cut to MAX_MESSAGE_VALUE_LENGTH characters (never inside a surrogate pair), ending in "…" when cut. */
export function cutForMessage(text: string): string {
  return text.length > MAX_MESSAGE_VALUE_LENGTH ? `${cutText(text, MAX_MESSAGE_VALUE_LENGTH)}…` : text;
}

/**
 * `text` cut to at most `max` UTF-16 units, never inside a surrogate pair: when the cut
 * would land after a high surrogate it is made one unit earlier, so a message that holds
 * the cut text is well-formed (a lone `\ud83d` makes jq reject a whole JSON stream).
 * Text no longer than `max` is returned as it is; the caller marks a cut.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * `text` with every lone surrogate (half of a character) replaced by U+FFFD, like
 * `String.prototype.toWellFormed` (ES2024, so not in this package's `lib`).
 */
export function toWellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/**
 * The API responded with a non-2xx HTTP status, or with a 2xx whose envelope reports
 * a failure (`apiStatus`). `detail` holds a short snippet of
 * the response body when a useful textual one is present. `url` (and the message)
 * show the request URL with its userinfo replaced by `***` ({@link redactUrl}). Note that a 3xx also
 * lands here: this client deliberately does NOT follow redirects (the canonical
 * host answers directly), so a redirect surfaces as an error.
 */
export class HochwasserzentralenApiError extends HochwasserzentralenError {
  /** The HTTP status — 200 for a 2xx answer whose envelope reports a failure (`apiStatus`). */
  readonly status: number;
  /**
   * The envelope's own `status` when the API answered 2xx but reported a failure in it
   * (anything but `"success"`, e.g. `"error"`); `undefined` for a non-2xx answer.
   */
  readonly apiStatus: string | undefined;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    apiStatus?: string;
  }) {
    const detailPart = args.detail ? `: ${args.detail}` : "";
    // The URL is shown and kept without userinfo: a credential in the base URL must not leak.
    const url = redactUrl(args.url);
    const head =
      args.apiStatus === undefined
        ? `HTTP ${args.status}`
        : `The API reported status "${args.apiStatus}" (HTTP ${args.status}, not "success")`;
    super(`${head} for ${args.method} ${cutForMessage(url)}${detailPart}`);
    this.status = args.status;
    this.apiStatus = args.apiStatus;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
  }

  /** True for HTTP statuses the engine treats as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }

  /** True for a transport-level HTTP 404. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, size cap, ...). */
export class HochwasserzentralenNetworkError extends HochwasserzentralenError {}

/**
 * A rejected input — a client option or a method argument that breaks one of the
 * library's rules (see validate.ts), e.g. an unknown state code. Thrown before any
 * request is made; the CLI maps it to its usage exit code (2).
 */
export class HochwasserzentralenValidationError extends HochwasserzentralenError {}

/** The response body could not be parsed as the expected JSON. */
export class HochwasserzentralenParseError extends HochwasserzentralenError {}
