// CLI <-> library parity: the same input through run() and through the library,
// on one recording mock transport, must give the same outcome — both reject with
// no request, or both send the identical request and return the same data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HochwasserzentralenClient } from "../src/client/client.js";
import { HochwasserzentralenParseError } from "../src/client/errors.js";
import type { HttpRequest } from "../src/client/http.js";
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
  assert.equal(cli.err, `Error: ${error.message}`);
});
