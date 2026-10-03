import { DEFAULT_RUN_PROFILE, type RunnerConfig } from "../runner.js";
import { codexVersionProbe, hashSkillDirectory, PreflightGate, probeLiveCodexRuntime, probeSolidWorksRuntime, RealPreflightProbe, runtimeProbeResultOf, solidWorksProbeResultOf } from "../index.js";
import { LIVE_CODEX_DEFAULT_SKILL_NAME, LIVE_CODEX_SKILL_NAME_ENV, LIVE_CODEX_SKILL_PATH_ENV, resolveLiveCodexConfig } from "./live-codex-config.js";
import { discoverSkill, type SkillSearchOptions } from "./skill-discovery.js";
import { buildLiveCodexAgentWiring } from "./live-codex-wiring.js";
import { resolveWebCodexProvider, webCodexTransportFactory } from "./web-codex-provider.js";
import type { AgentAuthMode } from "./codex-login.js";
import type { RuntimeSettings } from "../server/settings-service.js";

/** Server environment is the only source of executable/skill configuration. No model turn runs during discovery. */
export async function configureWebRuntime(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, authMode: AgentAuthMode = "api_key", skillSearch: SkillSearchOptions = {}): Promise<{ runnerConfig?: RunnerConfig; runtime: RuntimeSettings }> {
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
  if (!provider.childOptions) { runtime.reason = authMode === "codex_cli" ? "未检测到本机 Codex CLI 登录（请先在服务器上运行 codex login），建模执行器未启用" : "服务器 API Key 未配置，建模执行器未启用"; return { runtime }; }
  const transportFactory = webCodexTransportFactory(provider);
  const solidworks = await probeSolidWorksRuntime();
  runtime.solidWorksVersion = solidworks.version;
  if (!solidworks.available || !solidworks.version) { runtime.reason = "SolidWorks 实际可用性检测未通过"; return { runtime }; }
  const codex = await probeLiveCodexRuntime({ transportFactory, command: config.executable, skillName: config.skillName, skillResolvedPath: config.skillPath, version: codexVersionProbe({ command: config.executable }).probe().version, ...(config.modelImageInputSupported === undefined ? {} : { modelImageInputSupported: config.modelImageInputSupported }), forceReloadSkills: config.forceReloadSkills });
  if (!codex.available || !codex.protocol || !codex.skillDiscovered || !codex.skillPathVerified || codex.modelImageInputSupported !== true) { runtime.reason = "Codex 协议、技能或图像输入检测未通过"; return { runtime }; }
  const skillHash = hashSkillDirectory(config.skillPath);
  const preflight = new PreflightGate(new RealPreflightProbe({ skillRootPath: config.skillPath, runtime: { probe: () => runtimeProbeResultOf(codex) }, liveCodex: codex, modelImageInputSupported: true, solidworks: { probe: () => solidWorksProbeResultOf(solidworks) } }));
  const wiring = buildLiveCodexAgentWiring(config, { transportFactory });
  runtime.modelingConfigured = true;
  runtime.reason = provider.model === null ? "真实执行环境检测通过；模型使用 Codex 服务端配置" : "真实执行环境检测通过";
  return { runtime, runnerConfig: { ...wiring, expectedSolidWorksVersion: solidworks.version, runProfile: { ...DEFAULT_RUN_PROFILE, skill: { name: config.skillName, sha256: skillHash }, agentConfigId: "web-live-codex" }, preflight } };
}
