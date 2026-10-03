/**
 * WP6 Drawing Repository provider and async query hooks.
 *
 * The provider resolves ONE `DrawingRepository` for the app tree:
 * - explicit override (component tests / route tests);
 * - `window.swpanel` present  -> `BridgeDrawingRepository` (product runtime,
 *   real Runner data over the WP5 bridge);
 * - development without a bridge -> explicit `MockBridgeDrawingRepository`
 *   seeded from the `?scenario=` query (browser preview / Playwright);
 * - production without a bridge -> `UnavailableDrawingRepository` (explicit
 *   error state; fixture data is NEVER silently shown in product).
 *
 * `useDrawingQuery` adds the async state machine the pages share:
 * - a per-key cache so the same key (e.g. the library list) is fetched once;
 * - loading / success / error states with `retry()`;
 * - race protection: every request carries a monotonically increasing id and
 *   stale resolutions are discarded, so a slow response can never overwrite a
 *   newer navigation;
 * - `useDrawingInvalidate()` clears the cache and bumps the provider version
 *   after every mutation, refetching all mounted queries (cross-page updates).
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

import { PRODUCTION_DEFAULT_SCENARIO } from "../../fixtures/index.js";
import { resolveRepositoryScenario } from "../repository-provider.js";
import { resolveRepositoryModeFrom } from "../repository-mode.js";
import { broadcastRepositoryInvalidation, subscribeRepositoryInvalidation } from "../repository-invalidation.js";
import { useRevalidateOnFocus } from "../repository-revalidation.js";
import type { SwpanelBridgeApi } from "../../../main/bridge/bridge-contract.js";
import { BridgeDrawingRepository } from "./bridge-drawing-repository.js";
import { HttpDrawingRepository } from "./http-drawing-repository.js";
import { MockBridgeDrawingRepository } from "./mock-bridge-repository.js";
import { UnavailableDrawingRepository } from "./unavailable-drawing-repository.js";
import {
  toDrawingRepositoryError,
  type DrawingRepository,
  DrawingRepositoryError
} from "./drawing-repository.js";

/** Default adapter for standalone renders (matches RepositoryProvider's default). */
const DEFAULT_DRAWING_REPOSITORY: DrawingRepository =
  MockBridgeDrawingRepository.create(PRODUCTION_DEFAULT_SCENARIO);

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

/**
 * Provider-wide monotonic request id. It is NEVER reset by `invalidate()`, so a
 * response of a request started before an invalidation can not be mistaken for
 * the response of the request that replaced it.
 */
let nextRequestId = 0;

interface QueryEntry {
  status: "loading" | "success" | "error";
  data: unknown;
  error: DrawingRepositoryError | null;
  /** Monotonic request id; stale resolutions are discarded. */
  requestId: number;
  /** Bumped by `retry()`; refetches the key. */
  retryTick: number;
  /** `${version}:${retryTick}` of the request already started for this entry. */
  fetchedFor: string | null;
}

interface DrawingRepositoryContextValue {
  readonly repository: DrawingRepository;
  readonly version: number;
  /** Bumped on every query resolution so ALL consumers re-read shared entries. */
  readonly tick: number;
  readonly entriesRef: MutableRefObject<Map<string, QueryEntry>>;
  /** Bumped by focus/visibility revalidation (stale data stays visible while refetching). */
  readonly revalidation: number;
  readonly invalidate: () => void;
  readonly notify: () => void;
}

const DrawingRepositoryContext = createContext<DrawingRepositoryContextValue | null>(null);

export interface DrawingRepositoryProviderProps {
  /** Explicit adapter (tests / storybook-like renders). */
  repository?: DrawingRepository;
  children: ReactNode;
}

/** Resolves the runtime adapter without touching React (pure + testable). */
export function resolveDrawingRepository(options: {
  override?: DrawingRepository;
  hasBridge: boolean;
  isDevelopment: boolean;
  search: string;
}): DrawingRepository {
  if (options.override !== undefined) return options.override;
  if (options.hasBridge) {
    // The preload bridge is the only sanctioned runtime data source. It is
    // typed as `SwpanelBridgeApi` and frozen; no generic channel access exists.
    return new BridgeDrawingRepository(globalThis.window.swpanel as SwpanelBridgeApi);
  }
  // If ?mode=http is provided or in browser without bridge when not asking for mock scenario
  const mode = resolveRepositoryModeFrom(options);
  if (mode === "http") {
    return new HttpDrawingRepository();
  }
  if (mode === "mock") {
    // Explicit mock adapter for browser preview/tests ONLY — scenario selectors
    // keep the canonical Phase 1 fixtures deterministic. Never used in product.
    return MockBridgeDrawingRepository.create(
      resolveRepositoryScenario(true, options.search)
    );
  }
  // Product renderer without a bridge: explicit error state, never fixtures.
  return UNAVAILABLE_DRAWING_REPOSITORY;
}

const UNAVAILABLE_DRAWING_REPOSITORY: DrawingRepository = new UnavailableDrawingRepository();

/**
 * Provides the resolved DrawingRepository plus the query cache/invalidation
 * machinery to the page tree.
 */
