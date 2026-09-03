import { readFile } from "node:fs/promises";
import path from "node:path";

import type { BrowserWindowConstructorOptions, Session } from "electron";

/**
 * Restricted standard protocol that serves the production renderer. The
 * packaged app never loads the renderer over `file://`: a `file://` origin is
 * opaque/null, so a CSP `'self'` would match any file on disk and a compromised
 * renderer could read or execute files outside the application directory.
 *
 * Instead the renderer is served from `app://swpanel`, a `standard` + `secure`
 * scheme with a real origin (`app://swpanel`). CSP `'self'` therefore pins to
 * that single origin, and every resource request passes through
 * {@link createRendererProtocolHandler} which only maps canonical paths inside
 * the renderer output directory.
 */
export const APP_SCHEME = "app";
export const APP_HOST = "swpanel";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_PATH = "/index.html";
export const APP_ENTRY_URL = `${APP_ORIGIN}${APP_ENTRY_PATH}`;

export const DEVELOPMENT_RENDERER_ORIGIN = "http://127.0.0.1:5173";
export const DEVELOPMENT_RENDERER_URL = `${DEVELOPMENT_RENDERER_ORIGIN}/`;
export const DEVELOPMENT_WS_ORIGIN = "ws://127.0.0.1:5173";
export const REACT_REFRESH_PREAMBLE_HASH =
  "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='";

/**
 * The dedicated command-line argument that explicitly opts an UNPACKAGED launch
 * into the local development renderer. scripts/dev.mjs and the dev-mode
 * Electron smoke pass `--swpanel-development-renderer=http://127.0.0.1:5173/`.
 * Every production launch — packaged or loose, with any environment — never
 * passes it, and the main process still refuses to honor it when the app is
 * packaged. The argument carries the pinned URL as its value, so the parser
 * rejects duplicates, variant spellings and external targets in one place.
 */
export const DEVELOPMENT_RENDERER_CLI_FLAG = "--swpanel-development-renderer";

/**
 * The only port the development renderer may run on. The dev server is pinned
 * to `127.0.0.1:5173` (see apps/desktop/vite.config.ts), so the development
 * renderer argument is accepted only for that exact URL and nothing else (5174,
 * any other port).
 */
export const DEVELOPMENT_RENDERER_PORT = 5173;

