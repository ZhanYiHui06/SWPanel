import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RunnerInvariantError } from "../errors.js";
import type {
  PdfInspectResult,
  PdfRasterizeRequest,
  PdfRasterizeResult,
  PdfRasterizer,
  PdfRasterizerAvailability
} from "./real-pdf-input-adapter.js";
import { redactSensitivePaths } from "./path-redaction.js";

/**
 * Concrete {@link PdfRasterizer} (Batch E): a REAL local rendering engine based
 * on the pinned repository Python environment (pypdfium2 4.30.0 + Pillow
 * 11.3.0). This is the engine the `RealPdfInputAdapter` documentation promised
 * the HIL batch would wire in — the environment probe now found it, so the
 * concrete renderer ships with this batch.
 *
 * The engine lives in a small repository Python helper
 * ({@link PYTHON_PDFIUM_HELPER_FILE_NAME}) that is invoked SYNCHRONOUSLY and
 * safely: `spawnSync` with `shell: false`, bounded `timeout` and `maxBuffer`,
 * `windowsHide` on Windows. The immutable source bytes are written to a
 * private per-operation temp directory (created under the OS temp dir by
 * default, or under a caller-supplied secure base via `tempDir`) — never
 * inside the repository — together with a materialized copy of the helper
 * script (so the packaged asar, whose virtual filesystem a child process
 * cannot read, works identically), the helper renders/inspects there, the
 * PNG is read back and the whole private directory is removed in `finally`.
 *
 * Availability is probed EXPLICITLY through {@link probeAvailability} (a
 * `probe` helper invocation): the adapter calls it at conversion time and
 * fails closed with a structured failure when the renderer is unavailable —
 * conversion availability is the ADAPTER's gate (`input_adapter_succeeded`,
 * marked by the executor only after the adaptation succeeds), NEVER a
 * preflight capability. The preflight gate evaluates only the eight
 * environment capabilities and never claims to cover PDF conversion.
 *
 * The helper reports the ACTUAL rendered metrics and the renderer version
 * verbatim (JSON on stdout), which are recorded into provenance by the
 * adapter. The rasterizer only maps the stable structured codes
 * (`INVALID_PDF` / `RENDER_FAILED` / `RENDERER_UNAVAILABLE`) and never
 * interprets engine internals. User-visible failure messages are REDACTED:
 * raw helper stderr is never included and absolute temp/user paths are
 * replaced by fixed placeholders ({@link redactSensitivePaths}).
 *
 * Packaged-app resolution: the helper ships in the asar at
 * `apps/runner/dist/adaptation/pdfium-rasterizer-helper.py` (audited by
 * `scripts/audit-asar.mjs`). The default path resolution covers the compiled
 * runner and the TypeScript test tree; the Electron host of a packaged app
 * must pass the asar-resolved absolute path explicitly via `helperPath` (the
 * content is materialized to the private temp dir before spawning, so the
 * asar path itself only needs `readFileSync`, which Electron's fs supports).
 */
export const PYTHON_PDFIUM_RASTERIZER_ID = "swpanel-python-pdfium-rasterizer" as const;

/** Filename of the repository Python helper (next to this module / in dist). */
export const PYTHON_PDFIUM_HELPER_FILE_NAME = "pdfium-rasterizer-helper.py" as const;

/** Version reported before the first successful helper handshake. */
export const PYTHON_PDFIUM_RASTERIZER_UNKNOWN_VERSION = "unknown" as const;

/** Bounded timeout of one `inspect` helper invocation (10 seconds). */
export const PYTHON_PDFIUM_INSPECT_TIMEOUT_MS = 10_000 as const;

/** Bounded timeout of one `render` helper invocation (30 seconds). */
export const PYTHON_PDFIUM_RENDER_TIMEOUT_MS = 30_000 as const;

/** Bounded stdout capture of one helper invocation (1 MB JSON envelope). */
export const PYTHON_PDFIUM_MAX_BUFFER_BYTES = 1_000_000 as const;

/** Result of one synchronous helper invocation (the spawnSync seam). */
export interface PythonCommandRunResult {
  /** Process exit code, or null when the spawn itself failed. */
  status: number | null;
  /** Captured stdout (bounded by maxBuffer). */
  stdout: string;
  /** Captured stderr (bounded by maxBuffer). */
  stderr: string;
  /** The spawn error message (ENOENT, ETIMEDOUT, ENOBUFS, ...), or null. */
  error: string | null;
}

