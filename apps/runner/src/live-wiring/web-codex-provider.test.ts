import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  describe("codex_cli auth mode (local subscription login)", () => {
    const withLogin = (run: (codexHome: string) => void, login: object | null = { tokens: { access_token: "t" } }): void => {
      const codexHome = mkdtempSync(join(tmpdir(), "swpanel-provider-home-"));
      try {
        if (login !== null) writeFileSync(join(codexHome, "auth.json"), JSON.stringify(login));
        run(codexHome);
      } finally { rmSync(codexHome, { recursive: true, force: true }); }
    };
    it("uses the CLI's own login: no provider override and no key variables reach the child", () => {
      withLogin((codexHome) => {
        const env = { CODEX_HOME: codexHome, OPENAI_API_KEY: "sk-server-secret-1234", OPENAI_BASE_URL: "https://agent.example.test/v1", CODEX_API_KEY: "sk-other-5678", PATH: "/p", SWPANEL_AGENT_MODEL: "gpt-x" };
        const result = resolveWebCodexProvider("/server/codex", env, "codex_cli");
        const options = result.childOptions;
        expect(result.authMode).toBe("codex_cli");
        expect(options?.args).toEqual([...CODEX_APP_SERVER_STDIO_ARGS, "-c", 'model="gpt-x"']);
        expect(options?.args?.some(value => value.includes("model_provider"))).toBe(false);
        const childEnv = options?.spawn?.env ?? {};
        expect(childEnv.OPENAI_API_KEY).toBeUndefined();
        expect(childEnv.OPENAI_BASE_URL).toBeUndefined();
        expect(childEnv.CODEX_API_KEY).toBeUndefined();
        expect(childEnv.CODEX_HOME).toBe(codexHome);
        expect(childEnv.PATH).toBe("/p");
        expect(webCodexTransportFactory(result)).toBeTypeOf("function");
      });
    });
    it("is not enabled without a Codex CLI login, even when a server API key exists", () => {
      withLogin((codexHome) => {
        const result = resolveWebCodexProvider("codex", { CODEX_HOME: codexHome, OPENAI_API_KEY: "sk-server-1234" }, "codex_cli");
        expect(result.childOptions).toBeNull();
        expect(() => webCodexTransportFactory(result)).toThrow("Codex CLI 登录");
      }, null);
    });
    it("keeps api_key mode as the default", () => {
      expect(resolveWebCodexProvider("codex", { OPENAI_API_KEY: "sk-server-1234" }).authMode).toBe("api_key");
    });
  });
});
