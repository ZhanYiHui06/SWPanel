import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PYTHON_COMMAND_RUNNER,
  PYTHON_PDFIUM_HELPER_FILE_NAME,
  PYTHON_PDFIUM_INSPECT_TIMEOUT_MS,
  PYTHON_PDFIUM_MAX_BUFFER_BYTES,
  PYTHON_PDFIUM_RASTERIZER_ID,
  PYTHON_PDFIUM_RASTERIZER_UNKNOWN_VERSION,
  PYTHON_PDFIUM_RENDER_TIMEOUT_MS,
  PythonPdfiumRasterizer,
  type PythonCommandRunResult,
  type PythonCommandRunner
} from "./python-pdfium-rasterizer.js";

const SOURCE_BYTES = Buffer.from("SWPanel hermetic synthetic PDF bytes\n");

/** First 8 bytes of a real PNG file (signature). */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Deterministic PNG-like bytes the mocked renderer "produces". */
function fakePngBytes(pageNumber: number, dpi: number): Buffer {
  return Buffer.concat([
    PNG_MAGIC,
    Buffer.from(`fake png of page ${pageNumber} at ${dpi} dpi\n`, "utf8")
  ]);
}

/** Success JSON envelope exactly as the real helper emits it. */
function renderEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    pageCount: 1,
    widthPx: 612,
    heightPx: 792,
    dpi: 72,
    pageNumber: 1,
    rendererVersion: "pypdfium2 4.30.0",
    ...overrides
  });
}

/**
 * A tiny single-page PDF (MediaBox 612x792 pt) synthesized deterministically
 * IN the test — never an approved business PDF. The xref offsets are computed
 * from the actual byte positions so the file is well-formed for PDFium.
 */
function buildSyntheticPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/**
 * Hermetic spawn seam: records every invocation and serves scripted outcomes.
 * For successful renders it must create the output PNG at args[5] (the
 * rasterizer reads it back). Also records the source bytes (args[2]) and the
 * materialized helper content (args[0]) as they were seen DURING the call.
 */
class ScriptedCommandRunner implements PythonCommandRunner {
  readonly calls: Array<{
    command: string;
    args: readonly string[];
    options: { timeoutMs: number; maxBufferBytes: number };
    sourceBytes: Buffer | null;
    helperContent: string | null;
  }> = [];
  outcome: PythonCommandRunResult = {
    status: 0,
    stdout: "",
    stderr: "",
    error: null
  };
  /** When true, the renderer writes the fake PNG at the requested path. */
  producePng = false;
  pngBytes = fakePngBytes(1, 72);

  run(
    command: string,
    args: readonly string[],
    options: { timeoutMs: number; maxBufferBytes: number }
  ): PythonCommandRunResult {
    this.calls.push({
      command,
      args: [...args],
      options,
      sourceBytes: args[2] === undefined ? null : readFileSync(args[2]),
      helperContent:
        args[0] === undefined ? null : readFileSync(args[0], "utf8")
    });
    if (this.producePng) {
      const pngPath = args[5];
      if (pngPath !== undefined) writeFileSync(pngPath, this.pngBytes);
    }
    return this.outcome;
  }
}

/** Repo helper source (the default resolution target under vitest). */
function repoHelperSource(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return readFileSync(path.join(moduleDir, PYTHON_PDFIUM_HELPER_FILE_NAME), "utf8");
}

/** Fresh private temp base dir for one test (removed afterwards). */
function tempBase(): string {
  return mkdtempSync(path.join(os.tmpdir(), "swpanel-pdfium-test-"));
}

function remainingWorkDirs(base: string): string[] {
  return readdirSync(base).filter((entry) => entry.startsWith("swpanel-pdfium-"));
}

