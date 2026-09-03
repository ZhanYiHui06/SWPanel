import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import { InvalidArgumentError, NotFoundError, RunnerInvariantError } from "../errors.js";
import { makeTempDir, removeTempDir } from "../test-utils.js";
import { SqliteDatabase } from "./database.js";
import { SqliteRepository } from "./repository.js";
import { RunRepository } from "./run-repository.js";

const T0 = "2026-08-13T09:00:00.000Z";
const T1 = "2026-08-13T09:01:00.000Z";
const T2 = "2026-08-13T09:02:00.000Z";

interface Fixture {
  dir: string;
  dbPath: string;
  db: SqliteDatabase;
  store: SqliteRepository;
  runs: RunRepository;
}

function openFixture(prefix: string): Fixture {
  const dir = makeTempDir(prefix);
  const dbPath = join(dir, "state", "swpanel.db");
  const db = new SqliteDatabase({ dbPath, busyTimeoutMs: 5_000 });
  db.open();
  const store = new SqliteRepository(db);
  return { dir, dbPath, db, store, runs: new RunRepository(db, store) };
}

function closeFixture(fixture: Fixture): void {
  fixture.db.close();
  removeTempDir(fixture.dir);
}

/** Seeds a Drawing + Revision through the low-level store primitives. */
function seedRevision(fixture: Fixture, revisionId: string): void {
  const sourceFile = {
    id: `file-${revisionId}`,
    fileName: `${revisionId}.pdf`,
    format: "PDF" as const,
    sizeBytes: 1024,
    sha256: "a".repeat(64),
    relativePath: `library/drawings/file-${revisionId}/source/original.pdf`,
    uploadedAt: T0
  };
  const drawingId = `drawing-${revisionId}`;
  fixture.db.transaction(() => {
    fixture.store.insertDrawing({
      id: drawingId,
      drawingNumber: `D-${drawingId}`,
      name: `Drawing ${drawingId}`,
      currentRevisionId: null,
      createdAt: T0,
      updatedAt: T0
    });
    fixture.store.insertRevisionFile(sourceFile);
    fixture.store.insertRevision({
      id: revisionId,
      drawingId,
      sequence: 1,
      sourceFile,
      currentApprovedModelId: null,
      createdAt: T0,
      updatedAt: T0
    });
    fixture.store.setCurrentRevisionPointer(drawingId, revisionId, T0);
  });
}

/** Seeds a Model row (mirroring the Phase 5 atomic publisher's row shape). */
function seedModel(
  fixture: Fixture,
  modelId: string,
  revisionId: string,
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED"
): void {
  fixture.db
    .prepare(
      "INSERT INTO models (id, number, drawing_id, revision_id, run_id, review_status, generated_at) " +
        "VALUES (?, 'M01', ?, ?, 'run-1', ?, ?)"
    )
    .run(modelId, `drawing-${revisionId}`, revisionId, reviewStatus, T0);
}

function review(fixture: Fixture, input: {
  modelId: string;
  result: "APPROVED" | "REJECTED";
  comment?: string;
  reviewerId?: string;
  reviewedAt?: string;
}) {
  return fixture.runs.reviewModel({
    modelId: input.modelId,
    result: input.result,
    ...(input.comment === undefined ? {} : { comment: input.comment }),
    reviewerId: input.reviewerId ?? "alice",
    reviewedAt: input.reviewedAt ?? T1
  });
}

function revisionPointer(fixture: Fixture, revisionId: string): {
  current_approved_model_id: string | null;
  updated_at: string;
} {
  return fixture.db
    .prepare("SELECT current_approved_model_id, updated_at FROM drawing_revisions WHERE id = ?")
    .get(revisionId) as { current_approved_model_id: string | null; updated_at: string };
}

function reviewCount(fixture: Fixture, modelId: string): number {
  const row = fixture.db
    .prepare("SELECT COUNT(*) AS count FROM model_reviews WHERE model_id = ?")
    .get(modelId) as { count: number };
  return row.count;
}

