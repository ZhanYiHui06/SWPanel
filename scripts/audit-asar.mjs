import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { init as initModuleLexer, parse as parseModule } from "es-module-lexer";

import * as asar from "@electron/asar";

import { isPackagedPathIgnored } from "../forge.config.mjs";

/** Default freshly packaged app.asar produced by `npm run package:win`. */
export const defaultAsarPath = fileURLToPath(
  new URL(
    "../out/SWPanel-win32-x64/resources/app.asar",
    import.meta.url
  )
);

/** Human-readable audit report location (gitignored temporary artifact). */
export const auditReportPath = fileURLToPath(
  new URL("../.scratch/asar-audit-report.json", import.meta.url)
);

/**
 * Entry roots of the shipped app's module closure. Everything reachable from
 * these files through relative static imports/exports/requires (ESM and CJS)
 * and through the renderer index.html script/link references must be present
 * and non-empty inside the asar. `package.json` is required by Electron
 * itself; the desktop main/preload, runner, and the domain/contracts/ui dist
 * entries are the runtime surface of the app.
 */
export const requiredRuntimeRootFiles = [
  "package.json",
  "apps/desktop/dist/main/main.js",
  "apps/desktop/dist/preload/preload.cjs",
  "apps/desktop/dist/renderer/index.html",
  "apps/runner/dist/index.js",
  // The Python pypdfium2 rasterization helper must ship as a REAL file inside
  // the asar: PythonPdfiumRasterizer materializes it to a private temp dir
  // before spawning, but the entry itself has to be present in the package.
  "apps/runner/dist/adaptation/pdfium-rasterizer-helper.py",
  "packages/domain/dist/index.js",
  "packages/contracts/dist/index.js",
  "packages/ui/dist/index.js"
];

/** Renderer asset font extensions (excluded from the renderer-asset check). */
export const RENDERER_FONT_EXTENSIONS = /\.(?:woff2?|ttf|otf|eot)$/i;

/**
 * True when an entry is a real renderer asset: a file under the renderer
 * assets directory that is neither a source map nor a font. Fonts are loaded
 * by the browser from CSS url() references and are deliberately not counted as
 * evidence that the renderer bundle actually shipped.
 *
 * @param {string} entry normalized POSIX relative path
 */
export function isRendererAsset(entry) {
  return (
    /^apps\/desktop\/dist\/renderer\/assets\//i.test(entry) &&
    !/\.map$/i.test(entry) &&
    !RENDERER_FONT_EXTENSIONS.test(entry)
  );
}

/**
 * @typedef {{
 *   auditedSourcePath: string;
 *   generatedAt: string;
 *   asarSizeBytes: number;
 *   asarSha256: string;
 *   totalEntries: number;
 *   forbidden: Array<{ entry: string; categories: string[] }>;
 *   missingRuntime: string[];
 *   emptyRuntime: string[];
 *   closureFiles: string[];
 *   hasRendererAssets: boolean;
 *   ok: boolean;
 *   publishedPath?: string;
 *   publishedSha256?: string;
 *   publishedSizeBytes?: number;
 *   publishedAt?: string;
 * }} AsarAuditReport
 */

/**
 * SHA-256 hex digest of a file's contents.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function sha256File(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Normalize an asar entry to a stable POSIX relative path (forward slashes,
 * no leading separator), matching how forge.config.mjs is evaluated.
 *
 * @param {string} entry
 * @returns {string}
 */
export function normalizeAsarEntry(entry) {
  return entry.replace(/\\/g, "/").replace(/^[/]+/, "").replace(/\/+$/, "");
}

/** Precise, case-insensitive segment comparison helpers (no regex escaping). */

/**
 * @param {string} entry normalized POSIX relative path
 * @returns {string[]} path segments, lowercased for comparison
 */
function pathSegments(entry) {
  return normalizeAsarEntry(entry)
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
}

