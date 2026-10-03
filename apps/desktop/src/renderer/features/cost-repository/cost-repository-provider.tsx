import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode
} from "react";

import type { CostDataSnapshot } from "@swpanel/domain";
import type { CostReportDetailView } from "@swpanel/contracts";
import { PRODUCTION_DEFAULT_SCENARIO } from "../../fixtures/index.js";
import { MockRepository } from "../mock-repository/mock-repository.js";
import { resolveRepositoryScenario } from "../repository-provider.js";
import { resolveRepositoryModeFrom } from "../repository-mode.js";
import { broadcastRepositoryInvalidation, subscribeRepositoryInvalidation } from "../repository-invalidation.js";
import { useRevalidateOnFocus } from "../repository-revalidation.js";
import { BridgeCostRepository } from "./bridge-cost-repository.js";
import { HttpCostRepository } from "./http-cost-repository.js";
import { MockCostRepository } from "./mock-cost-repository.js";
import { UnavailableCostRepository } from "./unavailable-cost-repository.js";
import {
  toCostRepositoryError,
  type CostRepository,
  CostRepositoryError
} from "./cost-repository.js";

const DEFAULT_COST_REPOSITORY: CostRepository = new MockCostRepository(
  MockRepository.create(PRODUCTION_DEFAULT_SCENARIO)
);

interface QueryEntry<T = unknown> {
  status: "idle" | "loading" | "success" | "error";
  data: T | null;
  error: CostRepositoryError | null;
  requestId: number;
  retryTick: number;
  /** Provider `revalidation` value this entry was last fetched under. */
  revalidation: number;
}

/**
 * Provider-wide monotonic request id (never reset by invalidation or key
 * switches), so a stale response can never be mistaken for the current one.
 */
let nextRequestId = 0;

const DEFAULT_ENTRIES_REF: MutableRefObject<Map<string, QueryEntry>> = {
  current: new Map()
};

const NOOP_INVALIDATE = (): void => {};
const NOOP_NOTIFY = (): void => {};

interface CostRepositoryContextValue {
  repository: CostRepository;
  version: number;
  tick: number;
  revalidation: number;
  entriesRef: MutableRefObject<Map<string, QueryEntry>>;
  invalidate: (keyOrPrefix?: string) => void;
  notify: () => void;
}

const CostRepositoryContext = createContext<CostRepositoryContextValue>({
  repository: DEFAULT_COST_REPOSITORY,
  version: 0,
  tick: 0,
  revalidation: 0,
  entriesRef: DEFAULT_ENTRIES_REF,
  invalidate: NOOP_INVALIDATE,
  notify: NOOP_NOTIFY
});

export interface CostRepositoryProviderProps {
  readonly repository?: CostRepository;
  readonly children: ReactNode;
}

export function resolveCostRepository({
  override,
  hasBridge,
  isDevelopment,
  search
}: {
  override: CostRepository | undefined;
  hasBridge: boolean;
  isDevelopment: boolean;
  search: string;
}): CostRepository {
  if (override) return override;
  if (hasBridge && typeof window !== "undefined" && window.swpanel) {
    return new BridgeCostRepository(window.swpanel);
  }
  const mode = resolveRepositoryModeFrom({ hasBridge, isDevelopment, search });
  if (mode === "http") {
    return new HttpCostRepository();
  }
  if (mode === "mock") {
    const scenario = resolveRepositoryScenario(true, search);
    return new MockCostRepository(MockRepository.create(scenario));
  }
  return new UnavailableCostRepository();
}

export function CostRepositoryProvider({
  repository: override,
  children
}: CostRepositoryProviderProps): React.JSX.Element {
  const hasBridge = typeof window !== "undefined" && typeof window.swpanel !== "undefined";
  const isDevelopment = import.meta.env.DEV;
  const search = typeof window !== "undefined" ? window.location.search : "";

  const repository = useMemo(
    () => resolveCostRepository({ override, hasBridge, isDevelopment, search }),
    [override, hasBridge, isDevelopment, search]
  );

  const [version, setVersion] = useState(0);
  const [tick, setTick] = useState(0);
  const [revalidation, setRevalidation] = useState(0);
  const entriesRef = useRef<Map<string, QueryEntry>>(new Map());

  const notify = useCallback(() => {
    setTick((t) => (t + 1) | 0);
  }, []);

  const invalidateLocal = useCallback(
    (keyOrPrefix?: string) => {
      if (!keyOrPrefix) {
        entriesRef.current.clear();
      } else {
        for (const key of entriesRef.current.keys()) {
          if (key.startsWith(keyOrPrefix)) {
            entriesRef.current.delete(key);
          }
        }
      }
      setVersion((v) => (v + 1) | 0);
    },
    []
  );

  /** Public invalidation: clear locally, then tell dependent providers to refresh. */
  const invalidate = useCallback(
    (keyOrPrefix?: string) => {
      invalidateLocal(keyOrPrefix);
      broadcastRepositoryInvalidation("cost");
    },
    [invalidateLocal]
  );

  useEffect(
    () => subscribeRepositoryInvalidation("cost", () => invalidateLocal()),
    [invalidateLocal]
  );

  const revalidate = useCallback(() => {
    setRevalidation((v) => (v + 1) | 0);
  }, []);
  useRevalidateOnFocus(revalidate, repository.mode === "bridge");

  const value = useMemo<CostRepositoryContextValue>(
    () => ({
      repository,
      version,
      tick,
      revalidation,
      entriesRef,
      invalidate,
      notify
    }),
    [repository, version, tick, revalidation, invalidate, notify]
  );

  return (
    <CostRepositoryContext.Provider value={value}>
      {children}
    </CostRepositoryContext.Provider>
  );
}

