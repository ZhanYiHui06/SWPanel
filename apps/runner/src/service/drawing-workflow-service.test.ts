import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Runner } from "../runner.js";
import { SqliteDatabase } from "../db/database.js";
import { SCHEMA_VERSION } from "../db/schema.js";
import { SqliteRepository } from "../db/repository.js";
import { RunRepository } from "../db/run-repository.js";
import {
  EntityConflictError,
  InvalidArgumentError,
  NotFoundError,
  RunnerInvariantError,
  UnsupportedPhaseOperationError
} from "../errors.js";
import { DrawingFileLedger, DRAWING_LIBRARY_RELATIVE_DIR } from "../ledger/drawing-file-ledger.js";
import { DrawingWorkflowService } from "./drawing-workflow-service.js";
import { BusinessDeletionService } from "./business-deletion-service.js";
import { makeTempDir, removeTempDir, samplePdfBytes, sha256Of } from "../test-utils.js";

function makeSource(sourceDir: string, name: string, content: Buffer = samplePdfBytes()): string {
  const path = join(sourceDir, name);
  writeFileSync(path, content);
  return path;
}

function runAt(root: string): Runner {
  const runner = new Runner(root);
  runner.open();
  return runner;
}

describe("DrawingWorkflowService (via Runner)", () => {
  const roots: string[] = [];
  const openRunners: Runner[] = [];
  afterEach(() => {
    // Close every open Runner first: on Windows the SQLite connection holds a
    // file lock that otherwise makes temp-dir removal fail with EPERM.
    while (openRunners.length > 0) {
      openRunners.pop()?.close();
    }
    while (roots.length > 0) {
      removeTempDir(roots.pop() as string);
    }
  });

  function newRoot(): string {
    const root = makeTempDir("runner");
    roots.push(root);
    mkdirSync(join(root, "sources"), { recursive: true });
    return root;
  }

  function trackedRunner(root: string): Runner {
    const runner = runAt(root);
    openRunners.push(runner);
    return runner;
  }

  it("imports a new Drawing with its first Revision and atomic current pointer", () => {
    const root = newRoot();
    const runner = trackedRunner(root);
    const sourcePath = makeSource(join(root, "sources"), "PDJF001.01.pdf");

    const result = runner.importDrawing({
      drawingNumber: "PDJF001.01",
      name: "轧辊（一）",
      sourceFile: {
        sourcePath,
        fileName: "PDJF001.01.pdf",
        format: "PDF",
        uploadedAt: "2026-08-12T01:00:00.000Z"
      },
      createdAt: "2026-08-12T01:00:00.000Z",
      createdBy: "user-1"
    });

    expect(result.drawing.drawingNumber).toBe("PDJF001.01");
    expect(result.drawing.currentRevisionId).toBe(result.revision.id);
    expect(result.revision.sequence).toBe(1);
    expect(result.revision.sourceFile.sha256).toBe(sha256Of(samplePdfBytes()));
    expect(result.revision.sourceFile.relativePath.startsWith(`${DRAWING_LIBRARY_RELATIVE_DIR}/`)).toBe(true);
    expect(existsSync(runner.resolveLedgerPath(result.revision.sourceFile.relativePath))).toBe(true);

    const history = runner.getDrawingHistory(result.drawing.id);
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0]?.isCurrent).toBe(true);
    expect(history.revisions[0]?.revisionLabel).toBe("V1");

    const detail = runner.getDrawingDetail(result.drawing.id);
    expect(detail.revisions[0]?.isCurrent).toBe(true);
    expect(detail.revisions[0]?.currentApprovedModelId).toBeNull();
  });

  it("imports a Unicode file name through the full workflow", () => {
    const root = newRoot();
    const runner = trackedRunner(root);
    const sourcePath = makeSource(join(root, "sources"), "轧辊-A-修订二版.pdf");

    const result = runner.importDrawing({
      drawingNumber: "PDJF999.02",
      name: "Unicode 图纸",
      sourceFile: {
        sourcePath,
        fileName: "轧辊-A-修订二版.pdf",
        format: "PDF",
        uploadedAt: "2026-08-12T02:00:00.000Z"
      },
      createdAt: "2026-08-12T02:00:00.000Z"
    });

    expect(result.revision.sourceFile.fileName).toBe("轧辊-A-修订二版.pdf");
    const history = runner.getDrawingHistory(result.drawing.id);
    expect(history.revisions[0]?.sourceFile.fileName).toBe("轧辊-A-修订二版.pdf");
  });

  it("rejects a duplicate Drawing number and compensates the stored file", () => {
    const root = newRoot();
    const runner = trackedRunner(root);
    const sourcePath = makeSource(join(root, "sources"), "dupe.pdf");
    runner.importDrawing({
      drawingNumber: "PDJF-DUP",
      name: "First",
      sourceFile: {
        sourcePath,
        fileName: "dupe.pdf",
        format: "PDF",
        uploadedAt: "2026-08-12T03:00:00.000Z"
      },
      createdAt: "2026-08-12T03:00:00.000Z"
    });

    const secondSource = makeSource(join(root, "sources"), "dupe2.pdf");
    expect(() =>
      runner.importDrawing({
        drawingNumber: "PDJF-DUP",
        name: "Second",
        sourceFile: {
          sourcePath: secondSource,
          fileName: "dupe2.pdf",
          format: "PDF",
          uploadedAt: "2026-08-12T03:01:00.000Z"
        },
        createdAt: "2026-08-12T03:01:00.000Z"
      })
    ).toThrowError(EntityConflictError);

    // The second file must not be left behind in the ledger.
    const libraryDir = join(root, DRAWING_LIBRARY_RELATIVE_DIR);
    const entries = existsSync(libraryDir) ? readdirSync(libraryDir) : [];
    const storedDirs = entries.filter((entry) => /^[0-9a-f-]{36}$/.test(entry));
    expect(storedDirs.length).toBe(1);
  });

  it("adds a Revision, switches the current pointer and keeps history consistent", () => {
    const root = newRoot();
    const runner = trackedRunner(root);
    const imported = runner.importDrawing({
      drawingNumber: "PDJF002.02",
      name: "V 型",
      sourceFile: {
        sourcePath: makeSource(join(root, "sources"), "v1.pdf"),
        fileName: "v1.pdf",
        format: "PDF",
        uploadedAt: "2026-08-12T04:00:00.000Z"
      },
      createdAt: "2026-08-12T04:00:00.000Z"
    });

    const added = runner.addRevision({
      drawingId: imported.drawing.id,
      sourceFile: {
        sourcePath: makeSource(join(root, "sources"), "v2.dwg"),
        fileName: "v2.dwg",
        format: "DWG",
        uploadedAt: "2026-08-12T04:30:00.000Z"
      },
      createdAt: "2026-08-12T04:30:00.000Z"
    });
    expect(added.revision.sequence).toBe(2);
    expect(added.revision.drawingId).toBe(imported.drawing.id);

    // Adding a Revision does not change the current pointer.
    let history = runner.getDrawingHistory(imported.drawing.id);
    expect(history.currentRevisionId).toBe(imported.revision.id);
    expect(history.revisions.map((r) => r.revisionLabel)).toEqual(["V1", "V2"]);
    expect(history.revisions[1]?.isCurrent).toBe(false);

    // Atomically switch the current Revision.
    const switched = runner.setCurrentRevision({
      drawingId: imported.drawing.id,
      revisionId: added.revision.id,
      updatedAt: "2026-08-12T05:00:00.000Z"
    });
    expect(switched.currentRevisionId).toBe(added.revision.id);

    history = runner.getDrawingHistory(imported.drawing.id);
    expect(history.currentRevisionId).toBe(added.revision.id);
    expect(history.revisions[1]?.isCurrent).toBe(true);
    expect(history.revisions[0]?.isCurrent).toBe(false);
  });

  it("rejects setting the current Revision to a Revision of another Drawing", () => {
    const root = newRoot();
    const runner = trackedRunner(root);
    const a = runner.importDrawing({
      drawingNumber: "PDJF-A",
      name: "A",
      sourceFile: {
        sourcePath: makeSource(join(root, "sources"), "a.pdf"),
        fileName: "a.pdf",
        format: "PDF",
        uploadedAt: "2026-08-12T06:00:00.000Z"
      },
      createdAt: "2026-08-12T06:00:00.000Z"
    });
    const b = runner.importDrawing({
      drawingNumber: "PDJF-B",
      name: "B",
      sourceFile: {
        sourcePath: makeSource(join(root, "sources"), "b.pdf"),
        fileName: "b.pdf",
        format: "PDF",
        uploadedAt: "2026-08-12T06:05:00.000Z"
      },
      createdAt: "2026-08-12T06:05:00.000Z"
    });

    expect(() =>
      runner.setCurrentRevision({
        drawingId: a.drawing.id,
        revisionId: b.revision.id,
        updatedAt: "2026-08-12T06:10:00.000Z"
      })
    ).toThrowError(RunnerInvariantError);
  });

  describe("conservative Revision deletion", () => {
    function importWithTwoRevisions(runner: Runner, root: string) {
      const imported = runner.importDrawing({
        drawingNumber: "PDJF-DEL",
        name: "Deletion",
        sourceFile: {
          sourcePath: makeSource(join(root, "sources"), "del-v1.pdf"),
          fileName: "del-v1.pdf",
          format: "PDF",
          uploadedAt: "2026-08-12T06:00:00.000Z"
        },
        createdAt: "2026-08-12T06:00:00.000Z"
      });
      const added = runner.addRevision({
        drawingId: imported.drawing.id,
        sourceFile: {
          sourcePath: makeSource(join(root, "sources"), "del-v2.dwg"),
          fileName: "del-v2.dwg",
          format: "DWG",
          uploadedAt: "2026-08-12T06:10:00.000Z"
        },
        createdAt: "2026-08-12T06:10:00.000Z"
      });
      return { imported, added };
    }

    it("refuses to delete the CURRENT revision (current-pointer protection)", () => {
      const root = newRoot();
      const runner = trackedRunner(root);
      const { imported } = importWithTwoRevisions(runner, root);

      expect(() =>
        runner.deleteRevision({
          drawingId: imported.drawing.id,
          revisionId: imported.revision.id,
          updatedAt: "2026-08-12T06:20:00.000Z"
        })
      ).toThrowError(
        expect.objectContaining({
          code: "DOMAIN_INVARIANT"
        })
      );

      // Nothing changed: history and ledger file remain.
      expect(runner.getDrawingHistory(imported.drawing.id).revisions).toHaveLength(2);
      expect(existsSync(runner.resolveLedgerPath(imported.revision.sourceFile.relativePath))).toBe(true);
    });

    it("deletes a non-current Revision: metadata + owned file gone, others intact", () => {
      const root = newRoot();
      const runner = trackedRunner(root);
      const { imported, added } = importWithTwoRevisions(runner, root);
      const deletedPath = runner.resolveLedgerPath(added.revision.sourceFile.relativePath);
      const survivingPath = runner.resolveLedgerPath(imported.revision.sourceFile.relativePath);

      const result = runner.deleteRevision({
        drawingId: imported.drawing.id,
        revisionId: added.revision.id,
        updatedAt: "2026-08-12T06:20:00.000Z"
      });
      expect(result.deletedRevisionId).toBe(added.revision.id);

      // History refresh: only V1 remains and the current pointer is intact.
      const history = runner.getDrawingHistory(imported.drawing.id);
      expect(history.revisions.map((revision) => revision.revisionLabel)).toEqual(["V1"]);
      expect(history.currentRevisionId).toBe(imported.revision.id);
      expect(result.drawing.updatedAt).toBe("2026-08-12T06:20:00.000Z");

      // File removal: only the OWNED allowlisted source file is gone.
      expect(existsSync(deletedPath)).toBe(false);
      expect(existsSync(survivingPath)).toBe(true);

      // Reading the deleted revision now yields NOT_FOUND.
      expect(() =>
        runner.getRevisionDetail(imported.drawing.id, added.revision.id)
      ).toThrowError(NotFoundError);
    });

    it("cascades facts and feedback of the deleted revision only", () => {
      const root = newRoot();
      const runner = trackedRunner(root);
      const { imported, added } = importWithTwoRevisions(runner, root);
      runner.addRevisionFact({
        drawingId: imported.drawing.id,
        revisionId: added.revision.id,
        field: "材料",
        value: "42CrMo",
        source: "USER_SUPPLEMENT",
        createdAt: "2026-08-12T06:15:00.000Z"
      });
      runner.addModelingFeedback({
        drawingId: imported.drawing.id,
        revisionId: added.revision.id,
        content: "V2 的反馈",
        createdAt: "2026-08-12T06:16:00.000Z"
      });
      runner.addRevisionFact({
        drawingId: imported.drawing.id,
        revisionId: imported.revision.id,
        field: "材料",
        value: "45钢",
        source: "USER_SUPPLEMENT",
        createdAt: "2026-08-12T06:17:00.000Z"
      });

      runner.deleteRevision({
        drawingId: imported.drawing.id,
        revisionId: added.revision.id,
        updatedAt: "2026-08-12T06:20:00.000Z"
      });

      const surviving = runner.getRevisionHistory(imported.drawing.id, imported.revision.id);
      expect(surviving.facts).toHaveLength(1);
      expect(surviving.facts[0]?.value).toBe("45钢");
      expect(surviving.modelingFeedback).toHaveLength(0);
    });

    it("treats an already-missing ledger file as gone and still removes the metadata", () => {
      const root = newRoot();
      const runner = trackedRunner(root);
      const { imported, added } = importWithTwoRevisions(runner, root);
      rmSync(runner.resolveLedgerPath(added.revision.sourceFile.relativePath));

      const result = runner.deleteRevision({
        drawingId: imported.drawing.id,
        revisionId: added.revision.id,
        updatedAt: "2026-08-12T06:20:00.000Z"
      });
      expect(result.deletedRevisionId).toBe(added.revision.id);
      expect(runner.getDrawingHistory(imported.drawing.id).revisions).toHaveLength(1);
      // The surviving revision's file is untouched.
      expect(existsSync(runner.resolveLedgerPath(imported.revision.sourceFile.relativePath))).toBe(true);
    });

    it("rejects deleting a Revision of another Drawing", () => {
      const root = newRoot();
      const runner = trackedRunner(root);
      const { imported } = importWithTwoRevisions(runner, root);
      const other = runner.importDrawing({
        drawingNumber: "PDJF-DEL-OTHER",
        name: "Other",
        sourceFile: {
          sourcePath: makeSource(join(root, "sources"), "other.pdf"),
          fileName: "other.pdf",
          format: "PDF",
          uploadedAt: "2026-08-12T06:30:00.000Z"
        },
        createdAt: "2026-08-12T06:30:00.000Z"
      });

      expect(() =>
        runner.deleteRevision({
          drawingId: other.drawing.id,
          revisionId: imported.revision.id,
          updatedAt: "2026-08-12T06:40:00.000Z"
        })
      ).toThrowError(RunnerInvariantError);
    });

    it("replaying the delete of an already-deleted Revision yields NOT_FOUND", () => {
      const root = newRoot();
      const runner = trackedRunner(root);
      const { imported, added } = importWithTwoRevisions(runner, root);

      runner.deleteRevision({
        drawingId: imported.drawing.id,
        revisionId: added.revision.id,
        updatedAt: "2026-08-12T06:20:00.000Z"
      });
      expect(() =>
        runner.deleteRevision({
          drawingId: imported.drawing.id,
          revisionId: added.revision.id,
          updatedAt: "2026-08-12T06:21:00.000Z"
        })
      ).toThrowError(NotFoundError);
    });

    it("persists the deletion across close/reopen", () => {
      const root = newRoot();
      const runner = trackedRunner(root);
      const { imported, added } = importWithTwoRevisions(runner, root);
      runner.deleteRevision({
        drawingId: imported.drawing.id,
        revisionId: added.revision.id,
        updatedAt: "2026-08-12T06:20:00.000Z"
      });
      runner.close();

      const second = trackedRunner(root);
      const history = second.getDrawingHistory(imported.drawing.id);
      expect(history.revisions).toHaveLength(1);
      expect(history.currentRevisionId).toBe(imported.revision.id);
      second.close();
    });
  });

  it("appends Revision Facts and USER_SUPPLEMENT Modeling Feedback and reads them back", () => {
    const root = newRoot();
    const runner = trackedRunner(root);
    const imported = runner.importDrawing({
      drawingNumber: "PDJF-MEM",
      name: "Memory",
      sourceFile: {
        sourcePath: makeSource(join(root, "sources"), "mem.pdf"),
        fileName: "mem.pdf",
        format: "PDF",
        uploadedAt: "2026-08-12T07:00:00.000Z"
      },
      createdAt: "2026-08-12T07:00:00.000Z"
    });

    const fact = runner.addRevisionFact({
      drawingId: imported.drawing.id,
      revisionId: imported.revision.id,
      field: "中心孔深度",
      value: "85 mm",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-12T07:10:00.000Z",
      createdBy: "engineer-1"
    });
    expect(fact.revisionId).toBe(imported.revision.id);
    expect(fact.source).toBe("USER_SUPPLEMENT");

    runner.addModelingFeedback({
      drawingId: imported.drawing.id,
      revisionId: imported.revision.id,
      content: "右侧台阶倒角偏小，下次建模注意。",
      createdAt: "2026-08-12T07:20:00.000Z"
    });

    const history = runner.getRevisionHistory(imported.drawing.id, imported.revision.id);
    expect(history.facts).toHaveLength(1);
    expect(history.facts[0]?.field).toBe("中心孔深度");
    expect(history.facts[0]?.value).toBe("85 mm");
    expect(history.facts[0]?.source).toBe("USER_SUPPLEMENT");
    expect(history.modelingFeedback).toHaveLength(1);
    expect(history.modelingFeedback[0]?.source).toBe("USER_SUPPLEMENT");

    const detail = runner.getRevisionDetail(imported.drawing.id, imported.revision.id);
    expect(detail.facts).toHaveLength(1);
    expect(detail.modelingFeedback).toHaveLength(1);
  });

  it("never creates a Modeling Run during upload/import workflows", () => {
    const root = newRoot();
    const runner = trackedRunner(root);
    const imported = runner.importDrawing({
      drawingNumber: "PDJF-NORUN",
      name: "No Run",
      sourceFile: {
        sourcePath: makeSource(join(root, "sources"), "norun.pdf"),
        fileName: "norun.pdf",
        format: "PDF",
        uploadedAt: "2026-08-12T08:00:00.000Z"
      },
      createdAt: "2026-08-12T08:00:00.000Z"
    });
    runner.addRevision({
      drawingId: imported.drawing.id,
      sourceFile: {
        sourcePath: makeSource(join(root, "sources"), "norun2.dxf"),
        fileName: "norun2.dxf",
        format: "DXF",
        uploadedAt: "2026-08-12T08:10:00.000Z"
      },
      createdAt: "2026-08-12T08:10:00.000Z"
    });
    runner.addRevisionFact({
      drawingId: imported.drawing.id,
      revisionId: imported.revision.id,
      field: "材料",
      value: "42CrMo",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-12T08:20:00.000Z"
    });

    expect(runner.getRunCount()).toBe(0);
    const dashboard = runner.getWorkspaceDashboard();
    expect(dashboard.currentRun).toBeNull();
    expect(dashboard.queuedRunLabels).toEqual([]);
  });

  it("persists everything across close/reopen (restart persistence)", () => {
    const root = newRoot();
    const sources = join(root, "sources");

    const first = trackedRunner(root);
    const imported = first.importDrawing({
      drawingNumber: "PDJF-RESTART",
      name: "Restart",
      sourceFile: {
        sourcePath: makeSource(sources, "restart.pdf"),
        fileName: "restart.pdf",
        format: "PDF",
        uploadedAt: "2026-08-12T09:00:00.000Z"
      },
      createdAt: "2026-08-12T09:00:00.000Z"
    });
    const revisionTwo = first.addRevision({
      drawingId: imported.drawing.id,
      sourceFile: {
        sourcePath: makeSource(sources, "restart2.dwg"),
        fileName: "restart2.dwg",
        format: "DWG",
        uploadedAt: "2026-08-12T09:10:00.000Z"
      },
      createdAt: "2026-08-12T09:10:00.000Z"
    });
    first.setCurrentRevision({
      drawingId: imported.drawing.id,
      revisionId: revisionTwo.revision.id,
      updatedAt: "2026-08-12T09:20:00.000Z"
    });
    first.addRevisionFact({
      drawingId: imported.drawing.id,
      revisionId: revisionTwo.revision.id,
      field: "表面粗糙度",
      value: "Ra 1.6",
      source: "USER_SUPPLEMENT",
      createdAt: "2026-08-12T09:30:00.000Z"
    });
    const storedPath = first.resolveLedgerPath(imported.revision.sourceFile.relativePath);
    first.close();

    const second = trackedRunner(root);
    const history = second.getDrawingHistory(imported.drawing.id);
    expect(history.revisions).toHaveLength(2);
    expect(history.currentRevisionId).toBe(revisionTwo.revision.id);
    expect(history.revisions[0]?.isCurrent).toBe(false);
    expect(history.revisions[1]?.isCurrent).toBe(true);

    const revisionHistory = second.getRevisionHistory(imported.drawing.id, revisionTwo.revision.id);
    expect(revisionHistory.facts).toHaveLength(1);
    expect(revisionHistory.facts[0]?.field).toBe("表面粗糙度");

    // The ledger file survives the restart as well.
    expect(existsSync(storedPath)).toBe(true);
    second.close();
  });

  it("seeds storage settings on first open and persists them", () => {
    const root = newRoot();
    const runner = trackedRunner(root);
    const settings = runner.getStorageSettings().settings;
    expect(settings.dataRoot).toBe(root);
    expect(settings.workspaceRoot).toBe(join(root, "workspaces"));
    expect(settings.constraint).toBe("LOCAL_FIXED_NTFS");
    runner.close();
  });

  it("refuses to open a data root that does not match persisted settings", () => {
    const root = newRoot();
    const otherRoot = newRoot();
    const runner = trackedRunner(root);
    runner.close();

    // Same database, but a different data root: the persisted settings must
    // reject the mismatch instead of silently re-rooting the library.
    const second = new Runner(otherRoot, { dbPath: join(root, "state", "swpanel.db") });
    expect(() => second.open()).toThrowError(/data root/);
  });

  it("returns a structured missing-file error when a stored source disappears", () => {
    const root = newRoot();
    const runner = trackedRunner(root);
    const source = makeSource(join(root, "sources"), "missing-after-import.pdf");
    const imported = runner.importDrawing({
      drawingNumber: "PDJF-MISSING",
      name: "缺失源文件",
      sourceFile: {
        sourcePath: source,
        fileName: "missing-after-import.pdf",
        format: "PDF",
        uploadedAt: "2026-08-12T09:00:00.000Z"
      },
      createdAt: "2026-08-12T09:00:00.000Z"
    });
    const storedPath = runner.resolveLedgerPath(imported.revision.sourceFile.relativePath);
    rmSync(storedPath);

    expect(() => runner.getRevisionDetail(imported.drawing.id, imported.revision.id)).toThrowError(
      expect.objectContaining({
        code: "LEDGER_FILE_MISSING",
        details: expect.objectContaining({ relativePath: imported.revision.sourceFile.relativePath }) as object
      })
    );
    runner.close();
  });

  it("throws NotFoundError for unknown drawings and revisions", () => {
    const root = newRoot();
    const runner = trackedRunner(root);
    expect(() => runner.getDrawingHistory("00000000-0000-0000-0000-000000000000")).toThrowError(
      NotFoundError
    );
    expect(() =>
      runner.addRevisionFact({
        drawingId: "00000000-0000-0000-0000-000000000000",
        revisionId: "00000000-0000-0000-0000-000000000000",
        field: "f",
        value: "v",
        source: "USER_SUPPLEMENT",
        createdAt: "2026-08-12T10:00:00.000Z"
      })
    ).toThrowError(NotFoundError);
  });

  it("throws UnsupportedPhaseOperationError for later-phase aggregate writes", () => {
    const root = newRoot();
    const db = new SqliteDatabase({ dbPath: join(root, "state", "swpanel.db") });
    db.open();
    const repo = new SqliteRepository(db);
    expect(() => repo.saveRun({} as never)).toThrowError(UnsupportedPhaseOperationError);
    expect(() => repo.saveModel({} as never)).toThrowError(UnsupportedPhaseOperationError);
    expect(() => repo.appendRunEvent({} as never)).toThrowError(UnsupportedPhaseOperationError);
    db.close();
  });

  it("rejects invalid workflow inputs", () => {
    const root = newRoot();
    const runner = trackedRunner(root);
    expect(() =>
      runner.importDrawing({
        drawingNumber: "",
        name: "x",
        sourceFile: {
          sourcePath: makeSource(join(root, "sources"), "x.pdf"),
          fileName: "x.pdf",
          format: "PDF",
          uploadedAt: "2026-08-12T11:00:00.000Z"
        },
        createdAt: "2026-08-12T11:00:00.000Z"
      })
    ).toThrowError(InvalidArgumentError);
    expect(() =>
      runner.addRevisionFact({
        drawingId: "x",
        revisionId: "y",
        field: "",
        value: "",
        source: "USER_SUPPLEMENT",
        createdAt: "2026-08-12T11:00:00.000Z"
      })
    ).toThrowError(InvalidArgumentError);
  });

  it("exposes the drawing library relative dir and the schema version", () => {
    const root = newRoot();
    const runner = trackedRunner(root);
    expect(Runner.drawingLibraryRelativeDir).toBe("library/drawings");
    expect(DrawingFileLedger.libraryRelativeDir).toBe("library/drawings");
    expect(runner.schemaVersion).toBe(SCHEMA_VERSION);
    runner.close();
  });
});

