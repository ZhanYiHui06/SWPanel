import { revisionLabel } from "@swpanel/domain";

import { DRAWING_IDS } from "../fixtures/index.js";
import type { MockRepository } from "./mock-repository/mock-repository.js";

/**
 * Friendly route segment -> fixture id aliases used by the canonical deep-link
 * sample URLs (e.g. `/drawings/drawing-main/revisions/revision-v3/...`).
 * The canonical route-manifest sample paths use human-readable segments while
 * the fixture world uses stable machine ids; every page resolves the URL
 * parameters through these helpers before touching the repository.
 */
const DRAWING_ALIASES: Readonly<Record<string, string>> = {
  "drawing-main": DRAWING_IDS.main,
  "drawing-a": DRAWING_IDS.a,
  "drawing-b": DRAWING_IDS.b,
  "drawing-c": DRAWING_IDS.c,
  "drawing-d": DRAWING_IDS.d
};

/**
 * Resolves a drawing route parameter to a fixture drawing id. Accepts the raw
 * fixture id, a `drawing-*` alias, or the drawing number itself.
 */
export function resolveDrawingId(repository: MockRepository, param: string | undefined): string | null {
  if (param === undefined || param === "") return null;
  if (repository.getDrawing(param) !== undefined) return param;
  const aliased = DRAWING_ALIASES[param];
  if (aliased !== undefined) return aliased;
  const byNumber = repository
    .listDrawings()
    .find((drawing) => drawing.drawingNumber === param || drawing.name === param);
  return byNumber?.id ?? null;
}

/**
 * Resolves a revision route parameter to a fixture revision id, scoped to the
 * resolved drawing. Accepts the raw fixture id or a `V{n}`-style label segment
 * (`revision-v3` / `V3` / `v3`).
 */
export function resolveRevisionId(
  repository: MockRepository,
  drawingId: string | null,
  param: string | undefined
): string | null {
  if (drawingId === null || param === undefined || param === "") return null;
  const direct = repository.getRevision(param);
  if (direct !== undefined) return direct.drawingId === drawingId ? direct.id : null;
  const label = param.replace(/^revision-/, "").toUpperCase();
  const revision = repository
    .listRevisions()
    .find((candidate) => revisionLabel(candidate.sequence) === label && candidate.drawingId === drawingId);
  return revision?.id ?? null;
}

/**
 * Resolves a model route parameter to a fixture model id, scoped to both URL
 * parents (`model-m03` / `M03` / raw id).
 */
export function resolveModelId(
  repository: MockRepository,
  drawingId: string | null,
  revisionId: string | null,
  param: string | undefined
): string | null {
  if (drawingId === null || revisionId === null || param === undefined || param === "") return null;
  const ownsRoute = (candidate: { drawingId: string; revisionId: string }) =>
    candidate.drawingId === drawingId && candidate.revisionId === revisionId;
  const direct = repository.getModel(param);
  if (direct !== undefined) return ownsRoute(direct) ? direct.id : null;
  const label = param.replace(/^model-/, "").toUpperCase();
  const model = repository
    .listModels()
    .find((candidate) => candidate.number === label && ownsRoute(candidate));
  return model?.id ?? null;
}

/** Resolves a run route parameter to a fixture run id (`run-r05` / `R05` / raw id). */
export function resolveRunId(
  repository: MockRepository,
  param: string | undefined
): string | null {
  if (param === undefined || param === "") return null;
  if (repository.getRun(param) !== undefined) return param;
  const label = param.replace(/^run-/, "").toUpperCase();
  const run = repository.listRuns().find((candidate) => candidate.number === label);
  return run?.id ?? null;
}

/** Resolves a cost report route parameter, scoped to both URL parents. */
export function resolveReportId(
  repository: MockRepository,
  drawingId: string | null,
  revisionId: string | null,
  param: string | undefined
): string | null {
  if (drawingId === null || revisionId === null || param === undefined || param === "") return null;
  const ownsRoute = (candidate: { drawingId: string; revisionId: string }) =>
    candidate.drawingId === drawingId && candidate.revisionId === revisionId;
  const direct = repository.listReports().find((candidate) => candidate.id === param);
  if (direct !== undefined) return ownsRoute(direct) ? direct.id : null;
  const label = param.replace(/^report-/, "").toUpperCase();
  const report = repository
    .listReports()
    .find((candidate) => candidate.label === label && ownsRoute(candidate));
  return report?.id ?? null;
}

/** Canonical revision label for a revision id (falls back to the raw id). */
export function revisionLabelOrId(repository: MockRepository, revisionId: string): string {
  const revision = repository.getRevision(revisionId);
  return revision === undefined ? revisionId : revisionLabel(revision.sequence);
}
