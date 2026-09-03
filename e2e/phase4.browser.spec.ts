import { expect, test, type Page } from "@playwright/test";
import { validateRuntimeMetadata } from "@swpanel/contracts";

type EventRecord = {
  sequence: number;
  type: string;
  occurredAt: string;
  stage?: string;
  activity?: string;
  progressPercent?: number;
  metadata?: Record<string, unknown>;
  turnId?: string;
  manifestRef?: string;
  clarificationRequestId?: string;
};
type RunRecord = {
  runId: string; runLabel: string; drawingId: string; revisionId: string; status: string;
  stage: string | null; activity: string | null; progressPercent: number | null;
  createdAt: string; startedAt: string | null; completedAt: string | null;
  failureCode: string | null; failureMessage: string | null; modelId: string | null;
  clarificationRequestId: string | null; events: EventRecord[];
};
type Question = { questionId: string; type: "dimension" | "choice"; question: string; hint: string | null; unit: string | null; options: { id: string; label: string }[] };
type Clarification = { clarificationRequestId: string; runId: string; revisionId: string; status: "OPEN" | "ANSWERED"; createdAt: string; questions: Question[]; answers: { answerId: string; questionId: string; value: unknown; answeredAt: string }[] };
type BridgeResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
type FakeApi = { runs: { list: () => Promise<BridgeResult<unknown>>; getDetail: (id: string) => Promise<BridgeResult<unknown>>; create: (input: { drawingId: string; revisionId: string }) => Promise<BridgeResult<RunRecord & { id: string }>>; cancel: () => Promise<BridgeResult<never>>; subscribe: (input: { runId: string; fromSequence: number }, onPush: (value: unknown) => void) => () => void }; clarifications: { get: (id: string) => Promise<BridgeResult<Clarification>>; submit: (input: { clarificationRequestId: string; answers: unknown[]; answeredAt: string; answeredBy: string }) => Promise<BridgeResult<Clarification>> }; drawings: Record<string, unknown>; metadata: unknown; health: unknown; files: unknown; storage: unknown };
type FakeHook = { calls: string[] };

