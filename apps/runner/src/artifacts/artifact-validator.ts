import { createHash } from "node:crypto";
import type { ResultManifest } from "@swpanel/contracts";
import { validateResultManifest } from "@swpanel/contracts";

export interface ArtifactWorkspaceReadSurface {
  readOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
  }): { content: Buffer } | null;
}

export interface ArtifactValidationSuccess {
  ok: true;
  manifest: ResultManifest;
  artifacts: Array<{
    kind: string;
    fileName: string;
    relativePath: string;
    sizeBytes: number;
    sha256: string;
    mimeType?: string | undefined;
  }>;
}

export interface ArtifactValidationFailure {
  ok: false;
  issue: {
    code: "ARTIFACT_MANIFEST_INVALID" | "ARTIFACT_MISSING" | "ARTIFACT_OUTSIDE_WORKSPACE" | "VALIDATION_REJECTED";
    message: string;
  };
}

export type ArtifactValidationOutcome = ArtifactValidationSuccess | ArtifactValidationFailure;

export interface ArtifactValidatorOptions {
  now?: () => Date;
  expectedSolidWorksVersion?: string;
}

export class ArtifactValidator {
  constructor(
    private readonly workspace: ArtifactWorkspaceReadSurface,
    private readonly options: ArtifactValidatorOptions = {}
  ) {}

  validate(input: {
    runId: string;
    attemptSequence: number;
    manifestRef: string;
    recordMp4Required?: boolean;
  }): ArtifactValidationOutcome {
    const { runId, attemptSequence, manifestRef, recordMp4Required = false } = input;

    // 1. Safe workspace-relative manifest path
    if (manifestRef.startsWith("/") || manifestRef.includes("..") || manifestRef.includes("\\")) {
      return {
        ok: false,
        issue: {
          code: "ARTIFACT_OUTSIDE_WORKSPACE",
          message: "Manifest path must be safe and workspace-relative"
        }
      };
    }

    const manifestFile = this.workspace.readOwnedFile({
      runId,
      attemptSequence,
      relativePath: manifestRef
    });

    if (!manifestFile) {
      return {
        ok: false,
        issue: {
          code: "ARTIFACT_MANIFEST_INVALID",
          message: `Result manifest not found at ${manifestRef}`
        }
      };
    }

    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(manifestFile.content.toString("utf8"));
    } catch {
      return {
        ok: false,
        issue: {
          code: "ARTIFACT_MANIFEST_INVALID",
          message: "Result manifest is not valid JSON"
        }
      };
    }

    let manifest: ResultManifest;
    try {
      manifest = validateResultManifest(manifestRaw);
    } catch (err: unknown) {
      return {
        ok: false,
        issue: {
          code: "ARTIFACT_MANIFEST_INVALID",
          message: err instanceof Error ? err.message : "Manifest schema validation failed"
        }
      };
    }

    // Version match validation
    if (
      this.options.expectedSolidWorksVersion &&
      manifest.solidWorksVersion !== this.options.expectedSolidWorksVersion
    ) {
      return {
        ok: false,
        issue: {
          code: "ARTIFACT_MANIFEST_INVALID",
          message: `SolidWorks version mismatch: expected ${this.options.expectedSolidWorksVersion}, got ${manifest.solidWorksVersion}`
        }
      };
    }

    // Production verified rejection when unauthoritative
    if (manifest.productionVerified === true) {
      return {
        ok: false,
        issue: {
          code: "ARTIFACT_MANIFEST_INVALID",
          message: "productionVerified: true is not authoritative on unverified runs"
        }
      };
    }

    // Rebuild status check
    if (manifest.rebuildStatus !== "PASSED") {
      return {
        ok: false,
        issue: {
          code: "VALIDATION_REJECTED",
          message: `Rebuild status is not PASSED: ${manifest.rebuildStatus}`
        }
      };
    }

    const artifactEntries: Array<{
      kind: string;
      ref: { fileName: string; relativePath: string; sizeBytes: number; sha256: string };
      mimeType?: string;
    }> = [
      { kind: "SLDPRT", ref: manifest.artifacts.sldprt, mimeType: "application/sla" },
      { kind: "PREVIEW", ref: manifest.artifacts.preview, mimeType: "image/png" },
      { kind: "DIMENSION_LEDGER", ref: manifest.artifacts.dimensionLedger, mimeType: "application/json" },
      { kind: "FEATURE_PLAN", ref: manifest.artifacts.featurePlan, mimeType: "application/json" },
      { kind: "BUILD_VALIDATION_LOG", ref: manifest.artifacts.buildValidationLog, mimeType: "application/json" },
      { kind: "BUILDER_SOURCE", ref: manifest.artifacts.builderSource, mimeType: "application/json" }
    ];

    if (recordMp4Required) {
      if (!manifest.artifacts.processMp4) {
        return {
          ok: false,
          issue: {
            code: "ARTIFACT_MISSING",
            message: "processMp4 artifact is required when recordMp4 is true"
          }
        };
      }
      artifactEntries.push({
        kind: "PROCESS_MP4",
        ref: manifest.artifacts.processMp4,
        mimeType: "video/mp4"
      });
    }

    // Check duplicate paths
    const seenPaths = new Set<string>();
    for (const entry of artifactEntries) {
      const relPath = entry.ref.relativePath;
      if (seenPaths.has(relPath)) {
        return {
          ok: false,
          issue: {
            code: "ARTIFACT_MANIFEST_INVALID",
            message: `Duplicate artifact path in manifest: ${relPath}`
          }
        };
      }
      seenPaths.add(relPath);

      if (relPath.startsWith("/") || relPath.includes("..") || relPath.includes("\\")) {
        return {
          ok: false,
          issue: {
            code: "ARTIFACT_OUTSIDE_WORKSPACE",
            message: `Artifact path ${relPath} escapes the attempt workspace`
          }
        };
      }

      const file = this.workspace.readOwnedFile({
        runId,
        attemptSequence,
        relativePath: relPath
      });

      if (!file || file.content.length === 0) {
        return {
          ok: false,
          issue: {
            code: "ARTIFACT_MISSING",
            message: `Artifact missing or empty: ${relPath}`
          }
        };
      }

      const fileHash = createHash("sha256").update(file.content).digest("hex");
      if (file.content.length !== entry.ref.sizeBytes || fileHash !== entry.ref.sha256) {
        return {
          ok: false,
          issue: {
            code: "ARTIFACT_MISSING",
            message: `Artifact hash or size mismatch: ${relPath}`
          }
        };
      }
    }

    const attemptLabel = `attempt-${String(attemptSequence).padStart(3, "0")}`;
    const workspacePrefix = `runs/${runId}/${attemptLabel}/`;

    return {
      ok: true,
      manifest,
      artifacts: artifactEntries.map((e) => ({
        kind: e.kind,
        fileName: e.ref.fileName,
        relativePath: `${workspacePrefix}${e.ref.relativePath}`,
        sizeBytes: e.ref.sizeBytes,
        sha256: e.ref.sha256,
        mimeType: e.mimeType
      }))
    };
  }
}
