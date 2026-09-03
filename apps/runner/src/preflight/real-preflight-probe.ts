/**
 * The REAL preflight probe of Phase 5 (P5-1): the repository-side counterpart
 * of the deterministic synthetic fixture. `RealPreflightProbe` NEVER fakes an
 * environment fact — every capability is derived from a real check or from an
 * injected, verifiable seam, and anything unverifiable fails closed:
 *
 * - `agent_runtime_available` / `agent_runtime_version_supported`: the
 *   injected {@link RuntimeProbe} seam (default: the real bounded
 *   `codex --version` metadata probe, {@link codexVersionProbe}). The version
 *   requirement is PINNED (default `0.147.0`, {@link CODEX_CLI_VERSION}):
 *   any other version, an unparsable version and an unavailable runtime all
 *   fail closed.
 * - `agent_model_supports_image`: NEVER hardcoded. Derived from explicit live
 *   configuration (`modelImageInputSupported`) when provided — authoritative —
 *   otherwise from the live Codex snapshot or the runtime seam's verifiable
 *   report; when neither proves it (absent config, unknown seam result) the
 *   capability FAILS CLOSED.
 * - `structured_runtime_protocol_available`: the runtime seam's reported
 *   app-server protocol must equal the pinned protocol version (default `2`,
 *   {@link CODEX_PROTOCOL_VERSION}). When a LIVE Codex snapshot
 *   ({@link LiveCodexProbeResult}, the initialize + skills/list + bounded
 *   thread/start compatibility round trip of
 *   {@link probeLiveCodexRuntime}) is injected it is AUTHORITATIVE — the
 *   strict round trip IS the protocol-v2 proof, and an aborted round trip
 *   fails closed. A runtime whose protocol is unknown (e.g. only a
 *   `--version` probe ran) fails closed: the structured protocol is never
 *   assumed.
 * - `modeling_skill_discovered`: REAL filesystem check at the exact
 *   configured path (`skillRootPath`): the root must be a real directory
 *   containing a regular `SKILL.md` entry — no symlinks anywhere. When a live
 *   Codex snapshot that RAN is injected, the live `skills/list` exact-path
 *   verification is authoritative TOO: an available runtime whose listing
 *   does not prove the exact configured path fails the discovery closed (the
 *   hashed tree and the executed tree must be the same tree).
 * - `modeling_skill_hash_allowed`: REAL deterministic directory SHA-256
 *   ({@link hashSkillDirectory}, canonical algorithm) compared EXACTLY to the
 *   frozen snapshot digest; any hash failure (symlink, path escape, drift,
 *   malformed frozen digest) fails closed.
 * - `workspace_write_scope_supported`: REAL writability probe of the CURRENT
 *   attempt workspace root (the executor passes it in the probe context): a
 *   unique probe file is created, written, read back and deleted; ANY failure
 *   fails closed.
 * - `solidworks_available`: the injected {@link SolidWorksProbe} seam (never
 *   assumed — the version-agnostic gate requires any drivable installation;
 *   absent injection defaults to the fail-closed {@link
 *   FAIL_CLOSED_SOLIDWORKS_PROBE}).
 *
 * `input_adapter_succeeded` stays executor-owned and is never evaluated here:
 * PDF conversion availability is NOT a preflight capability — the preflight
 * gate covers only the environment capabilities above and never claims to
 * cover conversion. The conversion gate is `input_adapter_succeeded`: the
 * adapter probes its renderer at conversion time (explicit availability
 * probe) and fails closed, structured, when unavailable; the executor marks
 * the item only after the adaptation succeeds.
 * Every result is marked `synthetic: false` — the probe is real, but every
 * check it reports is exactly what the seams and the filesystem proved at
 * probe time.
 *
 * The probe captures the runtime and SolidWorks snapshots ONCE at
 * construction (deterministic per probe instance — one probe per Runner
 * open); a probe whose seam THROWS fails that seam's capabilities closed
 * instead of crashing the gate. The skill/hash/workspace checks are
 * re-evaluated per gate run against the live filesystem — that is the point
 * of the gate (the frozen snapshot hash must equal the CURRENT skill tree).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PreflightCapability } from "@swpanel/domain";

import { CODEX_CLI_VERSION, CODEX_PROTOCOL_VERSION } from "../agent/codex/builders.js";
import { InvalidArgumentError } from "../errors.js";
import type { LiveCodexProbeResult } from "./codex-live-probe.js";
import { hashSkillDirectory } from "./skill-directory-hash.js";
import type { PreflightProbeContext } from "./preflight.js";

/** Synchronous, fail-closed snapshot of the Codex App Server runtime. */
export interface RuntimeProbeResult {
  /** True when the runtime binary ran successfully. */
  available: boolean;
  /** The reported runtime version, or null when unavailable/unparsable. */
  version: string | null;
  /** The reported app-server protocol version, or null when not verifiable. */
  protocol: string | null;
  /**
   * Verifiable model image-input support, or null when the runtime cannot
   * prove it (fail closed by the probe). Never invented.
   */
  modelImageInputSupported: boolean | null;
}

