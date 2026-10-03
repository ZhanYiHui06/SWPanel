import type { DeletionImpact } from "@swpanel/contracts";
import { Button, Dialog, InlineNotice } from "@swpanel/ui";
import { useEffect, useState } from "react";

export interface BusinessDeletionCapability {
  getDeletionImpact?(id: string): Promise<DeletionImpact>;
  deleteObject?(id: string, confirmationToken: string): Promise<{ deletedId: string; cleanupWarnings: string[] }>;
}

export function BusinessDeletionDialog({ repository, id, label, onCancel, onDeleted }: {
  repository: BusinessDeletionCapability; id: string; label: string;
  onCancel: () => void; onDeleted: (warnings: string[]) => void;
}): React.JSX.Element {
  const [impact, setImpact] = useState<DeletionImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    setImpact(null);
    setError(null);
    if (!repository.getDeletionImpact) { setError("当前服务不支持删除此对象"); return; }
    void repository.getDeletionImpact(id).then(value => { if (alive) setImpact(value); }, () => { if (alive) setError("无法读取删除影响，请重试"); });
    return () => { alive = false; };
  }, [repository, id, refresh]);
  async function remove(): Promise<void> {
    if (!impact?.canDelete || !repository.deleteObject || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await repository.deleteObject(id, impact.confirmationToken);
      onDeleted(result.cleanupWarnings);
    } catch (cause) {
      setImpact(null);
      setError(cause instanceof Error && "code" in cause && cause.code === "ENTITY_CONFLICT"
        ? "关联数据已变化或仍有未结束任务，请重新核对删除影响。" : "删除未完成，请重新读取影响后重试。");
    } finally { setBusy(false); }
  }
  return <Dialog labelledBy="business-delete-title" onClose={onCancel} dismissible={!busy}>
    <div className="dialog-header"><h2 id="business-delete-title" className="dialog-title">删除 {label}</h2></div>
    <div className="dialog-body">
      <p className="text-sm mb-4">此操作会永久删除以下数据，无法从页面恢复。</p>
      {!impact && !error && <p role="status">正在核对关联数据…</p>}
      {impact && <>
        <p className="text-sm mb-4">{impact.counts.revisions} 个版本 · {impact.counts.runs} 次建模任务 · {impact.counts.models} 个模型 · {impact.counts.reviews} 条审核 · {impact.counts.costReports} 份成本报告 · {impact.counts.artifacts} 个产物 · {impact.counts.sourceFiles} 份原图</p>
        {impact.kind === "model" && <p className="text-sm text-muted mb-4">原图、版本和建模记录保留；该模型的审核、文件和成本报告会删除。</p>}
        {impact.clearsCurrentApproved && <InlineNotice tone="warning" className="mb-4">当前正式模型指针会清空。系统不会自动选用历史模型。</InlineNotice>}
        {!impact.canDelete && <InlineNotice tone="warning">{impact.blockingReason}</InlineNotice>}
      </>}
      {error && <InlineNotice tone="error" role="alert">{error}</InlineNotice>}
    </div>
    <div className="dialog-footer">
      <Button variant="ghost" onClick={onCancel} disabled={busy}>取消</Button>
      {(error || impact?.canDelete === false) && <Button variant="secondary" onClick={() => setRefresh(value => value + 1)} disabled={busy}>重新核对</Button>}
      <Button variant="danger" onClick={() => void remove()} disabled={busy || !impact?.canDelete || !repository.deleteObject}>{busy ? "正在删除…" : "确认永久删除"}</Button>
    </div>
  </Dialog>;
}
