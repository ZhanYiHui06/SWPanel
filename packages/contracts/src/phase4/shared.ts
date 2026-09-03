/**
 * Shared building blocks of the Phase 4 contract validators in `@swpanel/contracts`.
 * The validators are strict, dependency-free runtime guards in the same style as
 * `ipc-validation.ts`: every Phase 4 contract validator rejects unknown fields,
 * version mismatches and illegal enum/shape values with a stable
 * machine-readable code instead of tolerating them silently.
 */

/** Stable machine-readable codes raised by every Phase 4 contract validator. */
export type Phase4ContractErrorCode =
  | "VERSION_MISMATCH"
  | "UNKNOWN_FIELD"
  | "INVALID_CONTRACT";

/** Structured validation failure of a Phase 4 contract document. */
export class Phase4ContractError extends Error {
  readonly code: Phase4ContractErrorCode;

  constructor(code: Phase4ContractErrorCode, message: string) {
    super(message);
    this.name = "Phase4ContractError";
    this.code = code;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Rejects any key outside `allowed` so future/unknown fields are never trusted.
 * `label` names the object in the error message.
 */
export function assertNoUnknownKeys(
  payload: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(payload).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Phase4ContractError(
      "UNKNOWN_FIELD",
      `${label} contains unknown field(s): ${unknown.join(", ")}`
    );
  }
}

/** Requires a non-empty string at `key` of `payload`; `label` names the object. */
export function assertNonEmptyString(
  payload: Record<string, unknown>,
  key: string,
  label: string
): string {
  if (!isNonEmptyString(payload[key])) {
    throw new Phase4ContractError("INVALID_CONTRACT", `${label}.${key} must be a non-empty string`);
  }
  return payload[key];
}

/**
 * Accepts an optional field only when it is a non-empty string. Returns the
 * validated value (`undefined` when absent) so callers can narrow it.
 */
export function assertOptionalNonEmptyString(
  payload: Record<string, unknown>,
  key: string,
  label: string
): string | undefined {
  if (payload[key] !== undefined && !isNonEmptyString(payload[key])) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      `${label}.${key} must be a non-empty string when present`
    );
  }
  return payload[key] === undefined ? undefined : payload[key];
}

/** Requires a non-empty string array at `key` of `payload`. */
export function assertNonEmptyStringArray(
  payload: Record<string, unknown>,
  key: string,
  label: string
): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      `${label}.${key} must be a non-empty array`
    );
  }
  const result: string[] = [];
  for (const item of value) {
    if (!isNonEmptyString(item)) {
      throw new Phase4ContractError(
        "INVALID_CONTRACT",
        `${label}.${key} items must be non-empty strings`
      );
    }
    result.push(item);
  }
  return result;
}

/** Requires an ISO-8601 timestamp string at `key` of `payload`. */
export function assertIsoTimestamp(
  payload: Record<string, unknown>,
  key: string,
  label: string
): string {
  if (!isIsoTimestamp(payload[key])) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      `${label}.${key} must be a valid ISO timestamp`
    );
  }
  return payload[key];
}
