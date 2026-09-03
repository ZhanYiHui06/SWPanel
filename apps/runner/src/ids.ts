import { randomUUID } from "node:crypto";

import { InvalidArgumentError } from "./errors.js";

/** Ledger-safe path token pattern (drawing/revision ids become directory names). */
export const SAFE_PATH_TOKEN = /^[A-Za-z0-9._-]+$/;

/**
 * Generates a globally unique ledger/database identifier. The Runner always
 * mints ids; user-facing ids never become directory names.
 */
export function generateId(): string {
  return randomUUID();
}

/**
 * Validates that a value is safe to use as a single path segment. Generated
 * UUIDs qualify; free-form user text (Drawing numbers, file names) never does.
 */
export function assertSafeIdToken(label: string, value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new InvalidArgumentError(`${label} must be a non-empty string of at most 128 chars`, {
      [label]: value
    });
  }
  if (!SAFE_PATH_TOKEN.test(value)) {
    throw new InvalidArgumentError(
      `${label} contains characters that are unsafe for a ledger directory name`,
      { [label]: value }
    );
  }
}
