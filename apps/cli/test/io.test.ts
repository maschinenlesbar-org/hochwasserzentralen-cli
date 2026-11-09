import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputError, handleOutputErrors, nodeFiles, nodeFilesFor, stderrAfterStdout, type LinkOwners } from "../src/cli/io.js";
import { run } from "../src/cli/run.js";
import { HochwasserzentralenClient } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/client";
import type { HttpRequest } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/http";
import { jsonResponse, makeMockTransport, untimed } from "./helpers.js";
import { createLogger } from "../src/cli/log.js";

function writeError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`write ${code}`);
  err.code = code;
  return err;
}

function setup() {
  const stdout = new EventEmitter();
  const written: string[] = [];
  const stderr = Object.assign(new EventEmitter(), { write: (text: string) => written.push(text) > 0 });
  const exits: number[] = [];
  const records: string[] = [];
  const log = createLogger({ format: "jsonl", write: (line) => records.push(line), now: () => new Date("2026-01-02T03:04:05.678Z") });
  handleOutputErrors(
    { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream },
    (code) => exits.push(code),
    log,
  );
  return { stdout, stderr, exits, written, records };
}

test("EPIPE on stdout (reader closed early, e.g. | head) exits 0 instead of crashing", () => {
  const s = setup();
  // Without a listener, emitting 'error' would throw — the raw stack trace of the bug.
  s.stdout.emit("error", writeError("EPIPE"));
  assert.deepEqual(s.exits, [0]);
  assert.deepEqual(s.records, []);
});

test("another stdout write error is an ERROR record of hochwasser.output, in the run's format, and exits 1 (result 04, Known 7)", () => {
  const s = setup();
  s.stdout.emit("error", writeError("EBADF"));
  assert.deepEqual(s.exits, [1]);
  assert.deepEqual(s.records.map((line) => JSON.parse(line)), [
    { ts: "2026-01-02T03:04:05.678Z", level: "ERROR", topic: "hochwasser.output", msg: "Could not write to stdout: write EBADF" },
  ]);
  assert.deepEqual(s.written, []);
});

test("without a logger, a stdout write error is a text ERROR record on the streams' stderr", () => {
  const stdout = new EventEmitter();
  const written: string[] = [];
  const stderr = Object.assign(new EventEmitter(), { write: (text: string) => written.push(text) > 0 });
  const exits: number[] = [];
  handleOutputErrors({ stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream }, (code) => exits.push(code));
  stdout.emit("error", writeError("EBADF"));
  assert.deepEqual(exits, [1]);
  assert.equal(written.length, 1);
  assert.match(written[0] ?? "", /^\S+Z ERROR \[hochwasser\.output\] Could not write to stdout: write EBADF\n$/);
});

test("ENOTCONN (stdout is a socket whose reader has gone) is treated like EPIPE", () => {
  const s = setup();
  s.stdout.emit("error", writeError("ENOTCONN"));
  s.stderr.emit("error", writeError("ENOTCONN"));
  assert.deepEqual(s.exits, [0]);
});

test("EPIPE on stderr is ignored, so the run's own exit code stands", () => {
  const s = setup();
  s.stderr.emit("error", writeError("EPIPE"));
  assert.deepEqual(s.exits, []);
});

test("another stderr write error exits 1", () => {
  const s = setup();
  s.stderr.emit("error", writeError("EIO"));
  assert.deepEqual(s.exits, [1]);
});

