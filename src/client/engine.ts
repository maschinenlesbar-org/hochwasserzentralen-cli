// The request engine: turns logical (path, query) calls into HTTP GET requests
// via a Transport, applies retry/backoff for transient statuses (429, 503)
// honouring Retry-After, and decodes JSON responses.
//
// Redirects are NOT followed — a 3xx surfaces as a HochwasserzentralenApiError.
// The canonical host (api.hochwasserzentralen.de) answers directly, so a redirect
// almost always means --base-url points somewhere unexpected. Because no redirect
// is ever followed, credential headers can never leak across hosts (this client
// is keyless anyway).

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  HochwasserzentralenApiError,
  HochwasserzentralenNetworkError,
  HochwasserzentralenParseError,
} from "./errors.js";

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

export interface EngineOptions {
  /** Base URL of the API. Defaults to https://api.hochwasserzentralen.de/public/v1 */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent on every request. */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; capped at `MAX_TIMEOUT_MS`, 2^31 - 1 ms).
   */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly), unless the
   * response carries a `Retry-After` header, which takes precedence.
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
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
const MAX_RETRY_AFTER_MS = 30_000;

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
 * Strip control characters (all C0/C1 except tab and newline, plus DEL) out of a
 * string that originates in an attacker-controlled response body — the error
 * `detail` snippet that ends up in a HochwasserzentralenApiError.message printed
 * raw to stderr by run.ts. Without this, a hostile / MITM'd / spoofed-`--base-url`
 * endpoint could drive ANSI/OSC escape sequences (display spoofing, terminal
 * title changes) into the user's terminal via a non-2xx reply. This only covers
 * error text: the CLI's JSON/GeoJSON output is escaped separately (escapeControlChars
 * in cli/shared.ts), since JSON.stringify alone leaves DEL and the C1 range raw.
 *
 * Written as a char-code filter so no raw control byte ever appears in this source.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/**
 * Reject a base URL whose scheme is not http(s), or that has a query or fragment.
 * The default transport already gates the scheme per hop, but the engine is
 * exported as a library and may be handed a custom transport that does no such
 * check, so gate the configured base URL here too (a `file:`/`ftp:` base URL fails
 * fast with a typed error). Request paths are appended to the base URL as a string,
 * so a `?` or `#` in it would swallow every path and the `states` filter:
 * `http://h/v1?x=1` requests `/v1?x=1/data/stations` and `http://h/v1#f` requests `/v1`.
 */
function assertHttpScheme(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new HochwasserzentralenNetworkError(`Invalid base URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HochwasserzentralenNetworkError(
      `Unsupported protocol "${url.protocol}" in base URL: ${baseUrl}`,
    );
  }
  if (/[?#]/.test(baseUrl)) {
    throw new HochwasserzentralenNetworkError(`Base URL must not contain a query or fragment: ${baseUrl}`);
  }
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
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    assertHttpScheme(this.baseUrl);
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
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
      const response = await this.transport({
        method: "GET",
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        // Honour a Retry-After header when present, clamped to MAX_RETRY_AFTER_MS
        // so a pathological/hostile value can't hang the CLI; otherwise fall back
        // to linear backoff.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        const delay =
          retryAfter !== undefined ? Math.min(retryAfter, MAX_RETRY_AFTER_MS) : this.retryDelayMs * attempt;
        await this.sleep(delay);
        continue;
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(url, status, response.body);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams, options: RequestOptions = {}): Promise<T> {
    const res = await this.request(path, query, options);
    const text = res.data.toString("utf8");
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new HochwasserzentralenParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  private toApiError(url: string, status: number, body: Buffer): HochwasserzentralenApiError {
    const text = body.toString("utf8");
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
