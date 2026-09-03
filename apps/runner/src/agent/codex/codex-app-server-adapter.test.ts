import { describe, expect, it } from "vitest";

import { validateResultManifest } from "@swpanel/contracts";

import type { AgentTurnInput } from "../agent-turn-adapter.js";
import { RAW_AGENT_LOG_RELATIVE_PATH, RAW_AGENT_SESSION_RELATIVE_PATH } from "../raw-agent-records.js";
import { buildAgentSessionRecord, validateAgentSessionRecord } from "./agent-session.js";
import {
  CodexAppServerAdapter,
  type CodexAppServerAdapterOptions
} from "./codex-app-server-adapter.js";
import {
  CodexAppServerClient,
  DEFAULT_CODEX_TURN_WAIT_TIMEOUT_MS,
  type CodexTransport
} from "./codex-app-server-client.js";
import {
  decodeJsonRpcLine,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest
} from "./jsonrpc-codec.js";

const RUN = "run-adapter-1";
const ATTEMPT_ID = "att-1";
const ATTEMPT = 1;
const NOW = "2026-08-14T09:30:00.000Z";
const ATTEMPT_ROOT = "C:\\workspaces\\runs\\run-adapter-1\\attempt-001";
const IMAGE = `${ATTEMPT_ROOT}\\input\\drawing.png`;
const SKILL_PATH = "C:\\skills\\solidworks-build-part-from-drawing";

/** The fixed bounded activity summary suffix of a failed note with NO observed current-turn activity. */
const NO_ACTIVITY_SUMMARY =
  "turn activity: agent-message=0 command-execution=0 file-change=0 tool-or-other=0 approval-request=0; last activity: none";

/** The activity summary suffix when ONE current-turn agent-message delta was observed. */
const AGENT_MESSAGE_ACTIVITY_SUMMARY =
  "turn activity: agent-message=1 command-execution=0 file-change=0 tool-or-other=0 approval-request=0; last activity: agent-message";

const INITIALIZE_RESULT = {
  codexHome: "C:\\Users\\me\\.codex",
  platformFamily: "windows",
  platformOs: "windows",
  userAgent: "codex-app-server/0.147.0"
};

/** In-memory attempt workspace stub capturing every written file. */
class MemoryAgentWorkspace {
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

/**
 * Two-sided in-process transport: the client registers its line handler
 * (`setLineHandler`, the `CodexTransport` contract); the scripted server
 * registers the peer side. `writeLine` (client→server) delivers to the peer;
 * `receiveMessage` (server→client) delivers to the client handler — no echo.
 */
class ScriptedCodexTransport implements CodexTransport {
  private clientHandler: ((line: string) => void) | null = null;
  private peerHandler: ((line: string) => void) | null = null;
  private exitHandler: ((exit: { code: number | null; signal: string | null }) => void) | null =
    null;

  writeLine(line: string): void {
    this.peerHandler?.(line);
  }

  setLineHandler(handler: (line: string) => void): void {
    this.clientHandler = handler;
  }

  /** The scripted server's receive side. */
  registerPeer(handler: (line: string) => void): void {
    this.peerHandler = handler;
  }

  setExitHandler(handler: (exit: { code: number | null; signal: string | null }) => void): void {
    this.exitHandler = handler;
  }

  close(): void {
    // no-op
  }

  receiveMessage(message: JsonRpcMessage): void {
    this.clientHandler?.(JSON.stringify(message));
  }

  /** Signals the child-process exit (as a real spawn transport would). */
  emitExit(code: number | null, signal: string | null): void {
    this.exitHandler?.({ code, signal });
  }
}

/**
 * Scripted Codex App Server: auto-answers the configured request methods and
 * records every request/notification the client sent, in order. The test
 * drives the turn notifications (deltas + turn/completed) explicitly — no
 * real process is ever spawned.
 */
class ScriptedCodexServer {
  readonly transport = new ScriptedCodexTransport();
  readonly seen: Array<{ kind: "request" | "notification"; method: string; params?: unknown }> = [];
  private readonly responders = new Map<string, (params: unknown) => unknown>();
  private threadCounter = 0;
  private turnCounter = 0;
  private lastThreadId = "thread-none";
  private lastTurnId = "turn-none";
  private readonly earlyDelta: string | null;
  private readonly interruptBehavior: "respond" | "ignore" | "error";

  constructor(options: { earlyDelta?: string; interruptBehavior?: "respond" | "ignore" | "error" } = {}) {
    this.earlyDelta = options.earlyDelta ?? null;
    this.interruptBehavior = options.interruptBehavior ?? "respond";
    this.transport.registerPeer((line) => {
      const decoded = decodeJsonRpcLine(line);
      if (decoded.kind === "notification") {
        const message = decoded.message as JsonRpcNotification;
        this.seen.push({ kind: "notification", method: message.method, params: message.params });
        return;
      }
      if (decoded.kind !== "request") return;
      const message = decoded.message as JsonRpcRequest;
      this.seen.push({ kind: "request", method: message.method, params: message.params });
      const responder = this.responders.get(message.method);
      if (responder === undefined) return; // left pending: timeout tests
      const outcome = responder(message.params);
      if (outcome === undefined) return; // responder declined: left pending
      if (outcome !== null && typeof outcome === "object" && "__error" in outcome) {
        this.transport.receiveMessage({
          id: message.id,
          error: (outcome as { __error: { code: number; message: string } }).__error
        });
        return;
      }
      this.transport.receiveMessage({ id: message.id, result: outcome });
    });
    // Default auto-answers of the used subset (track the live thread/turn so
    // the test's notification emissions target the CURRENT turn).
    this.respond("initialize", () => INITIALIZE_RESULT);
    this.respond("thread/start", () => {
      this.threadCounter += 1;
      this.lastThreadId = `thread-${this.threadCounter}`;
      return { thread: { id: this.lastThreadId } };
    });
    this.respond("thread/resume", (params) => {
      this.lastThreadId = (params as { threadId: string }).threadId;
      return { thread: { id: this.lastThreadId } };
    });
    this.respond("turn/start", () => {
      this.turnCounter += 1;
      this.lastTurnId = `turn-${this.turnCounter}`;
      // Listener-race coverage: a delta emitted BEFORE the turn/start response
      // (during request processing) must still be captured by the adapter.
      if (this.earlyDelta !== null) {
        this.transport.receiveMessage({
          method: "item/agentMessage/delta",
          params: {
            threadId: this.lastThreadId,
            turnId: this.lastTurnId,
            itemId: "item-final",
            delta: this.earlyDelta
          }
        });
      }
      return { turn: { id: this.lastTurnId } };
    });
    this.respond("turn/interrupt", () => {
      if (this.interruptBehavior === "ignore") return undefined; // left pending
      if (this.interruptBehavior === "error") {
        return { __error: { code: -32603, message: "interrupt refused" } };
      }
      return {};
    });
  }

  respond(method: string, responder: (params: unknown) => unknown): void {
    this.responders.set(method, responder);
  }

  /** The request methods the client sent, in order. */
  requestMethods(): string[] {
    return this.seen.filter((entry) => entry.kind === "request").map((entry) => entry.method);
  }

  /** The params of the LAST request with the given method, or undefined. */
  lastRequestParams(method: string): unknown {
    const matches = this.seen.filter((entry) => entry.kind === "request" && entry.method === method);
    return matches.at(-1)?.params;
  }

  /** Emits one agentMessage delta of the CURRENT turn. */
  emitAgentMessageDelta(delta: string, itemId = "item-final"): void {
    this.transport.receiveMessage({
      method: "item/agentMessage/delta",
      params: { threadId: this.lastThreadId, turnId: this.lastTurnId, itemId, delta }
    });
  }

