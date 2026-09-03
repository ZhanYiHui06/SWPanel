import { readFileSync } from "node:fs";

import type {
  InputAdapterFailureCode,
  InputAdapterImageFormat,
  InputAdapterPageSelection,
  InputAdapterProvenance,
  InputAdapterRequest,
  InputAdapterResult,
  InputAdapterScenario,
  InputAdapterSourceRef,
  RunFailureCode
} from "@swpanel/domain";
import { isInputAdapterScenario, isInputAdapterSuccess, isTestOnlyScenario } from "@swpanel/domain";
import {
  INPUT_ADAPTATION_CONTRACT_VERSION,
  validateInputAdapterProvenance,
  validateInputAdapterRequest,
  validateInputAdapterResult
} from "@swpanel/contracts";

import { InvalidArgumentError, RunnerInvariantError } from "../errors.js";
import type { StoredRunFile } from "../ledger/run-workspace-ledger.js";

/**
 * Phase 4 (P4-1) Input Adapter boundary of the Runner. SWPanel converts product
 * inputs (PDF / DWG / DXF) into the JPG / PNG image the modeling Skill accepts;
 * the original drawing file is IMMUTABLE — an adapter only ever produces derived
 * images plus provenance inside the attempt workspace and never overwrites the
 * source (architecture.md §8).
 *
 * The boundary is deterministic and injectable: scenario selection exists ONLY
 * at Runner construction / test harness configuration (mirroring the Fake
 * Executor scenario idiom) and is never exposed to the Renderer. The pure
 * `@swpanel/domain` Input Adapter model describes the shapes; the strict
 * `@swpanel/contracts` validators enforce the serialized contract — every
 * request is validated on the way in and every result (including the persisted
 * provenance document) is validated before it leaves the adapter.
 */

/**
 * The deterministic adapter scenario of the normal product path. The default
 * PDF path never invents a page selection: without an explicit request
 * selection the provenance records no page/layout assertion, so it can never
 * falsely claim an inspected one-page source or a silently chosen page.
 */
export const DEFAULT_INPUT_ADAPTER_SCENARIO: InputAdapterScenario = "single-page-pdf";

/** Identity of the deterministic fake adapter (non-test-only scenarios). */
export const INPUT_ADAPTER_ID = "swpanel-fake-input-adapter" as const;

/** Identity of the synthetic DWG/DXF adapter: explicitly marked test-only. */
export const TEST_ONLY_INPUT_ADAPTER_ID = "swpanel-fake-dwg-dxf-adapter-test-only" as const;

/** Version of the deterministic fake adapter implementation. */
export const INPUT_ADAPTER_VERSION = "1.0.0" as const;

/** Deterministic page count the fake multi-page PDF scenarios expose. */
export const FAKE_MULTI_PAGE_PDF_TOTAL_PAGES = 5 as const;

/** The narrow attempt-workspace write surface an adapter needs. */
export interface InputAdapterWorkspace {
  writeOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
    content: Buffer;
  }): StoredRunFile;
}

/**
 * The resolved immutable original source of a Run handed to the executor's
 * PREPARING integration: revision source-file metadata + the absolute path of
 * the verified ledger copy the adapter reads (never modifies).
 */
export interface InputAdapterSource {
  source: InputAdapterSourceRef;
  absolutePath: string;
}

/** Everything one deterministic conversion of one attempt needs. */
export interface InputAdapterContext {
  runId: string;
  attemptSequence: number;
  /** Identity + hash of the immutable original drawing file. */
  source: InputAdapterSourceRef;
  /** Absolute path of the immutable original file the adapter reads. */
  sourceAbsolutePath: string;
  outputFormat: InputAdapterImageFormat;
  /** Explicit page/layout selection; REQUIRED for multi-page sources. */
  pageSelection?: InputAdapterPageSelection;
  workspace: InputAdapterWorkspace;
}

/**
 * The injectable Input Adapter boundary. Implementations must never modify the
 * original source file and must return a contract-valid result (success with
 * provenance, or a structured failure).
 */
