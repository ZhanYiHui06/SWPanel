import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CheckIcon,
  EmptyState,
  FileIcon,
  InlineNotice,
  PropertyList,
  StatusBadge
} from "@swpanel/ui";
import { Link, Navigate, useParams } from "react-router-dom";

import { useCallback, useMemo, useState } from "react";

import type { ModelDetailView } from "@swpanel/contracts";

import { useRepository } from "../features/repository-provider.js";
import { useDrawingRepository } from "../features/bridge-repository/drawing-repository-provider.js";
import { useModelInvalidate, useModelDetailQuery, useModelRepository } from "../features/model-repository/model-repository-provider.js";
import { isModelNotFoundError } from "../features/model-repository/model-repository.js";
import { MockModelRepository } from "../features/model-repository/mock-model-repository.js";
import { useRunIdentity } from "../features/run-repository/run-display.js";
import {
  resolveDrawingId,
  resolveModelId,
  resolveRevisionId,
  revisionLabelOrId
} from "../features/ids.js";
import { formatBytes, formatRelativeTime } from "../features/format.js";
import { modelStatusBadge, modelStatusLabel } from "../features/status.js";
import { ModelPreview } from "../features/models/ModelPreview.js";
import {
  ModelReviewPanel,
  type ModelReviewSubmitInput
} from "../features/models/ModelReviewPanel.js";
import { QueryErrorState, QueryLoadingState } from "../features/drawing/DrawingQueryStates.js";

export interface ModelDetailPageProps {
  readonly now?: Date;
}

/** User-visible artifact name for each artifact kind. */
const ARTIFACT_NAMES: Readonly<Record<string, string>> = {
  SLDPRT: "SolidWorks 模型",
  PREVIEW: "模型预览图",
  DIMENSION_LEDGER: "Dimension Ledger",
  FEATURE_PLAN: "Feature Plan",
  BUILD_VALIDATION_LOG: "Validation Log",
  BUILDER_SOURCE: "Builder Source",
  SOURCE_DRAWING: "Source Drawing",
  PROCESS_MP4: "建模过程视频"
};

interface ValidationRow {
  readonly label: string;
  readonly result: string;
  readonly pass: boolean;
}

/**
 * Model Detail (`/drawings/:drawingId/revisions/:revisionId/models/:modelId`).
 * Model preview, info, validation facts, technical artifacts and the review
 * actions (approve / reject-with-reason) for PENDING_REVIEW models, matching
 * `.design/pages/model-detail.html` and `.design/pages/drawing-models.html`.
 *
 * Mock runtime: deterministic Phase 1 fixture UI (sync). Product runtime (real
 * bridge / no bridge): real async data over the ModelRepository (`model.getDetail`
 * query), with the review actions flowing through `model.review`.
 */
export function ModelDetailPage({ now = new Date() }: ModelDetailPageProps): React.JSX.Element {
  const drawingRepository = useDrawingRepository();
  if (drawingRepository.mode !== "mock") {
    return <ProductModelDetailPage now={now} />;
  }
  return <MockModelDetailPage now={now} />;
}

// ---------------------------------------------------------------------------
// Mock runtime (deterministic Phase 1 fixtures, sync reads)
// ---------------------------------------------------------------------------

function MockModelDetailPage({ now }: { readonly now: Date }): React.JSX.Element {
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
  const modelId = useMemo(
    () => resolveModelId(repository, drawingId, revisionId, parameters.modelId),
    [repository, drawingId, revisionId, parameters.modelId]
  );
  const modelRepository = useMemo(() => new MockModelRepository(repository), [repository]);
  const [, setReviewVersion] = useState(0);
  const reviewModel = useCallback(
    (input: ModelReviewSubmitInput): Promise<unknown> => modelRepository.reviewModel(input),
    [modelRepository]
  );
  const onReviewed = useCallback(() => setReviewVersion((value) => value + 1), []);

  if (drawingId === null || revisionId === null || modelId === null) {
    return <Navigate to="/drawings" replace />;
  }

  const detail = repository.getModelDetail(modelId);
  const drawingDetail = repository.getDrawingDetail(drawingId);
  const run = repository.getRun(detail.model.runId);

  return (
    <ModelDetailContent
      detail={detail}
      now={now}
      drawingNumber={drawingDetail.drawing.drawingNumber}
      drawingName={drawingDetail.drawing.name}
      revisionLabel={revisionLabelOrId(repository, revisionId)}
      runLabel={run?.number ?? detail.model.runId}
      reviewModel={reviewModel}
      onReviewed={onReviewed}
    />
  );
}

// ---------------------------------------------------------------------------
// Product runtime (bridge / unavailable): real async data, never fixtures
// ---------------------------------------------------------------------------

