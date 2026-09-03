import { describe, expect, it } from "vitest";

import {
  INPUT_ADAPTER_FAILURE_CODES,
  INPUT_ADAPTER_IMAGE_FORMATS,
  INPUT_ADAPTER_SCENARIOS,
  INPUT_ADAPTER_TEST_ONLY_SCENARIOS,
  isInputAdapterFailure,
  isInputAdapterScenario,
  isInputAdapterSuccess,
  isTestOnlyResult,
  isTestOnlyScenario,
  type InputAdapterProvenance,
  type InputAdapterResult
} from "./input-adapter.js";

describe("input adapter model", () => {
  it("defines the canonical adapter scenarios", () => {
    expect(INPUT_ADAPTER_SCENARIOS).toEqual([
      "png-jpg-passthrough",
      "single-page-pdf",
      "multi-page-pdf-selected-page",
      "multi-page-pdf-no-page-selected",
      "dwg-dxf-synthetic-test-only",
      "unsupported-source",
      "missing-corrupt-source",
      "adapter-failure"
    ]);
  });

  it("defines the skill-accepted image formats", () => {
    expect(INPUT_ADAPTER_IMAGE_FORMATS).toEqual(["JPG", "PNG"]);
  });

  it("defines the structured adapter failure codes", () => {
    expect(INPUT_ADAPTER_FAILURE_CODES).toEqual([
      "UNSUPPORTED_SOURCE_FORMAT",
      "SOURCE_MISSING_OR_CORRUPT",
      "PAGE_SELECTION_REQUIRED",
      "CONVERSION_FAILED",
      "OUTPUT_VALIDATION_FAILED"
    ]);
  });

  it("flags only the synthetic DWG/DXF conversion as test-only", () => {
    expect(INPUT_ADAPTER_TEST_ONLY_SCENARIOS).toEqual(["dwg-dxf-synthetic-test-only"]);
    expect(isTestOnlyScenario("dwg-dxf-synthetic-test-only")).toBe(true);
    expect(isTestOnlyScenario("single-page-pdf")).toBe(false);
  });

  it("guards scenario membership", () => {
    expect(isInputAdapterScenario("multi-page-pdf-selected-page")).toBe(true);
    expect(isInputAdapterScenario("dwg-dxf-synthetic-test-only")).toBe(true);
    expect(isInputAdapterScenario("solidworks-model")).toBe(false);
    expect(isInputAdapterScenario(42)).toBe(false);
  });

  it("serializes a success result with provenance over JSON unchanged", () => {
    const result: InputAdapterResult = {
      ok: true,
      provenance: {
        adapterId: "swpanel-fake-pdf-adapter",
        adapterVersion: "1.0.0",
        sourceFileSha256: "a".repeat(64),
        pageSelection: { pageNumber: 2, totalPages: 5 },
        output: {
          fileName: "page-2.png",
          sha256: "b".repeat(64),
          sizeBytes: 4096,
          widthPx: 2480,
          heightPx: 3508,
          dpi: 300,
          relativePath: "input/page-2.png"
        },
        renderer: { id: "swpanel-python-pdfium-rasterizer", version: "pypdfium2 4.30.0" },
        warnings: ["embedded fonts substituted"],
        unsupportedEntities: ["hatching pattern"],
        previewRelativePath: "input/preview-page-2.png",
        productionVerified: true,
        createdAt: "2026-08-13T10:00:00.000Z"
      }
    };
    expect(isInputAdapterSuccess(result)).toBe(true);
    expect(isInputAdapterFailure(result)).toBe(false);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result.provenance.renderer).toEqual({
      id: "swpanel-python-pdfium-rasterizer",
      version: "pypdfium2 4.30.0"
    });
  });

  it("classifies a structured failure result", () => {
    const result: InputAdapterResult = {
      ok: false,
      error: { code: "PAGE_SELECTION_REQUIRED", message: "multi-page source needs an explicit page" }
    };
    expect(isInputAdapterFailure(result)).toBe(true);
    expect(isInputAdapterSuccess(result)).toBe(false);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("flags provenance of the synthetic DWG/DXF adapter as test-only", () => {
    const provenance: InputAdapterProvenance = {
      adapterId: "swpanel-fake-dwg-adapter",
      adapterVersion: "1.0.0",
      sourceFileSha256: "c".repeat(64),
      output: {
        fileName: "converted.png",
        sha256: "d".repeat(64),
        sizeBytes: 2048,
        widthPx: 1240,
        heightPx: 1754,
        dpi: 150,
        relativePath: "input/converted.png"
      },
      warnings: ["synthetic conversion, not production-verified"],
      unsupportedEntities: [],
      productionVerified: false,
      createdAt: "2026-08-13T10:00:00.000Z"
    };
    expect(isTestOnlyResult(provenance)).toBe(true);
    expect(isTestOnlyResult({ ...provenance, productionVerified: true })).toBe(false);
  });
});
