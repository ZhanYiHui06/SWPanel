import { describe, expect, it } from "vitest";

import type { Drawing } from "./drawings/drawing.js";
import type { DrawingRevision } from "./revisions/revision.js";
import {
  canCreateCostEstimateReport,
  canReviewModel,
  canSetCurrentRevision,
  hasCurrentApprovedModel
} from "./invariants.js";

const drawing: Drawing = {
  id: "drawing-1",
  drawingNumber: "PDJF480.01.17C-4",
  name: "轧辊（二）",
  currentRevisionId: "rev-3",
  createdAt: "2026-08-06T10:00:00.000Z",
  updatedAt: "2026-08-10T12:00:00.000Z"
};

function revision(id: string, currentApprovedModelId: string | null): DrawingRevision {
  return {
    id,
    drawingId: drawing.id,
    sequence: 3,
    sourceFile: {
      id: "file-1",
      fileName: "PDJF480.01.17C-4.pdf",
      format: "PDF",
      sizeBytes: 1_234_567,
      sha256: "a".repeat(64),
      relativePath: "revisions/rev-3/source/original.pdf",
      uploadedAt: "2026-08-10T11:00:00.000Z"
    },
    currentApprovedModelId,
    createdAt: "2026-08-10T11:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z"
  };
}

describe("cross-entity invariants", () => {
  it("only the current revision with an approved model is cost-eligible", () => {
    expect(canCreateCostEstimateReport(drawing, revision("rev-3", "model-3"))).toBe(true);
    // Stale revision, even with an approved model, is never eligible.
    expect(canCreateCostEstimateReport(drawing, revision("rev-1", "model-1"))).toBe(false);
    // Current revision without an approved model is not eligible.
    expect(canCreateCostEstimateReport(drawing, revision("rev-3", null))).toBe(false);
  });

  it("tracks current approved model identity separately from review history", () => {
    expect(hasCurrentApprovedModel(revision("rev-3", "model-3"))).toBe(true);
    expect(hasCurrentApprovedModel(revision("rev-3", null))).toBe(false);
  });

  it("only PENDING_REVIEW models can be reviewed", () => {
    expect(canReviewModel("PENDING_REVIEW")).toBe(true);
    expect(canReviewModel("APPROVED")).toBe(false);
    expect(canReviewModel("REJECTED")).toBe(false);
  });

  it("allows switching the current revision pointer only to an owned revision", () => {
    const owned = revision("rev-3", "model-3");
    expect(canSetCurrentRevision(drawing, owned)).toBe(true);
    // A revision of another drawing is never a valid current pointer target.
    const foreign = { ...revision("rev-x", null), drawingId: "drawing-2" };
    expect(canSetCurrentRevision(drawing, foreign)).toBe(false);
  });
});
