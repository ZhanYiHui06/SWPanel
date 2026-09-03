import { describe, expect, it } from "vitest";

import {
  Phase4ContractError,
  REQUIRED_RESULT_MANIFEST_ARTIFACTS,
  RESULT_MANIFEST_CONTRACT_VERSION,
  validateResultManifest,
  type ResultManifest
} from "../index.js";

/** Builds a valid artifact reference whose sha256 is a real 64-char hex digest. */
function artifactRef(seed: string) {
  const hex = [...seed].map((char) => char.charCodeAt(0) % 16).map((n) => n.toString(16));
  let sha256 = "";
  while (sha256.length < 64) {
    sha256 += hex.join("");
  }
  return {
    fileName: `${seed}.png`,
    relativePath: `output/${seed}.png`,
    sizeBytes: 1024,
    sha256: sha256.slice(0, 64)
  };
}

function validManifest(): ResultManifest {
  return {
    contractVersion: RESULT_MANIFEST_CONTRACT_VERSION,
    result: "completed",
    // The actual version the builder used; the contract is version-agnostic.
    solidWorksVersion: "2025",
    units: "mm",
    projectionDecision: "第三角投影",
    featureCount: 12,
    bodyCount: 1,
    rebuildStatus: "PASSED",
    unresolvedAssumptions: ["圆角半径按经验值 R3 处理"],
    productionVerified: false,
    artifacts: {
      sldprt: artifactRef("sldprt"),
      preview: artifactRef("preview"),
      dimensionLedger: artifactRef("ledger"),
      featurePlan: artifactRef("plan"),
      buildValidationLog: artifactRef("log"),
      builderSource: artifactRef("source"),
      processMp4: artifactRef("mp4")
    }
  };
}

function expectCode(fn: () => unknown, code: Phase4ContractError["code"]): void {
  expect(fn).toThrowError(expect.objectContaining({ code }));
}

describe("result manifest contract", () => {
  it("pins the contract version, result and required artifacts", () => {
    expect(RESULT_MANIFEST_CONTRACT_VERSION).toBe(1);
    expect(REQUIRED_RESULT_MANIFEST_ARTIFACTS).toEqual([
      "sldprt",
      "preview",
      "dimensionLedger",
      "featurePlan",
      "buildValidationLog",
      "builderSource"
    ]);
  });

  it("accepts any non-empty actual SolidWorks version (version-agnostic)", () => {
    // No version is required or implied: newer releases (2025) and legacy
    // 2022 values both read unchanged.
    for (const version of ["2025", "2022", "2024", "2026"]) {
      const manifest = { ...validManifest(), solidWorksVersion: version };
      expect(validateResultManifest(manifest).solidWorksVersion).toBe(version);
    }
  });

  it("rejects a missing, empty or non-string solidWorksVersion", () => {
    const manifest = validManifest();
    expectCode(
      () => validateResultManifest({ ...manifest, solidWorksVersion: "" }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateResultManifest({ ...manifest, solidWorksVersion: 2025 }),
      "INVALID_CONTRACT"
    );
    const { solidWorksVersion, ...withoutVersion } = manifest;
    expect(solidWorksVersion).toBe("2025");
    expectCode(() => validateResultManifest(withoutVersion), "INVALID_CONTRACT");
  });

  it("accepts a well-formed manifest and round-trips over JSON", () => {
    const manifest = validManifest();
    expect(validateResultManifest(manifest)).toEqual(manifest);
    expect(JSON.parse(JSON.stringify(validateResultManifest(manifest)))).toEqual(manifest);
  });

  it("accepts a manifest without the optional processMp4 recording", () => {
    const manifest = validManifest();
    delete manifest.artifacts.processMp4;
    expect(validateResultManifest(manifest)).toEqual(manifest);
  });

  it("accepts a productionVerified true claim and round-trips it", () => {
    const manifest = { ...validManifest(), productionVerified: true };
    expect(validateResultManifest(manifest)).toEqual(manifest);
    expect(JSON.parse(JSON.stringify(validateResultManifest(manifest)))).toEqual(manifest);
  });

  it("normalizes an absent productionVerified claim to false", () => {
    const manifest = validManifest();
    const { productionVerified, ...withoutClaim } = manifest;
    expect(productionVerified).toBe(false);
    expect(validateResultManifest(withoutClaim)).toEqual(manifest);
  });

  it("rejects a non-boolean productionVerified flag", () => {
    expectCode(
      () => validateResultManifest({ ...validManifest(), productionVerified: "yes" }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateResultManifest({ ...validManifest(), productionVerified: 1 }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects a contract version mismatch", () => {
    expectCode(
      () => validateResultManifest({ ...validManifest(), contractVersion: 2 }),
      "VERSION_MISMATCH"
    );
  });

  it("rejects unknown manifest fields and unknown artifact keys", () => {
    expectCode(
      () => validateResultManifest({ ...validManifest(), builder: "codex" }),
      "UNKNOWN_FIELD"
    );
    expectCode(
      () =>
        validateResultManifest({
          ...validManifest(),
          artifacts: { ...validManifest().artifacts, thumbnail: artifactRef("t") }
        }),
      "UNKNOWN_FIELD"
    );
  });

  it("rejects a non-completed result", () => {
    expectCode(
      () => validateResultManifest({ ...validManifest(), result: "failed" }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects a missing required artifact", () => {
    const manifest = validManifest();
    const artifacts: Record<string, unknown> = { ...manifest.artifacts };
    delete artifacts.dimensionLedger;
    expectCode(
      () => validateResultManifest({ ...manifest, artifacts }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects non-positive counts and an illegal rebuild status", () => {
    expectCode(
      () => validateResultManifest({ ...validManifest(), featureCount: 0 }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateResultManifest({ ...validManifest(), bodyCount: -1 }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () => validateResultManifest({ ...validManifest(), rebuildStatus: "UNKNOWN" }),
      "INVALID_CONTRACT"
    );
  });

  it("rejects malformed artifact references", () => {
    const manifest = validManifest();
    expectCode(
      () =>
        validateResultManifest({
          ...manifest,
          artifacts: { ...manifest.artifacts, sldprt: { ...manifest.artifacts.sldprt, sizeBytes: 0 } }
        }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () =>
        validateResultManifest({
          ...manifest,
          artifacts: { ...manifest.artifacts, preview: { ...manifest.artifacts.preview, sha256: "bad" } }
        }),
      "INVALID_CONTRACT"
    );
    expectCode(
      () =>
        validateResultManifest({
          ...manifest,
          artifacts: {
            ...manifest.artifacts,
            featurePlan: { ...manifest.artifacts.featurePlan, absolutePath: "C:\\x" }
          }
        }),
      "UNKNOWN_FIELD"
    );
  });

  it("rejects non-object manifests and non-object artifact references", () => {
    expectCode(() => validateResultManifest("manifest"), "INVALID_CONTRACT");
    expectCode(
      () => validateResultManifest({ ...validManifest(), artifacts: "none" }),
      "INVALID_CONTRACT"
    );
  });
});
