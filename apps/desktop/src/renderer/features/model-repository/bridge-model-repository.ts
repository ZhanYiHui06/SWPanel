/**
 * Product-runtime ModelRepository backed by the real `window.swpanel` Electron
 * bridge (`models` surface). Every method maps 1:1 onto an allowlisted, typed
 * bridge method and unwraps the `BridgeResult<T>` envelope into data (or a
 * structured `ModelRepositoryError`). No Node imports, no globals besides the
 * frozen bridge object, no generic channel access.
 */

import type { ModelDetailView } from "@swpanel/contracts";
import type {
  BridgeResult,
  SwpanelBridgeApi
} from "../../../main/bridge/bridge-contract.js";
import {
  ModelRepositoryError,
  type ModelRepository,
  type ReviewModelInput
} from "./model-repository.js";

export class BridgeModelRepository implements ModelRepository {
  readonly mode = "bridge" as const;
  readonly mock = null;

  constructor(private readonly api: SwpanelBridgeApi) {}

  /** Unwraps the bridge envelope: data on ok, structured error on failure. */
  private async unwrap<T>(result: Promise<BridgeResult<T>>): Promise<T> {
    const resolved = await result;
    if (resolved.ok) return resolved.data;
    throw new ModelRepositoryError(resolved.error.code, resolved.error.message);
  }

  getModelDetail(modelId: string): Promise<ModelDetailView> {
    return this.unwrap(this.api.models.getDetail(modelId));
  }

  reviewModel(input: ReviewModelInput): Promise<ModelDetailView> {
    return this.unwrap(
      this.api.models.review({
        modelId: input.modelId,
        result: input.result,
        ...(input.comment === undefined ? {} : { comment: input.comment }),
        reviewerId: input.reviewerId,
        reviewedAt: input.reviewedAt
      })
    );
  }
}