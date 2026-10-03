import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import type {
  InputAdapterProvenance,
  InputAdapterScenario,
  InputAdapterSourceRef,
  RevisionFact,
  RunInputSnapshot
} from "@swpanel/domain";
import { isTestOnlyResult } from "@swpanel/domain";
import {
  Phase4ContractError,
  validateInputAdapterResult,
  validateInvocationPackage
} from "@swpanel/contracts";
import type { RunWorkspaceLayout } from "../ledger/run-workspace-ledger.js";
import type { StoredRunFile } from "../ledger/run-workspace-ledger.js";
import {
  DEFAULT_INPUT_ADAPTER_SCENARIO,
  FakeInputAdapter,
  INPUT_ADAPTER_ID,
  INPUT_ADAPTER_VERSION,
  TEST_ONLY_INPUT_ADAPTER_ID,
  mapInputAdapterFailureCode,
  type InputAdapterContext,
  type InputAdapterWorkspace
} from "./input-adapter.js";
import {
  PROMPT_TEMPLATE_VERSION,
  REQUIRED_MODEL_ARTIFACTS,
  renderPrompt
} from "./prompt-template.js";
import { buildInvocationPackage } from "./invocation-package.js";
import { DEFAULT_RUN_PROFILE } from "../runner.js";

const T0 = "2026-08-13T10:00:00.000Z";

const SOURCE: InputAdapterSourceRef = {
  fileName: "original.pdf",
  format: "PDF",
  sizeBytes: 1024,
  sha256: "a".repeat(64)
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
      sha256: createHash("sha256").update(input.content).digest("hex"),
      sizeBytes: input.content.byteLength
    };
  }
}

function adapterContext(overrides: Partial<InputAdapterContext> = {}): InputAdapterContext {
  return {
    runId: "run-1",
    attemptSequence: 1,
    source: SOURCE,
    sourceAbsolutePath: "C:/library/original.pdf",
    outputFormat: "PNG",
    workspace: new MemoryInputAdapterWorkspace(),
    ...overrides
  };
}

function runAdapter(scenario: InputAdapterScenario, context: InputAdapterContext) {
  return new FakeInputAdapter({
    scenario,
    now: () => new Date(T0),
    // Deterministic readable original bytes (unit tests have no real file).
    readSourceBytes: () => Buffer.from("SWPanel unit-test source bytes\n")
  }).adapt(context);
}

