import type { DrawingRevision, ModelingRun } from "@swpanel/domain";

import type { MockRepository } from "../mock-repository/mock-repository.js";

/**
 * Creates a new Modeling Run for a revision using the repository's canonical
 * `run.create` path. The caller submits only the drawing/revision identity
 * pair; the repository (standing in for the Runner) freezes the execution
 * input from its own memory at the creation moment — the snapshot is never
 * forged or supplied by the renderer.
 */
export function createRunForRevision(
  repository: MockRepository,
  revision: DrawingRevision
): ModelingRun {
  return repository.createRun({
    drawingId: revision.drawingId,
    revisionId: revision.id
  });
}
