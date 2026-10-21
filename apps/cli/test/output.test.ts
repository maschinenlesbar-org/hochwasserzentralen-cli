// `-o` against real files in a temp dir, through run(): the target checks before any request,
// the atomic write, --force. A write cut short is conformance test P26's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

test("--force to a new path creates the file; through a dangling link it creates the file the link names (D1)", async () => {
  await inTempDir(async (dir) => {
    const fresh = join(dir, "fresh.json");
    assert.equal(await run(["--compact", "-o", fresh, "--force", "alerts"], makeCli().deps), 0);
    assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), BIDI);
    // "--force writes through a symlink", also when the file it points at doesn't exist yet; a
    // relative link is resolved from the link's directory, through a chain of links.
    mkdirSync(join(dir, "sub"));
    symlinkSync("sub/nowhere.json", join(dir, "hop.json"));
    const dangling = join(dir, "dangling.json");
    symlinkSync("hop.json", dangling);
    assert.equal(await run(["--compact", "-o", dangling, "--force", "alerts"], makeCli().deps), 0);
    assert.ok(lstatSync(dangling).isSymbolicLink(), "the link stays a link");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "sub", "nowhere.json"), "utf8")), BIDI);
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "fresh.json", "hop.json", "sub"]);
    assert.deepEqual(readdirSync(join(dir, "sub")), ["nowhere.json"], "no temporary file is left");
  });
});

test("a target whose directory can't take the file is refused before any request, exit 2 (D5)", async () => {
  await inTempDir(async (dir) => {
    const file = join(dir, "file.json");
    writeFileSync(file, "x");
    const readOnly = join(dir, "ro");
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o555);
    const loop = join(dir, "loop.json");
    symlinkSync("loop.json", loop);
    const danglingIntoMissing = join(dir, "away.json");
    symlinkSync("missing/x.json", danglingIntoMissing);
    const cases: Array<[string[], RegExp]> = [
      [["-o", join(dir, "missing", "x.json")], /the directory ".*missing" does not exist\./],
      [["-o", join(dir, "missing", "x.json"), "--force"], /the directory ".*missing" does not exist\./],
      [["-o", join(file, "x.json")], /".*file\.json" is not a directory\./],
      [["-o", join(readOnly, "x.json")], /no permission to create files in ".*ro"\./],
      [["-o", danglingIntoMissing, "--force"], /the directory ".*missing" does not exist\./],
      [["-o", loop, "--force"], /too many levels of symbolic links/],
    ];
    try {
      for (const [argv, message] of cases) {
        const cli = makeCli();
        assert.equal(await run([...argv, "alerts"], cli.deps), 2, argv.join(" "));
        assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
        assert.match(cli.err.join("\n"), /^ERROR \[hochwasser\.output\] Cannot write to "/, argv.join(" "));
        assert.match(cli.err.join("\n"), message, argv.join(" "));
      }
    } finally {
      chmodSync(readOnly, 0o755);
    }
  });
});

test("a file name of up to 255 bytes is written: the temporary name stays within NAME_MAX (D5)", async () => {
  await inTempDir(async (dir) => {
    for (const name of [`${"x".repeat(250)}.json`, `${"ü".repeat(125)}.json`, `${"😀".repeat(62)}.json`]) {
      assert.ok(Buffer.byteLength(name) <= 255, name);
      const path = join(dir, name);
      const cli = makeCli();
      assert.equal(await run(["--compact", "-o", path, "alerts"], cli.deps), 0, cli.err.join("\n"));
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), BIDI);
      assert.equal(await run(["--compact", "-o", path, "--force", "alerts"], makeCli().deps), 0);
    }
    assert.equal(readdirSync(dir).length, 3, "no temporary file is left");
  });
});

test("a stream target (/dev/null) needs no --force and is written in place (D5)", async () => {
  for (const argv of [["-o", "/dev/null"], ["-o", "/dev/null", "--force"]]) {
    const cli = makeCli();
    assert.equal(await run([...argv, "alerts"], cli.deps), 0, cli.err.join("\n"));
    assert.equal(cli.mt.calls.length, 1);
    assert.match(cli.err.join("\n"), /^INFO  \[hochwasser\.output\] Wrote \d+ bytes to \/dev\/null$/);
  }
  assert.ok(statSync("/dev/null").isCharacterDevice(), "/dev/null is still the device");
});

test("a file that appears during the request is not overwritten: a write failure, exit 1, not a usage error", async () => {
  // Nothing the user typed was wrong (the check before the request passed), so this is the
  // write failing, as the kit has it: an ERROR of hochwasser.output, exit 1.
  await inTempDir(async (dir) => {
    const path = join(dir, "race.json");
    const cli = makeCli(() => {
      writeFileSync(path, "theirs");
      return jsonResponse(BIDI);
    });
    assert.equal(await run(["-o", path, "alerts"], cli.deps), 1);
    assert.equal(readFileSync(path, "utf8"), "theirs");
    assert.deepEqual(cli.err, [
      `ERROR [hochwasser.output] Refusing to overwrite existing file "${path}". Pass --force to overwrite, or choose a different --output path.`,
    ]);
    assert.deepEqual(readdirSync(dir), ["race.json"]);
  });
});

test("a directory that appears during the request is a write failure too: exit 1, also with --force", async () => {
  await inTempDir(async (dir) => {
    for (const force of [false, true]) {
      const path = join(dir, `race-dir-${force}`);
      const cli = makeCli(() => {
        mkdirSync(path);
        return jsonResponse(BIDI);
      });
      assert.equal(await run(["-o", path, ...(force ? ["--force"] : []), "alerts"], cli.deps), 1, `force ${force}`);
      assert.deepEqual(cli.err, [`ERROR [hochwasser.output] "${path}" is a directory; give a file path to --output.`]);
      assert.deepEqual(readdirSync(path), []);
    }
  });
});

test("a write the file system refuses is an ERROR of the output area naming the file, not the temporary one; exit 1", async () => {
  await inTempDir(async (dir) => {
    for (const force of [false, true]) {
      const sub = join(dir, `gone-${force}`);
      mkdirSync(sub);
      const path = join(sub, "out.json");
      // The directory is there when -o is checked, and gone when the answer is written.
      const cli = makeCli(() => {
        rmSync(sub, { recursive: true });
        return jsonResponse(BIDI);
      });
      assert.equal(await run(["-o", path, ...(force ? ["--force"] : []), "alerts"], cli.deps), 1);
      assert.deepEqual(cli.err, [`ERROR [hochwasser.output] Could not write to "${path}": ENOENT: no such file or directory`]);
    }
    const locked = join(dir, "locked");
    mkdirSync(locked);
    try {
      const path = join(locked, "out.json");
      // Writable when -o is checked, locked when the answer is written.
      const cli = makeCli(() => {
        chmodSync(locked, 0o500);
        return jsonResponse(BIDI);
      });
      assert.equal(await run(["-o", path, "alerts"], cli.deps), 1);
      assert.match(cli.err.join("\n"), /^ERROR \[hochwasser\.output\] Could not write to ".*out\.json": EACCES/);
      assert.deepEqual(readdirSync(locked), []);
    } finally {
      chmodSync(locked, 0o700);
    }
    assert.deepEqual(readdirSync(dir).sort(), ["locked"]);
  });
});
