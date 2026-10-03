/**
 * Batch P3-5 Run Repository provider and async hooks.
 *
 * The provider resolves ONE `RunRepository` for the app tree:
 * - explicit override (component tests / route tests);
 * - `window.swpanel` present  -> `BridgeRunRepository` (product runtime, real
 *   Runner run/queue data over the WP5 bridge);
 * - development without a bridge -> explicit `MockRunRepository` seeded from
 *   the `?scenario=` query (browser preview / Playwright; pages keep their
 *   deterministic fixture UI through the mock path);
 * - production without a bridge -> `UnavailableRunRepository` (explicit error
 *   state; fixture data is NEVER silently shown in product).
 *
 * `useRunQuery` mirrors `useDrawingQuery` (per-key cache, loading / success /
 * error states with `retry()`, race protection, invalidation after mutations).
 *
 * `useRunEventStream(runId)` implements the Run event subscription lifecycle:
 * 1. snapshot-then-subscribe: fetch `run.getDetail`, then subscribe from
 *    `lastEventSequence + 1`;
 * 2. strict ordered application: events with `sequence <= lastSequence` are
 *    duplicates and ignored; a first event beyond `lastSequence + 1` is a GAP;
 * 3. any stream failure (gap / invalid / connection lost / closed) switches to
 *    the visible `recovering` state, refetches the snapshot and resubscribes
 *    from the new last sequence. Connection failures retry with exponential
 *    backoff (1s / 2s / 4s / 8s ...); the attempt counter resets once the
 *    stream has been healthy for a while or applied a live event; after
 *    repeated failures the stream stops in a recoverable `error` state with
 *    `retry()`. The last good `detail` / `events` stay available in every
 *    state, so pages can keep rendering them under a "reconnecting" banner;
 * 4. cleanup: the subscription, refetch and timers are torn down on route
 *    unmount or `runId` change (a changed runId also discards stale
 *    resolutions).
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

import type { RunDetailView } from "@swpanel/contracts";
import type { RunEvent } from "@swpanel/domain";
import type { SwpanelBridgeApi } from "../../../main/bridge/bridge-contract.js";
import { PRODUCTION_DEFAULT_SCENARIO } from "../../fixtures/index.js";
import { MockRepository } from "../mock-repository/mock-repository.js";
import { resolveRepositoryScenario } from "../repository-provider.js";
import { resolveRepositoryModeFrom } from "../repository-mode.js";
import { broadcastRepositoryInvalidation, subscribeRepositoryInvalidation } from "../repository-invalidation.js";
import { useRevalidateOnFocus } from "../repository-revalidation.js";
import { BridgeRunRepository } from "./bridge-run-repository.js";
import { HttpRunRepository } from "./http-run-repository.js";
import { MockRunRepository } from "./mock-run-repository.js";
import { UnavailableRunRepository } from "./unavailable-run-repository.js";
import {
  applyRunEventToDetail,
  toRunRepositoryError,
  type RunRepository,
  RunRepositoryError
} from "./run-repository.js";

/** Default adapter for standalone renders (matches RepositoryProvider's default). */
const DEFAULT_RUN_REPOSITORY: RunRepository = new MockRunRepository(
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

/**
 * Provider-wide monotonic request id. It is NEVER reset by `invalidate()`, so a
 * response of a request started before an invalidation can not be mistaken for
 * the response of the request that replaced it.
 */
let nextRequestId = 0;

interface QueryEntry {
  status: "loading" | "success" | "error";
  data: unknown;
  error: RunRepositoryError | null;
  /** Monotonic request id; stale resolutions are discarded. */
  requestId: number;
  /** Bumped by `retry()`; refetches the key. */
  retryTick: number;
  /** `${version}:${retryTick}` of the request already started for this entry. */
  fetchedFor: string | null;
}

interface RunRepositoryContextValue {
  readonly repository: RunRepository;
  readonly version: number;
  /** Bumped on every query resolution so ALL consumers re-read shared entries. */
  readonly tick: number;
  readonly entriesRef: MutableRefObject<Map<string, QueryEntry>>;
  /** Bumped by focus/visibility revalidation (stale data stays visible while refetching). */
  readonly revalidation: number;
  readonly invalidate: () => void;
  readonly notify: () => void;
}

const RunRepositoryContext = createContext<RunRepositoryContextValue | null>(null);

export interface RunRepositoryProviderProps {
  /** Explicit adapter (tests / storybook-like renders). */
  repository?: RunRepository;
  children: ReactNode;
}

/** Resolves the runtime adapter without touching React (pure + testable). */
export function resolveRunRepository(options: {
  override?: RunRepository;
  hasBridge: boolean;
  isDevelopment: boolean;
  search: string;
}): RunRepository {
  if (options.override !== undefined) return options.override;
  if (options.hasBridge) {
    // The preload bridge is the only sanctioned runtime data source. It is
    // typed as `SwpanelBridgeApi` and frozen; no generic channel access exists.
    return new BridgeRunRepository(globalThis.window.swpanel as SwpanelBridgeApi);
  }
  const mode = resolveRepositoryModeFrom(options);
  if (mode === "http") {
    return new HttpRunRepository();
  }
  if (mode === "mock") {
    // Explicit mock adapter for browser preview/tests ONLY — scenario selectors
    // keep the canonical Phase 1 fixtures deterministic. Never used in product.
    return new MockRunRepository(
      MockRepository.create(resolveRepositoryScenario(true, options.search))
    );
  }
  // Product renderer without a bridge: explicit error state, never fixtures.
  return UNAVAILABLE_RUN_REPOSITORY;
}

const UNAVAILABLE_RUN_REPOSITORY: RunRepository = new UnavailableRunRepository();

/**
 * Provides the resolved RunRepository plus the query cache/invalidation
 * machinery to the page tree.
 */
export function RunRepositoryProvider({
  repository,
  children
}: RunRepositoryProviderProps): React.JSX.Element {
  const [resolved] = useState(() =>
    resolveRunRepository({
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
    broadcastRepositoryInvalidation("run");
  }, [invalidateLocal]);

  useEffect(
    () => subscribeRepositoryInvalidation("run", invalidateLocal),
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

  const value = useMemo<RunRepositoryContextValue>(
    () => ({ repository: resolved, version, tick, revalidation, entriesRef, invalidate, notify }),
    [resolved, version, tick, revalidation, invalidate, notify]
  );

  return <RunRepositoryContext.Provider value={value}>{children}</RunRepositoryContext.Provider>;
}

/** Returns the active RunRepository (explicit override wins). */
export function useRunRepository(override?: RunRepository): RunRepository {
  if (override !== undefined) return override;
  const context = useContext(RunRepositoryContext);
  return context?.repository ?? DEFAULT_RUN_REPOSITORY;
}

/** Returns the cache invalidation callback (call after every mutation). */
export function useRunInvalidate(): () => void {
  const context = useContext(RunRepositoryContext);
  return context?.invalidate ?? NOOP;
}

export interface RunQueryState<T> {
  readonly status: "idle" | "loading" | "success" | "error";
  readonly data: T | undefined;
  readonly error: RunRepositoryError | null;
  /** Refetches the key (also used for the error-state retry button). */
  retry(): void;
}

/**
 * Async query hook with per-key caching, loading/error/success states, retry
 * and race protection. The fetcher is read from a ref, so pages may pass an
 * inline closure without retriggering the effect every render.
 */
export function useRunQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: { enabled?: boolean } = {}
): RunQueryState<T> {
  const context = useContext(RunRepositoryContext);
  const entriesRef = context?.entriesRef ?? DEFAULT_ENTRIES_REF;
  const version = context?.version ?? 0;
  const revalidation = context?.revalidation ?? 0;
  const notify = context?.notify ?? NOOP;
  const tick = context?.tick ?? 0;
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
        // Notify ALL consumers: shared keys (e.g. run detail cells) must
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
        latest.error = toRunRepositoryError(error);
        forceRender();
        notify();
      }
    );
  }, [enabled, entriesRef, key, version, revalidation, entry.retryTick, notify]);

  // Re-read latest entry state when tick changes from another query resolving
  useEffect(() => {
    if (tick > 0) {
      forceRender();
    }
  }, [tick]);

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

