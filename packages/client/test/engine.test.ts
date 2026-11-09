import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { TextDecoder, inspect } from "node:util";
import assert from "node:assert/strict";
import { RequestEngine, bigIntegerKeysOption, firstInexactNumber, parseRetryAfter, sanitizeServerText, scanNumbers, type EngineOptions } from "../src/engine.js";
import {
  HochwasserzentralenApiError,
  HochwasserzentralenNetworkError,
  HochwasserzentralenParseError,
  HochwasserzentralenValidationError,
  cutForMessage,
  TextBuilder,
  cutText,
  echoedCredentialForms,
  redactUrlUserinfo,
  toWellFormed,
} from "../src/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import type { HttpResponse } from "../src/http.js";
import * as fx from "./fixtures.js";
import { HochwasserzentralenClient } from "../src/client.js";

test("a non-http(s) base URL is rejected at construction, before any request reaches a custom transport", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse(fx.alertsJson));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) =>
        err instanceof HochwasserzentralenValidationError &&
        err.message === "Invalid baseUrl: Only http: and https: base URLs are supported.",
    );
    assert.throws(
      () => new HochwasserzentralenClient({ baseUrl, transport: mt.transport }),
      (err) =>
        err instanceof HochwasserzentralenValidationError &&
        err.message === "Invalid baseUrl: Only http: and https: base URLs are supported.",
    );
    assert.equal(mt.calls.length, 0);
  }
  assert.throws(
    () => new RequestEngine({ baseUrl: "not a url", transport: makeMockTransport(() => jsonResponse({})).transport }),
    (err) => err instanceof HochwasserzentralenValidationError && err.message === "Invalid baseUrl: Expected a valid URL.",
  );
});

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://api.hochwasserzentralen.de/public/v1/" });
  assert.equal(
    e.buildUrl("/data/alerts", { states: "BY,SN", cap: true }),
    "https://api.hochwasserzentralen.de/public/v1/data/alerts?states=BY%2CSN&cap=true",
  );
});

test("getJson parses a JSON body into a typed value", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.stationsJson));
  const e = new RequestEngine({ transport: mt.transport });
  const v = await e.getJson<typeof fx.stationsJson>("/data/stations");
  assert.equal(v.status, "success");
  assert.equal(v.data.length, 4);
  assert.equal(v.data[0]!.water, "Havel");
});

test("sends Accept: application/json and no Accept-Language by default", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.alertsJson));
  const e = new RequestEngine({ transport: mt.transport });
  await e.getJson("/data/alerts");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
  assert.equal(mt.last().headers?.["Accept-Language"], undefined);
});

test("sets Accept-Language when a language option is given", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.alertsJson));
  const e = new RequestEngine({ transport: mt.transport });
  await e.getJson("/data/alerts", undefined, { language: "en" });
  assert.equal(mt.last().headers?.["Accept-Language"], "en");
});

test("a 503 is retried up to maxRetries then surfaces as HochwasserzentralenApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return rawResponse("busy", "text/plain", 503);
  });
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 2, sleep: async () => {} });
  await assert.rejects(
    () => e.getJson("/data/alerts"),
    (err) => err instanceof HochwasserzentralenApiError && err.status === 503 && err.isRetryable,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a Retry-After header (delta-seconds) takes precedence over linear backoff", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1
      ? jsonResponse({ message: "slow down" }, 429, { "retry-after": "1" })
      : jsonResponse(fx.alertsJson);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    retryDelayMs: 5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await e.getJson("/data/alerts");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]); // 1s from Retry-After, not 5ms linear
});

test("a pathological Retry-After is clamped to 30s", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1
      ? jsonResponse("{}", 503, { "retry-after": "99999999" })
      : jsonResponse(fx.alertsJson);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 1,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await e.getJson("/data/alerts");
  assert.deepEqual(sleeps, [30_000]);
});

test("parseRetryAfter handles delta-seconds, HTTP-dates and garbage", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter("not a date"), undefined);
  const inTen = new Date(Date.now() + 10_000).toUTCString();
  const ms = parseRetryAfter(inTen);
  assert.ok(ms !== undefined && ms > 5_000 && ms <= 10_000);
});

test("a 404 surfaces as a HochwasserzentralenApiError with status 404", async () => {
  const mt = makeMockTransport(() => rawResponse("not found", "text/plain", 404));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/data/nope"),
    (err) => err instanceof HochwasserzentralenApiError && err.status === 404 && err.isNotFound,
  );
});

test("a 302 is NOT followed — it surfaces as an ApiError after one request", async () => {
  const mt = makeMockTransport(() =>
    rawResponse("", "text/html", 302),
  );
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/data/alerts"),
    (err) => err instanceof HochwasserzentralenApiError && err.status === 302,
  );
  assert.equal(mt.calls.length, 1); // no redirect hop
});

test("a non-JSON 200 body surfaces as HochwasserzentralenParseError", async () => {
  const mt = makeMockTransport(() => rawResponse("<html>not json</html>", "text/html"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/data/alerts"),
    (err) =>
      err instanceof HochwasserzentralenParseError &&
      err.message ===
        'GET https://api.hochwasserzentralen.de/public/v1/data/alerts: the answer is not valid JSON (expected JSON, got Content-Type "text/html").',
  );
});

test("error detail is stripped of terminal control characters", async () => {
  // Build the hostile snippet from char codes so no raw control byte appears in
  // this source file. ESC + CSI (a C1 control) + BEL interleaved with printable text.
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const CSI = String.fromCharCode(0x9b);
  const evil = JSON.stringify({ message: `boom${ESC}[31mred${BEL}${CSI}2J` });
  const mt = makeMockTransport(() => rawResponse(evil, "application/json", 500));
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 0 });
  await assert.rejects(
    () => e.getJson("/data/alerts"),
    (err) => {
      assert.ok(err instanceof HochwasserzentralenApiError);
      const hasControl = (s: string): boolean =>
        [...s].some((c) => {
          const n = c.charCodeAt(0);
          return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
        });
      assert.ok(!hasControl(err.detail ?? ""));
      assert.ok(!hasControl(err.message));
      // Whole escape sequences go, not only their control bytes (the "[31m" and "2J" left before).
      assert.equal(err.detail, "boomred");
      return true;
    },
  );
});

