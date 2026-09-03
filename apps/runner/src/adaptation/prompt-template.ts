import type { InputAdapterProvenance, RunInputSnapshot } from "@swpanel/domain";
import type { InvocationPackage } from "@swpanel/contracts";

import type { RunWorkspaceLayout } from "../ledger/run-workspace-ledger.js";

/**
 * Phase 4 (P4-2) + Phase 5 controlled, versioned Prompt Template. The template
 * text is a fixed, versioned constant in this module — ordinary users never
 * edit it — and is filled automatically from the frozen `RunInputSnapshot`
 * (drawing input, Revision Facts, Modeling Feedback), the Input Adapter
 * provenance, the attempt workspace and the generated Invocation Package
 * (development-plan §8.2). The Runner pins the template version into every
 * frozen snapshot through `DEFAULT_RUN_PROFILE`. The Phase 5 revision adds the
 * FINAL TURN CONTRACT: the turn MUST end with exactly one of the two
 * machine-readable terminal states (completed Result Manifest vs structured
 * clarification), blocking facts MUST be clarified instead of guessed, and
 * SolidWorks / model artifacts MUST NOT be started or generated before a
 * clarification terminal state.
 */

/** Version of the current controlled prompt template. */
export const PROMPT_TEMPLATE_VERSION = "2026.08-p5.1" as const;

/** Hard success artifacts of the Output Contract (development-plan §9.4). */
export const REQUIRED_MODEL_ARTIFACTS = [
  ".SLDPRT",
  "Preview",
  "Dimension Ledger",
  "Feature Plan",
  "Validation Log"
] as const;

export interface RenderPromptInput {
  snapshot: RunInputSnapshot;
  provenance: InputAdapterProvenance;
  workspace: RunWorkspaceLayout;
  invocationPackage: InvocationPackage;
  /** Runner-minted identity of this execution attempt (never Agent-supplied). */
  attemptId: string;
  /** Runner-minted sequence of this execution attempt (never Agent-supplied). */
  attemptSequence: number;
  /**
   * The authoritative SolidWorks version the Runner attests for the attempt
   * (e.g. the live SolidWorks probe snapshot of the Desktop main live branch).
   * Rendered into the Execution Rules ONLY when non-empty so the Agent records
   * the exact version instead of guessing; absent/empty keeps the rendered
   * prompt byte-identical to the version-agnostic default.
   */
  expectedSolidWorksVersion?: string;
}

/**
 * Renders the controlled prompt for one attempt from the frozen snapshot, the
 * adapter provenance, the attempt workspace and the validated Invocation
 * Package. Deterministic: identical inputs render identical text.
 */
