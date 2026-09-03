import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SOLIDWORKS_CLOSE_MAX_BUFFER_BYTES,
  DEFAULT_SOLIDWORKS_CLOSE_TIMEOUT_MS,
  SOLIDWORKS_DOCUMENT_CLOSE_SCRIPT,
  SolidWorksDocumentCloseError,
  SolidWorksDocumentCloser,
  type SolidWorksDocumentCloseRunInput,
  type SolidWorksDocumentCloseRunner
} from "./solidworks-document-closer.js";
import type { PythonCommandRunResult } from "../../adaptation/python-pdfium-rasterizer.js";
import type { SolidWorksIdentity } from "./solidworks-ownership-guard.js";
import { DEFAULT_CANCEL_CLEANUP_LEASE_MINIMUM_MS } from "../../orchestration/run-orchestrator.js";

/** The expected absolute path of one registered document. */
const DOC_PATH = "C:\\workspaces\\runs\\run-1\\attempt-001\\working\\底板-法兰.sldprt";

function okOutcome(): PythonCommandRunResult {
  return {
    status: 0,
    stdout: `SWPANEL_SW_CLOSE_RESULT ${JSON.stringify({ ok: true, closed: [DOC_PATH] })}`,
    stderr: "",
    error: null
  };
}

/** Scripted runner: records every invocation, returns the canned outcome. */
function scriptedRunner(outcome: () => PythonCommandRunResult) {
  const calls: SolidWorksDocumentCloseRunInput[] = [];
  const run = vi.fn<SolidWorksDocumentCloseRunner["run"]>(() => outcome());
  return {
    calls,
    runner: {
      run: (input: SolidWorksDocumentCloseRunInput) => {
        calls.push(input);
        return run(input);
      }
    } satisfies SolidWorksDocumentCloseRunner,
    run
  };
}

function closerWith(runner: SolidWorksDocumentCloseRunner, redact?: (message: string) => string) {
  return new SolidWorksDocumentCloser({
    run: runner,
    ...(redact === undefined ? {} : { redact })
  });
}

function documentIdentityOf(path: string): SolidWorksIdentity {
  return { kind: "document", documentIdentity: path };
}

describe("the live cleanup duration bound (single-part contract + closer hard bound)", () => {
  it("the cancel-cleanup fence lease minimum strictly exceeds the document-closer hard timeout", () => {
    // The orchestrator's fence deadline is max(run lease, this minimum). The
    // live cleanup is fully synchronous and closes EXACTLY ONE document (the
    // Phase 5 single-part registry maximum) with ONE closer invocation whose
    // hard bound is DEFAULT_SOLIDWORKS_CLOSE_TIMEOUT_MS — so a 60 s fence
    // lease provably bounds the 20 s close helper with margin for the
    // snapshot / delete / confirm steps (see the orchestrator constant doc).
    expect(DEFAULT_CANCEL_CLEANUP_LEASE_MINIMUM_MS).toBeGreaterThan(
      DEFAULT_SOLIDWORKS_CLOSE_TIMEOUT_MS
    );
    expect(DEFAULT_CANCEL_CLEANUP_LEASE_MINIMUM_MS - DEFAULT_SOLIDWORKS_CLOSE_TIMEOUT_MS).toBeGreaterThanOrEqual(
      40_000
    );
  });
});