test("a base URL with a query or fragment is rejected at construction", () => {
  for (const baseUrl of ["https://example.org/v1?x=1", "https://example.org/v1#x"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: makeMockTransport(() => jsonResponse({})).transport }),
      (err) =>
        err instanceof HochwasserzentralenValidationError &&
        err.message === "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#).",
    );
  }
});

test("parseRetryAfter accepts only delta-seconds or an IMF-fixdate", () => {
  const now = Date.parse("Sat, 26 Sep 2026 08:00:00 GMT");
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 08:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter(["3", "9"], now), 3000);
  for (const bad of ["-5", "1.5", "+5", "1e3", "0x10", "2026-09-26T08:00:05Z", "Saturday, 26-Sep-26 08:00:05 GMT", ""]) {
    assert.equal(parseRetryAfter(bad, now), undefined, bad);
  }
});

test("an invalid Retry-After falls back to linear backoff instead of an instant retry burst", async () => {
  for (const header of ["-5", "1.5"]) {
    const sleeps: number[] = [];
    const mt = makeMockTransport(() => jsonResponse("{}", 429, { "retry-after": header }));
    const e = new RequestEngine({
      transport: mt.transport,
      maxRetries: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await assert.rejects(() => e.getJson("/data/alerts"), HochwasserzentralenApiError);
    assert.deepEqual(sleeps, [200, 400], header);
  }
});

test("error detail loses bidi controls and line breaks", async () => {
  const RLO = String.fromCharCode(0x202e);
  const LRI = String.fromCharCode(0x2066);
  const body = JSON.stringify({ message: `abc${RLO}def${LRI}x\nError: forged\r\n\tline` });
  const mt = makeMockTransport(() => rawResponse(body, "application/json", 500));
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 0 });
  await assert.rejects(
    () => e.getJson("/data/alerts"),
    (err) => err instanceof HochwasserzentralenApiError && err.detail === "abcdefx Error: forged line",
  );
});

test("invalid numeric engine options are rejected at construction", () => {
  const transport = makeMockTransport(() => jsonResponse({})).transport;
  const bad: Array<[string, Record<string, number>]> = [
    ["timeoutMs", { timeoutMs: -5 }],
    ["timeoutMs", { timeoutMs: Number.NaN }],
    ["timeoutMs", { timeoutMs: 2_147_483_648 }],
    ["maxRetries", { maxRetries: Infinity }],
    ["maxRetries", { maxRetries: 11 }],
    ["retryDelayMs", { retryDelayMs: 1.5 }],
    ["maxResponseBytes", { maxResponseBytes: -1 }],
  ];
  for (const [name, options] of bad) {
    assert.throws(
      () => new RequestEngine({ transport, ...options }),
      (err) =>
        err instanceof HochwasserzentralenValidationError &&
        err.message.startsWith(`Invalid option ${name}: expected an integer from 0 to `),
    );
  }
  assert.doesNotThrow(
    () => new RequestEngine({ transport, timeoutMs: 0, maxRetries: 10, retryDelayMs: 0, maxResponseBytes: 0 }),
  );
});

test("getJson decodes by the declared charset, drops a BOM, and rejects an unknown charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const mt = makeMockTransport(() => rawResponse(Buffer.from(JSON.stringify([text]), encoding), `application/json; charset=${charset}`));
    assert.deepEqual(await new RequestEngine({ transport: mt.transport }).getJson("/x"), [text], charset);
  }
  const bom = makeMockTransport(() => rawResponse(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("[]")]), "application/json"));
  assert.deepEqual(await new RequestEngine({ transport: bom.transport }).getJson("/x"), []);
  const unknown = makeMockTransport(() => rawResponse("[]", "application/json; charset=x-bogus"));
  await assert.rejects(new RequestEngine({ transport: unknown.transport }).getJson("/x"), HochwasserzentralenParseError);
});

test("the API's own JSend error message (error.message) becomes the detail (result 06 Bug 1)", async () => {
  const live = '{"apiVersion":"1.0 beta, 2025-02-04","status":"fail","error":{"code":"BAD_REQUEST","message":"Unknown states"}}';
  for (const status of [400, 500]) {
    const mt = makeMockTransport(() => rawResponse(live, "application/json", status));
    await assert.rejects(new RequestEngine({ transport: mt.transport, maxRetries: 0 }).getJson("/data/alerts"), (err: unknown) => {
      assert.ok(err instanceof HochwasserzentralenApiError);
      assert.equal(err.detail, "Unknown states");
      assert.match(err.message, /^HTTP \d+ for GET .*\/data\/alerts: Unknown states$/);
      return true;
    });
  }
});

