import { test } from "node:test";
import assert from "node:assert/strict";
import { HochwasserzentralenClient, normalizeStates } from "../src/client/client.js";
import {
  HochwasserzentralenApiError,
  HochwasserzentralenParseError,
  HochwasserzentralenValidationError,
} from "../src/client/errors.js";
import { alertsToGeoJson, stationsToGeoJson } from "../src/client/geojson.js";
import type { AlertsResponse, Station, StationsResponse } from "../src/client/types.js";
import { aggregateSituation, filterStations, foldName, onlyStates, stationClass } from "../src/client/stations.js";
import * as lib from "../src/index.js";
import { makeMockTransport, jsonResponse, queryOf, rawResponse } from "./helpers.js";
import * as fx from "./fixtures.js";

test("alerts() GETs /data/alerts with no query by default", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.alertsJson));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  await c.alerts();
  const req = mt.last();
  assert.equal(req.method, "GET");
  assert.equal(new URL(req.url).pathname, "/public/v1/data/alerts");
  assert.equal(new URL(req.url).search, "");
});

test("alerts({states}) joins the codes into one comma-separated states param", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.alertsJson));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  await c.alerts({ states: ["BY", "SN"] });
  assert.equal(queryOf(mt.last()).get("states"), "BY,SN");
});

test("alerts({cap: true}) sends cap=true; cap omitted otherwise", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.alertsJson));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  await c.alerts({ cap: true });
  assert.equal(queryOf(mt.last()).get("cap"), "true");
  await c.alerts({});
  assert.equal(queryOf(mt.last()).get("cap"), null);
});

test("alerts({lang}) sets the Accept-Language header", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.alertsJson));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  await c.alerts({ lang: "en" });
  assert.equal(mt.last().headers?.["Accept-Language"], "en");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

test("stations() GETs /data/stations and maps the typed response", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.stationsJson));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  const res = await c.stations({ states: ["BE"] });
  assert.equal(new URL(mt.last().url).pathname, "/public/v1/data/stations");
  assert.equal(queryOf(mt.last()).get("states"), "BE");
  assert.equal(res.data[1]!.water, "Spree-Oder-Wasserstrasse");
  assert.equal(res.data[1]!.lhpClass, 2);
  assert.equal(res.stateLinks?.["DE-BE"], "https://wasserportal.berlin.de");
  assert.equal(res.updated, "2026-07-13T10:43:47+01:00");
});

test("an unknown state code is rejected client-side — no request is made", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.stationsJson));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  await assert.rejects(
    () => c.stations({ states: ["BE", "XX"] }),
    (err) => err instanceof HochwasserzentralenValidationError && /XX/.test(err.message),
  );
  assert.equal(mt.calls.length, 0);
});

test("stations() throws HochwasserzentralenParseError when the response's data is not an array", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ...fx.stationsJson, data: { message: "maintenance" } }));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  await assert.rejects(
    () => c.stations(),
    (err) => err instanceof HochwasserzentralenParseError && /data.*array.*data\/stations/.test(err.message),
  );
});

test("alerts() throws HochwasserzentralenParseError when the response's data is not an array", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ...fx.alertsJson, data: null }));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  await assert.rejects(
    () => c.alerts(),
    (err) => err instanceof HochwasserzentralenParseError && /data.*array.*data\/alerts/.test(err.message),
  );
});

test("a GeoJSON representation served in place of plain JSON gets a transient-cache error message", async () => {
  // Live 2026-09-15: the API's cache varies only on Accept-Encoding and now and
  // then answers `Accept: application/json` with the geo+json body.
  const { data: _data, ...envelope } = fx.stationsJson;
  const geo = { ...envelope, type: "FeatureCollection", features: [] };
  const mt = makeMockTransport(() => rawResponse(JSON.stringify(geo), "application/geo+json; charset=UTF-8"));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  await assert.rejects(
    () => c.stations(),
    (err) =>
      err instanceof HochwasserzentralenParseError &&
      /GeoJSON representation/.test(err.message) &&
      /\/data\/stations/.test(err.message) &&
      /transient/.test(err.message) &&
      /retry/.test(err.message),
  );
  await assert.rejects(
    () => c.alerts(),
    (err) => err instanceof HochwasserzentralenParseError && /\/data\/alerts.*transient/.test(err.message),
  );
});

