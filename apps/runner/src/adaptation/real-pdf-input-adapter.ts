import { createHash } from "node:crypto";

import type {
  InputAdapterPageSelection,
  InputAdapterProvenance,
  InputAdapterRequest,
  InputAdapterResult
} from "@swpanel/domain";
import {
  INPUT_ADAPTATION_CONTRACT_VERSION,
  validateInputAdapterProvenance,
  validateInputAdapterRequest,
  validateInputAdapterResult
} from "@swpanel/contracts";

import { RunnerInvariantError } from "../errors.js";
import { defaultReadSourceBytes, type InputAdapter, type InputAdapterContext } from "./input-adapter.js";
import { redactSensitivePaths } from "./path-redaction.js";

/**
 * Phase 5 (Batch E) real repository-side PDF Input Adapter boundary. Unlike the
 * deterministic {@link FakeInputAdapter}, this adapter performs REAL conversion
 * work: it reads the immutable original PDF, verifies its recorded hash/size,
 * inspects the actual page count, applies the fail-closed page-selection rules
 * (architecture.md §8.2 — never silently pick a page) and writes the derived
 * PNG, the human-reviewable preview and the strictly validated
 * `adapter-result.json` through the attempt workspace ledger.
 *
 * The rasterization ENGINE is deliberately NOT coupled here: a clean injectable
 * {@link PdfRasterizer} boundary separates the SWPanel conversion contract from
 * the concrete renderer. Batch E now ships the concrete
 * {@link PythonPdfiumRasterizer} (the repository Python environment with
 * pypdfium2 4.30.0 + Pillow 11.3.0, invoked through the bundled helper
 * script); the rasterizer remains a constructor injection so tests and future
 * engines stay decoupled. Unit tests use a stub rasterizer and no approved
 * business PDF.
 *
 * Truthfulness contracts (identical to the fake adapter's):
 *
 * - the source bytes are re-hashed against the frozen snapshot BEFORE any
 *   conversion — a missing, empty or hash/size-mismatching source fails closed
 *   with `SOURCE_MISSING_OR_CORRUPT`, never silently converting wrong bytes;
 * - the source must actually be a PDF (`UNSUPPORTED_SOURCE_FORMAT` otherwise);
 * - a multi-page source without an explicit selection fails closed with
 *   `PAGE_SELECTION_REQUIRED` — the adapter never silently picks a page; an
 *   explicit selection that contradicts the ACTUAL inspected page count also
 *   fails closed;
 * - a single-page source (pageCount === 1) converts page 1 and truthfully
 *   records `pageSelection { pageNumber: 1, totalPages: 1 }` — the real
 *   adapter inspects the source, so unlike the fake it MAY assert the page
 *   structure it actually observed;
 * - EVERY conversion records the real renderer id/version, the actual rendered
 *   dimensions/DPI and the actual page count, and is `productionVerified:
 *   false` — this first local integration is not verified against approved
 *   production drawings (a success claiming `true` is an invariant violation).
 *
 * CONVERSION GATE, not preflight: the preflight capability gate evaluates only
 * the eight ENVIRONMENT capabilities and never covers PDF conversion. The
 * conversion gate is `input_adapter_succeeded` — the executor marks it ONLY
 * after this adapter's conversion succeeds. The adapter probes its rasterizer
 * availability FIRST (structured {@link PdfRasterizerAvailability}) and fails
 * closed with a structured `CONVERSION_FAILED` when the renderer is
 * unavailable; user-visible failure messages are REDACTED (never raw helper
 * stderr, never absolute temp/user paths — see {@link redactSensitivePaths}).
 */

/** Identity of the real PDF input adapter (never test-only in the synthetic sense). */
export const REAL_PDF_INPUT_ADAPTER_ID = "swpanel-real-pdf-input-adapter" as const;

/** Version of the real PDF input adapter implementation. */
export const REAL_PDF_INPUT_ADAPTER_VERSION = "1.0.0" as const;

/** Default output resolution of the real PDF adapter (high-resolution PNG). */
export const REAL_PDF_DEFAULT_DPI = 300 as const;

/** Structured rasterizer-level failure classification. */
export const PDF_RASTERIZER_FAILURE_CODES = ["INVALID_PDF", "RENDER_FAILED"] as const;
export type PdfRasterizerFailureCode = (typeof PDF_RASTERIZER_FAILURE_CODES)[number];

/** Result of inspecting the immutable PDF bytes. */
export type PdfInspectResult =
  | { ok: true; pageCount: number }
  | { ok: false; code: PdfRasterizerFailureCode; message: string };