/** One synchronous external-command invocation (injectable for hermetic tests). */
export interface PythonCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { timeoutMs: number; maxBufferBytes: number }
  ): PythonCommandRunResult;
}

/**
 * Default command runner over `spawnSync`: shell-free (no shell interpolation
 * of the private temp paths), bounded timeout/maxBuffer, hidden window on
 * Windows. Mirrors the batch's spawnSync seam conventions.
 */
export const DEFAULT_PYTHON_COMMAND_RUNNER: PythonCommandRunner = {
  run(command, args, options) {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBufferBytes
    });
    return {
      status: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      error: result.error?.message ?? null
    };
  }
};

/**
 * The JSON envelope the helper writes to stdout (last non-empty line) for the
 * inspect/render operations: either a structured failure or a success carrying
 * the ACTUAL page count, the ACTUAL rendered metrics and the renderer version
 * verbatim.
 */
export type PdfiumHelperJson =
  | {
      ok: true;
      pageCount: number;
      widthPx?: number;
      heightPx?: number;
      dpi?: number;
      pageNumber?: number;
      rendererVersion: string;
    }
  | { ok: false; code: string; message: string };

/**
 * The JSON envelope of the explicit availability/version probe (`probe`
 * mode): a structured success with the renderer version verbatim, or a
 * structured failure (`RENDERER_UNAVAILABLE` when pypdfium2 is missing).
 */
export type PdfiumProbeHelperJson =
  | { ok: true; available: true; rendererVersion: string }
  | { ok: false; code: string; message: string };

export interface PythonPdfiumRasterizerOptions {
  /** Python executable (default `python`; e.g. `python3` on other hosts). */
  pythonExecutable?: string;
  /**
   * Absolute path of the helper script. Default: resolved next to this module
   * (dist/adaptation in the compiled runner, src/adaptation in the TS test
   * tree), with a src fallback. A packaged Electron host passes the
   * asar-resolved path explicitly.
   */
  helperPath?: string;
  /** Base directory for the private per-operation temp dirs (default: OS tmp). */
  tempDir?: string;
  /** Bounded timeout of one inspect invocation (default 10 s). */
  inspectTimeoutMs?: number;
  /** Bounded timeout of one render invocation (default 30 s). */
  renderTimeoutMs?: number;
  /** Bounded stdout cap of one invocation (default 1 MB). */
  maxBufferBytes?: number;
  /** Injectable spawn seam (hermetic tests script it). */
  run?: PythonCommandRunner;
}

/** Default helper path: next to the module, then the src tree fallback. */
function defaultHelperPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, PYTHON_PDFIUM_HELPER_FILE_NAME),
    path.join(moduleDir, "..", "..", "src", "adaptation", PYTHON_PDFIUM_HELPER_FILE_NAME)
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/**
 * The concrete pypdfium2-backed {@link PdfRasterizer}: inspects the ACTUAL
 * page count and rasterizes one 1-based page to PNG through the repository
 * Python helper, synchronously, with bounded and shell-free process
 * execution and private-temp-dir input/output + cleanup. Availability is
 * probed explicitly via {@link probeAvailability} (a `probe` helper
 * invocation); the adapter fails closed, structured, when it reports the
 * renderer unavailable — never after interpreting leaked stderr or paths.
 */
export class PythonPdfiumRasterizer implements PdfRasterizer {
  readonly id = PYTHON_PDFIUM_RASTERIZER_ID;

  private readonly pythonExecutable: string;
  private readonly helperPath: string;
  private readonly tempDir: string;
  private readonly inspectTimeoutMs: number;
  private readonly renderTimeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly run: PythonCommandRunner;
  private currentVersion: string = PYTHON_PDFIUM_RASTERIZER_UNKNOWN_VERSION;

  /** Exact renderer version reported by the helper's last successful call. */
  get version(): string {
    return this.currentVersion;
  }