export interface InputAdapter {
  adapt(context: InputAdapterContext): InputAdapterResult;
}

/** Default source reader: reads the immutable original file or null. */
export function defaultReadSourceBytes(absolutePath: string): Buffer | null {
  try {
    return readFileSync(absolutePath);
  } catch {
    return null;
  }
}

/**
 * Maps an adapter-level failure classification onto the Run-level failure code
 * (domain input-adapter model): unsupported source formats are
 * `INPUT_UNSUPPORTED`, every other conversion failure is `INPUT_ADAPTER_FAILED`.
 */
export function mapInputAdapterFailureCode(code: InputAdapterFailureCode): RunFailureCode {
  return code === "UNSUPPORTED_SOURCE_FORMAT" ? "INPUT_UNSUPPORTED" : "INPUT_ADAPTER_FAILED";
}

/** Deterministic derived-image bytes: header over scenario + source hash. */
function derivedImageBytes(
  scenario: InputAdapterScenario,
  sourceSha256: string,
  label: string
): Buffer {
  const header = Buffer.from(
    `SWPanel fake input adapter derived image\nscenario=${scenario}\nlabel=${label}\n` +
      `sourceSha256=${sourceSha256}\n`,
    "utf8"
  );
  return Buffer.concat([header, Buffer.alloc(1024, 0x4d)]);
}

/** Deterministic image dimensions per scenario family. */
function imageDimensions(scenario: InputAdapterScenario): {
  widthPx: number;
  heightPx: number;
  dpi: number;
} {
  if (scenario === "png-jpg-passthrough") {
    return { widthPx: 1240, heightPx: 1754, dpi: 150 };
  }
  return { widthPx: 2480, heightPx: 3508, dpi: 300 };
}

function canonicalIso(value: Date): string {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(ms)) {
    throw new RunnerInvariantError("The injected clock returned a non-finite timestamp");
  }
  return new Date(ms).toISOString();
}

export interface FakeInputAdapterOptions {
  /** Deterministic scenario matrix selection (Runner construction / test harness only). */
  scenario: InputAdapterScenario;
  /** Deterministic clock for provenance timestamps (defaults to the wall clock). */
  now?: () => Date;
  /** Injectable source reader (tests stub it); defaults to the real file read. */
  readSourceBytes?: (absolutePath: string) => Buffer | null;
}

/**
 * The deterministic fake Input Adapter of Phase 4 (P4-1). It simulates the
 * conversion paths the product targets:
 *
 * - `png-jpg-passthrough`: raster input passes through to JPG;
 * - `single-page-pdf`: the default PDF path. The fake NEVER inspects the
 *   source, so it never invents a page selection: an explicit request
 *   selection (page 1 of 1) is echoed verbatim, otherwise the provenance
 *   records NO page/layout assertion (with a warning) — the adapter never
 *   falsely asserts an inspected one-page source and never silently picks a
 *   page among unknown/multi-page input. A contradicting explicit selection
 *   fails closed with `PAGE_SELECTION_REQUIRED`;
 * - `multi-page-pdf-selected-page`: multi-page PDF converted ONLY with an
 *   explicit page selection — an adapter never silently picks a page, so
 *   missing selection fails closed with `PAGE_SELECTION_REQUIRED`;
 * - `multi-page-pdf-no-page-selected`: deterministic `PAGE_SELECTION_REQUIRED`
 *   failure (the fail-closed path);
 * - `dwg-dxf-synthetic-test-only`: synthetic DWG/DXF conversion marked
 *   test-only — a `-test-only` adapter id;
 * - `unsupported-source` / `missing-corrupt-source` / `adapter-failure`:
 *   structured failure simulations.
 *
 * EVERY success of this synthetic Phase 4 adapter is marked
 * `productionVerified: false` — no conversion path is verified against
 * approved production drawings — and carries a human-readable warning. Every
 * success is written into the attempt workspace through the workspace ledger
 * (derived image, preview and the validated `adapter-result.json` envelope)
 * and every result passes the strict contracts validator before it is
 * returned or persisted.
 */
