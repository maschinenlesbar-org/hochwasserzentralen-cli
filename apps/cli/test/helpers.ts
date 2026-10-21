// Test helpers of the CLI: the log helpers and the CLI <-> library parity harness. The
// transport helpers (canned responses, the recording mock transport) live with the client,
// in packages/client/test/helpers.ts, and are re-exported here so every CLI test imports its
// helpers from one place.

import type { Transport, HttpRequest, HttpResponse } from "@maschinenlesbar.org/hochwasserzentralen-client/internal/http";
import { refuseOverwrite, type CliDeps, type OutputFiles } from "../src/cli/io.js";
import { run } from "../src/cli/run.js";
import { defaultDeps } from "../src/cli/program.js";
import { jsonResponse, makeMockTransport } from "@maschinenlesbar.org/hochwasserzentralen-client/test/helpers";

export * from "@maschinenlesbar.org/hochwasserzentralen-client/test/helpers";

// ---- the log on stderr -------------------------------------------------------

/**
 * stderr with each text record's timestamp taken off: `ERROR [hochwasser.api] HTTP 404 …`.
 * The format itself — timestamp, level, topic — is the conformance test's
 * (conformance-p23-log-format); the other tests check what was said, at which level
 * and under which topic.
 */
export function untimed(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm, "");
}

// ---- the -o file seam ------------------------------------------------------

/** An `-o` seam that writes nothing: no path exists, a write is dropped (P23's `-o` runs). */
export const discardFiles: OutputFiles = { state: () => "absent", write: () => {} };

/** An `-o` seam for tests that must not write: no path exists, a write is an error. */
export const noFiles: OutputFiles = {
  state: () => "absent",
  write: () => {
    throw new Error("the CLI tried to write a file");
  },
};

/**
 * An in-memory `-o` file system: the `existing` paths are there, a write lands in `written`
 * and is refused (as `nodeFiles` refuses it) for a path that exists unless `overwrite`.
 */
export function memoryFiles(existing: readonly string[] = []): OutputFiles & { written: Record<string, Buffer> } {
  const written: Record<string, Buffer> = {};
  const files: OutputFiles & { written: Record<string, Buffer> } = {
    written,
    state: (path) => (existing.includes(path) || written[path] !== undefined ? "exists" : "absent"),
    write: (path, data, overwrite) => {
      if (!overwrite && files.state(path) !== "absent") throw refuseOverwrite(path);
      written[path] = data;
    },
  };
  return files;
}

// ---- CLI <-> library parity ---------------------------------------------------

/** What the CLI did with one input: exit code, captured output and requests. */
export interface CliOutcome {
  code: number;
  out: string;
  err: string;
  requests: HttpRequest[];
}

/** What the library did with the same input: its value or error, and requests. */
export type LibOutcome =
  | { ok: true; value: unknown; requests: HttpRequest[] }
  | { ok: false; error: unknown; requests: HttpRequest[] };

/** What the library did, in the shape the shared P24/P25 bodies read: the error as `{ name, message }`. */
export interface KitLibOutcome {
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string };
  requests: HttpRequest[];
}

/** {@link parity}, with the library's error mapped to `{ name, message }` for P24/P25. */
export async function kitParity(
  argv: string[],
  call: (transport: Transport) => unknown,
  responder?: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): Promise<{ cli: CliOutcome; lib: KitLibOutcome }> {
  const { cli, lib } = await parity(argv, call, responder);
  if (lib.ok) return { cli, lib: { ok: true, value: lib.value, requests: lib.requests } };
  const error = lib.error instanceof Error ? { name: lib.error.name, message: lib.error.message } : { name: "", message: String(lib.error) };
  return { cli, lib: { ok: false, error, requests: lib.requests } };
}

/**
 * Send one input through the CLI (`run(argv)` with the real client factory, on the
 * mock transport) and through a library call (`call(transport)`, e.g.
 * `(t) => new HochwasserzentralenClient({ transport: t }).stations()`), both on ONE
 * recording mock transport. Returns both outcomes with the requests each side made,
 * so a test can assert the same outcome: both reject with no request, or both send
 * the identical request. A synchronous throw from the library call (constructor
 * validation) is captured like a rejection. The CLI never touches the filesystem.
 */
export async function parity(
  argv: string[],
  call: (transport: Transport) => unknown,
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => jsonResponse({ data: [] }),
): Promise<{ cli: CliOutcome; lib: LibOutcome }> {
  const mt = makeMockTransport(responder);
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    files: noFiles,
    createClient: (opts) => defaultDeps.createClient({ ...opts, transport: mt.transport }),
  };
  const code = await run(argv, deps);
  const cliRequests = mt.calls.slice();
  const cli: CliOutcome = { code, out: out.join("\n"), err: untimed(err.join("\n")), requests: cliRequests };

  let lib: LibOutcome;
  try {
    const value = await call(mt.transport);
    lib = { ok: true, value, requests: mt.calls.slice(cliRequests.length) };
  } catch (error) {
    lib = { ok: false, error, requests: mt.calls.slice(cliRequests.length) };
  }
  return { cli, lib };
}
