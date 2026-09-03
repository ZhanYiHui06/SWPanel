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
import { BridgeCostRepository } from "./bridge-cost-repository.js";
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
}

const DEFAULT_ENTRIES_REF: MutableRefObject<Map<string, QueryEntry>> = {
  current: new Map()
};

const NOOP_INVALIDATE = (): void => {};
const NOOP_NOTIFY = (): void => {};

interface CostRepositoryContextValue {
  repository: CostRepository;
  version: number;
  tick: number;
  entriesRef: MutableRefObject<Map<string, QueryEntry>>;
  invalidate: (keyOrPrefix?: string) => void;
  notify: () => void;
}

const CostRepositoryContext = createContext<CostRepositoryContextValue>({
  repository: DEFAULT_COST_REPOSITORY,
  version: 0,
  tick: 0,
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
  if (isDevelopment) {
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
  const isDevelopment = typeof process !== "undefined" && process.env?.NODE_ENV === "development";
  const search = typeof window !== "undefined" ? window.location.search : "";

  const repository = useMemo(
    () => resolveCostRepository({ override, hasBridge, isDevelopment, search }),
    [override, hasBridge, isDevelopment, search]
  );

  const [version, setVersion] = useState(0);
  const [tick, setTick] = useState(0);
  const entriesRef = useRef<Map<string, QueryEntry>>(new Map());

  const notify = useCallback(() => {
    setTick((t) => (t + 1) | 0);
  }, []);

  const invalidate = useCallback(
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

  const value = useMemo<CostRepositoryContextValue>(
    () => ({
      repository,
      version,
      tick,
      entriesRef,
      invalidate,
      notify
    }),
    [repository, version, tick, invalidate, notify]
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
  const { repository, version, entriesRef, notify } = useContext(CostRepositoryContext);
  const enabled = (options.enabled ?? true) && key !== null;
  const requestIdRef = useRef(0);

  const [, setLocalTick] = useState(0);

  useEffect(() => {
    if (!enabled || key === null) return;
    const currentEntry = entriesRef.current.get(key);
    if (currentEntry && currentEntry.status !== "idle") return;

    const reqId = ++requestIdRef.current;
    const newEntry: QueryEntry<T> = {
      status: "loading",
      data: (currentEntry?.data as T) ?? null,
      error: null,
      requestId: reqId,
      retryTick: 0
    };
    entriesRef.current.set(key, newEntry);
    setLocalTick((t) => t + 1);

    fetcher(repository)
      .then((data) => {
        if (reqId !== requestIdRef.current) return;
        entriesRef.current.set(key, {
          status: "success",
          data,
          error: null,
          requestId: reqId,
          retryTick: 0
        });
        notify();
      })
      .catch((err) => {
        if (reqId !== requestIdRef.current) return;
        entriesRef.current.set(key, {
          status: "error",
          data: null,
          error: toCostRepositoryError(err),
          requestId: reqId,
          retryTick: 0
        });
        notify();
      });
  }, [key, enabled, version, repository, fetcher, notify]);

  const retry = useCallback(() => {
    if (key === null) return;
    entriesRef.current.delete(key);
    notify();
  }, [key, notify]);

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