export interface PdfRasterizeRequest {
  /** Bytes of the immutable original PDF (hash-verified by the adapter). */
  sourceBytes: Buffer;
  /** 1-based page number to rasterize. */
  pageNumber: number;
  /** Requested output resolution in DPI. */
  dpi: number;
}

/** Result of rasterizing one page: PNG bytes plus ACTUAL rendered metrics. */
export type PdfRasterizeResult =
  | {
      ok: true;
      /** PNG-encoded rasterized page bytes (non-empty). */
      image: Buffer;
      widthPx: number;
      heightPx: number;
      /** DPI the renderer actually produced (may differ from the request). */
      dpi: number;
      /** The 1-based page the renderer actually rendered (must echo the request). */
      pageNumber: number;
    }
  | { ok: false; code: PdfRasterizerFailureCode; message: string };

/**
 * Stable structured reasons a renderer reports itself unavailable. Redacted by
 * design: a reason is a fixed machine-readable code, never a path or stderr.
 */
export const RASTERIZER_UNAVAILABILITY_REASONS = [
  "PYTHON_UNAVAILABLE",
  "PDFIUM_UNAVAILABLE",
  "INVOCATION_FAILED"
] as const;
export type RasterizerUnavailabilityReason =
  (typeof RASTERIZER_UNAVAILABILITY_REASONS)[number];

/**
 * Result of the explicit availability/version probe every {@link PdfRasterizer}
 * implements. The adapter evaluates this at conversion time and fails closed,
 * structured, when the renderer is unavailable — availability is NEVER guessed
 * and NEVER a preflight capability (`input_adapter_succeeded`, marked by the
 * executor after the adaptation succeeds, is the conversion gate).
 */
export interface PdfRasterizerAvailability {
  /** True when the renderer environment is usable for conversion. */
  available: boolean;
  /** Exact renderer version when available; null when unavailable. */
  version: string | null;
  /** Stable structured reason when unavailable (redacted — never paths or stderr). */
  reason?: RasterizerUnavailabilityReason;
}

/**
 * The clean injectable PDF rasterization engine boundary. Implementations are
 * concrete renderers (engine + version recorded verbatim into provenance); the
 * adapter never interprets engine-internal failures and only maps the stable
 * structured codes onto the adapter failure vocabulary.
 */
export interface PdfRasterizer {
  /** Stable identity of the rendering engine (recorded in provenance). */
  readonly id: string;
  /** Exact version of the rendering engine (recorded in provenance). */
  readonly version: string;
  /** Explicit availability/version probe (the conversion-gate check). */
  probeAvailability(): PdfRasterizerAvailability;
  /** Inspects the PDF bytes: the actual total page count, or a structured failure. */
  inspect(sourceBytes: Buffer): PdfInspectResult;
  /** Rasterizes one 1-based page into PNG bytes with the actual metrics. */
  rasterize(input: PdfRasterizeRequest): PdfRasterizeResult;
}

export interface RealPdfInputAdapterOptions {
  /**
   * The rasterization engine. REQUIRED: the adapter never bundles an engine
   * itself — the concrete Batch E renderer is
   * {@link PythonPdfiumRasterizer} (pypdfium2 4.30.0 via the bundled helper);
   * unit tests inject a stub.
   */
  rasterizer: PdfRasterizer;
  /** Deterministic clock for provenance timestamps (defaults to the wall clock). */
  now?: () => Date;
  /** Injectable source reader (tests stub it); defaults to the real file read. */
  readSourceBytes?: (absolutePath: string) => Buffer | null;
  /** Requested output resolution in DPI (default {@link REAL_PDF_DEFAULT_DPI}). */
  dpi?: number;
}

/**
 * The real repository-side PDF Input Adapter (Batch E). Synchronous like the
 * `InputAdapter` boundary it implements — the injected rasterizer must also be
 * synchronous. Only PNG output is supported (the executor always requests PNG);
 * JPG requests fail closed with a truthful `CONVERSION_FAILED`.
 */
export class RealPdfInputAdapter implements InputAdapter {
  private readonly rasterizer: PdfRasterizer;
  private readonly now: () => Date;
  private readonly readSourceBytes: (absolutePath: string) => Buffer | null;
  private readonly dpi: number;