export function DrawingRepositoryProvider({
  repository,
  children
}: DrawingRepositoryProviderProps): React.JSX.Element {
  const [resolved] = useState(() =>
    resolveDrawingRepository({
      ...(repository === undefined ? {} : { override: repository }),
      hasBridge: window.swpanel !== undefined,
      isDevelopment: import.meta.env.DEV,
      search: window.location.search
    })
  );
  const [version, setVersion] = useState(0);
  const [tick, setTick] = useState(0);
  const [revalidation, setRevalidation] = useState(0);
  const entriesRef = useRef<Map<string, QueryEntry>>(new Map());

  /** Clears this provider's cache only (also the target of cross-provider invalidation). */
  const invalidateLocal = useCallback(() => {
    entriesRef.current.clear();
    setVersion((current) => current + 1);
  }, []);

  /** Public invalidation: clear locally, then tell dependent providers to refresh. */
  const invalidate = useCallback(() => {
    invalidateLocal();
    broadcastRepositoryInvalidation("drawing");
  }, [invalidateLocal]);

  useEffect(
    () => subscribeRepositoryInvalidation("drawing", invalidateLocal),
    [invalidateLocal]
  );

  const revalidate = useCallback(() => {
    setRevalidation((current) => current + 1);
  }, []);
  // Real data can change behind the UI's back; fixtures can not.
  useRevalidateOnFocus(revalidate, resolved.mode === "bridge");

  const notify = useCallback(() => {
    setTick((current) => current + 1);
  }, []);

  const value = useMemo<DrawingRepositoryContextValue>(
    () => ({ repository: resolved, version, tick, revalidation, entriesRef, invalidate, notify }),
    [resolved, version, tick, revalidation, invalidate, notify]
  );

  return <DrawingRepositoryContext.Provider value={value}>{children}</DrawingRepositoryContext.Provider>;
}

/** Returns the active DrawingRepository (explicit override wins). */
export function useDrawingRepository(override?: DrawingRepository): DrawingRepository {
  if (override !== undefined) return override;
  const context = useContext(DrawingRepositoryContext);
  return context?.repository ?? DEFAULT_DRAWING_REPOSITORY;
}

/** Returns the cache invalidation callback (call after every mutation). */
export function useDrawingInvalidate(): () => void {
  const context = useContext(DrawingRepositoryContext);
  return context?.invalidate ?? NOOP;
}

export interface DrawingQueryState<T> {
  readonly status: "idle" | "loading" | "success" | "error";
  readonly data: T | undefined;
  readonly error: DrawingRepositoryError | null;
  /** Refetches the key (also used for the error-state retry button). */
  retry(): void;
}

/**
 * Async query hook with per-key caching, loading/error/success states, retry
 * and race protection. The fetcher is read from a ref, so pages may pass an
 * inline closure without retriggering the effect every render.
 */
export function useDrawingQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: { enabled?: boolean } = {}
): DrawingQueryState<T> {
  const context = useContext(DrawingRepositoryContext);
  const entriesRef = context?.entriesRef ?? DEFAULT_ENTRIES_REF;
  const version = context?.version ?? 0;
  const revalidation = context?.revalidation ?? 0;
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
    const fetchKey = `${version}:${revalidation}:${current.retryTick}`;
    if (current.fetchedFor === fetchKey) return;
    current.fetchedFor = fetchKey;
    // Refetching a cached success (focus revalidation) keeps the data on screen.
    const background = current.status === "success";
    if (!background) {
      current.status = "loading";
      current.error = null;
    }
    nextRequestId += 1;
    current.requestId = nextRequestId;
    const requestId = current.requestId;
    if (!background) {
      forceRender();
      notify();
    }

    void fetcherRef.current().then(
      (data) => {
        const latest = entriesRef.current.get(key);
        // Stale guard: a newer request (retry, invalidation, navigation) owns
        // the key now — this resolution must never overwrite it.
        if (latest === undefined || latest.requestId !== requestId) return;
        latest.status = "success";
        latest.data = data;
        latest.error = null;
        // Notify ALL consumers: shared keys (e.g. drawing identity rows) must
        // re-read the resolved entry, not just the starting component.
        forceRender();
        notify();
      },
      (error: unknown) => {
        const latest = entriesRef.current.get(key);
        if (latest === undefined || latest.requestId !== requestId) return;
        // A failed background refresh keeps the last good data instead of an error page.
        if (background) return;
        latest.status = "error";
        latest.data = undefined;
        latest.error = toDrawingRepositoryError(error);
        forceRender();
        notify();
      }
    );
  }, [enabled, entriesRef, key, version, revalidation, entry.retryTick, notify]);

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

export function useDrawingDetailQuery(drawingId: string | null) {
  const repository = useDrawingRepository();
  return useDrawingQuery(
    drawingId ? `drawing:detail:${drawingId}` : "",
    () => repository.getDrawingDetail(drawingId!),
    { enabled: drawingId !== null }
  );
}

export function useRevisionDetailQuery(drawingId: string | null, revisionId: string | null) {
  const repository = useDrawingRepository();
  return useDrawingQuery(
    drawingId && revisionId ? `revision:detail:${drawingId}:${revisionId}` : "",
    () => repository.getRevisionDetail(drawingId!, revisionId!),
    { enabled: drawingId !== null && revisionId !== null }
  );
}
