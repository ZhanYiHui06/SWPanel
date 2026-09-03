import type {
  InputAdapterFailureCode,
  InputAdapterPageSelection,
  InputAdapterProvenance,
  InputAdapterRenderer,
  InputAdapterRequest,
  InputAdapterResult
} from "@swpanel/domain";
import {
  DRAWING_FILE_FORMATS,
  INPUT_ADAPTER_FAILURE_CODES,
  INPUT_ADAPTER_IMAGE_FORMATS
} from "@swpanel/domain";
import {
  INPUT_ADAPTATION_SCHEMA_ID,
  PHASE4_SCHEMA_DRAFT
} from "./schema-ids.js";
import {
  Phase4ContractError,
  assertIsoTimestamp,
  assertNoUnknownKeys,
  assertNonEmptyString,
  assertOptionalNonEmptyString,
  isPositiveSafeInteger,
  isRecord,
  isSha256Hex
} from "./shared.js";

/**
 * Versioned Input Adaptation metadata contract (architecture.md §8.2): the
 * serialized request and the conversion provenance every successful adapter
 * result must carry. The provenance records adapter id/version, source hash,
 * page/layout selection, output image path/hash/dimensions/DPI, the STRUCTURED
 * rendering engine identity/version (v2; real conversions always record it,
 * synthetic adapters without an engine leave it absent), warnings,
 * unsupported entities, the human-reviewable preview and whether the conversion
 * path is production-verified. The DTOs reuse the pure `@swpanel/domain` Input
 * Adapter model.
 *
 * Conversion availability is adapter-owned and never a preflight capability:
 * the adapter probes its renderer at conversion time and the executor marks
 * the `input_adapter_succeeded` preflight report item only after the
 * conversion succeeds.
 */
export const INPUT_ADAPTATION_CONTRACT_VERSION = 2 as const;

const DRAWING_FILE_FORMAT_SET: ReadonlySet<string> = new Set(DRAWING_FILE_FORMATS);
const INPUT_ADAPTER_IMAGE_FORMAT_SET: ReadonlySet<string> = new Set(
  INPUT_ADAPTER_IMAGE_FORMATS
);
const INPUT_ADAPTER_FAILURE_CODE_SET: ReadonlySet<string> = new Set(
  INPUT_ADAPTER_FAILURE_CODES
);

/** JSON Schema document registering/documenting the Input Adaptation contract. */
export const INPUT_ADAPTATION_JSON_SCHEMA = {
  $schema: PHASE4_SCHEMA_DRAFT,
  $id: INPUT_ADAPTATION_SCHEMA_ID,
  title: "SWPanel Input Adaptation Metadata",
  description:
    "Serialized Input Adapter request and conversion provenance: source hash, " +
    "explicit page selection, structured rendering engine id/version, derived " +
    "image path/hash/dimensions/DPI, warnings, unsupported entities, preview " +
    "and production-verification flag.",
  type: "object",
  additionalProperties: false,
  required: ["contractVersion", "ok"],
  properties: {
    contractVersion: { const: INPUT_ADAPTATION_CONTRACT_VERSION },
    ok: { type: "boolean" },
    provenance: {
      type: "object",
      additionalProperties: false,
      required: [
        "adapterId",
        "adapterVersion",
        "sourceFileSha256",
        "output",
        "warnings",
        "unsupportedEntities",
        "productionVerified",
        "createdAt"
      ],
      properties: {
        adapterId: { type: "string", minLength: 1 },
        adapterVersion: { type: "string", minLength: 1 },
        sourceFileSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        pageSelection: {
          type: "object",
          additionalProperties: false,
          required: ["pageNumber", "totalPages"],
          properties: {
            pageNumber: { type: "integer", minimum: 1 },
            totalPages: { type: "integer", minimum: 1 }
          }
        },
        renderer: {
          type: "object",
          additionalProperties: false,
          required: ["id", "version"],
          properties: {
            id: { type: "string", minLength: 1 },
            version: { type: "string", minLength: 1 }
          }
        },
        output: {
          type: "object",
          additionalProperties: false,
          required: ["fileName", "sha256", "sizeBytes", "widthPx", "heightPx", "dpi", "relativePath"],
          properties: {
            fileName: { type: "string", minLength: 1 },
            sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
            sizeBytes: { type: "integer", minimum: 1 },
            widthPx: { type: "integer", minimum: 1 },
            heightPx: { type: "integer", minimum: 1 },
            dpi: { type: "number", exclusiveMinimum: 0 },
            relativePath: { type: "string", minLength: 1 }
          }
        },
        warnings: { type: "array", items: { type: "string", minLength: 1 } },
        unsupportedEntities: { type: "array", items: { type: "string", minLength: 1 } },
        previewRelativePath: { type: "string", minLength: 1 },
        productionVerified: { type: "boolean" },
        createdAt: { type: "string", format: "date-time" }
      }
    },
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: {
        code: { enum: [...INPUT_ADAPTER_FAILURE_CODES] },
        message: { type: "string", minLength: 1 }
      }
    }
  }
} as const;

