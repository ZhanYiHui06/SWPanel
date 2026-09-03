import { describe, expect, it } from "vitest";

import {
  AGENT_SESSION_FILE_RELATIVE_PATH,
  buildAgentSessionRecord,
  readAgentSessionRecord,
  validateAgentSessionRecord,
  withAgentSessionStatus,
  writeAgentSessionRecord,
  type AgentSessionRecord
} from "./agent-session.js";

const RUN = "run-session-1";
const ATTEMPT = 1;
const NOW = "2026-08-14T09:00:00.000Z";

/** In-memory session workspace stub (write + read surfaces). */
class MemorySessionWorkspace {
  readonly files = new Map<string, Buffer>();

  writeOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
    content: Buffer;
  }): unknown {
    this.files.set(input.relativePath, input.content);
    return {
      relativePath: input.relativePath,
      absolutePath: `memory://${input.relativePath}`,
      sha256: "0".repeat(64),
      sizeBytes: input.content.byteLength
    };
  }

  readOwnedFile(input: {
    runId: string;
    attemptSequence: number;
    relativePath: string;
  }): { content?: Buffer } | null {
    const content = this.files.get(input.relativePath);
    return content === undefined ? null : { content };
  }
}

function sampleRecord(): AgentSessionRecord {
  return buildAgentSessionRecord({
    threadId: "thread-1",
    status: "started",
    adapterId: "codex-app-server",
    adapterVersion: "0.147.0",
    protocol: "codex-app-server",
    protocolVersion: "2",
    nowIso: () => NOW,
    attemptId: "att-1",
    note: "technical session snapshot, never a product event"
  });
}

describe("AgentSessionStore (P5-3)", () => {
  it("writes and strictly re-reads a technical session record through the workspace", () => {
    const workspace = new MemorySessionWorkspace();
    const record = sampleRecord();
    writeAgentSessionRecord(workspace, { runId: RUN, attemptSequence: ATTEMPT, record });
    expect(workspace.files.has(AGENT_SESSION_FILE_RELATIVE_PATH)).toBe(true);

    const read = readAgentSessionRecord(workspace, { runId: RUN, attemptSequence: ATTEMPT });
    expect(read).toEqual(record);
    expect(read?.threadId).toBe("thread-1");
  });

  it("applies status updates while preserving the session origin timestamp", () => {
    const updated = withAgentSessionStatus(sampleRecord(), {
      status: "in_progress",
      turnId: "turn-9",
      nowIso: () => "2026-08-14T09:01:00.000Z"
    });
    expect(updated.status).toBe("in_progress");
    expect(updated.turnId).toBe("turn-9");
    expect(updated.startedAt).toBe(NOW);
    expect(updated.updatedAt).toBe("2026-08-14T09:01:00.000Z");
  });

  it("replaces the technical note through a status update and stays strictly valid (schemaVersion 1)", () => {
    const updated = withAgentSessionStatus(sampleRecord(), {
      status: "failed",
      note: "Codex turn failed: the Codex turn failed without a technical detail",
      nowIso: () => "2026-08-14T09:02:00.000Z"
    });
    expect(updated.status).toBe("failed");
    expect(updated.note).toBe(
      "Codex turn failed: the Codex turn failed without a technical detail"
    );
    expect(updated.startedAt).toBe(NOW);
    // The optional note stays within the strict allowlist at schemaVersion 1.
    expect(validateAgentSessionRecord(updated)).toEqual(updated);
  });

  it("rejects malformed records strictly (unknown keys, bad types, wrong version)", () => {
    const base = sampleRecord();
    expect(validateAgentSessionRecord(base)).toEqual(base);

    const cases: unknown[] = [
      null,
      "string",
      42,
      [],
      { ...base, schemaVersion: 2 },
      { ...base, unknownField: "x" },
      { ...base, threadId: "" },
      { ...base, status: "bogus" },
      { ...base, startedAt: "not-a-date" },
      { ...base, updatedAt: "not-a-date" },
      { ...base, turnId: 5 },
      { ...base, adapterId: "" },
      { ...base, manifestRef: "" },
      { ...base, attemptId: 5 }
    ];
    for (const value of cases) {
      expect(validateAgentSessionRecord(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("returns null (never throws raw content) for an absent or malformed stored file", () => {
    const workspace = new MemorySessionWorkspace();
    expect(readAgentSessionRecord(workspace, { runId: RUN, attemptSequence: ATTEMPT })).toBeNull();

    workspace.files.set(AGENT_SESSION_FILE_RELATIVE_PATH, Buffer.from("{broken json", "utf8"));
    expect(readAgentSessionRecord(workspace, { runId: RUN, attemptSequence: ATTEMPT })).toBeNull();
  });

  it("is redacted by construction: only allowlisted technical fields ever exist", () => {
    const record = sampleRecord();
    const keys = Object.keys(record);
    expect(keys).toEqual([
      "schemaVersion",
      "threadId",
      "status",
      "adapterId",
      "adapterVersion",
      "protocol",
      "protocolVersion",
      "startedAt",
      "updatedAt",
      "attemptId",
      "note"
    ]);
    // No prompt text, no reasoning content, no absolute host paths.
    expect(JSON.stringify(record)).not.toContain("prompt");
    expect(JSON.stringify(record)).not.toContain("reasoning");
  });
});
