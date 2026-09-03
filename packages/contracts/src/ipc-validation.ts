import {
  COST_BASES,
  COST_CURRENCIES,
  MODEL_REVIEW_RESULTS,
  RUN_EVENT_CONTRACT_VERSION,
  RUN_EVENT_TYPES,
  STOCK_TYPES,
  type ModelReviewResult
} from "@swpanel/domain";
import type {
  Command,
  CommandName
} from "./commands.js";
import { COMMAND_NAMES } from "./commands.js";
import type {
  IpcEventEnvelope,
  IpcHandshakeEnvelope,
  IpcRequestEnvelope,
  IpcResponseEnvelope,
  QueryName,
  SubscribeName
} from "./ipc.js";
import { IPC_PROTOCOL_VERSION, QUERY_NAMES, SUBSCRIBE_NAMES } from "./ipc.js";

/**
 * Stable machine-readable codes returned by {@link validateIpcRequestEnvelope}
 * and friends. The same codes are echoed verbatim as
 * `IpcResponseEnvelope.error.code` by the Runner IPC server, so a UI can map
 * them to user-visible messages without parsing prose.
 */
export type IpcValidationErrorCode =
  | "INVALID_ENVELOPE"
  | "PROTOCOL_VERSION_MISMATCH"
  | "MISSING_REQUEST_ID"
  | "INVALID_CHANNEL"
  | "UNKNOWN_OPERATION"
  | "CHANNEL_OPERATION_MISMATCH"
  | "INVALID_PAYLOAD";

/** Structured validation failure of an IPC envelope. */
export class IpcValidationError extends Error {
  readonly code: IpcValidationErrorCode;

  constructor(code: IpcValidationErrorCode, message: string) {
    super(message);
    this.name = "IpcValidationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const QUERY_NAME_SET: ReadonlySet<string> = new Set(QUERY_NAMES);
const COMMAND_NAME_SET: ReadonlySet<string> = new Set(COMMAND_NAMES);
const SUBSCRIBE_NAME_SET: ReadonlySet<string> = new Set(SUBSCRIBE_NAMES);
const DRAWING_FILE_FORMATS: ReadonlySet<string> = new Set(["PDF", "DWG", "DXF"]);
const REVISION_FACT_SOURCES: ReadonlySet<string> = new Set([
  "USER_SUPPLEMENT",
  "DRAWING_CONFIRMED",
  "CLARIFICATION"
]);
const CLARIFICATION_ANSWER_KINDS: ReadonlySet<string> = new Set([
  "dimension",
  "text",
  "choice"
]);
const STOCK_TYPE_SET: ReadonlySet<string> = new Set(STOCK_TYPES);
const COST_CURRENCY_SET: ReadonlySet<string> = new Set(COST_CURRENCIES);
const COST_BASIS_SET: ReadonlySet<string> = new Set(COST_BASES);

/** Query operations whose payload is a set of non-empty string identifiers. */
const QUERY_STRING_ID_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "drawing.getDetail": ["drawingId"],
  "drawing.getHistory": ["drawingId"],
  "revision.getDetail": ["drawingId", "revisionId"],
  "revision.getHistory": ["drawingId", "revisionId"],
  "run.getDetail": ["runId"],
  "model.getDetail": ["modelId"],
  "clarification.get": ["clarificationRequestId"],
  "costReport.getDetail": ["costReportId"],
  "costReport.listByRevision": ["drawingId", "revisionId"]
};

/** Query operations whose payload must be the empty object `{}`. */
const QUERY_EMPTY_PAYLOAD_NAMES: ReadonlySet<string> = new Set([
  "run.list",
  "workspace.getDashboard",
  "costData.get",
  "storage.getSettings"
]);

function assertExactStringKeys(
  payload: Record<string, unknown>,
  expected: readonly string[]
): void {
  const actual = Object.keys(payload).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new IpcValidationError(
      "INVALID_PAYLOAD",
      `payload must have exactly the fields ${JSON.stringify(expected)}`
    );
  }
  for (const key of expected) {
    if (!isNonEmptyString(payload[key])) {
      throw new IpcValidationError("INVALID_PAYLOAD", `payload.${key} must be a non-empty string`);
    }
  }
}

/**
 * Rejects any key outside `allowed` so future/unknown fields are never trusted.
 * `label` names the object in the error message.
 */
function assertNoUnknownKeys(
  payload: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(payload).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new IpcValidationError(
      "INVALID_PAYLOAD",
      `${label} contains unknown field(s): ${unknown.join(", ")}`
    );
  }
}

