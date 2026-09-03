import type { CostDataSnapshot, CostEstimateInputSnapshot } from "@swpanel/domain";
import { DomainInvariantError } from "@swpanel/domain";
import type { CostReportDetailView } from "@swpanel/contracts";
import type { CostReportDeleteBridgeResult } from "../../../main/bridge/bridge-contract.js";
import { MockRepository } from "../mock-repository/mock-repository.js";
import {
  CostRepositoryError,
  toCostRepositoryError,
  type CostRepository,
  type DeleteCostReportInput
} from "./cost-repository.js";

export class MockCostRepository implements CostRepository {
  readonly mode = "mock" as const;

  constructor(readonly mock: MockRepository) {}

  getEffectiveCostData(): Promise<CostDataSnapshot> {
    return Promise.resolve(this.mock.getEffectiveCostData());
  }

  updateCostData(snapshot: CostDataSnapshot): Promise<CostDataSnapshot> {
    this.mock.updateCostData(snapshot, snapshot.capturedAt);
    return Promise.resolve(this.mock.getEffectiveCostData());
  }

  getCostReportDetail(costReportId: string): Promise<CostReportDetailView> {
    return Promise.resolve(this.mock.getCostReportDetail(costReportId));
  }

  createCostReport(input: CostEstimateInputSnapshot, createdAt: string): Promise<CostReportDetailView> {
    const reportId = this.mock.createCostReport({
      drawingId: input.drawingId,
      revisionId: input.revisionId,
      modelId: input.modelId,
      inputSnapshot: input,
      result: {
        rawStockVolume: 0,
        materialQuantity: 0,
        materialCost: 0,
        fixedCostLines: [],
        perPieceCost: 0,
        totalCost: 0,
        currency: "CNY"
      },
      createdAt
    });
    return Promise.resolve(this.mock.getCostReportDetail(reportId));
  }

  deleteCostReport(input: DeleteCostReportInput): Promise<CostReportDeleteBridgeResult> {
    try {
      return Promise.resolve(this.mock.deleteCostReport(input));
    } catch (error) {
      if (error instanceof DomainInvariantError) {
        return Promise.reject(new CostRepositoryError("INVALID_INPUT", error.message));
      }
      return Promise.reject(toCostRepositoryError(error));
    }
  }
}
