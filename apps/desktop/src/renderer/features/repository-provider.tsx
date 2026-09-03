import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";

import { MockRepository } from "./mock-repository/mock-repository.js";
import {
  MOCK_SCENARIOS,
  PRODUCTION_DEFAULT_SCENARIO,
  type MockScenario
} from "../fixtures/index.js";

/**
 * Singleton repository used when no explicit provider is mounted (browser
 * preview, standalone component tests). Page instances created by the router
 * read this instance through `useRepository`.
 */
const DEFAULT_REPOSITORY = MockRepository.create(PRODUCTION_DEFAULT_SCENARIO);

/** Resolves an explicit fixture query only in development; otherwise uses production. */
export function resolveRepositoryScenario(
  isDevelopment: boolean,
  search: string
): MockScenario {
  if (!isDevelopment) return PRODUCTION_DEFAULT_SCENARIO;

  const scenario = new URLSearchParams(search).get("scenario");
  return (MOCK_SCENARIOS as readonly string[]).includes(scenario ?? "")
    ? (scenario as MockScenario)
    : PRODUCTION_DEFAULT_SCENARIO;
}

interface RepositoryContextValue {
  readonly repository: MockRepository;
  readonly version: number;
}

const RepositoryContext = createContext<RepositoryContextValue | null>(null);

export interface RepositoryProviderProps {
  /** When omitted, a fresh repository is created from the default scenario. */
  repository?: MockRepository;
  children: ReactNode;
}

/**
 * Provides the repository to the page tree and re-renders consumers whenever a
 * command is applied. Every page action (create run, submit clarification,
 * review model, cancel run) flows through the repository subscription, so the
 * UI always reflects the last applied world snapshot.
 */
export function RepositoryProvider({
  repository,
  children
}: RepositoryProviderProps): React.JSX.Element {
  // Browser E2E may select a deterministic fixture without affecting packaged Electron.
  const [resolvedRepository] = useState(() => repository ?? MockRepository.create(
    resolveRepositoryScenario(import.meta.env.DEV, window.location.search)
  ));
  const [version, setVersion] = useState(0);

  useLayoutEffect(() => {
    const subscription = resolvedRepository.subscribe(() => {
      setVersion((current) => current + 1);
    });
    return () => subscription.unsubscribe();
  }, [resolvedRepository]);

  return (
    <RepositoryContext.Provider value={{ repository: resolvedRepository, version }}>{children}</RepositoryContext.Provider>
  );
}

/**
 * Returns the current repository. Components that call this hook re-render on
 * every applied command because the provider context value changes. When an
 * explicit repository is supplied (component prop), it wins over the context so
 * pages can be rendered with a scenario-specific repository in tests.
 */
export function useRepository(override?: MockRepository): MockRepository {
  if (override !== undefined) return override;
  const context = useContext(RepositoryContext);
  return context?.repository ?? DEFAULT_REPOSITORY;
}
