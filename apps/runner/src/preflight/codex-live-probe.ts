/**
 * The LIVE Codex App Server runtime probe seam (review-finding-9 real
 * discovery wiring, Batch D). This is the async counterpart of the
 * synchronous {@link codexVersionProbe}: the `--version` metadata probe can
 * never verify the app-server PROTOCOL or the SKILL path, so the real probe
 * performs the actual bounded app-server round trip through the strict
 * {@link CodexAppServerClient} (codex-cli 0.147.0 / protocol v2):
 *
 *   initialize (strict 0.147.0 InitializeResponse) -> skills/list (strict
 *   0.147.0 SkillsListResponse) -> exact configured skill path verification
 *   -> bounded `thread/start` COMPATIBILITY probe (stable params: `cwd` +
 *   `sandbox: "workspace-write"` + `approvalPolicy: "never"`, NO gated
 *   `runtimeWorkspaceRoots` field, no local image, no skill invocation, no
 *   turn/model call — success required, the thread id is discarded and never
 *   persisted)
 *
 * and returns the authoritative snapshot `RealPreflightProbe` consumes.
 * Nothing is faked:
 *
 * - `protocol` is reported ONLY when the full strict round trip completed —
 *   the handshake + strict listing validation + the thread/start compatibility
 *   probe under the pinned used subset IS the protocol-v2 proof
 *   (`CODEX_PROTOCOL_VERSION`); an aborted, malformed or incompatible round
 *   trip reports `protocol: null` and the gate fails the structured-protocol
 *   capability closed;
 * - `skillDiscovered` / `skillPathVerified` come from the live `skills/list`
 *   metadata: the exact configured skill name must appear AND the listing's
 *   reported `path` must be the skill manifest file INSIDE the exact
 *   configured skill directory — Codex truthfully reports
 *   `<configuredDirectory>\SKILL.md`, never the directory itself, so the
 *   verification requires exactly that shape through the canonical
 *   Windows-safe comparison of {@link isSkillMdPathOfDirectory} (a
 *   differently-shaped path — a sibling directory, a `.codex` copy, a nested
 *   manifest, a different file name — fails closed). The protocol never
 *   returns a hash, so the directory digest stays SWPanel's own computation
 *   (see `hashSkillDirectory`);
 * - `modelImageInputSupported` is ONLY the explicit live configuration
 *   passthrough — absent means `null` (the probe never invents image
 *   support; the gate fails closed unless another seam proves it);
 * - `version` is a passthrough of the caller's bounded `--version` metadata
 *   probe result (the initialize response carries no CLI version field).
 *
 * Lifecycle: the probe is the SINGLE owner of its Codex child. ONE transport
 * (one child process) is created per probe call through the injectable
 * factory (default {@link codexChildTransportFactory} over the configured
 * executable), and the client + transport are ALWAYS closed before the
 * result resolves — on success, on any protocol/RPC/child-exit failure and
 * even when the client construction itself failed. The probe workspace of
 * the `thread/start` compatibility probe is the caller-supplied
 * `probeWorkspace` (absolute, writable, outside customer artifacts), or —
 * when absent — a temporary directory the probe creates under the OS temp
 * dir and removes in `finally`: no thread id, workspace path or secret is
 * ever persisted. A probe call never throws for a runtime failure (fail
 * closed, exactly like the synchronous probe seam); only a misconfigured
 * probe (empty skill name / non-absolute skill path / non-absolute probe
 * workspace) throws {@link InvalidArgumentError} at call time.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

import {
  CodexAppServerClient,
  type CodexTransport,
  type CodexTransportFactory
} from "../agent/codex/codex-app-server-client.js";
import {
  buildSkillsListParams,
  buildThreadStartParams,
  CODEX_PROTOCOL_VERSION
} from "../agent/codex/builders.js";
import {
  CODEX_APP_SERVER_COMMAND,
  codexChildTransportFactory
} from "../agent/codex/codex-child-transport.js";
import { InvalidArgumentError } from "../errors.js";
import type { RuntimeProbeResult } from "./real-preflight-probe.js";

/** Default per-request bound of the live probe round trip (15 seconds). */
export const DEFAULT_LIVE_CODEX_PROBE_TIMEOUT_MS = 15_000 as const;

