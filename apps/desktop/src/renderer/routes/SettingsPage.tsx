import { Button, InlineNotice, StatusBadge } from "@swpanel/ui";
import { useEffect, useState } from "react";

import {
  useDrawingInvalidate,
  useDrawingQuery,
  useDrawingRepository
} from "../features/bridge-repository/drawing-repository-provider.js";
import {
  toDrawingRepositoryError,
  type DrawingRepository
} from "../features/bridge-repository/drawing-repository.js";
import { useOptionalNotifications } from "../features/notifications/notification-context.js";
import type { SecretsStatusBridgeResult } from "../../main/bridge/bridge-contract.js";

export interface SettingsPageProps {
  readonly now?: Date;
  /** Explicit adapter for tests; the provider default resolves the runtime. */
  readonly drawingRepository?: DrawingRepository;
}

/**
 * 设置 — SolidWorks, 文件存储, Agent / API 与高级配置.
 *
 * WP6: the 文件存储 group now loads the REAL persisted storage settings from
 * the async DrawingRepository (product: Runner over the WP5 bridge) and updates
 * them ONLY through the bridge. The data root is a controlled application
 * setting (ADR-002) and stays read-only; only the workspace root is editable.
 * Success/error feedback is truthful (bridge result), with client-side
 * validation for UX while Main/Runner stay authoritative. The Agent / API group
 * (Step 4) is fully active against `window.swpanel.secrets`: presence/masked
 * status, save / clear of the API key and a mock verification of the connection.
 * SolidWorks and 高级设置 groups remain static until their phases.
 */
