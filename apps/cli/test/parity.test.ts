// CLI <-> library parity: the same input through run() and through the library,
// on one recording mock transport, must give the same outcome — both reject with
// no request, or both send the identical request and return the same data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HochwasserzentralenClient } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/client";
import {
  HochwasserzentralenNetworkError,
  HochwasserzentralenParseError,
  HochwasserzentralenValidationError,
} from "@maschinenlesbar.org/hochwasserzentralen-client/internal/errors";
import { stationsToGeoJson } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/geojson";
import type { HttpRequest } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/http";
import { credentialsIn } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/errors";
import type { Station, StationsParams, StationsResponse } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/types";
import { toEngineOptions } from "../src/cli/shared.js";
import { defaultDeps } from "../src/cli/program.js";
import { jsonResponse, parity } from "./helpers.js";
import * as fx from "@maschinenlesbar.org/hochwasserzentralen-client/test/fixtures";

const urls = (reqs: HttpRequest[]): string[] => reqs.map((r) => `${r.method} ${r.url}`);

// ---- situation (finding #1) ----------------------------------------------------

test("parity: situation --states be,hh equals client.situation({ states })", async () => {
  const { cli, lib } = await parity(
    ["--compact", "situation", "--states", "be,hh"],
    (transport) => new HochwasserzentralenClient({ transport }).situation({ states: ["be", "hh"] }),
    () => jsonResponse({ ...fx.stationsJson, data: fx.stationsJson.data.filter((s) => s.stateId === "DE-BE") }),
  );
  assert.equal(cli.code, 0, cli.err);
  assert.equal(lib.ok, true);
  assert.deepEqual(urls(lib.requests), urls(cli.requests));
  assert.deepEqual(JSON.parse(cli.out), lib.ok ? lib.value : undefined);
});

test("parity: plain situation lists all 16 states on both sides", async () => {
  const { cli, lib } = await parity(
    ["--compact", "situation"],
    (transport) => new HochwasserzentralenClient({ transport }).situation(),
    () => jsonResponse(fx.stationsJson),
  );
  assert.equal(cli.code, 0, cli.err);
  const value = lib.ok ? (lib.value as { states: unknown[] }) : undefined;
  assert.equal(value?.states.length, 16);
  assert.deepEqual(JSON.parse(cli.out), value);
});

test("parity: situation with an off-scale lhpClass fails with the same parse error on both sides", async () => {
  const data = [fx.stationsJson.data[0]!, { ...fx.stationsJson.data[2]!, lhpClass: 99 }];
  const { cli, lib } = await parity(
    ["--compact", "situation"],
    (transport) => new HochwasserzentralenClient({ transport }).situation(),
    () => jsonResponse({ ...fx.stationsJson, data }),
  );
  assert.equal(cli.code, 1);
  assert.equal(lib.ok, false);
  const error = lib.ok ? undefined : lib.error;
  assert.ok(error instanceof HochwasserzentralenParseError);
  assert.equal(cli.err, `ERROR [hochwasser.api] ${error.message}`);
});

// ---- stations --water / --min-class (finding #2) --------------------------------

const station = (id: string, water: string, lhpClass: unknown): Station => ({
  kind: "Station",
  id,
  coordinates: [13, 52],
  name: id,
  water,
  lhpClass: lhpClass as number,
  stateId: `DE-${id.slice(0, 2)}`,
});
const sixStations: StationsResponse = {
  ...fx.stationsJson,
  data: [
    station("BE_A", "Havel", 0),
    station("BE_B", "Spree–Oder-Wasserstraße", 2),
    station("BY_C", "Donau", 3),
    station("BY_D", "Isar", -1),
    station("MV_E", "Peene", null),
    station("SN_F", "Lausitzer Neiße", 1),
  ],
};
const ids = (value: unknown): string[] => (value as { data: Station[] }).data.map((s) => s.id);