describe("SolidWorksDocumentCloser (bounded shell:false python/pywin32 document-only closer)", () => {
  it("refuses non-document identities (the closer NEVER closes a process)", () => {
    const closer = closerWith(scriptedRunner(okOutcome).runner);
    expect(() => closer.close({ kind: "pid", pid: 101 })).toThrow(SolidWorksDocumentCloseError);
    expect(() => closer.close({ kind: "pid", pid: 101 })).toThrow(/never closes a process/);
  });

  it("closes a verified document through ONE bounded helper invocation carrying the exact path", () => {
    const { calls, run, runner } = scriptedRunner(okOutcome);
    const closer = closerWith(runner);
    closer.close(documentIdentityOf(DOC_PATH));
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    const input = calls[0]!;
    expect(input.pythonCommand).toEqual(["python"]);
    expect(input.script).toContain("GetActiveObject");
    expect(input.env["SWPANEL_SW_CLOSE_MODE"]).toBe("close-documents");
    expect(input.env["SWPANEL_SW_CLOSE_EXPECTED_DOCS"]).toBe(JSON.stringify([DOC_PATH]));
    expect(input.env["SWPANEL_SW_CLOSE_DEADLINE_MS"]).toBe(String(DEFAULT_SOLIDWORKS_CLOSE_TIMEOUT_MS));
    expect(input.timeoutMs).toBe(DEFAULT_SOLIDWORKS_CLOSE_TIMEOUT_MS);
    expect(input.maxBufferBytes).toBe(DEFAULT_SOLIDWORKS_CLOSE_MAX_BUFFER_BYTES);
  });

  it("passes the configured Python command and bounds through the seam", () => {
    const { calls, runner } = scriptedRunner(okOutcome);
    const closer = new SolidWorksDocumentCloser({
      pythonCommand: ["py", "-3"],
      timeoutMs: 1234,
      maxBufferBytes: 2048,
      run: runner
    });
    closer.close(documentIdentityOf(DOC_PATH));
    const input = calls[0]!;
    expect(input.pythonCommand).toEqual(["py", "-3"]);
    expect(input.timeoutMs).toBe(1234);
    expect(input.maxBufferBytes).toBe(2048);
  });

  it("THROWS on a zero-match helper result (registered document not open) — fail closed", () => {
    const { runner } = scriptedRunner(() => ({
      status: 0,
      stdout:
        "SWPANEL_SW_CLOSE_RESULT " +
        JSON.stringify({
          ok: false,
          code: "CLOSE_FAILED",
          message: "registered document not found open (0 matches)"
        }),
      stderr: "",
      error: null
    }));
    const closer = closerWith(runner);
    expect(() => closer.close(documentIdentityOf(DOC_PATH))).toThrow(SolidWorksDocumentCloseError);
    expect(() => closer.close(documentIdentityOf(DOC_PATH))).toThrow(/0 matches/);
  });

  it("THROWS on a multiple-match helper result (ambiguous) — fail closed", () => {
    const { runner } = scriptedRunner(() => ({
      status: 0,
      stdout:
        "SWPANEL_SW_CLOSE_RESULT " +
        JSON.stringify({
          ok: false,
          code: "CLOSE_FAILED",
          message: "registered document matched multiple open documents"
        }),
      stderr: "",
      error: null
    }));
    const closer = closerWith(runner);
    expect(() => closer.close(documentIdentityOf(DOC_PATH))).toThrow(/multiple open documents/);
  });

  it("THROWS on COM unavailability (pywin32 missing) — fail closed", () => {
    const { runner } = scriptedRunner(() => ({
      status: 0,
      stdout:
        "SWPANEL_SW_CLOSE_RESULT " +
        JSON.stringify({ ok: false, code: "COM_UNAVAILABLE", message: "python or pywin32 unavailable" }),
      stderr: "",
      error: null
    }));
    const closer = closerWith(runner);
    expect(() => closer.close(documentIdentityOf(DOC_PATH))).toThrow(/pywin32 unavailable/);
  });

  it("THROWS on a helper timeout (the child was terminated by the runner) — fail closed, redacted", () => {
    const { runner } = scriptedRunner(() => ({
      status: null,
      stdout: "",
      stderr: "",
      error: "spawnSync ETIMEDOUT"
    }));
    const closer = closerWith(runner);
    expect(() => closer.close(documentIdentityOf(DOC_PATH))).toThrow(
      /helper invocation failed \(spawnSync ETIMEDOUT\)/
    );
  });

  it("THROWS when the helper produced no parseable result (broken contract)", () => {
    const { runner } = scriptedRunner(() => ({
      status: 0,
      stdout: "garbage without a marker",
      stderr: "",
      error: null
    }));
    const closer = closerWith(runner);
    expect(() => closer.close(documentIdentityOf(DOC_PATH))).toThrow(/no parseable result/);
  });

  it("THROWS when the helper reports closing a DIFFERENT or additional document (broken contract)", () => {
    for (const closed of [
      ["C:\\other.sldprt"],
      [DOC_PATH, "C:\\other.sldprt"]
    ]) {
      const { runner } = scriptedRunner(() => ({
        status: 0,
        stdout: `SWPANEL_SW_CLOSE_RESULT ${JSON.stringify({ ok: true, closed })}`,
        stderr: "",
        error: null
      }));
      const closer = closerWith(runner);
      expect(() => closer.close(documentIdentityOf(DOC_PATH))).toThrow(
        /different or additional document/
      );
    }
  });

  it("REDACTS absolute user/temp paths from helper failure messages", () => {
    const { runner } = scriptedRunner(() => ({
      status: 0,
      stdout:
        "SWPANEL_SW_CLOSE_RESULT " +
        JSON.stringify({
          ok: false,
          code: "CLOSE_FAILED",
          message: `traceback at C:\\Users\\someone\\AppData\\Local\\Temp\\swpanel-x`
        }),
      stderr: "",
      error: null
    }));
    const redact = vi.fn((message: string) => message.replace(/C:\\Users\\[^\\]+/, "C:\\<user>"));
    const closer = closerWith(runner, redact);
    try {
      closer.close(documentIdentityOf(DOC_PATH));
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SolidWorksDocumentCloseError);
      expect(String(error)).not.toContain("someone");
      expect(String(error)).toContain("C:\\<user>");
      expect(redact).toHaveBeenCalled();
    }
  });

  it("uses the default path redaction when none is injected", () => {
    const { runner } = scriptedRunner(() => ({
      status: null,
      stdout: "",
      stderr: "",
      error: `spawn ENOENT ${process.env.USERPROFILE ?? "C:\\Users\\x"}`
    }));
    const closer = closerWith(runner);
    try {
      closer.close(documentIdentityOf(DOC_PATH));
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SolidWorksDocumentCloseError);
      expect(String(error)).not.toContain(process.env.USERPROFILE ?? "C:\\Users\\x");
    }
  });

  it("exposes NO kill/enumerate/process-termination surface (document-only by construction)", () => {
    const proto = Object.getOwnPropertyNames(SolidWorksDocumentCloser.prototype).sort();
    const instance = new SolidWorksDocumentCloser({
      run: scriptedRunner(okOutcome).runner
    });
    const forbiddenPattern = /kill|terminate|exitapp|quit|taskkill|enumerateProcess|getprocess/i;
    for (const name of [...proto, ...Object.getOwnPropertyNames(instance)]) {
      expect(name).not.toMatch(forbiddenPattern);
    }
    // The runtime surface stays exactly the guard-facing `close` (plus the
    // constructor and the private helper the class needs internally).
    expect(instance).toBeDefined();
    expect(typeof instance.close).toBe("function");
  });
});

describe("the helper script contract (no process-level API, ever)", () => {
  it("contains NO ExitApp/Quit, process kill or process enumeration", () => {
    // The script is an exported module constant; the test pins the fail-closed
    // contract (a future regression adding ExitApp/Quit/taskkill/os.kill
    // breaks here).
    const source = SOLIDWORKS_DOCUMENT_CLOSE_SCRIPT;
    expect(source).not.toMatch(/ExitApp|QuitDoc|\bQuit\b|taskkill|os\.kill|TerminateProcess/i);
    expect(source).toContain("GetActiveObject");
    expect(source).toContain("GetPathName");
    expect(source).toContain("CloseDoc");
    // The closer never names a process or enumerates processes.
    expect(source).not.toMatch(/SLDWORKS\.exe|GetProcessID|enumerateProcess/i);
  });
});
