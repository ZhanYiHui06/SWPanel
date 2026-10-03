import { beforeEach, describe, expect, it, vi } from "vitest";
const seams = vi.hoisted(() => ({ childFactory: vi.fn(), solidworks: vi.fn(), codex: vi.fn(), wiring: vi.fn(), transport: vi.fn() }));
vi.mock("../index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../index.js")>(),
  codexChildTransportFactory: seams.childFactory,
  probeSolidWorksRuntime: seams.solidworks,
  probeLiveCodexRuntime: seams.codex,
  codexVersionProbe: () => ({ probe: () => ({ version: "0.147.0" }) }),
  hashSkillDirectory: () => "a".repeat(64)
}));
vi.mock("./live-codex-wiring.js", () => ({ buildLiveCodexAgentWiring: seams.wiring }));
import { configureWebRuntime } from "./web-runtime.js";
const baseEnv = { SWPANEL_LIVE_CODEX_SKILL_PATH: "/server/controlled-skill", SWPANEL_LIVE_CODEX_MODEL_IMAGE_SUPPORT: "true", OPENAI_API_KEY: "sk-private-server-1234", OPENAI_BASE_URL: "https://agent.example.test/v1", SWPANEL_AGENT_MODEL: "server-model" };
beforeEach(() => {
  vi.clearAllMocks();
  seams.childFactory.mockReturnValue(seams.transport);
  seams.solidworks.mockResolvedValue({ available: true, version: "34.0" });
  seams.codex.mockResolvedValue({ available: true, version: "0.147.0", protocol: "v2", skillDiscovered: true, skillPathVerified: true, modelImageInputSupported: true });
  seams.wiring.mockReturnValue({ ownsAgent: true });
});
describe("runtime provider binding", () => {
  it("uses one identical private provider factory for discovery and execution", async () => {
    const result = await configureWebRuntime(baseEnv, "win32");
    expect(result.runtime.modelingConfigured).toBe(true);
    expect(result.runtime.model).toBe("server-model");
    expect(seams.childFactory).toHaveBeenCalledTimes(1);
    expect(seams.childFactory.mock.calls[0]?.[0]).toMatchObject({ spawn: { env: { OPENAI_API_KEY: baseEnv.OPENAI_API_KEY } } });
    expect(seams.codex.mock.calls[0]?.[0]).toMatchObject({ transportFactory: seams.transport });
    expect(seams.wiring.mock.calls[0]?.[1]).toMatchObject({ transportFactory: seams.transport });
  });
  it("never discovers or spawns any worker when the API key is missing", async () => {
    const result = await configureWebRuntime({ ...baseEnv, OPENAI_API_KEY: "" }, "win32");
    expect(result.runnerConfig).toBeUndefined();
    expect(result.runtime.reason).toContain("API Key 未配置");
    expect(seams.childFactory).not.toHaveBeenCalled();
    expect(seams.solidworks).not.toHaveBeenCalled();
    expect(seams.codex).not.toHaveBeenCalled();
    expect(seams.wiring).not.toHaveBeenCalled();
  });
});
