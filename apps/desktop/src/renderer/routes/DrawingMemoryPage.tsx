import { Button, Card, CardBody, CardHeader, CardTitle, CloseIcon, EmptyState, FormField, InlineNotice, Select, TextInput, Textarea } from "@swpanel/ui";
import type { RevisionFactSource } from "@swpanel/domain";
import { useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";

import { DrawingWorkspace } from "../features/drawing/DrawingWorkspace.js";
import { newClientIntentId } from "../features/bridge-repository/client-intent-id.js";
import {
  useDrawingInvalidate,
  useDrawingQuery,
  useDrawingRepository
} from "../features/bridge-repository/drawing-repository-provider.js";
import {
  isNotFoundError,
  toDrawingRepositoryError,
  type DrawingRepository
} from "../features/bridge-repository/drawing-repository.js";
import { QueryErrorState, QueryLoadingState } from "../features/drawing/DrawingQueryStates.js";
import { factSourceLabel, formatSmartDate } from "../features/presentation.js";

export interface DrawingMemoryPageProps {
  readonly now?: Date;
  /** Explicit adapter for tests; the provider default resolves the runtime. */
  readonly drawingRepository?: DrawingRepository;
}

/** Field-level validation for the fact form (Main remains authoritative). */
function validateFactForm(field: string, value: string): string | null {
  if (field.trim().length === 0) return "请填写字段名称。";
  if (value.trim().length === 0) return "请填写字段值。";
  return null;
}

export function AddFactDialog({
  repository,
  drawingId,
  revisionId,
  onCancel,
  onAdded
}: {
  readonly repository: DrawingRepository;
  readonly drawingId: string;
  readonly revisionId: string;
  readonly onCancel: () => void;
  readonly onAdded: () => void;
}): React.JSX.Element {
  const [field, setField] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [source, setSource] = useState<RevisionFactSource>("USER_SUPPLEMENT");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One opaque intent id per submission: retries of the UNCHANGED form reuse
  // it (Main deduplicates), while any edited resubmission is a new intent.
  const intentRef = useRef<{ id: string; signature: string } | null>(null);

  async function submit(): Promise<void> {
    const problem = validateFactForm(field, value);
    if (problem !== null) {
      setError(problem);
      return;
    }
    const payload = {
      drawingId,
      revisionId,
      field: field.trim(),
      value: value.trim(),
      ...(unit.trim().length > 0 ? { unit: unit.trim() } : {}),
      source
    };
    const signature = JSON.stringify(payload);
    const previous = intentRef.current;
    const clientIntentId =
      previous !== null && previous.signature === signature
        ? previous.id
        : newClientIntentId();
    intentRef.current = { id: clientIntentId, signature };
    setSubmitting(true);
    setError(null);
    try {
      await repository.addRevisionFact({ ...payload, clientIntentId });
      onAdded();
    } catch (caught) {
      setError(toDrawingRepositoryError(caught).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-overlay" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-fact-dialog-title">
        <div className="dialog-header">
          <div id="add-fact-dialog-title" className="dialog-title">添加工程事实</div>
        </div>
        <div className="dialog-body">
          <FormField label="字段名称" htmlFor="add-fact-field" required>
            <TextInput value={field} onValueChange={setField} placeholder="例如 中心孔深度" inputProps={{ id: "add-fact-field" }} />
          </FormField>
          <FormField label="值" htmlFor="add-fact-value" required>
            <TextInput value={value} onValueChange={setValue} mono placeholder="例如 85 mm" inputProps={{ id: "add-fact-value" }} />
          </FormField>
          <FormField label="单位" htmlFor="add-fact-unit" hint="可选，例如 mm / MPa / kg">
            <TextInput value={unit} onValueChange={setUnit} mono placeholder="选填" inputProps={{ id: "add-fact-unit" }} />
          </FormField>
          <FormField label="来源" htmlFor="add-fact-source">
            <Select
              value={source}
              onValueChange={(next) => setSource(next as RevisionFactSource)}
              options={[
                { value: "USER_SUPPLEMENT", label: "用户补充" },
                { value: "DRAWING_CONFIRMED", label: "图纸确认" },
                { value: "CLARIFICATION", label: "补充信息确认" }
              ]}
              selectProps={{ id: "add-fact-source" }}
            />
          </FormField>
          {error !== null && (
            <InlineNotice tone="error" title="无法添加工程事实" className="mt-4">
              {error}
            </InlineNotice>
          )}
        </div>
        <div className="dialog-footer">
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            <CloseIcon aria-hidden="true" />取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={submitting}>
            {submitting ? "正在保存…" : "保存事实"}
          </Button>
        </div>
      </section>
    </div>
  );
}

export function AddFeedbackDialog({
  repository,
  drawingId,
  revisionId,
  onCancel,
  onAdded
}: {
  readonly repository: DrawingRepository;
  readonly drawingId: string;
  readonly revisionId: string;
  readonly onCancel: () => void;
  readonly onAdded: () => void;
}): React.JSX.Element {
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One opaque intent id per submission (retry of the unchanged form reuses it).
  const intentRef = useRef<{ id: string; signature: string } | null>(null);

  async function submit(): Promise<void> {
    if (content.trim().length === 0) {
      setError("请填写反馈内容。");
      return;
    }
    const payload = {
      drawingId,
      revisionId,
      content: content.trim()
    };
    const signature = JSON.stringify(payload);
    const previous = intentRef.current;
    const clientIntentId =
      previous !== null && previous.signature === signature
        ? previous.id
        : newClientIntentId();
    intentRef.current = { id: clientIntentId, signature };
    setSubmitting(true);
    setError(null);
    try {
      await repository.addModelingFeedback({ ...payload, clientIntentId });
      onAdded();
    } catch (caught) {
      setError(toDrawingRepositoryError(caught).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-overlay" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-feedback-dialog-title">
        <div className="dialog-header">
          <div id="add-feedback-dialog-title" className="dialog-title">添加建模反馈</div>
        </div>
        <div className="dialog-body">
          <FormField label="反馈内容" htmlFor="add-feedback-content" required hint="记录本版本建模时需要避免的错误或注意事项">
            <Textarea
              value={content}
              onValueChange={setContent}
              rows={4}
              placeholder="例如：右侧台阶直径容易识别错误，请按剖面图 A-A 校核。"
              textareaProps={{ id: "add-feedback-content" }}
            />
          </FormField>
          {error !== null && (
            <InlineNotice tone="error" title="无法添加建模反馈" className="mt-4">
              {error}
            </InlineNotice>
          )}
        </div>
        <div className="dialog-footer">
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            <CloseIcon aria-hidden="true" />取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={submitting}>
            {submitting ? "正在保存…" : "保存反馈"}
          </Button>
        </div>
      </section>
    </div>
  );
}

/**
 * Drawing Workspace · 版本记忆 — loads the REAL revision history (facts +
 * feedback) from the async DrawingRepository, isolates data per Revision, and
 * adds the Phase 2 forms: add Revision Fact (field/value/unit/source) and add
 * Modeling Feedback (USER_SUPPLEMENT). Mutations invalidate the cache so the
 * Overview/History views refresh with the same data.
 */
export function DrawingMemoryPage({ now = new Date(), drawingRepository }: DrawingMemoryPageProps): React.JSX.Element {
  const repository = useDrawingRepository(drawingRepository);
  const invalidate = useDrawingInvalidate();
  const parameters = useParams();
  const [addFactOpen, setAddFactOpen] = useState(false);
  const [addFeedbackOpen, setAddFeedbackOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const drawingId = repository.resolveDrawingParam(parameters.drawingId);
  const revisionId = repository.resolveRevisionParam(drawingId, parameters.revisionId);

  const detailQuery = useDrawingQuery(
    drawingId === null ? "drawing:detail:" : `drawing:detail:${drawingId}`,
    () => repository.getDrawingDetail(drawingId as string),
    { enabled: drawingId !== null }
  );
  const historyQuery = useDrawingQuery(
    drawingId === null || revisionId === null ? "revision:history:" : `revision:history:${drawingId}:${revisionId}`,
    () => repository.getRevisionHistory(drawingId as string, revisionId as string),
    { enabled: drawingId !== null && revisionId !== null }
  );

  if (drawingId === null || revisionId === null) {
    return <Navigate to="/drawings" replace />;
  }

  if (detailQuery.status === "loading" || (historyQuery.status === "loading" && historyQuery.data === undefined)) {
    return (
      <div className="page-content wide" data-route-id="drawing-memory">
        <div className="section section-tight"><h1 className="page-header-title">Drawing Workspace · 版本记忆</h1></div>
        <QueryLoadingState label="正在加载版本记忆…" />
      </div>
    );
  }

  if (detailQuery.status === "error") {
    return (
      <div className="page-content wide" data-route-id="drawing-memory">
        <div className="section section-tight"><h1 className="page-header-title">Drawing Workspace · 版本记忆</h1></div>
        {isNotFoundError(detailQuery.error) ? (
          <div className="data-sheet">
            <InlineNotice tone="error" title="图纸不存在或已被删除">无法打开该图纸的版本记忆。</InlineNotice>
            <div className="mt-4"><Link to="/drawings" className="btn btn-secondary btn-sm">返回图纸库</Link></div>
          </div>
        ) : (
          <QueryErrorState title="图纸详情加载失败" error={detailQuery.error} onRetry={() => detailQuery.retry()} action={<Link to="/drawings" className="btn btn-ghost btn-sm">返回图纸库</Link>} />
        )}
      </div>
    );
  }

  if (historyQuery.status === "error" || historyQuery.data === undefined) {
    return (
      <div className="page-content wide" data-route-id="drawing-memory">
        <div className="section section-tight"><h1 className="page-header-title">Drawing Workspace · 版本记忆</h1></div>
        <QueryErrorState
          title="版本记忆加载失败"
          error={historyQuery.error}
          onRetry={() => historyQuery.retry()}
          action={<Link to="/drawings" className="btn btn-ghost btn-sm">返回图纸库</Link>}
        />
      </div>
    );
  }

  if (detailQuery.data === undefined) {
    return (
      <div className="page-content wide" data-route-id="drawing-memory">
        <div className="section section-tight"><h1 className="page-header-title">Drawing Workspace · 版本记忆</h1></div>
        <QueryLoadingState label="正在加载版本记忆…" />
      </div>
    );
  }

  const drawingDetail = detailQuery.data;
  const history = historyQuery.data;
  const mock = repository.mock;
  const revisionLabelById = (id: string): string =>
    drawingDetail.revisions.find((revision) => revision.revisionId === id)?.revisionLabel ?? id;

  function handleFactAdded(): void {
    invalidate();
    setAddFactOpen(false);
    setNotice("工程事实已保存。");
  }

  function handleFeedbackAdded(): void {
    invalidate();
    setAddFeedbackOpen(false);
    setNotice("建模反馈已保存。");
  }

  return (
    <div className="page-content wide" data-route-id="drawing-memory">
      <DrawingWorkspace
        drawingId={drawingId}
        drawingNumber={drawingDetail.drawing.drawingNumber}
        drawingName={drawingDetail.drawing.name}
        revisions={drawingDetail.revisions}
        activeRevisionId={revisionId}
        activeTab="memory"
        revisionLabelById={revisionLabelById}
      >
        {notice !== null && (
          <InlineNotice tone="success" title="已保存" className="mb-6">
            {notice}
          </InlineNotice>
        )}

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Revision Facts</CardTitle>
            <Button variant="secondary" size="sm" onClick={() => setAddFactOpen(true)}>添加事实</Button>
          </CardHeader>
          <CardBody>
            <p className="text-muted text-sm mb-4">
              本版本确认的工程事实，包括用户补充信息和图纸确认信息。
            </p>
            {history.facts.length === 0 ? (
              <EmptyState
                title="当前版本还没有工程事实"
                description="用户补充信息与图纸确认信息会保存在这里，供后续建模任务使用。"
              />
            ) : (
              history.facts.map((fact) => {
                const sourceRun =
                  mock !== null && fact.sourceRunId !== undefined ? mock.getRun(fact.sourceRunId) : undefined;
                return (
                  <div className="memory-entry" key={fact.id}>
                    <div className="memory-entry-label">{fact.field}</div>
                    <div className="memory-entry-value">
                      {fact.value}
                      <div className="memory-entry-source">
                        <span>来源：{factSourceLabel(fact.source)}</span>
                        {sourceRun !== undefined && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{sourceRun.number}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Modeling Feedback</CardTitle>
            <Button variant="secondary" size="sm" onClick={() => setAddFeedbackOpen(true)}>添加反馈</Button>
          </CardHeader>
          <CardBody>
            <p className="text-muted text-sm mb-4">历史模型审核退回意见与用户补充，帮助 Agent 避免重复错误。</p>
            {history.modelingFeedback.length === 0 ? (
              <EmptyState
                title="当前版本还没有建模反馈"
                description="模型审核退回时填写的意见与用户补充会自动记录在这里。"
              />
            ) : (
              history.modelingFeedback.map((entry) => {
                const model = entry.modelId !== undefined && mock !== null ? mock.getModel(entry.modelId) : undefined;
                const label =
                  model?.number ??
                  (entry.source === "USER_SUPPLEMENT" ? "用户补充" : (entry.modelId ?? entry.id));
                return (
                  <div className="memory-entry" key={entry.id}>
                    <div className="memory-entry-label text-mono">
                      {label}
                    </div>
                    <div className="memory-entry-value">
                      {entry.content}
                      <div className="memory-entry-source">
                        <span>来源：{entry.source === "MODEL_REVIEW_REJECTED" ? "模型审核退回" : "用户补充"}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatSmartDate(entry.createdAt, now)}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </CardBody>
        </Card>
      </DrawingWorkspace>

      {addFactOpen && (
        <AddFactDialog
          repository={repository}
          drawingId={drawingId}
          revisionId={revisionId}
          onCancel={() => setAddFactOpen(false)}
          onAdded={handleFactAdded}
        />
      )}
      {addFeedbackOpen && (
        <AddFeedbackDialog
          repository={repository}
          drawingId={drawingId}
          revisionId={revisionId}
          onCancel={() => setAddFeedbackOpen(false)}
          onAdded={handleFeedbackAdded}
        />
      )}
    </div>
  );
}

export default DrawingMemoryPage;