/** The injectable runtime seam of the real probe (synchronous, deterministic). */
export interface RuntimeProbe {
  probe(): RuntimeProbeResult;
}

/** Synchronous availability/version snapshot of the SolidWorks installation. */
export interface SolidWorksProbeResult {
  available: boolean;
  /** The detected SolidWorks version, or null when unavailable. */
  version: string | null;
}

/** The injectable SolidWorks seam of the real probe (never assumed). */
export interface SolidWorksProbe {
  probe(): SolidWorksProbeResult;
}

/** The fail-closed default runtime snapshot: nothing is ever assumed. */
const UNAVAILABLE_RUNTIME_RESULT: RuntimeProbeResult = Object.freeze({
  available: false,
  version: null,
  protocol: null,
  modelImageInputSupported: null
});

/**
 * The fail-closed runtime seam: reports an unavailable runtime. Used whenever
 * no runtime seam was injected — the probe must never guess a runtime exists.
 */
export const FAIL_CLOSED_RUNTIME_PROBE: RuntimeProbe = Object.freeze({
  probe: () => UNAVAILABLE_RUNTIME_RESULT
});

/**
 * The fail-closed SolidWorks seam: reports an unavailable installation. Used
 * whenever no SolidWorks seam was injected — availability is never assumed by
 * this probe (the version-agnostic gate requires ANY drivable installation).
 */
export const FAIL_CLOSED_SOLIDWORKS_PROBE: SolidWorksProbe = Object.freeze({
  probe: () => ({ available: false, version: null })
});

/** One synchronous external-command invocation (the spawnSync seam). */
export interface CommandRunner {
  run(command: string, args: readonly string[]): {
    status: number | null;
    stdout: string;
    /** The spawn error message (ENOENT etc.), or null. */
    error: string | null;
  };
}

/** Default command runner over `spawnSync` (bounded, shell-free, hidden on Windows). */
export const DEFAULT_COMMAND_RUNNER: CommandRunner = {
  run(command, args) {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      timeout: DEFAULT_CODEX_VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
      shell: false
    });
    return {
      status: result.status,
      stdout: result.stdout,
      error: result.error?.message ?? null
    };
  }
};

/** Default timeout of the bounded `codex --version` probe (5 seconds). */
export const DEFAULT_CODEX_VERSION_PROBE_TIMEOUT_MS = 5_000 as const;

export interface CodexVersionProbeOptions {
  /** Executable to probe (default `codex`). */
  command?: string;
  /** Injectable command runner (hermetic tests script it). */
  run?: CommandRunner;
  /** Parser of the version from the probe stdout (default: first semver). */
  parseVersion?: (stdout: string) => string | null;
}

const SEMVER_PATTERN = /\b\d+\.\d+\.\d+\b/;

function firstSemver(stdout: string): string | null {
  return SEMVER_PATTERN.exec(stdout)?.[0] ?? null;
}