for (const [argv, params, expected] of [
  [["--water", " donau "], { water: " donau " }, ["BY_C"]],
  [["--water", "NEISSE"], { water: "NEISSE" }, ["SN_F"]],
  [["--water", "spree-oder-wasserstrasse"], { water: "spree-oder-wasserstrasse" }, ["BE_B"]],
  [["--min-class", "2"], { minClass: 2 }, ["BE_B", "BY_C"]],
  [["--min-class", "-1"], { minClass: -1 }, ["BE_A", "BE_B", "BY_C", "BY_D", "SN_F"]],
  [["--water", "a", "--min-class", "1"], { water: "a", minClass: 1 }, ["BE_B", "BY_C", "SN_F"]],
] as Array<[string[], StationsParams, string[]]>) {
  test(`parity: stations ${argv.join(" ")} equals client.stations(${JSON.stringify(params)})`, async () => {
    const { cli, lib } = await parity(
      ["--compact", "stations", ...argv],
      (transport) => new HochwasserzentralenClient({ transport }).stations(params),
      () => jsonResponse(sixStations),
    );
    assert.equal(cli.code, 0, cli.err);
    assert.equal(lib.ok, true);
    assert.deepEqual(urls(lib.requests), urls(cli.requests));
    assert.deepEqual(ids(JSON.parse(cli.out)), expected);
    assert.deepEqual(JSON.parse(cli.out), lib.ok ? lib.value : undefined);
  });
}

for (const [argv, params, reason] of [
  [["--min-class", "9"], { minClass: 9 }, "Expected an integer between -1 and 4."],
  [["--water", "  "], { water: "  " }, "Expected a non-empty value."],
] as Array<[string[], StationsParams, string]>) {
  test(`parity: stations ${argv.join(" ")} is rejected on both sides before any request`, async () => {
    const { cli, lib } = await parity(
      ["--compact", "stations", ...argv],
      (transport) => new HochwasserzentralenClient({ transport }).stations(params),
      () => jsonResponse(sixStations),
    );
    assert.equal(cli.code, 2);
    assert.match(cli.err, new RegExp(reason.replace(/[.]/g, "\\.")));
    assert.equal(cli.requests.length, 0);
    assert.equal(lib.ok, false);
    const error = lib.ok ? undefined : lib.error;
    assert.ok(error instanceof HochwasserzentralenValidationError);
    assert.equal(error.message, `Invalid ${Object.keys(params)[0]}: ${reason}`);
    assert.equal(lib.requests.length, 0);
  });
}

test("parity: stations --water donau --geojson equals stationsToGeoJson(client.stations({ water }))", async () => {
  const { cli, lib } = await parity(
    ["--compact", "stations", "--water", "donau", "--geojson"],
    async (transport) => stationsToGeoJson(await new HochwasserzentralenClient({ transport }).stations({ water: "donau" })),
    () => jsonResponse(sixStations),
  );
  assert.equal(cli.code, 0, cli.err);
  assert.equal((JSON.parse(cli.out) as { features: unknown[] }).features.length, 1);
  assert.deepEqual(JSON.parse(cli.out), lib.ok ? lib.value : undefined);
});

test("parity: stations --min-class 1 with an off-scale string class fails the same on both sides", async () => {
  const data = { ...sixStations, data: [...sixStations.data, station("BY_X", "Main", "3")] };
  const { cli, lib } = await parity(
    ["--compact", "stations", "--min-class", "1"],
    (transport) => new HochwasserzentralenClient({ transport }).stations({ minClass: 1 }),
    () => jsonResponse(data),
  );
  assert.equal(cli.code, 1);
  const error = lib.ok ? undefined : lib.error;
  assert.ok(error instanceof HochwasserzentralenParseError);
  assert.match(error.message, /Unexpected lhpClass "3" at station "BY_X"/);
  assert.equal(cli.err, `ERROR [hochwasser.api] ${error.message}`);
});

