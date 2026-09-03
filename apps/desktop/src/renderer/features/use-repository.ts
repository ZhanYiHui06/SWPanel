/**
 * Backward-compatible entry for the repository hook. Pages may import either
 * `./repository-provider.js` or this alias; both expose the same hook.
 */
export { useRepository } from "./repository-provider.js";
export type { RepositoryProviderProps } from "./repository-provider.js";
