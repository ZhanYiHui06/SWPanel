/**
 * Structured, serialization-friendly error surface of the Runner application
 * layer. Codes are stable identifiers the UI (through the future IPC boundary)
 * can map to user-visible messages; they are not free-form prose.
 */

export type RunnerErrorCode =
  | "RUNNER_NOT_OPEN"
  | "NOT_FOUND"
  | "ENTITY_CONFLICT"
  | "INVALID_ARGUMENT"
  | "DOMAIN_INVARIANT"
  | "LEDGER_NOT_OPEN"
  | "LEDGER_FILE_MISSING"
  | "LEDGER_HASH_MISMATCH"
  | "LEDGER_SIZE_MISMATCH"
  | "LEDGER_PATH_UNSAFE"
  | "LEDGER_ESCAPE_DETECTED"
  | "LEDGER_COPY_FAILED"
  | "LEDGER_IO"
  | "STORAGE_INVALID"
  | "SOURCE_FILE_NOT_REGISTERED"
  | "UNSUPPORTED_PHASE_OPERATION";

export interface RunnerErrorFields {
  /** Stable machine-readable error code. */
  code: RunnerErrorCode;
  /** Human-readable description suitable for the UI. */
  message: string;
  /** Optional structured context (affected ids / paths), never user input. */
  details?: Readonly<Record<string, unknown>>;
  /** Underlying cause, when available. */
  cause?: unknown;
}

/** Base structured error for every Runner application-layer failure. */
export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(fields: RunnerErrorFields) {
    super(fields.message, fields.cause === undefined ? undefined : { cause: fields.cause });
    this.name = "RunnerError";
    this.code = fields.code;
    this.details = fields.details;
  }
}

function withDetails(
  code: RunnerErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>
): RunnerErrorFields {
  return details === undefined ? { code, message } : { code, message, details };
}

/** No entity (Drawing, Revision, ...) matches the requested identifier. */
export class NotFoundError extends RunnerError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(withDetails("NOT_FOUND", message, details));
    this.name = "NotFoundError";
  }
}

/** A uniqueness constraint was violated (e.g. duplicate Drawing number). */
export class EntityConflictError extends RunnerError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(withDetails("ENTITY_CONFLICT", message, details));
    this.name = "EntityConflictError";
  }
}

/** A domain invariant from `@swpanel/domain` rejected the transition. */
export class RunnerInvariantError extends RunnerError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(withDetails("DOMAIN_INVARIANT", message, details));
    this.name = "RunnerInvariantError";
  }
}

/** Invalid caller-supplied argument (bad format, bad id token, ...). */
export class InvalidArgumentError extends RunnerError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(withDetails("INVALID_ARGUMENT", message, details));
    this.name = "InvalidArgumentError";
  }
}

/** Storage settings are structurally invalid or violate the ADR-002 constraint. */
export class InvalidStorageSettingsError extends RunnerError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(withDetails("STORAGE_INVALID", message, details));
    this.name = "InvalidStorageSettingsError";
  }
}

/**
 * Persistence path that belongs to a later phase (Run/Model/Review/Cost
 * aggregates). The table schema exists structurally, but the Runner does not
 * yet write these entities and refuses to fake them.
 */
export class UnsupportedPhaseOperationError extends RunnerError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(withDetails("UNSUPPORTED_PHASE_OPERATION", message, details));
    this.name = "UnsupportedPhaseOperationError";
  }
}

/**
 * The Drawing file referenced by a `drawing.create` / `drawing.createRevision`
 * IPC command was not registered with the Runner host. The wire contract never
 * carries absolute paths; the Electron Main host must register the user-picked
 * file (by sha256) before dispatching the command.
 */
export class SourceFileNotRegisteredError extends RunnerError {
  constructor(sha256: string, details?: Readonly<Record<string, unknown>>) {
    super(
      withDetails(
        "SOURCE_FILE_NOT_REGISTERED",
        `No source file is registered for sha256 ${sha256}; the host must register the user-picked file before dispatching the command`,
        { sha256, ...(details === undefined ? {} : details) }
      )
    );
    this.name = "SourceFileNotRegisteredError";
  }
}

/** Base structured error of the immutable source-file ledger. */
export class LedgerError extends RunnerError {
  constructor(fields: RunnerErrorFields) {
    super(fields);
    this.name = "LedgerError";
  }
}

/** The requested ledger file does not exist on disk. Never silently ignored. */
export class LedgerFileMissingError extends LedgerError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(withDetails("LEDGER_FILE_MISSING", message, details));
    this.name = "LedgerFileMissingError";
  }
}

/** The declared SHA-256 does not match the bytes on disk. */
export class LedgerHashMismatchError extends LedgerError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(withDetails("LEDGER_HASH_MISMATCH", message, details));
    this.name = "LedgerHashMismatchError";
  }
}

/** The declared byte size does not match the bytes on disk. */
export class LedgerSizeMismatchError extends LedgerError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(withDetails("LEDGER_SIZE_MISMATCH", message, details));
    this.name = "LedgerSizeMismatchError";
  }
}

/** The relative path is not a safe ledger-relative path (traversal, drive, ...). */
export class LedgerPathUnsafeError extends LedgerError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(withDetails("LEDGER_PATH_UNSAFE", message, details));
    this.name = "LedgerPathUnsafeError";
  }
}

/** A symlink/junction component resolves outside the canonical ledger root. */
export class LedgerEscapeDetectedError extends LedgerError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(withDetails("LEDGER_ESCAPE_DETECTED", message, details));
    this.name = "LedgerEscapeDetectedError";
  }
}

/** Copying bytes into the ledger failed (I/O, quota, lock, ...). */
export class LedgerCopyFailedError extends LedgerError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(withDetails("LEDGER_COPY_FAILED", message, details));
    this.name = "LedgerCopyFailedError";
  }
}
