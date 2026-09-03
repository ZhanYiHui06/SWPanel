/**
 * Error raised when a pure domain transition or invariant would be violated.
 * Used by the lifecycle helpers so that the Agent Runner (and tests) can
 * distinguish business-rule failures from execution failures.
 */
export class DomainInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainInvariantError";
  }
}