describe("Phase 4 P4-1 FakeInputAdapter", () => {
  it("the production default scenario is single-page-pdf and succeeds without inventing a page selection", () => {
    expect(DEFAULT_INPUT_ADAPTER_SCENARIO).toBe("single-page-pdf");
    // The fake never inspects the source: without an explicit selection the
    // default PDF path must NOT claim an inspected one-page source and must
    // NOT record a silently chosen page.
    const result = runAdapter("single-page-pdf", adapterContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance).toMatchObject({
      adapterId: INPUT_ADAPTER_ID,
      adapterVersion: INPUT_ADAPTER_VERSION,
      sourceFileSha256: SOURCE.sha256,
      productionVerified: false,
      previewRelativePath: "input/preview.png"
    });
    expect(result.provenance.pageSelection).toBeUndefined();
    expect(result.provenance.warnings.join(" ")).toContain(
      "synthetic conversion, not production-verified"
    );
    expect(result.provenance.warnings.join(" ")).toContain(
      "page structure not inspected; no page/layout assertion made"
    );
    expect(result.provenance.output.relativePath).toBe("input/drawing.png");
    expect(result.provenance.output.sha256).toMatch(/^[0-9a-f]{64}$/);

    // An explicit page 1 of 1 selection is echoed verbatim — the caller's
    // assertion, never an invented inspection result.
    const selected = runAdapter(
      "single-page-pdf",
      adapterContext({ pageSelection: { pageNumber: 1, totalPages: 1 } })
    );
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.provenance.pageSelection).toEqual({ pageNumber: 1, totalPages: 1 });
      expect(selected.provenance.productionVerified).toBe(false);
    }
  });

  it("fails closed when the default PDF path gets a selection that contradicts the simulated source", () => {
    // A multi-page claim against the simulated one-page source can never be
    // converted truthfully — the adapter must not assert it.
    const multiPageClaim = runAdapter(
      "single-page-pdf",
      adapterContext({ pageSelection: { pageNumber: 1, totalPages: 3 } })
    );
    expect(multiPageClaim.ok).toBe(false);
    if (!multiPageClaim.ok) {
      expect(multiPageClaim.error.code).toBe("PAGE_SELECTION_REQUIRED");
    }
    // A malformed selection (pageNumber > totalPages) fails closed too.
    const malformed = runAdapter(
      "single-page-pdf",
      adapterContext({ pageSelection: { pageNumber: 2, totalPages: 1 } })
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("PAGE_SELECTION_REQUIRED");
  });

  it("writes the derived image, preview and a contract-valid adapter-result.json envelope", () => {
    const context = adapterContext();
    const result = runAdapter("single-page-pdf", context);
    expect(result.ok).toBe(true);
    const workspace = context.workspace as MemoryInputAdapterWorkspace;
    expect(workspace.files.has("run-1/1/input/drawing.png")).toBe(true);
    expect(workspace.files.has("run-1/1/input/preview.png")).toBe(true);
    const envelopeBytes = workspace.files.get("run-1/1/input/adapter-result.json");
    expect(envelopeBytes).toBeDefined();
    const envelope: unknown = JSON.parse(envelopeBytes?.toString("utf8") ?? "{}");
    // The persisted envelope round-trips the strict shared validator.
    const validated = validateInputAdapterResult(envelope);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      // The provenance hash matches the hash of the actually written image.
      const imageBytes = workspace.files.get("run-1/1/input/drawing.png");
      expect(createHash("sha256").update(imageBytes ?? Buffer.alloc(0)).digest("hex")).toBe(
        validated.provenance.output.sha256
      );
    }
  });

  it("fails closed for a multi-page PDF without an explicit page selection", () => {
    const selected = runAdapter("multi-page-pdf-selected-page", adapterContext());
    expect(selected.ok).toBe(false);
    if (!selected.ok) {
      expect(selected.error.code).toBe("PAGE_SELECTION_REQUIRED");
      expect(selected.error.message.length).toBeGreaterThan(0);
    }
    const none = runAdapter("multi-page-pdf-no-page-selected", adapterContext());
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.code).toBe("PAGE_SELECTION_REQUIRED");
  });

  it("converts a multi-page PDF only with an explicit in-range selection", () => {
    const result = runAdapter(
      "multi-page-pdf-selected-page",
      adapterContext({ pageSelection: { pageNumber: 3, totalPages: 5 } })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance.pageSelection).toEqual({ pageNumber: 3, totalPages: 5 });
    }
    // Out-of-range selection fails closed too.
    const outOfRange = runAdapter(
      "multi-page-pdf-selected-page",
      adapterContext({ pageSelection: { pageNumber: 9, totalPages: 5 } })
    );
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.error.code).toBe("PAGE_SELECTION_REQUIRED");
  });

  it("marks the synthetic DWG/DXF conversion test-only with productionVerified=false", () => {
    const result = runAdapter("dwg-dxf-synthetic-test-only", adapterContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.adapterId).toBe(TEST_ONLY_INPUT_ADAPTER_ID);
    expect(result.provenance.productionVerified).toBe(false);
    expect(isTestOnlyResult(result.provenance)).toBe(true);
    expect(result.provenance.warnings.join(" ")).toContain("synthetic conversion, not production-verified");
  });

  it("maps the structured failure scenarios onto the Run-level failure codes", () => {
    const unsupported = runAdapter("unsupported-source", adapterContext());
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) {
      expect(unsupported.error.code).toBe("UNSUPPORTED_SOURCE_FORMAT");
      expect(mapInputAdapterFailureCode(unsupported.error.code)).toBe("INPUT_UNSUPPORTED");
    }
    const failure = runAdapter("adapter-failure", adapterContext());
    if (!failure.ok) {
      expect(failure.error.code).toBe("CONVERSION_FAILED");
      expect(mapInputAdapterFailureCode(failure.error.code)).toBe("INPUT_ADAPTER_FAILED");
    }
    const missing = runAdapter("missing-corrupt-source", adapterContext());
    if (!missing.ok) {
      expect(missing.error.code).toBe("SOURCE_MISSING_OR_CORRUPT");
      expect(mapInputAdapterFailureCode(missing.error.code)).toBe("INPUT_ADAPTER_FAILED");
    }
  });

  it("fails closed when the immutable original source is unreadable", () => {
    const context = adapterContext();
    const adapter = new FakeInputAdapter({
      scenario: "single-page-pdf",
      now: () => new Date(T0),
      readSourceBytes: () => null
    });
    const result = adapter.adapt(context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SOURCE_MISSING_OR_CORRUPT");
  });

  it("passes the passthrough scenario through as the requested JPG output", () => {
    const result = runAdapter(
      "png-jpg-passthrough",
      adapterContext({ outputFormat: "JPG" })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance.output.relativePath).toBe("input/drawing.jpg");
      expect(result.provenance.output.fileName).toBe("drawing.jpg");
      expect(result.provenance.pageSelection).toBeUndefined();
    }
  });

  it("rejects an unknown scenario at construction (test-only configuration guard)", () => {
    expect(
      () => new FakeInputAdapter({ scenario: "not-a-scenario" as InputAdapterScenario })
    ).toThrowError(/inputAdapterScenario must be a known input adapter scenario/);
  });
});