function ProductModelDetailPage({ now }: { readonly now: Date }): React.JSX.Element {
  const parameters = useParams();
  const modelIdParam = parameters.modelId;
  const modelRepository = useModelRepository();
  const invalidateModels = useModelInvalidate();

  const reviewModel = useCallback(
    async (input: ModelReviewSubmitInput) => {
      await modelRepository.reviewModel(input);
      invalidateModels();
    },
    [modelRepository, invalidateModels]
  );
  const [, setReviewVersion] = useState(0);
  const onReviewed = useCallback(() => setReviewVersion((value) => value + 1), []);

  const shell = (children: React.ReactNode): React.JSX.Element => (
    <div className="page-content wide" data-route-id="model-detail">
      <div className="section section-tight">
        <h1 className="page-header-title">Model Detail</h1>
      </div>
      {children}
    </div>
  );

  if (modelIdParam === undefined || modelIdParam === "") {
    return <Navigate to="/drawings" replace />;
  }

  const modelQuery = useModelDetailQuery(modelIdParam);

  if (modelQuery.status === "loading" || (modelQuery.status === "success" && modelQuery.data === undefined)) {
    return shell(<QueryLoadingState label="正在加载模型详情…" />);
  }

  if (modelQuery.status === "error") {
    if (isModelNotFoundError(modelQuery.error)) {
      return shell(
        <div className="data-sheet">
          <InlineNotice tone="error" title="模型不存在或已被删除">
            无法打开模型 {modelIdParam} 的详情页面。
          </InlineNotice>
          <div className="mt-4">
            <Link to="/drawings" className="btn btn-secondary btn-sm">
              返回图纸库
            </Link>
          </div>
        </div>
      );
    }
    return shell(
      <QueryErrorState
        title="模型详情加载失败"
        error={modelQuery.error}
        onRetry={() => modelQuery.retry()}
        action={
          <Link to="/drawings" className="btn btn-ghost btn-sm">
            返回图纸库
          </Link>
        }
      />
    );
  }

  // At this point the query resolved successfully: the data must be present
  // (the loading guard above also covers `success` with undefined data).
  if (modelQuery.data === undefined) {
    return shell(<QueryLoadingState label="正在加载模型详情…" />);
  }

  const detail = modelQuery.data;
  return (
    <ProductModelDetailContent
      detail={detail}
      now={now}
      reviewModel={reviewModel}
      onReviewed={onReviewed}
    />
  );
}

/** Product-mode content after the model detail is loaded (identity via Drawing queries). */
function ProductModelDetailContent({
  detail,
  now,
  reviewModel,
  onReviewed
}: {
  readonly detail: ModelDetailView;
  readonly now: Date;
  readonly reviewModel: (input: ModelReviewSubmitInput) => Promise<unknown>;
  readonly onReviewed: () => void;
}): React.JSX.Element {
  const model = detail.model;
  const identity = useRunIdentity(model.drawingId, model.revisionId);
  return (
    <ModelDetailContent
      detail={detail}
      now={now}
      drawingNumber={identity.drawingNumber}
      drawingName={identity.drawingName}
      revisionLabel={identity.revisionLabel}
      runLabel={model.runId}
      reviewModel={reviewModel}
      onReviewed={onReviewed}
    />
  );
}

// ---------------------------------------------------------------------------
// Shared content (mock + product)
// ---------------------------------------------------------------------------

