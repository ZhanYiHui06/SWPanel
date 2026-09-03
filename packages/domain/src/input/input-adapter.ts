import type { DrawingFileFormat } from "../revisions/revision.js";

/**
 * Pure data model of the Phase 4 Input Adapter boundary (architecture.md §8).
 * SWPanel converts product inputs (PDF / DWG / DXF) into the JPG / PNG image the
 * modeling Skill consumes. The original drawing file is immutable: adapters only
 * ever produce derived images plus provenance metadata, and never overwrite the
 * source.
 *
 * This module is intentionally dependency-free and purely descriptive; the
 * Runner implements the adapter behaviour and the shared contract validators in
 * `@swpanel/contracts` enforce the serialized shapes.
 */

/** Image formats the modeling Skill accepts and adapters may produce. */
export const INPUT_ADAPTER_IMAGE_FORMATS = ["JPG", "PNG"] as const;
export type InputAdapterImageFormat = (typeof INPUT_ADAPTER_IMAGE_FORMATS)[number];

/**
 * Deterministic scenarios of the Phase 4 fake Input Adapters (P4-1). Scenario
 * selection is injected through Runner construction / test harness
 * configuration, never exposed to the Renderer, and mirrors the Fake Executor
 * scenario idiom. The DWG/DXF conversion is a synthetic test-only path: it is
 * not verified against approved production drawings and must stay marked as
 * such in the provenance it produces.
 */
export const INPUT_ADAPTER_SCENARIOS = [
  "png-jpg-passthrough",
  "single-page-pdf",
  "multi-page-pdf-selected-page",
  "multi-page-pdf-no-page-selected",
  "dwg-dxf-synthetic-test-only",
  "unsupported-source",
  "missing-corrupt-source",
  "adapter-failure"
] as const;
export type InputAdapterScenario = (typeof INPUT_ADAPTER_SCENARIOS)[number];

/**
 * Scenarios whose output is inherently test-only. A scenario in this list must
 * never claim `productionVerified: true` in its provenance.
 */
export const INPUT_ADAPTER_TEST_ONLY_SCENARIOS: readonly InputAdapterScenario[] = [
  "dwg-dxf-synthetic-test-only"
];

/** True when the scenario is a canonical adapter scenario. */
export function isInputAdapterScenario(value: unknown): value is InputAdapterScenario {
  return (
    typeof value === "string" &&
    (INPUT_ADAPTER_SCENARIOS as readonly string[]).includes(value)
  );
}

/** True when the scenario's output must always be flagged test-only. */
export function isTestOnlyScenario(scenario: InputAdapterScenario): boolean {
  return INPUT_ADAPTER_TEST_ONLY_SCENARIOS.includes(scenario);
}

/**
 * Structured adapter-level failure classification. These are conversion
 * failures, mapped by the Runner onto the Run-level failure codes
 * `INPUT_UNSUPPORTED` / `INPUT_ADAPTER_FAILED` when the attempt terminates.
 */
export const INPUT_ADAPTER_FAILURE_CODES = [
  "UNSUPPORTED_SOURCE_FORMAT",
  "SOURCE_MISSING_OR_CORRUPT",
  "PAGE_SELECTION_REQUIRED",
  "CONVERSION_FAILED",
  "OUTPUT_VALIDATION_FAILED"
] as const;
export type InputAdapterFailureCode = (typeof INPUT_ADAPTER_FAILURE_CODES)[number];

/** Identity + hash of the immutable original drawing file handed to the adapter. */
export interface InputAdapterSourceRef {
  fileName: string;
  format: DrawingFileFormat;
  sizeBytes: number;
  sha256: string;
}

/**
 * Explicit page/layout selection. Multi-page sources MUST carry an explicit
 * selection; an adapter must never silently pick an arbitrary page
 * (architecture.md §8.2).
 */
export interface InputAdapterPageSelection {
  /** 1-based page number converted for multi-page sources. */
  pageNumber: number;
  totalPages: number;
}

export interface InputAdapterRequest {
  source: InputAdapterSourceRef;
  outputFormat: InputAdapterImageFormat;
  /** Explicit selection; REQUIRED when the source has more than one page. */
  pageSelection?: InputAdapterPageSelection;
}

/** Derived image written inside the attempt workspace; never the original. */
export interface InputAdapterOutputImage {
  fileName: string;
  /** SHA-256 of the derived image bytes. */
  sha256: string;
  sizeBytes: number;
  widthPx: number;
  heightPx: number;
  dpi: number;
  /** Canonical workspace-relative path (input/ subdirectory of the attempt). */
  relativePath: string;
}

/**
 * The rendering engine that produced the derived image. Structured identity +
 * exact version — real conversions ALWAYS record it; synthetic adapters that
 * have no engine leave it absent (never invented).
 */
export interface InputAdapterRenderer {
  /** Stable identity of the rendering engine. */
  id: string;
  /** Exact version of the rendering engine. */
  version: string;
}

/**
 * Conversion provenance attached to every successful adapter result. It records
 * adapter identity/version, source hash, page selection, the derived image
 * (path/hash/dimensions/DPI), the rendering engine that produced it, warnings,
 * unsupported entities, the human-reviewable preview and whether the conversion
 * path is verified against approved production drawings. Conversion
 * availability is adapter-owned: the adapter probes its renderer at conversion
 * time and the executor marks the `input_adapter_succeeded` preflight report
 * item only after the conversion succeeds — the preflight gate itself never
 * evaluates conversion capabilities.
 */
export interface InputAdapterProvenance {
  adapterId: string;
  adapterVersion: string;
  /** SHA-256 of the immutable original source file. */
  sourceFileSha256: string;
  pageSelection?: InputAdapterPageSelection;
  output: InputAdapterOutputImage;
  /**
   * Structured renderer identity/version (contract v2). Real conversions
   * always record it; synthetic adapters without an engine leave it absent.
   */
  renderer?: InputAdapterRenderer;
  warnings: readonly string[];
  unsupportedEntities: readonly string[];
  /** Workspace-relative path of the human-reviewable preview image. */
  previewRelativePath?: string;
  /**
   * False until the conversion path is verified with allowed production
   * drawings. Synthetic test adapters must leave this false.
   */
  productionVerified: boolean;
  createdAt: string;
}

export type InputAdapterResult =
  | { ok: true; provenance: InputAdapterProvenance }
  | { ok: false; error: { code: InputAdapterFailureCode; message: string } };

/** True when the adapter produced a derived image with provenance. */
export function isInputAdapterSuccess(
  result: InputAdapterResult
): result is { ok: true; provenance: InputAdapterProvenance } {
  return result.ok;
}

/** True when the adapter failed with a structured failure code. */
export function isInputAdapterFailure(
  result: InputAdapterResult
): result is { ok: false; error: { code: InputAdapterFailureCode; message: string } } {
  return !result.ok;
}

/** True when the provenance is explicitly marked test-only (not production-verified). */
export function isTestOnlyResult(provenance: InputAdapterProvenance): boolean {
  return !provenance.productionVerified;
}