// ---- --user-agent / userAgent (finding #4) --------------------------------------

for (const [ua, reason] of [
  ["a\r\nX-Injected: 1", "Value contains control characters."],
  ["agent\u0000", "Value contains control characters."],
  ["agent\u007f", "Value contains control characters."],
  ["agent €", "Value contains characters outside Latin-1 (above U+00FF)."],
  ["", "Expected a non-empty value."],
  ["   ", "Expected a non-empty value."],
] as const) {
  test(`parity: User-Agent ${JSON.stringify(ua)} is rejected on both sides before any request`, async () => {
    const { cli, lib } = await parity(
      ["--compact", "--user-agent", ua, "stations"],
      (transport) => new HochwasserzentralenClient({ transport, userAgent: ua }).stations(),
      () => jsonResponse(fx.stationsJson),
    );
    assert.equal(cli.code, 2);
    assert.equal(cli.requests.length, 0);
    assert.ok(cli.err.includes(reason), cli.err);
    assert.equal(lib.ok, false);
    const error = lib.ok ? undefined : lib.error;
    assert.ok(error instanceof HochwasserzentralenValidationError);
    assert.equal(error.message, `Invalid userAgent: ${reason}`);
    assert.equal(lib.requests.length, 0);
  });
}

for (const ua of [" ok-agent ", "café/1.0", "a\tb"]) {
  test(`parity: User-Agent ${JSON.stringify(ua)} is sent as is on both sides`, async () => {
    const { cli, lib } = await parity(
      ["--compact", "--user-agent", ua, "stations"],
      (transport) => new HochwasserzentralenClient({ transport, userAgent: ua }).stations(),
      () => jsonResponse(fx.stationsJson),
    );
    assert.equal(cli.code, 0, cli.err);
    assert.equal(lib.ok, true);
    assert.deepEqual(
      lib.requests.map((r) => r.headers?.["User-Agent"]),
      cli.requests.map((r) => r.headers?.["User-Agent"]),
    );
    assert.equal(cli.requests[0]?.headers?.["User-Agent"], ua);
  });
}

// ---- --base-url / baseUrl (finding #5) ------------------------------------------

for (const [baseUrl, reason] of [
  ["ftp://h/v1", "Only http: and https: base URLs are supported."],
  ["file:///etc", "Only http: and https: base URLs are supported."],
  ["", "Expected a non-empty URL."],
  ["   ", "Expected a non-empty URL."],
  ["h.example", "Expected a valid URL."],
  ["http://h/v1?x", "A base URL cannot have a query (?) or fragment (#)."],
  ["http://h/v1#f", "A base URL cannot have a query (?) or fragment (#)."],
] as const) {
  test(`parity: base URL ${JSON.stringify(baseUrl)} is a validation error on both sides`, async () => {
    const { cli, lib } = await parity(
      ["--compact", "--base-url", baseUrl, "stations"],
      (transport) => new HochwasserzentralenClient({ transport, baseUrl }).stations(),
      () => jsonResponse(fx.stationsJson),
    );
    assert.equal(cli.code, 2);
    assert.equal(cli.requests.length, 0);
    assert.ok(cli.err.includes(reason), cli.err);
    assert.equal(lib.ok, false);
    const error = lib.ok ? undefined : lib.error;
    assert.ok(error instanceof HochwasserzentralenValidationError, String(error));
    assert.ok(!(error instanceof HochwasserzentralenNetworkError));
    assert.equal(error.message, `Invalid baseUrl: ${reason}`);
    assert.equal(lib.requests.length, 0);
  });
}

test("parity: a base URL with a trailing slash requests the same URL on both sides", async () => {
  const { cli, lib } = await parity(
    ["--compact", "--base-url", "http://h/v1/", "stations"],
    (transport) => new HochwasserzentralenClient({ transport, baseUrl: "http://h/v1/" }).stations(),
    () => jsonResponse(fx.stationsJson),
  );
  assert.equal(cli.code, 0, cli.err);
  assert.deepEqual(urls(cli.requests), ["GET http://h/v1/data/stations"]);
  assert.deepEqual(urls(lib.requests), urls(cli.requests));
});

