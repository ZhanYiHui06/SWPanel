import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Command, IpcRequestEnvelope, IpcResponseEnvelope, QueryName } from "@swpanel/contracts";
import { IPC_PROTOCOL_VERSION } from "@swpanel/contracts";
import type { AgentTurnAdapter } from "@swpanel/runner";
import { PipeDaclResult, Runner } from "@swpanel/runner";

import {
  RunnerHost,
  RunnerHostNotReadyError,
  RunnerHostStartError,
  type RunnerHostClientLike,
  type RunnerHostServerLike
} from "./runner-host.js";
import { IpcConnectError } from "../ipc-client/index.js";

function okEnvelope(requestId: string, data: unknown): IpcResponseEnvelope {
  return { protocolVersion: IPC_PROTOCOL_VERSION, requestId, ok: true, data };
}

function errorEnvelope(requestId: string, code: string, message: string): IpcResponseEnvelope {
  return { protocolVersion: IPC_PROTOCOL_VERSION, requestId, ok: false, error: { code, message } };
}

interface FakeServer extends Omit<RunnerHostServerLike, "acl" | "claimsWindowsPipe"> {
  runnerRegister: (sha256: string, absolutePath: string) => void;
  closed: boolean;
  /** Mutable so tests can inject WINDOWS_ACL_FAILED / missing results. */
  acl: PipeDaclResult | null;
  claimsWindowsPipe?: boolean;
}

function makeServer(options: { failStart?: boolean; probeError?: boolean } = {}): FakeServer {
  const received: IpcRequestEnvelope[] = [];
  const runnerRegister = (): void => {};
  let closed = false;
  const server: FakeServer = {
    pipePath: "\\\\.\\pipe\\swpanel.test.host",
    serverInstanceId: "server-instance-1",
    // In-memory test adapter: no real pipe is bound, so the win32 ACL gate is
    // explicitly waived via the documented exemption.
    acl: null,
    claimsWindowsPipe: false,
    runnerRegister,
    dispatch: (request) => {
      received.push(request);
      if (options.failStart === true) {
        throw new Error("pipe bind failed");
      }
      if (options.probeError === true) {
        return Promise.resolve(errorEnvelope(request.requestId, "INVALID_PAYLOAD", "probe failed"));
      }
      return Promise.resolve(okEnvelope(request.requestId, { settings: { dataRoot: "C:\\data" } }));
    },
    close: () => {
      closed = true;
      return Promise.resolve();
    }
  };
  Object.defineProperty(server, "closed", {
    configurable: true,
    enumerable: true,
    get: () => closed,
    set: (value: boolean) => {
      closed = value;
    }
  });
  return server;
}

function makeClient(
  options: { failConnect?: boolean; failProbe?: boolean } = {}
): RunnerHostClientLike & {
  closed: boolean;
  requests: Array<{ name: QueryName; payload: unknown } | Command>;
} {
  const requests: Array<{ name: QueryName; payload: unknown } | Command> = [];
  let closed = false;
  let queryCount = 0;
  const client: RunnerHostClientLike & {
    requests: typeof requests;
  } = {
    requests,
    get serverInstanceId() {
      return "server-instance-1";
    },
    query: (name, payload) => {
      if (options.failConnect === true) {
        throw new IpcConnectError("connection refused");
      }
      requests.push({ name, payload });
      queryCount++;
      if (queryCount === 1) {
        return Promise.resolve(
          options.failProbe === true
            ? { protocolVersion: IPC_PROTOCOL_VERSION, requestId: "probe", ok: false, error: { code: "INVALID_PAYLOAD", message: "probe failed" } }
            : okEnvelope("probe", { settings: {} })
        );
      }
      return Promise.resolve(okEnvelope("q", { settings: {} }));
    },
    command: (command) => {
      requests.push(command);
      return Promise.resolve(okEnvelope("c", {}));
    },
    close: () => {
      closed = true;
    }
  };
  Object.defineProperty(client, "closed", {
    configurable: true,
    enumerable: true,
    get: () => closed,
    set: (value: boolean) => {
      closed = value;
    }
  });
  return client;
}

function tempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "swpanel-host-test-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("RunnerHost", () => {
  it("starts and becomes READY with a sanitized health state", async () => {
    const { root, cleanup } = tempRoot();
    try {
      const server = makeServer();
      const client = makeClient();
      const host = new RunnerHost({
        dataRoot: root,
        dependencies: {
          createServer: () => server,
          createClient: () => client
        }
      });
      expect(host.state).toBe("idle");
      await host.start();
      expect(host.state).toBe("ready");
      expect(host.health).toEqual({
        status: "READY",
        serverInstanceId: "server-instance-1",
        error: null
      });
      expect(client.requests).toEqual([{ name: "storage.getSettings", payload: {} }]);
      await host.close();
      expect(host.state).toBe("closed");
      expect(host.health.status).toBe("CLOSED");
    } finally {
      cleanup();
    }
  });

  it("is idempotent: starting twice is a no-op", async () => {
    const { root, cleanup } = tempRoot();
    try {
      const server = makeServer();
      const client = makeClient();
      const host = new RunnerHost({
        dataRoot: root,
        dependencies: { createServer: () => server, createClient: () => client }
      });
      await host.start();
      await host.start();
      expect(host.state).toBe("ready");
      // Only one probe was dispatched.
      const probes = client.requests.filter(
        (request) => "name" in request && request.name === "storage.getSettings"
      );
      expect(probes).toHaveLength(1);
      await host.close();
    } finally {
      cleanup();
    }
  });

  it("stays FAILED with a sanitized health state when the server start fails", async () => {
    const { root, cleanup } = tempRoot();
    try {
      const host = new RunnerHost({
        dataRoot: root,
        dependencies: {
          createServer: () => {
            throw new Error("net::ERR_ADDRESS_IN_USE");
          },
          createClient: () => makeClient()
        },
        logger: { error: () => {} }
      });
      await expect(host.start()).rejects.toBeInstanceOf(RunnerHostStartError);
      expect(host.state).toBe("failed");
      const health = host.health;
      expect(health.status).toBe("FAILED");
      expect(health.serverInstanceId).toBeNull();
      expect(health.error).not.toBeNull();
      expect(health.error?.code).toBe("RUNNER_START_FAILED");
    } finally {
      cleanup();
    }
  });

  it("stays FAILED when the probe fails with a structured error", async () => {
    const { root, cleanup } = tempRoot();
    try {
      const server = makeServer();
      const client = makeClient({ failProbe: true });
      const host = new RunnerHost({
        dataRoot: root,
        dependencies: { createServer: () => server, createClient: () => client },
        logger: { error: () => {} }
      });
      await expect(host.start()).rejects.toMatchObject({ code: "PROBE_FAILED" });
      expect(host.state).toBe("failed");
      expect(host.health.status).toBe("FAILED");
      await host.close();
      expect(host.state).toBe("closed");
    } finally {
      cleanup();
    }
  });

  it("stays FAILED when the client connect fails", async () => {
    const { root, cleanup } = tempRoot();
    try {
      const server = makeServer();
      const host = new RunnerHost({
        dataRoot: root,
        dependencies: {
          createServer: () => server,
          createClient: () => makeClient({ failConnect: true })
        },
        logger: { error: () => {} }
      });
      await expect(host.start()).rejects.toBeInstanceOf(RunnerHostStartError);
      expect(host.state).toBe("failed");
      expect(host.health.error?.code).toBe("RUNNER_UNAVAILABLE");
    } finally {
      cleanup();
    }
  });

  it("registers source files and dispatches queries/commands when READY", async () => {
    const { root, cleanup } = tempRoot();
    try {
      const server = makeServer();
      const client = makeClient();
      const host = new RunnerHost({
        dataRoot: root,
        dependencies: { createServer: () => server, createClient: () => client }
      });
      await host.start();
      host.registerSourceFile("a".repeat(64), "C:\\x\\a.pdf");
      const response = await host.runQuery("storage.getSettings", {});
      expect(response.ok).toBe(true);
      await host.runCommand({ command: "storage.updateSettings", settings: {} as never });
      expect(host.health.status).toBe("READY");
      await host.close();
    } finally {
      cleanup();
    }
  });

  it("refuses requests before the host is READY", async () => {
    const { root, cleanup } = tempRoot();
    try {
      const host = new RunnerHost({ dataRoot: root });
      await expect(host.runQuery("storage.getSettings", {})).rejects.toBeInstanceOf(
        RunnerHostNotReadyError
      );
      expect(() => host.registerSourceFile("a".repeat(64), "C:\\x\\a.pdf")).toThrow(
        RunnerHostNotReadyError
      );
    } finally {
      cleanup();
    }
  });

  it("closes exactly once even under concurrent close calls", async () => {
    const { root, cleanup } = tempRoot();
    try {
      const server = makeServer();
      const client = makeClient();
      const host = new RunnerHost({
        dataRoot: root,
        dependencies: { createServer: () => server, createClient: () => client }
      });
      await host.start();
      await Promise.all([host.close(), host.close(), host.close()]);
      expect(host.state).toBe("closed");
      // The server/client were closed (no double close exceptions surfaced).
      expect(client.closed).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("close() awaits the Runner shutdown seam: an OWNED never-started live adapter is closed (no orphan)", async () => {
    const { root, cleanup } = tempRoot();
    try {
      const server = makeServer();
      const client = makeClient();
      let closed = 0;
      const host = new RunnerHost({
        dataRoot: root,
        dependencies: {
          createRunner: (dataRoot) => {
            const adapter: AgentTurnAdapter = {
              adapterId: "host-close-spy",
              adapterVersion: "1",
              protocol: "test",
              protocolVersion: "1",
              threadIdFor: (runId) => `thread-${runId}`,
              runTurn: () => Promise.resolve([]),
              close: () => {
                closed += 1;
              }
            };
            return new Runner(dataRoot, { agent: adapter, ownsAgent: true });
          },
          createServer: () => server,
          createClient: () => client
        }
      });
      await host.start();
      expect(host.state).toBe("ready");
      // The queue loop never started: the eagerly spawned transport of the
      // owned adapter must still be closed before host.close() settles.
      await host.close();
      expect(closed).toBe(1);
      expect(host.state).toBe("closed");
    } finally {
      cleanup();
    }
  });

  it("sanitizes failure messages (no paths or stacks in the health state)", async () => {
    const { root, cleanup } = tempRoot();
    try {
      const host = new RunnerHost({
        dataRoot: root,
        dependencies: {
          createServer: () => {
            throw new Error("Failed to open database at C:\\Users\\alice\\AppData\\Local\\JANGHI\\SWPanel");
          },
          createClient: () => makeClient()
        },
        logger: { error: () => {} }
      });
      await expect(host.start()).rejects.toBeInstanceOf(RunnerHostStartError);
      const message = host.health.error?.message ?? "";
      expect(message).not.toContain("C:\\Users\\alice");
      expect(message).not.toContain("Local\\JANGHI");
    } finally {
      cleanup();
    }
  });

  describe("Windows named-pipe ACL fail-closed gate", () => {
    function aclAppliedServer(): FakeServer {
      const server = makeServer();
      server.acl = {
        status: "WINDOWS_ACL_APPLIED",
        ownerAccount: "alice",
        ownerSid: "S-1-5-21-123",
        systemSid: "S-1-5-18",
        aces: []
      };
      server.claimsWindowsPipe = true;
      return server;
    }

    it("accepts a real pipe whose ACL was verified as WINDOWS_ACL_APPLIED", async () => {
      const { root, cleanup } = tempRoot();
      try {
        const server = aclAppliedServer();
        const host = new RunnerHost({
          dataRoot: root,
          dependencies: {
            createServer: () => server,
            createClient: () => makeClient(),
            platform: "win32"
          }
        });
        await host.start();
        expect(host.state).toBe("ready");
        expect(host.health.status).toBe("READY");
        await host.close();
      } finally {
        cleanup();
      }
    });

    it("refuses startup when the ACL result is WINDOWS_ACL_FAILED and closes the stack", async () => {
      const { root, cleanup } = tempRoot();
      try {
        const server = makeServer();
        server.acl = { status: "WINDOWS_ACL_FAILED", reason: "SetSecurityInfo failed with error 5" };
        server.claimsWindowsPipe = true;
        let clientCreated = false;
        const host = new RunnerHost({
          dataRoot: root,
          dependencies: {
            createServer: () => server,
            createClient: () => {
              clientCreated = true;
              return makeClient();
            },
            platform: "win32"
          },
          logger: { error: () => {} }
        });
        await expect(host.start()).rejects.toMatchObject({ code: "PIPE_ACL_FAILED" });
        expect(host.state).toBe("failed");
        const health = host.health;
        expect(health.status).toBe("FAILED");
        expect(health.serverInstanceId).toBeNull();
        expect(health.error?.code).toBe("PIPE_ACL_FAILED");
        // Sanitized: no reason prose and no paths in the exposed message.
        expect(health.error?.message).not.toContain("SetSecurityInfo");
        // Fail closed: the partial stack was torn down and no client was built.
        expect(server.closed).toBe(true);
        expect(clientCreated).toBe(false);
        await host.close();
      } finally {
        cleanup();
      }
    });

    it("refuses startup when the ACL result is missing (null)", async () => {
      const { root, cleanup } = tempRoot();
      try {
        const server = makeServer();
        server.acl = null;
        server.claimsWindowsPipe = true;
        const host = new RunnerHost({
          dataRoot: root,
          dependencies: {
            createServer: () => server,
            createClient: () => makeClient(),
            platform: "win32"
          },
          logger: { error: () => {} }
        });
        await expect(host.start()).rejects.toMatchObject({ code: "PIPE_ACL_FAILED" });
        expect(host.state).toBe("failed");
        expect(host.health.error?.code).toBe("PIPE_ACL_FAILED");
        expect(server.closed).toBe(true);
      } finally {
        cleanup();
      }
    });

    it("refuses startup when a silent adapter omits the claimsWindowsPipe declaration AND the ACL is missing", async () => {
      const { root, cleanup } = tempRoot();
      try {
        const server = makeServer();
        server.acl = null;
        const undeclared = server as RunnerHostServerLike;
        Reflect.deleteProperty(undeclared, "claimsWindowsPipe");
        const host = new RunnerHost({
          dataRoot: root,
          dependencies: {
            createServer: () => undeclared,
            createClient: () => makeClient(),
            platform: "win32"
          },
          logger: { error: () => {} }
        });
        await expect(host.start()).rejects.toMatchObject({ code: "PIPE_ACL_FAILED" });
        expect(host.health.status).toBe("FAILED");
        expect(server.closed).toBe(true);
      } finally {
        cleanup();
      }
    });

    it("exempts non-Windows hosts (no named pipe exists there)", async () => {
      const { root, cleanup } = tempRoot();
      try {
        const server = makeServer();
        const host = new RunnerHost({
          dataRoot: root,
          dependencies: {
            createServer: () => server,
            createClient: () => makeClient(),
            platform: "linux"
          },
          logger: { error: () => {} }
        });
        await host.start();
        expect(host.state).toBe("ready");
        await host.close();
      } finally {
        cleanup();
      }
    });

    it("exempts in-memory test adapters that explicitly declare no real pipe", async () => {
      const { root, cleanup } = tempRoot();
      try {
        const server = makeServer(); // claimsWindowsPipe: false, acl: null
        const host = new RunnerHost({
          dataRoot: root,
          dependencies: { createServer: () => server, createClient: () => makeClient() }
        });
        await host.start();
        expect(host.state).toBe("ready");
        await host.close();
      } finally {
        cleanup();
      }
    });
  });
});
