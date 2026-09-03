import { describe, expect, it } from "vitest";

import {
  DELETABLE_RUN_STATUSES,
  REVISION_DELETION_BLOCKERS,
  canDeleteCostReport,
  canDeleteRevision,
  canDeleteRun,
  type CanDeleteRevisionInput
} from "./index.js";

function freeRevision(): CanDeleteRevisionInput {
  return {
    isCurrentRevision: false,
    hasRuns: false,
    hasModels: false,
    hasCostReports: false
  };
}

describe("canDeleteRevision", () => {
  it("returns true for a stale, dependency-free revision", () => {
    const result = canDeleteRevision(freeRevision());
    expect(result).toEqual({ canDelete: true });
    expect(result.blockingDependencies).toBeUndefined();
  });

  it("blocks the current revision as a live pointer", () => {
    expect(canDeleteRevision({ ...freeRevision(), isCurrentRevision: true })).toEqual({
      canDelete: false,
      reason: "REVISION_HAS_DEPENDENCIES",
      blockingDependencies: ["CURRENT_REVISION"]
    });
  });

  it("blocks each dependent record kind in canonical order", () => {
    expect(canDeleteRevision({ ...freeRevision(), hasRuns: true })).toEqual({
      canDelete: false,
      reason: "REVISION_HAS_DEPENDENCIES",
      blockingDependencies: ["RUNS"]
    });
    expect(canDeleteRevision({ ...freeRevision(), hasModels: true })).toEqual({
      canDelete: false,
      reason: "REVISION_HAS_DEPENDENCIES",
      blockingDependencies: ["MODELS"]
    });
    expect(canDeleteRevision({ ...freeRevision(), hasCostReports: true })).toEqual({
      canDelete: false,
      reason: "REVISION_HAS_DEPENDENCIES",
      blockingDependencies: ["COST_REPORTS"]
    });
  });

  it("accumulates every blocking dependency in canonical order", () => {
    const result = canDeleteRevision({
      isCurrentRevision: true,
      hasRuns: true,
      hasModels: true,
      hasCostReports: true
    });
    expect(result.canDelete).toBe(false);
    expect(result.reason).toBe("REVISION_HAS_DEPENDENCIES");
    expect(result.blockingDependencies).toEqual([
      "CURRENT_REVISION",
      "RUNS",
      "MODELS",
      "COST_REPORTS"
    ]);
  });

  it("exposes the canonical blocker list as the blocking dependency vocabulary", () => {
    expect(REVISION_DELETION_BLOCKERS).toEqual([
      "CURRENT_REVISION",
      "RUNS",
      "MODELS",
      "COST_REPORTS"
    ]);
  });

  it("force bypasses every guard without listing blockers", () => {
    expect(
      canDeleteRevision({
        isCurrentRevision: true,
        hasRuns: true,
        hasModels: true,
        hasCostReports: true,
        force: true
      })
    ).toEqual({ canDelete: true });
  });
});

describe("canDeleteRun", () => {
  it("permits deletion only from the terminal COMPLETED / FAILED / CANCELLED statuses", () => {
    expect(DELETABLE_RUN_STATUSES).toEqual(["COMPLETED", "FAILED", "CANCELLED"]);
    expect(canDeleteRun("COMPLETED")).toEqual({ canDelete: true });
    expect(canDeleteRun("FAILED")).toEqual({ canDelete: true });
    expect(canDeleteRun("CANCELLED")).toEqual({ canDelete: true });
  });

  it("blocks active QUEUED and RUNNING runs", () => {
    expect(canDeleteRun("QUEUED")).toEqual({ canDelete: false, reason: "RUN_NOT_TERMINAL" });
    expect(canDeleteRun("RUNNING")).toEqual({ canDelete: false, reason: "RUN_NOT_TERMINAL" });
  });

  it("blocks the terminal CLARIFICATION_REQUIRED run (clarification is still owed)", () => {
    expect(canDeleteRun("CLARIFICATION_REQUIRED")).toEqual({
      canDelete: false,
      reason: "RUN_HAS_PENDING_CLARIFICATION"
    });
  });
});

describe("canDeleteCostReport", () => {
  it("allows deleting any persisted report", () => {
    expect(canDeleteCostReport()).toEqual({ canDelete: true });
    expect(canDeleteCostReport("FINALIZED")).toEqual({ canDelete: true });
    expect(canDeleteCostReport(undefined)).toEqual({ canDelete: true });
  });
});
