import { WebServer, isExposedHost } from "./server/web-server.js";
import { acquireDataRootLock } from "./server/instance-lock.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SettingsService } from "./server/settings-service.js";
import { configureWebRuntime } from "./live-wiring/web-runtime.js";

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 3001;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT 无效：${value}（需要 1-65535 的整数）`);
  return port;
}
function parseList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

async function main() {
  const port = parsePort(process.env.PORT);
  const host = process.env.HOST || "127.0.0.1";
  const dataRoot = process.env.SWPANEL_DATA_ROOT || join(homedir(), ".swpanel-data");
  // Customer drawings and the database live here: owner-only on POSIX (Windows relies on the profile ACL).
  const existed = existsSync(dataRoot);
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  if (!existed && process.platform !== "win32") chmodSync(dataRoot, 0o700);
  // One server per data root: a second instance would run recovery against the first one's live attempts.
  const releaseLock = acquireDataRootLock(dataRoot);
  process.once("exit", releaseLock);
  if (isExposedHost(host)) {
    console.warn("============================================================");
    console.warn(`警告：服务绑定在 ${host}，局域网内任何人都可访问。`);
    console.warn("SWPanel 目前没有登录与鉴权：可读取图纸、修改成本数据、写入 API Key。");
    console.warn("仅在受信任的内网使用；并通过 SWPANEL_ALLOWED_HOSTS / SWPANEL_ALLOWED_ORIGINS 限定访问名称。");
    console.warn("============================================================");
  }
  try {
    // Credentials are loaded once, before spawning any Codex child; the runtime description is attached afterwards.
    const settingsService = new SettingsService({ dataRoot });
    const { runnerConfig, runtime } = await configureWebRuntime(process.env, process.platform, settingsService.getAuthMode());
    settingsService.setRuntime(runtime);
    // The built web UI (apps/desktop/dist/renderer) is served from the same port when present.
    const configuredWebRoot = process.env.SWPANEL_WEB_ROOT?.trim();
    const webRoot = [configuredWebRoot, fileURLToPath(new URL("../../desktop/dist/renderer", import.meta.url))].find((candidate): candidate is string => candidate !== undefined && candidate !== "" && existsSync(join(candidate, "index.html"))) ?? null;
    const allowedHosts = parseList(process.env.SWPANEL_ALLOWED_HOSTS);
    const allowedOrigins = parseList(process.env.SWPANEL_ALLOWED_ORIGINS);
    const server = new WebServer({
      port, host, dataRoot, settingsService,
      ...(webRoot !== null ? { webRoot } : {}),
      ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
      ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
      ...(runnerConfig ? { runnerConfig } : {})
    });
    const info = await server.start();
    console.log(`SWPanel Web API Server listening at http://${info.host}:${info.port}`);
    console.log(webRoot === null ? "Web UI: 未找到前端构建产物（仅提供 /api）" : `Web UI: http://${info.host}:${info.port}/`);
    console.log(`Modeling runtime: ${runtime.reason}`);
    if (runtime.skillPath) console.log(`Skill: ${runtime.skillName ?? ""} at ${runtime.skillPath} (${runtime.skillPathSource === "auto-detected" ? "自动检测" : "已配置"})`);
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void server.stop().catch((error: unknown) => {
        console.error("Failed to stop SWPanel Web Server:", error);
        process.exitCode = 1;
      }).finally(releaseLock);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    releaseLock();
    throw error;
  }
}

main().catch((err) => {
  console.error("Failed to start SWPanel Web Server:", err);
  process.exit(1);
});
