import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { renderGeoJson, renderJson } from "../src/cli/shared.js";
import type { GeoJsonFeatureCollection } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/geojson";
import { HochwasserzentralenClient } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/client";
import { HochwasserzentralenNetworkError, credentialsIn, toWellFormed } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/errors";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/http";
import { makeMockTransport, jsonResponse, memoryFiles, rawResponse, untimed } from "./helpers.js";
import { appearedMeanwhile } from "../src/cli/io.js";
import * as fx from "@maschinenlesbar.org/hochwasserzentralen-client/test/fixtures";

function makeCli(
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
  existingFiles: string[] = [],
) {
  const out: string[] = [];
  const err: string[] = [];
  const seam = memoryFiles(existingFiles);
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    files: seam,
    createClient: (opts) => new HochwasserzentralenClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt, files: seam.written };
}

test("alerts renders the envelope incl. the updated timestamp and attribution", async () => {
  const cli = makeCli(() => jsonResponse(fx.alertsJson));
  const code = await run(["alerts"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, "/public/v1/data/alerts");
  const parsed = JSON.parse(cli.out.join("\n")) as { updated: string; licenceName: string; data: unknown[] };
  assert.equal(parsed.updated, "2026-07-13T10:43:47+01:00");
  assert.equal(parsed.licenceName, "CC BY 4.0 - Namensnennung");
  assert.equal(parsed.data.length, 2);
});

test("alerts --states normalises case-insensitive input to upper in the URL", async () => {
  const cli = makeCli(() => jsonResponse(fx.alertsJson));
  const code = await run(["alerts", "--states", "by,sn"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("states"), "BY,SN");
});

test("alerts --states with a bad code exits 2 and makes no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.alertsJson));
  const code = await run(["alerts", "--states", "BY,XX"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Unknown state code "XX"/);
});

test("alerts --states with only commas/whitespace exits 2, no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.alertsJson));
  assert.equal(await run(["alerts", "--states", " , ,"], cli.deps), 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("alerts --cap adds cap=true to the query", async () => {
  const cli = makeCli(() => jsonResponse(fx.alertsJson));
  await run(["alerts", "--cap"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("cap"), "true");
});

test("alerts --lang en sets the Accept-Language header", async () => {
  const cli = makeCli(() => jsonResponse(fx.alertsJson));
  await run(["alerts", "--lang", "en"], cli.deps);
  assert.equal(cli.mt.last().headers?.["Accept-Language"], "en");
});

test("alerts --lang with an unsupported language exits 2, no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.alertsJson));
  assert.equal(await run(["alerts", "--lang", "fr"], cli.deps), 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("stations --water filters case-insensitively by substring, keeping the envelope", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  await run(["stations", "--water", "havel"], cli.deps);
  const parsed = JSON.parse(cli.out.join("\n")) as { updated: string; data: Array<{ name: string }> };
  assert.equal(parsed.data.length, 1);
  assert.equal(parsed.data[0]!.name, "Pfaueninsel");
  assert.equal(parsed.updated, fx.stationsJson.updated); // envelope survives filtering
});

test("stations --water with no match returns an empty data array (not the full set)", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  await run(["stations", "--water", "rhein"], cli.deps);
  const parsed = JSON.parse(cli.out.join("\n")) as { data: unknown[] };
  assert.deepEqual(parsed.data, []);
});

test("stations --min-class keeps only stations at or above the class", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  await run(["stations", "--min-class", "2"], cli.deps);
  const parsed = JSON.parse(cli.out.join("\n")) as { data: Array<{ id: string; lhpClass: number }> };
  assert.deepEqual(
    parsed.data.map((s) => s.id),
    ["BE_586290", "BY_10088003"],
  );
});

test("stations --min-class -1 keeps everything (including no-data stations)", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  await run(["stations", "--min-class", "-1"], cli.deps);
  const parsed = JSON.parse(cli.out.join("\n")) as { data: unknown[] };
  assert.equal(parsed.data.length, 4);
});

test("stations --min-class rejects a non-integer (exit 2, no request)", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  assert.equal(await run(["stations", "--min-class", "abc"], cli.deps), 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("stations --min-class rejects an out-of-range value (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  assert.equal(await run(["stations", "--min-class", "9"], cli.deps), 2);
});

test("situation aggregates per state: counts per class, worst class, attribution", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  const code = await run(["situation"], cli.deps);
  assert.equal(code, 0);
  const parsed = JSON.parse(cli.out.join("\n")) as {
    updated: string;
    sourceName: string;
    totalStations: number;
    worstClass: number;
    worstClassName: string;
    states: Array<{
      state: string;
      stateId: string;
      stations: number;
      worstClass: number;
      worstClassName: string;
      classes: Record<string, number>;
    }>;
  };
  assert.equal(parsed.totalStations, 4);
  assert.equal(parsed.worstClass, 3);
  assert.equal(parsed.worstClassName, "Großes Hochwasser");
  assert.equal(parsed.updated, fx.stationsJson.updated); // CC BY: timestamp shown
  assert.equal(parsed.sourceName, "Länderübergreifendes Hochwasserportal (LHP)");
  // BY (worst 3) sorts before BE (worst 2); the 14 states without a gauge follow,
  // alphabetically, with stations 0 and worstClass null.
  assert.deepEqual(
    parsed.states.map((s) => s.state).slice(0, 4),
    ["BY", "BE", "BB", "BW"],
  );
  assert.equal(parsed.states.length, 16);
  const bw = parsed.states[3]!;
  assert.equal(bw.stations, 0);
  assert.equal(bw.worstClass, null);
  assert.equal(bw.worstClassName, null);
  assert.equal(bw.stateId, "DE-BW");
  const by = parsed.states[0]!;
  assert.equal(by.stateId, "DE-BY");
  assert.equal(by.stations, 2);
  assert.deepEqual(by.classes, { "-1": 1, "0": 0, "1": 0, "2": 0, "3": 1, "4": 0 });
  const be = parsed.states[1]!;
  assert.equal(be.worstClass, 2);
  assert.deepEqual(be.classes, { "-1": 0, "0": 1, "1": 0, "2": 1, "3": 0, "4": 0 });
});

test("alerts --geojson prints a FeatureCollection with attribution members", async () => {
  const cli = makeCli(() => jsonResponse(fx.alertsJson));
  const code = await run(["alerts", "--geojson"], cli.deps);
  assert.equal(code, 0);
  const fc = JSON.parse(cli.out.join("\n")) as {
    type: string;
    features: Array<{ type: string; geometry: { type: string } }>;
    updated: string;
  };
  assert.equal(fc.type, "FeatureCollection");
  assert.equal(fc.features.length, 2);
  assert.equal(fc.features[0]!.geometry.type, "Polygon");
  assert.equal(fc.updated, fx.alertsJson.updated);
});

test("stations --geojson -o writes the file and reports the feature count", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  const code = await run(["stations", "--geojson", "-o", "/tmp/stations.geojson"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.out.length, 0); // stdout stays clean
  const written = cli.files["/tmp/stations.geojson"];
  assert.ok(written);
  const fc = JSON.parse(written.toString("utf8")) as { type: string; features: unknown[] };
  assert.equal(fc.type, "FeatureCollection");
  assert.equal(fc.features.length, 4);
  assert.match(untimed(cli.err.join("\n")), /^INFO  \[hochwasser\.output\] Wrote 4 features \(\d+ bytes\) to \/tmp\/stations\.geojson/);
});

test("stations --geojson --min-class filters before export", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  await run(["stations", "--geojson", "--min-class", "2"], cli.deps);
  const fc = JSON.parse(cli.out.join("\n")) as { features: unknown[] };
  assert.equal(fc.features.length, 2);
});

test("stations --geojson --water sets the bbox to the filtered points, south before north", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  assert.equal(await run(["stations", "--geojson", "--water", "havel"], cli.deps), 0);
  const fc = JSON.parse(cli.out.join("\n")) as { bbox: number[]; features: unknown[] };
  assert.equal(fc.features.length, 1);
  assert.deepEqual(fc.bbox, [13.1239, 52.4303, 13.1239, 52.4303]);
});

test("DEL and C1 control characters in server data are escaped in the JSON and GeoJSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const esc = String.fromCharCode(0x1b) + "[31m";
  const served = { ...fx.stationsJson, data: [{ ...fx.stationsJson.data[0]!, name: `Pfaueninsel${controls}`, water: esc }] };
  const rawControls = (text: string) =>
    [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "stations"], cli.deps), 0);
    const text = cli.out.join("\n");
    assert.deepEqual(rawControls(text), [], format.join(" "));
    assert.match(text, /Pfaueninsel\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);

    const geo = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "stations", "--geojson"], geo.deps), 0);
    const geoText = geo.out.join("\n");
    assert.deepEqual(rawControls(geoText), [], `--geojson ${format.join(" ")}`);
    assert.match(geoText, /Pfaueninsel\\u007f\\u0085\\u009b2J/);
    const fc = JSON.parse(geoText) as { features: Array<{ properties: Record<string, unknown> }> };
    assert.equal(fc.features[0]!.properties["name"], `Pfaueninsel${controls}`);
    assert.equal(fc.features[0]!.properties["water"], esc);
  }
});

