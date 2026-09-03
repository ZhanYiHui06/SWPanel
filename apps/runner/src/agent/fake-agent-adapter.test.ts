import { describe, expect, it } from "vitest";

import { validateResultManifest, REQUIRED_RESULT_MANIFEST_ARTIFACTS } from "@swpanel/contracts";

import { translateRawAgentRecords } from "./product-event-translator.js";
import { FakeAgentAdapter, RAW_AGENT_LOG_RELATIVE_PATH, RAW_AGENT_SESSION_RELATIVE_PATH } from "./fake-agent-adapter.js";
import type { AgentWorkspace } from "./fake-agent-adapter.js";
import { RAW_AGENT_RECORDS_VERSION } from "./raw-agent-records.js";

const RUN = "run-adapter-a";
const ATTEMPT_ID = "att-1";
const ATTEMPT = 1;
const NOW = "2026-08-13T09:30:00.000Z";

/** In-memory attempt workspace stub capturing every written file. */
class MemoryAgentWorkspace implements AgentWorkspace {
  readonly files = new Map<string, Buffer>();

  writeOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
    content: Buffer;
  }): { relativePath: string; absolutePath: string; sha256: string; sizeBytes: number } {
    this.files.set(input.relativePath, input.content);
    return {
      relativePath: input.relativePath,
      absolutePath: `memory://${input.relativePath}`,
      sha256: "0".repeat(64),
      sizeBytes: input.content.byteLength
    };
  }
}

