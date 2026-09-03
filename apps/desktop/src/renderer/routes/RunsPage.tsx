import { Button, Card, CardBody, DataTable, FilterTabs, InlineNotice, type DataTableColumn } from "@swpanel/ui";
import { Link, Navigate, useNavigate } from "react-router-dom";

import { useMemo, useRef, useState } from "react";

import type { RunListItemView } from "@swpanel/contracts";

import { useRepository } from "../features/repository-provider.js";
import { useDrawingRepository } from "../features/bridge-repository/drawing-repository-provider.js";
import { useRunEventStream, useRunInvalidate, useRunQuery, useRunRepository } from "../features/run-repository/run-repository-provider.js";
import { useRunIdentity } from "../features/run-repository/run-display.js";
import { LiveCurrentRunCard } from "../features/run-repository/run-current-card.js";
import { toRunRepositoryError } from "../features/run-repository/run-repository.js";
import { cancelOutcomeNotice, type CancelNotice } from "../features/runs/cancel-outcome.js";
import { formatRelativeTime } from "../features/format.js";
import { revisionLabelOrId } from "../features/ids.js";
import { RunStatusBadge } from "../features/runs/RunStatusBadge.js";
import { RunProgressCard } from "../features/runs/RunProgressCard.js";
import { QueryErrorState, QueryLoadingState } from "../features/drawing/DrawingQueryStates.js";

export interface RunsPageProps {
  readonly now?: Date;
}

interface HistoryRow {
  readonly runId: string;
  readonly runLabel: string;
  readonly drawingNumber: string;
  readonly drawingName: string;
  readonly revisionLabel: string;
  readonly status: string;
  readonly result: string;
  readonly timeLabel: string;
}

type HistoryFilter = "ALL" | "COMPLETED" | "CLARIFICATION_REQUIRED" | "FAILED" | "CANCELLED" | "RUNNING" | "QUEUED";

const HISTORY_FILTERS: readonly { value: HistoryFilter; label: string }[] = [
  { value: "ALL", label: "全部" },
  { value: "COMPLETED", label: "已完成" },
  { value: "CLARIFICATION_REQUIRED", label: "需补充" },
  { value: "FAILED", label: "失败" },
  { value: "CANCELLED", label: "已取消" }
];

function modelLabelFromId(modelId: string | null | undefined): string | null {
  if (modelId === null || modelId === undefined) return null;
  return modelId.replace(/^model-/, "").toUpperCase();
}

// ---------------------------------------------------------------------------
// Product-runtime (bridge / unavailable) implementation
// ---------------------------------------------------------------------------

/** Fetches the failure message of one Run through the cached run query. */
function useRunFailureMessage(runId: string): string | null {
  const runRepository = useRunRepository();
  const detailQuery = useRunQuery(`run:detail:${runId}`, () => runRepository.getRunDetail(runId));
  return detailQuery.data?.run.failureMessage ?? null;
}

