import { Button } from "@swpanel/ui";
import { Link } from "react-router-dom";

import { canCancelRun, RUN_STAGE_LABELS, type RunStatus } from "@swpanel/domain";

import { formatRelativeTime } from "../format.js";
import { stageIndex } from "../status.js";
import { RunStatusBadge } from "./RunStatusBadge.js";
import { StageProgress } from "./StageProgress.js";

export interface RunProgressCardProps {
  readonly run: {
    readonly runId: string;
    readonly runLabel: string;
    readonly drawingNumber: string;
    readonly drawingName: string;
    readonly revisionLabel: string;
    readonly status: string;
    readonly stage: string | null;
    readonly activity: string | null;
    readonly progressPercent: number | null;
    readonly createdAt: string;
  };
  readonly now?: Date;
  /** Optional cancel action (async or sync); disables the button while truthy. */
  readonly onCancel?: () => void;
  readonly cancelling?: boolean;
}

/**
 * The active-task card (`.run-card`) shown at the top of the global 建模任务
 * page for the current RUNNING run. Renders the six-stage progress, the linear
 * progress bar, live activity text and a cancel action when the run is still
 * cancellable. Runtime-agnostic: the caller supplies the display data and the
 * optional cancel handler (MockRepository in mock mode, async RunRepository in
 * the bridge runtime).
 */
export function RunProgressCard({
  run,
  now,
  onCancel,
  cancelling = false
}: RunProgressCardProps): React.JSX.Element {
  const progress = run.progressPercent ?? 0;
  const reached = stageIndex(run.stage);
  const live = run.status === "RUNNING";
  const showCancel = canCancelRun(run.status as RunStatus) && onCancel !== undefined;

  return (
    <div className="run-card">
      <div className="run-card-header">
        <div className="run-card-title-group">
          <div className="flex-row-gap-3">
            <span className="run-card-drawing">{run.drawingNumber}</span>
            <RunStatusBadge status={run.status} />
          </div>
          <div className="run-card-partname">{run.drawingName}</div>
          <div className="run-card-meta mt-2">
            <span>{run.revisionLabel}</span>
            <span className="run-card-meta-sep" aria-hidden="true" />
            <span>Run {run.runLabel}</span>
            <span className="run-card-meta-sep" aria-hidden="true" />
            <span>{formatRelativeTime(run.createdAt, now)} 启动</span>
          </div>
        </div>
        <div className="action-row">
          <Link to={`/runs/${run.runId}`} className="btn btn-secondary btn-sm">
            查看任务
          </Link>
          {showCancel && (
            <Button
              variant="ghost-muted"
              size="sm"
              {...(onCancel === undefined ? {} : { onClick: onCancel })}
              {...(cancelling ? { disabled: true } : {})}
            >
              {cancelling ? "正在取消…" : "取消"}
            </Button>
          )}
        </div>
      </div>

      {live && reached >= 0 && (
        <>
          <div className="run-card-status-line">
            <span className="run-card-stage-label">
              {RUN_STAGE_LABELS[run.stage as keyof typeof RUN_STAGE_LABELS]}
            </span>
            <span className="run-card-progress-pct">{progress}%</span>
          </div>
          <div className="progress-bar" role="progressbar" aria-label="当前任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
          </div>
          {run.activity !== null && <div className="run-card-activity">{run.activity}</div>}
        </>
      )}

      <StageProgress stage={run.stage} live={live} />
    </div>
  );
}