/**
 * The REAL runtime availability/version probe (Batch D): runs the bounded,
 * read-only `codex --version` metadata check through the injected command
 * runner (default `spawnSync`, shell-free, hidden on Windows). The runtime is
 * `available` only when the command ran (exit 0); the version is the first
 * semver of the output. The app-server PROTOCOL version and model image-input
 * support are NOT verifiable from `--version` — they report `null` and the
 * probe fails those capabilities closed until a live app-server handshake
 * (a later batch) can prove them. This is a repository-side metadata check,
 * never an app-server session and never HIL evidence.
 */
export function codexVersionProbe(options: CodexVersionProbeOptions = {}): RuntimeProbe {
  const command = options.command ?? "codex";
  const run = options.run ?? DEFAULT_COMMAND_RUNNER;
  const parseVersion = options.parseVersion ?? firstSemver;
  return {
    probe(): RuntimeProbeResult {
      let outcome: ReturnType<CommandRunner["run"]>;
      try {
        outcome = run.run(command, ["--version"]);
      } catch {
        return UNAVAILABLE_RUNTIME_RESULT;
      }
      if (outcome.error !== null || outcome.status !== 0) {
        return UNAVAILABLE_RUNTIME_RESULT;
      }
      const version = parseVersion(outcome.stdout);
      if (version === null) {
        // The binary ran but no version could be verified: the pinned-version
        // capability must never pass on an unparsable output.
        return { ...UNAVAILABLE_RUNTIME_RESULT, available: true };
      }
      return {
        available: true,
        version,
        protocol: null,
        modelImageInputSupported: null
      };
    }
  };
}

export interface RealPreflightProbeOptions {
  /**
   * The exact configured absolute path of the modeling Skill directory
   * (the same `skillResolvedPath` the turn adapter receives). REQUIRED — the
   * real probe never guesses where the skill lives.
   */
  skillRootPath: string;
  /**
   * The injected SolidWorks seam. Absent (default) fails SolidWorks closed
   * ({@link FAIL_CLOSED_SOLIDWORKS_PROBE}) — availability is never assumed by
   * this probe.
   */
  solidworks?: SolidWorksProbe;
  /**
   * The injected runtime seam (default: the real bounded `codex --version`
   * probe, {@link codexVersionProbe}; pass {@link FAIL_CLOSED_RUNTIME_PROBE}
   * to never touch the runtime). When {@link liveCodex} is injected, the live
   * snapshot is authoritative for the runtime/protocol capabilities it
   * proves.
   */
  runtime?: RuntimeProbe;
  /**
   * The pinned runtime version the gate requires. Defaults to the pinned
   * codex-cli release `0.147.0` (`CODEX_CLI_VERSION`) — the version check is
   * an EXACT pin, never a ">= some version" guess.
   */
  expectedRuntimeVersion?: string;
  /**
   * The pinned app-server protocol version the gate requires. Defaults to the
   * pinned protocol `2` (`CODEX_PROTOCOL_VERSION`).
   */
  expectedProtocolVersion?: string;
  /**
   * Explicit live configuration of model image-input support. When provided
   * it is AUTHORITATIVE (a `false` override wins even over a seam that
   * reports support). Absent: derived from the live Codex snapshot, then from
   * the runtime seam's verifiable report; a seam that cannot prove it fails
   * closed. NEVER faked here.
   */
  modelImageInputSupported?: boolean;
  /**
   * The captured LIVE Codex App Server probe snapshot
   * ({@link LiveCodexProbeResult}, produced by {@link probeLiveCodexRuntime} —
   * the strict initialize + skills/list + bounded thread/start compatibility
   * round trip). When injected it is
   * AUTHORITATIVE for the capabilities the live round trip proves: the
   * structured protocol (`protocol` must equal the expected pinned version),
   * the runtime availability, the pinned runtime version and the exact
   * skills/list skill-path discovery. An injected snapshot that RAN but did
   * not verify the exact configured skill path fails the discovery closed.
   * The live probe is an async seam, so it runs in the production-config
   * construction path BEFORE the (synchronous) probe is constructed; absent
   * here, the gate falls back to the injected runtime seam / filesystem.
   */
  liveCodex?: LiveCodexProbeResult;
}

