import { HttpTransport } from "../http-transport.js";
export type AgentAuthMode = "api_key" | "codex_cli";
export interface AgentAuthStatus {
  authMode: AgentAuthMode;
  codexLogin: { loggedIn: boolean; method: "chatgpt" | "api_key" | null };
}
export interface RuntimeSettings {
  authMode?: AgentAuthMode;
  platform: string;
  modelingConfigured: boolean;
  solidWorksVersion: string | null;
  skillName: string | null;
  baseUrl: string;
  model: string | null;
  reason: string;
}
export interface ModelOption {
  id: string;
  displayName: string;
  description: string | null;
  supportsImage: boolean | null;
  isDefault: boolean;
}
export interface ModelStatus { model: string | null; source: "setting" | "env" | "default" }
export interface ModelCatalog extends ModelStatus { models: ModelOption[]; authMode: AgentAuthMode }
export interface ApiKeyStatus { hasApiKey: boolean; maskedApiKey: string | null }
export class SettingsError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
async function get<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store" });
  } catch {
    throw new SettingsError("NETWORK_ERROR", "无法连接 SWPanel 服务，请确认后端服务已启动");
  }
  let result: { ok: boolean; data: T; error?: { code?: string; message?: string } };
  try {
    result = await response.json() as typeof result;
  } catch {
    throw new SettingsError(response.ok ? "INVALID_RESPONSE" : "NETWORK_ERROR", "服务响应无效，无法读取运行设置");
  }
  if (!response.ok || !result.ok) {
    throw new SettingsError(typeof result.error?.code === "string" ? result.error.code : "UNKNOWN", result.error?.message ?? "无法读取运行设置");
  }
  return result.data;
}
const transport = () => new HttpTransport({}, SettingsError);
export const httpSettings = {
  getRuntime: () => get<RuntimeSettings>("/api/settings/runtime"),
  getStatus: async () => ({ ok: true as const, data: await get<ApiKeyStatus>("/api/settings/api-key") }),
  setApiKey: async (apiKey: string) => ({ ok: true as const, data: await transport().post<ApiKeyStatus>("/api/settings/api-key", { apiKey }) }),
  clearApiKey: async () => ({ ok: true as const, data: await transport().post<ApiKeyStatus>("/api/settings/api-key", { apiKey: null }) }),
  getAuthStatus: () => get<AgentAuthStatus>("/api/settings/auth-mode"),
  setAuthMode: (authMode: AgentAuthMode) => transport().post<AgentAuthStatus>("/api/settings/auth-mode", { authMode }),
  getModelStatus: () => get<ModelStatus>("/api/settings/model"),
  listModels: () => get<ModelCatalog>("/api/settings/models"),
  setModel: (model: string | null) => transport().post<ModelStatus>("/api/settings/model", { model }),
  testConnection: () => transport().post<{ connected: true }>("/api/settings/test-connection", {})
};