test("server text in a message is cut at 500 characters; a parse error says why", async () => {
  const long = makeMockTransport(() => rawResponse(JSON.stringify({ message: "x".repeat(200_000) }), "application/json", 500));
  await assert.rejects(new RequestEngine({ transport: long.transport, maxRetries: 0 }).getJson("/x"), (err: unknown) => {
    assert.ok(err instanceof HochwasserzentralenApiError);
    assert.ok(err.message.length < 700, String(err.message.length));
    return true;
  });
  const html = makeMockTransport(() => rawResponse("<html>proxy</html>", "text/html"));
  await assert.rejects(new RequestEngine({ transport: html.transport }).getJson("/x"), /expected JSON, got Content-Type "text\/html"/);
  const cut = makeMockTransport(() => rawResponse('{"data":[', "application/json"));
  await assert.rejects(new RequestEngine({ transport: cut.transport }).getJson("/x"), /: GET https:\/\/api\.hochwasserzentralen\.de\/public\/v1\/x: the answer is not valid JSON \(\S/);
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
  // cutForMessage (500) uses it too.
  assert.equal(toWellFormed(cutForMessage("a" + "\u{1f600}".repeat(400))), cutForMessage("a" + "\u{1f600}".repeat(400)));
});

test("server text cut to a length limit keeps the library's messages well-formed (result 02 Bug B02-1)", async () => {
  for (const text of ["\u{1f600}".repeat(300), "a" + "\u{1f600}".repeat(300)]) {
    const answers = [
      jsonResponse({ detail: text }, 500), // the detail, cut at 500
      rawResponse("x", `text/${text}`), // the Content-Type of a body that isn't JSON, cut at 100
      rawResponse("x", `application/json; charset=${text}`), // an unknown charset, cut at 100
      jsonResponse({ status: text, data: [] }), // the envelope's status, cut at 40
    ];
    for (const answer of answers) {
      const client = new HochwasserzentralenClient({ maxRetries: 0, transport: async () => answer });
      await assert.rejects(client.alerts(), (err: Error) => {
        assert.equal(toWellFormed(err.message), err.message, err.message);
        return true;
      });
    }
  }
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  // Node sends the pair UTF-8 encoded (the Authorization header it builds from the URL), so that is the form a server echoes.
  const basic = Buffer.from("alice:pa ss-pw", "utf8").toString("base64");
  const engine = new RequestEngine({
    baseUrl: "https://alice:pa%20ss-pw@mirror.example",
    maxRetries: 0,
    transport: makeMockTransport(() => rawResponse(`no: Basic ${basic} / alice:pa ss-pw / pa ss-pw`, "text/plain", 401)).transport,
  });
  await assert.rejects(engine.getJson("/x"), (err: HochwasserzentralenApiError) => {
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.body.includes(form), err.body);
    return true;
  });
});

test("onRetry is called once per retry, with the event fields, right before the sleep", async () => {
  const log: string[] = [];
  const events: unknown[] = [];
  let n = 0;
  const mt = makeMockTransport(() =>
    n++ < 2
      ? { status: 503, headers: n === 1 ? { "retry-after": "2" } : {}, body: Buffer.from("{}") }
      : jsonResponse({ ok: 1 }),
  );
  const e = new RequestEngine({
    transport: mt.transport,
    baseUrl: "https://user:pw@example.test",
    maxRetries: 3,
    sleep: async (ms) => void log.push(`sleep ${ms}`),
    onRetry: (ev) => {
      events.push(ev);
      log.push("retry");
    },
  });
  await e.request("/x");
  assert.deepEqual(log, ["retry", "sleep 2000", "retry", "sleep 400"]);
  assert.deepEqual(events, [
    { retry: 1, maxRetries: 3, delayMs: 2000, status: 503, url: "https://***@example.test/x" },
    { retry: 2, maxRetries: 3, delayMs: 400, status: 503, url: "https://***@example.test/x" },
  ]);
});

test("onRetry reports a reset connection without a status", async () => {
  let n = 0;
  const events: unknown[] = [];
  const mt = makeMockTransport(() => {
    if (n++ === 0) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {}, onRetry: (ev) => void events.push(ev) });
  await e.request("/x");
  assert.equal(events.length, 1);
  assert.equal((events[0] as { status?: number }).status, undefined);
  assert.equal((events[0] as { retry: number }).retry, 1);
});

test("a throw in onRetry is swallowed", async () => {
  let n = 0;
  const mt = makeMockTransport(() => (n++ === 0 ? { status: 503, headers: {}, body: Buffer.from("{}") } : jsonResponse({ ok: 1 })));
  const e = new RequestEngine({
    transport: mt.transport,
    sleep: async () => {},
    onRetry: () => {
      throw new Error("boom");
    },
  });
  await e.request("/x");
  assert.equal(mt.calls.length, 2);
});

test("onRetry is never called without a retry", async () => {
  const events: unknown[] = [];
  const onRetry = (ev: unknown) => void events.push(ev);
  const ok = new RequestEngine({ transport: makeMockTransport(() => jsonResponse({})).transport, sleep: async () => {}, onRetry });
  await ok.request("/x");
  const notFound = new RequestEngine({
    transport: makeMockTransport(() => jsonResponse({ detail: "no" }, 404)).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(notFound.request("/x"), HochwasserzentralenApiError);
  // retries exhausted: the last 503 is an error, not a retry
  const down = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: {}, body: Buffer.from("{}") })).transport,
    maxRetries: 1,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(down.request("/x"), HochwasserzentralenApiError);
  assert.equal(events.length, 1);
});

test("onRetry must be a function", () => {
  assert.throws(() => new RequestEngine({ onRetry: 5 as never }), HochwasserzentralenValidationError);
});

test("a number JSON.parse can't carry exactly is a parse error, never a changed value (K1)", async () => {
  const inexact = [
    "12345678901234567890", "-9007199254740993", "1e400", "-1E400", "12345678901234567890.0", "9007199254740993e0",
    "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
    "123456789012345678901234567890",
    // Below the smallest normal double a subnormal has fewer digits: 3e-324 became 5e-324 (D4).
    "3e-324", "4e-324", "-4.9e-324", "1.2345678901234567e-310", "2.225073858507201e-309",
  ];
  for (const literal of inexact) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(`{"data":[],"n":${literal}}`, "application/json")).transport });
    await assert.rejects(
      e.getJson("/data/stations", { states: "BY" }),
      (err) =>
        err instanceof HochwasserzentralenParseError &&
        err.message ===
          `GET https://api.hochwasserzentralen.de/public/v1/data/stations?states=BY: the number ${literal} cannot be represented exactly.`,
      literal,
    );
  }
  // A number in a string is text, and a double carries these as written.
  const exact: Array<[string, number]> = [
    ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53], ["1e21", 1e21], ["0.1", 0.1],
    ["13.404954", 13.404954], ["-2.5e-3", -0.0025], ["5e-324", 5e-324], ["0.0e-500", 0], ["-1", -1],
    // A double a server printed in its shortest form reads back as that double and prints as the
    // same number: not a changed value, though the decimal is not the double's exact binary value.
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1E23", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE], ["-1.7976931348623157e308", -Number.MAX_VALUE],
    ["4.35e30", 4.35e30],
    // A subnormal or the smallest normal double that prints as written (D4).
    ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308],
  ];
  for (const [literal, value] of exact) {
    const e = new RequestEngine({
      transport: makeMockTransport(() => rawResponse(`{"id":"12345678901234567890","n":${literal}}`, "application/json")).transport,
    });
    assert.deepEqual(await e.getJson("/data/stations"), { id: "12345678901234567890", n: value }, literal);
  }
});

