import { DEFAULT_RUN_PROFILE, type RunnerConfig } from "../runner.js";
import { codexVersionProbe, hashSkillDirectory, PreflightGate, probeLiveCodexRuntime, probeSolidWorksRuntime, RealPreflightProbe, runtimeProbeResultOf, solidWorksProbeResultOf } from "../index.js";
import { LIVE_CODEX_DEFAULT_SKILL_NAME, LIVE_CODEX_SKILL_NAME_ENV, LIVE_CODEX_SKILL_PATH_ENV, resolveLiveCodexConfig } from "./live-codex-config.js";
import { discoverSkill, type SkillSearchOptions } from "./skill-discovery.js";
import { buildLiveCodexAgentWiring } from "./live-codex-wiring.js";
import { resolveWebCodexProvider, webCodexTransportFactory } from "./web-codex-provider.js";
import type { AgentAuthMode } from "./codex-login.js";
import type { RuntimeSettings } from "../server/settings-service.js";

const SOLIDWORKS_REASON_TEXT: Record<string, string> = {
  "unsupported-platform": "仅支持 Windows",
  "no-installation-found": "注册表中未找到 SolidWorks 安装（需安装 SolidWorks 桌面版）",
  "com-helper-failed": "无法通过 Python/pywin32 连接 SolidWorks COM（检查随包 python 目录是否完整）",
  "com-helper-timeout": "连接 SolidWorks COM 超时",
  "spawn-failed": "无法启动 SLDWORKS.exe",
  "ownership-not-proven": "已启动 SolidWorks，但在超时内未能注册 COM（请先手动打开 SolidWorks 并保持运行，再重启本程序）",
  "owned-process-exited": "SolidWorks 启动后立即退出（可能是许可证或显卡驱动问题；请先手动打开 SolidWorks 后重启本程序）",
  "foreign-instance-owner": "检测到非本程序启动的 SolidWorks 实例，进程归属无法确认",
  "probe-threw": "检测过程异常"
};

/** Server environment is the only source of executable/skill configuration. No model turn runs during discovery. */
export async function configureWebRuntime(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, authMode: AgentAuthMode = "api_key", skillSearch: SkillSearchOptions = {}, modelProvider?: () => string | null): Promise<{ runnerConfig?: RunnerConfig; runtime: RuntimeSettings }> {
  // Without an explicit skill path, look for the skill in the usual agent skill folders.
  let discovered: ReturnType<typeof discoverSkill> = null;
  if (!env[LIVE_CODEX_SKILL_PATH_ENV]?.trim()) {
    discovered = discoverSkill(env[LIVE_CODEX_SKILL_NAME_ENV]?.trim() || LIVE_CODEX_DEFAULT_SKILL_NAME, { env, ...skillSearch });
    if (discovered !== null) env = { ...env, [LIVE_CODEX_SKILL_PATH_ENV]: discovered.path };
  }
  const config = resolveLiveCodexConfig(env, { isPackaged: false });
  const provider = resolveWebCodexProvider(config.executable, env, authMode);
  const runtime: RuntimeSettings = { authMode, platform, modelingConfigured: false, solidWorksVersion: null, skillName: null, skillPath: null, skillPathSource: null, baseUrl: provider.baseUrl, model: provider.model, reason: "建模执行器未配置" };
  if (!config.enabled) return { runtime };
  runtime.skillName = config.skillName;
  runtime.skillPath = config.skillPath;
  runtime.skillPathSource = discovered === null ? "configured" : "auto-detected";
  if (platform !== "win32") { runtime.reason = "自动建模需要 Windows 和 SolidWorks；当前平台不支持"; return { runtime }; }
  if (!provider.childOptions) { runtime.reason = authMode === "codex_cli" ? "未检测到本机 Codex CLI 登录（请先在服务器上运行 codex login），建模执行器未启用" : "服务器 API Key 未配置，建模执行器未启用（若使用订阅登录，请在 设置 中切换为 Codex CLI 登录并重启）"; return { runtime }; }
  const transportFactory = webCodexTransportFactory(provider);
  const solidworks = await probeSolidWorksRuntime();
  runtime.solidWorksVersion = solidworks.version;
  if (!solidworks.available || !solidworks.version) { runtime.reason = `SolidWorks 实际可用性检测未通过：${SOLIDWORKS_REASON_TEXT[solidworks.reason] ?? solidworks.reason}`; console.warn(`SolidWorks probe failed: ${solidworks.reason}${solidworks.installedVersion ? ` (installed ${solidworks.installedVersion})` : ""}`); return { runtime }; }
  const codex = await probeLiveCodexRuntime({ transportFactory, command: config.executable, skillName: config.skillName, skillResolvedPath: config.skillPath, version: codexVersionProbe({ command: config.executable }).probe().version, ...(config.modelImageInputSupported === undefined ? {} : { modelImageInputSupported: config.modelImageInputSupported }), forceReloadSkills: config.forceReloadSkills });
  if (!codex.available || !codex.protocol || !codex.skillDiscovered || !codex.skillPathVerified || codex.modelImageInputSupported !== true) { runtime.reason = "Codex 协议、技能或图像输入检测未通过"; return { runtime }; }
  const skillHash = hashSkillDirectory(config.skillPath);
  const preflight = new PreflightGate(new RealPreflightProbe({ skillRootPath: config.skillPath, runtime: { probe: () => runtimeProbeResultOf(codex) }, liveCodex: codex, modelImageInputSupported: true, solidworks: { probe: () => solidWorksProbeResultOf(solidworks) } }));
  const wiring = buildLiveCodexAgentWiring(config, { transportFactory, ...(modelProvider === undefined ? {} : { modelProvider }) });
  runtime.modelingConfigured = true;
  runtime.reason = provider.model === null ? "真实执行环境检测通过；模型使用 Codex 服务端配置" : "真实执行环境检测通过";
  return { runtime, runnerConfig: { ...wiring, expectedSolidWorksVersion: solidworks.version, runProfile: { ...DEFAULT_RUN_PROFILE, skill: { name: config.skillName, sha256: skillHash }, agentConfigId: "web-live-codex" }, preflight } };
}
