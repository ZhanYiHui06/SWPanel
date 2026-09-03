/**
 * Shared accessible loading / error panels for the Drawing-management pages.
 * Both render inside the page's `data-route-id` container so route assertions
 * and screenshots stay deterministic across states.
 */

import { Button, InlineNotice } from "@swpanel/ui";
import type { DrawingRepositoryError } from "../bridge-repository/drawing-repository.js";
import type { ReactNode } from "react";

export interface QueryLoadingStateProps {
  /** Accessible label of what is being loaded. */
  readonly label: string;
}

export function QueryLoadingState({ label }: QueryLoadingStateProps): React.JSX.Element {
  return (
    <div className="data-sheet" role="status" aria-live="polite">
      <div className="empty-state">
        <div className="empty-state-title">{label}</div>
        <div className="empty-state-desc">正在与图纸处理服务（Runner）通信…</div>
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
  return (
    <div className="data-sheet">
      <InlineNotice tone="error" title={title}>
        {error !== null && <strong className="text-mono" data-error-code={error.code}>{error.code}: </strong>}
        {error?.message ?? "未知错误"}
      </InlineNotice>
      <div className="flex-row-gap-3 mt-4" style={{ justifyContent: "flex-start" }}>
        <Button variant="secondary" size="sm" onClick={onRetry}>重试</Button>
        {action}
      </div>
    </div>
  );
}