function assertPageSelection(value: unknown): InputAdapterPageSelection {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "pageSelection must be an object");
  }
  assertNoUnknownKeys(value, ["pageNumber", "totalPages"], "pageSelection");
  const pageNumber = value.pageNumber;
  const totalPages = value.totalPages;
  if (!isPositiveSafeInteger(pageNumber) || !isPositiveSafeInteger(totalPages)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "pageSelection pageNumber and totalPages must be positive integers"
    );
  }
  if (pageNumber > totalPages) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "pageSelection pageNumber must not exceed totalPages"
    );
  }
  return { pageNumber, totalPages };
}

/**
 * Strictly validates the structured renderer metadata (contract v2): identity
 * and exact version are non-empty strings; unknown fields and malformed values
 * are rejected. Absent renderer stays valid — synthetic adapters without a
 * rendering engine must not invent one.
 */
function assertRenderer(value: unknown): InputAdapterRenderer {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "renderer must be an object");
  }
  assertNoUnknownKeys(value, ["id", "version"], "renderer");
  const id = assertNonEmptyString(value, "id", "renderer");
  const version = assertNonEmptyString(value, "version", "renderer");
  return { id, version };
}

/**
 * Strictly validates a serialized Input Adapter request. Multi-page sources
 * must carry an explicit `pageSelection`; an adapter must never silently choose
 * a page (architecture.md §8.2).
 */
export function validateInputAdapterRequest(value: unknown): InputAdapterRequest {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "input adapter request must be an object");
  }
  assertNoUnknownKeys(value, ["source", "outputFormat", "pageSelection"], "input adapter request");
  const source = value.source;
  if (!isRecord(source)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "source must be an object");
  }
  assertNoUnknownKeys(source, ["fileName", "format", "sizeBytes", "sha256"], "source");
  const fileName = assertNonEmptyString(source, "fileName", "source");
  if (typeof source.format !== "string" || !DRAWING_FILE_FORMAT_SET.has(source.format)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "source.format must be one of PDF, DWG, DXF"
    );
  }
  if (!isPositiveSafeInteger(source.sizeBytes)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "source.sizeBytes must be a positive integer"
    );
  }
  if (!isSha256Hex(source.sha256)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "source.sha256 must be a 64-char hex digest");
  }
  if (typeof value.outputFormat !== "string" || !INPUT_ADAPTER_IMAGE_FORMAT_SET.has(value.outputFormat)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "outputFormat must be one of JPG, PNG"
    );
  }
  if (value.pageSelection !== undefined) {
    assertPageSelection(value.pageSelection);
  }
  return {
    source: {
      fileName,
      format: source.format as InputAdapterRequest["source"]["format"],
      sizeBytes: source.sizeBytes,
      sha256: source.sha256
    },
    outputFormat: value.outputFormat as InputAdapterRequest["outputFormat"],
    ...(value.pageSelection === undefined ? {} : { pageSelection: assertPageSelection(value.pageSelection) })
  };
}

/**
 * Strictly validates a serialized Input Adapter provenance document. Throws
 * {@link Phase4ContractError} on the first violation: unknown fields, malformed
 * hashes/dimensions/DPI or an inconsistent page selection.
 */
