import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditAsarEntries,
  collectHtmlAssets,
  collectStaticImportSpecifiers,
  computeModuleClosure,
  forbiddenCategories,
  isRendererAsset,
  makeArchiveReader,
  normalizeAsarEntry,
  requiredRuntimeRootFiles,
  resolveModulePath,
  sha256File,
  writeAsarAuditReport
} from "../scripts/audit-asar.mjs";

describe("normalizeAsarEntry", () => {
  it("normalizes Windows separators, leading slashes and trailing slashes", () => {
    expect(normalizeAsarEntry("\\apps\\desktop\\dist\\main\\main.js")).toBe(
      "apps/desktop/dist/main/main.js"
    );
    expect(normalizeAsarEntry("/apps/desktop/dist/main/main.js")).toBe(
      "apps/desktop/dist/main/main.js"
    );
    expect(normalizeAsarEntry("apps/desktop/dist/")).toBe("apps/desktop/dist");
  });
});

describe("renderer asset classification", () => {
  it("counts JS/CSS assets as renderer assets", () => {
    expect(
      isRendererAsset("apps/desktop/dist/renderer/assets/index-abc.js")
    ).toBe(true);
    expect(
      isRendererAsset("apps/desktop/dist/renderer/assets/index-abc.css")
    ).toBe(true);
  });

  it("excludes source maps", () => {
    expect(
      isRendererAsset("apps/desktop/dist/renderer/assets/index-abc.js.map")
    ).toBe(false);
  });

  it("excludes fonts (only fonts are not renderer assets)", () => {
    expect(
      isRendererAsset("apps/desktop/dist/renderer/assets/inter-400-normal.woff2")
    ).toBe(false);
    expect(
      isRendererAsset("apps/desktop/dist/renderer/assets/inter-400-normal.woff")
    ).toBe(false);
    expect(
      isRendererAsset("apps/desktop/dist/renderer/assets/font.otf")
    ).toBe(false);
  });

  it("does not count a file outside the renderer assets dir", () => {
    expect(isRendererAsset("apps/desktop/dist/main/main.js")).toBe(false);
  });
});