/**
 * The real preflight probe (Batch D). `synthetic` is always `false`: every
 * capability result is derived from a real check or an injected seam, and
 * anything unverifiable fails closed. See the module doc for the per-item
 * semantics.
 */
export class RealPreflightProbe {
  readonly synthetic = false;

  private readonly skillRootPath: string;
  private readonly expectedRuntimeVersion: string;
  private readonly expectedProtocolVersion: string;
  private readonly modelImageInputSupportedConfig: boolean | undefined;
  private readonly runtimeResult: RuntimeProbeResult;
  private readonly solidworksResult: SolidWorksProbeResult;
  private readonly liveCodex: LiveCodexProbeResult | undefined;

  constructor(options: RealPreflightProbeOptions) {
    if (typeof options.skillRootPath !== "string" || options.skillRootPath.trim().length === 0) {
      throw new InvalidArgumentError("skillRootPath must be a non-empty absolute path");
    }
    this.skillRootPath = options.skillRootPath;
    this.expectedRuntimeVersion = options.expectedRuntimeVersion ?? CODEX_CLI_VERSION;
    this.expectedProtocolVersion = options.expectedProtocolVersion ?? CODEX_PROTOCOL_VERSION;
    this.modelImageInputSupportedConfig = options.modelImageInputSupported;
    this.liveCodex = options.liveCodex;
    // The runtime + SolidWorks snapshots are captured ONCE at construction
    // (deterministic per probe instance); a THROWN seam fails closed instead
    // of crashing the gate. SolidWorks availability is never assumed: absent
    // injection defaults to the fail-closed probe.
    const runtime = options.runtime ?? codexVersionProbe();
    this.runtimeResult = captureRuntime(runtime);
    this.solidworksResult = captureSolidWorks(options.solidworks ?? FAIL_CLOSED_SOLIDWORKS_PROBE);
  }

  /** The runtime snapshot the probe captured at construction (diagnostics). */
  get runtimeSnapshot(): RuntimeProbeResult {
    return this.runtimeResult;
  }

  /** The SolidWorks snapshot the probe captured at construction (diagnostics). */
  get solidworksSnapshot(): SolidWorksProbeResult {
    return this.solidworksResult;
  }

  /**
   * The REAL capability check. A thrown check (hash failure, unreadable
   * directory, probe-file failure) is converted into `false` for THAT
   * capability — the gate records it redacted and the report never carries
   * the underlying error content.
   */
  checkCapability(capability: PreflightCapability, context: PreflightProbeContext): boolean {
    switch (capability) {
      case "agent_runtime_available":
        // The LIVE snapshot is authoritative when injected; otherwise the
        // runtime seam's report. Neither ever assumes a runtime exists.
        return this.liveCodex === undefined
          ? this.runtimeResult.available
          : this.liveCodex.available;
      case "agent_runtime_version_supported":
        // Exact pin: the reported version MUST equal the expected one.
        return this.liveCodex === undefined
          ? this.runtimeResult.available &&
              this.runtimeResult.version === this.expectedRuntimeVersion
          : this.liveCodex.available &&
              this.liveCodex.version === this.expectedRuntimeVersion;
      case "agent_model_supports_image":
        // Explicit live configuration is authoritative; otherwise the live
        // snapshot's, then the seam's verifiable report; an unverifiable
        // input fails closed (false).
        return (
          this.modelImageInputSupportedConfig ??
          this.liveCodex?.modelImageInputSupported ??
          this.runtimeResult.modelImageInputSupported ??
          false
        );
      case "modeling_skill_discovered":
        return this.skillDiscovered() && this.liveSkillVerified();
      case "modeling_skill_hash_allowed":
        return this.skillHashAllowed(context);
      case "structured_runtime_protocol_available":
        // Exact pin: the proved protocol MUST equal the expected one — an
        // unverifiable protocol is never assumed. The LIVE round trip is the
        // authoritative protocol-v2 proof when injected.
        return this.liveCodex === undefined
          ? this.runtimeResult.available &&
              this.runtimeResult.protocol === this.expectedProtocolVersion
          : this.liveCodex.available &&
              this.liveCodex.protocol === this.expectedProtocolVersion;
      case "workspace_write_scope_supported":
        return this.workspaceWritable(context);
      case "solidworks_available":
        return this.solidworksResult.available;
      case "input_adapter_succeeded":
        // Executor-owned: the gate never evaluates this item, and a direct
        // query must never claim it.
        return false;
    }
  }