test("-o refuses to overwrite an existing file without --force (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson), ["/tmp/exists.geojson"]);
  const code = await run(["stations", "--geojson", "-o", "/tmp/exists.geojson"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.files["/tmp/exists.geojson"], undefined); // nothing written
  assert.match(cli.err.join("\n"), /Refusing to overwrite.*--force/);
});

test("-o --force overwrites an existing file", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson), ["/tmp/exists.geojson"]);
  const code = await run(["stations", "--geojson", "-o", "/tmp/exists.geojson", "--force"], cli.deps);
  assert.equal(code, 0);
  assert.ok(cli.files["/tmp/exists.geojson"]);
});

test("--output on a JSON command also refuses to overwrite without --force", async () => {
  const cli = makeCli(() => jsonResponse(fx.alertsJson), ["/tmp/alerts.json"]);
  assert.equal(await run(["alerts", "-o", "/tmp/alerts.json"], cli.deps), 2);
});

test("a 404 exits 4", async () => {
  const cli = makeCli(() => rawResponse("not found", "text/plain", 404));
  assert.equal(await run(["alerts"], cli.deps), 4);
});

test("a network failure exits 6", async () => {
  const cli = makeCli(() => {
    throw new HochwasserzentralenNetworkError("getaddrinfo ENOTFOUND api.hochwasserzentralen.de");
  });
  const code = await run(["stations"], cli.deps);
  assert.equal(code, 6);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[hochwasser\.http\] .*ENOTFOUND/);
});