describe("forbiddenCategories", () => {
  it("flags source code outside dist", () => {
    expect(forbiddenCategories("apps/desktop/src/main.ts")).toContain("source");
    expect(forbiddenCategories("packages/domain/src/invariants.ts")).toContain(
      "source"
    );
    expect(forbiddenCategories("src/phase-zero.ts")).toContain("source");
  });

  it("flags docs, design and design source-of-truth copies", () => {
    expect(forbiddenCategories("docs/architecture.md")).toContain("docs");
    expect(forbiddenCategories(".design/pages/drawings.html")).toContain(
      "design"
    );
    expect(forbiddenCategories("dist/design-source/project.json")).toContain(
      "design"
    );
    expect(forbiddenCategories("SWPanel-UI-Design-Brief.md")).toContain(
      "design"
    );
  });

  it("flags tests, e2e and fixtures", () => {
    expect(forbiddenCategories("e2e/phase1.browser.spec.ts")).toContain("tests");
    expect(forbiddenCategories("packages/ui/dist/test/render.js")).toContain(
      "tests"
    );
    expect(forbiddenCategories("tests/fixtures/sample.json")).toContain("tests");
    expect(forbiddenCategories("apps/desktop/src/main.test.ts")).toContain(
      "tests"
    );
  });

  it("flags maps, declarations and build caches", () => {
    expect(
      forbiddenCategories("apps/desktop/dist/main/main.js.map")
    ).toContain("maps");
    expect(
      forbiddenCategories("packages/domain/dist/index.d.ts")
    ).toContain("declarations");
    expect(
      forbiddenCategories("packages/domain/dist/index.d.ts.map")
    ).toContain("declarations");
    expect(forbiddenCategories(".vite/deps/react.js")).toContain("cache");
    expect(forbiddenCategories(".eslintcache")).toContain("cache");
    expect(forbiddenCategories("out/tsconfig.tsbuildinfo")).toContain("cache");
  });

  it("flags db, CAD and runtime secret files", () => {
    expect(forbiddenCategories("db/swpanel.sqlite")).toContain("db");
    expect(forbiddenCategories("artifacts/drawing.sldprt")).toContain("cad");
    expect(forbiddenCategories("runtime/secrets.json")).toContain(
      "runtime-secrets"
    );
    expect(forbiddenCategories("workspaces/run-1/")).toContain(
      "runtime-secrets"
    );
    expect(forbiddenCategories(".env.production")).toContain("runtime-secrets");
    expect(forbiddenCategories(".env")).toContain("runtime-secrets");
    expect(forbiddenCategories("apps/desktop/.env")).toContain(
      "runtime-secrets"
    );
    expect(forbiddenCategories("secrets/signing.pem")).toContain(
      "runtime-secrets"
    );
    expect(forbiddenCategories("keys/app.key")).toContain("runtime-secrets");
    expect(forbiddenCategories("logs/app.log")).toContain("runtime-secrets");
    expect(forbiddenCategories("customer/alice/cost.json")).toContain(
      "runtime-secrets"
    );
    expect(forbiddenCategories(".local-data/state.json")).toContain(
      "runtime-secrets"
    );
  });

  it("restricts runtime-secrets to explicit workspace-root paths", () => {
    // Legitimate runtime modules under packages/domain/dist must not be
    // misclassified because their directory names look like runtime data.
    expect(
      forbiddenCategories("packages/domain/dist/artifacts/artifact.js")
    ).toHaveLength(0);
    expect(forbiddenCategories("packages/domain/dist/artifacts/")).toHaveLength(0);
    expect(forbiddenCategories("packages/domain/dist/runs/run.js")).toHaveLength(0);
    expect(forbiddenCategories("packages/domain/dist/runs/")).toHaveLength(0);
    expect(forbiddenCategories("apps/desktop/dist")).toHaveLength(0);
    expect(forbiddenCategories("packages/domain/dist")).toHaveLength(0);
    expect(forbiddenCategories("apps/runner/dist")).toHaveLength(0);
    expect(forbiddenCategories("packages/contracts/dist")).toHaveLength(0);
    expect(forbiddenCategories("packages/ui/dist")).toHaveLength(0);
  });

  it("keeps the WP5 runner db module directory as legitimate runtime code", () => {
    // The Runner ships its SQLite layer as a nested `db` module directory;
    // it is code, not runtime data, and must never be flagged.
    expect(forbiddenCategories("apps/runner/dist/db/database.js")).toHaveLength(0);
    expect(forbiddenCategories("apps/runner/dist/db/repository.js")).toHaveLength(0);
    expect(forbiddenCategories("apps/runner/dist/db/schema.js")).toHaveLength(0);
    expect(forbiddenCategories("apps/runner/dist/db")).toHaveLength(0);
    expect(forbiddenCategories("apps/runner/dist/db/")).toHaveLength(0);
    // A root-level db DATA directory and SQLite DATA files stay forbidden.
    expect(forbiddenCategories("db/")).toContain("runtime-secrets");
    expect(forbiddenCategories("db/swpanel.db")).toContain("db");
    expect(forbiddenCategories("state/swpanel.db-wal")).toContain("db");
  });

  it("flags dev tooling, staging snapshots, vcs metadata and node_modules", () => {
    expect(forbiddenCategories("scripts/package-win.mjs")).toContain(
      "devtooling"
    );
    expect(forbiddenCategories("forge.config.mjs")).toContain("devtooling");
    expect(forbiddenCategories("tsconfig.json")).toContain("devtooling");
    expect(forbiddenCategories(".scratch/asar-list.txt")).toContain("staging");
    expect(forbiddenCategories(".package-copy/out/app.asar")).toContain(
      "staging"
    );
    expect(forbiddenCategories("out-invalid-2026/app.asar")).toContain(
      "staging"
    );
    expect(forbiddenCategories(".git/index")).toContain("vcs");
    expect(forbiddenCategories(".gitignore")).toContain("vcs");
    expect(forbiddenCategories("node_modules/react/index.js")).toContain(
      "node_modules"
    );
  });

  it("flags ONLY the exact out-invalid- quarantine prefix as staging", () => {
    // The canonical quarantine prefix is `out-invalid-`. Directories that merely
    // START with "out-invalid" (no hyphen) are not packaging quarantines and
    // must never be flagged.
    expect(forbiddenCategories("out-invalid-2026/app.asar")).toContain(
      "staging"
    );
    expect(forbiddenCategories("out-invalid-/x")).toContain("staging");
    expect(forbiddenCategories("out-invalidated/app.asar")).toHaveLength(0);
    expect(forbiddenCategories("out-invalid/app.asar")).toHaveLength(0);
    expect(forbiddenCategories("out-invalidish/x.js")).toHaveLength(0);
    expect(
      forbiddenCategories("packages/ui/dist/out-invalid-2026/app.js")
    ).toHaveLength(0);
  });

  it("flags installer artifacts and their quarantine at the root only", () => {
    // Canonical root `installers` (built Setup.exe/.nupkg/RELEASES) is
    // packaging output, never runtime content.
    expect(
      forbiddenCategories("installers/SWPanel-0.1.0 Setup.exe")
    ).toContain("dev-output");
    expect(
      forbiddenCategories("installers/swpanel-0.1.0-full.nupkg")
    ).toContain("dev-output");
    expect(forbiddenCategories("installers/RELEASES")).toContain("dev-output");
    // The exact `installers-invalid-` quarantine prefix is staging.
    expect(
      forbiddenCategories("installers-invalid-2026/RELEASES")
    ).toContain("staging");
    expect(forbiddenCategories("installers-invalid-/x")).toContain("staging");
    // A module tree named installers is legitimate runtime content.
    expect(
      forbiddenCategories("packages/ui/dist/installers/x.js")
    ).toHaveLength(0);
    expect(
      forbiddenCategories("apps/desktop/dist/installers/marker.js")
    ).toHaveLength(0);
    // Directories that merely START with "installers-invalid" are not
    // installer quarantines and must never be flagged.
    expect(forbiddenCategories("installers-invalidated/x")).toHaveLength(0);
    expect(forbiddenCategories("installers-invalid/x")).toHaveLength(0);
    expect(forbiddenCategories("installers-invalidish/x.js")).toHaveLength(0);
  });

  it("reviewer counterexamples: legitimate files are never flagged", () => {
    // Loosely named tooling files that must ship as-is.
    expect(forbiddenCategories("apps/desktop/dist/vite.js")).toHaveLength(0);
    expect(forbiddenCategories("apps/desktop/dist/eslint.js")).toHaveLength(0);
    expect(forbiddenCategories("apps/desktop/dist/README.js")).toHaveLength(0);
    expect(forbiddenCategories("apps/desktop/dist/playwright.cjs")).toHaveLength(0);
    // A module directory that merely contains "test" in its name is runtime.
    expect(forbiddenCategories("packages/domain/dist/testing/harness.js")).toHaveLength(0);
    expect(forbiddenCategories("apps/desktop/dist/main/contestant.js")).toHaveLength(0);
    // .git as a segment name inside a shipped module tree is not VCS metadata.
    expect(forbiddenCategories("packages/ui/dist/components/.git/index.js")).toHaveLength(
      0
    );
    // Root-level dist directories are dev output, but workspace dists ship.
    expect(forbiddenCategories("dist/phase-zero.js")).toContain("dev-output");
    expect(forbiddenCategories("apps/desktop/dist/main/main.js")).toHaveLength(0);
  });

  it("leaves legitimate workspace runtime output clean", () => {
    expect(
      forbiddenCategories("apps/desktop/dist/main/main.js")
    ).toHaveLength(0);
    expect(
      forbiddenCategories("apps/desktop/dist/preload/preload.cjs")
    ).toHaveLength(0);
    expect(
      forbiddenCategories("apps/desktop/dist/renderer/index.html")
    ).toHaveLength(0);
    expect(
      forbiddenCategories("apps/desktop/dist/renderer/assets/index-x.js")
    ).toHaveLength(0);
    expect(forbiddenCategories("apps/runner/dist/index.js")).toHaveLength(0);
    expect(forbiddenCategories("packages/domain/dist/index.js")).toHaveLength(0);
    expect(
      forbiddenCategories("packages/contracts/dist/index.js")
    ).toHaveLength(0);
    expect(forbiddenCategories("packages/ui/dist/index.js")).toHaveLength(0);
    expect(forbiddenCategories("package.json")).toHaveLength(0);
  });
});