test("a non-object JSON body is still a HochwasserzentralenParseError", async () => {
  const mt = makeMockTransport(() => jsonResponse("null"));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  await assert.rejects(
    () => c.stations(),
    (err) => err instanceof HochwasserzentralenParseError && /expected a JSON object, got null/.test(err.message),
  );
});

test("normalizeStates upper-cases, trims and de-duplicates", () => {
  assert.deepEqual(normalizeStates(["by", " sn ", "BY"]), ["BY", "SN"]);
  assert.throws(() => normalizeStates([""]), HochwasserzentralenValidationError);
  assert.throws(() => normalizeStates(["bavaria"]), HochwasserzentralenValidationError);
});

test("alerts fixture maps typed fields incl. the CAP block", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.alertsJson));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  const res = await c.alerts({ cap: true });
  assert.equal(res.data.length, 2);
  const by = res.data[0]!;
  assert.equal(by.id, "BY_577");
  assert.equal(by.lhpClass, "4"); // alerts lhpClass is a STRING
  assert.equal(by.cap?.info?.severity, "Moderate");
  assert.equal(res.data[1]!.lhpClassName, "Vorwarnung");
});

test("stationsToGeoJson builds Point features in [lon, lat] order with attribution", () => {
  const fc = stationsToGeoJson(fx.stationsJson);
  assert.equal(fc.type, "FeatureCollection");
  assert.equal(fc.features.length, 4);
  const f = fc.features[0]!;
  assert.deepEqual(f.geometry, { type: "Point", coordinates: [13.1239, 52.4303] });
  assert.equal(f.properties["name"], "Pfaueninsel");
  assert.equal(f.properties["lhpClass"], 0);
  // CC BY foreign members survive on the collection.
  assert.equal(fc.updated, fx.stationsJson.updated);
  assert.equal(fc.sourceName, "Länderübergreifendes Hochwasserportal (LHP)");
});

test("stationsToGeoJson skips stations without usable coordinates", () => {
  const broken = {
    ...fx.stationsJson,
    data: [{ ...fx.stationsJson.data[0]!, coordinates: undefined }, fx.stationsJson.data[1]!],
  };
  const fc = stationsToGeoJson(broken);
  assert.equal(fc.features.length, 1);
});

test("stationsToGeoJson computes an RFC 7946 bbox [west, south, east, north] from the exported points", () => {
  // The API envelope's bbox is a fixed Germany box in [west, north, east, south]
  // order; it must not be copied into the export.
  const fc = stationsToGeoJson(fx.stationsJson);
  assert.deepEqual(fc.bbox, [11.5581, 48.1421, 13.574, 52.4303]);
  const oneStation = { ...fx.stationsJson, data: [fx.stationsJson.data[2]!] };
  assert.deepEqual(stationsToGeoJson(oneStation).bbox, [12.1211, 49.0342, 12.1211, 49.0342]);
});

test("the GeoJSON export omits bbox when no feature is exported", () => {
  const fc = stationsToGeoJson({ ...fx.stationsJson, data: [] });
  assert.equal(fc.features.length, 0);
  assert.equal("bbox" in fc, false);
  assert.equal("bbox" in alertsToGeoJson({ ...fx.alertsJson, data: [] }), false);
});

test("alertsToGeoJson computes the bbox over every polygon vertex", () => {
  const fc = alertsToGeoJson(fx.alertsJson);
  assert.deepEqual(fc.bbox, [12.1, 48.9, 13.6, 51.1]);
});

