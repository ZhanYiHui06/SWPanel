import { CODEX_APP_SERVER_STDIO_ARGS, codexChildTransportFactory, type CodexChildTransportOptions, type CodexTransportFactory } from "../index.js";

const PROVIDER_ID = "swpanel_web_api";
export interface WebCodexProviderConfig {
  readonly baseUrl: string;
  readonly model: string | null;
  readonly childOptions: CodexChildTransportOptions | null;
}
/** Pins the server's API provider. Credentials are passed only in the private child environment. */
export function resolveWebCodexProvider(command: string, env: NodeJS.ProcessEnv): WebCodexProviderConfig {
  let url: URL;
  try { url = new URL(env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"); }
  catch { throw new Error("OPENAI_BASE_URL 格式无效"); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error("OPENAI_BASE_URL 必须是 HTTPS 或本机 HTTP 地址，且不可包含凭据、查询参数或片段");
  const baseUrl = url.href.replace(/\/$/, "");
  const model = env.SWPANEL_AGENT_MODEL?.trim() || null;
  if (model !== null && (model.length > 256 || (/[\r\n]/.test(model) || model.includes("\0")))) throw new Error("SWPANEL_AGENT_MODEL 格式无效");
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return { baseUrl, model, childOptions: null };
  if (apiKey.length < 8 || apiKey.length > 4096 || (/[\r\n]/.test(apiKey) || apiKey.includes("\0"))) throw new Error("服务器 API Key 格式无效");
  const overrides = [
    `model_provider=${JSON.stringify(PROVIDER_ID)}`,
    `model_providers.${PROVIDER_ID}.name="SWPanel Server API"`,
    `model_providers.${PROVIDER_ID}.base_url=${JSON.stringify(baseUrl)}`,
    `model_providers.${PROVIDER_ID}.env_key="OPENAI_API_KEY"`,
    `model_providers.${PROVIDER_ID}.wire_api="responses"`,
    `model_providers.${PROVIDER_ID}.requires_openai_auth=false`,
    ...(model === null ? [] : [`model=${JSON.stringify(model)}`])
  ];
  return { baseUrl, model, childOptions: { command, args: [...CODEX_APP_SERVER_STDIO_ARGS, ...overrides.flatMap(value => ["-c", value])], spawn: { env: { ...env, OPENAI_API_KEY: apiKey } } } };
}
export function webCodexTransportFactory(config: WebCodexProviderConfig): CodexTransportFactory {
  if (!config.childOptions) throw new Error("服务器 API Key 未配置，建模执行器未启用");
  return codexChildTransportFactory(config.childOptions);
}
