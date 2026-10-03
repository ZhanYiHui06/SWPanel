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
import { useRevisionDetailQuery } from "../features/bridge-repository/drawing-repository-provider.js";
import {
  resolveDrawingId,
  resolveModelId,
  resolveRevisionId,
  revisionLabelOrId
} from "../features/ids.js";
import { formatBytes, formatRelativeTime } from "../features/format.js";
import { modelStatusBadge, modelStatusLabel } from "../features/status.js";
import { ModelPreview } from "../features/models/ModelPreview.js";
import { shortId } from "../features/models/identifiers.js";
import { reviewerDisplayName } from "../features/models/reviewer.js";
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
      runLabel={run?.number ?? shortId(detail.model.runId)}
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
  const modelKey = modelIdParam === undefined || modelIdParam === "" ? null : modelIdParam;
  const modelRepository = useModelRepository();
  const invalidateModels = useModelInvalidate();
  // Hooks must run on every render: the query is declared before any early
  // return and simply stays disabled while the route parameter is missing.
  const modelQuery = useModelDetailQuery(modelKey);

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
        <h1 className="page-header-title">模型详情</h1>
      </div>
      {children}
    </div>
  );

  if (modelKey === null) {
    return <Navigate to="/drawings" replace />;
  }

  if (modelQuery.status === "loading" || (modelQuery.status === "success" && modelQuery.data === undefined)) {
    return shell(<QueryLoadingState label="正在加载模型详情…" />);
  }

  if (modelQuery.status === "error") {
    if (isModelNotFoundError(modelQuery.error)) {
      return shell(
        <div className="data-sheet">
          <InlineNotice tone="error" title="模型不存在或已被删除">
            无法打开该模型的详情页面，它可能已被删除，请返回图纸库重新选择。
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
  const ownershipMismatch =
    (parameters.drawingId !== undefined && parameters.drawingId !== detail.model.drawingId) ||
    (parameters.revisionId !== undefined && parameters.revisionId !== detail.model.revisionId);
  if (ownershipMismatch) {
    return shell(
      <div className="data-sheet">
        <InlineNotice tone="warning" title="该模型不属于此图纸版本">
          链接中的图纸或版本与模型实际所属不一致，请从图纸的模型列表重新打开。
        </InlineNotice>
        <div className="mt-4">
          <Link
            to={`/drawings/${detail.model.drawingId}/revisions/${detail.model.revisionId}/models/${detail.model.modelId}`}
            className="btn btn-secondary btn-sm"
          >
            打开模型所在版本
          </Link>
        </div>
      </div>
    );
  }
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
  // Resolve the business Run label (R05) through the cached revision detail;
  // a raw Runner id is long and opaque, so fall back to a short identifier.
  const revisionQuery = useRevisionDetailQuery(model.drawingId, model.revisionId);
  const runLabel =
    revisionQuery.data?.runs.find((candidate) => candidate.runId === model.runId)?.runLabel ?? shortId(model.runId);
  return (
    <ModelDetailContent
      detail={detail}
      now={now}
      drawingNumber={identity.drawingNumber}
      drawingName={identity.drawingName}
      revisionLabel={identity.revisionLabel}
      runLabel={runLabel}
      reviewModel={reviewModel}
      onReviewed={onReviewed}
      product
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
  onReviewed,
  product = false
}: {
  readonly product?: boolean;
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
  const repository = useModelRepository();
  const previewArtifact = detail.artifacts.find((artifact) => artifact.kind === "PREVIEW");
  const modelArtifact = detail.artifacts.find((artifact) => artifact.kind === "SLDPRT");
  const previewUrl = product && previewArtifact ? repository.artifactUrl?.(model.modelId, previewArtifact.artifactId) : undefined;
  const downloadUrl = product && modelArtifact ? repository.artifactUrl?.(model.modelId, modelArtifact.artifactId, true) : undefined;

  const modelsListPath = `/drawings/${model.drawingId}/revisions/${model.revisionId}/models`;
  const canEstimateCost = model.reviewStatus === "APPROVED" && model.isCurrentApproved && (!product || Boolean(detail.geometry));

  const validationRows: ValidationRow[] = (() => {
    const summary = model.validationSummary;
    if (summary === null) return [];
    const rows: ValidationRow[] = [
      { label: "重建", result: summary.rebuildStatus === "PASSED" ? "通过" : "失败", pass: summary.rebuildStatus === "PASSED" },
      { label: "实体数", result: `${summary.bodyCount} 个实体`, pass: summary.bodyCount > 0 },
      { label: "特征数", result: `${summary.featureCount} 个特征`, pass: summary.featureCount > 0 }
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
            <Link className="btn btn-ghost btn-sm" to={modelsListPath}>
              返回模型列表
            </Link>
            {product ? (
              downloadUrl ? <a className="btn btn-secondary btn-sm" href={downloadUrl} download={modelArtifact?.fileName}>
                <FileIcon aria-hidden="true" />下载 SolidWorks 模型
              </a> : <span className="text-sm text-muted">模型文件暂不可下载</span>
            ) : <Button variant="secondary" size="sm"><FileIcon aria-hidden="true" />在 SolidWorks 中打开</Button>}
          </div>
        </div>
      </div>

      {product && <InlineNotice tone="info" className="mb-4">浏览器中请先下载 SLDPRT 文件，再使用本机 SolidWorks 打开检查。</InlineNotice>}
      <div className="grid-2">
        <Card>
          <CardHeader>
            <CardTitle>模型预览</CardTitle>
          </CardHeader>
          <CardBody>
            <div className="model-preview">
              <ModelPreview modelLabel={model.modelLabel} size={200} showLabel placeholder={!product}
                {...(previewUrl ? { imageUrl: previewUrl } : {})} />
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

          {/* Validation is the evidence a reviewer needs, so it is shown for
              every review status and sits above the review actions. */}
          <Card className={model.reviewStatus === "PENDING_REVIEW" ? "mb-6" : ""}>
            <CardHeader>
              <CardTitle>验证结果</CardTitle>
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

          {model.reviewStatus === "PENDING_REVIEW" && (
            <Card>
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
                  {product && repository.artifactUrl ? <a className="btn btn-ghost btn-sm"
                    href={repository.artifactUrl(model.modelId, artifact.artifactId, true)} download={artifact.fileName}
                    aria-label={`下载 ${artifact.fileName}`}>下载</a> : <span className="text-xs text-muted text-mono">{formatBytes(artifact.sizeBytes)}</span>}
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {model.reviewStatus === "APPROVED" && (
        <InlineNotice tone="success" className="mt-6" title="审核通过">
          该模型已通过人工审核。{model.isCurrentApproved ? "为当前正式模型。" : "为历史正式模型。"}
          {product && !detail.geometry ? "尚无可信模型体积，暂不能生成成本测算报告。" : model.isCurrentApproved ? "可用于生成成本测算报告。" : ""}
          {canEstimateCost && (
            <div className="mt-2">
              <Link
                className="btn btn-secondary btn-sm"
                to={`/drawings/${model.drawingId}/revisions/${model.revisionId}/costs/new`}
              >
                生成成本测算报告
              </Link>
            </div>
          )}
        </InlineNotice>
      )}

      {detail.reviews.length > 0 && (
        <div className="mt-6">
          {detail.reviews.map((review) => (
            <InlineNotice
              key={review.reviewId}
              tone={review.result === "APPROVED" ? "success" : "error"}
              className="mt-2"
              title={`${review.result === "APPROVED" ? "审核通过" : "已退回"} · ${reviewerDisplayName(review.reviewerId)}`}
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