test("alertsToGeoJson uses the alert geometry verbatim and keeps the CAP block", () => {
  const fc = alertsToGeoJson(fx.alertsJson);
  assert.equal(fc.features.length, 2);
  const f = fc.features[0]!;
  assert.deepEqual(f.geometry, fx.alertsJson.data[0]!.geometry);
  assert.equal(f.properties["areaDesc"], "Donau von Regensburg bis Straubing");
  assert.equal((f.properties["cap"] as { identifier?: string }).identifier, "LHP.BY.20260713_577");
  assert.equal(fc.updated, fx.alertsJson.updated);
});

test("a null or scalar data item, or a station without an id, is a HochwasserzentralenParseError", async () => {
  const station = fx.stationsJson.data[0]!;
  const cases: Array<[() => HochwasserzentralenClient, "stations" | "alerts", RegExp]> = [
    [() => client({ ...fx.stationsJson, data: [station, null] }), "stations", /data\/stations: .*item 1 is null/],
    [() => client({ ...fx.stationsJson, data: [7] }), "stations", /item 0 is number/],
    [() => client({ ...fx.alertsJson, data: [null] }), "alerts", /data\/alerts: .*item 0 is null/],
    [() => client({ ...fx.stationsJson, data: [{ ...station, id: undefined }] }), "stations", /string id, item 0/],
  ];
  for (const [make, method, re] of cases) {
    await assert.rejects(
      () => make()[method](),
      (err) => err instanceof HochwasserzentralenParseError && /Unexpected response shape/.test(err.message) && re.test(err.message),
    );
  }
});

function client(body: unknown): HochwasserzentralenClient {
  return new HochwasserzentralenClient({ transport: makeMockTransport(() => jsonResponse(body)).transport });
}

test("alertsToGeoJson skips invalid geometries and computes the bbox inside a GeometryCollection", () => {
  const base = fx.alertsJson.data[0]!;
  const data = [
    { ...base, id: "gc", geometry: { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [50, 50] }] } },
    { ...base, id: "line", geometry: { type: "LineString", coordinates: [[8.3, 49.6], [8.1, 50.0]] } },
    { ...base, id: "string", geometry: "garbage" },
    { ...base, id: "unknown", geometry: { type: "Circle", coordinates: [1, 2] } },
    { ...base, id: "range", geometry: { type: "Polygon", coordinates: [[[-179, -80], [5, 6], [200, 95], [-179, -80]]] } },
    { ...base, id: "nan", geometry: { type: "Point", coordinates: ["a", 1] } },
    { ...base, id: "empty-gc", geometry: { type: "GeometryCollection", geometries: [] } },
  ];
  const fc = alertsToGeoJson({ ...fx.alertsJson, data } as unknown as AlertsResponse);
  assert.deepEqual(fc.features.map((f) => f.properties["id"]), ["gc", "line"]);
  assert.deepEqual(fc.bbox, [8.1, 49.6, 50, 50]);
});

test("stationsToGeoJson skips stations whose coordinates are out of range", () => {
  const base = fx.stationsJson.data[0]!;
  const data = [
    { ...base, id: "ok", coordinates: [11, 48] },
    { ...base, id: "far", coordinates: [200, 95] },
    { ...base, id: "inf", coordinates: [Infinity, 48] },
  ];
  const fc = stationsToGeoJson({ ...fx.stationsJson, data });
  assert.deepEqual(fc.features.map((f) => f.properties["id"]), ["ok"]);
  assert.deepEqual(fc.bbox, [11, 48, 11, 48]);
});

test("library params are validated before any request: states must be an array, lang one of de/en", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.stationsJson));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  const bad: Array<[() => Promise<unknown>, RegExp]> = [
    [() => c.stations({ states: "BY" as unknown as string[] }), /^Invalid states: expected an array of state codes, got "BY"\.$/],
    [() => c.alerts({ states: [1] as unknown as string[] }), /^Invalid states/],
    [() => c.stations({ lang: "fr" as "de" }), /^Invalid lang: expected one of de, en, got "fr"\.$/],
    [() => c.alerts({ lang: "de\r\nX-Evil: 1" as "de" }), /^Invalid lang/],
  ];
  for (const [call, re] of bad) {
    await assert.rejects(call, (err) => err instanceof HochwasserzentralenValidationError && re.test(err.message));
  }
  assert.equal(mt.calls.length, 0);
});