export class FakeInputAdapter implements InputAdapter {
  private readonly scenario: InputAdapterScenario;
  private readonly now: () => Date;
  private readonly readSourceBytes: (absolutePath: string) => Buffer | null;

  constructor(options: FakeInputAdapterOptions) {
    if (!isInputAdapterScenario(options.scenario)) {
      throw new InvalidArgumentError(
        `inputAdapterScenario must be a known input adapter scenario, got ${String(options.scenario)}`
      );
    }
    this.scenario = options.scenario;
    this.now = options.now ?? (() => new Date());
    this.readSourceBytes = options.readSourceBytes ?? defaultReadSourceBytes;
  }

  adapt(context: InputAdapterContext): InputAdapterResult {
    // Explicit page/layout selections must be well-formed BEFORE the strict
    // request validation: an out-of-range selection is converted into the
    // structured PAGE_SELECTION_REQUIRED failure (fail closed), never into a
    // request-validation throw that would crash the serial queue.
    if (context.pageSelection !== undefined) {
      const selection = context.pageSelection;
      const wellFormed =
        Number.isSafeInteger(selection.pageNumber) &&
        Number.isSafeInteger(selection.totalPages) &&
        selection.pageNumber >= 1 &&
        selection.totalPages >= 1 &&
        selection.pageNumber <= selection.totalPages;
      if (!wellFormed) {
        return {
          ok: false,
          error: {
            code: "PAGE_SELECTION_REQUIRED",
            message: "页选择无效：pageNumber 必须在 1..totalPages 范围内；多页 PDF 必须显式选择有效页"
          }
        };
      }
    }
    // The request boundary is validated by the strict contracts validator: an
    // internally misbuilt request is an invariant error, never a silent pass.
    let request: InputAdapterRequest;
    try {
      request = validateInputAdapterRequest({
        source: context.source,
        outputFormat: context.outputFormat,
        ...(context.pageSelection === undefined ? {} : { pageSelection: context.pageSelection })
      });
    } catch (error) {
      throw new RunnerInvariantError(
        `input adapter received an invalid request: ${errorMessage(error)}`,
        { runId: context.runId }
      );
    }
    // Deterministic scenario failures need no source read.
    switch (this.scenario) {
      case "unsupported-source":
        return {
          ok: false,
          error: {
            code: "UNSUPPORTED_SOURCE_FORMAT",
            message: "来源格式不受支持（Fake 场景：模拟不受支持的源格式）"
          }
        };
      case "missing-corrupt-source":
        return {
          ok: false,
          error: {
            code: "SOURCE_MISSING_OR_CORRUPT",
            message: "原始图纸缺失或损坏，无法转换（Fake 场景）"
          }
        };
      case "adapter-failure":
        return {
          ok: false,
          error: {
            code: "CONVERSION_FAILED",
            message: "输入适配转换失败（Fake 场景：模拟转换器故障）"
          }
        };
      case "multi-page-pdf-no-page-selected":
        // Fail closed: the source is multi-page and no explicit selection was
        // supplied — an adapter must never silently choose an arbitrary page.
        return {
          ok: false,
          error: {
            code: "PAGE_SELECTION_REQUIRED",
            message:
              `多页 PDF 必须显式选择要转换的页（共 ${FAKE_MULTI_PAGE_PDF_TOTAL_PAGES} 页）；` +
              "适配器绝不静默挑选任意页"
          }
        };
      case "png-jpg-passthrough":
      case "single-page-pdf":
      case "multi-page-pdf-selected-page":
      case "dwg-dxf-synthetic-test-only":
        break;
    }

    // Conversion-attempting scenarios read the immutable original file; an
    // unreadable or empty source fails closed (data-driven, independent of the
    // scenario script).
    const sourceBytes = this.readSourceBytes(context.sourceAbsolutePath);
    if (sourceBytes === null || sourceBytes.byteLength === 0) {
      return {
        ok: false,
        error: {
          code: "SOURCE_MISSING_OR_CORRUPT",
          message: "原始图纸缺失或损坏（源文件不可读或为空），无法转换"
        }
      };
    }

    // Page/layout selection truthfulness: the fake NEVER inspects the source,
    // so it can only report a `pageSelection` the REQUEST explicitly supplied
    // (echoed verbatim). It never invents a page selection — the default PDF
    // path must not falsely assert an inspected one-page source and must not
    // silently pick a page among unknown/multi-page input.
    let pageSelection: InputAdapterPageSelection | undefined;
    if (this.scenario === "single-page-pdf") {
      const selected = request.pageSelection;
      if (selected !== undefined) {
        // The scenario simulates a known one-page source: the only truthful
        // explicit selection is page 1 of 1; anything else contradicts the
        // simulated source and fails closed instead of asserting it.
        if (selected.pageNumber !== 1 || selected.totalPages !== 1) {
          return {
            ok: false,
            error: {
              code: "PAGE_SELECTION_REQUIRED",
              message:
                "单页 PDF 场景只接受显式选择第 1 页（共 1 页）；" +
                "页选择与模拟源不符，适配器绝不静默挑选任意页"
            }
          };
        }
        pageSelection = { pageNumber: 1, totalPages: 1 };
      }
      // No explicit selection: the provenance records no page/layout assertion
      // (a warning is added in completeSuccess) instead of claiming a page.
    } else if (this.scenario === "multi-page-pdf-selected-page") {
      const selected = request.pageSelection;
      if (selected === undefined) {
        return {
          ok: false,
          error: {
            code: "PAGE_SELECTION_REQUIRED",
            message:
              `多页 PDF 必须显式选择要转换的页（共 ${FAKE_MULTI_PAGE_PDF_TOTAL_PAGES} 页）；` +
              "适配器绝不静默挑选任意页"
          }
        };
      }
      if (selected.pageNumber < 1 || selected.pageNumber > FAKE_MULTI_PAGE_PDF_TOTAL_PAGES) {
        return {
          ok: false,
          error: {
            code: "PAGE_SELECTION_REQUIRED",
            message:
              `页选择超出范围：第 ${selected.pageNumber} 页，共 ${FAKE_MULTI_PAGE_PDF_TOTAL_PAGES} 页；` +
              "必须显式选择有效页"
          }
        };
      }
      pageSelection = { pageNumber: selected.pageNumber, totalPages: FAKE_MULTI_PAGE_PDF_TOTAL_PAGES };
    }

    const testOnly = isTestOnlyScenario(this.scenario);
    if (testOnly) {
      // A test-only scenario must never claim production verification (domain
      // invariant); the adapter id itself carries the explicit marker. The
      // productionVerified guard itself lives in completeSuccess (it applies
      // to EVERY synthetic success).
      const result = this.completeSuccess(context, request, pageSelection, testOnly);
      if (!result.ok) return result;
      if (result.provenance.adapterId !== TEST_ONLY_INPUT_ADAPTER_ID) {
        throw new RunnerInvariantError(
          `test-only scenario ${this.scenario} must use the test-only adapter identity`
        );
      }
      return result;
    }
    return this.completeSuccess(context, request, pageSelection, false);
  }