const drawing = { id: "drawing-p4", drawingNumber: "P4-001", name: "Phase 4 fixture", currentRevisionId: "revision-p4", createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" };
const phase4Events: EventRecord[] = [
  { sequence: 1, type: "StageChanged", stage: "PREPARING", activity: "准备建模任务", occurredAt: "2026-08-13T00:01:00.000Z" },
  { sequence: 2, type: "ActivityUpdated", activity: "准备建模任务", occurredAt: "2026-08-13T00:01:00.000Z" },
  { sequence: 3, type: "ProgressUpdated", progressPercent: 17, activity: "准备建模任务", occurredAt: "2026-08-13T00:01:00.000Z" },
  {
    sequence: 4,
    type: "RuntimeMetadataUpdated",
    metadata: {
      contractVersion: 1,
      runtime: {
        adapterId: "codex-app-server",
        adapterVersion: "0.1.0",
        protocol: "codex-app-server",
        protocolVersion: "1",
        modelId: "codex-app-server",
        modelSupportsImageInput: true
      },
      session: { threadId: "thread-run-p4" },
      updatedAt: "2026-08-13T00:02:00.000Z"
    },
    occurredAt: "2026-08-13T00:02:00.000Z"
  },
  { sequence: 5, type: "AgentTurnCompleted", turnId: "turn-run-p4-1", occurredAt: "2026-08-13T00:02:00.000Z" },
  { sequence: 6, type: "ResultManifestReceived", manifestRef: "output/result-manifest.json", occurredAt: "2026-08-13T00:02:00.000Z" },
  { sequence: 7, type: "Completed", occurredAt: "2026-08-13T00:03:00.000Z" }
];
const clarificationSeed: Clarification = { clarificationRequestId: "clarification-p4", runId: "run-clarification-p4", revisionId: drawing.currentRevisionId, status: "OPEN", createdAt: "2026-08-13T00:04:00.000Z", questions: [{ questionId: "thickness", type: "dimension", question: "底板厚度是多少？", hint: "12", unit: "mm", options: [] }, { questionId: "treatment", type: "choice", question: "焊缝处理方式？", hint: null, unit: null, options: [{ id: "none", label: "无需焊缝" }, { id: "full", label: "全周满焊" }] }], answers: [] };

// Keep the browser fixture aligned with the same strict Runtime Metadata
// contract used by the Runner's product-event translator.
validateRuntimeMetadata(phase4Events[3]?.metadata);

type BridgeInit = { drawing: typeof drawing; phase4Events: typeof phase4Events; clarificationSeed: typeof clarificationSeed };
function installBridge(init: BridgeInit): void {
  const drawing = init.drawing;
  const phase4Events = init.phase4Events;
  const clarificationSeed = init.clarificationSeed;
  const calls: string[] = [];
  const runs = new Map<string, RunRecord>();
  const clarifications = new Map<string, Clarification>([[clarificationSeed.clarificationRequestId, structuredClone(clarificationSeed)]]);
  const makeRun = (runId: string, runLabel: string, status: string, events: EventRecord[], clarificationRequestId: string | null = null): RunRecord => ({ runId, runLabel, drawingId: drawing.id, revisionId: drawing.currentRevisionId, status, stage: null, activity: null, progressPercent: null, createdAt: drawing.createdAt, startedAt: drawing.createdAt, completedAt: status === "COMPLETED" ? "2026-08-13T00:03:00.000Z" : drawing.updatedAt, failureCode: null, failureMessage: null, modelId: null, clarificationRequestId, events: structuredClone(events) });
  runs.set("run-p4", makeRun("run-p4", "R01", "COMPLETED", phase4Events));
  runs.set("run-clarification-p4", makeRun("run-clarification-p4", "R02", "CLARIFICATION_REQUIRED", [{ sequence: 1, type: "ClarificationRequired", clarificationRequestId: clarificationSeed.clarificationRequestId, occurredAt: drawing.updatedAt }], clarificationSeed.clarificationRequestId));
  const ok = <T,>(data: T): Promise<BridgeResult<T>> => Promise.resolve({ ok: true, data });
  const fail = <T,>(code: string): Promise<BridgeResult<T>> => Promise.resolve({ ok: false, error: { code, message: "unused" } });
  const detail = (run: RunRecord): { run: RunRecord; events: EventRecord[]; lastEventSequence: number } => ({ run, events: run.events, lastEventSequence: run.events.at(-1)?.sequence ?? 0 });
  const api: FakeApi = { metadata: { versions: { electron: "1", chrome: "1" } }, health: {}, files: {}, storage: {}, drawings: { list: () => ok([]), getDetail: () => ok({ drawing: { drawingId: drawing.id, drawingNumber: drawing.drawingNumber, name: drawing.name, currentRevisionId: drawing.currentRevisionId, createdAt: drawing.createdAt, updatedAt: drawing.updatedAt }, revisions: [{ revisionId: drawing.currentRevisionId, revisionLabel: "V1", isCurrent: true }] }), getHistory: () => ok({ drawingId: drawing.id, drawingNumber: drawing.drawingNumber, name: drawing.name, currentRevisionId: drawing.currentRevisionId, revisions: [] }), getRevisionDetail: () => ok({ revision: { revisionId: drawing.currentRevisionId, revisionLabel: "V1", drawingId: drawing.id, drawingNumber: drawing.drawingNumber, drawingName: drawing.name, isCurrent: true }, runs: [], models: [], costReports: [], facts: [], modelingFeedback: [] }), getRevisionHistory: () => ok({ revisionId: drawing.currentRevisionId, revisionLabel: "V1", drawingId: drawing.id, drawingNumber: drawing.drawingNumber, isCurrent: true, facts: [], modelingFeedback: [] }), addRevisionFact: () => fail("NOT_IMPLEMENTED"), addModelingFeedback: () => fail("NOT_IMPLEMENTED"), importDrawing: () => fail("NOT_IMPLEMENTED"), addRevision: () => fail("NOT_IMPLEMENTED"), setCurrentRevision: () => fail("NOT_IMPLEMENTED"), deleteRevision: () => fail("NOT_IMPLEMENTED") }, runs: { list: () => ok([...runs.values()]), getDetail: (id) => { calls.push(`runs.getDetail:${id}`); const run = runs.get(id); return run === undefined ? fail("NOT_FOUND") : ok(detail(run)); }, create: (input) => { calls.push(`runs.create:${JSON.stringify(input)}`); const run = makeRun("run-new-p4", "R03", "QUEUED", []); runs.set(run.runId, run); return ok({ ...run, id: run.runId }); }, cancel: () => fail("NOT_IMPLEMENTED"), subscribe: (input, onPush) => { const run = runs.get(input.runId); const events = run?.events.filter((event) => event.sequence >= input.fromSequence) ?? []; if (events.length > 0) onPush({ kind: "runEvents", runId: input.runId, fromSequence: events[0]?.sequence, events }); return () => undefined; } }, clarifications: { get: (id) => { const value = clarifications.get(id); return value === undefined ? fail("NOT_FOUND") : ok(value); }, submit: (input) => { calls.push(`clarifications.submit:${JSON.stringify(input)}`); const value = clarifications.get(input.clarificationRequestId); if (value === undefined) return fail("NOT_FOUND"); value.status = "ANSWERED"; value.answers = input.answers.map((answer) => { const record = answer as { id: string; questionId: string; value: unknown }; return { answerId: record.id, questionId: record.questionId, value: record.value, answeredAt: input.answeredAt }; }); return ok(value); } } };
  const target = globalThis as unknown as { swpanel: FakeApi; __swpanelFake: FakeHook };
  target.swpanel = api; target.__swpanelFake = { calls };
}
async function open(page: Page, route: string): Promise<void> { page.on("pageerror", (error) => console.log(`phase4 pageerror: ${error.message}`)); await page.addInitScript(installBridge, { drawing, phase4Events, clarificationSeed }); await page.setViewportSize({ width: 1366, height: 768 }); await page.goto(route, { waitUntil: "networkidle" }); await expect(page.locator("[data-route-id]")).toBeVisible(); }

test.describe("Phase 4 product event and clarification UI", () => {
  test("renders Agent protocol product events and manifest completion without fake controls", async ({ page }) => { await open(page, "/#/runs/run-p4"); await expect(page.getByText("已完成", { exact: true }).first()).toBeVisible(); const stream = page.locator(".section").filter({ hasText: "结构化事件" }); for (const label of ["RuntimeMetadataUpdated", "AgentTurnCompleted", "ResultManifestReceived", "Completed"]) await expect(stream.locator(".run-detail-stage-label").filter({ hasText: new RegExp(`^${label}$`) })).toHaveCount(1); await expect(page.getByText("场景", { exact: true })).toHaveCount(0); await expect(page).not.toHaveURL(/scenario=/); });
  test("submits clarification answers and creates a new Run", async ({ page }) => { await open(page, "/#/runs/run-clarification-p4"); await expect(page.getByText("需要补充 2 项信息")).toBeVisible(); await page.getByRole("textbox", { name: "底板厚度是多少？" }).fill("12"); await page.getByRole("combobox", { name: "焊缝处理方式？" }).selectOption({ label: "全周满焊" }); await page.getByRole("button", { name: "提交补充信息" }).click(); await expect(page.getByText("补充信息已保存至版本记忆")).toBeVisible(); await expect(page.getByRole("link", { name: "前往版本记忆更新 Facts" })).toBeVisible(); await page.getByRole("button", { name: "重新自动建模" }).click(); await expect(page).toHaveURL(/#\/runs\/run-new-p4/); const hook = await page.evaluate(() => (globalThis as unknown as { __swpanelFake: FakeHook }).__swpanelFake); expect(hook.calls.some((call) => call.startsWith("clarifications.submit:"))).toBe(true); });
});