function ModelDetailContent({
  detail,
  now,
  drawingNumber,
  drawingName,
  revisionLabel,
  runLabel,
  reviewModel,
  onReviewed
}: {
  readonly detail: ModelDetailView;
  readonly now: Date;
  readonly drawingNumber: string;
  readonly drawingName: string;
  readonly revisionLabel: string;
  readonly runLabel: string;
  readonly reviewModel: (input: ModelReviewSubmitInput) => Promise<unknown>;
  readonly onReviewed: () => void;
}): React.JSX.Element {
  const model = detail.model;

  const validationRows: ValidationRow[] = (() => {
    const summary = model.validationSummary;
    if (summary === null) return [];
    const rows: ValidationRow[] = [
      { label: "Rebuild", result: summary.rebuildStatus === "PASSED" ? "通过" : "失败", pass: summary.rebuildStatus === "PASSED" },
      { label: "Body Count", result: `${summary.bodyCount} body`, pass: summary.bodyCount > 0 },
      { label: "Feature Count", result: `${summary.featureCount} features`, pass: summary.featureCount > 0 }
    ];
    return rows;
  })();

  return (
    <div className="page-content wide" data-route-id="model-detail">
      <div className="workspace-header">
        <div className="workspace-header-top">
          <div>
            <div className="flex-row-gap-3">
              <h1 className="workspace-drawing-number" style={{ fontSize: "18px" }}>
                {model.modelLabel}
              </h1>
              <StatusBadge variant={modelStatusBadge(model.reviewStatus)}>
                {modelStatusLabel(model.reviewStatus)}
              </StatusBadge>
              {model.reviewStatus === "APPROVED" && (
                <StatusBadge variant={model.isCurrentApproved ? "current" : "no-model"}>
                  {model.isCurrentApproved ? "当前正式模型" : "历史正式模型"}
                </StatusBadge>
              )}
              {model.productionVerified === false && (
                <StatusBadge variant="no-model">合成预览 · 未生产验证</StatusBadge>
              )}
            </div>
            <div className="workspace-drawing-name" style={{ marginTop: "6px" }}>
              {drawingNumber} · {revisionLabel} · {drawingName}
            </div>
          </div>
          <div className="workspace-header-actions">
            <Button variant="secondary" size="sm">
              <FileIcon aria-hidden="true" />
              在 SolidWorks 中打开
            </Button>
          </div>
        </div>
      </div>

      <div className="grid-2">
        <Card>
          <CardHeader>
            <CardTitle>模型预览</CardTitle>
          </CardHeader>
          <CardBody>
            <div className="model-preview">
              <ModelPreview modelLabel={model.modelLabel} size={200} showLabel />
              <div className="model-preview-placeholder-label">
                MODEL {model.modelLabel} · SLDPRT
              </div>
            </div>
          </CardBody>
        </Card>

        <div>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>模型信息</CardTitle>
            </CardHeader>
            <CardBody>
              <PropertyList
                items={[
                  { key: "图号", value: drawingNumber, mono: true },
                  { key: "版本", value: revisionLabel, mono: true },
                  { key: "来源 Run", value: runLabel, mono: true },
                  { key: "生成时间", value: formatRelativeTime(model.generatedAt, now) },
                  { key: "文件格式", value: "SLDPRT", mono: true }
                ]}
              />
            </CardBody>
          </Card>

          {model.reviewStatus === "PENDING_REVIEW" && (
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>模型审核</CardTitle>
              </CardHeader>
              <CardBody>
                <ModelReviewPanel
                  model={model}
                  reviewModel={reviewModel}
                  onReviewed={onReviewed}
                />
              </CardBody>
            </Card>
          )}

          {model.reviewStatus !== "PENDING_REVIEW" && (
            <Card>
              <CardHeader>
                <CardTitle>Validation</CardTitle>
              </CardHeader>
              <CardBody>
                {validationRows.length === 0 ? (
                  <p className="text-sm text-muted">暂无验证信息</p>
                ) : (
                  <div className="validation-list">
                    {validationRows.map((row) => (
                      <div className="validation-item" key={row.label}>
                        <span className={`validation-item-icon ${row.pass ? "pass" : "fail"}`}>
                          <CheckIcon aria-hidden="true" />
                        </span>
                        <span className="validation-item-label">{row.label}</span>
                        <span className={`validation-item-result ${row.pass ? "pass" : "fail"}`}>
                          {row.result}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>
          )}
        </div>
      </div>

      {model.buildReportSummary !== null && model.buildReportSummary !== undefined && (
        <InlineNotice tone="info" className="mt-6" title="构建摘要">
          {model.buildReportSummary}
        </InlineNotice>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>技术文件</CardTitle>
        </CardHeader>
        <CardBody>
          {detail.artifacts.length === 0 ? (
            <EmptyState title="暂无技术文件" description="该模型尚未发布技术产物。" />
          ) : (
            <div className="file-list">
              {detail.artifacts.map((artifact) => (
                <div className="file-item" key={artifact.artifactId}>
                  <div className="file-item-icon">
                    <FileIcon aria-hidden="true" />
                  </div>
                  <div className="file-item-main">
                    <div className="file-item-name">{ARTIFACT_NAMES[artifact.kind] ?? artifact.kind}</div>
                    <div className="file-item-meta">
                      {artifact.fileName} · {formatBytes(artifact.sizeBytes)}
                    </div>
                  </div>
                  <span className="text-xs text-muted text-mono">{formatBytes(artifact.sizeBytes)}</span>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {model.reviewStatus === "APPROVED" && (
        <InlineNotice tone="success" className="mt-6" title="审核通过">
          该模型已通过人工审核，为当前正式模型。可用于生成成本测算报告。
        </InlineNotice>
      )}

      {detail.reviews.length > 0 && (
        <div className="mt-6">
          {detail.reviews.map((review) => (
            <InlineNotice
              key={review.reviewId}
              tone={review.result === "APPROVED" ? "success" : "error"}
              className="mt-2"
              title={`${review.result === "APPROVED" ? "审核通过" : "已退回"} · ${review.reviewerId}`}
            >
              {review.comment !== null
                ? `退回原因：${review.comment} · ${formatRelativeTime(review.createdAt, now)}`
                : `审核时间 ${formatRelativeTime(review.createdAt, now)}`}
            </InlineNotice>
          ))}
        </div>
      )}
    </div>
  );
}

export default ModelDetailPage;