import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ALLOWED_DEVELOPMENT_RENDERER_HOSTS,
  APP_ENTRY_URL,
  APP_ORIGIN,
  CONTENT_SECURITY_POLICY,
  contentSecurityPolicyForUrl,
  createWindowOptions,
  DEVELOPMENT_CONTENT_SECURITY_POLICY,
  DEVELOPMENT_RENDERER_CLI_FLAG,
  DEVELOPMENT_RENDERER_ORIGIN,
  DEVELOPMENT_RENDERER_URL,
  DEVELOPMENT_WS_ORIGIN,
  isAllowedDevelopmentRendererUrl,
  isAllowedTopLevelNavigation,
  isCanonicalAppAuthority,
  isControlledAppOrigin,
  readDevelopmentRendererCliArg,
  REACT_REFRESH_PREAMBLE_HASH,
  resolveRendererResource
} from "./security.js";

describe("desktop security policy", () => {
  it("uses a sandboxed, isolated renderer without Node integration", () => {
    const options = createWindowOptions("C:\\app\\preload.cjs");

    expect(options.webPreferences).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    });
  });

  it("locks down active content and framing in the CSP", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain(REACT_REFRESH_PREAMBLE_HASH);
    expect(CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("ws://127.0.0.1");
  });

  it("pins only the local Vite websocket in the development CSP", () => {
    expect(DEVELOPMENT_CONTENT_SECURITY_POLICY).toContain(
      `connect-src 'self' ${DEVELOPMENT_WS_ORIGIN}`
    );
    expect(DEVELOPMENT_CONTENT_SECURITY_POLICY).not.toContain("ws://127.0.0.1:*");
  });

  it("selects the development CSP only for the pinned development origin", () => {
    expect(contentSecurityPolicyForUrl(`${DEVELOPMENT_RENDERER_ORIGIN}/@vite/client`)).toBe(
      DEVELOPMENT_CONTENT_SECURITY_POLICY
    );
    expect(DEVELOPMENT_CONTENT_SECURITY_POLICY).toContain(
      `script-src 'self' ${REACT_REFRESH_PREAMBLE_HASH}`
    );
    expect(DEVELOPMENT_CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");

    // The packaged renderer origin gets the strict production CSP.
    expect(contentSecurityPolicyForUrl(APP_ENTRY_URL)).toBe(CONTENT_SECURITY_POLICY);
    expect(contentSecurityPolicyForUrl("file:///F:/SWPanel/dist/renderer/index.html")).toBe(
      CONTENT_SECURITY_POLICY
    );
    expect(contentSecurityPolicyForUrl("http://localhost:5173/")).toBe(
      CONTENT_SECURITY_POLICY
    );
    expect(contentSecurityPolicyForUrl("not a URL")).toBe(CONTENT_SECURITY_POLICY);
  });

  it("accepts exactly one canonical development-renderer CLI argument", () => {
    expect(DEVELOPMENT_RENDERER_CLI_FLAG).toBe("--swpanel-development-renderer");
    expect(
      readDevelopmentRendererCliArg([
        "electron.exe",
        "apps/desktop/dist/main/main.js",
        "--swpanel-development-renderer=http://127.0.0.1:5173/"
      ])
    ).toBe(DEVELOPMENT_RENDERER_URL);
    // The URL parser normalizes the bare origin to pathname "/", so the value
    // is accepted; the raw argv value is returned unchanged.
    expect(
      readDevelopmentRendererCliArg([
        "--swpanel-development-renderer=http://127.0.0.1:5173"
      ])
    ).toBe("http://127.0.0.1:5173");
  });

  it("rejects duplicate development-renderer CLI arguments", () => {
    expect(
      readDevelopmentRendererCliArg([
        "--swpanel-development-renderer=http://127.0.0.1:5173/",
        "--swpanel-development-renderer=http://127.0.0.1:5173/"
      ])
    ).toBeUndefined();
  });

  it("rejects variant development-renderer CLI arguments", () => {
    // Separate-value form (flag, then the URL as the next argv element).
    expect(
      readDevelopmentRendererCliArg([
        "--swpanel-development-renderer",
        "http://127.0.0.1:5173/"
      ])
    ).toBeUndefined();
    // Empty value.
    expect(
      readDevelopmentRendererCliArg(["--swpanel-development-renderer="])
    ).toBeUndefined();
    // Alternate/cased spellings and flag extensions never match the exact flag.
    expect(
      readDevelopmentRendererCliArg([
        "--SWPANEL-DEVELOPMENT-RENDERER=http://127.0.0.1:5173/"
      ])
    ).toBeUndefined();
    expect(
      readDevelopmentRendererCliArg([
        "--swpanel_development_renderer=http://127.0.0.1:5173/"
      ])
    ).toBeUndefined();
    expect(
      readDevelopmentRendererCliArg([
        "--swpanel-development-renderer-extra=http://127.0.0.1:5173/"
      ])
    ).toBeUndefined();
  });

  it("rejects an external development-renderer CLI argument", () => {
    expect(
      readDevelopmentRendererCliArg([
        "--swpanel-development-renderer=https://example.com/"
      ])
    ).toBeUndefined();
  });

  it("returns undefined without the dedicated CLI argument", () => {
    expect(readDevelopmentRendererCliArg([])).toBeUndefined();
    expect(readDevelopmentRendererCliArg(["electron.exe", "main.js"])).toBeUndefined();
    expect(
      readDevelopmentRendererCliArg(["--unrelated=http://127.0.0.1:5173/"])
    ).toBeUndefined();
  });

  it("allows only the single canonical development renderer URL", () => {
    expect(isAllowedDevelopmentRendererUrl(DEVELOPMENT_RENDERER_URL)).toBe(true);
    // The URL parser normalizes the bare origin to pathname "/", and
    // scripts/dev.mjs supplies this exact no-slash form.
    expect(isAllowedDevelopmentRendererUrl("http://127.0.0.1:5173")).toBe(true);
    expect(ALLOWED_DEVELOPMENT_RENDERER_HOSTS.has("127.0.0.1")).toBe(true);
  });

  it.each([
    "https://127.0.0.1:5173/",
    "http://localhost:5173/",
    "http://192.168.0.10:5173/",
    "http://example.com/",
    "http://example.com:5173/",
    "http://127.0.0.1/",
    "http://127.0.0.1:80/",
    "http://127.0.0.1:1023/",
    "http://127.0.0.1:5174/",
    "http://127.0.0.1:65536/",
    "http://127.0.0.1:5173/app",
    "http://127.0.0.1:5173/?scenario=clarification-open",
    "http://127.0.0.1:5173/#/settings",
    "http://user:pass@127.0.0.1:5173/",
    "file:///F:/SWPanel/apps/desktop/dist/renderer/index.html",
    "file:///C:/Windows/System32/config.html",
    "not a URL",
    ""
  ])("rejects development renderer URL %s", (target) => {
    expect(isAllowedDevelopmentRendererUrl(target)).toBe(false);
  });

  it("recognizes only the controlled app origins", () => {
    expect(isControlledAppOrigin(APP_ORIGIN)).toBe(true);
    expect(isControlledAppOrigin(DEVELOPMENT_RENDERER_ORIGIN)).toBe(true);
    expect(isControlledAppOrigin("app://evil")).toBe(false);
    expect(isControlledAppOrigin("https://example.com")).toBe(false);
    expect(isControlledAppOrigin("null")).toBe(false);
  });

  it("allows same-entry hash navigation on the development origin", () => {
    expect(
      isAllowedTopLevelNavigation(
        `${DEVELOPMENT_RENDERER_ORIGIN}/#settings`,
        `${DEVELOPMENT_RENDERER_ORIGIN}/#drawings`
      )
    ).toBe(true);
  });

  it("allows same-entry hash navigation on the app origin", () => {
    expect(
      isAllowedTopLevelNavigation(
        `${APP_ENTRY_URL}#/runs/run-r05`,
        `${APP_ENTRY_URL}#/drawings`
      )
    ).toBe(true);
    expect(
      isAllowedTopLevelNavigation(`${APP_ENTRY_URL}#/drawings`, APP_ENTRY_URL)
    ).toBe(true);
  });

  it.each([
    [
      "external origin",
      "https://example.com/",
      `${DEVELOPMENT_RENDERER_ORIGIN}/`
    ],
    ["different pathname", `${DEVELOPMENT_RENDERER_ORIGIN}/app`, `${DEVELOPMENT_RENDERER_ORIGIN}/`],
    ["query change", `${DEVELOPMENT_RENDERER_ORIGIN}/?scenario=x#/runs`, `${DEVELOPMENT_RENDERER_ORIGIN}/`],
    ["file target", "file:///F:/Windows/System32/config.html", `${DEVELOPMENT_RENDERER_ORIGIN}/`],
    [
      "file UNC target",
      "file://server/share/index.html",
      `${DEVELOPMENT_RENDERER_ORIGIN}/`
    ],
    [
      "different app pathname",
      `${APP_ORIGIN}/other.html#/x`,
      `${APP_ENTRY_URL}#/drawings`
    ],
    ["app query change", `${APP_ENTRY_URL}?scenario=x#/runs`, `${APP_ENTRY_URL}#/drawings`],
    ["app host swap", `${APP_ORIGIN.replace("swpanel", "evil")}/index.html#/x`, `${APP_ENTRY_URL}#/drawings`],
    ["app port", `${APP_ORIGIN}:8080/index.html#/x`, `${APP_ENTRY_URL}#/drawings`],
    ["app credentials", `${APP_ORIGIN.replace("://", "://user:pass@")}/index.html#/x`, `${APP_ENTRY_URL}#/drawings`],
    ["app to file", "file:///C:/Windows/System32/config.html", `${APP_ENTRY_URL}#/drawings`],
    ["app to http", "https://example.com/", `${APP_ENTRY_URL}#/drawings`]
  ])("rejects navigation on %s", (_label, target, current) => {
    expect(isAllowedTopLevelNavigation(target, current)).toBe(false);
  });
});

