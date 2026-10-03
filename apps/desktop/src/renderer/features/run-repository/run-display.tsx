/**
 * Shared product-mode Run page helpers (Batch P3-5).
 *
 * `useRunIdentity` resolves a Run's drawing number / drawing name / revision
 * label through the cached Drawing queries (`drawing:detail:<drawingId>`), so
 * Run pages render real display names for real Runner ids without per-row
 * repository plumbing. While the drawing detail is still loading the helper
 * falls back to the raw ids and reports `ready === false`.
 */

import { useDrawingQuery, useDrawingRepository } from "../bridge-repository/drawing-repository-provider.js";
import { useModelDetailQuery } from "../model-repository/model-repository-provider.js";

export interface RunIdentity {
  readonly ready: boolean;
  readonly drawingNumber: string;
  readonly drawingName: string;
  readonly revisionLabel: string;
}

/** Resolves display identity of one Run's drawing/revision pair (cached). */
export function useRunIdentity(drawingId: string, revisionId: string): RunIdentity {
  const drawingRepository = useDrawingRepository();
  const detailQuery = useDrawingQuery(`drawing:detail:${drawingId}`, () =>
    drawingRepository.getDrawingDetail(drawingId)
  );
  const detail = detailQuery.data;
  const revision = detail?.revisions.find((candidate) => candidate.revisionId === revisionId);
  return {
    ready: detail !== undefined,
    drawingNumber: detail?.drawing.drawingNumber ?? drawingId,
    drawingName: detail?.drawing.name ?? "",
    revisionLabel: revision?.revisionLabel ?? revisionId
  };
}

/**
 * Business label (e.g. "M03") of a published Model, resolved through the cached
 * Model detail query. Returns null while loading / unknown: callers must never
 * fall back to showing the raw id.
 */
export function useModelLabel(modelId: string | null | undefined): string | null {
  const query = useModelDetailQuery(modelId ?? null);
  return query.data?.model.modelLabel ?? null;
}
