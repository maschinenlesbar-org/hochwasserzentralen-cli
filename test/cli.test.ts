import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { HochwasserzentralenClient } from "../src/client/client.js";
import { HochwasserzentralenNetworkError, credentialsIn, toWellFormed } from "../src/client/errors.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse, untimed } from "./helpers.js";
import * as fx from "./fixtures.js";

function makeCli(
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
  existingFiles: string[] = [],
) {
  const out: string[] = [];
  const err: string[] = [];
  const files: Record<string, Buffer> = {};
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: (p, d) => {
        files[p] = d;
      },
      fileExists: (p) => existingFiles.includes(p) || files[p] !== undefined,
    },
    createClient: (opts) => new HochwasserzentralenClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt, files };
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

test("a server 3xx exits 1 (runtime) with a base-url hint, not usage (2)", async () => {
  const cli = makeCli(() => rawResponse("", "text/html", 302));
  const code = await run(["alerts"], cli.deps);
  assert.equal(code, 1);
  assert.match(untimed(cli.err.join("\n")), /^INFO  \[hochwasser\.api\] the server redirected \(3xx\)/m);
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

test("a file that appears between the check and the write (EEXIST) is refused like an existing one", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  let overwriteFlag: boolean | undefined;
  cli.deps.io.writeFile = (_p, _d, overwrite) => {
    overwriteFlag = overwrite;
    throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
  };
  assert.equal(await run(["-o", "race.json", "stations"], cli.deps), 2);
  assert.equal(overwriteFlag, false);
  assert.match(cli.err.join("\n"), /Refusing to overwrite existing file "race.json"/);
});

test("--force writes with overwrite allowed", async () => {
  const cli = makeCli(() => jsonResponse(fx.stationsJson));
  let overwriteFlag: boolean | undefined;
  cli.deps.io.writeFile = (_p, _d, overwrite) => {
    overwriteFlag = overwrite;
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
    assert.match(untimed(cli.err.join("\n")), /^ERROR \[hochwasser\.cli\] Unexpected response shape from \/data\/stations/);
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
      assert.match(untimed(cli.err.join("\n")), /^ERROR \[hochwasser\.cli\] Unexpected lhpClass .* at station "BY_10088003" .*expected an integer from -1 to 4, or null/);
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

test("a deeply nested response gives a clear error, not a stack overflow", async () => {
  const deep = "[".repeat(200_000) + "]".repeat(200_000);
  const body = `{"apiVersion":"x","status":"success","lang":"de","source":"s","sourceName":"s","licence":"l","licenceName":"l","title":"t","description":"d","updated":"u","data":[],"extra":${deep}}`;
  const pretty = makeCli(() => rawResponse(body, "application/json"));
  assert.equal(await run(["stations", "--states", "HH"], pretty.deps), 1);
  assert.equal(untimed(pretty.err.join("\n")), "ERROR [hochwasser.cli] The response is nested too deeply to pretty-print; try --compact.");
  const compact = makeCli(() => rawResponse(body, "application/json"));
  const code = await run(["--compact", "stations", "--states", "HH"], compact.deps);
  if (code !== 0) {
    assert.equal(code, 1);
    assert.equal(untimed(compact.err.join("\n")), "ERROR [hochwasser.cli] The response is nested too deeply to print.");
  }
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
    assert.match(cli.err.join("\n"), /without a single station/);
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
  // "--log-format" as the -o path: commander then sees "jsonl" as the command, and logs text.
  const output = makeCli(notFound);
  assert.equal(await run(["-o", "--log-format", "jsonl", "stations"], output.deps), 2);
  assert.ok(output.err.length > 0 && output.err.every((line) => !isJsonl(line)), output.err.join("\n"));
  assert.match(untimed(output.err[0] ?? ""), /^ERROR \[hochwasser\.cli\] unknown command 'jsonl'/);
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
    cli.deps.io.writeFile = () => {
      throw thrown;
    };
    assert.equal(await run(["-o", "/nonexistent/x", "alerts"], cli.deps), 1);
    assert.match(untimed(cli.err.join("\n")), /^ERROR \[hochwasser\.output\] Could not write to \/nonexistent\/x: /);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
  }
  // An existing file without --force: refused before any request, exit 2, and at write time too.
  const exists = makeCli(() => jsonResponse(fx.alertsJson), ["exists.json"]);
  assert.equal(await run(["-o", "exists.json", "alerts"], exists.deps), 2);
  assert.equal(exists.mt.calls.length, 0);
  assert.match(untimed(exists.err.join("\n")), /^ERROR \[hochwasser\.output\] Refusing to overwrite existing file "exists\.json"/);
  const race = makeCli(() => jsonResponse(fx.alertsJson));
  race.deps.io.writeFile = () => {
    throw Object.assign(new Error("EEXIST: file already exists, open 'race.json'"), { code: "EEXIST" });
  };
  assert.equal(await run(["-o", "race.json", "alerts"], race.deps), 2);
  assert.match(untimed(race.err.join("\n")), /^ERROR \[hochwasser\.output\] Refusing to overwrite existing file "race\.json"/);
});
