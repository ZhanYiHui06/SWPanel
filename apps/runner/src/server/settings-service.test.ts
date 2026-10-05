import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsInputError, SettingsService, SettingsStorageError } from "./settings-service.js";
const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "swpanel-settings-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
describe("server credentials", () => {
  it("persists only in owner-readable file and returns a mask", () => {
    const dataRoot = root();
    const env = {};
    const service = new SettingsService({ dataRoot, env });
    expect(service.getApiKeyStatus().hasApiKey).toBe(false);
    expect(service.setApiKey("sk-sensitive-1234")).toEqual({ hasApiKey: true, maskedApiKey: "••••1234" });
    // POSIX permission bits do not exist on Windows (the file lives under the user profile ACL).
    if (process.platform !== "win32") expect(statSync(join(dataRoot, "secrets.env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dataRoot, "secrets.env"), "utf8")).toContain("sk-sensitive-1234");
    expect(new SettingsService({ dataRoot, env: {} }).getApiKeyStatus().maskedApiKey).toBe("••••1234");
    service.clearApiKey();
    expect(new SettingsService({ dataRoot, env: { OPENAI_API_KEY: "inherited-1234" } }).getApiKeyStatus().hasApiKey).toBe(false);
  });
  it("does not expose malformed credential contents in startup errors", () => {
    const dataRoot = root();
    writeFileSync(join(dataRoot, "secrets.env"), "sk-do-not-expose-this-secret");
    expect(() => new SettingsService({ dataRoot, env: {} })).toThrow("服务器凭据文件格式无效");
    writeFileSync(join(dataRoot, "secrets.env"), JSON.stringify({ apiKey: "short" }));
    expect(() => new SettingsService({ dataRoot, env: {} })).toThrow("服务器 API Key 格式无效");
  });
  it("does not send network requests until explicit connection test", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "model" }] }), { status: 200 }));
    const service = new SettingsService({ dataRoot: root(), env: {}, fetch: fetcher });
    await expect(service.testConnection()).rejects.toThrow("请先保存");
    service.setApiKey("sk-private-1234");
    service.getRuntime();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(service.testConnection()).resolves.toEqual({ connected: true });
    expect((fetcher.mock.calls[0]?.[0] as URL).href).toBe("https://api.openai.com/v1/models");
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it("fails authentication and malformed responses without leaking API data", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive upstream body", { status: 401 }));
    const service = new SettingsService({ dataRoot: root(), env: {}, fetch: fetcher });
    service.setApiKey("sk-private-1234");
    await expect(service.testConnection()).rejects.toThrow("HTTP 401");
    fetcher.mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(service.testConnection()).rejects.toThrow("无效的模型列表");
    fetcher.mockRejectedValue(new Error("secret upstream token"));
    await expect(service.testConnection()).rejects.toThrow("无法连接 Agent API");
    expect(() => service.setApiKey("bad\nsecret-key")).toThrow("格式无效");
  });
  it("reports persistence failures as storage errors, not client input errors", () => {
    const dataRoot = root();
    const service = new SettingsService({ dataRoot, env: {} });
    rmSync(dataRoot, { recursive: true, force: true });
    expect(() => service.setApiKey("sk-private-1234")).toThrow(SettingsStorageError);
    expect(() => service.setApiKey("short")).toThrow(SettingsInputError);
  });
  it("accepts a runtime description after construction without re-reading credentials", () => {
    const service = new SettingsService({ dataRoot: root(), env: {} });
    const runtime = { authMode: "api_key" as const, platform: "win32", modelingConfigured: true, solidWorksVersion: "2024", skillName: "skill", baseUrl: "https://example.test/v1", model: "m", reason: "ok" };
    service.setRuntime(runtime);
    expect(service.getRuntime()).toEqual(runtime);
  });
  it("leaves no temporary files after a successful write", () => {
    const dataRoot = root();
    const service = new SettingsService({ dataRoot, env: {} });
    service.setApiKey("sk-private-1234");
    expect(readdirSync(dataRoot)).toEqual(["secrets.env"]);
  });
  it("persists the auth mode next to the key, defaults to api_key and survives clearing the key", () => {
    const dataRoot = root();
    const service = new SettingsService({ dataRoot, env: {} });
    expect(service.getAuthMode()).toBe("api_key");
    service.setApiKey("sk-sensitive-1234");
    expect(service.setAuthMode("codex_cli").authMode).toBe("codex_cli");
    expect(new SettingsService({ dataRoot, env: {} }).getAuthMode()).toBe("codex_cli");
    expect(new SettingsService({ dataRoot, env: {} }).getApiKeyStatus().maskedApiKey).toBe("••••1234");
    service.clearApiKey();
    expect(new SettingsService({ dataRoot, env: {} }).getAuthMode()).toBe("codex_cli");
    expect(() => service.setAuthMode("bogus")).toThrow(SettingsInputError);
    expect(service.getRuntime().authMode).toBe("codex_cli");
  });
  it("reads credential files written before auth modes existed as api_key", () => {
    const dataRoot = root();
    writeFileSync(join(dataRoot, "secrets.env"), JSON.stringify({ apiKey: "sk-legacy-1234" }));
    const service = new SettingsService({ dataRoot, env: {} });
    expect(service.getAuthMode()).toBe("api_key");
    expect(service.getApiKeyStatus().hasApiKey).toBe(true);
    writeFileSync(join(dataRoot, "secrets.env"), JSON.stringify({ apiKey: null, authMode: "weird" }));
    expect(() => new SettingsService({ dataRoot, env: {} })).toThrow("服务器凭据文件格式无效");
  });
  it("tests the Codex CLI login without any network request in codex_cli mode", async () => {
    const dataRoot = root();
    const codexHome = root();
    const fetcher = vi.fn<typeof fetch>();
    const service = new SettingsService({ dataRoot, env: { CODEX_HOME: codexHome }, fetch: fetcher });
    service.setAuthMode("codex_cli");
    await expect(service.testConnection()).rejects.toThrow("codex login");
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "t" } }));
    expect(service.getAuthStatus()).toEqual({ authMode: "codex_cli", codexLogin: { loggedIn: true, method: "chatgpt" } });
    await expect(service.testConnection()).resolves.toEqual({ connected: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("selects a model: the Settings choice wins over the env default and persists", () => {
    const dataRoot = root();
    const env = { SWPANEL_AGENT_MODEL: "env-model" };
    const service = new SettingsService({ dataRoot, env });
    expect(service.getModelStatus()).toEqual({ model: "env-model", source: "env" });
    expect(service.setModel("gpt-5.1-codex")).toEqual({ model: "gpt-5.1-codex", source: "setting" });
    expect(new SettingsService({ dataRoot, env }).getModel()).toBe("gpt-5.1-codex");
    expect(service.setModel(null)).toEqual({ model: "env-model", source: "env" });
    expect(new SettingsService({ dataRoot, env: {} }).getModelStatus()).toEqual({ model: null, source: "default" });
    expect(() => service.setModel("bad model; rm")).toThrow(SettingsInputError);
    // Saving a model never drops the stored API key / auth mode (and vice versa).
    service.setApiKey("sk-private-1234");
    service.setModel("m1");
    service.setAuthMode("api_key");
    const reopened = new SettingsService({ dataRoot, env: {} });
    expect(reopened.getModel()).toBe("m1");
    expect(reopened.getApiKeyStatus().hasApiKey).toBe(true);
  });
  it("lists models through the injected lister and refuses without credentials", async () => {
    const service = new SettingsService({ dataRoot: root(), env: {} });
    await expect(service.listModels()).rejects.toThrow("未启用");
    const lister = vi.fn().mockResolvedValue([{ id: "m1", displayName: "M1", description: null, supportsImage: true, isDefault: true }]);
    service.setModelLister(lister);
    await expect(service.listModels()).rejects.toThrow("请先保存");
    service.setApiKey("sk-private-1234");
    const catalog = await service.listModels();
    expect(lister).toHaveBeenCalledWith("api_key", "sk-private-1234");
    expect(catalog).toMatchObject({ model: null, source: "default", authMode: "api_key", models: [{ id: "m1" }] });
    service.setModelLister(() => Promise.reject(new Error("boom")));
    await expect(service.listModels()).rejects.toThrow("检查模型失败：boom");
  });
});
