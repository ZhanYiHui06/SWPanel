import type { CostDataSnapshot, CostEstimateInputSnapshot } from "@swpanel/domain";
import type { CostReportDetailView } from "@swpanel/contracts";
import type { CostReportDeleteBridgeResult } from "../../../main/bridge/bridge-contract.js";
import { HttpTransport, type HttpRepositoryOptions } from "../http-transport.js";
import { CostRepositoryError, type CostRepository, type DeleteCostReportInput } from "./cost-repository.js";

export class HttpCostRepository implements CostRepository {
  readonly mode = "bridge" as const;
  readonly mock = null;
  private readonly transport: HttpTransport;

  constructor(options: HttpRepositoryOptions = {}) {
    this.transport = new HttpTransport(options, CostRepositoryError);
  }

  getEffectiveCostData(): Promise<CostDataSnapshot> { return this.transport.query("costData.get"); }
  updateCostData(snapshot: CostDataSnapshot): Promise<CostDataSnapshot> { return this.transport.command("costData.update", { snapshot: { ...snapshot, updatedAt: snapshot.capturedAt } }, `cost-data-update:${snapshot.capturedAt}`); }
  getCostReportDetail(costReportId: string): Promise<CostReportDetailView> { return this.transport.query("costReport.getDetail", { costReportId }); }
  createCostReport(input: CostEstimateInputSnapshot, createdAt: string): Promise<CostReportDetailView> { return this.transport.command("costReport.create", { input, createdAt }); }
  deleteCostReport(input: DeleteCostReportInput): Promise<CostReportDeleteBridgeResult> { return this.transport.command("costReport.delete", { ...input }); }
}
