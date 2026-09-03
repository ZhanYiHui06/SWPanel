import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

import { InvalidArgumentError } from "../errors.js";
import { CODEX_SANDBOX_MODE } from "../agent/codex/builders.js";
import {
  CODEX_SKILL_FILE_NAME,
  DEFAULT_LIVE_CODEX_PROBE_TIMEOUT_MS,
  failClosedLiveCodexResult,
  isSkillMdPathOfDirectory,
  probeLiveCodexRuntime,
  runtimeProbeResultOf
} from "./codex-live-probe.js";
import {
  decodeJsonRpcLine,
  type JsonRpcRequest
} from "../agent/codex/jsonrpc-codec.js";
import type { CodexTransport } from "../agent/codex/codex-app-server-client.js";

const SKILL_NAME = "solidworks-build-part-from-drawing";
// The configured input is the skill DIRECTORY; the listing truthfully reports
// the manifest file inside it.
const SKILL_PATH = "C:\\skills\\solidworks-build-part-from-drawing";
const SKILL_MD_PATH = "C:\\skills\\solidworks-build-part-from-drawing\\SKILL.md";
// The caller-supplied probe workspace of the thread/start compatibility probe
// (the hermetic default keeps the tests free of real temp-directory I/O).
const PROBE_WORKSPACE = "C:\\swpanel\\codex-probe-workspace";
const FIXED_NOW = () => new Date("2026-08-14T00:00:00.000Z");

const INITIALIZE_RESULT = {
  codexHome: "C:\\Users\\me\\.codex",
  platformFamily: "windows",
  platformOs: "windows",
  userAgent: "codex-app-server/0.147.0"
};

type ScriptedReply =
  | { kind: "result"; value: unknown }
  | { kind: "error"; code: number; message: string }
  | { kind: "none" };

/**
 * Hermetic in-memory Codex App Server transport: the probe NEVER spawns a
 * real process. Every request the client writes is answered synchronously by
 * the injected responder (the client registers its pending entry before the
 * write, so a synchronous reply is a legal response); the test inspects the
 * written request lines and the close count (the probe must close its child
 * exactly once on every path).
 */
class ScriptedTransport implements CodexTransport {
  readonly written: string[] = [];
  closeCount = 0;
  private lineHandler: ((line: string) => void) | null = null;
  private exitHandler:
    | ((exit: { code: number | null; signal: string | null }) => void)
    | null = null;
  private readonly responder: (request: {
    id: number;
    method: string;
    params: unknown;
  }) => ScriptedReply;

  constructor(
    responder: (request: { id: number; method: string; params: unknown }) => ScriptedReply
  ) {
    this.responder = responder;
  }

  writeLine(line: string): void {
    this.written.push(line);
    const decoded = decodeJsonRpcLine(line);
    if (decoded.kind !== "request") return; // notifications never get a reply
    const message = decoded.message as JsonRpcRequest;
    const reply = this.responder({
      id: message.id as number,
      method: message.method,
      params: message.params
    });
    if (reply.kind === "none") return;
    const payload =
      reply.kind === "error"
        ? { id: message.id, error: { code: reply.code, message: reply.message } }
        : { id: message.id, result: reply.value };
    this.lineHandler?.(JSON.stringify(payload));
  }