/** Strictly validates ONE ClarificationAnswer of a `clarification.submit` payload. */
function assertClarificationAnswer(answer: unknown): void {
  if (!isRecord(answer)) {
    throw new IpcValidationError("INVALID_PAYLOAD", "each answer must be an object");
  }
  assertNoUnknownKeys(
    answer,
    ["id", "questionId", "value", "answeredAt", "answeredBy"],
    "clarification answer"
  );
  if (!isNonEmptyString(answer.id)) {
    throw new IpcValidationError("INVALID_PAYLOAD", "answer.id must be a non-empty string");
  }
  if (!isNonEmptyString(answer.questionId)) {
    throw new IpcValidationError("INVALID_PAYLOAD", "answer.questionId must be a non-empty string");
  }
  if (!isNonEmptyString(answer.answeredAt)) {
    throw new IpcValidationError("INVALID_PAYLOAD", "answer.answeredAt must be a non-empty string");
  }
  if (!isNonEmptyString(answer.answeredBy)) {
    throw new IpcValidationError("INVALID_PAYLOAD", "answer.answeredBy must be a non-empty string");
  }
  const value = answer.value;
  if (!isRecord(value)) {
    throw new IpcValidationError("INVALID_PAYLOAD", "answer.value must be an object");
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !CLARIFICATION_ANSWER_KINDS.has(kind)) {
    throw new IpcValidationError(
      "INVALID_PAYLOAD",
      "answer.value.kind must be one of dimension, text, choice"
    );
  }
  switch (kind) {
    case "dimension":
      assertNoUnknownKeys(value, ["kind", "value", "unit"], "dimension answer value");
      if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "dimension answer value.value must be a finite number"
        );
      }
      if (!isNonEmptyString(value.unit)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "dimension answer value.unit must be a non-empty string"
        );
      }
      return;
    case "text":
      assertNoUnknownKeys(value, ["kind", "value"], "text answer value");
      if (!isNonEmptyString(value.value)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "text answer value.value must be a non-empty string"
        );
      }
      return;
    case "choice":
      assertNoUnknownKeys(value, ["kind", "optionId"], "choice answer value");
      if (!isNonEmptyString(value.optionId)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "choice answer value.optionId must be a non-empty string"
        );
      }
      return;
  }
}

function assertSourceFile(file: unknown): void {
  if (!isRecord(file)) {
    throw new IpcValidationError("INVALID_PAYLOAD", "sourceFile must be an object");
  }
  assertNoUnknownKeys(file, ["fileName", "format", "sizeBytes", "sha256"], "sourceFile");
  if (!isNonEmptyString(file.fileName)) {
    throw new IpcValidationError("INVALID_PAYLOAD", "sourceFile.fileName must be a non-empty string");
  }
  if (typeof file.format !== "string" || !DRAWING_FILE_FORMATS.has(file.format)) {
    throw new IpcValidationError("INVALID_PAYLOAD", "sourceFile.format must be one of PDF, DWG, DXF");
  }
  if (typeof file.sizeBytes !== "number" || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) {
    throw new IpcValidationError("INVALID_PAYLOAD", "sourceFile.sizeBytes must be a positive integer");
  }
  if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
    throw new IpcValidationError("INVALID_PAYLOAD", "sourceFile.sha256 must be a 64-char hex digest");
  }
}

/**
 * Rejects anything that is not a canonical ISO-8601 UTC timestamp (exactly
 * `YYYY-MM-DDTHH:mm:ss.sssZ`). Offset timestamps and fuzzy dates are never
 * canonical and are rejected, mirroring the `model.review reviewedAt` rule.
 */
function assertCanonicalIsoTimestamp(value: unknown, label: string): void {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label} must be a canonical ISO timestamp`);
  }
}

/** Strictly validates ONE machining allowance dimension (`AllowanceValue`). */
function assertAllowanceValue(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label} must be an object`);
  }
  assertNoUnknownKeys(value, ["name", "valueMm"], label);
  if (!isNonEmptyString(value.name)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.name must be a non-empty string`);
  }
  if (typeof value.valueMm !== "number" || !Number.isFinite(value.valueMm) || value.valueMm < 0) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.valueMm must be a non-negative number`);
  }
}

/** Strictly validates ONE material cost entry of a Cost Data snapshot. */
function assertMaterialCostValue(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label} must be an object`);
  }
  assertNoUnknownKeys(
    value,
    ["id", "name", "purchasePrice", "priceUnit", "density", "densityUnit", "effectiveFrom", "updatedAt"],
    label
  );
  if (!isNonEmptyString(value.id)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.id must be a non-empty string`);
  }
  if (!isNonEmptyString(value.name)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.name must be a non-empty string`);
  }
  if (
    typeof value.purchasePrice !== "number" ||
    !Number.isFinite(value.purchasePrice) ||
    value.purchasePrice <= 0
  ) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.purchasePrice must be a positive number`);
  }
  if (!isNonEmptyString(value.priceUnit)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.priceUnit must be a non-empty string`);
  }
  // density is optional, but when present it must be positive.
  if (
    value.density !== undefined &&
    (typeof value.density !== "number" || !Number.isFinite(value.density) || value.density <= 0)
  ) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.density must be a positive number when present`);
  }
  if (value.densityUnit !== undefined && !isNonEmptyString(value.densityUnit)) {
    throw new IpcValidationError(
      "INVALID_PAYLOAD",
      `${label}.densityUnit must be a non-empty string when present`
    );
  }
  if (!isNonEmptyString(value.effectiveFrom)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.effectiveFrom must be a non-empty string`);
  }
  if (!isNonEmptyString(value.updatedAt)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.updatedAt must be a non-empty string`);
  }
}

