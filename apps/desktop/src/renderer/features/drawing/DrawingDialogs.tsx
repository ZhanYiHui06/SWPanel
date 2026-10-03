/**
 * Phase 2 Drawing-management dialogs (WP6).
 *
 * `ImportDrawingDialog` — 上传图纸: platform file picker (bridge) followed by a
 * focused metadata form (图号 / 名称). Cancelling at any step does nothing;
 * importing creates a Drawing + first Revision and NEVER creates a Modeling Run.
 *
 * `AddRevisionDialog` — 新增版本: picks a file and adds a Revision to the
 * Drawing. The current-Revision pointer is not touched (the explicit
 * 设为当前版本 action owns that transition).
 *
 * Both dialogs follow the existing `.dialog` visual language from the Phase 1
 * pages and validate inputs client-side for UX while the adapter/Main stays
 * authoritative.
 */

import { useState } from "react";
import { Button, CloseIcon, Dialog, FormField, InlineNotice, TextInput } from "@swpanel/ui";

import { describeError } from "../error-messages.js";
import { formatBytes } from "../format.js";
import { runStatusLabel } from "../status.js";
import { useNotifications } from "../notifications/notification-context.js";
import {
  type AddRevisionResult,
  type DrawingRepository,
  type ImportDrawingResult,
  type SelectedDrawingFileInput
} from "../bridge-repository/drawing-repository.js";
import { type RunRepository } from "../run-repository/run-repository.js";
import { type CostRepository } from "../cost-repository/cost-repository.js";

