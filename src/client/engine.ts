// The request engine: turns logical (path, query) calls into HTTP GET requests
// via a Transport, applies retry/backoff for transient statuses (429, 503)
// honouring Retry-After, and decodes JSON responses.
//
// Redirects are NOT followed — a 3xx surfaces as a HochwasserzentralenApiError.
// The canonical host (api.hochwasserzentralen.de) answers directly, so a redirect
// almost always means --base-url points somewhere unexpected. Because no redirect
// is ever followed, credential headers can never leak across hosts (this client
// is keyless anyway).

import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  HochwasserzentralenApiError,
  HochwasserzentralenError,
  HochwasserzentralenNetworkError,
  HochwasserzentralenParseError,
  HochwasserzentralenValidationError,
  credentialsIn,
  redactCredentials,
} from "./errors.js";
import { assertValid, baseUrlProblem, headerNameProblem, headerValueProblem } from "./validate.js";

export const DEFAULT_BASE_URL = "https://api.hochwasserzentralen.de/public/v1";
/**
 * The LHP test system: same API, fixed canned data (including active alerts) —
 * handy for demos and development. Pass via `--base-url`.
 */
export const TEST_BASE_URL = "https://api.hochwasserzentralen.de/public/v1/test";
const DEFAULT_USER_AGENT = "hochwasserzentralen-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large) makes the constructor throw a
 * HochwasserzentralenValidationError.
 */
export interface EngineOptions {
  /**
   * Base URL of the API. Defaults to https://api.hochwasserzentralen.de/public/v1. A
   * value that breaks a rule of {@link validateBaseUrl} (blank, not a URL, not
   * http(s), a query or fragment) throws a HochwasserzentralenValidationError.
   */
  baseUrl?: string;
  /**
   * Swappable transport. Defaults to the built-in node http/https transport. The engine
   * enforces `timeoutMs` and `maxResponseBytes` for any transport, reads its headers in any
   * case (a fetch `Headers` or a `Map` too) and its body as any ArrayBuffer view, and turns
   * whatever it throws into a `HochwasserzentralenNetworkError`.
   */
  transport?: Transport;
  /**
   * Value of the User-Agent header (default `hochwasserzentralen-cli`). A blank
   * value, a control character other than tab, or a character above U+00FF throws
   * a HochwasserzentralenValidationError.
   */
  userAgent?: string;
  /** Extra headers sent on every request; names and values are checked like `userAgent`. */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms). Default 30 000.
   * Enforced by the engine for every transport: the request's `signal` aborts at the
   * deadline and the call rejects with a HochwasserzentralenNetworkError.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses and reset connections
   * (`ECONNRESET`, `EPIPE`, `ECONNABORTED`, undici's `UND_ERR_SOCKET`), 0..`MAX_RETRIES`
   * (10). A refused connection, a DNS failure and a timeout are not retried. Default 2.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly), unless the
   * response carries a `Retry-After` header, which takes precedence. At most
   * `MAX_RETRY_AFTER_MS`. Default 200.
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit. At
   * most `Number.MAX_SAFE_INTEGER`. The default transport aborts early; for any
   * transport the engine checks the body it gets back.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

// Upper bound on how long a Retry-After header may make us wait, so a
// pathological or hostile value (e.g. "Retry-After: 99999999") cannot hang the
// CLI for hours. The retry *count* is bounded by maxRetries, but each individual
// sleep would otherwise not be.
export const MAX_RETRY_AFTER_MS = 30_000;

/** Most automatic retries a caller may ask for (the CLI's --max-retries shares it). */
export const MAX_RETRIES = 10;

/**
 * Read a numeric engine option: `undefined` gives the default; anything but an
 * integer in [0, max] throws. Without this a negative or NaN `timeoutMs` silently
 * disabled the timeout, `maxRetries: Infinity` retried forever and
 * `maxResponseBytes: -1` lifted the size cap.
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new HochwasserzentralenValidationError(
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ${String(value)}.`,
    );
  }
  return value;
}

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds, supporting both
 * the delta-seconds form (`Retry-After: 120`) and the HTTP-date form as an
 * IMF-fixdate (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`). Returns `undefined`
 * when the header is absent or anything else (`-5`, `1.5`, `1e3`, other date
 * formats), so the caller falls back to its own linear backoff. Bare `Date.parse`
 * is not used: it reads "-5" or "1.5" as a date in the past, i.e. a zero delay and
 * an instant retry burst.
 */