describe("revision cascade protection (Phase 8)", () => {
  let dir: string;
  let db: SqliteDatabase;
  let repo: SqliteRepository;
  let runs: RunRepository;
  let ledger: DrawingFileLedger;
  let drawingService: DrawingWorkflowService;

  const CASCADE_PROFILE = {
    promptTemplateVersion: "2026.08-p8",
    skill: { name: "solidworks-build-part-from-drawing", sha256: "c".repeat(64) },
    agentConfigId: "codex"
  };

  beforeAll(() => {
    dir = makeTempDir("cascade");
    db = new SqliteDatabase({ dbPath: join(dir, "state", "swpanel.db") });
    db.open();
    repo = new SqliteRepository(db);
    runs = new RunRepository(db, repo);
    ledger = new DrawingFileLedger({ dataRoot: dir });
    ledger.open();
    drawingService = new DrawingWorkflowService(repo, ledger, runs);
    mkdirSync(join(dir, "sources"), { recursive: true });
  });

  afterAll(() => {
    ledger.close();
    db.close();
    removeTempDir(dir);
  });

  function importWithTwoRevisions(drawingNumber: string) {
    const imported = drawingService.importDrawing({
      drawingNumber,
      name: drawingNumber,
      sourceFile: {
        sourcePath: makeSource(join(dir, "sources"), `${drawingNumber}-v1.pdf`),
        fileName: `${drawingNumber}-v1.pdf`,
        format: "PDF",
        uploadedAt: "2026-08-12T06:00:00.000Z"
      },
      createdAt: "2026-08-12T06:00:00.000Z"
    });
    const added = drawingService.addRevision({
      drawingId: imported.drawing.id,
      sourceFile: {
        sourcePath: makeSource(join(dir, "sources"), `${drawingNumber}-v2.dwg`),
        fileName: `${drawingNumber}-v2.dwg`,
        format: "DWG",
        uploadedAt: "2026-08-12T06:10:00.000Z"
      },
      createdAt: "2026-08-12T06:10:00.000Z"
    });
    return { imported, added };
  }

  function createRun(drawingId: string, revisionId: string) {
    return runs.createRun({
      drawingId,
      revisionId,
      profile: CASCADE_PROFILE,
      createdAt: "2026-08-12T06:20:00.000Z"
    });
  }

  function seedModel(drawingId: string, revisionId: string, runId: string, modelId: string) {
    db.prepare(
      "INSERT INTO models (id, number, drawing_id, revision_id, run_id, review_status, generated_at) " +
        "VALUES (?, 'M01', ?, ?, ?, 'PENDING_REVIEW', ?)"
    ).run(modelId, drawingId, revisionId, runId, "2026-08-12T06:30:00.000Z");
  }

  function seedCostReport(drawingId: string, revisionId: string, modelId: string, reportId: string) {
    db.prepare(
      "INSERT INTO cost_reports " +
        "(id, label, drawing_id, revision_id, model_id, quantity, snapshot_json, created_at, updated_at) " +
        "VALUES (?, 'Q01', ?, ?, ?, 1, ?, ?, ?)"
    ).run(
      reportId,
      drawingId,
      revisionId,
      modelId,
      JSON.stringify({
        input: {},
        result: {
          rawStockVolume: 1,
          materialCost: 1,
          fixedCostLines: [],
          perPieceCost: 2,
          totalCost: 2,
          currency: "CNY"
        },
        createdAt: "2026-08-12T06:40:00.000Z"
      }),
      "2026-08-12T06:40:00.000Z",
      "2026-08-12T06:40:00.000Z"
    );
  }

  function deleteV2(drawingId: string, revisionId: string) {
    return () =>
      drawingService.deleteRevision({
        drawingId,
        revisionId,
        updatedAt: "2026-08-12T06:50:00.000Z"
      });
  }

  it("refuses to delete a Revision that has dependent Runs", () => {
    const { imported, added } = importWithTwoRevisions("PDJF-CASC-RUNS");
    createRun(imported.drawing.id, added.revision.id);
    expect(deleteV2(imported.drawing.id, added.revision.id)).toThrowError(
      expect.objectContaining({
        code: "DOMAIN_INVARIANT",
        details: expect.objectContaining({ blockingDependencies: ["RUNS"] }) as object
      })
    );
    // The Revision survives with its source file intact.
    expect(drawingService.getDrawingHistory(imported.drawing.id).revisions).toHaveLength(2);
  });

  it("refuses to delete a Revision that has dependent Models", () => {
    const { imported, added } = importWithTwoRevisions("PDJF-CASC-MODELS");
    seedModel(imported.drawing.id, added.revision.id, "run-casc-ghost", "model-casc-1");
    expect(deleteV2(imported.drawing.id, added.revision.id)).toThrowError(
      expect.objectContaining({
        code: "DOMAIN_INVARIANT",
        details: expect.objectContaining({ blockingDependencies: ["MODELS"] }) as object
      })
    );
  });

  it("refuses to delete a Revision that has dependent Cost Reports", () => {
    const { imported, added } = importWithTwoRevisions("PDJF-CASC-COST");
    seedCostReport(imported.drawing.id, added.revision.id, "model-casc-cost", "report-casc-1");
    expect(deleteV2(imported.drawing.id, added.revision.id)).toThrowError(
      expect.objectContaining({
        code: "DOMAIN_INVARIANT",
        details: expect.objectContaining({ blockingDependencies: ["COST_REPORTS"] }) as object
      })
    );
  });

  it("lists every dependency blocker when Runs and Models both exist", () => {
    const { imported, added } = importWithTwoRevisions("PDJF-CASC-BOTH");
    const run = createRun(imported.drawing.id, added.revision.id);
    seedModel(imported.drawing.id, added.revision.id, run.id, "model-casc-both");
    expect(deleteV2(imported.drawing.id, added.revision.id)).toThrowError(
      expect.objectContaining({
        code: "DOMAIN_INVARIANT",
        details: expect.objectContaining({
          reason: "REVISION_HAS_DEPENDENCIES",
          blockingDependencies: ["RUNS", "MODELS"]
        }) as object
      })
    );
  });

  it("does not fail a committed Revision deletion when the source file cannot be removed (BE-14)", () => {
    const { imported, added } = importWithTwoRevisions("PDJF-CASC-CLEANUP");
    const relativePath = added.revision.sourceFile.relativePath;
    const spy = vi.spyOn(ledger, "deleteOwnedFile").mockImplementationOnce(() => {
      throw new Error("EBUSY: resource busy or locked");
    });
    try {
      const result = drawingService.deleteRevision({
        drawingId: imported.drawing.id,
        revisionId: added.revision.id,
        updatedAt: "2026-08-12T06:50:00.000Z"
      });
      expect(result.deletedRevisionId).toBe(added.revision.id);
      expect(result.cleanupWarnings).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    // The DB deletion is committed and the cleanup intent is durably queued.
    expect(drawingService.getDrawingHistory(imported.drawing.id).revisions).toHaveLength(1);
    const queued = JSON.parse(
      (db.prepare("SELECT value FROM settings WHERE key = 'business_deletion_cleanup'").get() as { value: string }).value
    ) as Array<{ kind: string; relativePath: string }>;
    expect(queued).toContainEqual({ kind: "source", relativePath });
    expect(existsSync(ledger.toAbsolute(relativePath))).toBe(true);

    // The shared retry loop finishes the job and empties the queue.
    expect(new BusinessDeletionService(db, ledger, () => null).retryCleanup()).toEqual([]);
    expect(existsSync(ledger.toAbsolute(relativePath))).toBe(false);
    const after = JSON.parse(
      (db.prepare("SELECT value FROM settings WHERE key = 'business_deletion_cleanup'").get() as { value: string }).value
    ) as unknown[];
    expect(after).toEqual([]);
  });

  it("leaves no cleanup intent behind after a clean Revision deletion", () => {
    const { imported, added } = importWithTwoRevisions("PDJF-CASC-CLEAN");
    const result = drawingService.deleteRevision({
      drawingId: imported.drawing.id,
      revisionId: added.revision.id,
      updatedAt: "2026-08-12T06:50:00.000Z"
    });
    expect(result.cleanupWarnings).toBeUndefined();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'business_deletion_cleanup'").get() as
      | { value: string }
      | undefined;
    expect(row === undefined ? [] : (JSON.parse(row.value) as unknown[])).toEqual([]);
  });

  it("stamps Facts and Feedback with the SERVER clock and keeps them in the next Run snapshot (BE-03)", () => {
    const { imported } = importWithTwoRevisions("PDJF-SERVERCLOCK");
    const serverNow = new Date("2026-10-03T00:00:00.000Z");
    const service = new DrawingWorkflowService(repo, ledger, runs, () => serverNow);
    const fact = service.addRevisionFact({
      drawingId: imported.drawing.id,
      revisionId: imported.revision.id,
      field: "材料",
      value: "42CrMo",
      source: "USER_SUPPLEMENT",
      // A browser clock far in the future (or garbage) must not matter.
      createdAt: "2099-01-01T00:00:00.000Z"
    });
    const garbage = service.addRevisionFact({
      drawingId: imported.drawing.id,
      revisionId: imported.revision.id,
      field: "热处理",
      value: "调质",
      source: "USER_SUPPLEMENT",
      createdAt: "abc"
    });
    const feedback = service.addModelingFeedback({
      drawingId: imported.drawing.id,
      revisionId: imported.revision.id,
      content: "保留端面台阶",
      createdAt: "not-a-date"
    });
    expect(fact.createdAt).toBe("2026-10-03T00:00:00.000Z");
    expect(garbage.createdAt).toBe("2026-10-03T00:00:00.000Z");
    expect(feedback.createdAt).toBe("2026-10-03T00:00:00.000Z");

    const run = runs.createRun({
      drawingId: imported.drawing.id,
      revisionId: imported.revision.id,
      profile: CASCADE_PROFILE,
      createdAt: "2026-10-03T00:00:01.000Z"
    });
    expect(run.inputSnapshot.revisionFacts.map((entry) => entry.field).sort()).toEqual(["材料", "热处理"]);
    expect(run.inputSnapshot.modelingFeedback).toHaveLength(1);
  });

  it("keeps memory with an unparseable legacy timestamp in the Run snapshot instead of dropping it (BE-03)", () => {
    const { imported } = importWithTwoRevisions("PDJF-LEGACYTS");
    repo.insertRevisionFact({
      id: "fact-legacy-nan",
      revisionId: imported.revision.id,
      field: "旧数据",
      value: "x",
      source: "USER_SUPPLEMENT",
      createdAt: "legacy-garbage"
    });
    repo.insertRevisionFact({
      id: "fact-future",
      revisionId: imported.revision.id,
      field: "未来",
      value: "y",
      source: "USER_SUPPLEMENT",
      createdAt: "2999-01-01T00:00:00.000Z"
    });
    const run = createRun(imported.drawing.id, imported.revision.id);
    const fields = run.inputSnapshot.revisionFacts.map((entry) => entry.field);
    expect(fields).toContain("旧数据");
    expect(fields).not.toContain("未来");
  });

  it("derives real library status fields in ONE aggregate read (UX-03)", () => {
    const { imported, added } = importWithTwoRevisions("PDJF-LISTSTATUS");
    const find = () =>
      repo.getWorkspaceDashboard().recentDrawings.find((item) => item.drawingId === imported.drawing.id);
    expect(find()).toMatchObject({
      currentApprovedModelId: null,
      runStatus: null,
      hasOpenClarification: false,
      hasPendingReview: false,
      totalRevisionCount: 2,
      currentRevisionLabel: "V1",
      latestRevisionLabel: "V2"
    });

    // A Run on a NON-current Revision does not change the library status.
    createRun(imported.drawing.id, added.revision.id);
    expect(find()?.runStatus).toBeNull();

    const run = createRun(imported.drawing.id, imported.revision.id);
    expect(find()?.runStatus).toBe("QUEUED");

    seedModel(imported.drawing.id, imported.revision.id, run.id, "model-liststatus");
    expect(find()?.hasPendingReview).toBe(true);

    db.prepare(
      "INSERT INTO clarification_requests (id, run_id, revision_id, status, created_at) VALUES (?, ?, ?, 'OPEN', ?)"
    ).run("clar-liststatus", run.id, imported.revision.id, "2026-08-12T06:30:00.000Z");
    expect(find()?.hasOpenClarification).toBe(true);
    db.prepare("UPDATE clarification_requests SET status = 'ANSWERED' WHERE id = ?").run("clar-liststatus");
    expect(find()?.hasOpenClarification).toBe(false);

    db.prepare("UPDATE models SET review_status = 'APPROVED' WHERE id = ?").run("model-liststatus");
    db.prepare("UPDATE drawing_revisions SET current_approved_model_id = ? WHERE id = ?").run(
      "model-liststatus",
      imported.revision.id
    );
    expect(find()).toMatchObject({ currentApprovedModelId: "model-liststatus", hasPendingReview: false });
  });

  it("exposes every pending review (with revisionId) and every open clarification, untruncated (UX-04)", () => {
    const { imported } = importWithTwoRevisions("PDJF-DASHFULL");
    const run = createRun(imported.drawing.id, imported.revision.id);
    seedModel(imported.drawing.id, imported.revision.id, run.id, "model-dash-1");
    const run2 = createRun(imported.drawing.id, imported.revision.id);
    for (const [index, runId] of [run.id, run2.id].entries()) {
      db.prepare(
        "INSERT INTO clarification_requests (id, run_id, revision_id, status, created_at) VALUES (?, ?, ?, 'OPEN', ?)"
      ).run(`clar-dash-${index}`, runId, imported.revision.id, `2026-08-12T06:3${index}:00.000Z`);
      db.prepare("INSERT INTO clarification_questions (id, request_id, sort_order, payload_json) VALUES (?, ?, 1, '{}')").run(
        `q-dash-${index}`,
        `clar-dash-${index}`
      );
    }
    const reviews = runs.listPendingReviewItems().filter((item) => item.drawingId === imported.drawing.id);
    expect(reviews).toEqual([
      expect.objectContaining({ modelId: "model-dash-1", revisionId: imported.revision.id, revisionLabel: "V1" })
    ]);
    const clarifications = runs
      .listPendingClarificationItems()
      .filter((item) => item.drawingId === imported.drawing.id);
    expect(clarifications.map((item) => item.runId)).toEqual([run.id, run2.id]);
    expect(clarifications[0]).toMatchObject({ drawingNumber: "PDJF-DASHFULL", revisionLabel: "V1", openQuestionCount: 1 });
  });
});

describe("Run deletion via Runner (Phase 8)", () => {
  const roots: string[] = [];
  const openRunners: Runner[] = [];
  afterEach(() => {
    while (openRunners.length > 0) {
      openRunners.pop()?.close();
    }
    while (roots.length > 0) {
      removeTempDir(roots.pop() as string);
    }
  });

  function newRoot(): string {
    const root = makeTempDir("runner-del");
    roots.push(root);
    mkdirSync(join(root, "sources"), { recursive: true });
    return root;
  }

  function trackedRunner(root: string): Runner {
    const runner = runAt(root);
    openRunners.push(runner);
    return runner;
  }

  function importOneDrawing(runner: Runner, root: string, drawingNumber: string) {
    return runner.importDrawing({
      drawingNumber,
      name: drawingNumber,
      sourceFile: {
        sourcePath: makeSource(join(root, "sources"), `${drawingNumber}.pdf`),
        fileName: `${drawingNumber}.pdf`,
        format: "PDF",
        uploadedAt: "2026-08-12T06:00:00.000Z"
      },
      createdAt: "2026-08-12T06:00:00.000Z"
    });
  }

  it("deletes a terminal COMPLETED Run, removes its rows and wipes the attempt workspace", async () => {
    const root = newRoot();
    const runner = trackedRunner(root);
    const imported = importOneDrawing(runner, root, "PDJF-RUNDEL");
    // Runner-level createRun does NOT wake the queue; the facade's runQueue()
    // drives the QUEUED Run to COMPLETED (the default Runner publishes a
    // PENDING_REVIEW Model, which the deletion then removes too).
    const run = runner.createRun({
      drawingId: imported.drawing.id,
      revisionId: imported.revision.id
    });
    await runner.runQueue();
    const detail = runner.getRunDetail(run.id);
    expect(detail.run.status).toBe("COMPLETED");

    // The executor created the isolated attempt workspace subtree.
    const attemptWorkspace = join(root, "workspaces", "runs", run.id, "attempt-001");
    expect(existsSync(attemptWorkspace)).toBe(true);

    const deleted = runner.deleteRun(run.id, imported.drawing.id, imported.revision.id);
    expect(deleted.runId).toBe(run.id);
    expect(deleted.attemptSequences).toEqual([1]);

    // Every read surface is now empty for the Run.
    expect(() => runner.getRunDetail(run.id)).toThrowError(NotFoundError);
    expect(runner.getRunList().some((item) => item.runId === run.id)).toBe(false);
    expect(runner.getRunCount()).toBe(0);

    // The attempt workspace subtree was wiped (including the empty parent).
    expect(existsSync(attemptWorkspace)).toBe(false);
    expect(existsSync(join(root, "workspaces", "runs", run.id))).toBe(false);
    runner.close();
  });

  it("rejects deleting an active QUEUED Run with RUN_NOT_TERMINAL", () => {
    const root = newRoot();
    const runner = trackedRunner(root);
    const imported = importOneDrawing(runner, root, "PDJF-RUNDELQ");
    const run = runner.createRun({
      drawingId: imported.drawing.id,
      revisionId: imported.revision.id
    });
    expect(run.status).toBe("QUEUED");
    expect(() => runner.deleteRun(run.id, imported.drawing.id, imported.revision.id)).toThrowError(
      expect.objectContaining({
        code: "DOMAIN_INVARIANT",
        details: expect.objectContaining({ reason: "RUN_NOT_TERMINAL" }) as object
      })
    );
    runner.close();
  });

  it("rejects deleting a COMPLETED Run whose drawing/revision pair does not match", async () => {
    const root = newRoot();
    const runner = trackedRunner(root);
    const imported = importOneDrawing(runner, root, "PDJF-RUNDELW");
    const run = runner.createRun({
      drawingId: imported.drawing.id,
      revisionId: imported.revision.id
    });
    await runner.runQueue();
    expect(runner.getRunDetail(run.id).run.status).toBe("COMPLETED");
    expect(() => runner.deleteRun(run.id, "drawing-other", "revision-other")).toThrowError(
      expect.objectContaining({ code: "DOMAIN_INVARIANT" })
    );
    // The Run survives the rejected deletion.
    expect(runner.getRunDetail(run.id).run.status).toBe("COMPLETED");
    runner.close();
  });
});
