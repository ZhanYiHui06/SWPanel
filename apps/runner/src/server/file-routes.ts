import type { IncomingMessage, ServerResponse } from "node:http";
import type { Runner } from "../runner.js";
import { RunnerError } from "../errors.js";
import type { RegisteredFile } from "../artifacts/registered-file.js";

/** Call after the WebServer origin gate; only identity-bound registered files are served. */
export function handleFileRequest(runner: Runner, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const model = /^\/api\/models\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname);
  const drawing = /^\/api\/drawings\/([^/]+)\/revisions\/([^/]+)\/source$/.exec(url.pathname);
  if (model === null && drawing === null) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return true;
  }
  let ids: [string, string];
  try {
    const match = (model ?? drawing)!;
    ids = [decodeURIComponent(match[1]!), decodeURIComponent(match[2]!)];
  } catch {
    sendFileError(res, 400, "INVALID_REQUEST", "请求地址格式无效");
    return true;
  }
  try {
    let file: RegisteredFile;
    if (model !== null) file = runner.readModelArtifact(ids[0], ids[1]);
    else file = runner.readDrawingSource(ids[0], ids[1]);
    const download = url.searchParams.get("download") === "1" || file.mimeType === "application/octet-stream";
    const fallbackName = file.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    // RFC 5987 / RFC 8187: percent-encode everything outside attr-char (encodeURIComponent leaves ' ( ) * unescaped).
    const encodedName = encodeURIComponent(file.fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    res.writeHead(200, {
      "Content-Type": file.mimeType,
      "Content-Length": file.content.length,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "sandbox"
    });
    res.end(req.method === "HEAD" ? undefined : file.content);
  } catch (error) {
    const code = error instanceof RunnerError ? error.code
      : (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "LEDGER_FILE_MISSING" : "FILE_UNAVAILABLE";
    if (code === "NOT_FOUND" || code === "LEDGER_FILE_MISSING") sendFileError(res, 404, code, "文件不存在或已被删除");
    else sendFileError(res, 400, code, "文件完整性验证失败");
  }
  return true;
}

function sendFileError(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: { code, message } }));
}