describe("app://swpanel protocol containment", () => {
  const rendererRoot = path.join("V:", "swpanel", "renderer");

  it("accepts only the canonical app authority with no port or credentials", () => {
    expect(isCanonicalAppAuthority("app://swpanel/index.html")).toBe(true);
    expect(isCanonicalAppAuthority("app://SWPANEL/assets/app.js")).toBe(true);
    expect(isCanonicalAppAuthority("app://swpanel")).toBe(true);
  });

  it.each([
    "app://swpanel:8080/index.html",
    "app://swpanel:443/index.html",
    "app://user:pass@swpanel/index.html",
    "app://user@swpanel/index.html",
    "app://swpanel@evil/index.html",
    "app://swpanel.evil.com/index.html",
    "app://evil/index.html",
    "http://swpanel/index.html",
    "https://swpanel/index.html",
    "file:///F:/SWPanel/index.html",
    "not a URL"
  ])("rejects non-canonical app authority %s", (target) => {
    expect(isCanonicalAppAuthority(target)).toBe(false);
  });

  it("routes the app-origin check through the canonical authority", () => {
    expect(isControlledAppOrigin(APP_ORIGIN)).toBe(true);
    expect(isControlledAppOrigin("app://SWPANEL")).toBe(true);
    expect(isControlledAppOrigin("app://swpanel:8080")).toBe(false);
    expect(isControlledAppOrigin("app://user@swpanel")).toBe(false);
    expect(isControlledAppOrigin("app://swpanel.evil.com")).toBe(false);
    expect(isControlledAppOrigin(DEVELOPMENT_RENDERER_ORIGIN)).toBe(true);
  });

  it("serves only canonical paths inside the renderer root", () => {
    expect(resolveRendererResource("app://swpanel/index.html", rendererRoot)).toBe(
      path.join(rendererRoot, "index.html")
    );
    expect(
      resolveRendererResource("app://swpanel/assets/app.js", rendererRoot)
    ).toBe(path.join(rendererRoot, "assets", "app.js"));
    expect(
      resolveRendererResource("app://SWPANEL/assets/app.js", rendererRoot)
    ).toBe(path.join(rendererRoot, "assets", "app.js"));
  });

  it("normalizes traversal attempts back inside the renderer root", () => {
    // The standard-scheme URL parser collapses `..`/`.%2e` before the handler
    // sees the request, so these can never escape the root.
    expect(resolveRendererResource("app://swpanel/../package.json", rendererRoot)).toBe(
      path.join(rendererRoot, "package.json")
    );
    expect(resolveRendererResource("app://swpanel/%2e%2e/package.json", rendererRoot)).toBe(
      path.join(rendererRoot, "package.json")
    );
    expect(
      resolveRendererResource("app://swpanel/assets/%2e%2e/%2e%2e/package.json", rendererRoot)
    ).toBe(path.join(rendererRoot, "package.json"));
  });

  it.each([
    "https://example.com/index.html",
    "file:///C:/Windows/win.ini",
    "file:///F:/SWPanel/package.json",
    "file://server/share/index.html",
    "app://evil/index.html",
    "app://swpanel:8080/index.html",
    "app://user:pass@swpanel/index.html",
    "app://user@swpanel/index.html",
    "app://swpanel@evil/index.html",
    "app://swpanel.evil.com/index.html",
    "app://swpanel/",
    "app://swpanel",
    "app://swpanel/index.html?scenario=x",
    "app://swpanel/index.html#/settings",
    "app://swpanel/../../..//C:/Windows/win.ini",
    "app://swpanel//etc/passwd",
    "app://swpanel/index%2f..%2fpackage.json",
    "app://swpanel/..%5c..%5cpackage.json",
    "app://swpanel/..\\..\\package.json"
  ])("rejects non-contained resource %s", (target) => {
    expect(resolveRendererResource(target, rendererRoot)).toBeNull();
  });
});