const FACT: RevisionFact = {
  id: "fact-1",
  revisionId: "revision-a1",
  field: "thickness",
  value: "12",
  unit: "mm",
  source: "USER_SUPPLEMENT",
  createdAt: T0
};

const SNAPSHOT: RunInputSnapshot = {
  drawingId: "drawing-a",
  revisionId: "revision-a1",
  originalFileRef: "library/drawings/file-a/source/original.pdf",
  revisionFacts: [FACT],
  modelingFeedback: [
    {
      id: "feedback-1",
      revisionId: "revision-a1",
      content: "检查焊缝处理",
      source: "USER_SUPPLEMENT",
      createdAt: T0
    }
  ],
  promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
  skill: { name: "solidworks-build-part-from-drawing", sha256: "b".repeat(64) },
  agentConfigId: "agent-config-1",
  createdAt: T0
};

const PROVENANCE: InputAdapterProvenance = {
  adapterId: INPUT_ADAPTER_ID,
  adapterVersion: INPUT_ADAPTER_VERSION,
  sourceFileSha256: SOURCE.sha256,
  pageSelection: { pageNumber: 1, totalPages: 1 },
  output: {
    fileName: "drawing.png",
    sha256: "c".repeat(64),
    sizeBytes: 2048,
    widthPx: 2480,
    heightPx: 3508,
    dpi: 300,
    relativePath: "input/drawing.png"
  },
  warnings: [],
  unsupportedEntities: [],
  previewRelativePath: "input/preview.png",
  productionVerified: true,
  createdAt: T0
};

function workspaceLayout(runId = "run-1"): RunWorkspaceLayout {
  const root = `C:/swpanel/workspaces/runs/${runId}/attempt-001`;
  const subdir = (name: string) => ({
    relativePath: `runs/${runId}/attempt-001/${name}`,
    absolutePath: `${root}/${name}`
  });
  return {
    runId,
    attemptSequence: 1,
    attemptLabel: "attempt-001",
    relativeRoot: `runs/${runId}/attempt-001`,
    absoluteRoot: root,
    directories: {
      input: subdir("input"),
      memory: subdir("memory"),
      working: subdir("working"),
      output: subdir("output"),
      logs: subdir("logs"),
      runtime: subdir("runtime")
    }
  };
}

describe("Phase 4 P4-2 Invocation Package", () => {
  it("builds the package from the frozen snapshot + provenance + workspace and validates it", () => {
    const layout = workspaceLayout();
    const pkg = buildInvocationPackage({
      runId: "run-1",
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      workspace: { root: layout.absoluteRoot, output: layout.directories.output.absolutePath }
    });
    // The builder validates through the shared contract; a second strict pass
    // round-trips the serialized form.
    expect(validateInvocationPackage(JSON.parse(JSON.stringify(pkg)))).toEqual(pkg);
    expect(pkg).toMatchObject({
      contractVersion: 1,
      runId: "run-1",
      skill: { name: "solidworks-build-part-from-drawing", sha256: "b".repeat(64) },
      input: {
        originalArtifactId: SNAPSHOT.originalFileRef,
        imagePath: "input/drawing.png",
        imageSha256: "c".repeat(64)
      },
      workspace: { root: layout.absoluteRoot, output: layout.directories.output.absolutePath },
      execution: { visibility: "visible", recordMp4: false }
    });
    expect(pkg.memory.revisionFacts).toEqual([FACT]);
    expect(pkg.memory.modelingFeedback).toHaveLength(1);
  });

  it("rejects a package that violates the versioned contract", () => {
    expect(() =>
      buildInvocationPackage({
        runId: "run-1",
        snapshot: { ...SNAPSHOT, skill: { name: "solidworks-build-part-from-drawing", sha256: "nope" } },
        provenance: PROVENANCE,
        workspace: { root: "C:/root", output: "C:/root/output" }
      })
    ).toThrowError(Phase4ContractError);
  });
});

