/**
 * Shared product-mode current-RUNNING-run card (Batch P3-5).
 *
 * Combines the live event stream (`useRunEventStream`) with the canonical
 * `RunProgressCard`: stage/activity/progress update from applied live events,
 * a visible reconnect notice while the stream recovers, and an error state
 * with retry. Used by the global 建模任务 page and the Workbench.
 */

import { Button, InlineNotice } from "@swpanel/ui";

import type { RunListItemView } from "@swpanel/contracts";

import { describeError } from "../error-messages.js";
import { useRunEventStream } from "./run-repository-provider.js";
import { useRunIdentity } from "./run-display.js";
import { RunProgressCard } from "../runs/RunProgressCard.js";

export interface LiveCurrentRunCardProps {
  readonly run: RunListItemView;
  readonly now: Date;
  /** Optional cancel action (async); disables the button while truthy. */
  readonly onCancel?: () => void;
  readonly cancelling?: boolean;
}

/** The current RUNNING run card with live events and cancel. */
export function LiveCurrentRunCard({
  run,
  now,
  onCancel,
  cancelling = false
}: LiveCurrentRunCardProps): React.JSX.Element {
  const stream = useRunEventStream(run.runId);
  const detailRun = stream.detail?.run;
  const identity = useRunIdentity(detailRun?.drawingId ?? "", detailRun?.revisionId ?? "");
  const status = detailRun?.status ?? run.status;
  const stage = detailRun?.stage ?? run.stage;
  const activity = detailRun?.activity ?? null;
  const progressPercent = detailRun?.progressPercent ?? null;

  return (
    <div>
      {stream.status === "recovering" && (
        <InlineNotice tone="warning" className="mb-4" title="连接中断，正在重新连接…" role="status">
          与执行服务的事件连接中断，正在重新同步进度…
        </InlineNotice>
      )}
      {stream.status === "error" && (
        <InlineNotice tone="error" className="mb-4" title="连接中断，未能重新连接" role="alert">
          {describeError(stream.error).message}
          <div className="mt-4">
            <Button variant="secondary" size="sm" onClick={() => stream.retry()}>
              重试
            </Button>
          </div>
        </InlineNotice>
      )}
      {stream.detail === null ? (
        <div className="run-card">
          <p className="text-sm text-muted" role="status">
            正在加载任务进度…
          </p>
        </div>
      ) : (
        <RunProgressCard
          run={{
            runId: run.runId,
            runLabel: run.runLabel,
            drawingNumber: identity.drawingNumber,
            drawingName: identity.drawingName,
            revisionLabel: identity.revisionLabel,
            status,
            stage,
            activity,
            progressPercent,
            createdAt: run.createdAt
          }}
          now={now}
          {...(onCancel === undefined ? {} : { onCancel })}
          {...(cancelling ? { cancelling } : {})}
        />
      )}
    </div>
  );
}
