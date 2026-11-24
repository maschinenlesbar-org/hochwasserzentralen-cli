// This server's tools against a mock of the LHP API (the client's recorded answers), with the
// skills' traps as cases: each tool answers through the protocol (its structuredContent checked by
// the SDK against its output schema), an all-clear is never a flood, no warning is an answer, a
// name matching several places is reported and never guessed, filters that don't apply are refused,
// a page says where the next one starts, and every result carries the source and the attribution.
// The rules every server follows are the conformance tests (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { alertArea, gauge, lhpApi, liveAlerts, liveStations } from "./helpers.js";

test("five tools: the three use cases first, then the generic ones", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["getFloodAlerts", "getFloodSituation", "getFloodMap", "listGauges", "findGauge"]);
});

test("getFloodAlerts: worst first on the alerts scale, the all-clear apart; states by name reach the API as codes; the source names them", async () => {
  const api = lhpApi();
  const connection = await connect({ transport: api });
  const result = await connection.call("getFloodAlerts", { states: ["Bayern", "Rheinland-Pfalz"] });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.deepEqual((content["active"] as { id: string }[]).map((a) => a.id), ["BY_473", "BY_476", "BY_471", "RP_17", "BY_472"]);
  assert.deepEqual((content["cleared"] as { id: string }[]).map((a) => a.id), ["RP_18"]);
  assert.match(String(content["source"]), /\/data\/alerts\?states=BY,RP$/);
  assert.match(String(content["licence"]), /CC BY 4\.0/);
  assert.match(String((content["attribution"] as { text: string }).text), /^Quelle: Länderübergreifendes Hochwasserportal \(LHP\), hochwasserzentralen\.de — Stand: 19\.11\.2026, 16:11 MEZ$/);
  assert.equal(new URL(api.last().url).searchParams.get("states"), "BY,RP");
  await connection.close();
});

test("getFloodAlerts: no warning is ok with a plain verdict, not an error; an unknown state is a tool error naming the codes, before any request", async () => {
  const api = lhpApi({ alerts: { ...liveAlerts(), data: [] } });
  const connection = await connect({ transport: api });
  const none = await connection.call("getFloodAlerts", {});
  assert.equal(none.structuredContent?.["status"], "ok");
  assert.equal(none.structuredContent?.["verdict"], "No active official flood warning for Germany.");
  const before = api.calls.length;
  const bad = await connection.call("getFloodAlerts", { states: ["Bayer"] });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0]?.text ?? "", /unknown state "Bayer".*BY \(Bayern\)/);
  assert.equal(api.calls.length, before, "no request");
  await connection.close();
});

test("getFloodAlerts with cap gives the official instruction and asks the API for the CAP block", async () => {
  const api = lhpApi({ alerts: { ...liveAlerts(), data: [alertArea("BY_577", "4", "Donau", { cap: { info: { severity: "Moderate", instruction: "Meiden Sie Ufernähe." } } })] } });
  const connection = await connect({ transport: api });
  const result = await connection.call("getFloodAlerts", { cap: true });
  assert.deepEqual((result.structuredContent?.["active"] as { cap: unknown }[])[0]?.cap, { severity: "Moderate", instruction: "Meiden Sie Ufernähe." });
  assert.equal(new URL(api.last().url).searchParams.get("cap"), "true");
  assert.match(String(result.structuredContent?.["source"]), /\/data\/alerts\?cap=true$/);
  await connection.close();
});

test("getFloodAlerts with cap pages the active warnings at the size cap, each CAP text whole, and every warning can be reached", async () => {
  const info = (n: number) => ({ cap: { info: { severity: "Severe", description: `Beschreibung ${n} `.padEnd(1500, "x"), instruction: "Meiden Sie Ufernähe. ".padEnd(320, "y") } } });
  const data = Array.from({ length: 30 }, (_, n) => alertArea(`BY_${100 + n}`, n < 3 ? "5" : "2", `Gebiet ${n}`, info(n)));
  const connection = await connect({ transport: lhpApi({ alerts: { ...liveAlerts(), data } }) });
  const seen: string[] = [];
  let offset: number | undefined = 0;
  for (let calls = 0; offset !== undefined && calls < 30; calls++) {
    const content: Record<string, unknown> = (await connection.call("getFloodAlerts", { cap: true, offset })).structuredContent ?? {};
    assert.equal(content["status"], "ok");
    assert.equal(content["total"], 30);
    assert.match(String(content["verdict"]), /^30 active official flood warnings/);
    for (const a of content["active"] as { id: string; cap: { description: string; instruction: string } }[]) {
      assert.equal(a.cap.description.length, 1500, "each CAP text whole");
      assert.equal(a.cap.instruction.length, 320);
      seen.push(a.id);
    }
    offset = content["nextOffset"] as number | undefined;
  }
  assert.deepEqual([...new Set(seen)].length, 30, "every warning reached by following nextOffset");
  assert.equal(seen.length, 30, "none twice");
  const long = (await connection.call("getFloodAlerts", { cap: true, limit: 1 })).structuredContent ?? {};
  assert.deepEqual([(long["active"] as unknown[]).length, long["nextOffset"]], [1, 1]);
  await connection.close();
});