describe("auditAsarEntries", () => {
  // Mirrors the real packaged layout: directory entries plus the module
  // closure files the shipped app actually loads.
  const runtimeOnly = [
    "package.json",
    "apps/desktop/dist",
    "apps/desktop/dist/main",
    "apps/desktop/dist/main/main.js",
    "apps/desktop/dist/main/security.js",
    "apps/desktop/dist/preload",
    "apps/desktop/dist/preload/preload.cjs",
    "apps/desktop/dist/renderer",
    "apps/desktop/dist/renderer/index.html",
    "apps/desktop/dist/renderer/assets",
    "apps/desktop/dist/renderer/assets/index-x.js",
    "apps/desktop/dist/renderer/assets/inter-400.woff2",
    "apps/runner/dist",
    "apps/runner/dist/index.js",
    "apps/runner/dist/adaptation",
    "apps/runner/dist/adaptation/pdfium-rasterizer-helper.py",
    "packages/domain/dist",
    "packages/domain/dist/index.js",
    "packages/domain/dist/artifacts",
    "packages/domain/dist/artifacts/artifact.js",
    "packages/contracts/dist",
    "packages/contracts/dist/index.js",
    "packages/ui/dist",
    "packages/ui/dist/index.js"
  ];

  it("reports every required runtime root as required", () => {
    for (const entry of requiredRuntimeRootFiles) {
      expect(runtimeOnly).toContain(entry);
    }
  });

  it("passes a clean runtime-only package", () => {
    const report = auditAsarEntries(runtimeOnly);
    expect(report.ok).toBe(true);
    expect(report.forbidden).toHaveLength(0);
    expect(report.missingRuntime).toHaveLength(0);
    expect(report.emptyRuntime).toHaveLength(0);
    expect(report.hasRendererAssets).toBe(true);
  });

  it("passes when the renderer ships only fonts as assets (fonts do not count)", () => {
    const onlyFonts = [
      ...runtimeOnly.filter((entry) => !entry.includes("renderer/assets/")),
      "apps/desktop/dist/renderer/assets/inter-400.woff2"
    ];
    expect(auditAsarEntries(onlyFonts).hasRendererAssets).toBe(false);
    expect(auditAsarEntries(onlyFonts).ok).toBe(false);
    // A single JS asset makes it pass again.
    expect(
      auditAsarEntries([
        ...onlyFonts,
        "apps/desktop/dist/renderer/assets/index-x.js"
      ]).hasRendererAssets
    ).toBe(true);
  });

  it("flags forbidden content and reports each entry once with its categories", () => {
    const report = auditAsarEntries([
      ...runtimeOnly,
      "apps/desktop/src/main.ts",
      ".scratch/browser.log",
      "dist/design-source/project.json",
      "forge.config.mjs",
      "docs/architecture.md"
    ]);
    expect(report.ok).toBe(false);
    const entries = report.forbidden.map((f) => f.entry);
    expect(entries).toContain("apps/desktop/src/main.ts");
    expect(entries).toContain(".scratch/browser.log");
    expect(entries).toContain("dist/design-source/project.json");
    expect(entries).toContain("forge.config.mjs");
    expect(entries).toContain("docs/architecture.md");
    const scratchFinding = report.forbidden.find(
      (f) => f.entry === ".scratch/browser.log"
    );
    expect(scratchFinding?.categories).toContain("staging");
    expect(scratchFinding?.categories).toContain("forge-ignore-policy");
  });

  it("fails when a required runtime entry is missing or the renderer has no assets", () => {
    const withoutMain = auditAsarEntries(
      runtimeOnly.filter((e) => e !== "apps/desktop/dist/main/main.js")
    );
    expect(withoutMain.ok).toBe(false);
    expect(withoutMain.missingRuntime).toContain(
      "apps/desktop/dist/main/main.js"
    );

    const withoutAssets = auditAsarEntries(
      runtimeOnly.filter((e) => !e.includes("renderer/assets"))
    );
    expect(withoutAssets.hasRendererAssets).toBe(false);
    expect(withoutAssets.ok).toBe(false);
  });

  it("fails when a required runtime file entry is empty", () => {
    const report = auditAsarEntries(runtimeOnly, [
      "apps/desktop/dist/main/main.js"
    ]);
    expect(report.emptyRuntime).toContain("apps/desktop/dist/main/main.js");
    expect(report.ok).toBe(false);
  });

  it("fails when a transitive closure module is missing", () => {
    const report = auditAsarEntries(runtimeOnly, [], {
      missing: ["apps/desktop/dist/main/security.js"]
    });
    expect(report.missingRuntime).toContain("apps/desktop/dist/main/security.js");
    expect(report.ok).toBe(false);
  });

  it("is deterministic: sorted output regardless of input order", () => {
    const shuffled = [...runtimeOnly].reverse();
    const a = auditAsarEntries(shuffled);
    const b = auditAsarEntries(runtimeOnly);
    expect(a.forbidden).toEqual(b.forbidden);
    expect(a.missingRuntime).toEqual(b.missingRuntime);
  });
});

