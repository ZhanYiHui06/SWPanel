import { describe, expect, it } from "vitest";
import { CODEX_APP_SERVER_STDIO_ARGS } from "../index.js";
import { resolveWebCodexProvider, webCodexTransportFactory } from "./web-codex-provider.js";
describe("private server Codex provider", () => {
  it("pins base URL, API provider and actual model while keeping the key off argv", () => {
    const env = { OPENAI_API_KEY: "sk-server-secret-1234", OPENAI_BASE_URL: "https://agent.example.test/v1/", SWPANEL_AGENT_MODEL: "model-for-server", PATH: "/controlled/server/path" };
    const result = resolveWebCodexProvider("/server/codex", env);
    const options = result.childOptions;
    expect(result.baseUrl).toBe("https://agent.example.test/v1");
    expect(result.model).toBe("model-for-server");
    expect(options?.command).toBe("/server/codex");
    expect(options?.args?.slice(0, CODEX_APP_SERVER_STDIO_ARGS.length)).toEqual([...CODEX_APP_SERVER_STDIO_ARGS]);
    expect(options?.args).toContain('model_provider="swpanel_web_api"');
    expect(options?.args).toContain('model_providers.swpanel_web_api.base_url="https://agent.example.test/v1"');
    expect(options?.args).toContain('model_providers.swpanel_web_api.env_key="OPENAI_API_KEY"');
    expect(options?.args).toContain('model_providers.swpanel_web_api.wire_api="responses"');
    expect(options?.args).toContain('model_providers.swpanel_web_api.requires_openai_auth=false');
    expect(options?.args).toContain('model="model-for-server"');
    expect(JSON.stringify(options?.args)).not.toContain(env.OPENAI_API_KEY);
    expect(options?.spawn?.env?.OPENAI_API_KEY).toBe("sk-server-secret-1234");
    env.OPENAI_API_KEY = "later-mutation";
    expect(options?.spawn?.env?.OPENAI_API_KEY).toBe("sk-server-secret-1234");
  });
  it("keeps an unspecified model null and does not override the Codex model", () => {
    const result = resolveWebCodexProvider("codex", { OPENAI_API_KEY: "sk-server-1234" });
    expect(result.model).toBeNull();
    expect(result.childOptions?.args?.some(value => value.startsWith("model="))).toBe(false);
  });
  it("cannot create a transport factory without a server key", () => {
    const result = resolveWebCodexProvider("codex", {});
    expect(result.childOptions).toBeNull();
    expect(() => webCodexTransportFactory(result)).toThrow("API Key 未配置");
  });
  it("permits loopback HTTP and rejects insecure or credential-bearing provider URLs", () => {
    expect(resolveWebCodexProvider("codex", { OPENAI_BASE_URL: "http://127.0.0.1:8080/v1" }).baseUrl).toBe("http://127.0.0.1:8080/v1");
    for (const value of ["http://api.example.test/v1", "https://user:secret@api.example.test/v1", "https://api.example.test/v1?key=secret", "https://api.example.test/v1#secret", "not-a-url"]) {
      expect(() => resolveWebCodexProvider("codex", { OPENAI_BASE_URL: value })).toThrow(/OPENAI_BASE_URL/);
    }
  });
});