/** Diagnostics-only view of a transport that exposes its spawned child pid. */
interface PidExposingTransport {
  readonly pid?: number;
}

export interface LiveCodexProbeOptions {
  /** The exact configured name of the modeling Skill (skills/list match). */
  skillName: string;
  /**
   * The exact configured absolute path of the Skill DIRECTORY — the input is
   * explicitly the directory, never the manifest file: `skills/list`
   * truthfully reports `<directory>\SKILL.md` (see
   * {@link isSkillMdPathOfDirectory}) and the turn input, the directory
   * digest (`hashSkillDirectory`) and the real probe's `skillRootPath` all
   * consume the directory.
   */
  skillResolvedPath: string;
  /**
   * Codex executable of the spawned app-server child (default `codex`, the
   * same `CODEX_APP_SERVER_COMMAND` the child transport resolves truthfully
   * on Windows — a `.cmd` shim is refused, never executed).
   */
  command?: string;
  /**
   * The absolute, writable probe workspace/cwd of the bounded `thread/start`
   * COMPATIBILITY probe (stable params: `cwd` + `sandbox: "workspace-write"` +
   * `approvalPolicy: "never"` — the gated `runtimeWorkspaceRoots` field is
   * never sent, matching the client's `experimentalApi: false`). It must be a
   * safe directory OUTSIDE customer artifacts; nothing is written into it and
   * no path is persisted. Absent: the probe creates its OWN temporary
   * directory under the OS temp dir and removes it in `finally` (never
   * persisted).
   */
  probeWorkspace?: string;
  /**
   * The live-spawn seam. Default: {@link codexChildTransportFactory} with the
   * configured command — ONE child per probe call, owned and closed by the
   * probe. Tests script an in-memory transport and never spawn a process.
   */
  transportFactory?: CodexTransportFactory;
  /** Per-request bound of the handshake / skills-list round trip (ms). */
  requestTimeoutMs?: number;
  /**
   * Authoritative explicit live configuration of model image-input support.
   * NEVER invented here: absent (`undefined`) reports `null` so the preflight
   * gate fails the image capability closed unless another seam proves it.
   */
  modelImageInputSupported?: boolean;
  /** Bypass the skills cache (`skills/list.forceReload`); default false. */
  forceReloadSkills?: boolean;
  /**
   * The CLI version snapshot of the caller's bounded `codex --version`
   * metadata probe (see {@link codexVersionProbe}), or null. The live
   * app-server handshake itself cannot verify the CLI version, so this probe
   * never claims one on its own — absent defaults to `null` (the pinned
   * version capability then fails closed).
   */
  version?: string | null;
  /** Deterministic clock of the snapshot timestamp (defaults to the wall clock). */
  now?: () => Date;
}

/**
 * The authoritative live snapshot of ONE bounded app-server probe call. Every
 * field is derived from the round trip or from explicit configuration — never
 * invented. Consumed by {@link RealPreflightProbe} (`liveCodex` option) and
 * adaptable to the synchronous {@link RuntimeProbeResult} surface through
 * {@link runtimeProbeResultOf}.
 */
