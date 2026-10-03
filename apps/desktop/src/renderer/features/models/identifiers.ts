/**
 * Short, readable form of an opaque Runner id (a UUID in production).
 *
 * Pages should prefer the business label (`runLabel` / `modelLabel`) from the
 * views; when it is unavailable this shows the first block of the id instead of
 * a 36-character string, and never assumes a fixture-only id format.
 */
export function shortId(id: string): string {
  const trimmed = id.trim();
  if (trimmed === "") return "—";
  return trimmed.length <= 8 ? trimmed : trimmed.slice(0, 8).toUpperCase();
}
