/**
 * Child-process Codex App Server transport (Batch C: minimal live stdio
 * transport + lifecycle only). The first real implementation of the
 * {@link CodexTransport} seam: it spawns the Codex CLI as a child process
 * with `app-server --stdio` and speaks strict NDJSON over its stdio pipes,
 * exactly the process boundary the strict JSON-RPC client
 * (`codex-app-server-client.ts`) was contract-tested against.
 *
 * Lifecycle guarantees:
 *
 * - spawn with `shell: false` (no shell interpolation of the command line),
 *   `windowsHide: true` (no console window on Windows hosts) and stdio pipes;
 *   the caller may pass further spawn options (cwd / env / ...), but these
 *   three are FORCED by the transport;
 * - Windows executable resolution is TRUTHFUL (`shell: false` can only spawn a
 *   real executable): the default `codex` commonly resolves to a `.cmd` shim
 *   on PATH, which is refused as a structured spawn failure
 *   (`CodexCommandResolutionError`, WINDOWS_CMD_SHIM) — a bare name resolves
 *   to the real executable on PATH, an explicit real executable path passes
 *   through, and the stable resolver is exported
 *   (`resolveCodexAppServerCommand`) for the live config;
 * - stdout is fed through the shared `splitJsonRpcChunk` codec (line
 *   splitting, `\r` tolerance, OVERSIZED rejection): complete lines are
 *   delivered to the registered line sink in arrival order, the incomplete
 *   tail is preserved across chunks. An OVERSIZED line is delivered RAW to
 *   the sink (the client's decoder rejects it and fails the connection
 *   closed with PROTOCOL) — never silently dropped, which would hang the
 *   connection forever;
 * - stdin writes are BOUNDED (backpressure cap, default one full-size
 *   NDJSON line): a child that stops reading its stdin must never make the
 *   host buffer writes without bound — once the buffered backlog plus the
 *   next line would exceed the cap, `writeLine` fails closed (throws; the
 *   client surfaces TRANSPORT);
 * - stderr is drained into a BOUNDED tail buffer (head of the connection
 *   never exhausts memory, the last diagnostics of a crash stay readable)
 *   and is NEVER written into a Run workspace;
 * - exit/error propagation is stable and exactly-once: a spontaneous child
 *   exit reports `{ code, signal }` to the exit sink; a spawn failure (e.g.
 *   the codex binary is missing) reports `{ code: null, signal: null }`
 *   exactly once; an exit AFTER a locally-initiated `close()` is suppressed
 *   (the close was requested by the owning client, which already knows);
 * - `close()` is idempotent and BOUNDED: SIGTERM, escalating to SIGKILL
 *   after the configured bound, then stdio teardown. A closed transport
 *   never orphans its child and never keeps the host event loop alive; the
 *   `closed` promise settles when the teardown finished.
 *
 * Hermetic-tested with scripted Node children; never HIL-verified against a
 * real Codex App Server. The product wiring (transport factory → client →
 * adapter) remains a later batch — this module ships the transport itself.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import type { CodexTransport, CodexTransportFactory } from "./codex-app-server-client.js";
import {
  JSON_RPC_DEFAULT_MAX_LINE_BYTES,
  JsonRpcCodecError,
  jsonRpcLineBytes,
  splitJsonRpcChunk
} from "./jsonrpc-codec.js";

/** The Codex CLI executable the transport spawns by default. */
export const CODEX_APP_SERVER_COMMAND = "codex" as const;
/** The default CLI arguments: the app-server stdio mode. */
export const CODEX_APP_SERVER_STDIO_ARGS = ["app-server", "--stdio"] as const;
/** Default bounded stderr retention in characters (tail-kept). */
export const DEFAULT_CODEX_STDERR_MAX_CHARS = 65_536 as const;
/**
 * Default bounded stdin backlog cap in bytes: one full-size NDJSON line (the
 * codec's default max line size plus its `\n` delimiter) always fits,
 * anything beyond a non-reading child fails closed.
 */
export const DEFAULT_CODEX_STDIN_MAX_BUFFER_BYTES = JSON_RPC_DEFAULT_MAX_LINE_BYTES + 1;
/** Default close bound: SIGTERM escalates to SIGKILL after this delay. */
export const DEFAULT_CODEX_KILL_TIMEOUT_MS = 5_000 as const;

