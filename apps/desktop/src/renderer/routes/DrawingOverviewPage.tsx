import { Button, Card, CardBody, CardHeader, CardTitle, CloseIcon, Dialog, DownloadIcon, InlineNotice, PlayIcon, PlusIcon, PropertyList, StatusBadge } from "@swpanel/ui";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";

import type { DrawingHistoryView } from "@swpanel/contracts";

import { createRunForRevision } from "../features/runs/create-run.js";
import {
  useDrawingInvalidate,
  useDrawingQuery,
  useDrawingRepository
} from "../features/bridge-repository/drawing-repository-provider.js";
import { useRunInvalidate, useRunRepository } from "../features/run-repository/run-repository-provider.js";
import { describeError } from "../features/error-messages.js";
import { RunStatusBadge } from "../features/runs/RunStatusBadge.js";
import {
  isNotFoundError,
  type AddRevisionResult,
  type DrawingRepository
} from "../features/bridge-repository/drawing-repository.js";
import { DrawingWorkspace } from "../features/drawing/DrawingWorkspace.js";
import { AddRevisionDialog, DeleteRevisionDialog } from "../features/drawing/DrawingDialogs.js";
import { QueryErrorState, QueryLoadingState } from "../features/drawing/DrawingQueryStates.js";
import { formatBytes, formatRelativeTime } from "../features/format.js";
import { useModelDetailQuery, useModelRepository } from "../features/model-repository/model-repository-provider.js";
import { ModelPreview } from "../features/models/ModelPreview.js";
import { modelStatusBadge, modelStatusLabel } from "../features/status.js";
import "../styles/phase1-pages.css";

const DISPLAY_NOW = new Date("2026-08-10T23:40:00.000Z");

export interface DrawingOverviewPageProps {
  readonly now?: Date;
  /** Explicit adapter for tests; the provider default resolves the runtime. */
  readonly drawingRepository?: DrawingRepository;
}

/** Defensive read of a history revision's source file (Runner-side rows may
 *  reference a missing ledger file; the page must not crash on that). */
function safeHistorySourceFile(
  revision: DrawingHistoryView["revisions"][number]
): { fileName: string; format: string; sizeBytes: number; uploadedAt: string } | null {
  const sourceFile = (
    revision as {
      sourceFile?: { fileName: string; format: string; sizeBytes: number; uploadedAt: string } | null;
    }
  ).sourceFile;
  return sourceFile === null || sourceFile === undefined ? null : sourceFile;
}

/**
 * Drawing Workspace · 概览 — real async detail/history over the DrawingRepository
 * (product: Runner via the WP5 bridge; dev/tests: explicit mock adapter).
 *
 * Phase 2 actions: 新增版本 (file picker + new Revision, never auto-current,
 * never a Run), explicit 设为当前版本, and the full version history with the
 * current indicator. The 开始自动建模 / Model / SolidWorks actions stay
 * available through the mock adapter for the canonical scenario tests, and are
 * truthfully disabled (with an explanation) in the bridge runtime where the
 * Run orchestration has not landed yet.
 */