/** Strictly validates ONE allowance definition (per-stock-type allowances). */
function assertAllowanceDefinition(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label} must be an object`);
  }
  assertNoUnknownKeys(value, ["id", "stockType", "allowances", "updatedAt"], label);
  if (!isNonEmptyString(value.id)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.id must be a non-empty string`);
  }
  if (typeof value.stockType !== "string" || !STOCK_TYPE_SET.has(value.stockType)) {
    throw new IpcValidationError(
      "INVALID_PAYLOAD",
      `${label}.stockType must be one of CYLINDER, RECTANGULAR_BAR`
    );
  }
  if (!isNonEmptyString(value.updatedAt)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.updatedAt must be a non-empty string`);
  }
  if (!Array.isArray(value.allowances)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.allowances must be an array`);
  }
  for (const allowance of value.allowances) {
    assertAllowanceValue(allowance, `${label}.allowances[]`);
  }
}

/** Strictly validates ONE fixed cost entry of a Cost Data snapshot. */
function assertFixedCostValue(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label} must be an object`);
  }
  assertNoUnknownKeys(
    value,
    ["id", "name", "amount", "currency", "basis", "defaultEnabled", "updatedAt"],
    label
  );
  if (!isNonEmptyString(value.id)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.id must be a non-empty string`);
  }
  if (!isNonEmptyString(value.name)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.name must be a non-empty string`);
  }
  if (typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount < 0) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.amount must be a non-negative number`);
  }
  if (typeof value.currency !== "string" || !COST_CURRENCY_SET.has(value.currency)) {
    throw new IpcValidationError(
      "INVALID_PAYLOAD",
      `${label}.currency must be one of ${COST_CURRENCIES.join(", ")}`
    );
  }
  if (typeof value.basis !== "string" || !COST_BASIS_SET.has(value.basis)) {
    throw new IpcValidationError(
      "INVALID_PAYLOAD",
      `${label}.basis must be one of PER_PIECE, PER_BATCH`
    );
  }
  if (typeof value.defaultEnabled !== "boolean") {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.defaultEnabled must be a boolean`);
  }
  if (!isNonEmptyString(value.updatedAt)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.updatedAt must be a non-empty string`);
  }
}

/** Strictly validates ONE display-only custom cost field. */
function assertCustomCostField(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label} must be an object`);
  }
  assertNoUnknownKeys(value, ["id", "key", "name", "value", "unit", "semantics", "updatedAt"], label);
  if (!isNonEmptyString(value.id)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.id must be a non-empty string`);
  }
  if (!isNonEmptyString(value.key)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.key must be a non-empty string`);
  }
  if (!isNonEmptyString(value.name)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.name must be a non-empty string`);
  }
  if (!isNonEmptyString(value.value)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.value must be a non-empty string`);
  }
  if (value.unit !== undefined && !isNonEmptyString(value.unit)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.unit must be a non-empty string when present`);
  }
  // Unknown-semantics fields are preserved for display only and never computed.
  if (value.semantics !== "DISPLAY_ONLY") {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.semantics must be DISPLAY_ONLY`);
  }
  if (!isNonEmptyString(value.updatedAt)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.updatedAt must be a non-empty string`);
  }
}

/**
 * Strictly validates a full Cost Data snapshot (enterprise cost basis data).
 * `withSnapshotUpdatedAt` toggles the snapshot-level `updatedAt` maintenance
 * instant: the effective snapshot written by `costData.update` carries it,
 * while the frozen `costData` of a `costReport.create` input uses the domain
 * `CostDataSnapshot` shape WITHOUT it (an extra key is rejected there).
 */
function assertCostDataSnapshot(
  value: unknown,
  label: string,
  withSnapshotUpdatedAt: boolean
): void {
  if (!isRecord(value)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label} must be an object`);
  }
  const allowed = [
    "materials",
    "allowances",
    "fixedCosts",
    "customFields",
    "capturedAt",
    ...(withSnapshotUpdatedAt ? ["updatedAt"] : [])
  ];
  assertNoUnknownKeys(value, allowed, label);
  assertCanonicalIsoTimestamp(value.capturedAt, `${label}.capturedAt`);
  if (withSnapshotUpdatedAt) {
    assertCanonicalIsoTimestamp(value.updatedAt, `${label}.updatedAt`);
  }
  if (!Array.isArray(value.materials)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.materials must be an array`);
  }
  for (const material of value.materials) {
    assertMaterialCostValue(material, `${label}.materials[]`);
  }
  if (!Array.isArray(value.allowances)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.allowances must be an array`);
  }
  for (const allowance of value.allowances) {
    assertAllowanceDefinition(allowance, `${label}.allowances[]`);
  }
  if (!Array.isArray(value.fixedCosts)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.fixedCosts must be an array`);
  }
  for (const fixedCost of value.fixedCosts) {
    assertFixedCostValue(fixedCost, `${label}.fixedCosts[]`);
  }
  if (!Array.isArray(value.customFields)) {
    throw new IpcValidationError("INVALID_PAYLOAD", `${label}.customFields must be an array`);
  }
  for (const customField of value.customFields) {
    assertCustomCostField(customField, `${label}.customFields[]`);
  }
}

/**
 * Validates the payload of a command against its discriminated-union shape.
 * The WP4-supported commands and the Phase 3 boundary commands (`run.create`,
 * `run.cancel`) are checked strictly; remaining later-phase commands are
 * checked for the discriminator only and are rejected by the Runner with
 * `UNSUPPORTED_PHASE_OPERATION` regardless of their payload details.
 */
