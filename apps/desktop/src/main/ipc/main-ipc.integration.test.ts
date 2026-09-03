import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDuplexPipePair,
  FAKE_PREFLIGHT_SKILL_SHA256,
  IpcServer,
  Runner,
  RunnerRequestHandler,
  type DuplexPipePair
} from "@swpanel/runner";
import type { RunProfile } from "@swpanel/runner";
import type { ExecutorScheduler, ScheduledTask } from "@swpanel/runner";

import type { BridgeResult } from "../bridge/bridge-contract.js";
import { DrawingFilePicker, validateAndHashDrawingFile } from "../files/file-selection.js";
import { SelectedFileRegistry } from "../files/selected-file-registry.js";
import { installMainIpc, type IpcMainLike, type MainIpcDependencies, type MainIpcSender, type MainSecretsStore } from "./main-ipc.js";
import { IpcClientImpl, IpcConnectionLostError, createDuplexTransport } from "../ipc-client/index.js";
import { RunnerHost, type RunnerHostServerLike } from "../runner-host/runner-host.js";

/** In-memory secrets store double for the handler chain (plaintext never bridges). */
function makeSecretsStore(): MainSecretsStore & { stored: string | null } {
  const state: { stored: string | null } = { stored: null };
  return {
    get stored(): string | null {
      return state.stored;
    },
    set stored(value: string | null) {
      state.stored = value;
    },
    setApiKey(apiKey: string): Promise<void> {
      return Promise.resolve().then(() => {
        state.stored = apiKey;
      });
    },
    getApiKeyStatus(): Promise<{ hasApiKey: boolean; maskedApiKey: string | null }> {
      return Promise.resolve().then(() => {
        if (state.stored === null) return { hasApiKey: false, maskedApiKey: null };
        return { hasApiKey: true, maskedApiKey: "sk-****abcd" };
      });
    },
    clearApiKey(): Promise<void> {
      return Promise.resolve().then(() => {
        state.stored = null;
      });
    }
  };
}

const PROFILE: RunProfile = {
  promptTemplateVersion: "prompt-template-v3",
  // The Runner gates PREPARING with the synthetic preflight fixture whose
  // allowlist is EXACTLY the fixture digest (P5-2 review fix).
  skill: { name: "solidworks-build-part-from-drawing", sha256: FAKE_PREFLIGHT_SKILL_SHA256 },
  agentConfigId: "agent-config-1"
};

/**
 * Deterministic manual scheduler shared by the rig's Runner orchestration and
 * executor: the queue advances ONLY when the test flushes it.
 */
class ManualScheduler implements ExecutorScheduler {
  private tasks: Array<{ id: number; at: number; fn: () => void; cancelled: boolean }> = [];
  private nextId = 0;
  private currentMs = Date.parse("2026-08-13T09:00:00.000Z");

  now = (): Date => new Date(this.currentMs);

  schedule(fn: () => void, delayMs: number): ScheduledTask {
    const id = ++this.nextId;
    const task = { id, at: this.currentMs + Math.max(0, delayMs), fn, cancelled: false };
    this.tasks.push(task);
    return {
      cancel: () => {
        task.cancelled = true;
      }
    };
  }

  hasPending(): boolean {
    return this.tasks.some((task) => !task.cancelled && task.at <= this.currentMs);
  }

  flushAll(): void {
    let guard = 0;
    while (this.hasPending() && guard++ < 10_000) {
      const next = this.tasks
        .filter((task) => !task.cancelled && task.at <= this.currentMs)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (next === undefined) break;
      this.tasks = this.tasks.filter((task) => task !== next);
      next.fn();
    }
  }
}