describe("static import specifiers", () => {
  it("collects relative ESM imports, re-exports and dynamic imports", async () => {
    const source = [
      'import path from "node:path";',
      'import { app } from "electron";',
      'import { x } from "./security.js";',
      'export * from "./drawings/drawing.js";',
      'export { y } from "../shared/util.js";',
      'const z = await import("./chunk-lazy.js");'
    ].join("\n");
    const specs = await collectStaticImportSpecifiers(source);
    expect(specs).toContain("./security.js");
    expect(specs).toContain("./drawings/drawing.js");
    expect(specs).toContain("../shared/util.js");
    expect(specs).toContain("./chunk-lazy.js");
    // Bare package names and builtins are never part of the app closure.
    expect(specs).not.toContain("node:path");
    expect(specs).not.toContain("electron");
  });

  it("collects minified Vite no-space ESM import/export/dynamic forms", async () => {
    const source =
      'import{x}from"./x.js";export*from"./y.js";export{y}from"./z.js";' +
      'const q=await import("./lazy.js");';
    const specs = await collectStaticImportSpecifiers(source);
    expect(specs).toContain("./x.js");
    expect(specs).toContain("./y.js");
    expect(specs).toContain("./z.js");
    expect(specs).toContain("./lazy.js");
  });

  it("handles Vite-style real chunk output with imports, mapDeps and a comment boundary", async () => {
    // A realistic Vite preload-facade chunk: no-space static import + re-export
    // (parsed by es-module-lexer), a dynamic import, and the classic
    // `__vite__mapDeps` dependency array with the `m.f||(m.f=[...])` default.
    const source =
      'import{d as e,f as i}from"./chunk-A.js";export*from"./chunk-B.js";' +
      'const p=await import("./chunk-C.js");' +
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./page-X.js","./page-X.css","./page-X-2.js"])))=>i.map(i=>d[i]);';
    const specs = await collectStaticImportSpecifiers(source);
    expect(specs).toContain("./chunk-A.js");
    expect(specs).toContain("./chunk-B.js");
    expect(specs).toContain("./chunk-C.js");
    expect(specs).toContain("./page-X.js");
    expect(specs).toContain("./page-X.css");
    expect(specs).toContain("./page-X-2.js");
  });

  it("collects relative CJS require specifiers", async () => {
    const specs = await collectStaticImportSpecifiers(
      'const a = require("./config.cjs");\nconst b = require("electron");'
    );
    expect(specs).toContain("./config.cjs");
    expect(specs).not.toContain("electron");
  });

  it("collects Vite module-preload dependency lists", async () => {
    const source =
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./A-B.js","./C.css","./D.woff2"])))=>i.map(i=>d[i]);';
    const specs = await collectStaticImportSpecifiers(source);
    expect(specs).toContain("./A-B.js");
    expect(specs).toContain("./C.css");
    expect(specs).toContain("./D.woff2");
  });

  it("ignores non-relative and malformed specifiers", async () => {
    const specs = await collectStaticImportSpecifiers(
      'import "./plain.js";\nimport "react" from "react";\nimport url from "./x.js";\nconst nope = require("fs");'
    );
    expect(specs).toContain("./plain.js");
    expect(specs).toContain("./x.js");
    expect(specs).not.toContain("react");
    expect(specs).not.toContain("fs");
  });
});