function assertCommandPayload(operation: string, payload: Record<string, unknown>): void {
  const discriminator = payload.command;
  if (discriminator !== operation) {
    throw new IpcValidationError(
      "INVALID_PAYLOAD",
      `payload.command must equal the envelope operation ${operation}`
    );
  }
  switch (operation) {
    case "drawing.create":
      assertNoUnknownKeys(
        payload,
        ["command", "drawingNumber", "name", "sourceFile", "createdAt", "createdBy"],
        "drawing.create payload"
      );
      if (!isNonEmptyString(payload.drawingNumber)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "drawingNumber must be a non-empty string");
      }
      if (!isNonEmptyString(payload.name)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "name must be a non-empty string");
      }
      if (!isNonEmptyString(payload.createdAt)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "createdAt must be a non-empty string");
      }
      if (payload.createdBy !== undefined && !isNonEmptyString(payload.createdBy)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "createdBy must be a non-empty string");
      }
      assertSourceFile(payload.sourceFile);
      return;
    case "drawing.createRevision":
      assertNoUnknownKeys(
        payload,
        ["command", "drawingId", "sourceFile", "createdAt"],
        "drawing.createRevision payload"
      );
      if (!isNonEmptyString(payload.drawingId)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "drawingId must be a non-empty string");
      }
      if (!isNonEmptyString(payload.createdAt)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "createdAt must be a non-empty string");
      }
      assertSourceFile(payload.sourceFile);
      return;
    case "drawing.setCurrentRevision":
      assertNoUnknownKeys(
        payload,
        ["command", "drawingId", "revisionId", "updatedAt"],
        "drawing.setCurrentRevision payload"
      );
      if (!isNonEmptyString(payload.drawingId)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "drawingId must be a non-empty string");
      }
      if (!isNonEmptyString(payload.revisionId)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "revisionId must be a non-empty string");
      }
      if (!isNonEmptyString(payload.updatedAt)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "updatedAt must be a non-empty string");
      }
      return;
    case "drawing.deleteRevision":
      assertNoUnknownKeys(
        payload,
        ["command", "drawingId", "revisionId", "updatedAt"],
        "drawing.deleteRevision payload"
      );
      if (!isNonEmptyString(payload.drawingId)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "drawingId must be a non-empty string");
      }
      if (!isNonEmptyString(payload.revisionId)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "revisionId must be a non-empty string");
      }
      if (!isNonEmptyString(payload.updatedAt)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "updatedAt must be a non-empty string");
      }
      return;
    case "drawing.addRevisionFact":
      assertNoUnknownKeys(
        payload,
        ["command", "drawingId", "revisionId", "field", "value", "unit", "source", "sourceRunId", "createdAt", "createdBy"],
        "drawing.addRevisionFact payload"
      );
      if (!isNonEmptyString(payload.drawingId)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "drawingId must be a non-empty string");
      }
      if (!isNonEmptyString(payload.revisionId)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "revisionId must be a non-empty string");
      }
      if (!isNonEmptyString(payload.field)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "field must be a non-empty string");
      }
      if (!isNonEmptyString(payload.value)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "value must be a non-empty string");
      }
      if (typeof payload.source !== "string" || !REVISION_FACT_SOURCES.has(payload.source)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "source must be a revision-fact source");
      }
      if (payload.unit !== undefined && !isNonEmptyString(payload.unit)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "unit must be a non-empty string");
      }
      if (payload.sourceRunId !== undefined && !isNonEmptyString(payload.sourceRunId)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "sourceRunId must be a non-empty string");
      }
      if (!isNonEmptyString(payload.createdAt)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "createdAt must be a non-empty string");
      }
      return;
    case "drawing.addModelingFeedback":
      assertNoUnknownKeys(
        payload,
        ["command", "drawingId", "revisionId", "content", "createdAt"],
        "drawing.addModelingFeedback payload"
      );
      if (!isNonEmptyString(payload.drawingId)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "drawingId must be a non-empty string");
      }
      if (!isNonEmptyString(payload.revisionId)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "revisionId must be a non-empty string");
      }
      if (!isNonEmptyString(payload.content)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "content must be a non-empty string");
      }
      if (!isNonEmptyString(payload.createdAt)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "createdAt must be a non-empty string");
      }
      return;
    case "storage.updateSettings": {
      assertNoUnknownKeys(payload, ["command", "settings"], "storage.updateSettings payload");
      const settings = payload.settings;
      if (!isRecord(settings)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "settings must be an object");
      }
      assertNoUnknownKeys(
        settings,
        ["dataRoot", "workspaceRoot", "constraint", "updatedAt"],
        "settings"
      );
      if (!isNonEmptyString(settings.dataRoot)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "settings.dataRoot must be a non-empty string");
      }
      if (!isNonEmptyString(settings.workspaceRoot)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "settings.workspaceRoot must be a non-empty string");
      }
      if (settings.constraint !== "LOCAL_FIXED_NTFS") {
        throw new IpcValidationError("INVALID_PAYLOAD", "settings.constraint must be LOCAL_FIXED_NTFS");
      }
      if (!isNonEmptyString(settings.updatedAt)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "settings.updatedAt must be a non-empty string");
      }
      return;
    }
    case "run.create":
      // The renderer may only name the drawing/revision pair. Any attempt to
      // smuggle a snapshot (or any other field) is rejected before dispatch;
      // the Runner freezes the snapshot in its own transaction.
      assertNoUnknownKeys(
        payload,
        ["command", "drawingId", "revisionId"],
        "run.create payload"
      );
      if (!isNonEmptyString(payload.drawingId)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "run.create drawingId must be a non-empty string");
      }
      if (!isNonEmptyString(payload.revisionId)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "run.create revisionId must be a non-empty string");
      }
      return;
    case "run.cancel":
      assertNoUnknownKeys(
        payload,
        ["command", "runId", "reason"],
        "run.cancel payload"
      );
      if (!isNonEmptyString(payload.runId)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "run.cancel runId must be a non-empty string");
      }
      if (payload.reason !== undefined && !isNonEmptyString(payload.reason)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "run.cancel reason must be a non-empty string");
      }
      return;
    case "clarification.submit": {
      // Strict Phase-3 validation: answers persist on the OLD (terminal
      // CLARIFICATION_REQUIRED) Run's request; the Run itself is never resumed.
      assertNoUnknownKeys(
        payload,
        ["command", "clarificationRequestId", "answers", "answeredAt", "answeredBy"],
        "clarification.submit payload"
      );
      if (!isNonEmptyString(payload.clarificationRequestId)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "clarification.submit clarificationRequestId must be a non-empty string"
        );
      }
      if (!isNonEmptyString(payload.answeredAt)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "clarification.submit answeredAt must be a non-empty string"
        );
      }
      if (!isNonEmptyString(payload.answeredBy)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "clarification.submit answeredBy must be a non-empty string"
        );
      }
      const answers = payload.answers;
      if (!Array.isArray(answers) || answers.length === 0) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "clarification.submit answers must be a non-empty array"
        );
      }
      for (const answer of answers) {
        assertClarificationAnswer(answer);
      }
      return;
    }
    case "model.review": {
      assertNoUnknownKeys(
        payload,
        ["command", "modelId", "result", "comment", "reviewerId", "reviewedAt"],
        "model.review payload"
      );
      if (!isNonEmptyString(payload.modelId)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "model.review modelId must be a non-empty string"
        );
      }
      if (!isNonEmptyString(payload.reviewerId)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "model.review reviewerId must be a non-empty string"
        );
      }
      if (
        typeof payload.result !== "string" ||
        !MODEL_REVIEW_RESULTS.includes(payload.result as ModelReviewResult)
      ) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "model.review result must be one of APPROVED, REJECTED"
        );
      }
      assertCanonicalIsoTimestamp(payload.reviewedAt, "model.review reviewedAt");
      // A Rejected Review MUST carry a comment (written into the Revision's
      // Modeling Feedback); a comment on an APPROVED review is optional but
      // when present must be a non-empty string.
      if (payload.result === "REJECTED") {
        if (!isNonEmptyString(payload.comment)) {
          throw new IpcValidationError(
            "INVALID_PAYLOAD",
            "model.review comment must be a non-empty string when the model is REJECTED"
          );
        }
      } else if (payload.comment !== undefined && !isNonEmptyString(payload.comment)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "model.review comment must be a non-empty string when present"
        );
      }
      return;
    }
    case "costData.update":
      // Phase 7: full replacement of the company-global Cost Data basis. The
      // whole payload is the discriminator plus the strict snapshot
      // (materials with positive prices/densities, valid per-stock-type
      // allowances, non-negative fixed costs with valid currency/basis,
      // DISPLAY_ONLY custom fields, canonical capturedAt and snapshot-level
      // updatedAt). Any unknown key — including a forged top-level
      // `updatedAt` or a fake `result` — is rejected before dispatch.
      assertNoUnknownKeys(payload, ["command", "snapshot"], "costData.update payload");
      assertCostDataSnapshot(payload.snapshot, "costData.update payload.snapshot", true);
      return;
    case "costReport.create": {
      // Phase 7: the Renderer submits ONLY the immutable deterministic input
      // snapshot plus the report creation instant. A `result` is never
      // accepted — the Runner derives it with the pure calculator inside its
      // own transaction — so any attempt to forge one (or to smuggle any other
      // field) is rejected as an unknown key before dispatch.
      assertNoUnknownKeys(
        payload,
        ["command", "input", "createdAt"],
        "costReport.create payload"
      );
      if (!isNonEmptyString(payload.createdAt)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "costReport.create createdAt must be a non-empty string"
        );
      }
      const input = payload.input;
      if (!isRecord(input)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "costReport.create input must be an object");
      }
      assertNoUnknownKeys(
        input,
        [
          "drawingId",
          "revisionId",
          "modelId",
          "quantity",
          "materialId",
          "stockType",
          "stockSpec",
          "finishedVolume",
          "allowances",
          "costData",
          "formulaVersion",
          "capturedAt"
        ],
        "costReport.create input"
      );
      if (!isNonEmptyString(input.drawingId)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "costReport.create input.drawingId must be a non-empty string"
        );
      }
      if (!isNonEmptyString(input.revisionId)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "costReport.create input.revisionId must be a non-empty string"
        );
      }
      if (!isNonEmptyString(input.modelId)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "costReport.create input.modelId must be a non-empty string"
        );
      }
      if (
        typeof input.quantity !== "number" ||
        !Number.isSafeInteger(input.quantity) ||
        input.quantity <= 0
      ) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "costReport.create input.quantity must be a positive integer"
        );
      }
      if (!isNonEmptyString(input.materialId)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "costReport.create input.materialId must be a non-empty string"
        );
      }
      if (typeof input.stockType !== "string" || !STOCK_TYPE_SET.has(input.stockType)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "costReport.create input.stockType must be one of CYLINDER, RECTANGULAR_BAR"
        );
      }
      if (!isNonEmptyString(input.stockSpec)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "costReport.create input.stockSpec must be a non-empty string"
        );
      }
      if (
        typeof input.finishedVolume !== "number" ||
        !Number.isFinite(input.finishedVolume) ||
        input.finishedVolume <= 0
      ) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "costReport.create input.finishedVolume must be a positive number"
        );
      }
      if (!Array.isArray(input.allowances)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "costReport.create input.allowances must be an array"
        );
      }
      for (const allowance of input.allowances) {
        assertAllowanceValue(allowance, "costReport.create input.allowances[]");
      }
      // The frozen element of a report input is the domain `CostDataSnapshot`
      // (no snapshot-level `updatedAt`), strictly validated.
      assertCostDataSnapshot(input.costData, "costReport.create input.costData", false);
      if (!isNonEmptyString(input.formulaVersion)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "costReport.create input.formulaVersion must be a non-empty string"
        );
      }
      assertCanonicalIsoTimestamp(input.capturedAt, "costReport.create input.capturedAt");
      return;
    }
    case "run.delete":
      // Phase 8: deleting a Run names the Run plus the owning drawing/revision
      // identity pair so the Runner can guard and scope the deletion. Unknown
      // keys and blank/typed ID fields are rejected before dispatch.
      assertNoUnknownKeys(
        payload,
        ["command", "runId", "drawingId", "revisionId"],
        "run.delete payload"
      );
      if (!isNonEmptyString(payload.runId)) {
        throw new IpcValidationError("INVALID_PAYLOAD", "run.delete runId must be a non-empty string");
      }
      if (!isNonEmptyString(payload.drawingId)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "run.delete drawingId must be a non-empty string"
        );
      }
      if (!isNonEmptyString(payload.revisionId)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "run.delete revisionId must be a non-empty string"
        );
      }
      return;
    case "costReport.delete":
      // Phase 8: deleting a Cost Report names the report plus the owning
      // revision identity pair so the Runner can guard the deletion.
      assertNoUnknownKeys(
        payload,
        ["command", "costReportId", "revisionId"],
        "costReport.delete payload"
      );
      if (!isNonEmptyString(payload.costReportId)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "costReport.delete costReportId must be a non-empty string"
        );
      }
      if (!isNonEmptyString(payload.revisionId)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "costReport.delete revisionId must be a non-empty string"
        );
      }
      return;
    case "secrets.setApiKey":
      // Phase 8: the payload is the discriminator plus the secret key. Blank,
      // whitespace-only, non-string and unknown keys are rejected; the key
      // itself is never echoed back by any response.
      assertNoUnknownKeys(payload, ["command", "apiKey"], "secrets.setApiKey payload");
      if (
        typeof payload.apiKey !== "string" ||
        payload.apiKey.trim().length === 0
      ) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "secrets.setApiKey apiKey must be a non-empty string"
        );
      }
      return;
    case "secrets.getApiKeyStatus":
      assertNoUnknownKeys(payload, ["command"], "secrets.getApiKeyStatus payload");
      return;
    case "secrets.clearApiKey":
      assertNoUnknownKeys(payload, ["command"], "secrets.clearApiKey payload");
      return;
    case "system.getRecoveryStatus":
      assertNoUnknownKeys(payload, ["command"], "system.getRecoveryStatus payload");
      return;
    default:
      // Remaining later-phase command (model.openInSolidWorks) is checked for
      // the discriminator only; the Runner rejects it with
      // UNSUPPORTED_PHASE_OPERATION before any payload is interpreted.
      return;
  }
}