/** One QUEUED queue row with cancel (works while another Run runs). */
function QueueRunRow({
  run,
  now,
  cancelling,
  onCancel
}: {
  readonly run: RunListItemView;
  readonly now: Date;
  readonly cancelling?: boolean;
  readonly onCancel?: () => void;
}): React.JSX.Element {
  const runRepository = useRunRepository();
  const detailQuery = useRunQuery(`run:detail:${run.runId}`, () => runRepository.getRunDetail(run.runId));
  const detailRun = detailQuery.data?.run;
  const identity = useRunIdentity(detailRun?.drawingId ?? "", detailRun?.revisionId ?? "");
  return (
    <div className="queue-item" key={run.runId}>
      <div className="queue-item-main">
        <div className="queue-item-number">
          {identity.drawingNumber} · {identity.revisionLabel} · {run.runLabel}
        </div>
        <div className="queue-item-sub">{identity.drawingName}</div>
        <div className="queue-item-sub">{formatRelativeTime(run.createdAt, now)} 创建</div>
      </div>
      <div className="flex-row-gap-3">
        <RunStatusBadge status={run.status} size="sm" />
        <Button variant="ghost-muted" size="sm" {...(onCancel === undefined ? {} : { onClick: onCancel })} {...(cancelling === true ? { disabled: true } : {})}>
          {cancelling === true ? "正在取消…" : "取消"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Lightweight status watcher for QUEUED runs: subscribes the run's event
 * stream purely so status transitions (start / cancel / terminal) invalidate
 * `runs:list` and the queue/current/history views stay truthful even though
 * the run is not the visible current run yet.
 */
function RunStatusWatcher({ runId }: { readonly runId: string }): null {
  useRunEventStream(runId);
  return null;
}

/** The 结果 cell of one history row (failure details come from the run detail). */
function HistoryResultCell({ run }: { readonly run: RunListItemView }): React.JSX.Element {
  const failureMessage = useRunFailureMessage(run.runId);
  let result = "—";
  if (run.status === "COMPLETED") {
    const label = modelLabelFromId(run.modelId);
    result = label !== null ? `生成模型 ${label}` : "已完成（未生成模型）";
  } else if (run.status === "CLARIFICATION_REQUIRED") {
    result = "需要补充信息";
  } else if (run.status === "FAILED") {
    result = failureMessage ?? run.failureCode ?? "执行失败";
  } else if (run.status === "CANCELLED") {
    result = "用户主动取消";
  } else if (run.status === "RUNNING") {
    result = "执行中";
  } else if (run.status === "QUEUED") {
    result = "等待执行";
  }
  return run.status === "COMPLETED" || run.status === "CLARIFICATION_REQUIRED" ? (
    <span>{result}</span>
  ) : (
    <span className="col-result-muted">{result}</span>
  );
}

/** Product runtime (bridge / unavailable): real async data, never fixtures. */
function ProductRunsPage({ now }: { readonly now: Date }): React.JSX.Element {
  const runRepository = useRunRepository();
  const invalidateRuns = useRunInvalidate();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<HistoryFilter>("ALL");
  const [cancelling, setCancelling] = useState<Readonly<Record<string, boolean>>>({});
  const [notices, setNotices] = useState<readonly CancelNotice[]>([]);
  const nextNoticeId = useRef(1);

  const listQuery = useRunQuery("runs:list", () => runRepository.listRuns());

  const runs = listQuery.data ?? [];

  const currentRun = useMemo(
    () => [...runs].filter((run) => run.status === "RUNNING").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null,
    [runs]
  );
  const queuedRuns = useMemo(
    () => [...runs].filter((run) => run.status === "QUEUED").sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [runs]
  );
  const historyRows: HistoryRow[] = runs.map((run) => ({
    runId: run.runId,
    runLabel: run.runLabel,
    drawingNumber: run.runId,
    drawingName: "",
    revisionLabel: "",
    status: run.status,
    result: "",
    timeLabel: formatRelativeTime(run.createdAt, now)
  }));

  const filteredRows = filter === "ALL" ? historyRows : historyRows.filter((row) => row.status === filter);

  const columns: DataTableColumn[] = [
    { key: "run", header: "Run", width: "12%", cellClass: "mono" },
    { key: "drawing", header: "图号", width: "24%", cellClass: "mono" },
    { key: "version", header: "版本", width: "8%", cellClass: "version" },
    { key: "status", header: "状态", width: "14%" },
    { key: "result", header: "结果", width: "26%", cellClass: "result" },
    { key: "time", header: "时间", width: "16%", cellClass: "date" }
  ];

  const tableRows = filteredRows.map((row) => ({
    run: row.runLabel,
    drawing: <DrawingNumberCell runId={row.runId} fallback={row.drawingNumber} />,
    version: <RevisionLabelCell runId={row.runId} fallback={row.revisionLabel} />,
    status: <RunStatusBadge status={row.status} size="sm" />,
    result: <HistoryResultCell run={runs.find((run) => run.runId === row.runId) as RunListItemView} />,
    time: row.timeLabel,
    __runId: row.runId
  }));

  function openRun(row: Record<string, unknown>) {
    const runId = row.__runId as string;
    void navigate(`/runs/${runId}`);
  }

  async function handleCancel(run: RunListItemView): Promise<void> {
    if (cancelling[run.runId] === true) return; // duplicate submit guard
    setCancelling((current) => ({ ...current, [run.runId]: true }));
    try {
      const outcome = await runRepository.cancelRun({ runId: run.runId, reason: "用户主动取消" });
      setNotices((current) => [...current, cancelOutcomeNotice(outcome, run.runLabel, nextNoticeId.current++)]);
      if (outcome.status === "CANCELLED") invalidateRuns();
    } catch (error) {
      const structured = toRunRepositoryError(error);
      setNotices((current) => [
        ...current,
        {
          id: nextNoticeId.current++,
          tone: "error",
          title: `Run ${run.runLabel} 取消失败`,
          text: `${structured.code}: ${structured.message}`
        }
      ]);
    } finally {
      setCancelling((current) => ({ ...current, [run.runId]: false }));
    }
  }

  const shell = (children: React.ReactNode): React.JSX.Element => (
    <div className="page-content" data-route-id="runs">
      <div className="section section-tight">
        <h1 className="page-header-title">建模任务</h1>
        <p className="text-muted text-sm">全局建模任务监控</p>
      </div>
      {notices.map((notice) => (
        <InlineNotice key={notice.id} tone={notice.tone} title={notice.title} className="mb-4">
          {notice.text}
        </InlineNotice>
      ))}
      {children}
    </div>
  );

  if (listQuery.status === "loading" || (listQuery.status === "idle" && runs.length === 0)) {
    return shell(<QueryLoadingState label="正在加载建模任务…" />);
  }

  if (listQuery.status === "error") {
    return shell(
      <QueryErrorState
        title="建模任务加载失败"
        error={listQuery.error}
        onRetry={() => listQuery.retry()}
      />
    );
  }

  return shell(
    <>
      <div className="section">
        <div className="section-header">
          <div className="section-title">当前执行任务</div>
        </div>
        {currentRun === null ? (
          <Card>
            <CardBody>
              <p className="text-sm text-muted">当前没有正在执行的建模任务。</p>
              <p className="text-sm text-muted mt-2">
                从图纸库打开图纸，在概览页选择版本后点击「开始自动建模」即可创建任务。
              </p>
            </CardBody>
          </Card>
        ) : (
          <LiveCurrentRunCard
            run={currentRun}
            now={now}
            onCancel={() => void handleCancel(currentRun)}
            cancelling={cancelling[currentRun.runId] === true}
          />
        )}
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">等待队列</div>
          <Link to="/drawings" className="action-link">
            从图纸库开始建模
          </Link>
        </div>
        <Card>
          <CardBody>
            {queuedRuns.length === 0 ? (
              <p className="text-sm text-muted">当前没有等待执行的任务。</p>
            ) : (
              queuedRuns.map((run) => (
                <div key={run.runId}>
                  <RunStatusWatcher runId={run.runId} />
                  <QueueRunRow
                    run={run}
                    now={now}
                    cancelling={cancelling[run.runId] === true}
                    onCancel={() => void handleCancel(run)}
                  />
                </div>
              ))
            )}
          </CardBody>
        </Card>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">历史任务</div>
          <FilterTabs
            label="按状态筛选历史任务"
            options={HISTORY_FILTERS}
            value={filter}
            onChange={(value) => setFilter(value)}
          />
        </div>
        {historyRows.length === 0 ? (
          <Card>
            <CardBody>
              <p className="text-sm text-muted">暂无建模任务记录。</p>
            </CardBody>
          </Card>
        ) : (
          <DataTable
            label="历史建模任务"
            columns={columns}
            rows={tableRows}
            keyColumn="__runId"
            rowClick={openRun}
          />
        )}
      </div>
    </>
  );
}

function DrawingNumberCell({ runId, fallback }: { readonly runId: string; readonly fallback: string }): React.JSX.Element {
  const runRepository = useRunRepository();
  const detailQuery = useRunQuery(`run:detail:${runId}`, () => runRepository.getRunDetail(runId));
  const detail = detailQuery.data;
  const drawingId = detail?.run.drawingId ?? null;
  if (drawingId === null) return <span className="mono">{fallback}</span>;
  return <DrawingNumberInner drawingId={drawingId} revisionId={detail?.run.revisionId ?? ""} />;
}

function DrawingNumberInner({
  drawingId,
  revisionId
}: {
  readonly drawingId: string;
  readonly revisionId: string;
}): React.JSX.Element {
  const identity = useRunIdentity(drawingId, revisionId);
  return <span className="mono">{identity.drawingNumber}</span>;
}

function RevisionLabelCell({ runId, fallback }: { readonly runId: string; readonly fallback: string }): React.JSX.Element {
  const runRepository = useRunRepository();
  const detailQuery = useRunQuery(`run:detail:${runId}`, () => runRepository.getRunDetail(runId));
  const detail = detailQuery.data;
  if (detail === undefined) return <span className="version">{fallback}</span>;
  return <RevisionLabelInner drawingId={detail.run.drawingId} revisionId={detail.run.revisionId} />;
}

function RevisionLabelInner({
  drawingId,
  revisionId
}: {
  readonly drawingId: string;
  readonly revisionId: string;
}): React.JSX.Element {
  const identity = useRunIdentity(drawingId, revisionId);
  return <span className="version">{identity.revisionLabel}</span>;
}

/**
 * Global 建模任务 monitor (`/runs`). Shows the current RUNNING run with its
 * six-stage progress, the waiting QUEUED queue (with cancel actions) and the
 * cross-drawing history table with status filters, matching
 * `.design/pages/runs.html`.
 *
 * Mock runtime: deterministic Phase 1 fixture UI (sync). Product runtime
 * (real bridge / no bridge): real async data over the RunRepository with
 * loading/error/retry, live events and structured cancel outcomes.
 */
export function RunsPage({ now = new Date() }: RunsPageProps): React.JSX.Element {
  const repository = useRepository();
  const drawingRepository = useDrawingRepository();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<HistoryFilter>("ALL");
  const [dataVersion, setDataVersion] = useState(0);

  const { currentRun, queuedRuns, historyRows } = useMemo(() => {
    if (drawingRepository.mode !== "mock") {
      return { currentRun: null, queuedRuns: [], historyRows: [] };
    }
    const runs = repository.listRuns();
    const running = [...runs]
      .filter((run) => run.status === "RUNNING")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const runningEntry = running ?? null;

    const currentRunView =
      runningEntry === null
        ? null
        : {
            runId: runningEntry.id,
            runLabel: runningEntry.number,
            drawingNumber: "",
            drawingName: "",
            revisionLabel: "",
            status: runningEntry.status,
            stage: runningEntry.stage,
            activity: repository.getRunDetail(runningEntry.id).run.activity,
            progressPercent: repository.getRunDetail(runningEntry.id).run.progressPercent,
            createdAt: runningEntry.createdAt
          };
    if (runningEntry !== null && currentRunView !== null) {
      const drawing = repository.getDrawing(runningEntry.drawingId);
      currentRunView.drawingNumber = drawing?.drawingNumber ?? runningEntry.drawingId;
      currentRunView.drawingName = drawing?.name ?? "";
      currentRunView.revisionLabel = revisionLabelOrId(repository, runningEntry.revisionId);
    }

    const queued = runs
      .filter((run) => run.status === "QUEUED")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const rows: HistoryRow[] = runs.map((run) => {
      const drawing = repository.getDrawing(run.drawingId);
      const detail = repository.getRunDetail(run.id);
      let result = "—";
      if (run.status === "COMPLETED") {
        const label = modelLabelFromId(run.modelId);
        result = label !== null ? `生成模型 ${label}` : "已完成";
      } else if (run.status === "CLARIFICATION_REQUIRED") {
        const clarificationId = run.clarificationRequestId;
        const request = clarificationId !== undefined
          ? repository.getClarificationRequest(clarificationId)
          : undefined;
        result = `${request?.questions.length ?? 0} 个问题待确认`;
      } else if (run.status === "FAILED") {
        result = detail.run.failureMessage ?? detail.run.failureCode ?? "执行失败";
      } else if (run.status === "CANCELLED") {
        result = "用户主动取消";
      } else if (run.status === "RUNNING") {
        result = detail.run.activity ?? "执行中";
      } else if (run.status === "QUEUED") {
        result = "等待执行";
      }
      return {
        runId: run.id,
        runLabel: run.number,
        drawingNumber: drawing?.drawingNumber ?? run.drawingId,
        drawingName: drawing?.name ?? "",
        revisionLabel: revisionLabelOrId(repository, run.revisionId),
        status: run.status,
        result,
        timeLabel: formatRelativeTime(run.createdAt, now)
      };
    });

    const sorted = rows.sort((a, b) => {
      const runIndex = (runId: string) => runs.findIndex((run) => run.id === runId);
      return runIndex(b.runId) - runIndex(a.runId);
    });

    return { currentRun: currentRunView, queuedRuns: queued, historyRows: sorted };
  }, [repository, now, dataVersion, drawingRepository.mode]);

  // Product runtime: real async data over the RunRepository.
  if (drawingRepository.mode !== "mock") {
    return <ProductRunsPage now={now} />;
  }

  const filteredRows = useMemo(
    () => (filter === "ALL" ? historyRows : historyRows.filter((row) => row.status === filter)),
    [historyRows, filter]
  );

  const columns: DataTableColumn[] = [
    { key: "run", header: "Run", width: "12%", cellClass: "mono" },
    { key: "drawing", header: "图号", width: "24%", cellClass: "mono" },
    { key: "version", header: "版本", width: "8%", cellClass: "version" },
    { key: "status", header: "状态", width: "14%" },
    { key: "result", header: "结果", width: "26%", cellClass: "result" },
    { key: "time", header: "时间", width: "16%", cellClass: "date" }
  ];

  const tableRows = filteredRows.map((row) => ({
    run: row.runLabel,
    drawing: row.drawingNumber,
    version: row.revisionLabel,
    status: <RunStatusBadge status={row.status} size="sm" />,
    result: row.status === "COMPLETED" || row.status === "CLARIFICATION_REQUIRED" ? row.result : (
      <span className="col-result-muted">{row.result}</span>
    ),
    time: row.timeLabel,
    __runId: row.runId
  }));

  function openRun(row: Record<string, unknown>) {
    const runId = row.__runId as string;
    void navigate(`/runs/${runId}`);
  }

  function cancelQueued(runId: string) {
    repository.cancelRun(runId, "用户主动取消");
    setDataVersion((value) => value + 1);
  }

  if (currentRun === null) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="page-content" data-route-id="runs">
      <div className="section section-tight">
        <h1 className="page-header-title">建模任务</h1>
        <p className="text-muted text-sm">全局建模任务监控</p>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">当前执行任务</div>
        </div>
        <RunProgressCard
          run={currentRun}
          now={now}
          onCancel={() => {
            repository.cancelRun(currentRun.runId, "用户主动取消");
            setDataVersion((value) => value + 1);
          }}
        />
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">等待队列</div>
        </div>
        <Card>
          <CardBody>
            {queuedRuns.length === 0 ? (
              <p className="text-sm text-muted">当前没有等待执行的任务。</p>
            ) : (
              queuedRuns.map((run) => {
                const drawing = repository.getDrawing(run.drawingId);
                return (
                  <div className="queue-item" key={run.id}>
                    <div className="queue-item-main">
                      <div className="queue-item-number">
                        {drawing?.drawingNumber ?? run.drawingId} · {revisionLabelOrId(repository, run.revisionId)} · {run.number}
                      </div>
                      <div className="queue-item-sub">{drawing?.name ?? ""}</div>
                    </div>
                    <div className="flex-row-gap-3">
                      <RunStatusBadge status={run.status} size="sm" />
                      <Button variant="ghost-muted" size="sm" onClick={() => cancelQueued(run.id)}>
                        取消
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </CardBody>
        </Card>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">历史任务</div>
          <FilterTabs
            label="按状态筛选历史任务"
            options={HISTORY_FILTERS}
            value={filter}
            onChange={(value) => setFilter(value)}
          />
        </div>
        <DataTable
          label="历史建模任务"
          columns={columns}
          rows={tableRows}
          keyColumn="__runId"
          rowClick={openRun}
        />
      </div>
    </div>
  );
}

export default RunsPage;
