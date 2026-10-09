// CLI <-> library parity: the same input through run() and through the library,
// on one recording mock transport, must give the same outcome — both reject with
// no request, or both send the identical request and return the same data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HochwasserzentralenClient } from "../src/client/client.js";
import {
  HochwasserzentralenNetworkError,
  HochwasserzentralenParseError,
  HochwasserzentralenValidationError,
} from "../src/client/errors.js";
import { stationsToGeoJson } from "../src/client/geojson.js";
import type { HttpRequest } from "../src/client/http.js";
import type { Station, StationsParams, StationsResponse } from "../src/client/types.js";
import { toEngineOptions } from "../src/cli/shared.js";
import { defaultDeps } from "../src/cli/program.js";
import { jsonResponse, parity } from "./helpers.js";
import * as fx from "./fixtures.js";

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
  ["stations", "BY,xx", ["BY", "xx"], `Unknown state code "xx". Expected one of: ${CODES}.`],
  ["situation", " xx ", [" xx "], `Unknown state code "xx". Expected one of: ${CODES}.`],
  ["alerts", " , ,", [" ", "", " "], `No usable state code given. Expected one or more of: ${CODES}.`],
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
