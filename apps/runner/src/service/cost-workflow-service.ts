import type {
  CostDataSnapshot,
  CostEstimateInputSnapshot,
  CostEstimateReport
} from "@swpanel/domain";
import {
  calculateCostEstimate,
  canCreateCostEstimateReport,
  costReportLabel,
  MAX_COST_QUANTITY,
  parseStockSpec
} from "@swpanel/domain";
import type { CostReportDetailView, CostReportListItemView } from "@swpanel/contracts";

import { SqliteRepository } from "../db/repository.js";
import { RunRepository } from "../db/run-repository.js";
import { generateId } from "../ids.js";
import type { ModelGeometry } from "../artifacts/model-geometry.js";
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
    private readonly runs: RunRepository,
    private readonly geometryOf: (modelId: string) => ModelGeometry | null = () => null
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

      const geometry = this.geometryOf(model.id);
      if (geometry === null) {
        throw new InvalidArgumentError("MODEL_GEOMETRY_UNAVAILABLE: 已审核模型缺少经过验证的真实成品体积，无法生成成本报告");
      }
      if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_COST_QUANTITY) {
        throw new InvalidArgumentError(`Quantity must be a positive integer not greater than ${MAX_COST_QUANTITY}`);
      }
      const costData = this.repository.getEffectiveCostData();
      if (costData.fixedCosts.some((cost) => cost.defaultEnabled &&
        (!Number.isFinite(cost.amount) || cost.amount < 0 || cost.currency !== "CNY" ||
        (cost.basis !== "PER_PIECE" && cost.basis !== "PER_BATCH")))) {
        throw new InvalidArgumentError("Enabled fixed costs require nonnegative CNY amounts and a supported billing basis");
      }
      if (costData.allowances.some((definition) => definition.allowances.some((allowance) =>
        !Number.isFinite(allowance.valueMm) || allowance.valueMm < 0))) {
        throw new InvalidArgumentError("Company machining allowances must be finite nonnegative millimeters");
      }
      const material = costData.materials.find((material) => material.id === input.materialId);
      if (material === undefined) {
        throw new InvalidArgumentError("Material is not present in the current company cost data");
      }
      if (!Number.isFinite(material.purchasePrice) || material.purchasePrice < 0 ||
        !["元/吨", "元/kg", "元/千克", "元/件"].includes(material.priceUnit) ||
        typeof material.density !== "number" || !Number.isFinite(material.density) || material.density <= 0 ||
        !["g/cm³", "g/cm3"].includes(material.densityUnit ?? "")) {
        throw new InvalidArgumentError("Material requires a valid purchase price, supported price unit and explicit density in g/cm³");
      }
      if (input.stockType !== "CYLINDER" && input.stockType !== "RECTANGULAR_BAR") {
        throw new InvalidArgumentError("Stock type is invalid");
      }
      // One shared parser (domain) validates and computes the blank volume, so
      // the frozen spec text and the computed rawStockVolume can never diverge.
      const parsedSpec = typeof input.stockSpec === "string"
        ? parseStockSpec(input.stockSpec, input.stockType, { requireUnit: true })
        : null;
      if (parsedSpec === null) throw new InvalidArgumentError("Stock specification requires explicit positive dimensions and mm, cm or m units");
      const stockVolume = parsedSpec.volumeM3;
      if (!Number.isFinite(stockVolume) || stockVolume < geometry.finishedVolumeM3) {
        throw new InvalidArgumentError("Stock dimensions must define a finite blank at least as large as the finished volume");
      }
      // Freeze server-owned geometry and company prices, never the client's copy.
      input = {
        ...input,
        finishedVolume: geometry.finishedVolumeM3,
        costData,
        allowances: costData.allowances.find((definition) => definition.stockType === input.stockType)?.allowances ?? [],
        formulaVersion: "v1",
        capturedAt: createdAt
      };
      const result = calculateCostEstimate(input);
      if (![result.rawStockVolume, result.materialQuantity, result.materialCost,
        result.perPieceCost, result.totalCost, ...result.fixedCostLines.flatMap((line) => [line.amount, line.subtotal])]
        .every((value) => Number.isFinite(value) && value >= 0)) {
        throw new InvalidArgumentError("Cost calculation overflowed or produced an invalid amount");
      }

      // Determine report sequence label (Q01, Q02, ...)
      const existingReports = this.repository.listCostReportsByRevision(drawing.id, revision.id);
      // Deleting an earlier report must not collide with a surviving report.
      const nextSeq = existingReports.reduce((max, report) => Math.max(max, Number(report.label.slice(1))), 0) + 1;
      const label = costReportLabel(nextSeq);
      const reportId = generateId();

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
