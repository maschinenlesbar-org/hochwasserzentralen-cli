// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { HochwasserzentralenClient as Client, normalizeStates } from "../src/client/client.js";
import { aggregateSituation, filterStations, onlyStates, stationClass } from "../src/client/stations.js";
import { alertsToGeoJson, stationsToGeoJson } from "../src/client/geojson.js";
import {
  HochwasserzentralenError as BaseError,
  HochwasserzentralenParseError as ParseError,
  HochwasserzentralenValidationError as ValidationError,
} from "../src/client/errors.js";
import type { StationsResponse } from "../src/client/types.js";
const envelope = {
  apiVersion: "1.0",
  status: "success",
  title: "t",
  lang: "de",
  source: "s",
  sourceName: "LHP",
  licence: "l",
  licenceName: "CC BY 4.0",
  updated: "2026-10-06T10:00:00+02:00",
};
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.stations();
const textBody = (text: string): unknown => ({
  ...envelope,
  data: [{ kind: "Station", id: "BY_1", stateId: "DE-BY", name: text, lhpClass: 0 }],
});
const readText = (result: unknown): string => (result as StationsResponse).data[0]!.name!;
/** How a body goes on the wire. */
const serialize = (body: unknown): string => JSON.stringify(body);
/**
 * 2xx bodies the call must reject (empty or wrong shapes). An envelope whose `status`
 * isn't "success" is a HochwasserzentralenApiError with the API's message, not a parse
 * error: client.test.ts and cli.test.ts cover it.
 */
const malformedBodies: unknown[] = [
  null,
  {},
  [],
  "text",
  42,
  { ...envelope, data: "x" },
  { ...envelope, status: undefined, data: [] },
  { ...envelope, data: [null] },
  { ...envelope, data: [{ kind: "Station" }] },
  { ...envelope, data: [] }, // nationwide, not a single gauge
  { type: "FeatureCollection", features: [] },
];
const station = { kind: "Station", id: "BY_1", lhpClass: 0 };
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["alerts(5)", () => new Client().alerts(5 as never)],
  ["alerts(null)", () => new Client().alerts(null as never)],
  ["alerts('BY')", () => new Client().alerts("BY" as never)],
  ["alerts([])", () => new Client().alerts([] as never)],
  ["alerts({ states: 'BY' })", () => new Client().alerts({ states: "BY" as never })],
  ["alerts({ cap: 1 })", () => new Client().alerts({ cap: 1 as never })],
  ["stations({ water: 5 })", () => new Client().stations({ water: 5 as never })],
  ["stations({ minClass: '1' })", () => new Client().stations({ minClass: "1" as never })],
  ["situation({ lang: 5 })", () => new Client().situation({ lang: 5 as never })],
  ["normalizeStates('BY')", () => normalizeStates("BY" as never)],
  ["filterStations('x', {})", () => filterStations("x" as never, {})],
  ["filterStations({ data: undefined }, {})", () => filterStations({ data: undefined } as never, {})],
  ["filterStations(res, 5)", () => filterStations({ ...envelope, data: [station] } as never, 5 as never)],
  ["aggregateSituation(null)", () => aggregateSituation(null as never)],
  ["aggregateSituation(res, 'BY')", () => aggregateSituation({ ...envelope, data: [station] } as never, "BY" as never)],
  ["onlyStates({ data: [null] }, ['BY'])", () => onlyStates({ data: [null] } as never, ["BY"])],
  ["stationClass(null)", () => stationClass(null as never)],
  ["alertsToGeoJson(null)", () => alertsToGeoJson(null as never)],
  ["stationsToGeoJson({})", () => stationsToGeoJson({} as never)],
  ["new Client(null)", () => new Client(null as never)],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["transport: 'x'", () => new Client({ transport: "x" as never })],
  ["sleep: 5", () => new Client({ sleep: 5 as never })],
  ["defaultHeaders: 'x'", () => new Client({ defaultHeaders: "x" as never })],
  ["defaultHeaders: { a: 5 }", () => new Client({ defaultHeaders: { a: 5 } as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(serialize(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(serialize(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