export function useCostRepository(): CostRepository {
  return useContext(CostRepositoryContext).repository;
}

export function useCostInvalidate(): (keyOrPrefix?: string) => void {
  return useContext(CostRepositoryContext).invalidate;
}

export interface UseCostQueryResult<T> {
  data: T | null;
  loading: boolean;
  error: CostRepositoryError | null;
  retry: () => void;
}

export function useCostQuery<T>(
  key: string | null,
  fetcher: (repository: CostRepository) => Promise<T>,
  options: { enabled?: boolean } = {}
): UseCostQueryResult<T> {
  const { repository, version, revalidation, entriesRef, notify } = useContext(CostRepositoryContext);
  const enabled = (options.enabled ?? true) && key !== null;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [, setLocalTick] = useState(0);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!enabled || key === null) return;
    const currentEntry = entriesRef.current.get(key);
    // Request ids live in the cache entry (not in the hook), so a response
    // that arrives after the caller switched keys still completes ITS entry,
    // and switching back to that key finds a finished (or in-flight) entry
    // instead of a permanently "loading" one.
    if (currentEntry?.status === "loading" || currentEntry?.status === "error") return;
    if (currentEntry?.status === "success" && currentEntry.revalidation === revalidation) return;

    // Refetching cached data (focus revalidation) keeps it on screen.
    const background = currentEntry?.status === "success";
    nextRequestId += 1;
    const reqId = nextRequestId;
    const base = {
      requestId: reqId,
      retryTick: 0,
      revalidation
    };
    entriesRef.current.set(
      key,
      background
        ? { ...currentEntry, ...base }
        : { status: "loading", data: null, error: null, ...base }
    );
    if (!background) setLocalTick((t) => t + 1);

    fetcherRef.current(repository)
      .then((data) => {
        if (entriesRef.current.get(key)?.requestId !== reqId) return;
        entriesRef.current.set(key, { status: "success", data, error: null, ...base });
        setLocalTick((t) => t + 1);
        notify();
      })
      .catch((err: unknown) => {
        if (entriesRef.current.get(key)?.requestId !== reqId) return;
        // A failed background refresh keeps the last good data.
        if (background) return;
        entriesRef.current.set(key, {
          status: "error",
          data: null,
          error: toCostRepositoryError(err),
          ...base
        });
        setLocalTick((t) => t + 1);
        notify();
      });
  }, [key, enabled, version, revalidation, retryTick, repository, entriesRef, notify]);

  const retry = useCallback(() => {
    if (key === null) return;
    entriesRef.current.delete(key);
    // Re-run the fetch effect: the entry is gone, so it starts a fresh request.
    setRetryTick((t) => t + 1);
    notify();
  }, [entriesRef, key, notify]);

  const activeEntry = key !== null ? entriesRef.current.get(key) : undefined;

  return {
    data: (activeEntry?.data as T) ?? null,
    loading: activeEntry?.status === "loading" || (!activeEntry && enabled),
    error: activeEntry?.error ?? null,
    retry
  };
}

export function useEffectiveCostDataQuery(): UseCostQueryResult<CostDataSnapshot> {
  const fetcher = useCallback((repo: CostRepository) => repo.getEffectiveCostData(), []);
  return useCostQuery<CostDataSnapshot>("cost:effective", fetcher);
}

export function useCostReportDetailQuery(costReportId: string | null): UseCostQueryResult<CostReportDetailView> {
  const fetcher = useCallback(
    (repo: CostRepository) => repo.getCostReportDetail(costReportId ?? ""),
    [costReportId]
  );
  return useCostQuery<CostReportDetailView>(
    costReportId ? `cost:report:${costReportId}` : null,
    fetcher,
    { enabled: costReportId !== null }
  );
}
