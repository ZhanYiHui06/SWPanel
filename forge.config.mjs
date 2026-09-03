import { MakerSquirrel } from "@electron-forge/maker-squirrel";

/**
 * Per-run Forge output directory. `npm run package:win` sets this to
 * `.scratch/package-runs/<uuid>/out` for every run; when it is unset (e.g. an
 * ad-hoc manual `electron-forge package`), Forge falls back to the default
 * `out` directory. The canonical `out` is only ever produced by the final
 * atomic publish in scripts/packaging.mjs.
 */
const configuredOutDir =
  typeof process.env.SWPANEL_FORGE_OUT_DIR === "string" &&
  process.env.SWPANEL_FORGE_OUT_DIR.length > 0
    ? process.env.SWPANEL_FORGE_OUT_DIR
    : undefined;

// Forge evaluates these against POSIX-style paths relative to the package root.
// Keep this list focused on files that can never be loaded by the shipped app.
// Anything listed here must also be absent from a freshly produced app.asar:
// scripts/audit-asar.mjs cross-checks the package against this policy.
//
// Repo-level rules are anchored to the workspace root only; loose prefix
// matching (e.g. "vite.js" matching vite.config) is deliberately avoided so a
// legitimate file is never silently dropped.
export const PACKAGE_IGNORE_PATTERNS = [
  // Local working dirs: design source of truth, VCS, the removed packaging
  // staging snapshot (.package-copy), temporary verification artifacts
  // (.scratch), and editor state. None may ever be read by the shipped app.
  /^[\\/]\.(?:design|git|local-data|package-copy|scratch|zcode)(?:$|[\\/])/i,
  // Root build output (dist/phase-zero.js, dist/design-source/...) is a dev
  // artifact; workspace dist outputs under apps//packages ship.
  /^[\\/]dist(?:$|[\\/])/i,
  // Dev tooling lives under scripts/; nothing in the shipped app loads it.
  /(?:^|[\\/])scripts(?:$|[\\/])/i,
  /^[\\/](?:apps|packages)[\\/][^\\/]+[\\/](?:src|node_modules)(?:$|[\\/])/i,
  // Compiled test output inside workspace dists (e.g. packages/ui/dist/test/)
  // is never part of the runtime closure. Precise segment match; repo-level
  // dev/test directories are handled separately, anchored to the root.
  /^[\\/](?:apps|packages)[\\/][^\\/]+[\\/]dist[\\/](?:test|tests|__tests__)(?:$|[\\/])/i,
  // SWPanel runtime data lives only at explicit workspace-root paths. Matched
  // at the root only so legitimate runtime modules such as
  // packages/domain/dist/artifacts/** are never excluded.
  /^[\\/](?:artifacts|customer|crash-dumps|db|logs|runtime|secrets|workspaces|\.local-data)(?:$|[\\/])/i,
  // Repo-level dev/test directories, anchored to the workspace root. Includes
  // the canonical Forge `out` and only the exact `out-invalid-*` quarantine
  // prefix: a root directory that merely starts with "out-invalid" (e.g.
  // out-invalidated) is not a packaging quarantine and must be retained.
  /^[\\/](?:cache|component-spec|coverage|docs|e2e|fixtures?|out|out-invalid-[^\\/]*|playwright-report|src|test-results|tests?)(?:$|[\\/])/i,
  // Root installer artifacts: the canonical `installers` directory (built
  // Setup.exe / .nupkg / RELEASES output published by scripts/installer.mjs)
  // and the exact `installers-invalid-` quarantine prefix it uses for a
  // previous canonical installers. Anchored to the root only; a module tree
  // that happens to contain an `installers` directory is legitimate runtime
  // content and must be retained.
  /^[\\/]installers-invalid-[^\\/]*(?:$|[\\/])/i,
  /^[\\/]installers(?:$|[\\/])/i,
  /(?:^|[\\/])\.vite[^\\/]*(?:[\\/]|$)/i,
  // Cache/dev-state artifacts: the literal names above plus ANY basename ending
  // in `.tsbuildinfo` (e.g. the root `tsconfig.build.tsbuildinfo` refreshed by
  // `npm run build`). Mirrored by the audit in scripts/audit-asar.mjs ("cache").
  /(?:^|[\\/])(?:\.eslintcache|\.npmrc|\.tsbuildinfo)(?:$|[\\/])/i,
  /\.tsbuildinfo$/i,
  // Source maps and TypeScript declarations are dev artifacts; the shipped
  // app runs plain compiled JavaScript.
  /\.(?:map|d\.ts|d\.ts\.map)$/i,
  /\.(?:db|db-shm|db-wal|sqlite|sqlite-shm|sqlite-wal)$/i,
  /\.(?:sldprt|sldasm|slddrw|step|stp|iges|igs|mp4)$/i,
  /(?:^|[\\/])(?:node_modules|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)(?:$|[\\/])/i,
  // Sensitive local files: environment files, private keys and logs. Mirrored
  // by the audit in scripts/audit-asar.mjs (runtime-secrets).
  /(?:^|[\\/])\.env(?:\.|$)/i,
  /\.(?:pem|key|log)$/i,
  // Root-level VCS metadata and repo-scoped config/design-brief documents.
  /(?:^|[\\/])\.git(?:attributes|ignore|modules)(?:$|[\\/])/i,
  // Precise tool-config filenames only — never loose prefixes, so files such
  // as vite.js, eslint.js or playwright.cjs are retained.
  /(?:^|[\\/])tsconfig[^\\/]*\.json$/i,
  /(?:^|[\\/])vite\.config\.(?:ts|js|mjs|cjs)$/i,
  /(?:^|[\\/])vitest\.config\.(?:ts|js|mjs|cjs)$/i,
  /(?:^|[\\/])eslint\.config\.(?:js|mjs|cjs)$/i,
  /(?:^|[\\/])playwright(?:\.electron\.production)?\.config\.(?:ts|js|cjs)$/i,
  /(?:^|[\\/])forge\.config\.mjs$/i,
  // Root-level repo documents (README/CHANGELOG/CONTRIBUTING) never ship;
  // identical filenames inside a shipped module tree are retained.
  /^[\\/](?:README|CHANGELOG|CONTRIBUTING)(?:\.(?:md|markdown|txt))?$/i,
  /^[\\/]SWPanel-UI-Design-Brief\.md$/i
];

