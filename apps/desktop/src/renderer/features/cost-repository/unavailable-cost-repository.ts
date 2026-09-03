import type { CostDataSnapshot } from "@swpanel/domain";
import type { CostReportDetailView } from "@swpanel/contracts";
import type { CostReportDeleteBridgeResult } from "../../../main/bridge/bridge-contract.js";
import { CostRepositoryError, type CostRepository } from "./cost-repository.js";

const UNAVAILABLE_ERROR = new CostRepositoryError(
  "BRIDGE_UNAVAILABLE",
  "The desktop bridge is not available. Running in a browser or without Electron?"
);

export class UnavailableCostRepository implements CostRepository {
  readonly mode = "unavailable" as const;
  readonly mock = null;

  getEffectiveCostData(): Promise<CostDataSnapshot> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  updateCostData(): Promise<CostDataSnapshot> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  getCostReportDetail(): Promise<CostReportDetailView> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  createCostReport(): Promise<CostReportDetailView> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  deleteCostReport(): Promise<CostReportDeleteBridgeResult> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }
}
