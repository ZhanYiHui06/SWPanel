import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { RunnerError } from "../errors.js";
import { SCHEMA_VERSION, migrateSchema } from "./schema.js";

export interface SqliteDatabaseOptions {
  /** Absolute path of the SQLite database file. Parent directories are created. */
  dbPath: string;
  /** SQLite busy timeout in milliseconds (also applied as PRAGMA busy_timeout). */
  busyTimeoutMs?: number;
}

/**
 * Owns the single Runner SQLite connection. Every write path in the Runner must
 * go through an explicit transaction; this class never exposes raw BEGIN/COMMIT.
 */
export class SqliteDatabase {
  readonly dbPath: string;
  private readonly busyTimeoutMs: number;
  private db: DatabaseSync | null = null;
  private transactionDepth = 0;
  /** Pending after-commit hooks with the transaction depth they were registered at. */
  private readonly commitHooks = new Set<{ fn: () => void; depth: number }>();

  constructor(options: SqliteDatabaseOptions) {
    this.dbPath = options.dbPath;
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  }

  open(): void {
    if (this.db !== null) return;
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      const db = new DatabaseSync(this.dbPath, {
        enableForeignKeyConstraints: true,
        timeout: this.busyTimeoutMs
      });
      // WAL must be set before any transaction. `synchronous = NORMAL` is the
      // recommended WAL durability/performance trade-off and keeps the -wal file.
      db.exec(`PRAGMA journal_mode = WAL`);
      db.exec(`PRAGMA synchronous = NORMAL`);
      db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
      db.exec(`PRAGMA foreign_keys = ON`);
      migrateSchema(db);
      this.db = db;
    } catch (error) {
      throw new RunnerError({
        code: "LEDGER_IO",
        message: `Failed to open the Runner database at ${this.dbPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        details: { dbPath: this.dbPath },
        cause: error
      });
    }
  }

  close(): void {
    if (this.db === null) return;
    this.db.close();
    this.db = null;
    this.transactionDepth = 0;
    this.commitHooks.clear();
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  /** Current schema version read from `schema_migrations`. */
  get schemaVersion(): number {
    const db = this.assertOpen();
    const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as {
      version: number;
    };
    return row.version;
  }

  /** WAL mode marker for diagnostics and tests (e.g. `wal` on file databases). */
  get journalMode(): string {
    const db = this.assertOpen();
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    return row.journal_mode;
  }

  prepare(sql: string): StatementSync {
    return this.assertOpen().prepare(sql);
  }

  exec(sql: string): void {
    this.assertOpen().exec(sql);
  }

  /**
   * Runs `work` in a transaction. The outermost call opens `BEGIN IMMEDIATE`;
   * nested calls use savepoints so inner failures roll back only their own work.
   *
   * Commit hooks registered via {@link onCommit} fire ONLY after the outermost
   * COMMIT succeeded — never after a rollback, and never while an outer
   * transaction is still open — so subscribers observe events exactly when
   * they are durable. Hooks registered inside a rolled-back transaction (or a
   * rolled-back savepoint) are DISCARDED, so they can never fire on a later
   * unrelated commit.
   */
  transaction<T>(work: () => T): T {
    const db = this.assertOpen();
    const depth = this.transactionDepth;
    if (depth === 0) {
      db.exec("BEGIN IMMEDIATE");
    } else {
      db.exec(`SAVEPOINT swpanel_tx_${depth}`);
    }
    this.transactionDepth += 1;
    let result: T;
    try {
      result = work();
      if (depth === 0) {
        db.exec("COMMIT");
      } else {
        db.exec(`RELEASE SAVEPOINT swpanel_tx_${depth}`);
      }
      this.transactionDepth -= 1;
    } catch (error) {
      if (depth === 0) {
        db.exec("ROLLBACK");
        // Every hook of the rolled-back transaction is stale: its writes were
        // undone, so it must never fire on a later commit (H1). Hooks are
        // registered while the frame is OPEN, i.e. at depth >= 1.
        this.discardHooksAtDepth(1);
      } else {
        db.exec(`ROLLBACK TO SAVEPOINT swpanel_tx_${depth}`);
        db.exec(`RELEASE SAVEPOINT swpanel_tx_${depth}`);
        // Hooks registered inside this savepoint (depth >= depth + 1) belong
        // to work that was undone; hooks of released ancestor frames stay.
        this.discardHooksAtDepth(depth + 1);
      }
      this.transactionDepth -= 1;
      throw error;
    }
    if (depth === 0) {
      // Fires only after the outermost COMMIT; hooks registered inside nested
      // savepoints that released successfully fire here too, and hooks of a
      // rolled-back transaction never fire. Hook exceptions are isolated so a
      // notification listener can never break the committed transaction flow.
      this.fireCommitHooks();
    }
    return result;
  }

  /**
   * Registers a hook that runs after the outermost transaction of the current
   * (or a later) write batch commits. Returns an unsubscribe function. Hooks
   * registered inside a transaction whose savepoint is later rolled back never
   * fire.
   */
  onCommit(hook: () => void): () => void {
    const entry = { fn: hook, depth: this.transactionDepth };
    this.commitHooks.add(entry);
    return () => {
      this.commitHooks.delete(entry);
    };
  }

  /** Removes every pending hook registered at `depth` or deeper (rolled back). */
  private discardHooksAtDepth(depth: number): void {
    for (const entry of this.commitHooks) {
      if (entry.depth >= depth) {
        this.commitHooks.delete(entry);
      }
    }
  }

  private fireCommitHooks(): void {
    if (this.commitHooks.size === 0) return;
    const hooks = [...this.commitHooks];
    this.commitHooks.clear();
    for (const entry of hooks) {
      try {
        entry.fn();
      } catch {
        // Isolated: a listener failure must never break the caller's flow.
      }
    }
  }

  /**
   * `RUNNER_NOT_OPEN` structured error when the database is closed. Kept as a
   * plain assert (not part of the public result surface) because every caller
   * is already inside the Runner's own process boundary.
   */
  private assertOpen(): DatabaseSync {
    if (this.db === null) {
      throw new RunnerError({
        code: "RUNNER_NOT_OPEN",
        message: "The Runner database is not open",
        details: { dbPath: this.dbPath }
      });
    }
    return this.db;
  }

  /** Version marker proving this slice compiles against the schema registry. */
  static readonly SCHEMA_VERSION = SCHEMA_VERSION;
}
