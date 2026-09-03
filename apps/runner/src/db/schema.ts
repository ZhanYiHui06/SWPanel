import type { DatabaseSync } from "node:sqlite";

/**
 * SQLite schema for the Agent Runner structured store.
 *
 * Version 1 covers the Phase 2 entity groups structurally: Drawing, Revision,
 * Revision Facts, Modeling Feedback and Storage Settings are fully persisted;
 * Run / Model / Review / Cost tables exist structurally so later phases can
 * migrate them without rewriting this slice. The Runner is the only writer.
 *
 * Version 2 (Phase 3, forward migration only — v1 semantics are untouched)
 * adds the Run read-model columns (stage/activity/progress, timestamps,
 * failure, clarification/model pointers, cancellation request), the attempt
 * status plus owner/claim/lease/heartbeat/runtime/recovery columns with their
 * uniqueness constraints, the run-event attempt reference, the unique
 * per-revision Run number (R01/R02/...), and the queue / active-run / lease
 * lookup indexes. The `run_events(run_id, sequence)` unique constraint from v1
 * is preserved.
 *
 * Version 3 (Phase 3, P3-4 review fix): the attempt `kind` column
 * (EXECUTION vs CANCELLATION). The one-unfinished-attempt-per-owner
 * constraint becomes EXECUTION-scoped, so a queued cancellation can mint its
 * ephemeral cancellation-scoped attempt (the mandatory event attemptId of the
 * cancellation pair) while the same Runner is executing another Run — the
 * cancellation attempt is minted AND finished CANCELLED in one transaction and
 * never occupies the execution slot. Existing rows are backfilled as
 * EXECUTION; the old index is replaced.
 *
 * Version 4 (Phase 5, P5-2): the atomic Model publication. `models` gains the
 * persisted validation summary (JSON) and the optional build report summary;
 * a UNIQUE per-revision Model number (M01/M02/...) defends the allocation the
 * publication transaction derives (mirroring the per-revision Run number), and
 * lookup indexes cover Model-by-revision / Model-by-run and Artifact-by-run /
 * Artifact-by-model reads. The Artifact `(run_id, relative_path)` pair is
 * unique: one Run can never record two metadata rows for the same canonical
 * workspace-relative file. All v4 additions are forward-only — existing rows
 * and columns are never rewritten; no v1 table is rebuilt (SQLite cannot add
 * FK constraints via ALTER, so the defenses are index-based, which is exactly
 * what is migration-safe for existing databases).
 *
 * Version 5 (Phase 5 truthfulness hardening): `models.production_verified` is
 * the persisted production-verification claim the atomic publication writes
 * directly from the STRICTLY validated Result Manifest. The column is
 * `NOT NULL DEFAULT 0` with a 0/1 CHECK, so every row — including v1-era
 * structural rows — truthfully reads `false` unless the manifest claimed
 * production verification; no existing row is rewritten.
 *
 * Version 6 (Phase 6, P6-* model review): a Model may be reviewed exactly once
 * (`idx_model_reviews_model_id`), mirroring the domain's irreversibility of a
 * review outcome — a human review record exists once and is never re-edited;
 * fixing a rejected Model requires a new Modeling Run. Forward-only: existing
 * rows and columns are never rewritten.
 *
 * Version 7 (Phase 7, Cost Data & Deterministic Engine): indexes for
 * `cost_reports` by revision_id and model_id to accelerate cost report lookups.
 */
export const SCHEMA_VERSION = 7 as const;

export interface SchemaMigration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Table creation runs inside one transaction per migration version. The
 * `schema_migrations` row is written in the same transaction, so a failed
 * migration rolls back both its DDL and the version marker.
 */
