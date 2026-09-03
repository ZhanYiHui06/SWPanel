import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import {
  InvalidArgumentError,
  LedgerEscapeDetectedError,
  LedgerFileMissingError,
  LedgerPathUnsafeError
} from "../errors.js";
import { makeTempDir, removeTempDir, sha256Of } from "../test-utils.js";
import {
  RUN_WORKSPACE_RELATIVE_DIR,
  RUN_WORKSPACE_SUBDIRS,
  RunWorkspaceLedger,
  type StoredRunFile
} from "./run-workspace-ledger.js";

const RUN_A = "run-a-000000000000";
const RUN_B = "run-b-000000000000";

describe("RunWorkspaceLedger", () => {
  let dir: string;
  let workspaceRoot: string;
  let ledger: RunWorkspaceLedger;

  beforeAll(() => {
    dir = makeTempDir("run-workspace");
    workspaceRoot = join(dir, "workspaces");
    ledger = new RunWorkspaceLedger({ workspaceRoot });
    ledger.open();
  });
  afterAll(() => {
    ledger.close();
    removeTempDir(dir);
  });

  it("creates the six attempt directories with the canonical layout", () => {
    const layout = ledger.createAttemptWorkspace(RUN_A, 7);
    expect(layout.attemptLabel).toBe("attempt-007");
    expect(layout.relativeRoot).toBe(`${RUN_WORKSPACE_RELATIVE_DIR}/${RUN_A}/attempt-007`);
    expect(existsSync(layout.absoluteRoot)).toBe(true);
    for (const subdir of RUN_WORKSPACE_SUBDIRS) {
      const entry = layout.directories[subdir];
      expect(entry.relativePath).toBe(`${layout.relativeRoot}/${subdir}`);
      expect(entry.relativePath.includes("\\")).toBe(false);
      expect(existsSync(entry.absolutePath)).toBe(true);
    }
  });

  it("computes the layout without touching the disk", () => {
    const layout = ledger.workspaceLayout(RUN_B, 1);
    expect(layout.relativeRoot).toBe(`${RUN_WORKSPACE_RELATIVE_DIR}/${RUN_B}/attempt-001`);
    expect(existsSync(layout.absoluteRoot)).toBe(false);
    expect(existsSync(join(layout.absoluteRoot, ".."))).toBe(false);
  });

  it("rejects unsafe run ids and attempt sequences", () => {
    for (const badRunId of ["../escape", "a/b", "C:\\evil", "with space", ""]) {
      expect(() => ledger.workspaceLayout(badRunId, 1)).toThrowError(InvalidArgumentError);
    }
    for (const badAttempt of [0, -1, 1.5, Number.NaN]) {
      expect(() => ledger.workspaceLayout(RUN_A, badAttempt)).toThrowError(InvalidArgumentError);
    }
  });

  it("writes owned files with hash and size and verifies the bytes", () => {
    const content = Buffer.from("run workspace bytes 工作区");
    const stored: StoredRunFile = ledger.writeOwnedFile({
      runId: RUN_A,
      attemptSequence: 2,
      relativePath: "output/report.json",
      content
    });
    expect(stored.relativePath).toBe(`${RUN_WORKSPACE_RELATIVE_DIR}/${RUN_A}/attempt-002/output/report.json`);
    expect(stored.sha256).toBe(sha256Of(content));
    expect(stored.sizeBytes).toBe(content.byteLength);
    expect(readFileSync(stored.absolutePath)).toEqual(content);
    const layout = ledger.workspaceLayout(RUN_A, 2);
    expect(existsSync(join(layout.directories.output.absolutePath, "report.json"))).toBe(true);
  });

  it("rejects path escapes in owned file paths", () => {
    const content = Buffer.from("escape attempt");
    for (const bad of [
      "../evil.txt",
      "..\\evil.txt",
      "a/../../evil.txt",
      "C:/windows/evil.txt",
      "/etc/evil.txt",
      "sub/../.."
    ]) {
      expect(() =>
        ledger.writeOwnedFile({ runId: RUN_A, attemptSequence: 3, relativePath: bad, content })
      ).toThrowError(LedgerPathUnsafeError);
    }
  });

  it("reads owned files back with the same hash/size guards (P4-5 validator surface)", () => {
    const content = Buffer.from("readable run workspace bytes 可读工作区");
    const stored = ledger.writeOwnedFile({
      runId: RUN_A,
      attemptSequence: 6,
      relativePath: "output/artifact.bin",
      content
    });
    const read = ledger.readOwnedFile({
      runId: RUN_A,
      attemptSequence: 6,
      relativePath: "output/artifact.bin"
    });
    expect(read).not.toBeNull();
    expect(read?.content).toEqual(content);
    expect(read?.sha256).toBe(sha256Of(content));
    expect(read?.sizeBytes).toBe(content.byteLength);
    expect(read?.relativePath).toBe(stored.relativePath);
    // The read surface reports null for a missing file (never a raw error).
    expect(
      ledger.readOwnedFile({ runId: RUN_A, attemptSequence: 6, relativePath: "output/missing.bin" })
    ).toBeNull();
    // Unsafe and escaping paths are refused exactly like writes.
    for (const bad of ["../evil.txt", "C:/windows/evil.txt", "/etc/evil.txt", "sub/../.."]) {
      expect(() =>
        ledger.readOwnedFile({ runId: RUN_A, attemptSequence: 6, relativePath: bad })
      ).toThrowError(LedgerPathUnsafeError);
    }
  });

  it("refuses to read through symlink/junction components (P4-5 escape guard)", () => {
    // Pre-create runs/{RUN_JUNCTION_READ} as a junction pointing outside the
    // workspace root; the read surface must refuse the traversal exactly like
    // writes and deletions.
    const runId = "run-junction-read";
    const runsRoot = join(workspaceRoot, RUN_WORKSPACE_RELATIVE_DIR);
    mkdirSync(runsRoot, { recursive: true });
    const junctionTarget = join(runsRoot, runId);
    const outside = join(dir, "outside-read");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "leak.txt"), "secret");
    try {
      symlinkSync(outside, junctionTarget, "junction");
    } catch {
      // Junction creation unavailable on this host: skip rather than fail.
      return;
    }
    expect(() =>
      ledger.readOwnedFile({ runId, attemptSequence: 4, relativePath: "leak.txt" })
    ).toThrowError(LedgerEscapeDetectedError);
  });

  it("rejects symlink/junction components inside the workspace (traversal escape)", () => {
    // Pre-create runs/{RUN_JUNCTION} as a junction pointing outside the
    // workspace root; every write and deletion must refuse to traverse it.
    const runId = "run-junction-target";
    const runsRoot = join(workspaceRoot, RUN_WORKSPACE_RELATIVE_DIR);
    mkdirSync(runsRoot, { recursive: true });
    const junctionTarget = join(runsRoot, runId);
    const outside = join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    try {
      symlinkSync(outside, junctionTarget, "junction");
    } catch {
      // Windows: creating a junction requires Developer Mode or elevated
      // privileges; when unavailable, skip this escape assertion rather than
      // failing the machine state.
      return;
    }
    const content = Buffer.from("must not land outside");
    expect(() =>
      ledger.writeOwnedFile({ runId, attemptSequence: 4, relativePath: "output/x.txt", content })
    ).toThrowError(LedgerEscapeDetectedError);
    expect(() => ledger.createAttemptWorkspace(runId, 4)).toThrowError(LedgerEscapeDetectedError);
    expect(() => ledger.deleteAttemptWorkspace(runId, 4)).toThrowError(LedgerEscapeDetectedError);
    // Nothing leaked into the junction target.
    expect(readdirSync(outside)).toEqual([]);
  });

  it("deletes an owned file conservatively and prunes only empty parents", () => {
    ledger.createAttemptWorkspace(RUN_A, 5);
    const stored = ledger.writeOwnedFile({
      runId: RUN_A,
      attemptSequence: 5,
      relativePath: "logs/run.log",
      content: Buffer.from("log line")
    });
    expect(existsSync(stored.absolutePath)).toBe(true);
    ledger.deleteOwnedFile({ runId: RUN_A, attemptSequence: 5, relativePath: "logs/run.log" });
    expect(existsSync(stored.absolutePath)).toBe(false);
    // The now-empty logs dir is pruned; the attempt root stays.
    const layout = ledger.workspaceLayout(RUN_A, 5);
    expect(existsSync(layout.directories.logs.absolutePath)).toBe(false);
    expect(existsSync(layout.absoluteRoot)).toBe(true);
  });

  it("reports a structured error when deleting a missing owned file", () => {
    expect(() =>
      ledger.deleteOwnedFile({ runId: RUN_A, attemptSequence: 5, relativePath: "logs/missing.log" })
    ).toThrowError(LedgerFileMissingError);
  });

  it("deletes one attempt workspace without touching another run", () => {
    const runX = "run-cross-a";
    const runY = "run-cross-b";
    ledger.createAttemptWorkspace(runX, 6);
    ledger.createAttemptWorkspace(runY, 6);
    const fileX = ledger.writeOwnedFile({
      runId: runX,
      attemptSequence: 6,
      relativePath: "output/model.part",
      content: Buffer.from("run X artifact")
    });
    const fileY = ledger.writeOwnedFile({
      runId: runY,
      attemptSequence: 6,
      relativePath: "output/model.part",
      content: Buffer.from("run Y artifact")
    });
    expect(existsSync(fileX.absolutePath)).toBe(true);
    expect(existsSync(fileY.absolutePath)).toBe(true);

    ledger.deleteAttemptWorkspace(runX, 6);
    // Run X's whole attempt subtree (and its now-empty run dir) is gone.
    expect(existsSync(join(workspaceRoot, RUN_WORKSPACE_RELATIVE_DIR, runX))).toBe(false);
    // Run Y is untouched.
    expect(existsSync(fileY.absolutePath)).toBe(true);
    expect(readFileSync(fileY.absolutePath)).toEqual(Buffer.from("run Y artifact"));
  });

  it("treats a missing attempt workspace as already gone and never deletes siblings", () => {
    const runX = "run-cross-a";
    const runY = "run-cross-b";
    // Idempotent cleanup: deleting again is a no-op.
    expect(() => ledger.deleteAttemptWorkspace(runX, 6)).not.toThrow();
    // A different attempt number of the same run is also just "already gone".
    expect(() => ledger.deleteAttemptWorkspace(runX, 99)).not.toThrow();
    // Run Y's attempt survived both cleanup calls.
    expect(
      existsSync(join(workspaceRoot, RUN_WORKSPACE_RELATIVE_DIR, runY, "attempt-006"))
    ).toBe(true);
  });

  it("refuses deletions that leave the attempt subtree", () => {
    expect(() =>
      ledger.deleteOwnedFile({ runId: RUN_A, attemptSequence: 6, relativePath: "../../secret.txt" })
    ).toThrowError(LedgerPathUnsafeError);
  });

  it("refuses to open a workspace root that is a junction", () => {
    const root = join(dir, "junction-root");
    const target = join(dir, "junction-target");
    mkdirSync(target, { recursive: true });
    try {
      symlinkSync(target, root, "junction");
    } catch {
      return; // junction creation unavailable on this host
    }
    const hostile = new RunWorkspaceLedger({ workspaceRoot: root });
    expect(() => hostile.open()).toThrowError(LedgerEscapeDetectedError);
  });

  it("creates the workspace root lazily on open", () => {
    const root = join(dir, "lazy-workspaces");
    const fresh = new RunWorkspaceLedger({ workspaceRoot: root });
    expect(existsSync(root)).toBe(false);
    fresh.open();
    expect(existsSync(root)).toBe(true);
    fresh.close();
  });

  it("refuses writes while closed", () => {
    const closed = new RunWorkspaceLedger({ workspaceRoot: join(dir, "closed-workspaces") });
    expect(() =>
      closed.writeOwnedFile({
        runId: RUN_A,
        attemptSequence: 1,
        relativePath: "output/x.txt",
        content: Buffer.from("x")
      })
    ).toThrowError(/not open/);
  });
});
