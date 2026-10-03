import { createHash } from "node:crypto";
import type { DeletionImpact } from "@swpanel/contracts";
import type { SqliteDatabase } from "../db/database.js";
import type { DrawingFileLedger } from "../ledger/drawing-file-ledger.js";
import type { RunWorkspaceLedger } from "../ledger/run-workspace-ledger.js";
import { EntityConflictError, NotFoundError, RunnerError } from "../errors.js";

type Kind = "drawing" | "model";
type Row = Record<string, string | number | null>;
type Cleanup = { kind: "source"; relativePath: string } | { kind: "attempt"; runId: string; attemptSequence: number } | { kind: "artifact"; runId: string; attemptSequence: number; relativePath: string };
const CLEANUP_KEY = "business_deletion_cleanup";

/** Explicit hard deletion. The confirmation describes the exact dependency set. */
export class BusinessDeletionService {
  constructor(private readonly db: SqliteDatabase, private readonly drawingLedger: DrawingFileLedger, private readonly workspace: () => RunWorkspaceLedger | null) {}

  private rows(sql: string, id: string): Row[] { return this.db.prepare(sql).all(id) as Row[]; }

  private collect(kind: Kind, id: string) {
    const head = this.rows(kind === "drawing" ? "SELECT * FROM drawings WHERE id=?" : "SELECT * FROM models WHERE id=?", id);
    if (!head.length) throw new NotFoundError("The object no longer exists");
    const revisions = kind === "drawing" ? this.rows("SELECT * FROM drawing_revisions WHERE drawing_id=? ORDER BY id", id) : [];
    const runs = this.rows(kind === "drawing" ? "SELECT * FROM runs WHERE drawing_id=? ORDER BY id" : "SELECT * FROM runs WHERE id=(SELECT run_id FROM models WHERE id=?)", id);
    const models = kind === "drawing" ? this.rows("SELECT * FROM models WHERE drawing_id=? ORDER BY id", id) : head;
    const reviews = this.rows(kind === "drawing" ? "SELECT * FROM model_reviews WHERE model_id IN (SELECT id FROM models WHERE drawing_id=?) ORDER BY id" : "SELECT * FROM model_reviews WHERE model_id=? ORDER BY id", id);
    const reports = this.rows(kind === "drawing" ? "SELECT * FROM cost_reports WHERE drawing_id=? ORDER BY id" : "SELECT * FROM cost_reports WHERE model_id=? ORDER BY id", id);
    const artifacts = this.rows(kind === "drawing" ? "SELECT * FROM artifacts WHERE run_id IN (SELECT id FROM runs WHERE drawing_id=?) ORDER BY id" : "SELECT * FROM artifacts WHERE model_id=? ORDER BY id", id);
    const sources = kind === "drawing" ? this.rows("SELECT * FROM revision_files WHERE id IN (SELECT source_file_id FROM drawing_revisions WHERE drawing_id=?) ORDER BY id", id) : [];
    const attempts = kind === "drawing" ? this.rows("SELECT run_id,attempt_sequence FROM run_attempts WHERE run_id IN (SELECT id FROM runs WHERE drawing_id=?) ORDER BY run_id,attempt_sequence", id) : [];
    const facts = kind === "drawing" ? this.rows("SELECT * FROM revision_facts WHERE revision_id IN (SELECT id FROM drawing_revisions WHERE drawing_id=?) ORDER BY id", id) : [];
    const feedback = kind === "drawing" ? this.rows("SELECT * FROM modeling_feedback WHERE revision_id IN (SELECT id FROM drawing_revisions WHERE drawing_id=?) ORDER BY id", id) : [];
    const data = { head, revisions, runs, models, reviews, reports, artifacts, sources, attempts, facts, feedback };
    const blocked = runs.some(run => !["COMPLETED", "FAILED", "CANCELLED"].includes(String(run.status)));
    const impact: DeletionImpact = {
      kind, id, confirmationToken: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
      canDelete: !blocked,
      blockingReason: blocked ? "请先取消尚未结束的建模任务；存在待澄清任务时暂不可删除。" : null,
      counts: { revisions: revisions.length, runs: kind === "drawing" ? runs.length : 0, models: models.length, reviews: reviews.length, costReports: reports.length, artifacts: artifacts.length, sourceFiles: sources.length },
      clearsCurrentApproved: kind === "drawing" ? revisions.some(revision => revision.current_approved_model_id !== null) : this.rows("SELECT id FROM drawing_revisions WHERE current_approved_model_id=?", id).length > 0
    };
    return { data, impact };
  }

  getImpact(kind: Kind, id: string): DeletionImpact { return this.db.transaction(() => this.collect(kind, id).impact); }