/**
 * Validates an incoming request envelope against the versioned IPC contract
 * and returns a typed envelope. Throws {@link IpcValidationError} on the first
 * violation with a stable machine-readable code. There is no generic command
 * endpoint: `operation` must be an allowlisted query or command and must be
 * delivered on the matching channel.
 */
export function validateIpcRequestEnvelope(value: unknown): IpcRequestEnvelope {
  if (!isRecord(value)) {
    throw new IpcValidationError("INVALID_ENVELOPE", "Request envelope must be a JSON object");
  }
  assertNoUnknownKeys(
    value,
    ["protocolVersion", "requestId", "channel", "operation", "payload", "idempotencyKey"],
    "Request envelope"
  );
  if (value.protocolVersion !== IPC_PROTOCOL_VERSION) {
    throw new IpcValidationError(
      "PROTOCOL_VERSION_MISMATCH",
      `Expected protocolVersion ${IPC_PROTOCOL_VERSION}, got ${JSON.stringify(value.protocolVersion)}`
    );
  }
  if (!isNonEmptyString(value.requestId)) {
    throw new IpcValidationError("MISSING_REQUEST_ID", "requestId must be a non-empty string");
  }
  const channel = value.channel;
  if (channel !== "query" && channel !== "command" && channel !== "subscribe") {
    throw new IpcValidationError(
      "INVALID_CHANNEL",
      "channel must be 'query', 'command' or 'subscribe'"
    );
  }
  if (typeof value.operation !== "string") {
    throw new IpcValidationError("UNKNOWN_OPERATION", "operation must be a string");
  }
  const operation = value.operation;
  const isQueryName = QUERY_NAME_SET.has(operation);
  const isCommandName = COMMAND_NAME_SET.has(operation);
  const isSubscribeName = SUBSCRIBE_NAME_SET.has(operation);
  if (!isQueryName && !isCommandName && !isSubscribeName) {
    throw new IpcValidationError("UNKNOWN_OPERATION", `Unknown operation: ${operation}`);
  }
  if (channel === "query" && !isQueryName) {
    throw new IpcValidationError(
      "CHANNEL_OPERATION_MISMATCH",
      `${operation} is not a query and cannot be dispatched on the query channel`
    );
  }
  if (channel === "command" && !isCommandName) {
    throw new IpcValidationError(
      "CHANNEL_OPERATION_MISMATCH",
      `${operation} is not a command and cannot be dispatched on the command channel`
    );
  }
  if (channel === "subscribe" && !isSubscribeName) {
    throw new IpcValidationError(
      "CHANNEL_OPERATION_MISMATCH",
      `${operation} is not a subscription and cannot be dispatched on the subscribe channel`
    );
  }
  if (!isRecord(value.payload)) {
    throw new IpcValidationError("INVALID_PAYLOAD", "payload must be a JSON object");
  }
  const payload = value.payload;
  if (channel === "query") {
    const queryName = operation as QueryName;
    const idFields = QUERY_STRING_ID_FIELDS[queryName];
    if (idFields !== undefined) {
      assertExactStringKeys(payload, idFields);
    } else if (QUERY_EMPTY_PAYLOAD_NAMES.has(queryName)) {
      if (Object.keys(payload).length !== 0) {
        throw new IpcValidationError("INVALID_PAYLOAD", `${queryName} payload must be {}`);
      }
    }
  } else if (channel === "subscribe") {
    assertSubscribePayload(operation as SubscribeName, payload);
  } else {
    assertCommandPayload(operation, payload);
  }
  const idempotencyKey = value.idempotencyKey;
  if (idempotencyKey !== undefined && !isNonEmptyString(idempotencyKey)) {
    throw new IpcValidationError("INVALID_PAYLOAD", "idempotencyKey must be a non-empty string");
  }
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId: value.requestId,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    channel,
    operation: operation as IpcRequestEnvelope["operation"],
    payload
  };
}