// ---------------------------------------------------------------------------
// Live Run event stream (snapshot-then-subscribe with reconnect recovery)
// ---------------------------------------------------------------------------

export type RunEventStreamStatus = "loading" | "live" | "recovering" | "error";

export interface RunEventStreamState {
  /** `loading` (first snapshot), `live` (subscribed), `recovering` (refetch +
   *  resubscribe in progress after a stream failure; previous data stays
   *  rendered), `error` (recoverable failure; call `retry()`). */
  readonly status: RunEventStreamStatus;
  /** Merged snapshot + applied live events; null while first-loading. */
  readonly detail: RunDetailView | null;
  /** Every applied event, ordered by sequence. */
  readonly events: readonly RunEvent[];
  readonly lastSequence: number;
  readonly error: RunRepositoryError | null;
  /** Number of consecutive failed recovery attempts (bounded). */
  readonly recoveryAttempts: number;
  /** Epoch ms at which the next reconnect attempt starts (backoff wait), else null. */
  readonly nextRetryAt: number | null;
  /** Restarts the whole snapshot-then-subscribe flow. */
  retry(): void;
}

/**
 * Reconnect policy. Mutable on purpose so tests can shrink the delays; product
 * code never changes it.
 * - `maxAttempts`: consecutive recoveries allowed before the stream stops;
 * - `baseDelayMs` / `maxDelayMs`: backoff `base * 2^(attempt-1)` capped at max;
 * - `stableResetMs`: a stream that stayed `live` this long forgets earlier failures.
 */