// ---- situation() / aggregateSituation / stationClass ---------------------------

test("situation() makes one /data/stations request and aggregates it per state", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.stationsJson));
  const sit = await new HochwasserzentralenClient({ transport: mt.transport }).situation({ states: ["by", "hh"] });
  assert.equal(mt.calls.length, 1);
  assert.equal(new URL(mt.last().url).pathname, "/public/v1/data/stations");
  assert.equal(queryOf(mt.last()).get("states"), "BY,HH");
  assert.equal(sit.worstClass, 3);
  assert.equal(sit.worstClassName, "Großes Hochwasser");
  assert.equal(sit.licenceName, fx.stationsJson.licenceName);
  assert.equal(sit.updated, fx.stationsJson.updated);
  // The library normalises the requested states itself; HH has no gauge but is listed,
  // and the BE gauges the mock sent although only BY,HH were asked for are left out.
  assert.deepEqual(
    sit.states.map((s) => [s.state, s.stations, s.worstClass]),
    [
      ["BY", 2, 3],
      ["HH", 0, null],
    ],
  );
  assert.equal(sit.totalStations, 2);
});

test("situation() rejects a bad states / lang before any request", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.stationsJson));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  await assert.rejects(c.situation({ states: ["XX"] }), HochwasserzentralenValidationError);
  await assert.rejects(c.situation({ lang: "fr" as "de" }), HochwasserzentralenValidationError);
  assert.equal(mt.calls.length, 0);
});

test("aggregateSituation zero-fills requested states without gauges and counts a null lhpClass in -1", () => {
  const data = [{ ...fx.stationsJson.data[0]!, lhpClass: null as unknown as number }];
  const sit = aggregateSituation({ ...fx.stationsJson, data }, ["BE", "HH"]);
  assert.equal(sit.totalStations, 1);
  assert.equal(sit.worstClass, -1);
  assert.deepEqual(sit.states[0], {
    state: "BE",
    stateId: "DE-BE",
    stations: 1,
    worstClass: -1,
    worstClassName: "Derzeit keine Daten",
    classes: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "-1": 1 },
  });
  assert.deepEqual(sit.states[1]!.worstClass, null);
  assert.equal(aggregateSituation({ ...fx.stationsJson, data: [] }).states.length, 16);
});

test("stationClass accepts -1..4 and null, and throws a parse error for an off-scale value", () => {
  const st = (lhpClass: unknown): Station => ({ kind: "Station", id: "BY_1", lhpClass: lhpClass as number });
  for (const ok of [-1, 0, 4]) assert.equal(stationClass(st(ok)), ok);
  assert.equal(stationClass(st(null)), null);
  assert.equal(stationClass(st(undefined)), null);
  for (const bad of [99, 2.5, "3", -2, 5]) {
    assert.throws(
      () => stationClass(st(bad)),
      (e: unknown) => e instanceof HochwasserzentralenParseError && /Unexpected lhpClass .* at station "BY_1"/.test(e.message),
    );
  }
});

test("the situation helpers are exported from the package root", () => {
  assert.equal(lib.aggregateSituation, aggregateSituation);
  assert.equal(lib.stationClass, stationClass);
});

// ---- stations({ water, minClass }) / filterStations / foldName -------------------

test("foldName folds case, ß, Unicode form and dashes", () => {
  assert.equal(foldName("Lausitzer Neiße"), "lausitzer neisse");
  assert.equal(foldName("NEISSE"), "neisse");
  assert.equal(foldName("Spree–Oder-Wasserstraße"), "spree-oder-wasserstrasse");
  assert.equal(foldName("Müritz"), foldName("Müritz"));
  assert.equal(foldName(" Weiße \u00a0 Elster\t"), "weisse elster");
  assert.equal(foldName("Große Röder"), "grosse roeder");
});