  /** Emits the terminal turn/completed notification of the CURRENT turn. */
  emitTurnCompleted(
    status: "completed" | "interrupted" | "failed",
    error?: { message: string }
  ): void {
    this.transport.receiveMessage({
      method: "turn/completed",
      params: {
        threadId: this.lastThreadId,
        turn: { id: this.lastTurnId, status, ...(error === undefined ? {} : { error }) }
      }
    });
  }
}

/** A manifest the shared validator accepts (its artifact refs are truthful). */
function acceptedManifestJson(): string {
  return JSON.stringify({
    contractVersion: 1,
    result: "completed",
    solidWorksVersion: "2022",
    units: "mm",
    projectionDecision: "first-angle",
    featureCount: 4,
    bodyCount: 1,
    rebuildStatus: "PASSED",
    unresolvedAssumptions: [],
    // Provider wire shape: productionVerified is REQUIRED (false is the
    // expected claim for this product's HIL) and processMp4 is a required
    // nullable sentinel of the optional recording artifact.
    productionVerified: false,
    artifacts: {
      sldprt: { fileName: "fake-model.sldprt", relativePath: "output/fake-model.sldprt", sizeBytes: 128, sha256: "a".repeat(64) },
      preview: { fileName: "preview.png", relativePath: "output/preview.png", sizeBytes: 64, sha256: "b".repeat(64) },
      dimensionLedger: { fileName: "dimension-ledger.json", relativePath: "output/dimension-ledger.json", sizeBytes: 64, sha256: "c".repeat(64) },
      featurePlan: { fileName: "feature-plan.json", relativePath: "output/feature-plan.json", sizeBytes: 64, sha256: "d".repeat(64) },
      buildValidationLog: { fileName: "build-validation.log", relativePath: "output/build-validation.log", sizeBytes: 64, sha256: "e".repeat(64) },
      builderSource: { fileName: "builder-source.json", relativePath: "output/builder-source.json", sizeBytes: 64, sha256: "f".repeat(64) },
      processMp4: null
    }
  });
}

/**
 * A completed Agent Turn Output document in the PROVIDER wire shape the
 * adapter's strict projector accepts: all four top-level fields present, the
 * manifest embedded in the `completed` object-or-null sentinel and the
 * `questions` sentinel null (the terminal states are mutually exclusive).
 */
function acceptedTurnOutputJson(): string {
  return JSON.stringify({
    contractVersion: 1,
    result: "completed",
    completed: JSON.parse(acceptedManifestJson()) as unknown,
    questions: null
  });
}

/** The SAME completed wire document, but with a DIFFERENT manifest claim (featureCount). */
function acceptedTurnOutputJsonWithFeatureCount(featureCount: number): string {
  const manifest = JSON.parse(acceptedManifestJson()) as Record<string, unknown>;
  manifest.featureCount = featureCount;
  return JSON.stringify({
    contractVersion: 1,
    result: "completed",
    completed: manifest,
    questions: null
  });
}

/** Recursively re-inserts every object key in REVERSE order (semantics unchanged). */
function reorderKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderKeysDeep);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(record).reverse()) {
      reordered[key] = reorderKeysDeep(record[key]);
    }
    return reordered;
  }
  return value;
}

/** The accepted completed document with EVERY object's key order reversed. */
function acceptedTurnOutputJsonWithReorderedKeys(): string {
  return JSON.stringify(reorderKeysDeep(JSON.parse(acceptedTurnOutputJson()) as unknown));
}

/** A clarification Agent Turn Output document in the PROVIDER wire shape. */
function clarificationTurnOutputJson(): string {
  return JSON.stringify({
    contractVersion: 1,
    result: "clarification_required",
    completed: null,
    questions: [
      {
        id: "q1",
        type: "dimension",
        question: "底板厚度是多少？",
        hint: "例如 12",
        unit: "mm",
        options: null
      },
      {
        id: "q2",
        type: "choice",
        question: "焊缝处理方式？",
        hint: null,
        unit: null,
        options: [
          { id: "none", label: "无需焊缝" },
          { id: "full", label: "全周满焊" }
        ]
      }
    ]
  });
}

function adapterFor(
  server: ScriptedCodexServer,
  turnTimeoutMs = 5_000,
  adapterOptions: Omit<CodexAppServerAdapterOptions, "client"> = {}
): CodexAppServerAdapter {
  const client = new CodexAppServerClient({
    transport: server.transport,
    requestTimeoutMs: 1_000
  });
  return new CodexAppServerAdapter({ client, turnTimeoutMs, ...adapterOptions });
}

function turnInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    runId: RUN,
    attemptId: ATTEMPT_ID,
    attemptSequence: ATTEMPT,
    workspace: new MemoryAgentWorkspace(),
    nowIso: () => NOW,
    recordMp4: false,
    workspaceRoot: ATTEMPT_ROOT,
    promptText: "请根据图纸建模并输出结果清单",
    localImageAbsolutePath: IMAGE,
    skill: { name: "solidworks-build-part-from-drawing", resolvedPath: SKILL_PATH },
    ...overrides
  };
}

/** Lets the synchronous-responding server settle the client's microtask chain. */
async function settle(): Promise<void> {
  for (let index = 0; index < 32; index++) await Promise.resolve();
}