  constructor(options: RealPdfInputAdapterOptions) {
    this.rasterizer = options.rasterizer;
    this.now = options.now ?? (() => new Date());
    this.readSourceBytes = options.readSourceBytes ?? defaultReadSourceBytes;
    const dpi = options.dpi ?? REAL_PDF_DEFAULT_DPI;
    if (typeof dpi !== "number" || !Number.isFinite(dpi) || dpi <= 0) {
      throw new RunnerInvariantError("RealPdfInputAdapter dpi must be a positive number");
    }
    this.dpi = dpi;
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

    // Only PDF sources can be rasterized; everything else is unsupported.
    if (request.source.format !== "PDF") {
      return {
        ok: false,
        error: {
          code: "UNSUPPORTED_SOURCE_FORMAT",
          message: `来源格式不受支持：真实 PDF 适配器仅接受 PDF 源（实际为 ${request.source.format}）`
        }
      };
    }
    // Only PNG output is produced by this adapter (the executor always requests
    // PNG); a JPG request is a truthful structured failure, never a silent
    // format substitution.
    if (request.outputFormat !== "PNG") {
      return {
        ok: false,
        error: {
          code: "CONVERSION_FAILED",
          message: "真实 PDF 适配器仅支持 PNG 输出（JPG 输出未实现）"
        }
      };
    }

    // The conversion gate (NOT a preflight capability): the preflight gate
    // evaluates only environment capabilities and never covers PDF conversion
    // — `input_adapter_succeeded` is marked by the executor ONLY after this
    // adapter's conversion succeeds. Probe the renderer availability FIRST and
    // fail closed, structured, when it is unavailable: the user sees a stable
    // redacted message, never helper stderr or absolute temp/user paths.
    const availability = this.rasterizer.probeAvailability();
    if (!availability.available) {
      return {
        ok: false,
        error: {
          code: "CONVERSION_FAILED",
          message: "PDF 渲染器不可用（本地 Python/pypdfium2 渲染环境不可用），无法转换"
        }
      };
    }

    // Read the immutable original file; unreadable or empty fails closed
    // (data-driven, independent of any engine behaviour).
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

    // Source integrity: the bytes handed to the rasterizer must be exactly the
    // frozen snapshot's bytes (hash AND size). A mismatch proves the immutable
    // original was replaced/tampered between the ledger verification and the
    // conversion — fail closed, never convert wrong bytes.
    if (sourceBytes.byteLength !== request.source.sizeBytes) {
      return {
        ok: false,
        error: {
          code: "SOURCE_MISSING_OR_CORRUPT",
          message: "原始图纸缺失或损坏（源文件大小与冻结快照不一致），无法转换"
        }
      };
    }
    const actualSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    if (actualSha256 !== request.source.sha256) {
      return {
        ok: false,
        error: {
          code: "SOURCE_MISSING_OR_CORRUPT",
          message: "原始图纸缺失或损坏（源文件哈希与冻结快照不一致），无法转换"
        }
      };
    }

    // Inspect the ACTUAL page count of the immutable source. An unparseable
    // PDF is a corrupt source, not a conversion failure of a valid one. The
    // engine message is REDACTED before it reaches the user-visible surface.
    const inspection = this.rasterizer.inspect(sourceBytes);
    if (!inspection.ok) {
      return {
        ok: false,
        error: {
          code: "SOURCE_MISSING_OR_CORRUPT",
          message:
            `原始图纸缺失或损坏（PDF 无法解析：${redactSensitivePaths(inspection.message)}），无法转换`
        }
      };
    }
    const pageCount = inspection.pageCount;
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
      // A rasterizer reporting no pages for a parseable PDF is internally
      // inconsistent: fail closed instead of picking a page to convert.
      return {
        ok: false,
        error: {
          code: "CONVERSION_FAILED",
          message: "PDF 页数无效（渲染器报告 0 或非整数页数），无法转换"
        }
      };
    }

    // Page/layout selection truthfulness: the real adapter inspected the
    // source, so it knows the actual page count. An explicit selection must
    // MATCH the actual source; a multi-page source without an explicit
    // selection fails closed — an adapter never silently picks a page
    // (architecture.md §8.2).
    let pageNumber: number;
    if (request.pageSelection !== undefined) {
      const selection = request.pageSelection;
      const contradictsSource =
        selection.totalPages !== pageCount || selection.pageNumber < 1 || selection.pageNumber > pageCount;
      if (contradictsSource) {
        return {
          ok: false,
          error: {
            code: "PAGE_SELECTION_REQUIRED",
            message:
              `页选择与源不符：选择第 ${selection.pageNumber} 页（共 ${selection.totalPages} 页），` +
              `实际 PDF 共 ${pageCount} 页；适配器绝不静默挑选任意页`
          }
        };
      }
      pageNumber = selection.pageNumber;
    } else if (pageCount === 1) {
      // Single-page source without an explicit selection: convert page 1 and
      // truthfully record the inspected one-page structure.
      pageNumber = 1;
    } else {
      return {
        ok: false,
        error: {
          code: "PAGE_SELECTION_REQUIRED",
          message: `多页 PDF 必须显式选择要转换的页（实际共 ${pageCount} 页）；适配器绝不静默挑选任意页`
        }
      };
    }

