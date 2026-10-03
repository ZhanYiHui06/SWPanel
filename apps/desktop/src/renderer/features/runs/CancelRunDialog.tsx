import { Button, Dialog } from "@swpanel/ui";

export interface CancelRunDialogProps {
  readonly runLabel: string;
  /** Called when the user keeps the Run running (dialog dismissed). */
  readonly onKeep: () => void;
  /** Called when the user confirms cancelling the RUNNING Run. */
  readonly onConfirm: () => void;
}

/**
 * Second confirmation for cancelling a RUNNING Run. Cancelling stops the
 * modeling session and deletes every file generated so far, so it must not be
 * one click. QUEUED Runs have no output and are cancelled directly.
 */
export function CancelRunDialog({ runLabel, onKeep, onConfirm }: CancelRunDialogProps): React.JSX.Element {
  return (
    <Dialog labelledBy="cancel-run-dialog-title" onClose={onKeep}>
      <div className="dialog-header">
        <h2 id="cancel-run-dialog-title" className="dialog-title">取消正在执行的任务</h2>
      </div>
      <div className="dialog-body">
        <p className="dialog-text">
          确认取消 Run <strong className="text-mono">{runLabel}</strong>？
        </p>
        <p className="dialog-text">
          取消后将停止建模，并清理本次已生成的全部文件（包括部分模型），无法恢复。需要时可重新发起新的建模任务。
        </p>
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" onClick={onKeep}>继续运行</Button>
        <Button variant="danger" onClick={onConfirm}>确认取消任务</Button>
      </div>
    </Dialog>
  );
}