  /**
   * Writes the derived image + preview + validated result envelope into the
   * attempt workspace and returns the strictly validated success result.
   */
  private completeSuccess(
    context: InputAdapterContext,
    request: InputAdapterRequest,
    pageSelection: InputAdapterPageSelection | undefined,
    testOnly: boolean
  ): InputAdapterResult {
    const extension = request.outputFormat === "JPG" ? "jpg" : "png";
    const imagePath = `input/drawing.${extension}`;
    const previewPath = "input/preview.png";
    const imageBytes = derivedImageBytes(this.scenario, request.source.sha256, "derived");
    const previewBytes = derivedImageBytes(this.scenario, request.source.sha256, "preview");
    const dimensions = imageDimensions(this.scenario);

    const image = context.workspace.writeOwnedFile({
      runId: context.runId,
      attemptSequence: context.attemptSequence,
      relativePath: imagePath,
      content: imageBytes
    });
    context.workspace.writeOwnedFile({
      runId: context.runId,
      attemptSequence: context.attemptSequence,
      relativePath: previewPath,
      content: previewBytes
    });

    // Every synthetic Phase 4 conversion is explicitly unverified: warnings
    // make it human-readable and the machine-readable flag is always false.
    const warnings: string[] = ["synthetic conversion, not production-verified"];
    if (testOnly) {
      warnings.push(
        "DWG/DXF conversion is a Phase 4 spike: not verified against approved production drawings"
      );
    } else if (this.scenario === "png-jpg-passthrough") {
      warnings.push("passthrough conversion, no page/layout interpretation performed");
    } else if (this.scenario === "single-page-pdf" && pageSelection === undefined) {
      warnings.push(
        "page structure not inspected; no page/layout assertion made — convert only with an explicit page selection"
      );
    }

    const provenance: InputAdapterProvenance = {
      adapterId: testOnly ? TEST_ONLY_INPUT_ADAPTER_ID : INPUT_ADAPTER_ID,
      adapterVersion: INPUT_ADAPTER_VERSION,
      sourceFileSha256: request.source.sha256,
      ...(pageSelection === undefined ? {} : { pageSelection }),
      output: {
        fileName: `drawing.${extension}`,
        sha256: image.sha256,
        sizeBytes: image.sizeBytes,
        widthPx: dimensions.widthPx,
        heightPx: dimensions.heightPx,
        dpi: dimensions.dpi,
        relativePath: imagePath
      },
      warnings,
      unsupportedEntities: [],
      previewRelativePath: previewPath,
      // M1: no synthetic path may claim production verification — the Phase 4
      // fake adapter is never verified against approved production drawings.
      productionVerified: false,
      createdAt: canonicalIso(this.now())
    };
    // Strict contract validation before anything leaves the adapter; the
    // persisted envelope is the validated shape (defensive catch: a corrupted
    // deterministic output must fail closed as OUTPUT_VALIDATION_FAILED).
    let validated: InputAdapterProvenance;
    try {
      validated = validateInputAdapterProvenance(provenance);
    } catch {
      return {
        ok: false,
        error: {
          code: "OUTPUT_VALIDATION_FAILED",
          message: "适配器输出未通过契约校验（OUTPUT_VALIDATION_FAILED）"
        }
      };
    }
    // Fail-closed guard for M1: a synthetic success that ever claims
    // `productionVerified: true` is an invariant violation and must never
    // leave the adapter.
    if (validated.productionVerified) {
      throw new RunnerInvariantError(
        `FakeInputAdapter scenario ${this.scenario} must never claim productionVerified: ` +
          "no Phase 4 synthetic conversion is verified against approved production drawings"
      );
    }
    const envelope = {
      contractVersion: INPUT_ADAPTATION_CONTRACT_VERSION,
      ok: true as const,
      provenance: validated
    };
    const validatedEnvelope = validateInputAdapterResult(envelope);
    // Defensive: the deterministic envelope is built with `ok: true`, so a
    // failure here is impossible; fail closed instead of handing out a result
    // that violates the contract.
    if (!isInputAdapterSuccess(validatedEnvelope)) {
      return {
        ok: false,
        error: {
          code: "OUTPUT_VALIDATION_FAILED",
          message: "适配器输出未通过契约校验（OUTPUT_VALIDATION_FAILED）"
        }
      };
    }
    // Persist the versioned envelope (contractVersion + ok + validated
    // provenance) so the stored document round-trips the strict validator.
    const persistedEnvelope = {
      contractVersion: INPUT_ADAPTATION_CONTRACT_VERSION,
      ok: true as const,
      provenance: validatedEnvelope.provenance
    };
    context.workspace.writeOwnedFile({
      runId: context.runId,
      attemptSequence: context.attemptSequence,
      relativePath: "input/adapter-result.json",
      content: Buffer.from(JSON.stringify(persistedEnvelope, null, 2), "utf8")
    });
    return { ok: true, provenance: validatedEnvelope.provenance };
  }
}

/** Error message extraction for injected reader / validation failures. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
