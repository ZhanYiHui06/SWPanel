import { describe, expect, it } from "vitest";

import { IPC_PROTOCOL_VERSION } from "@swpanel/contracts";

import {
  ALL_MAIN_CHANNELS,
  MAIN_CHANNELS,
  MAIN_HANDLE_CHANNELS,
  type BridgeResult
} from "../bridge/bridge-contract.js";
import {
  installMainIpc,
  type IpcMainLike,
  type MainIpcDependencies,
  type MainIpcSender,
  type MainSecretsStore
} from "./main-ipc.js";
import { SelectedFileRegistry } from "../files/selected-file-registry.js";

/** In-memory secrets store double tracking calls (mirrors the SecretStore surface). */
function makeSecretsStore(initial: {
  hasApiKey?: boolean;
  maskedApiKey?: string | null;
} = {}): {
  secrets: MainSecretsStore;
  calls: string[];
  stored: string | null;
  failNext: "read" | "write" | "clear" | null;
} {
  const state: {
    secrets: MainSecretsStore;
    calls: string[];
    stored: string | null;
    failNext: "read" | "write" | "clear" | null;
  } = {
    calls: [],
    stored: null,
    failNext: null,
    secrets: {
      setApiKey(apiKey) {
        return Promise.resolve().then(() => {
          state.calls.push("setApiKey");
          if (state.failNext === "write") throw new Error("vault is corrupt");
          state.stored = apiKey;
        });
      },
      getApiKeyStatus() {
        return Promise.resolve().then(() => {
          state.calls.push("getApiKeyStatus");
          if (state.failNext === "read") throw new Error("vault is corrupt");
          if (state.stored === null) {
            return {
              hasApiKey: initial.hasApiKey ?? false,
              maskedApiKey: initial.maskedApiKey ?? null
            };
          }
          const key = state.stored;
          return {
            hasApiKey: true,
            maskedApiKey: key.length > 7 ? `${key.slice(0, 3)}****${key.slice(-4)}` : "****"
          };
        });
      },
      clearApiKey() {
        return Promise.resolve().then(() => {
          state.calls.push("clearApiKey");
          if (state.failNext === "clear") throw new Error("vault is corrupt");
          state.stored = null;
        });
      }
    }
  };
  return state;
}

function okEnvelope(requestId: string, data: unknown) {
  return { protocolVersion: IPC_PROTOCOL_VERSION, requestId, ok: true, data };
}

function failEnvelope(requestId: string, code: string, message: string) {
  return { protocolVersion: IPC_PROTOCOL_VERSION, requestId, ok: false, error: { code, message } };
}

function makeFakeIpc(): {
  ipc: IpcMainLike;
  registered: Map<string, (event: unknown, payload: unknown) => Promise<unknown>>;
} {
  const registered = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const ipc: IpcMainLike = {
    handle: (channel, listener) => {
      registered.set(channel, listener as (event: unknown, payload: unknown) => Promise<unknown>);
    }
  };
  return { ipc, registered };
}