test("a 3xx from the LHP's own host names the target and says the service may be offline, not --base-url (01-1)", async () => {
  // As on 2026-10-21: api.hochwasserzentralen.de answered 302 to www.…, which led to an "offline" page.
  const target = "https://www.hochwasserzentralen.de/public/v1/data/stations";
  for (const argv of [["stations"], ["--base-url", "https://api.hochwasserzentralen.de/public/v1/test", "stations"]]) {
    const cli = makeCli(() => ({ status: 302, headers: { location: target }, body: Buffer.alloc(0) }));
    assert.equal(await run(argv, cli.deps), 1);
    assert.deepEqual(cli.out, []);
    const err = untimed(cli.err.join("\n"));
    assert.match(err, new RegExp(`^ERROR \\[hochwasser\\.api\\] HTTP 302 for GET https://api\\.hochwasserzentralen\\.de/\\S+/data/stations: redirect to ${target.replace(/[.]/g, "\\.")} not followed$`, "m"));
    assert.match(err, /^INFO  \[hochwasser\.api\] the LHP API redirected instead of answering: the service may be offline or have moved\./m);
    assert.doesNotMatch(err, /check --base-url/);
    assert.equal(cli.mt.calls.length, 1); // the redirect was not followed
  }
});

test("a 3xx from another --base-url exits 1 (runtime) with a base-url hint, not usage (2)", async () => {
  const cli = makeCli(() => rawResponse("", "text/html", 302));
  const code = await run(["--base-url", "https://mirror.example/lhp", "alerts"], cli.deps);
  assert.equal(code, 1);
  const err = untimed(cli.err.join("\n"));
  assert.match(err, /^ERROR \[hochwasser\.api\] HTTP 302 for GET https:\/\/mirror\.example\/lhp\/data\/alerts: redirect not followed \(no Location header\)$/m);
  assert.match(err, /^INFO  \[hochwasser\.api\] the server at --base-url redirected; redirects are not followed — check --base-url points at the API \(the LHP's is https:\/\/api\.hochwasserzentralen\.de\/public\/v1\)\.$/m);
  assert.equal(cli.mt.calls.length, 1); // the redirect was not followed
});

test("a 429 is retried honouring Retry-After, then succeeds (exit 0)", async () => {
  let calls = 0;
  const cli = makeCli(() => {
    calls += 1;
    return calls === 1
      ? jsonResponse("{}", 429, { "retry-after": "0" })
      : jsonResponse(fx.alertsJson);
  });
  const code = await run(["alerts", "--max-retries", "2"], cli.deps);
  assert.equal(code, 0);
  assert.equal(calls, 2);
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  await run(["stations", "--compact"], cli.deps);
  assert.equal(cli.out.length, 1);
});

test("a non-http --base-url is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.alertsJson));
  assert.equal(await run(["--base-url", "ftp://x/y", "alerts"], cli.deps), 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("--max-retries above the sane maximum is rejected (exit 2)", async () => {
  const cli = makeCli(() => jsonResponse(fx.alertsJson));
  assert.equal(await run(["--max-retries", "1000", "alerts"], cli.deps), 2);
});

test("a control character in --user-agent is rejected (exit 2), no request", async () => {
  const cli = makeCli(() => jsonResponse(fx.alertsJson));
  const code = await run(["alerts", "--user-agent", "bad\r\nX-Injected: 1"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  assert.equal(await run(["--timeout", "2147483647", "stations"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse(fx.stationsJson));
  assert.equal(await run(["--timeout", "2147483648", "stations"], over.deps), 2);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
});

test("a bare invocation prints help and exits 0", async () => {
  const cli = makeCli(() => jsonResponse(fx.alertsJson));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.out.join("\n"), /Usage: hochwasser/);
});

test("an unknown command exits 2", async () => {
  const cli = makeCli(() => jsonResponse(fx.alertsJson));
  assert.equal(await run(["boguscmd"], cli.deps), 2);
});

test("--help exits 0", async () => {
  const cli = makeCli(() => jsonResponse(fx.alertsJson));
  assert.equal(await run(["--help"], cli.deps), 0);
  assert.match(cli.out.join("\n"), /alerts/);
});

test("a --base-url with a query or fragment is rejected (exit 2), no request", async () => {
  for (const url of ["http://127.0.0.1:1/echo#frag", "http://127.0.0.1:1/echo?x=1"]) {
    const cli = makeCli(() => jsonResponse(fx.stationsJson));
    assert.equal(await run(["--base-url", url, "stations", "--states", "BY"], cli.deps), 2);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /cannot have a query \(\?\) or fragment \(#\)/);
  }
});

test("a file that appears between the check and the write is not overwritten: a failed write, exit 1", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  let overwriteFlag: boolean | undefined;
  cli.deps.files = {
    state: () => "absent",
    parentProblem: () => undefined,
    write: (p, _d, overwrite) => {
      overwriteFlag = overwrite;
      throw appearedMeanwhile(p, "file");
    },
  };
  assert.equal(await run(["-o", "race.json", "stations"], cli.deps), 1);
  assert.equal(overwriteFlag, false);
  assert.match(cli.err.join("\n"), /Refusing to overwrite existing file "race.json"/);
});

test("--force writes with overwrite allowed", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  let overwriteFlag: boolean | undefined;
  cli.deps.files = {
    state: () => "absent",
    parentProblem: () => undefined,
    write: (_p, _d, overwrite) => {
      overwriteFlag = overwrite;
    },
  };
  assert.equal(await run(["--force", "-o", "x.json", "stations"], cli.deps), 0);
  assert.equal(overwriteFlag, true);
});

test("stations --water folds ß/SS and decomposed umlauts on both sides", async () => {
  const data = [
    { ...fx.stationsJson.data[0]!, id: "SN_1", water: "Lausitzer Neiße" },
    { ...fx.stationsJson.data[0]!, id: "BY_2", water: "Altmühl" },
    { ...fx.stationsJson.data[0]!, id: "BB_3", water: "Havel–Oder-Wasserstraße" },
  ];
  const cases: Array<[string, string[]]> = [
    ["NEISSE", ["SN_1"]],
    ["neisse", ["SN_1"]],
    ["Neiße", ["SN_1"]],
    ["ALTMÜHL", ["BY_2"]],
    ["Altmühl", ["BY_2"]],
    ["havel-oder-wasserstrasse", ["BB_3"]],
  ];
  for (const [needle, ids] of cases) {
    const cli = makeCli(() => jsonResponse({ ...fx.stationsJson, data }));
    assert.equal(await run(["--compact", "stations", "--water", needle], cli.deps), 0);
    const parsed = JSON.parse(cli.out.join("\n")) as { data: Array<{ id: string }> };
    assert.deepEqual(parsed.data.map((s) => s.id), ids, needle);
  }
});

test("a null data item exits 1 with a typed parse error, not Unexpected error", async () => {
  for (const argv of [["stations", "--water", "w"], ["stations", "--geojson"], ["situation"]]) {
    const cli = makeCli(() => jsonResponse({ ...fx.stationsJson, data: [null] }));
    assert.equal(await run(argv, cli.deps), 1);
    assert.match(untimed(cli.err.join("\n")), /^ERROR \[hochwasser\.api\] GET https:\/\/api\.hochwasserzentralen\.de\/public\/v1\/data\/stations: unexpected response shape: /);
  }
});

test("an existing -o file is refused before any request is sent (exit 2)", async () => {
  for (const argv of [["stations"], ["alerts", "--geojson"], ["situation"]]) {
    const cli = makeCli(() => jsonResponse(fx.stationsJson), ["exists.json"]);
    assert.equal(await run(["-o", "exists.json", ...argv], cli.deps), 2);
    assert.equal(cli.mt.calls.length, 0, argv.join(" "));
    assert.match(cli.err.join("\n"), /Refusing to overwrite existing file "exists.json"/);
  }
});

test("a blank -o or --user-agent is a usage error (exit 2), no request, no file", async () => {
  for (const argv of [["-o", "", "stations"], ["-o", " ", "stations"], ["--user-agent", "", "stations"], ["--user-agent", "  ", "stations"]]) {
    const cli = makeCli(() => jsonResponse(fx.stationsJson));
    assert.equal(await run(argv, cli.deps), 2, JSON.stringify(argv));
    assert.equal(cli.mt.calls.length, 0);
    assert.deepEqual(Object.keys(cli.files), []);
    assert.match(cli.err.join("\n"), /Expected a non-empty value/);
  }
});

test("a --user-agent outside Latin-1 is a usage error (exit 2), Latin-1 and tab pass", async () => {
  const bad = makeCli(() => jsonResponse(fx.alertsJson));
  assert.equal(await run(["--user-agent", "hochwasser €", "alerts"], bad.deps), 2);
  assert.equal(bad.mt.calls.length, 0);
  assert.match(bad.err.join("\n"), /outside Latin-1/);
  const ok = makeCli(() => jsonResponse(fx.alertsJson));
  assert.equal(await run(["--user-agent", "hochwasser-tür\tx", "alerts"], ok.deps), 0);
  assert.equal(ok.mt.last().headers?.["User-Agent"], "hochwasser-tür\tx");
});

test("a repeated --states adds to the list instead of keeping only the last value", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  assert.equal(await run(["stations", "--states", "BY", "--states", "sn,by"], cli.deps), 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("states"), "BY,SN");
  const bad = makeCli(() => jsonResponse(fx.stationsJson));
  assert.equal(await run(["stations", "--states", "BY", "--states", "XX"], bad.deps), 2);
  assert.equal(bad.mt.calls.length, 0);
});

test("bidi controls in server data are escaped in the JSON output", async () => {
  const RLO = String.fromCharCode(0x202e);
  const PDI = String.fromCharCode(0x2069);
  const data = [{ ...fx.stationsJson.data[0]!, name: `abc${RLO}def${PDI}` }];
  const cli = makeCli(() => jsonResponse({ ...fx.stationsJson, data }));
  assert.equal(await run(["--compact", "stations"], cli.deps), 0);
  const text = cli.out.join("\n");
  assert.ok(![...text].some((c) => c === RLO || c === PDI));
  assert.match(text, /abc\\u202edef\\u2069/);
  assert.equal((JSON.parse(text) as { data: Array<{ name: string }> }).data[0]!.name, `abc${RLO}def${PDI}`);
});

test("situation --states lists a requested state without gauges as stations 0, worstClass null", async () => {
  const cli = makeCli(() => jsonResponse({ ...fx.stationsJson, data: [] }));
  assert.equal(await run(["--compact", "situation", "--states", "HH"], cli.deps), 0);
  const parsed = JSON.parse(cli.out.join("\n")) as {
    totalStations: number;
    worstClass: number | null;
    worstClassName: string | null;
    states: Array<{ state: string; stations: number; worstClass: number | null; worstClassName: string | null }>;
  };
  assert.equal(parsed.totalStations, 0);
  assert.equal(parsed.worstClass, null);
  assert.equal(parsed.worstClassName, null);
  assert.deepEqual(
    parsed.states.map((s) => [s.state, s.stations, s.worstClass, s.worstClassName]),
    [["HH", 0, null, null]],
  );
});

test("situation --states BY,HH keeps both, the one with gauges first", async () => {
  const data = fx.stationsJson.data.filter((s) => s.stateId === "DE-BY");
  const cli = makeCli(() => jsonResponse({ ...fx.stationsJson, data }));
  assert.equal(await run(["--compact", "situation", "--states", "HH,BY"], cli.deps), 0);
  const parsed = JSON.parse(cli.out.join("\n")) as { worstClass: number; states: Array<{ state: string }> };
  assert.equal(parsed.worstClass, 3);
  assert.deepEqual(parsed.states.map((s) => s.state), ["BY", "HH"]);
});

test("situation carries the response's lang, so a --lang en answered in German shows", async () => {
  const cli = makeCli(() => jsonResponse({ ...fx.stationsJson, lang: "de" }));
  assert.equal(await run(["--compact", "situation", "--lang", "en"], cli.deps), 0);
  assert.equal(cli.mt.last().headers?.["Accept-Language"], "en");
  assert.equal((JSON.parse(cli.out.join("\n")) as { lang: string }).lang, "de");
});

test("situation classes serialise in the documented key order 0..4, then -1", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  assert.equal(await run(["--compact", "situation"], cli.deps), 0);
  assert.match(cli.out.join("\n"), /"classes":\{"0":0,"1":0,"2":0,"3":1,"4":0,"-1":1\}/);
});

test("--min-class and situation share one classification: an off-scale lhpClass is a parse error in both", async () => {
  for (const bad of [99, 2.5, "3"]) {
    const data = [fx.stationsJson.data[0]!, { ...fx.stationsJson.data[2]!, lhpClass: bad }];
    for (const argv of [["stations", "--min-class", "3"], ["situation"]]) {
      const cli = makeCli(() => jsonResponse({ ...fx.stationsJson, data }));
      assert.equal(await run(argv, cli.deps), 1, `${JSON.stringify(bad)} ${argv.join(" ")}`);
      assert.match(untimed(cli.err.join("\n")), /^ERROR \[hochwasser\.api\] Unexpected lhpClass .* at station "BY_10088003" .*expected an integer from -1 to 4, or null/);
      assert.deepEqual(cli.out, []);
    }
  }
});

test("a null lhpClass is dropped by --min-class and counted in situation's -1 bucket", async () => {
  const data = [{ ...fx.stationsJson.data[0]!, lhpClass: null }];
  const filtered = makeCli(() => jsonResponse({ ...fx.stationsJson, data }));
  assert.equal(await run(["--compact", "stations", "--min-class", "-1"], filtered.deps), 0);
  assert.deepEqual((JSON.parse(filtered.out.join("\n")) as { data: unknown[] }).data, []);
  const sit = makeCli(() => jsonResponse({ ...fx.stationsJson, data }));
  assert.equal(await run(["--compact", "situation", "--states", "BE"], sit.deps), 0);
  const be = (JSON.parse(sit.out.join("\n")) as { states: Array<{ classes: Record<string, number> }> }).states[0]!;
  assert.equal(be.classes["-1"], 1);
});

test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7)", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't. Whether
  // the compact printer can depends on the Node version (iterative from Node 26) and the stack:
  // probed here, never assumed.
  const deep = "[".repeat(200_000) + "]".repeat(200_000);
  const body = `{"apiVersion":"x","status":"success","lang":"de","source":"s","sourceName":"s","licence":"l","licenceName":"l","title":"t","description":"d","updated":"u","data":[],"extra":${deep}}`;
  let compactPrints = true;
  try {
    JSON.stringify(JSON.parse(body));
  } catch {
    compactPrints = false;
  }
  const pretty = makeCli(() => rawResponse(body, "application/json"));
  assert.equal(await run(["stations", "--states", "HH"], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.equal(
    untimed(pretty.err.join("\n")),
    `ERROR [hochwasser.output] The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
  );
  const compact = makeCli(() => rawResponse(body, "application/json"));
  assert.equal(await run(["--compact", "stations", "--states", "HH"], compact.deps), compactPrints ? 0 : 1);
  if (!compactPrints) assert.equal(untimed(compact.err.join("\n")), "ERROR [hochwasser.output] The answer is nested too deeply to print.");
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const { deps } = makeCli(() => jsonResponse({}));
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise (K4)", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeCli(() => jsonResponse({}));
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: "a1", text: huge });
  renderJson(deps, { compact: true }, { id: "a1", x: [[["Elbe"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  renderGeoJson(deps, { compact: true }, { type: "FeatureCollection", features: [], name: huge } as unknown as GeoJsonFeatureCollection);
  renderGeoJson(deps, { compact: true }, { type: "FeatureCollection", features: [] });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2, "", "none"]);
  assert.deepEqual(out, Array(7).fill('"stub"'));
});

test("a 200 envelope whose status isn't success is an error with the API's message, exit 1, never written", async () => {
  const errorEnvelope = { ...fx.alertsJson, status: "error", message: "Wartungsarbeiten", data: [] };
  for (const argv of [
    ["alerts"],
    ["alerts", "--geojson"],
    ["--force", "-o", "good.json", "alerts"],
    ["--force", "-o", "good.geojson", "alerts", "--geojson"],
    ["stations", "--min-class", "1"],
    ["situation"],
  ]) {
    const cli = makeCli(() => jsonResponse(errorEnvelope), ["good.json", "good.geojson"]);
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.equal(cli.out.join(""), "", argv.join(" "));
    assert.deepEqual(Object.keys(cli.files), [], argv.join(" "));
    assert.match(cli.err.join("\n"), /status "error".*HTTP 200.*Wartungsarbeiten/, argv.join(" "));
  }
});

test("a nationwide /data/stations answer without any station is an error, not an all-clear", async () => {
  for (const argv of [["situation"], ["stations"], ["stations", "--min-class", "1"]]) {
    const cli = makeCli(() => jsonResponse({ ...fx.stationsJson, data: [] }));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.match(cli.err.join("\n"), / ERROR \[hochwasser\.api\] GET https:\/\/\S+\/data\/stations: the answer for all of Germany holds no station at all; /);
  }
  // A requested state without gauges (HH) stays a valid, empty answer.
  const hh = makeCli(() => jsonResponse({ ...fx.stationsJson, data: [] }));
  assert.equal(await run(["situation", "--states", "HH"], hh.deps), 0);
});

test("a single-value option given twice is a usage error, not last-one-wins", async () => {
  for (const argv of [
    ["--base-url", "http://127.0.0.1:9/a", "--base-url", "http://127.0.0.1:9/b", "alerts"],
    ["--timeout", "1000", "--timeout", "2000", "alerts"],
    ["-o", "a.json", "-o", "b.json", "alerts"],
    ["alerts", "--lang", "de", "--lang", "en"],
    ["stations", "--water", "Elbe", "--water", "Rhein"],
  ]) {
    const cli = makeCli(() => jsonResponse(fx.alertsJson));
    assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /more than once/);
  }
});

test("--geojson names the alerts it leaves off the map, to a file and to stdout (result 01 Bug 4)", async () => {
  const good = fx.alertsJson.data[0]!;
  const body = {
    ...fx.alertsJson,
    data: [
      { ...good, id: "BY_1", lhpClass: "6", lhpClassName: "Sehr großes Hochwasser", areaDesc: "Donau", geometry: null },
      { ...good, id: "BY_2", geometry: { type: "Point", coordinates: [181, 48] } },
      good,
    ],
  };
  const toFile = makeCli(() => jsonResponse(body));
  assert.equal(await run(["alerts", "--geojson", "-o", "map.geojson"], toFile.deps), 0);
  const err = untimed(toFile.err.join("\n"));
  assert.match(err, /^INFO  \[hochwasser\.output\] Wrote 1 feature \(\d+ bytes\) to map\.geojson; 2 alerts skipped \(no usable geometry\)$/m);
  assert.match(err, /^INFO  \[hochwasser\.output\] 2 alerts left off the map \(no usable geometry\): BY_1 \(class 6, Sehr großes Hochwasser, Donau\), BY_2/m);
  const toStdout = makeCli(() => jsonResponse(body));
  assert.equal(await run(["alerts", "--geojson"], toStdout.deps), 0);
  assert.equal((JSON.parse(toStdout.out.join("\n")) as { features: unknown[] }).features.length, 1);
  assert.match(untimed(toStdout.err.join("\n")), /^INFO  \[hochwasser\.output\] 2 alerts left off the map/);
  // A complete export says nothing extra.
  const complete = makeCli(() => jsonResponse(fx.alertsJson));
  assert.equal(await run(["alerts", "--geojson"], complete.deps), 0);
  assert.equal(complete.err.join("\n"), "");
});

test("a skipped item's label is cut on a character boundary: jsonl stays readable (result 02 Bug B02-1)", async () => {
  const good = fx.stationsJson.data[0]!;
  for (const id of ["a" + "\u{1f600}".repeat(45), "\u{1f600}".repeat(45)]) {
    const body = { ...fx.stationsJson, data: [{ ...good, id, name: "b" + "\u{1f30a}".repeat(45), coordinates: null }, good] };
    const cli = makeCli(() => jsonResponse(body));
    assert.equal(await run(["--log-format", "jsonl", "stations", "--geojson"], cli.deps), 0);
    const records = cli.err.map((line) => JSON.parse(line) as { msg: string });
    assert.equal(records.length, 1, cli.err.join("\n"));
    const msg = records[0]!.msg;
    assert.match(msg, /^1 station left off the map/);
    assert.equal(toWellFormed(msg), msg, "no half character");
    assert.doesNotMatch(cli.err[0]!, /\\ud[89ab]/i, "no escaped lone surrogate in the line");
  }
});

test("an a:b@c argument (a User-Agent, an -o path) is neither a credential in the log nor rewritten in the JSON on stdout (L14)", async () => {
  const good = fx.stationsJson.data[0]!;
  const body = { ...fx.stationsJson, data: [{ ...good, name: "run:2026-10-09@x" }] };
  const cli = makeCli(() => jsonResponse(body));
  assert.equal(await run(["--user-agent", "run:2026-10-09@x", "stations"], cli.deps), 0);
  assert.match(cli.out.join("\n"), /"name": "run:2026-10-09@x"/);
  const written = makeCli(() => jsonResponse(body));
  assert.equal(await run(["-o", "flood:map@v2.geojson", "stations", "--geojson"], written.deps), 0);
  assert.match(untimed(written.err.join("\n")), /^INFO  \[hochwasser\.output\] Wrote 1 feature \(\d+ bytes\) to flood:map@v2\.geojson$/);
  assert.match(written.files["flood:map@v2.geojson"]?.toString() ?? "", /"name": "run:2026-10-09@x"/);
  assert.deepEqual(credentialsIn("run:2026-10-09@x"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
});

test("commander's output is one record per line, and a run without a command has an ERROR (L5)", async () => {
  // Options but no command: commander shows the help as an error.
  const none = makeCli(() => jsonResponse(fx.alertsJson));
  assert.equal(await run(["--compact"], none.deps), 2);
  const lines = none.err.map(untimed);
  assert.equal(lines[0], "ERROR [hochwasser.cli] missing command: `hochwasser <subcommand>`");
  assert.ok(lines.slice(1).every((line) => line.startsWith("INFO  [hochwasser.cli] ") && !line.includes("\\n")), lines.join("\n"));
  assert.ok(lines.some((line) => line === "INFO  [hochwasser.cli] Usage: hochwasser [options] [command]"), lines.join("\n"));

  // A typo: the suggestion is part of the ERROR, the help one INFO record per line.
  const typo = makeCli(() => jsonResponse(fx.alertsJson));
  assert.equal(await run(["situaton"], typo.deps), 2);
  const typoLines = typo.err.map(untimed);
  assert.equal(typoLines[0], "ERROR [hochwasser.cli] unknown command 'situaton' (Did you mean situation?)");
  assert.ok(typoLines.slice(1).every((line) => line.startsWith("INFO  [hochwasser.cli] ") && !line.includes("\\n")), typoLines.join("\n"));
  const option = makeCli(() => jsonResponse(fx.alertsJson));
  assert.equal(await run(["stations", "--wate", "Elbe"], option.deps), 2);
  assert.equal(untimed(option.err[0] ?? ""), "ERROR [hochwasser.cli] unknown option '--wate' (Did you mean --water?)");

  // An unknown help topic is an ERROR too (result 03, Known 2: it used to be an INFO only).
  const help = makeCli(() => jsonResponse(fx.alertsJson));
  assert.equal(await run(["help", "bogus"], help.deps), 2);
  assert.match(untimed(help.err[0] ?? ""), /^ERROR \[hochwasser\.cli\] /);
});

test("the log format is the one commander parsed, where an option's value looks like --log-format (L6)", async () => {
  const isJsonl = (line: string): boolean => line.startsWith("{");
  const notFound = () => jsonResponse({ status: "fail", error: { code: "NOT_FOUND", message: "nope" } }, 404);
  // commander takes "--log-format=jsonl" as the User-Agent: the record is text (result 03, Known 5).
  const ua = makeCli(notFound);
  assert.equal(await run(["--user-agent", "--log-format=jsonl", "stations"], ua.deps), 4);
  assert.equal(ua.mt.last().headers?.["User-Agent"], "--log-format=jsonl");
  assert.ok(ua.err.length === 1 && !isJsonl(ua.err[0] as string), ua.err.join("\n"));
  // "--log-format" as the -o path: refused as a missing value (T13), logged as text.
  const output = makeCli(notFound);
  assert.equal(await run(["-o", "--log-format", "jsonl", "stations"], output.deps), 2);
  assert.ok(output.err.length > 0 && output.err.every((line) => !isJsonl(line)), output.err.join("\n"));
  assert.match(untimed(output.err[0] ?? ""), /^ERROR \[hochwasser\.cli\] option '-o, --output <file>' argument '--log-format' is invalid\. looks like a missing value/);
  // jsonl asked for, then "--log-format" as the value of --user-agent: jsonl.
  const back = makeCli(notFound);
  assert.equal(await run(["--log-format", "jsonl", "--user-agent", "--log-format", "stations"], back.deps), 4);
  assert.ok(back.err.length === 1 && isJsonl(back.err[0] as string), back.err.join("\n"));
  // A parse error after such a value is logged in the format commander would have used.
  const parse = makeCli(notFound);
  assert.equal(await run(["--log-format", "jsonl", "--user-agent", "--log-format", "stations", "--bogus"], parse.deps), 2);
  assert.ok(parse.err.length > 0 && parse.err.every(isJsonl), parse.err.join("\n"));
  // A global option is commander's wherever it stands, after a command's value option too.
  const water = makeCli(notFound);
  assert.equal(await run(["stations", "--water", "--log-format", "jsonl"], water.deps), 2);
  assert.ok(water.err.length > 0 && water.err.every(isJsonl), water.err.join("\n"));
  // Given twice, the first counts: commander keeps it and rejects the second (once()).
  const twice = makeCli(notFound);
  assert.equal(await run(["--log-format", "jsonl", "--log-format", "text", "stations"], twice.deps), 2);
  assert.ok(twice.err.length > 0 && twice.err.every(isJsonl), twice.err.join("\n"));
});

test("every -o failure is an ERROR record of hochwasser.output: a write failure exits 1, a refused overwrite 2 (L8)", async () => {
  // result 01, Known 9: a missing directory was an ERROR of hochwasser.cli.
  for (const thrown of [
    Object.assign(new Error("ENOENT: no such file or directory, open '/nonexistent/x'"), { code: "ENOENT" }),
    Object.assign(new Error("EACCES: permission denied, open '/nonexistent/x'"), { code: "EACCES" }),
    Object.assign(new Error("EISDIR: illegal operation on a directory, open '/nonexistent/x'"), { code: "EISDIR" }),
    "not an Error",
  ]) {
    const cli = makeCli(() => jsonResponse(fx.alertsJson));
    cli.deps.files = {
      state: () => "absent",
      parentProblem: () => undefined,
      write: () => {
        throw thrown;
      },
    };
    assert.equal(await run(["-o", "/nonexistent/x", "alerts"], cli.deps), 1);
    assert.match(untimed(cli.err.join("\n")), /^ERROR \[hochwasser\.output\] Could not write to "\/nonexistent\/x": /);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
  }
  // An existing file without --force: refused before any request, exit 2; one that appears
  // during the request is found by the write, a failed write (exit 1).
  const exists = makeCli(() => jsonResponse(fx.alertsJson), ["exists.json"]);
  assert.equal(await run(["-o", "exists.json", "alerts"], exists.deps), 2);
  assert.equal(exists.mt.calls.length, 0);
  assert.match(untimed(exists.err.join("\n")), /^ERROR \[hochwasser\.output\] Refusing to overwrite existing file "exists\.json"/);
  const race = makeCli(() => jsonResponse(fx.alertsJson));
  race.deps.files = {
    state: () => "absent",
    parentProblem: () => undefined,
    write: (p) => {
      throw appearedMeanwhile(p, "file");
    },
  };
  assert.equal(await run(["-o", "race.json", "alerts"], race.deps), 1);
  assert.match(untimed(race.err.join("\n")), /^ERROR \[hochwasser\.output\] Refusing to overwrite existing file "race\.json"/);
});

test("the -o failure drops Node's \", open '<path>'\" tail also when the path holds a line break", async () => {
  for (const path of ["/nonexistent\nZZ/x", "/nonexistent\u2028ZZ/x", "/nonexistent\rZZ/x", "/nonexistent/x"]) {
    const cli = makeCli(() => jsonResponse(fx.alertsJson));
    cli.deps.files = {
      state: () => "absent",
      parentProblem: () => undefined,
      write: (p) => {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
      },
    };
    assert.equal(await run(["-o", path, "alerts"], cli.deps), 1);
    assert.equal(cli.err.length, 1, cli.err.join("\n"));
    const msg = untimed(cli.err[0] as string);
    assert.match(msg, /^ERROR \[hochwasser\.output\] Could not write to "\/nonexistent.*": ENOENT: no such file or directory$/);
    assert.doesNotMatch(msg, /open '/);
  }
});

test("an answer with invalid text prints well-formed JSON and one WARN record of hochwasser.api (D2)", async () => {
  const body = Buffer.concat([Buffer.from('{"status":"success","data":[],"note":"a'), Buffer.from([0xff]), Buffer.from('b\\ud800"}')]);
  const cli = makeCli(() => rawResponse(body, "application/json"));
  assert.equal(await run(["--compact", "alerts"], cli.deps), 0);
  assert.equal((JSON.parse(cli.out.join("\n")) as { note: string }).note, "a\ufffdb\ufffd");
  assert.deepEqual(cli.err.map(untimed), [
    "WARN  [hochwasser.api] GET https://api.hochwasserzentralen.de/public/v1/data/alerts: 2 characters of the answer were not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.",
  ]);
});

test("terminal controls are escaped in chunks: the same text as one pass, across chunk edges (D7)", () => {
  const DEL = String.fromCharCode(0x7f);
  const C1 = String.fromCharCode(0x9b);
  const RLO = String.fromCharCode(0x202e);
  // Controls right before, at and after the 64 Ki edges, and a run of them.
  const text = ["a".repeat(65535), DEL, C1, "b".repeat(65534), RLO, DEL.repeat(70000), "ü😀", C1].join("");
  const { deps, out } = makeCli(() => jsonResponse({}));
  renderJson(deps, { compact: true }, { text });
  const expected = JSON.stringify({ text }).replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.equal(out[0], expected);
  assert.deepEqual(JSON.parse(out[0]!), { text });
});
