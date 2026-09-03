/**
 * Persisted storage configuration of the local drawing library and Run
 * workspaces. The active data root is a controlled application setting: the
 * SQLite database and the drawing library must reside on a writable local fixed
 * NTFS volume and stay outside the application installation directory and the
 * public Git workspace (ADR-002).
 */
export const STORAGE_CONSTRAINTS = ["LOCAL_FIXED_NTFS"] as const;
export type StorageConstraint = (typeof STORAGE_CONSTRAINTS)[number];

export interface StorageSettings {
  /** Root of all SWPanel runtime data, e.g. %LOCALAPPDATA%\JANGHI\SWPanel. */
  dataRoot: string;
  /** Root of per-Run Agent workspaces. */
  workspaceRoot: string;
  /** Placement constraint of the active database and library. */
  constraint: StorageConstraint;
  updatedAt: string;
}
