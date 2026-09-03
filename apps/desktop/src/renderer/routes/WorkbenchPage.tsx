import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ChevronRightIcon,
  EmptyState,
  InfoIcon,
  InlineNotice
} from "@swpanel/ui";
import { Link } from "react-router-dom";

import { useMemo, useRef, useState } from "react";

import { formatRelativeTime } from "../features/format.js";
import { revisionLabelOrId } from "../features/ids.js";
import { useRepository } from "../features/repository-provider.js";
import {
  useDrawingQuery,
  useDrawingRepository
} from "../features/bridge-repository/drawing-repository-provider.js";
import { useRunEventStream, useRunInvalidate, useRunQuery, useRunRepository } from "../features/run-repository/run-repository-provider.js";
import { LiveCurrentRunCard } from "../features/run-repository/run-current-card.js";
import { useRunIdentity } from "../features/run-repository/run-display.js";
import { toRunRepositoryError } from "../features/run-repository/run-repository.js";
import { cancelOutcomeNotice, type CancelNotice } from "../features/runs/cancel-outcome.js";
import { QueryErrorState, QueryLoadingState } from "../features/drawing/DrawingQueryStates.js";
import { RunStatusBadge } from "../features/runs/RunStatusBadge.js";
import { StageProgress } from "../features/runs/StageProgress.js";
import { drawingStatusFromListItem } from "../features/drawing-status.js";
import { drawingBusinessStatus, DrawingStatusBadge, listDrawingItems } from "./page-data.js";
import "../styles/phase1-pages.css";

const DISPLAY_NOW = new Date("2026-08-10T23:40:00.000Z");

function ActionLink({ to, children }: { readonly to: string; readonly children: React.ReactNode }) {
  return (
    <Link to={to} className="action-link">
      {children}
      <ChevronRightIcon aria-hidden="true" />
    </Link>
  );
}

/**
 * Lightweight status watcher for QUEUED runs: subscribes the run's event
 * stream so start/cancel/terminal transitions invalidate `runs:list` and the
 * Workbench queue/current views stay truthful.
 */
function WorkbenchRunStatusWatcher({ runId }: { readonly runId: string }): null {
  useRunEventStream(runId);
  return null;
}

/** One QUEUED queue row with a link to the Run detail page. */
function WorkbenchQueueRow({ runId }: { readonly runId: string }): React.JSX.Element {
  const runRepository = useRunRepository();
  const detailQuery = useRunQuery(`run:detail:${runId}`, () => runRepository.getRunDetail(runId));
  const detail = detailQuery.data;
  if (detail === undefined) {
    return (
      <div className="queue-item">
        <div className="queue-item-main">
          <div className="queue-item-number">{runId}</div>
        </div>
      </div>
    );
  }
  return <WorkbenchQueueRowLoaded run={detail.run} />;
}

function WorkbenchQueueRowLoaded({
  run
}: {
  readonly run: { runId: string; runLabel: string; drawingId: string; revisionId: string; status: string; createdAt: string };
}): React.JSX.Element {
  const identity = useRunIdentity(run.drawingId, run.revisionId);
  return (
    <div className="queue-item">
      <div className="queue-item-main">
        <div className="queue-item-number">
          {identity.drawingNumber} · {identity.revisionLabel}
        </div>
        <div className="queue-item-sub">
          {identity.drawingName} · {run.runLabel}
        </div>
      </div>
      <div className="flex-row-gap-3">
        <RunStatusBadge status={run.status} />
        <Link to={`/runs/${run.runId}`} className="action-link">
          查看
        </Link>
      </div>
    </div>
  );
}

/** One CLARIFICATION_REQUIRED run with a link to answer it. */
function WorkbenchClarificationRow({ runId }: { readonly runId: string }): React.JSX.Element {
  const runRepository = useRunRepository();
  const detailQuery = useRunQuery(`run:detail:${runId}`, () => runRepository.getRunDetail(runId));
  const detail = detailQuery.data;
  if (detail === undefined) {
    return (
      <div className="attention-item">
        <span className="attention-item-icon clarify" aria-hidden="true"><InfoIcon /></span>
        <div className="attention-item-main">
          <div className="attention-item-title">1 个任务需要补充信息</div>
        </div>
      </div>
    );
  }
  return <WorkbenchClarificationRowLoaded run={detail.run} />;
}

