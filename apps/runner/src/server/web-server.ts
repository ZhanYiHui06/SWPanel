import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IPC_PROTOCOL_VERSION,
  IpcValidationError,
  validateIpcRequestEnvelope,
  type IpcRequestEnvelope,
  type IpcResponseEnvelope
} from "@swpanel/contracts";
import type { DrawingFileFormat, RunEvent } from "@swpanel/domain";
import { Runner, DEFAULT_RUN_PROFILE, type RunnerConfig } from "../runner.js";
import { RunnerRequestHandler } from "../ipc/request-handler.js";
import { RunnerError } from "../errors.js";
import { SettingsInputError, SettingsService } from "./settings-service.js";
import { toPublicError } from "./public-errors.js";
import { handleFileRequest } from "./file-routes.js";

/**
 * The single place that decides which Runner operations may be reached over HTTP.
 * Everything else in the contracts (storage.updateSettings, secrets.*,
 * model.openInSolidWorks, ...) is desktop-only or implemented elsewhere
 * (credentials live behind /api/settings/api-key) and is refused with
 * OPERATION_NOT_AVAILABLE after envelope validation.
 */
export const WEB_QUERY_ALLOWLIST: ReadonlySet<string> = new Set([
  "drawing.getDeletionImpact", "model.getDeletionImpact", "drawing.getDetail", "drawing.getHistory",
  "revision.getDetail", "revision.getHistory", "run.getDetail", "run.list", "model.getDetail",
  "clarification.get", "costReport.getDetail", "costReport.listByRevision", "workspace.getDashboard",
  "costData.get",
  // Read-only display of storage locations; writing them is not a Web capability.
  "storage.getSettings"
]);
export const WEB_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  "drawing.create", "drawing.createRevision", "drawing.setCurrentRevision", "drawing.addRevisionFact",
  "drawing.addModelingFeedback", "drawing.deleteRevision", "drawing.delete", "run.create", "run.cancel",
  "run.delete", "clarification.submit", "model.review", "model.delete", "costData.update",
  "costReport.create", "costReport.delete", "system.getRecoveryStatus"
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);
const DEFAULT_MAX_STAGED_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_UPLOADS = 3;
const DEFAULT_MAX_SSE = 64;
const DEFAULT_MAX_SSE_PER_RUN = 16;
const DEFAULT_SSE_BUFFER_BYTES = 4 * 1024 * 1024;

/** True when binding to this host exposes the unauthenticated API beyond the local machine. */
export function isExposedHost(host: string): boolean {
  return !LOOPBACK_HOSTS.has(host.toLowerCase());
}

export interface WebServerOptions {
  port?: number;
  host?: string;
  dataRoot: string;
  /** Server-side injection only. No client may select a synthetic execution scenario. */
  runnerConfig?: RunnerConfig;
  allowedOrigins?: readonly string[];
  maxUploadBytes?: number;
  maxRequestBytes?: number;
  uploadTokenTtlMs?: number;
  settingsService?: SettingsService;
  /** Extra Host header names (hostname or hostname:port) accepted besides loopback and `host`. */
  allowedHosts?: readonly string[];
  /** Concurrent /api/upload requests (default 3) and total staged bytes (default 200 MiB). */
  maxConcurrentUploads?: number;
  maxStagedBytes?: number;
  /** SSE caps: all connections (default 64), per Run (default 16), and unsent bytes before a slow client is dropped (default 4 MiB). */
  maxSseClients?: number;
  maxSseClientsPerRun?: number;
  sseBufferLimitBytes?: number;
}

export interface StagedWebFile {
  token: string;
  tempPath: string;
  fileName: string;
  format: DrawingFileFormat;
  sizeBytes: number;
  sha256: string;
  expiresAt: number;
}

class WebRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

interface CachedCommand {
  fingerprint: string;
  response: Promise<IpcResponseEnvelope>;
  expiresAt: number;
}