describe("FakeAgentAdapter", () => {
  it("produces the technical raw records and writes the artifact set, manifest and raw logs", () => {
    const adapter = new FakeAgentAdapter();
    const workspace = new MemoryAgentWorkspace();

    const records = adapter.produceResult({
      runId: RUN,
      attemptId: ATTEMPT_ID,
      attemptSequence: ATTEMPT,
      workspace,
      nowIso: () => NOW,
      recordMp4: false
    });

    expect(records.map((record) => record.type)).toEqual([
      "metadata_updated",
      "turn_completed",
      "result_manifest"
    ]);
    expect(records.every((record) => record.recordVersion === RAW_AGENT_RECORDS_VERSION)).toBe(true);
    expect(adapter.threadIdFor(RUN)).toBe(`thread-${RUN}`);

    // The result manifest document + every required artifact file were written.
    const manifestFile = workspace.files.get("output/result-manifest.json");
    expect(manifestFile).toBeDefined();
    const manifest = validateResultManifest(
      JSON.parse(manifestFile?.toString("utf8") ?? "{}")
    );
    expect(manifest.rebuildStatus).toBe("PASSED");
    for (const key of REQUIRED_RESULT_MANIFEST_ARTIFACTS) {
      expect(workspace.files.has(manifest.artifacts[key].relativePath), key).toBe(true);
      const bytes = workspace.files.get(manifest.artifacts[key].relativePath);
      expect(bytes?.byteLength).toBeGreaterThan(0);
    }
    // The manifest reference of the raw record matches the written document.
    const manifestRecord = records.find((record) => record.type === "result_manifest");
    expect(manifestRecord?.type).toBe("result_manifest");
    if (manifestRecord?.type !== "result_manifest") throw new Error("expected manifest record");
    expect(manifestRecord.manifestRef).toBe("output/result-manifest.json");

    // Technical-only raw log + session snapshot exist and never surface as
    // product events (translator derives only the three product payloads).
    expect(workspace.files.has(RAW_AGENT_LOG_RELATIVE_PATH)).toBe(true);
    expect(workspace.files.has(RAW_AGENT_SESSION_RELATIVE_PATH)).toBe(true);
    const translated = translateRawAgentRecords(records, { attemptId: ATTEMPT_ID });
    expect(translated.ok).toBe(true);
    if (!translated.ok) throw new Error("expected ok translation");
    expect(translated.payloads.map((payload) => payload.type)).toEqual([
      "RuntimeMetadataUpdated",
      "AgentTurnCompleted",
      "ResultManifestReceived"
    ]);
  });

  it("is deterministic per run: identical records, bytes and manifest across calls", () => {
    const adapter = new FakeAgentAdapter();
    const first = new MemoryAgentWorkspace();
    const second = new MemoryAgentWorkspace();
    const options = {
      runId: RUN,
      attemptId: ATTEMPT_ID,
      attemptSequence: ATTEMPT,
      nowIso: () => NOW,
      recordMp4: false
    };
    const recordsA = adapter.produceResult({ ...options, workspace: first });
    const recordsB = adapter.produceResult({ ...options, workspace: second });
    expect(recordsB).toEqual(recordsA);
    expect([...second.files.entries()]).toEqual([...first.files.entries()]);
  });

  it("produces the processMp4 artifact only when recording was requested", () => {
    const adapter = new FakeAgentAdapter();
    const workspace = new MemoryAgentWorkspace();
    adapter.produceResult({
      runId: RUN,
      attemptId: ATTEMPT_ID,
      attemptSequence: ATTEMPT,
      workspace,
      nowIso: () => NOW,
      recordMp4: true
    });
    const manifest = validateResultManifest(
      JSON.parse(workspace.files.get("output/result-manifest.json")?.toString("utf8") ?? "{}")
    );
    expect(manifest.artifacts.processMp4).toBeDefined();
    expect(workspace.files.has("output/process.mp4")).toBe(true);
  });

  it("forwards the test-harness defect into the produced set", () => {
    const adapter = new FakeAgentAdapter();
    const workspace = new MemoryAgentWorkspace();
    adapter.produceResult({
      runId: RUN,
      attemptId: ATTEMPT_ID,
      attemptSequence: ATTEMPT,
      workspace,
      nowIso: () => NOW,
      recordMp4: false,
      resultDefect: { kind: "missing-artifact" }
    });
    const manifest = validateResultManifest(
      JSON.parse(workspace.files.get("output/result-manifest.json")?.toString("utf8") ?? "{}")
    );
    // Declared but never written: the independent validator must reject it.
    expect(manifest.artifacts.sldprt).toBeDefined();
    expect(workspace.files.has(manifest.artifacts.sldprt.relativePath)).toBe(false);
  });

  it("runTurn with produceClarification settles the clarification outcome: runtime records only, no manifest/artifacts, no duplicate ClarificationRequired source", async () => {
    const adapter = new FakeAgentAdapter();
    const workspace = new MemoryAgentWorkspace();

    const outcome = await adapter.runTurn({
      runId: RUN,
      attemptId: ATTEMPT_ID,
      attemptSequence: ATTEMPT,
      workspace,
      nowIso: () => NOW,
      recordMp4: false,
      produceClarification: true,
      workspaceRoot: "C:\\workspaces\\runs\\run-adapter-a\\attempt-001",
      promptText: "prompt",
      localImageAbsolutePath: "C:\\workspaces\\runs\\run-adapter-a\\attempt-001\\input\\drawing.png",
      skill: { name: "solidworks-build-part-from-drawing", resolvedPath: "C:\\skills\\skill" }
    });

    expect(outcome.kind).toBe("clarification");
    if (outcome.kind !== "clarification") throw new Error("expected clarification outcome");
    // Runtime raw records ONLY: metadata + turn — NO result_manifest claim and
    // NO clarification_requested record, so the translator can never produce a
    // ClarificationRequired that would duplicate the orchestrator's event.
    expect(outcome.records.map((record) => record.type)).toEqual([
      "metadata_updated",
      "turn_completed"
    ]);
    // The structured question set the orchestrator persists.
    expect(outcome.questions.map((question) => question.type)).toEqual(["dimension", "choice"]);
    expect(outcome.questions[0]).toMatchObject({ question: "底板厚度是多少？", unit: "mm" });

    // NO manifest and NO artifact set were produced.
    expect(workspace.files.has("output/result-manifest.json")).toBe(false);
    expect([...workspace.files.keys()].some((path) => path.startsWith("output/"))).toBe(false);
    // Technical-only raw log + session snapshot exist.
    expect(workspace.files.has(RAW_AGENT_LOG_RELATIVE_PATH)).toBe(true);
    expect(workspace.files.has(RAW_AGENT_SESSION_RELATIVE_PATH)).toBe(true);
    const session = JSON.parse(
      workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}"
    ) as { status: string; manifestRef?: string; note?: string };
    // Session recorded truthfully: the turn completed WITHOUT a manifest claim.
    expect(session.status).toBe("completed");
    expect(session.manifestRef).toBeUndefined();
    expect(session.note).toContain("clarification request");

    // The raw stream translates to exactly the runtime product events — the
    // translator derives NO ClarificationRequired from it.
    const translated = translateRawAgentRecords(outcome.records, { attemptId: ATTEMPT_ID });
    expect(translated.ok).toBe(true);
    if (!translated.ok) throw new Error("expected ok translation");
    expect(translated.payloads.map((payload) => payload.type)).toEqual([
      "RuntimeMetadataUpdated",
      "AgentTurnCompleted"
    ]);
  });
});