const hasPython = (() => {
  const probe = spawnSync("python", ["--version"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  return probe.error === undefined && probe.status === 0;
})();

describe("Phase 5 Batch E PythonPdfiumRasterizer", () => {
  it("defines the engine identity and bounded-execution constants", () => {
    expect(PYTHON_PDFIUM_RASTERIZER_ID).toBe("swpanel-python-pdfium-rasterizer");
    expect(PYTHON_PDFIUM_HELPER_FILE_NAME).toBe("pdfium-rasterizer-helper.py");
    expect(PYTHON_PDFIUM_RASTERIZER_UNKNOWN_VERSION).toBe("unknown");
    expect(PYTHON_PDFIUM_INSPECT_TIMEOUT_MS).toBe(10_000);
    expect(PYTHON_PDFIUM_RENDER_TIMEOUT_MS).toBe(30_000);
    expect(PYTHON_PDFIUM_MAX_BUFFER_BYTES).toBe(1_000_000);
  });

  it("resolves the repository helper by default and reports an unknown version until the first handshake", () => {
    const rasterizer = new PythonPdfiumRasterizer();
    expect(rasterizer.id).toBe(PYTHON_PDFIUM_RASTERIZER_ID);
    expect(rasterizer.version).toBe(PYTHON_PDFIUM_RASTERIZER_UNKNOWN_VERSION);
  });

  it("inspects through the helper: source bytes and helper are materialized in a private temp dir, JSON is parsed, the temp dir is removed", () => {
    const runner = new ScriptedCommandRunner();
    runner.outcome = {
      status: 0,
      stdout: JSON.stringify({ ok: true, pageCount: 3, rendererVersion: "pypdfium2 4.30.0" }),
      stderr: "",
      error: null
    };
    const base = tempBase();
    try {
      const rasterizer = new PythonPdfiumRasterizer({ tempDir: base, run: runner });
      const result = rasterizer.inspect(SOURCE_BYTES);

      expect(result).toEqual({ ok: true, pageCount: 3 });
      expect(rasterizer.version).toBe("pypdfium2 4.30.0");

      expect(runner.calls).toHaveLength(1);
      const call = runner.calls[0]!;
      expect(call.command).toBe("python");
      expect(call.args[0]).toBeTruthy();
      expect(path.basename(call.args[0]!)).toBe(PYTHON_PDFIUM_HELPER_FILE_NAME);
      expect(call.args[1]).toBe("inspect");
      expect(path.basename(call.args[2]!)).toBe("source.pdf");
      expect(call.options).toEqual({
        timeoutMs: PYTHON_PDFIUM_INSPECT_TIMEOUT_MS,
        maxBufferBytes: PYTHON_PDFIUM_MAX_BUFFER_BYTES
      });
      // The exact immutable bytes were handed to the helper.
      expect(call.sourceBytes?.equals(SOURCE_BYTES)).toBe(true);
      // The helper was materialized with the exact repository source (the
      // packaged-asar spawn path).
      expect(call.helperContent).toBe(repoHelperSource());
      // The private temp dir was fully cleaned up.
      expect(remainingWorkDirs(base)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("maps the helper's structured INVALID_PDF failure through unchanged", () => {
    const runner = new ScriptedCommandRunner();
    runner.outcome = {
      status: 1,
      stdout: JSON.stringify({ ok: false, code: "INVALID_PDF", message: "not a PDF" }),
      stderr: "",
      error: null
    };
    const result = new PythonPdfiumRasterizer({ run: runner }).inspect(SOURCE_BYTES);
    expect(result).toEqual({ ok: false, code: "INVALID_PDF", message: "not a PDF" });
    expect(runner.calls).toHaveLength(1);
  });

  it("maps a spawn-level failure (missing python / timeout / buffer overflow) to RENDER_FAILED", () => {
    const runner = new ScriptedCommandRunner();
    runner.outcome = {
      status: null,
      stdout: "",
      stderr: "",
      error: "spawnSync python ETIMEDOUT"
    };
    const base = tempBase();
    try {
      const result = new PythonPdfiumRasterizer({ tempDir: base, run: runner }).inspect(
        SOURCE_BYTES
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("RENDER_FAILED");
      expect(result.message).toContain("ETIMEDOUT");
      // Cleanup also happens when the invocation never produced JSON.
      expect(remainingWorkDirs(base)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("fails closed with RENDER_FAILED when the helper output is not parseable JSON", () => {
    const runner = new ScriptedCommandRunner();
    runner.outcome = { status: 0, stdout: "traceback noise\n", stderr: "", error: null };
    const result = new PythonPdfiumRasterizer({ run: runner }).inspect(SOURCE_BYTES);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RENDER_FAILED");
    expect(result.message).toContain("inspect");
  });

  it("fails closed with RENDER_FAILED when the helper reports an invalid page count", () => {
    const runner = new ScriptedCommandRunner();
    runner.outcome = {
      status: 0,
      stdout: JSON.stringify({ ok: true, pageCount: 0, rendererVersion: "pypdfium2 4.30.0" }),
      stderr: "",
      error: null
    };
    const result = new PythonPdfiumRasterizer({ run: runner }).inspect(SOURCE_BYTES);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("RENDER_FAILED");
  });

  it("rasterizes through the helper: PNG is read back with the ACTUAL metrics and the temp dir is removed", () => {
    const runner = new ScriptedCommandRunner();
    runner.producePng = true;
    runner.pngBytes = fakePngBytes(1, 150);
    runner.outcome = {
      status: 0,
      stdout: renderEnvelope({ widthPx: 1275, heightPx: 1650, dpi: 150 }),
      stderr: "",
      error: null
    };
    const base = tempBase();
    try {
      const rasterizer = new PythonPdfiumRasterizer({ tempDir: base, run: runner });
      const result = rasterizer.rasterize({ sourceBytes: SOURCE_BYTES, pageNumber: 1, dpi: 150 });

      expect(result).toEqual({
        ok: true,
        image: runner.pngBytes,
        widthPx: 1275,
        heightPx: 1650,
        dpi: 150,
        pageNumber: 1
      });
      expect(rasterizer.version).toBe("pypdfium2 4.30.0");

      const call = runner.calls[0]!;
      expect(call.args[1]).toBe("render");
      expect(call.args[3]).toBe("1");
      expect(call.args[4]).toBe("150");
      expect(path.basename(call.args[5]!)).toBe("output.png");
      expect(call.options).toEqual({
        timeoutMs: PYTHON_PDFIUM_RENDER_TIMEOUT_MS,
        maxBufferBytes: PYTHON_PDFIUM_MAX_BUFFER_BYTES
      });
      expect(remainingWorkDirs(base)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("fails closed when the helper reports having rendered a DIFFERENT page than requested", () => {
    const runner = new ScriptedCommandRunner();
    runner.producePng = true;
    runner.outcome = {
      status: 0,
      stdout: renderEnvelope({ pageNumber: 2 }),
      stderr: "",
      error: null
    };
    const result = new PythonPdfiumRasterizer({ run: runner }).rasterize({
      sourceBytes: SOURCE_BYTES,
      pageNumber: 1,
      dpi: 72
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("RENDER_FAILED");
      expect(result.message).toContain("instead of requested page 1");
    }
  });

  it("fails closed when the helper claims success but wrote no PNG or an empty PNG", () => {
    const missing = new ScriptedCommandRunner();
    missing.outcome = { status: 0, stdout: renderEnvelope(), stderr: "", error: null };
    const missingResult = new PythonPdfiumRasterizer({ run: missing }).rasterize({
      sourceBytes: SOURCE_BYTES,
      pageNumber: 1,
      dpi: 72
    });
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.message).toContain("no PNG");

    const empty = new ScriptedCommandRunner();
    empty.producePng = true;
    empty.pngBytes = Buffer.alloc(0);
    empty.outcome = { status: 0, stdout: renderEnvelope(), stderr: "", error: null };
    const emptyResult = new PythonPdfiumRasterizer({ run: empty }).rasterize({
      sourceBytes: SOURCE_BYTES,
      pageNumber: 1,
      dpi: 72
    });
    expect(emptyResult.ok).toBe(false);
    if (!emptyResult.ok) expect(emptyResult.message).toContain("empty PNG");
  });

  it("fails closed on inconsistent ACTUAL metrics reported by the helper", () => {
    for (const overrides of [
      { widthPx: 0 },
      { heightPx: -1 },
      { dpi: 0 },
      { pageCount: 0 }
    ]) {
      const runner = new ScriptedCommandRunner();
      runner.producePng = true;
      runner.outcome = {
        status: 0,
        stdout: renderEnvelope(overrides),
        stderr: "",
        error: null
      };
      const result = new PythonPdfiumRasterizer({ run: runner }).rasterize({
        sourceBytes: SOURCE_BYTES,
        pageNumber: 1,
        dpi: 72
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects invalid requests WITHOUT invoking the helper", () => {
    const runner = new ScriptedCommandRunner();
    const rasterizer = new PythonPdfiumRasterizer({ run: runner });

    const badPage = rasterizer.rasterize({ sourceBytes: SOURCE_BYTES, pageNumber: 0, dpi: 72 });
    expect(badPage.ok).toBe(false);
    const badDpi = rasterizer.rasterize({ sourceBytes: SOURCE_BYTES, pageNumber: 1, dpi: 0 });
    expect(badDpi.ok).toBe(false);
    const emptySource = rasterizer.inspect(Buffer.alloc(0));
    expect(emptySource.ok).toBe(false);
    if (!emptySource.ok) expect(emptySource.code).toBe("INVALID_PDF");

    expect(runner.calls).toHaveLength(0);
  });

  it("forwards injected python executable, timeouts and buffer bounds to the spawn seam", () => {
    const runner = new ScriptedCommandRunner();
    runner.outcome = {
      status: 0,
      stdout: JSON.stringify({ ok: true, pageCount: 1, rendererVersion: "pypdfium2 4.30.0" }),
      stderr: "",
      error: null
    };
    const rasterizer = new PythonPdfiumRasterizer({
      pythonExecutable: "python3.13",
      inspectTimeoutMs: 1234,
      renderTimeoutMs: 5678,
      maxBufferBytes: 4096,
      run: runner
    });
    rasterizer.inspect(SOURCE_BYTES);
    rasterizer.rasterize({ sourceBytes: SOURCE_BYTES, pageNumber: 1, dpi: 72 });

    expect(runner.calls[0]!.command).toBe("python3.13");
    expect(runner.calls[0]!.options).toEqual({ timeoutMs: 1234, maxBufferBytes: 4096 });
    expect(runner.calls[1]!.options).toEqual({ timeoutMs: 5678, maxBufferBytes: 4096 });
  });

  it("rejects an empty or missing helper, empty python executable and empty temp dir", () => {
    const base = tempBase();
    try {
      const emptyHelper = path.join(base, "empty-helper.py");
      writeFileSync(emptyHelper, "");
      expect(
        () => new PythonPdfiumRasterizer({ helperPath: emptyHelper })
      ).toThrow(/empty/);
      expect(
        () => new PythonPdfiumRasterizer({ helperPath: path.join(base, "missing.py") })
      ).toThrow(/not found/);
      expect(
        () => new PythonPdfiumRasterizer({ pythonExecutable: "" })
      ).toThrow(/pythonExecutable/);
      expect(() => new PythonPdfiumRasterizer({ tempDir: "" })).toThrow(/tempDir/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("probes availability: reports the exact renderer version and updates the version state", () => {
    const runner = new ScriptedCommandRunner();
    runner.outcome = {
      status: 0,
      stdout: JSON.stringify({ ok: true, available: true, rendererVersion: "pypdfium2 4.30.0" }),
      stderr: "",
      error: null
    };
    const base = tempBase();
    try {
      const rasterizer = new PythonPdfiumRasterizer({ tempDir: base, run: runner });
      expect(rasterizer.probeAvailability()).toEqual({
        available: true,
        version: "pypdfium2 4.30.0"
      });
      expect(rasterizer.version).toBe("pypdfium2 4.30.0");

      expect(runner.calls).toHaveLength(1);
      const call = runner.calls[0]!;
      expect(call.command).toBe("python");
      expect(path.basename(call.args[0]!)).toBe(PYTHON_PDFIUM_HELPER_FILE_NAME);
      expect(call.args[1]).toBe("probe");
      expect(call.options).toEqual({
        timeoutMs: PYTHON_PDFIUM_INSPECT_TIMEOUT_MS,
        maxBufferBytes: PYTHON_PDFIUM_MAX_BUFFER_BYTES
      });
      // The private temp dir was fully cleaned up.
      expect(remainingWorkDirs(base)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("maps the probe failures onto the structured unavailability reasons", () => {
    const missingPdfium = new ScriptedCommandRunner();
    missingPdfium.outcome = {
      status: 1,
      stdout: JSON.stringify({
        ok: false,
        code: "RENDERER_UNAVAILABLE",
        message: "pypdfium2 is not installed in the Python environment"
      }),
      stderr: "",
      error: null
    };
    expect(
      new PythonPdfiumRasterizer({ run: missingPdfium }).probeAvailability()
    ).toEqual({ available: false, version: null, reason: "PDFIUM_UNAVAILABLE" });

    const missingPython = new ScriptedCommandRunner();
    missingPython.outcome = {
      status: null,
      stdout: "",
      stderr: "",
      error: "spawnSync python ENOENT"
    };
    expect(
      new PythonPdfiumRasterizer({ run: missingPython }).probeAvailability()
    ).toEqual({ available: false, version: null, reason: "PYTHON_UNAVAILABLE" });

    const brokenContract = new ScriptedCommandRunner();
    brokenContract.outcome = { status: 0, stdout: "not json\n", stderr: "", error: null };
    expect(
      new PythonPdfiumRasterizer({ run: brokenContract }).probeAvailability()
    ).toEqual({ available: false, version: null, reason: "INVOCATION_FAILED" });

    const helperFailed = new ScriptedCommandRunner();
    helperFailed.outcome = {
      status: 1,
      stdout: JSON.stringify({ ok: false, code: "RENDER_FAILED", message: "unknown mode" }),
      stderr: "",
      error: null
    };
    expect(
      new PythonPdfiumRasterizer({ run: helperFailed }).probeAvailability()
    ).toEqual({ available: false, version: null, reason: "INVOCATION_FAILED" });
  });

  it("never includes raw helper stderr in spawn-failure descriptions", () => {
    const runner = new ScriptedCommandRunner();
    runner.outcome = {
      status: 1,
      stdout: "",
      stderr: `Traceback (most recent call last):\n  File "<temp>", line 1\nError: boom at ${os.tmpdir()}`,
      error: null
    };
    const result = new PythonPdfiumRasterizer({ run: runner }).inspect(SOURCE_BYTES);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("RENDER_FAILED");
    expect(result.message).not.toContain("Traceback");
    expect(result.message).not.toContain(os.tmpdir());
  });

  it("redacts absolute temp/user paths from helper-reported messages", () => {
    const runner = new ScriptedCommandRunner();
    const leakedPath = path.join(os.tmpdir(), "swpanel-pdfium-secret123", "source.pdf");
    runner.outcome = {
      status: 1,
      stdout: JSON.stringify({
        ok: false,
        code: "INVALID_PDF",
        message: `PDF 无法解析: ${leakedPath}`
      }),
      stderr: "",
      error: null
    };
    const result = new PythonPdfiumRasterizer({ run: runner }).inspect(SOURCE_BYTES);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_PDF");
    expect(result.message).not.toContain(os.tmpdir());
    // The default tempDir IS the OS temp dir, so the specific base is the
    // "<temp-dir>" placeholder (never the absolute path).
    expect(result.message).toContain("<temp-dir>");
  });
});

describe("DEFAULT_PYTHON_COMMAND_RUNNER (spawnSync seam)", () => {
  it("runs a real child process shell-free and captures stdout with the bounded options", () => {
    // process.execPath is always present, so this stays hermetic (no Python).
    const result = DEFAULT_PYTHON_COMMAND_RUNNER.run(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify({ ok: true, pageCount: 1 }))"],
      { timeoutMs: 5_000, maxBufferBytes: 65_536 }
    );
    expect(result.error).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"pageCount":1');
  });

  it("passes arguments verbatim without shell interpretation", () => {
    // With shell:false, shell metacharacters and expansions must reach the
    // child literally.
    const result = DEFAULT_PYTHON_COMMAND_RUNNER.run(
      process.execPath,
      ["-e", "process.stdout.write('a b $HOME && x')"],
      { timeoutMs: 5_000, maxBufferBytes: 65_536 }
    );
    expect(result.error).toBeNull();
    expect(result.stdout).toBe("a b $HOME && x");
  });
});

/**
 * Real end-to-end helper test: the synthetic PDF fixture created in this test
 * is inspected and rasterized by the REAL helper through the REAL spawnSync
 * path. Skipped on hosts without a usable `python` (CI without the pinned
 * Python environment) — this host has pypdfium2 4.30.0 + Pillow 11.3.0.
 */
describe.skipIf(!hasPython)("Phase 5 Batch E PythonPdfiumRasterizer (real helper)", () => {
  it("probes availability through the real helper and reports the real renderer version", () => {
    const rasterizer = new PythonPdfiumRasterizer();
    const availability = rasterizer.probeAvailability();
    expect(availability.available).toBe(true);
    expect(availability.version).toBe("pypdfium2 4.30.0");
    expect(rasterizer.version).toBe("pypdfium2 4.30.0");
  });

  it("inspects the synthetic PDF and rasterizes it to a real PNG with truthful metrics", () => {
    const pdfBytes = buildSyntheticPdf();
    const base = tempBase();
    try {
      const rasterizer = new PythonPdfiumRasterizer({ tempDir: base });

      const inspection = rasterizer.inspect(pdfBytes);
      expect(inspection).toEqual({ ok: true, pageCount: 1 });

      const result = rasterizer.rasterize({
        sourceBytes: pdfBytes,
        pageNumber: 1,
        dpi: 72
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // MediaBox 612x792 pt at exactly 72 dpi (scale 1.0) -> 612x792 px.
      expect(result.widthPx).toBe(612);
      expect(result.heightPx).toBe(792);
      expect(result.dpi).toBe(72);
      expect(result.pageNumber).toBe(1);
      expect(result.image.byteLength).toBeGreaterThan(0);
      expect(result.image.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
      expect(rasterizer.version).toBe("pypdfium2 4.30.0");
      // The private temp dir was removed after the real invocations.
      expect(remainingWorkDirs(base)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports an unparseable PDF as INVALID_PDF through the real helper", () => {
    const base = tempBase();
    try {
      const rasterizer = new PythonPdfiumRasterizer({ tempDir: base });
      const result = rasterizer.inspect(Buffer.from("this is definitely not a pdf", "utf8"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("INVALID_PDF");
        expect(result.message.length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
