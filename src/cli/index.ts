#!/usr/bin/env node
// Bin shim: parse argv, run the CLI, and set the process exit code. All real
// logic lives in run.ts (testable without spawning a subprocess).

import { handleOutputErrors } from "./io.js";
import { createLogger, logFormatFromArgv } from "./log.js";
import { run } from "./run.js";

handleOutputErrors();
run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // run() reports its own errors; this is the last resort, a log record all the same.
    createLogger({ format: logFormatFromArgv(process.argv.slice(2)), write: (line) => process.stderr.write(line + "\n") }).error(
      "cli",
      `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  },
);