describe("resolveModulePath", () => {
  it("resolves ./ and ../ against the importing file directory", () => {
    expect(
      resolveModulePath("apps/desktop/dist/main/main.js", "./security.js")
    ).toBe("apps/desktop/dist/main/security.js");
    expect(
      resolveModulePath(
        "apps/desktop/dist/renderer/index.html",
        "./assets/index-x.js"
      )
    ).toBe("apps/desktop/dist/renderer/assets/index-x.js");
    expect(
      resolveModulePath("packages/domain/dist/index.js", "./runs/status.js")
    ).toBe("packages/domain/dist/runs/status.js");
  });

  it("returns null for non-relative specifiers and traversal escapes", () => {
    expect(resolveModulePath("a/b.js", "react")).toBeNull();
    expect(resolveModulePath("a/b.js", "../../outside.js")).toBeNull();
    expect(resolveModulePath("a/b.js", "/absolute.js")).toBeNull();
  });
});

describe("collectHtmlAssets", () => {
  it("collects relative script and stylesheet references from index.html", () => {
    const html =
      '<html><head><script type="module" crossorigin src="./assets/index-x.js"></script>' +
      '<link rel="stylesheet" crossorigin href="./assets/index.css"></head></html>';
    expect(collectHtmlAssets(html).sort()).toEqual([
      "./assets/index-x.js",
      "./assets/index.css"
    ]);
  });
});