test("a network failure names the request: GET <url> failed: <reason>, the original as cause (K3)", async () => {
  const url = "https://***@api.example/v1/data/stations?states=BY";
  const fail = (thrown: unknown) => () => {
    throw thrown;
  };
  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
  const dns = Object.assign(new Error("getaddrinfo ENOTFOUND api.example"), { code: "ENOTFOUND" });
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const cases: Array<[string, EngineOptions, string, unknown]> = [
    ["refused", { transport: fail(refused) }, "connect ECONNREFUSED 127.0.0.1:1", refused],
    ["dns", { transport: fail(dns) }, "getaddrinfo ENOTFOUND api.example", dns],
    ["reset", { transport: fail(reset), maxRetries: 1, sleep: async () => {} }, "socket hang up (after 1 retry)", reset],
    ["timeout", { transport: () => new Promise(() => {}), timeoutMs: 10 }, "Request timed out after 10ms", undefined],
    [
      "size cap",
      { transport: async () => rawResponse("x".repeat(100), "application/json"), maxResponseBytes: 10 },
      "Response exceeded the size limit of 10 bytes",
      undefined,
    ],
  ];
  for (const [name, options, reason, cause] of cases) {
    const e = new RequestEngine({ baseUrl: "https://user:secret@api.example/v1", ...options });
    await assert.rejects(
      e.getJson("/data/stations", { states: "BY" }),
      (err) => {
        assert.ok(err instanceof HochwasserzentralenNetworkError, name);
        assert.ok(err.message.startsWith(`GET ${url} failed: `), `${name}: ${err.message}`);
        assert.ok(err.message.includes(reason), `${name}: ${err.message}`);
        if (cause !== undefined) assert.equal(err.cause, cause, name);
        assert.doesNotMatch(err.message, /secret/, name);
        return true;
      },
    );
  }
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  const headers = JSON.parse('{"__proto__":{"content-type":"text/html"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from("<html>") }) });
  // With the prototype set, "text/html" was read as the Content-Type and named in the message.
  await assert.rejects(e.getJson("/x"), (err: Error) => err instanceof HochwasserzentralenParseError && !err.message.includes("text/html"));
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson("/x"), { a: 1 });
});

test("an answer error names the request: method and URL, userinfo redacted (D9)", async () => {
  const answers: Array<[string, () => HttpResponse]> = [
    ["not valid JSON", () => rawResponse("<html>", "text/html")],
    ["empty response body", () => rawResponse(" ", "application/json")],
    ["cannot be represented exactly", () => rawResponse('{"n":1e400}', "application/json")],
    ["unsupported response charset", () => rawResponse("{}", "application/json; charset=x-bogus")],
    ["unsupported Content-Encoding", () => ({ status: 200, headers: { "content-type": "application/json", "content-encoding": "br" }, body: Buffer.from("{}") })],
  ];
  const base = new URL("https://api.hochwasserzentralen.de/public/v1");
  base.username = "alice";
  base.password = "s3cret";
  for (const [what, respond] of answers) {
    const e = new RequestEngine({ baseUrl: base.href, transport: makeMockTransport(respond).transport });
    await assert.rejects(e.getJson("/data/alerts", { states: "BY" }), (err: unknown) => {
      assert.ok(err instanceof HochwasserzentralenParseError, what);
      assert.ok(err.message.startsWith(`GET ${base.protocol}//***@${base.host}`), err.message);
      assert.ok(err.message.includes("/data/alerts?states=BY: ") && err.message.includes(what), err.message);
      assert.ok(!err.message.includes("s3cret"), err.message);
      return true;
    });
  }
  // An identity coding is no coding.
  const identity = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 200, headers: { "content-type": "application/json", "content-encoding": "identity" }, body: Buffer.from("{}") })).transport,
  });
  assert.deepEqual(await identity.getJson("/x"), {});
});

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3)", async () => {
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.getJson("/x"), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.getJson("/x"), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.getJson("/x"), /not valid JSON/);
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof HochwasserzentralenValidationError && err.message === "Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  // Without declarations the scan is the plain number check.
  assert.equal(firstInexactNumber('{"a":"1e400","b":3e-324}'), "3e-324");
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
});

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2)", async () => {
  const cases: Array<[string, Buffer, string, unknown, number]> = [
    // A lone surrogate written as an escape (high alone, low alone); a real pair and an escaped backslash stay.
    ["lone escapes", Buffer.from('{"a":"x\\ud800y","b":"\\udc00","c":"\\ud83d\\ude00","d":"\\\\ud800"}'), "application/json", { a: "x\ufffdy", b: "\ufffd", c: "\u{1f600}", d: "\\ud800" }, 2],
    // A lone surrogate in a member name.
    ["lone in a key", Buffer.from('{"\\udbff":1}'), "application/json", { "\ufffd": 1 }, 1],
    // Invalid UTF-8 bytes; a U+FFFD the server sent is not counted.
    ["invalid bytes", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xc3]), Buffer.from('","b":"\ufffd"}')]), "application/json", { a: "\ufffd\ufffd", b: "\ufffd" }, 2],
    // A byte undefined in a single-byte charset.
    ["iso-8859-3", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xa5]), Buffer.from('"}')]), "application/json; charset=iso-8859-3", { a: "\ufffd" }, 1],
  ];
  for (const [label, body, type, expected, count] of cases) {
    const warnings: string[] = [];
    const e = new RequestEngine({ onWarning: (m) => warnings.push(m), transport: makeMockTransport(() => rawResponse(body, type)).transport });
    const value = await e.getJson("/data/alerts", { states: "BY" });
    assert.deepEqual(value, expected, label);
    assert.ok(!/[\ud800-\udfff]/u.test(JSON.stringify(value)), `${label}: well-formed`);
    assert.deepEqual(warnings, [
      `GET https://api.hochwasserzentralen.de/public/v1/data/alerts?states=BY: ${count} ${count === 1 ? "character" : "characters"} of the answer ${count === 1 ? "was" : "were"} not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`,
    ], label);
  }
  // Valid text: no warning; a throwing hook never fails the request.
  const quiet: string[] = [];
  const ok = new RequestEngine({ onWarning: (m) => quiet.push(m), transport: makeMockTransport(() => rawResponse('{"a":"\\u00fc\ufffd"}', "application/json")).transport });
  assert.deepEqual(await ok.getJson("/x"), { a: "ü\ufffd" });
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ onWarning: () => { throw new Error("hook"); }, transport: makeMockTransport(() => rawResponse('"\\ud800"', "application/json")).transport });
  assert.equal(await throwing.getJson("/x"), "\ufffd");
  assert.throws(() => new RequestEngine({ onWarning: "log" as unknown as () => void }), HochwasserzentralenValidationError);
});

