/**
 * `Drawing` is the long-lived root business object. A Drawing is identified by
 * its drawing number and owns every Drawing Revision, Modeling Run, Model and
 * Cost Estimate Report. The current business version is expressed by the
 * `current_revision_id` pointer; Drawings have no ACTIVE/ARCHIVED state machine.
 */
export interface Drawing {
  id: string;
  /** Company drawing number, e.g. PDJF480.01.17C-4 */
  drawingNumber: string;
  /** Display name, e.g. 轧辊（二） */
  name: string;
  /** Pointer to the current Drawing Revision, or null when no revision exists yet. */
  currentRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function isCurrentRevision(drawing: Drawing, revisionId: string): boolean {
  return drawing.currentRevisionId === revisionId;
}