interface SseClient {
  response: ServerResponse;
  nextSequence: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** HTTP transport of the existing business contract; SQLite remains Runner-owned. */
export class WebServer {
  readonly serverInstanceId = randomUUID();
  private readonly server: ReturnType<typeof createServer>;
  private readonly runner: Runner;
  private readonly handler: RunnerRequestHandler;
  private readonly settings: SettingsService;
  private readonly stagedFiles = new Map<string, StagedWebFile>();
  private readonly sseClients = new Map<string, Set<SseClient>>();
  private readonly commands = new Map<string, CachedCommand>();
  private readonly pendingCleanup = new Set<string>();
  private readonly unsubscribeEvents: () => void;
  private uploadRoot: string | null = null;
  private maintenance: ReturnType<typeof setInterval> | null = null;
  private stopping: Promise<void> | null = null;
  private activeUploads = 0;
  private sseClientCount = 0;
  private lastMaintenanceLog = 0;

  constructor(private readonly options: WebServerOptions) {
    // A database-backed Web page is not proof of a working CAD execution environment.
    // Until a real worker is configured, persist Run failures at PREPARING instead of
    // publishing the Runner's default synthetic success artifacts.
    this.runner = new Runner(options.dataRoot, options.runnerConfig ?? {
      runProfile: { ...DEFAULT_RUN_PROFILE, agentConfigId: "web-worker-unconfigured" },
      preflight: {
        synthetic: false,
        run: () => ({
          ok: false,
          failedCapability: "agent_runtime_available",
          checks: [{ capability: "agent_runtime_available", ok: false }]
        })
      }
    });
    this.handler = new RunnerRequestHandler(this.runner);
    this.settings = options.settingsService ?? new SettingsService({ dataRoot: options.dataRoot });
    this.unsubscribeEvents = this.runner.subscribeRunEventCommits((events) => {
      for (const event of events) {
        for (const client of [...(this.sseClients.get(event.runId) ?? [])]) this.sendEvent(client, event);
      }
    });
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch(() => res.destroy());
    });
  }

  async start(): Promise<{ port: number; host: string }> {
    const port = this.options.port ?? 3001;
    const host = this.options.host ?? "127.0.0.1";
    this.runner.open();
    try {
      this.uploadRoot = mkdtempSync(join(tmpdir(), "swpanel-web-uploads-"));
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(port, host, () => {
          this.server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (error) {
      await this.runner.shutdown();
      this.removeUploads();
      throw error;
    }
    this.maintenance = setInterval(() => {
      // A failing housekeeping step must never become an uncaughtException that kills the server.
      for (const step of [
        () => this.runner.retryDeletionCleanup(),
        () => this.pruneUploads(),
        () => { for (const path of this.pendingCleanup) this.cleanupFile(path); },
        () => {
          for (const clients of this.sseClients.values()) {
            for (const client of [...clients]) this.writeSse(client, ": keep-alive\n\n");
          }
        }
      ]) {
        try { step(); } catch (error) { this.logMaintenanceFailure(error); }
      }
    }, 15_000);
    this.maintenance.unref();
    const address = this.server.address();
    return { port: typeof address === "object" && address !== null ? address.port : port, host };
  }

  private logMaintenanceFailure(error: unknown): void {
    const now = Date.now();
    if (now - this.lastMaintenanceLog < 60_000) return;
    this.lastMaintenanceLog = now;
    console.error("SWPanel maintenance task failed:", error instanceof Error ? error.message : "unknown error");
  }

  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    if (this.maintenance !== null) clearInterval(this.maintenance);
    this.unsubscribeEvents();
    for (const clients of this.sseClients.values()) {
      for (const client of clients) client.response.end();
    }
    this.sseClients.clear();
    this.sseClientCount = 0;
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => this.server.closeAllConnections(), 2000);
        this.server.close((err) => {
          clearTimeout(deadline);
          if (err) reject(err);
          else resolve();
        });
        this.server.closeIdleConnections();
      });
    }
    await this.runner.shutdown();
    this.commands.clear();
    this.removeUploads();
  }

  private removeUploads(): void {
    this.stagedFiles.clear();
    this.pendingCleanup.clear();
    if (this.uploadRoot !== null) rmSync(this.uploadRoot, { recursive: true, force: true });
    this.uploadRoot = null;
  }

  private pruneUploads(): void {
    for (const [token, file] of this.stagedFiles) {
      if (file.expiresAt <= Date.now()) {
        this.stagedFiles.delete(token);
        this.cleanupFile(file.tempPath);
      }
    }
  }

  private cleanupFile(path: string): void {
    try {
      rmSync(path, { force: true });
      this.pendingCleanup.delete(path);
    } catch {
      // Cleanup is retried without converting a committed mutation into failure.
      this.pendingCleanup.add(path);
    }
  }

  private sendJson(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  }

  private error(res: ServerResponse, requestId: string, status: number, code: string, message: string): void {
    this.sendJson(res, status, { protocolVersion: IPC_PROTOCOL_VERSION, requestId, ok: false, error: { code, message } });
  }

  /** Host header gate against DNS rebinding. Returns the validated Host header value. */
  private checkHost(req: IncomingMessage): string {
    const raw = req.headers.host;
    const bound = (this.options.host ?? "127.0.0.1").toLowerCase();
    const extra = (this.options.allowedHosts ?? []).map((value) => value.toLowerCase());
    // A wildcard bind with no configured names cannot know its legitimate names; the startup warning covers that case.
    if (WILDCARD_HOSTS.has(bound) && extra.length === 0) return raw ?? "";
    const match = typeof raw === "string" ? /^(\[[0-9a-f:.]+\]|[^:\s/@]+)(?::(\d+))?$/i.exec(raw.toLowerCase()) : null;
    const address = this.server.address();
    const port = typeof address === "object" && address !== null ? address.port : this.options.port;
    if (typeof raw === "string" && extra.includes(raw.toLowerCase())) return raw;
    const acceptable = (name: string) => LOOPBACK_HOSTS.has(name) || name === bound || extra.includes(name);
    if (match === null || !acceptable(match[1]!) || (match[2] !== undefined && port !== undefined && Number(match[2]) !== port)) {
      throw new WebRequestError(421, "HOST_NOT_ALLOWED", "不允许使用此地址访问服务");
    }
    return raw!;
  }

  private checkOrigin(req: IncomingMessage, res: ServerResponse, host: string): void {
    const origin = req.headers.origin;
    if (origin === undefined) {
      // Non-browser clients (curl, tests) carry no Origin; a browser-initiated cross-site request is refused.
      if (req.headers["sec-fetch-site"] === "cross-site") throw new WebRequestError(403, "ORIGIN_NOT_ALLOWED", "不允许此来源访问本地服务");
      return;
    }
    const allowed = this.options.allowedOrigins ?? ["http://127.0.0.1:5173", "http://localhost:5173"];
    // Same-origin means "the validated Host this request addressed", not the configured bind address.
    if (origin !== `http://${host}` && !allowed.includes(origin)) {
      throw new WebRequestError(403, "ORIGIN_NOT_ALLOWED", "不允许此来源访问本地服务");
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID");
    res.setHeader("Access-Control-Expose-Headers", "X-SWPanel-Server-Instance-Id");
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    res.setHeader("X-SWPanel-Server-Instance-Id", this.serverInstanceId);
    try {
      const host = this.checkHost(req);
      this.checkOrigin(req, res, host);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      let url: URL;
      try { url = new URL(req.url ?? "/", "http://127.0.0.1"); }
      catch { throw new WebRequestError(400, "INVALID_REQUEST", "请求地址格式无效"); }
      if (handleFileRequest(this.runner, req, res, url)) return;
      if (url.pathname.startsWith("/api/settings/")) {
        let data: unknown;
        try {
          if (req.method === "GET" && url.pathname === "/api/settings/runtime") data = this.settings.getRuntime();
          else if (req.method === "GET" && url.pathname === "/api/settings/api-key") data = this.settings.getApiKeyStatus();
          else if (req.method === "POST" && url.pathname === "/api/settings/api-key") {
            const body = await this.readJson(req, 8192);
            if (!record(body) || Object.keys(body).length !== 1 || !("apiKey" in body)) throw new WebRequestError(400, "INVALID_PAYLOAD", "apiKey is required");
            data = body.apiKey === null ? this.settings.clearApiKey() : this.settings.setApiKey(body.apiKey);
          } else if (req.method === "POST" && url.pathname === "/api/settings/test-connection") {
            const body = await this.readJson(req, 1024);
            if (!record(body) || Object.keys(body).length !== 0) throw new WebRequestError(400, "INVALID_PAYLOAD", "Connection test requires an empty payload");
            data = await this.settings.testConnection();
          } else throw new WebRequestError(404, "NOT_FOUND", "Settings route not found");
        } catch (error) {
          if (error instanceof WebRequestError) throw error;
          if (error instanceof SettingsInputError) throw new WebRequestError(400, "SETTINGS_ERROR", error.message);
          // Persistence/unknown failures are server faults, not a client mistake (details are not exposed).
          throw new WebRequestError(500, "SETTINGS_IO_ERROR", "服务器无法保存设置，请检查磁盘空间和目录权限");
        }
        this.sendJson(res, 200, { ok: true, data });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        this.sendJson(res, 200, {
          ok: true, status: "READY", serverInstanceId: this.serverInstanceId,
          modeling: this.options.runnerConfig === undefined ? "UNCONFIGURED" : "SERVER_CONFIGURED"
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/upload") {
        this.pruneUploads();
        if (this.stagedFiles.size >= 100) throw new WebRequestError(429, "UPLOAD_LIMIT", "待导入的图纸过多，请先完成或放弃已选择的文件");
        if (this.activeUploads >= (this.options.maxConcurrentUploads ?? DEFAULT_MAX_UPLOADS)) {
          req.resume();
          throw new WebRequestError(429, "UPLOAD_BUSY", "正在处理的上传过多，请稍后重试");
        }
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && this.stagedBytes() + Math.floor(declared * 3 / 4) > (this.options.maxStagedBytes ?? DEFAULT_MAX_STAGED_BYTES)) {
          req.resume();
          throw new WebRequestError(429, "UPLOAD_STORAGE_FULL", "暂存的图纸文件总量已达上限，请先完成导入");
        }
        this.activeUploads++;
        try {
          const body = await this.readJson(req, this.uploadRequestLimit());
          this.sendJson(res, 200, { ok: true, data: this.stageUpload(body) });
        } finally {
          this.activeUploads--;
        }
        return;
      }
      if (req.method === "POST" && (url.pathname === "/api/query" || url.pathname === "/api/command")) {
        const body = await this.readJson(req, this.options.maxRequestBytes ?? 1024 * 1024);
        const channel = url.pathname === "/api/query" ? "query" : "command";
        this.sendJson(res, 200, await this.dispatch(channel, body, requestId));
        return;
      }
      const sseMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
      if (req.method === "GET" && sseMatch !== null) {
        let runId: string;
        try { runId = decodeURIComponent(sseMatch[1]!); }
        catch { throw new WebRequestError(400, "INVALID_REQUEST", "请求地址格式无效"); }
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(runId)) throw new WebRequestError(400, "INVALID_REQUEST", "请求地址格式无效");
        this.subscribe(req, res, runId, url);
        return;
      }
      this.error(res, requestId, 404, "NOT_FOUND", "API route not found");
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof WebRequestError) {
        this.error(res, requestId, error.status, error.code, error.message);
      } else if (error instanceof IpcValidationError) {
        this.error(res, requestId, 400, error.code, error.message);
      } else if (error instanceof RunnerError) {
        const publicError = toPublicError(error);
        this.error(res, requestId, error.code === "NOT_FOUND" ? 404 : 400, publicError.code, publicError.message);
      } else {
        this.error(res, requestId, 500, "INTERNAL_ERROR", "服务暂时无法完成请求，请稍后重试");
      }
    }
  }

  private stagedBytes(): number {
    let total = 0;
    for (const file of this.stagedFiles.values()) total += file.sizeBytes;
    return total;
  }

  private uploadRequestLimit(): number {
    return 4 * Math.ceil((this.options.maxUploadBytes ?? 20 * 1024 * 1024) / 3) + 4096;
  }

  private stageUpload(body: unknown): Omit<StagedWebFile, "tempPath" | "expiresAt"> {
    if (!record(body) || Object.keys(body).some((key) => key !== "fileName" && key !== "contentBase64")) {
      throw new WebRequestError(400, "INVALID_PAYLOAD", "上传内容格式无效");
    }
    const { fileName, contentBase64 } = body;
    // Names are stored NFC-normalized; bidi/zero-width controls could disguise an extension in lists.
    const normalizedName = typeof fileName === "string" ? fileName.normalize("NFC") : fileName;
    if (typeof fileName !== "string" || typeof normalizedName !== "string" || normalizedName.length === 0 || normalizedName.length > 255 || normalizedName.startsWith(".") ||
      /[/\\]/.test(normalizedName) || /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(normalizedName) ||
      Array.from(normalizedName).some((character) => character.charCodeAt(0) < 32 || (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159))) {
      throw new WebRequestError(400, "INVALID_FILE_NAME", "文件名无效：不能包含路径、控制字符，也不能以点开头");
    }
    const extension = /\.([^.]+)$/.exec(normalizedName)?.[1]?.toUpperCase();
    if (extension !== "PDF" && extension !== "DWG" && extension !== "DXF") {
      throw new WebRequestError(400, "INPUT_UNSUPPORTED", "仅支持 PDF、DWG 和 DXF 格式的图纸");
    }
    if (typeof contentBase64 !== "string" || contentBase64.length === 0 || contentBase64.length % 4 !== 0) {
      throw new WebRequestError(400, "INVALID_PAYLOAD", "图纸内容不能为空");
    }
    // Buffer decoding is permissive; the canonical round trip below rejects
    // invalid characters, padding and pad bits without a repeated-group regex
    // that overflows V8's stack on ordinary multi-megabyte drawings.
    const content = Buffer.from(contentBase64, "base64");
    if (content.toString("base64") !== contentBase64) throw new WebRequestError(400, "INVALID_PAYLOAD", "图纸内容编码无效");
    if (content.length > (this.options.maxUploadBytes ?? 20 * 1024 * 1024)) {
      throw new WebRequestError(413, "PAYLOAD_TOO_LARGE", "图纸文件超过大小上限");
    }
    this.pruneUploads();
    if (this.stagedFiles.size >= 100) throw new WebRequestError(429, "UPLOAD_LIMIT", "待导入的图纸过多，请先完成或放弃已选择的文件");
    if (this.stagedBytes() + content.length > (this.options.maxStagedBytes ?? DEFAULT_MAX_STAGED_BYTES)) {
      throw new WebRequestError(429, "UPLOAD_STORAGE_FULL", "暂存的图纸文件总量已达上限，请先完成导入");
    }
    if (this.uploadRoot === null) throw new Error("Upload storage is unavailable");
    mkdirSync(this.uploadRoot, { recursive: true });
    const token = `swsel_${randomBytes(16).toString("hex")}`;
    const tempPath = join(this.uploadRoot, `${token}.${extension.toLowerCase()}`);
    writeFileSync(tempPath, content, { flag: "wx", mode: 0o600 });
    const file: StagedWebFile = {
      token, tempPath, fileName: normalizedName, format: extension, sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      expiresAt: Date.now() + (this.options.uploadTokenTtlMs ?? 5 * 60 * 1000)
    };
    this.stagedFiles.set(token, file);
    const { tempPath: ignoredPath, expiresAt: ignoredExpiry, ...selected } = file;
    void ignoredPath;
    void ignoredExpiry;
    return selected;
  }

  private async dispatch(channel: "query" | "command", body: unknown, requestId: string): Promise<IpcResponseEnvelope> {
    if (!record(body) || Object.keys(body).some((key) => !["operation", "payload", "idempotencyKey"].includes(key))) {
      throw new WebRequestError(400, "INVALID_ENVELOPE", "Request requires operation, payload and optional idempotencyKey");
    }
    if (!record(body.payload)) throw new WebRequestError(400, "INVALID_PAYLOAD", "payload must be an object");
    const payload = { ...body.payload };
    const key = body.idempotencyKey;
    if (key !== undefined && (channel !== "command" || typeof key !== "string" || key.length === 0 || key.length > 256)) {
      throw new WebRequestError(400, "INVALID_PAYLOAD", "idempotencyKey must be a non-empty command key up to 256 characters");
    }
    const semanticPayload = { ...payload };
    if (["drawing.create", "drawing.createRevision", "drawing.addRevisionFact", "drawing.addModelingFeedback"].includes(String(body.operation))) {
      delete semanticPayload.createdAt;
      delete semanticPayload.createdBy;
    }
    const fingerprint = createHash("sha256").update(canonical({ operation: body.operation, payload: semanticPayload })).digest("hex");
    if (typeof key === "string") {
      const cached = this.commands.get(key);
      if (cached !== undefined && cached.expiresAt > Date.now()) {
        if (cached.fingerprint !== fingerprint) throw new WebRequestError(409, "IDEMPOTENCY_CONFLICT", "The same intent key cannot be used for a different command");
        return { ...await cached.response, requestId };
      }
      this.commands.delete(key);
    }
    let file: StagedWebFile | undefined;
    if (channel === "command" && (body.operation === "drawing.create" || body.operation === "drawing.createRevision")) {
      if ("sourceFile" in payload) throw new WebRequestError(400, "INVALID_PAYLOAD", "图纸来源信息无效");
      const token = payload.selectedFileToken;
      this.pruneUploads();
      file = typeof token === "string" ? this.stagedFiles.get(token) : undefined;
      if (file === undefined) throw new WebRequestError(400, "TOKEN_NOT_FOUND", "上传凭证已过期或已被使用，请重新选择文件");
      delete payload.selectedFileToken;
      payload.sourceFile = { fileName: file.fileName, format: file.format, sizeBytes: file.sizeBytes, sha256: file.sha256 };
    }
    const request = validateIpcRequestEnvelope({
      protocolVersion: IPC_PROTOCOL_VERSION, requestId, channel,
      operation: body.operation, payload,
      ...(key === undefined ? {} : { idempotencyKey: key })
    });
    if (!(channel === "query" ? WEB_QUERY_ALLOWLIST : WEB_COMMAND_ALLOWLIST).has(request.operation)) {
      throw new WebRequestError(403, "OPERATION_NOT_AVAILABLE", "该操作不支持通过 Web 访问");
    }
    if (file !== undefined) {
      this.stagedFiles.delete(file.token);
      this.runner.registerSourceFile(file.sha256, file.tempPath);
    }
    const response = this.execute(request, file);
    if (typeof key === "string") {
      const entry = { fingerprint, response, expiresAt: Date.now() + 30 * 60 * 1000 };
      this.commands.set(key, entry);
      while (this.commands.size > 1024) this.commands.delete(this.commands.keys().next().value!);
      void response.then((result) => {
        if (!result.ok && this.commands.get(key) === entry) this.commands.delete(key);
      }, () => {
        if (this.commands.get(key) === entry) this.commands.delete(key);
      });
    }
    return response;
  }

  private async execute(request: IpcRequestEnvelope, file: StagedWebFile | undefined): Promise<IpcResponseEnvelope> {
    const response = await this.handler.handle(request);
    if (file !== undefined) {
      if (response.ok) this.cleanupFile(file.tempPath);
      else this.stagedFiles.set(file.token, file);
    }
    // Handler error details may include server filesystem paths; expose only stable codes.
    if (!response.ok && response.error !== undefined) {
      return { ...response, error: toPublicError(response.error) };
    }
    return response;
  }

  private subscribe(req: IncomingMessage, res: ServerResponse, runId: string, url: URL): void {
    const cursor = url.searchParams.get("fromSequence") ?? "0";
    const lastId = req.headers["last-event-id"];
    if (!/^\d+$/.test(cursor) || (lastId !== undefined && (typeof lastId !== "string" || !/^\d+$/.test(lastId)))) {
      throw new WebRequestError(400, "INVALID_PAYLOAD", "事件游标必须是非负整数");
    }
    const fromSequence = Math.max(Number(cursor), lastId === undefined ? 0 : Number(lastId) + 1);
    validateIpcRequestEnvelope({ protocolVersion: IPC_PROTOCOL_VERSION, requestId: randomUUID(), channel: "subscribe", operation: "run.subscribe", payload: { runId, fromSequence } });
    this.runner.getRunDetail(runId);
    if (this.sseClientCount >= (this.options.maxSseClients ?? DEFAULT_MAX_SSE) ||
      (this.sseClients.get(runId)?.size ?? 0) >= (this.options.maxSseClientsPerRun ?? DEFAULT_MAX_SSE_PER_RUN)) {
      throw new WebRequestError(429, "SSE_LIMIT", "任务事件连接过多，请关闭其他页面后重试");
    }
    const backlog = this.runner.listRunEventsFrom(runId, fromSequence);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": connected\n\n");
    const client = { response: res, nextSequence: fromSequence };
    let clients = this.sseClients.get(runId);
    if (clients === undefined) {
      clients = new Set();
      this.sseClients.set(runId, clients);
    }
    clients.add(client);
    this.sseClientCount++;
    // The connection is intentionally kept open after a terminal event: the browser
    // EventSource treats any server-side close as STREAM_LOST, so the client (not the
    // server) ends the stream when its subscription is released.
    res.on("close", () => {
      if (clients.delete(client)) this.sseClientCount = Math.max(0, this.sseClientCount - 1);
      if (clients.size === 0 && this.sseClients.get(runId) === clients) this.sseClients.delete(runId);
    });
    for (const event of backlog) this.sendEvent(client, event);
  }

  /** Writes one SSE chunk; a client whose unsent buffer exceeds the limit is dropped (it resumes via Last-Event-ID). */
  private writeSse(client: SseClient, chunk: string): boolean {
    const res = client.response;
    if (res.destroyed || res.writableEnded) return false;
    try {
      const flushed = res.write(chunk);
      if (!flushed && res.writableLength > (this.options.sseBufferLimitBytes ?? DEFAULT_SSE_BUFFER_BYTES)) {
        res.destroy();
        return false;
      }
      return true;
    } catch {
      res.destroy();
      return false;
    }
  }

  private sendEvent(client: SseClient, event: RunEvent): void {
    if (event.sequence < client.nextSequence) return;
    // One failing/slow client must not stop delivery to the others of the same commit batch.
    const sent = this.writeSse(client, `id: ${event.sequence}\ndata: ${JSON.stringify({ type: "events", serverInstanceId: this.serverInstanceId, events: [event] })}\n\n`);
    if (sent) client.nextSequence = event.sequence + 1;
  }

  private async readJson(req: IncomingMessage, limit: number): Promise<unknown> {
    const length = req.headers["content-length"];
    if (length !== undefined && Number(length) > limit) {
      req.resume();
      throw new WebRequestError(413, "PAYLOAD_TOO_LARGE", "请求内容过大");
    }
    const chunks = await new Promise<Buffer[]>((resolve, reject) => {
      const buffers: Buffer[] = [];
      let size = 0;
      let exceeded = false;
      req.on("data", (chunk: Buffer) => {
        if (exceeded) return;
        size += chunk.length;
        if (size > limit) {
          exceeded = true;
          buffers.length = 0;
          reject(new WebRequestError(413, "PAYLOAD_TOO_LARGE", "请求内容过大"));
        } else buffers.push(chunk);
      });
      req.on("end", () => resolve(buffers));
      req.on("error", reject);
      req.on("aborted", () => reject(new WebRequestError(400, "INVALID_REQUEST", "请求被中断")));
    });
    try {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return body;
    } catch {
      throw new WebRequestError(400, "INVALID_JSON", "请求内容不是有效的 JSON");
    }
  }
}
