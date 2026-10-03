import { Button, Card, CardBody, CardHeader, CardTitle, EmptyState } from "@swpanel/ui";
import { Link, Navigate, useParams } from "react-router-dom";

import { useMemo, useState } from "react";

import type { ModelListItemView } from "@swpanel/contracts";

import { useRepository } from "../features/repository-provider.js";
import { useDrawingRepository, useDrawingQuery, useDrawingInvalidate } from "../features/bridge-repository/drawing-repository-provider.js";
import { isNotFoundError } from "../features/bridge-repository/drawing-repository.js";
import { useModelDetailQuery, useModelRepository, useModelInvalidate } from "../features/model-repository/model-repository-provider.js";
import { useCostInvalidate } from "../features/cost-repository/index.js";
import { BusinessDeletionDialog } from "../features/deletion/BusinessDeletionDialog.js";
import { useOptionalNotifications } from "../features/notifications/notification-context.js";
import { resolveDrawingId, resolveRevisionId, revisionLabelOrId } from "../features/ids.js";
import { DrawingWorkspace } from "../features/drawing/DrawingWorkspace.js";
import { QueryErrorState, QueryLoadingState } from "../features/drawing/DrawingQueryStates.js";
import { ModelCard } from "../features/models/ModelCard.js";

export interface DrawingModelsPageProps {
  readonly now?: Date;
}

/**
 * Drawing Workspace · 模型 (`/drawings/:drawingId/revisions/:revisionId/models`).
 * Grid of the revision's generated Models with review status, current-formal
 * marker and rejection reasons, matching `.design/pages/drawing-models.html`.
 *
 * Mock runtime: deterministic Phase 1 fixture UI (sync). Product runtime (real
 * bridge / no bridge): real async data over the DrawingRepository revision
 * detail (which carries the revision's `models` array) plus per-model detail
 * for rejection reasons; the review links open the unlocked Model Detail page.
 */
export function DrawingModelsPage({ now = new Date() }: DrawingModelsPageProps): React.JSX.Element {
  const drawingRepository = useDrawingRepository();
  if (drawingRepository.mode !== "mock") {
    return <ProductDrawingModelsPage now={now} />;
  }
  return <MockDrawingModelsPage now={now} />;
}

// ---------------------------------------------------------------------------
// Mock runtime (deterministic Phase 1 fixtures, sync reads)
// ---------------------------------------------------------------------------