/** @param {string} path */
export const isPackagedPathIgnored = (path) =>
  PACKAGE_IGNORE_PATTERNS.some((pattern) => pattern.test(path));

export const SQUIRREL_MAKER_CONFIG = {
  authors: "JANGHI",
  description: "江海冶金内部图纸自动建模与成本测算工作台"
};

// Opt-in: when SWPANEL_ELECTRON_ZIP_DIR is set, package the app from the
// `electron-v<version>-<platform>-<arch>.zip` already present in that directory
// (packager's `electronZipDir`) and skip @electron/get's network fetch of both
// the zip and SHASUMS256.txt. Unset on normal hosts keeps the default download
// behavior. This exists so packaging stays deterministic on hosts whose access
// to the Electron release host is unavailable or flaky (see the Phase 8
// packaging note about SHASUMS256.txt verification).
const configuredElectronZipDir =
  typeof process.env.SWPANEL_ELECTRON_ZIP_DIR === "string" &&
  process.env.SWPANEL_ELECTRON_ZIP_DIR.length > 0
    ? process.env.SWPANEL_ELECTRON_ZIP_DIR
    : undefined;

export default {
  outDir: configuredOutDir,
  packagerConfig: {
    asar: true,
    executableName: "SWPanel",
    name: "SWPanel",
    ignore: PACKAGE_IGNORE_PATTERNS,
    ...(configuredElectronZipDir !== undefined
      ? { electronZipDir: configuredElectronZipDir }
      : {})
  },
  rebuildConfig: {},
  makers: [new MakerSquirrel(SQUIRREL_MAKER_CONFIG)]
};