export function DrawingOverviewPage({ now: nowProp, drawingRepository }: DrawingOverviewPageProps): React.JSX.Element {
  const repository = useDrawingRepository(drawingRepository);
  // Fixture date only in mock mode; real data is relative to the real clock.
  const now = nowProp ?? (repository.mode === "mock" ? DISPLAY_NOW : new Date());
  const dispatchingRef = useRef(false);
  const invalidate = useDrawingInvalidate();
  const runRepository = useRunRepository();
  const invalidateRuns = useRunInvalidate();
  const navigate = useNavigate();
  const { drawingId: drawingParam, revisionId: revisionParam } = useParams();
  const [confirming, setConfirming] = useState(false);
  const [creatingRun, setCreatingRun] = useState(false);
  const [dispatchedRun, setDispatchedRun] = useState<{ number: string; id: string } | null>(null);
  const [addRevisionOpen, setAddRevisionOpen] = useState(false);
  const [settingCurrent, setSettingCurrent] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    revisionId: string;
    revisionLabel: string;
    sourceFileName: string | null;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success"; title: string; text: string } | null>(null);

  const drawingId = repository.resolveDrawingParam(drawingParam);
  const revisionId = repository.resolveRevisionParam(drawingId, revisionParam);

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
  const historyQuery = useDrawingQuery(
    drawingId === null ? "drawing:history:" : `drawing:history:${drawingId}`,
    () => repository.getDrawingHistory(drawingId as string),
    { enabled: drawingId !== null }
  );
  // Per-target dependency counts: the delete dialog blocks when the target
  // Revision still owns Runs / Models / Cost Reports.
  const deleteTargetQuery = useDrawingQuery(
    deleteTarget === null || drawingId === null
      ? "revision:delete:none"
      : `revision:delete:${drawingId}:${deleteTarget.revisionId}`,
    () => repository.getRevisionDetail(drawingId as string, deleteTarget?.revisionId as string),
    { enabled: deleteTarget !== null && drawingId !== null }
  );

  const mock = repository.mock;
  const modelRepository = useModelRepository();
  const previewModel = [...(revisionQuery.data?.models ?? [])].sort((a, b) => {
    const priority = (status: string) => status === "PENDING_REVIEW" ? 3 : status === "APPROVED" ? 2 : 1;
    return priority(b.reviewStatus) - priority(a.reviewStatus) || b.generatedAt.localeCompare(a.generatedAt);
  })[0];
  const previewQuery = useModelDetailQuery(mock === null ? previewModel?.modelId ?? null : null);

  // When the Drawing exists but the URL revision is unknown/foreign, fall back
  // to the Drawing's current Revision (real ids are dynamic; deep links must
  // not dead-end). Never loops: the guard compares against the current pointer.
  useEffect(() => {
    if (drawingId === null || revisionId === null) return;
    if (detailQuery.status !== "success" || revisionQuery.status !== "error") return;
    if (!isNotFoundError(revisionQuery.error)) return;
    const currentRevisionId = detailQuery.data?.drawing.currentRevisionId ?? null;
    if (currentRevisionId !== null && currentRevisionId !== revisionId) {
      void navigate(`/drawings/${drawingId}/revisions/${currentRevisionId}/overview`, { replace: true });
    }
  }, [detailQuery.data, detailQuery.status, drawingId, navigate, revisionId, revisionQuery.error, revisionQuery.status]);

  if (drawingId === null || revisionId === null) {
    return <Navigate to="/drawings" replace />;
  }

  if (detailQuery.status === "loading" || (revisionQuery.status === "loading" && revisionQuery.data === undefined)) {
    return (
      <div className="page-content wide" data-route-id="drawing-overview">
        <div className="section section-tight"><h1 className="page-header-title">Drawing Workspace · 概览</h1></div>
        <QueryLoadingState label="正在加载图纸详情…" />
      </div>
    );
  }

  if (detailQuery.status === "error") {
    return (
      <div className="page-content wide" data-route-id="drawing-overview">
        <div className="section section-tight"><h1 className="page-header-title">Drawing Workspace · 概览</h1></div>
        {isNotFoundError(detailQuery.error) ? (
          <div className="data-sheet">
            <InlineNotice tone="error" title="图纸不存在或已被删除">
              无法打开图号为 {drawingParam ?? ""} 的图纸。
            </InlineNotice>
            <div className="mt-4"><Link to="/drawings" className="btn btn-secondary btn-sm">返回图纸库</Link></div>
          </div>
        ) : (
          <QueryErrorState title="图纸详情加载失败" error={detailQuery.error} onRetry={() => detailQuery.retry()} action={<Link to="/drawings" className="btn btn-ghost btn-sm">返回图纸库</Link>} />
        )}
      </div>
    );
  }

  if (revisionQuery.status === "error" || revisionQuery.data === undefined) {
    return (
      <div className="page-content wide" data-route-id="drawing-overview">
        <div className="section section-tight"><h1 className="page-header-title">Drawing Workspace · 概览</h1></div>
        <QueryErrorState
          title="版本不存在或无法加载"
          error={revisionQuery.error}
          onRetry={() => revisionQuery.retry()}
          action={<Link to="/drawings" className="btn btn-ghost btn-sm">返回图纸库</Link>}
        />
      </div>
    );
  }

  if (detailQuery.data === undefined) {
    return (
      <div className="page-content wide" data-route-id="drawing-overview">
        <div className="section section-tight"><h1 className="page-header-title">Drawing Workspace · 概览</h1></div>
        <QueryLoadingState label="正在加载图纸详情…" />
      </div>
    );
  }

  const activeDrawingId = drawingId;
  const activeRevisionId = revisionId;
  const drawingDetail = detailQuery.data;
  const revisionDetail = revisionQuery.data;
  const model = [...revisionDetail.models]
    .sort((a, b) => {
      const priority = (status: string) => status === "PENDING_REVIEW" ? 3 : status === "APPROVED" ? 2 : 1;
      return priority(b.reviewStatus) - priority(a.reviewStatus) || b.generatedAt.localeCompare(a.generatedAt);
    })[0];
  const source = revisionDetail.revision.sourceFile;
  const sourceUrl = repository.sourceFileUrl?.(drawingId, revisionId);
  const sourceDownloadUrl = repository.sourceFileUrl?.(drawingId, revisionId, true);
  const previewArtifact = previewQuery.data?.artifacts.find((artifact) => artifact.kind === "PREVIEW");
  const previewUrl = model && previewArtifact ? modelRepository.artifactUrl?.(model.modelId, previewArtifact.artifactId) : undefined;
  const modelRun = model === undefined ? undefined : revisionDetail.runs.find((run) => run.runId === model.runId);
  const modelRunLabel = modelRun === undefined ? "建模任务" : `Run ${modelRun.runLabel}`;
  const latestRun = model === undefined
    ? revisionDetail.runs[revisionDetail.runs.length - 1]
    : revisionDetail.runs.find((run) => run.runId === model.runId) ?? revisionDetail.runs[revisionDetail.runs.length - 1];

  const revisionLabelById = (id: string): string =>
    drawingDetail.revisions.find((revision) => revision.revisionId === id)?.revisionLabel ?? id;

  /**
   * Creates a Modeling Run for the active revision. The caller submits ONLY
   * the drawing/revision identity pair: the Runner (mock or real) freezes the
   * Input Snapshot. Mock runtime keeps the synchronous fixture path; product
   * runtime goes through the async RunRepository with loading/error/retry.
   */
  async function dispatchModeling(): Promise<void> {
    if (dispatchingRef.current) return; // duplicate submit guard (survives re-renders)
    if (mock !== null) {
      const revision = mock.getRevision(activeRevisionId);
      if (revision === undefined) return;
      const run = createRunForRevision(mock, revision);
      invalidate();
      invalidateRuns();
      setConfirming(false);
      setDispatchedRun({ number: run.number, id: run.id });
      return;
    }
    dispatchingRef.current = true;
    setCreatingRun(true);
    setActionError(null);
    setCreateError(null);
    setNotice(null);
    try {
      const run = await runRepository.createRun({
        drawingId: activeDrawingId,
        revisionId: activeRevisionId
      });
      invalidateRuns();
      setConfirming(false);
      setDispatchedRun({ number: run.number, id: run.id });
    } catch (caught) {
      // Keep the dialog open so the user can read the error and retry.
      setCreateError(describeError(caught).message);
    } finally {
      dispatchingRef.current = false;
      setCreatingRun(false);
    }
  }

  function handleRevisionAdded(result: AddRevisionResult): void {
    invalidate();
    setAddRevisionOpen(false);
    void navigate(`/drawings/${activeDrawingId}/revisions/${result.revision.id}/overview`);
  }

  async function handleSetCurrent(targetRevisionId: string): Promise<void> {
    setSettingCurrent(targetRevisionId);
    setActionError(null);
    setNotice(null);
    try {
      await repository.setCurrentRevision({ drawingId: activeDrawingId, revisionId: targetRevisionId });
      invalidate();
      setNotice({
        tone: "success",
        title: "已设为当前版本",
        text: `版本 ${revisionLabelById(targetRevisionId)} 现在是当前版本。`
      });
    } catch (caught) {
      setActionError(describeError(caught).message);
    } finally {
      setSettingCurrent(null);
    }
  }

  function handleRevisionDeleted(deletedRevisionId: string): void {
    const label = deleteTarget?.revisionLabel ?? deletedRevisionId;
    invalidate();
    setDeleteTarget(null);
    setNotice({
      tone: "success",
      title: "版本已删除",
      text: `版本 ${label} 及其源文件已删除。`
    });
    void navigate(`/drawings/${activeDrawingId}/revisions/${activeRevisionId}/overview`, {
      replace: true
    });
  }

  const historyRows = historyQuery.status === "success" && historyQuery.data !== undefined
    ? historyQuery.data.revisions.map((revision) => ({
        revisionId: revision.revisionId,
        revisionLabel: revision.revisionLabel,
        isCurrent: revision.isCurrent,
        createdAt: revision.createdAt,
        sourceFile: safeHistorySourceFile(revision)
      }))
    : [];

  return (
    <div className="page-content wide" data-route-id="drawing-overview">
      <DrawingWorkspace
        drawingId={activeDrawingId}
        drawingNumber={drawingDetail.drawing.drawingNumber}
        drawingName={drawingDetail.drawing.name}
        revisions={drawingDetail.revisions}
        activeRevisionId={activeRevisionId}
        activeTab="overview"
        revisionLabelById={revisionLabelById}
        headerActions={
          <>
            <Button variant="secondary" size="sm" onClick={() => setAddRevisionOpen(true)}><PlusIcon aria-hidden="true" />新增版本</Button>
            {!revisionDetail.revision.isCurrent && (
              <Button variant="secondary" size="sm" disabled={settingCurrent !== null} onClick={() => void handleSetCurrent(activeRevisionId)}>
                {settingCurrent === activeRevisionId ? "正在设置…" : "设为当前版本"}
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={() => { setCreateError(null); setConfirming(true); }} disabled={creatingRun}><PlayIcon aria-hidden="true" />开始自动建模</Button>
          </>
        }
      >
    {dispatchedRun !== null && (
      <InlineNotice tone="success" title="任务已加入等待队列" className="mb-4" role="status">
        Run {dispatchedRun.number} 已创建，等待执行。
        <div className="mt-4">
          <Link to={`/runs/${dispatchedRun.id}`} className="btn btn-secondary btn-sm">
            查看任务
          </Link>
        </div>
      </InlineNotice>
    )}
        {notice !== null && (
          <InlineNotice tone={notice.tone} title={notice.title} className="mb-4">
            {notice.text}
          </InlineNotice>
        )}
        {actionError !== null && (
          <InlineNotice tone="error" title="操作未完成" className="mb-4" role="alert">
            {actionError}
          </InlineNotice>
        )}

        <div className="overview-grid">
          <Card>
            <CardHeader><CardTitle>原始图纸</CardTitle></CardHeader>
            <CardBody>
              {mock !== null ? <div className="drawing-preview" role="img" aria-label="工程图纸预览"><div className="drawing-preview-inner" /></div> : sourceUrl && source.format.toUpperCase() === "PDF" ? (
                <object data={sourceUrl} type="application/pdf" aria-label="工程图纸预览" style={{ width: "100%", height: 260 }}>
                  <a href={sourceUrl} target="_blank" rel="noreferrer">查看原始 PDF 图纸</a>
                </object>
              ) : <p className="text-sm text-muted">{source.format.toUpperCase()} 图纸请下载后使用本机软件查看。</p>}
              <PropertyList className="mt-4" items={[{ key: "文件名", value: source.fileName, mono: true }, { key: "文件大小", value: formatBytes(source.sizeBytes) }, { key: "上传时间", value: formatRelativeTime(source.uploadedAt, now) }]} />
              {sourceDownloadUrl ? <div className="overview-download flex-row-gap-3">
                <a className="btn btn-secondary btn-sm" href={sourceDownloadUrl} download={source.fileName}><DownloadIcon aria-hidden="true" />下载原图</a>
                {source.format.toUpperCase() === "PDF" && <a className="btn btn-ghost btn-sm" href={sourceUrl} target="_blank" rel="noreferrer">查看原图</a>}
              </div> : <Button variant="secondary" size="sm" className="overview-download" disabled><DownloadIcon aria-hidden="true" />下载原图</Button>}
            </CardBody>
          </Card>

          <Card>
            <CardHeader><CardTitle>当前模型</CardTitle>{model === undefined ? <StatusBadge variant="no-model">尚未建模</StatusBadge> : <StatusBadge variant={modelStatusBadge(model.reviewStatus)}>{modelStatusLabel(model.reviewStatus)}</StatusBadge>}</CardHeader>
            <CardBody>
              {model === undefined ? <div className="overview-model-empty"><ModelPreview modelLabel="MODEL" size={110} showLabel /><p className="text-sm text-muted">当前版本还没有生成模型。</p></div> : <>
                <div className="model-preview aspect-16-10"><ModelPreview modelLabel={model.modelLabel} size={110} showLabel placeholder={mock !== null} {...(previewUrl ? { imageUrl: previewUrl } : {})} /><div className="model-preview-placeholder-label">{model.modelLabel}</div></div>
                {model.reviewStatus === "PENDING_REVIEW" && <InlineNotice tone="warning" title="等待人工审核" className="mt-4">模型 {model.modelLabel} 由 {modelRunLabel} 自动生成，请在 SolidWorks 中检查后确认。</InlineNotice>}
                <div className="overview-model-actions">{mock !== null && <Button variant="secondary" size="sm" disabled buttonProps={{ title: "SolidWorks 集成将在后续阶段提供" }}><PlayIcon aria-hidden="true" />在 SolidWorks 中打开</Button>}<Link to={`/drawings/${activeDrawingId}/revisions/${activeRevisionId}/models/${model.modelId}`} className="btn btn-ghost btn-sm">查看详情</Link></div>
              </>}
            </CardBody>
          </Card>
        </div>

        <Card className="mt-6">
          <CardHeader><CardTitle>版本状态</CardTitle></CardHeader>
          <CardBody padding="flush">
            <div className="overview-status-grid">
              <div><span className="property-key">最近 Run</span><strong className="text-mono">{latestRun?.runLabel ?? "—"}</strong><span className="text-xs text-muted">{latestRun === undefined ? "暂无记录" : formatRelativeTime(latestRun.createdAt, now)}</span></div>
              <div><span className="property-key">Run 状态</span>{latestRun === undefined ? <StatusBadge variant="no-model">暂无</StatusBadge> : <RunStatusBadge status={latestRun.status} />}</div>
              <div><span className="property-key">最新模型</span><strong className="text-mono">{model?.modelLabel ?? "—"}</strong><span className="text-xs text-muted">{model === undefined ? "尚未生成" : `由 ${modelRunLabel} 生成`}</span></div>
              <div><span className="property-key">审核状态</span>{model === undefined ? <StatusBadge variant="no-model">尚未建模</StatusBadge> : <StatusBadge variant={modelStatusBadge(model.reviewStatus)}>{modelStatusLabel(model.reviewStatus)}</StatusBadge>}</div>
              <div><span className="property-key">成本测算</span><StatusBadge variant={revisionDetail.revision.currentApprovedModelId === null ? "no-model" : "approved"}>{revisionDetail.revision.currentApprovedModelId === null ? "不可用" : "可用"}</StatusBadge><span className="text-xs text-muted">{revisionDetail.revision.currentApprovedModelId === null ? "需审核通过后可用" : "基于正式模型"}</span></div>
            </div>
          </CardBody>
        </Card>

        <Card className="mt-6">
          <CardHeader><CardTitle>版本历史</CardTitle><span className="text-xs text-muted">{drawingDetail.revisions.length} 个版本</span></CardHeader>
          <CardBody padding="compact">
            {historyQuery.status === "loading" && (
              <div className="text-sm text-muted" role="status">正在加载版本历史…</div>
            )}
            {historyQuery.status === "error" && (
              <InlineNotice tone="error" title="版本历史加载失败">
                {describeError(historyQuery.error).message}
                <div className="mt-4"><Button variant="secondary" size="sm" onClick={() => historyQuery.retry()}>重试</Button></div>
              </InlineNotice>
            )}
            {historyQuery.status === "success" && (
              <div className="history-list">
                {historyRows.map((revision) => (
                  <div className="history-row" key={revision.revisionId}>
                    <div className="history-row-main">
                      <span className="revision-item-label">{revision.revisionLabel}</span>
                      {revision.isCurrent && <span className="status-badge current-rev">当前</span>}
                      <span className="text-xs text-muted">
                        {revision.sourceFile === null
                          ? "源文件缺失或不可用"
                          : `${revision.sourceFile.fileName} · ${formatBytes(revision.sourceFile.sizeBytes)}`}
                      </span>
                      <span className="text-xs text-muted">{formatRelativeTime(revision.createdAt, now)}</span>
                    </div>
                    {!revision.isCurrent && (
                      <div className="flex-row-gap-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="btn-ghost-muted"
                          disabled={settingCurrent !== null}
                          onClick={() => void handleSetCurrent(revision.revisionId)}
                        >
                          {settingCurrent === revision.revisionId ? "正在设置…" : "设为当前版本"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="btn-ghost-muted"
                          onClick={() =>
                            setDeleteTarget({
                              revisionId: revision.revisionId,
                              revisionLabel: revision.revisionLabel,
                              sourceFileName: revision.sourceFile?.fileName ?? null
                            })
                          }
                        >
                          删除版本
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </DrawingWorkspace>

      {confirming && (
        <Dialog labelledBy="modeling-dialog-title" onClose={() => setConfirming(false)} dismissible={!creatingRun}>
          <div className="dialog-header"><h2 id="modeling-dialog-title" className="dialog-title">确认开始自动建模</h2></div>
          <div className="dialog-body">
            <p className="dialog-text">
              将为图纸 <strong className="text-mono">{drawingDetail.drawing.drawingNumber}</strong> 的当前所选版本 {revisionDetail.revision.revisionLabel} 创建新的建模任务，使用该版本图纸和最新版本记忆（工程事实与历史反馈）。任务会先进入等待队列。
            </p>
            {createError !== null && (
              <InlineNotice tone="error" title="创建建模任务失败" className="mt-4" role="alert">{createError}</InlineNotice>
            )}
          </div>
          <div className="dialog-footer">
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={creatingRun}><CloseIcon aria-hidden="true" />取消</Button>
            <Button variant="primary" onClick={() => void dispatchModeling()} disabled={creatingRun}>{creatingRun ? "正在创建…" : (<><PlayIcon aria-hidden="true" />确认并开始</>)}</Button>
          </div>
        </Dialog>
      )}
      {addRevisionOpen && (
        <AddRevisionDialog
          repository={repository}
          drawingId={activeDrawingId}
          onCancel={() => setAddRevisionOpen(false)}
          onAdded={handleRevisionAdded}
        />
      )}
      {deleteTarget !== null && (
        <DeleteRevisionDialog
          repository={repository}
          drawingId={activeDrawingId}
          revisionId={deleteTarget.revisionId}
          revisionLabel={deleteTarget.revisionLabel}
          {...(deleteTarget.sourceFileName === null
            ? {}
            : { sourceFileName: deleteTarget.sourceFileName })}
          runCount={deleteTargetQuery.data?.runs.length ?? 0}
          modelCount={deleteTargetQuery.data?.models.length ?? 0}
          costReportCount={deleteTargetQuery.data?.costReports.length ?? 0}
          onCancel={() => setDeleteTarget(null)}
          onDeleted={handleRevisionDeleted}
        />
      )}
    </div>
  );
}

export default DrawingOverviewPage;
