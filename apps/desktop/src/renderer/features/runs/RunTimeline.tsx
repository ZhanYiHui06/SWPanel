import { ChevronRightIcon } from "@swpanel/ui";
import { Link } from "react-router-dom";

import { formatRelativeTime } from "../format.js";
import { runFailureSummary } from "./failure-presentation.js";
import { RunStatusBadge } from "./RunStatusBadge.js";

export type RunTimelineDotState = "completed" | "running" | "warning" | "failed" | "cancelled" | "queued";

function dotState(status: string): RunTimelineDotState {
  switch (status) {
    case "RUNNING":
      return "running";
    case "CLARIFICATION_REQUIRED":
      return "warning";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    case "COMPLETED":
      return "completed";
    case "QUEUED":
      return "queued";
    default:
      return "running";
  }
}

export interface RunTimelineItem {
  readonly runId: string;
  readonly runLabel: string;
  readonly status: string;
  /** Detail hint shown under the header, e.g. "生成模型 M03". */
  readonly body: string;
  /** Secondary technical text (e.g. the original failure message). */
  readonly detail?: string;
  /** Secondary technical code (e.g. the failure code). */
  readonly detailCode?: string;
  readonly timeLabel: string;
  /** Detail link when the run has a detail page. */
  readonly detailHref?: string;
}

export interface RunTimelineProps {
  readonly items: readonly RunTimelineItem[];
  readonly emptyText?: string;
  readonly now?: Date;
}

/**
 * Vertical timeline of Modeling Runs (`.timeline`) with status-colored dots,
 * used by the Drawing Workspace · 建模记录 page.
 */
export function RunTimeline({ items, emptyText }: RunTimelineProps): React.JSX.Element {
  if (items.length === 0) {
    return <p className="text-sm text-muted">{emptyText ?? "暂无建模记录"}</p>;
  }

  return (
    <ol className="timeline" aria-label="建模记录时间线">
      {items.map((item) => (
        <li className="timeline-item" key={item.runId}>
          <span className={`timeline-item-dot ${dotState(item.status)}`} aria-hidden="true" />
          <div className="timeline-item-header">
            <span className="timeline-item-title">{item.runLabel}</span>
            <RunStatusBadge status={item.status} />
            <span className="timeline-item-time">{item.timeLabel}</span>
          </div>
          <div className="timeline-item-body">{item.body}</div>
          {(item.detailCode !== undefined || item.detail !== undefined) && (
            <div className="timeline-item-body text-xs text-muted">
              技术详情：
              {item.detailCode !== undefined && <span className="text-mono">{item.detailCode} </span>}
              {item.detail !== undefined && <span>{item.detail}</span>}
            </div>
          )}
          {item.detailHref !== undefined && (
            <div className="timeline-item-result">
              <Link to={item.detailHref} className="action-link">
                查看详情
                <ChevronRightIcon aria-hidden="true" />
              </Link>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

export interface RunTimelineItemInput {
  readonly runId: string;
  readonly runLabel: string;
  readonly status: string;
  readonly createdAt: string;
  readonly modelId: string | null;
  readonly clarificationRequestId: string | null;
  readonly failureMessage?: string | null;
  readonly failureCode?: string | null;
  /** Business label of the generated Model (e.g. "M03"); never a raw id. */
  readonly modelLabel?: string | null;
  readonly now?: Date;
}

/**
 * Adapts a contract `RunListItemView` (plus an optional failure message from the
 * underlying run) into a display `RunTimelineItem`.
 */
export function toRunTimelineItem(input: RunTimelineItemInput): RunTimelineItem {
  let body = "用户主动取消";
  let detail: string | undefined;
  let detailCode: string | undefined;
  if (input.status === "COMPLETED" && input.modelId !== null) {
    body = input.modelLabel !== undefined && input.modelLabel !== null ? `生成模型 ${input.modelLabel}` : "已生成模型";
  } else if (input.status === "COMPLETED") {
    // Phase 3 truthfulness: a Run may complete without publishing a Model.
    body = "已完成（未生成模型）";
  } else if (input.status === "CLARIFICATION_REQUIRED") {
    body = input.clarificationRequestId !== null ? "问题待确认" : "需要补充信息";
  } else if (input.status === "FAILED") {
    body = runFailureSummary(input.failureCode);
    if (typeof input.failureCode === "string" && input.failureCode.length > 0) detailCode = input.failureCode;
    if (typeof input.failureMessage === "string" && input.failureMessage.length > 0) detail = input.failureMessage;
  } else if (input.status === "RUNNING") {
    body = "执行中";
  } else if (input.status === "QUEUED") {
    body = "等待执行";
  }

  return {
    runId: input.runId,
    runLabel: input.runLabel,
    status: input.status,
    body,
    ...(detail === undefined ? {} : { detail }),
    ...(detailCode === undefined ? {} : { detailCode }),
    timeLabel: formatRelativeTime(input.createdAt, input.now)
  };
}