// ---- --states / states (finding #6) ---------------------------------------------

const CODES = "BB, BE, BW, BY, HB, HE, HH, MV, NI, NW, RP, SH, SL, SN, ST, TH";
for (const [command, flag, states, reason] of [
  ["alerts", " xx ", [" xx "], `Unknown state code "xx". Expected one of: ${CODES}.`],
  ["stations", "BY,xx", ["BY", "xx"], `item 2 of 2: Unknown state code "xx". Expected one of: ${CODES}.`],
  ["situation", " xx ", [" xx "], `Unknown state code "xx". Expected one of: ${CODES}.`],
  ["alerts", " , ,", [" ", "", " "], "item 1 of 3: Expected a non-empty value."],
  ["alerts", "BY,,SN", ["BY", "", "SN"], "item 2 of 3: Expected a non-empty value."],
  ["stations", "BY\u200b", ["BY\u200b"], '"BY\\u200b" contains an invisible or control character (U+200B).'],
] as const) {
  test(`parity: ${command} --states ${JSON.stringify(flag)} is rejected with one message on both sides`, async () => {
    const { cli, lib } = await parity(
      ["--compact", command, "--states", flag],
      (transport) => new HochwasserzentralenClient({ transport })[command]({ states }),
    );
    assert.equal(cli.code, 2);
    assert.equal(cli.requests.length, 0);
    assert.ok(cli.err.includes(`is invalid. ${reason}`), cli.err);
    assert.equal(lib.ok, false);
    const error = lib.ok ? undefined : lib.error;
    assert.ok(error instanceof HochwasserzentralenValidationError);
    assert.equal(error.message, `Invalid states: ${reason}`);
    assert.equal(lib.requests.length, 0);
  });
}

test("parity: --states ' by , sn,BY' sends the same normalised states as the library", async () => {
  const { cli, lib } = await parity(
    ["--compact", "stations", "--states", " by , sn,BY"],
    (transport) => new HochwasserzentralenClient({ transport }).stations({ states: [" by ", " sn", "BY"] }),
    () => jsonResponse(fx.stationsJson),
  );
  assert.equal(cli.code, 0, cli.err);
  assert.deepEqual(urls(cli.requests), ["GET https://api.hochwasserzentralen.de/public/v1/data/stations?states=BY%2CSN"]);
  assert.deepEqual(urls(lib.requests), urls(cli.requests));
});

// ---- toEngineOptions hands the User-Agent through (finding #7) ------------------

for (const ua of ["", "   ", "\t"]) {
  test(`parity: toEngineOptions passes a blank User-Agent ${JSON.stringify(ua)} to the library, which rejects it`, () => {
    const options = toEngineOptions({ userAgent: ua });
    assert.deepEqual(options, { userAgent: ua });
    const viaCli = (): unknown => defaultDeps.createClient(options);
    const viaLib = (): unknown => new HochwasserzentralenClient({ userAgent: ua });
    for (const make of [viaCli, viaLib]) {
      assert.throws(
        make,
        (e: unknown) =>
          e instanceof HochwasserzentralenValidationError && e.message === "Invalid userAgent: Expected a non-empty value.",
      );
    }
  });
}

test("toEngineOptions passes a set User-Agent through unchanged and leaves an unset one to the library", () => {
  assert.deepEqual(toEngineOptions({ userAgent: " x " }), { userAgent: " x " });
  assert.deepEqual(toEngineOptions({}), {});
});

