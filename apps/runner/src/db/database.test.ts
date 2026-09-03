import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

import { SqliteDatabase } from "./database.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";
import { makeTempDir, removeTempDir } from "../test-utils.js";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

describe("SqliteDatabase", () => {
  let dir: string;
  beforeAll(() => {
    dir = makeTempDir("db");
  });
  afterAll(() => {
    removeTempDir(dir);
  });

  it("creates the database file, applies migrations and reports the schema version", () => {
    const dbPath = join(dir, "migrate", "swpanel.db");
    const db = new SqliteDatabase({ dbPath });
    db.open();
    expect(existsSync(dbPath)).toBe(true);
    expect(db.schemaVersion).toBe(SCHEMA_VERSION);
    expect(db.schemaVersion).toBe(7);
    db.close();
  });

  it("applies the Phase 3 v3 attempt kind column and the execution-scoped owner index", () => {
    const db = new SqliteDatabase({ dbPath: join(dir, "v3-attempt-kind", "swpanel.db") });
    db.open();
    expect(tableColumns(db, "run_attempts")).toContain("kind");
    const indexNamesNow = indexNames(db, "run_attempts");
    expect(indexNamesNow).toContain("idx_run_attempts_one_active_execution_per_owner");
    // The pre-v3 owner index is gone.
    expect(indexNamesNow).not.toContain("idx_run_attempts_one_active_per_owner");
    db.close();
  });

  it("scopes the one-active-per-owner index to EXECUTION attempts (B1)", () => {
    const db = new SqliteDatabase({ dbPath: join(dir, "v3-index-scope", "swpanel.db") });
    db.open();
    db.prepare(
      "INSERT INTO runs (id, number, drawing_id, revision_id, status, created_at) " +
        "VALUES (?, ?, 'drawing-1', 'rev-1', 'RUNNING', ?)"
    ).run("run-1", "R01", "2026-08-13T00:00:00.000Z");
    db.prepare(
      "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, kind, owner_token, created_at) " +
        "VALUES (?, ?, 1, 'ACTIVE', 'EXECUTION', 'owner-1', ?)"
    ).run("attempt-execution", "run-1", "2026-08-13T00:01:00.000Z");
    // A second unfinished EXECUTION attempt of the same owner is rejected...
    expect(() =>
      db
        .prepare(
          "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, kind, owner_token, created_at) " +
            "VALUES (?, ?, 2, 'ACTIVE', 'EXECUTION', 'owner-1', ?)"
        )
        .run("attempt-execution-2", "run-1", "2026-08-13T00:02:00.000Z")
    ).toThrow(/UNIQUE constraint failed/);
    // ...while a CANCELLATION attempt of the SAME owner coexists (the queued
    // cancellation of another Run while this Runner is executing).
    expect(() =>
      db
        .prepare(
          "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, kind, owner_token, created_at) " +
            "VALUES (?, ?, 3, 'ACTIVE', 'CANCELLATION', 'owner-1', ?)"
        )
        .run("attempt-cancellation", "run-1", "2026-08-13T00:03:00.000Z")
    ).not.toThrow();
    db.close();
  });

  it("applies the Phase 3 v2 run columns on a fresh database", () => {
    const db = new SqliteDatabase({ dbPath: join(dir, "v2-columns", "swpanel.db") });
    db.open();
    const runColumns = tableColumns(db, "runs");
    for (const column of [
      "stage",
      "activity",
      "progress_percent",
      "started_at",
      "completed_at",
      "failure_code",
      "failure_message",
      "clarification_request_id",
      "model_id",
      "cancellation_requested_at",
      "cancellation_requested_reason",
      "cancellation_confirmed_at"
    ]) {
      expect(runColumns).toContain(column);
    }
    const attemptColumns = tableColumns(db, "run_attempts");
    for (const column of [
      "status",
      "owner_token",
      "claimed_at",
      "lease_deadline_at",
      "heartbeat_at",
      "started_at",
      "finished_at",
      "interruption_kind",
      "recovery_decision"
    ]) {
      expect(attemptColumns).toContain(column);
    }
    const eventColumns = tableColumns(db, "run_events");
    expect(eventColumns).toContain("attempt_id");
    db.close();
  });

  it("migrates a version 1 database forward without rewriting v1 data", () => {
    const dbPath = join(dir, "v1-forward", "swpanel.db");
    // Build a genuine v1 database (migration 1 only, like a Phase 2 install).
    mkdirSync(dirname(dbPath), { recursive: true });
    const v1 = new DatabaseSync(dbPath);
    v1.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
    v1.exec(MIGRATIONS[0]!.sql);
    v1.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
      1,
      MIGRATIONS[0]!.name,
      "2026-08-12T00:00:00.000Z"
    );
    v1.prepare("INSERT INTO runs (id, number, drawing_id, revision_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      "run-v1",
      "R01",
      "drawing-1",
      "rev-1",
      "QUEUED",
      "2026-08-12T01:00:00.000Z"
    );
    // v1 run_attempts had no lifecycle columns: a genuine Phase 2 row.
    v1.prepare("INSERT INTO run_attempts (id, run_id, attempt_sequence, created_at) VALUES (?, ?, ?, ?)").run(
      "attempt-v1",
      "run-v1",
      1,
      "2026-08-12T01:05:00.000Z"
    );
    v1.close();

    // Reopening through the Runner applies migrations 2, 3, 4, 5, 6 and 7 on top.
    const db = new SqliteDatabase({ dbPath });
    db.open();
    expect(db.schemaVersion).toBe(7);
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get("run-v1") as {
      number: string;
      status: string;
      created_at: string;
      stage: string | null;
      model_id: string | null;
      cancellation_requested_at: string | null;
    };
    expect(run.number).toBe("R01");
    expect(run.status).toBe("QUEUED");
    expect(run.created_at).toBe("2026-08-12T01:00:00.000Z");
    expect(run.stage).toBeNull();
    expect(run.model_id).toBeNull();
    expect(run.cancellation_requested_at).toBeNull();
    const attempt = db
      .prepare("SELECT status, owner_token, finished_at, kind FROM run_attempts WHERE id = ?")
      .get("attempt-v1") as {
      status: string | null;
      owner_token: string | null;
      finished_at: string | null;
      kind: string | null;
    };
    expect(attempt.status).toBeNull();
    expect(attempt.owner_token).toBeNull();
    expect(attempt.finished_at).toBeNull();
    // The v3 backfill classifies the pre-kind row as an EXECUTION attempt.
    expect(attempt.kind).toBe("EXECUTION");
    expect(tableColumns(db, "run_events")).toContain("attempt_id");
    db.close();
  });

  it("enforces the run_attempts(run_id, attempt_sequence) uniqueness after migration", () => {
    const db = new SqliteDatabase({ dbPath: join(dir, "attempt-unique", "swpanel.db") });
    db.open();
    db.prepare("INSERT INTO runs (id, number, drawing_id, revision_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      "run-1",
      "R01",
      "drawing-1",
      "rev-1",
      "QUEUED",
      "2026-08-13T00:00:00.000Z"
    );
    const insert = db.prepare(
      "INSERT INTO run_attempts (id, run_id, attempt_sequence, created_at) VALUES (?, ?, ?, ?)"
    );
    insert.run("attempt-1", "run-1", 1, "2026-08-13T00:01:00.000Z");
    expect(() =>
      insert.run("attempt-2", "run-1", 1, "2026-08-13T00:02:00.000Z")
    ).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it("preserves the run_events(run_id, sequence) unique constraint across the migration", () => {
    const db = new SqliteDatabase({ dbPath: join(dir, "events-unique", "swpanel.db") });
    db.open();
    db.prepare("INSERT INTO runs (id, number, drawing_id, revision_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      "run-1",
      "R01",
      "drawing-1",
      "rev-1",
      "QUEUED",
      "2026-08-13T00:00:00.000Z"
    );
    const insert = db.prepare(
      "INSERT INTO run_events (run_id, sequence, contract_version, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)"
    );
    insert.run("run-1", 1, 1, "{}", "2026-08-13T00:01:00.000Z");
    expect(() =>
      insert.run("run-1", 1, 1, "{}", "2026-08-13T00:02:00.000Z")
    ).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it("installs the queue, active-run and lease lookup indexes", () => {
    const db = new SqliteDatabase({ dbPath: join(dir, "v2-indexes", "swpanel.db") });
    db.open();
    expect(indexNames(db, "runs")).toContain("idx_runs_queue");
    expect(indexNames(db, "runs")).toContain("idx_runs_single_running");
    expect(indexNames(db, "runs")).toContain("idx_runs_revision_id");
    expect(indexNames(db, "runs")).toContain("idx_runs_revision_number");
    expect(indexNames(db, "run_attempts")).toContain("idx_run_attempts_run_sequence");
    expect(indexNames(db, "run_attempts")).toContain("idx_run_attempts_one_active_execution_per_owner");
    expect(indexNames(db, "run_attempts")).toContain("idx_run_attempts_lease_deadline");
    expect(indexNames(db, "run_attempts")).toContain("idx_run_attempts_owner");
    db.close();
  });

  it("enforces unique Run labels per revision", () => {
    const db = new SqliteDatabase({ dbPath: join(dir, "run-number-unique", "swpanel.db") });
    db.open();
    const insert = db.prepare(
      "INSERT INTO runs (id, number, drawing_id, revision_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    insert.run("run-1", "R01", "drawing-1", "rev-1", "QUEUED", "2026-08-13T00:00:00.000Z");
    insert.run("run-2", "R02", "drawing-1", "rev-1", "QUEUED", "2026-08-13T00:01:00.000Z");
    // Same number on the same revision is rejected...
    expect(() =>
      insert.run("run-3", "R01", "drawing-1", "rev-1", "QUEUED", "2026-08-13T00:02:00.000Z")
    ).toThrow(/UNIQUE constraint failed/);
    // ...while the same number on another revision is independent.
    expect(() =>
      insert.run("run-4", "R01", "drawing-1", "rev-2", "QUEUED", "2026-08-13T00:03:00.000Z")
    ).not.toThrow();
    db.close();
  });

  it("enables WAL journal mode, foreign keys and the busy timeout", () => {
    const db = new SqliteDatabase({ dbPath: join(dir, "pragmas", "swpanel.db"), busyTimeoutMs: 4_000 });
    db.open();
    expect(db.journalMode.toLowerCase()).toBe("wal");
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
    const busy = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    expect(busy.timeout).toBe(4_000);
    db.close();
  });

  it("applies the Phase 5 v4 model publication columns and defenses", () => {
    const db = new SqliteDatabase({ dbPath: join(dir, "v4-model-publication", "swpanel.db") });
    db.open();
    const modelColumns = tableColumns(db, "models");
    expect(modelColumns).toContain("validation_summary_json");
    expect(modelColumns).toContain("build_report_summary");
    const artifactColumns = tableColumns(db, "artifacts");
    for (const column of ["id", "run_id", "model_id", "kind", "file_name", "relative_path", "size_bytes", "sha256", "mime_type", "created_at"]) {
      expect(artifactColumns).toContain(column);
    }
    expect(indexNames(db, "models")).toContain("idx_models_revision_number");
    expect(indexNames(db, "models")).toContain("idx_models_revision_id");
    expect(indexNames(db, "models")).toContain("idx_models_run_id");
    expect(indexNames(db, "artifacts")).toContain("idx_artifacts_run_id");
    expect(indexNames(db, "artifacts")).toContain("idx_artifacts_model_id");
    expect(indexNames(db, "artifacts")).toContain("idx_artifacts_run_path");
    db.close();
  });

  it("enforces unique Model labels per revision (M01/M02/...) after migration", () => {
    const db = new SqliteDatabase({ dbPath: join(dir, "model-number-unique", "swpanel.db") });
    db.open();
    const insert = db.prepare(
      "INSERT INTO models (id, number, drawing_id, revision_id, run_id, review_status, generated_at) " +
        "VALUES (?, ?, 'drawing-1', ?, 'run-1', 'PENDING_REVIEW', ?)"
    );
    insert.run("model-1", "M01", "rev-1", "2026-08-13T00:00:00.000Z");
    insert.run("model-2", "M02", "rev-1", "2026-08-13T00:01:00.000Z");
    // Same number on the same revision is rejected...
    expect(() =>
      insert.run("model-3", "M01", "rev-1", "2026-08-13T00:02:00.000Z")
    ).toThrow(/UNIQUE constraint failed/);
    // ...while the same number on another revision is independent.
    expect(() =>
      insert.run("model-4", "M01", "rev-2", "2026-08-13T00:03:00.000Z")
    ).not.toThrow();
    db.close();
  });

  it("migrates a version 3 database forward to v5 without rewriting v3 data", () => {
    const dbPath = join(dir, "v3-forward", "swpanel.db");
    // Build a genuine v3 database (migrations 1..3 only, like a Phase 4 install).
    mkdirSync(dirname(dbPath), { recursive: true });
    const v3 = new DatabaseSync(dbPath);
    v3.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
    for (const migration of MIGRATIONS.slice(0, 3)) {
      v3.exec(migration.sql);
      v3.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        "2026-08-13T00:00:00.000Z"
      );
    }
    // A genuine v3 Run + EXECUTION attempt row.
    v3.prepare(
      "INSERT INTO runs (id, number, drawing_id, revision_id, status, created_at, model_id) " +
        "VALUES (?, ?, ?, ?, 'COMPLETED', ?, NULL)"
    ).run("run-v3", "R01", "drawing-1", "rev-1", "2026-08-13T01:00:00.000Z");
    v3.prepare(
      "INSERT INTO run_attempts (id, run_id, attempt_sequence, status, kind, owner_token, created_at) " +
        "VALUES (?, ?, 1, 'FINISHED', 'EXECUTION', 'owner-1', ?)"
    ).run("attempt-v3", "run-v3", "2026-08-13T01:05:00.000Z");
    v3.close();

    // Reopening through the Runner applies migrations 4, 5, 6 and 7 on top.
    const db = new SqliteDatabase({ dbPath });
    db.open();
    expect(db.schemaVersion).toBe(7);
    const run = db.prepare("SELECT status, model_id, number FROM runs WHERE id = ?").get("run-v3") as {
      status: string;
      model_id: string | null;
      number: string;
    };
    expect(run.status).toBe("COMPLETED");
    expect(run.model_id).toBeNull();
    expect(run.number).toBe("R01");
    const attempt = db
      .prepare("SELECT status, kind FROM run_attempts WHERE id = ?")
      .get("attempt-v3") as { status: string; kind: string };
    expect(attempt.status).toBe("FINISHED");
    expect(attempt.kind).toBe("EXECUTION");
    // The v4 additions are forward-only: the columns are nullable, the
    // per-revision Model number and artifact path defenses are installed.
    expect(tableColumns(db, "models")).toContain("validation_summary_json");
    expect(tableColumns(db, "models")).toContain("build_report_summary");
    expect(indexNames(db, "models")).toContain("idx_models_revision_number");
    expect(indexNames(db, "artifacts")).toContain("idx_artifacts_run_path");
    // The v5 production-verification column is installed.
    expect(tableColumns(db, "models")).toContain("production_verified");
    db.close();
  });

  it("migrates a version 4 database forward to v5 without rewriting v4 data", () => {
    const dbPath = join(dir, "v4-forward", "swpanel.db");
    // Build a genuine v4 database (migrations 1..4 only, like a Phase 5
    // P5-2 install with model publication).
    mkdirSync(dirname(dbPath), { recursive: true });
    const v4 = new DatabaseSync(dbPath);
    v4.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
    for (const migration of MIGRATIONS.slice(0, 4)) {
      v4.exec(migration.sql);
      v4.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        "2026-08-13T00:00:00.000Z"
      );
    }
    // A genuine v4 Model row with its persisted validation summary.
    v4.prepare(
      "INSERT INTO models (id, number, drawing_id, revision_id, run_id, review_status, generated_at, validation_summary_json, build_report_summary) " +
        "VALUES (?, 'M01', 'drawing-1', 'rev-1', 'run-1', 'PENDING_REVIEW', ?, ?, NULL)"
    ).run(
      "model-v4",
      "2026-08-13T01:00:00.000Z",
      JSON.stringify({
        solidWorksVersion: "2022",
        units: "mm",
        projectionDecision: "first-angle",
        featureCount: 4,
        bodyCount: 1,
        rebuildStatus: "PASSED",
        unresolvedAssumptions: []
      })
    );
    v4.close();

    // Reopening through the Runner applies migration 5, 6 and 7 on top.
    const db = new SqliteDatabase({ dbPath });
    db.open();
    expect(db.schemaVersion).toBe(7);
    expect(tableColumns(db, "models")).toContain("production_verified");
    // The existing row was NOT rewritten and truthfully reads unverified (the
    // column defaulted to 0 for every pre-v5 row).
    const legacy = db
      .prepare("SELECT number, review_status, production_verified FROM models WHERE id = ?")
      .get("model-v4") as { number: string; review_status: string; production_verified: number };
    expect(legacy).toMatchObject({ number: "M01", review_status: "PENDING_REVIEW", production_verified: 0 });
    // A verified claim is representable after migration...
    db.prepare(
      "INSERT INTO models (id, number, drawing_id, revision_id, run_id, review_status, generated_at, production_verified) " +
        "VALUES (?, 'M02', 'drawing-1', 'rev-1', 'run-1', 'PENDING_REVIEW', ?, 1)"
    ).run("model-v5-verified", "2026-08-13T02:00:00.000Z");
    // ...and the 0/1 CHECK confines the column to the two legal values.
    expect(() =>
      db
        .prepare(
          "INSERT INTO models (id, number, drawing_id, revision_id, run_id, review_status, generated_at, production_verified) " +
            "VALUES (?, 'M03', 'drawing-1', 'rev-1', 'run-1', 'PENDING_REVIEW', ?, 2)"
        )
        .run("model-v5-invalid", "2026-08-13T02:05:00.000Z")
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("migrates a version 5 database forward to v6 without rewriting v5 data", () => {
    const dbPath = join(dir, "v5-forward", "swpanel.db");
    // Build a genuine v5 database (migrations 1..5 only, like a Phase 5
    // P5-2/P5 install with production verification already applied).
    mkdirSync(dirname(dbPath), { recursive: true });
    const v5 = new DatabaseSync(dbPath);
    v5.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
    for (const migration of MIGRATIONS.slice(0, 5)) {
      v5.exec(migration.sql);
      v5.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        "2026-08-13T00:00:00.000Z"
      );
    }
    v5.prepare(
      "INSERT INTO models (id, number, drawing_id, revision_id, run_id, review_status, generated_at) " +
        "VALUES (?, 'M01', 'drawing-1', 'rev-1', 'run-1', 'PENDING_REVIEW', ?)"
    ).run("model-v5", "2026-08-13T01:00:00.000Z");
    v5.close();

    // Reopening through the Runner applies migration 6 and 7 on top; the v5 row is
    // untouched and still reviewable.
    const db = new SqliteDatabase({ dbPath });
    db.open();
    expect(db.schemaVersion).toBe(7);
    const legacy = db
      .prepare("SELECT number, review_status FROM models WHERE id = ?")
      .get("model-v5") as { number: string; review_status: string };
    expect(legacy).toMatchObject({ number: "M01", review_status: "PENDING_REVIEW" });
    expect(indexNames(db, "model_reviews")).toContain("idx_model_reviews_model_id");
    db.close();
  });

  it("enforces exactly one review per Model after the v6 migration", () => {
    const db = new SqliteDatabase({ dbPath: join(dir, "model-reviews-unique", "swpanel.db") });
    db.open();
    db.prepare(
      "INSERT INTO models (id, number, drawing_id, revision_id, run_id, review_status, generated_at) " +
        "VALUES (?, 'M01', 'drawing-1', 'rev-1', 'run-1', 'APPROVED', ?)"
    ).run("model-1", "2026-08-13T00:00:00.000Z");
    const insert = db.prepare(
      "INSERT INTO model_reviews (id, model_id, result, reviewer_id, comment, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)"
    );
    insert.run("review-1", "model-1", "APPROVED", "alice", null, "2026-08-13T01:00:00.000Z");
    // A second review row of the same Model is rejected by the unique index...
    expect(() =>
      insert.run("review-2", "model-1", "REJECTED", "bob", "尺寸不对", "2026-08-13T02:00:00.000Z")
    ).toThrow(/UNIQUE constraint failed/);
    // ...while another Model reviews independently.
    db.prepare(
      "INSERT INTO models (id, number, drawing_id, revision_id, run_id, review_status, generated_at) " +
        "VALUES (?, 'M02', 'drawing-1', 'rev-1', 'run-2', 'PENDING_REVIEW', ?)"
    ).run("model-2", "2026-08-13T00:05:00.000Z");
    expect(() =>
      insert.run("review-3", "model-2", "APPROVED", "alice", null, "2026-08-13T02:05:00.000Z")
    ).not.toThrow();
    db.close();
  });

  it("rolls back the whole transaction when work throws", () => {
    const db = new SqliteDatabase({ dbPath: join(dir, "rollback", "swpanel.db") });
    db.open();
    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
          "test.rollback",
          "value",
          new Date().toISOString()
        );
        throw new Error("boom");
      })
    ).toThrow("boom");
    const rows = db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = ?").get("test.rollback") as {
      count: number;
    };
    expect(rows.count).toBe(0);
    db.close();
  });

  it("commits work when the transaction succeeds", () => {
    const db = new SqliteDatabase({ dbPath: join(dir, "commit", "swpanel.db") });
    db.open();
    db.transaction(() => {
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
        "test.commit",
        "value",
        new Date().toISOString()
      );
    });
    const rows = db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = ?").get("test.commit") as {
      count: number;
    };
    expect(rows.count).toBe(1);
    db.close();
  });

  it("persists data across close/reopen (restart persistence)", () => {
    const dbPath = join(dir, "restart", "swpanel.db");
    const first = new SqliteDatabase({ dbPath });
    first.open();
    first
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run("test.restart", "survives", new Date().toISOString());
    first.close();

    const second = new SqliteDatabase({ dbPath });
    second.open();
    const row = second.prepare("SELECT value FROM settings WHERE key = ?").get("test.restart") as {
      value: string;
    };
    expect(row.value).toBe("survives");
    expect(second.journalMode.toLowerCase()).toBe("wal");
    second.close();
  });

  it("keeps nested savepoint transactions isolated on inner failure", () => {
    const db = new SqliteDatabase({ dbPath: join(dir, "savepoint", "swpanel.db") });
    db.open();
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
        "outer",
        "kept",
        now
      );
      expect(() =>
        db.transaction(() => {
          db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
            "inner",
            "discarded",
            now
          );
          throw new Error("inner boom");
        })
      ).toThrow("inner boom");
    });
    const outer = db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = ?").get("outer") as {
      count: number;
    };
    const inner = db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = ?").get("inner") as {
      count: number;
    };
    expect(outer.count).toBe(1);
    expect(inner.count).toBe(0);
    db.close();
  });

  it("rejects writes while the database is closed with a structured error", () => {
    const db = new SqliteDatabase({ dbPath: join(dir, "closed", "swpanel.db") });
    expect(() => db.prepare("SELECT 1").get()).toThrowError();
  });

  it("creates the parent state directory automatically", () => {
    const dbPath = join(dir, "nested", "deep", "state", "swpanel.db");
    const db = new SqliteDatabase({ dbPath });
    db.open();
    expect(existsSync(dbPath)).toBe(true);
    db.close();
  });

  describe("after-commit hooks (H1)", () => {
    it("fires hooks only after the outermost COMMIT", () => {
      const db = new SqliteDatabase({ dbPath: join(dir, "hooks-commit", "swpanel.db") });
      db.open();
      const fired: string[] = [];
      db.transaction(() => {
        db.onCommit(() => fired.push("outer"));
        db.transaction(() => {
          db.onCommit(() => fired.push("nested"));
        });
      });
      // Hooks of released savepoints fire together after the outer COMMIT.
      expect(fired).toEqual(["outer", "nested"]);
      db.close();
    });

    it("discards hooks of a rolled-back transaction: they never fire on a later commit", () => {
      const db = new SqliteDatabase({ dbPath: join(dir, "hooks-rollback", "swpanel.db") });
      db.open();
      const fired: string[] = [];
      // Hooks registered during a transaction that ROLLS BACK (both at the
      // outer level and inside a released savepoint) must be DISCARDED...
      expect(() =>
        db.transaction(() => {
          db.onCommit(() => fired.push("outer-rolled-back"));
          db.transaction(() => {
            db.onCommit(() => fired.push("nested-released-then-rolled-back"));
          });
          throw new Error("boom");
        })
      ).toThrow("boom");
      // ...so an unrelated later commit must NOT fire them.
      db.transaction(() => {
        db.onCommit(() => fired.push("fresh"));
      });
      expect(fired).toEqual(["fresh"]);
      db.close();
    });

    it("discards hooks of a rolled-back savepoint while keeping the outer transaction's hooks", () => {
      const db = new SqliteDatabase({ dbPath: join(dir, "hooks-savepoint", "swpanel.db") });
      db.open();
      const fired: string[] = [];
      db.transaction(() => {
        db.onCommit(() => fired.push("outer"));
        expect(() =>
          db.transaction(() => {
            db.onCommit(() => fired.push("inner-rolled-back"));
            throw new Error("boom-inner");
          })
        ).toThrow("boom-inner");
      });
      // The inner hook (registered inside the rolled-back savepoint) is gone;
      // the outer hook survives the inner rollback and fires on the commit.
      expect(fired).toEqual(["outer"]);
      db.close();
    });

    it("an explicit unsubscribe removes a pending hook", () => {
      const db = new SqliteDatabase({ dbPath: join(dir, "hooks-unsubscribe", "swpanel.db") });
      db.open();
      const fired: string[] = [];
      db.transaction(() => {
        const unsubscribe = db.onCommit(() => fired.push("removed"));
        unsubscribe();
      });
      expect(fired).toEqual([]);
      db.close();
    });
  });
});

/** Column names of a table (PRAGMA table_info), for schema-shape assertions. */
function tableColumns(db: SqliteDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/** Index names of a table (PRAGMA index_list), for index installation assertions. */
function indexNames(db: SqliteDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as unknown as Array<{ name: string }>;
  return rows.map((row) => row.name);
}
