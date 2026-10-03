import { Button, Card, CardBody, CardHeader, CardTitle, InlineNotice } from "@swpanel/ui";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";

import { useMemo, useRef, useState } from "react";

import { isRunTerminal, RUN_STAGE_LABELS, type RunStatus } from "@swpanel/domain";

import { useRepository } from "../features/repository-provider.js";
import { useDrawingRepository } from "../features/bridge-repository/drawing-repository-provider.js";
import { useRunEventStream, useRunInvalidate, useRunQuery, useRunRepository } from "../features/run-repository/run-repository-provider.js";
import { MockRunRepository } from "../features/run-repository/mock-run-repository.js";
import { useModelLabel, useRunIdentity } from "../features/run-repository/run-display.js";
import { describeError } from "../features/error-messages.js";
import { cancelOutcomeNotice, type CancelNotice } from "../features/runs/cancel-outcome.js";
import { resolveRunId, revisionLabelOrId } from "../features/ids.js";
import { formatRelativeTime } from "../features/format.js";
import { RunStatusBadge } from "../features/runs/RunStatusBadge.js";
import { CancelRunDialog } from "../features/runs/CancelRunDialog.js";
import { runEventTypeLabel, runFailureSummary } from "../features/runs/failure-presentation.js";
import { StageProgress } from "../features/runs/StageProgress.js";
import { ClarificationForm, MOCK_ANSWERING_USER } from "../features/runs/ClarificationForm.js";
import { createRunForRevision } from "../features/runs/create-run.js";
import { QueryErrorState, QueryLoadingState } from "../features/drawing/DrawingQueryStates.js";
import { DeleteRunDialog } from "../features/drawing/DrawingDialogs.js";

export interface RunDetailPageProps {
  readonly now?: Date;
}

interface StageActivityRow {
  readonly index: number;
  readonly label: string;
  readonly state: "completed" | "active" | "pending";
  readonly activity: string | null;
}

/** Derives the six-stage activity list from the run's event stream. */
function buildStageRows(
  stageEvents: readonly { type: string; stage?: string; activity?: string }[],
  reachedStage: string | null,
  live: boolean
): readonly StageActivityRow[] {
  const ORDER: readonly string[] = ["PREPARING", "ANALYZING", "PLANNING", "MODELING", "VALIDATING", "PACKAGING"];
  const labels: Readonly<Record<string, string>> = {
    PREPARING: "准备任务",
    ANALYZING: "分析图纸",
    PLANNING: "规划模型",
    MODELING: "SolidWorks 建模",
    VALIDATING: "检查模型",
    PACKAGING: "生成结果"
  };
  const reachedIndex = reachedStage === null ? -1 : ORDER.indexOf(reachedStage);
  const lastReached =
    stageEvents.length > 0
      ? Math.max(-1, ...stageEvents.map((event) => (event.stage !== undefined ? ORDER.indexOf(event.stage) : -1)))
      : reachedIndex;

  const activityByStage = new Map<string, string>();
  for (const event of stageEvents) {
    if (event.stage !== undefined && event.activity !== undefined) {
      activityByStage.set(event.stage, event.activity);
    }
  }

  return ORDER.map((stage, index) => {
    const state: StageActivityRow["state"] =
      index < lastReached ? "completed" : index === lastReached ? (live ? "active" : "completed") : "pending";
    return {
      index: index + 1,
      label: labels[stage] ?? stage,
      state,
      activity: activityByStage.get(stage) ?? null
    };
  });
}

// ---------------------------------------------------------------------------
// Product runtime (bridge / unavailable): real async data, never fixtures
// ---------------------------------------------------------------------------

/** Header identity line resolved through the cached Drawing queries. */
function RunIdentityLine({
  drawingId,
  revisionId
}: {
  readonly drawingId: string;
  readonly revisionId: string;
}): React.JSX.Element {
  const identity = useRunIdentity(drawingId, revisionId);
  return (
    <div className="workspace-drawing-name" style={{ marginTop: "6px" }}>
      {identity.drawingNumber} · {identity.revisionLabel} · {identity.drawingName}
    </div>
  );
}

/**
 * Product-mode Run Detail. Reads the merged snapshot+live-events stream
 * (`useRunEventStream`) with snapshot-then-subscribe and reconnect recovery;
 * renders the clarification form against the real bridge; cancel resolves the
 * structured outcome (CANCELLED / CANCEL_PENDING / FAILED cleanup /
 * ALREADY_TERMINAL). A COMPLETED
 * run is shown truthfully model-less (Phase 3 semantics: completion publishes
 * no Model) and NEVER links to a Model page.
 */
