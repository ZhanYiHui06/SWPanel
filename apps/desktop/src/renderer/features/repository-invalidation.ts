/**
 * Lightweight cross-provider cache invalidation bus.
 *
 * Drawing / Model / Run / Cost each keep their own query cache, but the data
 * they show is interdependent (approving a model changes the revision's
 * `currentApprovedModelId`, a Run reaching a terminal state changes the
 * drawing status, ...). When one provider invalidates, it broadcasts here and
 * every dependent provider clears its own cache locally (without
 * re-broadcasting, so there are no loops).
 */

export type RepositoryDomain = "drawing" | "model" | "run" | "cost";

/** Who must refresh when `origin` is invalidated (origin itself excluded). */
const DEPENDENTS: Readonly<Record<RepositoryDomain, readonly RepositoryDomain[]>> = {
  drawing: ["model", "run", "cost"],
  model: ["drawing", "run"],
  run: ["drawing", "model"],
  cost: ["drawing"]
};

type Listener = () => void;

const listeners: Record<RepositoryDomain, Set<Listener>> = {
  drawing: new Set(),
  model: new Set(),
  run: new Set(),
  cost: new Set()
};

/** Registers a provider's local invalidation; returns the unsubscribe. */
export function subscribeRepositoryInvalidation(domain: RepositoryDomain, listener: Listener): () => void {
  listeners[domain].add(listener);
  return () => {
    listeners[domain].delete(listener);
  };
}

/**
 * Tells every provider that depends on `origin` to drop its cache. Listeners
 * of `origin` itself are NOT called (the originating provider already cleared
 * itself).
 */
export function broadcastRepositoryInvalidation(origin: RepositoryDomain): void {
  for (const domain of DEPENDENTS[origin]) {
    for (const listener of [...listeners[domain]]) listener();
  }
}
