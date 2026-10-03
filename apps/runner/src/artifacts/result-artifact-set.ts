import { createHash } from "node:crypto";
import type { ResultManifest, ResultManifestArtifacts } from "@swpanel/contracts";

export const RESULT_MANIFEST_FILE_RELATIVE_PATH = "output/result-manifest.json";

export interface ArtifactDefect {
  kind: "missing-artifact" | "path-escape" | "hash-mismatch" | "size-mismatch" | "rebuild-failed" | "unsupported-verified";
}

export interface SyntheticArtifactFile {
  relativePath: string;
  content: Buffer;
}

export interface SyntheticResultArtifactSet {
  manifestRef: string;
  manifest: ResultManifest;
  files: readonly SyntheticArtifactFile[];
}

function sha256Of(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function produceSyntheticResultArtifactSet(options: {
  runId: string;
  attemptSequence: number;
  recordMp4?: boolean;
  solidWorksVersion?: string;
  adapterId?: string;
  adapterVersion?: string;
  defect?: ArtifactDefect;
}): SyntheticResultArtifactSet {
  const {
    runId,
    recordMp4 = false,
    solidWorksVersion = "2025",
    defect
  } = options;

  const sldprtContent = Buffer.from(`SOLIDWORKS PART DATA for run ${runId}\n`, "utf8");
  const previewContent = Buffer.from(`PNG PREVIEW IMAGE DATA for run ${runId}\n`, "utf8");
  const ledgerContent = Buffer.from(JSON.stringify({ runId, dimensions: [] }, null, 2) + "\n", "utf8");
  const planContent = Buffer.from(JSON.stringify({ runId, features: ["Boss-Extrude1"] }, null, 2) + "\n", "utf8");
  const logContent = Buffer.from(`Rebuild succeeded for ${runId}\n`, "utf8");
  const sourceContent = Buffer.from(`// Builder source code for ${runId}\n`, "utf8");
  const mp4Content = Buffer.from(`MP4 VIDEO DATA for ${runId}\n`, "utf8");

  const sldprtFileRelativePath = "output/fake-model.sldprt";
  const sldprtManifestRelativePath = defect?.kind === "path-escape" ? "../outside.sldprt" : sldprtFileRelativePath;
  const previewPath = "output/preview.png";
  const ledgerPath = "output/dimension-ledger.json";
  const planPath = "output/feature-plan.json";
  const logPath = "output/validation-log.json";
  const sourcePath = "output/builder-source.json";
  const mp4Path = "output/process.mp4";

  const artifacts: ResultManifestArtifacts = {
    sldprt: {
      fileName: "fake-model.sldprt",
      relativePath: sldprtManifestRelativePath,
      sizeBytes: sldprtContent.length,
      sha256: sha256Of(sldprtContent)
    },
    preview: {
      fileName: "preview.png",
      relativePath: previewPath,
      sizeBytes: previewContent.length,
      sha256: sha256Of(previewContent)
    },
    dimensionLedger: {
      fileName: "dimension-ledger.json",
      relativePath: ledgerPath,
      sizeBytes: ledgerContent.length,
      sha256: sha256Of(ledgerContent)
    },
    featurePlan: {
      fileName: "feature-plan.json",
      relativePath: planPath,
      sizeBytes: planContent.length,
      sha256: sha256Of(planContent)
    },
    buildValidationLog: {
      fileName: "validation-log.json",
      relativePath: logPath,
      sizeBytes: logContent.length,
      sha256: sha256Of(logContent)
    },
    builderSource: {
      fileName: "builder-source.json",
      relativePath: sourcePath,
      sizeBytes: sourceContent.length,
      sha256: sha256Of(sourceContent)
    }
  };

  if (recordMp4) {
    artifacts.processMp4 = {
      fileName: "process.mp4",
      relativePath: mp4Path,
      sizeBytes: mp4Content.length,
      sha256: sha256Of(mp4Content)
    };
  }

  const rebuildStatus = defect?.kind === "rebuild-failed" ? "FAILED" : "PASSED";
  const productionVerified = defect?.kind === "unsupported-verified" ? true : false;

  const manifest: ResultManifest = {
    contractVersion: 1,
    result: "completed",
    solidWorksVersion,
    units: "mm",
    projectionDecision: "first-angle",
    featureCount: 4,
    bodyCount: 1,
    rebuildStatus,
    unresolvedAssumptions: [],
    artifacts,
    productionVerified
  };

  const files: SyntheticArtifactFile[] = [];

  if (defect?.kind !== "missing-artifact") {
    files.push(
      { relativePath: sldprtFileRelativePath, content: sldprtContent },
      { relativePath: previewPath, content: previewContent },
      { relativePath: ledgerPath, content: ledgerContent },
      { relativePath: planPath, content: planContent },
      { relativePath: logPath, content: logContent },
      { relativePath: sourcePath, content: sourceContent }
    );
    if (recordMp4) {
      files.push({ relativePath: mp4Path, content: mp4Content });
    }
  }

  const manifestJson = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  files.push({ relativePath: RESULT_MANIFEST_FILE_RELATIVE_PATH, content: manifestJson });

  return {
    manifestRef: RESULT_MANIFEST_FILE_RELATIVE_PATH,
    manifest,
    files
  };
}
