// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { lstatSync, writeFileSync } from "node:fs";
import type { HochwasserzentralenClient, HochwasserzentralenClientOptions } from "../client/client.js";
import { createLogger, type Logger } from "./log.js";
import { HochwasserzentralenError } from "../client/errors.js";

/**
 * Writing the output to the `-o` file failed (a missing directory, a directory, EACCES,
 * …), or was refused (`refused`: an existing file without `--force`). Logged as an ERROR
 * of `hochwasser.output`; exit 1, or 2 for a refusal (a usage condition: pass --force or
 * pick another path).
 */
export class OutputError extends HochwasserzentralenError {
  /** True for the overwrite refusal (exit 2), false for a failed write (exit 1). */
  readonly refused: boolean;

  constructor(message: string, options: { cause?: unknown; refused?: boolean } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.refused = options.refused === true;
  }
}

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Persist bytes to a file (for --output). Without `overwrite` the file must not
   * exist yet (exclusive create): anything at `path` — a file, or a symlink, even a
   * dangling one — makes it throw an `EEXIST` error instead of writing through it.
   */
  writeFile(path: string, data: Buffer, overwrite: boolean): void;
  /**
   * True if a filesystem entry already exists at `path` (the --force guard); a
   * dangling symlink counts.
   */
  fileExists(path: string): boolean;
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: HochwasserzentralenClientOptions): HochwasserzentralenClient;
  /**
   * Where diagnostics go: one record per line on stderr, in the `--log-format`
   * (`log.ts`). `run()` sets it from argv; deps without it log text through `io.err`.
   */
  log?: Logger;
  /** The clock the log's timestamps come from. Unset, the real one. */
  now?: () => Date;
}

/** The deps' logger, or one that writes text records through `io.err`. */
export function logOf(deps: CliDeps): Logger {
  return deps.log ?? createLogger({ format: "text", write: (line) => deps.io.err(line), ...(deps.now === undefined ? {} : { now: deps.now }) });
}

/** The two process streams, as far as `handleOutputErrors` needs them. */
export interface OutputStreams {
  stdout: Pick<NodeJS.WriteStream, "on">;
  stderr: Pick<NodeJS.WriteStream, "on" | "write">;
}

/**
 * Handle write errors on stdout/stderr, which Node otherwise reports as an
 * unhandled 'error' event: a raw stack trace and exit 1.
 *
 * A reader that stops early — `| head`, `| jq` exiting on the first match, a closed
 * pager — closes the pipe while the CLI is still writing, and the next write fails
 * with EPIPE (ENOTCONN when stdout is a socket whose peer has gone, as when a Node
 * parent spawns the CLI with piped stdio on macOS). That is ordinary use, so the
 * process exits 0 at once, quietly. Any
 * other stdout error (e.g. EBADF with stdout read-only) is an ERROR record of
 * `hochwasser.output` (`Could not write to stdout: <message>`, through `log`, in the
 * run's format) and exits 1. On stderr an EPIPE is ignored, so a failed run keeps its
 * exit code; any other stderr error exits 1 silently (there is nowhere left to report
 * it). The bin shim installs this once, before `run()`, with a logger for the format
 * argv asks for (`processLogger`); without one, records are text on `streams.stderr`.
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
  log: Pick<Logger, "error"> = createLogger({ format: "text", write: (line) => streams.stderr.write(line + "\n") }),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (readerGone(err)) return exit(0);
    log.error("output", `Could not write to stdout: ${err.message}`);
    exit(1);
  });
  // stderr's reader going away doesn't make a failed run a success: ignore EPIPE there and
  // let the run's own exit code stand (`2>&1 | true` used to turn a usage error into 0).
  streams.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (!readerGone(err)) exit(1);
  });
}

/** True for the write errors that mean the reader has gone: EPIPE, or ENOTCONN on a socket. */
function readerGone(err: NodeJS.ErrnoException): boolean {
  return err.code === "EPIPE" || err.code === "ENOTCONN";
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  // "wx" = O_CREAT|O_EXCL: never follows a symlink planted at `path` and closes the
  // gap between the fileExists check and the write.
  writeFile: (path, data, overwrite) => writeFileSync(path, data, { flag: overwrite ? "w" : "wx" }),
  // lstat, not existsSync: existsSync follows a symlink and reports a dangling one
  // as absent, so -o would create a file wherever the link points.
  fileExists: (path) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  },
};
