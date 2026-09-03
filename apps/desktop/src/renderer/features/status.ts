import type { BadgeVariant } from "@swpanel/ui";
import {
  CLARIFICATION_STATUS_LABELS,
  MODEL_REVIEW_STATUS_LABELS,
  RUN_STATUS_LABELS,
  RUN_STAGES,
  RUN_STAGE_LABELS
} from "@swpanel/domain";

/**
 * Shared status presentation mappings for the Modeling domain. Every badge and
 * label used by the run/model pages derives from the domain's canonical
 * vocabulary so the UI and the fixture world can never drift apart.
 */

// ── Run status ────────────────────────────────────────────────────────────

export const RUN_STATUS_BADGE: Readonly<Record<string, BadgeVariant>> = {
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  CLARIFICATION_REQUIRED: "clarification",
  FAILED: "failed",
  CANCELLED: "cancelled"
};

export function runStatusBadge(status: string): BadgeVariant {
  return RUN_STATUS_BADGE[status] ?? "no-model";
}

export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABELS[status as keyof typeof RUN_STATUS_LABELS] ?? status;
}

// ── Model review status ───────────────────────────────────────────────────

export const MODEL_STATUS_BADGE: Readonly<Record<string, BadgeVariant>> = {
  PENDING_REVIEW: "pending-review",
  APPROVED: "approved",
  REJECTED: "rejected"
};

export function modelStatusBadge(status: string): BadgeVariant {
  return MODEL_STATUS_BADGE[status] ?? "no-model";
}

export function modelStatusLabel(status: string): string {
  return MODEL_REVIEW_STATUS_LABELS[status as keyof typeof MODEL_REVIEW_STATUS_LABELS] ?? status;
}

// ── Clarification status ──────────────────────────────────────────────────

export function clarificationStatusLabel(status: string): string {
  return CLARIFICATION_STATUS_LABELS[status as keyof typeof CLARIFICATION_STATUS_LABELS] ?? status;
}

// ── Six execution stages ──────────────────────────────────────────────────

export interface StageDescriptor {
  readonly key: (typeof RUN_STAGES)[number];
  readonly label: string;
}

export const SIX_STAGES: readonly StageDescriptor[] = RUN_STAGES.map((stage) => ({
  key: stage,
  label: RUN_STAGE_LABELS[stage]
}));

/** 0-based index of a stage in the canonical six-stage list. */
export function stageIndex(stage: string | null | undefined): number {
  if (stage === null || stage === undefined) return -1;
  return RUN_STAGES.indexOf(stage as (typeof RUN_STAGES)[number]);
}