function ProductRunDetailPage({ now }: { readonly now: Date }): React.JSX.Element {
  const { runId: runParam } = useParams();
  const navigate = useNavigate();
  const runRepository = useRunRepository();
  const invalidateRuns = useRunInvalidate();
  const [cancelling, setCancelling] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteRunOpen, setDeleteRunOpen] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [notices, setNotices] = useState<readonly CancelNotice[]>([]);
  const nextNoticeId = useRef(1);

  const stream = useRunEventStream(runParam ?? null);

  const detail = stream.detail;
  const run = detail?.run ?? null;

  const clarificationQuery = useRunQuery(
    run?.clarificationRequestId !== null && run?.clarificationRequestId !== undefined
      ? `clarification:${run.clarificationRequestId}`
      : "clarification:none",
    () => runRepository.getClarification(run?.clarificationRequestId as string),
    {
      enabled:
        run !== null &&
        run.clarificationRequestId !== null &&
        run.clarificationRequestId !== undefined
    }
  );
  const clarification = clarificationQuery.data ?? null;

  const live = run?.status === "RUNNING";
  const terminal = run !== null && isRunTerminal(run.status as RunStatus);
  const modelLabel = useModelLabel(run?.modelId ?? null);

  async function handleCancel(): Promise<void> {
    if (run === null || cancelling) return; // duplicate submit guard
    setCancelConfirmOpen(false);
    setCancelling(true);
    try {
      const outcome = await runRepository.cancelRun({ runId: run.runId, reason: "用户主动取消" });
      setNotices((current) => [...current, cancelOutcomeNotice(outcome, run.runLabel, nextNoticeId.current++)]);
      if (outcome.status === "CANCELLED") invalidateRuns();
    } catch (error) {
      setNotices((current) => [
        ...current,
        {
          id: nextNoticeId.current++,
          tone: "error",
          title: `Run ${run.runLabel} 取消失败`,
          text: describeError(error).message
        }
      ]);
    } finally {
      setCancelling(false);
    }
  }

  /** RUNNING Runs need a second confirmation (cancel deletes generated files). */
  function requestCancel(): void {
    if (run === null || cancelling) return;
    if (run.status === "RUNNING") setCancelConfirmOpen(true);
    else void handleCancel();
  }

  async function handleStartNewRun(): Promise<void> {
    if (run === null || creating) return; // duplicate submit guard
    setCreating(true);
    try {
      const created = await runRepository.createRun({
        drawingId: run.drawingId,
        revisionId: run.revisionId
      });
      invalidateRuns();
      // Navigate to the fresh Run (a new Run, never a resumed one).
      void navigate(`/runs/${created.id}`);
    } catch (error) {
      setNotices((current) => [
        ...current,
        {
          id: nextNoticeId.current++,
          tone: "error",
          title: "创建新的 Run 失败",
          text: describeError(error).message
        }
      ]);
      setCreating(false);
    }
  }

  // While the stream reconnects (or gave up) the last known data stays on
  // screen; only a banner reports the interruption.
  const hasData = detail !== null && run !== null;
  const shell = (children: React.ReactNode): React.JSX.Element => (
    <div className="page-content" data-route-id="run-detail">
      {hasData && stream.status === "recovering" && (
        <InlineNotice tone="warning" className="mb-4" title="连接中断，正在重新连接…" role="status">
          与执行服务的实时连接已中断，页面保留最近一次的进度（第 {stream.recoveryAttempts} 次尝试）。
        </InlineNotice>
      )}
      {hasData && stream.status === "error" && (
        <InlineNotice tone="error" className="mb-4" title="连接中断，未能重新连接" role="alert">
          页面显示的是最近一次获取的进度，可能已过期。
          <div className="mt-4">
            <Button variant="secondary" size="sm" onClick={() => stream.retry()}>点击重试</Button>
          </div>
        </InlineNotice>
      )}
      {notices.map((notice) => (
        <InlineNotice key={notice.id} tone={notice.tone} title={notice.title} className="mb-4" role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
        </InlineNotice>
      ))}
      {children}
    </div>
  );

  if (runParam === undefined || runParam === "") {
    return <Navigate to="/runs" replace />;
  }

  if (detail === null || run === null) {
    if (stream.status === "error") {
      return shell(
        <QueryErrorState
          title="Run 详情加载失败"
          error={stream.error}
          onRetry={() => stream.retry()}
          action={
            <Link to="/runs" className="btn btn-ghost btn-sm">
              返回建模任务
            </Link>
          }
        />
      );
    }
    return shell(<QueryLoadingState label="正在加载 Run 详情…" />);
  }

  const stageRows = buildStageRows(
    detail.events.filter((event) => event.type === "StageChanged" || event.type === "ActivityUpdated"),
    run.stage,
    live
  );

  const stopStageLabel =
    run.status === "CLARIFICATION_REQUIRED"
      ? "分析图纸"
      : run.status === "FAILED" || run.status === "CANCELLED"
        ? "执行中断"
        : run.stage !== null
          ? (RUN_STAGE_LABELS[run.stage as keyof typeof RUN_STAGE_LABELS] ?? "—")
          : "—";

  const canCancel = run.status === "QUEUED" || run.status === "RUNNING";
  const deletable = run.status === "COMPLETED" || run.status === "FAILED" || run.status === "CANCELLED";

  return shell(
    <>
      <div className="workspace-header">
        <div className="workspace-header-top">
          <div>
            <div className="flex-row-gap-3">
              <h1 className="workspace-drawing-number" style={{ fontSize: "18px" }}>
                {run.runLabel}
              </h1>
              <RunStatusBadge status={run.status} />
            </div>
            <RunIdentityLine drawingId={run.drawingId} revisionId={run.revisionId} />
          </div>
          <div className="workspace-header-actions">
            <Link to="/runs" className="btn btn-ghost btn-sm">
              返回建模任务
            </Link>
            {deletable && (
              <Button variant="ghost-muted" size="sm" onClick={() => setDeleteRunOpen(true)}>
                删除记录
              </Button>
            )}
            {canCancel && (
              <Button variant="ghost-muted" size="sm" onClick={requestCancel} disabled={cancelling}>
                {cancelling ? "正在取消…" : "取消任务"}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="stat-strip stat-strip-3 mb-8">
        <div className="stat-strip-item">
          <div className="stat-strip-label">创建时间</div>
          <div className="stat-strip-value mono">{formatRelativeTime(run.createdAt, now)}</div>
        </div>
        <div className="stat-strip-item">
          <div className="stat-strip-label">{terminal ? "停止阶段" : "当前阶段"}</div>
          <div className="stat-strip-value">{stopStageLabel}</div>
        </div>
        <div className="stat-strip-item">
          <div className="stat-strip-label">状态</div>
          <div className="stat-strip-value">
            <RunStatusBadge status={run.status} />
          </div>
        </div>
      </div>

      {(live || run.status === "QUEUED") && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">{live ? "执行进度" : "等待执行"}</div>
          </div>
          <Card>
            <CardBody>
              {live && run.progressPercent !== null && (
                <>
                  <div className="run-card-status-line">
                    <span className="run-card-stage-label">{run.activity ?? "正在执行"}</span>
                    <span className="run-card-progress-pct">{run.progressPercent}%</span>
                  </div>
                  <div className="progress-bar" role="progressbar" aria-label="当前任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={run.progressPercent}>
                    <div className="progress-bar-fill" style={{ width: `${run.progressPercent}%` }} />
                  </div>
                </>
              )}
              <StageProgress stage={run.stage} live={live} />
              {run.status === "QUEUED" && (
                <p className="text-sm text-muted">任务已在队列中，将按顺序自动执行。</p>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {clarification !== null && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">
              需要补充 {clarification.questions.length} 项信息
            </div>
          </div>
          <ClarificationForm
            clarification={clarification}
            now={now}
            answeredBy={MOCK_ANSWERING_USER}
            onSubmitAnswers={async (answers) => {
              await runRepository.submitClarification({
                clarificationRequestId: clarification.clarificationRequestId,
                answers,
                answeredAt: new Date().toISOString(),
                answeredBy: MOCK_ANSWERING_USER
              });
              // The request is now ANSWERED; refetch it. The Run stays
              // terminal CLARIFICATION_REQUIRED and is NEVER resumed.
              invalidateRuns();
            }}
            onSubmitted={() => undefined}
            onRestartModeling={() => void handleStartNewRun()}
            restarting={creating}
          />
          {clarification.status === "ANSWERED" && (
            <div className="mt-4">
              <Link
                to={`/drawings/${run.drawingId}/revisions/${run.revisionId}/memory`}
                className="btn btn-secondary btn-sm"
              >
                前往版本记忆更新 Facts
              </Link>
            </div>
          )}
        </div>
      )}

      {run.clarificationRequestId !== null &&
        run.clarificationRequestId !== undefined &&
        clarification === null && (
          <div className="section">
            <div className="section-header">
              <div className="section-title">需要补充信息</div>
            </div>
            <Card>
              <CardBody>
                {clarificationQuery.status === "loading" && (
                  <p className="text-sm text-muted" role="status">
                    正在加载补充信息…
                  </p>
                )}
                {clarificationQuery.status === "error" && (
                  <InlineNotice tone="error" title="补充信息加载失败" role="alert">
                    {describeError(clarificationQuery.error).message}
                    <div className="mt-4">
                      <Button variant="secondary" size="sm" onClick={() => clarificationQuery.retry()}>
                        重试
                      </Button>
                    </div>
                  </InlineNotice>
                )}
              </CardBody>
            </Card>
          </div>
        )}

      {run.status === "COMPLETED" && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">执行结果</div>
          </div>
          <Card>
            <CardBody>
              {run.modelId === null ? (
                <InlineNotice tone="neutral" title="Run 已完成（未生成模型）">
                  本阶段执行完成，未发布模型。可随时发起新的 Run。
                </InlineNotice>
              ) : (
                <InlineNotice tone="success" title="Run 已完成">
                  执行完成并发布模型{modelLabel !== null ? ` ${modelLabel}` : ""}。
                  <div className="mt-4">
                    <Link
                      to={`/drawings/${run.drawingId}/revisions/${run.revisionId}/models/${run.modelId}`}
                      className="btn btn-secondary btn-sm"
                    >
                      查看模型详情
                    </Link>
                  </div>
                </InlineNotice>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {run.status === "FAILED" && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">失败信息</div>
          </div>
          <Card>
            <CardBody>
              <InlineNotice tone="error" title={runFailureSummary(run.failureCode)}>
                该 Run 已终止。处理后可通过「重新自动建模」发起新的 Run。
              </InlineNotice>
              <details className="text-xs text-muted mt-4" open>
                <summary>技术详情</summary>
                {run.failureCode !== null && <div className="text-mono">失败代码：{run.failureCode}</div>}
                {run.failureMessage !== null && run.failureMessage !== undefined && <div>{run.failureMessage}</div>}
              </details>
              <div className="mt-4">
                <Button variant="secondary" size="sm" onClick={() => void handleStartNewRun()} disabled={creating}>
                  {creating ? "正在创建新任务…" : "重新自动建模"}
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {run.status === "CANCELLED" && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">已取消</div>
          </div>
          <Card>
            <CardBody>
              <InlineNotice tone="neutral" title="Run 已取消">
                用户主动取消了本次执行，未生成模型。可随时发起新的 Run。
              </InlineNotice>
            </CardBody>
          </Card>
        </div>
      )}

      {stageRows.length > 0 && terminal && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">执行阶段</div>
          </div>
          <Card>
            <CardBody>
              <div className="run-detail-stage-list">
                {stageRows.map((stage) => (
                  <div className={`run-detail-stage ${stage.state}`} key={stage.index}>
                    <span className="run-detail-stage-num">{stage.index}</span>
                    <span className="run-detail-stage-label">{stage.label}</span>
                    {stage.activity !== null && (
                      <span className="run-detail-stage-activity">{stage.activity}</span>
                    )}
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {detail.events.length > 0 && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">事件流</div>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>结构化事件</CardTitle>
            </CardHeader>
            <CardBody>
              <div className="run-detail-stage-list">
                {detail.events.map((event) => (
                  <div className="run-detail-stage" key={event.sequence}>
                    <span className="run-detail-stage-num">{event.sequence}</span>
                    <span className="run-detail-stage-label">
                      {runEventTypeLabel(event.type)}{" "}
                      <span className="text-xs text-muted text-mono">{event.type}</span>
                    </span>
                    <span className="run-detail-stage-activity">{formatRelativeTime(event.occurredAt, now)}</span>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {cancelConfirmOpen && (
        <CancelRunDialog
          runLabel={run.runLabel}
          onKeep={() => setCancelConfirmOpen(false)}
          onConfirm={() => void handleCancel()}
        />
      )}
      {deleteRunOpen && run !== null && (
        <DeleteRunDialog
          repository={runRepository}
          run={run}
          onCancel={() => setDeleteRunOpen(false)}
          onDeleted={() => {
            setDeleteRunOpen(false);
            invalidateRuns();
            void navigate("/runs");
          }}
        />
      )}
    </>
  );
}

/**
 * Run Detail (`/runs/:runId`). Full execution record for one Modeling Run:
 * header with status, stat strip, six-stage progress for live runs, the
 * clarification form for CLARIFICATION_REQUIRED runs (open vs answered) and a
 * truthful model-less completion for COMPLETED runs.
 *
 * Mock runtime: deterministic Phase 1 fixture UI (sync). Product runtime (real
 * bridge / no bridge): real async data over the RunRepository event stream.
 */
export function RunDetailPage({ now = new Date() }: RunDetailPageProps): React.JSX.Element {
  const repository = useRepository();
  const parameters = useParams();
  const [, setVersion] = useState(0);
  const [deleteRunOpen, setDeleteRunOpen] = useState(false);
  // Mock-mode deletion runs through the explicit MockRunRepository adapter so
  // the exact Phase 1 MockRepository instance the page reads is mutated.
  const deleteRunRepository = useMemo(() => new MockRunRepository(repository), [repository]);

  const runId = useMemo(() => resolveRunId(repository, parameters.runId), [repository, parameters.runId]);
  const drawingRepository = useDrawingRepository();
  if (drawingRepository.mode !== "mock") {
    return <ProductRunDetailPage now={now} />;
  }

  if (runId === null) {
    return <Navigate to="/runs" replace />;
  }

  const detail = repository.getRunDetail(runId);
  const run = detail.run;
  const drawing = repository.getDrawing(run.drawingId);
  const revision = repository.getRevision(run.revisionId);
  const model = run.modelId !== null ? repository.getModel(run.modelId) : undefined;

  const live = run.status === "RUNNING";
  const terminal = isRunTerminal(run.status as RunStatus);
  const deletable = run.status === "COMPLETED" || run.status === "FAILED" || run.status === "CANCELLED";

  const stageRows = buildStageRows(
    detail.events.filter((event) => event.type === "StageChanged" || event.type === "ActivityUpdated"),
    run.stage,
    live
  );

  const clarification =
    run.clarificationRequestId !== null
      ? repository.getClarification(run.clarificationRequestId)
      : null;


  function restartModeling() {
    if (revision === undefined) return;
    const newRun = createRunForRevision(repository, revision);
    setVersion((value) => value + 1);
    // Navigate in the next tick so the freshly created run is visible.
    window.setTimeout(() => {
      window.location.hash = `#/runs/${newRun.id}`;
    }, 0);
  }

  const stopStageLabel =
    run.status === "CLARIFICATION_REQUIRED"
      ? "分析图纸"
      : run.status === "FAILED" || run.status === "CANCELLED"
        ? "执行中断"
        : run.stage !== null
          ? (RUN_STAGE_LABELS[run.stage as keyof typeof RUN_STAGE_LABELS] ?? "—")
          : "—";

  return (
    <div className="page-content" data-route-id="run-detail">
      <div className="workspace-header">
        <div className="workspace-header-top">
          <div>
            <div className="flex-row-gap-3">
              <h1 className="workspace-drawing-number" style={{ fontSize: "18px" }}>
                {run.runLabel}
              </h1>
              <RunStatusBadge status={run.status} />
            </div>
            <div className="workspace-drawing-name" style={{ marginTop: "6px" }}>
              {drawing?.drawingNumber ?? run.drawingId} · {revisionLabelOrId(repository, run.revisionId)} · {drawing?.name ?? ""}
            </div>
          </div>
          <div className="workspace-header-actions">
            <Link to="/runs" className="btn btn-ghost btn-sm">
              返回建模任务
            </Link>
            {deletable && (
              <Button variant="ghost-muted" size="sm" onClick={() => setDeleteRunOpen(true)}>
                删除记录
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="stat-strip stat-strip-3 mb-8">
        <div className="stat-strip-item">
          <div className="stat-strip-label">创建时间</div>
          <div className="stat-strip-value mono">{formatRelativeTime(run.createdAt, now)}</div>
        </div>
        <div className="stat-strip-item">
          <div className="stat-strip-label">{terminal ? "停止阶段" : "当前阶段"}</div>
          <div className="stat-strip-value">{stopStageLabel}</div>
        </div>
        <div className="stat-strip-item">
          <div className="stat-strip-label">状态</div>
          <div className="stat-strip-value">
            <RunStatusBadge status={run.status} />
          </div>
        </div>
      </div>

      {(live || run.status === "QUEUED") && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">{live ? "执行进度" : "等待执行"}</div>
          </div>
          <Card>
            <CardBody>
              {live && run.progressPercent !== null && (
                <>
                  <div className="run-card-status-line">
                    <span className="run-card-stage-label">{run.activity ?? "正在执行"}</span>
                    <span className="run-card-progress-pct">{run.progressPercent}%</span>
                  </div>
                  <div className="progress-bar" role="progressbar" aria-label="当前任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={run.progressPercent}>
                    <div className="progress-bar-fill" style={{ width: `${run.progressPercent}%` }} />
                  </div>
                </>
              )}
              <StageProgress stage={run.stage} live={live} />
              {run.status === "QUEUED" && (
                <p className="text-sm text-muted">任务已在队列中，将按顺序自动执行。</p>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {clarification !== null && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">
              需要补充 {clarification.questions.length} 项信息
            </div>
          </div>
          <ClarificationForm
            clarification={clarification}
            now={now}
            onSubmitAnswers={(answers) => {
              repository.submitClarificationAnswers({
                clarificationId: clarification.clarificationRequestId,
                answers,
                answeredAt: new Date().toISOString(),
                answeredBy: MOCK_ANSWERING_USER
              });
            }}
            onSubmitted={() => setVersion((value) => value + 1)}
            onRestartModeling={restartModeling}
          />
        </div>
      )}

      {run.status === "COMPLETED" && model !== undefined && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">执行结果</div>
          </div>
          <Card>
            <CardBody>
              <InlineNotice tone="success" title={`模型 ${model.number} 已生成`}>
                Run {run.runLabel} 已完成并发布模型 {model.number}。该模型当前为{" "}
                {model.reviewStatus === "PENDING_REVIEW" ? "等待审核" : model.reviewStatus === "APPROVED" ? "审核通过" : "已退回"} 状态。
              </InlineNotice>
              <div className="mt-4">
                <Link
                  to={`/drawings/${model.drawingId}/revisions/${model.revisionId}/models/${model.id}`}
                  className="btn btn-secondary btn-sm"
                >
                  查看模型详情
                </Link>
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {run.status === "FAILED" && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">失败信息</div>
          </div>
          <Card>
            <CardBody>
              <InlineNotice tone="error" title={runFailureSummary(run.failureCode)}>
                该 Run 已终止。处理后可通过「重新自动建模」发起新的 Run。
              </InlineNotice>
              <details className="text-xs text-muted mt-4" open>
                <summary>技术详情</summary>
                {run.failureCode !== null && <div className="text-mono">失败代码：{run.failureCode}</div>}
                {run.failureMessage !== null && run.failureMessage !== undefined && <div>{run.failureMessage}</div>}
              </details>
            </CardBody>
          </Card>
        </div>
      )}

      {run.status === "CANCELLED" && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">已取消</div>
          </div>
          <Card>
            <CardBody>
              <InlineNotice tone="neutral" title="Run 已取消">
                用户主动取消了本次执行，未生成模型。可随时发起新的 Run。
              </InlineNotice>
            </CardBody>
          </Card>
        </div>
      )}

      {stageRows.length > 0 && terminal && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">执行阶段</div>
          </div>
          <Card>
            <CardBody>
              <div className="run-detail-stage-list">
                {stageRows.map((stage) => (
                  <div className={`run-detail-stage ${stage.state}`} key={stage.index}>
                    <span className="run-detail-stage-num">{stage.index}</span>
                    <span className="run-detail-stage-label">{stage.label}</span>
                    {stage.activity !== null && (
                      <span className="run-detail-stage-activity">{stage.activity}</span>
                    )}
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {detail.events.length > 0 && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">事件流</div>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>结构化事件</CardTitle>
            </CardHeader>
            <CardBody>
              <div className="run-detail-stage-list">
                {detail.events.map((event) => (
                  <div className="run-detail-stage" key={event.sequence}>
                    <span className="run-detail-stage-num">{event.sequence}</span>
                    <span className="run-detail-stage-label">
                      {runEventTypeLabel(event.type)}{" "}
                      <span className="text-xs text-muted text-mono">{event.type}</span>
                    </span>
                    <span className="run-detail-stage-activity">{formatRelativeTime(event.occurredAt, now)}</span>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {deleteRunOpen && (
        <DeleteRunDialog
          repository={deleteRunRepository}
          run={run}
          onCancel={() => setDeleteRunOpen(false)}
          onDeleted={() => {
            setDeleteRunOpen(false);
            setVersion((value) => value + 1);
            window.location.hash = "#/runs";
          }}
        />
      )}
    </div>
  );
}

export default RunDetailPage;
