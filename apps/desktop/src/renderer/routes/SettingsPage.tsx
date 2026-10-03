import { Button, Dialog, InlineNotice, StatusBadge } from "@swpanel/ui";
import { useEffect, useState } from "react";

import {
  useDrawingInvalidate,
  useDrawingQuery,
  useDrawingRepository
} from "../features/bridge-repository/drawing-repository-provider.js";
import type { DrawingRepository } from "../features/bridge-repository/drawing-repository.js";
import { describeError } from "../features/error-messages.js";
import { resolveRepositoryMode } from "../features/repository-mode.js";
import { useOptionalNotifications } from "../features/notifications/notification-context.js";
import { httpSettings, type AgentAuthMode, type AgentAuthStatus, type RuntimeSettings } from "../features/settings/http-settings.js";
import type { SecretsStatusBridgeResult } from "../../main/bridge/bridge-contract.js";

export interface SettingsPageProps {
  readonly now?: Date;
  /** Explicit adapter for tests; the provider default resolves the runtime. */
  readonly drawingRepository?: DrawingRepository;
}

/** Reads real storage, credential and runtime status; connection tests require a server round trip. */
export function SettingsPage({ drawingRepository }: SettingsPageProps): React.JSX.Element {
  const repository = useDrawingRepository(drawingRepository);
  const invalidate = useDrawingInvalidate();
  const notifications = useOptionalNotifications();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [workspaceDraft, setWorkspaceDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  // Real settings endpoints are only touched when the page talks to a real
  // service. Demo (mock) and unavailable modes never read or write secrets.
  const mode = resolveRepositoryMode();
  const live = mode === "http" || mode === "bridge";
  // Over HTTP the server owns the workspace path and refuses to rewrite it.
  const workspaceReadOnly = mode === "http";
  const secretsAvailable = live;
  const secrets = window.swpanel?.secrets ?? httpSettings;
  const [runtime, setRuntime] = useState<RuntimeSettings | null>(null);
  const [runtimeState, setRuntimeState] = useState<"loading" | "ready" | "error">(live ? "loading" : "ready");
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeTick, setRuntimeTick] = useState(0);
  const [connected, setConnected] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  // Auth mode (API key vs. local Codex CLI login) is a Web-service setting; the
  // legacy desktop bridge and demo mode never show it.
  const authModeAvailable = mode === "http";
  const [authStatus, setAuthStatus] = useState<AgentAuthStatus | null>(null);
  const [switchingAuth, setSwitchingAuth] = useState(false);
  const authMode: AgentAuthMode = authStatus?.authMode ?? "api_key";
  const codexMode = authModeAvailable && authMode === "codex_cli";
  useEffect(() => {
    if (!authModeAvailable) return undefined;
    let mounted = true;
    httpSettings.getAuthStatus()
      .then((value) => { if (mounted) setAuthStatus(value); })
      // Older servers have no auth-mode route: keep the API-key view.
      .catch(() => undefined);
    return () => { mounted = false; };
  }, [authModeAvailable, runtimeTick]);
  async function changeAuthMode(next: AgentAuthMode): Promise<void> {
    if (next === authMode || switchingAuth) return;
    setSwitchingAuth(true);
    setSecretsError(null);
    try {
      setAuthStatus(await httpSettings.setAuthMode(next));
      setConnected(false);
      notifications?.addToast?.({
        tone: "success",
        title: "认证方式已切换",
        message: "已保存到服务器；重启服务后，建模 Agent 才会使用新的认证方式。"
      });
    } catch (caught) {
      setSecretsError(describeError(caught).message);
    } finally {
      setSwitchingAuth(false);
    }
  }
  useEffect(() => {
    if (!live) return undefined;
    let mounted = true;
    setRuntimeState("loading");
    httpSettings.getRuntime()
      .then((value) => { if (mounted) { setRuntime(value); setRuntimeState("ready"); setRuntimeError(null); } })
      .catch((error: unknown) => {
        if (!mounted) return;
        setRuntimeState("error");
        setRuntimeError(describeError(error).message);
      });
    return () => { mounted = false; };
  }, [live, runtimeTick]);
  const [secretsStatus, setSecretsStatus] = useState<SecretsStatusBridgeResult | null>(null);
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
      return undefined;
    }
    let mounted = true;
    secrets.getStatus()
      .then((result) => {
        if (!mounted) return;
        setSecretsLoaded(true);
        if (result.ok) setSecretsStatus(result.data);
        else setSecretsError(describeError(result.error).message);
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setSecretsLoaded(true);
        setSecretsError(describeError(error).message);
      });
    return () => {
      mounted = false;
    };
  }, [secrets, secretsAvailable]);

  async function saveApiKey(): Promise<void> {
    const key = apiKeyDraft.trim();
    if (key.length === 0) {
      setSecretsError("请输入新的 API Key。");
      return;
    }
    if (!secretsAvailable) {
      setSecretsError("当前未连接到 SWPanel 服务，无法保存密钥。");
      return;
    }
    const secrets = window.swpanel?.secrets ?? httpSettings;
    setSavingKey(true);
    setSecretsError(null);
    try {
      const result = await secrets.setApiKey(key);
      if (!result.ok) throw new Error(describeError(result.error).message, { cause: result.error });
      setSecretsStatus(result.data);
      setConnected(false);
      setApiKeyDraft("");
      notifications?.addToast?.({
        tone: "success",
        title: "API Key 已保存",
        message: "密钥已保存在服务器私有凭据文件。"
      });
    } catch (caught) {
      setConnected(false);
      setSecretsError(describeError(caught).message);
    } finally {
      setSavingKey(false);
    }
  }

  async function clearApiKey(): Promise<void> {
    if (!secretsAvailable) return;
    const secrets = window.swpanel?.secrets ?? httpSettings;
    setClearingKey(true);
    setSecretsError(null);
    try {
      const result = await secrets.clearApiKey();
      if (!result.ok) throw new Error(describeError(result.error).message, { cause: result.error });
      setSecretsStatus(result.data);
      setConnected(false);
      notifications?.addToast?.({
        tone: "neutral",
        title: "API Key 已清除",
        message: "服务器保存的 API Key 已被移除。"
      });
    } catch (caught) {
      setConnected(false);
      setSecretsError(describeError(caught).message);
    } finally {
      setClearingKey(false);
    }
  }

  async function testApiConnection(): Promise<void> {
    setTestingConnection(true);
    setSecretsError(null);
    try {
      if (!secretsAvailable) throw new Error("当前未连接到 SWPanel 服务，无法测试连接。");
      await httpSettings.testConnection();
      setConnected(true);
      notifications?.addToast?.({ tone: "success", title: "连接成功", message: "API 服务已返回有效的模型列表。" });
    } catch (caught) {
      setConnected(false);
      setSecretsError(
        caught instanceof Error && !("code" in caught) ? caught.message : describeError(caught).message
      );
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
      setStorageError(describeError(caught).message);
    } finally {
      setSaving(false);
    }
  }

  const modeNotice =
    mode === "mock"
      ? "当前为演示数据模式，不连接真实服务，也不会读取或保存密钥。"
      : "未连接到 SWPanel 服务，请确认后端服务已启动。";
  const runtimeStatusText = !live ? modeNotice : runtimeState === "error" ? "读取失败" : "正在读取服务配置…";
  const solidWorksBadge = !live
    ? "未读取"
    : runtime === null
      ? runtimeState === "error" ? "读取失败" : "读取中"
      : runtime.modelingConfigured ? "服务端已配置" : "服务端未配置";
  const solidWorksPath = !live
    ? modeNotice
    : runtime === null
      ? runtimeStatusText
      : runtime.platform === "win32" ? "由服务端检测并控制" : "服务器平台不支持 SolidWorks";

  return (
    <div className="page-content" data-route-id="settings">
      <div className="section section-tight">
        <h1 className="page-header-title">设置</h1>
        <p className="text-muted text-sm">SolidWorks、文件存储、Agent API 与高级配置</p>
      </div>

      <div className="settings-group">
        <div className="settings-group-header">
          <span className="settings-group-title">SolidWorks</span>
          <StatusBadge variant={runtime?.modelingConfigured ? "completed" : "no-model"}>{solidWorksBadge}</StatusBadge>
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
              value={solidWorksPath}
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
            <span className="text-mono text-sm">{runtime === null ? runtimeStatusText : (runtime.solidWorksVersion ?? "未检测到可用版本")}</span>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">服务端配置</div>
            <div className="settings-row-desc">仅表示服务端已配置建模执行器，并非实时连通性检测</div>
          </div>
          <div className="settings-row-value">
            <StatusBadge variant={runtime?.modelingConfigured ? "completed" : "no-model"}>{solidWorksBadge}</StatusBadge>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">检测</div>
            <div className="settings-row-desc">重新检测 SolidWorks 安装</div>
          </div>
          <div className="settings-row-value">
            <Button variant="secondary" size="sm" disabled buttonProps={{ title: "执行环境由服务启动时检测；调整配置后请重启服务" }}>重新检测</Button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-header">
          <span className="settings-group-title">文件存储</span>
          {settingsQuery.status === "loading" && <span className="text-xs text-muted" role="status">正在加载存储设置…</span>}
        </div>
        {settingsQuery.status === "error" && (
          <InlineNotice tone="error" title="存储设置加载失败" role="alert">
            {describeError(settingsQuery.error).message}
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
                <div className="settings-row-desc">{workspaceReadOnly ? "Agent 建模工作目录（由服务端管理，网页中不可修改）" : "Agent 建模工作目录"}</div>
              </div>
              <div className="settings-row-value">
                <input
                  type="text"
                  className="form-input mono"
                  value={draftValue}
                  onChange={(event) => { setWorkspaceDraft(event.target.value); setSavedNotice(false); }}
                  readOnly={workspaceReadOnly}
                  disabled={saving}
                  aria-label="Workspace 路径"
                  aria-invalid={storageError !== null || undefined}
                />
              </div>
            </div>
            {!workspaceReadOnly && storageError !== null && (
              <div className="settings-notice">
                <InlineNotice tone="error" title="保存失败" role="alert">
                  {storageError}
                </InlineNotice>
              </div>
            )}
            {!workspaceReadOnly && savedNotice && storageError === null && (
              <div className="settings-notice">
                <InlineNotice tone="success" title="存储设置已保存" role="status">
                  新的 Workspace 路径已生效。
                </InlineNotice>
              </div>
            )}
            {!workspaceReadOnly && <div className="settings-row">
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
            </div>}
          </>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-group-header">
          <span className="settings-group-title">Agent / API</span>
          {!secretsAvailable ? (
            <StatusBadge variant="no-model">{mode === "mock" ? "演示数据" : "服务不可用"}</StatusBadge>
          ) : codexMode ? (
            authStatus?.codexLogin.loggedIn ? <StatusBadge variant="approved">已登录</StatusBadge> : <StatusBadge variant="no-model">未登录</StatusBadge>
          ) : !secretsLoaded ? (
            <StatusBadge variant="no-model">读取中</StatusBadge>
          ) : secretsStatus?.hasApiKey ? (
            <StatusBadge variant="approved">已配置</StatusBadge>
          ) : (
            <StatusBadge variant="no-model">未配置</StatusBadge>
          )}
        </div>
        {authModeAvailable && (
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-name">认证方式</div>
              <div className="settings-row-desc">自行配置 API Key，或使用服务器上 Codex CLI 的登录（走订阅额度）</div>
            </div>
            <div className="settings-row-value">
              <div role="radiogroup" aria-label="Agent 认证方式" className="flex-row-gap-3" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                <label className="flex-row-gap-3">
                  <input type="radio" name="agent-auth-mode" checked={!codexMode} disabled={switchingAuth} onChange={() => void changeAuthMode("api_key")} />
                  使用 API Key
                </label>
                <label className="flex-row-gap-3">
                  <input type="radio" name="agent-auth-mode" checked={codexMode} disabled={switchingAuth} onChange={() => void changeAuthMode("codex_cli")} />
                  使用本机 Codex CLI 登录
                </label>
              </div>
            </div>
          </div>
        )}
        {codexMode && (
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-name">Codex CLI 登录状态</div>
              <div className="settings-row-desc">读取服务器 ~/.codex（或 CODEX_HOME）中的登录记录；页面不会读取或显示令牌</div>
            </div>
            <div className="settings-row-value">
              {authStatus?.codexLogin.loggedIn ? (
                <StatusBadge variant="completed">{authStatus.codexLogin.method === "chatgpt" ? "已登录（订阅账号）" : "已登录（CLI 内置 API Key）"}</StatusBadge>
              ) : (
                <span className="flex-row-gap-3" style={{ justifyContent: "flex-end" }}>
                  <StatusBadge variant="no-model">未登录</StatusBadge>
                  <span className="text-xs text-muted">请在服务器终端运行 codex login</span>
                </span>
              )}
            </div>
          </div>
        )}
        {codexMode && (
          <div className="settings-notice">
            <InlineNotice tone="warning" title="将使用服务器所有者的订阅额度">
              所有能访问此服务的人发起的建模任务，都会消耗该 Codex 账号的额度。当前服务没有登录鉴权，请仅在受信任的网络中使用。
            </InlineNotice>
          </div>
        )}
        {!codexMode && (<>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">Base URL</div>
            <div className="settings-row-desc">Agent API 服务地址</div>
          </div>
          <div className="settings-row-value">
            <input
              type="text"
              className="form-input mono"
              value={runtime?.baseUrl ?? runtimeStatusText}
              readOnly
              aria-label="Agent API Base URL"
            />
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">API Key 状态</div>
            <div className="settings-row-desc">密钥由服务器保存，页面仅显示掩码</div>
          </div>
          <div className="settings-row-value">
            {!secretsAvailable ? (
              <span className="text-muted text-sm">{modeNotice}</span>
            ) : !secretsLoaded ? (
              <span className="text-xs text-muted" role="status">正在读取密钥状态…</span>
            ) : secretsStatus === null ? (
              <span className="text-muted text-sm">读取失败</span>
            ) : secretsStatus.hasApiKey ? (
              <span className="text-mono text-sm">{secretsStatus.maskedApiKey}</span>
            ) : (
              <span className="text-muted text-sm">未配置</span>
            )}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">新 API Key</div>
            <div className="settings-row-desc">保存到服务器私有凭据文件；已启动的 Agent 需重启服务生效</div>
          </div>
          <div className="settings-row-value">
            <input
              type="password"
              className="form-input mono input-w-xl"
              value={apiKeyDraft}
              onChange={(event) => setApiKeyDraft(event.target.value)}
              placeholder="sk-…"
              aria-label="新 Agent API Key"
              autoComplete="new-password"
              disabled={!secretsAvailable}
            />
            <div className="flex-row-gap-3" style={{ justifyContent: "flex-end", marginTop: 8 }}>
              <Button
                variant="primary"
                size="sm"
                disabled={!secretsAvailable || savingKey}
                onClick={() => void saveApiKey()}
              >
                {savingKey ? "正在保存…" : "保存密钥"}
              </Button>
            </div>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">清除密钥</div>
            <div className="settings-row-desc">删除服务器保存的 API Key</div>
          </div>
          <div className="settings-row-value">
            <Button
              variant="ghost-muted"
              size="sm"
              disabled={!secretsAvailable || !secretsStatus?.hasApiKey || clearingKey}
              onClick={() => setConfirmClear(true)}
            >
              {clearingKey ? "正在清除…" : "清除密钥"}
            </Button>
          </div>
        </div>
        </>)}
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">Model</div>
            <div className="settings-row-desc">Agent 使用的模型配置</div>
          </div>
          <div className="settings-row-value">
            <span className="text-mono text-sm">{runtime?.model ?? "由 Codex 服务端配置"}</span>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <div className="settings-row-name">连接状态</div>
            <div className="settings-row-desc">与 Agent API 的连接情况</div>
          </div>
          <div className="settings-row-value">
            <span className="flex-row-gap-3" style={{ justifyContent: "flex-end" }}>
              {connected ? (
                <StatusBadge variant="completed">已连接</StatusBadge>
              ) : (
                <StatusBadge variant="no-model">未连接</StatusBadge>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={!secretsAvailable || testingConnection}
                onClick={() => void testApiConnection()}
              >
                {testingConnection ? "正在测试…" : "测试连接"}
              </Button>
            </span>
          </div>
        </div>
        {secretsError !== null && (
          <div className="settings-notice">
            <InlineNotice tone="error" title="密钥操作失败" role="alert">
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
              <span className="text-sm text-muted">由服务端配置</span>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-name">Skill</div>
              <div className="settings-row-desc">Agent 技能配置</div>
            </div>
            <div className="settings-row-value">
              <span className="text-sm text-muted">由服务端配置</span>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-name">Runtime</div>
              <div className="settings-row-desc">运行时环境配置</div>
            </div>
            <div className="settings-row-value">
              <span className="text-sm text-muted">由服务端配置</span>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-name">Log</div>
              <div className="settings-row-desc">系统日志</div>
            </div>
            <div className="settings-row-value">
              <span className="text-sm text-muted">由服务端配置</span>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-label">
              <div className="settings-row-name">Debug</div>
              <div className="settings-row-desc">调试工具</div>
            </div>
            <div className="settings-row-value">
              <span className="text-sm text-muted">由服务端配置</span>
            </div>
          </div>
        </div>
      </div>

      {runtimeState === "error" ? (
        <InlineNotice tone="error" className="mt-6" title="运行环境状态读取失败" role="alert">
          {runtimeError}
          <div className="mt-2">
            <Button variant="secondary" size="sm" onClick={() => setRuntimeTick((tick) => tick + 1)}>重试</Button>
          </div>
        </InlineNotice>
      ) : (
        <InlineNotice tone="neutral" className="mt-6">
          {!live ? modeNotice : runtime?.reason ?? "正在读取运行环境状态…"}
        </InlineNotice>
      )}

      {confirmClear && (
        <Dialog labelledBy="clear-api-key-title" onClose={() => setConfirmClear(false)} dismissible={!clearingKey}>
          <div className="dialog-header"><h2 id="clear-api-key-title" className="dialog-title">清除 API Key</h2></div>
          <div className="dialog-body">
            <p>清除后新的建模任务将无法调用 Agent API，确认清除？</p>
          </div>
          <div className="dialog-footer">
            <Button variant="ghost" disabled={clearingKey} onClick={() => setConfirmClear(false)}>取消</Button>
            <Button
              variant="danger"
              disabled={clearingKey}
              onClick={() => { void clearApiKey().then(() => setConfirmClear(false)); }}
            >
              {clearingKey ? "正在清除…" : "确认清除"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export default SettingsPage;