/** A fake sender with a push channel, destroy hook and destroyed flag. */
function makeSender(id = 1): MainIpcSender & { pushed: unknown[]; destroy(): void } {
  const pushed: unknown[] = [];
  const handlers = new Map<string, () => void>();
  let destroyed = false;
  return {
    id,
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

function makeDeps(overrides: {
  runQuery?: (name: string, payload: unknown) => Promise<unknown>;
  runCommand?: (command: unknown) => Promise<unknown>;
  pickerSelect?: () => Promise<BridgeResult<unknown>>;
  tokenSha256?: string;
  subscribeRunEvents?: MainIpcDependencies["host"]["subscribeRunEvents"];
} = {}): {
  deps: MainIpcDependencies;
  host: MainIpcDependencies["host"];
  registry: SelectedFileRegistry;
  runQuery: (name: string, payload: unknown) => Promise<unknown>;
  runCommand: (command: unknown) => Promise<unknown>;
  token: string;
  secretsState: ReturnType<typeof makeSecretsStore>;
} {
  const registry = new SelectedFileRegistry({ now: () => 1_000, ttlMs: 60_000 });
  const staged = registry.stage({
    absolutePath: "C:\\users\\alice\\docs\\PDJF001.pdf",
    fileName: "PDJF001.pdf",
    format: "PDF",
    sizeBytes: 1234,
    sha256: overrides.tokenSha256 ?? "e".repeat(64)
  });
  const token = staged.token;
  const runQuery = overrides.runQuery ?? ((name, payload) => Promise.resolve(okEnvelope("q", { name, payload })));
  const runCommand = overrides.runCommand ?? (() => Promise.resolve(okEnvelope("c", {})));
  const host: MainIpcDependencies["host"] = {
    health: { status: "READY", serverInstanceId: "srv-1", error: null },
    registerSourceFile: () => {},
    runQuery: runQuery as MainIpcDependencies["host"]["runQuery"],
    runCommand: runCommand as MainIpcDependencies["host"]["runCommand"],
    subscribeRunEvents: overrides.subscribeRunEvents ?? (() => () => {})
  };
  const secretsState = makeSecretsStore();
  const deps: MainIpcDependencies = {
    host,
    picker: {
      select: overrides.pickerSelect ?? (() =>
        Promise.resolve({ ok: true as const, data: { canceled: true, file: null } }))
    },
    registry,
    secrets: secretsState.secrets
  };
  return { deps, host, registry, runQuery, runCommand, token, secretsState };
}

async function invoke(
  ipc: IpcMainLike,
  registered: Map<string, (event: unknown, payload: unknown) => Promise<unknown>>,
  channel: string,
  payload: unknown,
  sender: MainIpcSender = makeSender()
): Promise<unknown> {
  const listener = registered.get(channel);
  if (listener === undefined) throw new Error(`channel ${channel} not registered`);
  return listener({ sender }, payload);
}

describe("installMainIpc allowlist", () => {
  it("registers EXACTLY the allowlisted handle channels and nothing else", () => {
    const { ipc, registered } = makeFakeIpc();
    installMainIpc(ipc, makeDeps().deps);
    expect([...registered.keys()].sort()).toEqual([...MAIN_HANDLE_CHANNELS].sort());
    expect(registered.size).toBe(MAIN_HANDLE_CHANNELS.length);
    // The runEvents PUSH channel is never registered as a handle channel.
    expect(registered.has(MAIN_CHANNELS.runEvents)).toBe(false);
    // ... but it is part of the frozen allowlist.
    expect(ALL_MAIN_CHANNELS).toContain(MAIN_CHANNELS.runEvents);
  });

  it("registers no generic invoke/readFile/spawn channels", () => {
    const { ipc, registered } = makeFakeIpc();
    installMainIpc(ipc, makeDeps().deps);
    const joined = [...registered.keys()].join(" ");
    expect(joined).not.toMatch(/invoke|readFile|spawn|shell|pipe|file-path/);
  });

  it("has no channel parameter accepted from the renderer", () => {
    // Every handler is bound to a fixed channel; the payload is the only input.
    const { ipc, registered } = makeFakeIpc();
    installMainIpc(ipc, makeDeps().deps);
    for (const channel of MAIN_HANDLE_CHANNELS) {
      const listener = registered.get(channel);
      expect(listener).toBeTypeOf("function");
      // A renderer passing an extra "channel" field in the payload is rejected by
      // the strict validators (unknown-field rejection), never honored.
      const result = (listener as (event: unknown, payload: unknown) => Promise<unknown>)(
        { sender: makeSender() },
        { channel: "swpanel:health", extra: true }
      );
      expect(result).toBeInstanceOf(Promise);
    }
  });
});

describe("main ipc handlers", () => {
  it("health returns the host health state", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps } = makeDeps();
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.health, {})) as BridgeResult<{
      status: string;
    }>;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe("READY");
  });

  it("drawing list maps to the workspace dashboard recent drawings", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps, runQuery } = makeDeps({
      runQuery: (name) => {
        expect(name).toBe("workspace.getDashboard");
        return Promise.resolve(okEnvelope("q", { recentDrawings: [{ drawingId: "d1" }] }));
      }
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.drawingList, {})) as BridgeResult<unknown>;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([{ drawingId: "d1" }]);
    void runQuery;
  });

  it("rejects an invalid drawing id on drawing detail with INVALID_PAYLOAD", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps } = makeDeps();
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.drawingDetail, {
      drawingId: "../escape"
    })) as BridgeResult<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects unknown fields on revision detail", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps } = makeDeps();
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.revisionDetail, {
      drawingId: "d1",
      revisionId: "r1",
      malware: true
    })) as BridgeResult<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_PAYLOAD");
  });

  it("importDrawing consumes the staged token exactly once", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps, registry, token, runCommand } = makeDeps();
    installMainIpc(ipc, deps);
    const payload = {
      drawingNumber: "PDJF001.01",
      name: "轧辊",
      selectedFileToken: token,
      createdAt: "2026-08-12T00:00:00.000Z"
    };
    const first = (await invoke(ipc, registered, MAIN_CHANNELS.importDrawing, payload)) as BridgeResult<unknown>;
    expect(first.ok).toBe(true);
    // The token was consumed: a replay must fail with TOKEN_NOT_FOUND and never
    // reach the Runner.
    const replay = (await invoke(ipc, registered, MAIN_CHANNELS.importDrawing, payload)) as BridgeResult<never>;
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("TOKEN_NOT_FOUND");
    expect(registry.size).toBe(0);
    void runCommand;
  });

  it("importDrawing forwards the resolved registered file to the Runner command", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: unknown[] = [];
    const { deps, token } = makeDeps({
      runCommand: (command) => {
        commands.push(command);
        return Promise.resolve(okEnvelope("c", { drawing: { id: "d1" }, revision: { id: "r1" } }));
      },
      tokenSha256: "f".repeat(64)
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.importDrawing, {
      drawingNumber: "PDJF001.01",
      name: "轧辊",
      selectedFileToken: token,
      createdAt: "2026-08-12T00:00:00.000Z"
    })) as BridgeResult<unknown>;
    expect(result.ok).toBe(true);
    expect(commands).toHaveLength(1);
    const command = commands[0] as { command: string; sourceFile: { sha256: string; fileName: string } };
    expect(command.command).toBe("drawing.create");
    // The absolute path must never appear in the command payload.
    expect(JSON.stringify(command)).not.toContain("C:\\users\\alice");
    expect(command.sourceFile.sha256).toBe("f".repeat(64));
  });

  it("addRevision consumes the token and forwards drawing.createRevision", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: unknown[] = [];
    const { deps, registry, token } = makeDeps({
      runCommand: (command) => {
        commands.push(command);
        return Promise.resolve(okEnvelope("c", {}));
      }
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.addRevision, {
      drawingId: "d1",
      selectedFileToken: token,
      createdAt: "2026-08-12T00:00:00.000Z"
    })) as BridgeResult<unknown>;
    expect(result.ok).toBe(true);
    const command = commands[0] as { command: string; drawingId: string };
    expect(command.command).toBe("drawing.createRevision");
    expect(command.drawingId).toBe("d1");
    expect(registry.size).toBe(0);
  });

  it("addRevision with an invalid token returns TOKEN_NOT_FOUND without touching the Runner", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps, runCommand } = makeDeps();
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.addRevision, {
      drawingId: "d1",
      selectedFileToken: "swsel_00000000000000000000000000000000",
      createdAt: "2026-08-12T00:00:00.000Z"
    })) as BridgeResult<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOKEN_NOT_FOUND");
    void runCommand;
  });

  it("addRevision retry reuses the same intent key despite a regenerated createdAt (M1)", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: Array<{ command: unknown; options?: { idempotencyKey?: string } }> = [];
    let fail = true;
    const { deps, registry, token } = makeDeps({
      runCommand: (command: unknown, options?: { idempotencyKey?: string }) => {
        commands.push({ command, options });
        return fail
          ? Promise.resolve(failEnvelope("c", "RUNNER_UNAVAILABLE", "runner down"))
          : Promise.resolve(okEnvelope("c", { revision: { id: "r2" } }));
      }
    });
    installMainIpc(ipc, deps);
    const payload = { drawingId: "d1", selectedFileToken: token };
    const first = (await invoke(ipc, registered, MAIN_CHANNELS.addRevision, {
      ...payload,
      createdAt: "2026-08-12T00:00:00.000Z"
    })) as BridgeResult<never>;
    expect(first.ok).toBe(false);
    // The failed command released the token so the retry can reuse it.
    expect(registry.has(token)).toBe(true);

    fail = false;
    // The renderer bridge repository regenerates createdAt on every attempt;
    // the key must NOT depend on it.
    const retry = (await invoke(ipc, registered, MAIN_CHANNELS.addRevision, {
      ...payload,
      createdAt: "2026-08-12T09:30:00.000Z"
    })) as BridgeResult<unknown>;
    expect(retry.ok).toBe(true);
    expect(commands).toHaveLength(2);
    expect(commands[1]?.options?.idempotencyKey).toBe(commands[0]?.options?.idempotencyKey);
    // Success burned the token exactly once.
    expect(registry.size).toBe(0);
  });

  it("importDrawing retry reuses the same intent key despite a regenerated createdAt (M1)", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: Array<{ command: unknown; options?: { idempotencyKey?: string } }> = [];
    let fail = true;
    const { deps, registry, token } = makeDeps({
      runCommand: (command: unknown, options?: { idempotencyKey?: string }) => {
        commands.push({ command, options });
        return fail
          ? Promise.resolve(failEnvelope("c", "RUNNER_UNAVAILABLE", "runner down"))
          : Promise.resolve(okEnvelope("c", { drawing: { id: "d1" }, revision: { id: "r1" } }));
      }
    });
    installMainIpc(ipc, deps);
    const payload = {
      drawingNumber: "PDJF001.01",
      name: "轧辊",
      selectedFileToken: token
    };
    const first = (await invoke(ipc, registered, MAIN_CHANNELS.importDrawing, {
      ...payload,
      createdAt: "2026-08-12T00:00:00.000Z"
    })) as BridgeResult<never>;
    expect(first.ok).toBe(false);
    expect(registry.has(token)).toBe(true);

    fail = false;
    const retry = (await invoke(ipc, registered, MAIN_CHANNELS.importDrawing, {
      ...payload,
      createdAt: "2026-08-12T09:30:00.000Z"
    })) as BridgeResult<unknown>;
    expect(retry.ok).toBe(true);
    expect(commands).toHaveLength(2);
    expect(commands[1]?.options?.idempotencyKey).toBe(commands[0]?.options?.idempotencyKey);
    expect(registry.size).toBe(0);
  });

  it("setCurrentRevision keys on the drawing+revision ids, not the regenerated updatedAt", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: Array<{ command: unknown; options?: { idempotencyKey?: string } }> = [];
    const { deps } = makeDeps({
      runCommand: (command: unknown, options?: { idempotencyKey?: string }) => {
        commands.push({ command, options });
        return Promise.resolve(okEnvelope("c", { drawing: { id: "d1" } }));
      }
    });
    installMainIpc(ipc, deps);
    const payload = { drawingId: "d1", revisionId: "r1" };
    await invoke(ipc, registered, MAIN_CHANNELS.setCurrentRevision, {
      ...payload,
      updatedAt: "2026-08-12T00:00:00.000Z"
    });
    await invoke(ipc, registered, MAIN_CHANNELS.setCurrentRevision, {
      ...payload,
      updatedAt: "2026-08-12T09:30:00.000Z"
    });
    await invoke(ipc, registered, MAIN_CHANNELS.setCurrentRevision, {
      ...payload,
      revisionId: "r2",
      updatedAt: "2026-08-12T09:30:00.000Z"
    });
    expect(commands).toHaveLength(3);
    expect(commands[1]?.options?.idempotencyKey).toBe(commands[0]?.options?.idempotencyKey);
    expect(commands[2]?.options?.idempotencyKey).not.toBe(commands[0]?.options?.idempotencyKey);
  });

  it("addRevisionFact converts a clientIntentId into a stable intent key and never forwards it on the wire (M1)", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: Array<{ command: unknown; options?: { idempotencyKey?: string } }> = [];
    const { deps } = makeDeps({
      runCommand: (command: unknown, options?: { idempotencyKey?: string }) => {
        commands.push({ command, options });
        return Promise.resolve(okEnvelope("c", { id: "f1" }));
      }
    });
    installMainIpc(ipc, deps);
    const base = {
      drawingId: "d1",
      revisionId: "r1",
      field: "中心孔深度",
      value: "85 mm",
      source: "USER_SUPPLEMENT",
      clientIntentId: `swint_${"a".repeat(32)}`
    };
    const first = (await invoke(ipc, registered, MAIN_CHANNELS.addRevisionFact, {
      ...base,
      createdAt: "2026-08-12T04:00:00.000Z"
    })) as BridgeResult<unknown>;
    expect(first.ok).toBe(true);
    // Retry: same intent id, regenerated timestamp -> SAME key.
    const retry = (await invoke(ipc, registered, MAIN_CHANNELS.addRevisionFact, {
      ...base,
      createdAt: "2026-08-12T09:30:00.000Z"
    })) as BridgeResult<unknown>;
    expect(retry.ok).toBe(true);
    // Deliberate identical submission: new intent id -> DIFFERENT key.
    const duplicate = (await invoke(ipc, registered, MAIN_CHANNELS.addRevisionFact, {
      ...base,
      clientIntentId: `swint_${"b".repeat(32)}`,
      createdAt: "2026-08-12T09:30:00.000Z"
    })) as BridgeResult<unknown>;
    expect(duplicate.ok).toBe(true);

    expect(commands).toHaveLength(3);
    const firstKey = commands[0]?.options?.idempotencyKey;
    expect(firstKey).toBeTypeOf("string");
    expect(commands[1]?.options?.idempotencyKey).toBe(firstKey);
    expect(commands[2]?.options?.idempotencyKey).not.toBe(firstKey);
    // The opaque id is consumed by Main as the idempotency key and never
    // appears in the wire command payload.
    expect(JSON.stringify(commands[0]?.command)).not.toContain("swint_");
    expect(JSON.stringify(commands[2]?.command)).not.toContain("swint_");
  });

  it("addModelingFeedback converts a clientIntentId into a stable intent key (M1)", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: Array<{ command: unknown; options?: { idempotencyKey?: string } }> = [];
    const { deps } = makeDeps({
      runCommand: (command: unknown, options?: { idempotencyKey?: string }) => {
        commands.push({ command, options });
        return Promise.resolve(okEnvelope("c", { id: "fb1" }));
      }
    });
    installMainIpc(ipc, deps);
    const base = {
      drawingId: "d1",
      revisionId: "r1",
      content: "圆角位置应标注在主视图",
      clientIntentId: `swint_${"c".repeat(32)}`
    };
    await invoke(ipc, registered, MAIN_CHANNELS.addModelingFeedback, {
      ...base,
      createdAt: "2026-08-12T05:00:00.000Z"
    });
    await invoke(ipc, registered, MAIN_CHANNELS.addModelingFeedback, {
      ...base,
      createdAt: "2026-08-12T09:30:00.000Z"
    });
    await invoke(ipc, registered, MAIN_CHANNELS.addModelingFeedback, {
      ...base,
      clientIntentId: `swint_${"d".repeat(32)}`,
      createdAt: "2026-08-12T09:30:00.000Z"
    });
    expect(commands).toHaveLength(3);
    expect(commands[1]?.options?.idempotencyKey).toBe(commands[0]?.options?.idempotencyKey);
    expect(commands[2]?.options?.idempotencyKey).not.toBe(commands[0]?.options?.idempotencyKey);
    expect(JSON.stringify(commands[0]?.command)).not.toContain("swint_");
  });

  it("rejects missing or malformed clientIntentId on fact/feedback with INVALID_PAYLOAD", async () => {
    const { ipc, registered } = makeFakeIpc();
    let runCount = 0;
    const { deps } = makeDeps({
      runCommand: () => {
        runCount += 1;
        return Promise.resolve(okEnvelope("c", {}));
      }
    });
    installMainIpc(ipc, deps);
    const factBase = {
      drawingId: "d1",
      revisionId: "r1",
      field: "f",
      value: "v",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-12T00:00:00.000Z"
    };
    const missing = (await invoke(ipc, registered, MAIN_CHANNELS.addRevisionFact, factBase)) as BridgeResult<never>;
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("INVALID_PAYLOAD");
    const malformed = (await invoke(ipc, registered, MAIN_CHANNELS.addRevisionFact, {
      ...factBase,
      clientIntentId: "swint_UPPERCASE_AND_LONG_STRING"
    })) as BridgeResult<never>;
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("INVALID_PAYLOAD");
    const feedbackMissing = (await invoke(ipc, registered, MAIN_CHANNELS.addModelingFeedback, {
      drawingId: "d1",
      revisionId: "r1",
      content: "c",
      createdAt: "2026-08-12T00:00:00.000Z"
    })) as BridgeResult<never>;
    expect(feedbackMissing.ok).toBe(false);
    if (!feedbackMissing.ok) expect(feedbackMissing.error.code).toBe("INVALID_PAYLOAD");
    // No invalid payload ever reached the Runner.
    expect(runCount).toBe(0);
  });

  it("maps a Runner failure envelope to a path-redacted bridge error", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps } = makeDeps({
      runQuery: () =>
        Promise.resolve(
          failEnvelope("q", "LEDGER_FILE_MISSING", "Source file does not exist: C:\\Users\\alice\\docs\\x.pdf")
        )
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.drawingHistory, {
      drawingId: "d1"
    })) as BridgeResult<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("LEDGER_FILE_MISSING");
      expect(result.error.message).not.toContain("C:\\Users\\alice");
      expect(result.error.message).toContain("[path redacted]");
    }
  });

  it("maps an IPC client failure to RUNNER_UNAVAILABLE", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps } = makeDeps({
      runQuery: async () => {
        throw new (await import("../ipc-client/index.js")).IpcConnectionLostError("connection lost");
      }
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.drawingHistory, {
      drawingId: "d1"
    })) as BridgeResult<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RUNNER_UNAVAILABLE");
  });

  it("maps a not-ready host to RUNNER_NOT_READY", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps } = makeDeps({
      runQuery: async () => {
        throw new (await import("../runner-host/runner-host.js")).RunnerHostNotReadyError();
      }
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.drawingList, {})) as BridgeResult<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RUNNER_NOT_READY");
  });

  it("storage.updateSettings forwards the validated settings", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: unknown[] = [];
    const { deps } = makeDeps({
      runCommand: (command) => {
        commands.push(command);
        return Promise.resolve(okEnvelope("c", { settings: { settings: {} } }));
      }
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.updateStorageSettings, {
      settings: {
        dataRoot: "C:\\data\\swpanel",
        workspaceRoot: "C:\\data\\swpanel\\workspaces",
        constraint: "LOCAL_FIXED_NTFS",
        updatedAt: "2026-08-12T00:00:00.000Z"
      }
    })) as BridgeResult<unknown>;
    expect(result.ok).toBe(true);
    const command = commands[0] as { command: string; settings: { constraint: string } };
    expect(command.command).toBe("storage.updateSettings");
    expect(command.settings.constraint).toBe("LOCAL_FIXED_NTFS");
  });

  it("deleteRevision forwards drawing.deleteRevision with a stable per-intent idempotency key", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: Array<{ command: unknown; options?: { idempotencyKey?: string } }> = [];
    const { deps } = makeDeps({
      runCommand: (command: unknown, options?: { idempotencyKey?: string }) => {
        commands.push({ command, options });
        return Promise.resolve(okEnvelope("c", { drawing: { id: "d1" }, deletedRevisionId: "r2" }));
      }
    });
    installMainIpc(ipc, deps);
    const payload = {
      drawingId: "d1",
      revisionId: "r2",
      updatedAt: "2026-08-12T00:00:00.000Z"
    };
    const first = (await invoke(ipc, registered, MAIN_CHANNELS.deleteRevision, payload)) as BridgeResult<unknown>;
    expect(first.ok).toBe(true);
    // A retry carries a FRESH updatedAt (transport-generated); the semantic
    // intent (same drawing + revision) must still map to the SAME key.
    const retry = (await invoke(ipc, registered, MAIN_CHANNELS.deleteRevision, {
      ...payload,
      updatedAt: "2026-08-12T09:30:00.000Z"
    })) as BridgeResult<unknown>;
    expect(retry.ok).toBe(true);
    // A DIFFERENT intent (another revision) maps to a DIFFERENT key.
    const other = (await invoke(ipc, registered, MAIN_CHANNELS.deleteRevision, {
      ...payload,
      revisionId: "r3",
      updatedAt: "2026-08-12T09:30:00.000Z"
    })) as BridgeResult<unknown>;
    expect(other.ok).toBe(true);

    expect(commands).toHaveLength(3);
    const command = commands[0] as { command: { command: string } };
    expect(command.command.command).toBe("drawing.deleteRevision");
    const firstKey = commands[0]?.options?.idempotencyKey;
    const retryKey = commands[1]?.options?.idempotencyKey;
    const otherKey = commands[2]?.options?.idempotencyKey;
    expect(firstKey).toBeTypeOf("string");
    // Same intent payload (regardless of the regenerated updatedAt) -> SAME
    // stable key, so a retry (fresh requestId) is deduplicated by the Runner
    // instead of double-applying the mutation.
    expect(retryKey).toBe(firstKey);
    expect(otherKey).not.toBe(firstKey);
  });

  it("rejects unknown fields on deleteRevision with INVALID_PAYLOAD", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps } = makeDeps();
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.deleteRevision, {
      drawingId: "d1",
      revisionId: "r2",
      updatedAt: "2026-08-12T00:00:00.000Z",
      force: true
    })) as BridgeResult<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_PAYLOAD");
  });

  describe("selected-file token reserve/commit/release", () => {
    it("releases the token when the command FAILS so a retry succeeds", async () => {
      const { ipc, registered } = makeFakeIpc();
      let fail = true;
      const { deps, registry, token } = makeDeps({
        runCommand: () =>
          fail
            ? Promise.resolve(failEnvelope("c", "RUNNER_UNAVAILABLE", "runner down"))
            : Promise.resolve(okEnvelope("c", { drawing: { id: "d1" }, revision: { id: "r1" } }))
      });
      installMainIpc(ipc, deps);
      const payload = {
        drawingNumber: "PDJF001.01",
        name: "轧辊",
        selectedFileToken: token,
        createdAt: "2026-08-12T00:00:00.000Z"
      };
      const first = (await invoke(ipc, registered, MAIN_CHANNELS.importDrawing, payload)) as BridgeResult<never>;
      expect(first.ok).toBe(false);
      // The failed command did NOT burn the token: it is still staged.
      expect(registry.has(token)).toBe(true);

      fail = false;
      const retry = (await invoke(ipc, registered, MAIN_CHANNELS.importDrawing, payload)) as BridgeResult<unknown>;
      expect(retry.ok).toBe(true);
      // Success burned the token exactly once.
      expect(registry.size).toBe(0);
    });

    it("releases the token when the Runner client THROWS so a retry succeeds", async () => {
      const { ipc, registered } = makeFakeIpc();
      let throwOnce = true;
      const { deps, registry, token } = makeDeps({
        runCommand: () => {
          if (throwOnce) {
            throwOnce = false;
            return Promise.reject(new Error("ipc transport died"));
          }
          return Promise.resolve(okEnvelope("c", { drawing: { id: "d1" }, revision: { id: "r1" } }));
        }
      });
      installMainIpc(ipc, deps);
      const payload = {
        drawingNumber: "PDJF001.01",
        name: "轧辊",
        selectedFileToken: token,
        createdAt: "2026-08-12T00:00:00.000Z"
      };
      const first = (await invoke(ipc, registered, MAIN_CHANNELS.importDrawing, payload)) as BridgeResult<never>;
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.error.code).toBe("INTERNAL");
      expect(registry.has(token)).toBe(true);

      const retry = (await invoke(ipc, registered, MAIN_CHANNELS.importDrawing, payload)) as BridgeResult<unknown>;
      expect(retry.ok).toBe(true);
      expect(registry.size).toBe(0);
    });

    it("denies CONCURRENT use of the same token with TOKEN_IN_USE", async () => {
      const { ipc, registered } = makeFakeIpc();
      let releaseFirst: (value: unknown) => void = () => {};
      const gate = new Promise<unknown>((resolve) => {
        releaseFirst = resolve;
      });
      const { deps, registry, token } = makeDeps({
        runCommand: () => gate.then(() => okEnvelope("c", { drawing: { id: "d1" }, revision: { id: "r1" } }))
      });
      installMainIpc(ipc, deps);
      const payload = {
        drawingNumber: "PDJF001.01",
        name: "轧辊",
        selectedFileToken: token,
        createdAt: "2026-08-12T00:00:00.000Z"
      };
      const first = invoke(ipc, registered, MAIN_CHANNELS.importDrawing, payload) as Promise<BridgeResult<unknown>>;
      // The first request reserved the token; the second concurrent request
      // must be refused WITHOUT reaching the Runner.
      const second = (await invoke(ipc, registered, MAIN_CHANNELS.importDrawing, payload)) as BridgeResult<never>;
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe("TOKEN_IN_USE");
      expect(registry.has(token)).toBe(true);

      releaseFirst({});
      const firstResult = await first;
      expect(firstResult.ok).toBe(true);
      // The successful use burned the token exactly once.
      expect(registry.size).toBe(0);
    });

    it("successful use burns the token one-time (replay is TOKEN_NOT_FOUND)", async () => {
      const { ipc, registered } = makeFakeIpc();
      const { deps, registry, token } = makeDeps({
        runCommand: () => Promise.resolve(okEnvelope("c", { drawing: { id: "d1" }, revision: { id: "r1" } }))
      });
      installMainIpc(ipc, deps);
      const payload = {
        drawingNumber: "PDJF001.01",
        name: "轧辊",
        selectedFileToken: token,
        createdAt: "2026-08-12T00:00:00.000Z"
      };
      const first = (await invoke(ipc, registered, MAIN_CHANNELS.importDrawing, payload)) as BridgeResult<unknown>;
      expect(first.ok).toBe(true);
      expect(registry.size).toBe(0);

      const replay = (await invoke(ipc, registered, MAIN_CHANNELS.importDrawing, payload)) as BridgeResult<never>;
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.error.code).toBe("TOKEN_NOT_FOUND");
    });
  });

  it("rejects storage.updateSettings with a non-fixed constraint", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps } = makeDeps();
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.updateStorageSettings, {
      settings: {
        dataRoot: "C:\\data",
        workspaceRoot: "C:\\data\\w",
        constraint: "REMOTE_SMB",
        updatedAt: "2026-08-12T00:00:00.000Z"
      }
    })) as BridgeResult<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_PAYLOAD");
  });

  it("run list maps to the run.list query", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps, runQuery } = makeDeps({
      runQuery: (name) => {
        expect(name).toBe("run.list");
        return Promise.resolve(okEnvelope("q", [{ runId: "run-1", status: "QUEUED" }]));
      }
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.runList, {})) as BridgeResult<unknown>;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([{ runId: "run-1", status: "QUEUED" }]);
    void runQuery;
  });

  it("run detail maps to run.getDetail and rejects a smuggled payload", async () => {
    const { ipc, registered } = makeFakeIpc();
    const queries: Array<{ name: string; payload: unknown }> = [];
    const { deps } = makeDeps({
      runQuery: (name, payload) => {
        queries.push({ name, payload });
        return Promise.resolve(okEnvelope("q", { run: { runId: "run-1" }, events: [], lastEventSequence: 0 }));
      }
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.runDetail, {
      runId: "run-1"
    })) as BridgeResult<unknown>;
    expect(result.ok).toBe(true);
    expect(queries).toEqual([{ name: "run.getDetail", payload: { runId: "run-1" } }]);

    const smuggled = (await invoke(ipc, registered, MAIN_CHANNELS.runDetail, {
      runId: "run-1",
      scenario: "faked"
    })) as BridgeResult<never>;
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) expect(smuggled.error.code).toBe("INVALID_PAYLOAD");
  });

  it("run create maps to run.create with a per-invocation Main-minted idempotency key (no snapshot smuggling)", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: Array<{ command: unknown; options?: { idempotencyKey?: string } }> = [];
    const { deps } = makeDeps({
      runCommand: (command: unknown, options?: { idempotencyKey?: string }) => {
        commands.push({ command, options });
        return Promise.resolve(okEnvelope("c", { id: "run-1", status: "QUEUED" }));
      }
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.runCreate, {
      drawingId: "d1",
      revisionId: "r1"
    })) as BridgeResult<unknown>;
    expect(result.ok).toBe(true);
    const command = commands[0]?.command as { command: string; drawingId: string; revisionId: string };
    expect(command.command).toBe("run.create");
    expect(command.drawingId).toBe("d1");
    expect(command.revisionId).toBe("r1");
    // F1: the key is a Main-minted per-invocation UUID — never a
    // deterministic encoding of the semantic pair or a snapshot field.
    const firstKey = commands[0]?.options?.idempotencyKey;
    expect(firstKey).toMatch(
      /^run-create:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(firstKey).not.toBe("run-create:d1:r1");

    // A SECOND separate invocation for the SAME identity pair mints a NEW
    // key: two explicit user creates are two distinct intents (R01/R02).
    const second = (await invoke(ipc, registered, MAIN_CHANNELS.runCreate, {
      drawingId: "d1",
      revisionId: "r1"
    })) as BridgeResult<unknown>;
    expect(second.ok).toBe(true);
    expect(commands).toHaveLength(2);
    expect(commands[1]?.options?.idempotencyKey).toMatch(/^run-create:/);
    expect(commands[1]?.options?.idempotencyKey).not.toBe(firstKey);

    const smuggled = (await invoke(ipc, registered, MAIN_CHANNELS.runCreate, {
      drawingId: "d1",
      revisionId: "r1",
      inputSnapshot: { faked: true }
    })) as BridgeResult<never>;
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) expect(smuggled.error.code).toBe("INVALID_PAYLOAD");
    expect(commands).toHaveLength(2);
  });

  it("run cancel maps to run.cancel with a stable run-scoped idempotency key", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: Array<{ command: unknown; options?: { idempotencyKey?: string } }> = [];
    const { deps } = makeDeps({
      runCommand: (command: unknown, options?: { idempotencyKey?: string }) => {
        commands.push({ command, options });
        return Promise.resolve(
          okEnvelope("c", { runId: "run-1", status: "CANCELLED", alreadyCancelled: false })
        );
      }
    });
    installMainIpc(ipc, deps);
    const first = (await invoke(ipc, registered, MAIN_CHANNELS.runCancel, {
      runId: "run-1",
      reason: "A"
    })) as BridgeResult<unknown>;
    const retry = (await invoke(ipc, registered, MAIN_CHANNELS.runCancel, {
      runId: "run-1",
      reason: "B"
    })) as BridgeResult<unknown>;
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    expect(commands).toHaveLength(2);
    // The reason is incidental: both cancels share ONE intent key.
    expect(commands[1]?.options?.idempotencyKey).toBe(commands[0]?.options?.idempotencyKey);
  });

  it("run subscribe registers a subscription, pushes validated batches, and unsubscribes cleanly", async () => {
    const { ipc, registered } = makeFakeIpc();
    const subscriptions: Array<{ runId: string; fromSequence?: number }> = [];
    let unsubscribeCalls = 0;
    let subscriber: {
      onRunEvents?: (batch: { runId: string; fromSequence: number; events: unknown[] }) => void;
      onRunEventsError?: (error: { code: string; runId: string; message: string }) => void;
    } = {};
    const { deps } = makeDeps({
      subscribeRunEvents: ((runId, sub, options) => {
        subscriptions.push({ runId, fromSequence: options?.fromSequence });
        subscriber = sub as typeof subscriber;
        return () => {
          unsubscribeCalls += 1;
        };
      })
    });
    installMainIpc(ipc, deps);
    const sender = makeSender();
    const subscribed = (await invoke(ipc, registered, MAIN_CHANNELS.runSubscribe, {
      runId: "run-1",
      fromSequence: 4
    }, sender)) as BridgeResult<unknown>;
    expect(subscribed.ok).toBe(true);
    expect(subscriptions).toEqual([{ runId: "run-1", fromSequence: 4 }]);

    // A committed batch is forwarded on the frozen push channel.
    subscriber.onRunEvents?.({
      runId: "run-1",
      fromSequence: 5,
      events: [{ sequence: 5, type: "StageChanged" }]
    });
    expect(sender.pushed).toEqual([
      {
        channel: MAIN_CHANNELS.runEvents,
        payload: {
          kind: "runEvents",
          runId: "run-1",
          fromSequence: 5,
          events: [{ sequence: 5, type: "StageChanged" }]
        }
      }
    ]);

    // A stream failure is forwarded as a structured error push (path-redacted).
    subscriber.onRunEventsError?.({
      code: "RUN_EVENT_GAP",
      runId: "run-1",
      message: "skipped C:\\Users\\alice\\secret"
    });
    expect(sender.pushed[1]).toEqual({
      channel: MAIN_CHANNELS.runEvents,
      payload: {
        kind: "runEventsError",
        runId: "run-1",
        error: { code: "RUN_EVENT_GAP", message: "skipped [path redacted]" }
      }
    });

    // Unsubscribe releases the host subscription exactly once.
    const unsubscribed = (await invoke(ipc, registered, MAIN_CHANNELS.runUnsubscribe, {
      runId: "run-1"
    }, sender)) as BridgeResult<unknown>;
    expect(unsubscribed.ok).toBe(true);
    expect(unsubscribeCalls).toBe(1);
  });

  it("run subscribe rejects a bad fromSequence and never reaches the host", async () => {
    const { ipc, registered } = makeFakeIpc();
    let hostCalls = 0;
    const { deps } = makeDeps({
      subscribeRunEvents: (() => {
        hostCalls += 1;
        return () => {};
      })
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.runSubscribe, {
      runId: "run-1",
      fromSequence: -3
    })) as BridgeResult<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_PAYLOAD");
    expect(hostCalls).toBe(0);
  });

  it("re-subscribing the same run from one sender replaces the previous subscription", async () => {
    const { ipc, registered } = makeFakeIpc();
    let unsubscribeCalls = 0;
    const { deps } = makeDeps({
      subscribeRunEvents: (() => {
        return () => {
          unsubscribeCalls += 1;
        };
      })
    });
    installMainIpc(ipc, deps);
    const sender = makeSender();
    await invoke(ipc, registered, MAIN_CHANNELS.runSubscribe, { runId: "run-1", fromSequence: 0 }, sender);
    await invoke(ipc, registered, MAIN_CHANNELS.runSubscribe, { runId: "run-1", fromSequence: 3 }, sender);
    // The first subscription was replaced by the second: one unsubscribe later.
    await invoke(ipc, registered, MAIN_CHANNELS.runUnsubscribe, { runId: "run-1" }, sender);
    expect(unsubscribeCalls).toBe(2);
  });

  it("a destroyed sender releases every subscription it registered", async () => {
    const { ipc, registered } = makeFakeIpc();
    const released: string[] = [];
    const { deps } = makeDeps({
      subscribeRunEvents: ((runId: string) => {
        return () => {
          released.push(runId);
        };
      })
    });
    installMainIpc(ipc, deps);
    const sender = makeSender(7);
    await invoke(ipc, registered, MAIN_CHANNELS.runSubscribe, { runId: "run-1", fromSequence: 0 }, sender);
    await invoke(ipc, registered, MAIN_CHANNELS.runSubscribe, { runId: "run-2", fromSequence: 0 }, sender);
    expect(released).toEqual([]);
    sender.destroy();
    expect(released.sort()).toEqual(["run-1", "run-2"]);
  });

  it("clarification get maps to clarification.get", async () => {
    const { ipc, registered } = makeFakeIpc();
    const queries: Array<{ name: string; payload: unknown }> = [];
    const { deps } = makeDeps({
      runQuery: (name, payload) => {
        queries.push({ name, payload });
        return Promise.resolve(okEnvelope("q", { clarificationRequestId: "clar-1" }));
      }
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.clarificationGet, {
      clarificationRequestId: "clar-1"
    })) as BridgeResult<unknown>;
    expect(result.ok).toBe(true);
    expect(queries).toEqual([
      { name: "clarification.get", payload: { clarificationRequestId: "clar-1" } }
    ]);
  });

  it("clarification submit maps to clarification.submit with a content-scoped idempotency key", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: Array<{ command: unknown; options?: { idempotencyKey?: string } }> = [];
    const { deps } = makeDeps({
      runCommand: (command: unknown, options?: { idempotencyKey?: string }) => {
        commands.push({ command, options });
        return Promise.resolve(okEnvelope("c", { clarificationRequestId: "clar-1", status: "ANSWERED" }));
      }
    });
    installMainIpc(ipc, deps);
    const payload = {
      clarificationRequestId: "clar-1",
      answers: [
        {
          id: "ans-1",
          questionId: "dimension",
          value: { kind: "dimension", value: 12, unit: "mm" },
          answeredAt: "2026-08-13T01:00:00.000Z",
          answeredBy: "alice"
        }
      ],
      answeredAt: "2026-08-13T01:00:00.000Z",
      answeredBy: "alice"
    };
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.clarificationSubmit, payload)) as BridgeResult<unknown>;
    expect(result.ok).toBe(true);
    const command = commands[0]?.command as {
      command: string;
      clarificationRequestId: string;
    };
    expect(command.command).toBe("clarification.submit");
    expect(command.clarificationRequestId).toBe("clar-1");

    // A retry with a FRESH transport timestamp keeps the same intent key...
    const retryPayload = {
      ...payload,
      answeredAt: "2026-08-13T02:00:00.000Z",
      answers: [
        {
          ...payload.answers[0],
          answeredAt: "2026-08-13T02:00:00.000Z"
        }
      ]
    };
    await invoke(ipc, registered, MAIN_CHANNELS.clarificationSubmit, retryPayload);
    expect(commands[1]?.options?.idempotencyKey).toBe(commands[0]?.options?.idempotencyKey);

    // ... while DIFFERENT answers map to a DIFFERENT intent (honest rejection
    // once the request is ANSWERED, never a cached duplicate).
    const different = {
      ...payload,
      answers: [
        {
          ...payload.answers[0],
          value: { kind: "dimension", value: 20, unit: "mm" }
        }
      ]
    };
    await invoke(ipc, registered, MAIN_CHANNELS.clarificationSubmit, different);
    expect(commands[2]?.options?.idempotencyKey).not.toBe(commands[0]?.options?.idempotencyKey);
  });

  it("clarification submit rejects malformed answer values", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps } = makeDeps();
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.clarificationSubmit, {
      clarificationRequestId: "clar-1",
      answers: [
        {
          id: "ans-1",
          questionId: "q1",
          value: { kind: "choice", optionId: "" },
          answeredAt: "2026-08-13T01:00:00.000Z",
          answeredBy: "alice"
        }
      ],
      answeredAt: "2026-08-13T01:00:00.000Z",
      answeredBy: "alice"
    })) as BridgeResult<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_PAYLOAD");
  });

  it("model detail maps to model.getDetail and rejects a smuggled payload", async () => {
    const { ipc, registered } = makeFakeIpc();
    const queries: Array<{ name: string; payload: unknown }> = [];
    const { deps } = makeDeps({
      runQuery: (name, payload) => {
        queries.push({ name, payload });
        return Promise.resolve(
          okEnvelope("q", { model: { modelId: "model-1" }, artifacts: [], reviews: [] })
        );
      }
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.modelDetail, {
      modelId: "model-1"
    })) as BridgeResult<unknown>;
    expect(result.ok).toBe(true);
    expect(queries).toEqual([{ name: "model.getDetail", payload: { modelId: "model-1" } }]);

    const smuggled = (await invoke(ipc, registered, MAIN_CHANNELS.modelDetail, {
      modelId: "model-1",
      review: true
    })) as BridgeResult<never>;
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) expect(smuggled.error.code).toBe("INVALID_PAYLOAD");
  });

  it("model review maps to model.review with a stable (modelId, result) idempotency key", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: Array<{ command: unknown; options?: { idempotencyKey?: string } }> = [];
    const { deps } = makeDeps({
      runCommand: (command: unknown, options?: { idempotencyKey?: string }) => {
        commands.push({ command, options });
        return Promise.resolve(okEnvelope("c", { model: { modelId: "model-1" }, artifacts: [], reviews: [] }));
      }
    });
    installMainIpc(ipc, deps);
    const payload = {
      modelId: "model-1",
      result: "APPROVED" as const,
      reviewerId: "current-windows-user",
      reviewedAt: "2026-08-13T01:00:00.000Z"
    };
    const first = (await invoke(ipc, registered, MAIN_CHANNELS.modelReview, payload)) as BridgeResult<unknown>;
    expect(first.ok).toBe(true);
    const command = commands[0]?.command as {
      command: string;
      modelId: string;
      result: string;
      reviewerId: string;
      reviewedAt: string;
    };
    expect(command.command).toBe("model.review");
    expect(command.modelId).toBe("model-1");
    expect(command.result).toBe("APPROVED");
    expect(command.reviewerId).toBe("current-windows-user");
    expect(command.reviewedAt).toBe("2026-08-13T01:00:00.000Z");

    // A retry with a FRESH reviewedAt keeps the same semantic intent key.
    const retry = (await invoke(ipc, registered, MAIN_CHANNELS.modelReview, {
      ...payload,
      reviewedAt: "2026-08-13T02:00:00.000Z"
    })) as BridgeResult<unknown>;
    expect(retry.ok).toBe(true);

    // A DIFFERENT result for the same model is a distinct intent.
    const different = (await invoke(ipc, registered, MAIN_CHANNELS.modelReview, {
      ...payload,
      result: "REJECTED",
      comment: "右侧台阶直径错误",
      reviewedAt: "2026-08-13T03:00:00.000Z"
    })) as BridgeResult<unknown>;
    expect(different.ok).toBe(true);

    expect(commands).toHaveLength(3);
    const firstKey = commands[0]?.options?.idempotencyKey;
    expect(firstKey).toBe("model-review:model-1:APPROVED");
    expect(commands[1]?.options?.idempotencyKey).toBe(firstKey);
    expect(commands[2]?.options?.idempotencyKey).toBe("model-review:model-1:REJECTED");
    expect(commands[2]?.options?.idempotencyKey).not.toBe(firstKey);
  });

  it("model review rejects a REJECTED payload without a comment and never touches the Runner", async () => {
    const { ipc, registered } = makeFakeIpc();
    let runCount = 0;
    const { deps } = makeDeps({
      runCommand: () => {
        runCount += 1;
        return Promise.resolve(okEnvelope("c", {}));
      }
    });
    installMainIpc(ipc, deps);
    const malformed = (await invoke(ipc, registered, MAIN_CHANNELS.modelReview, {
      modelId: "model-1",
      result: "REJECTED",
      reviewerId: "alice",
      reviewedAt: "2026-08-13T01:00:00.000Z"
    })) as BridgeResult<never>;
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("INVALID_PAYLOAD");

    const nonCanonical = (await invoke(ipc, registered, MAIN_CHANNELS.modelReview, {
      modelId: "model-1",
      result: "APPROVED",
      reviewerId: "alice",
      reviewedAt: "2026-08-13 01:00:00"
    })) as BridgeResult<never>;
    expect(nonCanonical.ok).toBe(false);
    if (!nonCanonical.ok) expect(nonCanonical.error.code).toBe("INVALID_PAYLOAD");

    const unknownField = (await invoke(ipc, registered, MAIN_CHANNELS.modelReview, {
      modelId: "model-1",
      result: "APPROVED",
      reviewerId: "alice",
      reviewedAt: "2026-08-13T01:00:00.000Z",
      reviewId: "review-1"
    })) as BridgeResult<never>;
    expect(unknownField.ok).toBe(false);
    if (!unknownField.ok) expect(unknownField.error.code).toBe("INVALID_PAYLOAD");

    // No invalid payload ever reached the Runner.
    expect(runCount).toBe(0);
  });

  it("run delete maps to run.delete with a run-scoped idempotency key", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: Array<{ command: unknown; options?: { idempotencyKey?: string } }> = [];
    const { deps } = makeDeps({
      runCommand: (command: unknown, options?: { idempotencyKey?: string }) => {
        commands.push({ command, options });
        return Promise.resolve(okEnvelope("c", { runId: "run-1", attemptSequences: [1, 2] }));
      }
    });
    installMainIpc(ipc, deps);
    const payload = { runId: "run-1", drawingId: "d1", revisionId: "r2" };
    const first = (await invoke(ipc, registered, MAIN_CHANNELS.runDelete, payload)) as BridgeResult<{
      runId: string;
      attemptSequences: number[];
    }>;
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.data.runId).toBe("run-1");
      expect(first.data.attemptSequences).toEqual([1, 2]);
    }
    const retry = (await invoke(ipc, registered, MAIN_CHANNELS.runDelete, payload)) as BridgeResult<unknown>;
    expect(retry.ok).toBe(true);

    expect(commands).toHaveLength(2);
    const command = commands[0]?.command as { command: string; runId: string; drawingId: string; revisionId: string };
    expect(command.command).toBe("run.delete");
    expect(command.runId).toBe("run-1");
    expect(command.drawingId).toBe("d1");
    expect(command.revisionId).toBe("r2");
    // The delete intent is keyed on the Run only: retries share ONE key.
    expect(commands[1]?.options?.idempotencyKey).toBe(commands[0]?.options?.idempotencyKey);
  });

  it("run delete rejects smuggled fields and never reaches the Runner", async () => {
    const { ipc, registered } = makeFakeIpc();
    let runCount = 0;
    const { deps } = makeDeps({
      runCommand: () => {
        runCount += 1;
        return Promise.resolve(okEnvelope("c", {}));
      }
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.runDelete, {
      runId: "run-1",
      drawingId: "d1",
      revisionId: "r1",
      deleteWholeDrawing: true
    })) as BridgeResult<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_PAYLOAD");
    const badIds = (await invoke(ipc, registered, MAIN_CHANNELS.runDelete, {
      runId: "../escape",
      drawingId: "d1",
      revisionId: "r1"
    })) as BridgeResult<never>;
    expect(badIds.ok).toBe(false);
    if (!badIds.ok) expect(badIds.error.code).toBe("INVALID_PAYLOAD");
    expect(runCount).toBe(0);
  });

  it("costReport delete maps to costReport.delete with a report-scoped idempotency key", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: Array<{ command: unknown; options?: { idempotencyKey?: string } }> = [];
    const { deps } = makeDeps({
      runCommand: (command: unknown, options?: { idempotencyKey?: string }) => {
        commands.push({ command, options });
        return Promise.resolve(okEnvelope("c", { costReportId: "cost-report-1" }));
      }
    });
    installMainIpc(ipc, deps);
    const payload = { costReportId: "cost-report-1", revisionId: "rev-3" };
    await invoke(ipc, registered, MAIN_CHANNELS.costReportDelete, payload);
    await invoke(ipc, registered, MAIN_CHANNELS.costReportDelete, payload);
    expect(commands).toHaveLength(2);
    const command = commands[0]?.command as { command: string; costReportId: string; revisionId: string };
    expect(command.command).toBe("costReport.delete");
    expect(command.costReportId).toBe("cost-report-1");
    expect(command.revisionId).toBe("rev-3");
    expect(commands[1]?.options?.idempotencyKey).toBe(commands[0]?.options?.idempotencyKey);

    // A different report is a distinct intent.
    const other = (await invoke(ipc, registered, MAIN_CHANNELS.costReportDelete, {
      costReportId: "cost-report-2",
      revisionId: "rev-3"
    })) as BridgeResult<unknown>;
    expect(other.ok).toBe(true);
    expect(commands[2]?.options?.idempotencyKey).not.toBe(commands[0]?.options?.idempotencyKey);
  });

  it("costReport delete rejects unknown fields with INVALID_PAYLOAD", async () => {
    const { ipc, registered } = makeFakeIpc();
    let runCount = 0;
    const { deps } = makeDeps({
      runCommand: () => {
        runCount += 1;
        return Promise.resolve(okEnvelope("c", {}));
      }
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.costReportDelete, {
      costReportId: "cost-report-1",
      revisionId: "rev-3",
      why: "because"
    })) as BridgeResult<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_PAYLOAD");
    expect(runCount).toBe(0);
  });

  it("recoveryStatus reads system.getRecoveryStatus as a NON-cached read (no idempotency key)", async () => {
    const { ipc, registered } = makeFakeIpc();
    const commands: Array<{ command: unknown; options?: { idempotencyKey?: string } }> = [];
    const { deps } = makeDeps({
      runCommand: (command: unknown, options?: { idempotencyKey?: string }) => {
        commands.push({ command, options });
        return Promise.resolve(okEnvelope("c", { scanTime: "2026-08-18T00:00:00.000Z", resumedCount: 1 }));
      }
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.recoveryStatus, {})) as BridgeResult<{
      scanTime: string;
    }>;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.scanTime).toBe("2026-08-18T00:00:00.000Z");
    expect(commands).toHaveLength(1);
    expect((commands[0]?.command as { command: string }).command).toBe("system.getRecoveryStatus");
    // A read must never be cached by the Runner's replay cache.
    expect(commands[0]?.options?.idempotencyKey).toBeUndefined();
    expect(JSON.stringify(commands[0]?.command)).not.toContain("scanTime");
  });

  it("recoveryStatus rejects non-empty payloads and never reaches the Runner", async () => {
    const { ipc, registered } = makeFakeIpc();
    let runCount = 0;
    const { deps } = makeDeps({
      runCommand: () => {
        runCount += 1;
        return Promise.resolve(okEnvelope("c", {}));
      }
    });
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.recoveryStatus, {
      scan: true
    })) as BridgeResult<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_PAYLOAD");
    expect(runCount).toBe(0);
  });

  it("secrets.getStatus returns presence + masked preview only", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps, secretsState } = makeDeps();
    secretsState.stored = "sk-proj-0123456789abcdefghij98765432";
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.secretsGetStatus, {})) as BridgeResult<{
      hasApiKey: boolean;
      maskedApiKey: string | null;
    }>;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.hasApiKey).toBe(true);
      expect(result.data.maskedApiKey).toBe("sk-****5432");
      expect(JSON.stringify(result.data)).not.toContain("0123456789");
    }
    // Nothing else is stored: no plaintext key ever crosses the bridge.
    expect(secretsState.calls).toContain("getApiKeyStatus");
    expect(secretsState.calls).not.toContain("getApiKey");
  });

  it("secrets.getStatus rejects non-empty payloads", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps, secretsState } = makeDeps();
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.secretsGetStatus, {
      apiKey: "sk-proj-leak"
    })) as BridgeResult<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_PAYLOAD");
    expect(secretsState.calls).not.toContain("getApiKeyStatus");
  });

  it("secrets.setApiKey stores the validated key and resolves the refreshed status", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps, secretsState } = makeDeps();
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.secretsSetApiKey, {
      apiKey: "sk-proj-my-real-key-1234"
    })) as BridgeResult<{ hasApiKey: boolean; maskedApiKey: string | null }>;
    expect(result.ok).toBe(true);
    expect(secretsState.stored).toBe("sk-proj-my-real-key-1234");
    if (result.ok) expect(result.data.hasApiKey).toBe(true);
  });

  it("secrets.setApiKey rejects blank/unknown/overlong keys without touching the store", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps, secretsState } = makeDeps();
    installMainIpc(ipc, deps);
    for (const payload of [
      { apiKey: "   " },
      { apiKey: "" },
      { apiKey: 42 },
      { apiKey: "x".repeat(4097) },
      { apiKey: "valid-key", provider: "openai" }
    ]) {
      const result = (await invoke(ipc, registered, MAIN_CHANNELS.secretsSetApiKey, payload)) as BridgeResult<never>;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_PAYLOAD");
    }
    expect(secretsState.stored).toBeNull();
    expect(secretsState.calls).not.toContain("setApiKey");
  });

  it("secrets.clearApiKey clears the key and resolves the empty status", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps, secretsState } = makeDeps();
    secretsState.stored = "sk-proj-to-clear";
    installMainIpc(ipc, deps);
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.secretsClearApiKey, {})) as BridgeResult<{
      hasApiKey: boolean;
    }>;
    expect(result.ok).toBe(true);
    expect(secretsState.stored).toBeNull();
    if (result.ok) expect(result.data.hasApiKey).toBe(false);
  });

  it("maps a SecretStore failure to a sanitized INTERNAL error", async () => {
    const { ipc, registered } = makeFakeIpc();
    const { deps, secretsState } = makeDeps();
    installMainIpc(ipc, deps);
    secretsState.failNext = "read";
    const result = (await invoke(ipc, registered, MAIN_CHANNELS.secretsGetStatus, {})) as BridgeResult<never>;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      // Vault internals never leak to the Renderer.
      expect(result.error.message).not.toContain("vault");
      expect(result.error.message).not.toContain("corrupt");
    }
  });
});
