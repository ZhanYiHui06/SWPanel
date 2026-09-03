/**
 * Phase 6 Model Repository provider and async query hooks.
 *
 * The provider resolves ONE `ModelRepository` for the app tree:
 * - explicit override (component tests / route tests);
 * - `window.swpanel` present  -> `BridgeModelRepository` (product runtime, real
 *   Runner Models/Reviews over the WP5 bridge);
 * - development without a bridge -> explicit `MockModelRepository` seeded from
 *   the `?scenario=` query (browser preview / Playwright / canonical model
 *   scenario tests);
 * - production without a bridge -> `UnavailableModelRepository` (explicit error
 *   state; fixture data is NEVER silently shown in product).
 *
 * `useModelQuery` mirrors `useDrawingQuery` / `useRunQuery` (per-key cache,
 * loading / success / error states with `retry()`, race protection,
 * invalidation after mutations). `useModelDetailQuery(modelId)` is the typed
 * convenience wrapper for the aggregated Model detail.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode
} from "react";

import type { ModelDetailView } from "@swpanel/contracts";
import type { SwpanelBridgeApi } from "../../../main/bridge/bridge-contract.js";
import { PRODUCTION_DEFAULT_SCENARIO } from "../../fixtures/index.js";
import { MockRepository } from "../mock-repository/mock-repository.js";
import { resolveRepositoryScenario } from "../repository-provider.js";
import { BridgeModelRepository } from "./bridge-model-repository.js";
import { MockModelRepository } from "./mock-model-repository.js";
import { UnavailableModelRepository } from "./unavailable-model-repository.js";
import {
  toModelRepositoryError,
  type ModelRepository,
  ModelRepositoryError
} from "./model-repository.js";

/** Default adapter for standalone renders (matches RepositoryProvider's default). */
const DEFAULT_MODEL_REPOSITORY: ModelRepository = new MockModelRepository(
  MockRepository.create(PRODUCTION_DEFAULT_SCENARIO)
);

/** Default entry map for hooks mounted without a provider (tests/standalone). */
const DEFAULT_ENTRIES_REF: MutableRefObject<Map<string, QueryEntry>> = {
  current: new Map()
};

/**
 * Stable no-op for provider-less renders. Returns the SAME function on every
 * render so consumers that use `invalidate`/`notify` in a `useEffect`
 * dependency never re-trigger their effect just because the fallback identity
 * changed (which would infinite-loop without a provider mounted).
 */
const NOOP = (): void => undefined;

interface QueryEntry {
  status: "loading" | "success" | "error";
  data: unknown;
  error: ModelRepositoryError | null;
  /** Monotonic request id; stale resolutions are discarded. */
  requestId: number;
  /** Bumped by `retry()`; refetches the key. */
  retryTick: number;
  /** `${version}:${retryTick}` of the request already started for this entry. */
  fetchedFor: string | null;
}

interface ModelRepositoryContextValue {
  readonly repository: ModelRepository;
  readonly version: number;
  /** Bumped on every query resolution so ALL consumers re-read shared entries. */
  readonly tick: number;
  readonly entriesRef: MutableRefObject<Map<string, QueryEntry>>;
  readonly invalidate: () => void;
  readonly notify: () => void;
}

const ModelRepositoryContext = createContext<ModelRepositoryContextValue | null>(null);

export interface ModelRepositoryProviderProps {
  /** Explicit adapter (tests / storybook-like renders). */
  repository?: ModelRepository;
  children: ReactNode;
}

/** Resolves the runtime adapter without touching React (pure + testable). */
export function resolveModelRepository(options: {
  override?: ModelRepository;
  hasBridge: boolean;
  isDevelopment: boolean;
  search: string;
}): ModelRepository {
  if (options.override !== undefined) return options.override;
  if (options.hasBridge) {
    // The preload bridge is the only sanctioned runtime data source. It is
    // typed as `SwpanelBridgeApi` and frozen; no generic channel access exists.
    return new BridgeModelRepository(globalThis.window.swpanel as SwpanelBridgeApi);
  }
  if (options.isDevelopment) {
    // Explicit mock adapter for browser preview/tests ONLY — scenario selectors
    // keep the canonical fixture Models deterministic. Never used in product.
    return new MockModelRepository(
      MockRepository.create(resolveRepositoryScenario(true, options.search))
    );
  }
  // Product renderer without a bridge: explicit error state, never fixtures.
  return UNAVAILABLE_MODEL_REPOSITORY;
}

const UNAVAILABLE_MODEL_REPOSITORY: ModelRepository = new UnavailableModelRepository();

/**
 * Provides the resolved ModelRepository plus the query cache/invalidation
 * machinery to the page tree.
 */
