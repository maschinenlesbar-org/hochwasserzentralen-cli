// Compile-time checks of the exported library types: a consumer under the strictest compiler
// settings may pass `undefined` for any option, as the runtime treats it as omitted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HochwasserzentralenClient, RequestEngine, filterStations } from "../src/index.js";
import { jsonResponse, makeMockTransport } from "./helpers.js";
import * as fx from "./fixtures.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "hochwasserzentralen-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { HochwasserzentralenClient, type AlertsParams, type EngineOptions, type HochwasserzentralenClientOptions, type RequestOptions, type SituationParams, type StationFilter, type StationsParams } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const options: EngineOptions = allUndefined<EngineOptions>();",
        "export const clientOptions: HochwasserzentralenClientOptions = allUndefined<HochwasserzentralenClientOptions>();",
        "export const request: RequestOptions = allUndefined<RequestOptions>();",
        "export const alerts: AlertsParams = allUndefined<AlertsParams>();",
        "export const stations: StationsParams = allUndefined<StationsParams>();",
        "export const situation: SituationParams = allUndefined<SituationParams>();",
        "export const filter: StationFilter = allUndefined<StationFilter>();",
        "export const client = new HochwasserzentralenClient({ baseUrl: process.env.HOCHWASSER_BASE_URL, timeoutMs: 15_000 });",
        "export const ids = async (): Promise<string[]> => (await client.stations({ water: process.env.WATER })).data.map((s) => s.id);",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = makeMockTransport((req) => jsonResponse(req.url.includes("/data/alerts") ? fx.alertsJson : fx.stationsJson));
  const client = new HochwasserzentralenClient({
    baseUrl: undefined,
    userAgent: undefined,
    defaultHeaders: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.alerts({ states: undefined, cap: undefined, lang: undefined });
  assert.equal(mt.last().url, "https://api.hochwasserzentralen.de/public/v1/data/alerts");
  assert.equal(mt.last().headers?.["Accept-Language"], undefined);
  const all = await client.stations({ states: undefined, lang: undefined, water: undefined, minClass: undefined });
  assert.equal(mt.last().url, "https://api.hochwasserzentralen.de/public/v1/data/stations");
  assert.equal(all.data.length, fx.stationsJson.data.length);
  await client.situation({ states: undefined, lang: undefined });
  assert.equal(mt.last().url, "https://api.hochwasserzentralen.de/public/v1/data/stations");
  assert.deepEqual(filterStations(fx.stationsJson, { water: undefined, minClass: undefined }).data, fx.stationsJson.data);
  const engine = new RequestEngine({ transport: mt.transport });
  await engine.request("/data/alerts", undefined, { accept: undefined, language: undefined });
  assert.equal(mt.last().headers?.["Accept"], "application/json");
  assert.equal(mt.last().headers?.["Accept-Language"], undefined);
});
