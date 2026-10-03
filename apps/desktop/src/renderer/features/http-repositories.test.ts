import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateIpcRequestEnvelope } from "@swpanel/contracts";
import type { CostEstimateInputSnapshot } from "@swpanel/domain";
import { HttpDrawingRepository } from "./bridge-repository/http-drawing-repository.js";
import { HttpRunRepository } from "./run-repository/http-run-repository.js";
import { HttpCostRepository } from "./cost-repository/http-cost-repository.js";
import { HttpModelRepository } from "./model-repository/http-model-repository.js";
import { HttpTransport, httpIntentKey } from "./http-transport.js";
import { DrawingRepositoryError } from "./bridge-repository/drawing-repository.js";
import { progressEvent } from "../fixtures/runs.js";

const NOW = "2026-10-01T00:00:00.000Z";
const options = { baseUrl: "http://127.0.0.1:3001/" };
const selected = { token: `swsel_${"a".repeat(32)}`, fileName: "drawing.pdf", format: "PDF" as const, sizeBytes: 1, sha256: "a".repeat(64) };
type ApiFetch = (url: string, init: RequestInit & { body: string }) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<ApiFetch>>;
interface HttpRequestBody {
  operation: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}
const body = (index = 0): HttpRequestBody => JSON.parse(fetchMock.mock.calls[index]![1].body) as HttpRequestBody;
function success(data: unknown) { return new Response(JSON.stringify({ ok: true, data }), { status: 200 }); }
function canonical(index = 0) {
  const request = body(index);
  return validateIpcRequestEnvelope({ protocolVersion: 1, requestId: "test", channel: fetchMock.mock.calls[index]![0].endsWith("/query") ? "query" : "command", ...request });
}