/**
 * Validates the payload of a subscription request. The only supported
 * subscription names the drawing/revision identity of one Run plus the first
 * event sequence the subscriber has not yet seen (`fromSequence`, 0 = whole
 * history). No scenario, snapshot or arbitrary field is ever accepted.
 */
function assertSubscribePayload(operation: SubscribeName, payload: Record<string, unknown>): void {
  switch (operation) {
    case "run.subscribe":
      assertNoUnknownKeys(payload, ["runId", "fromSequence"], "run.subscribe payload");
      if (!isNonEmptyString(payload.runId)) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "run.subscribe runId must be a non-empty string"
        );
      }
      if (
        typeof payload.fromSequence !== "number" ||
        !Number.isSafeInteger(payload.fromSequence) ||
        payload.fromSequence < 0
      ) {
        throw new IpcValidationError(
          "INVALID_PAYLOAD",
          "run.subscribe fromSequence must be a non-negative integer"
        );
      }
      return;
  }
}

/**
 * Validates a server-initiated Run event envelope received by a client. Throws
 * {@link IpcValidationError} on the first violation: wrong protocol version,
 * wrong kind, malformed run id / fromSequence, or an event that violates the
 * structured Run event contract (version, run id, sequence, timestamp, type).
 * The receiver additionally enforces strict monotonicity / gap detection across
 * envelopes using its own applied-sequence watermark.
 */
