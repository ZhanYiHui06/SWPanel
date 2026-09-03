import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Workspace build outputs that `npm run build` fully regenerates.
 *
 * The Electron Forge packaging output (`../out`) is intentionally absent:
 * it is owned by the `package:win` phase, which cleans it itself before
 * packaging. A packaged `app.asar` locked by a running SWPanel instance must
 * never block rebuilding the workspace dists.
 */
export const workspaceDistDirectories = [
  "../dist",
  "../apps/desktop/dist",
  "../apps/runner/dist",
  "../packages/contracts/dist",
  "../packages/domain/dist",
  "../packages/ui/dist"
];

/**
 * Remove the given directories recursively and unconditionally.
 *
 * @param {readonly string[]} directories absolute paths
 */
export async function removeDirectories(directories) {
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
}

/** Remove every workspace dist output (never the Forge `out` directory). */
export async function cleanWorkspaceDist() {
  await removeDirectories(
    workspaceDistDirectories.map((directory) =>
      fileURLToPath(new URL(directory, import.meta.url))
    )
  );
}

function isEntryPoint() {
  const invoked = process.argv[1];
  return (
    invoked !== undefined &&
    path.resolve(invoked) === fileURLToPath(import.meta.url)
  );
}

if (isEntryPoint()) {
  await cleanWorkspaceDist();
}
