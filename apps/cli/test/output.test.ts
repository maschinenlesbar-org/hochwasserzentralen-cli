// `-o` against real files in a temp dir, through run(): the target checks before any request,
// the atomic write, --force. A write cut short is conformance test P26's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { HochwasserzentralenClient } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/client";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/http";
import * as fx from "@maschinenlesbar.org/hochwasserzentralen-client/test/fixtures";
import { jsonResponse, makeMockTransport, untimed } from "./helpers.js";

const BIDI = { ...fx.alertsJson, title: "Hochwasser \u001b[31m\u009b ‮" };

function makeCli(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => jsonResponse(BIDI)) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(untimed(s)) },
    createClient: (opts) => new HochwasserzentralenClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

/** Run `body` with a fresh temp directory that is always removed. */
async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "hochwasser-output-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("-o writes what stdout would show, plus a newline, and says so in an INFO record", async () => {
  await inTempDir(async (dir) => {
    const shown = makeCli();
    assert.equal(await run(["alerts"], shown.deps), 0);
    const path = join(dir, "alerts.json");
    const cli = makeCli();
    assert.equal(await run(["-o", path, "alerts"], cli.deps), 0);
    const written = readFileSync(path, "utf8");
    assert.equal(written, `${shown.out.join("\n")}\n`);
    assert.doesNotMatch(written, /[\u001b\u009b‮]/, "control characters are escaped in the file too");
    assert.match(written, /\\u202e/);
    assert.deepEqual(cli.out, []);
    assert.deepEqual(cli.err, [`INFO  [hochwasser.output] Wrote ${Buffer.byteLength(written)} bytes to ${path}`]);
    assert.deepEqual(readdirSync(dir), ["alerts.json"], "no temporary file is left");
  });
});

test("-o - prints to stdout and creates no file, also with --force", async () => {
  await inTempDir(async (dir) => {
    const cli = makeCli();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      assert.equal(await run(["--compact", "-o", "-", "alerts"], cli.deps), 0);
      assert.equal(await run(["--compact", "-o", "-", "--force", "alerts"], cli.deps), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.equal(cli.out.length, 2);
    assert.deepEqual(cli.err, []);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("a refused -o target is a usage error (exit 2) before any request", async () => {
  await inTempDir(async (dir) => {
    const existing = join(dir, "existing.json");
    writeFileSync(existing, "keep");
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nowhere"), dangling);
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const refusal = (path: string) =>
      `ERROR [hochwasser.output] Refusing to overwrite existing file "${path}". Pass --force to overwrite, or choose a different --output path.`;
    const cases: Array<[string[], string]> = [
      [["--force", "alerts"], "ERROR [hochwasser.cli] --force needs --output (it only allows overwriting the -o file)."],
      [["-o", existing, "alerts"], refusal(existing)],
      [["-o", dangling, "alerts"], refusal(dangling)],
      [["-o", sub, "alerts"], `ERROR [hochwasser.output] "${sub}" is a directory; give a file path to --output.`],
      [["-o", sub, "--force", "alerts"], `ERROR [hochwasser.output] "${sub}" is a directory; give a file path to --output.`],
    ];
    for (const [argv, message] of cases) {
      const cli = makeCli();
      assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
      assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
      assert.deepEqual(cli.err, [message], argv.join(" "));
    }
    assert.equal(readFileSync(existing, "utf8"), "keep");
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "existing.json", "sub"]);
  });
});

test("--force replaces an existing file atomically, keeps its mode, and writes through a symlink", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "out.json");
    writeFileSync(path, "old");
    chmodSync(path, 0o600);
    assert.equal(await run(["--compact", "-o", path, "--force", "alerts"], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), BIDI);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const link = join(dir, "latest.json");
    symlinkSync(path, link);
    assert.equal(await run(["--compact", "-o", link, "--force", "stations"], makeCli(() => jsonResponse(fx.stationsJson)).deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), fx.stationsJson);
    assert.deepEqual(readdirSync(dir).sort(), ["latest.json", "out.json"]);
  });
});

test("--force to a new path creates the file; over a dangling link it replaces the link with the file", async () => {
  await inTempDir(async (dir) => {
    const fresh = join(dir, "fresh.json");
    assert.equal(await run(["--compact", "-o", fresh, "--force", "alerts"], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), BIDI);
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nowhere"), dangling);
    assert.equal(await run(["--compact", "-o", dangling, "--force", "alerts"], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(dangling, "utf8")), BIDI);
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "fresh.json"]);
  });
});

test("a file that appears during the request is not overwritten: exit 2, the refusal", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "race.json");
    const cli = makeCli(() => {
      writeFileSync(path, "theirs");
      return jsonResponse(BIDI);
    });
    assert.equal(await run(["-o", path, "alerts"], cli.deps), 2);
    assert.equal(readFileSync(path, "utf8"), "theirs");
    assert.deepEqual(cli.err, [
      `ERROR [hochwasser.output] Refusing to overwrite existing file "${path}". Pass --force to overwrite, or choose a different --output path.`,
    ]);
    assert.deepEqual(readdirSync(dir), ["race.json"]);
  });
});

test("a write the file system refuses is an ERROR of the output area naming the file, exit 1, nothing left", async () => {
  await inTempDir(async (dir) => {
    for (const force of [false, true]) {
      const path = join(dir, "missing-dir", "out.json");
      const cli = makeCli();
      assert.equal(await run(["-o", path, ...(force ? ["--force"] : []), "alerts"], cli.deps), 1);
      assert.deepEqual(cli.err, [`ERROR [hochwasser.output] Could not write to "${path}": ENOENT: no such file or directory`]);
    }
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      const path = join(locked, "out.json");
      const cli = makeCli();
      assert.equal(await run(["-o", path, "alerts"], cli.deps), 1);
      assert.match(cli.err.join("\n"), /^ERROR \[hochwasser\.output\] Could not write to ".*out\.json": EACCES/);
      assert.deepEqual(readdirSync(locked), []);
    } finally {
      chmodSync(locked, 0o700);
    }
    assert.deepEqual(readdirSync(dir).sort(), ["locked"]);
  });
});