/**
 * Whether any path segment of the entry matches one of `names`.
 *
 * @param {string} entry
 * @param {ReadonlySet<string>} names
 */
function hasAnySegment(entry, names) {
  return pathSegments(entry).some((segment) => names.has(segment));
}

/**
 * Whether the FIRST (root) segment of the entry is `name`. Segment-exact: the
 * name must be the whole first segment, so `packages/domain/dist/artifacts`
 * never matches the root runtime-data name `artifacts`.
 *
 * @param {string} entry
 * @param {string} name
 */
function hasRootSegment(entry, name) {
  const segments = pathSegments(entry);
  return segments.length > 0 && segments[0] === name;
}

/**
 * Whether the entry starts with the exact root segments `[...names]`
 * (e.g. `dist/design-source/...`).
 *
 * @param {string} entry
 * @param {readonly string[]} names
 */
function startsWithSegments(entry, names) {
  const segments = pathSegments(entry);
  return (
    segments.length >= names.length &&
    names.every((name, index) => segments[index] === name)
  );
}

/** @param {string} entry */
function basename(entry) {
  return normalizeAsarEntry(entry).split("/").filter(Boolean).pop() ?? "";
}

const RUNTIME_DATA_ROOT_SEGMENTS = new Set([
  "artifacts",
  "customer",
  "crash-dumps",
  "db",
  "logs",
  "runtime",
  "secrets",
  "workspaces",
  ".local-data"
]);

const TEST_SEGMENTS = new Set([
  "e2e",
  "tests",
  "test",
  "__tests__",
  "test-results"
]);

const CACHE_SEGMENTS = new Set([".cache", ".vite"]);

/**
 * Exact tool-config file basenames that must never ship. Only whole filenames
 * are matched (precise segment compare): `vite.js`, `eslint.js` or
 * `playwright.cjs` are legitimate and are never flagged.
 */
const DEVTOOLING_CONFIG_BASENAMES = new Set([
  "forge.config.mjs",
  "forge.config.js",
  "forge.config.cjs",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.cjs",
  "playwright.electron.production.config.ts",
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock"
]);

/** Prefix of the root-level quarantine that holds a previous canonical `out`. */
export const OUT_INVALID_PREFIX = "out-invalid-";

/**
 * Prefix of the root-level quarantine that holds a previous canonical
 * `installers` (see `INSTALLERS_INVALID_PREFIX` in scripts/installer.mjs).
 */
export const INSTALLERS_INVALID_PREFIX = "installers-invalid-";

/**
 * Forbidden-content categories an entry may belong to. Returns an empty array
 * for legitimate runtime content. The list is intentionally independent of
 * forge.config.mjs; the `forge-ignore-policy` category then cross-checks that
 * whatever the packaging policy forbids was actually excluded.
 *
 * @param {string} entry normalized POSIX relative path
 * @returns {string[]}
 */