function WorkbenchClarificationRowLoaded({
  run
}: {
  readonly run: { runId: string; runLabel: string; drawingId: string; revisionId: string };
}): React.JSX.Element {
  const identity = useRunIdentity(run.drawingId, run.revisionId);
  return (
    <div className="attention-item">
      <span className="attention-item-icon clarify" aria-hidden="true"><InfoIcon /></span>
      <div className="attention-item-main">
        <div className="attention-item-title">1 个任务需要补充信息</div>
        <div className="attention-item-sub">
          {identity.drawingNumber} · {identity.revisionLabel} · {run.runLabel}
        </div>
      </div>
      <Link to={`/runs/${run.runId}`} className="action-link">
        补充
      </Link>
    </div>
  );
}

/**
 * PRODUCT-runtime workbench (real bridge / no bridge): real Runner data over
 * the DrawingRepository and RunRepository. Shows the live current Run (with
 * reconnect recovery), the waiting queue, clarification attention items and
 * the recent drawings. NO fixture Run/Model data and NO dead fixture links;
 * Model review / Cost items stay out until their phases land.
 */
function TruthfulWorkbench({ now }: { readonly now: Date }): React.JSX.Element {
  const repository = useDrawingRepository();
  const runRepository = useRunRepository();
  const invalidateRuns = useRunInvalidate();
  const [cancelling, setCancelling] = useState(false);
  const [notices, setNotices] = useState<readonly CancelNotice[]>([]);
  const nextNoticeId = useRef(1);

  const listQuery = useDrawingQuery("drawings:list", () => repository.listDrawings());
  const runsQuery = useRunQuery("runs:list", () => runRepository.listRuns());

  const runs = runsQuery.data ?? [];
  const currentRun = useMemo(
    () => [...runs].filter((run) => run.status === "RUNNING").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null,
    [runs]
  );
  const queuedRuns = useMemo(
    () => [...runs].filter((run) => run.status === "QUEUED").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 2),
    [runs]
  );
  const clarificationRuns = useMemo(
    () => [...runs].filter((run) => run.status === "CLARIFICATION_REQUIRED").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 1),
    [runs]
  );

  async function handleCancelCurrentRun(): Promise<void> {
    if (currentRun === null || cancelling) return; // duplicate submit guard
    setCancelling(true);
    try {
      const outcome = await runRepository.cancelRun({ runId: currentRun.runId, reason: "用户主动取消" });
      setNotices((current) => [...current, cancelOutcomeNotice(outcome, currentRun.runLabel, nextNoticeId.current++)]);
      if (outcome.status === "CANCELLED") invalidateRuns();
    } catch (error) {
      const structured = toRunRepositoryError(error);
      setNotices((current) => [
        ...current,
        {
          id: nextNoticeId.current++,
          tone: "error",
          title: `Run ${currentRun.runLabel} 取消失败`,
          text: `${structured.code}: ${structured.message}`
        }
      ]);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="page-content" data-route-id="workbench">
      {notices.map((notice) => (
        <InlineNotice key={notice.id} tone={notice.tone} title={notice.title} className="mb-4">
          {notice.text}
        </InlineNotice>
      ))}

      <section className="section" aria-labelledby="current-run-heading">
        {runsQuery.status === "loading" && <QueryLoadingState label="正在加载建模任务…" />}
        {runsQuery.status === "error" && (
          <QueryErrorState title="建模任务加载失败" error={runsQuery.error} onRetry={() => runsQuery.retry()} />
        )}
        {runsQuery.status === "success" && (currentRun === null ? (
          <EmptyState
            title="当前没有正在执行的建模任务"
            description="上传新图纸或从图纸库打开已有图纸即可开始自动建模。"
            action={
              <div className="action-row" style={{ justifyContent: "center" }}>
                <Link to="/drawings" className="btn btn-primary">打开图纸库</Link>
              </div>
            }
          />
        ) : (
          <LiveCurrentRunCard
            run={currentRun}
            now={now}
            onCancel={() => void handleCancelCurrentRun()}
            cancelling={cancelling}
          />
        ))}
      </section>

      <section className="section grid-2" aria-label="队列与待处理事项">
        <Card>
          <CardHeader><CardTitle>等待队列</CardTitle><ActionLink to="/runs">查看全部</ActionLink></CardHeader>
          <CardBody padding="compact">
            {runsQuery.status === "loading" && <p className="text-sm text-muted">正在加载…</p>}
            {runsQuery.status === "error" && <p className="text-sm text-muted">队列加载失败。</p>}
            {runsQuery.status === "success" && (queuedRuns.length === 0 ? (
              <p className="text-sm text-muted">当前没有等待执行的任务。</p>
            ) : (
              queuedRuns.map((run) => (
                <div key={run.runId}>
                  <WorkbenchRunStatusWatcher runId={run.runId} />
                  <WorkbenchQueueRow runId={run.runId} />
                </div>
              ))
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>需要处理</CardTitle></CardHeader>
          <CardBody padding="compact">
            {runsQuery.status === "success" && (clarificationRuns.length === 0 ? (
              <p className="text-sm text-muted">当前没有需要处理的事项。</p>
            ) : (
              clarificationRuns.map((run) => (
                <WorkbenchClarificationRow key={run.runId} runId={run.runId} />
              ))
            ))}
          </CardBody>
        </Card>
      </section>

      <section className="section" aria-labelledby="recent-drawings-heading">
        <div className="section-header">
          <h2 id="recent-drawings-heading" className="section-title">最近图纸</h2>
          <ActionLink to="/drawings">图纸库</ActionLink>
        </div>
        {listQuery.status === "loading" && <QueryLoadingState label="正在加载最近图纸…" />}
        {listQuery.status === "error" && (
          <QueryErrorState title="图纸库加载失败" error={listQuery.error} onRetry={() => listQuery.retry()} />
        )}
        {listQuery.status === "success" && (
          <div className="drawing-list">
            {listQuery.data?.slice(0, 3).map((drawing) => {
              const revisionId = drawing.currentRevisionId ?? "";
              return (
                <Link
                  key={drawing.drawingId}
                  to={`/drawings/${drawing.drawingId}/revisions/${revisionId}/overview`}
                  className="drawing-row"
                  aria-label={`打开图纸 ${drawing.drawingNumber} ${drawing.name}`}
                >
                  <span className="drawing-row-main">
                    <span className="drawing-row-number">{drawing.drawingNumber}</span>
                    <span className="drawing-row-name">{drawing.name}</span>
                  </span>
                  <span className="drawing-row-meta">
                    <span className="row-version text-mono text-xs text-muted">
                      {drawing.currentRevisionLabel ?? "—"}
                    </span>
                    <span className="row-status">
                      <DrawingStatusBadge status={drawingStatusFromListItem(drawing)} />
                    </span>
                    <span className="row-date text-xs text-muted">
                      {formatRelativeTime(drawing.updatedAt, now)}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

export interface WorkbenchPageProps {
  readonly now?: Date;
  readonly repository?: import("../features/mock-repository/mock-repository.js").MockRepository;
}

/**
 * PRODUCT workbench renders with the REAL current time (relative labels stay
 * truthful); the mock runtime keeps the deterministic fixture date so the
 * canonical Phase 1 stories and screenshots never drift.
 */
export function WorkbenchPage({ now: nowProp, repository: repositoryOverride }: WorkbenchPageProps): React.JSX.Element {
  const repository = useRepository(repositoryOverride);
  const drawingRepository = useDrawingRepository();
  const now = nowProp ?? (drawingRepository.mode === "mock" ? DISPLAY_NOW : new Date());

  // Product runtime truthfulness: with a real bridge (or no bridge in
  // production) the fixture Run/Model dashboard must never be shown.
  if (drawingRepository.mode !== "mock") {
    return <TruthfulWorkbench now={now} />;
  }

  const dashboard = repository.getWorkspaceDashboard();
  const runningRun = repository
    .listRuns()
    .filter((run) => run.status === "RUNNING")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const currentRun = runningRun === undefined ? null : repository.getRunDetail(runningRun.id).run;
  const currentDrawing = currentRun === null ? undefined : repository.getDrawing(currentRun.drawingId);
  const queuedRuns = repository
    .listRuns()
    .filter((run) => run.status === "QUEUED")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, 2);

  return (
    <div className="page-content" data-route-id="workbench">
      {currentRun !== null && currentDrawing !== undefined ? (
        <section className="section" aria-labelledby="current-run-heading">
          <div className="run-card">
            <div className="run-card-header">
              <div className="run-card-title-group">
                <div className="flex-row-gap-3">
                  <h1 id="current-run-heading" className="run-card-drawing">{currentDrawing.drawingNumber}</h1>
                  <RunStatusBadge status={currentRun.status} />
                </div>
                <div className="run-card-partname">{currentDrawing.name}</div>
                <div className="run-card-meta mt-2">
                  <span>{revisionLabelOrId(repository, currentRun.revisionId)}</span>
                  <span className="run-card-meta-sep" aria-hidden="true" />
                  <span>Run {currentRun.runLabel}</span>
                  <span className="run-card-meta-sep" aria-hidden="true" />
                  <span>{formatRelativeTime(currentRun.createdAt, now)} 启动</span>
                </div>
              </div>
              <Link to={`/runs/${currentRun.runId}`} className="btn btn-secondary btn-sm">查看任务</Link>
            </div>
            <div className="run-card-status-line">
              <span className="run-card-stage-label">SolidWorks 建模</span>
              <span className="run-card-progress-pct">{currentRun.progressPercent ?? 0}%</span>
            </div>
            <div className="progress-bar" role="progressbar" aria-label="当前任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={currentRun.progressPercent ?? 0}>
              <div className="progress-bar-fill" style={{ width: `${currentRun.progressPercent ?? 0}%` }} />
            </div>
            {currentRun.activity !== null && <div className="run-card-activity">{currentRun.activity}</div>}
            <StageProgress stage={currentRun.stage} live />
          </div>
        </section>
      ) : (
        <section className="section" aria-labelledby="workbench-empty-heading">
          <EmptyState
            title="当前没有正在执行的建模任务"
            description="上传新图纸或从图纸库打开已有图纸即可开始自动建模。"
            action={
              <div className="action-row" style={{ justifyContent: "center" }}>
                <Link to="/drawings" className="btn btn-primary">打开图纸库</Link>
              </div>
            }
          />
        </section>
      )}

      <section className="section grid-2" aria-label="队列与待处理事项">
        <Card>
          <CardHeader><CardTitle>等待队列</CardTitle><ActionLink to="/runs">查看全部</ActionLink></CardHeader>
          <CardBody padding="compact">
            {queuedRuns.map((run) => {
              const drawing = repository.getDrawing(run.drawingId);
              return (
                <div className="queue-item" key={run.id}>
                  <div className="queue-item-main">
                    <div className="queue-item-number">{drawing?.drawingNumber ?? run.drawingId} · {revisionLabelOrId(repository, run.revisionId)}</div>
                    <div className="queue-item-sub">{drawing?.name ?? "未知图纸"} · {run.number}</div>
                  </div>
                  <RunStatusBadge status={run.status} />
                </div>
              );
            })}
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>需要处理</CardTitle></CardHeader>
          <CardBody padding="compact">
            {dashboard.pendingReviews.map((review) => {
              const model = repository.getModel(review.modelId);
              return (
                <div className="attention-item" key={review.modelId}>
                  <span className="attention-item-icon review" aria-hidden="true"><InfoIcon /></span>
                  <div className="attention-item-main">
                    <div className="attention-item-title">1 个模型等待审核</div>
                    <div className="attention-item-sub">{review.drawingNumber} · {review.revisionLabel} · {review.modelLabel}</div>
                  </div>
                  {model !== undefined && <ActionLink to={`/drawings/${review.drawingId}/revisions/${model.revisionId}/models/${review.modelId}`}>审核</ActionLink>}
                </div>
              );
            })}
            {dashboard.pendingClarifications.slice(0, 1).map((clarification) => (
              <div className="attention-item" key={clarification.runId}>
                <span className="attention-item-icon clarify" aria-hidden="true"><InfoIcon /></span>
                <div className="attention-item-main">
                  <div className="attention-item-title">1 个任务需要补充信息</div>
                  <div className="attention-item-sub">{clarification.drawingNumber} · {clarification.revisionLabel} · {clarification.runLabel}</div>
                </div>
                <ActionLink to={`/runs/${clarification.runId}`}>补充</ActionLink>
              </div>
            ))}
          </CardBody>
        </Card>
      </section>

      <section className="section" aria-labelledby="recent-drawings-heading">
        <div className="section-header"><h2 id="recent-drawings-heading" className="section-title">最近图纸</h2><ActionLink to="/drawings">图纸库</ActionLink></div>
        <div className="drawing-list">
          {listDrawingItems(repository).slice(0, 3).map((drawing) => {
            const status = drawingBusinessStatus(repository, drawing);
            const revisionId = drawing.currentRevisionId ?? "";
            return (
              <Link key={drawing.drawingId} to={`/drawings/${drawing.drawingId}/revisions/${revisionId}/overview`} className="drawing-row" aria-label={`打开图纸 ${drawing.drawingNumber} ${drawing.name}`}>
                <span className="drawing-row-main"><span className="drawing-row-number">{drawing.drawingNumber}</span><span className="drawing-row-name">{drawing.name}</span></span>
                <span className="drawing-row-meta"><span className="row-version text-mono text-xs text-muted">{drawing.currentRevisionLabel ?? "—"}</span><span className="row-status"><DrawingStatusBadge status={status} /></span><span className="row-date text-xs text-muted">{formatRelativeTime(drawing.updatedAt, now)}</span></span>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export default WorkbenchPage;
