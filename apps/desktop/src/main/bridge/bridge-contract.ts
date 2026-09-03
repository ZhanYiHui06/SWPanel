/**
 * WP5 Main <-> Preload bridge contract.
 *
 * Single source of truth for the Electron IPC channel allowlist, the
 * renderer-visible bridge API surface, the strict main-side payload validators
 * and the serializable bridge error envelope. The Main process imports this
 * module directly (NodeNext ESM); the sandboxed Preload bundles it through
 * esbuild so both sides share the exact channel strings and types. The module
 * never imports `electron` and never touches the filesystem, so it is pure and
 * testable on both sides.
 *
 * Security posture (WP5):
 * - the Renderer may only reach EXACTLY the channels declared in
 *   {@link MAIN_CHANNELS}; there is no generic `invoke(channel, ...)`,
 *   `readFile(path)`, `spawn` or raw pipe endpoint;
 * - every `ipcMain` payload is re-validated here before it is translated into a
 *   Runner query/command — the Preload type system is never trusted;
 * - errors are converted to a serializable {@link BridgeError} whose message is
 *   path-redacted; stack traces and absolute source paths never reach the
 *   Renderer.
 */

import type {
  ClarificationView,
  CostReportDetailView,
  DrawingDetailView,
  DrawingHistoryView,
  DrawingListItemView,
  ModelDetailView,
  RevisionDetailView,
  RevisionHistoryView,
  RunDetailView,
  RunListItemView,
  StorageSettingsView
} from "@swpanel/contracts";
import {
  REVISION_FACT_SOURCES,
  STORAGE_CONSTRAINTS,
  type ClarificationAnswer,
  type CostDataSnapshot,
  type CostEstimateInputSnapshot,
  type Drawing,
  type DrawingFileFormat,
  type DrawingRevision,
  type ModelingFeedback,
  type ModelingRun,
  type RecoveryStatusSummary,
  type RevisionFact,
  type RevisionSourceFile,
  type RunEvent,
  type StorageSettings
} from "@swpanel/domain";

// ---------------------------------------------------------------------------
// IPC channel allowlist
// ---------------------------------------------------------------------------

/**
 * The exact `ipcMain.handle` channels the Main process registers. The Renderer
 * may invoke ONLY these channels (through the Preload), and the Main process
 * must not register any other channel. This object is frozen so neither the
 * Main nor the bundled Preload can extend it at runtime.
 *
 * `runEvents` is the ONLY Main -> Renderer push channel: validated Run event
 * batches (and stream failures) travel from Main to the Renderer over it after
 * a `runSubscribe`. No other unsolicited data ever reaches the Renderer.
 */
export const MAIN_CHANNELS = Object.freeze({
  health: "swpanel:health",
  selectDrawingFile: "swpanel:files:selectDrawingFile",
  drawingList: "swpanel:drawings:list",
  drawingHistory: "swpanel:drawings:history",
  drawingDetail: "swpanel:drawings:detail",
  revisionHistory: "swpanel:revisions:history",
  revisionDetail: "swpanel:revisions:detail",
  storageGetSettings: "swpanel:storage:getSettings",
  importDrawing: "swpanel:drawings:import",
  addRevision: "swpanel:drawings:addRevision",
  setCurrentRevision: "swpanel:drawings:setCurrentRevision",
  deleteRevision: "swpanel:drawings:deleteRevision",
  addRevisionFact: "swpanel:revisions:addFact",
  addModelingFeedback: "swpanel:revisions:addModelingFeedback",
  updateStorageSettings: "swpanel:storage:updateSettings",
  runList: "swpanel:runs:list",
  runDetail: "swpanel:runs:detail",
  runCreate: "swpanel:runs:create",
  runCancel: "swpanel:runs:cancel",
  runSubscribe: "swpanel:runs:subscribe",
  runUnsubscribe: "swpanel:runs:unsubscribe",
  runEvents: "swpanel:runs:events",
  clarificationGet: "swpanel:clarifications:get",
  clarificationSubmit: "swpanel:clarifications:submit",
  modelDetail: "swpanel:models:detail",
  modelReview: "swpanel:models:review",
  costDataGet: "swpanel:costData:get",
  costDataUpdate: "swpanel:costData:update",
  costReportDetail: "swpanel:costReports:detail",
  costReportCreate: "swpanel:costReports:create",
  runDelete: "swpanel:runs:delete",
  costReportDelete: "swpanel:costReports:delete",
  recoveryStatus: "swpanel:system:recoveryStatus",
  secretsGetStatus: "swpanel:secrets:getStatus",
  secretsSetApiKey: "swpanel:secrets:setApiKey",
  secretsClearApiKey: "swpanel:secrets:clearApiKey"
} as const);

export type MainChannel = (typeof MAIN_CHANNELS)[keyof typeof MAIN_CHANNELS];

/** All distinct channel strings of the frozen allowlist (handle + push). */
export const ALL_MAIN_CHANNELS: readonly MainChannel[] = Object.freeze(
  Object.values(MAIN_CHANNELS)
);

/**
 * The exact channels Main registers via `ipcMain.handle` (Renderer -> Main
 * request/response). Every channel of {@link MAIN_CHANNELS} except the
 * `runEvents` PUSH channel (Main -> Renderer only, used with
 * `webContents.send`, never handled) is handled.
 */