function MockDrawingModelsPage({ now }: { readonly now: Date }): React.JSX.Element {
  const repository = useRepository();
  const parameters = useParams();

  const drawingId = useMemo(
    () => resolveDrawingId(repository, parameters.drawingId),
    [repository, parameters.drawingId]
  );
  const revisionId = useMemo(
    () => resolveRevisionId(repository, drawingId, parameters.revisionId),
    [repository, drawingId, parameters.revisionId]
  );

  if (drawingId === null || revisionId === null) {
    return <Navigate to="/drawings" replace />;
  }

  const detail = repository.getRevisionDetail(drawingId, revisionId);
  const drawingDetail = repository.getDrawingDetail(drawingId);
  const runLabelFor = (runId: string): string | undefined => repository.getRun(runId)?.number;

  const models = [...detail.models].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  const rejectionCommentFor = (modelId: string): string | null =>
    repository
      .listReviews()
      .find((review) => review.modelId === modelId && review.result === "REJECTED")?.comment ?? null;

  return (
    <div className="page-content wide" data-route-id="drawing-models">
      <DrawingWorkspace
        drawingId={drawingId}
        drawingNumber={drawingDetail.drawing.drawingNumber}
        drawingName={drawingDetail.drawing.name}
        revisions={drawingDetail.revisions}
        activeRevisionId={revisionId}
        revisionLabelById={(id) => revisionLabelOrId(repository, id)}
        activeTab="models"
      >
        <Card>
          <CardHeader>
            <CardTitle>模型</CardTitle>
            <span className="text-xs text-muted text-mono">
              {drawingDetail.drawing.drawingNumber} · {detail.revision.revisionLabel} · {detail.models.length} 个模型
            </span>
          </CardHeader>
          <CardBody>
            {models.length === 0 ? (
              <EmptyState
                title="暂无模型"
                description="该版本还没有生成模型。可以先发起自动建模，完成后再在下方审核。"
              />
            ) : (
              <div className="grid-2">
                {models.map((model) => (
                  <ModelCard
                    key={model.modelId}
                    drawingId={drawingId}
                    revisionId={revisionId}
                    model={model}
                    now={now}
                    rejectionComment={rejectionCommentFor(model.modelId)}
                    {...optionalRunLabel(runLabelFor(model.runId))}
                  />
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </DrawingWorkspace>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Product runtime (bridge / unavailable): real async data, never fixtures
// ---------------------------------------------------------------------------

function ProductDrawingModelsPage({ now }: { readonly now: Date }): React.JSX.Element {
  const repository = useDrawingRepository();
  const parameters = useParams();

  const drawingId = repository.resolveDrawingParam(parameters.drawingId);
  const revisionId = repository.resolveRevisionParam(drawingId, parameters.revisionId);

  const detailQuery = useDrawingQuery(
    drawingId === null ? "drawing:detail:" : `drawing:detail:${drawingId}`,
    () => repository.getDrawingDetail(drawingId as string),
    { enabled: drawingId !== null }
  );
  const revisionQuery = useDrawingQuery(
    drawingId === null || revisionId === null ? "revision:detail:" : `revision:detail:${drawingId}:${revisionId}`,
    () => repository.getRevisionDetail(drawingId as string, revisionId as string),
    { enabled: drawingId !== null && revisionId !== null }
  );

  const shell = (children: React.ReactNode): React.JSX.Element => (
    <div className="page-content wide" data-route-id="drawing-models">
      <div className="section section-tight">
        <h1 className="page-header-title">图纸 · 模型</h1>
      </div>
      {children}
    </div>
  );

  if (drawingId === null || revisionId === null) {
    return <Navigate to="/drawings" replace />;
  }

  if (detailQuery.status === "loading" || (revisionQuery.status === "loading" && revisionQuery.data === undefined)) {
    return shell(<QueryLoadingState label="正在加载模型列表…" />);
  }

  if (detailQuery.status === "error") {
    if (isNotFoundError(detailQuery.error)) {
      return shell(
        <div className="data-sheet">
          <p className="text-sm text-muted mb-4">无法打开该图纸的模型页面。</p>
          <Link to="/drawings" className="btn btn-secondary btn-sm">
            返回图纸库
          </Link>
        </div>
      );
    }
    return shell(
      <QueryErrorState
        title="图纸详情加载失败"
        error={detailQuery.error}
        onRetry={() => detailQuery.retry()}
        action={
          <Link to="/drawings" className="btn btn-ghost btn-sm">
            返回图纸库
          </Link>
        }
      />
    );
  }

  if (revisionQuery.status === "error" || revisionQuery.data === undefined) {
    return shell(
      <QueryErrorState
        title="版本模型加载失败"
        error={revisionQuery.error}
        onRetry={() => revisionQuery.retry()}
        action={
          <Link to="/drawings" className="btn btn-ghost btn-sm">
            返回图纸库
          </Link>
        }
      />
    );
  }

  if (detailQuery.data === undefined) {
    return shell(<QueryLoadingState label="正在加载模型列表…" />);
  }

  const drawingDetail = detailQuery.data;
  const revisionDetail = revisionQuery.data;
  const revisionLabelById = (id: string): string =>
    drawingDetail.revisions.find((revision) => revision.revisionId === id)?.revisionLabel ?? id;

  const models = [...revisionDetail.models].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));

  return (
    <div className="page-content wide" data-route-id="drawing-models">
      <DrawingWorkspace
        drawingId={drawingId}
        drawingNumber={drawingDetail.drawing.drawingNumber}
        drawingName={drawingDetail.drawing.name}
        revisions={drawingDetail.revisions}
        activeRevisionId={revisionId}
        revisionLabelById={revisionLabelById}
        activeTab="models"
      >
        <Card>
          <CardHeader>
            <CardTitle>模型</CardTitle>
            <span className="text-xs text-muted text-mono">
              {drawingDetail.drawing.drawingNumber} · {revisionDetail.revision.revisionLabel} · {revisionDetail.models.length} 个模型
            </span>
          </CardHeader>
          <CardBody>
            {models.length === 0 ? (
              <EmptyState
                title="暂无模型"
                description="该版本还没有生成模型。可以先发起自动建模，完成后再在下方审核。"
              />
            ) : (
              <div className="grid-2">
                {models.map((model) => (
                  <BridgeModelCard
                    key={model.modelId}
                    drawingId={drawingId}
                    revisionId={revisionId}
                    model={model}
                    now={now}
                    {...optionalRunLabel(
                      revisionDetail.runs.find((run) => run.runId === model.runId)?.runLabel
                    )}
                  />
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </DrawingWorkspace>
    </div>
  );
}

/** Product-mode card: resolves the rejection reason via the cached model detail. */
function BridgeModelCard({
  drawingId,
  revisionId,
  model,
  now,
  runLabel
}: {
  readonly drawingId: string;
  readonly revisionId: string;
  readonly model: ModelListItemView;
  readonly now: Date;
  readonly runLabel?: string;
}): React.JSX.Element {
  const detailQuery = useModelDetailQuery(model.modelId);
  const repository = useModelRepository();
  const invalidateDrawing = useDrawingInvalidate();
  const invalidateModel = useModelInvalidate();
  const invalidateCost = useCostInvalidate();
  const notifications = useOptionalNotifications();
  const [deleting, setDeleting] = useState(false);
  const preview = detailQuery.data?.artifacts.find(artifact => artifact.kind === "PREVIEW");
  const imageUrl = preview ? repository.artifactUrl?.(model.modelId, preview.artifactId) : undefined;
  const rejectionComment =
    detailQuery.data?.reviews.find((review) => review.result === "REJECTED")?.comment ?? null;
  return (
    <div><ModelCard
      drawingId={drawingId}
      revisionId={revisionId}
      model={model}
      now={now}
      rejectionComment={rejectionComment}
      placeholder={false}
      {...optionalRunLabel(runLabel)}
      {...(imageUrl === undefined ? {} : { imageUrl })}
    />
    {repository.deleteObject && <Button variant="ghost" size="sm" onClick={() => setDeleting(true)}>删除模型 {model.modelLabel}</Button>}
    {deleting && <BusinessDeletionDialog repository={repository} id={model.modelId} label={`模型 ${model.modelLabel}`} onCancel={() => setDeleting(false)} onDeleted={warnings => {
      setDeleting(false); invalidateDrawing(); invalidateModel(); invalidateCost();
      notifications?.addNotification({ title: "模型已删除", tone: warnings.length ? "warning" : "success", ...(warnings.length ? { message: warnings.join(" ") } : {}) });
    }} />}</div>
  );
}

/** Spreads `runLabel` only when known (exactOptionalPropertyTypes-safe). */
function optionalRunLabel(runLabel: string | undefined): { runLabel?: string } {
  return runLabel === undefined ? {} : { runLabel };
}

export default DrawingModelsPage;