describe("Phase 4 P4-2 + Phase 5 Prompt Template", () => {
  it("the default run profile pins the controlled template version", () => {
    expect(DEFAULT_RUN_PROFILE.promptTemplateVersion).toBe(PROMPT_TEMPLATE_VERSION);
    expect(PROMPT_TEMPLATE_VERSION).toBe("2026.10-web.1");
  });

  it("renders every section from the frozen snapshot, provenance, workspace and package", () => {
    const layout = workspaceLayout();
    const pkg = buildInvocationPackage({
      runId: "run-1",
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      workspace: { root: layout.absoluteRoot, output: layout.directories.output.absolutePath }
    });
    const prompt = renderPrompt({
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      workspace: layout,
      invocationPackage: pkg,
      attemptId: "attempt-1",
      attemptSequence: 1
    });
    expect(prompt).toContain(`Template ${PROMPT_TEMPLATE_VERSION}`);
    expect(prompt).toContain("run-1");
    expect(prompt).toContain("attemptId: attempt-1");
    expect(prompt).toContain("attemptSequence: 1");
    expect(prompt).toContain(SNAPSHOT.originalFileRef);
    expect(prompt).toContain("input/drawing.png");
    expect(prompt).toContain("thickness: 12 mm");
    expect(prompt).toContain("检查焊缝处理");
    expect(prompt).toContain(layout.absoluteRoot);
    for (const artifact of REQUIRED_MODEL_ARTIFACTS) {
      expect(prompt).toContain(artifact);
    }
    expect(prompt).toContain("never modify the original drawing file");
    expect(prompt).toContain("runtime/solidworks-ownership.json");
    expect(prompt).toContain("the exact runId/attemptId/attemptSequence above");
    expect(prompt).toContain("never absolute paths, pids or process entries");
    expect(prompt).toContain("CANCEL_CLEANUP_PENDING");
    // Phase 5 single-part contract: the registry carries EXACTLY ONE
    // attempt-relative .SLDPRT (planned path, then the same entry updated to
    // the true saved path) — never a second document.
    expect(prompt).toContain("EXACTLY ONE attempt-workspace-relative .SLDPRT path");
    expect(prompt).toContain("never append a second document");
    // Phase 5 Final Turn Contract: the strict either/or terminal states, the
    // clarify-don't-guess rule and the no-SolidWorks/no-artifacts-before-
    // clarification rule are explicit.
    expect(prompt).toContain("## Final Turn Contract");
    expect(prompt).toContain("EXACTLY ONE of two terminal states");
    expect(prompt).toContain("- completed: the machine-readable Result Manifest above is the ONLY success state;");
    expect(prompt).toContain("- clarification_required: a structured clarification question set, and ONLY that.");
    expect(prompt).toContain("Blocking engineering facts");
    expect(prompt).toContain("INSTEAD of guessing a dimension, material or treatment");
    expect(prompt).toContain(
      "SolidWorks MUST NOT be started and NO model artifact may be generated"
    );
    expect(prompt).toContain("for completed, questions MUST be null");
    expect(prompt).toContain("for clarification_required, completed MUST be null");
    expect(prompt).toContain("use null for an unused hint, unit or options (never [] for no options)");
    expect(prompt).toContain("a choice question MUST use a non-empty options array");
    expect(prompt).toContain("productionVerified MUST be false for this execution");
    expect(prompt).toContain(
      "processMp4 MUST be null unless a real recording artifact was requested and produced"
    );
    // Deterministic render.
    expect(renderPrompt({
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      workspace: layout,
      invocationPackage: pkg,
      attemptId: "attempt-1",
      attemptSequence: 1
    })).toBe(prompt);
  });

  it("renders the attested expected SolidWorks version into the Execution Rules only when provided", () => {
    const layout = workspaceLayout();
    const pkg = buildInvocationPackage({
      runId: "run-1",
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      workspace: { root: layout.absoluteRoot, output: layout.directories.output.absolutePath }
    });
    const base = renderPrompt({
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      workspace: layout,
      invocationPackage: pkg,
      attemptId: "attempt-1",
      attemptSequence: 1
    });
    // Absent/empty keeps the version-agnostic default: no version line.
    expect(base).not.toContain("expected SolidWorks version");
    expect(
      renderPrompt({
        snapshot: SNAPSHOT,
        provenance: PROVENANCE,
        workspace: layout,
        invocationPackage: pkg,
        attemptId: "attempt-1",
        attemptSequence: 1,
        expectedSolidWorksVersion: ""
      })
    ).toBe(base);
    // The authoritative version is rendered so the live Agent records the
    // exact value instead of guessing; the ONLY delta is the version line.
    const attested = renderPrompt({
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      workspace: layout,
      invocationPackage: pkg,
      attemptId: "attempt-1",
      attemptSequence: 1,
      expectedSolidWorksVersion: "2025"
    });
    expect(attested).toContain("- expected SolidWorks version: 2025");
    expect(attested.replace("- expected SolidWorks version: 2025\n", "")).toBe(base);
  });
});
