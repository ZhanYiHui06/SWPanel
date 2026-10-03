import type { DrawingListItemView } from "@swpanel/contracts";
import { describe, expect, it } from "vitest";

import { drawingStatusFromListItem } from "./drawing-status.js";

function item(overrides: Partial<DrawingListItemView> = {}): DrawingListItemView {
  return {
    drawingId: "d1",
    drawingNumber: "D-1",
    name: "测试图纸",
    currentRevisionId: "r1",
    currentRevisionLabel: "V1",
    currentApprovedModelId: null,
    runStatus: null,
    updatedAt: "2026-08-10T00:00:00.000Z",
    totalRevisionCount: 1,
    latestRevisionLabel: "V1",
    hasOpenClarification: false,
    ...overrides
  };
}

describe("drawingStatusFromListItem", () => {
  it("shows 尚未建模 without a current Revision or any Run", () => {
    expect(drawingStatusFromListItem(item()).key).toBe("no-model");
    expect(drawingStatusFromListItem(item({ currentRevisionId: null, hasPendingReview: true })).key).toBe("no-model");
  });

  it("maps real Runner state with priority clarification > pending-review > running > queued > approved", () => {
    expect(drawingStatusFromListItem(item({ hasOpenClarification: true, hasPendingReview: true })).key).toBe("clarification");
    expect(drawingStatusFromListItem(item({ runStatus: "CLARIFICATION_REQUIRED" })).key).toBe("clarification");
    expect(drawingStatusFromListItem(item({ hasPendingReview: true, runStatus: "RUNNING" })).key).toBe("pending-review");
    expect(drawingStatusFromListItem(item({ runStatus: "RUNNING", currentApprovedModelId: "m1" })).key).toBe("running");
    expect(drawingStatusFromListItem(item({ runStatus: "QUEUED" })).key).toBe("queued");
    expect(drawingStatusFromListItem(item({ runStatus: "COMPLETED", currentApprovedModelId: "m1" })).key).toBe("approved");
  });
});