export function parseRetryAfter(
  value: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return undefined;

  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1000;
  }

  if (!IMF_FIXDATE.test(raw)) return undefined;
  const when = Date.parse(raw);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * True for the Unicode bidirectional formatting characters: ALM (U+061C), LRM/RLM
 * (U+200E/U+200F), the embeddings and overrides U+202A–U+202E and the isolates
 * U+2066–U+2069. A terminal applies them to the text that follows, so an override
 * in server text can reorder what the user sees ("Trojan Source" spoofing).
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Make a string that originates in an attacker-controlled response body — the
 * error `detail` snippet that ends up in a HochwasserzentralenApiError.message
 * printed to stderr by run.ts — safe to print:
 *
 * - C0 and C1 controls and DEL are dropped. Without this, a hostile / MITM'd /
 *   spoofed-`--base-url` endpoint could drive ANSI/OSC escape sequences (display
 *   spoofing, terminal title changes) into the user's terminal via a non-2xx reply.
 * - Bidi formatting characters (isBidiControl) are dropped, so server text cannot
 *   reorder the visible message.
 * - Every run of whitespace — newlines, tabs, U+2028/U+2029 included — becomes one
 *   space and the ends are trimmed, so the text stays on one line and a server
 *   cannot forge an `Error:` line of its own.
 *
 * This only covers error text: the CLI's JSON/GeoJSON output is escaped separately
 * (escapeControlChars in cli/shared.ts), since JSON.stringify alone leaves DEL, the
 * C1 range and the bidi characters raw.
 *
 * Written as a char-code filter so no raw control byte ever appears in this source.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    const whitespaceControl = n >= 0x09 && n <= 0x0d;
    if (!whitespaceControl && (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || isBidiControl(n))) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else. (A Uint8Array used to be decoded with
 * `Uint8Array#toString`, which gives "123,34,…", so a valid body failed as a parse error.)
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. A transport built on
 * `fetch` naturally returns its `Headers` object, which has no plain properties, and a
 * custom one may write `Retry-After` in any case: the engine then saw no Retry-After and
 * retried after its own short backoff, inside the server's window. Such an object
 * (anything with `get` and `forEach`, a `Headers` or a `Map`) is copied into a record; a
 * plain record gets its names lower-cased.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = {};
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  const record: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * Check a base URL against every rule of {@link baseUrlProblem} — blank,
 * unparseable, a scheme other than `http:`/`https:`, a query or fragment — and
 * return it with trailing slashes stripped. A bad value throws a
 * HochwasserzentralenValidationError ("Invalid baseUrl: <reason>"): it is a
 * configuration error, not a transport failure. The default transport still gates
 * the scheme per hop (a HochwasserzentralenNetworkError there), but the engine may
 * be handed a custom transport that does no such check, so the configured value is
 * checked here.
 */
export function validateBaseUrl(raw: string): string {
  return assertValid("baseUrl", raw, baseUrlProblem).replace(/\/+$/, "");
}

/**
 * Check a value bound for an HTTP header (see {@link headerValueProblem}) and
 * return it unchanged; anything else throws a HochwasserzentralenValidationError
 * naming `name` ("Invalid userAgent: Value contains control characters.").
 */
export function assertHeaderValue(name: string, value: string): string {
  return assertValid(name, value, headerValueProblem);
}

/** Check every name and value of `defaultHeaders`, returning a copy. */
function headerOption(headers: Record<string, string> | undefined): Record<string, string> {
  if (headers === undefined) return {};
  assertValid("defaultHeaders", headers as unknown, (v) =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? undefined : "Expected an object of header names to values.",
  );
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    assertValid("defaultHeaders name", name, headerNameProblem);
    out[name] = assertHeaderValue(`defaultHeaders["${name}"]`, value);
  }
  return out;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Per-request options accepted by `request` / `getJson`. */
