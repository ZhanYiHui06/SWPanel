import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CodexChildTransport,
  CodexCommandResolutionError,
  resolveCodexAppServerCommand,
  type CodexChildTransportOptions
} from "./codex-child-transport.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import { decodeJsonRpcLine, jsonRpcLineBytes } from "./jsonrpc-codec.js";

/**
 * Hermetic tests of the child-process Codex transport (Batch C): every test
 * spawns a SCRIPTED Node child (`process.execPath -e ...`) as the fake Codex
 * App Server — no external binary, no network, no Run workspace. The child is
 * driven through the transport's own stdin and writes scripted NDJSON (and
 * stderr) back, so chunk boundaries, exits and kills are all under the test's
 * control.
 */

/** Spawn options of a scripted Node child acting as the fake server. */
function nodeChild(script: string): Pick<CodexChildTransportOptions, "command" | "args"> {
  return { command: process.execPath, args: ["-e", script] };
}

/** Polls until the predicate holds (bounded; the child tests are time-bound). */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Await with an explicit bound; the loser's timer is cleared (no stray reject). */
function withTimeout(promise: Promise<void>, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/** Whether an OS pid is still alive (signal 0 probe). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The child echoes arbitrary fragmented NDJSON after a `burst`/`slow-line` command. */
const CHUNK_ECHO_CHILD = `
process.stdin.setEncoding("utf8");
let pending = "";
process.stdin.on("data", (c) => {
  pending += c;
  for (;;) {
    const idx = pending.indexOf("\\n");
    if (idx === -1) break;
    const line = pending.slice(0, idx);
    pending = pending.slice(idx + 1);
    if (line === "burst") {
      const payload = [
        JSON.stringify({ method: "n/one", params: { n: 1 } }),
        JSON.stringify({ method: "n/two", params: { n: 2 } }),
        JSON.stringify({ method: "n/three", params: { n: 3 } })
      ].join("\\n") + "\\n";
      for (let i = 0; i < payload.length; i += 3) process.stdout.write(payload.slice(i, i + 3));
    } else if (line === "slow-line") {
      const payload = JSON.stringify({ method: "n/slow", params: { n: 4 } }) + "\\n";
      for (let i = 0; i < payload.length; i += 2) process.stdout.write(payload.slice(i, i + 2));
    }
  }
});
`;

/** The child writes one notification and exits with code 3 after `go`. */
const EXIT_CHILD = `
process.stdin.setEncoding("utf8");
let pending = "";
process.stdin.on("data", (c) => {
  pending += c;
  for (;;) {
    const idx = pending.indexOf("\\n");
    if (idx === -1) break;
    const line = pending.slice(0, idx);
    pending = pending.slice(idx + 1);
    if (line === "go") {
      process.stdout.write(JSON.stringify({ method: "n/bye" }) + "\\n");
      // Drop stdin so the event loop drains (a flowing stdin keeps it alive),
      // then exit with code 3 after stdout flushed.
      process.stdin.pause();
      process.stdin.destroy();
      process.exitCode = 3;
    }
  }
});
`;

/** The child answers EVERY received line with an oversized NDJSON line. */
const OVERSIZED_CHILD = `
process.stdin.setEncoding("utf8");
let pending = "";
process.stdin.on("data", (c) => {
  pending += c;
  for (;;) {
    const idx = pending.indexOf("\\n");
    if (idx === -1) break;
    pending = pending.slice(idx + 1);
    process.stdout.write(JSON.stringify({ id: 1, result: { pad: "x".repeat(4096) } }) + "\\n");
  }
});
`;

/** The child stays alive forever (until the transport closes it). */
const STAY_ALIVE_CHILD = `
process.stdin.resume();
setInterval(() => {}, 1000);
`;

/** The child floods stderr (bounded drain test), then stays alive. */
const STDERR_FLOOD_CHILD = `
process.stdin.resume();
const chunk = "E".repeat(500);
for (let i = 0; i < 200; i++) process.stderr.write(chunk);
setInterval(() => {}, 1000);
`;

/** The child answers the app-server handshake and the two notifications. */
const HANDSHAKE_CHILD = `
process.stdin.setEncoding("utf8");
let pending = "";
process.stdin.on("data", (c) => {
  pending += c;
  for (;;) {
    const idx = pending.indexOf("\\n");
    if (idx === -1) break;
    const line = pending.slice(0, idx);
    pending = pending.slice(idx + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { codexHome: "C:/codex", platformFamily: "windows", platformOs: "windows", userAgent: "codex-app-server/0.147.0" } }) + "\\n");
    } else if (msg.method === "initialized") {
      process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "t1", turnId: "tn1", itemId: "i1", delta: "{}" } }) + "\\n");
      process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "t1", turn: { id: "tn1", status: "completed" } } }) + "\\n");
    }
  }
});
`;

describe("CodexChildTransport", () => {
  it("splits fragmented stdout through splitJsonRpcChunk and delivers complete lines in order", async () => {
    const transport = new CodexChildTransport(nodeChild(CHUNK_ECHO_CHILD));
    const received: string[] = [];
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    transport.setLineHandler((line) => received.push(line));
    transport.setExitHandler((exit) => exits.push(exit));
    const pid = transport.pid;
    expect(pid).toBeDefined();
    try {
      // The child fragments the burst into 3-byte writes: every line is split
      // across chunk boundaries, the transport's remainder reassembles it.
      transport.writeLine("burst");
      await waitFor(() => received.length >= 3, "the three burst lines");
      expect(received.slice(0, 3).map((line) => decodeJsonRpcLine(line))).toEqual([
        { kind: "notification", message: { method: "n/one", params: { n: 1 } } },
        { kind: "notification", message: { method: "n/two", params: { n: 2 } } },
        { kind: "notification", message: { method: "n/three", params: { n: 3 } } }
      ]);
      // A single line split across many small chunks also reassembles.
      transport.writeLine("slow-line");
      await waitFor(() => received.length >= 4, "the slow line");
      expect(decodeJsonRpcLine(received[3] ?? "")).toEqual({
        kind: "notification",
        message: { method: "n/slow", params: { n: 4 } }
      });
    } finally {
      transport.close();
      await withTimeout(transport.closed, 5_000, "the chunk-echo child teardown");
    }
    // The close-kill was never re-reported to the exit sink, and the child is
    // dead — the transport never orphans its process.
    expect(exits.length).toBe(0);
    expect(isAlive(pid as number)).toBe(false);
  });

  it("propagates a spontaneous child exit exactly once and stays idempotent on close", async () => {
    const transport = new CodexChildTransport(nodeChild(EXIT_CHILD));
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    transport.setLineHandler(() => {});
    transport.setExitHandler((exit) => exits.push(exit));
    try {
      transport.writeLine("go");
      await waitFor(() => exits.length === 1, "the child exit");
      expect(exits[0]).toEqual({ code: 3, signal: null });
      expect(transport.childExit).toEqual({ code: 3, signal: null });
      expect(transport.stderrTail).toBe("");
      // The child already exited: close is pure teardown and reports nothing.
      transport.close();
      await withTimeout(transport.closed, 5_000, "the exited child teardown");
    } finally {
      transport.close();
      await withTimeout(transport.closed, 5_000, "the exited child teardown (repeat)");
    }
    expect(exits.length).toBe(1);
  });

  it("delivers an oversized stdout line raw so the client fails closed with PROTOCOL", async () => {
    const transport = new CodexChildTransport({
      ...nodeChild(OVERSIZED_CHILD),
      maxLineBytes: 1_024
    });
    const received: string[] = [];
    transport.setLineHandler((line) => received.push(line));
    try {
      transport.writeLine("anything");
      await waitFor(() => received.length === 1, "the oversized line");
      expect(jsonRpcLineBytes(received[0] ?? "")).toBeGreaterThan(1_024);
      expect(received[0]).toContain("x".repeat(4_096));
    } finally {
      transport.close();
      await withTimeout(transport.closed, 5_000, "the oversized child teardown");
    }
  });

  it("fails a client connection closed (PROTOCOL) when the child answers oversized", async () => {
    const transport = new CodexChildTransport({
      ...nodeChild(OVERSIZED_CHILD),
      maxLineBytes: 1_024
    });
    const client = new CodexAppServerClient({
      transport,
      requestTimeoutMs: 2_000,
      maxLineBytes: 1_024
    });
    try {
      await expect(client.initialize()).rejects.toMatchObject({ code: "PROTOCOL" });
      // The client failed the connection closed and closed the transport.
      expect(transport.isClosed).toBe(true);
      await expect(client.initialize()).rejects.toMatchObject({ code: "PROTOCOL" });
    } finally {
      client.close();
      await withTimeout(transport.closed, 5_000, "the oversized client teardown");
    }
  });

  it("close is idempotent, bounded and never orphans the child", async () => {
    const transport = new CodexChildTransport({
      ...nodeChild(STAY_ALIVE_CHILD),
      killTimeoutMs: 2_000
    });
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    transport.setExitHandler((exit) => exits.push(exit));
    const pid = transport.pid;
    expect(pid).toBeDefined();
    // The child is up before the close semantics are exercised.
    await waitFor(() => isAlive(pid as number), "the stay-alive child to spawn");
    try {
      transport.close();
      const first = transport.closed;
      expect(transport.isClosed).toBe(true);
      // Idempotent: a second close is a no-op returning the SAME promise.
      expect(transport.closed).toBe(first);
      transport.close();
      await withTimeout(transport.closed, 5_000, "the bounded close");
      // No orphan: the child is dead, the close-kill was not re-reported.
      expect(isAlive(pid as number)).toBe(false);
      expect(exits.length).toBe(0);
      expect(transport.childExit).not.toBeNull();
    } finally {
      transport.close();
      await withTimeout(transport.closed, 5_000, "the stay-alive child teardown");
    }
  });

  it("propagates a spawn failure (missing binary) exactly once as an unavailable runtime", async () => {
    const transport = new CodexChildTransport({
      command: "swpanel-definitely-missing-codex-binary-xyz"
    });
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    transport.setExitHandler((exit) => exits.push(exit));
    try {
      await waitFor(() => exits.length === 1, "the spawn-failure exit");
      expect(exits[0]).toEqual({ code: null, signal: null });
      expect(transport.spawnError).not.toBeNull();
      expect(transport.pid).toBeUndefined();
    } finally {
      transport.close();
      await withTimeout(transport.closed, 5_000, "the spawn-failure teardown");
    }
    expect(exits.length).toBe(1);
  });

  it("drains stderr into a bounded tail, never unbounded and never a workspace write", async () => {
    const transport = new CodexChildTransport({
      ...nodeChild(STDERR_FLOOD_CHILD),
      maxStderrChars: 1_000
    });
    const pid = transport.pid;
    try {
      await waitFor(
        () => transport.stderrTail.length === 1_000,
        "the bounded stderr tail (200 x 500 chars, cap 1000)"
      );
      expect(transport.stderrTail).toBe("E".repeat(1_000));
    } finally {
      transport.close();
      await withTimeout(transport.closed, 5_000, "the stderr child teardown");
    }
    expect(isAlive(pid as number)).toBe(false);
  });

  it("fails closed on a saturated stdin buffer instead of buffering without bound", async () => {
    // The child NEVER reads its stdin (it only keeps the event loop alive):
    // every write first fills the OS pipe, then the transport's own bounded
    // backlog — beyond the cap writeLine must throw, never grow memory.
    const transport = new CodexChildTransport({
      ...nodeChild("setInterval(() => {}, 1000);"),
      maxWriteBufferBytes: 1_024
    });
    try {
      transport.writeLine("a".repeat(100));
      let failure: Error | null = null;
      for (let index = 0; index < 10_000 && failure === null; index++) {
        try {
          transport.writeLine("b".repeat(100));
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
      }
      expect(failure).not.toBeNull();
      expect((failure as Error).message).toContain("stdin buffer is saturated");
      // The cap is BOUNDED: the transport still works after the pipe drains
      // (the child was never harmed) and close stays clean.
      expect(transport.isClosed).toBe(false);
    } finally {
      transport.close();
      await withTimeout(transport.closed, 5_000, "the saturated child teardown");
    }
  });

  it("serves a full client handshake + notifications + turn wait over the real child pipes", async () => {
    const transport = new CodexChildTransport(nodeChild(HANDSHAKE_CHILD));
    const client = new CodexAppServerClient({
      transport,
      requestTimeoutMs: 2_000,
      turnWaitTimeoutMs: 2_000
    });
    const pid = transport.pid;
    const notificationMethods: string[] = [];
    client.onNotification((notification) => notificationMethods.push(notification.method));
    try {
      const handshake = await client.initialize();
      expect(handshake).toEqual({
        codexHome: "C:/codex",
        platformFamily: "windows",
        platformOs: "windows",
        userAgent: "codex-app-server/0.147.0"
      });
      await waitFor(
        () => notificationMethods.length === 2,
        "the delta + turn/completed notifications"
      );
      expect(notificationMethods).toEqual(["item/agentMessage/delta", "turn/completed"]);
      const completed = await client.waitForTurnCompleted({ threadId: "t1", turnId: "tn1" });
      expect(completed.turn.status).toBe("completed");
    } finally {
      client.close();
      await withTimeout(transport.closed, 5_000, "the handshake child teardown");
    }
    // Closing the client closed the transport: the child is dead, no orphan.
    expect(isAlive(pid as number)).toBe(false);
  });
});

describe("resolveCodexAppServerCommand (Windows shell:false executable resolution)", () => {
  function tempDir(prefix: string): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), `swpanel-codex-resolve-${prefix}-`));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("passes the command through unchanged on non-Windows platforms", () => {
    expect(resolveCodexAppServerCommand("codex", "linux", { PATH: "/usr/bin" })).toEqual({
      ok: true,
      command: "codex"
    });
    expect(resolveCodexAppServerCommand("codex", "darwin", {})).toEqual({
      ok: true,
      command: "codex"
    });
  });

  it("resolves a bare name to the real executable (absolute path) on the Windows PATH, preferring .exe over a .cmd shim", () => {
    const { dir, cleanup } = tempDir("exe");
    try {
      writeFileSync(join(dir, "codex.cmd"), "@echo off\r\n");
      writeFileSync(join(dir, "codex.exe"), "fake executable bytes");
      const result = resolveCodexAppServerCommand("codex", "win32", {
        PATH: `${dir};C:\\Windows\\System32`
      });
      expect(result).toEqual({ ok: true, command: join(dir, "codex.exe") });
    } finally {
      cleanup();
    }
  });

  it("resolves a bare name to a .com candidate when no .exe exists", () => {
    const { dir, cleanup } = tempDir("com");
    try {
      writeFileSync(join(dir, "codex.com"), "fake executable bytes");
      const result = resolveCodexAppServerCommand("codex", "win32", { PATH: dir });
      expect(result).toEqual({ ok: true, command: join(dir, "codex.com") });
    } finally {
      cleanup();
    }
  });

  it("refuses truthfully when the bare name resolves ONLY to a Windows .cmd shim (cannot spawn with shell:false)", () => {
    const { dir, cleanup } = tempDir("shim");
    try {
      writeFileSync(join(dir, "codex.cmd"), "@echo off\r\n");
      const result = resolveCodexAppServerCommand("codex", "win32", { PATH: dir });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(CodexCommandResolutionError);
        expect(result.error.code).toBe("WINDOWS_CMD_SHIM");
        expect(result.error.message).toContain(".cmd");
        expect(result.error.message).toContain("shell:false");
      }
    } finally {
      cleanup();
    }
  });

  it("refuses an explicit .cmd / .bat path (never handed to spawn)", () => {
    const cmd = resolveCodexAppServerCommand("C:\\tools\\codex.cmd", "win32", {});
    expect(cmd.ok).toBe(false);
    if (!cmd.ok) expect(cmd.error.code).toBe("WINDOWS_CMD_SHIM");
    const bat = resolveCodexAppServerCommand("C:\\tools\\codex.bat", "win32", {});
    expect(bat.ok).toBe(false);
    if (!bat.ok) expect(bat.error.code).toBe("WINDOWS_CMD_SHIM");
  });

  it("passes an explicit real executable path through unchanged", () => {
    expect(
      resolveCodexAppServerCommand("C:\\tools\\codex.exe", "win32", { PATH: "C:\\nope" })
    ).toEqual({ ok: true, command: "C:\\tools\\codex.exe" });
    expect(
      resolveCodexAppServerCommand("C:\\tools\\codex", "win32", { PATH: "C:\\nope" })
    ).toEqual({ ok: true, command: "C:\\tools\\codex" });
  });

  it("passes a truly unresolvable bare name through so the spawn reports the missing binary", () => {
    expect(resolveCodexAppServerCommand("codex", "win32", { PATH: "C:\\nope" })).toEqual({
      ok: true,
      command: "codex"
    });
  });

  it("refuses an empty command", () => {
    const result = resolveCodexAppServerCommand("", "win32", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("WINDOWS_INVALID_COMMAND");
  });
});

describe("CodexChildTransport Windows .cmd shim handling", () => {
  it.skipIf(process.platform !== "win32")(
    "fails closed truthfully when the command is a .cmd shim (never spawns, never uses a shell)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "swpanel-codex-cmd-shim-"));
      const cmdPath = join(dir, "codex.cmd");
      writeFileSync(cmdPath, "@echo off\r\n");
      try {
        const transport = new CodexChildTransport({ command: cmdPath });
        const exits: Array<{ code: number | null; signal: string | null }> = [];
        transport.setExitHandler((exit) => exits.push(exit));
        expect(transport.spawnError).not.toBeNull();
        expect(transport.spawnError?.message).toContain(".cmd");
        expect(transport.pid).toBeUndefined();
        // The resolution failure surfaces truthfully on the first write.
        expect(() => transport.writeLine("{}")).toThrow(/\.cmd/);
        transport.close();
        await withTimeout(transport.closed, 5_000, "the shim-resolution teardown");
        expect(exits).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