describe("RunRepository.reviewModel", () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = openFixture("model-review");
  });
  afterEach(() => closeFixture(fixture));

  it("approves a PENDING_REVIEW Model and repoints the Revision's approved-Model pointer", () => {
    seedRevision(fixture, "revision-a1");
    seedModel(fixture, "model-1", "revision-a1", "PENDING_REVIEW");
    const createdAt = T0;

    const detail = review(fixture, { modelId: "model-1", result: "APPROVED", reviewedAt: T1 });
    expect(detail.model).toMatchObject({
      modelId: "model-1",
      modelLabel: "M01",
      reviewStatus: "APPROVED",
      isCurrentApproved: true,
      productionVerified: false
    });
    expect(detail.reviews).toHaveLength(1);
    expect(detail.reviews[0]).toMatchObject({
      result: "APPROVED",
      reviewerId: "alice",
      comment: null,
      createdAt: T1
    });
    expect(detail.reviews[0]?.reviewId).toBeTypeOf("string");

    // The pointer transition bumped the Revision and lives on the row.
    expect(revisionPointer(fixture, "revision-a1")).toEqual({
      current_approved_model_id: "model-1",
      updated_at: T1
    });
    // An approval writes Review + status + pointer, never a feedback entry.
    const feedback = fixture.db
      .prepare("SELECT COUNT(*) AS count FROM modeling_feedback WHERE revision_id = ?")
      .get("revision-a1") as { count: number };
    expect(feedback.count).toBe(0);
    expect(reviewCount(fixture, "model-1")).toBe(1);
    expect(fixture.store.getRevision("revision-a1")?.currentApprovedModelId).toBe("model-1");
    // The stored generated_at (publication time) is never touched by review.
    const modelRow = fixture.db.prepare("SELECT generated_at FROM models WHERE id = ?").get("model-1") as {
      generated_at: string;
    };
    expect(modelRow.generated_at).toBe(createdAt);
  });

  it("rejects a Model and writes the comment into the Revision's Modeling Feedback", () => {
    seedRevision(fixture, "revision-a1");
    seedModel(fixture, "model-1", "revision-a1", "PENDING_REVIEW");

    const detail = review(fixture, {
      modelId: "model-1",
      result: "REJECTED",
      comment: "右侧台阶直径错误",
      reviewedAt: T1
    });
    expect(detail.model).toMatchObject({ reviewStatus: "REJECTED", isCurrentApproved: false });
    expect(detail.reviews[0]).toMatchObject({ result: "REJECTED", comment: "右侧台阶直径错误", reviewerId: "alice" });

    // The pointer stays clear and the feedback row carries the review linkage.
    expect(revisionPointer(fixture, "revision-a1")).toEqual({
      current_approved_model_id: null,
      updated_at: T0
    });
    const feedback = fixture.store.listModelingFeedback("revision-a1");
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({
      revisionId: "revision-a1",
      modelId: "model-1",
      reviewId: detail.reviews[0]?.reviewId,
      content: "右侧台阶直径错误",
      source: "MODEL_REVIEW_REJECTED",
      createdAt: T1
    });
  });

  it("requires a non-empty comment on REJECTED and rejects an empty one atomically", () => {
    seedRevision(fixture, "revision-a1");
    seedModel(fixture, "model-1", "revision-a1", "PENDING_REVIEW");

    expect(() => review(fixture, { modelId: "model-1", result: "REJECTED" })).toThrowError(
      InvalidArgumentError
    );
    expect(() =>
      review(fixture, { modelId: "model-1", result: "REJECTED", comment: "" })
    ).toThrowError(InvalidArgumentError);
    expect(() =>
      review(fixture, { modelId: "model-1", result: "REJECTED", comment: "   " })
    ).toThrowError(InvalidArgumentError);

    // Nothing was written by any rejected attempt: no review, no status change,
    // no feedback.
    expect(reviewCount(fixture, "model-1")).toBe(0);
    const modelRow = fixture.db.prepare("SELECT review_status FROM models WHERE id = ?").get("model-1") as {
      review_status: string;
    };
    expect(modelRow.review_status).toBe("PENDING_REVIEW");
    expect(fixture.store.listModelingFeedback("revision-a1")).toHaveLength(0);
  });

  it("a Model is reviewed exactly once: a repeated review is refused", () => {
    seedRevision(fixture, "revision-a1");
    seedModel(fixture, "model-1", "revision-a1", "PENDING_REVIEW");
    review(fixture, { modelId: "model-1", result: "APPROVED", reviewedAt: T1 });

    expect(() =>
      review(fixture, { modelId: "model-1", result: "REJECTED", comment: "再来一次", reviewedAt: T2 })
    ).toThrowError(RunnerInvariantError);
    expect(() =>
      review(fixture, { modelId: "model-1", result: "APPROVED", reviewedAt: T2 })
    ).toThrowError(RunnerInvariantError);

    // Exactly one review row survived and the pointer is the approval's.
    expect(reviewCount(fixture, "model-1")).toBe(1);
    expect(revisionPointer(fixture, "revision-a1").current_approved_model_id).toBe("model-1");
  });

  it("throws NOT_FOUND for an unknown Model and rolls back nothing", () => {
    seedRevision(fixture, "revision-a1");
    expect(() =>
      review(fixture, { modelId: "model-ghost", result: "APPROVED", reviewedAt: T1 })
    ).toThrowError(NotFoundError);
    expect(reviewCount(fixture, "model-ghost")).toBe(0);
    expect(revisionPointer(fixture, "revision-a1").current_approved_model_id).toBeNull();
  });

  it("refuses to review anything but a PENDING_REVIEW Model (transition invariant)", () => {
    seedRevision(fixture, "revision-a1");
    seedRevision(fixture, "revision-a2");
    seedModel(fixture, "model-approved", "revision-a1", "APPROVED");
    seedModel(fixture, "model-rejected", "revision-a2", "REJECTED");

    expect(() =>
      review(fixture, { modelId: "model-approved", result: "APPROVED", reviewedAt: T1 })
    ).toThrowError(/APPROVED; only a PENDING_REVIEW model can be reviewed/);
    expect(() =>
      review(fixture, { modelId: "model-rejected", result: "REJECTED", comment: "退回", reviewedAt: T1 })
    ).toThrowError(/REJECTED; only a PENDING_REVIEW model can be reviewed/);

    expect(reviewCount(fixture, "model-approved")).toBe(0);
    expect(reviewCount(fixture, "model-rejected")).toBe(0);
    expect(revisionPointer(fixture, "revision-a1").current_approved_model_id).toBeNull();
    expect(revisionPointer(fixture, "revision-a2").current_approved_model_id).toBeNull();
  });

  it("rejects an out-of-contract result value before any write", () => {
    seedRevision(fixture, "revision-a1");
    seedModel(fixture, "model-1", "revision-a1", "PENDING_REVIEW");
    expect(() =>
      fixture.runs.reviewModel({
        modelId: "model-1",
        result: "ACCEPTED" as never,
        reviewerId: "alice",
        reviewedAt: T1
      })
    ).toThrowError(InvalidArgumentError);
    expect(reviewCount(fixture, "model-1")).toBe(0);
    expect(revisionPointer(fixture, "revision-a1").current_approved_model_id).toBeNull();
  });

  it("canonicalizes a non-canonical reviewedAt to UTC ISO on the review record", () => {
    seedRevision(fixture, "revision-a1");
    seedModel(fixture, "model-1", "revision-a1", "PENDING_REVIEW");
    // 17:01+08:00 == 09:01Z: the review record and pointer use the canonical form.
    const detail = review(fixture, {
      modelId: "model-1",
      result: "APPROVED",
      reviewedAt: "2026-08-13T17:01:00.000+08:00"
    });
    expect(detail.reviews[0]?.createdAt).toBe("2026-08-13T09:01:00.000Z");
    expect(revisionPointer(fixture, "revision-a1").updated_at).toBe("2026-08-13T09:01:00.000Z");
  });
});