export const runStreamRecoveryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  stableResetMs: 10_000
};

function recoveryDelayMs(attempt: number): number {
  const { baseDelayMs, maxDelayMs } = runStreamRecoveryPolicy;
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

interface StreamSession {
  /** The runId this session belongs to (stale sessions never render/act). */
  runId: string;
  disposed: boolean;
  status: RunEventStreamStatus;
  attempts: number;
  /** True while a recovery refetch is in flight (in-flight guard). */
  recovering: boolean;
  lastSequence: number;
  events: RunEvent[];
  detail: RunDetailView | null;
  error: RunRepositoryError | null;
  unsubscribe: (() => void) | null;
  /** True only while `repository.subscribeRunEvents` runs synchronously. */
  subscribing: boolean;
  /** Set when the stream failed synchronously inside `subscribeRunEvents`. */
  failedDuringSubscribe: boolean;
  nextRetryAt: number | null;
}

export function useRunEventStream(runId: string | null): RunEventStreamState {
  const repository = useRunRepository();
  const invalidateRuns = useRunInvalidate();
  const [, forceRender] = useReducer((count: number) => count + 1, 0);
  const sessionRef = useRef<StreamSession | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const retry = useCallback(() => {
    setRetryTick((current) => current + 1);
  }, []);

  useEffect(() => {
    if (runId === null) return;
    const session: StreamSession = {
      runId,
      disposed: false,
      status: "loading",
      attempts: 0,
      recovering: false,
      lastSequence: 0,
      events: [],
      detail: null,
      error: null,
      unsubscribe: null,
      subscribing: false,
      failedDuringSubscribe: false,
      nextRetryAt: null
    };
    sessionRef.current = session;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelRetryWait: (() => void) | null = null;
    let stableTimer: ReturnType<typeof setTimeout> | null = null;

    const clearStableTimer = (): void => {
      if (stableTimer !== null) clearTimeout(stableTimer);
      stableTimer = null;
    };
    /** A stream that stays healthy for a while forgets earlier failures. */
    const armStableTimer = (): void => {
      clearStableTimer();
      stableTimer = setTimeout(() => {
        stableTimer = null;
        if (session.disposed) return;
        if (session.status === "live") {
          session.attempts = 0;
          render();
        }
      }, runStreamRecoveryPolicy.stableResetMs);
    };

    const render = (): void => forceRender();

    /** Ends the session (unmount / runId change / retry restart). */
    const teardown = (): void => {
      session.disposed = true;
      session.unsubscribe?.();
      session.unsubscribe = null;
      clearStableTimer();
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      cancelRetryWait?.();
      cancelRetryWait = null;
    };

    /** Subscribes after the current watermark and wires batch application. */
    const subscribe = (fromSequence: number): void => {
      session.unsubscribe?.();
      session.subscribing = true;
      session.failedDuringSubscribe = false;
      session.unsubscribe = repository.subscribeRunEvents(
        { runId, fromSequence },
        (push) => {
          if (session.disposed) return;
          if (push.runId !== runId) return;
          if (push.kind === "runEventsError") {
            if (session.subscribing) {
              // Failed before `subscribe` even returned: the caller handles it.
              session.failedDuringSubscribe = true;
              return;
            }
            void recover();
            return;
          }
          applyBatch(push.events);
        }
      );
      session.subscribing = false;
    };

    /** Refetches list queries once when a live event changed the run status. */
    const invalidateOnStatusChange = (
      previousStatus: string | undefined,
      nextStatus: string | undefined
    ): void => {
      if (previousStatus !== undefined && nextStatus !== undefined && previousStatus !== nextStatus) {
        // Queue/current/history pages read `runs:list`: keep them truthful.
        invalidateRuns();
      }
    };

    /** Applies one batch strictly ordered; duplicates ignored; gap recovers. */
    const applyBatch = (events: readonly RunEvent[]): void => {
      if (session.disposed) return;
      const previousStatus = session.detail?.run.status;
      let merged = session.detail;
      let appliedCount = 0;
      for (const event of events) {
        if (event.sequence <= session.lastSequence) continue; // duplicate: ignore
        if (event.sequence > session.lastSequence + 1) {
          // Gap: never silently apply; refetch + resubscribe (no backoff: the
          // connection itself is fine). Keep what was applied so far.
          if (merged !== null) session.detail = merged;
          void recover(true);
          return;
        }
        session.lastSequence = event.sequence;
        session.events.push(event);
        appliedCount += 1;
        if (merged !== null) merged = applyRunEventToDetail(merged, event);
      }
      if (appliedCount > 0) {
        // Live activity proves the stream is healthy: recovery attempts reset.
        session.attempts = 0;
      }
      if (merged !== null) {
        session.detail = merged;
        invalidateOnStatusChange(previousStatus, merged.run.status);
      }
      render();
    };

    /**
     * Stream failure path: visible recovering state, (backoff wait), refetch,
     * resubscribe. `immediate` skips the backoff wait (sequence gaps).
     */
    const recover = async (immediate = false): Promise<void> => {
      if (session.disposed) return;
      if (session.recovering) return; // in-flight guard: one recovery at a time
      session.recovering = true;
      clearStableTimer();
      session.unsubscribe?.();
      session.unsubscribe = null;
      session.attempts += 1;
      if (session.attempts > runStreamRecoveryPolicy.maxAttempts) {
        // Repeated failures: stop in a recoverable error state.
        session.status = "error";
        session.error = new RunRepositoryError(
          "RUN_EVENT_STREAM_LOST",
          "Run 事件流多次同步失败；请点击重试重新连接。"
        );
        session.nextRetryAt = null;
        session.recovering = false;
        render();
        return;
      }
      session.status = "recovering";
      session.error = null;
      const delay = immediate ? 0 : recoveryDelayMs(session.attempts);
      session.nextRetryAt = delay > 0 ? Date.now() + delay : null;
      render();
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          cancelRetryWait = resolve;
          retryTimer = setTimeout(resolve, delay);
        });
        retryTimer = null;
        cancelRetryWait = null;
        session.nextRetryAt = null;
        if (session.disposed) return;
      }
      try {
        const previousStatus = session.detail?.run.status;
        const detail = await repository.getRunDetail(runId);
        if (session.disposed) return;
        session.detail = detail;
        session.events = [...detail.events];
        session.lastSequence = detail.lastEventSequence;
        invalidateOnStatusChange(previousStatus, detail.run.status);
        subscribe(session.lastSequence + 1);
        session.recovering = false;
        if (session.failedDuringSubscribe) {
          // The new subscription died immediately: back off and try again.
          void recover();
          return;
        }
        session.status = "live";
        armStableTimer();
        render();
      } catch (error) {
        if (session.disposed) return;
        // Snapshot refetch failed (typically still offline): keep retrying with
        // backoff until the attempts run out; previous data stays visible.
        session.recovering = false;
        if (session.attempts < runStreamRecoveryPolicy.maxAttempts) {
          void recover();
          return;
        }
        session.status = "error";
        session.error = toRunRepositoryError(error);
        render();
      }
    };

    /** Initial snapshot-then-subscribe. */
    const start = async (): Promise<void> => {
      session.status = "loading";
      session.detail = null;
      session.events = [];
      session.lastSequence = 0;
      session.attempts = 0;
      session.error = null;
      render();
      try {
        const detail = await repository.getRunDetail(runId);
        if (session.disposed) return;
        session.detail = detail;
        session.events = [...detail.events];
        session.lastSequence = detail.lastEventSequence;
        subscribe(session.lastSequence + 1);
        if (session.failedDuringSubscribe) {
          void recover();
          return;
        }
        session.status = "live";
        armStableTimer();
        render();
      } catch (error) {
        if (session.disposed) return;
        session.status = "error";
        session.error = toRunRepositoryError(error);
        render();
      }
    };

    void start();
    return teardown;
  }, [repository, runId, retryTick, invalidateRuns]);

  const session = sessionRef.current;
  if (session === null || session.runId !== runId) {
    // The previous run's session must never render or act after a runId
    // change: expose a clean loading state for the frame before the new
    // session's effect runs.
    return {
      status: "loading",
      detail: null,
      events: [],
      lastSequence: 0,
      error: null,
      recoveryAttempts: 0,
      nextRetryAt: null,
      retry
    };
  }

  return {
    status: session.status,
    detail: session.detail,
    events: session.events,
    lastSequence: session.lastSequence,
    error: session.error,
    recoveryAttempts: session.attempts,
    nextRetryAt: session.nextRetryAt,
    retry
  };
}
