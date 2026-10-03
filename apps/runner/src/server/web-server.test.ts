import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeletionImpact, DrawingDetailView } from "@swpanel/contracts";
import { SettingsService } from "./settings-service.js";
import type { CostDataSnapshot, CostEstimateInputSnapshot, Drawing, DrawingRevision, ModelingRun, RevisionFact } from "@swpanel/domain";
import type { CostReportDetailView, ModelDetailView, RevisionDetailView, RunDetailView, WorkspaceDashboardView } from "@swpanel/contracts";
import { WebServer, type WebServerOptions } from "./web-server.js";
import { makeTempDir, removeTempDir, samplePdfBytes, sha256Of } from "../test-utils.js";
import { registerGeometryFixture } from "../testing/measured-geometry-fixture.js";

interface Envelope<T> {
  ok: boolean;
  data: T;
  error?: { code: string; message: string };
}
interface UploadedFile { token: string; fileName: string; format: string; sizeBytes: number; sha256: string }
interface ImportedDrawing { drawing: Drawing; revision: DrawingRevision; sourceFile: DrawingRevision["sourceFile"] }
const instant = "2026-10-01T08:00:00.000Z";

describe("WebServer real HTTP business transport", () => {
  let dataRoot: string;
  let server: WebServer;
  let baseUrl: string;

  async function start(options: Partial<WebServerOptions> = {}) {
    server = new WebServer({ dataRoot, port: 0, ...options });
    const info = await server.start();
    baseUrl = `http://${info.host}:${info.port}`;
  }

  beforeEach(async () => {
    dataRoot = makeTempDir("web-server");
    await start();
  });
  afterEach(async () => {
    await server.stop();
    removeTempDir(dataRoot);
  });

  async function post<T>(path: string, body: unknown): Promise<{ response: Response; json: Envelope<T> }> {
    const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json() as Envelope<T>;
    return { response, json };
  }
  async function query<T>(operation: string, payload: Record<string, unknown> = {}): Promise<Envelope<T>> {
    return (await post<T>("/api/query", { operation, payload })).json;
  }
  async function command<T>(operation: string, payload: Record<string, unknown>, idempotencyKey?: string): Promise<Envelope<T>> {
    return (await post<T>("/api/command", { operation, payload: { command: operation, ...payload }, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) })).json;
  }
  async function upload(fileName = "fixture.pdf", content = samplePdfBytes()): Promise<UploadedFile> {
    const result = await post<UploadedFile>("/api/upload", { fileName, contentBase64: content.toString("base64") });
    expect(result.json.ok).toBe(true);
    return result.json.data;
  }
  async function importDrawing(number = "WEB-001"): Promise<ImportedDrawing> {
    const file = await upload();
    const result = await command<ImportedDrawing>("drawing.create", { drawingNumber: number, name: "HTTP测试图纸", selectedFileToken: file.token, createdAt: instant });
    expect(result.ok).toBe(true);
    return result.data;
  }
  async function finishedRun(runId: string): Promise<RunDetailView> {
    let detail: RunDetailView | undefined;
    await expect.poll(async () => {
      detail = (await query<RunDetailView>("run.getDetail", { runId })).data;
      return detail.run.status;
    }, { timeout: 3000, interval: 10 }).toSatisfy((status: string) => ["COMPLETED", "FAILED", "CLARIFICATION_REQUIRED"].includes(status));
    return detail!;
  }

  it("serves identity-bound source files and requires a current cascade confirmation", async () => {
    const { drawing, revision } = await importDrawing();
    const path = `/api/drawings/${drawing.id}/revisions/${revision.id}/source`;
    const file = await fetch(`${baseUrl}${path}`);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(samplePdfBytes());
    expect((await fetch(`${baseUrl}${path}?download=1`)).headers.get("content-disposition")).toMatch(/^attachment/);
    expect((await fetch(`${baseUrl}${path}`, { method: "HEAD" })).headers.get("content-length")).toBe(String(samplePdfBytes().length));
    const other = await importDrawing("WEB-002");
    expect((await fetch(`${baseUrl}/api/drawings/${other.drawing.id}/revisions/${revision.id}/source`)).ok).toBe(false);
    const impact = (await query<DeletionImpact>("drawing.getDeletionImpact", { drawingId: drawing.id })).data;
    await command("drawing.addRevisionFact", { drawingId: drawing.id, revisionId: revision.id, field: "材料", value: "42CrMo", source: "USER_SUPPLEMENT", createdAt: instant });
    expect((await command("drawing.delete", { drawingId: drawing.id, confirmationToken: impact.confirmationToken })).error?.code).toBe("ENTITY_CONFLICT");
    const fresh = (await query<DeletionImpact>("drawing.getDeletionImpact", { drawingId: drawing.id })).data;
    expect((await command("drawing.delete", { drawingId: drawing.id, confirmationToken: fresh.confirmationToken })).ok).toBe(true);
    expect((await fetch(`${baseUrl}${path}`)).status).toBe(404);
    expect((await query("drawing.getDetail", { drawingId: other.drawing.id })).ok).toBe(true);
  });

  it("persists masked Web credentials and tests the upstream only on explicit request", async () => {
    await server.stop();
    let calls = 0;
    const settings = new SettingsService({ dataRoot, env: {}, fetch: () => { calls++; return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "test-model" }] }))); } });
    await start({ settingsService: settings });
    expect((await fetch(`${baseUrl}/api/settings/runtime`)).status).toBe(200);
    const saved = await post("/api/settings/api-key", { apiKey: "sk-disposable-test-key-1234" });
    expect(saved.json.data).toEqual({ hasApiKey: true, maskedApiKey: "••••1234" });
    expect(JSON.stringify(saved.json)).not.toContain("sk-disposable");
    expect(calls).toBe(0);
    expect((await post("/api/settings/test-connection", {})).json.ok).toBe(true);
    expect(calls).toBe(1);
    expect((await post("/api/settings/api-key", { apiKey: null })).json.data).toEqual({ hasApiKey: false, maskedApiKey: null });
    expect((await post("/api/settings/test-connection", {})).json.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it("reports server identity and unconfigured modeling truthfully", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "READY", modeling: "UNCONFIGURED", serverInstanceId: server.serverInstanceId });
    expect(response.headers.get("X-SWPanel-Server-Instance-Id")).toBe(server.serverInstanceId);
    expect((await query<WorkspaceDashboardView>("workspace.getDashboard")).data.recentDrawings).toEqual([]);
  });

  it("uploads, imports immutable bytes and persists drawing queries across restart", async () => {
    const file = await upload("工程图纸.PDF");
    expect(file).toMatchObject({ format: "PDF", sha256: sha256Of(samplePdfBytes()), sizeBytes: samplePdfBytes().length });
    expect(file.token).toMatch(/^swsel_[0-9a-f]{32}$/);
    const imported = await command<ImportedDrawing>("drawing.create", { drawingNumber: "持久化-001", name: "测试零件", selectedFileToken: file.token, createdAt: instant });
    expect(imported.ok).toBe(true);
    expect(readFileSync(join(dataRoot, imported.data.sourceFile.relativePath))).toEqual(samplePdfBytes());
    expect((await query<ModelingRun[]>("run.list")).data).toEqual([]);
    await server.stop();
    await start();
    const drawingId = imported.data.drawing.id;
    expect((await query<DrawingDetailView>("drawing.getDetail", { drawingId })).data.drawing.name).toBe("测试零件");
    expect((await query<WorkspaceDashboardView>("workspace.getDashboard")).data.recentDrawings).toHaveLength(1);
  });

  it("consumes upload tokens once and allows exact command replay", async () => {
    const file = await upload();
    const payload = { drawingNumber: "TOKEN-001", name: "Token test", selectedFileToken: file.token, createdAt: instant };
    const first = await command<ImportedDrawing>("drawing.create", payload, "import-one");
    const replay = await command<ImportedDrawing>("drawing.create", payload, "import-one");
    expect(replay.data.drawing.id).toBe(first.data.drawing.id);
    expect((await command("drawing.create", { ...payload, drawingNumber: "TOKEN-002" })).error?.code).toBe("TOKEN_NOT_FOUND");
    expect((await command("drawing.create", { ...payload, name: "different" }, "import-one")).error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await query<WorkspaceDashboardView>("workspace.getDashboard")).data.recentDrawings).toHaveLength(1);
  });

  it("keeps the token usable after a rejected business command", async () => {
    await importDrawing("DUPLICATE");
    const file = await upload();
    const payload = { drawingNumber: "DUPLICATE", name: "Duplicate", selectedFileToken: file.token, createdAt: instant };
    expect((await command("drawing.create", payload, "retry")).ok).toBe(false);
    expect((await command("drawing.create", { ...payload, drawingNumber: "CORRECTED" }, "retry")).ok).toBe(true);
  });

  it("keeps successful imports replayable when temporary cleanup is unavailable", async () => {
    const file = await upload();
    const uploadRoot = Reflect.get(server, "uploadRoot") as string;
    const temporaryPath = join(uploadRoot, `${file.token}.pdf`);
    chmodSync(uploadRoot, 0o500);
    try {
      const payload = { drawingNumber: "CLEANUP-001", name: "Cleanup test", selectedFileToken: file.token, createdAt: instant };
      const first = await command<ImportedDrawing>("drawing.create", payload, "cleanup-import");
      expect(first.ok).toBe(true);
      expect(existsSync(temporaryPath)).toBe(true);
      expect((await command<ImportedDrawing>("drawing.create", payload, "cleanup-import")).data.drawing.id).toBe(first.data.drawing.id);
    } finally {
      chmodSync(uploadRoot, 0o700);
    }
  });

  it("creates isolated revisions, switches current version and protects current deletion", async () => {
    const { drawing, revision } = await importDrawing();
    const file = await upload("version2.dxf", Buffer.from("DXF fixture"));
    const next = await command<{ revision: DrawingRevision }>("drawing.createRevision", { drawingId: drawing.id, selectedFileToken: file.token, createdAt: instant });
    expect(next.ok).toBe(true);
    expect(next.data.revision.sequence).toBe(2);
    expect((await query<RevisionDetailView>("revision.getDetail", { drawingId: drawing.id, revisionId: next.data.revision.id })).data.facts).toEqual([]);
    const current = await command<Drawing>("drawing.setCurrentRevision", { drawingId: drawing.id, revisionId: next.data.revision.id, updatedAt: instant });
    expect(current.data.currentRevisionId).toBe(next.data.revision.id);
    expect((await command("drawing.deleteRevision", { drawingId: drawing.id, revisionId: next.data.revision.id, updatedAt: instant })).ok).toBe(false);
    expect((await command("drawing.deleteRevision", { drawingId: drawing.id, revisionId: revision.id, updatedAt: instant })).ok).toBe(true);
  });

  it("preserves intent idempotency on concurrent and later retries of memory facts", async () => {
    const { drawing, revision } = await importDrawing();
    const payload = { drawingId: drawing.id, revisionId: revision.id, field: "材料", value: "42CrMo", source: "USER_SUPPLEMENT", createdAt: instant };
    const responses = await Promise.all([command<RevisionFact>("drawing.addRevisionFact", payload, "fact-one"), command<RevisionFact>("drawing.addRevisionFact", { ...payload, createdAt: "2026-10-01T08:01:00.000Z" }, "fact-one")]);
    expect(responses.map((r) => r.ok)).toEqual([true, true]);
    expect(responses[1].data.id).toBe(responses[0].data.id);
    expect((await command("drawing.addRevisionFact", { ...payload, value: "Q235" }, "fact-one")).error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await command("drawing.addRevisionFact", payload, "fact-two")).ok).toBe(true);
    expect((await command("drawing.addModelingFeedback", { drawingId: drawing.id, revisionId: revision.id, content: "保留端面台阶", createdAt: instant }, "feedback")).ok).toBe(true);
    const detail = (await query<RevisionDetailView>("revision.getDetail", { drawingId: drawing.id, revisionId: revision.id })).data;
    expect(detail.facts).toHaveLength(2);
    expect(detail.modelingFeedback).toHaveLength(1);
  });

  it.each([
    ["/api/query", { operation: "not.allowed", payload: {} }, "UNKNOWN_OPERATION"],
    ["/api/query", { operation: "drawing.getDetail", payload: {} }, "INVALID_PAYLOAD"],
    ["/api/query", { operation: "workspace.getDashboard", payload: { sourcePath: "/etc/passwd" } }, "INVALID_PAYLOAD"],
    ["/api/command", { operation: "run.create", payload: { command: "run.create", drawingId: "x", revisionId: "y", scenario: "success" } }, "INVALID_PAYLOAD"],
    ["/api/query", { operation: "run.create", payload: {} }, "CHANNEL_OPERATION_MISMATCH"],
    ["/api/command", { operation: "drawing.create", payload: { command: "drawing.create", sourceFile: { sha256: "a".repeat(64) } } }, "INVALID_PAYLOAD"],
    ["/api/query", null, "INVALID_ENVELOPE"]
  ])("validates malformed transport input: %s %j", async (path, body, code) => {
    const result = await post(path, body);
    expect(result.response.status).toBe(400);
    expect(result.json.error?.code).toBe(code);
    expect((await query<WorkspaceDashboardView>("workspace.getDashboard")).data.recentDrawings).toEqual([]);
  });

  it("rejects malformed JSON with a structured client error", async () => {
    const response = await fetch(`${baseUrl}/api/query`, { method: "POST", body: "{broken", headers: { "Content-Type": "application/json" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_JSON" } });
  });

  it.each(["../escape.pdf", "sub/file.pdf", "C:\\file.pdf", "file.exe", "file", "file\u0000.pdf"])("rejects unsupported or unsafe upload name %j", async (fileName) => {
    const result = await post("/api/upload", { fileName, contentBase64: samplePdfBytes().toString("base64") });
    expect(result.response.status).toBe(400);
    expect(result.json.ok).toBe(false);
  });

  it("imports a drawing at the 20 MiB limit without overflowing upload validation", async () => {
    const pdf = samplePdfBytes();
    const content = Buffer.concat([pdf, Buffer.alloc(20 * 1024 * 1024 - pdf.length, 10)]);
    const file = await upload("large-drawing.pdf", content);
    expect(file.sizeBytes).toBe(content.length);
    expect(file.sha256).toBe(sha256Of(content));
    const imported = await command<ImportedDrawing>("drawing.create", {
      drawingNumber: "LARGE-001", name: "Large drawing", selectedFileToken: file.token, createdAt: instant
    });
    expect(imported.ok).toBe(true);
    const { drawing, revision } = imported.data;
    const source = await fetch(`${baseUrl}/api/drawings/${drawing.id}/revisions/${revision.id}/source`);
    expect(source.status).toBe(200);
    const downloaded = Buffer.from(await source.arrayBuffer());
    expect(downloaded.length).toBe(content.length);
    expect(sha256Of(downloaded)).toBe(file.sha256);
  }, 15_000);

  it.each(["not base64", "A", "AAAAA", "TQ", "TQ===", "TQ==x===", "TQ==\n", "TQ-_", "TR=="])("rejects non-canonical base64 %j", async (contentBase64) => {
    const result = await post("/api/upload", { fileName: "x.pdf", contentBase64 });
    expect(result.response.status).toBe(400);
    expect(result.json.error?.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects bounded upload bodies", async () => {
    await server.stop();
    await start({ maxUploadBytes: 4, maxRequestBytes: 64 });
    expect((await post("/api/upload", { fileName: "x.pdf", contentBase64: Buffer.from("12345").toString("base64") })).response.status).toBe(413);
    expect((await post("/api/query", { operation: "workspace.getDashboard", payload: { huge: "a".repeat(128) } })).response.status).toBe(413);
  });

  it("expires upload credentials", async () => {
    await server.stop();
    await start({ uploadTokenTtlMs: 0 });
    const file = await upload();
    expect((await command("drawing.create", { drawingNumber: "EXPIRED", name: "expired", selectedFileToken: file.token, createdAt: instant })).error?.code).toBe("TOKEN_NOT_FOUND");
  });

  it("allows the dev origin and refuses unrelated websites without wildcard CORS", async () => {
    const allowed = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "http://127.0.0.1:5173" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:5173");
    const denied = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "https://unrelated.example" } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("fails unconfigured execution at PREPARING and streams ordered replay cursors", async () => {
    const { drawing, revision } = await importDrawing();
    const run = (await command<ModelingRun>("run.create", { drawingId: drawing.id, revisionId: revision.id })).data;
    const detail = await finishedRun(run.id);
    expect(detail.run).toMatchObject({ status: "FAILED", failureCode: "AGENT_RUNTIME_UNAVAILABLE", modelId: null });
    const fromSequence = detail.events[0]!.sequence;
    const response = await fetch(`${baseUrl}/api/runs/${run.id}/events?fromSequence=${fromSequence}`, { signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const text = new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain(`id: ${fromSequence}`);
    expect(text).not.toContain(`id: ${fromSequence - 1}\n`);
    expect(text).toContain(server.serverInstanceId);
    await reader.cancel();
    const resumed = await fetch(`${baseUrl}/api/runs/${run.id}/events?fromSequence=0`, { headers: { "Last-Event-ID": String(fromSequence) }, signal: AbortSignal.timeout(2000) });
    const resumedReader = resumed.body!.getReader();
    const resumedText = new TextDecoder().decode((await resumedReader.read()).value);
    expect(resumedText).not.toContain(`id: ${fromSequence}\n`);
    expect(resumedText).toContain(": connected");
    await resumedReader.cancel();
  });

  it("rejects unknown Runs and malformed event cursors before opening SSE", async () => {
    expect((await fetch(`${baseUrl}/api/runs/missing/events`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/runs/missing/events?fromSequence=-1`)).status).toBe(400);
  });

  it("streams live commits through completion after the persisted backlog", async () => {
    await server.stop();
    await start({ runnerConfig: { fakeExecutorStepDelayMs: 10 } });
    const { drawing, revision } = await importDrawing();
    const run = (await command<ModelingRun>("run.create", { drawingId: drawing.id, revisionId: revision.id })).data;
    const response = await fetch(`${baseUrl}/api/runs/${run.id}/events`, { signal: AbortSignal.timeout(3000) });
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes('"type":"Completed"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(ids.length).toBeGreaterThan(1);
    expect(ids).toEqual([...new Set(ids)].sort((a, b) => a - b));
    expect(text).toContain('"type":"StageChanged"');
    expect(text).toContain('"type":"Completed"');
    await reader.cancel();
  });

  it("explicit test executor supports review, deterministic reports and immutable cost snapshots", async () => {
    await server.stop();
    await start({ runnerConfig: {} });
    const { drawing, revision } = await importDrawing();
    const run = (await command<ModelingRun>("run.create", { drawingId: drawing.id, revisionId: revision.id })).data;
    const detail = await finishedRun(run.id);
    expect(detail.run.status).toBe("COMPLETED");
    const modelId = detail.run.modelId!;
    const model = (await query<ModelDetailView>("model.getDetail", { modelId })).data;
    expect(model.model.productionVerified).toBe(false);
    const costData = (await query<CostDataSnapshot>("costData.get")).data;
    const input: CostEstimateInputSnapshot = {
      drawingId: drawing.id, revisionId: revision.id, modelId,
      quantity: 5, materialId: costData.materials[0]!.id, stockType: "CYLINDER",
      stockSpec: "Ø320 × 820 mm", finishedVolume: 0.031,
      allowances: [{ name: "直径余量", valueMm: 20 }, { name: "长度余量", valueMm: 20 }],
      costData, formulaVersion: "2026.08-p7", capturedAt: instant
    };
    expect((await command("costReport.create", { input, createdAt: instant })).ok).toBe(false);
    expect((await command("model.review", { modelId, result: "APPROVED", reviewerId: "test-reviewer", reviewedAt: instant })).ok).toBe(true);
    expect((await query<ModelDetailView>("model.getDetail", { modelId })).data.model.isCurrentApproved).toBe(true);
    expect((await command("costReport.create", { input, createdAt: instant })).ok).toBe(false);
    registerGeometryFixture(dataRoot, modelId);
    input.finishedVolume = 5; // Browser-supplied values must not become authoritative.
    input.costData = { ...costData, materials: costData.materials.map(m => ({ ...m, purchasePrice: 1 })) };
    const report = await command<CostReportDetailView>("costReport.create", { input, createdAt: instant });
    expect(report.ok).toBe(true);
    expect(report.data.result.totalCost).toBeGreaterThan(0);
    expect(report.data.snapshot.input.finishedVolume).toBe(0.031);
    expect(report.data.snapshot.input.costData.materials[0]!.purchasePrice).toBe(costData.materials[0]!.purchasePrice);
    const updated = { ...costData, materials: costData.materials.map((m) => ({ ...m, purchasePrice: m.purchasePrice * 2 })), updatedAt: instant };
    expect((await command("costData.update", { snapshot: updated })).ok).toBe(true);
    expect((await query<CostReportDetailView>("costReport.getDetail", { costReportId: report.data.costReportId })).data.result.totalCost).toBe(report.data.result.totalCost);
    expect((await command("costReport.delete", { costReportId: report.data.costReportId, revisionId: revision.id })).ok).toBe(true);
    expect((await query("costReport.getDetail", { costReportId: report.data.costReportId })).ok).toBe(false);
  });

  it("rejects port conflicts asynchronously and releases database resources", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    const otherRoot = makeTempDir("web-server-conflict");
    const other = new WebServer({ dataRoot: otherRoot, port: typeof address === "object" && address !== null ? address.port : 0 });
    try {
      await expect(other.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
      await other.stop();
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
      removeTempDir(otherRoot);
    }
    expect(readdirSync(join(dataRoot, "state"))).toContain("swpanel.db");
  });

  async function rawGet(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    const url = new URL(baseUrl);
    return await new Promise((resolve, reject) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path, method: "GET", headers }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("keeps storage settings readable but refuses to change them or reach non-Web operations over HTTP", async () => {
    const current = (await query<{ settings: { dataRoot: string; workspaceRoot: string; constraint: string } }>("storage.getSettings")).data.settings;
    const attempt = await command("storage.updateSettings", { settings: { ...current, workspaceRoot: join(dataRoot, "elsewhere"), updatedAt: instant } });
    expect(attempt.ok).toBe(false);
    expect(attempt.error?.code).toBe("OPERATION_NOT_AVAILABLE");
    expect((await query<{ settings: { workspaceRoot: string } }>("storage.getSettings")).data.settings.workspaceRoot).toBe(current.workspaceRoot);
    const secret = await command("secrets.setApiKey", { apiKey: "sk-should-never-travel-here" });
    expect(secret.error?.code).toBe("OPERATION_NOT_AVAILABLE");
    expect(JSON.stringify(secret)).not.toContain("sk-should-never");
  });

  it("rejects foreign Host headers (DNS rebinding) and accepts loopback names", async () => {
    const port = new URL(baseUrl).port;
    const rebinding = await rawGet("/api/health", { Host: `attacker.example:${port}` });
    expect(rebinding.status).toBe(421);
    expect((JSON.parse(rebinding.body) as Envelope<unknown>).error?.code).toBe("HOST_NOT_ALLOWED");
    expect((await rawGet("/api/health", { Host: `localhost:${port}` })).status).toBe(200);
    expect((await rawGet("/api/health", { Host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await rawGet("/api/health", { Host: "127.0.0.1:1" })).status).toBe(421);
  });

  it("accepts configured extra Host names", async () => {
    await server.stop();
    await start({ allowedHosts: ["swpanel.internal"] });
    const port = new URL(baseUrl).port;
    expect((await rawGet("/api/health", { Host: `swpanel.internal:${port}` })).status).toBe(200);
  });

  it("refuses unlisted Origins and browser cross-site requests without Origin, but allows same-origin and tooling", async () => {
    const forged = await fetch(`${baseUrl}/api/query`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://unrelated.example" }, body: JSON.stringify({ operation: "run.list", payload: {} }) });
    expect(forged.status).toBe(403);
    expect((await rawGet("/api/health", { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await rawGet("/api/health", { Origin: baseUrl })).status).toBe(200);
    expect((await post("/api/query", { operation: "run.list", payload: {} })).response.status).toBe(200);
  });

  it("returns stable public error codes with fixed Chinese messages and never leaks details", async () => {
    await importDrawing("PUBLIC-001");
    const file = await upload();
    const duplicate = await command("drawing.create", { drawingNumber: "PUBLIC-001", name: "dup", selectedFileToken: file.token, createdAt: instant });
    expect(duplicate.error?.code).toBe("DRAWING_NUMBER_DUPLICATE");
    expect(duplicate.error?.message).toMatch(/[\u4e00-\u9fa5]/);
    expect(duplicate.error?.message).not.toContain("PUBLIC-001");
    const missing = await query("drawing.getDetail", { drawingId: "does-not-exist" });
    expect(missing.error?.code).toBe("NOT_FOUND");
    expect(missing.error?.message).not.toContain("does-not-exist");
    expect((await post("/api/upload", { fileName: "x.exe", contentBase64: "QQ==" })).json.error?.code).toBe("INPUT_UNSUPPORTED");
  });

  it.each(["\u202Egpj.pdf", ".hidden.pdf", "zero\u200Bwidth.pdf", "c1\u0085.pdf"])("rejects deceptive upload name %j", async (fileName) => {
    const result = await post("/api/upload", { fileName, contentBase64: samplePdfBytes().toString("base64") });
    expect(result.response.status).toBe(400);
    expect(result.json.error?.code).toBe("INVALID_FILE_NAME");
  });

  it("answers malformed percent-encoding with 400 instead of 500", async () => {
    expect((await fetch(`${baseUrl}/api/runs/%E0%A4%A/events`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/models/%E0%A4%A/artifacts/x`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/runs/bad%20id/events`)).status).toBe(400);
  });

  it("reports missing registered files as 404 rather than a generic failure", async () => {
    expect((await fetch(`${baseUrl}/api/models/nope/artifacts/nope`)).status).toBe(404);
  });

  it("caps staged upload bytes with a stable code", async () => {
    await server.stop();
    await start({ maxStagedBytes: samplePdfBytes().length * 2 });
    await upload();
    const second = await post("/api/upload", { fileName: "second.pdf", contentBase64: samplePdfBytes().toString("base64") });
    expect(second.response.status).toBe(429);
    expect(second.json.error?.code).toBe("UPLOAD_STORAGE_FULL");
  });

  it("caps SSE connections per Run", async () => {
    await server.stop();
    await start({ maxSseClientsPerRun: 1 });
    const { drawing, revision } = await importDrawing();
    const run = (await command<ModelingRun>("run.create", { drawingId: drawing.id, revisionId: revision.id })).data;
    await finishedRun(run.id);
    const first = await fetch(`${baseUrl}/api/runs/${run.id}/events`, { signal: AbortSignal.timeout(3000) });
    expect(first.status).toBe(200);
    const second = await fetch(`${baseUrl}/api/runs/${run.id}/events`, { signal: AbortSignal.timeout(3000) });
    expect(second.status).toBe(429);
    expect((await second.json() as Envelope<unknown>).error?.code).toBe("SSE_LIMIT");
    await first.body!.cancel();
  });
});