export function ModelRepositoryProvider({
  repository,
  children
}: ModelRepositoryProviderProps): React.JSX.Element {
  const [resolved] = useState(() =>
    resolveModelRepository({
      ...(repository === undefined ? {} : { override: repository }),
      hasBridge: window.swpanel !== undefined,
      isDevelopment: import.meta.env.DEV,
      search: window.location.search
    })
  );
  const [version, setVersion] = useState(0);
  const [tick, setTick] = useState(0);
  const entriesRef = useRef<Map<string, QueryEntry>>(new Map());

  const invalidate = useCallback(() => {
    entriesRef.current.clear();
    setVersion((current) => current + 1);
  }, []);

  const notify = useCallback(() => {
    setTick((current) => current + 1);
  }, []);

  const value = useMemo<ModelRepositoryContextValue>(
    () => ({ repository: resolved, version, tick, entriesRef, invalidate, notify }),
    [resolved, version, tick, invalidate, notify]
  );

  return <ModelRepositoryContext.Provider value={value}>{children}</ModelRepositoryContext.Provider>;
}

/** Returns the active ModelRepository (explicit override wins). */
export function useModelRepository(override?: ModelRepository): ModelRepository {
  if (override !== undefined) return override;
  const context = useContext(ModelRepositoryContext);
  return context?.repository ?? DEFAULT_MODEL_REPOSITORY;
}

/** Returns the cache invalidation callback (call after every mutation). */
export function useModelInvalidate(): () => void {
  const context = useContext(ModelRepositoryContext);
  return context?.invalidate ?? NOOP;
}

export interface ModelQueryState<T> {
  readonly status: "idle" | "loading" | "success" | "error";
  readonly data: T | undefined;
  readonly error: ModelRepositoryError | null;
  /** Refetches the key (also used for the error-state retry button). */
  retry(): void;
}

/**
 * Async query hook with per-key caching, loading/error/success states, retry
 * and race protection. The fetcher is read from a ref, so pages may pass an
 * inline closure without retriggering the effect every render.
 */
export function useModelQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: { enabled?: boolean } = {}
): ModelQueryState<T> {
  const context = useContext(ModelRepositoryContext);
  const entriesRef = context?.entriesRef ?? DEFAULT_ENTRIES_REF;
  const version = context?.version ?? 0;
  const notify = context?.notify ?? NOOP;
  const enabled = options.enabled ?? true;
  const [, forceRender] = useReducer((count: number) => count + 1, 0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  let entry = entriesRef.current.get(key);
  if (entry === undefined) {
    entry = {
      status: "loading",
      data: undefined,
      error: null,
      requestId: 0,
      retryTick: 0,
      fetchedFor: null
    };
    entriesRef.current.set(key, entry);
  }

  const retry = useCallback(() => {
    const current = entriesRef.current.get(key);
    if (current === undefined) return;
    current.retryTick += 1;
    forceRender();
  }, [entriesRef, key]);

  useEffect(() => {
    const current = entriesRef.current.get(key);
    if (current === undefined || !enabled) return;
    const fetchKey = `${version}:${current.retryTick}`;
    if (current.fetchedFor === fetchKey) return;
    current.fetchedFor = fetchKey;
    current.status = "loading";
    current.error = null;
    current.requestId += 1;
    const requestId = current.requestId;
    forceRender();
    notify();

    void fetcherRef.current().then(
      (data) => {
        const latest = entriesRef.current.get(key);
        // Stale guard: a newer request (retry, invalidation, navigation) owns
        // the key now — this resolution must never overwrite it.
        if (latest === undefined || latest.requestId !== requestId) return;
        latest.status = "success";
        latest.data = data;
        latest.error = null;
        // Notify ALL consumers: shared keys must re-read the resolved entry,
        // not just the starting component.
        forceRender();
        notify();
      },
      (error: unknown) => {
        const latest = entriesRef.current.get(key);
        if (latest === undefined || latest.requestId !== requestId) return;
        latest.status = "error";
        latest.data = undefined;
        latest.error = toModelRepositoryError(error);
        forceRender();
        notify();
      }
    );
  }, [enabled, entriesRef, key, version, entry.retryTick, notify]);

  if (!enabled) {
    return { status: "idle", data: undefined, error: null, retry };
  }

  return {
    status: entry.status,
    data: entry.data as T | undefined,
    error: entry.error,
    retry
  };
}

/**
 * Typed Model detail query (`model:detail:<modelId>` cache entry). Disabled
 * while `modelId` is null so pages can pass a possibly-unresolved id.
 */
export function useModelDetailQuery(modelId: string | null): ModelQueryState<ModelDetailView> {
  const repository = useModelRepository();
  return useModelQuery<ModelDetailView>(
    modelId === null ? "model:detail:" : `model:detail:${modelId}`,
    () => repository.getModelDetail(modelId as string),
    { enabled: modelId !== null }
  );
}