/**
 * Structured failure of the shell:false executable resolution on Windows
 * (never thrown by the resolver — returned in the resolution result, then
 * surfaced by the transport as its truthful spawn failure).
 */
export class CodexCommandResolutionError extends Error {
  readonly code: "WINDOWS_CMD_SHIM" | "WINDOWS_INVALID_COMMAND";

  constructor(code: "WINDOWS_CMD_SHIM" | "WINDOWS_INVALID_COMMAND", message: string) {
    super(message);
    this.name = "CodexCommandResolutionError";
    this.code = code;
  }
}

/** Result of {@link resolveCodexAppServerCommand}: spawn this, or the truth why not. */
export type CodexCommandResolution =
  | { ok: true; command: string }
  | { ok: false; error: CodexCommandResolutionError };

/**
 * The spawnable-extension candidates of a bare Windows command name
 * (CreateProcess-style: a real executable, never a shell script).
 */
const WINDOWS_EXECUTABLE_EXTENSIONS = ["", ".exe", ".com"] as const;
/**
 * The Windows shell-shim extensions that CANNOT be spawned with `shell: false`
 * (npm/global-install CLIs commonly exist ONLY as `codex.cmd` / `codex.bat`).
 */
const WINDOWS_SHIM_EXTENSIONS = [".cmd", ".bat"] as const;

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Truthful `shell: false` executable resolution (stable, synchronous, exported
 * for the live config / product wiring to reuse). `spawn(..., { shell: false })`
 * can only launch a real executable: on Windows the default bare name `codex`
 * often resolves ONLY to a `.cmd` shim on PATH (npm global bin), which
 * `shell: false` cannot spawn (ENOENT/EINVAL) and which this resolver NEVER
 * hands to spawn. Resolution rules:
 *
 * - non-Windows platforms: the command is passed through unchanged;
 * - an explicit path / extension-bearing command: `.cmd` / `.bat` is refused
 *   truthfully (`WINDOWS_CMD_SHIM`); anything else passes through (an explicit
 *   `.exe` path is the supported real-executable configuration);
 * - a bare name on Windows: PATH is scanned for a real executable candidate
 *   (the name, `name.exe`, `name.com`); the FIRST hit resolves to its ABSOLUTE
 *   path (stable regardless of the caller's cwd). If ONLY a `.cmd` / `.bat`
 *   shim exists, the resolution refuses truthfully (`WINDOWS_CMD_SHIM`) — a
 *   shim is never parsed or executed, and a missing real executable is a
 *   configuration error the caller can surface at startup instead of a
 *   misleading runtime ENOENT;
 * - nothing found at all: the command passes through unchanged and the spawn
 *   reports the genuinely missing binary as today (a truthful spawn failure).
 */
export function resolveCodexAppServerCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): CodexCommandResolution {
  if (platform !== "win32") return { ok: true, command };
  if (command.length === 0) {
    return {
      ok: false,
      error: new CodexCommandResolutionError(
        "WINDOWS_INVALID_COMMAND",
        "the Codex command must not be empty"
      )
    };
  }
  const lower = command.toLowerCase();
  const looksExplicit =
    command.includes("/") || command.includes("\\") || lower.includes(".exe") ||
    lower.includes(".cmd") || lower.includes(".bat") || lower.includes(".com");
  if (looksExplicit) {
    const extension = lower.slice(lower.lastIndexOf("."));
    if (extension === ".cmd" || extension === ".bat") {
      return {
        ok: false,
        error: new CodexCommandResolutionError(
          "WINDOWS_CMD_SHIM",
          `"${command}" is a Windows .cmd/.bat file which cannot be spawned with shell:false; configure the real codex executable (e.g. the absolute path of the codex .exe) explicitly`
        )
      };
    }
    return { ok: true, command };
  }
  // Bare name: resolve a REAL executable on PATH to an absolute path. Real
  // executable candidates win over shims (CreateProcess-like preference).
  const pathEntries = (env.PATH ?? "").split(";").filter((entry) => entry.length > 0);
  for (const entry of pathEntries) {
    for (const extension of WINDOWS_EXECUTABLE_EXTENSIONS) {
      const candidate = resolvePath(entry, command + extension);
      if (isFile(candidate)) return { ok: true, command: candidate };
    }
  }
  for (const entry of pathEntries) {
    for (const extension of WINDOWS_SHIM_EXTENSIONS) {
      const shim = resolvePath(entry, command + extension);
      if (isFile(shim)) {
        return {
          ok: false,
          error: new CodexCommandResolutionError(
            "WINDOWS_CMD_SHIM",
            `"${command}" resolves only to the Windows command shim "${shim}"; a .cmd/.bat shim cannot be spawned with shell:false — configure the real codex executable (e.g. the absolute path of the codex .exe) explicitly`
          )
        };
      }
    }
  }
  // Truly nothing found: pass through; the spawn reports the missing binary.
  return { ok: true, command };
}