export const MAIN_HANDLE_CHANNELS: readonly MainChannel[] = Object.freeze(
  ALL_MAIN_CHANNELS.filter((channel) => channel !== MAIN_CHANNELS.runEvents)
);

// ---------------------------------------------------------------------------
// Runner health state (exposed over the health channel)
// ---------------------------------------------------------------------------

export type RunnerHealthStatus = "STARTING" | "READY" | "FAILED" | "CLOSED";

export interface RunnerHealthState {
  readonly status: RunnerHealthStatus;
  /** Runner pipe server instance id the Main client is bound to (READY only). */
  readonly serverInstanceId: string | null;
  /** Sanitized failure detail; present only when `status === "FAILED"`. */
  readonly error: { readonly code: string; readonly message: string } | null;
}

// ---------------------------------------------------------------------------
// Selected drawing file token (opaque, renderer-visible metadata only)
// ---------------------------------------------------------------------------

/** Prefix of every one-use selected-file token minted by Main. */
export const SELECTED_FILE_TOKEN_PREFIX = "swsel_" as const;

/** Exact token shape: `swsel_` followed by 32 lowercase hex chars. */
export const SELECTED_FILE_TOKEN_PATTERN = /^swsel_[0-9a-f]{32}$/;

/**
 * Opaque handle to a user-picked drawing file. The Renderer receives ONLY
 * metadata (token + display name + format + size + sha256); the absolute
 * source path never crosses the bridge.
 */
export interface SelectedDrawingFile {
  readonly token: string;
  readonly fileName: string;
  readonly format: DrawingFileFormat;
  readonly sizeBytes: number;
  readonly sha256: string;
}

// ---------------------------------------------------------------------------
// Client intent id (opaque per-form-submission id for fact/feedback mutations)
// ---------------------------------------------------------------------------

/** Prefix of every client-minted intent id sent with fact/feedback mutations. */
export const CLIENT_INTENT_ID_PREFIX = "swint_" as const;

/**
 * Exact intent id shape: `swint_` followed by 32 lowercase hex chars. Main
 * re-validates this exact pattern so a renderer can never smuggle arbitrary or
 * unbounded strings into the idempotency key.
 */
export const CLIENT_INTENT_ID_PATTERN = /^swint_[0-9a-f]{32}$/;

// ---------------------------------------------------------------------------
// Bridge result / error envelope
// ---------------------------------------------------------------------------

/**
 * Stable bridge error codes. A `code` may also be a Runner error code echoed
 * from the Runner response envelope (NOT_FOUND, ENTITY_CONFLICT, ...), so the
 * Renderer can map business failures without parsing prose.
 */
export type BridgeErrorCode =
  | "INVALID_PAYLOAD"
  | "SELECTION_CANCELED"
  | "SELECTION_INVALID"
  | "FILE_PATH_UNSAFE"
  | "FILE_UNSUPPORTED_FORMAT"
  | "FILE_NOT_REGULAR"
  | "FILE_SYMLINK"
  | "FILE_TOO_LARGE"
  | "FILE_UNREADABLE"
  | "TOKEN_NOT_FOUND"
  | "TOKEN_EXPIRED"
  | "TOKEN_IN_USE"
  | "RUNNER_NOT_READY"
  | "RUNNER_UNAVAILABLE"
  | "RUNNER_ERROR"
  | "INTERNAL";

/** Serializable, path-redacted error returned over the bridge. */
export interface BridgeError {
  readonly code: string;
  readonly message: string;
}

/** Discriminated result envelope every bridge method resolves with. */
export type BridgeResult<T> = { readonly ok: true; readonly data: T } | {
  readonly ok: false;
  readonly error: BridgeError;
};

export function bridgeOk<T>(data: T): BridgeResult<T> {
  return { ok: true, data };
}

export function bridgeErr(code: string, message: string): BridgeResult<never> {
  return { ok: false, error: { code, message } };
}

/**
 * Removes absolute Windows/UNC path-looking tokens from a message so Runner
 * diagnostics can never leak the user's filesystem layout to the Renderer.
 */