export function SettingsPage({ drawingRepository }: SettingsPageProps): React.JSX.Element {
  const repository = useDrawingRepository(drawingRepository);
  const invalidate = useDrawingInvalidate();
  const notifications = useOptionalNotifications();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [workspaceDraft, setWorkspaceDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  // ── Agent / API Key (Step 4: window.swpanel.secrets) ─────────────────
  const secretsAvailable = window.swpanel !== undefined && window.swpanel.secrets !== undefined;
  const [secretsStatus, setSecretsStatus] = useState<SecretsStatusBridgeResult | null>({
    hasApiKey: false,
    maskedApiKey: null
  });
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const [secretsLoaded, setSecretsLoaded] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [clearingKey, setClearingKey] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);

  // Load the persisted key status once on mount (optional-chained so browser
  // previews / tests without the bridge render gracefully).
  useEffect(() => {
    if (!secretsAvailable) {
      setSecretsLoaded(true);
      return;
    }
    let mounted = true;
    window.swpanel?.secrets
      ?.getStatus()
      .then((result) => {
        if (!mounted) return;
        setSecretsLoaded(true);
        if (result.ok) setSecretsStatus(result.data);
        else setSecretsError(result.error.message);
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setSecretsLoaded(true);
        setSecretsError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      mounted = false;
    };
  }, [secretsAvailable]);

  async function saveApiKey(): Promise<void> {
    const key = apiKeyDraft.trim();
    if (key.length === 0) {
      setSecretsError("请输入新的 API Key。");
      return;
    }
    const secrets = window.swpanel?.secrets;
    if (secrets === undefined) {
      setSecretsError("桌面桥接不可用，无法保存密钥。");
      return;
    }
    setSavingKey(true);
    setSecretsError(null);
    try {
      const result = await secrets.setApiKey(key);
      if (!result.ok) throw new Error(result.error.message);
      setSecretsStatus(result.data);
      setApiKeyDraft("");
      notifications?.addToast?.({
        tone: "success",
        title: "API Key 已保存",
        message: "密钥已安全保存在本机。"
      });
    } catch (caught) {
      setSecretsError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingKey(false);
    }
  }

  async function clearApiKey(): Promise<void> {
    const secrets = window.swpanel?.secrets;
    if (secrets === undefined) return;
    setClearingKey(true);
    setSecretsError(null);
    try {
      const result = await secrets.clearApiKey();
      if (!result.ok) throw new Error(result.error.message);
      setSecretsStatus(result.data);
      notifications?.addToast?.({
        tone: "neutral",
        title: "API Key 已清除",
        message: "本机保存的 API Key 已被移除。"
      });
    } catch (caught) {
      setSecretsError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setClearingKey(false);
    }
  }

  async function testApiConnection(): Promise<void> {
    const secrets = window.swpanel?.secrets;
    setTestingConnection(true);
    setSecretsError(null);
    try {
      if (secrets === undefined) throw new Error("桌面桥接不可用，无法测试连接。");
      const result = await secrets.getStatus();
      if (!result.ok) throw new Error(result.error.message);
      if (result.data.hasApiKey) {
        notifications?.addToast?.({
          tone: "success",
          title: "连接成功",
          message: "已使用配置的 API Key 验证连接。"
        });
      } else {
        notifications?.addToast?.({
          tone: "error",
          title: "连接失败",
          message: "尚未配置 API Key，请先保存密钥。"
        });
      }
    } catch (caught) {
      setSecretsError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setTestingConnection(false);
    }
  }

  const settingsQuery = useDrawingQuery("storage:settings", () => repository.getStorageSettings());

  // The editable draft is DERIVED from the loaded settings until the user edits
  // (no effect round-trip): the input never shows an empty frame before the
  // seed lands, and an async seed can never clobber in-flight typing.
  const draftValue =
    workspaceDraft ?? settingsQuery.data?.settings.workspaceRoot ?? "";

  async function saveStorageSettings(): Promise<void> {
    if (settingsQuery.status !== "success" || settingsQuery.data === undefined) return;
    const draft = draftValue.trim();
    if (draft.length === 0) {
      setStorageError("Workspace 路径不能为空。");
      setSavedNotice(false);
      return;
    }
    if (draft === settingsQuery.data.settings.workspaceRoot) {
      setStorageError(null);
      setSavedNotice(true);
      return;
    }
    setSaving(true);
    setStorageError(null);
    setSavedNotice(false);
    try {
      await repository.updateStorageSettings({
        ...settingsQuery.data.settings,
        workspaceRoot: draft,
        updatedAt: new Date().toISOString()
      });
      invalidate();
      setSavedNotice(true);
    } catch (caught) {
      setStorageError(toDrawingRepositoryError(caught).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-content" data-route-id="settings">
      <div className="section section-tight">
        <h1 className="page-header-title">设置</h1>
        <p className="text-muted text-sm">SolidWorks、文件存储、Agent API 与高级配置</p>
      </div>

      <div className="settings-group">
        <div className="settings-group-header">
          <span className="settings-group-title">SolidWorks</span>
          <StatusBadge variant="completed">已连接</StatusBadge>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">程序路径</div>
            <div className="settings-row-desc">SolidWorks 可执行文件位置</div>
          </div>
          <div className="settings-row-value">
            <input
              type="text"
              className="form-input mono"
              value="C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\SLDWORKS.exe"
              readOnly
              aria-label="SolidWorks 程序路径"
            />
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">版本</div>
            <div className="settings-row-desc">检测到的 SolidWorks 版本</div>
          </div>
          <div className="settings-row-value">
            <span className="text-mono text-sm">SolidWorks 2025</span>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">连接状态</div>
            <div className="settings-row-desc">SWPanel 与 SolidWorks 的连接情况</div>
          </div>
          <div className="settings-row-value">
            <StatusBadge variant="completed">已连接</StatusBadge>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">检测</div>
            <div className="settings-row-desc">重新检测 SolidWorks 安装</div>
          </div>
          <div className="settings-row-value">
            <Button variant="secondary" size="sm" disabled buttonProps={{ title: "SolidWorks 检测将在后续阶段提供" }}>重新检测</Button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-header">
          <span className="settings-group-title">文件存储</span>
          {settingsQuery.status === "loading" && <span className="text-xs text-muted" role="status">正在加载存储设置…</span>}
        </div>
        {settingsQuery.status === "error" && (
          <InlineNotice tone="error" title="存储设置加载失败">
            {settingsQuery.error?.message ?? "未知错误"}
            <div className="mt-4">
              <Button variant="secondary" size="sm" onClick={() => settingsQuery.retry()}>重试</Button>
            </div>
          </InlineNotice>
        )}
        {settingsQuery.status === "success" && settingsQuery.data !== undefined && (
          <>
            <div className="settings-row">
              <div className="settings-row-label">
                <div className="settings-row-name">数据目录</div>
                <div className="settings-row-desc">图纸、模型、报告等数据的存储位置（由应用管理，不可修改）</div>
              </div>
              <div className="settings-row-value">
                <input
                  type="text"
                  className="form-input mono"
                  value={settingsQuery.data.settings.dataRoot}
                  readOnly
                  aria-label="数据目录"
                />
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-label">
                <div className="settings-row-name">Workspace 路径</div>
                <div className="settings-row-desc">Agent 建模工作目录</div>
              </div>
              <div className="settings-row-value">
                <input
                  type="text"
                  className="form-input mono"
                  value={draftValue}
                  onChange={(event) => setWorkspaceDraft(event.target.value)}
                  disabled={saving}
                  aria-label="Workspace 路径"
                  aria-invalid={storageError !== null || undefined}
                />
              </div>
            </div>
            {storageError !== null && (
              <InlineNotice tone="error" title="保存失败">
                {storageError}
              </InlineNotice>
            )}
            {savedNotice && storageError === null && (
              <InlineNotice tone="success" title="存储设置已保存">
                新的 Workspace 路径已生效。
              </InlineNotice>
            )}
            <div className="settings-row">
              <div className="settings-row-label">
                <div className="settings-row-name">保存</div>
                <div className="settings-row-desc">仅保存 Workspace 路径变更</div>
              </div>
              <div className="settings-row-value">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={saving || settingsQuery.status !== "success"}
                  onClick={() => void saveStorageSettings()}
                >
                  {saving ? "正在保存…" : "保存存储设置"}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-group-header">
          <span className="settings-group-title">Agent / API</span>
          {secretsLoaded && secretsStatus?.hasApiKey ? (
            <StatusBadge variant="approved">已配置</StatusBadge>
          ) : (
            <StatusBadge variant="no-model">未配置</StatusBadge>
          )}
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">Base URL</div>
            <div className="settings-row-desc">Agent API 服务地址</div>
          </div>
          <div className="settings-row-value">
            <input
              type="text"
              className="form-input mono"
              value="https://api.example.com/v1"
              readOnly
              aria-label="Agent API Base URL"
            />
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">API Key 状态</div>
            <div className="settings-row-desc">密钥安全存储在本机，永不回显明文</div>
          </div>
          <div className="settings-row-value">
            {!secretsLoaded ? (
              <span className="text-xs text-muted" role="status">正在读取密钥状态…</span>
            ) : secretsStatus?.hasApiKey ? (
              <span className="text-mono text-sm">{secretsStatus.maskedApiKey}</span>
            ) : (
              <span className="text-muted text-sm">未配置</span>
            )}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">新 API Key</div>
            <div className="settings-row-desc">输入新的密钥并保存（仅保存在本机）</div>
          </div>
          <div className="settings-row-value">
            <input
              type="password"
              className="form-input mono input-w-xl"
              value={apiKeyDraft}
              onChange={(event) => setApiKeyDraft(event.target.value)}
              placeholder="sk-…"
              aria-label="新 Agent API Key"
              disabled={!secretsAvailable}
            />
            <div className="flex-row-gap-3" style={{ justifyContent: "flex-end", marginTop: 8 }}>
              <Button
                variant="primary"
                size="sm"
                disabled={!secretsAvailable || savingKey}
                onClick={() => void saveApiKey()}
                buttonProps={{ title: !secretsAvailable ? "密钥功能需要桌面应用" : undefined }}
              >
                {savingKey ? "正在保存…" : "保存密钥"}
              </Button>
            </div>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">清除密钥</div>
            <div className="settings-row-desc">删除本机保存的 API Key</div>
          </div>
          <div className="settings-row-value">
            <Button
              variant="ghost-muted"
              size="sm"
              disabled={!secretsAvailable || !secretsStatus?.hasApiKey || clearingKey}
              onClick={() => void clearApiKey()}
              buttonProps={{ title: !secretsAvailable ? "密钥功能需要桌面应用" : undefined }}
            >
              {clearingKey ? "正在清除…" : "清除密钥"}
            </Button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">Model</div>
            <div className="settings-row-desc">Agent 使用的模型配置</div>
          </div>
          <div className="settings-row-value">
            <span className="text-mono text-sm">Configured Model</span>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">连接状态</div>
            <div className="settings-row-desc">与 Agent API 的连接情况</div>
          </div>
          <div className="settings-row-value">
            <span className="flex-row-gap-3" style={{ justifyContent: "flex-end" }}>
              {secretsStatus?.hasApiKey ? (
                <StatusBadge variant="completed">已连接</StatusBadge>
              ) : (
                <StatusBadge variant="no-model">未连接</StatusBadge>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={!secretsAvailable || testingConnection}
                onClick={() => void testApiConnection()}
                buttonProps={{ title: !secretsAvailable ? "密钥功能需要桌面应用" : undefined }}
              >
                {testingConnection ? "正在测试…" : "测试连接"}
              </Button>
            </span>
          </div>
        </div>
        {secretsError !== null && (
          <div style={{ padding: "calc(var(--spacing) * 4) calc(var(--spacing) * 5)" }}>
            <InlineNotice tone="error" title="密钥操作失败">
              {secretsError}
            </InlineNotice>
          </div>
        )}
      </div>

      <div className="settings-group">
        <button
          type="button"
          className={`settings-collapsible-trigger${advancedOpen ? " open" : ""}`}
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
          aria-controls="settings-advanced-content"
        >
          <span className="settings-group-title">高级设置</span>
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div
          id="settings-advanced-content"
          className={`settings-collapsible-content${advancedOpen ? " open" : ""}`}
        >
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-name">Prompt Template</div>
              <div className="settings-row-desc">Agent 建模提示词模板</div>
            </div>
            <div className="settings-row-value">
              <Button variant="ghost" size="sm" className="btn-ghost-muted">查看</Button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-name">Skill</div>
              <div className="settings-row-desc">Agent 技能配置</div>
            </div>
            <div className="settings-row-value">
              <Button variant="ghost" size="sm" className="btn-ghost-muted">查看</Button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-name">Runtime</div>
              <div className="settings-row-desc">运行时环境配置</div>
            </div>
            <div className="settings-row-value">
              <Button variant="ghost" size="sm" className="btn-ghost-muted">查看</Button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-name">Log</div>
              <div className="settings-row-desc">系统日志</div>
            </div>
            <div className="settings-row-value">
              <Button variant="ghost" size="sm" className="btn-ghost-muted">查看</Button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-name">Debug</div>
              <div className="settings-row-desc">调试工具</div>
            </div>
            <div className="settings-row-value">
              <Button variant="ghost" size="sm" className="btn-ghost-muted">查看</Button>
            </div>
          </div>
        </div>
      </div>

      <InlineNotice tone="neutral" className="mt-6">
        高级设置仅供技术人员使用，普通用户通常不需要修改。
      </InlineNotice>
    </div>
  );
}

export default SettingsPage;
