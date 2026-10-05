import { CodexAppServerClient, type CodexTransportFactory } from "../agent/codex/codex-app-server-client.js";

/** One selectable model offered on the Settings page. */
export interface ModelOption {
  id: string;
  displayName: string;
  description: string | null;
  /** True/false when the source states image-input support; null when unknown. */
  supportsImage: boolean | null;
  isDefault: boolean;
}

const MODEL_LIST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 10;
const MAX_MODELS = 500;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

export function isValidModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tolerant parse of one Codex `model/list` entry (field names differ slightly between CLI versions). */
export function parseCodexModelEntry(entry: unknown): ModelOption | null {
  if (!isRecord(entry) || entry.hidden === true) return null;
  const id = typeof entry.model === "string" ? entry.model : typeof entry.id === "string" ? entry.id : null;
  if (id === null || !isValidModelId(id)) return null;
  const modalities = Array.isArray(entry.inputModalities) ? entry.inputModalities : null;
  return {
    id,
    displayName: typeof entry.displayName === "string" && entry.displayName.length > 0 ? entry.displayName.slice(0, 120) : id,
    description: typeof entry.description === "string" && entry.description.length > 0 ? entry.description.slice(0, 300) : null,
    supportsImage: modalities === null ? null : modalities.includes("image"),
    isDefault: entry.isDefault === true
  };
}

/** Lists the models the logged-in Codex CLI account can use (short-lived app-server child). */
export async function listCodexModels(factory: CodexTransportFactory, timeoutMs = MODEL_LIST_TIMEOUT_MS): Promise<ModelOption[]> {
  const transport = factory();
  try {
    const client = new CodexAppServerClient({ transport, requestTimeoutMs: timeoutMs });
    await client.initialize(timeoutMs);
    const models = new Map<string, ModelOption>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response: unknown = await client.request("model/list", cursor === null ? { limit: 100 } : { limit: 100, cursor }, timeoutMs);
      if (!isRecord(response) || !Array.isArray(response.data)) throw new Error("Codex 返回了无法识别的模型列表");
      for (const entry of response.data) {
        const parsed = parseCodexModelEntry(entry);
        if (parsed !== null && models.size < MAX_MODELS) models.set(parsed.id, parsed);
      }
      cursor = typeof response.nextCursor === "string" && response.nextCursor.length > 0 ? response.nextCursor : null;
      if (cursor === null) break;
    }
    return sortModels([...models.values()]);
  } finally {
    transport.close();
  }
}

/** Lists the models an OpenAI-compatible `/models` endpoint offers to the server API key. */
export async function listApiModels(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<ModelOption[]> {
  let url: URL;
  try { url = new URL(`${baseUrl.replace(/\/$/, "")}/models`); }
  catch { throw new Error("API 地址无效"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("API 地址必须使用 HTTPS");
  let response: Response;
  try { response = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000), redirect: "error" }); }
  catch { throw new Error("无法连接 Agent API，请检查服务地址和网络"); }
  if (!response.ok) throw new Error(`Agent API 验证失败（HTTP ${response.status}）`);
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body) || !Array.isArray(body.data)) throw new Error("Agent API 返回了无效的模型列表");
  const models = new Map<string, ModelOption>();
  for (const entry of body.data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !isValidModelId(entry.id)) continue;
    if (models.size < MAX_MODELS) models.set(entry.id, { id: entry.id, displayName: entry.id, description: null, supportsImage: null, isDefault: false });
  }
  return sortModels([...models.values()]);
}

function sortModels(models: ModelOption[]): ModelOption[] {
  return models.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id));
}