export function redactPaths(message: string): string {
  return message.replace(/(?:[A-Za-z]:[\\/][^\s"']*|\\\\[^\s"']+)/g, "[path redacted]");
}

// ---------------------------------------------------------------------------
// Renderer-visible input types (also enforced by the main-side validators)
// ---------------------------------------------------------------------------

export interface SelectDrawingFileResult {
  readonly canceled: boolean;
  readonly file: SelectedDrawingFile | null;
}

export interface ImportDrawingBridgeInput {
  readonly drawingNumber: string;
  readonly name: string;
  /** One-use token returned by `files.selectDrawingFile`. */
  readonly selectedFileToken: string;
  readonly createdAt: string;
  readonly createdBy?: string;
}

export interface AddRevisionBridgeInput {
  readonly drawingId: string;
  readonly selectedFileToken: string;
  readonly createdAt: string;
}

export interface SetCurrentRevisionBridgeInput {
  readonly drawingId: string;
  readonly revisionId: string;
  readonly updatedAt: string;
}

export interface DeleteRevisionBridgeInput {
  readonly drawingId: string;
  readonly revisionId: string;
  readonly updatedAt: string;
}

export interface AddRevisionFactBridgeInput {
  readonly drawingId: string;
  readonly revisionId: string;
  readonly field: string;
  readonly value: string;
  readonly unit?: string;
  readonly source: RevisionFact["source"];
  readonly sourceRunId?: string;
  readonly createdAt: string;
  readonly createdBy?: string;
  /**
   * Opaque intent id minted by the Renderer once per form submission and reused
   * ONLY for retries of the identical submission. Main converts it into the
   * Runner idempotency key (never forwarded on the wire) so a deliberate second
   * submission of identical content still counts as a separate intent.
   */
  readonly clientIntentId: string;
}

export interface AddModelingFeedbackBridgeInput {
  readonly drawingId: string;
  readonly revisionId: string;
  readonly content: string;
  readonly createdAt: string;
  /** See {@link AddRevisionFactBridgeInput.clientIntentId}. */
  readonly clientIntentId: string;
}

export interface UpdateStorageSettingsBridgeInput {
  readonly settings: StorageSettings;
}

// ---------------------------------------------------------------------------
// Run / Clarification bridge inputs (Phase 3, P3-4)
// ---------------------------------------------------------------------------

/**
 * `run.create` bridge input. The Renderer submits ONLY the drawing/revision
 * identity pair: the Runner owns snapshot freezing (an Input Snapshot field in
 * the payload is rejected by the validator as unknown).
 */
export interface RunCreateBridgeInput {
  readonly drawingId: string;
  readonly revisionId: string;
}

export interface RunCancelBridgeInput {
  readonly runId: string;
  readonly reason?: string;
}

/**
 * Subscribe input of one Run event stream. `fromSequence` is the first event
 * sequence the Renderer has not yet seen (0 = whole history); Main validates
 * it and hands it to the Runner client, which delivers the persisted backlog
 * and then live batches over the `runEvents` push channel.
 */
export interface RunSubscribeBridgeInput {
  readonly runId: string;
  readonly fromSequence: number;
}

export interface RunUnsubscribeBridgeInput {
  readonly runId: string;
}

/**
 * Submit input of one OPEN Clarification Request. Answer ids travel over the
 * bridge but are NEVER trusted by the Runner as primary keys (the repository
 * mints its own ids); the referenced Run stays terminal CLARIFICATION_REQUIRED
 * and is never resumed.
 */
export interface ClarificationSubmitBridgeInput {
  readonly clarificationRequestId: string;
  readonly answers: readonly ClarificationAnswer[];
  readonly answeredAt: string;
  readonly answeredBy: string;
}

/**
 * `model.review` bridge input (Phase 6). `comment` is REQUIRED when the model is
 * REJECTED (the Runner writes it into the Revision's Modeling Feedback) and
 * when present must be a non-empty string. The Renderer may NEVER name the
 * resulting Review id: the Runner mints its own.
 */
export interface ReviewModelBridgeInput {
  readonly modelId: string;
  readonly result: "APPROVED" | "REJECTED";
  readonly comment?: string;
  readonly reviewerId: string;
  readonly reviewedAt: string;
}

// ---------------------------------------------------------------------------
// Renderer-visible result types (structural; no path fields)
// ---------------------------------------------------------------------------

export interface ImportDrawingBridgeResult {
  readonly drawing: Drawing;
  readonly revision: DrawingRevision;
  readonly sourceFile: RevisionSourceFile;
}

export interface AddRevisionBridgeResult {
  readonly revision: DrawingRevision;
  readonly sourceFile: RevisionSourceFile;
}

export interface DeleteRevisionBridgeResult {
  readonly drawing: Drawing;
  readonly deletedRevisionId: string;
}

export type DrawingListBridgeResult = readonly DrawingListItemView[];
export type DrawingHistoryBridgeResult = DrawingHistoryView;
export type DrawingDetailBridgeResult = DrawingDetailView;
export type RevisionHistoryBridgeResult = RevisionHistoryView;
export type RevisionDetailBridgeResult = RevisionDetailView;
export type StorageSettingsBridgeResult = StorageSettingsView;
export type SetCurrentRevisionBridgeResult = Drawing;
export type AddRevisionFactBridgeResult = RevisionFact;
export type AddModelingFeedbackBridgeResult = ModelingFeedback;

export type RunListBridgeResult = readonly RunListItemView[];
export type RunDetailBridgeResult = RunDetailView;
export type RunCreateBridgeResult = ModelingRun;

/** Structured cancel outcome echoed from the Runner's cancel coordinator. */
export type RunCancelBridgeResult =
  | { readonly runId: string; readonly status: "CANCELLED"; readonly alreadyCancelled: boolean }
  | {
      readonly runId: string;
      readonly status: "FAILED";
      readonly failureCode: "CANCEL_CLEANUP_PENDING";
    }
  | {
      readonly runId: string;
      readonly status: "CANCEL_PENDING";
      readonly detail: "FOREIGN_LIVE_LEASE";
      readonly leaseDeadlineAt: string | null;
    }
  | {
      readonly runId: string;
      readonly status: "ALREADY_TERMINAL";
      readonly finalStatus: "COMPLETED" | "CLARIFICATION_REQUIRED" | "FAILED";
    };

export type ClarificationBridgeResult = ClarificationView;
export type ClarificationSubmitBridgeResult = ClarificationView;

/** Aggregated Model detail view (Phase 6): model facts, artifacts, reviews. */
export type ModelDetailBridgeResult = ModelDetailView;

/** The refreshed Model detail after a review command was applied. */
export type ReviewModelBridgeResult = ModelDetailView;

/** Cost Data Snapshot result (Phase 7). */
export type CostDataBridgeResult = CostDataSnapshot;

/** Cost Estimate Report detail view (Phase 7). */
export type CostReportDetailBridgeResult = CostReportDetailView;

export interface CostReportCreateBridgeInput {
  readonly input: CostEstimateInputSnapshot;
  readonly createdAt: string;
}

export type CostReportCreateBridgeResult = CostReportDetailView;

// ---------------------------------------------------------------------------
// Delete / system / secrets bridge surface (Step 3, Phase 8)
// ---------------------------------------------------------------------------

/**
 * `run.delete` bridge input. The Renderer names the Run PLUS its owning
 * drawing/revision identity pair so the Runner can guard and scope the
 * deletion; Main re-validates all three as strict identifiers.
 */
export interface RunDeleteBridgeInput {
  readonly runId: string;
  readonly drawingId: string;
  readonly revisionId: string;
}

/** `costReport.delete` bridge input (report + owning revision pair). */
export interface CostReportDeleteBridgeInput {
  readonly costReportId: string;
  readonly revisionId: string;
}

/** Outcome of one terminal Run deletion echoed from the Runner. */
export interface RunDeleteBridgeResult {
  readonly runId: string;
  /** Every attempt sequence ever recorded for the Run (workspace cleanup scope). */
  readonly attemptSequences: readonly number[];
}

/** Outcome of one Cost Report deletion. */
export interface CostReportDeleteBridgeResult {
  readonly costReportId: string;
}

/** Summary of the latest startup recovery scan (null when none has run yet). */
export type RecoveryStatusBridgeResult = RecoveryStatusSummary | null;

/**
 * Secrets status exposed over the bridge: presence + masked preview ONLY. The
 * plaintext API key never leaves the Main process.
 */
export interface SecretsStatusBridgeResult {
  readonly hasApiKey: boolean;
  /** Masked preview (e.g. `sk-****abcd`) when a key is stored, else null. */
  readonly maskedApiKey: string | null;
}

/** `secrets.setApiKey` bridge input: the Renderer must submit the key to store it. */
export interface SetApiKeyBridgeInput {
  readonly apiKey: string;
}

/**
 * Main -> Renderer push received on the `runEvents` channel after a
 * subscription. `runEvents` batches are ALREADY validated, deduplicated and
 * gap-checked by the Main-side Runner client: the Renderer applies them
 * directly. `runEventsError` carries the structured stream failure (gap /
 * invalid / connection lost / closed); the Renderer must re-read the snapshot
 * and resubscribe.
 */
export type RunEventsBridgePush =
  | {
      readonly kind: "runEvents";
      readonly runId: string;
      readonly fromSequence: number;
      readonly events: readonly RunEvent[];
    }
  | {
      readonly kind: "runEventsError";
      readonly runId: string;
      readonly error: { readonly code: string; readonly message: string };
    };

/**
 * The full renderer-visible bridge API. This is the exact surface the Preload
 * exposes under `window.swpanel` and the contract tests pin. Every method is
 * Promise-based and resolves a typed `BridgeResult<T>` discriminated union.
 */
export interface SwpanelBridgeApi {
  readonly metadata: Readonly<{
    readonly platform: string;
    readonly versions: Readonly<{ chrome: string; electron: string }>;
  }>;
  readonly health: Readonly<{
    get(): Promise<BridgeResult<RunnerHealthState>>;
  }>;
  readonly files: Readonly<{
    selectDrawingFile(): Promise<BridgeResult<SelectDrawingFileResult>>;
  }>;
  readonly drawings: Readonly<{
    list(): Promise<BridgeResult<DrawingListBridgeResult>>;
    getHistory(drawingId: string): Promise<BridgeResult<DrawingHistoryBridgeResult>>;
    getDetail(drawingId: string): Promise<BridgeResult<DrawingDetailBridgeResult>>;
    getRevisionHistory(
      drawingId: string,
      revisionId: string
    ): Promise<BridgeResult<RevisionHistoryBridgeResult>>;
    getRevisionDetail(
      drawingId: string,
      revisionId: string
    ): Promise<BridgeResult<RevisionDetailBridgeResult>>;
    importDrawing(
      input: ImportDrawingBridgeInput
    ): Promise<BridgeResult<ImportDrawingBridgeResult>>;
    addRevision(input: AddRevisionBridgeInput): Promise<BridgeResult<AddRevisionBridgeResult>>;
    setCurrentRevision(
      input: SetCurrentRevisionBridgeInput
    ): Promise<BridgeResult<SetCurrentRevisionBridgeResult>>;
    deleteRevision(
      input: DeleteRevisionBridgeInput
    ): Promise<BridgeResult<DeleteRevisionBridgeResult>>;
    addRevisionFact(
      input: AddRevisionFactBridgeInput
    ): Promise<BridgeResult<AddRevisionFactBridgeResult>>;
    addModelingFeedback(
      input: AddModelingFeedbackBridgeInput
    ): Promise<BridgeResult<AddModelingFeedbackBridgeResult>>;
  }>;
  readonly storage: Readonly<{
    getSettings(): Promise<BridgeResult<StorageSettingsBridgeResult>>;
    updateSettings(
      input: UpdateStorageSettingsBridgeInput
    ): Promise<BridgeResult<StorageSettingsBridgeResult>>;
  }>;
  /**
   * Run management surface (Phase 3, P3-4). `subscribe` registers a live Run
   * event stream: Main validates the input, subscribes the Runner client and
   * forwards validated batches (and stream failures) to `onPush` over the
   * frozen `runEvents` push channel. The returned function unsubscribes.
   * A subscription Main REFUSES (validation failure, Runner not ready, ...)
   * surfaces deterministically to `onPush` as a `runEventsError` push and the
   * listener is detached — the renderer never waits forever on a refused
   * subscription.
   */
  readonly runs: Readonly<{
    list(): Promise<BridgeResult<RunListBridgeResult>>;
    getDetail(runId: string): Promise<BridgeResult<RunDetailBridgeResult>>;
    create(input: RunCreateBridgeInput): Promise<BridgeResult<RunCreateBridgeResult>>;
    cancel(input: RunCancelBridgeInput): Promise<BridgeResult<RunCancelBridgeResult>>;
    delete(input: RunDeleteBridgeInput): Promise<BridgeResult<RunDeleteBridgeResult>>;
    subscribe(
      input: RunSubscribeBridgeInput,
      onPush: (push: RunEventsBridgePush) => void
    ): () => void;
  }>;
  /**
   * Clarification surface (Phase 3, P3-4). Submitting answers persists them on
   * the OLD (terminal CLARIFICATION_REQUIRED) Run's request; the Run is never
   * resumed.
   */
  readonly clarifications: Readonly<{
    get(clarificationRequestId: string): Promise<BridgeResult<ClarificationBridgeResult>>;
    submit(
      input: ClarificationSubmitBridgeInput
    ): Promise<BridgeResult<ClarificationSubmitBridgeResult>>;
  }>;
  /**
   * Model Review surface (Phase 6). `getDetail` resolves the aggregated Model
   * detail (model facts, artifacts, review records); `review` applies the
   * APPROVE / REJECT decision for a PENDING_REVIEW model and resolves the
   * refreshed detail. A REJECTED model never resumes business flow — fixing it
   * requires a new Modeling Run, not an in-place edit.
   */
  readonly models: Readonly<{
    getDetail(modelId: string): Promise<BridgeResult<ModelDetailBridgeResult>>;
    review(input: ReviewModelBridgeInput): Promise<BridgeResult<ReviewModelBridgeResult>>;
  }>;
  /**
   * Cost Data and Estimation surface (Phase 7).
   */
  readonly cost: Readonly<{
    getEffectiveCostData(): Promise<BridgeResult<CostDataBridgeResult>>;
    updateCostData(snapshot: CostDataSnapshot): Promise<BridgeResult<CostDataBridgeResult>>;
    getReportDetail(costReportId: string): Promise<BridgeResult<CostReportDetailBridgeResult>>;
    createReport(input: CostReportCreateBridgeInput): Promise<BridgeResult<CostReportCreateBridgeResult>>;
    deleteReport(
      input: CostReportDeleteBridgeInput
    ): Promise<BridgeResult<CostReportDeleteBridgeResult>>;
  }>;
  /**
   * System surface (Step 3): reads the latest startup Run-recovery scan summary.
   */
  readonly system: Readonly<{
    getRecoveryStatus(): Promise<BridgeResult<RecoveryStatusBridgeResult>>;
  }>;
  /**
   * Secrets surface (Step 3): the company-global automation API key is stored
   * at rest by Main's SafeStorage-backed {@link SecretStore}. Only presence and
   * a masked preview ever cross the bridge; the plaintext stays Main-internal.
   */
  readonly secrets: Readonly<{
    getStatus(): Promise<BridgeResult<SecretsStatusBridgeResult>>;
    setApiKey(apiKey: string): Promise<BridgeResult<SecretsStatusBridgeResult>>;
    clearApiKey(): Promise<BridgeResult<SecretsStatusBridgeResult>>;
  }>;
}

// ---------------------------------------------------------------------------
// Strict main-side payload validators (never trust the Preload / type system)
// ---------------------------------------------------------------------------

/** Structured validation failure raised by the bridge validators. */
export class BridgeValidationError extends Error {
  readonly code = "INVALID_PAYLOAD" as const;

  constructor(message: string) {
    super(message);
    this.name = "BridgeValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength = 1024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/**
 * Strict identifier used by queries/commands: a single safe path token segment
 * matching the Runner's own `SAFE_PATH_TOKEN`, at most 128 chars.
 */
function assertStrictId(label: string, value: unknown): string {
  if (
    !isNonEmptyString(value, 128) ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(value)
  ) {
    throw new BridgeValidationError(`${label} must be a strict identifier`);
  }
  return value;
}

function assertIsoTimestamp(label: string, value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new BridgeValidationError(`${label} must be a valid ISO-8601 timestamp`);
  }
  return value;
}

/** Rejects any key outside `allowed` so future/unknown fields are never trusted. */
function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label = "payload"
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new BridgeValidationError(
      `${label} contains unknown field(s): ${unknown.join(", ")}`
    );
  }
}

export function validateEmptyPayload(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new BridgeValidationError("payload must be the empty object {}");
  }
}

export function validateDrawingId(value: unknown): string {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["drawingId"]);
  return assertStrictId("drawingId", value.drawingId);
}