export function forbiddenCategories(entry) {
  const normalized = normalizeAsarEntry(entry);
  const base = basename(normalized);
  /** @type {string[]} */
  const categories = [];
  /** @param {string} category */
  const push = (category) => {
    if (!categories.includes(category)) categories.push(category);
  };

  // Source code: any src tree, TypeScript sources outside dist, and any
  // vendored runtime source that must never ship.
  if (hasAnySegment(normalized, new Set(["src"]))) push("source");
  if (/\.(ts|tsx|jsx)$/i.test(base) && !/\.d\.ts$/i.test(base)) {
    push("source");
  }
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(base)) push("tests");

  if (hasAnySegment(normalized, new Set(["docs"]))) push("docs");
  if (hasAnySegment(normalized, new Set([".design"]))) push("design");
  if (startsWithSegments(normalized, ["dist", "design-source"])) push("design");
  if (/^SWPanel-UI-Design-Brief\.md$/i.test(base)) push("design");

  if (hasAnySegment(normalized, TEST_SEGMENTS)) push("tests");

  if (/\.map$/i.test(base)) push("maps");
  if (/\.d\.ts(\.map)?$/i.test(base)) push("declarations");
  if (hasAnySegment(normalized, CACHE_SEGMENTS)) push("cache");
  if (/\.(eslintcache|tsbuildinfo)$/i.test(base)) push("cache");

  if (/\.(db|db-shm|db-wal|sqlite|sqlite-shm|sqlite-wal)$/i.test(base)) {
    push("db");
  }
  // A `db` DIRECTORY segment is only runtime data when it sits at the
  // workspace root (the WP2 data-root layout); the root case is already
  // covered by RUNTIME_DATA_ROOT_SEGMENTS below. A nested `db` module
  // directory is legitimate runtime code — the WP5 Runner ships its SQLite
  // layer as `apps/runner/dist/db/**` — and must never be flagged here
  // (same principle as packages/domain/dist/artifacts/**).

  if (/\.(sldprt|sldasm|slddrw|step|stp|iges|igs|mp4)$/i.test(base)) {
    push("cad");
  }

  // SWPanel runtime-data roots, matched at the root only so legitimate modules
  // such as packages/domain/dist/artifacts/** stay clean.
  if (RUNTIME_DATA_ROOT_SEGMENTS.has(pathSegments(normalized)[0] ?? "")) {
    push("runtime-secrets");
  }
  if (/\.(?:pem|key|log)$/i.test(base)) push("runtime-secrets");
  if (/^\.env$|^\.env\./i.test(base)) push("runtime-secrets");

  // Dev/build tooling never needed by the shipped app.
  if (hasAnySegment(normalized, new Set(["scripts"]))) push("devtooling");
  if (DEVTOOLING_CONFIG_BASENAMES.has(base.toLowerCase())) push("devtooling");
  if (/^tsconfig[^\\/]*\.json$/i.test(base)) push("devtooling");

  // Root build output (dist/phase-zero.*, dist/design-source/) is a dev
  // artifact. Workspace dist outputs (apps/desktop/dist, packages/domain/dist,
  // ...) are legitimate runtime modules and must never be flagged here.
  if (hasRootSegment(normalized, "dist")) push("dev-output");

  if (hasAnySegment(normalized, new Set([".scratch", ".package-copy"]))) {
    push("staging");
  }
  // Only the exact `out-invalid-` quarantine prefix is staging: a root
  // directory that merely starts with "out-invalid" (e.g. out-invalidated)
  // is not a packaging quarantine and must not be flagged.
  if (pathSegments(normalized)[0]?.startsWith(OUT_INVALID_PREFIX) === true) {
    push("staging");
  }
  // Root installer artifacts (built Setup.exe/.nupkg/RELEASES) are packaging
  // output, never runtime content. Matched at the root only so a module tree
  // such as packages/ui/dist/installers/** is legitimate and retained. The
  // exact `installers-invalid-` quarantine prefix is staging, mirroring the
  // `out-invalid-` rule above; a directory that merely starts with
  // "installers-invalid" (e.g. installers-invalidated) is not a quarantine.
  if (hasRootSegment(normalized, "installers")) push("dev-output");
  if (
    pathSegments(normalized)[0]?.startsWith(INSTALLERS_INVALID_PREFIX) === true
  ) {
    push("staging");
  }

  // Repository VCS metadata. Root-anchored to match the packaging policy: a
  // module tree that happens to contain a `.git` directory is not VCS metadata
  // and must not be flagged.
  if (hasRootSegment(normalized, ".git")) push("vcs");
  if (/^\.git(attributes|ignore|modules)$/i.test(base)) push("vcs");

  if (hasAnySegment(normalized, new Set(["node_modules"]))) push("node_modules");

  // Cross-check against the authoritative packaging ignore policy.
  if (isPackagedPathIgnored(`/${normalized}`)) push("forge-ignore-policy");

  return categories;
}

