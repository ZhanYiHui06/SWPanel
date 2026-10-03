import type { ModelDetailView } from "@swpanel/contracts";
import { HttpTransport, type HttpRepositoryOptions } from "../http-transport.js";
import { ModelRepositoryError, type ModelRepository, type ReviewModelInput } from "./model-repository.js";

export class HttpModelRepository implements ModelRepository {
  readonly mode = "bridge" as const;
  readonly mock = null;
  private readonly transport: HttpTransport;

  constructor(options: HttpRepositoryOptions = {}) {
    this.transport = new HttpTransport(options, ModelRepositoryError);
  }

  artifactUrl(modelId: string, artifactId: string, download = false): string {
    return `${this.transport.baseUrl}/api/models/${encodeURIComponent(modelId)}/artifacts/${encodeURIComponent(artifactId)}${download ? "?download=1" : ""}`;
  }

  getModelDetail(modelId: string): Promise<ModelDetailView> { return this.transport.query("model.getDetail", { modelId }); }
  getDeletionImpact(modelId: string): Promise<import("@swpanel/contracts").DeletionImpact> { return this.transport.query("model.getDeletionImpact", { modelId }); }
  deleteObject(modelId: string, confirmationToken: string): Promise<{ deletedId: string; cleanupWarnings: string[] }> { return this.transport.command("model.delete", { modelId, confirmationToken }); }
  reviewModel(input: ReviewModelInput): Promise<ModelDetailView> { return this.transport.command("model.review", { ...input }); }
}