export interface LiveCodexProbeResult {
  /** True when initialize + skills/list + the thread/start compatibility probe completed. */
  available: boolean;
  /** The caller-supplied CLI version snapshot, or null. */
  version: string | null;
  /**
   * The pinned app-server protocol (`CODEX_PROTOCOL_VERSION`, "2") the live
   * round trip proved, or null when the round trip did not complete.
   */
  protocol: string | null;
  /** Authoritative image-input support from explicit live config, or null. */
  modelImageInputSupported: boolean | null;
  /** The exact configured skill name appears in the live skills/list listing. */
  skillDiscovered: boolean;
  /**
   * The discovered skill's reported path is the manifest file INSIDE the
   * exact configured skill directory (`<directory>\SKILL.md`, canonical
   * Windows-safe comparison — see {@link isSkillMdPathOfDirectory}).
   */
  skillPathVerified: boolean;
  /** The $CODEX_HOME of the completed handshake, or null. */
  codexHome: string | null;
  /** The OS pid of the spawned child (diagnostics), or undefined. */
  childPid: number | undefined;
  /**
   * True when the probe closed its own client + transport before resolving
   * (the probe's child was never left unmanaged). False only when the
   * transport factory itself threw (no child was ever created).
   */
  childClosed: boolean;
  /** ISO timestamp of the snapshot (probe clock). */
  probedAt: string;
}

/** The fail-closed live snapshot: nothing is ever assumed. */
export function failClosedLiveCodexResult(input: {
  version: string | null;
  modelImageInputSupported: boolean | null;
  now: () => Date;
}): LiveCodexProbeResult {
  return {
    available: false,
    version: input.version,
    protocol: null,
    modelImageInputSupported: input.modelImageInputSupported,
    skillDiscovered: false,
    skillPathVerified: false,
    codexHome: null,
    childPid: undefined,
    childClosed: false,
    probedAt: input.now().toISOString()
  };
}

/** The exact skill manifest file name the live `skills/list` must report. */
export const CODEX_SKILL_FILE_NAME = "SKILL.md" as const;

/** The lexical path segments of a path (empty runs from repeated separators dropped). */
function pathSegmentsOf(value: string, platform: NodeJS.Platform): string[] {
  // On Windows both separators are equivalent; on POSIX `/` is the only
  // separator and a backslash is a legal file-name character.
  return value
    .split(platform === "win32" ? /[\\/]+/ : /\/+/)
    .filter((segment) => segment.length > 0);
}

/**
 * Canonical Windows-safe verification of the configured skill DIRECTORY
 * against the skill manifest path Codex's `skills/list` reports. Codex
 * truthfully reports `<configuredDirectory>\SKILL.md` — the manifest file
 * INSIDE the configured directory, never the directory itself — so a plain
 * string comparison of the directory against the reported path can never
 * pass. This check requires the reported path to be the configured directory
 * PLUS exactly one final `SKILL.md` segment.
 *
 * Canonical and lexical (never a filesystem resolution):
 *
 * - both sides are split into segments on the platform separators and
 *   compared segment-wise with the same length; a differently-shaped path —
 *   a sibling directory (`...-other\SKILL.md`), a `.codex` copy, a nested
 *   manifest (`...\sub\SKILL.md`), a missing file segment (the bare
 *   directory), an extra segment, a different file name (`SKILL.md.backup`) —
 *   fails closed; prefix tricks are impossible because every segment must
 *   equal exactly;
 * - on Windows hosts (`platform === "win32"`) segments compare
 *   case-insensitively (the filesystem is case-insensitive) and both `/` and
 *   `\` are separators; on POSIX hosts the comparison is case-sensitive and
 *   `/` is the only separator;
 * - NOTHING is resolved against the filesystem (`realpath`/`resolve` are
 *   never used): a symlink- or junction-redirected tree can never pass this
 *   check, and the check itself is purely lexical on the round-trip snapshot
 *   — no read/comparison TOCTOU window exists.
 */
export function isSkillMdPathOfDirectory(
  reportedPath: string,
  skillDirectory: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const reported = pathSegmentsOf(reportedPath, platform);
  const directory = pathSegmentsOf(skillDirectory, platform);
  if (reported.length !== directory.length + 1) return false;
  const equal = platform === "win32" ? insensitiveEqual : exactEqual;
  for (let index = 0; index < directory.length; index += 1) {
    const reportedSegment = reported[index];
    const directorySegment = directory[index];
    // Unreachable after the length check, but indexed access is optional-typed.
    if (reportedSegment === undefined || directorySegment === undefined) return false;
    if (!equal(reportedSegment, directorySegment)) return false;
  }
  const reportedFile = reported[reported.length - 1];
  return reportedFile !== undefined && equal(reportedFile, CODEX_SKILL_FILE_NAME);
}

