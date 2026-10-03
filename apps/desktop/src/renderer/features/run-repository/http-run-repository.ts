import type { ModelingRun, RunEvent } from "@swpanel/domain";
import { validateProductEvent } from "@swpanel/contracts/product-events";
import type { ClarificationView, RunDetailView, RunListItemView } from "@swpanel/contracts";
import type { RunCancelBridgeResult, RunDeleteBridgeResult, RunEventsBridgePush } from "../../../main/bridge/bridge-contract.js";
import { HttpTransport, type HttpRepositoryOptions } from "../http-transport.js";
import { RunRepositoryError, type CancelRunInput, type CreateRunInput, type DeleteRunInput, type RunEventSubscriptionInput, type RunRepository, type SubmitClarificationInput } from "./run-repository.js";

export class HttpRunRepository implements RunRepository {
  readonly mode = "bridge" as const;
  readonly mock = null;
  private readonly transport: HttpTransport;

  constructor(options: HttpRepositoryOptions = {}) {
    this.transport = new HttpTransport(options, RunRepositoryError);
  }

  listRuns(): Promise<readonly RunListItemView[]> { return this.transport.query("run.list"); }
  getRunDetail(runId: string): Promise<RunDetailView> { return this.transport.query("run.getDetail", { runId }); }
  getClarification(clarificationRequestId: string): Promise<ClarificationView> { return this.transport.query("clarification.get", { clarificationRequestId }); }
  createRun(input: CreateRunInput): Promise<ModelingRun> { return this.transport.command("run.create", { drawingId: input.drawingId, revisionId: input.revisionId }); }
  cancelRun(input: CancelRunInput): Promise<RunCancelBridgeResult> { return this.transport.command("run.cancel", { ...input }); }
  deleteRun(input: DeleteRunInput): Promise<RunDeleteBridgeResult> { return this.transport.command("run.delete", { ...input }); }
  submitClarification(input: SubmitClarificationInput): Promise<ClarificationView> { return this.transport.command("clarification.submit", { ...input }); }

  subscribeRunEvents(input: RunEventSubscriptionInput, onPush: (push: RunEventsBridgePush) => void): () => void {
    let source: EventSource | undefined;
    let closed = false;
    // Runner sequences start at one; zero means request the entire history.
    let nextSequence = Math.max(1, input.fromSequence);
    let serverInstanceId: string | undefined;
    const fail = (code: string, message: string) => {
      if (closed) return;
      closed = true;
      source?.close();
      onPush({ kind: "runEventsError", runId: input.runId, error: { code, message } });
    };
    if (typeof EventSource === "undefined") {
      fail("STREAM_UNAVAILABLE", "当前浏览器不支持任务事件订阅");
      return () => undefined;
    }
    try {
      const url = `${this.transport.baseUrl}/api/runs/${encodeURIComponent(input.runId)}/events?fromSequence=${input.fromSequence}`;
      source = new EventSource(url);
      source.onmessage = (message) => {
        if (closed) return;
        let payload: unknown;
        try { payload = JSON.parse(String(message.data)); }
        catch { fail("INVALID_EVENT", "任务事件响应无效"); return; }
        if (payload === null || typeof payload !== "object" || !("type" in payload) || payload.type !== "events" || !("events" in payload) || !Array.isArray(payload.events)) {
          fail("INVALID_EVENT", "任务事件响应无效"); return;
        }
        if ("serverInstanceId" in payload && typeof payload.serverInstanceId === "string") {
          if (serverInstanceId !== undefined && payload.serverInstanceId !== serverInstanceId) {
            fail("STREAM_RESTARTED", "任务服务已重启，请重新读取任务"); return;
          }
          serverInstanceId = payload.serverInstanceId;
        }
        const events: RunEvent[] = [];
        const fromSequence = nextSequence;
        for (const value of payload.events) {
          let event: RunEvent;
          try { event = validateProductEvent(value); }
          catch { fail("INVALID_EVENT", "任务事件格式无效"); return; }
          if (event.runId !== input.runId) { fail("INVALID_EVENT", "任务事件所属任务无效"); return; }
          if (event.sequence < nextSequence) continue;
          if (event.sequence !== nextSequence) { fail("EVENT_GAP", "任务事件序列缺失，请重新读取任务"); return; }
          events.push(event);
          nextSequence++;
        }
        if (events.length > 0) onPush({ kind: "runEvents", runId: input.runId, fromSequence, events });
      };
      source.onerror = () => fail("STREAM_LOST", "任务事件连接中断，请重新读取任务");
    } catch {
      fail("STREAM_UNAVAILABLE", "无法订阅任务事件");
    }
    return () => { closed = true; source?.close(); };
  }
}
