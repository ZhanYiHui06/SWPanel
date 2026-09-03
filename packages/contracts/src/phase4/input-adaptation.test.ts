import { describe, expect, it } from "vitest";

import type {
  InputAdapterProvenance,
  InputAdapterRequest,
  InputAdapterResult
} from "@swpanel/domain";
import {
  INPUT_ADAPTATION_CONTRACT_VERSION,
  Phase4ContractError,
  validateInputAdapterProvenance,
  validateInputAdapterRequest,
  validateInputAdapterResult
} from "../index.js";

function validRequest(): InputAdapterRequest {
  return {
    source: {
      fileName: "PDJF001.01.pdf",
      format: "PDF",
      sizeBytes: 2_048_000,
      sha256: "a".repeat(64)
    },
    outputFormat: "PNG",
    pageSelection: { pageNumber: 2, totalPages: 5 }
  };
}

function validProvenance(): InputAdapterProvenance {
  return {
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
  };
}

function expectCode(fn: () => unknown, code: Phase4ContractError["code"]): void {
  expect(fn).toThrowError(expect.objectContaining({ code }));
}

describe("input adaptation contract", () => {
  it("pins the contract version", () => {
    expect(INPUT_ADAPTATION_CONTRACT_VERSION).toBe(2);
  });

  it("accepts a well-formed request and round-trips over JSON", () => {
    const request = validRequest();
    expect(validateInputAdapterRequest(request)).toEqual(request);
    expect(JSON.parse(JSON.stringify(validateInputAdapterRequest(request)))).toEqual(request);
  });

  it("accepts a request without an explicit page selection (single-page source)", () => {
    const request = validRequest();
    delete (request as { pageSelection?: unknown }).pageSelection;
    expect(validateInputAdapterRequest(request)).toEqual(request);
  });

  it("rejects unknown request fields, bad formats and bad hashes", () => {
    expectCode(
      () => validateInputAdapterRequest({ ...validRequest(), quality: "high" }),
      "UNKNOWN_FIELD"
    );
    expectCode(
      () =>
        validateInputAdapterRequest({
          ...validRequest(),
          source: { ...validRequest().source, format: "SVG" }
        }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateInputAdapterRequest({ ...validRequest(), outputFormat: "TIFF" }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () =>
        validateInputAdapterRequest({
          ...validRequest(),
          source: { ...validRequest().source, sha256: "short" }
        }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects an inconsistent page selection", () => {
    expectCode(
      () =>
        validateInputAdapterRequest({
          ...validRequest(),
          pageSelection: { pageNumber: 6, totalPages: 5 }
        }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () =>
        validateInputAdapterRequest({
          ...validRequest(),
          pageSelection: { pageNumber: 0, totalPages: 5 }
        }),
      "INVALID_CONTRACT"
    );
  });

  it("accepts a well-formed provenance and round-trips over JSON", () => {
    const provenance = validProvenance();
    expect(validateInputAdapterProvenance(provenance)).toEqual(provenance);
    expect(JSON.parse(JSON.stringify(validateInputAdapterProvenance(provenance)))).toEqual(provenance);
  });

  it("rejects unknown provenance fields and malformed output metadata", () => {
    expectCode(
      () => validateInputAdapterProvenance({ ...validProvenance(), toolchain: "poppler" }),
      "UNKNOWN_FIELD"
    );
    expectCode(
      () =>
        validateInputAdapterProvenance({
          ...validProvenance(),
          output: { ...validProvenance().output, dpi: 0 }
        }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () =>
        validateInputAdapterProvenance({
          ...validProvenance(),
          output: { ...validProvenance().output, widthPx: 0 }
        }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () =>
        validateInputAdapterProvenance({
          ...validProvenance(),
          output: { ...validProvenance().output, sha256: "zz" }
        }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects a non-boolean productionVerified flag", () => {
    expectCode(
      () => validateInputAdapterProvenance({ ...validProvenance(), productionVerified: "yes" }),
      "INVALID_CONTRACT"
    );
  });

  it("accepts a provenance WITHOUT a renderer (synthetic adapters have no engine)", () => {
    const provenance = validProvenance();
    delete (provenance as { renderer?: unknown }).renderer;
    expect(validateInputAdapterProvenance(provenance)).toEqual(provenance);
    expect(JSON.parse(JSON.stringify(validateInputAdapterProvenance(provenance)))).toEqual(
      provenance
    );
  });

  it("strictly validates the structured renderer metadata (contract v2)", () => {
    const renderer = { id: "swpanel-python-pdfium-rasterizer", version: "pypdfium2 4.30.0" };
    expect(validateInputAdapterProvenance({ ...validProvenance(), renderer }).renderer).toEqual(
      renderer
    );
    expectCode(
      () => validateInputAdapterProvenance({ ...validProvenance(), renderer: { ...renderer, dpi: 300 } }),
      "UNKNOWN_FIELD"
    );
    expectCode(
      () => validateInputAdapterProvenance({ ...validProvenance(), renderer: { ...renderer, id: "" } }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateInputAdapterProvenance({ ...validProvenance(), renderer: { ...renderer, version: "" } }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateInputAdapterProvenance({ ...validProvenance(), renderer: "pypdfium2 4.30.0" }),
      "INVALID_CONTRACT"
    );
  });

  it("accepts a successful result carrying provenance", () => {
    const result: InputAdapterResult = { ok: true, provenance: validProvenance() };
    const wire = { contractVersion: INPUT_ADAPTATION_CONTRACT_VERSION, ...result };
    expect(validateInputAdapterResult(wire)).toEqual(result);
  });

  it("accepts a structured failure result", () => {
    const result: InputAdapterResult = {
      ok: false,
      error: { code: "PAGE_SELECTION_REQUIRED", message: "multi-page source needs an explicit page" }
    };
    const wire = { contractVersion: INPUT_ADAPTATION_CONTRACT_VERSION, ...result };
    expect(validateInputAdapterResult(wire)).toEqual(result);
  });

  it("rejects result version mismatch and cross-carrying success/failure fields", () => {
    const success = {
      contractVersion: INPUT_ADAPTATION_CONTRACT_VERSION,
      ok: true,
      provenance: validProvenance()
    };
    expectCode(() => validateInputAdapterResult({ ...success, contractVersion: 99 }), "VERSION_MISMATCH");
    expectCode(
      () => validateInputAdapterResult({ ...success, error: { code: "CONVERSION_FAILED", message: "x" } }),
      "INVALID_CONTRACT"
    );
    const failure = {
      contractVersion: INPUT_ADAPTATION_CONTRACT_VERSION,
      ok: false,
      error: { code: "CONVERSION_FAILED", message: "x" }
    };
    expectCode(
      () => validateInputAdapterResult({ ...failure, provenance: validProvenance() }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateInputAdapterResult({ ...failure, error: { code: "EXPLODED", message: "x" } }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects an adapter result without the ok discriminator", () => {
    expectCode(
      () => validateInputAdapterResult({ contractVersion: INPUT_ADAPTATION_CONTRACT_VERSION }),
      "INVALID_CONTRACT"
    );
  });
});