test("nodeFiles: a dangling symlink counts as existing and is never written through without --force", () => {
  const dir = mkdtempSync(join(tmpdir(), "hochwasser-io-"));
  try {
    const target = join(dir, "target-created.txt");
    const link = join(dir, "dangling");
    symlinkSync(target, link);
    assert.equal(nodeFiles.state(link), "exists");
    assert.throws(
      () => nodeFiles.write(link, Buffer.from("x"), false),
      // At write time (after the request) this is a failed write, exit 1: not `refused`.
      (err: unknown) => err instanceof OutputError && !err.refused && /Refusing to overwrite existing file/.test(err.message),
    );
    assert.equal(existsSync(target), false);

    const plain = join(dir, "plain.json");
    assert.equal(nodeFiles.state(plain), "absent");
    nodeFiles.write(plain, Buffer.from("one"), false);
    assert.throws(() => nodeFiles.write(plain, Buffer.from("two"), false), /Refusing to overwrite/);
    nodeFiles.write(plain, Buffer.from("three"), true);
    assert.equal(readFileSync(plain, "utf8"), "three");
    assert.equal(nodeFiles.state(dir), "directory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stream target is written only when the descriptor opened is a stream, and never created", { skip: process.platform === "win32" }, () => {
  // The path was a stream when it was classified (a link to /dev/null) and is a link to a regular
  // file, or to a file that doesn't exist, when it is opened: without --force nothing is appended
  // and nothing is created. The open by name with "a" followed the switched link (O_CREAT too).
  const dir = mkdtempSync(join(tmpdir(), "hw-stream-"));
  try {
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep me\n");
    const link = join(dir, "out.json");
    symlinkSync(victim, link);
    const switched = { ...nodeFiles, state: () => "stream" as const };
    assert.throws(() => switched.write(link, Buffer.from("appended\n"), false), /Refusing to overwrite/);
    assert.equal(readFileSync(victim, "utf8"), "keep me\n");
    const dangling = join(dir, "dangling.json");
    const missing = join(dir, "missing.txt");
    symlinkSync(missing, dangling);
    assert.throws(() => switched.write(dangling, Buffer.from("created\n"), false));
    assert.equal(existsSync(missing), false, "the in-place open creates no file");
    // A real stream is still written in place.
    assert.doesNotThrow(() => nodeFiles.write("/dev/null", Buffer.from("x"), false));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A stdout as far as the hold needs one: a backlog, and the events that end it. */
class FakeStdout extends EventEmitter {
  writableLength = 0;
}

test("stderr waits for stdout: a record is held while stdout has a backlog, and flushed in order (L11)", () => {
  const stdout = new FakeStdout();
  const written: string[] = [];
  const err = stderrAfterStdout(stdout, (text: string) => written.push(text));
  err("first");
  assert.deepEqual(written, ["first"], "no backlog: written at once");
  stdout.writableLength = 65536;
  err("second");
  err("third");
  assert.deepEqual(written, ["first"], "held while stdout has a backlog");
  stdout.writableLength = 0;
  stdout.emit("drain");
  assert.deepEqual(written, ["first", "second", "third"]);
  // Flushed on close and on error too, never lost.
  stdout.writableLength = 10;
  err("fourth");
  stdout.emit("close");
  stdout.writableLength = 10;
  err("fifth");
  stdout.emit("error", new Error("EPIPE"));
  assert.deepEqual(written, ["first", "second", "third", "fourth", "fifth"]);
});

// ---- -o --force and other users' links (security audit 2026-10-27, class G) -------------

/** The caller, and another user who planted links. */
const ME = 1000;
const OTHER = 1001;
/** /tmp: owned by root, sticky and world-writable. */
const SHARED = { uid: 0, mode: 0o41777 };

/** Owners as a test says: links' owners (the caller otherwise), directories' owner and mode. */
function owners(links: Record<string, number>, dirs: Record<string, { uid: number; mode: number }>): LinkOwners {
  return {
    uid: ME,
    ownerOf: (path, follow) => (follow ? (dirs[path] ?? { uid: ME, mode: 0o40755 }) : { uid: links[path] ?? ME, mode: 0o120777 }),
  };
}

async function runWith(files: ReturnType<typeof nodeFilesFor>, file: string, force: boolean): Promise<{ code: number; err: string; requests: HttpRequest[] }> {
  const mock = makeMockTransport(() => jsonResponse({ status: "success", data: [] }));
  const err: string[] = [];
  const code = await run(["--max-retries", "0", "-o", file, ...(force ? ["--force"] : []), "alerts"], {
    io: { out: () => {}, err: (s) => err.push(s) },
    createClient: (options) => new HochwasserzentralenClient({ ...options, transport: mock.transport }),
    files,
  });
  return { code, err: untimed(err.join("\n")), requests: mock.calls };
}

/** A temporary directory with a victim file and a link `out.json` to it. */
function planted(): { dir: string; victim: string; link: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hw-g-"));
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "keep me\n");
  const link = join(dir, "out.json");
  symlinkSync(victim, link);
  return { dir, victim, link, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("-o --force does not follow another user's link in a shared directory, at any hop, before any request or at write time", { skip: process.platform === "win32" }, async () => {
  const t = planted();
  try {
    // Sticky or just writable by others: both count.
    for (const dir of [SHARED, { uid: ME, mode: 0o40777 }]) {
      const files = nodeFilesFor(owners({ [t.link]: OTHER }, { [t.dir]: dir }));
      const o = await runWith(files, t.link, true);
      assert.equal(o.code, 2, o.err);
      assert.equal(o.requests.length, 0);
      assert.match(o.err, /ERROR \[hochwasser\.output\] .*another user/);
      assert.ok(o.err.includes(t.link), o.err);
      assert.throws(() => files.write(t.link, Buffer.from("x"), true), /another user/);
      assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
      assert.ok(lstatSync(t.link).isSymbolicLink());
    }
    // own link -> another user's link -> the victim; and another user's dangling link.
    const inner = join(t.dir, "inner");
    symlinkSync(t.victim, inner);
    const outer = join(t.dir, "outer.json");
    symlinkSync(inner, outer);
    assert.equal((await runWith(nodeFilesFor(owners({ [inner]: OTHER }, { [t.dir]: SHARED })), outer, true)).code, 2);
    const dangling = join(t.dir, "dangling.json");
    const target = join(t.dir, "created-elsewhere.json");
    symlinkSync(target, dangling);
    assert.equal((await runWith(nodeFilesFor(owners({ [dangling]: OTHER }, { [t.dir]: SHARED })), dangling, true)).code, 2);
    assert.throws(() => statSync(target));
    assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
  } finally {
    t.done();
  }
});

test("-o --force still follows the caller's own links, the directory owner's, and any link in a directory only its owner writes", { skip: process.platform === "win32" }, async () => {
  const cases: Array<[string, (t: ReturnType<typeof planted>) => LinkOwners]> = [
    ["the caller's own link in a shared directory", (t) => owners({}, { [t.dir]: SHARED })],
    ["a link of the shared directory's owner", (t) => owners({ [t.link]: 0 }, { [t.dir]: SHARED })],
    ["another user's link in a directory only its owner writes", (t) => owners({ [t.link]: OTHER }, { [t.dir]: { uid: OTHER, mode: 0o40755 } })],
    ["another user's link where no caller id exists", (t) => ({ ...owners({ [t.link]: OTHER }, { [t.dir]: SHARED }), uid: undefined })],
  ];
  for (const [label, who] of cases) {
    const t = planted();
    try {
      const o = await runWith(nodeFilesFor(who(t)), t.link, true);
      assert.equal(o.code, 0, `${label}: ${o.err}`);
      assert.equal((JSON.parse(readFileSync(t.victim, "utf8")) as { status: string }).status, "success", label);
      assert.ok(lstatSync(t.link).isSymbolicLink(), label);
    } finally {
      t.done();
    }
  }
});

test("an -o path that can't be inspected is reported as such, not as an existing file", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hw-g-"));
  try {
    const closed = join(dir, "closed");
    mkdirSync(closed);
    const link = join(dir, "out.json");
    symlinkSync(join(closed, "x.json"), link);
    chmodSync(closed, 0o000);
    const o = await runWith(nodeFilesFor(), link, false);
    assert.equal(o.code, 2, o.err);
    assert.equal(o.requests.length, 0);
    assert.doesNotMatch(o.err, /Refusing to overwrite existing file/);
    assert.match(o.err, /EACCES|permission/i);
  } finally {
    chmodSync(join(dir, "closed"), 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
