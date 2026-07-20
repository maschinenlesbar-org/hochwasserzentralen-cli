// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import {
  HochwasserzentralenApiError,
  HochwasserzentralenError,
  HochwasserzentralenNetworkError,
  HochwasserzentralenValidationError,
} from "../client/errors.js";

/**
 * Process exit codes. Distinct codes let scripts tell apart a usage error, a
 * missing resource, a transport failure, and a catch-all.
 */
const EXIT = {
  /** Usage / parse / client-side validation error (incl. the --force overwrite guard). */
  USAGE: 2,
  /** HTTP 404 — resource not found. */
  NOT_FOUND: 4,
  /** Network / transport failure (DNS, connection, timeout, size-cap). */
  NETWORK: 6,
  /** Any other error (incl. a 3xx — redirects are not followed — and bad JSON). */
  OTHER: 1,
} as const;

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  const program = buildProgram(deps);
  configureTree(program, deps);

  // A bare invocation (no command) is a help request, not an error: print help
  // to stdout and exit 0, matching `--help`.
  if (argv.length === 0) {
    deps.io.out(program.helpInformation().replace(/\n$/, ""));
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests exit 0; every genuine usage/parse error maps to a
      // single USAGE code (commander's own exitCode is 1, indistinguishable from
      // the catch-all).
      return err.exitCode === 0 ? 0 : EXIT.USAGE;
    }
    if (err instanceof HochwasserzentralenValidationError) {
      deps.io.err(`Error: ${err.message}`);
      return EXIT.USAGE;
    }
    if (err instanceof HochwasserzentralenApiError) {
      deps.io.err(`Error: ${err.message}`);
      if (err.status === 404) return EXIT.NOT_FOUND;
      // A 3xx means the server redirected. This client deliberately does not
      // follow redirects (the canonical host answers directly), so this usually
      // means --base-url points at a redirecting host — but it is a server /
      // runtime condition, not CLI misuse, so it exits OTHER (1) with a pointed
      // hint rather than USAGE (2), which scripts reserve for bad flags/arguments.
      if (err.status >= 300 && err.status < 400) {
        deps.io.err(
          "Hint: the server redirected (3xx); redirects are not followed — check --base-url " +
            "points at the canonical host (https://api.hochwasserzentralen.de/public/v1).",
        );
        return EXIT.OTHER;
      }
      return EXIT.OTHER;
    }
    if (err instanceof HochwasserzentralenNetworkError) {
      deps.io.err(`Error: ${err.message}`);
      if (/maxResponseBytes/.test(err.message)) {
        deps.io.err(
          "Hint: the response exceeded the size cap. Raise --max-response-bytes <n> (0 = unlimited).",
        );
      }
      return EXIT.NETWORK;
    }
    if (err instanceof HochwasserzentralenError) {
      // Includes HochwasserzentralenParseError (a non-JSON body).
      deps.io.err(`Error: ${err.message}`);
      return EXIT.OTHER;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.OTHER;
  }
}