/**
 * Audit a full entry list. Deterministic: findings are sorted by entry.
 *
 * @param {readonly string[]} rawEntries raw asar entries
 * @param {readonly string[]} [emptyRuntime] normalized paths of required
 *   runtime files whose archive entry is empty (detected via the closure
 *   reader; raw entry strings carry no size information).
 * @param {{ missing?: string[]; empty?: string[] }} [closure] closure result
 *   from computeModuleClosure (missing/empty transitive module files).
 * @returns {{
 *   totalEntries: number;
 *   forbidden: Array<{ entry: string; categories: string[] }>;
 *   missingRuntime: string[];
 *   emptyRuntime: string[];
 *   hasRendererAssets: boolean;
 *   ok: boolean;
 * }}
 */
export function auditAsarEntries(
  rawEntries,
  emptyRuntime = [],
  closure = { missing: [], empty: [] }
) {
  const entries = rawEntries.map(normalizeAsarEntry).sort();
  const forbidden = entries
    .map((entry) => ({ entry, categories: forbiddenCategories(entry) }))
    .filter((item) => item.categories.length > 0);
  const present = new Set(entries);
  const missingRoot = requiredRuntimeRootFiles.filter(
    (entry) => !present.has(entry)
  );
  const missingRuntime = [...new Set([...missingRoot, ...(closure.missing ?? [])])].sort();
  const emptyRuntimeSorted = [
    ...new Set([...(emptyRuntime ?? []), ...(closure.empty ?? [])])
  ]
    .filter((entry) => present.has(entry))
    .sort();
  const hasRendererAssets = entries.some(isRendererAsset);
  const ok =
    forbidden.length === 0 &&
    missingRuntime.length === 0 &&
    emptyRuntimeSorted.length === 0 &&
    hasRendererAssets;
  return {
    totalEntries: entries.length,
    forbidden,
    missingRuntime,
    emptyRuntime: emptyRuntimeSorted,
    hasRendererAssets,
    ok
  };
}

/** Promise that resolves once the es-module-lexer WASM is ready. */
/** @type {Promise<void> | null} */
let moduleLexerReady = null;

/** @returns {Promise<void>} */
function ensureModuleLexer() {
  if (moduleLexerReady === null) {
    moduleLexerReady = initModuleLexer;
  }
  return moduleLexerReady;
}

/** @param {string | undefined} specifier */
function isRelative(specifier) {
  return specifier !== undefined && /^\.{1,2}\//.test(specifier);
}

/**
 * Fallback collector used only when es-module-lexer cannot parse a file (a
 * genuinely malformed chunk). The lexer is the primary parser; this legacy
 * regex pass is a defensive last resort so a valid-but-odd file never silently
 * loses its closure edges. It intentionally cannot match minified no-space
 * ESM (`import{x}from"./x.js"`), which the lexer handles.
 *
 * @param {string} source
 * @returns {string[]}
 */
function collectStaticImportSpecifiersWithRegex(source) {
  const specifiers = new Set();
  /** @param {string | undefined} specifier */
  const add = (specifier) => {
    if (isRelative(specifier)) specifiers.add(specifier);
  };
  for (const match of source.matchAll(
    /\bimport\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/g
  )) {
    add(match[1]);
  }
  for (const match of source.matchAll(
    /\bexport\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/g
  )) {
    add(match[1]);
  }
  for (const match of source.matchAll(
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  )) {
    add(match[1]);
  }
  for (const match of source.matchAll(
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
  )) {
    add(match[1]);
  }
  for (const match of source.matchAll(
    /__vite__mapDeps[^;]*?\(m\.f\s*\|\|\s*\(m\.f\s*=\s*\[([^\]]*)\]\)/g
  )) {
    const list = match[1];
    if (list === undefined) continue;
    for (const quoted of list.matchAll(/["']([^"']+)["']/g)) {
      add(quoted[1]);
    }
  }
  return [...specifiers];
}

