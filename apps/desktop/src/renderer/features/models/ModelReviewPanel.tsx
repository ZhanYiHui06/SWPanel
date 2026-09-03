import { Button, Textarea } from "@swpanel/ui";
import { useState } from "react";

import type { ModelDetailView } from "@swpanel/contracts";

import { formatRelativeTime } from "../format.js";
import { modelStatusLabel } from "../status.js";

export const MODEL_REVIEWER_ID = "current-windows-user";

/** One APPROVE / REJECT submission as sent to the ModelRepository. */
export interface ModelReviewSubmitInput {
  readonly modelId: string;
  readonly result: "APPROVED" | "REJECTED";
  /** Required when `result` is REJECTED (written into the revision feedback). */
  readonly comment?: string;
  readonly reviewerId: string;
  readonly reviewedAt: string;
}

export interface ModelReviewPanelProps {
  readonly model: ModelDetailView["model"];
  /**
   * Applies the decision through the active ModelRepository (mock adapter or
   * the real bridge) and resolves the refreshed detail. The panel awaits it
   * before calling `onReviewed`, so callers may invalidate their cached
   * queries on success.
   */
  readonly reviewModel: (input: ModelReviewSubmitInput) => Promise<unknown>;
  readonly onReviewed?: () => void;
}

/** True when the thrown value carries a stable bridge/runner error code. */
function structuredMessage(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Approve / Reject panel for a PENDING_REVIEW model. Approve immediately
 * publishes the review and moves the revision's current-approved pointer.
 * Reject requires a non-empty reason: the panel blocks submission until one is
 * provided, and the repository also enforces the invariant
 * ("comment is required when rejecting a model").
 */
export function ModelReviewPanel({ model, reviewModel, onReviewed }: ModelReviewPanelProps): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (model.reviewStatus !== "PENDING_REVIEW") {
    return (
      <div className="inline-notice success">
        <div className="inline-notice-content">
          <div className="inline-notice-title">{modelStatusLabel(model.reviewStatus)}</div>
          <div className="inline-notice-text">
            {model.reviewStatus === "APPROVED"
              ? "该模型已通过人工审核，为当前正式模型。可用于生成成本测算报告。"
              : "该模型已退回，修订通过新建 Run 重新建模后再审核。"}
          </div>
        </div>
      </div>
    );
  }

  function openReject() {
    setRejecting(true);
    setError(null);
  }

  function cancelReject() {
    setRejecting(false);
    setError(null);
    setReason("");
  }

  async function approve() {
    if (busy) return; // duplicate submit guard
    setBusy(true);
    setError(null);
    try {
      await reviewModel({
        modelId: model.modelId,
        result: "APPROVED",
        reviewerId: MODEL_REVIEWER_ID,
        reviewedAt: new Date().toISOString()
      });
      onReviewed?.();
    } catch (caught) {
      setError(structuredMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    const trimmed = reason.trim();
    if (trimmed === "") {
      setError("退回原因不能为空，请填写退回理由。");
      return;
    }
    if (busy) return; // duplicate submit guard
    setBusy(true);
    setError(null);
    try {
      await reviewModel({
        modelId: model.modelId,
        result: "REJECTED",
        reviewerId: MODEL_REVIEWER_ID,
        reviewedAt: new Date().toISOString(),
        comment: trimmed
      });
      onReviewed?.();
    } catch (caught) {
      setError(structuredMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="review-panel" data-model-status="pending-review">
      {!rejecting ? (
        <>
          <div className="review-panel-title">审核模型</div>
          <p className="text-sm text-muted">审核通过后该模型成为当前正式模型；退回需要填写原因，且不可恢复。</p>
          <div className="action-row mt-4">
            <Button variant="primary" size="sm" onClick={() => void approve()} disabled={busy}>
              审核通过
            </Button>
            <Button variant="ghost-muted" size="sm" onClick={openReject} disabled={busy}>
              退回
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="review-panel-title">退回原因</div>
          <p className="text-sm text-muted">
            退回将记录 Modeling Feedback，原模型不可恢复。请说明需要修正的具体问题。
          </p>
          <div className="mt-4">
            <Textarea
              placeholder="例如：右侧台阶直径错误，应为 Ø120；同时遗漏图纸中的 R5 圆角。"
              value={reason}
              onValueChange={(value) => {
                setReason(value);
                setError(null);
              }}
              invalid={error !== null}
              textareaProps={{ "aria-label": "退回原因" }}
            />
            {error !== null && (
              <p className="form-hint form-hint-error mt-2" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="action-row mt-4">
            <Button variant="ghost-muted" size="sm" onClick={cancelReject} disabled={busy}>
              取消
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void reject()} disabled={busy}>
              确认退回
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** Renders the review record history for an already-reviewed model. */
export function ModelReviewHistory({ reviews }: { reviews: readonly ModelDetailView["reviews"][number][] }): React.JSX.Element | null {
  if (reviews.length === 0) return null;
  return (
    <div className="mt-6">
      {reviews.map((review) => (
        <div className="inline-notice mt-2" key={review.reviewId}>
          <div className="inline-notice-content">
            <div className="inline-notice-title">
              {review.result === "APPROVED" ? "审核通过" : "已退回"} · {formatRelativeTime(review.createdAt)}
            </div>
            {review.comment !== null && <div className="inline-notice-text">退回原因：{review.comment}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}