describe("computeModuleClosure", () => {
  const rootFiles = [{ path: "apps/desktop/dist/main/main.js" }];
  const archive = new Map<string, string>([
    ["apps/desktop/dist/main/main.js", 'import { x } from "./security.js";'],
    ["apps/desktop/dist/main/security.js", "export const x = 1;"],
    [
      "apps/desktop/dist/renderer/index.html",
      '<script src="./assets/index-a.js"></script><link href="./assets/index-b.css">'
    ]
  ]);

  function readArchive(relPath: string): { content: string; size: number } | null {
    const content = archive.get(relPath);
    if (content === undefined) return null;
    return { content, size: content.length };
  }

  it("follows the transitive closure through imports and reports missing/empty files", async () => {
    const result = await computeModuleClosure(rootFiles, readArchive);
    expect(result.closure).toContain("apps/desktop/dist/main/main.js");
    expect(result.closure).toContain("apps/desktop/dist/main/security.js");
    expect(result.closure).not.toContain(
      "apps/desktop/dist/renderer/index.html"
    );
  });

  it("reports a missing imported module and an empty imported module", async () => {
    const withMissing = new Map(archive);
    withMissing.delete("apps/desktop/dist/main/security.js");
    const missingResult = await computeModuleClosure(rootFiles, (relPath) => {
      const content = withMissing.get(relPath);
      if (content === undefined) return null;
      return { content, size: content.length };
    });
    expect(missingResult.missing).toContain("apps/desktop/dist/main/security.js");

    const withEmpty = new Map(archive);
    withEmpty.set("apps/desktop/dist/main/security.js", "");
    const emptyResult = await computeModuleClosure(rootFiles, (relPath) => {
      const content = withEmpty.get(relPath);
      if (content === undefined) return null;
      return { content, size: content.length };
    });
    expect(emptyResult.empty).toContain("apps/desktop/dist/main/security.js");
  });

  it("handles renderer index.html script/link references recursively", async () => {
    const htmlArchive = new Map<string, string>([
      [
        "apps/desktop/dist/renderer/index.html",
        '<script type="module" src="./assets/index-a.js"></script>'
      ],
      [
        "apps/desktop/dist/renderer/assets/index-a.js",
        'import "./chunk.js";'
      ],
      ["apps/desktop/dist/renderer/assets/chunk.js", "export default 1;"]
    ]);
    const result = await computeModuleClosure(
      [{ path: "apps/desktop/dist/renderer/index.html" }],
      (relPath) => {
        const content = htmlArchive.get(relPath);
        if (content === undefined) return null;
        return { content, size: content.length };
      }
    );
    expect(result.closure).toContain(
      "apps/desktop/dist/renderer/assets/index-a.js"
    );
    expect(result.closure).toContain(
      "apps/desktop/dist/renderer/assets/chunk.js"
    );
    expect(result.missing).toEqual([]);
    expect(result.empty).toEqual([]);
  });

  it("fails the audit when a real minified chunk imports a file missing from the archive", async () => {
    // The archive contains only the entry chunk, which minified-imports
    // "./part.js"; that file is absent, so the closure must report it missing
    // and the audit must fail (missing file => not publishable).
    const chunkArchive = new Map<string, string>([
      [
        "apps/desktop/dist/renderer/assets/index-abc123.js",
        'import{render}from"./part.js";render();'
      ]
    ]);
    const closure = await computeModuleClosure(
      [{ path: "apps/desktop/dist/renderer/assets/index-abc123.js" }],
      (relPath) => {
        const content = chunkArchive.get(relPath);
        if (content === undefined) return null;
        return { content, size: content.length };
      }
    );
    expect(closure.missing).toContain(
      "apps/desktop/dist/renderer/assets/part.js"
    );
    const report = auditAsarEntries(
      [
        "apps/desktop/dist/renderer/assets/index-abc123.js",
        "apps/desktop/dist/renderer/index.html",
        "package.json",
        "apps/desktop/dist/main/main.js",
        "apps/desktop/dist/preload/preload.cjs",
        "apps/runner/dist/index.js",
        "packages/domain/dist/index.js",
        "packages/contracts/dist/index.js",
        "packages/ui/dist/index.js"
      ],
      [],
      { missing: closure.missing, empty: closure.empty }
    );
    expect(report.ok).toBe(false);
    expect(report.missingRuntime).toContain(
      "apps/desktop/dist/renderer/assets/part.js"
    );
  });

  it("reports no-space minified import/export targets missing from the archive", async () => {
    // A minified chunk with no whitespace between the keyword and the
    // specifier (`import{r}from"./a.js"`, `export*from"./b.js"`,
    // `export{v}from"./c.js"`) — the Vite-compressed forms es-module-lexer is
    // the only parser that can surface. Every target is absent, so the closure
    // must report each one missing and the audit must fail.
    const chunkArchive = new Map<string, string>([
      [
        "apps/desktop/dist/renderer/assets/index-abc123.js",
        'import{r}from"./part-a.js";export*from"./part-b.js";export{v}from"./part-c.js";r(v);'
      ]
    ]);
    const closure = await computeModuleClosure(
      [{ path: "apps/desktop/dist/renderer/assets/index-abc123.js" }],
      (relPath) => {
        const content = chunkArchive.get(relPath);
        if (content === undefined) return null;
        return { content, size: content.length };
      }
    );
    expect(closure.missing.sort()).toEqual([
      "apps/desktop/dist/renderer/assets/part-a.js",
      "apps/desktop/dist/renderer/assets/part-b.js",
      "apps/desktop/dist/renderer/assets/part-c.js"
    ]);
    const report = auditAsarEntries(
      [
        "apps/desktop/dist/renderer/assets/index-abc123.js",
        "apps/desktop/dist/renderer/index.html",
        "package.json",
        "apps/desktop/dist/main/main.js",
        "apps/desktop/dist/preload/preload.cjs",
        "apps/runner/dist/index.js",
        "apps/runner/dist/adaptation/pdfium-rasterizer-helper.py",
        "packages/domain/dist/index.js",
        "packages/contracts/dist/index.js",
        "packages/ui/dist/index.js"
      ],
      [],
      { missing: closure.missing, empty: closure.empty }
    );
    expect(report.ok).toBe(false);
    expect(report.missingRuntime).toEqual([
      "apps/desktop/dist/renderer/assets/part-a.js",
      "apps/desktop/dist/renderer/assets/part-b.js",
      "apps/desktop/dist/renderer/assets/part-c.js"
    ]);
  });

  it("reports a real current Vite index chunk's closure when a preloaded page chunk is missing", async () => {
    // The actual structure emitted by the current Vite build
    // (apps/desktop/dist/renderer/assets/index-uhLzrnO4.js): a `const
    // __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=[...])))=>i.map(i=>d[i])`
    // module-preload table plus a lazy-route facade that dynamic-imports
    // "./WorkbenchPage-Dazse4tm.js". The archive ships the index chunk and
    // every dependency EXCEPT the preloaded WorkbenchPage chunk, so the
    // closure must report exactly that one missing and the audit must fail.
    const preloadTargets = [
      "./WorkbenchPage-Dazse4tm.js",
      "./format-Czrgukhi.js",
      "./ids-2Gx-eITa.js",
      "./RunStatusBadge-CypQkGzb.js",
      "./status-COXYEGkc.js",
      "./StageProgress-Ce6fUZQc.js",
      "./page-data-B3e4g2hK.js",
      "./EmptyState-T_emGtiq.js",
      "./phase1-pages-DvvSeuaV.css",
      "./DrawingsPage-g8620Cc8.js"
    ];
    const chunkArchive = new Map<string, string>([
      [
        "apps/desktop/dist/renderer/assets/index-uhLzrnO4.js",
        'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["' +
          './WorkbenchPage-Dazse4tm.js","./format-Czrgukhi.js","./ids-2Gx-eITa.js",' +
          '"./RunStatusBadge-CypQkGzb.js","./status-COXYEGkc.js","./StageProgress-Ce6fUZQc.js",' +
          '"./page-data-B3e4g2hK.js","./EmptyState-T_emGtiq.js","./phase1-pages-DvvSeuaV.css",' +
          '"./DrawingsPage-g8620Cc8.js"])))=>i.map(i=>d[i]);' +
          '{id:"workbench",path:"/",title:"工作台",' +
          'load:()=>import("./WorkbenchPage-Dazse4tm.js").then(m=>m.WorkbenchPage)}'
      ],
      ["apps/desktop/dist/renderer/assets/format-Czrgukhi.js", "export default {};"],
      ["apps/desktop/dist/renderer/assets/ids-2Gx-eITa.js", "export default {};"],
      ["apps/desktop/dist/renderer/assets/RunStatusBadge-CypQkGzb.js", "export default {};"],
      ["apps/desktop/dist/renderer/assets/status-COXYEGkc.js", "export default {};"],
      ["apps/desktop/dist/renderer/assets/StageProgress-Ce6fUZQc.js", "export default {};"],
      ["apps/desktop/dist/renderer/assets/page-data-B3e4g2hK.js", "export default {};"],
      ["apps/desktop/dist/renderer/assets/EmptyState-T_emGtiq.js", "export default {};"],
      ["apps/desktop/dist/renderer/assets/phase1-pages-DvvSeuaV.css", "body{}"],
      ["apps/desktop/dist/renderer/assets/DrawingsPage-g8620Cc8.js", "export default {};"]
    ]);
    const closure = await computeModuleClosure(
      [{ path: "apps/desktop/dist/renderer/assets/index-uhLzrnO4.js" }],
      (relPath) => {
        const content = chunkArchive.get(relPath);
        if (content === undefined) return null;
        return { content, size: content.length };
      }
    );
    // Every preloaded asset except WorkbenchPage-Dazse4tm.js is present.
    expect(closure.missing).toEqual([
      "apps/desktop/dist/renderer/assets/WorkbenchPage-Dazse4tm.js"
    ]);
    for (const target of preloadTargets) {
      if (target === "./WorkbenchPage-Dazse4tm.js") continue;
      expect(closure.closure).toContain(
        `apps/desktop/dist/renderer/assets/${target.slice(2)}`
      );
    }
    const report = auditAsarEntries(
      [
        "apps/desktop/dist/renderer/assets/index-uhLzrnO4.js",
        "apps/desktop/dist/renderer/index.html",
        "package.json",
        "apps/desktop/dist/main/main.js",
        "apps/desktop/dist/preload/preload.cjs",
        "apps/runner/dist/index.js",
        "packages/domain/dist/index.js",
        "packages/contracts/dist/index.js",
        "packages/ui/dist/index.js"
      ],
      [],
      { missing: closure.missing, empty: closure.empty }
    );
    expect(report.ok).toBe(false);
    expect(report.missingRuntime).toContain(
      "apps/desktop/dist/renderer/assets/WorkbenchPage-Dazse4tm.js"
    );
  });
});

