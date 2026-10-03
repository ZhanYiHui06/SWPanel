import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runner } from "../runner.js";
import { SqliteDatabase } from "../db/database.js";
import { DrawingFileLedger } from "../ledger/drawing-file-ledger.js";
import { RunWorkspaceLedger } from "../ledger/run-workspace-ledger.js";
import { BusinessDeletionService } from "./business-deletion-service.js";
import { makeTempDir, removeTempDir } from "../test-utils.js";

const time = "2026-08-18T01:00:00.000Z";
const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const root = makeTempDir("business-deletion");
  const runner = new Runner(root); runner.open();
  const db = new SqliteDatabase({ dbPath: join(root, "state", "swpanel.db") }); db.open();
  const drawingLedger = new DrawingFileLedger({ dataRoot: root }); drawingLedger.open();
  const workspace = new RunWorkspaceLedger({ workspaceRoot: join(root, "workspaces") }); workspace.open();
  const service = new BusinessDeletionService(db, drawingLedger, () => workspace);
  cleanups.push(() => { workspace.close(); drawingLedger.close(); db.close(); runner.close(); removeTempDir(root); });
  function populate(label: string) {
    const sourcePath = join(root, `${label}.pdf`); writeFileSync(sourcePath, "%PDF-1.4 fixture");
    const { drawing, revision } = runner.importDrawing({ drawingNumber: label, name: label, sourceFile: { sourcePath, fileName: `${label}.pdf`, format: "PDF", uploadedAt: time }, createdAt: time });
    const run = runner.createRun({ drawingId: drawing.id, revisionId: revision.id });
    db.prepare("UPDATE runs SET status='COMPLETED',model_id=? WHERE id=?").run(`model-${label}`, run.id);
    db.prepare("INSERT INTO run_attempts (id,run_id,attempt_sequence,created_at,status) VALUES (?,?,1,?,'FINISHED')").run(`attempt-${label}`, run.id, time);
    db.prepare("INSERT INTO run_events (run_id,sequence,contract_version,payload_json,occurred_at) VALUES (?,99,1,'{}',?)").run(run.id,time);
    db.prepare("INSERT INTO models (id,number,drawing_id,revision_id,run_id,review_status,generated_at) VALUES (?,'M01',?,?,?,'APPROVED',?)").run(`model-${label}`,drawing.id,revision.id,run.id,time);
    db.prepare("UPDATE drawing_revisions SET current_approved_model_id=? WHERE id=?").run(`model-${label}`,revision.id);
    db.prepare("INSERT INTO model_reviews (id,model_id,result,reviewer_id,created_at) VALUES (?,?,'APPROVED','user',?)").run(`review-${label}`,`model-${label}`,time);
    db.prepare("INSERT INTO revision_facts (id,revision_id,field,value,source,created_at) VALUES (?,?,'material','steel','USER_SUPPLEMENT',?)").run(`fact-${label}`,revision.id,time);
    db.prepare("INSERT INTO modeling_feedback (id,revision_id,model_id,review_id,content,source,created_at) VALUES (?,?,?,?,'retain experience','USER_SUPPLEMENT',?)").run(`feedback-${label}`,revision.id,`model-${label}`,`review-${label}`,time);
    db.prepare("INSERT INTO cost_reports (id,label,drawing_id,revision_id,model_id,quantity,snapshot_json,created_at,updated_at) VALUES (?,'Q01',?,?,?,1,'{}',?,?)").run(`report-${label}`,drawing.id,revision.id,`model-${label}`,time,time);
    db.prepare("INSERT INTO clarification_requests (id,run_id,revision_id,status,created_at) VALUES (?,?,?,'ANSWERED',?)").run(`clarify-${label}`,run.id,revision.id,time);
    db.prepare("INSERT INTO clarification_questions (id,request_id,sort_order,payload_json) VALUES (?,?,0,'{}')").run(`question-${label}`,`clarify-${label}`);
    db.prepare("INSERT INTO clarification_answers (id,request_id,question_id,value_json,answered_at,answered_by) VALUES (?,?,?,'{}',?,'user')").run(`answer-${label}`,`clarify-${label}`,`question-${label}`,time);
    workspace.createAttemptWorkspace(run.id, 1);
    const artifact = workspace.writeOwnedFile({ runId: run.id, attemptSequence: 1, relativePath: "output/model.step", content: Buffer.from("owned-model") });
    db.prepare("INSERT INTO artifacts (id,run_id,model_id,kind,file_name,relative_path,size_bytes,sha256,created_at) VALUES (?,?,?,'STEP','model.step',?,?,?,?)").run(`artifact-${label}`,run.id,`model-${label}`,artifact.relativePath,artifact.sizeBytes,artifact.sha256,time);
    return { drawing, revision, run, modelId: `model-${label}`, artifact, source: runner.resolveLedgerPath(revision.sourceFile.relativePath) };
  }
  return { root, runner, db, drawingLedger, workspace, service, populate };
}

