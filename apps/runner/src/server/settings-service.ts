import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface RuntimeSettings {
  platform: string;
  modelingConfigured: boolean;
  solidWorksVersion: string | null;
  skillName: string | null;
  baseUrl: string;
  model: string | null;
  reason: string;
}
export interface ApiKeyStatus { hasApiKey: boolean; maskedApiKey: string | null }
/** Client-correctable settings failure (bad input, missing key, upstream rejected). Maps to HTTP 400. */
export class SettingsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsInputError";
  }
}
/** Server-side persistence failure (disk full, read-only directory...). Maps to HTTP 500. */
export class SettingsStorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SettingsStorageError";
  }
}
type SettingsOptions = { dataRoot: string; runtime?: RuntimeSettings; env?: NodeJS.ProcessEnv; fetch?: typeof fetch };
/** Server-only credentials; secrets.env is owner-readable plaintext, never a public asset. */
export class SettingsService {
  private readonly file: string;
  private key: string | null;
  private options: SettingsOptions;
  constructor(options: SettingsOptions) {
    this.options = options;
    this.file = join(options.dataRoot, "secrets.env");
    if (existsSync(this.file)) {
      if (!lstatSync(this.file).isFile() || lstatSync(this.file).isSymbolicLink()) throw new Error("Credential file must be a regular file");
      chmodSync(this.file, 0o600);
      let stored: unknown;
      try { stored = JSON.parse(readFileSync(this.file, "utf8")); }
      catch { throw new Error("服务器凭据文件格式无效"); }
      if (typeof stored !== "object" || stored === null || !("apiKey" in stored) || (stored.apiKey !== null && typeof stored.apiKey !== "string")) throw new Error("服务器凭据文件格式无效");
      this.key = stored.apiKey;

    } else this.key = (options.env ?? process.env).OPENAI_API_KEY?.trim() || null;
    if (this.key !== null && (this.key.length < 8 || this.key.length > 4096 || /[\r\n]/.test(this.key))) throw new Error("服务器 API Key 格式无效");
    if (this.key) (options.env ?? process.env).OPENAI_API_KEY = this.key;
    else delete (options.env ?? process.env).OPENAI_API_KEY;
  }
  /** Supplies the runtime description once it is known, without re-reading credentials from disk. */
  setRuntime(runtime: RuntimeSettings): void {
    this.options = { ...this.options, runtime };
  }
  /** Same-directory temp file + fsync + rename + directory fsync; a crash leaves old or new content, never an empty file. */
  private persist(value: { apiKey: string | null }): void {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(value));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.file);
      try {
        const dirFd = openSync(dirname(this.file), "r");
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      } catch {
        // Directory fsync is unsupported on some platforms (Windows); the rename already happened.
      }
    } catch (error) {
      throw new SettingsStorageError("服务器无法保存设置，请检查磁盘空间和目录权限", error);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  getRuntime(): RuntimeSettings {
    return this.options.runtime ?? { platform: process.platform, modelingConfigured: false, solidWorksVersion: null, skillName: null, baseUrl: (this.options.env ?? process.env).OPENAI_BASE_URL ?? "https://api.openai.com/v1", model: null, reason: "建模执行器未配置" };
  }
  getApiKeyStatus(): ApiKeyStatus {
    return { hasApiKey: this.key !== null, maskedApiKey: this.key ? `••••${this.key.slice(-4)}` : null };
  }
  setApiKey(apiKey: unknown): ApiKeyStatus {
    if (typeof apiKey !== "string" || apiKey.trim().length < 8 || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new SettingsInputError("API Key 格式无效");
    const key = apiKey.trim();
    this.persist({ apiKey: key });
    this.key = key;
    (this.options.env ?? process.env).OPENAI_API_KEY = key;
    return this.getApiKeyStatus();
  }
  clearApiKey(): ApiKeyStatus {
    // Persist an explicit null to avoid restoring an inherited environment key on restart.
    this.persist({ apiKey: null });
    this.key = null;
    delete (this.options.env ?? process.env).OPENAI_API_KEY;
    return this.getApiKeyStatus();
  }
  async testConnection(): Promise<{ connected: true }> {
    if (!this.key) throw new SettingsInputError("请先保存 API Key");
    let url: URL;
    try { url = new URL(`${this.getRuntime().baseUrl.replace(/\/$/, "")}/models`); }
    catch { throw new SettingsInputError("API 地址无效"); }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new SettingsInputError("API 地址必须使用 HTTPS");
    let response: Response;
    try { response = await (this.options.fetch ?? fetch)(url, { headers: { Authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(10000), redirect: "error" }); }
    catch { throw new SettingsInputError("无法连接 Agent API，请检查服务地址和网络"); }
    if (!response.ok) throw new SettingsInputError(`Agent API 验证失败（HTTP ${response.status}）`);
    const data: unknown = await response.json().catch(() => null);
    if (typeof data !== "object" || data === null || !("data" in data) || !Array.isArray(data.data)) throw new SettingsInputError("Agent API 返回了无效的模型列表");
    return { connected: true };
  }
}
