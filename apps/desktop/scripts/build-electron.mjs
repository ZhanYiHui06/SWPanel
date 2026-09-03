/**
 * Electron main + preload build (WP5).
 *
 * Two steps:
 *
 * 1. `tsc -p tsconfig.electron.json --noEmit` type-checks the main and preload
 *    modules (the compiler is the type gate for the whole main/preload tree;
 *    it never emits, so its output cannot clobber the bundles).
 * 2. esbuild BUNDLES the entry points into self-contained output:
 *    - `dist/main/main.js` (ESM): inlines the Main IPC bridge, the RunnerHost,
 *      the drawing-file picker and the whole `@swpanel/runner` (SQLite store +
 *      ledger + named-pipe server) so the packaged app (whose asar ships NO
 *      node_modules) resolves the Runner purely from the bundle — no runtime
 *      native dependency beyond Electron's bundled `node:sqlite`.
 *    - `dist/preload/preload.cjs` (CJS): inlines the shared channel/type module
 *      from `src/main/bridge` because the SANDBOXED Preload cannot `require` a
 *      sibling module; `electron` stays external so the sandbox resolves the
 *      real API.
 *
 * The bundle-inlined modules emitted by tsc are then removed so the shipped
 * dist contains exactly `main/main.js` and `preload/preload.cjs` plus the Vite
 * renderer output.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const distRoot = path.join(desktopRoot, "dist");
const mainDist = path.join(distRoot, "main");
const preloadDist = path.join(distRoot, "preload");
const srcMain = path.join(desktopRoot, "src", "main", "main.ts");
const srcPreload = path.join(desktopRoot, "src", "preload", "preload.cts");

/** Removes a directory tree without failing when it is already absent. */
function removeTree(directory) {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // best effort; tsc/esbuild will recreate the directory
  }
}

/** Keeps only the bundled entry files in a dist subdirectory. */
function pruneBundledDir(directory, keep) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry !== keep) {
      removeTree(path.join(directory, entry));
    }
  }
}

removeTree(mainDist);
removeTree(preloadDist);

const tsc = spawnSync(
  process.execPath,
  [
    require.resolve("typescript/lib/tsc.js"),
    "-p",
    path.join(desktopRoot, "tsconfig.electron.json"),
    // tsc is ONLY the type gate here: esbuild below bundles straight from the
    // TypeScript sources. Emitting must stay off so the tsc output can never
    // clobber the self-contained bundles or leak unbundled modules into dist.
    "--noEmit"
  ],
  { cwd: desktopRoot, stdio: "inherit" }
);
if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  external: ["electron"],
  sourcemap: false,
  logLevel: "info"
};

await esbuild.build({
  ...common,
  entryPoints: [srcMain],
  format: "esm",
  outfile: path.join(mainDist, "main.js")
});

await esbuild.build({
  ...common,
  entryPoints: [srcPreload],
  format: "cjs",
  outfile: path.join(preloadDist, "preload.cjs")
});

// The bundles are self-contained; drop any stray per-module files so the
// shipped dist contains exactly the bundles plus the Vite renderer output.
pruneBundledDir(mainDist, "main.js");
pruneBundledDir(preloadDist, "preload.cjs");

console.log("SWPanel Electron main + preload build completed.");
