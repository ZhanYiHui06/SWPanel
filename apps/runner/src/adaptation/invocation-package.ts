import type { InputAdapterProvenance, RunInputSnapshot } from "@swpanel/domain";
import {
  INVOCATION_PACKAGE_CONTRACT_VERSION,
  validateInvocationPackage,
  type InvocationExecutionVisibility,
  type InvocationPackage
} from "@swpanel/contracts";

/**
 * Phase 4 (P4-2) Invocation Package generation. The package is the complete,
 * frozen input handed to the modeling Skill for one Run attempt: it is built by
 * the Runner from the frozen `RunInputSnapshot`, the Input Adapter provenance
 * and the attempt workspace — the Agent never sees a client-supplied snapshot
 * (architecture.md §9.3). The built package is strictly validated through the
 * shared `@swpanel/contracts` validator before it is written to the attempt
 * workspace.
 */

export interface InvocationPackageWorkspacePaths {
  /** Absolute attempt-workspace root handed to the Skill. */
  root: string;
  /** Absolute output directory of the attempt. */
  output: string;
}

export interface InvocationPackageBuildInput {
  runId: string;
  /** The frozen Run Input Snapshot of the attempt (never a client snapshot). */
  snapshot: RunInputSnapshot;
  /** Provenance of the successful Input Adapter conversion. */
  provenance: InputAdapterProvenance;
  /** Absolute attempt workspace paths the Skill may write into. */
  workspace: InvocationPackageWorkspacePaths;
  /** MVP defaults to background execution without MP4 recording. */
  execution?: {
    visibility?: InvocationExecutionVisibility;
    recordMp4?: boolean;
  };
}

/**
 * Builds the Invocation Package from the frozen snapshot + adapter provenance +
 * workspace. Throws the shared contract error when the built package does not
 * satisfy the versioned Invocation Package contract (the Runner fails the
 * attempt closed at PREPARING rather than ever handing out an invalid package).
 */
export function buildInvocationPackage(input: InvocationPackageBuildInput): InvocationPackage {
  const candidate: InvocationPackage = {
    contractVersion: INVOCATION_PACKAGE_CONTRACT_VERSION,
    runId: input.runId,
    skill: { name: input.snapshot.skill.name, sha256: input.snapshot.skill.sha256 },
    input: {
      originalArtifactId: input.snapshot.originalFileRef,
      imagePath: input.provenance.output.relativePath,
      imageSha256: input.provenance.output.sha256
    },
    memory: {
      revisionFacts: input.snapshot.revisionFacts,
      modelingFeedback: input.snapshot.modelingFeedback
    },
    workspace: {
      root: input.workspace.root,
      output: input.workspace.output
    },
    execution: {
      visibility: input.execution?.visibility ?? "visible",
      recordMp4: input.execution?.recordMp4 ?? false
    }
  };
  // The strict shared validator both proves the contract and normalizes the
  // built shape (throwing Phase4ContractError on the first violation).
  return validateInvocationPackage(candidate);
}
