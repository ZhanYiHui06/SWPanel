/**
 * The bounded, shell-free Python/pywin32 document-only closer of Phase 5
 * (Batch 2): the low-level `SolidWorksIdentityCloser` the live ownership
 * surface hands to the guard. It closes EXACTLY one verified document
 * identity per call and fails closed on ANY ambiguity or failure:
 *
 * - the helper ONLY attaches via `win32com.client.GetActiveObject` (never
 *   `Dispatch`/`Create` — no instance is ever spawned by the closer), reads
 *   the version attestation of the CURRENT open documents (`GetFirstDocument`
 *   / `GetNextDocument`), compares `GetPathName()` EXACTLY after canonical
 *   normalization (absolute, separator-canonical, case-folded — Windows
 *   Unicode paths compare case-insensitively), and closes ONLY the matched
 *   documents;
 * - the helper NEVER calls `ExitApp`/`Quit`, NEVER enumerates or kills
 *   processes by name, NEVER terminates any process — the only process that
 *   ever ends is the bounded helper child itself, killed by the Node side
 *   when a COM dispatch blocks past the hard bound;
 * - ZERO matches (a registered document is not open under its registered
 *   path — e.g. saved elsewhere or never created), MULTIPLE matches (one
 *   registered path matching several open documents — ambiguous), a COM /
 *   pywin32 failure, a helper timeout and any helper failure all THROW, so
 *   the guard reports `partial`/`failed` and the cancellation is never
 *   confirmed (CANCEL_CLEANUP_PENDING);
 * - the helper child runs `shell: false` with bounded `timeout`/`maxBuffer`
 *   (both stdout and stderr are capped), a hidden window on Windows, and
 *   error diagnostics are path-REDACTED before they reach any surface.
 *
 * The helper script ships as an inline template literal delivered via
 * `python -c <script>` (no temp file — asar-safe), exactly like the SolidWorks
 * COM probe helper (`preflight/solidworks-live-probe.ts`). The expected
 * document paths travel through a dedicated environment variable (UTF-16 by
 * construction of the Windows process environment), so Unicode paths survive
 * verbatim; the helper forces UTF-8 on its redirected stdout so the result
 * marker round-trips identically.
 */
import { spawnSync } from "node:child_process";

import type {
  SolidWorksDocumentIdentity,
  SolidWorksIdentity
} from "./solidworks-ownership-guard.js";
import type { PythonCommandRunResult } from "../../adaptation/python-pdfium-rasterizer.js";
import { redactSensitivePaths } from "../../adaptation/path-redaction.js";

/** The helper mode env var (must equal `close-documents`). */
const SOLIDWORKS_CLOSE_MODE_ENV = "SWPANEL_SW_CLOSE_MODE" as const;
/** The helper mode value of the document-close invocation. */
const SOLIDWORKS_CLOSE_MODE = "close-documents" as const;
/** Env var carrying the JSON array of expected absolute document paths. */
const SOLIDWORKS_CLOSE_EXPECTED_DOCS_ENV = "SWPANEL_SW_CLOSE_EXPECTED_DOCS" as const;
/** Env var carrying the helper-side soft deadline (ms). */
const SOLIDWORKS_CLOSE_DEADLINE_MS_ENV = "SWPANEL_SW_CLOSE_DEADLINE_MS" as const;
/** The stdout marker line prefix of the helper result. */
const SOLIDWORKS_CLOSE_RESULT_MARKER = "SWPANEL_SW_CLOSE_RESULT " as const;

/** Default Python argv of the document-close helper (pywin32 required). */
export const DEFAULT_SOLIDWORKS_CLOSE_PYTHON_COMMAND = ["python"] as const;

/**
 * Bounded hard bound of one close helper invocation (20 s): a COM dispatch
 * that blocks (e.g. an unsaved-changes dialog in the user's SolidWorks) can
 * never outlive this — the Node side terminates the helper child itself.
 */
export const DEFAULT_SOLIDWORKS_CLOSE_TIMEOUT_MS = 20_000 as const;

/**
 * Bounded capture of the helper's stdout/stderr (64 KB each): the result
 * marker is tiny; runaway output (a traceback flood) must never grow without
 * bound.
 */
export const DEFAULT_SOLIDWORKS_CLOSE_MAX_BUFFER_BYTES = 65_536 as const;

/** Structured failure of ONE document-close invocation (fail closed). */
export class SolidWorksDocumentCloseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolidWorksDocumentCloseError";
  }
}

/** The parsed helper result envelope of one close invocation. */
export type SolidWorksDocumentCloseHelperJson =
  | { ok: true; closed: readonly string[] }
  | { ok: false; code: string; message: string };

