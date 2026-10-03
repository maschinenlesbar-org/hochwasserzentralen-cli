import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertValid,
  baseUrlProblem,
  headerNameProblem,
  headerValueProblem,
  minClassProblem,
  nonBlankProblem,
  type Problem,
} from "../src/client/validate.js";
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

test("headerValueProblem rejects blank, control characters and non-Latin-1, allows tab and Latin-1", () => {
  assert.equal(headerValueProblem("my-app/1.0"), undefined);
  assert.equal(headerValueProblem("café\tx"), undefined);
  assert.equal(headerValueProblem(""), "Expected a non-empty value.");
  assert.equal(headerValueProblem("  "), "Expected a non-empty value.");
  for (const bad of ["a\r\nb", "a\u0000", "a\u007f", "a\u001b[0m"]) {
    assert.equal(headerValueProblem(bad), "Value contains control characters.", JSON.stringify(bad));
  }
  assert.equal(headerValueProblem("a €"), "Value contains characters outside Latin-1 (above U+00FF).");
  assert.equal(headerValueProblem(1), "Expected a string.");
});

test("headerNameProblem accepts an RFC 9110 token only", () => {
  assert.equal(headerNameProblem("X-Request-Id"), undefined);
  for (const bad of ["", "X Id", "X:Id", "X\r\nY", 1]) {
    assert.equal(headerNameProblem(bad), "Expected an HTTP header name (a token such as X-Request-Id).");
  }
});

test("the client constructor checks userAgent and defaultHeaders before any request", () => {
  const bad: Array<[object, string]> = [
    [{ userAgent: "a\r\nb" }, "Invalid userAgent: Value contains control characters."],
    [{ userAgent: "" }, "Invalid userAgent: Expected a non-empty value."],
    [{ defaultHeaders: { "X-A": "a\nb" } }, 'Invalid defaultHeaders["X-A"]: Value contains control characters.'],
    [{ defaultHeaders: { "X A": "v" } }, "Invalid defaultHeaders name: Expected an HTTP header name (a token such as X-Request-Id)."],
    [{ defaultHeaders: "X-A: v" }, "Invalid defaultHeaders: Expected an object of header names to values."],
  ];
  for (const [options, message] of bad) {
    assert.throws(
      () => new HochwasserzentralenClient(options),
      (e: unknown) => e instanceof HochwasserzentralenValidationError && e.message === message,
      message,
    );
  }
  assert.equal(lib.assertHeaderValue("userAgent", "ok/1"), "ok/1");
});

test("valid defaultHeaders are sent with every request", async () => {
  const { lib: l } = await parity(
    ["--compact", "stations"],
    (transport) => new HochwasserzentralenClient({ transport, defaultHeaders: { "X-Trace": "1" } }).stations(),
    () => jsonResponse(fx.stationsJson),
  );
  assert.equal(l.requests[0]?.headers?.["X-Trace"], "1");
});

test("baseUrlProblem: blank, unparseable, non-http(s), query or fragment", () => {
  assert.equal(baseUrlProblem("https://api.hochwasserzentralen.de/public/v1"), undefined);
  assert.equal(baseUrlProblem("http://127.0.0.1:8080/v1/"), undefined);
  assert.equal(baseUrlProblem(""), "Expected a non-empty URL.");
  assert.equal(baseUrlProblem(" \t"), "Expected a non-empty URL.");
  assert.equal(baseUrlProblem("h.example"), "Expected a valid URL.");
  assert.equal(baseUrlProblem("ftp://h/v1"), "Only http: and https: base URLs are supported.");
  assert.equal(baseUrlProblem("http://h/v1?x=1"), "A base URL cannot have a query (?) or fragment (#).");
  assert.equal(baseUrlProblem("http://h/v1#f"), "A base URL cannot have a query (?) or fragment (#).");
  assert.equal(baseUrlProblem(42), "Expected a string.");
  assert.equal(lib.validateBaseUrl("http://h/v1//"), "http://h/v1");
});
