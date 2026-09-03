import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { InputAdapterSourceRef } from "@swpanel/domain";
import { validateInputAdapterResult } from "@swpanel/contracts";
import type { StoredRunFile } from "../ledger/run-workspace-ledger.js";
import type { InputAdapterContext, InputAdapterWorkspace } from "./input-adapter.js";
import {
  PDF_RASTERIZER_FAILURE_CODES,
  RASTERIZER_UNAVAILABILITY_REASONS,
  REAL_PDF_DEFAULT_DPI,
  REAL_PDF_INPUT_ADAPTER_ID,
  REAL_PDF_INPUT_ADAPTER_VERSION,
  RealPdfInputAdapter,
  type PdfInspectResult,
  type PdfRasterizeRequest,
  type PdfRasterizeResult,
  type PdfRasterizer,
  type PdfRasterizerAvailability
} from "./real-pdf-input-adapter.js";

const T0 = "2026-08-14T12:00:00.000Z";

/** Deterministic PDF-like bytes of the hermetic unit source (no real PDF). */
const SOURCE_BYTES = Buffer.from("SWPanel hermetic unit-test PDF bytes\n");

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const SOURCE: InputAdapterSourceRef = {
  fileName: "original.pdf",
  format: "PDF",
  sizeBytes: SOURCE_BYTES.byteLength,
  sha256: sha256Hex(SOURCE_BYTES)
};

/** In-memory attempt-workspace stub recording written files. */
class MemoryInputAdapterWorkspace implements InputAdapterWorkspace {
  readonly files = new Map<string, Buffer>();

  writeOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
    content: Buffer;
  }): StoredRunFile {
    const key = `${input.runId}/${input.attemptSequence}/${input.relativePath}`;
    this.files.set(key, input.content);
    return {
      relativePath: input.relativePath,
      absolutePath: key,
      sha256: sha256Hex(input.content),
      sizeBytes: input.content.byteLength
    };
  }
}

/** Deterministic stub rasterizer: hermetic, no real PDF engine involved. */
class StubPdfRasterizer implements PdfRasterizer {
  readonly id = "stub-rasterizer";
  readonly version = "1.0.0";
  readonly probeCalls: number[] = [];
  readonly inspectCalls: number[] = [];
  readonly rasterizeCalls: PdfRasterizeRequest[] = [];
  pageCount = 1;
  inspectResult: PdfInspectResult | null = null;
  rasterizeResult: PdfRasterizeResult | null = null;
  /** When null the stub probes as available (version "1.0.0"). */
  availability: PdfRasterizerAvailability | null = null;
  /** When true the stub simulates an engine that renders a different page. */
  liarPageNumber = false;

  probeAvailability(): PdfRasterizerAvailability {
    this.probeCalls.push(1);
    return this.availability ?? { available: true, version: "1.0.0" };
  }

  inspect(sourceBytes: Buffer): PdfInspectResult {
    this.inspectCalls.push(sourceBytes.byteLength);
    if (this.inspectResult !== null) return this.inspectResult;
    return { ok: true, pageCount: this.pageCount };
  }

  rasterize(input: PdfRasterizeRequest): PdfRasterizeResult {
    this.rasterizeCalls.push(input);
    if (this.rasterizeResult !== null) return this.rasterizeResult;
    return {
      ok: true,
      image: Buffer.from(`stub png of page ${input.pageNumber} at ${input.dpi} dpi\n`),
      widthPx: 2480,
      heightPx: 1754,
      dpi: input.dpi,
      pageNumber: this.liarPageNumber ? input.pageNumber + 1 : input.pageNumber
    };
  }
}

function adapterContext(
  overrides: Partial<InputAdapterContext> & { workspace?: MemoryInputAdapterWorkspace } = {}
): InputAdapterContext {
  return {
    runId: "run-1",
    attemptSequence: 1,
    source: SOURCE,
    sourceAbsolutePath: "C:/library/original.pdf",
    outputFormat: "PNG",
    workspace: overrides.workspace ?? new MemoryInputAdapterWorkspace(),
    ...overrides
  };
}

