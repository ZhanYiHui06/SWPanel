/**
 * Immutability helpers used to store and read repository entities defensively.
 *
 * Cost reports and their snapshots are immutable business records: commands
 * never mutate them, and callers must not be able to corrupt stored state by
 * mutating command inputs or objects returned from queries. `deepClone` gives
 * storage its own copy of a caller-provided object; `deepFreeze` makes a value
 * recursively read-only so any attempt to mutate it throws in strict mode.
 */
export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

/** Recursively freezes an object/array graph, returning the same value. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