export function validateIpcEventEnvelope(value: unknown): IpcEventEnvelope {
  if (!isRecord(value)) {
    throw new IpcValidationError("INVALID_ENVELOPE", "Event envelope must be a JSON object");
  }
  assertNoUnknownKeys(
    value,
    ["protocolVersion", "kind", "runId", "fromSequence", "events"],
    "Event envelope"
  );
  if (value.protocolVersion !== IPC_PROTOCOL_VERSION) {
    throw new IpcValidationError(
      "PROTOCOL_VERSION_MISMATCH",
      `Expected protocolVersion ${IPC_PROTOCOL_VERSION}, got ${JSON.stringify(value.protocolVersion)}`
    );
  }
  if (value.kind !== "runEvents") {
    throw new IpcValidationError(
      "INVALID_ENVELOPE",
      `Event envelope kind must be 'runEvents', got ${JSON.stringify(value.kind)}`
    );
  }
  if (!isNonEmptyString(value.runId)) {
    throw new IpcValidationError("INVALID_ENVELOPE", "event runId must be a non-empty string");
  }
  if (
    typeof value.fromSequence !== "number" ||
    !Number.isSafeInteger(value.fromSequence) ||
    value.fromSequence < 0
  ) {
    throw new IpcValidationError(
      "INVALID_ENVELOPE",
      "event fromSequence must be a non-negative integer"
    );
  }
  if (!Array.isArray(value.events)) {
    throw new IpcValidationError("INVALID_ENVELOPE", "event envelope events must be an array");
  }
  for (const event of value.events) {
    if (!isRecord(event)) {
      throw new IpcValidationError("INVALID_ENVELOPE", "each run event must be an object");
    }
    if (event.contractVersion !== RUN_EVENT_CONTRACT_VERSION) {
      throw new IpcValidationError(
        "INVALID_ENVELOPE",
        `run event contractVersion must be ${RUN_EVENT_CONTRACT_VERSION}`
      );
    }
    if (event.runId !== value.runId) {
      throw new IpcValidationError(
        "INVALID_ENVELOPE",
        "run event runId must match the envelope runId"
      );
    }
    if (
      typeof event.sequence !== "number" ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 0
    ) {
      throw new IpcValidationError("INVALID_ENVELOPE", "run event sequence must be a non-negative integer");
    }
    if (!isNonEmptyString(event.attemptId)) {
      throw new IpcValidationError("INVALID_ENVELOPE", "run event attemptId must be a non-empty string");
    }
    if (!isNonEmptyString(event.occurredAt) || Number.isNaN(Date.parse(event.occurredAt))) {
      throw new IpcValidationError("INVALID_ENVELOPE", "run event occurredAt must be a valid ISO timestamp");
    }
    if (typeof event.type !== "string" || !RUN_EVENT_TYPES.includes(event.type as never)) {
      throw new IpcValidationError(
        "INVALID_ENVELOPE",
        `run event type is not a known run event type: ${JSON.stringify(event.type)}`
      );
    }
  }
  return value as unknown as IpcEventEnvelope;
}