/** One synchronous helper invocation (the spawnSync seam, env included). */
export interface SolidWorksDocumentCloseRunInput {
  pythonCommand: readonly string[];
  /** The inline helper script (`python -c <script>`). */
  script: string;
  /** The helper protocol env vars (merged over the base environment). */
  env: Readonly<Record<string, string>>;
  /** Bounded hard bound (the child is terminated by the runner on timeout). */
  timeoutMs: number;
  /** Bounded stdout/stderr cap (applies to each pipe). */
  maxBufferBytes: number;
}

/** One synchronous helper invocation seam (hermetic tests script it). */
export interface SolidWorksDocumentCloseRunner {
  run(input: SolidWorksDocumentCloseRunInput): PythonCommandRunResult;
}

/**
 * Default runner over `spawnSync`: shell-free (no shell interpolation of the
 * Unicode document paths), bounded `timeout`/`maxBuffer`, hidden window on
 * Windows, and the helper protocol env vars merged over the base environment
 * (Node converts env strings to UTF-16 for CreateProcess, so Unicode document
 * paths survive verbatim). Mirrors the pdfium spawnSync seam and the probe
 * helper env protocol. On timeout the runner itself terminates the helper
 * child — the ONLY process the closer ever ends.
 */
export const DEFAULT_SOLIDWORKS_DOCUMENT_CLOSE_RUNNER: SolidWorksDocumentCloseRunner = {
  run: (input: SolidWorksDocumentCloseRunInput) => {
    const pythonExecutable = input.pythonCommand[0];
    if (pythonExecutable === undefined) {
      throw new SolidWorksDocumentCloseError(
        "the document closer has no configured Python command"
      );
    }
    const result = spawnSync(
      pythonExecutable,
      [...input.pythonCommand.slice(1), "-c", input.script],
      {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...input.env },
        timeout: input.timeoutMs,
        maxBuffer: input.maxBufferBytes
      }
    );
    return {
      status: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      error: result.error?.message ?? null
    };
  }
};

export interface SolidWorksDocumentCloserOptions {
  /** Python executable + leading args (default `["python"]`). */
  pythonCommand?: readonly string[];
  /** Bounded hard bound of one invocation (default 20 s). */
  timeoutMs?: number;
  /** Bounded stdout/stderr cap of one invocation (default 64 KB). */
  maxBufferBytes?: number;
  /** Injectable spawnSync seam (hermetic tests script it). */
  run?: SolidWorksDocumentCloseRunner;
  /** Path-redaction seam of failure messages (default redactSensitivePaths). */
  redact?: (message: string) => string;
}

/**
 * The bounded Python/pywin32 document-only closer. `close` accepts ONLY
 * document identities — a pid identity is refused loudly (this closer NEVER
 * closes a process); every document identity runs ONE bounded helper
 * invocation whose result decides success/failure (a throw makes the guard
 * report `partial`/`failed`, never a confirmed cancellation).
 */
export class SolidWorksDocumentCloser {
  private readonly pythonCommand: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly run: SolidWorksDocumentCloseRunner;
  private readonly redact: (message: string) => string;

  constructor(options: SolidWorksDocumentCloserOptions = {}) {
    this.pythonCommand = options.pythonCommand ?? DEFAULT_SOLIDWORKS_CLOSE_PYTHON_COMMAND;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SOLIDWORKS_CLOSE_TIMEOUT_MS;
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_SOLIDWORKS_CLOSE_MAX_BUFFER_BYTES;
    this.run = options.run ?? DEFAULT_SOLIDWORKS_DOCUMENT_CLOSE_RUNNER;
    this.redact = options.redact ?? ((message) => redactSensitivePaths(message));
  }

  close(identity: SolidWorksIdentity): void {
    if (identity.kind !== "document") {
      throw new SolidWorksDocumentCloseError(
        "the document closer refuses non-document identities (it never closes a process)"
      );
    }
    this.closeDocument(identity);
  }

