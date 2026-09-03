import { DomainInvariantError } from "./errors.js";

/**
 * Formats a two-digit sequence label used by the product's business objects,
 * e.g. R05, M03, Q03, C01, A01. Sequences are 1-based business ordinals.
 */
export function formatSequenceLabel(prefix: string, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new DomainInvariantError(`Sequence label requires a positive integer, got ${sequence}`);
  }
  return `${prefix}${String(sequence).padStart(2, "0")}`;
}

export function runLabel(sequence: number): string {
  return formatSequenceLabel("R", sequence);
}

export function modelLabel(sequence: number): string {
  return formatSequenceLabel("M", sequence);
}

export function costReportLabel(sequence: number): string {
  return formatSequenceLabel("Q", sequence);
}

export function clarificationQuestionLabel(sequence: number): string {
  return formatSequenceLabel("C", sequence);
}

export function clarificationAnswerLabel(sequence: number): string {
  return formatSequenceLabel("A", sequence);
}
