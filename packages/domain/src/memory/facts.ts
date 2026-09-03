/**
 * `Revision Facts` are version-level engineering facts that carry authoritative
 * weight for later Modeling Runs: user-supplied missing dimensions, clarified
 * ambiguous structures, confirmed materials/processes and Clarification answers.
 */
export const REVISION_FACT_SOURCES = [
  "USER_SUPPLEMENT",
  "DRAWING_CONFIRMED",
  "CLARIFICATION"
] as const;
export type RevisionFactSource = (typeof REVISION_FACT_SOURCES)[number];

export interface RevisionFact {
  id: string;
  revisionId: string;
  /** Fact field name, e.g. 中心孔深度, 材料, R5 圆角位置 */
  field: string;
  /** Normalized display value, e.g. "85 mm" or "42CrMo" */
  value: string;
  unit?: string;
  source: RevisionFactSource;
  /** Run that produced the fact (e.g. the Clarification run), when applicable. */
  sourceRunId?: string;
  createdAt: string;
  createdBy?: string;
}
