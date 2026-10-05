import { describe, expect, it, vi } from "vitest";
import { isValidModelId, listApiModels, parseCodexModelEntry } from "./model-catalog.js";

describe("model catalog", () => {
  it("parses Codex model entries tolerantly and reports image support", () => {
    expect(parseCodexModelEntry({ model: "gpt-x", displayName: "GPT X", inputModalities: ["text", "image"], isDefault: true }))
      .toEqual({ id: "gpt-x", displayName: "GPT X", description: null, supportsImage: true, isDefault: true });
    expect(parseCodexModelEntry({ id: "text-only", inputModalities: ["text"] })?.supportsImage).toBe(false);
    expect(parseCodexModelEntry({ id: "unknown-modalities" })?.supportsImage).toBeNull();
    expect(parseCodexModelEntry({ id: "hidden", hidden: true })).toBeNull();
    expect(parseCodexModelEntry({ id: "bad id" })).toBeNull();
    expect(parseCodexModelEntry("x")).toBeNull();
  });
  it("validates model ids", () => {
    expect(isValidModelId("gpt-5.1-codex")).toBe(true);
    expect(isValidModelId("a b")).toBe(false);
    expect(isValidModelId("")).toBe(false);
    expect(isValidModelId("x".repeat(200))).toBe(false);
  });
  it("lists API models sorted and refuses non-HTTPS endpoints", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "b" }, { id: "a" }, { id: "bad id" }] }), { status: 200 }));
    const models = await listApiModels("https://api.example.com/v1", "sk-test-1234", fetcher);
    expect(models.map((model) => model.id)).toEqual(["a", "b"]);
    expect((fetcher.mock.calls[0]?.[0] as URL).href).toBe("https://api.example.com/v1/models");
    await expect(listApiModels("http://example.com/v1", "sk-test-1234", fetcher)).rejects.toThrow("HTTPS");
    fetcher.mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(listApiModels("https://api.example.com/v1", "sk-test-1234", fetcher)).rejects.toThrow("HTTP 401");
  });
});
