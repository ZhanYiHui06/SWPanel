import { DomainInvariantError } from "../errors.js";

/**
 * Product-level drawing file formats accepted by SWPanel. The modeling Skill
 * itself consumes JPG/PNG; conversion to the Skill input is the Input Adapter's
 * responsibility and never replaces the original file.
 */
export const DRAWING_FILE_FORMATS = ["PDF", "DWG", "DXF"] as const;
export type DrawingFileFormat = (typeof DRAWING_FILE_FORMATS)[number];

/**
 * Metadata of the immutable original drawing file bound to a Revision.
 * The file bytes live on NTFS; only metadata is stored in the structured store.
 */
export interface RevisionSourceFile {
  id: string;
  fileName: string;
  format: DrawingFileFormat;
  sizeBytes: number;
  sha256: string;
  mimeType?: string;
  /** Stable relative path inside the Drawing/Revision library layout. */
  relativePath: string;
  uploadedAt: string;
}

/**
 * `Drawing Revision` is the exact work version used as the fixed input of a
 * Modeling Run. Each Revision owns an independent Revision Memory and its own
 * `current_approved_model_id` pointer. Revisions have no ACTIVE/ARCHIVED state.
 */
export interface DrawingRevision {
  id: string;
  drawingId: string;
  /** 1-based business ordinal (1, 2, 3, ...) displayed as V1, V2, V3. */
  sequence: number;
  sourceFile: RevisionSourceFile;
  /** Pointer to the current approved Model, or null when none exists yet. */
  currentApprovedModelId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Derives the user-visible version label, e.g. sequence 3 -> "V3". */
export function revisionLabel(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new DomainInvariantError(`Revision sequence must be a positive integer, got ${sequence}`);
  }
  return `V${sequence}`;
}

/** Computes the next revision sequence for a new Revision of a Drawing. */
export function nextRevisionSequence(revisions: readonly { sequence: number }[]): number {
  return revisions.reduce((max, revision) => Math.max(max, revision.sequence), 0) + 1;
}