  setLineHandler(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  setExitHandler(handler: (exit: { code: number | null; signal: string | null }) => void): void {
    this.exitHandler = handler;
  }

  close(): void {
    // The real transport close is idempotent (CodexChildTransport.close):
    // mirror that contract so the probe's single-owner guarantee is asserted
    // exactly (the client may close first on a failing connection).
    if (this.closeCount === 0) this.closeCount = 1;
  }

  /** Emits the child-exit signal to the client. */
  exit(code: number | null, signal: string | null): void {
    this.exitHandler?.({ code, signal });
  }

  /** The decoded request methods the probe sent, in order. */
  requestMethods(): readonly string[] {
    return this.written
      .map((line) => decodeJsonRpcLine(line))
      .filter((decoded) => decoded.kind === "request")
      .map((decoded) => (decoded.message as JsonRpcRequest).method);
  }

  /** The decoded params of the LAST request of the given method, or null. */
  lastParams(method: string): Record<string, unknown> | null {
    let found: Record<string, unknown> | null = null;
    for (const line of this.written) {
      const decoded = decodeJsonRpcLine(line);
      if (decoded.kind !== "request") continue;
      const message = decoded.message as JsonRpcRequest;
      if (message.method !== method) continue;
      found = (message.params as Record<string, unknown>) ?? {};
    }
    return found;
  }
}

function skillEntry(path = SKILL_MD_PATH): Record<string, unknown> {
  return { name: SKILL_NAME, description: "d", enabled: true, path, scope: "user" };
}

function skillsListResult(skills: readonly unknown[]): Record<string, unknown> {
  return { data: [{ cwd: "C:\\work", errors: [], skills }] };
}

/** The happy responder: a strict 0.147.0 initialize + the given skills list + a successful thread/start. */
function happyResponder(skills: readonly unknown[] = [skillEntry()]) {
  return (request: { id: number; method: string; params: unknown }): ScriptedReply => {
    switch (request.method) {
      case "initialize":
        return { kind: "result", value: INITIALIZE_RESULT };
      case "skills/list":
        return { kind: "result", value: skillsListResult(skills) };
      case "thread/start":
        return { kind: "result", value: { thread: { id: "probe-thread-1" } } };
      default:
        return { kind: "error", code: -32601, message: "method not found" };
    }
  };
}

function probeOptions(transport: CodexTransport, overrides: Record<string, unknown> = {}) {
  return {
    skillName: SKILL_NAME,
    skillResolvedPath: SKILL_PATH,
    transportFactory: () => transport,
    now: FIXED_NOW,
    probeWorkspace: PROBE_WORKSPACE,
    ...overrides
  } as Parameters<typeof probeLiveCodexRuntime>[0];
}

/** The names of the probe-owned temp directories currently present. */
function ownedProbeWorkspaces(): Set<string> {
  return new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith("swpanel-codex-probe-"))
  );
}