test("an answer longer than V8's longest string is a HochwasserzentralenParseError naming the request, not a plain Error (T14)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the body marked by its length.
  const huge = Buffer.from('{"status":"success","data":[]}   ');
  const tooLong = Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
    if (input !== undefined && input.byteLength === huge.length) throw tooLong;
    return decode.call(this, input, options);
  });
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    if (this.length === huge.length && args[0] === "utf8") throw tooLong;
    return toString.apply(this, args);
  });
  const e = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "application/json")).transport });
  await assert.rejects(e.getJson("/data/alerts", { states: "BY" }), (err: unknown) => {
    assert.ok(err instanceof HochwasserzentralenParseError, String(err));
    assert.equal(
      err.message,
      `GET https://api.hochwasserzentralen.de/public/v1/data/alerts?states=BY: the answer is too large to read as text (${huge.length} bytes; the longest string is 536870888 characters).`,
    );
    return true;
  });
  // An error status with such a body is still the API error, without the unreadable body.
  const failing = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "text/plain", 500)).transport });
  await assert.rejects(failing.getJson("/data/alerts"), (err: unknown) => err instanceof HochwasserzentralenApiError && err.status === 500 && err.body === "");
});

test("sanitizeServerText drops whole escape sequences, not just their control bytes", () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const CSI8 = String.fromCharCode(0x9b);
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  for (const [input, expected] of [
    [`line1 ${ESC}]0;title${BEL}rest`, "line1 rest"],
    [`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`, "click"],
    [`${ESC}[31mred${ESC}[0m plain`, "red plain"],
    [`${ESC}[1;31;4mbold`, "bold"],
    [`${CSI8}2Jcleared`, "cleared"],
    [`${OSC8}0;t${ST8}ok`, "ok"],
    [`a${ESC}7b${ESC}(Bc`, "abc"],
    // Unterminated: only ESC and its introducer go, the text stays.
    [`keep ${ESC}]0;no terminator here`, "keep 0;no terminator here"],
  ] as const) {
    assert.equal(sanitizeServerText(input), expected, JSON.stringify(input));
  }
});

test("sanitizeServerText drops invisible format characters (zero-width, soft hyphen, BOM)", () => {
  const text = "real\u200b error\u2028Error: forged\u2066x\u2069 \ufeffend\u00ad\u200d\u2060!";
  assert.equal(sanitizeServerText(text), "real error Error: forgedx end!");
});

/** Milliseconds `work` takes. */
async function elapsedAsync(work: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await work();
  return performance.now() - start;
}

test("server text of unterminated control-string introducers is cleaned in linear time, in an error status and a failed envelope", async () => {
  // 100 000 × U+009D took about 16 s with the old escape-sequence regex (its control-string body
  // admitted the other 8-bit introducers), after the request's deadline had ended.
  for (const opener of ["\\u009d", "\\u0090", "\\u0098", "\\u009e", "\\u009f", "\\u001b]"]) {
    const message = `"${opener.repeat(100_000)} tail"`;
    for (const [status, body] of [
      [500, `{"message":${message}}`],
      [200, `{"status":"error","message":${message}}`],
    ] as const) {
      const client = new HochwasserzentralenClient({ maxRetries: 0, transport: makeMockTransport(() => jsonResponse(body, status)).transport });
      let err: unknown;
      const ms = await elapsedAsync(async () => {
        try {
          await client.alerts();
        } catch (e) {
          err = e;
        }
      });
      assert.ok(ms < 1000, `${opener} (${status}): ${Math.round(ms)} ms`);
      assert.ok(err instanceof HochwasserzentralenApiError && err.status === status, String(err));
      assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(err.message), `${opener} (${status}): a control character in the message`);
    }
  }
});