export function validateRevisionIds(value: unknown): {
  drawingId: string;
  revisionId: string;
} {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["drawingId", "revisionId"]);
  return {
    drawingId: assertStrictId("drawingId", value.drawingId),
    revisionId: assertStrictId("revisionId", value.revisionId)
  };
}

export function validateSelectedFileToken(value: unknown): string {
  if (typeof value !== "string" || !SELECTED_FILE_TOKEN_PATTERN.test(value)) {
    throw new BridgeValidationError("selectedFileToken must be a valid one-use token");
  }
  return value;
}

export function validateClientIntentId(value: unknown): string {
  if (typeof value !== "string" || !CLIENT_INTENT_ID_PATTERN.test(value)) {
    throw new BridgeValidationError(
      "clientIntentId must be a valid opaque intent id (swint_ + 32 lowercase hex chars)"
    );
  }
  return value;
}

export function validateImportDrawing(value: unknown): ImportDrawingBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["drawingNumber", "name", "selectedFileToken", "createdAt", "createdBy"]);
  const drawingNumber = value.drawingNumber;
  const name = value.name;
  if (!isNonEmptyString(drawingNumber)) {
    throw new BridgeValidationError("drawingNumber must be a non-empty string");
  }
  if (!isNonEmptyString(name)) {
    throw new BridgeValidationError("name must be a non-empty string");
  }
  const createdAt = assertIsoTimestamp("createdAt", value.createdAt);
  const selectedFileToken = validateSelectedFileToken(value.selectedFileToken);
  if (value.createdBy !== undefined && !isNonEmptyString(value.createdBy)) {
    throw new BridgeValidationError("createdBy must be a non-empty string");
  }
  return {
    drawingNumber,
    name,
    selectedFileToken,
    createdAt,
    ...(value.createdBy === undefined ? {} : { createdBy: value.createdBy })
  };
}

