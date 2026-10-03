import { StatusBadge } from "@swpanel/ui";
import { Link } from "react-router-dom";

import type { ModelListItemView } from "@swpanel/contracts";

import { formatRelativeTime } from "../format.js";
import { modelStatusBadge, modelStatusLabel } from "../status.js";
import { shortId } from "./identifiers.js";
import { ModelPreview } from "./ModelPreview.js";

export interface ModelCardProps {
  readonly drawingId: string;
  readonly revisionId: string;
  readonly model: ModelListItemView;
  readonly now?: Date;
  /** Rejection reason of the latest REJECTED review (mock or bridge detail). */
  readonly rejectionComment?: string | null;
  readonly imageUrl?: string;
  readonly placeholder?: boolean;
  /** Business label of the source Run (R05); falls back to a short id. */
  readonly runLabel?: string;
}

function isCurrentBadge(model: ModelListItemView): "当前正式模型" | "历史正式模型" | null {
  if (model.reviewStatus !== "APPROVED") return null;
  return model.isCurrentApproved ? "当前正式模型" : "历史正式模型";
}

/**
 * Model card (`.model-card`) for the Drawing Workspace · 模型 grid. Shows the
 * model label, review badge, current-formal-model marker, source Run and the
 * rejection reason for REJECTED models. Runtime-agnostic: callers resolve the
 * rejection reason from the mock repository or the bridge model detail.
 */
export function ModelCard({
  drawingId,
  revisionId,
  model,
  now,
  rejectionComment,
  imageUrl,
  placeholder,
  runLabel
}: ModelCardProps): React.JSX.Element {
  const currentMarker = isCurrentBadge(model);

  return (
    <Link
      to={`/drawings/${drawingId}/revisions/${revisionId}/models/${model.modelId}`}
      className="model-card"
    >
      <div className="model-card-preview">
        <div className="model-card-badge">
          {currentMarker !== null && (
            <StatusBadge variant={model.isCurrentApproved ? "current" : "no-model"}>
              {currentMarker}
            </StatusBadge>
          )}
        </div>
        <ModelPreview modelLabel={model.modelLabel} size={100} {...(imageUrl === undefined ? {} : { imageUrl })} {...(placeholder === undefined ? {} : { placeholder })} />
      </div>
      <div className="model-card-body">
        <div className="model-card-title">
          <span className="model-card-id">{model.modelLabel}</span>
          <StatusBadge variant={modelStatusBadge(model.reviewStatus)} size="sm">
            {modelStatusLabel(model.reviewStatus)}
          </StatusBadge>
        </div>
        <div className="model-card-meta">
          <span>来源 {runLabel ?? shortId(model.runId)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatRelativeTime(model.generatedAt, now)}</span>
        </div>
        {model.reviewStatus === "REJECTED" && rejectionComment !== null && rejectionComment !== undefined && (
          <div className="model-card-reject-reason">退回原因：{rejectionComment}</div>
        )}
      </div>
    </Link>
  );
}