test("sanitizeServerText reads a bounded prefix and drops what the per-character filter dropped", () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  // The filter it replaces, one character at a time: C0 but TAB to CR, DEL, C1 and Cf go.
  const perCharacter = (text: string): string =>
    [...text]
      .filter((ch) => {
        const n = ch.codePointAt(0) ?? 0;
        return (n >= 0x09 && n <= 0x0d) || !(n <= 0x1f || (n >= 0x7f && n <= 0x9f) || /\p{Cf}/u.test(ch));
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  const every = Array.from({ length: 0x3000 }, (_, i) => String.fromCharCode(i)).join("") + "\u{1f600}\u{e0001}\ud800x";
  for (let at = 0; at < every.length; at += 512) {
    const piece = every.slice(at, at + 512).replace(/[\u001b\u0090\u0098\u009b-\u009f]/g, "");
    assert.equal(sanitizeServerText(piece), perCharacter(piece), `from U+${at.toString(16)}`);
  }
  // At most 16 384 units of the text are read, never half a surrogate pair.
  assert.equal(sanitizeServerText("x".repeat(100_000)).length, 16_384);
  assert.equal(sanitizeServerText(`${"x".repeat(16_383)}\u{1f600}`), "x".repeat(16_383));
  // A control string ends at another introducer: the first is dropped by the filter, the second
  // string as a whole.
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  assert.equal(sanitizeServerText(`a${OSC8}0;x${OSC8}0;t${ST8}b`), "a0;xb");
  assert.equal(sanitizeServerText(`a${ESC}]0;x${ESC}]0;t${BEL}b`), "a0;xb");
});

test("a 3xx names the redirect target, resolved, userinfo redacted, sanitised; it stays unfollowed (01-1)", async () => {
  const cases: Array<[number, string | undefined, string]> = [
    [302, "https://www.hochwasserzentralen.de/public/v1/data/alerts", ": redirect to https://www.hochwasserzentralen.de/public/v1/data/alerts not followed"],
    [301, "/elsewhere", ": redirect to https://api.hochwasserzentralen.de/elsewhere not followed"],
    [307, "https://u:p@evil.test/\u202ex", ": redirect to https://***@evil.test/%E2%80%AEx not followed"],
    [308, undefined, ": redirect not followed (no Location header)"],
  ];
  for (const [status, location, suffix] of cases) {
    const mt = makeMockTransport(() => ({ status, headers: location === undefined ? {} : { location }, body: Buffer.alloc(0) }));
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(e.getJson("/data/alerts"), (err: unknown) => {
      assert.ok(err instanceof HochwasserzentralenApiError);
      assert.equal(err.message, `HTTP ${status} for GET https://api.hochwasserzentralen.de/public/v1/data/alerts${suffix}`);
      assert.equal(err.location, location === undefined ? undefined : suffix.slice(": redirect to ".length, -" not followed".length));
      return true;
    });
    assert.equal(mt.calls.length, 1, "not followed");
  }
  // A 304 is no redirect.
  const notModified = new RequestEngine({ transport: async () => ({ status: 304, headers: {}, body: Buffer.alloc(0) }) });
  await assert.rejects(notModified.getJson("/x"), (err: unknown) =>
    err instanceof HochwasserzentralenApiError && err.message === "HTTP 304 for GET https://api.hochwasserzentralen.de/public/v1/x" && err.location === undefined);
});

test("redactUrlUserinfo hides every URL's userinfo in one linear pass, however many URLs", () => {
  const elapsed = (work: () => unknown): number => {
    const start = performance.now();
    work();
    return performance.now() - start;
  };
  // The URL regex this replaces (a scheme tried at every word start) takes about 3 s on this.
  assert.ok(elapsed(() => redactUrlUserinfo("a.".repeat(30_000))) < 1000);
  assert.equal(redactUrlUserinfo("a -https://u:p@h/x and x-ftp://v@w?q, mail@example.org"), "a -https://***@h/x and x-ftp://***@w?q, mail@example.org");
  assert.equal(
    redactUrlUserinfo("argument 'ftp://user:s3cret@h.example' is invalid; also http://a@b@c.example/x?y=u@v"),
    "argument 'ftp://***@h.example' is invalid; also http://***@c.example/x?y=u@v",
  );
  assert.equal(redactUrlUserinfo("1://u:p@h ://u:p@h"), "1://u:p@h ://u:p@h");
  assert.equal(redactUrlUserinfo("https://h/p?u=a@b"), "https://h/p?u=a@b");
  assert.equal(redactUrlUserinfo("error: unknown option '--bogus' (mail@example.org)"), "error: unknown option '--bogus' (mail@example.org)");
  for (const text of ["a".repeat(1_000_000), "a.".repeat(500_000), "://".repeat(100_000), `https://${"u".repeat(1_000_000)}`]) {
    assert.equal(redactUrlUserinfo(text), text);
  }
  const many = redactUrlUserinfo("https://u:p@h ".repeat(100_000));
  assert.equal(many, "https://***@h ".repeat(100_000));
});

test("a TextBuilder joins its pieces in order across batches", () => {
  const b = new TextBuilder();
  const expected: string[] = [];
  for (let i = 0; i < 40_000; i++) {
    b.push(String(i), ",");
    expected.push(String(i), ",");
  }
  assert.equal(b.toString(), expected.join(""));
  assert.equal(new TextBuilder().toString(), "");
});

function elapsed(work: () => unknown): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

test("redactUrlUserinfo hides the userinfo of a URL glued onto the one before it, still linear (B2)", () => {
  // The authority read for the first `://` ends at the `/` of the second; the second URL starts
  // inside it (its scheme is the first one's host, or follows a redacted `@`), so the search goes
  // on after each `://`, not after the authority. The regex this replaces redacted both; the
  // first linear pass missed them.
  assert.equal(redactUrlUserinfo("https://host://u:p@h"), "https://host://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@x://v:q@w"), "https://***@x://***@w");
  assert.equal(redactUrlUserinfo("see https://h.example:/x://u:p@h"), "see https://h.example:/x://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@1://v:q@w"), "https://***@1://v:q@w");
  // Many glued URLs, unredacted and redacted, and long scheme-character runs: one pass each.
  const n = 100_000;
  for (const [text, want] of [
    [`${"a://".repeat(n)}u:p@h`, `${"a://".repeat(n)}***@h`],
    ["x://u:p@".repeat(n), "x://***@".repeat(n)],
    [`${"a.".repeat(500_000)}://u:p@h`, `${"a.".repeat(500_000)}://***@h`],
    [`https://${"a.".repeat(500_000)}://u:p@h`, `https://${"a.".repeat(500_000)}://***@h`],
    ["a:".repeat(500_000), "a:".repeat(500_000)],
  ] as const) {
    let got = "";
    const ms = elapsed(() => (got = redactUrlUserinfo(text)));
    assert.ok(got === want, `${text.slice(0, 40)}…`);
    assert.ok(ms < 1000, `${Math.round(ms)} ms on ${text.slice(0, 40)}…`);
  }
});