test("parity: --water with an invisible, control or half character is refused on both sides, shown escaped (04-1, D8)", async () => {
  for (const [water, shown] of [["Mul\u00adde", "\\u00ad"], ["El\u200bbe", "\\u200b"], ["El\u2060be", "\\u2060"], ["\u200b", ""], ["x\ud800", "\\ud800"]] as const) {
    const { cli, lib } = await parity(
      ["--compact", "stations", "--water", water],
      (transport) => new HochwasserzentralenClient({ transport }).stations({ water }),
      () => jsonResponse(fx.stationsJson),
    );
    assert.equal(cli.code, 2, `${JSON.stringify(water)}: ${cli.err}`);
    assert.equal(cli.requests.length, 0);
    assert.equal(lib.ok, false);
    assert.equal(lib.requests.length, 0);
    const error = lib.ok ? undefined : lib.error;
    assert.ok(error instanceof HochwasserzentralenValidationError);
    if (shown !== "") {
      assert.ok(cli.err.includes(shown) && error.message.includes(shown), `${cli.err} | ${error.message}`);
      assert.ok(!cli.err.includes(water), "shown raw");
    }
  }
});

test("parity: a refused value shows its invisible characters escaped, on both sides (04-2, D10)", async () => {
  for (const [states, shown] of [["BY\u200b", "\\u200b"], ["B\u00adY", "\\u00ad"], ["\u202eBY", "\\u202e"]] as const) {
    const { cli, lib } = await parity(
      ["--compact", "stations", "--states", states],
      (transport) => new HochwasserzentralenClient({ transport }).stations({ states: [states] }),
    );
    assert.equal(cli.code, 2);
    const error = lib.ok ? undefined : lib.error;
    assert.ok(error instanceof HochwasserzentralenValidationError);
    for (const text of [cli.err, error.message]) {
      assert.ok(text.includes(shown), `${shown} not shown: ${text}`);
      assert.ok(!text.includes(states.replace("BY", "").replace("B", "").replace("Y", "")), `shown raw: ${text}`);
    }
  }
  // An unknown key of a parameter object is quoted visibly too.
  await assert.rejects(new HochwasserzentralenClient().stations({ "Wat\u200ber": "elbe" } as never), /Unknown key "Wat\\u200ber"/);
});

// ---- base-URL credentials (security audit 2026-10-27, portfolio round) -------------

const TOKEN = "T0kenS3cret";
const basicOf = (pair: string): string => Buffer.from(pair, "utf8").toString("base64");
/** An alerts answer that carries `value` in a member the CLI prints. */
const alertsWith = (value: string) => () => jsonResponse(`{"status":"success","data":[],"x":${JSON.stringify(value)}}`);

test("a userinfo without a password is a token: scrubbed from library errors and redacted from what the CLI prints (class E)", async () => {
  for (const base of [`https://${TOKEN}@mirror.example`, `https://${TOKEN}:@mirror.example`]) {
    for (const echo of [`bad token ${TOKEN}`, `Authorization: Basic ${basicOf(`${TOKEN}:`)}`, `user ${TOKEN}: unknown`]) {
      const o = await parity(["--base-url", base, "--max-retries", "0", "alerts"], (t) => new HochwasserzentralenClient({ baseUrl: base, transport: t, maxRetries: 0 }).alerts(), () =>
        jsonResponse({ status: "fail", error: { code: "UNAUTHORIZED", message: echo } }, 401),
      );
      assert.ok(!o.lib.ok);
      const e = o.lib.error as Error & { detail?: unknown; body?: unknown };
      const seen = [e.message, e.detail, e.body].map(String).join("\n");
      assert.ok(/^HTTP 401 /.test(e.message), e.message);
      assert.ok(!seen.includes(TOKEN) && !seen.includes(basicOf(`${TOKEN}:`)), `${base} ${echo}: ${seen}`);
      assert.notEqual(o.cli.code, 0);
      assert.ok(!o.cli.err.includes(TOKEN), o.cli.err);
    }
  }
  // A 2xx answer that echoes the Basic value and `TOKEN:`: stdout.
  const base = `https://${TOKEN}@mirror.example`;
  const echoed = await parity(["--base-url", base, "--compact", "alerts"], (t) => new HochwasserzentralenClient({ baseUrl: base, transport: t }).alerts(), alertsWith(`Basic ${basicOf(`${TOKEN}:`)} for ${TOKEN}:x`));
  assert.equal(echoed.cli.code, 0, echoed.cli.err);
  assert.ok(!echoed.cli.out.includes(basicOf(`${TOKEN}:`)) && !echoed.cli.out.includes(`${TOKEN}:`), echoed.cli.out);
});