/**
 * Validates the handshake envelope the Runner sends immediately on connect.
 * Throws {@link IpcValidationError} with `PROTOCOL_VERSION_MISMATCH` when the
 * peer speaks a different protocol version.
 */
export function validateIpcHandshakeEnvelope(value: unknown): IpcHandshakeEnvelope {
  if (!isRecord(value)) {
    throw new IpcValidationError("INVALID_ENVELOPE", "Handshake envelope must be a JSON object");
  }
  if (value.protocolVersion !== IPC_PROTOCOL_VERSION) {
    throw new IpcValidationError(
      "PROTOCOL_VERSION_MISMATCH",
      `Expected protocolVersion ${IPC_PROTOCOL_VERSION}, got ${JSON.stringify(value.protocolVersion)}`
    );
  }
  if (!isNonEmptyString(value.serverInstanceId)) {
    throw new IpcValidationError("INVALID_ENVELOPE", "serverInstanceId must be a non-empty string");
  }
  return { protocolVersion: IPC_PROTOCOL_VERSION, serverInstanceId: value.serverInstanceId };
}

/**
 * Validates a response envelope received by a client. Throws
 * {@link IpcValidationError} when the envelope is malformed or the peer reports
 * a mismatched protocol version.
 */
export function validateIpcResponseEnvelope(value: unknown): IpcResponseEnvelope {
  if (!isRecord(value)) {
    throw new IpcValidationError("INVALID_ENVELOPE", "Response envelope must be a JSON object");
  }
  if (value.protocolVersion !== IPC_PROTOCOL_VERSION) {
    throw new IpcValidationError(
      "PROTOCOL_VERSION_MISMATCH",
      `Expected protocolVersion ${IPC_PROTOCOL_VERSION}, got ${JSON.stringify(value.protocolVersion)}`
    );
  }
  if (!isNonEmptyString(value.requestId)) {
    throw new IpcValidationError("INVALID_ENVELOPE", "response requestId must be a non-empty string");
  }
  if (typeof value.ok !== "boolean") {
    throw new IpcValidationError("INVALID_ENVELOPE", "response ok must be a boolean");
  }
  if (value.ok === false) {
    const error = value.error;
    if (!isRecord(error) || !isNonEmptyString(error.code) || !isNonEmptyString(error.message)) {
      throw new IpcValidationError(
        "INVALID_ENVELOPE",
        "failed responses must carry error: { code, message }"
      );
    }
  }
  return value as unknown as IpcResponseEnvelope;
}

/** True when `operation` is an allowlisted query name. */
export function isQueryOperation(operation: unknown): operation is QueryName {
  return typeof operation === "string" && QUERY_NAME_SET.has(operation);
}

/** True when `operation` is an allowlisted command name. */
export function isCommandOperation(operation: unknown): operation is CommandName {
  return typeof operation === "string" && COMMAND_NAME_SET.has(operation);
}

/**
 * Type guard narrowing an unknown request envelope to a typed
 * {@link IpcRequestEnvelope}. Returns false instead of throwing for invalid
 * values; {@link validateIpcRequestEnvelope} remains the strict variant.
 */
export function isIpcRequestEnvelope(value: unknown): value is IpcRequestEnvelope {
  try {
    validateIpcRequestEnvelope(value);
    return true;
  } catch (error) {
    if (error instanceof IpcValidationError) return false;
    throw error;
  }
}

/** Type guard narrowing an unknown payload to a typed {@link Command}. */
export function isCommandPayload(value: unknown): value is Command {
  if (!isRecord(value)) return false;
  return isCommandOperation(value.command);
}