/** Polls until the condition holds (bounded) — lets real timers fire. */
async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("waitForCondition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("CodexAppServerAdapter (P5-3, scripted transport)", () => {
  it("shares the exported bounded 2-hour turn-wait default with the client", () => {
    const server = new ScriptedCodexServer();
    const client = new CodexAppServerClient({ transport: server.transport });
    const adapter = new CodexAppServerAdapter({ client });

    expect(DEFAULT_CODEX_TURN_WAIT_TIMEOUT_MS).toBe(120 * 60_000);
    expect((client as unknown as { turnWaitTimeoutMs: number }).turnWaitTimeoutMs).toBe(
      DEFAULT_CODEX_TURN_WAIT_TIMEOUT_MS
    );
    expect((adapter as unknown as { turnTimeoutMs: number }).turnTimeoutMs).toBe(
      DEFAULT_CODEX_TURN_WAIT_TIMEOUT_MS
    );
  });

  it("runs a successful turn: handshake, fresh thread/start, turn/start with Agent Turn Output outputSchema, then the completed outcome", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const input = turnInput();

    const run = adapter.runTurn(input);
    await settle();
    expect(server.requestMethods()).toEqual(["initialize", "thread/start", "turn/start"]);
    // Fresh start: thread/resume was never called.
    expect(server.seen.some((entry) => entry.method === "thread/resume")).toBe(false);

    // The turn input carries text + localImage + skill; the outputSchema is the
    // PROVIDER-FACING Agent Turn Output wire schema (flattened Structured
    // Outputs projection of the canonical either/or contract); writableRoots =
    // attempt root ONLY.
    const turnParams = server.lastRequestParams("turn/start") as {
      input: Array<{ type: string; text?: string; path?: string; name?: string }>;
      outputSchema: unknown;
      sandboxPolicy: { type: string; writableRoots: string[] };
    };
    expect(turnParams.input.map((entry) => entry.type)).toEqual(["text", "localImage", "skill"]);
    expect(turnParams.input[0]?.text).toBe(input.promptText);
    expect(turnParams.input[1]?.path).toBe(IMAGE);
    expect(turnParams.input[2]).toEqual({
      type: "skill",
      name: "solidworks-build-part-from-drawing",
      path: SKILL_PATH
    });
    expect(turnParams.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: [ATTEMPT_ROOT]
    });

    // The turn transcript: deltas + completion are emitted while the adapter
    // waits for turn/completed (code-fenced JSON is accepted).
    server.emitAgentMessageDelta("```json\n");
    server.emitAgentMessageDelta(acceptedTurnOutputJson());
    server.emitAgentMessageDelta("\n```");
    server.emitTurnCompleted("completed");

    const outcome = await run;
    const records = outcome.records;
    // Translator-compatible order ending turn_completed then result_manifest.
    expect(records.map((record) => record.type)).toEqual([
      "metadata_updated",
      "turn_completed",
      "result_manifest"
    ]);
    const manifestRecord = records[2];
    if (manifestRecord?.type !== "result_manifest") throw new Error("expected result_manifest");
    expect(manifestRecord.manifestRef).toBe("output/result-manifest.json");

    // The extracted manifest was written and is schema-valid.
    const workspace = input.workspace as MemoryAgentWorkspace;
    const manifest = validateResultManifest(
      JSON.parse(workspace.files.get("output/result-manifest.json")?.toString("utf8") ?? "{}")
    );
    expect(manifest.rebuildStatus).toBe("PASSED");

    // Technical-only files: raw log + strictly validated session record.
    expect(workspace.files.has(RAW_AGENT_LOG_RELATIVE_PATH)).toBe(true);
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.threadId).toBe("thread-1");
    expect(session?.status).toBe("completed");
    expect(session?.manifestRef).toBe("output/result-manifest.json");
    // Successful sessions are unchanged: the technical note stays the
    // build-time snapshot note (no failure diagnostic is ever injected).
    expect(session?.note).toBe("technical session snapshot, never a product event");
  });

  it("records modelSupportsImageInput from the AUTHORITATIVE option, fail-closed false by default", async () => {
    // No option: the adapter must NEVER invent image support — it records
    // false (fail-closed), not a hardcoded true.
    const serverDefault = new ScriptedCodexServer();
    const adapterDefault = adapterFor(serverDefault);
    const runDefault = adapterDefault.runTurn(turnInput());
    await settle();
    serverDefault.emitAgentMessageDelta(acceptedTurnOutputJson());
    serverDefault.emitTurnCompleted("completed");
    const defaultOutcome = await runDefault;
    const defaultRecords = defaultOutcome.records;
    const defaultMetadata = defaultRecords.find((record) => record.type === "metadata_updated");
    expect(defaultMetadata?.modelSupportsImageInput).toBe(false);

    // Explicit authoritative input (the SAME proven value the preflight gate
    // used): recorded verbatim.
    const serverExplicit = new ScriptedCodexServer();
    const adapterExplicit = adapterFor(serverExplicit, 5_000, {
      modelSupportsImageInput: true
    });
    const runExplicit = adapterExplicit.runTurn(turnInput());
    await settle();
    serverExplicit.emitAgentMessageDelta(acceptedTurnOutputJson());
    serverExplicit.emitTurnCompleted("completed");
    const explicitOutcome = await runExplicit;
    const explicitRecords = explicitOutcome.records;
    const explicitMetadata = explicitRecords.find((record) => record.type === "metadata_updated");
    expect(explicitMetadata?.modelSupportsImageInput).toBe(true);
  });

  it("resumes the supplied prior session thread via thread/resume instead of a fresh start", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const prior = buildAgentSessionRecord({
      threadId: "thread-prior-9",
      status: "completed",
      adapterId: adapter.adapterId,
      adapterVersion: adapter.adapterVersion,
      protocol: adapter.protocol,
      protocolVersion: adapter.protocolVersion,
      nowIso: () => NOW
    });

    const run = adapter.runTurn(turnInput({ priorSession: prior }));
    await settle();
    expect(server.requestMethods()).toEqual(["initialize", "thread/resume", "turn/start"]);
    expect(server.lastRequestParams("thread/resume")).toMatchObject({ threadId: "thread-prior-9" });

    server.emitAgentMessageDelta(acceptedTurnOutputJson());
    server.emitTurnCompleted("completed");
    const outcome = await run;
    const records = outcome.records;
    expect(records.some((record) => record.type === "turn_completed")).toBe(true);
  });

  it("fails a malformed supplied prior session as AGENT_PROTOCOL_INCOMPATIBLE", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const malformed = {
      schemaVersion: 1,
      threadId: "thread-x",
      status: "bogus-status",
      adapterId: "a",
      adapterVersion: "b",
      protocol: "c",
      protocolVersion: "d",
      startedAt: NOW,
      updatedAt: NOW
    };
    await expect(
      adapter.runTurn(turnInput({ priorSession: malformed as never }))
    ).rejects.toMatchObject({ name: "AgentTurnError", code: "AGENT_PROTOCOL_INCOMPATIBLE" });
  });

  it("fails an incomplete turn input (missing prompt) as AGENT_PROTOCOL_INCOMPATIBLE and terminates the started session", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const input = turnInput({ promptText: "" });
    await expect(adapter.runTurn(input)).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE"
    });
    const session = validateAgentSessionRecord(
      JSON.parse(
        (input.workspace as MemoryAgentWorkspace).files
          .get(RAW_AGENT_SESSION_RELATIVE_PATH)
          ?.toString("utf8") ?? "{}"
      )
    );
    expect(session?.status).toBe("failed");
    expect(session?.turnId).toBeUndefined();
    expect(session?.note).toBe("Codex turn failed: Codex turn start failed");
  });

  it("persists a bounded/redacted turn/start JSON-RPC diagnostic before propagating AGENT_PROTOCOL_INCOMPATIBLE", async () => {
    const server = new ScriptedCodexServer();
    server.respond("turn/start", () => ({
      __error: {
        code: -32600,
        message:
          "Invalid schema at C:\\Users\\me\\run\\schema.json; " +
          "api_key=sk-live-1234567890abcdef; see https://api.example.com/schema"
      }
    }));
    const adapter = adapterFor(server);
    const input = turnInput();

    await expect(adapter.runTurn(input)).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE"
    });

    const session = validateAgentSessionRecord(
      JSON.parse(
        (input.workspace as MemoryAgentWorkspace).files
          .get(RAW_AGENT_SESSION_RELATIVE_PATH)
          ?.toString("utf8") ?? "{}"
      )
    );
    expect(session?.status).toBe("failed");
    expect(session?.turnId).toBeUndefined();
    expect(session?.note).toContain("Invalid schema");
    expect(session?.note).toContain("<path>");
    expect(session?.note).toContain("api_key=<redacted>");
    expect(session?.note).toContain("<url>");
    expect(session?.note).not.toContain("C:\\Users\\me");
    expect(session?.note).not.toContain("sk-live-1234567890abcdef");
    expect(session?.note).not.toContain("api.example.com");
    expect(session?.note?.length).toBeLessThanOrEqual(600);
  });

  it("terminates the started session with a stable category when turn/start times out", async () => {
    const server = new ScriptedCodexServer();
    server.respond("turn/start", () => undefined);
    const client = new CodexAppServerClient({
      transport: server.transport,
      requestTimeoutMs: 20
    });
    const adapter = new CodexAppServerAdapter({ client, turnTimeoutMs: 5_000 });
    const input = turnInput();

    await expect(adapter.runTurn(input)).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_TIMEOUT"
    });

    const session = validateAgentSessionRecord(
      JSON.parse(
        (input.workspace as MemoryAgentWorkspace).files
          .get(RAW_AGENT_SESSION_RELATIVE_PATH)
          ?.toString("utf8") ?? "{}"
      )
    );
    expect(session?.status).toBe("failed");
    expect(session?.turnId).toBeUndefined();
    expect(session?.note).toBe("Codex turn failed: turn/start TIMEOUT");
  });

  it("maps a turn that never completes to AGENT_TIMEOUT", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server, 20, { interruptGraceTimeoutMs: 40 });
    const run = adapter.runTurn(turnInput());
    // turn/start answered; NO completion is ever emitted. After the wait
    // timeout the adapter interrupts the turn and waits a short grace, which
    // also expires; the ORIGINAL AGENT_TIMEOUT is thrown.
    await expect(run).rejects.toMatchObject({ name: "AgentTurnError", code: "AGENT_TIMEOUT" });
  });

  it("maps malformed final agent message JSON to AGENT_PROTOCOL_INCOMPATIBLE", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    server.emitAgentMessageDelta("{not-json");
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE",
      diagnostic: "no-balanced-json-object"
    });
  });

  it("classifies a completed turn with no agent message item without persisting raw content", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE",
      diagnostic: "no-agent-message-items"
    });
    const session = validateAgentSessionRecord(
      JSON.parse(
        (input.workspace as MemoryAgentWorkspace).files
          .get(RAW_AGENT_SESSION_RELATIVE_PATH)
          ?.toString("utf8") ?? "{}"
      )
    );
    expect(session?.note).toBe(
      "Codex turn failed: Agent Turn Output extraction failed: no-agent-message-items"
    );
  });

  it("maps a final message that violates the Agent Turn Output contract to AGENT_PROTOCOL_INCOMPATIBLE", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    // Version mismatch AND neither terminal state: no valid document.
    server.emitAgentMessageDelta(JSON.stringify({ contractVersion: 999, result: "failed" }));
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE"
    });
  });

  it("maps a final message with an ILLEGAL choice question (no options) to AGENT_PROTOCOL_INCOMPATIBLE", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    // Provider wire shape, but the choice question carries options: null — the
    // canonical validator rejects the projected choice-without-options.
    server.emitAgentMessageDelta(
      JSON.stringify({
        contractVersion: 1,
        result: "clarification_required",
        completed: null,
        questions: [{ id: "q1", type: "choice", question: "倒角？", hint: null, unit: null, options: null }]
      })
    );
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE"
    });
  });

  it("maps a final message with an illegal question type to AGENT_PROTOCOL_INCOMPATIBLE", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    server.emitAgentMessageDelta(
      JSON.stringify({
        contractVersion: 1,
        result: "clarification_required",
        completed: null,
        questions: [{ id: "q1", type: "date", question: "when?", hint: null, unit: null, options: null }]
      })
    );
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE"
    });
  });

  it("maps an interrupted turn to AGENT_INTERRUPTED and a failed turn to AGENT_RUNTIME_UNAVAILABLE", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const interrupted = adapter.runTurn(turnInput());
    await settle();
    server.emitTurnCompleted("interrupted");
    await expect(interrupted).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_INTERRUPTED"
    });

    const failed = adapter.runTurn(turnInput());
    await settle();
    server.emitTurnCompleted("failed");
    await expect(failed).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_RUNTIME_UNAVAILABLE"
    });
  });

  it("persists a bounded/redacted technical diagnostic note for a failed turn while the thrown error stays generic", async () => {
    // The native turn carries a technical error message full of host paths,
    // a UNC path, a URL, a Bearer token, an api_key assignment and control
    // characters — the session note must store a bounded, redacted digest
    // while the thrown AgentTurnError stays generic with an unchanged code.
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    server.emitTurnCompleted("failed", {
      message: [
        "native skill turn failed: C:\\Users\\me\\.codex\\logs\\runner.log; ",
        "\\\\nas\\share\\run\\input\\drawing.png unreadable; ",
        "api_key=sk-live-1234567890abcdef; ",
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5_NXgL0n3I9PlFUP0THsR8U; ",
        "see https://api.example.com/v1/runs?token=abc&key=xyz#frag; ",
        "secret=\"hunter2\"\r\n\t(attempt 1)"
      ].join("")
    });
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_RUNTIME_UNAVAILABLE",
      message: "the Codex turn failed before producing a result"
    });

    // The technical session record carries the sanitized diagnostic.
    const workspace = input.workspace as MemoryAgentWorkspace;
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.status).toBe("failed");
    const note = session?.note ?? "";
    expect(note.startsWith("Codex turn failed: ")).toBe(true);
    // Bounded: the sanitized digest never exceeds the 512-char cap.
    expect(note.length).toBeLessThanOrEqual("Codex turn failed: ".length + 512);
    // Redacted: no raw path, no UNC host, no URL, no credential value.
    expect(note).not.toContain("C:\\Users\\me");
    expect(note).not.toContain("runner.log");
    expect(note).not.toContain("nas\\share");
    expect(note).not.toContain("sk-live-1234567890abcdef");
    expect(note).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(note).not.toContain("api.example.com");
    expect(note).not.toContain("hunter2");
    // The diagnostic stays readable: key names and plain text survive.
    expect(note).toContain("native skill turn failed");
    expect(note).toContain("api_key");
    expect(note).toContain("attempt 1");
    // No raw agent log is written for a failed turn (records stay product-free).
    expect(workspace.files.has(RAW_AGENT_LOG_RELATIVE_PATH)).toBe(false);
  });

  it("persists the stable generic diagnostic note when a failed turn carries no error message", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    server.emitTurnCompleted("failed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_RUNTIME_UNAVAILABLE",
      message: "the Codex turn failed before producing a result"
    });
    const workspace = input.workspace as MemoryAgentWorkspace;
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.status).toBe("failed");
    expect(session?.note).toBe(
      "Codex turn failed: the Codex turn failed without a technical detail"
    );
  });

  it("marks the technical session failed with a safe category when parseable JSON violates the provider wire contract", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    // The turn completed, but its agent messages carry NO valid Agent Turn
    // Output document (parses, violates the contract).
    server.emitAgentMessageDelta(JSON.stringify({ contractVersion: 999, result: "failed" }));
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE",
      diagnostic: "no-valid-provider-wire-document"
    });

    // The in_progress session MUST end failed with a fixed category derived
    // only from parser/validator counts — never raw Agent content.
    const workspace = input.workspace as MemoryAgentWorkspace;
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.status).toBe("failed");
    expect(session?.turnId).toBe("turn-1");
    expect(session?.note).toBe(
      "Codex turn failed: Agent Turn Output extraction failed: no-valid-provider-wire-document"
    );
    expect(workspace.files.has("output/result-manifest.json")).toBe(false);
    expect(workspace.files.has(RAW_AGENT_LOG_RELATIVE_PATH)).toBe(false);
  });

  it("marks the technical session failed when the turn carries MULTIPLE DISTINCT valid terminal documents", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    // Two GENUINELY DIFFERENT completed documents (different manifest claims:
    // the featureCount differs) — semantically identical duplicates would have
    // folded into one, but a conflicting second manifest is ambiguity.
    server.emitAgentMessageDelta(acceptedTurnOutputJson(), "item-a");
    server.emitAgentMessageDelta(
      acceptedTurnOutputJsonWithFeatureCount(7),
      "item-b"
    );
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE",
      diagnostic: "multiple-valid-provider-wire-documents"
    });

    // The in_progress session MUST end failed with the fixed ambiguity category.
    const workspace = input.workspace as MemoryAgentWorkspace;
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.status).toBe("failed");
    expect(session?.turnId).toBe("turn-1");
    expect(session?.note).toBe(
      "Codex turn failed: Agent Turn Output extraction failed: multiple-valid-provider-wire-documents"
    );
    expect(workspace.files.has("output/result-manifest.json")).toBe(false);
    expect(workspace.files.has(RAW_AGENT_LOG_RELATIVE_PATH)).toBe(false);
  });

  it("marks a turn timeout with the safe no-agent-message-items category", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server, 20, { interruptGraceTimeoutMs: 40 });
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    // No completion or agent-message item is ever emitted: the adapter
    // interrupts the timed-out turn, the grace expires unconfirmed and the
    // client is poisoned — the note keeps the content-independent
    // classification and gains ONLY the safe interrupt outcome category.
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_TIMEOUT"
    });

    const workspace = input.workspace as MemoryAgentWorkspace;
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.status).toBe("failed");
    expect(session?.turnId).toBe("turn-1");
    expect(session?.note).toBe(
      `Codex turn failed: turn wait timed out: no-agent-message-items; interrupt outcome: grace-timed-out; ${NO_ACTIVITY_SUMMARY}`
    );
    expect(workspace.files.has("output/result-manifest.json")).toBe(false);
    expect(workspace.files.has(RAW_AGENT_LOG_RELATIVE_PATH)).toBe(false);
  });

  it("marks a turn timeout when an agent-message item was observed without persisting its content", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server, 20, { interruptGraceTimeoutMs: 40 });
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    server.emitAgentMessageDelta("not persisted");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_TIMEOUT"
    });

    const workspace = input.workspace as MemoryAgentWorkspace;
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.status).toBe("failed");
    expect(session?.turnId).toBe("turn-1");
    expect(session?.note).toBe(
      `Codex turn failed: turn wait timed out: agent-message-items-observed; interrupt outcome: grace-timed-out; ${AGENT_MESSAGE_ACTIVITY_SUMMARY}`
    );
    expect(JSON.stringify(session)).not.toContain("not persisted");
    expect(workspace.files.has("output/result-manifest.json")).toBe(false);
    expect(workspace.files.has(RAW_AGENT_LOG_RELATIVE_PATH)).toBe(false);
  });

  it("ignores an agent-message item belonging to a foreign turn when classifying timeout", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server, 20, { interruptGraceTimeoutMs: 40 });
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    server.transport.receiveMessage({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-foreign",
        itemId: "item-foreign",
        delta: "not persisted"
      }
    });
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_TIMEOUT"
    });

    const workspace = input.workspace as MemoryAgentWorkspace;
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.note).toBe(
      `Codex turn failed: turn wait timed out: no-agent-message-items; interrupt outcome: grace-timed-out; ${NO_ACTIVITY_SUMMARY}`
    );
    expect(JSON.stringify(session)).not.toContain("not persisted");
  });

  it("counts current-turn notifications into fixed categories and records the last activity before a timeout", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server, 20, { interruptGraceTimeoutMs: 40 });
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    server.emitAgentMessageDelta("secret-agent-text");
    server.transport.receiveMessage({
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-cmd",
        delta: "secret-command-output"
      }
    });
    server.transport.receiveMessage({
      method: "item/fileChange/outputDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-file",
        delta: "secret-file-diff"
      }
    });
    server.transport.receiveMessage({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: { id: "item-tool" }, startedAtMs: 1 }
    });
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_TIMEOUT"
    });

    const workspace = input.workspace as MemoryAgentWorkspace;
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.status).toBe("failed");
    expect(session?.note).toBe(
      "Codex turn failed: turn wait timed out: agent-message-items-observed; " +
        "interrupt outcome: grace-timed-out; " +
        "turn activity: agent-message=1 command-execution=1 file-change=1 tool-or-other=1 approval-request=0; " +
        "last activity: tool-or-other"
    );
    // Privacy: raw method names, deltas, item ids or reasoning never persisted.
    expect(JSON.stringify(session)).not.toContain("item/commandExecution");
    expect(JSON.stringify(session)).not.toContain("item/fileChange");
    expect(JSON.stringify(session)).not.toContain("item/started");
    expect(JSON.stringify(session)).not.toContain("secret-agent-text");
    expect(JSON.stringify(session)).not.toContain("secret-command-output");
    expect(JSON.stringify(session)).not.toContain("secret-file-diff");
    expect(JSON.stringify(session)).not.toContain("item-cmd");
    expect(JSON.stringify(session)).not.toContain("item-file");
    expect(JSON.stringify(session)).not.toContain("item-tool");
    expect(workspace.files.has("output/result-manifest.json")).toBe(false);
  });

  it("ignores notifications of a foreign thread, a foreign turn or unattributable params when classifying activity", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server, 20, { interruptGraceTimeoutMs: 40 });
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    // Foreign THREAD: never the current turn.
    server.transport.receiveMessage({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-other", turnId: "turn-1", itemId: "i", delta: "x" }
    });
    // Current thread but FOREIGN turn.
    server.transport.receiveMessage({
      method: "item/fileChange/outputDelta",
      params: { threadId: "thread-1", turnId: "turn-foreign", itemId: "i", delta: "y" }
    });
    // Current thread+turn but MISSING turnId: not attributable.
    server.transport.receiveMessage({
      method: "item/commandExecution/outputDelta",
      params: { threadId: "thread-1", itemId: "i", delta: "z" }
    });
    // No params at all.
    server.transport.receiveMessage({ method: "item/started", params: undefined });
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_TIMEOUT"
    });

    const workspace = input.workspace as MemoryAgentWorkspace;
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.note).toBe(
      `Codex turn failed: turn wait timed out: no-agent-message-items; interrupt outcome: grace-timed-out; ${NO_ACTIVITY_SUMMARY}`
    );
    // Foreign identities and unattributable content never leak into the note.
    expect(JSON.stringify(session)).not.toContain("thread-other");
    expect(JSON.stringify(session)).not.toContain("turn-foreign");
    expect(JSON.stringify(session)).not.toContain("item/fileChange");
    expect(JSON.stringify(session)).not.toContain("item/commandExecution");
  });

  it("counts an agentMessage delta emitted BEFORE the turn/start response into the timeout summary (listener race)", async () => {
    // The server emits the first delta while it still processes the turn/start
    // REQUEST: the tracker's pre-start buffer must promote it into the started
    // turn so the timeout note counts it.
    const server = new ScriptedCodexServer({ earlyDelta: "early-race-delta" });
    const adapter = adapterFor(server, 20, { interruptGraceTimeoutMs: 40 });
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle(); // turn/start answered; no completion is ever emitted
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_TIMEOUT"
    });

    const workspace = input.workspace as MemoryAgentWorkspace;
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.note).toBe(
      `Codex turn failed: turn wait timed out: agent-message-items-observed; interrupt outcome: grace-timed-out; ${AGENT_MESSAGE_ACTIVITY_SUMMARY}`
    );
    expect(JSON.stringify(session)).not.toContain("early-race-delta");
  });

  it("records an inbound approval server request (which fails the connection closed) as a non-timeout summary", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle(); // the turn is in progress; the completion wait is registered
    server.transport.receiveMessage({
      id: 9001,
      method: "item/permissions/requestApproval",
      params: { permissions: [{ path: "C:\\secret", mode: "write" }] }
    });
    // A server→client request is outside the used subset: the client fails the
    // whole connection closed (fail-closed) BEFORE the turn completes.
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE"
    });

    const workspace = input.workspace as MemoryAgentWorkspace;
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.status).toBe("failed");
    expect(session?.turnId).toBe("turn-1");
    expect(session?.note).toBe(
      "Codex turn wait failed; " +
        "turn activity: agent-message=0 command-execution=0 file-change=0 tool-or-other=0 approval-request=1; " +
        "last activity: approval-request"
    );
    // The raw method name and its params never reach the persisted note.
    expect(JSON.stringify(session)).not.toContain("requestApproval");
    expect(JSON.stringify(session)).not.toContain("item/permissions");
    expect(JSON.stringify(session)).not.toContain("C:\\secret");
    expect(workspace.files.has("output/result-manifest.json")).toBe(false);
    expect(workspace.files.has(RAW_AGENT_LOG_RELATIVE_PATH)).toBe(false);
  });

  it("keeps a non-timeout turn-wait failure generic after observing a current-turn agent-message item", async () => {
    const server = new ScriptedCodexServer();
    const client = new CodexAppServerClient({
      transport: server.transport,
      requestTimeoutMs: 1_000
    });
    const adapter = new CodexAppServerAdapter({ client, turnTimeoutMs: 5_000 });
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle(); // the turn is in progress; the completion wait is registered
    server.emitAgentMessageDelta("not persisted");
    server.transport.emitExit(1, null); // child exit WHILE awaiting completion
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_RUNTIME_UNAVAILABLE"
    });

    // The in_progress session MUST end failed with the stable generic
    // turn-wait note; no manifest claim, no raw agent log.
    const workspace = input.workspace as MemoryAgentWorkspace;
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.status).toBe("failed");
    expect(session?.turnId).toBe("turn-1");
    expect(session?.note).toBe(
      `Codex turn wait failed; ${AGENT_MESSAGE_ACTIVITY_SUMMARY}`
    );
    expect(workspace.files.has("output/result-manifest.json")).toBe(false);
    expect(workspace.files.has(RAW_AGENT_LOG_RELATIVE_PATH)).toBe(false);
  });

  it("maps child exit during the turn to AGENT_RUNTIME_UNAVAILABLE", async () => {
    const server = new ScriptedCodexServer();
    const client = new CodexAppServerClient({
      transport: server.transport,
      requestTimeoutMs: 1_000
    });
    const adapter = new CodexAppServerAdapter({ client, turnTimeoutMs: 5_000 });
    const run = adapter.runTurn(turnInput());
    server.transport.emitExit(1, null);
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_RUNTIME_UNAVAILABLE"
    });
  });

  it("cooperative interruptTurn targets the in-flight turn: turn/interrupt request before the interrupted completion", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    expect(server.requestMethods()).toContain("turn/start");

    await adapter.interruptTurn({ runId: RUN, attemptId: ATTEMPT_ID });
    // The interrupt request was sent BEFORE the interrupted completion.
    const order = server.requestMethods();
    expect(order.indexOf("turn/interrupt")).toBeGreaterThan(order.indexOf("turn/start"));
    expect(order.indexOf("turn/interrupt")).toBe(order.length - 1);

    server.emitTurnCompleted("interrupted");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_INTERRUPTED"
    });
  });

  it("interruptTurn for a foreign claim is a no-op", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    await adapter.interruptTurn({ runId: "run-other", attemptId: "att-other" });
    expect(server.requestMethods()).not.toContain("turn/interrupt");
    server.emitAgentMessageDelta(acceptedTurnOutputJson());
    server.emitTurnCompleted("completed");
    await expect(run).resolves.toMatchObject({ kind: "completed" });
  });

  it("drops reasoning/raw content from the product records (only the final message is parsed)", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    // An EARLY agentMessage item carries reasoning tokens; the FINAL item
    // carries the constrained Agent Turn Output document.
    server.emitAgentMessageDelta("SECRET-REASONING-TOKENS", "item-early");
    server.emitAgentMessageDelta(acceptedTurnOutputJson(), "item-final");
    server.emitTurnCompleted("completed");
    const outcome = await run;
    const records = outcome.records;
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("SECRET-REASONING");
    expect(serialized).not.toContain("item-early");
  });

  it("captures agentMessage deltas emitted BEFORE the turn/start response (listener race)", async () => {
    // The server emits the first JSON fragment while it still processes the
    // turn/start REQUEST (before its response): the adapter's collector was
    // registered before turn/start, so the fragment must not be lost.
    const server = new ScriptedCodexServer({
      earlyDelta: '{"contractVersion":1,"result":"completed","completed":'
    });
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();

    // The remainder of the Agent Turn Output document + the completion.
    server.emitAgentMessageDelta(
      acceptedTurnOutputJson().slice('{"contractVersion":1,"result":"completed","completed":'.length)
    );
    server.emitTurnCompleted("completed");
    const outcome = await run;
    const records = outcome.records;
    expect(records.map((record) => record.type)).toEqual([
      "metadata_updated",
      "turn_completed",
      "result_manifest"
    ]);
  });

  it("accepts surrounding prose whose braces do not belong to the Agent Turn Output JSON", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    server.emitAgentMessageDelta(
      "summary {draft}:\n" +
        acceptedTurnOutputJson() +
        '\nsummary: build complete, detail={"dimensions":"match"}'
    );
    server.emitTurnCompleted("completed");
    const outcome = await run;
    const records = outcome.records;
    expect(records.map((record) => record.type)).toEqual([
      "metadata_updated",
      "turn_completed",
      "result_manifest"
    ]);
  });

  it("handles MORE THAN 1024 agentMessage delta notifications in one turn without failing the connection", async () => {
    // The client's notification buffer retains ONLY turn/completed
    // notifications: a turn streaming >1024 delta notifications (the default
    // client bufferMax) must neither overflow-fail the connection nor lose
    // the manifest (regression: the generic buffer used to accumulate every
    // delta over connection lifetime and fail closed at 1024).
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();

    server.emitAgentMessageDelta(acceptedTurnOutputJson(), "item-final");
    for (let index = 0; index < 1099; index++) {
      server.emitAgentMessageDelta(`junk-${index}`, "item-final");
    }
    server.emitTurnCompleted("completed");

    const outcome = await run;
    const records = outcome.records;
    expect(records.map((record) => record.type)).toEqual([
      "metadata_updated",
      "turn_completed",
      "result_manifest"
    ]);
    // The manifest was still extracted from the head of the collected item.
    const manifest = validateResultManifest(
      JSON.parse(
        (input.workspace as MemoryAgentWorkspace)
          .files.get("output/result-manifest.json")
          ?.toString("utf8") ?? "{}"
      )
    );
    expect(manifest.rebuildStatus).toBe("PASSED");
  });

  it("bounds the collected item text per item: trailing content beyond the cap is dropped, extraction stays correct", async () => {
    // Head-retention: the manifest JSON is the head of the item content, so a
    // huge TAIL (which extraction never needs) is dropped without weakening
    // manifest extraction.
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server, 5_000, {
      maxCollectedItemChars: acceptedTurnOutputJson().length + 256
    });
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    server.emitAgentMessageDelta(acceptedTurnOutputJson(), "item-final");
    server.emitAgentMessageDelta("x".repeat(10_000), "item-final"); // tail beyond the cap
    server.emitTurnCompleted("completed");

    const outcome = await run;
    const records = outcome.records;
    expect(records.map((record) => record.type)).toEqual([
      "metadata_updated",
      "turn_completed",
      "result_manifest"
    ]);
    const manifest = validateResultManifest(
      JSON.parse(
        (input.workspace as MemoryAgentWorkspace)
          .files.get("output/result-manifest.json")
          ?.toString("utf8") ?? "{}"
      )
    );
    expect(manifest.rebuildStatus).toBe("PASSED");
  });

  it("fails loudly when content BEFORE the manifest exhausts the per-item cap (never silent truncation)", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server, 5_000, {
      maxCollectedItemChars: acceptedTurnOutputJson().length + 256
    });
    const run = adapter.runTurn(turnInput());
    await settle();
    server.emitAgentMessageDelta("x".repeat(10_000), "item-final"); // consumes the whole cap
    server.emitAgentMessageDelta(acceptedTurnOutputJson(), "item-final"); // dropped
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE"
    });
  });

  it("fails loudly when earlier flooding items exhaust the TOTAL collected-text cap before the manifest item", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server, 5_000, { maxCollectedTotalChars: 4_096 });
    const run = adapter.runTurn(turnInput());
    await settle();
    server.emitAgentMessageDelta("x".repeat(3_000), "item-a"); // kept 3000
    server.emitAgentMessageDelta("x".repeat(3_000), "item-b"); // kept the remaining 1096
    server.emitAgentMessageDelta(acceptedTurnOutputJson(), "item-final"); // dropped: budget spent
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE"
    });
  });

  it("fails loudly when more than the item-count cap of items arrive before the manifest item", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    for (let index = 0; index < 1_024; index++) {
      server.emitAgentMessageDelta("j", `item-${index}`);
    }
    server.emitAgentMessageDelta(acceptedTurnOutputJson(), "item-final"); // dropped: item cap reached
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE"
    });
  });

  it("rejects an ambiguous turn whose agent messages carry MULTIPLE DISTINCT documents", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    // A completed AND a clarification document are genuinely DIFFERENT
    // terminal states: they never fold and the turn fails closed.
    server.emitAgentMessageDelta(acceptedTurnOutputJson(), "item-a");
    server.emitAgentMessageDelta(clarificationTurnOutputJson(), "item-b");
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE",
      diagnostic: "multiple-valid-provider-wire-documents"
    });
  });

  it("rejects two valid terminal documents carried by the SAME agent message", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    server.emitAgentMessageDelta(
      acceptedTurnOutputJson() + "\n" + clarificationTurnOutputJson(),
      "item-final"
    );
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE",
      diagnostic: "multiple-valid-provider-wire-documents"
    });
  });

  it("folds semantically identical duplicate documents carried by the SAME agent message", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    // The same terminal document appears twice in ONE item (a redundant echo):
    // semantically identical canonical outputs fold into one — NOT ambiguity.
    server.emitAgentMessageDelta(
      acceptedTurnOutputJson() + "\n" + acceptedTurnOutputJson(),
      "item-final"
    );
    server.emitTurnCompleted("completed");

    const outcome = await run;
    expect(outcome.records.map((record) => record.type)).toEqual([
      "metadata_updated",
      "turn_completed",
      "result_manifest"
    ]);
    const manifest = validateResultManifest(
      JSON.parse(
        (input.workspace as MemoryAgentWorkspace)
          .files.get("output/result-manifest.json")
          ?.toString("utf8") ?? "{}"
      )
    );
    expect(manifest.featureCount).toBe(4);
    // The successful session is recorded exactly like a single-document turn.
    const session = validateAgentSessionRecord(
      JSON.parse(
        (input.workspace as MemoryAgentWorkspace)
          .files.get(RAW_AGENT_SESSION_RELATIVE_PATH)
          ?.toString("utf8") ?? "{}"
      )
    );
    expect(session?.status).toBe("completed");
    expect(session?.note).toBe("technical session snapshot, never a product event");
  });

  it("folds semantically identical duplicate documents carried by DIFFERENT agent messages", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    // The SAME terminal document appears in two items (the supported HIL flow
    // may echo the constrained document more than once): the duplicates fold.
    server.emitAgentMessageDelta(acceptedTurnOutputJson(), "item-early");
    server.emitAgentMessageDelta(acceptedTurnOutputJson(), "item-final");
    server.emitTurnCompleted("completed");

    const outcome = await run;
    expect(outcome.kind).toBe("completed");
    const records = outcome.records;
    // The product records NEVER leak the raw document content or the item ids.
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("featureCount");
    expect(serialized).not.toContain("item-early");
    expect(serialized).not.toContain("item-final");
    const session = validateAgentSessionRecord(
      JSON.parse(
        (input.workspace as MemoryAgentWorkspace)
          .files.get(RAW_AGENT_SESSION_RELATIVE_PATH)
          ?.toString("utf8") ?? "{}"
      )
    );
    expect(session?.status).toBe("completed");
  });

  it("folds duplicate wire documents that differ ONLY in object key order (semantically identical)", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    // The second wire document carries EVERY object's keys in REVERSE order —
    // a different wire text, but the canonical validated outputs are
    // deep-equal, so the duplicates fold into one.
    server.emitAgentMessageDelta(acceptedTurnOutputJson(), "item-a");
    server.emitAgentMessageDelta(acceptedTurnOutputJsonWithReorderedKeys(), "item-b");
    server.emitTurnCompleted("completed");

    const outcome = await run;
    expect(outcome.kind).toBe("completed");
    const manifest = validateResultManifest(
      JSON.parse(
        (input.workspace as MemoryAgentWorkspace)
          .files.get("output/result-manifest.json")
          ?.toString("utf8") ?? "{}"
      )
    );
    expect(manifest.rebuildStatus).toBe("PASSED");
  });

  it("folds duplicate documents surrounded by fenced noise and prose with braces", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    // Fenced copy + bare echo + brace-heavy prose: the balanced-object scanner
    // ignores the noise; the two IDENTICAL documents fold into one.
    server.emitAgentMessageDelta(
      "plan {draft-1}:\n```json\n" +
        acceptedTurnOutputJson() +
        "\n```\n" +
        "echo {draft-2}:\n" +
        acceptedTurnOutputJson() +
        '\nsummary: {"ok":true}',
      "item-final"
    );
    server.emitTurnCompleted("completed");

    const outcome = await run;
    expect(outcome.records.map((record) => record.type)).toEqual([
      "metadata_updated",
      "turn_completed",
      "result_manifest"
    ]);
  });

  it("keeps a document nested inside an enclosing JSON object unextractable (boundary, diagnostic unchanged)", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    // The document is NOT a top-level wire document — it is nested inside a
    // wrapper object. The scanner finds ONE balanced candidate (the wrapper),
    // which is not a valid wire document: the zero-document diagnostic stays
    // exactly as before the dedupe change.
    server.emitAgentMessageDelta(
      '{"wrapper": ' + acceptedTurnOutputJson() + "}",
      "item-final"
    );
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE",
      diagnostic: "no-valid-provider-wire-document"
    });
  });

  it("rejects two DISTINCT clarification documents with different question content", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    const other = JSON.parse(clarificationTurnOutputJson()) as {
      questions: Array<{ question: string }>;
    };
    other.questions[0]!.question = "长度是多少？";
    server.emitAgentMessageDelta(
      clarificationTurnOutputJson() + "\n" + JSON.stringify(other),
      "item-final"
    );
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE",
      diagnostic: "multiple-valid-provider-wire-documents"
    });
  });

  it("folds identical clarification duplicates with reordered keys into the clarification outcome", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    server.emitAgentMessageDelta(clarificationTurnOutputJson(), "item-a");
    server.emitAgentMessageDelta(
      JSON.stringify(reorderKeysDeep(JSON.parse(clarificationTurnOutputJson()) as unknown)),
      "item-b"
    );
    server.emitTurnCompleted("completed");

    const outcome = await run;
    expect(outcome.kind).toBe("clarification");
    if (outcome.kind !== "clarification") throw new Error("expected clarification outcome");
    expect(outcome.questions).toEqual([
      { id: "q1", type: "dimension", question: "底板厚度是多少？", hint: "例如 12", unit: "mm" },
      {
        id: "q2",
        type: "choice",
        question: "焊缝处理方式？",
        options: [
          { id: "none", label: "无需焊缝" },
          { id: "full", label: "全周满焊" }
        ]
      }
    ]);
  });

  it("interruptTurn reports a delivery failure instead of swallowing it", async () => {
    const server = new ScriptedCodexServer({ interruptBehavior: "error" });
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();

    await expect(
      adapter.interruptTurn({ runId: RUN, attemptId: ATTEMPT_ID })
    ).rejects.toMatchObject({ name: "AgentTurnError", code: "AGENT_PROTOCOL_INCOMPATIBLE" });

    // The turn is still running; it settles normally afterwards.
    server.emitAgentMessageDelta(acceptedTurnOutputJson());
    server.emitTurnCompleted("completed");
    await expect(run).resolves.toMatchObject({ kind: "completed" });
  });

  it("interruptTurn reports a timeout as a delivery failure", async () => {
    const server = new ScriptedCodexServer({ interruptBehavior: "ignore" });
    const client = new CodexAppServerClient({
      transport: server.transport,
      requestTimeoutMs: 25
    });
    const adapter = new CodexAppServerAdapter({ client, turnTimeoutMs: 5_000 });
    const run = adapter.runTurn(turnInput());
    await settle();

    await expect(
      adapter.interruptTurn({ runId: RUN, attemptId: ATTEMPT_ID })
    ).rejects.toMatchObject({ name: "AgentTurnError", code: "AGENT_TIMEOUT" });

    server.emitAgentMessageDelta(acceptedTurnOutputJson());
    server.emitTurnCompleted("completed");
    await expect(run).resolves.toMatchObject({ kind: "completed" });
  });

  it("settles a clarification_required final document with the clarification outcome: no manifest file, metadata+turn records, structured questions", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    server.emitAgentMessageDelta(clarificationTurnOutputJson());
    server.emitTurnCompleted("completed");

    const outcome = await run;
    expect(outcome.kind).toBe("clarification");
    if (outcome.kind !== "clarification") throw new Error("expected clarification outcome");
    // Runtime raw records ONLY — no result_manifest claim, and NO
    // clarification_requested record (the orchestrator owns the
    // ClarificationRequired product event, never duplicated from raw content).
    expect(outcome.records.map((record) => record.type)).toEqual([
      "metadata_updated",
      "turn_completed"
    ]);
    // The strictly validated structured question set.
    expect(outcome.questions).toEqual([
      { id: "q1", type: "dimension", question: "底板厚度是多少？", hint: "例如 12", unit: "mm" },
      {
        id: "q2",
        type: "choice",
        question: "焊缝处理方式？",
        options: [
          { id: "none", label: "无需焊缝" },
          { id: "full", label: "全周满焊" }
        ]
      }
    ]);

    // NO manifest was written for the clarification turn.
    const workspace = input.workspace as MemoryAgentWorkspace;
    expect(workspace.files.has("output/result-manifest.json")).toBe(false);
    // Technical-only files still exist: raw log + strictly validated session.
    expect(workspace.files.has(RAW_AGENT_LOG_RELATIVE_PATH)).toBe(true);
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    // Session recorded truthfully: the turn completed WITHOUT a manifest claim
    // (never failed/interrupted), with the technical note.
    expect(session?.status).toBe("completed");
    expect(session?.manifestRef).toBeUndefined();
    expect(session?.note).toBe(
      "turn completed with a clarification request; no Result Manifest was claimed"
    );
  });

  it("maps a clarification document with an EMPTY question set to AGENT_PROTOCOL_INCOMPATIBLE", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    server.emitAgentMessageDelta(
      JSON.stringify({
        contractVersion: 1,
        result: "clarification_required",
        completed: null,
        questions: []
      })
    );
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE"
    });
  });

  it("maps a document carrying BOTH terminal states (completed + questions) to AGENT_PROTOCOL_INCOMPATIBLE", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server);
    const run = adapter.runTurn(turnInput());
    await settle();
    // The contradictory provider wire payload (completed manifest AND a
    // non-null questions sentinel) fails closed in the strict projector.
    server.emitAgentMessageDelta(
      JSON.stringify({
        contractVersion: 1,
        result: "completed",
        completed: JSON.parse(acceptedManifestJson()) as unknown,
        questions: [{ id: "q1", type: "text", question: "材料？" }]
      })
    );
    server.emitTurnCompleted("completed");
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_PROTOCOL_INCOMPATIBLE"
    });
  });

  it("interrupts the EXACT timed-out turn and confirms the interrupted completion within the grace (client stays reusable)", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server, 20, { interruptGraceTimeoutMs: 500 });
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();

    // The wait timed out (20ms): the adapter must send turn/interrupt for the
    // EXACT current threadId/turnId and await the matching completion.
    await waitForCondition(() => server.requestMethods().includes("turn/interrupt"));
    expect(server.lastRequestParams("turn/interrupt")).toEqual({
      threadId: "thread-1",
      turnId: "turn-1"
    });
    expect(server.requestMethods().filter((method) => method === "turn/interrupt")).toHaveLength(1);

    server.emitTurnCompleted("interrupted");

    // The ORIGINAL AGENT_TIMEOUT propagates (never reclassified as
    // AGENT_INTERRUPTED — the interrupt was recovery after the wait timeout).
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_TIMEOUT"
    });

    const workspace = input.workspace as MemoryAgentWorkspace;
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.status).toBe("failed");
    expect(session?.turnId).toBe("turn-1");
    expect(session?.note).toBe(
      `Codex turn failed: turn wait timed out: no-agent-message-items; interrupt outcome: confirmed-interrupted; ${NO_ACTIVITY_SUMMARY}`
    );

    // The turn settled server-side (interrupted confirmed): the SHARED client
    // stays REUSABLE for the next turn of the same adapter.
    const second = adapter.runTurn(turnInput());
    await settle();
    server.emitAgentMessageDelta(acceptedTurnOutputJson());
    server.emitTurnCompleted("completed");
    await expect(second).resolves.toMatchObject({ kind: "completed" });
  });

  it.each([
    ["completed", "confirmed-completed"],
    ["failed", "confirmed-failed"]
  ] as const)(
    "treats a LATE %s completion during the grace as a confirmation and keeps the client reusable",
    async (status, expectedOutcome) => {
      const server = new ScriptedCodexServer();
      const adapter = adapterFor(server, 20, { interruptGraceTimeoutMs: 500 });
      const input = turnInput();
      const run = adapter.runTurn(input);
      await settle();
      await waitForCondition(() => server.requestMethods().includes("turn/interrupt"));
      // The turn actually settled on its own right around the interrupt: the
      // completion arrives during the grace and CONFIRMS the turn.
      server.emitTurnCompleted(status);
      await expect(run).rejects.toMatchObject({
        name: "AgentTurnError",
        code: "AGENT_TIMEOUT"
      });

      const workspace = input.workspace as MemoryAgentWorkspace;
      const session = validateAgentSessionRecord(
        JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
      );
      expect(session?.note).toBe(
        `Codex turn failed: turn wait timed out: no-agent-message-items; interrupt outcome: ${expectedOutcome}; ${NO_ACTIVITY_SUMMARY}`
      );

      // Confirmed completion: the SHARED client stays REUSABLE.
      const second = adapter.runTurn(turnInput());
      await settle();
      server.emitAgentMessageDelta(acceptedTurnOutputJson());
      server.emitTurnCompleted("completed");
      await expect(second).resolves.toMatchObject({ kind: "completed" });
    }
  );

  it("poisons the client when the timeout interrupt RPC fails: AGENT_TIMEOUT, request-failed note, never reusable", async () => {
    const server = new ScriptedCodexServer({ interruptBehavior: "error" });
    const adapter = adapterFor(server, 20, { interruptGraceTimeoutMs: 5_000 });
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();

    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_TIMEOUT"
    });
    expect(server.requestMethods()).toContain("turn/interrupt");

    const workspace = input.workspace as MemoryAgentWorkspace;
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.status).toBe("failed");
    expect(session?.note).toBe(
      `Codex turn failed: turn wait timed out: no-agent-message-items; interrupt outcome: request-failed; ${NO_ACTIVITY_SUMMARY}`
    );

    // The interrupt could NOT be delivered: the server-side turn state is
    // unknown, so the client was POISONED — the next turn fails closed
    // WITHOUT sending any new wire traffic (a late completion of the old turn
    // can never corrupt a later turn).
    const wireTraffic = server.requestMethods().length;
    await expect(adapter.runTurn(turnInput())).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_RUNTIME_UNAVAILABLE"
    });
    expect(server.requestMethods().length).toBe(wireTraffic);
  });

  it("poisons the client when the interrupt is delivered but no completion arrives within the grace", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server, 20, { interruptGraceTimeoutMs: 40 });
    const input = turnInput();
    const run = adapter.runTurn(input);
    await settle();
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_TIMEOUT"
    });
    expect(server.requestMethods()).toContain("turn/interrupt");

    const workspace = input.workspace as MemoryAgentWorkspace;
    const session = validateAgentSessionRecord(
      JSON.parse(workspace.files.get(RAW_AGENT_SESSION_RELATIVE_PATH)?.toString("utf8") ?? "{}")
    );
    expect(session?.note).toBe(
      `Codex turn failed: turn wait timed out: no-agent-message-items; interrupt outcome: grace-timed-out; ${NO_ACTIVITY_SUMMARY}`
    );

    // No confirmation within the grace: the server-side turn state is UNKNOWN
    // — the client was poisoned and must NEVER be reused for a later turn.
    const wireTraffic = server.requestMethods().length;
    await expect(adapter.runTurn(turnInput())).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_RUNTIME_UNAVAILABLE"
    });
    expect(server.requestMethods().length).toBe(wireTraffic);
  });

  it("safely drops a completion that arrives AFTER the grace expired and the client was poisoned", async () => {
    const server = new ScriptedCodexServer();
    const adapter = adapterFor(server, 20, { interruptGraceTimeoutMs: 30 });
    const run = adapter.runTurn(turnInput());
    await settle();
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_TIMEOUT"
    });

    // The turn completes only AFTER the grace expired: the client was already
    // poisoned, so the late notification is dropped — no crash, no connection
    // corruption, no unhandled rejection — and the client stays non-reusable.
    server.emitTurnCompleted("completed");
    await expect(adapter.runTurn(turnInput())).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_RUNTIME_UNAVAILABLE"
    });
  });

  it("keeps a non-timeout wait failure on the original path: no turn/interrupt, no poison, unchanged classification", async () => {
    const server = new ScriptedCodexServer();
    const client = new CodexAppServerClient({
      transport: server.transport,
      requestTimeoutMs: 1_000
    });
    const adapter = new CodexAppServerAdapter({ client, turnTimeoutMs: 5_000 });
    const run = adapter.runTurn(turnInput());
    await settle();
    server.transport.emitExit(1, null); // child exit WHILE awaiting completion
    await expect(run).rejects.toMatchObject({
      name: "AgentTurnError",
      code: "AGENT_RUNTIME_UNAVAILABLE"
    });
    // The timeout-specific recovery was NOT applied to a non-timeout failure:
    // no interrupt request was ever sent.
    expect(server.requestMethods()).not.toContain("turn/interrupt");
  });
});