export interface CodexChildTransportOptions {
  /**
   * Executable to spawn (default `codex`). On Windows the value is resolved
   * through {@link resolveCodexAppServerCommand} before the spawn: a `.cmd` /
   * `.bat` shim (the common shape of a global `codex` install) is refused
   * truthfully, a bare name resolves to the real executable on PATH, and an
   * explicit real executable path (e.g. the absolute `codex.exe` path) is
   * passed through — the transport NEVER uses `shell: true`.
   */
  command?: string;
  /** CLI arguments (default `["app-server", "--stdio"]`). */
  args?: readonly string[];
  /**
   * Further spawn options. `shell`, `windowsHide` and `stdio` are ALWAYS
   * forced by the transport (`false`, `true`, pipes) and cannot be overridden.
   */
  spawn?: Omit<SpawnOptions, "shell" | "windowsHide" | "stdio">;
  /** Maximum NDJSON line size in UTF-8 bytes (default the codec default, 8 MiB). */
  maxLineBytes?: number;
  /** Bounded stderr retention in characters, tail-kept (default 64 KiB). */
  maxStderrChars?: number;
  /**
   * Bounded backlog cap of the child stdin buffer in bytes (default 8 MiB +
   * delimiter — one full-size NDJSON line always fits). A child that stops
   * reading its stdin must never make the transport buffer writes without
   * bound: once the buffered backlog plus the next line would exceed the
   * cap, `writeLine` fails closed (throws; the client surfaces TRANSPORT).
   */
  maxWriteBufferBytes?: number;
  /**
   * Bound of one close: the child is asked to stop (SIGTERM) and is killed
   * (SIGKILL) when it did not exit within this delay (default 5 seconds).
   */
  killTimeoutMs?: number;
}

/**
 * The child-process implementation of the {@link CodexTransport} seam. The
 * child is spawned eagerly in the constructor and killed by `close()` — the
 * transport NEVER orphans its process.
 */
export class CodexChildTransport implements CodexTransport {
  private readonly child: ChildProcess | null;
  private readonly maxLineBytes: number;
  private readonly maxStderrChars: number;
  private readonly maxWriteBufferBytes: number;
  private readonly killTimeoutMs: number;

  private lineHandler: ((line: string) => void) | null = null;
  private exitHandler:
    | ((exit: { code: number | null; signal: string | null }) => void)
    | null = null;

  /** Incomplete trailing stdout line (no `\n` yet), preserved across chunks. */
  private remainder = "";
  /** Bounded tail of the drained stderr, never written to a Run workspace. */
  private stderrTailText = "";
  private lastExit: { code: number | null; signal: string | null } | null = null;
  private spawnFailure: Error | null = null;
  private exitEmitted = false;
  private closeStarted = false;
  private closedPromise: Promise<void> | null = null;

