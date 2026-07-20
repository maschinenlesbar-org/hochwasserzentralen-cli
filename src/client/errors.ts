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
 * The API responded with a non-2xx HTTP status. `detail` holds a short snippet of
 * the response body when a useful textual one is present. Note that a 3xx also
 * lands here: this client deliberately does NOT follow redirects (the canonical
 * host answers directly), so a redirect surfaces as an error.
 */
export class HochwasserzentralenApiError extends HochwasserzentralenError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: { status: number; url: string; method: string; body: string; detail?: string }) {
    const detailPart = args.detail ? `: ${args.detail}` : "";
    super(`HTTP ${args.status} for ${args.method} ${args.url}${detailPart}`);
    this.status = args.status;
    this.url = args.url;
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
 * A client-side validation error (e.g. an unknown state code) — no request was
 * made. The CLI maps this to the usage exit code (2).
 */
export class HochwasserzentralenValidationError extends HochwasserzentralenError {}

/** The response body could not be parsed as the expected JSON. */
export class HochwasserzentralenParseError extends HochwasserzentralenError {}
