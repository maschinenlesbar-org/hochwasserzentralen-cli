import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, minClassProblem, nonBlankProblem, type Problem } from "../src/client/validate.js";
import * as lib from "../src/index.js";
import { HochwasserzentralenError, HochwasserzentralenValidationError } from "../src/client/errors.js";
import { HochwasserzentralenClient } from "../src/client/client.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { jsonResponse, parity } from "./helpers.js";
import * as fx from "./fixtures.js";

const nonBlank: Problem<string> = (v) => (v.trim() === "" ? "Expected a non-empty value." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("water", "Donau", nonBlank), "Donau");
});

test("assertValid throws HochwasserzentralenValidationError 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("water", "  ", nonBlank),
    (err: unknown) =>
      err instanceof HochwasserzentralenValidationError &&
      err instanceof HochwasserzentralenError &&
      err.message === "Invalid water: Expected a non-empty value.",
  );
});

test("the validation layer is exported from the package root", () => {
  assert.equal(lib.assertValid, assertValid);
  assert.equal(lib.HochwasserzentralenValidationError, HochwasserzentralenValidationError);
});

test("run() maps a HochwasserzentralenValidationError raised in an action to exit 2, 'Error: <message>'", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => {}, fileExists: () => false },
    createClient: () => {
      throw new HochwasserzentralenValidationError("Invalid thing: Expected a non-empty value.");
    },
  };
  assert.equal(await run(["stations"], deps), 2);
  assert.deepEqual(err, ["Error: Invalid thing: Expected a non-empty value."]);
  assert.deepEqual(out, []);
});

test("parity() runs one input through the CLI and the library on one recording transport", async () => {
  const { cli, lib: l } = await parity(
    ["--compact", "stations", "--states", "be"],
    (transport) => new HochwasserzentralenClient({ transport }).stations({ states: ["be"] }),
    () => jsonResponse(fx.stationsJson),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.requests.length, 1);
  assert.equal(l.ok, true);
  assert.equal(l.requests.length, 1);
  assert.equal(cli.requests[0]!.url, l.requests[0]!.url);
  assert.deepEqual(JSON.parse(cli.out), l.ok ? l.value : undefined);
});

test("nonBlankProblem rejects a blank or non-string value", () => {
  assert.equal(nonBlankProblem("Donau"), undefined);
  assert.equal(nonBlankProblem(" x "), undefined);
  assert.equal(nonBlankProblem(""), "Expected a non-empty value.");
  assert.equal(nonBlankProblem(" \t "), "Expected a non-empty value.");
  assert.equal(nonBlankProblem(3), "Expected a string.");
  assert.equal(nonBlankProblem(undefined), "Expected a string.");
});

test("minClassProblem accepts an integer from -1 to 4 only", () => {
  for (const ok of [-1, 0, 1, 4]) assert.equal(minClassProblem(ok), undefined, String(ok));
  for (const bad of [-2, 5, 9, 2.5, Number.NaN, "2", null]) {
    assert.equal(minClassProblem(bad), "Expected an integer between -1 and 4.", String(bad));
  }
});