beforeEach(() => {
  fetchMock = vi.fn<ApiFetch>().mockImplementation(() => Promise.resolve(success({ marker: "result" })));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("HTTP repositories match the Runner contract", () => {
  it("resolves real route IDs and scoped revision IDs", () => {
    const repo = new HttpDrawingRepository(options);
    expect(repo.resolveDrawingParam("drawing-id")).toBe("drawing-id");
    expect(repo.resolveDrawingParam(undefined)).toBeNull();
    expect(repo.resolveRevisionParam(null, "revision-id")).toBeNull();
    expect(repo.resolveRevisionParam("drawing-id", "")).toBeNull();
    expect(repo.resolveRevisionParam("drawing-id", "revision-id")).toBe("revision-id");
  });

  it("sends upload credentials from the selected file for import and revisions", async () => {
    const repo = new HttpDrawingRepository(options);
    await repo.importDrawing({ drawingNumber: "D01", name: "零件", file: selected, createdAt: NOW });
    await repo.addRevision({ drawingId: "drawing-id", file: selected, createdAt: NOW });
    expect(body()).toMatchObject({ operation: "drawing.create", payload: { command: "drawing.create", drawingNumber: "D01", name: "零件", selectedFileToken: selected.token, createdAt: NOW } });
    expect(body().idempotencyKey).toBeTypeOf("string");
    expect(body(1).payload.selectedFileToken).toBe(selected.token);
    expect(body(1).payload.command).toBe("drawing.createRevision");
  });

  it("returns domain mutations directly and sends stable per-submission keys outside payload", async () => {
    const repo = new HttpDrawingRepository(options);
    expect(await repo.setCurrentRevision({ drawingId: "drawing-id", revisionId: "revision-id", updatedAt: NOW })).toEqual({ marker: "result" });
    canonical();
    const input = { drawingId: "drawing-id", revisionId: "revision-id", field: "material", value: "steel", source: "USER_SUPPLEMENT" as const, createdAt: NOW, clientIntentId: `swint_${"a".repeat(32)}` };
    expect(await repo.addRevisionFact(input)).toEqual({ marker: "result" });
    await repo.addRevisionFact({ ...input, createdAt: "2026-10-02T00:00:00.000Z" });
    await repo.addRevisionFact({ ...input, clientIntentId: `swint_${"b".repeat(32)}` });
    expect(body(1).payload.clientIntentId).toBeUndefined();
    expect(body(1).idempotencyKey).toBe(body(2).idempotencyKey);
    expect(body(1).idempotencyKey).not.toBe(body(3).idempotencyKey);
    canonical(1);
    await repo.addModelingFeedback({ drawingId: "drawing-id", revisionId: "revision-id", content: "fix", createdAt: NOW, clientIntentId: input.clientIntentId });
    canonical(4);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("uses canonical Run creation, clarification submit and full review metadata", async () => {
    const run = new HttpRunRepository(options);
    await run.createRun({ drawingId: "drawing-id", revisionId: "revision-id" });
    expect(body().payload).toEqual({ command: "run.create", drawingId: "drawing-id", revisionId: "revision-id" });
    canonical();
    await run.submitClarification({ clarificationRequestId: "clarification-id", answers: [{ id: "answer-id", questionId: "question-id", value: { kind: "text", value: "steel" }, answeredAt: NOW, answeredBy: "user" }], answeredAt: NOW, answeredBy: "user" });
    canonical(1);
    const model = new HttpModelRepository(options);
    await model.reviewModel({ modelId: "model-id", result: "APPROVED", reviewerId: "reviewer", reviewedAt: NOW });
    canonical(2);
    expect(body(2).payload.reviewerId).toBe("reviewer");
  });

  it("exposes the cost methods used by pages and preserves frozen report input", async () => {
    const repo = new HttpCostRepository(options);
    await repo.getCostReportDetail("report-id");
    canonical();
    // The adapter must transmit the caller's frozen input without inventing fields.
    const input: CostEstimateInputSnapshot = {
      drawingId: "drawing-id", revisionId: "revision-id", modelId: "model-id", quantity: 1,
      stockType: "CYLINDER", stockSpec: "Ø10 × 20 mm", materialId: "steel", finishedVolume: 0.01,
      allowances: [], costData: { materials: [], allowances: [], fixedCosts: [], customFields: [], capturedAt: NOW },
      formulaVersion: "v1", capturedAt: NOW
    };
    await repo.createCostReport(input, NOW);
    expect(body(1)).toEqual({ operation: "costReport.create", payload: { command: "costReport.create", input, createdAt: NOW } });
    canonical(1);
    await repo.deleteCostReport({ costReportId: "report-id", revisionId: "revision-id" });
    canonical(2);
    await repo.updateCostData(input.costData);
    canonical(3);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("uses the dashboard drawing list and unwraps its aggregate", async () => {
    fetchMock.mockResolvedValueOnce(success({ recentDrawings: [{ drawingId: "drawing-id" }] }));
    expect(await new HttpDrawingRepository(options).listDrawings()).toEqual([{ drawingId: "drawing-id" }]);
    canonical();
  });
});

describe("httpIntentKey in non-secure contexts", () => {
  it("produces the same key with and without crypto.subtle", async () => {
    const payload = { drawingNumber: "A-1", createdAt: NOW, createdBy: "someone" };
    const withSubtle = await httpIntentKey("drawing.create", "swsel_x", payload);
    vi.stubGlobal("crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const withoutSubtle = await httpIntentKey("drawing.create", "swsel_x", { ...payload, createdAt: "2030-01-01T00:00:00.000Z" });
    expect(withSubtle).toMatch(/^intent:[0-9a-f]{64}$/);
    expect(withoutSubtle).toBe(withSubtle);
  });
});

describe("HTTP transport failures", () => {
  const transport = () => new HttpTransport(options, DrawingRepositoryError);
  it("preserves structured business errors even with non-success status", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { code: "INVALID_PAYLOAD", message: "invalid file" } }), { status: 400 }));
    await expect(transport().query("drawing.getDetail")).rejects.toMatchObject({ name: "DrawingRepositoryError", code: "INVALID_PAYLOAD", message: "invalid file" });
  });
  it("settles network and malformed response failures as repository errors", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(transport().query("drawing.getDetail")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    fetchMock.mockResolvedValueOnce(new Response("not JSON"));
    await expect(transport().query("drawing.getDetail")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    fetchMock.mockResolvedValueOnce(success(undefined));
    await expect(transport().query("drawing.getDetail")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("browser file picker", () => {
  it("settles explicit cancellation and removes the temporary input", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) { this.dispatchEvent(new Event("cancel")); });
    await expect(new HttpDrawingRepository(options).selectDrawingFile()).resolves.toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["error", "abort"])("settles FileReader %s as a file read failure", async eventType => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, "files", { value: [new File(["PDF"], "drawing.pdf")] });
      this.dispatchEvent(new Event("change"));
    });
    vi.spyOn(FileReader.prototype, "readAsArrayBuffer").mockImplementation(function (this: FileReader) { this.dispatchEvent(new Event(eventType)); });
    await expect(new HttpDrawingRepository(options).selectDrawingFile()).rejects.toMatchObject({ code: "FILE_READ_FAILED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uploads the selected bytes and rejects server errors instead of treating them as cancellation", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, "files", { value: [new File(["%PDF-1"], "drawing.pdf")] });
      this.dispatchEvent(new Event("change"));
    });
    fetchMock.mockResolvedValueOnce(success(selected));
    expect(await new HttpDrawingRepository(options).selectDrawingFile()).toEqual(selected);
    expect(body()).toEqual({ fileName: "drawing.pdf", contentBase64: btoa("%PDF-1") });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { code: "INVALID_FILE", message: "invalid PDF" } }), { status: 400 }));
    await expect(new HttpDrawingRepository(options).selectDrawingFile()).rejects.toMatchObject({ code: "INVALID_FILE" });
  });
});