test("water finds names across whitespace runs, umlaut spellings and dropped diacritics (result 01 Bugs 2, 3)", () => {
  const station = (id: string, water: string) => ({ kind: "Station", id, stateId: "DE-SN", water, lhpClass: 0 });
  const body = {
    ...fx.stationsJson,
    data: [
      station("SN_1", "Weiße Elster"),
      station("SN_2", "Große Röder"),
      station("MV_1", "Müritz"),
      station("SN_3", "Lößnitzbach"),
      station("SN_4", "Elbe"),
    ],
  } as unknown as StationsResponse;
  const ids = (water: string) => filterStations(body, { water }).data.map((s) => s.id);
  for (const water of ["Weisse  Elster", "Weisse\u00a0Elster", "Weisse\tElster", "WEISSE ELSTER", " weiße elster "]) {
    assert.deepEqual(ids(water), ["SN_1"], JSON.stringify(water));
  }
  for (const water of ["Roeder", "Röder", "ROEDER", "Roder"]) assert.deepEqual(ids(water), ["SN_2"], water);
  for (const water of ["Mueritz", "Müritz", "Muritz"]) assert.deepEqual(ids(water), ["MV_1"], water);
  for (const water of ["Loessnitz", "Lößnitz", "Lossnitz"]) assert.deepEqual(ids(water), ["SN_3"], water);
  assert.deepEqual(ids("Elbe"), ["SN_4"]);
});

test("filterStations keeps the envelope, does not change its input and drops null classes", () => {
  const data = [...fx.stationsJson.data, { ...fx.stationsJson.data[0]!, id: "MV_1", lhpClass: null as unknown as number }];
  const res = { ...fx.stationsJson, data };
  const out = filterStations(res, { minClass: -1 });
  assert.equal(res.data.length, 5);
  assert.deepEqual(out.data.map((s) => s.id), ["BE_5803500", "BE_586290", "BY_10088003", "BY_16005701"]);
  assert.equal(out.licenceName, fx.stationsJson.licenceName);
  assert.deepEqual(filterStations(res, { water: " SPREE " }).data.map((s) => s.id), ["BE_586290"]);
  assert.deepEqual(filterStations(res, {}).data.length, 5);
});

test("filterStations throws a parse error for an off-scale class under minClass", () => {
  const res = { ...fx.stationsJson, data: [{ ...fx.stationsJson.data[0]!, lhpClass: "Hochwasser" as unknown as number }] };
  assert.throws(() => filterStations(res, { minClass: 1 }), HochwasserzentralenParseError);
  // Without minClass the class is not looked at (plain stations() passes it through).
  assert.equal(filterStations(res, { water: "havel" }).data.length, 1);
});

test("stations() rejects a bad water / minClass before any request", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.stationsJson));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  for (const params of [{ water: "" }, { water: 3 }, { minClass: 2.5 }, { minClass: "2" }, { minClass: 5 }]) {
    await assert.rejects(c.stations(params as object), HochwasserzentralenValidationError, JSON.stringify(params));
  }
  assert.equal(mt.calls.length, 0);
});

test("the station filters are exported from the package root", () => {
  assert.equal(lib.filterStations, filterStations);
  assert.equal(lib.foldName, foldName);
});

test("an envelope status other than success is a HochwasserzentralenApiError with apiStatus and the message", async () => {
  for (const [body, message] of [
    [{ ...fx.alertsJson, status: "error", message: "Wartungsarbeiten", data: [] }, "Wartungsarbeiten"],
    [{ apiVersion: "1.0", status: "fail", error: { code: "BAD_REQUEST", message: "Unknown states" } }, "Unknown states"],
  ] as const) {
    const c = new HochwasserzentralenClient({ transport: makeMockTransport(() => jsonResponse(body)).transport });
    await assert.rejects(c.alerts(), (err: unknown) => {
      assert.ok(err instanceof HochwasserzentralenApiError);
      assert.equal(err.status, 200);
      assert.equal(err.apiStatus, body.status);
      assert.equal(err.detail, message);
      return true;
    });
  }
  const missing = { ...fx.alertsJson } as Record<string, unknown>;
  delete missing["status"];
  const c = new HochwasserzentralenClient({ transport: makeMockTransport(() => jsonResponse(missing)).transport });
  await assert.rejects(c.alerts(), HochwasserzentralenParseError);
});

