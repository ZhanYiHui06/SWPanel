import { ChevronRightIcon } from "@swpanel/ui";
import { Link } from "react-router-dom";

import { formatRelativeTime } from "../format.js";
import { RunStatusBadge } from "./RunStatusBadge.js";

export type RunTimelineDotState = "completed" | "running" | "warning" | "failed" | "cancelled";

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
  readonly now?: Date;
}

/**
 * Adapts a contract `RunListItemView` (plus an optional failure message from the
 * underlying run) into a display `RunTimelineItem`.
 */
export function toRunTimelineItem(input: RunTimelineItemInput): RunTimelineItem {
  let body = "用户主动取消";
  if (input.status === "COMPLETED" && input.modelId !== null) {
    const modelLabel = input.modelId.replace(/^model-/, "").toUpperCase();
    body = `生成模型 ${modelLabel}`;
  } else if (input.status === "COMPLETED") {
    // Phase 3 truthfulness: a Run may complete without publishing a Model.
    body = "已完成（未生成模型）";
  } else if (input.status === "CLARIFICATION_REQUIRED") {
    body = input.clarificationRequestId !== null ? "问题待确认" : "需要补充信息";
  } else if (input.status === "FAILED") {
    body = input.failureMessage ?? "执行失败";
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
    timeLabel: formatRelativeTime(input.createdAt, input.now)
  };
}
