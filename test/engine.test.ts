import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, parseRetryAfter } from "../src/client/engine.js";
import {
  HochwasserzentralenApiError,
  HochwasserzentralenNetworkError,
  HochwasserzentralenParseError,
  HochwasserzentralenValidationError,
} from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import * as fx from "./fixtures.js";
import { HochwasserzentralenClient } from "../src/client/client.js";

test("a non-http(s) base URL is rejected at construction, before any request reaches a custom transport", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse(fx.alertsJson));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) => err instanceof HochwasserzentralenNetworkError && /Unsupported protocol/.test(err.message),
    );
    assert.throws(
      () => new HochwasserzentralenClient({ baseUrl, transport: mt.transport }),
      (err) => err instanceof HochwasserzentralenNetworkError && /Unsupported protocol/.test(err.message),
    );
    assert.equal(mt.calls.length, 0);
  }
  assert.throws(
    () => new RequestEngine({ baseUrl: "not a url", transport: makeMockTransport(() => jsonResponse({})).transport }),
    (err) => err instanceof HochwasserzentralenNetworkError && /Invalid base URL/.test(err.message),
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
    (err) => err instanceof HochwasserzentralenParseError && /Failed to parse JSON/.test(err.message),
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
      assert.equal(err.detail, "boom[31mred2J");
      return true;
    },
  );
});

test("a base URL with a query or fragment is rejected at construction", () => {
  for (const baseUrl of ["https://example.org/v1?x=1", "https://example.org/v1#x"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: makeMockTransport(() => jsonResponse({})).transport }),
      (err) => err instanceof HochwasserzentralenNetworkError && /must not contain a query or fragment/.test(err.message),
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