function runAdapter(
  rasterizer: PdfRasterizer,
  context: InputAdapterContext,
  options: { dpi?: number; readSourceBytes?: (absolutePath: string) => Buffer | null } = {}
) {
  return new RealPdfInputAdapter({
    rasterizer,
    now: () => new Date(T0),
    readSourceBytes: options.readSourceBytes ?? (() => SOURCE_BYTES),
    ...(options.dpi === undefined ? {} : { dpi: options.dpi })
  }).adapt(context);
}

describe("Phase 5 Batch E RealPdfInputAdapter", () => {
  it("defines the rasterizer failure vocabulary and adapter identity constants", () => {
    expect(PDF_RASTERIZER_FAILURE_CODES).toEqual(["INVALID_PDF", "RENDER_FAILED"]);
    expect(RASTERIZER_UNAVAILABILITY_REASONS).toEqual([
      "PYTHON_UNAVAILABLE",
      "PDFIUM_UNAVAILABLE",
      "INVOCATION_FAILED"
    ]);
    expect(REAL_PDF_INPUT_ADAPTER_ID).toBe("swpanel-real-pdf-input-adapter");
    expect(REAL_PDF_INPUT_ADAPTER_VERSION).toBe("1.0.0");
    expect(REAL_PDF_DEFAULT_DPI).toBe(300);
  });

  it("converts a single-page PDF without an explicit selection and records the inspected page structure", () => {
    const rasterizer = new StubPdfRasterizer();
    const workspace = new MemoryInputAdapterWorkspace();
    const context = adapterContext({ workspace });
    const result = runAdapter(rasterizer, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance).toMatchObject({
      adapterId: REAL_PDF_INPUT_ADAPTER_ID,
      adapterVersion: REAL_PDF_INPUT_ADAPTER_VERSION,
      sourceFileSha256: SOURCE.sha256,
      pageSelection: { pageNumber: 1, totalPages: 1 },
      productionVerified: false,
      previewRelativePath: "input/preview.png"
    });
    // The renderer identity/version is recorded STRUCTURED (contract v2),
    // never only inside warning prose.
    expect(result.provenance.renderer).toEqual({ id: "stub-rasterizer", version: "1.0.0" });
    expect(result.provenance.output).toMatchObject({
      fileName: "drawing.png",
      widthPx: 2480,
      heightPx: 1754,
      dpi: REAL_PDF_DEFAULT_DPI,
      relativePath: "input/drawing.png"
    });
    expect(result.provenance.output.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.provenance.output.sizeBytes).toBeGreaterThan(0);
    expect(result.provenance.warnings.join(" ")).toContain("not production-verified");
    expect(result.provenance.unsupportedEntities).toEqual([]);
    expect(result.provenance.createdAt).toBe(T0);

    // The real adapter probed the engine, inspected the source and
    // rasterized exactly page 1.
    expect(rasterizer.probeCalls).toHaveLength(1);
    expect(rasterizer.inspectCalls).toEqual([SOURCE_BYTES.byteLength]);
    expect(rasterizer.rasterizeCalls).toHaveLength(1);
    expect(rasterizer.rasterizeCalls[0]).toMatchObject({ pageNumber: 1, dpi: 300 });

    // Derived PNG, preview and the validated envelope are written through the
    // workspace abstraction; the source is never written or modified.
    expect(workspace.files.has("run-1/1/input/drawing.png")).toBe(true);
    expect(workspace.files.has("run-1/1/input/preview.png")).toBe(true);
    expect(workspace.files.has("run-1/1/input/adapter-result.json")).toBe(true);
    expect(workspace.files.size).toBe(3);
  });

  it("persists an envelope that round-trips the strict contracts validator", () => {
    const workspace = new MemoryInputAdapterWorkspace();
    const context = adapterContext({ workspace });
    const result = runAdapter(new StubPdfRasterizer(), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const persisted = JSON.parse(
      workspace.files.get("run-1/1/input/adapter-result.json")!.toString("utf8")
    ) as unknown;
    const validated = validateInputAdapterResult(persisted);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.provenance.productionVerified).toBe(false);
    }
  });

  it("converts an explicitly selected page of a multi-page PDF", () => {
    const rasterizer = new StubPdfRasterizer();
    rasterizer.pageCount = 3;
    const context = adapterContext({ pageSelection: { pageNumber: 2, totalPages: 3 } });
    const result = runAdapter(rasterizer, context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.pageSelection).toEqual({ pageNumber: 2, totalPages: 3 });
    expect(rasterizer.rasterizeCalls).toHaveLength(1);
    expect(rasterizer.rasterizeCalls[0]!.pageNumber).toBe(2);
  });

  it("fails closed with PAGE_SELECTION_REQUIRED when a multi-page PDF has no explicit selection", () => {
    const rasterizer = new StubPdfRasterizer();
    rasterizer.pageCount = 5;
    const workspace = new MemoryInputAdapterWorkspace();
    const context = adapterContext({ workspace });
    const result = runAdapter(rasterizer, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PAGE_SELECTION_REQUIRED");
    expect(result.error.message).toContain("实际共 5 页");
    // The adapter never rasterizes without a selection.
    expect(rasterizer.rasterizeCalls).toHaveLength(0);
    expect(workspace.files.size).toBe(0);
  });

  it("fails closed when an explicit selection contradicts the actual page count", () => {
    const rasterizer = new StubPdfRasterizer();
    rasterizer.pageCount = 1;
    const context = adapterContext({ pageSelection: { pageNumber: 1, totalPages: 3 } });
    const result = runAdapter(rasterizer, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PAGE_SELECTION_REQUIRED");
    expect(result.error.message).toContain("实际 PDF 共 1 页");
    expect(rasterizer.rasterizeCalls).toHaveLength(0);
  });

  it("fails closed when the selection is out of range of the actual page count", () => {
    const rasterizer = new StubPdfRasterizer();
    rasterizer.pageCount = 3;
    const context = adapterContext({ pageSelection: { pageNumber: 4, totalPages: 5 } });
    const result = runAdapter(rasterizer, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PAGE_SELECTION_REQUIRED");
    expect(result.error.message).toContain("实际 PDF 共 3 页");
    expect(rasterizer.rasterizeCalls).toHaveLength(0);
  });

  it("fails closed on an ill-formed explicit selection before any rasterization", () => {
    for (const pageSelection of [
      { pageNumber: 0, totalPages: 1 },
      { pageNumber: 2, totalPages: 1 },
      { pageNumber: 1.5, totalPages: 2 },
      { pageNumber: 1, totalPages: 0 }
    ]) {
      const rasterizer = new StubPdfRasterizer();
      const context = adapterContext({ pageSelection });
      const result = runAdapter(rasterizer, context);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PAGE_SELECTION_REQUIRED");
      }
      expect(rasterizer.inspectCalls).toHaveLength(0);
      expect(rasterizer.rasterizeCalls).toHaveLength(0);
    }
  });

  it("fails closed with SOURCE_MISSING_OR_CORRUPT when the source hash does not match the snapshot", () => {
    const rasterizer = new StubPdfRasterizer();
    const workspace = new MemoryInputAdapterWorkspace();
    const context = adapterContext({ workspace });
    const result = runAdapter(rasterizer, context, {
      // Deterministic bytes of the SAME size whose digest differs from
      // SOURCE.sha256 (a same-size tamper passes the size check and must be
      // caught by the hash check).
      readSourceBytes: () => Buffer.from(SOURCE_BYTES.toString("utf8").replace(/PDF/, "PDX"))
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SOURCE_MISSING_OR_CORRUPT");
    expect(result.error.message).toContain("哈希与冻结快照不一致");
    // Integrity is verified BEFORE the rasterizer ever sees the bytes.
    expect(rasterizer.inspectCalls).toHaveLength(0);
    expect(rasterizer.rasterizeCalls).toHaveLength(0);
    expect(workspace.files.size).toBe(0);
  });

  it("fails closed with SOURCE_MISSING_OR_CORRUPT when the source size does not match the snapshot", () => {
    const rasterizer = new StubPdfRasterizer();
    const context = adapterContext({
      source: { ...SOURCE, sizeBytes: SOURCE.sizeBytes + 1 }
    });
    const result = runAdapter(rasterizer, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SOURCE_MISSING_OR_CORRUPT");
    expect(rasterizer.inspectCalls).toHaveLength(0);
  });

  it("fails closed with SOURCE_MISSING_OR_CORRUPT when the source is unreadable or empty", () => {
    for (const readSourceBytes of [() => null, () => Buffer.alloc(0)]) {
      const rasterizer = new StubPdfRasterizer();
      const result = runAdapter(rasterizer, adapterContext(), { readSourceBytes });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("SOURCE_MISSING_OR_CORRUPT");
      }
      expect(rasterizer.inspectCalls).toHaveLength(0);
    }
  });

  it("fails closed with SOURCE_MISSING_OR_CORRUPT when the PDF cannot be parsed", () => {
    const rasterizer = new StubPdfRasterizer();
    rasterizer.inspectResult = { ok: false, code: "INVALID_PDF", message: "not a PDF" };
    const result = runAdapter(rasterizer, adapterContext());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SOURCE_MISSING_OR_CORRUPT");
    expect(result.error.message).toContain("not a PDF");
    expect(rasterizer.rasterizeCalls).toHaveLength(0);
  });

  it("fails closed with CONVERSION_FAILED when the renderer fails", () => {
    const rasterizer = new StubPdfRasterizer();
    rasterizer.rasterizeResult = { ok: false, code: "RENDER_FAILED", message: "out of memory" };
    const workspace = new MemoryInputAdapterWorkspace();
    const result = runAdapter(rasterizer, adapterContext({ workspace }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONVERSION_FAILED");
    expect(result.error.message).toContain("out of memory");
    expect(workspace.files.size).toBe(0);
  });

  it("fails closed with UNSUPPORTED_SOURCE_FORMAT for a non-PDF source", () => {
    const rasterizer = new StubPdfRasterizer();
    const context = adapterContext({ source: { ...SOURCE, format: "DWG" } });
    const result = runAdapter(rasterizer, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNSUPPORTED_SOURCE_FORMAT");
    expect(rasterizer.inspectCalls).toHaveLength(0);
  });

  it("fails closed with CONVERSION_FAILED for a JPG output request", () => {
    const rasterizer = new StubPdfRasterizer();
    const context = adapterContext({ outputFormat: "JPG" });
    const result = runAdapter(rasterizer, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONVERSION_FAILED");
    expect(result.error.message).toContain("仅支持 PNG");
    expect(rasterizer.inspectCalls).toHaveLength(0);
  });

  it("fails closed with OUTPUT_VALIDATION_FAILED when the renderer reports inconsistent metrics", () => {
    const emptyImage = new StubPdfRasterizer();
    emptyImage.rasterizeResult = {
      ok: true,
      image: Buffer.alloc(0),
      widthPx: 2480,
      heightPx: 1754,
      dpi: 300,
      pageNumber: 1
    };
    const emptyResult = runAdapter(emptyImage, adapterContext());
    expect(emptyResult.ok).toBe(false);
    if (emptyResult.ok) return;
    expect(emptyResult.error.code).toBe("OUTPUT_VALIDATION_FAILED");
    expect(emptyResult.error.message).toContain("空图片");

    const liarPage = new StubPdfRasterizer();
    liarPage.liarPageNumber = true;
    const liarResult = runAdapter(liarPage, adapterContext());
    expect(liarResult.ok).toBe(false);
    if (!liarResult.ok) {
      expect(liarResult.error.code).toBe("OUTPUT_VALIDATION_FAILED");
    }

    const badDpi = new StubPdfRasterizer();
    badDpi.rasterizeResult = {
      ok: true,
      image: Buffer.from("png"),
      widthPx: 2480,
      heightPx: 1754,
      dpi: 0,
      pageNumber: 1
    };
    expect(runAdapter(badDpi, adapterContext()).ok).toBe(false);
  });

  it("fails closed with PAGE_SELECTION_REQUIRED when the renderer reports an invalid page count", () => {
    const rasterizer = new StubPdfRasterizer();
    rasterizer.inspectResult = { ok: true, pageCount: 0 };
    const result = runAdapter(rasterizer, adapterContext());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONVERSION_FAILED");
    expect(result.error.message).toContain("页数无效");
  });

  it("forwards the injected DPI to the renderer and records the actual DPI", () => {
    const rasterizer = new StubPdfRasterizer();
    const context = adapterContext();
    const result = runAdapter(rasterizer, context, { dpi: 600 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(rasterizer.rasterizeCalls[0]!.dpi).toBe(600);
    expect(result.provenance.output.dpi).toBe(600);
  });

  it("records the actual dimensions reported by the renderer", () => {
    const rasterizer = new StubPdfRasterizer();
    rasterizer.rasterizeResult = {
      ok: true,
      image: Buffer.from("png"),
      widthPx: 3508,
      heightPx: 2480,
      dpi: 150,
      pageNumber: 1
    };
    const result = runAdapter(rasterizer, adapterContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.output).toMatchObject({ widthPx: 3508, heightPx: 2480, dpi: 150 });
  });

  it("never claims production verification on any success path", () => {
    const contexts = [
      adapterContext(),
      adapterContext({ pageSelection: { pageNumber: 1, totalPages: 1 } }),
      adapterContext({ pageSelection: { pageNumber: 3, totalPages: 3 } })
    ];
    for (const context of contexts) {
      const rasterizer = new StubPdfRasterizer();
      if (context.pageSelection !== undefined) rasterizer.pageCount = context.pageSelection.totalPages;
      const result = runAdapter(rasterizer, context);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.provenance.productionVerified).toBe(false);
      }
    }
  });

  it("fails early and structured when the rasterizer is unavailable (conversion gate, not preflight)", () => {
    const rasterizer = new StubPdfRasterizer();
    rasterizer.availability = { available: false, version: null, reason: "PDFIUM_UNAVAILABLE" };
    const workspace = new MemoryInputAdapterWorkspace();
    let readCalls = 0;
    const context = adapterContext({ workspace });
    const result = new RealPdfInputAdapter({
      rasterizer,
      now: () => new Date(T0),
      readSourceBytes: () => {
        readCalls += 1;
        return SOURCE_BYTES;
      }
    }).adapt(context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONVERSION_FAILED");
    expect(result.error.message).toContain("渲染器不可用");
    // Fail EARLY: the engine is probed before the source is read, inspected
    // or rasterized — nothing engine-dependent runs on an unavailable renderer.
    expect(rasterizer.probeCalls).toHaveLength(1);
    expect(rasterizer.inspectCalls).toHaveLength(0);
    expect(rasterizer.rasterizeCalls).toHaveLength(0);
    expect(readCalls).toBe(0);
    expect(workspace.files.size).toBe(0);
  });

  it("probes availability on every conversion and never skips the gate", () => {
    const rasterizer = new StubPdfRasterizer();
    const result = runAdapter(rasterizer, adapterContext());
    expect(result.ok).toBe(true);
    expect(rasterizer.probeCalls).toHaveLength(1);
  });

  it("redacts absolute temp/user paths in user-visible failure messages", () => {
    // A rasterizer message embedding the REAL machine temp dir (as the helper
    // traceback could) must never reach the user verbatim.
    const leakedPath = path.join(os.tmpdir(), "swpanel-pdfium-abc123", "source.pdf");
    const rasterizer = new StubPdfRasterizer();
    rasterizer.inspectResult = {
      ok: false,
      code: "INVALID_PDF",
      message: `PDF 无法解析: ${leakedPath}`
    };
    const result = runAdapter(rasterizer, adapterContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SOURCE_MISSING_OR_CORRUPT");
    expect(result.error.message).not.toContain(os.tmpdir());
    expect(result.error.message).toContain("<os-temp-dir>");

    const renderer = new StubPdfRasterizer();
    renderer.rasterizeResult = {
      ok: false,
      code: "RENDER_FAILED",
      message: `engine exploded near ${leakedPath}`
    };
    const renderResult = runAdapter(renderer, adapterContext());
    expect(renderResult.ok).toBe(false);
    if (renderResult.ok) return;
    expect(renderResult.error.code).toBe("CONVERSION_FAILED");
    expect(renderResult.error.message).not.toContain(os.tmpdir());
    expect(renderResult.error.message).toContain("<os-temp-dir>");
  });

  it("rejects an invalid adapter construction option", () => {
    expect(
      () =>
        new RealPdfInputAdapter({
          rasterizer: new StubPdfRasterizer(),
          dpi: 0
        })
    ).toThrow(/dpi/);
  });
});
