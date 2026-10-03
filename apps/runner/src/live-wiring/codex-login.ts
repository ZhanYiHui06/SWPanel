import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** How the server authenticates the Codex agent. */
export type AgentAuthMode = "api_key" | "codex_cli";
export const AGENT_AUTH_MODES: readonly AgentAuthMode[] = ["api_key", "codex_cli"];
export function isAgentAuthMode(value: unknown): value is AgentAuthMode {
  return typeof value === "string" && (AGENT_AUTH_MODES as readonly string[]).includes(value);
}

export interface CodexLoginStatus {
  loggedIn: boolean;
  /** `chatgpt` = subscription login, `api_key` = the CLI itself is configured with a key. */
  method: "chatgpt" | "api_key" | null;
}

/**
 * Reports whether the local Codex CLI is logged in by inspecting its auth file
 * (`$CODEX_HOME/auth.json`, default `~/.codex/auth.json`). Only the login
 * method is derived; token values are never returned, logged or copied.
 */
export function readCodexLoginStatus(env: NodeJS.ProcessEnv = process.env): CodexLoginStatus {
  const home = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const file = join(home, "auth.json");
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 1_000_000) return { loggedIn: false, method: null };
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return { loggedIn: false, method: null };
    const record = parsed as Record<string, unknown>;
    const tokens = record.tokens;
    if (typeof tokens === "object" && tokens !== null && Object.keys(tokens).length > 0) return { loggedIn: true, method: "chatgpt" };
    if (typeof record.OPENAI_API_KEY === "string" && record.OPENAI_API_KEY.length > 0) return { loggedIn: true, method: "api_key" };
  } catch {
    // Missing or unreadable auth file means not logged in.
  }
  return { loggedIn: false, method: null };
}