  /** One bounded helper invocation for exactly one verified document. */
  private closeDocument(identity: SolidWorksDocumentIdentity): void {
    const outcome = this.run.run({
      pythonCommand: this.pythonCommand,
      script: SOLIDWORKS_DOCUMENT_CLOSE_SCRIPT,
      env: {
        [SOLIDWORKS_CLOSE_MODE_ENV]: SOLIDWORKS_CLOSE_MODE,
        [SOLIDWORKS_CLOSE_EXPECTED_DOCS_ENV]: JSON.stringify([identity.documentIdentity]),
        [SOLIDWORKS_CLOSE_DEADLINE_MS_ENV]: String(this.timeoutMs)
      },
      timeoutMs: this.timeoutMs,
      maxBufferBytes: this.maxBufferBytes
    });
    if (outcome.error !== null && outcome.error.length > 0) {
      // The child itself could not be spawned, was killed by the hard bound
      // (timeout) or overflowed the buffer: fail closed, redacted.
      throw new SolidWorksDocumentCloseError(
        `SolidWorks document close helper invocation failed (${this.redact(outcome.error)})`
      );
    }
    const parsed = parseCloseHelperJson(outcome);
    if (parsed === null) {
      throw new SolidWorksDocumentCloseError(
        "the SolidWorks document close helper produced no parseable result"
      );
    }
    if (!parsed.ok) {
      throw new SolidWorksDocumentCloseError(
        `SolidWorks document close helper failed: ${this.redact(parsed.message)}`
      );
    }
    if (
      parsed.closed.length !== 1 ||
      parsed.closed[0] !== identity.documentIdentity
    ) {
      // The helper must report EXACTLY the one original requested identity —
      // never only a normalized spelling and never extra documents. Internal
      // matching is canonicalized in Python, but the success envelope echoes
      // the Node-supplied path verbatim so this protocol check is unambiguous.
      throw new SolidWorksDocumentCloseError(
        "the SolidWorks document close helper reported closing a different or additional document"
      );
    }
  }
}

/**
 * Parses the helper's `SWPANEL_SW_CLOSE_RESULT <json>` marker line. Returns
 * null for a missing marker, malformed JSON, a non-object payload or an
 * unknown shape.
 */
export function parseCloseHelperJson(
  outcome: PythonCommandRunResult
): SolidWorksDocumentCloseHelperJson | null {
  const markerIndex = outcome.stdout.indexOf(SOLIDWORKS_CLOSE_RESULT_MARKER);
  if (markerIndex < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      outcome.stdout.slice(markerIndex + SOLIDWORKS_CLOSE_RESULT_MARKER.length).trim()
    );
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.ok === true) {
    if (!Array.isArray(record.closed) || record.closed.some((path) => typeof path !== "string")) {
      return null;
    }
    return { ok: true, closed: record.closed as readonly string[] };
  }
  if (record.ok === false) {
    if (typeof record.code !== "string" || typeof record.message !== "string") return null;
    return { ok: false, code: record.code, message: record.message };
  }
  return null;
}

/**
 * The Python/pywin32 document-close helper script (template literal; delivered
 * via `python -c <script>` — no temp file, asar-safe). ONE mode
 * (`close-documents`):
 *
 * 1. ATTACH-ONLY: `win32com.client.GetActiveObject("SldWorks.Application")`
 *    — never `Dispatch`/`Create`, so this helper NEVER spawns an instance;
 * 2. enumerate the CURRENT open documents (`GetFirstDocument` /
 *    `GetNextDocument`) and compare each `GetPathName()` EXACTLY after
 *    canonical normalization (`normpath` + `normcase` — absolute, separator-
 *    canonical, case-folded Windows Unicode paths);
 * 3. fail closed on ZERO matches for any expected document (not open under
 *    its registered path) and on MULTIPLE matches of one expected path
 *    (ambiguous — never close either);
 * 4. close ONLY the matched document objects (the document-object close;
 *    the app-level `CloseDoc(title)` fallback is used ONLY when the title is
 *    unique among the open documents, so an unrelated same-title document can
 *    never be closed); NEVER `ExitApp`/`Quit`, NEVER kill/enumerate processes;
 * 5. re-enumerate and verify NO expected path remains open (the close took
 *    effect);
 * 6. emit `SWPANEL_SW_CLOSE_RESULT <json>` on stdout.
 *
 * Any COM failure (including "no instance is running" — the closure cannot be
 * verified against a live enumeration), pywin32 unavailability and every
 * fail-closed condition above is reported as `ok: false`; the Node side maps
 * it onto a throw, and the Node-side hard bound terminates the helper child
 * itself when a COM dispatch blocks (the ONLY process the closer ever ends).
 *
 * Exported for the fail-closed contract test (the script must never grow a
 * process-level API); production callers receive it via `python -c <script>`.
 */