test("a number with a long run of zeros is checked in linear time (class A)", async () => {
  // `decimalOf` stripped trailing zeros with /0+$/, which tries a match at every zero of a run
  // that doesn't end the text: 1.<100 000 zeros>1e300 took about 15 s, after the answer was in.
  const literal = `1.${"0".repeat(100_000)}1e300`;
  let scan: ReturnType<typeof scanNumbers> | undefined;
  const ms = elapsed(() => (scan = scanNumbers(`{"x":${literal}}`)));
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
  assert.equal(scan?.inexact, literal);
  // Same result as before: leading and trailing zeros are not significant.
  assert.equal(firstInexactNumber("[12345678901234567890.000, 0.000, 000.0e5, 1e23, 5e-324]"), "12345678901234567890.000");
  assert.equal(firstInexactNumber("[100000000000000000000, 1.0e23, 0e-400]"), undefined);
  assert.equal(firstInexactNumber("[3e-324]"), "3e-324");
  const engine = new RequestEngine({ maxRetries: 0, transport: makeMockTransport(() => jsonResponse(`{"x":${literal}}`)).transport });
  let err: unknown;
  const total = await elapsedAsync(async () => (err = await engine.getJson("/x").catch((e: unknown) => e)));
  assert.ok(total < 1000, `${Math.round(total)} ms`);
  assert.ok(err instanceof HochwasserzentralenParseError && /cannot be represented exactly/.test(err.message), String(err));
  assert.ok(err.message.length < 1000, "the message quotes the literal cut");
});

// These tests start a process with a small heap: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

test("scanNumbers quotes millions of declared members within a small heap", STARTS_A_PROCESS, () => {
  // One `+=` per quoted member made a rope node each: 3 million of them exhausted a 128 MB heap.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const n = 3_000_000;
  const script =
    `const { scanNumbers } = await import(${JSON.stringify(engine)});` +
    `const json = "[" + '{"k":1},'.repeat(${n - 1}) + '{"k":1}]';` +
    `process.stdout.write(String(scanNumbers(json, new Set(["k"])).json.length));`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, String(n * 10 + 1));
});

test("an answer of millions of lone surrogate escapes is repaired within a small heap", STARTS_A_PROCESS, () => {
  // One `+=` per repair (`wellFormedEscapes`) made a rope node each: 6 million of them (36 MB of
  // escapes) exhausted a 128 MB heap.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const n = 6_000_000;
  const script =
    `const { RequestEngine } = await import(${JSON.stringify(engine)});` +
    `const body = Buffer.from('{"x":"' + "\\\\ud800".repeat(${n}) + '"}');` +
    `let warned = "";` +
    `const e = new RequestEngine({ onWarning: (m) => (warned = m), transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body }) });` +
    `const value = await e.getJson("/x");` +
    `process.stdout.write(value.x.length + " " + /: (\\d+) characters/.exec(warned)[1]);`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, `${n} ${n}`);
});

// A password with characters a JSON writer escapes (a quote) or may write as \u00XX (an umlaut),
// and one a URL's query percent-encodes but encodeURIComponent doesn't (an apostrophe).
const ECHO_PW = "pä\"s's-W0rd";
const ECHO_BASE = `https://alice:${encodeURIComponent(ECHO_PW)}@mirror.example`;
/** The forms of the credential an error must not carry: decoded, and as JSON spells them (`\"`). */
const ECHO_SECRETS = [ECHO_PW, `alice:${ECHO_PW}`, Buffer.from(`alice:${ECHO_PW}`, "utf8").toString("base64")].flatMap((secret) => [
  secret,
  JSON.stringify(secret).slice(1, -1),
]);

/** Everything a library user may log of an error: inspect, message, detail, location, and the decoded body. */
function everythingOf(err: unknown): string {
  const e = err as { message?: unknown; detail?: unknown; location?: unknown; body?: unknown };
  let text = inspect(err, { depth: 10, showHidden: true }) + [e.message, e.detail, e.location, e.body].map(String).join("\n");
  const walk = (v: unknown): void => {
    if (typeof v === "string") text += `\n${v}`;
    else if (v !== null && typeof v === "object") for (const [k, w] of Object.entries(v)) (text += `\n${k}`), walk(w);
  };
  try {
    walk(typeof e.body === "string" ? JSON.parse(e.body) : undefined);
  } catch {
    // not JSON: the body as sent is all a caller reads
  }
  return text;
}