export function renderPrompt(input: RenderPromptInput): string {
  const { snapshot, provenance, workspace, invocationPackage } = input;
  const sections: string[] = [];
  sections.push(`# SWPanel Modeling Run Prompt (Template ${PROMPT_TEMPLATE_VERSION})`);
  sections.push("");

  sections.push("## Run");
  sections.push(`- runId: ${invocationPackage.runId}`);
  sections.push(`- attemptId: ${input.attemptId}`);
  sections.push(`- attemptSequence: ${input.attemptSequence}`);
  sections.push(`- drawingId: ${snapshot.drawingId}`);
  sections.push(`- revisionId: ${snapshot.revisionId}`);
  sections.push(`- promptTemplateVersion (frozen): ${snapshot.promptTemplateVersion}`);
  sections.push(`- agentConfigId: ${snapshot.agentConfigId}`);
  sections.push("");

  sections.push("## Drawing Input");
  sections.push(`- original file: ${snapshot.originalFileRef}`);
  sections.push(`- adapter: ${provenance.adapterId} ${provenance.adapterVersion}`);
  sections.push(`- derived image (workspace-relative): ${provenance.output.relativePath}`);
  sections.push(`- derived image sha256: ${provenance.output.sha256}`);
  sections.push(`- productionVerified: ${provenance.productionVerified}`);
  if (provenance.pageSelection !== undefined) {
    sections.push(
      `- page selection: page ${provenance.pageSelection.pageNumber} of ${provenance.pageSelection.totalPages}`
    );
  }
  sections.push("");

  sections.push("## Revision Facts");
  if (snapshot.revisionFacts.length === 0) {
    sections.push("- (none)");
  } else {
    for (const fact of snapshot.revisionFacts) {
      const unit = fact.unit === undefined ? "" : ` ${fact.unit}`;
      sections.push(`- ${fact.field}: ${fact.value}${unit} (source: ${fact.source})`);
    }
  }
  sections.push("");

  sections.push("## Modeling Feedback");
  if (snapshot.modelingFeedback.length === 0) {
    sections.push("- (none)");
  } else {
    for (const feedback of snapshot.modelingFeedback) {
      sections.push(`- ${feedback.content} (source: ${feedback.source})`);
    }
  }
  sections.push("");

  sections.push("## Workspace");
  sections.push(`- root: ${workspace.absoluteRoot}`);
  sections.push(`- input: ${workspace.directories.input.absolutePath}`);
  sections.push(`- output: ${workspace.directories.output.absolutePath}`);
  sections.push(`- working: ${workspace.directories.working.absolutePath}`);
  sections.push(`- logs: ${workspace.directories.logs.absolutePath}`);
  sections.push("");

  sections.push("## Output Contract");
  sections.push("A successful execution must produce machine-readable artifacts:");
  for (const artifact of REQUIRED_MODEL_ARTIFACTS) {
    sections.push(`- ${artifact}`);
  }
  sections.push("The final response must be machine-readable and independently verifiable.");
  sections.push("");

  sections.push("## Final Turn Contract");
  sections.push("The final response MUST end with EXACTLY ONE of two terminal states:");
  sections.push("- completed: the machine-readable Result Manifest above is the ONLY success state;");
  sections.push("- clarification_required: a structured clarification question set, and ONLY that.");
  sections.push(
    "Blocking engineering facts that cannot be determined from the drawing, Revision Facts or Modeling Feedback MUST be surfaced as a structured clarification INSTEAD of guessing a dimension, material or treatment."
  );
  sections.push(
    "Before a clarification_required terminal state, SolidWorks MUST NOT be started and NO model artifact may be generated."
  );
  sections.push(
    "The provider wire JSON always includes contractVersion, result, completed and questions: for completed, questions MUST be null; for clarification_required, completed MUST be null."
  );
  sections.push(
    "Every clarification question always includes id, type, question, hint, unit and options: use null for an unused hint, unit or options (never [] for no options); a choice question MUST use a non-empty options array."
  );
  sections.push(
    "A completed Result Manifest always includes productionVerified and artifacts.processMp4: productionVerified MUST be false for this execution, and processMp4 MUST be null unless a real recording artifact was requested and produced."
  );
  sections.push("");

  sections.push("## Execution Rules");
  sections.push(`- execution visibility: ${invocationPackage.execution.visibility}`);
  sections.push(`- recordMp4: ${invocationPackage.execution.recordMp4}`);
  if (input.expectedSolidWorksVersion !== undefined && input.expectedSolidWorksVersion.length > 0) {
    sections.push(`- expected SolidWorks version: ${input.expectedSolidWorksVersion}`);
  }
  sections.push("- never modify the original drawing file");
  sections.push("- write derived artifacts only inside the attempt workspace");
  sections.push(
    "- before launching SolidWorks, write runtime/solidworks-ownership.json with schemaVersion 1, the exact runId/attemptId/attemptSequence above, updatedAt, and EXACTLY ONE attempt-workspace-relative .SLDPRT path: the single part this attempt plans to create (this Run produces exactly one editable .SLDPRT); update the SAME entry after each real save with the true saved path — never append a second document"
  );
  sections.push(
    "- the SolidWorks ownership registry accepts ONLY a single attempt-workspace-relative .SLDPRT path (a second document — planned, saved or duplicate — is invalid): never absolute paths, pids or process entries; missing, stale or invalid registration is not proof of ownership and makes cancellation fail closed (CANCEL_CLEANUP_PENDING)"
  );
  sections.push(
    "- unresolved blocking engineering facts must end the turn as a structured clarification (never a guessed result)"
  );
  sections.push("");

  return sections.join("\n");
}