describe("makeArchiveReader", () => {
  it("returns a reader that returns null for missing files", () => {
    const reader = makeArchiveReader("definitely-not-a-real.asar");
    expect(reader("missing/file.js")).toBeNull();
  });
});

/**
 * Read a file's current contents, or null when it does not exist. Used to
 * assert that test runs never touch the workspace's default audit report.
 */
async function snapshotFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Build a minimal but valid app.asar (a single package.json entry) under
 * `base` and return its absolute path. It is missing most runtime roots, so
 * audits of it are NOT ok — fine for persistence tests.
 */
async function makeMinimalAsar(base: string): Promise<string> {
  const { createPackage } = await import("@electron/asar");
  const staging = path.join(base, "app");
  await mkdir(path.join(staging, "package-json-dir"), { recursive: true });
  await writeFile(path.join(staging, "package.json"), "{}");
  const asarPath = path.join(base, "app.asar");
  await createPackage(staging, asarPath);
  return asarPath;
}

describe("sha256File / audit report persistence", () => {
  it("computes the sha256 of a file", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-sha-"));
    try {
      const filePath = path.join(base, "sample.txt");
      await writeFile(filePath, "hello world");
      // SHA-256 of "hello world"
      expect(await sha256File(filePath)).toBe(
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("writes a report through the default writer (mkdir-recursive + pretty JSON)", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-writer-"));
    try {
      const reportPath = path.join(base, "nested", "dir", "report.json");
      // Full report shape (AsarAuditReport); only the arbitrary string fields
      // matter for the writer round-trip.
      const report = {
        auditedSourcePath: "sample",
        generatedAt: "2026-01-01T00:00:00.000Z",
        asarSizeBytes: 1,
        asarSha256: "a".repeat(64),
        totalEntries: 0,
        forbidden: [],
        missingRuntime: [],
        emptyRuntime: [],
        closureFiles: [],
        hasRendererAssets: false,
        ok: true
      };
      await writeAsarAuditReport(reportPath, report);
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("finalizes the audit report with the published path and fingerprint", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-final-"));
    try {
      const audit = await import("../scripts/audit-asar.mjs");
      const reportPath = path.join(base, "reports", "asar-audit-report.json");
      // Build a real (minimal) asar: a valid archive so listPackage/extract
      // work. It will be missing most runtime roots, but the audit report is
      // still written with the source path and its fingerprint.
      const sourceAsar = await makeMinimalAsar(base);

      const report = await audit.reportAsarAudit(sourceAsar, { reportPath });
      expect(report.auditedSourcePath).toBe(sourceAsar);
      expect(typeof report.asarSha256).toBe("string");
      expect(report.asarSha256).toHaveLength(64);
      expect(report.asarSizeBytes).toBeGreaterThan(0);
      expect(report.publishedPath).toBeUndefined();

      const publishedAsar = path.join(
        base,
        "out",
        "SWPanel-win32-x64",
        "resources",
        "app.asar"
      );
      await mkdir(path.dirname(publishedAsar), { recursive: true });
      await cp(sourceAsar, publishedAsar);
      const final = await audit.finalizeAsarAuditReport(publishedAsar, {
        reportPath
      });
      expect(final.publishedPath).toBe(publishedAsar);
      expect(final.publishedSha256).toBe(report.asarSha256);
      expect(final.publishedSizeBytes).toBe(report.asarSizeBytes);
      expect(typeof final.publishedAt).toBe("string");

      // The persisted report now contains the canonical fingerprint too.
      const persisted = JSON.parse(
        await readFile(reportPath, "utf8")
      ) as { publishedPath: string; publishedSha256: string };
      expect(persisted.publishedPath).toBe(publishedAsar);
      expect(persisted.publishedSha256).toBe(report.asarSha256);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("rejects finalization when the published asar differs from the audited source", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-final-"));
    try {
      const audit = await import("../scripts/audit-asar.mjs");
      const reportPath = path.join(base, "reports", "asar-audit-report.json");
      const sourceAsar = await makeMinimalAsar(base);

      await audit.reportAsarAudit(sourceAsar, { reportPath });

      const publishedAsar = path.join(
        base,
        "out",
        "SWPanel-win32-x64",
        "resources",
        "app.asar"
      );
      await mkdir(path.dirname(publishedAsar), { recursive: true });
      // Different content => different SHA-256 and size than the audited source.
      await writeFile(publishedAsar, "not the audited package");
      await expect(
        audit.finalizeAsarAuditReport(publishedAsar, { reportPath })
      ).rejects.toThrow(/does not match the audited source/);
      // The report on disk still describes the audited source only.
      const persisted = JSON.parse(
        await readFile(reportPath, "utf8")
      ) as { auditedSourcePath: string; publishedPath?: string };
      expect(persisted.auditedSourcePath).toBe(sourceAsar);
      expect(persisted.publishedPath).toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("writes to a custom reportPath and leaves the default report untouched", async () => {
    // Protection regression: passing reportPath must redirect the report away
    // from the workspace `.scratch/asar-audit-report.json` so test runs never
    // pollute the workspace artifact.
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-rpath-"));
    try {
      const audit = await import("../scripts/audit-asar.mjs");
      const sourceAsar = await makeMinimalAsar(base);
      const customPath = path.join(base, "reports", "audit.json");
      const defaultBefore = await snapshotFile(audit.auditReportPath);

      await audit.reportAsarAudit(sourceAsar, { reportPath: customPath });

      const persisted = JSON.parse(await readFile(customPath, "utf8")) as {
        auditedSourcePath: string;
      };
      expect(persisted.auditedSourcePath).toBe(sourceAsar);
      expect(await snapshotFile(audit.auditReportPath)).toBe(defaultBefore);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("honors a custom writer and never writes the default report", async () => {
    // Protection regression: the writer option fully replaces the write, so
    // even without reportPath the canonical workspace report is untouched.
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-writer-"));
    try {
      const audit = await import("../scripts/audit-asar.mjs");
      const sourceAsar = await makeMinimalAsar(base);
      const defaultBefore = await snapshotFile(audit.auditReportPath);
      const calls: Array<[string, unknown]> = [];
      const writer = (reportPath: string, report: unknown): Promise<void> => {
        calls.push([reportPath, report]);
        return Promise.resolve();
      };

      await audit.reportAsarAudit(sourceAsar, { writer });

      expect(calls).toHaveLength(1);
      // The writer receives the resolved (default) report path.
      expect(calls[0]?.[0]).toBe(audit.auditReportPath);
      const written = calls[0]?.[1] as { auditedSourcePath: string };
      expect(written.auditedSourcePath).toBe(sourceAsar);
      // Nothing was persisted to the workspace report.
      expect(await snapshotFile(audit.auditReportPath)).toBe(defaultBefore);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("finalize honors the same reportPath used for the audit", async () => {
    // Protection regression: reportAsarAudit and finalizeAsarAuditReport must
    // stay coupled on a custom reportPath, leaving the default untouched.
    const base = await mkdtemp(path.join(os.tmpdir(), "swpanel-frpath-"));
    try {
      const audit = await import("../scripts/audit-asar.mjs");
      const reportPath = path.join(base, "reports", "audit.json");
      const sourceAsar = await makeMinimalAsar(base);
      const defaultBefore = await snapshotFile(audit.auditReportPath);

      const report = await audit.reportAsarAudit(sourceAsar, { reportPath });
      const publishedAsar = path.join(base, "published", "app.asar");
      await mkdir(path.dirname(publishedAsar), { recursive: true });
      await cp(sourceAsar, publishedAsar);
      const final = await audit.finalizeAsarAuditReport(publishedAsar, {
        reportPath
      });

      expect(final.publishedPath).toBe(publishedAsar);
      const persisted = JSON.parse(await readFile(reportPath, "utf8")) as {
        publishedPath: string;
      };
      expect(persisted.publishedPath).toBe(publishedAsar);
      expect(await snapshotFile(audit.auditReportPath)).toBe(defaultBefore);
      expect(report.asarSha256).toBe(final.publishedSha256);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
