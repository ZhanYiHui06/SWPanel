import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAgentAuthMode, readCodexLoginStatus } from "./codex-login.js";

const roots: string[] = [];
const home = () => { const path = mkdtempSync(join(tmpdir(), "swpanel-codex-home-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("Codex CLI login detection", () => {
  it("recognizes a subscription login without returning any token", () => {
    const codexHome = home();
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "secret-token" } }));
    const status = readCodexLoginStatus({ CODEX_HOME: codexHome });
    expect(status).toEqual({ loggedIn: true, method: "chatgpt" });
    expect(JSON.stringify(status)).not.toContain("secret-token");
  });
  it("recognizes a CLI configured with its own API key", () => {
    const codexHome = home();
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-cli-key-1234", tokens: null }));
    expect(readCodexLoginStatus({ CODEX_HOME: codexHome })).toEqual({ loggedIn: true, method: "api_key" });
  });
  it("reports not logged in for a missing, malformed, empty or symlinked auth file", () => {
    const missing = home();
    expect(readCodexLoginStatus({ CODEX_HOME: missing }).loggedIn).toBe(false);
    const malformed = home();
    writeFileSync(join(malformed, "auth.json"), "not json");
    expect(readCodexLoginStatus({ CODEX_HOME: malformed }).loggedIn).toBe(false);
    const empty = home();
    writeFileSync(join(empty, "auth.json"), JSON.stringify({ tokens: null, OPENAI_API_KEY: null }));
    expect(readCodexLoginStatus({ CODEX_HOME: empty }).loggedIn).toBe(false);
    const linked = home();
    const target = join(home(), "real.json");
    writeFileSync(target, JSON.stringify({ tokens: { access_token: "x" } }));
    symlinkSync(target, join(linked, "auth.json"));
    expect(readCodexLoginStatus({ CODEX_HOME: linked }).loggedIn).toBe(false);
  });
  it("validates auth modes", () => {
    expect(isAgentAuthMode("api_key")).toBe(true);
    expect(isAgentAuthMode("codex_cli")).toBe(true);
    expect(isAgentAuthMode("other")).toBe(false);
    expect(isAgentAuthMode(undefined)).toBe(false);
  });
});
