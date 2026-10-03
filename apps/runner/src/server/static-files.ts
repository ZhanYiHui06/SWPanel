import { createReadStream, lstatSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

/**
 * Serves the built renderer (the `vite build --mode web` output) from one
 * directory. The app uses hash routing, so only real files are served: `/` maps
 * to index.html and every other missing path is a plain 404. A request can never
 * leave `webRoot` (no `..`, no NUL, symlinks are resolved and re-checked).
 * Returns true when the request was answered.
 */
export function serveStaticFile(webRoot: string, req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); }
  catch { return false; }
  if (decoded.includes("\0") || decoded.includes("\\")) return false;
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const root = resolve(webRoot);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) return false;
  let real: string;
  try {
    real = realpathSync(target);
    if (!lstatSync(real).isFile()) return false;
  } catch { return false; }
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { return false; }
  if (!real.startsWith(realRoot + sep)) return false;
  const extension = extname(real).toLowerCase();
  const isIndex = extension === ".html";
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[extension] ?? "application/octet-stream",
    "Content-Length": lstatSync(real).size,
    "X-Content-Type-Options": "nosniff",
    // Entry HTML must always be revalidated; hashed assets never change.
    "Cache-Control": isIndex ? "no-store" : "public, max-age=31536000, immutable"
  });
  if (req.method === "HEAD") { res.end(); return true; }
  createReadStream(real).on("error", () => res.destroy()).pipe(res);
  return true;
}