/** `text` as a JSON writer that escapes every non-ASCII character writes it (Python's json.dumps). */
const asciiJson = (text: string): string =>
  JSON.stringify(text).replace(/[\u0080-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** `text` with every character written as a \uXXXX escape: no spelling of it as sent matches. */
const escapedJson = (text: string): string => `"${[...text].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"`;

test("a credential echoed with JSON escapes is scrubbed from an error status, a failed envelope and a quoted station (class D)", async () => {
  const echoes = [asciiJson(`wrong password ${ECHO_PW}`), JSON.stringify(`bad login alice:${ECHO_PW}`), escapedJson(ECHO_PW), JSON.stringify(`no access to https://alice:${ECHO_PW}@mirror.example/x`)];
  const failure = async (answer: () => HttpResponse, call: (c: HochwasserzentralenClient) => Promise<unknown> = (c) => c.alerts()): Promise<unknown> => {
    const client = new HochwasserzentralenClient({ baseUrl: ECHO_BASE, maxRetries: 0, transport: makeMockTransport(answer).transport });
    return call(client).then(() => assert.fail("the call should have failed"), (err: unknown) => err);
  };
  for (const json of echoes) {
    // The API's JSend error on an error status, and a 2xx envelope that reports a failure.
    for (const [status, body] of [
      [401, `{"status":"fail","error":{"code":"UNAUTHORIZED","message":${json}}}`],
      [500, `{"message":${json}}`],
      [200, `{"status":"error","message":${json},"data":[]}`],
    ] as const) {
      const err = await failure(() => jsonResponse(body, status));
      assert.ok(err instanceof HochwasserzentralenApiError && err.status === status, String(err));
      const seen = everythingOf(err);
      for (const secret of ECHO_SECRETS) assert.ok(!seen.includes(secret), `${status} ${json}: ${seen.slice(0, 2000)}`);
    }
  }
  // A station whose id or class echoes the credential: quoted in the parse error, scrubbed before
  // it is cut (a cut first would leave the start of the password).
  for (const station of [
    { id: `${"x".repeat(95)}${ECHO_PW}`, lhpClass: 99 },
    { id: "BY_1", lhpClass: `${"y".repeat(30)}${ECHO_PW}` },
  ]) {
    const body = JSON.stringify({ ...fx.stationsJson, data: [station] });
    for (const call of [(c: HochwasserzentralenClient) => c.situation(), (c: HochwasserzentralenClient) => c.stations({ minClass: 1 })]) {
      const err = await failure(() => jsonResponse(body), call);
      assert.ok(err instanceof HochwasserzentralenParseError && /Unexpected lhpClass/.test(err.message), String(err));
      for (const secret of [...ECHO_SECRETS, 'pä"s', 'pä\\"s']) assert.ok(!err.message.includes(secret), err.message);
    }
  }
});

test("an error body keeps its spelling unless a credential hides behind an escape", async () => {
  const base = "https://alice:s3cret-pw@mirror.example";
  const bodyOf = async (body: string): Promise<string> => {
    const e = new RequestEngine({ baseUrl: base, transport: async () => rawResponse(body, "application/json", 500) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof HochwasserzentralenApiError, String(err));
    return err.body;
  };
  // No credential, or one spelled as sent: the body as sent (scrubbed), escapes kept.
  assert.equal(await bodyOf('{"m":"caf\\u00e9 \\"x\\""}'), '{"m":"caf\\u00e9 \\"x\\""}');
  assert.equal(await bodyOf('{"m":"pw s3cret-pw \\u00e9"}'), '{"m":"pw *** \\u00e9"}');
  // Escaped: written again decoded, scrubbed in that spelling.
  assert.equal(await bodyOf('{"m":"pw s3cret\\u002dpw \\u00e9"}'), '{"m":"pw *** é"}');
  // Not JSON: nobody decodes it, it stays as sent.
  assert.equal(await bodyOf("pw s3cret\\u002dpw"), "pw s3cret\\u002dpw");
  // Deeply nested: written again where this runtime can, else left out (probed, not assumed:
  // whether JSON.stringify recurses depends on the Node version).
  const deep = `${"[".repeat(200_000)}"s3cret\\u002dpw"${"]".repeat(200_000)}`;
  let parses = true;
  let writes = true;
  try {
    const value: unknown = JSON.parse(deep);
    try {
      JSON.stringify(value);
    } catch {
      writes = false;
    }
  } catch {
    parses = false;
  }
  if (parses) {
    const body = await bodyOf(deep);
    assert.ok(!body.includes("s3cret"), body.slice(199_990, 200_030));
    assert.equal(body === "", !writes);
  }
});

test("an echo of the request URL as sent is scrubbed, a short password too", async () => {
  // Typed raw; WHATWG sends `p%22%C3%A4` in the URL, which a server echoes.
  const e = new RequestEngine({
    baseUrl: 'https://alice:p"ä@mirror.example',
    transport: async (req) => rawResponse(JSON.stringify({ message: `no access: ${req.url}` }), "application/json", 403),
  });
  const err = await e.getJson("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof HochwasserzentralenApiError, String(err));
  for (const text of [err.message, err.detail ?? "", err.body]) {
    assert.ok(!text.includes("p%22%C3%A4@") && !text.includes('p"ä@'), text);
  }
});

test("a Content-Type, charset or Content-Encoding a parse error quotes is scrubbed first", async () => {
  const pw = "s3cret-Pw-long";
  for (const contentType of [`text/html; x=${pw}`, `application/json; charset=x-${pw}`]) {
    const e = new RequestEngine({ baseUrl: `https://alice:${pw}@mirror.example`, transport: async () => rawResponse("<html>", contentType) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof HochwasserzentralenParseError && !err.message.includes("s3cret"), String(err));
  }
  const e = new RequestEngine({
    baseUrl: `https://alice:${pw}@mirror.example`,
    transport: async () => ({ status: 200, headers: { "content-type": "application/json", "content-encoding": `gzip-${pw}` }, body: Buffer.from("{}") }),
  });
  const err = await e.getJson("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof HochwasserzentralenParseError && /Content-Encoding/.test(err.message) && !err.message.includes("s3cret"), String(err));
});

test("echoedCredentialForms treats a userinfo without a password as a token (Basic `TOKEN:`)", () => {
  const basic = (pair: string): string => Buffer.from(pair, "utf8").toString("base64");
  assert.deepEqual(echoedCredentialForms("alice:s3cret"), [basic("alice:s3cret"), "alice:s3cret", "s3cret"]);
  assert.deepEqual(echoedCredentialForms("T0ken"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T0ken:"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T%C3%B6k"), [basic("Tök:"), "Tök:"]); // short: not alone
  assert.deepEqual(echoedCredentialForms(":pw12"), [basic(":pw12"), ":pw12", "pw12"]);
  assert.deepEqual(echoedCredentialForms(""), []);
  assert.deepEqual(echoedCredentialForms(":"), []);
});
