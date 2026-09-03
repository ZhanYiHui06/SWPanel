import type { CostDataSnapshot, CostEstimateInputSnapshot } from "@swpanel/domain";
import type { CostReportDetailView } from "@swpanel/contracts";
import type {
  BridgeResult,
  CostReportDeleteBridgeResult,
  SwpanelBridgeApi
} from "../../../main/bridge/bridge-contract.js";
import {
  CostRepositoryError,
  type CostRepository,
  type DeleteCostReportInput
} from "./cost-repository.js";

function unwrap<T>(result: BridgeResult<T>): T {
  if (result.ok) return result.data;
  throw new CostRepositoryError(result.error.code, result.error.message);
}

export class BridgeCostRepository implements CostRepository {
  readonly mode = "bridge" as const;
  readonly mock = null;

  constructor(private readonly bridge: SwpanelBridgeApi) {}

  async getEffectiveCostData(): Promise<CostDataSnapshot> {
    return unwrap(await this.bridge.cost.getEffectiveCostData());
  }

  async updateCostData(snapshot: CostDataSnapshot): Promise<CostDataSnapshot> {
    return unwrap(await this.bridge.cost.updateCostData(snapshot));
  }

  async getCostReportDetail(costReportId: string): Promise<CostReportDetailView> {
    return unwrap(await this.bridge.cost.getReportDetail(costReportId));
  }

  async createCostReport(input: CostEstimateInputSnapshot, createdAt: string): Promise<CostReportDetailView> {
    return unwrap(await this.bridge.cost.createReport({ input, createdAt }));
  }

  async deleteCostReport(input: DeleteCostReportInput): Promise<CostReportDeleteBridgeResult> {
    return unwrap(
      await this.bridge.cost.deleteReport({
        costReportId: input.costReportId,
        revisionId: input.revisionId
      })
    );
  }
}
