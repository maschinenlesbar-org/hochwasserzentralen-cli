import { test } from "node:test";
import assert from "node:assert/strict";
import { HochwasserzentralenClient, normalizeStates } from "../src/client/client.js";
import { HochwasserzentralenParseError, HochwasserzentralenValidationError } from "../src/client/errors.js";
import { alertsToGeoJson, stationsToGeoJson } from "../src/client/geojson.js";
import { makeMockTransport, jsonResponse, queryOf } from "./helpers.js";
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