describe("probeLiveCodexRuntime (live initialize + skills/list discovery, hermetic)", () => {
  it("completes the strict round trip: protocol v2 proved, exact skill path verified, child closed exactly once", async () => {
    const transport = new ScriptedTransport(happyResponder());
    const result = await probeLiveCodexRuntime(
      probeOptions(transport, { version: "0.147.0", modelImageInputSupported: true })
    );

    expect(result.available).toBe(true);
    expect(result.protocol).toBe("2");
    expect(result.version).toBe("0.147.0");
    expect(result.modelImageInputSupported).toBe(true);
    expect(result.skillDiscovered).toBe(true);
    expect(result.skillPathVerified).toBe(true);
    expect(result.codexHome).toBe(INITIALIZE_RESULT.codexHome);
    expect(result.probedAt).toBe("2026-08-14T00:00:00.000Z");
    expect(result.childClosed).toBe(true);
    expect(result.childPid).toBeUndefined(); // in-memory transport exposes no pid
    expect(transport.closeCount).toBe(1);
    expect(transport.requestMethods()).toEqual(["initialize", "skills/list", "thread/start"]);
  });

  it("proves thread/start COMPATIBILITY with the STABLE params (no gated runtimeWorkspaceRoots, approvalPolicy pinned to never, thread id never persisted)", async () => {
    const transport = new ScriptedTransport(happyResponder());
    const result = await probeLiveCodexRuntime(probeOptions(transport));

    expect(result.available).toBe(true);
    // The compatibility probe runs in the supplied probe workspace with the
    // stable thread-open params ONLY — never the gated field that native
    // Codex 0.147.0 rejects with -32600 under experimentalApi:false. The
    // approval policy is pinned to "never" exactly like the Runner threads:
    // the probe never waits on interactive approval.
    expect(transport.lastParams("thread/start")).toEqual({
      cwd: PROBE_WORKSPACE,
      sandbox: CODEX_SANDBOX_MODE,
      approvalPolicy: "never"
    });
    expect(transport.lastParams("thread/start")).not.toHaveProperty("runtimeWorkspaceRoots");
    // No turn/start, no skill invocation, no model call: the probe is bounded
    // and harmless.
    expect(transport.requestMethods()).toEqual(["initialize", "skills/list", "thread/start"]);
    // The thread id of the compatibility probe is discarded — nothing is
    // persisted in the snapshot.
    expect(result).not.toHaveProperty("threadId");
    expect(result).not.toHaveProperty("probeWorkspace");
    expect(transport.closeCount).toBe(1);
  });

  it("creates its own temporary probe workspace and removes it in finally when none is supplied", async () => {
    const before = ownedProbeWorkspaces();
    const transport = new ScriptedTransport(happyResponder());
    const result = await probeLiveCodexRuntime(
      probeOptions(transport, { probeWorkspace: undefined })
    );

    expect(result.available).toBe(true);
    expect(transport.closeCount).toBe(1);
    const params = transport.lastParams("thread/start");
    // The stable params ran against the probe's own temp workspace under the
    // OS temp dir (a safe writable root outside customer artifacts).
    expect(params).not.toHaveProperty("runtimeWorkspaceRoots");
    expect(params).toMatchObject({ sandbox: CODEX_SANDBOX_MODE, approvalPolicy: "never" });
    expect(typeof params?.cwd).toBe("string");
    expect((params?.cwd as string).startsWith(tmpdir())).toBe(true);
    // The owned workspace was removed in finally: nothing persists.
    const after = ownedProbeWorkspaces();
    for (const name of after) {
      expect(before.has(name)).toBe(true);
    }
    expect(after.size).toBe(before.size);
  });

  it("a thread/start RPC error (-32600 gated-field rejection) fails closed while the child closes and the owned temp workspace is removed", async () => {
    const before = ownedProbeWorkspaces();
    const transport = new ScriptedTransport((request) => {
      if (request.method === "initialize") return { kind: "result", value: INITIALIZE_RESULT };
      if (request.method === "skills/list") {
        return { kind: "result", value: skillsListResult([skillEntry()]) };
      }
      // The exact native rejection of a gated field under experimentalApi:false.
      return {
        kind: "error",
        code: -32600,
        message: "thread/start.runtimeWorkspaceRoots requires experimentalApi capability"
      };
    });
    // No probeWorkspace: the probe's own temp workspace must be cleaned even
    // when the compatibility probe fails.
    const result = await probeLiveCodexRuntime(
      probeOptions(transport, { probeWorkspace: undefined })
    );

    expect(result.available).toBe(false);
    expect(result.protocol).toBeNull();
    expect(result.skillDiscovered).toBe(false);
    expect(result.skillPathVerified).toBe(false);
    expect(result.childClosed).toBe(true);
    expect(transport.closeCount).toBe(1);
    // The compatibility probe ran and its failure is what failed the probe.
    expect(transport.requestMethods()).toEqual(["initialize", "skills/list", "thread/start"]);
    const after = ownedProbeWorkspaces();
    for (const name of after) {
      expect(before.has(name)).toBe(true);
    }
    expect(after.size).toBe(before.size);
  });

  it("exact path discovery: a skill listed at a DIFFERENT directory fails the path verification", async () => {
    const transport = new ScriptedTransport(
      happyResponder([skillEntry("C:\\skills\\other-copy\\SKILL.md")])
    );
    const result = await probeLiveCodexRuntime(probeOptions(transport));

    expect(result.available).toBe(true);
    expect(result.protocol).toBe("2");
    expect(result.skillDiscovered).toBe(true);
    expect(result.skillPathVerified).toBe(false);
    expect(transport.closeCount).toBe(1);
  });

  it("exact path discovery: the bare configured directory (no SKILL.md segment) fails the path verification", async () => {
    // Codex reports the manifest file; a listing that reports the directory
    // itself is a differently-shaped path and must fail closed.
    const transport = new ScriptedTransport(happyResponder([skillEntry(SKILL_PATH)]));
    const result = await probeLiveCodexRuntime(probeOptions(transport));

    expect(result.skillDiscovered).toBe(true);
    expect(result.skillPathVerified).toBe(false);
    expect(transport.closeCount).toBe(1);
  });

  it("exact path discovery: sibling and prefix-shaped paths fail the path verification", async () => {
    // A sibling directory whose name extends the configured one and a
    // different file name inside the configured directory are never the
    // configured tree.
    const sibling = new ScriptedTransport(
      happyResponder([skillEntry("C:\\skills\\solidworks-build-part-from-drawing-other\\SKILL.md")])
    );
    const siblingResult = await probeLiveCodexRuntime(probeOptions(sibling));
    expect(siblingResult.skillDiscovered).toBe(true);
    expect(siblingResult.skillPathVerified).toBe(false);

    const renamed = new ScriptedTransport(
      happyResponder([skillEntry("C:\\skills\\solidworks-build-part-from-drawing\\SKILL.md.bak")])
    );
    const renamedResult = await probeLiveCodexRuntime(probeOptions(renamed));
    expect(renamedResult.skillDiscovered).toBe(true);
    expect(renamedResult.skillPathVerified).toBe(false);

    const nested = new ScriptedTransport(
      happyResponder([skillEntry("C:\\skills\\solidworks-build-part-from-drawing\\sub\\SKILL.md")])
    );
    const nestedResult = await probeLiveCodexRuntime(probeOptions(nested));
    expect(nestedResult.skillDiscovered).toBe(true);
    expect(nestedResult.skillPathVerified).toBe(false);
  });

  it("exact path discovery: canonical Windows-safe forms of the same directory pass", async () => {
    // Forward separators are the same directory — accepted on every platform.
    const forward = new ScriptedTransport(
      happyResponder([skillEntry("C:/skills/solidworks-build-part-from-drawing/SKILL.md")])
    );
    const forwardResult = await probeLiveCodexRuntime(probeOptions(forward));
    expect(forwardResult.skillPathVerified).toBe(true);

    // Windows filesystems are case-insensitive (the probe compares with the
    // host platform semantics; the hermetic win32 case is pinned directly on
    // isSkillMdPathOfDirectory below).
    if (process.platform === "win32") {
      const cased = new ScriptedTransport(
        happyResponder([skillEntry("c:\\SKILLS\\Solidworks-Build-Part-From-Drawing\\SKILL.md")])
      );
      const casedResult = await probeLiveCodexRuntime(probeOptions(cased));
      expect(casedResult.skillPathVerified).toBe(true);
    }
  });

  it("exact path discovery: a listing without the configured skill fails discovery", async () => {
    const transport = new ScriptedTransport(
      happyResponder([
        { name: "some-other-skill", description: "d", enabled: true, path: "C:\\skills\\other", scope: "user" }
      ])
    );
    const result = await probeLiveCodexRuntime(probeOptions(transport));

    expect(result.available).toBe(true);
    expect(result.skillDiscovered).toBe(false);
    expect(result.skillPathVerified).toBe(false);
    expect(transport.closeCount).toBe(1);
  });

  it("a JSON-RPC error response fails closed (protocol null, nothing claimed)", async () => {
    const transport = new ScriptedTransport((request) => {
      if (request.method === "initialize") return { kind: "result", value: INITIALIZE_RESULT };
      return { kind: "error", code: -32603, message: "internal error" };
    });
    const result = await probeLiveCodexRuntime(probeOptions(transport));

    expect(result.available).toBe(false);
    expect(result.protocol).toBeNull();
    expect(result.skillDiscovered).toBe(false);
    expect(result.skillPathVerified).toBe(false);
    expect(result.codexHome).toBeNull();
    expect(result.childClosed).toBe(true);
    expect(transport.closeCount).toBe(1);
  });

  it("a malformed initialize response fails closed (strict protocol subset)", async () => {
    const transport = new ScriptedTransport((request) => {
      if (request.method === "initialize") {
        return { kind: "result", value: { codexHome: "only-one-field" } };
      }
      return { kind: "result", value: skillsListResult([skillEntry()]) };
    });
    const result = await probeLiveCodexRuntime(probeOptions(transport));

    expect(result.available).toBe(false);
    expect(result.protocol).toBeNull();
    expect(result.skillDiscovered).toBe(false);
    expect(result.childClosed).toBe(true);
    expect(transport.closeCount).toBe(1);
  });

  it("a child exit during the round trip fails closed", async () => {
    const transport = new ScriptedTransport((request) => {
      if (request.method === "initialize") {
        // The child dies while the handshake is in flight.
        queueMicrotask(() => transport.exit(1, null));
        return { kind: "none" };
      }
      return { kind: "result", value: skillsListResult([skillEntry()]) };
    });
    const result = await probeLiveCodexRuntime(probeOptions(transport));

    expect(result.available).toBe(false);
    expect(result.protocol).toBeNull();
    expect(result.childClosed).toBe(true);
    expect(transport.closeCount).toBe(1);
  });

  it("a never-answering server fails closed after the bounded timeout", async () => {
    const transport = new ScriptedTransport(() => ({ kind: "none" }));
    const result = await probeLiveCodexRuntime(
      probeOptions(transport, { requestTimeoutMs: 20 })
    );

    expect(result.available).toBe(false);
    expect(result.protocol).toBeNull();
    expect(result.childClosed).toBe(true);
    expect(transport.closeCount).toBe(1);
  });

  it("a throwing transport factory fails closed with no child to close", async () => {
    const result = await probeLiveCodexRuntime(
      probeOptions({} as CodexTransport, {
        transportFactory: () => {
          throw new Error("spawn exploded");
        }
      })
    );

    expect(result.available).toBe(false);
    expect(result.protocol).toBeNull();
    expect(result.childClosed).toBe(false); // no child was ever created
  });

  it("a client-construction failure still closes the raw transport (no orphaned child)", async () => {
    const transport = new ScriptedTransport(happyResponder());
    transport.setLineHandler = () => {
      throw new Error("handler wiring exploded");
    };
    const result = await probeLiveCodexRuntime(probeOptions(transport));

    expect(result.available).toBe(false);
    expect(result.childClosed).toBe(true);
    expect(transport.closeCount).toBe(1);
  });

  it("modelImageInputSupported is ONLY the explicit config passthrough (never invented)", async () => {
    const absent = await probeLiveCodexRuntime(
      probeOptions(new ScriptedTransport(happyResponder()))
    );
    expect(absent.modelImageInputSupported).toBeNull();

    const denied = await probeLiveCodexRuntime(
      probeOptions(new ScriptedTransport(happyResponder()), { modelImageInputSupported: false })
    );
    expect(denied.modelImageInputSupported).toBe(false);
    expect(denied.available).toBe(true);
  });

  it("version is the caller's metadata snapshot passthrough (absent defaults to null)", async () => {
    const provided = await probeLiveCodexRuntime(
      probeOptions(new ScriptedTransport(happyResponder()), { version: "0.148.0" })
    );
    expect(provided.version).toBe("0.148.0");

    const absent = await probeLiveCodexRuntime(
      probeOptions(new ScriptedTransport(happyResponder()))
    );
    expect(absent.version).toBeNull();
  });

  it("forceReloadSkills is passed into the skills/list params when requested", async () => {
    const reloadTransport = new ScriptedTransport(happyResponder());
    await probeLiveCodexRuntime(probeOptions(reloadTransport, { forceReloadSkills: true }));
    expect(reloadTransport.lastParams("skills/list")).toEqual({ forceReload: true });

    const cachedTransport = new ScriptedTransport(happyResponder());
    await probeLiveCodexRuntime(probeOptions(cachedTransport));
    expect(cachedTransport.lastParams("skills/list")).toEqual({});
  });

  it("rejects a misconfigured probe (empty skill name / non-absolute skill path / non-absolute probe workspace)", async () => {
    const transport = new ScriptedTransport(happyResponder());
    await expect(
      probeLiveCodexRuntime(probeOptions(transport, { skillName: "  " }))
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      probeLiveCodexRuntime(probeOptions(transport, { skillResolvedPath: "relative/skill" }))
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      probeLiveCodexRuntime(probeOptions(transport, { probeWorkspace: "relative/workspace" }))
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      probeLiveCodexRuntime(probeOptions(transport, { probeWorkspace: "" }))
    ).rejects.toThrow(InvalidArgumentError);
  });

  it("failClosedLiveCodexResult is the deterministic fail-closed snapshot", () => {
    expect(
      failClosedLiveCodexResult({ version: null, modelImageInputSupported: null, now: FIXED_NOW })
    ).toEqual({
      available: false,
      version: null,
      protocol: null,
      modelImageInputSupported: null,
      skillDiscovered: false,
      skillPathVerified: false,
      codexHome: null,
      childPid: undefined,
      childClosed: false,
      probedAt: "2026-08-14T00:00:00.000Z"
    });
  });

  it("runtimeProbeResultOf maps the live snapshot verbatim onto the RuntimeProbeResult surface", () => {
    const live = {
      available: true,
      version: "0.147.0",
      protocol: "2",
      modelImageInputSupported: true,
      skillDiscovered: true,
      skillPathVerified: true,
      codexHome: "C:\\Users\\me\\.codex",
      childPid: 42,
      childClosed: true,
      probedAt: "2026-08-14T00:00:00.000Z"
    };
    expect(runtimeProbeResultOf(live)).toEqual({
      available: true,
      version: "0.147.0",
      protocol: "2",
      modelImageInputSupported: true
    });
  });

  it("uses the documented bounded default request timeout", () => {
    expect(DEFAULT_LIVE_CODEX_PROBE_TIMEOUT_MS).toBe(15_000);
  });
});