/**
 * Collect relative module specifiers from a compiled JS/CJS source. ESM
 * import/export/dynamic-import statements are parsed with es-module-lexer (a
 * real ESM lexer, so minified no-space forms such as `import{x}from"./x.js"`,
 * `export*from"./x.js"` and `import("./chunk.js")` are all handled); CJS
 * `require("...")` and Vite's `__vite__mapDeps` module-preload dependency
 * lists are kept as complementary static patterns. Only relative (`./` or
 * `../`) specifiers are returned; bare package names and Node builtins are
 * external and never part of the app closure.
 *
 * @param {string} source
 * @returns {Promise<string[]>} unique relative specifiers
 */
export async function collectStaticImportSpecifiers(source) {
  const specifiers = new Set();
  /** @param {string | undefined} specifier */
  const add = (specifier) => {
    if (isRelative(specifier)) specifiers.add(specifier);
  };
  await ensureModuleLexer();
  try {
    const [imports] = parseModule(source);
    // Every import entry carries the specifier in `n` for static imports,
    // re-exports, and string-literal dynamic imports; `import.meta` and
    // non-literal dynamic imports have `n` undefined and are skipped. Bare
    // package names are filtered out by `add`.
    for (const entry of imports) {
      add(entry.n);
    }
  } catch {
    // Malformed/unparseable source: fall back to the legacy regex pass.
    return collectStaticImportSpecifiersWithRegex(source);
  }
  // CJS require("…")
  for (const match of source.matchAll(
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
  )) {
    add(match[1]);
  }
  // Vite module-preload dependency lists: const __vite__mapDeps=(…,d=(m.f||(m.f=["./a.js","./b.css"])))=>…
  for (const match of source.matchAll(
    /__vite__mapDeps[^;]*?\(m\.f\s*\|\|\s*\(m\.f\s*=\s*\[([^\]]*)\]\)/g
  )) {
    const list = match[1];
    if (list === undefined) continue;
    for (const quoted of list.matchAll(/["']([^"']+)["']/g)) {
      add(quoted[1]);
    }
  }
  return [...specifiers];
}

/**
 * Resolve a relative specifier against the importing file's directory to a
 * normalized POSIX path (no leading `./`). Returns null for non-relative
 * specifiers or for references that escape the archive root.
 *
 * @param {string} fromPath normalized POSIX path of the importing file
 * @param {string} specifier raw relative specifier
 * @returns {string | null}
 */