export interface RequestOptions {
  /** Accept header. Defaults to application/json. */
  accept?: string;
  /** Accept-Language header (the API speaks de and en). Omitted when unset. */
  language?: string;
}

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // The raw value is checked before the trailing-slash strip; only an omitted
    // baseUrl selects the default.
    this.#baseUrl = validateBaseUrl(options.baseUrl === undefined ? DEFAULT_BASE_URL : options.baseUrl);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.transport = options.transport ?? nodeHttpTransport;
    // Only an omitted userAgent selects the default: a blank one is an error, not
    // a silent fallback, and a malformed one fails here rather than at request time.
    this.userAgent =
      options.userAgent === undefined ? DEFAULT_USER_AGENT : assertHeaderValue("userAgent", options.userAgent);
    this.defaultHeaders = headerOption(options.defaultHeaders);
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL) and transport text (fetch's "Failed to fetch <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactCredentials(text, this.#credentials);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * What the transport threw, as the error the engine raises. The default transport
   * rejects with `HochwasserzentralenNetworkError` only; an injected one may throw anything
   * (a string, a `TypeError` from fetch). Every failure becomes a
   * `HochwasserzentralenNetworkError` — a `HochwasserzentralenError` a caller and the CLI can
   * rely on — with the base URL's credentials scrubbed from its message and cause chain; any
   * other `HochwasserzentralenError` passes through, and a clean network error stays as it is.
   */
  private transportError(cause: unknown): HochwasserzentralenError {
    if (cause instanceof HochwasserzentralenError && !(cause instanceof HochwasserzentralenNetworkError)) return cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    const message = sanitizeServerText(this.scrub(reason));
    const scrubbed = this.scrubCause(cause);
    if (cause instanceof HochwasserzentralenNetworkError && message === cause.message && scrubbed === cause) return cause;
    return new HochwasserzentralenNetworkError(message, { cause: scrubbed });
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new HochwasserzentralenNetworkError(`Request timed out after ${this.timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * Perform a GET with Accept/Accept-Language negotiation and transient-error
   * retries. Redirects are NOT followed — a 3xx surfaces as an error.
   */
  async request(path: string, query?: QueryParams, options: RequestOptions = {}): Promise<RawResponse> {
    const url = this.buildUrl(path, query);
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      Accept: options.accept ?? "application/json",
      "User-Agent": this.userAgent,
    };
    if (options.language !== undefined) headers["Accept-Language"] = options.language;

    let attempt = 0;
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method: "GET",
          url,
          headers,
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset is retried like a 503, whichever
        // transport reported it (Node's ECONNRESET, fetch's UND_ERR_SOCKET, anywhere in the
        // cause chain). A refused connection, a DNS failure and a timeout are not: a slow
        // or absent upstream should not be asked again at once.
        if (hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
        throw this.transportError(cause);
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError, outside the error contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new HochwasserzentralenNetworkError(`The transport returned an invalid response (${invalid}).`);
      }
      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoder expects.
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a custom
      // one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new HochwasserzentralenNetworkError(sizeLimitMessage(this.maxResponseBytes));
      }
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        // Honour a Retry-After header when present, clamped to MAX_RETRY_AFTER_MS
        // so a pathological/hostile value can't hang the CLI; otherwise fall back
        // to linear backoff.
        const retryAfter = parseRetryAfter(responseHeaders["retry-after"]);
        const delay =
          retryAfter !== undefined ? Math.min(retryAfter, MAX_RETRY_AFTER_MS) : this.retryDelayMs * attempt;
        await this.sleep(delay);
        continue;
      }

      const contentType = String(responseHeaders["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(url, status, body);
      }

      return { data: body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams, options: RequestOptions = {}): Promise<T> {
    const res = await this.request(path, query, options);
    const text = res.data.toString("utf8");
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new HochwasserzentralenParseError(`Failed to parse JSON response from ${path}`, {
        cause: this.scrubCause(cause),
      });
    }
  }

  private toApiError(url: string, status: number, body: Buffer): HochwasserzentralenApiError {
    // The body is kept on the error (`body`) and may echo the request URL: scrub it.
    const text = this.scrub(body.toString("utf8"));
    let detail: string | undefined;
    // The API's own errors are JSON ({status, message/description}); a gateway
    // in front may serve plain text or HTML. Prefer structured fields, fall back
    // to a short plain-text (non-HTML) snippet.
    try {
      const parsed = JSON.parse(text) as { message?: unknown; description?: unknown; detail?: unknown };
      if (parsed && typeof parsed.message === "string") detail = parsed.message;
      else if (parsed && typeof parsed.description === "string") detail = parsed.description;
      else if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
    } catch {
      const snippet = text.trim().replace(/\s+/g, " ");
      if (snippet.length > 0 && !snippet.startsWith("<")) {
        detail = snippet.length > 200 ? `${snippet.slice(0, 200)}…` : snippet;
      }
    }
    // `detail` came from the response body and lands in an Error.message printed
    // raw to stderr; strip control chars so a hostile endpoint cannot inject
    // terminal escape sequences.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    return new HochwasserzentralenApiError({ status, url, method: "GET", body: text, detail });
  }
}
