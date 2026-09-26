import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { HochwasserzentralenClient } from "../src/client/client.js";
import { HochwasserzentralenNetworkError } from "../src/client/errors.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
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
  // BY (worst 3) sorts before BE (worst 2).
  assert.deepEqual(
    parsed.states.map((s) => s.state),
    ["BY", "BE"],
  );
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
  assert.match(cli.err.join("\n"), /Wrote 4 features \(\d+ bytes\) to \/tmp\/stations\.geojson/);
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
  assert.match(cli.err.join("\n"), /ENOTFOUND/);
});

test("a server 3xx exits 1 (runtime) with a base-url hint, not usage (2)", async () => {
  const cli = makeCli(() => rawResponse("", "text/html", 302));
  const code = await run(["alerts"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /redirected \(3xx\)/);
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
    assert.match(cli.err.join("\n"), /^Error: Unexpected response shape from \/data\/stations/);
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