  constructor(options: PythonPdfiumRasterizerOptions = {}) {
    this.pythonExecutable = options.pythonExecutable ?? "python";
    this.helperPath = options.helperPath ?? defaultHelperPath();
    this.tempDir = options.tempDir ?? os.tmpdir();
    this.inspectTimeoutMs = options.inspectTimeoutMs ?? PYTHON_PDFIUM_INSPECT_TIMEOUT_MS;
    this.renderTimeoutMs = options.renderTimeoutMs ?? PYTHON_PDFIUM_RENDER_TIMEOUT_MS;
    this.maxBufferBytes = options.maxBufferBytes ?? PYTHON_PDFIUM_MAX_BUFFER_BYTES;
    this.run = options.run ?? DEFAULT_PYTHON_COMMAND_RUNNER;
    if (this.pythonExecutable.length === 0) {
      throw new RunnerInvariantError("pythonExecutable must not be empty");
    }
    if (this.tempDir.length === 0) {
      throw new RunnerInvariantError("tempDir must not be empty");
    }
    if (!existsSync(this.helperPath)) {
      // The helper path is redacted for display: it may live under the user
      // profile (packaged asar) and must never reach a user-visible surface.
      throw new RunnerInvariantError(
        `python pdfium rasterizer helper not found at ` +
          `${redactSensitivePaths(this.helperPath, { tempDir: this.tempDir })}; ` +
          "build the runner or pass an explicit helperPath"
      );
    }
    try {
      const source = readFileSync(this.helperPath, "utf8");
      if (source.trim().length === 0) {
        throw new RunnerInvariantError(
          `python pdfium rasterizer helper at ` +
            `${redactSensitivePaths(this.helperPath, { tempDir: this.tempDir })} is empty`
        );
      }
    } catch (error) {
      if (error instanceof RunnerInvariantError) throw error;
      throw new RunnerInvariantError(
        `python pdfium rasterizer helper at ` +
          `${redactSensitivePaths(this.helperPath, { tempDir: this.tempDir })} is unreadable: ` +
          `${redactSensitivePaths(errorMessage(error), { tempDir: this.tempDir })}`
      );
    }
  }