export const SOLIDWORKS_DOCUMENT_CLOSE_SCRIPT = String.raw`
import json
import os
import sys
import time

# Force UTF-8 on the redirected stdout pipe: the Node side decodes the result
# marker as UTF-8, so Unicode document paths round-trip verbatim.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

mode = os.environ.get("SWPANEL_SW_CLOSE_MODE", "")
if mode != "close-documents":
    sys.stderr.write("SWPANEL_SW_CLOSE_MODE must be 'close-documents'\n")
    sys.exit(1)

raw_expected = os.environ.get("SWPANEL_SW_CLOSE_EXPECTED_DOCS", "")
try:
    expected = json.loads(raw_expected)
except Exception:
    sys.stderr.write("SWPANEL_SW_CLOSE_EXPECTED_DOCS must be a JSON array of paths\n")
    sys.exit(2)
if not isinstance(expected, list) or len(expected) == 0:
    sys.stderr.write("SWPANEL_SW_CLOSE_EXPECTED_DOCS must be a non-empty JSON array\n")
    sys.exit(3)
if not all(isinstance(p, str) and p for p in expected):
    sys.stderr.write("expected documents must be non-empty strings\n")
    sys.exit(4)

try:
    deadline_ms = float(os.environ.get("SWPANEL_SW_CLOSE_DEADLINE_MS", "") or 20000)
except ValueError:
    deadline_ms = 20000
if deadline_ms <= 0:
    deadline_ms = 20000
deadline = time.monotonic() + deadline_ms / 1000.0

def normalize(path):
    # Canonical exact-match normalization: absolute, separators canonicalized,
    # case folded (Windows paths compare case-insensitively; Unicode survives).
    return os.path.normcase(os.path.normpath(path))

expected_norm = [normalize(p) for p in expected]

result = {"ok": True, "closed": [], "code": "", "message": ""}

try:
    import pythoncom
    import win32com.client
except Exception:
    result = {"ok": False, "code": "COM_UNAVAILABLE", "message": "python or pywin32 unavailable"}
    print("SWPANEL_SW_CLOSE_RESULT " + json.dumps(result, separators=(",", ":")))
    sys.exit(0)

try:
    pythoncom.CoInitialize()
    try:
        if time.monotonic() >= deadline:
            raise RuntimeError("deadline reached before enumeration")
        # ATTACH-ONLY: GetActiveObject never creates an instance — it resolves
        # the already-running object in the ROT (or raises when none exists).
        sw = win32com.client.GetActiveObject("SldWorks.Application")
        if time.monotonic() >= deadline:
            raise RuntimeError("deadline reached before enumeration")
        open_docs = []
        doc = sw.GetFirstDocument()
        while doc is not None:
            open_docs.append(doc)
            doc = doc.GetNextDocument()
        # Normalized EXACT GetPathName comparison: an unsaved/unreadable path
        # (empty or throwing GetPathName) can never match and can never close.
        matched = {}
        for d in open_docs:
            try:
                raw_path = str(d.GetPathName())
            except Exception:
                continue
            if not raw_path:
                continue
            np = normalize(raw_path)
            if np in expected_norm:
                matched.setdefault(np, []).append(d)
        # Fail closed: EVERY expected document must be found open exactly once.
        for np in expected_norm:
            matches = matched.get(np, [])
            if len(matches) == 0:
                raise RuntimeError("registered document not found open (0 matches)")
            if len(matches) > 1:
                raise RuntimeError("registered document matched multiple open documents")
        # Close ONLY the matched documents. Prefer the document-object close;
        # fall back to the app-level CloseDoc(title) ONLY when the title is
        # unique among the open documents (never ambiguous).
        closed = []
        for index, np in enumerate(expected_norm):
            doc = matched[np][0]
            title = str(doc.GetTitle())
            try:
                doc.CloseDoc()
            except Exception:
                if [str(d.GetTitle()) for d in open_docs].count(title) != 1:
                    raise RuntimeError("cannot close registered document unambiguously")
                sw.CloseDoc(title)
            # Matching uses the canonicalized path, but the protocol envelope
            # echoes the original Node-supplied identity verbatim so the caller
            # can prove exactly which requested document was closed.
            closed.append(expected[index])
        # Re-verify: no expected path may remain open after the close.
        remaining = []
        doc = sw.GetFirstDocument()
        while doc is not None:
            try:
                np = normalize(str(doc.GetPathName()))
            except Exception:
                np = ""
            if np in expected_norm:
                remaining.append(np)
            doc = doc.GetNextDocument()
        if remaining:
            raise RuntimeError("registered documents still open after close")
        result = {"ok": True, "closed": closed, "code": "", "message": ""}
    finally:
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass
except Exception as e:
    result = {"ok": False, "code": "CLOSE_FAILED", "message": str(e)}

print("SWPANEL_SW_CLOSE_RESULT " + json.dumps(result, separators=(",", ":")))
`;