describe("business deletion", () => {
  it("deleting a terminal run also removes dependent quotes and retains feedback without dangling links", () => {
    const { db, runner, populate } = fixture(); const target = populate("target");
    runner.deleteRun(target.run.id, target.drawing.id, target.revision.id);
    expect(db.prepare("SELECT id FROM cost_reports WHERE model_id=?").get(target.modelId)).toBeUndefined();
    expect(db.prepare("SELECT model_id,review_id,content FROM modeling_feedback").get()).toMatchObject({ model_id: null, review_id: null, content: "retain experience" });
    expect(existsSync(target.source)).toBe(true);
    expect(existsSync(target.artifact.absolutePath)).toBe(false);
  });
  it("cascades a drawing across all child tables and owned files while preserving another drawing", () => {
    const { db, service, workspace, populate } = fixture(); const target = populate("target"); const other = populate("other");
    const impact = service.getImpact("drawing", target.drawing.id);
    expect(impact.counts).toMatchObject({ revisions: 1, runs: 1, models: 1, reviews: 1, costReports: 1, artifacts: 1, sourceFiles: 1 });
    expect(service.delete("drawing",target.drawing.id,impact.confirmationToken).cleanupWarnings).toEqual([]);
    for (const table of ["drawings","drawing_revisions","revision_files","runs","run_input_snapshots","run_attempts","run_events","models","model_reviews","cost_reports","artifacts","revision_facts","modeling_feedback","clarification_requests","clarification_questions","clarification_answers"]) {
      expect((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(1);
    }
    expect(existsSync(target.source)).toBe(false); expect(existsSync(workspace.workspaceLayout(target.run.id,1).absoluteRoot)).toBe(false);
    expect(existsSync(other.source)).toBe(true); expect(existsSync(other.artifact.absolutePath)).toBe(true);
  });
  it("deletes a model and its files but retains run, memory and original source", () => {
    const { db, service, populate } = fixture(); const target = populate("target");
    service.delete("model",target.modelId,service.getImpact("model",target.modelId).confirmationToken);
    for (const table of ["models","model_reviews","cost_reports","artifacts"]) expect((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(0);
    expect(db.prepare("SELECT model_id FROM runs WHERE id=?").get(target.run.id)).toMatchObject({ model_id: null });
    expect(db.prepare("SELECT current_approved_model_id FROM drawing_revisions WHERE id=?").get(target.revision.id)).toMatchObject({ current_approved_model_id: null });
    expect(db.prepare("SELECT model_id,review_id,content FROM modeling_feedback").get()).toMatchObject({ model_id: null, review_id: null, content: "retain experience" });
    expect(db.prepare("SELECT id FROM revision_facts").get()).toBeDefined();
    expect(existsSync(target.source)).toBe(true); expect(existsSync(target.artifact.absolutePath)).toBe(false);
  });
  it("blocks active and pending clarification runs, and expires confirmation after dependency changes", () => {
    const { db, runner, service, populate } = fixture(); const target = populate("target");
    for (const status of ["QUEUED","RUNNING","CLARIFICATION_REQUIRED"]) {
      db.prepare("UPDATE runs SET status=? WHERE id=?").run(status,target.run.id);
      for (const kind of ["drawing","model"] as const) {
        const impact = service.getImpact(kind,kind === "drawing" ? target.drawing.id : target.modelId);
        expect(impact.canDelete).toBe(false); expect(() => service.delete(kind,impact.id,impact.confirmationToken)).toThrow(/blocked/);
      }
    }
    db.prepare("UPDATE runs SET status='COMPLETED' WHERE id=?").run(target.run.id);
    const impact = service.getImpact("drawing",target.drawing.id);
    runner.addRevision({ drawingId: target.drawing.id, sourceFile: { sourcePath: target.source, fileName: "next.pdf", format: "PDF", uploadedAt: time }, createdAt: time });
    expect(() => service.delete("drawing",target.drawing.id,impact.confirmationToken)).toThrow(/changed/);
    db.prepare("DELETE FROM model_reviews WHERE model_id=?").run(target.modelId);
    const modelImpact = service.getImpact("model",target.modelId);
    db.prepare("INSERT INTO model_reviews (id,model_id,result,reviewer_id,created_at) VALUES ('new-review',?,'APPROVED','user',?)").run(target.modelId,time);
    expect(() => service.delete("model",target.modelId,modelImpact.confirmationToken)).toThrow(/changed/);
    expect(db.prepare("SELECT id FROM models WHERE id=?").get(target.modelId)).toBeDefined();
  });
  it("persists cleanup failures and retries across a Runner restart", () => {
    const { root, runner, db, drawingLedger, service, populate } = fixture(); const target = populate("target");
    const fault = vi.spyOn(drawingLedger,"deleteOwnedFile").mockImplementation(() => { throw new Error("disk unavailable"); });
    expect(service.delete("drawing",target.drawing.id,service.getImpact("drawing",target.drawing.id).confirmationToken).cleanupWarnings).toHaveLength(1);
    expect(existsSync(target.source)).toBe(true);
    expect(String((db.prepare("SELECT value FROM settings WHERE key='business_deletion_cleanup'").get() as { value: string }).value)).toContain(target.revision.sourceFile.id);
    fault.mockRestore(); runner.close();
    const restarted = new Runner(root); restarted.open();
    try { expect(existsSync(target.source)).toBe(false); expect(restarted.retryDeletionCleanup()).toEqual([]); } finally { restarted.close(); }
  });
  it("never follows a substituted attempt symlink outside the workspace", () => {
    const { root, service, workspace, populate } = fixture(); const target = populate("target");
    const outside = join(root,"outside"); mkdirSync(outside); const sentinel = join(outside,"sentinel"); writeFileSync(sentinel,"keep");
    const layout = workspace.workspaceLayout(target.run.id,1); workspace.deleteAttemptWorkspace(target.run.id,1);
    mkdirSync(join(root,"workspaces","runs",target.run.id),{ recursive: true }); symlinkSync(outside,layout.absoluteRoot);
    expect(service.delete("drawing",target.drawing.id,service.getImpact("drawing",target.drawing.id).confirmationToken).cleanupWarnings).toHaveLength(1);
    expect(existsSync(sentinel)).toBe(true); unlinkSync(layout.absoluteRoot);
    expect(service.retryCleanup()).toEqual([]); expect(existsSync(sentinel)).toBe(true);
  });
});