test("a backslash, or a scheme not followed by exactly // and the host, is refused by the library and by --base-url, never echoing the password (class F)", async () => {
  const pw = "s3cret-Pw";
  for (const base of [
    `https://alice:${pw}@api.example\\@evil.example`,
    "https://api.example\\evil",
    `http://alice:${pw}@127.0.0.1\\@evil.example`,
    `http:alice:${pw}@127.0.0.1:9`,
    `http:/alice:${pw}@127.0.0.1:9`,
    `http:///alice:${pw}@127.0.0.1:9`,
    `HTTPS:alice:${pw}@mirror.example`,
    `https:\\\\alice:${pw}@mirror.example`,
    `http:///alice:${pw}@mirror.example/?q=1`,
  ]) {
    const o = await parity(["--base-url", base, "alerts"], (t) => new HochwasserzentralenClient({ baseUrl: base, transport: t }).alerts());
    assert.ok(!o.lib.ok && o.lib.error instanceof HochwasserzentralenValidationError, `${base}: accepted`);
    assert.ok(!(o.lib.error as Error).message.includes(pw), (o.lib.error as Error).message);
    assert.equal(o.cli.code, 2, `${base}: ${o.cli.err}`);
    assert.equal(o.cli.requests.length + o.lib.requests.length, 0);
    assert.ok(!o.cli.err.includes(pw) && !o.cli.out.includes(pw), o.cli.err);
  }
  for (const base of [`http:alice:${pw}@mirror.example`, "https:/mirror.example", "http:///mirror.example"]) {
    const o = await parity(["--base-url", base, "alerts"], (t) => new HochwasserzentralenClient({ baseUrl: base, transport: t }).alerts());
    assert.match(o.cli.err, /"https:\/\/" and the host/, base);
  }
  assert.match((await parity(["--base-url", "https://api.example\\evil", "alerts"], () => undefined)).cli.err, /backslash/);
  // The userinfo ends where WHATWG ends the authority, and starts after the slashes it skips.
  assert.deepEqual(credentialsIn("https://alice:pw@api.example\\@evil.example/x"), ["alice:pw"]);
  for (const value of ["http:alice:pw@h.example", "http:///alice:pw@h.example/x", "HTTPS:\\\\alice:pw@h.example"]) {
    assert.deepEqual(credentialsIn(value), ["alice:pw"], value);
  }
});

test("requests go to the host of the parsed base URL, spelled as it parses, an @ in its path included (class F)", async () => {
  for (const base of ["https://alice:pw@api.example/v1/@evil.example", "https://API.Example:443/v1"]) {
    const parsed = new URL(base);
    const o = await parity(["--base-url", base, "alerts"], (t) => new HochwasserzentralenClient({ baseUrl: base, transport: t }).alerts(), () =>
      jsonResponse({ status: "success", data: [] }),
    );
    assert.equal(o.cli.requests.length, 1, o.cli.err);
    assert.equal(o.lib.requests.length, 1);
    for (const req of [...o.cli.requests, ...o.lib.requests]) {
      assert.equal(new URL(req.url).origin, parsed.origin, `${base}: ${req.url}`);
      const authority = req.url.slice(req.url.indexOf("//") + 2).split("/")[0] ?? "";
      assert.ok(authority === parsed.host || authority.endsWith(`@${parsed.host}`), `${base}: ${req.url}`);
    }
  }
});