  /**
   * When a LIVE Codex snapshot is injected and the runtime RAN, Codex's own
   * `skills/list` discovery is authoritative: the exact configured skill path
   * must be verified by the listing (the hashed tree and the executed tree
   * must be the same tree — a `.codex` copy instead of the configured path
   * fails closed). An unavailable live snapshot cannot disprove the
   * filesystem discovery: the runtime capabilities fail the gate anyway.
   */
  private liveSkillVerified(): boolean {
    const live = this.liveCodex;
    if (live === undefined) return true;
    if (!live.available) return true;
    return live.skillDiscovered && live.skillPathVerified;
  }

  /**
   * REAL skill discovery at the exact configured path: the root must exist,
   * be a real directory (not a symlink) and contain a regular `SKILL.md`
   * entry. Any anomaly fails closed.
   */
  private skillDiscovered(): boolean {
    try {
      const stats = lstatSync(this.skillRootPath);
      if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
      const skillMd = join(this.skillRootPath, "SKILL.md");
      const skillMdStats = lstatSync(skillMd);
      return !skillMdStats.isSymbolicLink() && skillMdStats.isFile();
    } catch {
      return false;
    }
  }

  /**
   * REAL hash equality: the deterministic directory SHA-256 of the CURRENT
   * skill tree must EXACTLY equal the frozen snapshot digest. A hash failure
   * (symlink, path escape, drift, unreadable entry) and a malformed frozen
   * digest (anything but 64 lowercase hex — including the 0*64 placeholder)
   * fail closed.
   */
  private skillHashAllowed(context: PreflightProbeContext): boolean {
    const frozen = context.skill.sha256;
    if (!/^[0-9a-f]{64}$/.test(frozen)) return false;
    let current: string;
    try {
      current = hashSkillDirectory(this.skillRootPath);
    } catch (error) {
      void error;
      return false;
    }
    return current === frozen;
  }

  /**
   * REAL writability probe of the CURRENT attempt workspace root: a unique
   * probe file is created, written, read back (content verified) and deleted
   * inside the root. A missing/absent workspace root, any write/read/delete
   * failure and any leftover probe file fail closed.
   */
  private workspaceWritable(context: PreflightProbeContext): boolean {
    const root = context.workspaceRoot;
    if (typeof root !== "string" || root.trim().length === 0) return false;
    const token = randomBytes(8).toString("hex");
    const probePath = join(root, `.swpanel-write-probe-${token}`);
    try {
      writeFileSync(probePath, Buffer.from("swpanel-write-probe", "utf8"), { flag: "wx" });
      const readBack = readFileSync(probePath, "utf8");
      if (readBack !== "swpanel-write-probe") return false;
      unlinkSync(probePath);
      return true;
    } catch {
      // Best-effort cleanup of a possibly-created probe file.
      try {
        rmSync(probePath, { force: true });
      } catch {
        // cleanup is best-effort
      }
      return false;
    }
  }
}

/** Captures the runtime snapshot; a THROWN seam fails closed (unavailable). */
function captureRuntime(runtime: RuntimeProbe): RuntimeProbeResult {
  try {
    return runtime.probe();
  } catch {
    return UNAVAILABLE_RUNTIME_RESULT;
  }
}

/** Captures the SolidWorks snapshot; a THROWN seam fails closed (unavailable). */
function captureSolidWorks(solidworks: SolidWorksProbe): SolidWorksProbeResult {
  try {
    return solidworks.probe();
  } catch {
    return { available: false, version: null };
  }
}