export const MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: "phase2-structured-store",
    sql: `
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE revision_files (
        id            TEXT PRIMARY KEY,
        file_name     TEXT NOT NULL,
        format        TEXT NOT NULL CHECK (format IN ('PDF', 'DWG', 'DXF')),
        size_bytes    INTEGER NOT NULL,
        sha256        TEXT NOT NULL,
        mime_type     TEXT,
        relative_path TEXT NOT NULL UNIQUE,
        uploaded_at   TEXT NOT NULL
      ) STRICT;

      CREATE TABLE drawings (
        id                  TEXT PRIMARY KEY,
        drawing_number      TEXT NOT NULL UNIQUE,
        name                TEXT NOT NULL,
        current_revision_id TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        FOREIGN KEY (current_revision_id) REFERENCES drawing_revisions(id)
      ) STRICT;

      CREATE TABLE drawing_revisions (
        id                       TEXT PRIMARY KEY,
        drawing_id               TEXT NOT NULL,
        sequence                 INTEGER NOT NULL,
        source_file_id           TEXT NOT NULL,
        current_approved_model_id TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL,
        UNIQUE (drawing_id, sequence),
        FOREIGN KEY (drawing_id) REFERENCES drawings(id),
        FOREIGN KEY (source_file_id) REFERENCES revision_files(id)
      ) STRICT;
      CREATE INDEX idx_drawing_revisions_drawing_id ON drawing_revisions(drawing_id);

      CREATE TABLE revision_facts (
        id            TEXT PRIMARY KEY,
        revision_id   TEXT NOT NULL,
        field         TEXT NOT NULL,
        value         TEXT NOT NULL,
        unit          TEXT,
        source        TEXT NOT NULL CHECK (source IN ('USER_SUPPLEMENT', 'DRAWING_CONFIRMED', 'CLARIFICATION')),
        source_run_id TEXT,
        created_at    TEXT NOT NULL,
        created_by    TEXT,
        FOREIGN KEY (revision_id) REFERENCES drawing_revisions(id)
      ) STRICT;
      CREATE INDEX idx_revision_facts_revision_id ON revision_facts(revision_id);

      CREATE TABLE modeling_feedback (
        id          TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL,
        model_id    TEXT,
        review_id   TEXT,
        content     TEXT NOT NULL,
        source      TEXT NOT NULL CHECK (source IN ('MODEL_REVIEW_REJECTED', 'USER_SUPPLEMENT')),
        created_at  TEXT NOT NULL,
        FOREIGN KEY (revision_id) REFERENCES drawing_revisions(id)
      ) STRICT;
      CREATE INDEX idx_modeling_feedback_revision_id ON modeling_feedback(revision_id);

      CREATE TABLE runs (
        id          TEXT PRIMARY KEY,
        number      TEXT NOT NULL,
        drawing_id  TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        status      TEXT NOT NULL,
        created_at  TEXT NOT NULL
      ) STRICT;

      CREATE TABLE run_input_snapshots (
        run_id      TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id)
      ) STRICT;

      CREATE TABLE run_attempts (
        id               TEXT PRIMARY KEY,
        run_id           TEXT NOT NULL,
        attempt_sequence INTEGER NOT NULL,
        created_at       TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id)
      ) STRICT;

      CREATE TABLE run_events (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id           TEXT NOT NULL,
        sequence         INTEGER NOT NULL,
        contract_version INTEGER NOT NULL,
        payload_json     TEXT NOT NULL,
        occurred_at      TEXT NOT NULL,
        UNIQUE (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES runs(id)
      ) STRICT;
      CREATE INDEX idx_run_events_run_id ON run_events(run_id);

      CREATE TABLE clarification_requests (
        id          TEXT PRIMARY KEY,
        run_id      TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        status      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id)
      ) STRICT;

      CREATE TABLE clarification_questions (
        id           TEXT PRIMARY KEY,
        request_id   TEXT NOT NULL,
        sort_order   INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES clarification_requests(id)
      ) STRICT;

      CREATE TABLE clarification_answers (
        id          TEXT PRIMARY KEY,
        request_id  TEXT NOT NULL,
        question_id TEXT NOT NULL,
        value_json  TEXT NOT NULL,
        answered_at TEXT NOT NULL,
        answered_by TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES clarification_requests(id)
      ) STRICT;

      CREATE TABLE models (
        id            TEXT PRIMARY KEY,
        number        TEXT NOT NULL,
        drawing_id    TEXT NOT NULL,
        revision_id   TEXT NOT NULL,
        run_id        TEXT NOT NULL,
        review_status TEXT NOT NULL,
        generated_at  TEXT NOT NULL
      ) STRICT;

      CREATE TABLE model_reviews (
        id          TEXT PRIMARY KEY,
        model_id    TEXT NOT NULL,
        result      TEXT NOT NULL,
        reviewer_id TEXT NOT NULL,
        comment     TEXT,
        created_at  TEXT NOT NULL,
        FOREIGN KEY (model_id) REFERENCES models(id)
      ) STRICT;

      CREATE TABLE artifacts (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL,
        model_id      TEXT,
        kind          TEXT NOT NULL,
        file_name     TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        size_bytes    INTEGER NOT NULL,
        sha256        TEXT NOT NULL,
        mime_type     TEXT,
        created_at    TEXT NOT NULL
      ) STRICT;

      CREATE TABLE cost_data_definitions (
        id        TEXT PRIMARY KEY,
        key       TEXT NOT NULL UNIQUE,
        name      TEXT NOT NULL,
        kind      TEXT NOT NULL,
        semantics TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE cost_data_values (
        id            TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL,
        payload_json  TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        FOREIGN KEY (definition_id) REFERENCES cost_data_definitions(id)
      ) STRICT;

      CREATE TABLE cost_reports (
        id            TEXT PRIMARY KEY,
        label         TEXT NOT NULL,
        drawing_id    TEXT NOT NULL,
        revision_id   TEXT NOT NULL,
        model_id      TEXT NOT NULL,
        quantity      REAL NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      ) STRICT;
    `
  },
  {
    version: 2,
    name: "phase3-run-orchestration",
    sql: `
      -- Runs: Phase 3 read-model columns. These are the event-projection
      -- targets written atomically by the Runner repository; all nullable,
      -- value semantics enforced at the application layer (v1 kept status
      -- unconstrained the same way). No v1 row or column is rewritten.

      ALTER TABLE runs ADD COLUMN stage TEXT;
      ALTER TABLE runs ADD COLUMN activity TEXT;
      ALTER TABLE runs ADD COLUMN progress_percent INTEGER;
      ALTER TABLE runs ADD COLUMN started_at TEXT;
      ALTER TABLE runs ADD COLUMN completed_at TEXT;
      ALTER TABLE runs ADD COLUMN failure_code TEXT;
      ALTER TABLE runs ADD COLUMN failure_message TEXT;
      ALTER TABLE runs ADD COLUMN clarification_request_id TEXT;
      ALTER TABLE runs ADD COLUMN model_id TEXT;
      ALTER TABLE runs ADD COLUMN cancellation_requested_at TEXT;
      ALTER TABLE runs ADD COLUMN cancellation_requested_reason TEXT;
      ALTER TABLE runs ADD COLUMN cancellation_confirmed_at TEXT;

      -- Queue: atomic claim of the earliest QUEUED Run (status, created_at).
      CREATE INDEX idx_runs_queue ON runs(status, created_at);
      -- Active Run lookup plus serial-execution invariant: at most one
      -- RUNNING Run at any time (defense in depth).
      CREATE UNIQUE INDEX idx_runs_single_running ON runs(status) WHERE status = 'RUNNING';
      -- Per-revision Run history (Drawing Runs / Run detail projection).
      CREATE INDEX idx_runs_revision_id ON runs(revision_id);
      -- Per-revision Run labels (R01/R02/...) are unique: the repository
      -- derives the next number under the write transaction and this unique
      -- index defends against any concurrent duplicate.
      CREATE UNIQUE INDEX idx_runs_revision_number ON runs(revision_id, number);

      -- Attempts: lifecycle status plus owner/claim/lease/heartbeat/runtime/
      -- recovery fields. status is the persisted RunAttemptStatus; a terminal
      -- attempt (FINISHED / INTERRUPTED / CANCELLED) must always record
      -- finished_at (enforced by the domain finishRunAttempt helper).
      ALTER TABLE run_attempts ADD COLUMN status TEXT;
      ALTER TABLE run_attempts ADD COLUMN owner_token TEXT;
      ALTER TABLE run_attempts ADD COLUMN claimed_at TEXT;
      ALTER TABLE run_attempts ADD COLUMN lease_deadline_at TEXT;
      ALTER TABLE run_attempts ADD COLUMN heartbeat_at TEXT;
      ALTER TABLE run_attempts ADD COLUMN started_at TEXT;
      ALTER TABLE run_attempts ADD COLUMN finished_at TEXT;
      ALTER TABLE run_attempts ADD COLUMN interruption_kind TEXT;
      ALTER TABLE run_attempts ADD COLUMN recovery_decision TEXT;

      -- Attempt sequence is unique and strictly ordered within one Run.
      CREATE UNIQUE INDEX idx_run_attempts_run_sequence ON run_attempts(run_id, attempt_sequence);
      CREATE INDEX idx_run_attempts_run_id ON run_attempts(run_id);
      -- A Runner owner holds at most one unfinished attempt at a time.
      CREATE UNIQUE INDEX idx_run_attempts_one_active_per_owner
        ON run_attempts(owner_token)
        WHERE owner_token IS NOT NULL AND finished_at IS NULL;
      -- Expired-lease sweep and heartbeat owner checks.
      CREATE INDEX idx_run_attempts_lease_deadline
        ON run_attempts(lease_deadline_at)
        WHERE lease_deadline_at IS NOT NULL;
      CREATE INDEX idx_run_attempts_owner
        ON run_attempts(owner_token)
        WHERE owner_token IS NOT NULL;

      -- Events carry the attempt that produced them (envelope field). The
      -- column is nullable so pre-attempt synthetic events remain representable,
      -- but the repository always writes the attemptId it was given.
      ALTER TABLE run_events ADD COLUMN attempt_id TEXT;
    `
  },
  {
    version: 3,
    name: "phase3-attempt-kind",
    sql: `
      -- Attempt kind: EXECUTION attempts (atomic claims and recovery mints)
      -- own the one-unfinished-attempt-per-owner slot; CANCELLATION attempts
      -- are the ephemeral event-carrier of a QUEUED cancellation, minted AND
      -- finished CANCELLED inside the same transaction, so they must never
      -- collide with the execution slot. The queued cancellation of one Run
      -- can therefore proceed while another Run of the same Runner executes.
      ALTER TABLE run_attempts ADD COLUMN kind TEXT;
      UPDATE run_attempts SET kind = 'EXECUTION' WHERE kind IS NULL;
      DROP INDEX idx_run_attempts_one_active_per_owner;
      CREATE UNIQUE INDEX idx_run_attempts_one_active_execution_per_owner
        ON run_attempts(owner_token)
        WHERE owner_token IS NOT NULL AND finished_at IS NULL AND kind = 'EXECUTION';
    `
  },
  {
    version: 4,
    name: "phase5-model-publication",
    sql: `
      -- Models: the publication transaction persists the STRICTLY validated
      -- Result Manifest summary (P5-2). Both columns are nullable so v1-era
      -- structural rows (none exist yet — Model persistence arrives with this
      -- migration) and any future legacy data remain representable; no existing
      -- row is rewritten.

      ALTER TABLE models ADD COLUMN validation_summary_json TEXT;
      ALTER TABLE models ADD COLUMN build_report_summary TEXT;

      -- Per-revision Model numbers (M01/M02/...) are unique: the publisher
      -- derives the next number under its write transaction and this unique
      -- index defends against any concurrent duplicate (mirrors
      -- idx_runs_revision_number).
      CREATE UNIQUE INDEX idx_models_revision_number ON models(revision_id, number);
      -- Per-revision Model history and per-Run Model lookup projections.
      CREATE INDEX idx_models_revision_id ON models(revision_id);
      CREATE INDEX idx_models_run_id ON models(run_id);

      -- Artifact metadata rows of one Run, and Artifacts published under one
      -- Model. One Run can never record two rows for the same canonical
      -- workspace-relative file (the validator verifies each declared artifact
      -- exactly once before publication).
      CREATE INDEX idx_artifacts_run_id ON artifacts(run_id);
      CREATE INDEX idx_artifacts_model_id ON artifacts(model_id) WHERE model_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_artifacts_run_path ON artifacts(run_id, relative_path);
    `
  },
  {
    version: 5,
    name: "phase5-production-verification",
    sql: `
      -- Models: the persisted production-verification claim (P5 truthfulness
      -- hardening). The atomic publisher writes it from the STRICTLY validated
      -- Result Manifest's productionVerified field — never from a separate
      -- in-memory Agent claim. NOT NULL DEFAULT 0 keeps every existing (and
      -- future structural) row truthfully unverified; the CHECK confines the
      -- column to the two legal values. Forward-only: no existing row is
      -- rewritten.

      ALTER TABLE models ADD COLUMN production_verified INTEGER NOT NULL DEFAULT 0
        CHECK (production_verified IN (0, 1));
    `
  },
  {
    version: 6,
    name: "phase6-model-reviews",
    sql: `
      -- One Review per Model: the model_reviews(model_id) unique index defends
      -- the domain's one-shot review semantics (P6). A human review record
      -- exists exactly once and is never re-edited; fixing a rejected Model
      -- requires a new Modeling Run. The unique Application-visible check is
      -- PENDING_REVIEW status; this index is the DB-level defense in depth.
      CREATE UNIQUE INDEX idx_model_reviews_model_id ON model_reviews(model_id);
    `
  },
  {
    version: 7,
    name: "phase7-cost-engine",
    sql: `
      -- Per-revision and per-model cost report indexes.
      CREATE INDEX idx_cost_reports_revision_id ON cost_reports(revision_id);
      CREATE INDEX idx_cost_reports_model_id ON cost_reports(model_id);
    `
  }
];

/** Storage settings keys persisted in the `settings` table. */
export const SETTING_KEYS = {
  dataRoot: "storage.data_root",
  workspaceRoot: "storage.workspace_root",
  constraint: "storage.constraint",
  updatedAt: "storage.updated_at"
} as const;

/**
 * Migrates a freshly opened database up to `SCHEMA_VERSION`. `CREATE TABLE IF
 * NOT EXISTS schema_migrations` runs outside a transaction (SQLite reserves it
 * only for the migration DDL below); every versioned migration batch then runs
 * in its own transaction.
 */
export function migrateSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const appliedRow = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number };

  const applied = appliedRow.version;
  for (const migration of MIGRATIONS) {
    if (migration.version <= applied) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString()
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