/** Joins 1-3 dependency labels with the Chinese enumeration conjunction. */
function joinChineseList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join("、")}与 ${parts[parts.length - 1]}`;
}

/** Human blocking message for a Revision with dependent artifacts (or null). */
export function revisionDependencyMessage(
  modelCount: number,
  runCount: number,
  costReportCount: number
): string | null {
  const parts: string[] = [];
  if (modelCount > 0) parts.push(`${modelCount} 个模型`);
  if (runCount > 0) parts.push(`${runCount} 次建模记录`);
  if (costReportCount > 0) parts.push(`${costReportCount} 份成本报告`);
  if (parts.length === 0) return null;
  return `该版本已包含 ${joinChineseList(parts)}，不可直接删除。`;
}

export interface ImportDrawingDialogProps {
  readonly repository: DrawingRepository;
  readonly onCancel: () => void;
  /** Called once the Drawing was imported (the page invalidates and navigates). */
  readonly onImported: (result: ImportDrawingResult) => void;
}

/** Server-side upload limit (kept in sync with the web server's 20 MiB cap). */
export const MAX_DRAWING_FILE_BYTES = 20 * 1024 * 1024;
const ACCEPTED_DRAWING_FORMATS: readonly string[] = ["PDF", "DWG", "DXF"];

/** Front-end pre-check of a picked file; returns a Chinese message or null. */
export function checkPickedDrawingFile(file: SelectedDrawingFileInput): string | null {
  const extension = file.fileName.includes(".") ? file.fileName.split(".").pop()?.toUpperCase() ?? "" : "";
  if (!ACCEPTED_DRAWING_FORMATS.includes(String(file.format).toUpperCase()) && !ACCEPTED_DRAWING_FORMATS.includes(extension)) {
    return "仅支持 PDF、DWG 和 DXF 格式的图纸，请重新选择文件。";
  }
  if (file.sizeBytes > MAX_DRAWING_FILE_BYTES) {
    return `文件大小为 ${formatBytes(file.sizeBytes)}，超过 20 MB 上限，请压缩或拆分后重新选择。`;
  }
  return null;
}

function SelectedFileSummary({
  file,
  onReselect,
  reselectDisabled
}: {
  readonly file: SelectedDrawingFileInput;
  readonly onReselect: () => void;
  readonly reselectDisabled: boolean;
}): React.JSX.Element {
  return (
    <div className="flex-between" style={{ marginBottom: "var(--spacing-4, 16px)" }}>
      <div>
        <div className="text-sm text-mono" style={{ fontWeight: 500 }}>{file.fileName}</div>
        <div className="text-xs text-muted" style={{ marginTop: 2 }}>
          {file.format} · {formatBytes(file.sizeBytes)}
        </div>
      </div>
      <Button variant="ghost" size="sm" className="btn-ghost-muted" onClick={onReselect} disabled={reselectDisabled}>
        重新选择
      </Button>
    </div>
  );
}

export function ImportDrawingDialog({
  repository,
  onCancel,
  onImported
}: ImportDrawingDialogProps): React.JSX.Element {
  const [file, setFile] = useState<SelectedDrawingFileInput | null>(null);
  const [drawingNumber, setDrawingNumber] = useState("");
  const [name, setName] = useState("");
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const numberReady = drawingNumber.trim().length > 0;
  const nameReady = name.trim().length > 0;

  async function pickFile(): Promise<void> {
    setPicking(true);
    setError(null);
    try {
      const picked = await repository.selectDrawingFile();
      if (picked !== null) {
        const problem = checkPickedDrawingFile(picked);
        if (problem === null) setFile(picked);
        else setError(problem);
      }
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setPicking(false);
    }
  }

  async function submit(): Promise<void> {
    if (file === null) {
      setError("请先选择图纸文件。");
      return;
    }
    if (!numberReady || !nameReady) {
      setError("请填写图号和名称。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await repository.importDrawing({
        drawingNumber: drawingNumber.trim(),
        name: name.trim(),
        file
      });
      onImported(result);
    } catch (caught) {
      const described = describeError(caught);
      if (described.code === "TOKEN_NOT_FOUND") setFile(null);
      setError(described.message);
      setSubmitting(false);
    }
  }

  return (
    <Dialog labelledBy="import-drawing-dialog-title" onClose={onCancel} dismissible={!submitting}>
      <div className="dialog-header">
        <h2 id="import-drawing-dialog-title" className="dialog-title">上传图纸</h2>
      </div>
      <div className="dialog-body">
        {file === null ? (
          <>
            <p className="dialog-text">
              选择要导入的工程图纸文件（PDF / DWG / DXF）。导入后会创建一张新图纸及其首个版本，不会创建建模任务。
            </p>
            <Button variant="secondary" onClick={() => void pickFile()} disabled={picking}>
              {picking ? "正在选择并上传…" : "选择图纸文件"}
            </Button>
          </>
        ) : (
          <>
            <SelectedFileSummary
              file={file}
              onReselect={() => void pickFile()}
              reselectDisabled={picking || submitting}
            />
            <FormField label="图号" htmlFor="import-drawing-number" required hint="例如 PDJF480.01.17C-4">
              <TextInput
                value={drawingNumber}
                onValueChange={setDrawingNumber}
                mono
                placeholder="请输入图纸编号"
                inputProps={{ id: "import-drawing-number", autoComplete: "off" }}
              />
            </FormField>
            <FormField label="名称" htmlFor="import-drawing-name" required hint="图纸的显示名称">
              <TextInput
                value={name}
                onValueChange={setName}
                placeholder="请输入图纸名称"
                inputProps={{ id: "import-drawing-name", autoComplete: "off" }}
              />
            </FormField>
          </>
        )}
        {error !== null && (
          <InlineNotice tone="error" title="无法导入图纸" className="mt-4">
            {error}
          </InlineNotice>
        )}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          <CloseIcon aria-hidden="true" />取消
        </Button>
        {file !== null && (
          <Button variant="primary" onClick={() => void submit()} disabled={submitting || !numberReady || !nameReady}>
            {submitting ? "正在导入…" : "导入图纸"}
          </Button>
        )}
      </div>
    </Dialog>
  );
}

export interface DeleteRevisionDialogProps {
  readonly repository: DrawingRepository;
  readonly drawingId: string;
  readonly revisionId: string;
  /** Display label of the revision being deleted (e.g. "V2"). */
  readonly revisionLabel: string;
  /** Display file name of the revision's source file, when known. */
  readonly sourceFileName?: string;
  /** Dependent Runs recorded on this Revision (blocks deletion). */
  readonly runCount?: number;
  /** Dependent Models generated on this Revision (blocks deletion). */
  readonly modelCount?: number;
  /** Dependent Cost Estimate Reports on this Revision (blocks deletion). */
  readonly costReportCount?: number;
  readonly onCancel: () => void;
  /** Called once the Revision was deleted (the page invalidates and navigates). */
  readonly onDeleted: (deletedRevisionId: string) => void;
}

/**
 * Explicit destructive confirmation for the conservative Revision deletion
 * policy: only NON-current revisions are ever offered this dialog; the delete
 * requires a second explicit confirmation step in the UI before the Runner
 * removes the metadata transactionally and the owned ledger file afterwards.
 *
 * A Revision with dependent artifacts (Runs / Models / Cost Reports) is NOT
 * deletable: the confirm button is disabled and a clear blocking message is
 * shown. The repository remains authoritative (it re-validates server-side).
 */
export function DeleteRevisionDialog({
  repository,
  drawingId,
  revisionId,
  revisionLabel,
  sourceFileName,
  runCount = 0,
  modelCount = 0,
  costReportCount = 0,
  onCancel,
  onDeleted
}: DeleteRevisionDialogProps): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = runCount > 0 || modelCount > 0 || costReportCount > 0;
  const blockingMessage = revisionDependencyMessage(modelCount, runCount, costReportCount);

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const result = await repository.deleteRevision({
        drawingId,
        revisionId,
        updatedAt: new Date().toISOString()
      });
      onDeleted(result.deletedRevisionId);
    } catch (caught) {
      setError(describeError(caught).message);
      setSubmitting(false);
    }
  }

  return (
    <Dialog labelledBy="delete-revision-dialog-title" onClose={onCancel} dismissible={!submitting}>
      <div className="dialog-header">
        <h2 id="delete-revision-dialog-title" className="dialog-title">删除版本</h2>
      </div>
      <div className="dialog-body">
        {blocked ? (
          <InlineNotice tone="warning" title="无法删除该版本">
            {blockingMessage}
            <div className="mt-4">
              如需删除，请先移除该版本下的模型、建模记录和成本报告。
            </div>
          </InlineNotice>
        ) : (
          <>
            <p className="dialog-text">
              确认删除版本 <strong className="text-mono">{revisionLabel}</strong>
              {sourceFileName !== undefined && sourceFileName.length > 0 ? `（${sourceFileName}）` : ""}？
            </p>
            <p className="dialog-text">
              该版本的工程事实、建模反馈和源文件将一并删除，操作不可撤销。
              当前版本不会被删除（受保护）。
            </p>
          </>
        )}
        {error !== null && (
          <InlineNotice tone="error" title="无法删除版本" className="mt-4">
            {error}
          </InlineNotice>
        )}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          <CloseIcon aria-hidden="true" />取消
        </Button>
        <Button variant="danger" onClick={() => void submit()} disabled={submitting || blocked}>
          {submitting ? "正在删除…" : "确认删除版本"}
        </Button>
      </div>
    </Dialog>
  );
}

export interface AddRevisionDialogProps {
  readonly repository: DrawingRepository;
  readonly drawingId: string;
  readonly onCancel: () => void;
  /** Called once the Revision was added (the page invalidates and navigates). */
  readonly onAdded: (result: AddRevisionResult) => void;
}

export function AddRevisionDialog({
  repository,
  drawingId,
  onCancel,
  onAdded
}: AddRevisionDialogProps): React.JSX.Element {
  const [file, setFile] = useState<SelectedDrawingFileInput | null>(null);
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickFile(): Promise<void> {
    setPicking(true);
    setError(null);
    try {
      const picked = await repository.selectDrawingFile();
      if (picked !== null) {
        const problem = checkPickedDrawingFile(picked);
        if (problem === null) setFile(picked);
        else setError(problem);
      }
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setPicking(false);
    }
  }

  async function submit(): Promise<void> {
    if (file === null) {
      setError("请先选择图纸文件。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await repository.addRevision({ drawingId, file });
      onAdded(result);
    } catch (caught) {
      const described = describeError(caught);
      if (described.code === "TOKEN_NOT_FOUND") setFile(null);
      setError(described.message);
      setSubmitting(false);
    }
  }

  return (
    <Dialog labelledBy="add-revision-dialog-title" onClose={onCancel} dismissible={!submitting}>
      <div className="dialog-header">
        <h2 id="add-revision-dialog-title" className="dialog-title">新增版本</h2>
      </div>
      <div className="dialog-body">
        {file === null ? (
          <>
            <p className="dialog-text">
              选择新版本的工程图纸文件。新增版本不会自动设为当前版本，也不会创建建模任务。
            </p>
            <Button variant="secondary" onClick={() => void pickFile()} disabled={picking}>
              {picking ? "正在选择并上传…" : "选择图纸文件"}
            </Button>
          </>
        ) : (
          <>
            <SelectedFileSummary
              file={file}
              onReselect={() => void pickFile()}
              reselectDisabled={picking || submitting}
            />
            <p className="dialog-text">确认后将基于该文件创建下一个版本。</p>
          </>
        )}
        {error !== null && (
          <InlineNotice tone="error" title="无法新增版本" className="mt-4">
            {error}
          </InlineNotice>
        )}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          <CloseIcon aria-hidden="true" />取消
        </Button>
        {file !== null && (
          <Button variant="primary" onClick={() => void submit()} disabled={submitting}>
            {submitting ? "正在新增…" : "确认新增版本"}
          </Button>
        )}
      </div>
    </Dialog>
  );
}

export interface DeleteRunDialogProps {
  readonly repository: RunRepository;
  readonly run: {
    readonly runId: string;
    readonly runLabel: string;
    readonly drawingId: string;
    readonly revisionId: string;
    readonly status: string;
  };
  readonly onCancel: () => void;
  /** Called once the Run was deleted (the page navigates / reloads). */
  readonly onDeleted: () => void;
}

/**
 * Conservative destructive confirmation for deleting ONE terminal Run
 * (COMPLETED / FAILED / CANCELLED). Calls `run.delete` with the owning
 * drawing/revision pair, shows a success toast and delegates navigation/reload
 * to the caller.
 */
export function DeleteRunDialog({
  repository,
  run,
  onCancel,
  onDeleted
}: DeleteRunDialogProps): React.JSX.Element {
  const { addToast } = useNotifications();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await repository.deleteRun({
        runId: run.runId,
        drawingId: run.drawingId,
        revisionId: run.revisionId
      });
      addToast({
        tone: "success",
        title: "Run 已删除",
        message: `${run.runLabel} 及其记录已删除。`
      });
      onDeleted();
    } catch (caught) {
      setError(describeError(caught).message);
      setSubmitting(false);
    }
  }

  return (
    <Dialog labelledBy="delete-run-dialog-title" onClose={onCancel} dismissible={!submitting}>
      <div className="dialog-header">
        <h2 id="delete-run-dialog-title" className="dialog-title">删除记录</h2>
      </div>
      <div className="dialog-body">
        <p className="dialog-text">
          确认删除 Run <strong className="text-mono">{run.runLabel}</strong>？（状态：{runStatusLabel(run.status)}）
        </p>
        <p className="dialog-text">
          该任务的建模记录、事件历史、生成的模型、审核、模型文件及关联成本报告将一并删除；当前正式模型指针会清空。原图与版本补充资料保留。操作不可撤销。
        </p>
        {error !== null && (
          <InlineNotice tone="error" title="无法删除 Run" className="mt-4">
            {error}
          </InlineNotice>
        )}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          <CloseIcon aria-hidden="true" />取消
        </Button>
        <Button variant="danger" onClick={() => void submit()} disabled={submitting}>
          {submitting ? "正在删除…" : "确认删除记录"}
        </Button>
      </div>
    </Dialog>
  );
}

export interface DeleteCostReportDialogProps {
  readonly repository: CostRepository;
  readonly costReportId: string;
  readonly revisionId: string;
  /** Display label of the report being deleted (e.g. "Q03"). */
  readonly reportLabel?: string;
  readonly onCancel: () => void;
  /** Called once the report was deleted (the page navigates / reloads). */
  readonly onDeleted: () => void;
}

/**
 * Confirmation dialog for deleting ONE Cost Estimate Report of its owning
 * Revision. Calls `costReport.delete`, shows a success toast and delegates
 * navigation/reload to the caller.
 */
export function DeleteCostReportDialog({
  repository,
  costReportId,
  revisionId,
  reportLabel,
  onCancel,
  onDeleted
}: DeleteCostReportDialogProps): React.JSX.Element {
  const { addToast } = useNotifications();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await repository.deleteCostReport({ costReportId, revisionId });
      addToast({
        tone: "success",
        title: "报告已删除",
        message: `成本测算报告${reportLabel !== undefined ? ` ${reportLabel}` : ""}已删除。`
      });
      onDeleted();
    } catch (caught) {
      setError(describeError(caught).message);
      setSubmitting(false);
    }
  }

  return (
    <Dialog labelledBy="delete-report-dialog-title" onClose={onCancel} dismissible={!submitting}>
      <div className="dialog-header">
        <h2 id="delete-report-dialog-title" className="dialog-title">删除报告</h2>
      </div>
      <div className="dialog-body">
        <p className="dialog-text">
          确认删除成本测算报告{" "}
          <strong className="text-mono">{reportLabel !== undefined ? reportLabel : costReportId}</strong>
          ？
        </p>
        <p className="dialog-text">
          该报告的估算快照与测算结果将一并删除，操作不可撤销。
        </p>
        {error !== null && (
          <InlineNotice tone="error" title="无法删除报告" className="mt-4">
            {error}
          </InlineNotice>
        )}
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          <CloseIcon aria-hidden="true" />取消
        </Button>
        <Button variant="danger" onClick={() => void submit()} disabled={submitting}>
          {submitting ? "正在删除…" : "确认删除报告"}
        </Button>
      </div>
    </Dialog>
  );
}
