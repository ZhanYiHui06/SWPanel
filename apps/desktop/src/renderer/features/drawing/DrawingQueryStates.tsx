/**
 * Shared accessible loading / error panels for the Drawing-management pages.
 * Both render inside the page's `data-route-id` container so route assertions
 * and screenshots stay deterministic across states.
 */

import { Button, InlineNotice } from "@swpanel/ui";
import type { DrawingRepositoryError } from "../bridge-repository/drawing-repository.js";
import type { ReactNode } from "react";

import { describeError } from "../error-messages.js";

export interface QueryLoadingStateProps {
  /** Accessible label of what is being loaded. */
  readonly label: string;
}

export function QueryLoadingState({ label }: QueryLoadingStateProps): React.JSX.Element {
  return (
    <div className="data-sheet" role="status" aria-live="polite">
      <div className="empty-state">
        <div className="empty-state-title">{label}</div>
        <div className="empty-state-desc">正在从服务读取数据，请稍候…</div>
      </div>
    </div>
  );
}

export interface QueryErrorStateProps {
  readonly title: string;
  readonly error: DrawingRepositoryError | null;
  readonly onRetry: () => void;
  /** Optional secondary action (e.g. 返回图纸库 link). */
  readonly action?: ReactNode;
}

export function QueryErrorState({ title, error, onRetry, action }: QueryErrorStateProps): React.JSX.Element {
  const described = error === null ? null : describeError(error);
  // Original server text stays available as secondary "technical details".
  const rawMessage = error?.message ?? "";
  const showDetails = error !== null && (described?.code !== undefined || rawMessage.length > 0);
  return (
    <div className="data-sheet">
      <InlineNotice tone="error" title={title} role="alert">
        {described?.message ?? "未知错误，请重试"}
        {showDetails && (
          <details className="text-xs text-muted mt-2">
            <summary>技术详情</summary>
            {error.code !== undefined && <span className="text-mono" data-error-code={error.code}>{error.code}</span>}
            {error.code !== undefined && rawMessage.length > 0 ? "：" : ""}
            {rawMessage}
          </details>
        )}
      </InlineNotice>
      <div className="flex-row-gap-3 mt-4" style={{ justifyContent: "flex-start" }}>
        <Button variant="secondary" size="sm" onClick={onRetry}>重试</Button>
        {action}
      </div>
    </div>
  );
}