export function validateAddRevision(value: unknown): AddRevisionBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["drawingId", "selectedFileToken", "createdAt"]);
  return {
    drawingId: assertStrictId("drawingId", value.drawingId),
    selectedFileToken: validateSelectedFileToken(value.selectedFileToken),
    createdAt: assertIsoTimestamp("createdAt", value.createdAt)
  };
}

export function validateSetCurrentRevision(value: unknown): SetCurrentRevisionBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["drawingId", "revisionId", "updatedAt"]);
  return {
    drawingId: assertStrictId("drawingId", value.drawingId),
    revisionId: assertStrictId("revisionId", value.revisionId),
    updatedAt: assertIsoTimestamp("updatedAt", value.updatedAt)
  };
}

export function validateDeleteRevision(value: unknown): DeleteRevisionBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["drawingId", "revisionId", "updatedAt"]);
  return {
    drawingId: assertStrictId("drawingId", value.drawingId),
    revisionId: assertStrictId("revisionId", value.revisionId),
    updatedAt: assertIsoTimestamp("updatedAt", value.updatedAt)
  };
}

export function validateAddRevisionFact(value: unknown): AddRevisionFactBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, [
    "drawingId",
    "revisionId",
    "field",
    "value",
    "unit",
    "source",
    "sourceRunId",
    "createdAt",
    "createdBy",
    "clientIntentId"
  ]);
  const field = value.field;
  const fieldValue = value.value;
  if (!isNonEmptyString(field, 256)) {
    throw new BridgeValidationError("field must be a non-empty string");
  }
  if (!isNonEmptyString(fieldValue, 2048)) {
    throw new BridgeValidationError("value must be a non-empty string");
  }
  const source = value.source;
  if (typeof source !== "string" || !REVISION_FACT_SOURCES.includes(source as RevisionFact["source"])) {
    throw new BridgeValidationError("source must be a revision-fact source");
  }
  if (value.unit !== undefined && !isNonEmptyString(value.unit, 128)) {
    throw new BridgeValidationError("unit must be a non-empty string");
  }
  const sourceRunId =
    value.sourceRunId === undefined ? undefined : assertStrictId("sourceRunId", value.sourceRunId);
  if (value.createdBy !== undefined && !isNonEmptyString(value.createdBy)) {
    throw new BridgeValidationError("createdBy must be a non-empty string");
  }
  // Required (fail closed): without a client intent id Main cannot tell a
  // retry from a deliberate duplicate submission of identical content.
  const clientIntentId = validateClientIntentId(value.clientIntentId);
  return {
    drawingId: assertStrictId("drawingId", value.drawingId),
    revisionId: assertStrictId("revisionId", value.revisionId),
    field,
    value: fieldValue,
    ...(value.unit === undefined ? {} : { unit: value.unit }),
    source: source as RevisionFact["source"],
    ...(sourceRunId === undefined ? {} : { sourceRunId }),
    createdAt: assertIsoTimestamp("createdAt", value.createdAt),
    ...(value.createdBy === undefined ? {} : { createdBy: value.createdBy }),
    clientIntentId
  };
}