test("getFloodAlerts with cap keeps a long official CAP text whole, not cut at the usual 2000 characters", async () => {
  const description = `${"Hochwasser an der Donau, ".repeat(240)}Ende.`;
  const connection = await connect({ transport: lhpApi({ alerts: { ...liveAlerts(), data: [alertArea("BY_577", "5", "Donau", { cap: { info: { description } } })] } }) });
  const content = (await connection.call("getFloodAlerts", { cap: true })).structuredContent ?? {};
  const kept = (content["active"] as { cap: { description: string } }[])[0]?.cap.description ?? "";
  assert.deepEqual([kept.length, kept.endsWith("Ende.")], [description.length, true]);
  assert.equal(content["truncated"], undefined);
  await connection.close();
});

test("getFloodSituation: per state with no data and unclassified apart, border gauges as sites, a plain verdict", async () => {
  const connection = await connect({ transport: lhpApi() });
  const content = (await connection.call("getFloodSituation", { worstGauges: 1 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.deepEqual([content["totalGauges"], content["sites"], content["worstClass"]], [14, 12, 2]);
  assert.deepEqual((content["worstGauges"] as { id: string }[]).map((g) => g.id), ["HE_25100100"]);
  const mv = (content["states"] as { state: string; unclassified: number; noData: number }[]).find((s) => s.state === "MV");
  assert.deepEqual([mv?.unclassified, mv?.noData], [2, 0]);
  assert.match(String(content["source"]), /\/data\/stations$/);
  await connection.close();
});

test("listGauges pages with offset and limit; a water search names the waters it matched; minClass 1 empty is good news", async () => {
  const connection = await connect({ transport: lhpApi() });
  const first = (await connection.call("listGauges", { limit: 5 })).structuredContent ?? {};
  assert.deepEqual([first["total"], (first["gauges"] as unknown[]).length, first["nextOffset"]], [14, 5, 5]);
  assert.equal(first["waters"], undefined);
  const last = (await connection.call("listGauges", { offset: 10, limit: 5 })).structuredContent ?? {};
  assert.deepEqual([(last["gauges"] as unknown[]).length, last["nextOffset"]], [4, undefined]);
  const oder = (await connection.call("listGauges", { water: "oder" })).structuredContent ?? {};
  assert.deepEqual(oder["waters"], { "Spree-Oder-Wasserstrasse": 1, Oder: 1 });
  const calm = (await connection.call("listGauges", { states: ["SN"], minClass: 1 })).structuredContent ?? {};
  assert.equal(calm["status"], "empty");
  assert.match(String(calm["reason"]), /good news/);
  assert.deepEqual(calm["searched"], { states: ["SN"], minClass: 1 });
  await connection.close();
});

test("findGauge: a border gauge is one answer with its twin; several places are ambiguous with the candidates; none is empty with what was searched", async () => {
  const stations = { ...liveStations(), data: [...liveStations().data, gauge("BY_1", "Neustadt", "Saale", 0, [10.2, 50.3]), gauge("SN_2", "Neustadt", "Sebnitz", 0, [14.2, 51.0])] };
  const connection = await connect({ transport: lhpApi({ stations }) });
  const kaub = (await connection.call("findGauge", { gauge: "Kaub" })).structuredContent ?? {};
  assert.equal(kaub["status"], "ok");
  assert.deepEqual([(kaub["gauge"] as { id: string }).id, (kaub["sameSite"] as { id: string }[]).map((g) => g.id)], ["HE_25100100", ["RP_25100100"]]);
  const two = (await connection.call("findGauge", { gauge: "Neustadt" })).structuredContent ?? {};
  assert.equal(two["status"], "ambiguous");
  assert.deepEqual((two["candidates"] as { id: string }[]).map((g) => g.id).sort(), ["BY_1", "SN_2"]);
  assert.equal(two["gauge"], undefined);
  const none = (await connection.call("findGauge", { gauge: "Atlantis" })).structuredContent ?? {};
  assert.equal(none["status"], "empty");
  assert.deepEqual(none["searched"], { gauge: "Atlantis" });
  await connection.close();
});

test("getFloodMap: alert features with what is left off named; gauges paged; water on the alerts layer is refused, not ignored", async () => {
  const data = [...liveAlerts().data, alertArea("BY_577", "6", "Donau", { geometry: undefined })];
  const connection = await connect({ transport: lhpApi({ alerts: { ...liveAlerts(), data } }) });
  const alerts = (await connection.call("getFloodMap", { layer: "alerts" })).structuredContent ?? {};
  assert.equal(alerts["type"], "FeatureCollection");
  assert.equal((alerts["features"] as unknown[]).length, 7);
  assert.deepEqual((alerts["leftOff"] as { id: string }[]).map((a) => a.id), ["BY_577"]);
  const gauges = (await connection.call("getFloodMap", { layer: "gauges", limit: 4 })).structuredContent ?? {};
  assert.deepEqual([gauges["total"], (gauges["features"] as unknown[]).length, gauges["nextOffset"]], [14, 4, 4]);
  assert.match(String(gauges["source"]), /\/data\/stations$/);
  const refused = await connection.call("getFloodMap", { layer: "alerts", water: "Rhein" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]?.text ?? "", /gauges layer only/);
  await connection.close();
});
