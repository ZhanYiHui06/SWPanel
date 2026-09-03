import type {
  CostDataSnapshot,
  CostEstimateInputSnapshot
} from "@swpanel/domain";
import type { CostReportDetailView } from "@swpanel/contracts";
import type { CostReportDeleteBridgeResult } from "../../../main/bridge/bridge-contract.js";
import type { MockRepository } from "../mock-repository/mock-repository.js";

/** Structured repository error carrying the stable bridge/runner error code. */
export class CostRepositoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CostRepositoryError";
    this.code = code;
  }
}

/** Converts any thrown value into a structured cost repository error. */
export function toCostRepositoryError(error: unknown): CostRepositoryError {
  if (error instanceof CostRepositoryError) return error;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return new CostRepositoryError(
      (error as { code: string }).code,
      error.message
    );
  }
  if (error instanceof Error) {
    return new CostRepositoryError("INTERNAL_ERROR", error.message);
  }
  return new CostRepositoryError("INTERNAL_ERROR", String(error));
}

export interface CostRepository {
  readonly mode: "bridge" | "mock" | "unavailable";
  readonly mock: MockRepository | null;

  getEffectiveCostData(): Promise<CostDataSnapshot>;
  updateCostData(snapshot: CostDataSnapshot): Promise<CostDataSnapshot>;
  getCostReportDetail(costReportId: string): Promise<CostReportDetailView>;
  createCostReport(input: CostEstimateInputSnapshot, createdAt: string): Promise<CostReportDetailView>;
  /**
   * Deletes ONE Cost Estimate Report of its owning Revision (Step 4). The
   * delegate (Runner or mock) guards the owning revision scope.
   */
  deleteCostReport(input: DeleteCostReportInput): Promise<CostReportDeleteBridgeResult>;
}

export interface DeleteCostReportInput {
  readonly costReportId: string;
  readonly revisionId: string;
}