export function validateAddModelingFeedback(value: unknown): AddModelingFeedbackBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["drawingId", "revisionId", "content", "createdAt", "clientIntentId"]);
  const content = value.content;
  if (!isNonEmptyString(content, 4096)) {
    throw new BridgeValidationError("content must be a non-empty string");
  }
  return {
    drawingId: assertStrictId("drawingId", value.drawingId),
    revisionId: assertStrictId("revisionId", value.revisionId),
    content,
    createdAt: assertIsoTimestamp("createdAt", value.createdAt),
    clientIntentId: validateClientIntentId(value.clientIntentId)
  };
}

export function validateUpdateStorageSettings(value: unknown): UpdateStorageSettingsBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["settings"]);
  const settings = value.settings;
  if (!isRecord(settings)) throw new BridgeValidationError("settings must be an object");
  assertNoUnknownKeys(settings, ["dataRoot", "workspaceRoot", "constraint", "updatedAt"]);
  const dataRoot = settings.dataRoot;
  const workspaceRoot = settings.workspaceRoot;
  const constraint = settings.constraint;
  if (!isNonEmptyString(dataRoot) || !isNonEmptyString(workspaceRoot)) {
    throw new BridgeValidationError("dataRoot and workspaceRoot must be non-empty strings");
  }
  if (constraint !== "LOCAL_FIXED_NTFS" || !STORAGE_CONSTRAINTS.includes(constraint)) {
    throw new BridgeValidationError("constraint must be LOCAL_FIXED_NTFS");
  }
  return {
    settings: {
      dataRoot,
      workspaceRoot,
      constraint,
      updatedAt: assertIsoTimestamp("updatedAt", settings.updatedAt)
    }
  };
}