function exactEqual(a: string, b: string): boolean {
  return a === b;
}

function insensitiveEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Runs ONE bounded live app-server probe: spawns one child (or uses the
 * injected transport), performs the strict initialize + skills/list round
 * trip, verifies the exact configured skill directory against the listing
 * (the reported path must be its `SKILL.md`, see
 * {@link isSkillMdPathOfDirectory}), then proves `thread/start`
 * COMPATIBILITY with the STABLE params (cwd + workspace-write sandbox, no
 * gated `runtimeWorkspaceRoots`, no turn/skill/image call) — success of that
 * probe is REQUIRED, and the thread id is discarded (never persisted) — and
 * ALWAYS closes its own client + transport before resolving. A runtime
 * failure never throws — it returns the fail-closed snapshot (the preflight
 * gate records the boolean and stays redacted). Only a malformed probe
 * configuration (empty skill name, non-absolute skill path, non-absolute
 * probe workspace) throws {@link InvalidArgumentError}.
 */
export async function probeLiveCodexRuntime(
  options: LiveCodexProbeOptions
): Promise<LiveCodexProbeResult> {
  const skillName = options.skillName;
  const skillResolvedPath = options.skillResolvedPath;
  if (typeof skillName !== "string" || skillName.trim().length === 0) {
    throw new InvalidArgumentError("skillName must be a non-empty string");
  }
  if (typeof skillResolvedPath !== "string" || skillResolvedPath.trim().length === 0) {
    throw new InvalidArgumentError("skillResolvedPath must be a non-empty absolute path");
  }
  if (!isAbsolute(skillResolvedPath)) {
    throw new InvalidArgumentError("skillResolvedPath must be an absolute path");
  }
  if (options.probeWorkspace !== undefined) {
    if (typeof options.probeWorkspace !== "string" || options.probeWorkspace.trim().length === 0) {
      throw new InvalidArgumentError("probeWorkspace must be a non-empty absolute path");
    }
    if (!isAbsolute(options.probeWorkspace)) {
      throw new InvalidArgumentError("probeWorkspace must be an absolute path");
    }
  }

  const now = options.now ?? (() => new Date());
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_LIVE_CODEX_PROBE_TIMEOUT_MS;
  const forceReload = options.forceReloadSkills ?? false;
  const failClosedInput = {
    version: options.version ?? null,
    modelImageInputSupported: options.modelImageInputSupported ?? null,
    now
  };

  const factory =
    options.transportFactory ??
    codexChildTransportFactory({
      command: options.command ?? CODEX_APP_SERVER_COMMAND
    });

  // The workspace of the thread/start compatibility probe: the
  // caller-supplied absolute path, or the probe's OWN disposable directory
  // (created below, removed in `finally` — never persisted).
  let ownedWorkspace: string | null = null;
  let workspace: string;
  if (options.probeWorkspace !== undefined) {
    workspace = options.probeWorkspace;
  } else {
    try {
      ownedWorkspace = await mkdtemp(join(tmpdir(), "swpanel-codex-probe-"));
      workspace = ownedWorkspace;
    } catch {
      // The probe's own temp workspace could not be created: the
      // thread/start probe has no safe cwd — fail closed (no child was ever
      // created, nothing to close).
      return failClosedLiveCodexResult(failClosedInput);
    }
  }

  // ONE child per probe call; the probe is the single lifecycle owner.
  let transport: CodexTransport | null = null;
  let client: CodexAppServerClient | null = null;
  // Start fail-closed; the successful round trip overrides below.
  let result: LiveCodexProbeResult = failClosedLiveCodexResult(failClosedInput);
  try {
    try {
      transport = factory();
    } catch {
      // The factory itself threw: no child was ever created, nothing to close.
      return failClosedLiveCodexResult(failClosedInput);
    }
    const childPid = (transport as PidExposingTransport).pid;
    client = new CodexAppServerClient({ transport, requestTimeoutMs });
    const initialized = await client.initialize(requestTimeoutMs);
    const listing = await client.skillsList(
      // The cache bypass is only sent when requested — the default call stays
      // on the smallest wire footprint (no invented params).
      buildSkillsListParams(forceReload ? { forceReload: true } : {}),
      requestTimeoutMs
    );
    let skillDiscovered = false;
    let skillPathVerified = false;
    for (const entry of listing.data) {
      for (const skill of entry.skills) {
        if (skill.name !== skillName) continue;
        skillDiscovered = true;
        // EXACT directory verification: the configured input is the skill
        // DIRECTORY, while the listing truthfully reports the manifest file
        // inside it (`<directory>\SKILL.md`) — the reported path must equal
        // exactly that shape (canonical Windows-safe segment comparison, no
        // filesystem resolution): a sibling directory, a `.codex` copy, a
        // nested manifest or a different file name fails closed.
        if (isSkillMdPathOfDirectory(skill.path, skillResolvedPath)) {
          skillPathVerified = true;
        }
      }
    }
    // Bounded `thread/start` COMPATIBILITY probe with the STABLE params
    // (`cwd` + `sandbox: "workspace-write"` + `approvalPolicy: "never"` —
    // NEVER the gated `runtimeWorkspaceRoots` field, which native Codex
    // 0.147.0 rejects with -32600 under `experimentalApi: false`). No local
    // image, no skill invocation, no turn/model call. Success is REQUIRED:
    // initialize + skills/list alone could miss a thread-open protocol
    // mismatch, so the gate proves thread-open compatibility itself. The
    // thread id is discarded and never persisted.
    await client.threadStart(
      buildThreadStartParams({ cwd: workspace, writableRoots: [workspace] }),
      requestTimeoutMs
    );
    result = {
      available: true,
      version: options.version ?? null,
      protocol: CODEX_PROTOCOL_VERSION,
      modelImageInputSupported: options.modelImageInputSupported ?? null,
      skillDiscovered,
      skillPathVerified,
      codexHome: initialized.codexHome,
      childPid,
      childClosed: false,
      probedAt: now().toISOString()
    };
  } catch {
    // Any runtime/protocol/RPC/timeout/child-exit failure fails closed (the
    // initialized fail-closed result stands); the gate stays boolean-only and
    // the report never carries the reason.
  } finally {
    // The probe owns the child: the client (or, if the client construction
    // itself failed, the raw transport) is ALWAYS closed — bounded
    // termination, never an orphaned child. A factory that threw created no
    // child, so `childClosed` stays false (nothing to close).
    if (transport !== null) {
      let closed = true;
      try {
        if (client !== null) {
          client.close();
        } else {
          transport.close();
        }
      } catch {
        closed = false;
      }
      result = { ...result, childClosed: closed };
    }
    // The probe's OWN temp workspace is ALWAYS removed (also on failures):
    // no path/workspace persists past the probe call.
    if (ownedWorkspace !== null) {
      try {
        await rm(ownedWorkspace, { recursive: true, force: true });
      } catch {
        // cleanup is best-effort
      }
    }
  }
  return result;
}

/**
 * Adapts the authoritative live snapshot onto the synchronous
 * {@link RuntimeProbeResult} surface of {@link RealPreflightProbe} (the
 * runtime seam the production gate construction injects). The fields are the
 * live snapshot verbatim — nothing is invented or reinterpreted.
 */
export function runtimeProbeResultOf(live: LiveCodexProbeResult): RuntimeProbeResult {
  return {
    available: live.available,
    version: live.version,
    protocol: live.protocol,
    modelImageInputSupported: live.modelImageInputSupported
  };
}