class FakeEventSource {
  static latest: FakeEventSource;
  onmessage: ((message: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) { FakeEventSource.latest = this; }
  push(events: unknown[], serverInstanceId = "instance-1") { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "events", events, serverInstanceId }) })); }
}

describe("HTTP Run event subscriptions", () => {
  beforeEach(() => vi.stubGlobal("EventSource", FakeEventSource));
  const event = (sequence: number) => progressEvent("run-id", sequence, NOW, sequence * 10);
  it("treats zero as full history whose first persisted event is sequence one", () => {
    const push = vi.fn();
    new HttpRunRepository(options).subscribeRunEvents({ runId: "run-id", fromSequence: 0 }, push);
    FakeEventSource.latest.push([event(1), event(2)]);
    expect(push.mock.calls[0]![0]).toMatchObject({ kind: "runEvents", fromSequence: 1, events: [event(1), event(2)] });
  });
  it("subscribes from the snapshot cursor, filters duplicates and tears down", () => {
    const push = vi.fn();
    const dispose = new HttpRunRepository(options).subscribeRunEvents({ runId: "run-id", fromSequence: 2 }, push);
    const source = FakeEventSource.latest;
    expect(source.url).toContain("/api/runs/run-id/events?fromSequence=2");
    source.push([event(1), event(2), event(3)]);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]![0]).toMatchObject({ kind: "runEvents", fromSequence: 2, events: [event(2), event(3)] });
    source.push([event(3)]);
    expect(push).toHaveBeenCalledTimes(1);
    dispose();
    source.push([event(4)]);
    expect(source.close).toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
  });
  it.each(["gap", "disconnect", "malformed", "restart"])("reports %s to allow snapshot refetch", kind => {
    const push = vi.fn();
    new HttpRunRepository(options).subscribeRunEvents({ runId: "run-id", fromSequence: 0 }, push);
    const source = FakeEventSource.latest;
    if (kind === "gap") source.push([event(2)]);
    if (kind === "disconnect") source.onerror?.();
    if (kind === "malformed") source.onmessage?.(new MessageEvent("message", { data: "{" }));
    if (kind === "restart") { source.push([event(0)]); source.push([event(1)], "instance-2"); }
    expect(push.mock.calls.at(-1)![0]).toMatchObject({ kind: "runEventsError", runId: "run-id" });
    expect(source.close).toHaveBeenCalled();
  });
});
