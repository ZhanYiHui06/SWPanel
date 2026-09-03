import type {
  CostDataSnapshot,
  CostEstimateInputSnapshot,
  CostEstimateReport
} from "@swpanel/domain";
import {
  calculateCostEstimate,
  canCreateCostEstimateReport,
  costReportLabel
} from "@swpanel/domain";
import type { CostReportDetailView, CostReportListItemView } from "@swpanel/contracts";

import { SqliteRepository } from "../db/repository.js";
import { RunRepository } from "../db/run-repository.js";
import {
  InvalidArgumentError,
  NotFoundError,
  RunnerInvariantError
} from "../errors.js";

/**
 * Phase 7 Cost workflow application service.
 * Handles company-global cost data basis reads/updates and deterministic
 * cost estimate report generation and queries against SQLite.
 */
export class CostWorkflowService {
  constructor(
    private readonly repository: SqliteRepository,
    private readonly runs: RunRepository
  ) {}

  getEffectiveCostData(): CostDataSnapshot {
    return this.repository.getEffectiveCostData();
  }

  updateCostData(snapshot: CostDataSnapshot): CostDataSnapshot {
    return this.repository.transaction(() => {
      this.repository.saveCostDataSnapshot(snapshot);
      return this.repository.getEffectiveCostData();
    });
  }

  getCostReportDetail(reportId: string): CostReportDetailView {
    return this.repository.getCostReportDetail(reportId);
  }

  listCostReportsByRevision(drawingId: string, revisionId: string): readonly CostReportListItemView[] {
    return this.repository.listCostReportsByRevision(drawingId, revisionId);
  }

  createCostReport(input: CostEstimateInputSnapshot, createdAt: string): CostReportDetailView {
    return this.repository.transaction(() => {
      const drawing = this.repository.getDrawing(input.drawingId);
      if (!drawing) {
        throw new NotFoundError(`Drawing ${input.drawingId} was not found`);
      }
      const revision = this.repository.getRevision(input.revisionId);
      if (!revision || revision.drawingId !== drawing.id) {
        throw new NotFoundError(`Revision ${input.revisionId} was not found for Drawing ${drawing.id}`);
      }

      const model = this.runs.getModel(input.modelId);
      if (!model) {
        throw new NotFoundError(`Model ${input.modelId} was not found`);
      }

      if (!canCreateCostEstimateReport(drawing, revision)) {
        throw new InvalidArgumentError(
          `Revision ${revision.id} is not eligible for Cost Estimate Report generation (requires current revision with approved model)`
        );
      }

      if (revision.currentApprovedModelId !== model.id) {
        throw new InvalidArgumentError(
          `Model ${model.id} is not the current approved model for Revision ${revision.id}`
        );
      }

      // Compute deterministic result using domain pure calculator
      const result = calculateCostEstimate(input);

      // Determine report sequence label (Q01, Q02, ...)
      const existingReports = this.repository.listCostReportsByRevision(drawing.id, revision.id);
      const nextSeq = existingReports.length + 1;
      const label = costReportLabel(nextSeq);
      const reportId = `report-${revision.id}-q${nextSeq.toString().padStart(2, "0")}`;

      const report: CostEstimateReport = {
        id: reportId,
        label,
        drawingId: drawing.id,
        revisionId: revision.id,
        modelId: model.id,
        quantity: input.quantity,
        snapshot: {
          input,
          result,
          createdAt
        },
        createdAt,
        updatedAt: createdAt
      };

      this.repository.saveCostEstimateReport(report);
      return this.repository.getCostReportDetail(report.id);
    });
  }

  /**
   * Deletes ONE Cost Estimate Report of the owning Revision (Phase 8). The
   * report must exist and belong to `revisionId`; a mismatched pair is an
   * invariant error (never a silent cross-revision delete), an unknown report
   * is a structured NOT_FOUND. The single `cost_reports` row is removed inside
   * one transaction.
   */
  deleteCostReport(costReportId: string, revisionId: string): { costReportId: string } {
    if (typeof revisionId !== "string" || revisionId.length === 0) {
      throw new InvalidArgumentError("revisionId must be a non-empty string");
    }
    return this.repository.transaction(() => {
      // Throws a structured NOT_FOUND when the report does not exist.
      const report = this.repository.getCostReportDetail(costReportId);
      if (report.revisionId !== revisionId) {
        throw new RunnerInvariantError(
          `Cost Estimate Report ${costReportId} belongs to Revision ${report.revisionId}, not ${revisionId}`,
          { costReportId, revisionId, reportRevisionId: report.revisionId }
        );
      }
      if (!this.repository.deleteCostReport(costReportId, revisionId)) {
        throw new NotFoundError(`Cost Estimate Report ${costReportId} was not found`, {
          costReportId
        });
      }
      return { costReportId };
    });
  }
}