  constructor(options: CodexChildTransportOptions = {}) {
    this.maxLineBytes = options.maxLineBytes ?? JSON_RPC_DEFAULT_MAX_LINE_BYTES;
    this.maxStderrChars = options.maxStderrChars ?? DEFAULT_CODEX_STDERR_MAX_CHARS;
    this.maxWriteBufferBytes =
      options.maxWriteBufferBytes ?? DEFAULT_CODEX_STDIN_MAX_BUFFER_BYTES;
    this.killTimeoutMs = options.killTimeoutMs ?? DEFAULT_CODEX_KILL_TIMEOUT_MS;

    // Truthful shell:false executable resolution (Windows): the default
    // `codex` may be a .cmd shim that cannot be spawned directly; a shim is
    // refused with a structured spawn failure instead of a misleading ENOENT
    // or an EINVAL from spawn().
    const resolution = resolveCodexAppServerCommand(
      options.command ?? CODEX_APP_SERVER_COMMAND,
      process.platform,
      process.env
    );
    if (!resolution.ok) {
      this.spawnFailure = resolution.error;
      this.child = null;
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(resolution.command, [
        ...(options.args ?? CODEX_APP_SERVER_STDIO_ARGS)
      ], {
        ...options.spawn,
        // The process boundary is a bare stdio child: never a shell, never a
        // visible console window on Windows hosts, always pipes.
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      // spawn() throws synchronously for invalid arguments: fail-closed with
      // the same stable spawn-failure propagation as a missing binary.
      this.spawnFailure = error instanceof Error ? error : new Error(String(error));
      this.child = null;
      return;
    }
    this.child = child;
    // A stream error (EPIPE after the child died, destroyed stream during
    // close) must never crash the host — the transport owns the pipes.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    // String data events (setEncoding) keep multi-byte UTF-8 sequences
    // correctly assembled across chunk boundaries.
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.onStderr(chunk));
    child.on("error", (error) => this.onChildError(error));
    child.on("exit", (code, signal) => this.onChildExit(code, signal));
  }

  // -------------------------------------------------------------------------
  // CodexTransport surface
  // -------------------------------------------------------------------------

  writeLine(line: string): void {
    if (this.closeStarted) {
      throw new Error("the Codex App Server transport is closed");
    }
    if (this.spawnFailure !== null) {
      throw new Error(`the Codex App Server process failed to spawn: ${this.spawnFailure.message}`);
    }
    const stdin = this.child?.stdin ?? null;
    if (stdin === null || stdin.destroyed) {
      throw new Error("the Codex App Server stdin is not writable");
    }
    // Bounded stdin buffering (backpressure cap): a child that stops reading
    // its stdin must never make the host buffer writes without bound. The
    // check runs BEFORE the write and includes the bytes this write is about
    // to add (+ the \n delimiter), so the buffered backlog stays bounded and
    // a saturated pipe fails closed (throw, surfaced as TRANSPORT by the
    // client) instead of growing memory. One full-size line always fits.
    const bytes = jsonRpcLineBytes(line) + 1;
    if (stdin.writableLength + bytes > this.maxWriteBufferBytes) {
      throw new Error(
        `the Codex App Server stdin buffer is saturated (max ${this.maxWriteBufferBytes} bytes buffered)`
      );
    }
    // The codec lines carry NO delimiter; the transport delimits them.
    stdin.write(line + "\n", "utf8");
  }

  setLineHandler(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  setExitHandler(handler: (exit: { code: number | null; signal: string | null }) => void): void {
    this.exitHandler = handler;
  }

  /**
   * Idempotent bounded close: asks the child to stop (SIGTERM), escalates to
   * SIGKILL after the configured bound, tears the stdio pipes down and
   * settles the `closed` promise. A second call is a no-op and returns the
   * SAME `closed` promise. An exit caused by THIS close is not re-reported
   * to the exit sink (the closing owner already knows).
   */
  close(): void {
    if (this.closeStarted) return;
    this.closeStarted = true;
    let resolveClosed: () => void = () => {};
    this.closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const child = this.child;
    if (
      child === null ||
      this.spawnFailure !== null ||
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      // Nothing was (successfully) spawned, or the child already exited on
      // its own: only teardown remains.
      this.destroyStreams();
      resolveClosed();
      return;
    }
    // The kill is ours: `closeStarted` (already true here) suppresses the
    // resulting exit in `onChildExit` — the closing owner already knows.
    // Bounded escalation: a child that ignores SIGTERM cannot outlive the
    // bound — the transport never leaves an orphan process behind.
    const escalate = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, this.killTimeoutMs);
    const settle = () => {
      clearTimeout(escalate);
      this.destroyStreams();
      resolveClosed();
    };
    child.once("exit", settle);
    child.once("error", settle); // defensive: a kill race also settles the close
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone; the exit event settles the close
    }
    try {
      child.stdin?.end();
    } catch {
      // already destroyed
    }
  }

  // -------------------------------------------------------------------------
  // Read-only diagnostics (never user content; stderr is bounded)
  // -------------------------------------------------------------------------

  /** The OS pid of the spawned child, or undefined before/without a spawn. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** True once `close()` was called (terminal state; close is idempotent). */
  get isClosed(): boolean {
    return this.closeStarted;
  }

