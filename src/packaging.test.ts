import { describe, expect, it } from "vitest";

import {
  isPackagedPathIgnored,
  PACKAGE_IGNORE_PATTERNS,
  SQUIRREL_MAKER_CONFIG
} from "../forge.config.mjs";

describe("Electron package filtering", () => {
  it("exports a non-empty Forge ignore policy", () => {
    expect(PACKAGE_IGNORE_PATTERNS.length).toBeGreaterThan(0);
  });

  it("provides the metadata required by the Squirrel nuspec", () => {
    expect(SQUIRREL_MAKER_CONFIG.authors).toBe("JANGHI");
    expect(SQUIRREL_MAKER_CONFIG.description).toBe(
      "江海冶金内部图纸自动建模与成本测算工作台"
    );
  });

  it.each([
    "/.design/pages/component-spec.html",
    "/.package-copy/out/SWPanel-win32-x64/resources/app.asar",
    "/.scratch/phase1-full-audit.json",
    "/apps/desktop/node_modules/.vite/deps/react.js",
    "/apps/desktop/node_modules/.vite-temp/chunk.js",
    "/packages/domain/dist/invariants.js.map",
    "/packages/domain/dist/invariants.d.ts",
    "/packages/domain/dist/invariants.d.ts.map",
    "/runtime/customer-secrets.json",
    "/db/swpanel.sqlite",
    "/logs/app.log",
    "/src/phase-zero.ts",
    "/tests/fixtures/sample.json",
    "/dist/design-source/project.json",
    "/dist/phase-zero.js",
    "/dist/phase-zero.d.ts",
    "/scripts/package-win.mjs",
    "/scripts/clean.mjs",
    "/scripts/build.mjs",
    "/scripts/dev.mjs",
    "/scripts/package-all.mjs",
    "/forge.config.mjs",
    "/tsconfig.json",
    "/tsconfig.build.json",
    "/vite.config.ts",
    "/vitest.config.js",
    "/eslint.config.js",
    "/playwright.config.ts",
    "/playwright.electron.production.config.ts",
    "/package-lock.json",
    "/out/SWPanel-win32-x64/resources/app.asar",
    "/out-invalid-2026-08-11/SWPanel-win32-x64/resources/app.asar",
    "/installers/SWPanel-0.1.0 Setup.exe",
    "/installers/swpanel-0.1.0-full.nupkg",
    "/installers/RELEASES",
    "/installers-invalid-2026-08-11/RELEASES",
    "/installers-invalid-x/Setup.exe",
    "/docs/engineering/architecture.md",
    "/e2e/phase1.browser.spec.ts",
    "/.gitignore",
    "/.gitattributes",
    "/SWPanel-UI-Design-Brief.md",
    "/README.md",
    "/CHANGELOG.md",
    "/CONTRIBUTING",
    "/.env",
    "/.env.production",
    "/.env.local",
    "/apps/desktop/.env",
    "/packages/domain/.env.test",
    "/secrets/signing.pem",
    "/keys/app.key",
    "/crash-dumps/2026-08-11.dmp",
    "/workspaces/run-1/",
    "/artifacts/cost-model.json",
    "/customer/alice/cost.json",
    "/.local-data/state.json"
  ])("ignores non-runtime path %s", (path) => {
    expect(isPackagedPathIgnored(path)).toBe(true);
  });

  it.each([
    // Real directory entries the shipped app must retain, including the
    // domain `artifacts` runtime module (a former ignore-policy false
    // positive) and workspace dist directory roots.
    "/apps/desktop/dist",
    "/apps/desktop/dist/main",
    "/apps/desktop/dist/main/main.js",
    "/apps/desktop/dist/main/security.js",
    "/apps/desktop/dist/preload",
    "/apps/desktop/dist/preload/preload.cjs",
    "/apps/desktop/dist/renderer",
    "/apps/desktop/dist/renderer/index.html",
    "/apps/desktop/dist/renderer/assets",
    "/apps/desktop/dist/renderer/assets/index-DTJUO-aq.js",
    "/apps/desktop/dist/renderer/assets/index-BEpGMuiZ.css",
    "/apps/desktop/dist/renderer/assets/inter-latin-400-normal-C38fXH4l.woff2",
    "/apps/runner/dist",
    "/apps/runner/dist/index.js",
    "/apps/runner/dist/adaptation",
    "/apps/runner/dist/adaptation/pdfium-rasterizer-helper.py",
    "/packages/domain/dist",
    "/packages/domain/dist/index.js",
    "/packages/domain/dist/artifacts",
    "/packages/domain/dist/artifacts/artifact.js",
    "/packages/domain/dist/cost/cost-data.js",
    "/packages/contracts/dist",
    "/packages/contracts/dist/index.js",
    "/packages/ui/dist",
    "/packages/ui/dist/index.js",
    "/packages/ui/dist/fonts.js",
    "/apps/desktop/dist/vite.js",
    "/apps/desktop/dist/eslint.js",
    "/apps/desktop/dist/README.js",
    "/apps/desktop/dist/playwright.cjs",
    "/packages/ui/dist/.git/index.js",
    "/apps/desktop/dist/README.md",
    "/apps/desktop/dist/CHANGELOG.txt",
    "/apps/desktop/dist/installers/marker.js",
    "/packages/ui/dist/installers/x.js"
  ])("retains required runtime path %s", (path) => {
    expect(isPackagedPathIgnored(path)).toBe(false);
  });

  it("reviewer counterexamples: loosely named tooling files are not ignored", () => {
    // Precise config-filename matching must not drop files that merely start
    // with a tool name.
    expect(isPackagedPathIgnored("/apps/desktop/dist/vite.js")).toBe(false);
    expect(isPackagedPathIgnored("/apps/desktop/dist/eslint.js")).toBe(false);
    expect(isPackagedPathIgnored("/apps/desktop/dist/README.js")).toBe(false);
    expect(isPackagedPathIgnored("/apps/desktop/dist/playwright.cjs")).toBe(
      false
    );
    // A module tree named .git is not the repository VCS metadata.
    expect(
      isPackagedPathIgnored("/packages/ui/dist/components/.git/index.js")
    ).toBe(false);
    expect(isPackagedPathIgnored("/packages/ui/dist/.gitattributes.js")).toBe(
      false
    );
  });

  it("repo rules are anchored to the workspace root only", () => {
    // The root out-invalid quarantine is ignored, but a package-internal
    // directory named out is retained.
    expect(isPackagedPathIgnored("/out-invalid-x/app.asar")).toBe(true);
    expect(isPackagedPathIgnored("/packages/ui/dist/out/thing.js")).toBe(false);
    // Root docs/e2e ignored; workspace-internal docs/e2e retained.
    expect(isPackagedPathIgnored("/docs/x.md")).toBe(true);
    expect(isPackagedPathIgnored("/packages/domain/dist/docs/x.md")).toBe(false);
    expect(isPackagedPathIgnored("/e2e/x.spec.ts")).toBe(true);
    expect(isPackagedPathIgnored("/packages/ui/dist/e2e/x.js")).toBe(false);
    // Compiled test output inside workspace dists is never runtime.
    expect(isPackagedPathIgnored("/packages/ui/dist/test/render.js")).toBe(true);
    expect(
      isPackagedPathIgnored("/packages/ui/dist/tests/spec.js")
    ).toBe(true);
    // A legitimate runtime module whose name merely contains "test" ships.
    expect(isPackagedPathIgnored("/packages/domain/dist/testing/harness.js")).toBe(false);
    expect(
      isPackagedPathIgnored("/apps/desktop/dist/main/contestant.js")
    ).toBe(false);
  });

  it("only the exact out-invalid- quarantine prefix is ignored", () => {
    // The canonical quarantine prefix is `out-invalid-` (with trailing hyphen).
    expect(isPackagedPathIgnored("/out-invalid-2026/app.asar")).toBe(true);
    expect(isPackagedPathIgnored("/out-invalid-/x")).toBe(true);
    // Directories that merely START with "out-invalid" are not packaging
    // quarantines and must be retained.
    expect(isPackagedPathIgnored("/out-invalidated/app.asar")).toBe(false);
    expect(isPackagedPathIgnored("/out-invalid/app.asar")).toBe(false);
    expect(isPackagedPathIgnored("/out-invalidish/x.js")).toBe(false);
  });

  it("only the exact installers-invalid- quarantine prefix is ignored", () => {
    // The canonical quarantine prefix is `installers-invalid-` (with trailing
    // hyphen), matching INSTALLERS_INVALID_PREFIX in scripts/installer.mjs.
    expect(isPackagedPathIgnored("/installers-invalid-2026/RELEASES")).toBe(
      true
    );
    expect(isPackagedPathIgnored("/installers-invalid-/x")).toBe(true);
    expect(
      isPackagedPathIgnored(
        "/installers-invalid-2026-08-11T10-01-59/SWPanel-0.1.0 Setup.exe"
      )
    ).toBe(true);
    // Directories that merely START with "installers-invalid" are not
    // installer quarantines and must be retained.
    expect(isPackagedPathIgnored("/installers-invalidated/x")).toBe(false);
    expect(isPackagedPathIgnored("/installers-invalid/x")).toBe(false);
    expect(isPackagedPathIgnored("/installers-invalidish/x.js")).toBe(false);
  });
});