describe("isSkillMdPathOfDirectory (canonical Windows-safe directory verification)", () => {
  const DIRECTORY = "C:\\Users\\Eric Chan\\.agents\\skills\\solidworks-build-part-from-drawing";
  const MANIFEST = `${DIRECTORY}\\SKILL.md`;

  it("requires the reported path to be the configured directory PLUS exactly one final SKILL.md segment", () => {
    expect(isSkillMdPathOfDirectory(MANIFEST, DIRECTORY, "win32")).toBe(true);
    expect(isSkillMdPathOfDirectory("/home/me/skills/skill/SKILL.md", "/home/me/skills/skill", "darwin")).toBe(true);
    // The bare directory itself is never the manifest path.
    expect(isSkillMdPathOfDirectory(DIRECTORY, DIRECTORY, "win32")).toBe(false);
    // An extra nested segment is a different shape.
    expect(isSkillMdPathOfDirectory(`${DIRECTORY}\\sub\\SKILL.md`, DIRECTORY, "win32")).toBe(false);
  });

  it("accepts canonical Windows forms: forward separators, case, trailing separators", () => {
    // Forward slashes are the same directory on Windows.
    expect(
      isSkillMdPathOfDirectory("C:/Users/Eric Chan/.agents/skills/solidworks-build-part-from-drawing/SKILL.md", DIRECTORY, "win32")
    ).toBe(true);
    // Windows filesystems are case-insensitive.
    expect(
      isSkillMdPathOfDirectory("c:\\users\\eric chan\\.agents\\skills\\SOLIDWORKS-BUILD-PART-FROM-DRAWING\\SKILL.md", DIRECTORY, "win32")
    ).toBe(true);
    // A trailing separator on the configured directory is tolerated.
    expect(isSkillMdPathOfDirectory(MANIFEST, `${DIRECTORY}\\`, "win32")).toBe(true);
  });

  it("never accepts siblings or prefix tricks (win32)", () => {
    // Sibling whose name extends the configured directory.
    expect(
      isSkillMdPathOfDirectory("C:\\Users\\Eric Chan\\.agents\\skills\\solidworks-build-part-from-drawing-other\\SKILL.md", DIRECTORY, "win32")
    ).toBe(false);
    // A file name that merely starts with SKILL.md.
    expect(
      isSkillMdPathOfDirectory("C:\\Users\\Eric Chan\\.agents\\skills\\solidworks-build-part-from-drawing\\SKILL.md.bak", DIRECTORY, "win32")
    ).toBe(false);
    // A differently-cased manifest name with an otherwise identical path.
    expect(
      isSkillMdPathOfDirectory("C:\\Users\\Eric Chan\\.agents\\skills\\solidworks-build-part-from-drawing\\skill.md", DIRECTORY, "win32")
    ).toBe(true);
    // A directory whose name is a prefix of the configured one.
    expect(
      isSkillMdPathOfDirectory("C:\\Users\\Eric Chan\\.agents\\skills\\solidworks-build-part-from-drawing\\SKILL.md", "C:\\Users\\Eric Chan\\.agents\\skills\\solidworks-build-part", "win32")
    ).toBe(false);
  });

  it("is case-sensitive and /-only on POSIX platforms", () => {
    expect(isSkillMdPathOfDirectory("/home/me/skills/skill/SKILL.md", "/home/me/skills/skill", "darwin")).toBe(true);
    // Case differences are different paths on POSIX.
    expect(isSkillMdPathOfDirectory("/home/me/skills/SKILL/SKILL.md", "/home/me/skills/skill", "darwin")).toBe(false);
    // A backslash is a legal file-name character on POSIX, not a separator.
    expect(
      isSkillMdPathOfDirectory("/home/me/skills/skill\\nested/SKILL.md", "/home/me/skills/skill", "darwin")
    ).toBe(false);
    // The sharpest form: a SIBLING FILE literally named `skill\SKILL.md`
    // inside the PARENT directory — the backslash must never act as a
    // separator, so the sibling can never pass as the configured manifest.
    expect(
      isSkillMdPathOfDirectory("/home/me/skills/skill\\SKILL.md", "/home/me/skills/skill", "darwin")
    ).toBe(false);
    expect(
      isSkillMdPathOfDirectory("/home/me/skills/skill\\SKILL.md", "/home/me/skills/skill", "linux")
    ).toBe(false);
  });

  it("the exported manifest file name is the exact SKILL.md", () => {
    expect(CODEX_SKILL_FILE_NAME).toBe("SKILL.md");
  });
});