// ---------------------------------------------------------------------------
// Run / Clarification bridge validators (Phase 3, P3-4)
// ---------------------------------------------------------------------------

export function validateRunDetailId(value: unknown): { runId: string } {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["runId"]);
  return { runId: assertStrictId("runId", value.runId) };
}

// ---------------------------------------------------------------------------
// Model bridge validators (Phase 6)
// ---------------------------------------------------------------------------

export function validateModelDetailId(value: unknown): string {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["modelId"]);
  return assertStrictId("modelId", value.modelId);
}

const MODEL_REVIEW_RESULTS = new Set(["APPROVED", "REJECTED"]);

/**
 * Strict canonical ISO-8601 check (mirrors the Runner's `model.review`
 * validation): the value must parse AND round-trip through `toISOString`, so a
 * renderer can never smuggle a non-canonical relative/legacy timestamp into the
 * idempotency-relevant `reviewedAt`.
 */
function assertCanonicalIsoTimestamp(label: string, value: unknown): string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new BridgeValidationError(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return value;
}

export function validateReviewModel(value: unknown): ReviewModelBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["modelId", "result", "comment", "reviewerId", "reviewedAt"]);
  const result = value.result;
  if (typeof result !== "string" || !MODEL_REVIEW_RESULTS.has(result)) {
    throw new BridgeValidationError("result must be one of APPROVED, REJECTED");
  }
  const reviewResult = result as "APPROVED" | "REJECTED";
  const modelId = assertStrictId("modelId", value.modelId);
  const reviewerId = value.reviewerId;
  if (!isNonEmptyString(reviewerId, 256)) {
    throw new BridgeValidationError("reviewerId must be a non-empty string");
  }
  const reviewedAt = assertCanonicalIsoTimestamp("reviewedAt", value.reviewedAt);
  const comment = value.comment;
  if (reviewResult === "REJECTED") {
    // A Rejected Review MUST carry a comment (the Runner writes it into the
    // Revision's Modeling Feedback).
    if (!isNonEmptyString(comment, 4096)) {
      throw new BridgeValidationError(
        "comment must be a non-empty string when the model is REJECTED"
      );
    }
    return { modelId, result: reviewResult, comment, reviewerId, reviewedAt };
  }
  if (comment !== undefined && !isNonEmptyString(comment, 4096)) {
    throw new BridgeValidationError("comment must be a non-empty string when present");
  }
  return {
    modelId,
    result: reviewResult,
    ...(comment === undefined ? {} : { comment }),
    reviewerId,
    reviewedAt
  };
}

export function validateRunCreate(value: unknown): RunCreateBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["drawingId", "revisionId"]);
  // The Renderer may name ONLY the drawing/revision pair; any attempt to
  // smuggle an Input Snapshot (or any other field) is rejected before dispatch.
  return {
    drawingId: assertStrictId("drawingId", value.drawingId),
    revisionId: assertStrictId("revisionId", value.revisionId)
  };
}

export function validateRunCancel(value: unknown): RunCancelBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["runId", "reason"]);
  const reason = value.reason;
  if (reason !== undefined && !isNonEmptyString(reason, 1024)) {
    throw new BridgeValidationError("reason must be a non-empty string");
  }
  return {
    runId: assertStrictId("runId", value.runId),
    ...(reason === undefined ? {} : { reason })
  };
}

export function validateRunSubscribe(value: unknown): RunSubscribeBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["runId", "fromSequence"]);
  const fromSequence = value.fromSequence;
  if (
    typeof fromSequence !== "number" ||
    !Number.isSafeInteger(fromSequence) ||
    fromSequence < 0
  ) {
    throw new BridgeValidationError("fromSequence must be a non-negative integer");
  }
  return { runId: assertStrictId("runId", value.runId), fromSequence };
}

export function validateRunUnsubscribe(value: unknown): RunUnsubscribeBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["runId"]);
  return { runId: assertStrictId("runId", value.runId) };
}

export function validateClarificationRequestId(value: unknown): { clarificationRequestId: string } {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["clarificationRequestId"]);
  return { clarificationRequestId: assertStrictId("clarificationRequestId", value.clarificationRequestId) };
}

const CLARIFICATION_ANSWER_KINDS = new Set(["dimension", "text", "choice"]);