  /**
   * The explicit availability/version probe (review fix): runs the helper's
   * `probe` mode in a private temp dir and reports whether the renderer
   * environment is usable, with the exact renderer version verbatim. This is
   * the conversion gate the adapter evaluates at conversion time —
   * `input_adapter_succeeded`, NOT a preflight capability, is the gate item
   * the executor marks after the adaptation (probe included) succeeds. The
   * result is fully structured and redacted: no paths and no raw stderr.
   */
  probeAvailability(): PdfRasterizerAvailability {
    const workDir = this.createWorkDir();
    try {
      this.materializeHelper(workDir);
      const outcome = this.run.run(
        this.pythonExecutable,
        [this.materializedHelperPath(workDir), "probe"],
        { timeoutMs: this.inspectTimeoutMs, maxBufferBytes: this.maxBufferBytes }
      );
      if (outcome.error !== null && outcome.error.length > 0) {
        // The executable itself could not spawn (ENOENT etc.): python is the
        // unavailable component.
        return { available: false, version: null, reason: "PYTHON_UNAVAILABLE" };
      }
      const parsed = parseProbeJson(outcome);
      if (parsed === null) {
        // Timeout, buffer overflow or a broken probe contract: the helper did
        // not produce a structured result.
        return { available: false, version: null, reason: "INVOCATION_FAILED" };
      }
      if (!parsed.ok) {
        if (parsed.code === "RENDERER_UNAVAILABLE") {
          return { available: false, version: null, reason: "PDFIUM_UNAVAILABLE" };
        }
        return { available: false, version: null, reason: "INVOCATION_FAILED" };
      }
      this.currentVersion = parsed.rendererVersion;
      return { available: true, version: parsed.rendererVersion };
    } catch {
      return { available: false, version: null, reason: "INVOCATION_FAILED" };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  inspect(sourceBytes: Buffer): PdfInspectResult {
    if (sourceBytes.byteLength === 0) {
      return { ok: false, code: "INVALID_PDF", message: "source bytes are empty" };
    }
    const workDir = this.createWorkDir();
    try {
      const pdfPath = this.writeSourceAndHelper(workDir, sourceBytes);
      const outcome = this.run.run(
        this.pythonExecutable,
        [this.materializedHelperPath(workDir), "inspect", pdfPath],
        { timeoutMs: this.inspectTimeoutMs, maxBufferBytes: this.maxBufferBytes }
      );
      const parsed = parseHelperJson(outcome);
      if (parsed === null) {
        return {
          ok: false,
          code: "RENDER_FAILED",
          message: this.describeSpawnFailure(outcome, "inspect")
        };
      }
      if (!parsed.ok) {
        return {
          ok: false,
          code: mapFailureCode(parsed.code),
          message: this.sanitizeMessage(parsed.message)
        };
      }
      if (!Number.isSafeInteger(parsed.pageCount) || parsed.pageCount < 1) {
        return {
          ok: false,
          code: "RENDER_FAILED",
          message: "helper reported an invalid page count"
        };
      }
      this.currentVersion = parsed.rendererVersion;
      return { ok: true, pageCount: parsed.pageCount };
    } catch (error) {
      return {
        ok: false,
        code: "RENDER_FAILED",
        message: `inspect failed: ${this.sanitizeMessage(errorMessage(error))}`
      };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  rasterize(input: PdfRasterizeRequest): PdfRasterizeResult {
    const { pageNumber, dpi } = input;
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
      return {
        ok: false,
        code: "RENDER_FAILED",
        message: "page number must be a positive integer"
      };
    }
    if (typeof dpi !== "number" || !Number.isFinite(dpi) || dpi <= 0) {
      return {
        ok: false,
        code: "RENDER_FAILED",
        message: "dpi must be a positive number"
      };
    }
    if (input.sourceBytes.byteLength === 0) {
      return { ok: false, code: "INVALID_PDF", message: "source bytes are empty" };
    }
    const workDir = this.createWorkDir();
    try {
      const pdfPath = this.writeSourceAndHelper(workDir, input.sourceBytes);
      const pngPath = path.join(workDir, "output.png");
      const outcome = this.run.run(
        this.pythonExecutable,
        [this.materializedHelperPath(workDir), "render", pdfPath, String(pageNumber), String(dpi), pngPath],
        { timeoutMs: this.renderTimeoutMs, maxBufferBytes: this.maxBufferBytes }
      );
      const parsed = parseHelperJson(outcome);
      if (parsed === null) {
        return {
          ok: false,
          code: "RENDER_FAILED",
          message: this.describeSpawnFailure(outcome, "render")
        };
      }
      if (!parsed.ok) {
        return { ok: false, code: mapFailureCode(parsed.code), message: this.sanitizeMessage(parsed.message) };
      }
      // The helper must report the ACTUAL metrics truthfully: any missing,
      // non-finite or contradicting metric is a renderer invariant violation
      // that fails closed (the adapter re-verifies the same invariants).
      if (!Number.isSafeInteger(parsed.pageCount) || parsed.pageCount < 1) {
        return {
          ok: false,
          code: "RENDER_FAILED",
          message: "helper reported an invalid page count"
        };
      }
      if (
        parsed.widthPx === undefined ||
        parsed.widthPx < 1 ||
        !Number.isSafeInteger(parsed.widthPx) ||
        parsed.heightPx === undefined ||
        parsed.heightPx < 1 ||
        !Number.isSafeInteger(parsed.heightPx)
      ) {
        return {
          ok: false,
          code: "RENDER_FAILED",
          message: "helper reported invalid rendered dimensions"
        };
      }
      if (parsed.dpi === undefined || !Number.isFinite(parsed.dpi) || parsed.dpi <= 0) {
        return {
          ok: false,
          code: "RENDER_FAILED",
          message: "helper reported an invalid dpi"
        };
      }
      if (parsed.pageNumber !== pageNumber) {
        return {
          ok: false,
          code: "RENDER_FAILED",
          message: `helper rendered page ${parsed.pageNumber} instead of requested page ${pageNumber}`
        };
      }
      let image: Buffer;
      try {
        image = readFileSync(pngPath);
      } catch (error) {
        return {
          ok: false,
          code: "RENDER_FAILED",
          message: `helper reported success but produced no PNG: ${this.sanitizeMessage(errorMessage(error))}`
        };
      }
      if (image.byteLength === 0) {
        return { ok: false, code: "RENDER_FAILED", message: "helper produced an empty PNG" };
      }
      this.currentVersion = parsed.rendererVersion;
      return {
        ok: true,
        image,
        widthPx: parsed.widthPx,
        heightPx: parsed.heightPx,
        dpi: parsed.dpi,
        pageNumber: parsed.pageNumber
      };
    } catch (error) {
      return {
        ok: false,
        code: "RENDER_FAILED",
        message: `rasterize failed: ${this.sanitizeMessage(errorMessage(error))}`
      };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** Create the private per-operation temp dir (never inside the repository). */
  private createWorkDir(): string {
    return mkdtempSync(path.join(this.tempDir, "swpanel-pdfium-"));
  }

  /** Path of the helper materialized inside the private work dir. */
  private materializedHelperPath(workDir: string): string {
    return path.join(workDir, PYTHON_PDFIUM_HELPER_FILE_NAME);
  }

  /**
   * Materialize a copy of the helper script inside the private work dir so
   * the packaged asar case (where the script is only readable through
   * Electron's patched fs) spawns a REAL file. Re-materialized per operation.
   */
  private materializeHelper(workDir: string): void {
    writeFileSync(this.materializedHelperPath(workDir), readFileSync(this.helperPath));
  }

  /**
   * Write the immutable source bytes and a materialized copy of the helper
   * script into the private work dir; returns the source PDF path.
   */
  private writeSourceAndHelper(workDir: string, sourceBytes: Buffer): string {
    this.materializeHelper(workDir);
    const pdfPath = path.join(workDir, "source.pdf");
    writeFileSync(pdfPath, sourceBytes);
    return pdfPath;
  }

  /**
   * Redacted description of a spawn-level failure: raw helper stderr is NEVER
   * included (it can embed absolute temp/user paths and tracebacks) and the
   * cause is path-redacted. The adapter maps this onto the structured
   * `RENDER_FAILED` / `CONVERSION_FAILED` vocabulary — the user sees a stable
   * message, never engine internals.
   */
  private describeSpawnFailure(outcome: PythonCommandRunResult, operation: string): string {
    const cause =
      outcome.error !== null && outcome.error.length > 0
        ? outcome.error
        : `exit code ${outcome.status ?? "unknown"}`;
    return `${operation} helper invocation failed (${this.sanitizeMessage(cause)})`;
  }

  /** Path-redacted message: absolute temp/user paths become placeholders. */
  private sanitizeMessage(message: string): string {
    return redactSensitivePaths(message, { tempDir: this.tempDir });
  }
}

/**
 * Parse the helper JSON from the last non-empty stdout line. Returns null
 * when no parseable envelope was produced (spawn failure, timeout, buffer
 * overflow or a broken helper contract).
 */
function parseHelperJson(outcome: PythonCommandRunResult): PdfiumHelperJson | null {
  const value = lastJsonLineValue(outcome);
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.ok === true) {
    if (typeof record.pageCount !== "number" || typeof record.rendererVersion !== "string") {
      return null;
    }
    return {
      ok: true,
      pageCount: record.pageCount,
      ...(typeof record.widthPx === "number" ? { widthPx: record.widthPx } : {}),
      ...(typeof record.heightPx === "number" ? { heightPx: record.heightPx } : {}),
      ...(typeof record.dpi === "number" ? { dpi: record.dpi } : {}),
      ...(typeof record.pageNumber === "number" ? { pageNumber: record.pageNumber } : {}),
      rendererVersion: record.rendererVersion
    };
  }
  if (record.ok === false) {
    if (typeof record.code !== "string" || typeof record.message !== "string") return null;
    return { ok: false, code: record.code, message: record.message };
  }
  return null;
}

/**
 * Parse the probe JSON envelope from the last non-empty stdout line. Returns
 * null when no parseable envelope was produced (spawn failure, timeout,
 * buffer overflow or a broken probe contract).
 */
function parseProbeJson(outcome: PythonCommandRunResult): PdfiumProbeHelperJson | null {
  const value = lastJsonLineValue(outcome);
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.ok === true && record.available === true) {
    if (typeof record.rendererVersion !== "string") return null;
    return { ok: true, available: true, rendererVersion: record.rendererVersion };
  }
  if (record.ok === false) {
    if (typeof record.code !== "string" || typeof record.message !== "string") return null;
    return { ok: false, code: record.code, message: record.message };
  }
  return null;
}

/** The parsed value of the last non-empty stdout line, or null. */
function lastJsonLineValue(outcome: PythonCommandRunResult): unknown {
  const lines = outcome.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]!);
  } catch {
    return null;
  }
}

/** Map the helper's structured code onto the stable rasterizer vocabulary. */
function mapFailureCode(code: string): "INVALID_PDF" | "RENDER_FAILED" {
  return code === "INVALID_PDF" ? "INVALID_PDF" : "RENDER_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