export function resolveModulePath(fromPath, specifier) {
  if (!/^\.{1,2}\//.test(specifier)) return null;
  const fromDir = path.posix.dirname(fromPath);
  const resolved = path.posix.normalize(path.posix.join(fromDir, specifier));
  if (resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
    return null;
  }
  return resolved;
}

/**
 * Collect relative script/link references from a renderer index.html.
 *
 * @param {string} html
 * @returns {string[]} relative src/href values
 */
export function collectHtmlAssets(html) {
  const refs = [];
  for (const match of html.matchAll(
    /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi
  )) {
    const value = match[1];
    if (value !== undefined && /^\.{1,2}\//.test(value)) refs.push(value);
  }
  return refs;
}

/**
 * Breadth-first module closure computation over an archive. Every reachable
 * file is recorded; missing and empty files are reported so a package whose
 * closure is broken can never be published.
 *
 * @param {ReadonlyArray<{ path: string }>} rootFiles
 * @param {(relPath: string) => { content: string; size: number } | null} readArchive
 * @returns {Promise<{
 *   closure: string[];
 *   missing: string[];
 *   empty: string[];
 * }>}
 */
export async function computeModuleClosure(rootFiles, readArchive) {
  const closure = new Set();
  const missing = new Set();
  const empty = new Set();
  const visited = new Set();
  const queue = rootFiles.map((root) => normalizeAsarEntry(root.path));
  while (queue.length > 0) {
    const rel = queue.shift();
    if (rel === undefined) continue;
    if (visited.has(rel)) continue;
    visited.add(rel);
    const entry = readArchive(rel);
    if (entry === null) {
      missing.add(rel);
      continue;
    }
    if (entry.size <= 0) empty.add(rel);
    closure.add(rel);
    const isJavaScript = /\.(?:js|cjs|mjs)$/i.test(rel);
    if (isJavaScript) {
      for (const specifier of await collectStaticImportSpecifiers(entry.content)) {
        const resolved = resolveModulePath(rel, specifier);
        if (resolved !== null && !visited.has(resolved)) queue.push(resolved);
      }
    }
    if (rel === "apps/desktop/dist/renderer/index.html") {
      for (const reference of collectHtmlAssets(entry.content)) {
        const resolved = resolveModulePath(rel, reference);
        if (resolved !== null && !visited.has(resolved)) queue.push(resolved);
      }
    }
  }
  return {
    closure: [...closure].sort(),
    missing: [...missing].sort(),
    empty: [...empty].sort()
  };
}

/**
 * Archive reader for @electron/asar: returns the file content and size, or
 * null when the file is absent.
 *
 * @param {string} asarPath
 * @returns {(relPath: string) => { content: string; size: number } | null}
 */
export function makeArchiveReader(asarPath) {
  return (relPath) => {
    try {
      const data = asar.extractFile(asarPath, relPath.replace(/\//g, path.sep));
      return { content: data.toString("utf8"), size: data.length };
    } catch {
      return null;
    }
  };
}

/**
 * Persist an audit report as pretty JSON at `reportPath`. The report parent
 * directory is created recursively so the report can be written even when the
 * working tree was freshly cloned without a `.scratch` directory.
 *
 * @param {string} reportPath
 * @param {AsarAuditReport} report
 */
export async function writeAsarAuditReport(reportPath, report) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
}

/**
 * Run the full audit against an app.asar (forbidden content + module closure +
 * renderer assets) and write a repeatable report. By default the report is
 * written to `.scratch/asar-audit-report.json`; callers may redirect it with
 * `options.reportPath` or fully replace the write with `options.writer`. The
 * report records the SOURCE asar path (`auditedSourcePath`) with its SHA-256
 * and size; the canonical published path (`publishedPath`) with its
 * fingerprint is appended by `finalizeAsarAuditReport` after the successful
 * publish.
 *
 * @param {string} asarPath
 * @param {{
 *   reportPath?: string;
 *   writer?: (reportPath: string, report: AsarAuditReport) => Promise<void>;
 * }} [options]
 * @returns {Promise<AsarAuditReport>} the audit report
 */
export async function reportAsarAudit(asarPath, options = {}) {
  const reportPath = options.reportPath ?? auditReportPath;
  const writer = options.writer ?? writeAsarAuditReport;
  let asarInfo;
  try {
    asarInfo = await stat(asarPath);
  } catch (error) {
    throw new Error(
      `Cannot audit "${asarPath}": the packaged app.asar does not exist. ` +
        "Run `npm run package:win` first; a missing package is not auditable.",
      { cause: error }
    );
  }
  const rawEntries = asar.listPackage(asarPath, { isPack: false });
  const readArchive = makeArchiveReader(asarPath);
  const closure = await computeModuleClosure(
    requiredRuntimeRootFiles.map((path) => ({ path })),
    readArchive
  );
  const result = auditAsarEntries(rawEntries, [], {
    missing: closure.missing,
    empty: closure.empty
  });
  const asarSha256 = await sha256File(asarPath);
  const report = {
    auditedSourcePath: asarPath,
    generatedAt: new Date().toISOString(),
    asarSizeBytes: asarInfo.size,
    asarSha256,
    ...result,
    closureFiles: closure.closure,
    ok:
      result.forbidden.length === 0 &&
      result.missingRuntime.length === 0 &&
      result.emptyRuntime.length === 0 &&
      result.hasRendererAssets
  };
  await writer(reportPath, report);
  return report;
}

/**
 * Append the canonical published path (`publishedPath`) and its fingerprint to
 * the audit report after the package was atomically published to `out`. The
 * published path must exist; its SHA-256 and size must match the audited
 * source, so the report always ties the evidence that was audited to the
 * package that actually became canonical. Reads and updates the report written
 * by `reportAsarAudit`; pass the same `options.reportPath`/`options.writer`
 * when the report was redirected away from the default path.
 *
 * @param {string} publishedAsarPath absolute canonical path (e.g.
 *   `F:/SWPanel/out/SWPanel-win32-x64/resources/app.asar`)
 * @param {{
 *   reportPath?: string;
 *   writer?: (reportPath: string, report: AsarAuditReport) => Promise<void>;
 * }} [options]
 * @returns {Promise<AsarAuditReport>} the updated audit report
 */
export async function finalizeAsarAuditReport(publishedAsarPath, options = {}) {
  const reportPath = options.reportPath ?? auditReportPath;
  const writer = options.writer ?? writeAsarAuditReport;
  const info = await stat(publishedAsarPath);
  if (!info.isFile() || info.size <= 0) {
    throw new Error(
      `Cannot finalize the audit report: published asar "${publishedAsarPath}" ` +
        "does not exist or is empty."
    );
  }
  const publishedSha256 = await sha256File(publishedAsarPath);
  const raw = await readFile(reportPath, "utf8");
  const report = JSON.parse(raw);
  if (
    report.asarSha256 !== publishedSha256 ||
    report.asarSizeBytes !== info.size
  ) {
    throw new Error(
      `Cannot finalize the audit report: published asar "${publishedAsarPath}" ` +
        `(${info.size} bytes, sha256 ${publishedSha256}) does not match the ` +
        `audited source "${report.auditedSourcePath}" ` +
        `(${report.asarSizeBytes} bytes, sha256 ${report.asarSha256}).`
    );
  }
  report.publishedPath = publishedAsarPath;
  report.publishedSha256 = publishedSha256;
  report.publishedSizeBytes = info.size;
  report.publishedAt = new Date().toISOString();
  await writer(reportPath, report);
  return report;
}

function isEntryPoint() {
  const invoked = process.argv[1];
  return (
    invoked !== undefined &&
    path.resolve(invoked) === fileURLToPath(import.meta.url)
  );
}

if (isEntryPoint()) {
  const asarPath = process.argv[2] ?? defaultAsarPath;
  try {
    const report = await reportAsarAudit(asarPath);
    console.log(`ASAR audit report: ${auditReportPath}`);
    console.log(`  asar: ${report.auditedSourcePath}`);
    console.log(`  size: ${report.asarSizeBytes} bytes`);
    console.log(`  sha256: ${report.asarSha256}`);
    console.log(`  generated: ${report.generatedAt}`);
    console.log(`  entries: ${report.totalEntries}`);
    console.log(`  closure files: ${report.closureFiles.length}`);
    console.log(`  forbidden findings: ${report.forbidden.length}`);
    for (const finding of report.forbidden) {
      console.log(`    - ${finding.entry} [${finding.categories.join(", ")}]`);
    }
    console.log(`  missing runtime entries: ${report.missingRuntime.length}`);
    for (const entry of report.missingRuntime) {
      console.log(`    - ${entry}`);
    }
    console.log(`  empty runtime entries: ${report.emptyRuntime.length}`);
    for (const entry of report.emptyRuntime) {
      console.log(`    - ${entry}`);
    }
    console.log(`  renderer assets present: ${report.hasRendererAssets}`);
    console.log(report.ok ? "AUDIT OK" : "AUDIT FAILED");
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