    // Rasterize the selected page at the requested DPI; the renderer reports
    // the ACTUAL produced metrics (dimensions/DPI) which are recorded verbatim.
    const rasterized = this.rasterizer.rasterize({
      sourceBytes,
      pageNumber,
      dpi: this.dpi
    });
    if (!rasterized.ok) {
      // The engine message is REDACTED: never raw helper stderr, never paths.
      return {
        ok: false,
        error: {
          code: "CONVERSION_FAILED",
          message: `PDF 渲染失败（${redactSensitivePaths(rasterized.message)}），无法转换`
        }
      };
    }
    // Defensive: a renderer returning inconsistent metrics is an invariant
    // violation of the engine boundary — fail closed as a conversion failure.
    const outputInvalid =
      rasterized.image.byteLength === 0 ||
      !Number.isSafeInteger(rasterized.widthPx) ||
      rasterized.widthPx < 1 ||
      !Number.isSafeInteger(rasterized.heightPx) ||
      rasterized.heightPx < 1 ||
      typeof rasterized.dpi !== "number" ||
      !Number.isFinite(rasterized.dpi) ||
      rasterized.dpi <= 0 ||
      rasterized.pageNumber !== pageNumber;
    if (outputInvalid) {
      return {
        ok: false,
        error: {
          code: "OUTPUT_VALIDATION_FAILED",
          message: "渲染器输出无效（空图片、非法尺寸/DPI 或页号不一致），无法转换"
        }
      };
    }

    return this.completeSuccess(
      context,
      request,
      { pageNumber, totalPages: pageCount },
      rasterized.image,
      rasterized.widthPx,
      rasterized.heightPx,
      rasterized.dpi
    );
  }

  /**
   * Writes the derived PNG + preview + validated result envelope into the
   * attempt workspace and returns the strictly validated success result.
   */
  private completeSuccess(
    context: InputAdapterContext,
    request: InputAdapterRequest,
    pageSelection: InputAdapterPageSelection,
    imageBytes: Buffer,
    widthPx: number,
    heightPx: number,
    dpi: number
  ): InputAdapterResult {
    const imagePath = "input/drawing.png";
    const previewPath = "input/preview.png";
    const image = context.workspace.writeOwnedFile({
      runId: context.runId,
      attemptSequence: context.attemptSequence,
      relativePath: imagePath,
      content: imageBytes
    });
    // The human-reviewable preview of the derived conversion (same rasterized
    // page; provenance keeps the canonical paths).
    context.workspace.writeOwnedFile({
      runId: context.runId,
      attemptSequence: context.attemptSequence,
      relativePath: previewPath,
      content: imageBytes
    });

    // M1: this first local integration is NOT verified against approved
    // production drawings — the flag is always false and the warning makes it
    // human-readable. The renderer identity/version is recorded STRUCTURED
    // (contract v2) so consumers never have to parse it out of warning prose.
    const provenance: InputAdapterProvenance = {
      adapterId: REAL_PDF_INPUT_ADAPTER_ID,
      adapterVersion: REAL_PDF_INPUT_ADAPTER_VERSION,
      sourceFileSha256: request.source.sha256,
      pageSelection,
      output: {
        fileName: "drawing.png",
        sha256: image.sha256,
        sizeBytes: image.sizeBytes,
        widthPx,
        heightPx,
        dpi,
        relativePath: imagePath
      },
      renderer: {
        id: this.rasterizer.id,
        version: this.rasterizer.version
      },
      warnings: [
        `real PDF conversion, not production-verified: first local integration, ` +
          `not yet verified against approved production drawings (renderer ${this.rasterizer.id} ${this.rasterizer.version})`
      ],
      unsupportedEntities: [],
      previewRelativePath: previewPath,
      productionVerified: false,
      createdAt: canonicalIso(this.now())
    };
    // Strict contract validation before anything leaves the adapter; the
    // persisted envelope is the validated shape (defensive catch: a corrupted
    // output must fail closed as OUTPUT_VALIDATION_FAILED).
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
    // Fail-closed guard for M1: a real success that ever claims
    // `productionVerified: true` is an invariant violation and must never
    // leave the adapter.
    if (validated.productionVerified) {
      throw new RunnerInvariantError(
        `RealPdfInputAdapter must never claim productionVerified: ` +
          "no real PDF conversion is verified against approved production drawings yet"
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
    if (!validatedEnvelope.ok) {
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

function canonicalIso(value: Date): string {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(ms)) {
    throw new RunnerInvariantError("The injected clock returned a non-finite timestamp");
  }
  return new Date(ms).toISOString();
}

/** Error message extraction for injected reader / validation failures. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