  delete(kind: Kind, id: string, confirmationToken: string): { deletedId: string; cleanupWarnings: string[] } {
    this.db.transaction(() => {
      const { data, impact } = this.collect(kind, id);
      if (!impact.canDelete) throw new EntityConflictError("Deletion is blocked by unfinished work");
      if (impact.confirmationToken !== confirmationToken) throw new EntityConflictError("Dependencies changed; review the deletion impact again");
      const jobs: Cleanup[] = [];
      if (kind === "drawing") {
        for (const attempt of data.attempts) jobs.push({ kind: "attempt", runId: String(attempt.run_id), attemptSequence: Number(attempt.attempt_sequence) });
        this.db.prepare("UPDATE drawings SET current_revision_id=NULL WHERE id=?").run(id);
        // Child-first order keeps every FK enabled throughout the transaction.
        for (const table of ["clarification_answers", "clarification_questions"]) {
          this.db.prepare(`DELETE FROM ${table} WHERE request_id IN (SELECT id FROM clarification_requests WHERE run_id IN (SELECT id FROM runs WHERE drawing_id=?))`).run(id);
        }
        for (const table of ["clarification_requests", "run_events", "run_attempts", "run_input_snapshots", "artifacts"]) {
          this.db.prepare(`DELETE FROM ${table} WHERE run_id IN (SELECT id FROM runs WHERE drawing_id=?)`).run(id);
        }
        this.db.prepare("DELETE FROM model_reviews WHERE model_id IN (SELECT id FROM models WHERE drawing_id=?)").run(id);
        for (const table of ["cost_reports", "models", "runs"]) this.db.prepare(`DELETE FROM ${table} WHERE drawing_id=?`).run(id);
        for (const table of ["revision_facts", "modeling_feedback"]) this.db.prepare(`DELETE FROM ${table} WHERE revision_id IN (SELECT id FROM drawing_revisions WHERE drawing_id=?)`).run(id);
        this.db.prepare("DELETE FROM drawing_revisions WHERE drawing_id=?").run(id);
        this.db.prepare("DELETE FROM drawings WHERE id=?").run(id);
        for (const source of data.sources) {
          if (!this.db.prepare("SELECT id FROM drawing_revisions WHERE source_file_id=?").get(source.id!)) {
            this.db.prepare("DELETE FROM revision_files WHERE id=?").run(source.id!);
            jobs.push({ kind: "source", relativePath: String(source.relative_path) });
          }
        }
      } else {
        for (const artifact of data.artifacts) {
          const sequence = /(?:^|\/)attempt-(\d+)\//.exec(String(artifact.relative_path))?.[1];
          if (sequence !== undefined) jobs.push({ kind: "artifact", runId: String(artifact.run_id), attemptSequence: Number(sequence), relativePath: String(artifact.relative_path).replace(/^.*?attempt-\d+\//, "") });
        }
        this.db.prepare("UPDATE drawing_revisions SET current_approved_model_id=NULL WHERE current_approved_model_id=?").run(id);
        this.db.prepare("UPDATE runs SET model_id=NULL WHERE model_id=?").run(id);
        // Keep accumulated modeling experience but remove dangling identity links.
        this.db.prepare("UPDATE modeling_feedback SET model_id=NULL,review_id=NULL WHERE model_id=?").run(id);
        for (const table of ["cost_reports", "model_reviews", "artifacts"]) this.db.prepare(`DELETE FROM ${table} WHERE model_id=?`).run(id);
        this.db.prepare("DELETE FROM models WHERE id=?").run(id);
      }
      const pending = this.readCleanup();
      this.writeCleanup([...pending, ...jobs]);
    });
    return { deletedId: id, cleanupWarnings: this.retryCleanup() };
  }

  private readCleanup(): Cleanup[] {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(CLEANUP_KEY) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as Cleanup[] : [];
  }
  private writeCleanup(jobs: Cleanup[]): void {
    this.db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(CLEANUP_KEY, JSON.stringify(jobs), new Date().toISOString());
  }
  /** Durable cleanup retries never turn an already committed deletion into a failure. */
  retryCleanup(): string[] {
    const remaining: Cleanup[] = [];
    try {
      for (const job of this.readCleanup()) {
        try {
          if (job.kind === "source") this.drawingLedger.deleteOwnedFile(job.relativePath);
          else {
            const workspace = this.workspace();
            if (!workspace) throw new Error("Workspace is unavailable");
            if (job.kind === "attempt") workspace.deleteAttemptWorkspace(job.runId, job.attemptSequence);
            else workspace.deleteOwnedFile(job);
          }
        } catch (error) { if (!(error instanceof RunnerError && error.code === "LEDGER_FILE_MISSING")) remaining.push(job); }
      }
      this.db.transaction(() => this.writeCleanup(remaining));
    } catch { return ["文件清理稍后重试；业务记录已删除。"] ; }
    return remaining.length ? ["部分文件清理稍后重试；业务记录已删除。"] : [];
  }
}