function createContentSecurityPolicy(
  scriptSources: readonly string[],
  connectSources: readonly string[]
): string {
  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    `connect-src ${connectSources.join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'self'"
  ].join("; ");
}

export const CONTENT_SECURITY_POLICY = createContentSecurityPolicy(["'self'"], ["'self'"]);

export const DEVELOPMENT_CONTENT_SECURITY_POLICY = createContentSecurityPolicy(
  ["'self'", REACT_REFRESH_PREAMBLE_HASH],
  ["'self'", DEVELOPMENT_WS_ORIGIN]
);

/**
 * Loopback host allowed as the development renderer origin. The dev server is
 * pinned to `127.0.0.1:5173` (see apps/desktop/vite.config.ts), so this is a
 * single canonical host rather than a wildcard.
 */
export const ALLOWED_DEVELOPMENT_RENDERER_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1"
]);

/**
 * Reads the development-renderer CLI argument from the main-process argv and
 * returns the validated URL, or `undefined` when the argument is absent or
 * invalid. EXACTLY ONE canonical `--swpanel-development-renderer=<url>`
 * argument whose value passes {@link isAllowedDevelopmentRendererUrl} is
 * accepted; anything else — no argument, a duplicate, a variant spelling
 * (missing `=`, empty value, alternate/cased names, a separate value), or an
 * external URL — yields `undefined` so the packaged renderer is used. The
 * environment is never consulted: `SWPANEL_RENDERER_URL` and
 * `SWPANEL_DEVELOPMENT_RENDERER` (in any casing) are completely ignored in
 * every launch mode.
 */
export function readDevelopmentRendererCliArg(
  argv: readonly string[]
): string | undefined {
  const exactPrefix = `${DEVELOPMENT_RENDERER_CLI_FLAG}=`;
  const matches: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith(DEVELOPMENT_RENDERER_CLI_FLAG)) matches.push(arg);
  }
  if (matches.length !== 1) return undefined;
  const candidate = matches[0];
  if (candidate === undefined || !candidate.startsWith(exactPrefix)) return undefined;
  const value = candidate.slice(exactPrefix.length);
  if (value === "") return undefined;
  return isAllowedDevelopmentRendererUrl(value) ? value : undefined;
}

/**
 * Strict allowlist for the development-renderer override. Only the single
 * canonical development URL `http://127.0.0.1:5173/` is accepted. Anything
 * else — a different host, port (including 5174), credentials, path, query or
 * fragment — must be rejected so a hostile argument can never point the
 * renderer at an external or unusual target.
 */
export function isAllowedDevelopmentRendererUrl(target: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }

  if (url.protocol !== "http:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (!ALLOWED_DEVELOPMENT_RENDERER_HOSTS.has(url.hostname)) return false;
  if (url.port !== String(DEVELOPMENT_RENDERER_PORT)) return false;
  if (url.pathname !== "/") return false;
  if (url.search !== "" || url.hash !== "") return false;
  return true;
}

/**
 * The `app` scheme is a standard scheme, so it has a real origin in the
 * renderer. Node's WHATWG `URL` parser does not know the scheme is standard and
 * reports `origin === "null"` for it, so the origin must be derived explicitly
 * for the main-process navigation checks.
 */
function originOf(url: URL): string {
  if (url.protocol === "http:" || url.protocol === "https:") {
    return url.origin;
  }
  if (url.protocol === `${APP_SCHEME}:`) {
    return `${APP_SCHEME}://${url.hostname.toLowerCase()}`;
  }
  return url.origin;
}

/**
 * Canonical authority for the `app` scheme: protocol `app:`, the exact host
 * `swpanel`, NO port and NO username/password. The `app` scheme is registered
 * as standard + secure with a real origin, so the only valid authority is
 * `app://swpanel`; anything else (an explicit port, credentials, or a host
 * other than the exact `swpanel`) must be rejected. This is the authority gate
 * used by the protocol resolver, the origin derivation and the navigation
 * guard, so a canonical check in one place cannot be bypassed through another.
 */
export function isCanonicalAppAuthority(target: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  return (
    url.protocol === `${APP_SCHEME}:` &&
    url.hostname.toLowerCase() === APP_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

/**
 * The two origins the app may ever be on: the packaged `app://swpanel` origin
 * and the pinned local Vite development origin. Anything else (http(s)
 * external sites, `file:`, `app://` with a different host, a port, or
 * credentials) is not controlled. The app side routes through
 * {@link isCanonicalAppAuthority} so the single source of truth for the app
 * authority is enforced here too.
 */
export function isControlledAppOrigin(origin: string): boolean {
  return (
    isCanonicalAppAuthority(origin) ||
    origin === DEVELOPMENT_RENDERER_ORIGIN
  );
}

/**
 * Top-level navigation guard. Only same-entry hash navigation on a controlled
 * app origin is allowed: the target must share the current origin AND the
 * current pathname AND the current search, so only the hash (the app's router
 * state) may change. This closes the previous bypasses where `file://` host
 * (UNC) and query-string differences were accepted.
 */
export function isAllowedTopLevelNavigation(target: string, current: string): boolean {
  let targetUrl: URL;
  let currentUrl: URL;
  try {
    targetUrl = new URL(target);
    currentUrl = new URL(current);
  } catch {
    return false;
  }

  const targetOrigin = originOf(targetUrl);
  const currentOrigin = originOf(currentUrl);
  if (targetOrigin !== currentOrigin) return false;
  if (!isControlledAppOrigin(targetOrigin)) return false;
  // The derived origin drops the port and credentials for the non-special app
  // scheme, so an app: navigation must additionally prove the canonical
  // authority on the actual URL.
  if (targetUrl.protocol === `${APP_SCHEME}:` && !isCanonicalAppAuthority(target)) {
    return false;
  }
  if (currentUrl.protocol === `${APP_SCHEME}:` && !isCanonicalAppAuthority(current)) {
    return false;
  }
  if (targetUrl.pathname !== currentUrl.pathname) return false;
  if (targetUrl.search !== currentUrl.search) return false;
  return true;
}

export function contentSecurityPolicyForUrl(target: string): string {
  try {
    return new URL(target).origin === DEVELOPMENT_RENDERER_ORIGIN
      ? DEVELOPMENT_CONTENT_SECURITY_POLICY
      : CONTENT_SECURITY_POLICY;
  } catch {
    return CONTENT_SECURITY_POLICY;
  }
}

export function createWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      safeDialogs: true,
      spellcheck: false
    }
  };
}

const RENDERER_MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".mjs": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

/**
 * Resolves an `app://swpanel` request URL to a canonical absolute path inside
 * `rendererRoot`, or `null` when the request is not a valid contained resource.
 *
 * Rejects: a different protocol/host, any query or hash, path separators that
 * are not forward slashes, backslashes, percent-encoded traversal or empty
 * path segments, and every path whose canonical resolution escapes
 * `rendererRoot` (path traversal, UNC, drive-letter escape). The final
 * containment check uses `path.relative`, so `..`, `C:` drive prefixes and
 * `//server/share` forms can never alias outside the renderer directory.
 */
export function resolveRendererResource(target: string, rendererRoot: string): string | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }

  if (!isCanonicalAppAuthority(target)) return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (url.pathname.length <= 1) return null; // "/" or "" — no directory index
  if (url.pathname.includes("\\")) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;

  const relative = decoded.startsWith("/") ? decoded.slice(1) : decoded;
  if (relative === "") return null;
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }

  const candidate = path.resolve(rendererRoot, ...segments);
  const relativePath = path.relative(rendererRoot, candidate);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
  return candidate;
}

/**
 * Creates the `protocol.handle` handler for the `app` scheme. The handler only
 * serves files that {@link resolveRendererResource} proved to be inside
 * `rendererRoot`; every other request (traversal, other hosts, missing files)
 * gets a 404. File contents are read with the asar-aware `fs` API so the same
 * handler works both from a plain directory in development and from inside
 * `app.asar` in a packaged build.
 */
export function createRendererProtocolHandler(rendererRoot: string) {
  return async (request: Request): Promise<Response> => {
    const filePath = resolveRendererResource(request.url, rendererRoot);
    if (filePath === null) {
      return new Response("app://swpanel resource not found", { status: 404 });
    }
    try {
      const data = await readFile(filePath);
      const contentType =
        RENDERER_MIME_TYPES[path.extname(filePath).toLowerCase()] ??
        "application/octet-stream";
      return new Response(data, { headers: { "content-type": contentType } });
    } catch {
      return new Response("app://swpanel resource not found", { status: 404 });
    }
  };
}

export function installSessionSecurity(session: Session): void {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [contentSecurityPolicyForUrl(details.url)]
      }
    });
  });
}