  /** The last observed child exit, or null (also recorded for a close-kill). */
  get childExit(): { code: number | null; signal: string | null } | null {
    return this.lastExit;
  }

  /** The spawn failure (missing binary, invalid args), or null. */
  get spawnError(): Error | null {
    return this.spawnFailure;
  }

  /** The BOUNDED tail of the drained stderr (never a Run workspace write). */
  get stderrTail(): string {
    return this.stderrTailText;
  }

  /**
   * Settles when the close teardown finished (child dead, pipes destroyed).
   * Resolves immediately when `close()` was never called.
   */
  get closed(): Promise<void> {
    return this.closedPromise ?? Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // Child wiring
  // -------------------------------------------------------------------------

  private onStdout(chunk: string): void {
    if (this.closeStarted) return;
    const handler = this.lineHandler;
    const combined = this.remainder + chunk;
    let lines: readonly string[];
    let tail: string;
    try {
      const split = splitJsonRpcChunk(combined, this.maxLineBytes);
      lines = split.lines;
      tail = split.remainder;
    } catch (error) {
      if (!(error instanceof JsonRpcCodecError) || error.code !== "OVERSIZED") throw error;
      // An OVERSIZED line is a protocol violation the CLIENT fails closed on
      // (its decoder rejects the raw line with OVERSIZED). Deliver the
      // offending line raw — a silently dropped line would hang the
      // connection forever. The client fails the connection and closes this
      // transport; the bytes after the oversized line are irrelevant then.
      const oversized = firstOversizedLine(combined, this.maxLineBytes);
      this.remainder = "";
      if (oversized !== null) handler?.(oversized);
      return;
    }
    this.remainder = tail;
    // The client registers its line sink synchronously at construction, so no
    // data event can arrive before the handler exists in the supported flow.
    if (handler === null) return;
    for (const line of lines) handler(line);
  }

  private onStderr(chunk: string): void {
    if (this.closeStarted) return;
    const next = this.stderrTailText + chunk;
    this.stderrTailText =
      next.length > this.maxStderrChars ? next.slice(next.length - this.maxStderrChars) : next;
  }

  private onChildError(error: Error): void {
    if (this.child !== null && this.child.pid !== undefined) {
      // A post-spawn error (e.g. a failed-kill race) is not a spawn failure:
      // the process itself reports its own exit.
      return;
    }
    // The child never spawned (e.g. ENOENT for a missing codex binary):
    // record the failure and propagate a stable exit exactly once so the
    // client fails the connection closed (CHILD_EXIT -> runtime unavailable).
    if (this.spawnFailure === null) this.spawnFailure = error;
    if (this.exitEmitted || this.closeStarted) return;
    this.exitEmitted = true;
    this.exitHandler?.({ code: null, signal: null });
  }

  private onChildExit(code: number | null, signal: string | null): void {
    this.lastExit = { code, signal };
    // Node documents that 'exit' may or may not fire after an 'error': the
    // exactly-once guard makes the propagation stable either way. An exit
    // caused by our own close() is suppressed (the closing owner knows).
    if (this.exitEmitted || this.closeStarted) return;
    this.exitEmitted = true;
    this.exitHandler?.({ code, signal });
  }

  private destroyStreams(): void {
    const child = this.child;
    if (child === null) return;
    try {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    } catch {
      // teardown is best-effort
    }
  }
}

/**
 * Returns the first COMPLETE line of the buffer whose UTF-8 byte length
 * exceeds the limit, or null. Only reached when `splitJsonRpcChunk` already
 * rejected the buffer as OVERSIZED, so the offending line is guaranteed
 * complete (the splitter only measures complete lines).
 */
function firstOversizedLine(buffer: string, maxLineBytes: number): string | null {
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer.charCodeAt(index) !== 10 /* \n */) continue;
    let line = buffer.slice(start, index);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (jsonRpcLineBytes(line) > maxLineBytes) return line;
    start = index + 1;
  }
  return null;
}

/**
 * The live-spawn factory seam (Batch C): produces a fresh
 * {@link CodexChildTransport} per call — one child per client/connection.
 */
export function codexChildTransportFactory(
  options: CodexChildTransportOptions
): CodexTransportFactory {
  return () => new CodexChildTransport(options);
}