/** Strictly validates ONE answer value of a clarification submit payload. */
function assertClarificationAnswerValue(value: unknown): void {
  if (!isRecord(value)) throw new BridgeValidationError("each answer value must be an object");
  const kind = value.kind;
  if (typeof kind !== "string" || !CLARIFICATION_ANSWER_KINDS.has(kind)) {
    throw new BridgeValidationError("answer value.kind must be one of dimension, text, choice");
  }
  switch (kind) {
    case "dimension":
      assertNoUnknownKeys(value, ["kind", "value", "unit"], "dimension answer value");
      if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
        throw new BridgeValidationError("dimension answer value.value must be a finite number");
      }
      if (!isNonEmptyString(value.unit, 64)) {
        throw new BridgeValidationError("dimension answer value.unit must be a non-empty string");
      }
      return;
    case "text":
      assertNoUnknownKeys(value, ["kind", "value"], "text answer value");
      if (!isNonEmptyString(value.value, 4096)) {
        throw new BridgeValidationError("text answer value.value must be a non-empty string");
      }
      return;
    case "choice":
      assertNoUnknownKeys(value, ["kind", "optionId"], "choice answer value");
      if (!isNonEmptyString(value.optionId, 128)) {
        throw new BridgeValidationError("choice answer value.optionId must be a non-empty string");
      }
      return;
  }
}

export function validateClarificationSubmit(value: unknown): ClarificationSubmitBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["clarificationRequestId", "answers", "answeredAt", "answeredBy"]);
  const answers = value.answers;
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new BridgeValidationError("answers must be a non-empty array");
  }
  const validatedAnswers: ClarificationAnswer[] = answers.map((answer) => {
    if (!isRecord(answer)) throw new BridgeValidationError("each answer must be an object");
    assertNoUnknownKeys(
      answer,
      ["id", "questionId", "value", "answeredAt", "answeredBy"],
      "clarification answer"
    );
    if (!isNonEmptyString(answer.id, 128)) {
      throw new BridgeValidationError("answer.id must be a non-empty string");
    }
    if (!isNonEmptyString(answer.questionId, 128)) {
      throw new BridgeValidationError("answer.questionId must be a non-empty string");
    }
    const answeredAt = assertIsoTimestamp("answer.answeredAt", answer.answeredAt);
    if (!isNonEmptyString(answer.answeredBy, 256)) {
      throw new BridgeValidationError("answer.answeredBy must be a non-empty string");
    }
    const value = answer.value;
    assertClarificationAnswerValue(value);
    return {
      id: answer.id,
      questionId: answer.questionId,
      value: value as ClarificationAnswer["value"],
      answeredAt,
      answeredBy: answer.answeredBy
    };
  });
  return {
    clarificationRequestId: assertStrictId("clarificationRequestId", value.clarificationRequestId),
    answers: validatedAnswers,
    answeredAt: assertIsoTimestamp("answeredAt", value.answeredAt),
    answeredBy: value.answeredBy as string
  };
}

export function validateCostReportId(value: unknown): { costReportId: string } {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["costReportId"]);
  return { costReportId: assertStrictId("costReportId", value.costReportId) };
}

export function validateCostDataUpdate(value: unknown): CostDataSnapshot {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["materials", "allowances", "fixedCosts", "customFields", "capturedAt"]);
  if (!Array.isArray(value.materials) || !Array.isArray(value.allowances) || !Array.isArray(value.fixedCosts) || !Array.isArray(value.customFields)) {
    throw new BridgeValidationError("materials, allowances, fixedCosts, customFields must be arrays");
  }
  return value as unknown as CostDataSnapshot;
}

export function validateCostReportCreate(value: unknown): CostReportCreateBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["input", "createdAt"]);
  const input = value.input;
  if (!isRecord(input)) throw new BridgeValidationError("input must be an object");
  const createdAt = assertIsoTimestamp("createdAt", value.createdAt);
  return {
    input: input as unknown as CostEstimateInputSnapshot,
    createdAt
  };
}

// ---------------------------------------------------------------------------
// Delete / system / secrets bridge validators (Step 3, Phase 8)
// ---------------------------------------------------------------------------

/**
 * Validates `run.delete`: the Run plus its owning drawing/revision identity
 * pair. All three are strict identifiers (unknown keys are rejected so the
 * Renderer can never smuggle extra fields into the guarded deletion).
 */
export function validateRunDelete(value: unknown): RunDeleteBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["runId", "drawingId", "revisionId"]);
  return {
    runId: assertStrictId("runId", value.runId),
    drawingId: assertStrictId("drawingId", value.drawingId),
    revisionId: assertStrictId("revisionId", value.revisionId)
  };
}

/** Validates `costReport.delete`: the report plus its owning revision pair. */
export function validateCostReportDelete(value: unknown): CostReportDeleteBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["costReportId", "revisionId"]);
  return {
    costReportId: assertStrictId("costReportId", value.costReportId),
    revisionId: assertStrictId("revisionId", value.revisionId)
  };
}

/** Maximum length of a stored API key (bounds the encrypted payload). */
export const API_KEY_MAX_LENGTH = 4096;

/**
 * Validates `secrets.setApiKey`: the key must be a non-empty string (after
 * trimming) and bounded. The validated key is stored at rest by Main and never
 * echoed back in any response.
 */
export function validateSetApiKey(value: unknown): SetApiKeyBridgeInput {
  if (!isRecord(value)) throw new BridgeValidationError("payload must be an object");
  assertNoUnknownKeys(value, ["apiKey"]);
  const apiKey = value.apiKey;
  if (
    typeof apiKey !== "string" ||
    apiKey.trim().length === 0 ||
    apiKey.length > API_KEY_MAX_LENGTH
  ) {
    throw new BridgeValidationError("apiKey must be a non-empty string");
  }
  return { apiKey };
}