/** Runs every due task and drains the microtask chains they release. */
async function drainScheduler(scheduler: ManualScheduler): Promise<void> {
  let guard = 0;
  while (scheduler.hasPending() && guard++ < 10_000) {
    scheduler.flushAll();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * WP5 Main-to-Runner integration: a REAL Runner (SQLite + ledger) hosted by the
 * RunnerHost, a REAL IpcServer + RunnerRequestHandler, and the REAL IpcClient —
 * connected over the in-process duplex pair (the same framing/protocol/ACL path
 * as the Windows pipe minus the pipe itself, which the Runner's own live-pipe
 * suite covers). The full channel chain (Main allowlist -> payload validation ->
 * one-use token -> Runner command) is exercised through the actual handlers, and
 * persistence is verified across a host restart on the same temp data root.
 */

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\nSWPanel integration fixture.\n");
const PDF_BYTES_2 = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\nSWPanel integration fixture revision 2.\n");

interface TestRig {
  host: RunnerHost;
  registry: SelectedFileRegistry;
  registered: Map<string, (event: unknown, payload: unknown) => Promise<unknown>>;
  pair: () => DuplexPipePair;
  root: string;
  scheduler: ManualScheduler;
  cleanup: () => void;
}

function buildRig(
  root: string,
  pairs: DuplexPipePair[],
  options: { scenario?: "success" | "clarification" | "failure" } = {}
): {
  host: RunnerHost;
  pair: () => DuplexPipePair;
  scheduler: ManualScheduler;
} {
  const scheduler = new ManualScheduler();
  const host = new RunnerHost({
    dataRoot: root,
    dependencies: {
      createRunner: (dataRoot) =>
        new Runner(dataRoot, {
          runProfile: PROFILE,
          fakeExecutorScenario: options.scenario ?? "success",
          scheduler,
          now: scheduler.now
        }),
      createServer: (runner): RunnerHostServerLike => {
        const server = new IpcServer(new RunnerRequestHandler(runner), {
          pipePath: "\\\\.\\pipe\\swpanel.test.integration",
          platform: "win32",
          eventStream: {
            subscribeRunEvents: (runId, subscriber) =>
              runner.subscribeRunEventCommits((events) => {
                // Commit batches are filtered by the SUBSCRIBED runId: one
                // Run's commits never leak into another Run's stream (B2).
                const owned = events.filter((event) => event.runId === runId);
                const first = owned[0];
                if (first === undefined) return;
                subscriber.onRunEvents({ runId, fromSequence: first.sequence, events: owned });
              }),
            listRunEventsFrom: (runId, fromSequence) => runner.listRunEventsFrom(runId, fromSequence)
          }
        });
        const pair = createDuplexPipePair();
        pairs.push(pair);
        server.attach(pair.server);
        return {
          pipePath: "\\\\.\\pipe\\swpanel.test.integration",
          serverInstanceId: server.serverInstanceId,
          // In-process duplex adapter: no real Windows pipe is bound (the
          // Runner's live-pipe suite covers the real pipe + DACL), so the
          // win32 ACL gate is explicitly waived via the documented exemption.
          acl: null,
          claimsWindowsPipe: false,
          dispatch: (request) => server.dispatch(request),
          close: () => server.close()
        };
      },
      createClient: ({ expectedServerInstanceId }) =>
        new IpcClientImpl({
          transport: createDuplexTransport(() => {
            const latest = pairs[pairs.length - 1];
            if (latest === undefined) throw new Error("no duplex pair");
            return latest.client;
          }),
          expectedServerInstanceId,
          requestTimeoutMs: 5_000
        })
    }
  });
  return { host, pair: () => pairs[pairs.length - 1] as DuplexPipePair, scheduler };
}

function makeIpc(): {
  ipc: IpcMainLike;
  registered: Map<string, (event: unknown, payload: unknown) => Promise<unknown>>;
} {
  const registered = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  return {
    ipc: { handle: (channel, listener) => registered.set(channel, listener as never) },
    registered
  };
}

async function invoke(
  registered: Map<string, (event: unknown, payload: unknown) => Promise<unknown>>,
  channel: string,
  payload: unknown
): Promise<BridgeResult<unknown>> {
  const listener = registered.get(channel);
  if (listener === undefined) throw new Error(`channel ${channel} not registered`);
  return (await listener({ sender: { id: 1 } }, payload)) as BridgeResult<unknown>;
}

describe("WP5 Main-to-Runner integration (real Runner over in-process IPC)", () => {
  const rigs: TestRig[] = [];

  afterEach(() => {
    while (rigs.length > 0) {
      const rig = rigs.pop() as TestRig;
      void rig.host.close();
      rig.cleanup();
    }
  });

  function newRig(options: { scenario?: "success" | "clarification" | "failure" } = {}): TestRig {
    const root = mkdtempSync(join(tmpdir(), "swpanel-int-"));
    const sources = join(root, "sources");
    mkdirSync(sources, { recursive: true });
    const pairs: DuplexPipePair[] = [];
    const { host, scheduler } = buildRig(root, pairs, options);
    const registry = new SelectedFileRegistry();
    const { ipc, registered } = makeIpc();
    const picker = new DrawingFilePicker({
      dialog: {
        showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: ["INJECTED"] })
      },
      registry,
      registerSourceFile: (sha256, absolutePath) => host.registerSourceFile(sha256, absolutePath),
      validate: async (candidate) =>
        validateAndHashDrawingFile(candidate, { readFileContent: () => Promise.resolve(readFixture(candidate)) })
    });
    installMainIpc(ipc, {
      host,
      picker,
      registry,
      secrets: makeSecretsStore()
    } satisfies MainIpcDependencies);
    const rig: TestRig = {
      host,
      registry,
      registered,
      pair: () => pairs[pairs.length - 1] as DuplexPipePair,
      root,
      scheduler,
      cleanup: () => rmSync(root, { recursive: true, force: true })
    };
    rigs.push(rig);
    return rig;
  }

  function writeFixture(rig: TestRig, name: string, content: Buffer): string {
    const filePath = join(rig.root, "sources", name);
    writeFileSync(filePath, content);
    return filePath;
  }

  const fixtureContents = new Map<string, Buffer>();
  function readFixture(candidate: string): Buffer {
    const content = fixtureContents.get(candidate);
    if (content === undefined) throw new Error(`no fixture for ${candidate}`);
    return content;
  }

  /** Stages a fixture through the real picker + validator and returns metadata. */
  async function stageFile(rig: TestRig, path_: string, content: Buffer): Promise<{
    token: string;
    sha256: string;
    sizeBytes: number;
  }> {
    fixtureContents.set(path_, content);
    const picker = new DrawingFilePicker({
      dialog: {
        showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [path_] })
      },
      registry: rig.registry,
      registerSourceFile: (sha256, absolutePath) => rig.host.registerSourceFile(sha256, absolutePath),
      validate: async (candidate) =>
        validateAndHashDrawingFile(candidate, { readFileContent: () => Promise.resolve(readFixture(candidate)) })
    });
    const result = await picker.select(null);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("staging failed");
    const file = result.data.file;
    if (file === null) throw new Error("expected a staged file");
    return { token: file.token, sha256: file.sha256, sizeBytes: file.sizeBytes };
  }

  it("imports a drawing, adds a revision, sets current, facts/feedback, restarts and confirms persistence", async () => {
    const rig = newRig();
    await rig.host.start();
    expect(rig.host.state).toBe("ready");

    // Stage + import the first fixture through the real picker/validator chain.
    const fixtureA = writeFixture(rig, "PDJF001.01.pdf", PDF_BYTES);
    const stagedA = await stageFile(rig, fixtureA, PDF_BYTES);
    const imported = (await invoke(rig.registered, "swpanel:drawings:import", {
      drawingNumber: "PDJF001.01",
      name: "轧辊（一）",
      selectedFileToken: stagedA.token,
      createdAt: "2026-08-12T01:00:00.000Z"
    })) as BridgeResult<{ drawing: { id: string }; revision: { id: string; sequence: number } }>;
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");
    const drawingId = imported.data.drawing.id;
    expect(imported.data.revision.sequence).toBe(1);

    // The token is single-use: a replayed import must fail.
    const replay = (await invoke(rig.registered, "swpanel:drawings:import", {
      drawingNumber: "PDJF001.02",
      name: "重复令牌",
      selectedFileToken: stagedA.token,
      createdAt: "2026-08-12T01:01:00.000Z"
    })) as BridgeResult<never>;
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("TOKEN_NOT_FOUND");

    // Stage + add a second revision.
    const fixtureB = writeFixture(rig, "PDJF001.01-rev2.pdf", PDF_BYTES_2);
    const stagedB = await stageFile(rig, fixtureB, PDF_BYTES_2);
    const added = (await invoke(rig.registered, "swpanel:drawings:addRevision", {
      drawingId,
      selectedFileToken: stagedB.token,
      createdAt: "2026-08-12T02:00:00.000Z"
    })) as BridgeResult<{ revision: { id: string; sequence: number } }>;
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("addRevision failed");
    const secondRevisionId = added.data.revision.id;
    expect(added.data.revision.sequence).toBe(2);

    // Set current revision to the second one.
    const switched = (await invoke(rig.registered, "swpanel:drawings:setCurrentRevision", {
      drawingId,
      revisionId: secondRevisionId,
      updatedAt: "2026-08-12T03:00:00.000Z"
    })) as BridgeResult<{ currentRevisionId: string }>;
    expect(switched.ok).toBe(true);
    if (switched.ok) expect(switched.data.currentRevisionId).toBe(secondRevisionId);

    // Add a fact and modeling feedback on revision 2.
    const fact = (await invoke(rig.registered, "swpanel:revisions:addFact", {
      drawingId,
      revisionId: secondRevisionId,
      field: "中心孔深度",
      value: "85 mm",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-12T04:00:00.000Z",
      clientIntentId: `swint_${"a".repeat(32)}`
    })) as BridgeResult<{ field: string }>;
    expect(fact.ok).toBe(true);
    if (fact.ok) expect(fact.data.field).toBe("中心孔深度");

    const feedback = (await invoke(rig.registered, "swpanel:revisions:addModelingFeedback", {
      drawingId,
      revisionId: secondRevisionId,
      content: "圆角位置应标注在主视图",
      createdAt: "2026-08-12T05:00:00.000Z",
      clientIntentId: `swint_${"b".repeat(32)}`
    })) as BridgeResult<{ content: string }>;
    expect(feedback.ok).toBe(true);

    // Query history through the allowlisted channels.
    const history = (await invoke(rig.registered, "swpanel:drawings:history", {
      drawingId
    })) as BridgeResult<{ revisions: unknown[]; currentRevisionId: string | null }>;
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.data.revisions).toHaveLength(2);
      expect(history.data.currentRevisionId).toBe(secondRevisionId);
    }

    const revisionHistory = (await invoke(rig.registered, "swpanel:revisions:history", {
      drawingId,
      revisionId: secondRevisionId
    })) as BridgeResult<{ facts: unknown[]; modelingFeedback: unknown[] }>;
    expect(revisionHistory.ok).toBe(true);
    if (revisionHistory.ok) {
      expect(revisionHistory.data.facts).toHaveLength(1);
      expect(revisionHistory.data.modelingFeedback).toHaveLength(1);
    }

    // Restart the host on the same data root and confirm persistence.
    await rig.host.close();
    expect(rig.host.state).toBe("closed");

    const root = rig.root;
    const second = buildRig(root, []);
    const secondHost = second.host;
    await secondHost.start();
    expect(secondHost.state).toBe("ready");

    const { ipc: ipc2, registered: registered2 } = makeIpc();
    installMainIpc(ipc2, {
      host: secondHost,
      picker: new DrawingFilePicker({
        dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) },
        registry: new SelectedFileRegistry(),
        registerSourceFile: () => {}
      }),
      registry: new SelectedFileRegistry(),
      secrets: makeSecretsStore()
    });

    const persistedHistory = (await invoke(registered2, "swpanel:drawings:history", {
      drawingId
    })) as BridgeResult<{ revisions: unknown[]; currentRevisionId: string | null }>;
    expect(persistedHistory.ok).toBe(true);
    if (persistedHistory.ok) {
      expect(persistedHistory.data.revisions).toHaveLength(2);
      expect(persistedHistory.data.currentRevisionId).toBe(secondRevisionId);
    }

    const persistedFacts = (await invoke(registered2, "swpanel:revisions:history", {
      drawingId,
      revisionId: secondRevisionId
    })) as BridgeResult<{ facts: unknown[]; modelingFeedback: unknown[] }>;
    expect(persistedFacts.ok).toBe(true);
    if (persistedFacts.ok) {
      expect(persistedFacts.data.facts).toHaveLength(1);
      expect(persistedFacts.data.modelingFeedback).toHaveLength(1);
    }

    await secondHost.close();

    // WP0 contract: the drawing import/revision workflow must NEVER auto-create
    // a Modeling Run. Open the persisted store directly (the bridge deliberately
    // exposes no run channel in Phase 2) and prove the run count is still 0
    // while the imported drawing and its facts/feedback survive the restarts.
    const verifier = new Runner(root);
    verifier.open();
    try {
      expect(verifier.getRunCount()).toBe(0);
      const verifiedHistory = verifier.getDrawingHistory(drawingId);
      expect(verifiedHistory.revisions).toHaveLength(2);
      expect(verifiedHistory.currentRevisionId).toBe(secondRevisionId);
      const verifiedRevision = verifier.getRevisionHistory(drawingId, secondRevisionId);
      expect(verifiedRevision.facts).toHaveLength(1);
      expect(verifiedRevision.modelingFeedback).toHaveLength(1);
    } finally {
      verifier.close();
    }
  });

  it("M1: fact/feedback retries with fresh timestamps execute once; deliberate duplicates execute again", async () => {
    const rig = newRig();
    await rig.host.start();
    expect(rig.host.state).toBe("ready");

    const fixture = writeFixture(rig, "PDJF-M1.pdf", PDF_BYTES);
    const staged = await stageFile(rig, fixture, PDF_BYTES);
    const imported = (await invoke(rig.registered, "swpanel:drawings:import", {
      drawingNumber: "PDJF-M1",
      name: "M1 意图幂等",
      selectedFileToken: staged.token,
      createdAt: "2026-08-12T01:00:00.000Z"
    })) as BridgeResult<{ drawing: { id: string }; revision: { id: string } }>;
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");
    const drawingId = imported.data.drawing.id;
    const revisionId = imported.data.revision.id;

    const historyFor = async (): Promise<{ facts: unknown[]; modelingFeedback: unknown[] }> => {
      const history = (await invoke(rig.registered, "swpanel:revisions:history", {
        drawingId,
        revisionId
      })) as BridgeResult<{ facts: unknown[]; modelingFeedback: unknown[] }>;
      expect(history.ok).toBe(true);
      if (!history.ok) throw new Error("history failed");
      return history.data;
    };

    // Same user intent retried with a FRESH requestId (the IPC client mints a
    // new requestId per attempt) and a regenerated createdAt executes ONCE.
    const factIntentA = `swint_${"a".repeat(32)}`;
    const factPayload = {
      drawingId,
      revisionId,
      field: "中心孔深度",
      value: "85 mm",
      source: "USER_SUPPLEMENT"
    };
    const first = (await invoke(rig.registered, "swpanel:revisions:addFact", {
      ...factPayload,
      createdAt: "2026-08-12T04:00:00.000Z",
      clientIntentId: factIntentA
    })) as BridgeResult<{ id: string }>;
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("addFact failed");
    const retry = (await invoke(rig.registered, "swpanel:revisions:addFact", {
      ...factPayload,
      createdAt: "2026-08-12T09:30:00.000Z",
      clientIntentId: factIntentA
    })) as BridgeResult<{ id: string }>;
    expect(retry.ok).toBe(true);
    // The retry replayed the cached response: SAME fact id, still one fact.
    if (retry.ok) expect(retry.data.id).toBe(first.data.id);
    expect((await historyFor()).facts).toHaveLength(1);

    // A separate DELIBERATE submission of identical content (new intent id)
    // executes again.
    const deliberate = (await invoke(rig.registered, "swpanel:revisions:addFact", {
      ...factPayload,
      createdAt: "2026-08-12T10:00:00.000Z",
      clientIntentId: `swint_${"b".repeat(32)}`
    })) as BridgeResult<{ id: string }>;
    expect(deliberate.ok).toBe(true);
    if (deliberate.ok && retry.ok) expect(deliberate.data.id).not.toBe(retry.data.id);
    expect((await historyFor()).facts).toHaveLength(2);

    // Modeling feedback follows the same contract.
    const feedbackIntentA = `swint_${"c".repeat(32)}`;
    const feedbackPayload = {
      drawingId,
      revisionId,
      content: "圆角位置应标注在主视图"
    };
    const fbFirst = (await invoke(rig.registered, "swpanel:revisions:addModelingFeedback", {
      ...feedbackPayload,
      createdAt: "2026-08-12T05:00:00.000Z",
      clientIntentId: feedbackIntentA
    })) as BridgeResult<{ id: string }>;
    expect(fbFirst.ok).toBe(true);
    const fbRetry = (await invoke(rig.registered, "swpanel:revisions:addModelingFeedback", {
      ...feedbackPayload,
      createdAt: "2026-08-12T09:30:00.000Z",
      clientIntentId: feedbackIntentA
    })) as BridgeResult<{ id: string }>;
    expect(fbRetry.ok).toBe(true);
    if (fbRetry.ok && fbFirst.ok) expect(fbRetry.data.id).toBe(fbFirst.data.id);
    expect((await historyFor()).modelingFeedback).toHaveLength(1);

    const fbDeliberate = (await invoke(rig.registered, "swpanel:revisions:addModelingFeedback", {
      ...feedbackPayload,
      createdAt: "2026-08-12T10:00:00.000Z",
      clientIntentId: `swint_${"d".repeat(32)}`
    })) as BridgeResult<{ id: string }>;
    expect(fbDeliberate.ok).toBe(true);
    expect((await historyFor()).modelingFeedback).toHaveLength(2);

    // Close before afterEach cleanup so the temp data root is not file-locked.
    await rig.host.close();
  });

  it("M1: a createRevision retry after a lost response cannot duplicate the revision or its file", async () => {
    const rig = newRig();
    await rig.host.start();
    expect(rig.host.state).toBe("ready");

    const fixtureA = writeFixture(rig, "PDJF-M1R.pdf", PDF_BYTES);
    const stagedA = await stageFile(rig, fixtureA, PDF_BYTES);
    const imported = (await invoke(rig.registered, "swpanel:drawings:import", {
      drawingNumber: "PDJF-M1R",
      name: "M1 版本重试",
      selectedFileToken: stagedA.token,
      createdAt: "2026-08-12T01:00:00.000Z"
    })) as BridgeResult<{ drawing: { id: string } }>;
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");
    const drawingId = imported.data.drawing.id;

    const fixtureB = writeFixture(rig, "PDJF-M1R-rev2.pdf", PDF_BYTES_2);
    const stagedB = await stageFile(rig, fixtureB, PDF_BYTES_2);

    // Wrap the real host so the FIRST createRevision response is dropped AFTER
    // the Runner executed the mutation — exactly the lost-response retry case.
    let dropNextCreateRevision = true;
    const droppingHost: MainIpcDependencies["host"] = {
      health: rig.host.health,
      registerSourceFile: (sha256, absolutePath) => rig.host.registerSourceFile(sha256, absolutePath),
      runQuery: (name, payload) => rig.host.runQuery(name, payload),
      runCommand: async (command, options) => {
        const response = await rig.host.runCommand(command, options);
        if (dropNextCreateRevision && command.command === "drawing.createRevision") {
          dropNextCreateRevision = false;
          throw new IpcConnectionLostError("simulated lost response");
        }
        return response;
      }
    };
    const { ipc, registered } = makeIpc();
    installMainIpc(ipc, {
      host: droppingHost,
      picker: {
        select: () => Promise.resolve({ ok: true as const, data: { canceled: true, file: null } })
      },
      registry: rig.registry,
      secrets: makeSecretsStore()
    });

    const revisionCount = async (): Promise<number> => {
      const history = (await invoke(registered, "swpanel:drawings:history", {
        drawingId
      })) as BridgeResult<{ revisions: unknown[] }>;
      expect(history.ok).toBe(true);
      if (!history.ok) throw new Error("history failed");
      return history.data.revisions.length;
    };
    expect(await revisionCount()).toBe(1);

    // First attempt: the Runner creates the revision, the response is lost.
    const first = (await invoke(registered, "swpanel:drawings:addRevision", {
      drawingId,
      selectedFileToken: stagedB.token,
      createdAt: "2026-08-12T02:00:00.000Z"
    })) as BridgeResult<never>;
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("RUNNER_UNAVAILABLE");
    // The failed delivery released the token: it is still staged for the retry.
    expect(rig.registry.has(stagedB.token)).toBe(true);

    // Retry: same token, FRESH createdAt. Main derives the SAME intent key
    // (drawingId + file sha256) so the Runner replays the cached response
    // instead of executing the mutation a second time.
    const retry = (await invoke(registered, "swpanel:drawings:addRevision", {
      drawingId,
      selectedFileToken: stagedB.token,
      createdAt: "2026-08-12T09:30:00.000Z"
    })) as BridgeResult<{ revision: { id: string; sequence: number } }>;
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error("retry failed");
    expect(retry.data.revision.sequence).toBe(2);

    // Exactly ONE revision was created for the intent (import + one revision).
    expect(await revisionCount()).toBe(2);
    // The one-use token burned exactly once on the replayed success.
    expect(rig.registry.size).toBe(0);

    // Close before afterEach cleanup so the temp data root is not file-locked.
    await rig.host.close();
  });

  /** A fake push-capable sender recording every runEvents push it receives. */
  function makePushSender(): MainIpcSender & {
    pushed: Array<{ channel: string; payload: unknown }>;
    destroy(): void;
  } {
    const pushed: Array<{ channel: string; payload: unknown }> = [];
    const handlers = new Map<string, () => void>();
    let destroyed = false;
    return {
      id: 1,
      pushed,
      send: (channel, payload) => {
        pushed.push({ channel, payload });
      },
      once: (event, listener) => {
        handlers.set(event, listener);
      },
      isDestroyed: () => destroyed,
      destroy: () => {
        destroyed = true;
        handlers.get("destroyed")?.();
      }
    };
  }

  it("creates a Run through the bridge, streams its live events to a subscription, and completes it", async () => {
    const rig = newRig();
    await rig.host.start();
    const fixture = writeFixture(rig, "PDJF-RUN-E2E.pdf", PDF_BYTES);
    const staged = await stageFile(rig, fixture, PDF_BYTES);
    const imported = (await invoke(rig.registered, "swpanel:drawings:import", {
      drawingNumber: "PDJF-RUN-E2E",
      name: "端到端 Run",
      selectedFileToken: staged.token,
      createdAt: "2026-08-12T01:00:00.000Z"
    })) as BridgeResult<{ drawing: { id: string }; revision: { id: string } }>;
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");

    // run.create through the frozen bridge channel: the Runner freezes the
    // snapshot and wakes the serial queue.
    const created = (await invoke(rig.registered, "swpanel:runs:create", {
      drawingId: imported.data.drawing.id,
      revisionId: imported.data.revision.id
    })) as BridgeResult<{ id: string; status: string; inputSnapshot: { revisionFacts: unknown[] } }>;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("run create failed");
    expect(created.data.status).toBe("QUEUED");
    expect(created.data.inputSnapshot.revisionFacts).toEqual([]);
    const runId = created.data.id;

    // run list + run detail through the bridge.
    const list = (await invoke(rig.registered, "swpanel:runs:list", {})) as BridgeResult<
      Array<{ runId: string; runLabel: string }>
    >;
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.data.map((item) => item.runId)).toEqual([runId]);

    // Subscribe AFTER the last known sequence (race-free snapshot-then-subscribe
    // happens inside the Main client; here we subscribe from 0 and rely on the
    // client-side dedupe). The subscribe handler needs a push-capable sender,
    // so it is invoked directly instead of through the payload-only helper.
    const sender = makePushSender();
    const subscribeListener = rig.registered.get("swpanel:runs:subscribe") as (
      event: unknown,
      payload: unknown
    ) => Promise<unknown>;
    const subscribed = (await subscribeListener(
      { sender },
      { runId, fromSequence: 0 }
    )) as BridgeResult<unknown>;
    expect(subscribed.ok).toBe(true);

    // The backlog push arrived first (events committed before the subscribe).
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const backlog = sender.pushed[0] as { payload: { kind: string; events: unknown[] } };
    expect(backlog.payload.kind).toBe("runEvents");
    expect((backlog.payload.events).length).toBeGreaterThanOrEqual(3);

    // Draining the queue completes the Run; live pushes follow the backlog.
    await drainScheduler(rig.scheduler);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const runEvents = sender.pushed.filter(
      (push) => (push.payload as { kind: string }).kind === "runEvents"
    );
    const allEvents = runEvents.flatMap((push) =>
      (push.payload as { events: Array<{ type: string; sequence: number }> }).events
    );
    expect(allEvents.at(-1)?.type).toBe("Completed");
    // Strictly increasing sequences across ALL pushes (client-side monotonicity
    // holds end to end).
    const sequences = allEvents.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));

    const detail = (await invoke(rig.registered, "swpanel:runs:detail", { runId })) as BridgeResult<{
      run: { status: string; completedAt: string | null };
    }>;
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.data.run.status).toBe("COMPLETED");
      expect(detail.data.run.completedAt).not.toBeNull();
    }

    // Unsubscribe through the frozen channel; a later drain produces no pushes.
    const unsubscribeListener = rig.registered.get("swpanel:runs:unsubscribe") as (
      event: unknown,
      payload: unknown
    ) => Promise<unknown>;
    await unsubscribeListener({ sender }, { runId });
    const before = sender.pushed.length;
    await drainScheduler(rig.scheduler);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(sender.pushed.length).toBe(before);
    await rig.host.close();
  });

  it("isolates per-Run event streams: one Run's commits never leak into another subscription (B2)", async () => {
    const rig = newRig();
    await rig.host.start();
    const fixture = writeFixture(rig, "PDJF-ISOLATE.pdf", PDF_BYTES);
    const staged = await stageFile(rig, fixture, PDF_BYTES);
    const imported = (await invoke(rig.registered, "swpanel:drawings:import", {
      drawingNumber: "PDJF-ISOLATE",
      name: "流隔离",
      selectedFileToken: staged.token,
      createdAt: "2026-08-12T01:00:00.000Z"
    })) as BridgeResult<{ drawing: { id: string }; revision: { id: string } }>;
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");
    const drawingId = imported.data.drawing.id;
    const revisionId = imported.data.revision.id;

    // F1 (2026-08-13): TWO separate create invocations for the SAME
    // drawing/revision pair mint two DISTINCT Runs (R01/R02) — run.create is
    // keyed by a Main-minted per-invocation intent id, never the semantic
    // pair, so an explicit second user create is a new intent.
    const createA = (await invoke(rig.registered, "swpanel:runs:create", {
      drawingId,
      revisionId
    })) as BridgeResult<{ id: string; number: string }>;
    expect(createA.ok).toBe(true);
    const createB = (await invoke(rig.registered, "swpanel:runs:create", {
      drawingId,
      revisionId
    })) as BridgeResult<{ id: string; number: string }>;
    expect(createB.ok).toBe(true);
    if (!createA.ok || !createB.ok) throw new Error("create failed");
    expect(createB.data.id).not.toBe(createA.data.id);
    expect(createA.data.number).toBe("R01");
    expect(createB.data.number).toBe("R02");
    const runA = createA.data.id;
    const runB = createB.data.id;

    const subscribeListener = rig.registered.get("swpanel:runs:subscribe") as (
      event: unknown,
      payload: unknown
    ) => Promise<unknown>;
    // Subscribe to run B ONLY: it has no events yet, so its stream must stay
    // completely silent while run A executes (B2 filters A's global commit
    // batches out of B's subscription instead of mismatching the envelope).
    const senderB = makePushSender();
    await subscribeListener({ sender: senderB }, { runId: runB, fromSequence: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(senderB.pushed).toEqual([]);

    // Drain the serial queue: run A completes, then the loop claims and runs
    // run B to COMPLETED. Run B's subscription receives ONLY run B's OWN
    // events — run A's commits must never leak into it.
    await drainScheduler(rig.scheduler);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const bPushes = senderB.pushed.filter(
      (push) => (push.payload as { kind: string }).kind === "runEvents"
    );
    const bEvents = bPushes.flatMap((push) =>
      (push.payload as { events: Array<{ runId: string; type: string }> }).events
    );
    expect(bEvents.length).toBeGreaterThanOrEqual(3);
    expect(bEvents.every((event) => event.runId === runB)).toBe(true);
    expect(bEvents.at(-1)?.type).toBe("Completed");
    // The envelope runId of every push matches the subscribed run.
    expect(
      bPushes.every((push) => (push.payload as { runId: string }).runId === runB)
    ).toBe(true);

    // The connection stayed healthy (no protocol failure from a mismatched
    // envelope): a fresh query through the bridge still works.
    const list = (await invoke(rig.registered, "swpanel:runs:list", {})) as BridgeResult<
      Array<{ runId: string }>
    >;
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data.map((item) => item.runId).sort()).toEqual([runA, runB].sort());
    }

    // Subscribing to run A now delivers ONLY run A's persisted history.
    const senderA = makePushSender();
    await subscribeListener({ sender: senderA }, { runId: runA, fromSequence: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const aPushes = senderA.pushed.filter(
      (push) => (push.payload as { kind: string }).kind === "runEvents"
    );
    const aEvents = aPushes.flatMap((push) =>
      (push.payload as { events: Array<{ runId: string; type: string }> }).events
    );
    expect(aEvents.length).toBeGreaterThanOrEqual(3);
    expect(aEvents.every((event) => event.runId === runA)).toBe(true);
    expect(aEvents.at(-1)?.type).toBe("Completed");
    await rig.host.close();
  });

  it("submits clarification answers through the bridge; the old Run stays CLARIFICATION_REQUIRED", async () => {
    const rig = newRig({ scenario: "clarification" });
    await rig.host.start();
    const fixture = writeFixture(rig, "PDJF-CLAR-E2E.pdf", PDF_BYTES);
    const staged = await stageFile(rig, fixture, PDF_BYTES);
    const imported = (await invoke(rig.registered, "swpanel:drawings:import", {
      drawingNumber: "PDJF-CLAR-E2E",
      name: "澄清端到端",
      selectedFileToken: staged.token,
      createdAt: "2026-08-12T01:00:00.000Z"
    })) as BridgeResult<{ drawing: { id: string }; revision: { id: string } }>;
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");

    const created = (await invoke(rig.registered, "swpanel:runs:create", {
      drawingId: imported.data.drawing.id,
      revisionId: imported.data.revision.id
    })) as BridgeResult<{ id: string }>;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("run create failed");
    const runId = created.data.id;

    // Drain: the clarification scenario ends CLARIFICATION_REQUIRED.
    await drainScheduler(rig.scheduler);
    const detail = (await invoke(rig.registered, "swpanel:runs:detail", { runId })) as BridgeResult<{
      run: { status: string; clarificationRequestId: string | null };
    }>;
    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error("detail failed");
    expect(detail.data.run.status).toBe("CLARIFICATION_REQUIRED");
    const requestId = detail.data.run.clarificationRequestId as string;

    // clarification.get through the bridge returns the OPEN request.
    const got = (await invoke(rig.registered, "swpanel:clarifications:get", {
      clarificationRequestId: requestId
    })) as BridgeResult<{
      status: string;
      questions: Array<{ questionId: string; type: string; options: Array<{ id: string }> }>;
    }>;
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("clarification get failed");
    expect(got.data.status).toBe("OPEN");
    const dimensionQuestionId = got.data.questions[0]?.questionId as string;
    const choiceQuestion = got.data.questions[1] as {
      questionId: string;
      options: Array<{ id: string }>;
    };

    // clarification.submit through the bridge persists the answers.
    const submitted = (await invoke(rig.registered, "swpanel:clarifications:submit", {
      clarificationRequestId: requestId,
      answers: [
        {
          id: "renderer-ans-1",
          questionId: dimensionQuestionId,
          value: { kind: "dimension", value: 12, unit: "mm" },
          answeredAt: "2026-08-13T01:00:00.000Z",
          answeredBy: "alice"
        },
        {
          id: "renderer-ans-2",
          questionId: choiceQuestion.questionId,
          value: { kind: "choice", optionId: choiceQuestion.options[1]?.id },
          answeredAt: "2026-08-13T01:00:00.000Z",
          answeredBy: "alice"
        }
      ],
      answeredAt: "2026-08-13T01:00:00.000Z",
      answeredBy: "alice"
    })) as BridgeResult<{ status: string; answers: unknown[] }>;
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) throw new Error("submit failed");
    expect(submitted.data.status).toBe("ANSWERED");
    expect(submitted.data.answers).toHaveLength(2);

    // The old Run stays terminal CLARIFICATION_REQUIRED — never resumed.
    const afterSubmit = (await invoke(rig.registered, "swpanel:runs:detail", { runId })) as BridgeResult<{
      run: { status: string };
    }>;
    expect(afterSubmit.ok).toBe(true);
    if (afterSubmit.ok) expect(afterSubmit.data.run.status).toBe("CLARIFICATION_REQUIRED");

    // A re-submission with DIFFERENT answers is honestly rejected.
    const resubmit = (await invoke(rig.registered, "swpanel:clarifications:submit", {
      clarificationRequestId: requestId,
      answers: [
        {
          id: "renderer-ans-3",
          questionId: dimensionQuestionId,
          value: { kind: "dimension", value: 20, unit: "mm" },
          answeredAt: "2026-08-13T02:00:00.000Z",
          answeredBy: "alice"
        }
      ],
      answeredAt: "2026-08-13T02:00:00.000Z",
      answeredBy: "alice"
    })) as BridgeResult<never>;
    expect(resubmit.ok).toBe(false);
    if (!resubmit.ok) expect(resubmit.error.code).toBe("DOMAIN_INVARIANT");
    await rig.host.close();
  });

  it("deletes a terminal Run through the bridge and reads the recovery status (Phase 8)", async () => {
    const rig = newRig();
    await rig.host.start();
    const fixture = writeFixture(rig, "PDJF-RUN-DELETE.pdf", PDF_BYTES);
    const staged = await stageFile(rig, fixture, PDF_BYTES);
    const imported = (await invoke(rig.registered, "swpanel:drawings:import", {
      drawingNumber: "PDJF-RUN-DELETE",
      name: "删除端到端",
      selectedFileToken: staged.token,
      createdAt: "2026-08-12T01:00:00.000Z"
    })) as BridgeResult<{ drawing: { id: string }; revision: { id: string } }>;
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");
    const drawingId = imported.data.drawing.id;
    const revisionId = imported.data.revision.id;

    const created = (await invoke(rig.registered, "swpanel:runs:create", {
      drawingId,
      revisionId
    })) as BridgeResult<{ id: string; status: string }>;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("run create failed");
    const runId = created.data.id;

    // Complete the Run so the guarded terminal deletion is allowed.
    await drainScheduler(rig.scheduler);
    const detail = (await invoke(rig.registered, "swpanel:runs:detail", { runId })) as BridgeResult<{
      run: { status: string };
    }>;
    expect(detail.ok).toBe(true);
    if (detail.ok) expect(detail.data.run.status).toBe("COMPLETED");

    // The recovery status read is a non-cached read command: it resolves.
    const recovery = await invoke(rig.registered, "swpanel:system:recoveryStatus", {});
    expect(recovery.ok, `recovery failed: ${JSON.stringify(recovery)}`).toBe(true);

    // Delete through the frozen channel: names the Run + owning pair.
    const deleted = (await invoke(rig.registered, "swpanel:runs:delete", {
      runId,
      drawingId,
      revisionId
    })) as BridgeResult<{ runId: string; attemptSequences: unknown[] }>;
    expect(deleted.ok).toBe(true);
    if (deleted.ok) {
      expect(deleted.data.runId).toBe(runId);
      expect(Array.isArray(deleted.data.attemptSequences)).toBe(true);
    }

    // The Run is gone: a fresh detail read fails honestly with NOT_FOUND.
    const afterDelete = (await invoke(rig.registered, "swpanel:runs:detail", { runId })) as BridgeResult<never>;
    expect(afterDelete.ok).toBe(false);
    if (!afterDelete.ok) expect(afterDelete.error.code).toBe("NOT_FOUND");
    await rig.host.close();
  });
});