test("unknown keys in client options, method params and the station filter are validation errors", async () => {
  assert.throws(() => new HochwasserzentralenClient({ timeout: 5 } as never), /Unknown key "timeout"/);
  const mt = makeMockTransport(() => jsonResponse(fx.alertsJson));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  await assert.rejects(c.alerts({ State: ["BY"] } as never), HochwasserzentralenValidationError);
  await assert.rejects(c.alerts({ cap: "yes" } as never), /Invalid cap/);
  await assert.rejects(c.situation({ water: "elbe" } as never), /Unknown key "water"/);
  assert.equal(mt.calls.length, 0);
  assert.throws(() => filterStations(fx.stationsJson, { Water: "elbe" } as never), HochwasserzentralenValidationError);
  assert.throws(() => filterStations(fx.stationsJson, undefined as never), HochwasserzentralenValidationError);
});

test("stations() combines states, lang and the filters without tripping the filter's key check", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.stationsJson));
  const c = new HochwasserzentralenClient({ transport: mt.transport });
  await assert.doesNotReject(c.stations({ states: ["BE"], lang: "en", water: "spree", minClass: 0 }));
});

test("a server that ignores ?states= can't change the answer: only the requested states' gauges count", async () => {
  // Result 01 Bug 1: the live body with a Bavarian gauge at class 3, served for --states RP.
  const body = {
    ...fx.stationsJson,
    data: [
      { kind: "Station", id: "RP_1", stateId: "DE-RP", water: "Rhein", lhpClass: 0 },
      { kind: "Station", id: "BY_10026293", stateId: "DE-BY", water: "Donau", lhpClass: 3 },
      { kind: "Station", id: "XX_1", stateId: "DE-XX", water: "Nirgendwo", lhpClass: 4 },
    ],
  } as unknown as StationsResponse;
  const c = new HochwasserzentralenClient({ transport: makeMockTransport(() => jsonResponse(body)).transport });
  const rp = await c.situation({ states: ["RP"] });
  assert.equal(rp.worstClass, 0);
  assert.equal(rp.totalStations, 1);
  assert.deepEqual(rp.states.map((s) => s.state), ["RP"]);
  assert.deepEqual((await c.stations({ states: ["RP"], minClass: 1 })).data, []);
  assert.deepEqual((await c.stations({ states: ["rp"] })).data.map((s) => s.id), ["RP_1"]);
  // Nationwide, no gauge is lost: the unknown state gets an entry of its own and counts.
  const all = await c.situation();
  assert.equal(all.worstClass, 4);
  assert.ok(all.states.some((s) => s.state === "XX" && s.stations === 1));
});

test("odd stateIds are read case-insensitively and fall back to the id prefix", () => {
  const body = {
    ...fx.stationsJson,
    data: [
      { kind: "Station", id: "BY_1", stateId: "DE-by", lhpClass: 4 },
      { kind: "Station", id: "BY_2", stateId: "DE-BY", lhpClass: 3 },
      { kind: "Station", id: "by_3", lhpClass: 1 },
    ],
  } as unknown as StationsResponse;
  const by = aggregateSituation(body, ["by"]);
  assert.deepEqual(by.states.map((s) => [s.state, s.stateId, s.stations, s.worstClass]), [["BY", "DE-BY", 3, 4]]);
  assert.throws(() => aggregateSituation(body, ["XX"]), HochwasserzentralenValidationError);
  assert.deepEqual(onlyStates(body, ["BY"]).data.length, 3);
});