export function validateInputAdapterProvenance(value: unknown): InputAdapterProvenance {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "input adapter provenance must be an object");
  }
  assertNoUnknownKeys(
    value,
    [
      "adapterId",
      "adapterVersion",
      "sourceFileSha256",
      "pageSelection",
      "renderer",
      "output",
      "warnings",
      "unsupportedEntities",
      "previewRelativePath",
      "productionVerified",
      "createdAt"
    ],
    "input adapter provenance"
  );
  const adapterId = assertNonEmptyString(value, "adapterId", "input adapter provenance");
  const adapterVersion = assertNonEmptyString(value, "adapterVersion", "input adapter provenance");
  if (!isSha256Hex(value.sourceFileSha256)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "sourceFileSha256 must be a 64-char hex digest"
    );
  }
  const pageSelection = value.pageSelection === undefined ? undefined : assertPageSelection(value.pageSelection);
  const renderer = value.renderer === undefined ? undefined : assertRenderer(value.renderer);

  const output = value.output;
  if (!isRecord(output)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "output must be an object");
  }
  assertNoUnknownKeys(
    output,
    ["fileName", "sha256", "sizeBytes", "widthPx", "heightPx", "dpi", "relativePath"],
    "output"
  );
  const outputFileName = assertNonEmptyString(output, "fileName", "output");
  if (!isSha256Hex(output.sha256)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "output.sha256 must be a 64-char hex digest");
  }
  if (!isPositiveSafeInteger(output.sizeBytes)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "output.sizeBytes must be a positive integer"
    );
  }
  if (!isPositiveSafeInteger(output.widthPx) || !isPositiveSafeInteger(output.heightPx)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "output widthPx and heightPx must be positive integers"
    );
  }
  if (typeof output.dpi !== "number" || !Number.isFinite(output.dpi) || output.dpi <= 0) {
    throw new Phase4ContractError("INVALID_CONTRACT", "output.dpi must be a positive number");
  }
  const relativePath = assertNonEmptyString(output, "relativePath", "output");

  const warnings = value.warnings;
  if (!Array.isArray(warnings)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "warnings must be an array");
  }
  for (const warning of warnings) {
    if (typeof warning !== "string" || warning.length === 0) {
      throw new Phase4ContractError(
        "INVALID_CONTRACT",
        "warnings items must be non-empty strings"
      );
    }
  }
  const unsupportedEntities = value.unsupportedEntities;
  if (!Array.isArray(unsupportedEntities)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "unsupportedEntities must be an array");
  }
  for (const entity of unsupportedEntities) {
    if (typeof entity !== "string" || entity.length === 0) {
      throw new Phase4ContractError(
        "INVALID_CONTRACT",
        "unsupportedEntities items must be non-empty strings"
      );
    }
  }
  const previewRelativePath = assertOptionalNonEmptyString(
    value,
    "previewRelativePath",
    "input adapter provenance"
  );
  if (typeof value.productionVerified !== "boolean") {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "productionVerified must be a boolean"
    );
  }
  const createdAt = assertIsoTimestamp(value, "createdAt", "input adapter provenance");

  return {
    adapterId,
    adapterVersion,
    sourceFileSha256: value.sourceFileSha256,
    ...(pageSelection === undefined ? {} : { pageSelection }),
    ...(renderer === undefined ? {} : { renderer }),
    output: {
      fileName: outputFileName,
      sha256: output.sha256,
      sizeBytes: output.sizeBytes,
      widthPx: output.widthPx,
      heightPx: output.heightPx,
      dpi: output.dpi,
      relativePath
    },
    warnings: warnings as readonly string[],
    unsupportedEntities: unsupportedEntities as readonly string[],
    ...(previewRelativePath === undefined ? {} : { previewRelativePath }),
    productionVerified: value.productionVerified,
    createdAt
  };
}

/**
 * Strictly validates a serialized Input Adapter result (success with provenance
 * or structured failure). Throws {@link Phase4ContractError} on the first
 * violation: version mismatch, unknown fields or an illegal failure code.
 */
export function validateInputAdapterResult(value: unknown): InputAdapterResult {
  if (!isRecord(value)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "input adapter result must be an object");
  }
  assertNoUnknownKeys(value, ["contractVersion", "ok", "provenance", "error"], "input adapter result");
  if (value.contractVersion !== INPUT_ADAPTATION_CONTRACT_VERSION) {
    throw new Phase4ContractError(
      "VERSION_MISMATCH",
      `Expected contractVersion ${INPUT_ADAPTATION_CONTRACT_VERSION}, got ${JSON.stringify(value.contractVersion)}`
    );
  }
  if (value.ok !== true && value.ok !== false) {
    throw new Phase4ContractError("INVALID_CONTRACT", "ok must be a boolean");
  }
  if (value.ok === true) {
    if (value.error !== undefined) {
      throw new Phase4ContractError(
        "INVALID_CONTRACT",
        "successful results must not carry an error"
      );
    }
    return { ok: true, provenance: validateInputAdapterProvenance(value.provenance) };
  }
  if (value.provenance !== undefined) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "failed results must not carry provenance"
    );
  }
  const error = value.error;
  if (!isRecord(error)) {
    throw new Phase4ContractError("INVALID_CONTRACT", "error must be an object");
  }
  assertNoUnknownKeys(error, ["code", "message"], "error");
  if (typeof error.code !== "string" || !INPUT_ADAPTER_FAILURE_CODE_SET.has(error.code)) {
    throw new Phase4ContractError(
      "INVALID_CONTRACT",
      "error.code must be a known input adapter failure code"
    );
  }
  const message = assertNonEmptyString(error, "message", "error");
  return {
    ok: false,
    error: { code: error.code as InputAdapterFailureCode, message }
  };
}
