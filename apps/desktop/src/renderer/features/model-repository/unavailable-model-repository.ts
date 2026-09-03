/**
 * Error-state ModelRepository for a product renderer WITHOUT the Electron bridge
 * (`window.swpanel` missing outside development). Every operation fails with a
 * truthful structured error so the Model pages render an explicit error state
 * with retry — the product runtime never silently shows Phase 1 fixture data.
 */

import type { ModelDetailView } from "@swpanel/contracts";
import { ModelRepositoryError, type ModelRepository } from "./model-repository.js";

const UNAVAILABLE_ERROR = new ModelRepositoryError(
  "RUNNER_UNAVAILABLE",
  "SWPanel 桌面桥接不可用：请通过 Electron 桌面应用启动，并确认图纸处理服务（Runner）已就绪。"
);

export class UnavailableModelRepository implements ModelRepository {
  readonly mode = "unavailable" as const;
  readonly mock = null;

  getModelDetail(): Promise<ModelDetailView> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }

  reviewModel(): Promise<ModelDetailView> {
    return Promise.reject(UNAVAILABLE_ERROR);
  }
}

/** Exported for tests: the exact error every unavailable-model call rejects with. */
export const UNAVAILABLE_MODEL_ERROR = UNAVAILABLE_ERROR;