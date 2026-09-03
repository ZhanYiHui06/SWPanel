/**
 * Phase 6 Model Repository feature exports.
 *
 * Consumers import the ModelRepository surface, the structured error helpers
 * and the provider/query hooks from this single module.
 */

export { BridgeModelRepository } from "./bridge-model-repository.js";
export { MockModelRepository } from "./mock-model-repository.js";
export { UnavailableModelRepository, UNAVAILABLE_MODEL_ERROR } from "./unavailable-model-repository.js";
export {
  ModelRepositoryError,
  toModelRepositoryError,
  isModelNotFoundError,
  type ModelRepository,
  type ReviewModelInput
} from "./model-repository.js";
export {
  ModelRepositoryProvider,
  resolveModelRepository,
  useModelDetailQuery,
  useModelInvalidate,
  useModelQuery,
  useModelRepository,
  type ModelQueryState,
  type ModelRepositoryProviderProps
} from "./model-repository-provider.js";