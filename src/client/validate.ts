// Input validation shared by the library and the CLI. Every rule about what a
// request may contain lives in src/client as a pure, exported function, so the CLI
// calls the very same rule instead of keeping a copy.
//
// - A `Problem` returns the reason a value is invalid ("Expected a non-empty
//   value."), or `undefined` when it is valid. The CLI's commander parsers turn
//   that reason into an `InvalidArgumentError` (exit 2).
// - `assertValid` runs a `Problem` in the library and throws a
//   `HochwasserzentralenValidationError` ("Invalid <name>: <reason>") before any
//   request is made. Methods that return a promise call it inside the async body,
//   so they reject rather than throw synchronously; constructors throw.

import { HochwasserzentralenValidationError } from "./errors.js";

/** A validation rule: the reason `value` is invalid, or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Check `value` against `problem` and return it unchanged when it is valid.
 * Otherwise throw a {@link HochwasserzentralenValidationError} with the message
 * `Invalid <name>: <reason>`.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new HochwasserzentralenValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/**
 * A free-text or filter value must be a string with something besides whitespace
 * in it: a blank `water` filter would otherwise match every station (or none).
 */
export const nonBlankProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (value.trim() === "") return "Expected a non-empty value.";
  return undefined;
};

/**
 * A `minClass` filter must be an integer on the station lhpClass scale, -1 (no
 * data) .. 4 (Sehr großes Hochwasser).
 */
export const minClassProblem: Problem<unknown> = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= -1 && value <= 4
    ? undefined
    : "Expected an integer between -1 and 4.";
