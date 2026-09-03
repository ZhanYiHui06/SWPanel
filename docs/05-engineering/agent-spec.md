---
title: Agent Spec — Input Adapter 与 Agent Contract 正式协议
status: evolving
owner: JANGHI
last_updated: 2026-08-16
---

# SWPanel Agent Spec（Phase 4 — Input Adapter 与 Agent Contract）

本文档定义 SWPanel 产品层与外部建模 Skill 之间的**正式协议**：Prompt Template、Invocation Package、Raw Agent Records、Structured Product Events、Clarification Contract、Result Manifest 与 Input Adapter provenance。它落实 `development-plan.md` §8、`architecture.md` §8–9 与 `docs/02-workflows/modeling-workflow.md` 中"具体 Prompt 内容 / 具体协议格式由 agent-spec.md 定义"的引用。

**当前状态（2026-08-14，Phase 5 仓库侧实施中，Exit Gate 未 PASS）**：Phase 4 协议全部由 `@swpanel/contracts` 的版本化 JSON Schema + 无依赖严格验证器落地，并由确定性 Fake Adapter / Fake Agent Adapter 端到端验证（2026-08-14 **当前树最终验证**：`npm run check` exit 0——root 10/291、desktop 31/572、runner 37/691、contracts 13/148、domain 14/70、ui 6/43，计数含全部 P5 套件；`check:fixtures` 1/1 零 violations；`test:e2e` exit 0——production Electron 20/20、browser+smoke 51/51；日志 `.scratch/check-p5-final.log` 等）。**Phase 5 仓库侧 P5-1..P5-4 契约实现完成并最终验证，但 Exit Gate NOT PASS**：**九项** preflight 能力门（报告契约 **v2**）恒生效——SolidWorks 为 **version-agnostic**（仅 availability/automation 门，实际版本由 probe/builder 记录，无版本硬匹配），`$solidworks-build-mechanical-models` 保留为 **非阻塞 Skill prose**（故意不是门项，绝不伪装为已解析）；成功路径原子发布 `PENDING_REVIEW` Model（产品默认）；Codex App Server `0.147.0` / protocol v2 契约钉定，**shell-free live stdio transport/lifecycle 已实现并最终验证**，真实 `initialize` + `skills/list` native smoke **通过（skill 目录→`SKILL.md` 精确路径校验通过）**并发现两个精确的外部 skill copies（`.agents` 与 `.codex`，digest `3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`），**live Runner 已接线 owned Codex adapter + 真实 PDF adapter**（`apps/desktop/src/main/runner-host/live-codex-wiring.ts`，`ownsAgent: true` 关闭时有界回收）；真实 preflight probe 与真实 PDF adapter（pypdfium2 4.30.0，300 DPI）已实现并**最终验证**；**async ownership-safe SolidWorks live probe 已实现并实测**（本机 `available:false`、`installedVersion` 33.0.0.5050、owned 进程已关闭、无残留进程、attach 错误不再 spawn）；**probe 版本写入 prompt（`expectedSolidWorksVersion`）并在 ArtifactValidator 精确校验**（manifest `solidWorksVersion` 必须与 Runner 认定的非空期望版本完全相等，否则 fail-closed）；ownership-safe Cancel 与低 Stage 钉定线程恢复仅契约测试、**无 HIL**。**本机 SolidWorks 2025（33.0.0.5050）已安装但 availability 门当前 FAILS**——COM 激活与直接启动均在 AMD `atio6axx.dll` 31.0.12042.4 以 `0xc0000005` 崩溃（本地 CXPD dump 证据），获批图纸建模 **未启动**。**尚未接入真实 Agent 运行时全链路建模与真实 SolidWorks**；默认产品路径转换/产物仍为 synthetic，`productionVerified: false`，不声称 PDF/DWG/DXF 生产转换已验证，**不声称 Phase 5 PASS、无 live HIL**。

**2026-08-15 更新（三次获批链 HIL 尝试均未完成；Exit Gate 保持 NOT PASS，不越报）**。2026-08-15 执行了三次获批图纸链 HIL 尝试，**均未完成**（证据目录 `.scratch/hil-20260815-142334-52f26231`、`.scratch/hil-20260815-144823-3836c9fc`、`.scratch/hil-20260815-214252-393c22d8`）：(1) 第一次真实 Runner Run 如实 FAILED `AGENT_PROTOCOL_INCOMPATIBLE`——九项 preflight 全过（`synthetic:false`）、真实 PDF adapter 通过、SolidWorks probe `available:true`/`33.0.0`/`owned-process-proven`；根因是原生 Codex 0.147.0 在 `experimentalApi:false` 下拒绝实验性 `thread/start.runtimeWorkspaceRoots`，已移除该 gated 字段——稳定 thread start = `cwd` + `sandbox:"workspace-write"`、attempt-root 包含在 `turn/start.sandboxPolicy`，live preflight 现含无害真实 `thread/start`；(2) 第二次真实 Runner Run 如实 FAILED `AGENT_RUNTIME_UNAVAILABLE`——九项 preflight 与真实 PDF adapter 全过、真实 `thread/start` + `turn/start` + failed turn 已发生、SolidWorks probe 再次 `available:true`/`33.0.0`/`owned-process-proven`、无 CAD/artifacts；adapter 曾丢弃原生 `turn.error.message`（精确 Skill/image Turn 错误丢失）——**失败回合诊断保留已实现**：Codex `turn.error.message` 确定性脱敏（URL、含空格绝对路径、credentials/env secret keys、JWT；控制符/空白归一；≤512 字符）仅写入技术 `runtime/agent-session.json` note，产品可见 `AGENT_RUNTIME_UNAVAILABLE` 保持通用、失败路径不写原始 agent 日志，harness 1.0.2 仅允许复制白名单 status/adapter/protocol 字段 + 有界脱敏 note 为 `14-agent-session-diagnostic.json`（绝不复制完整 session/thread/turn/attempt ID/时间戳/原始日志），`skill.resolvedPath` 亦做绝对路径校验；(3) 第三次在 `Runner.open`/Run 创建前停止（Codex 0.147.0 probe 与精确 Skill 路径/digest 通过、SolidWorks probe fail-closed）——harness/preflight 停止，非 Run 终态失败。**SolidWorks COM probe 已重设计**：PowerShell `GetActiveObject` 在 Python/pywin32 可用的主机上是假阴性源（`TYPE_E_ELEMENTNOTFOUND`），COM attach/poll 现仅用有界 Python/pywin32 `GetActiveObject`（PowerShell 仅 registry/文件版本发现）；既有实例只读；owned spawn 用精确 Node child handle/PID + 精确 `GetProcessID()` 相等，无 Dispatch/CreateObject、无 kill-all、无 ExitApp/Quit。**主机状态动态**：前两次 probe 成功，21:42 owned SolidWorks 启动在 COM 注册前退出；`21-solidworks-startup-diagnostic.json` 显示 default、`/ForceSoftwareOGL /SWDisableExitApp`、`/SWSafeMode /SWDisableExitApp` 均 ~3–4 s 以 unsigned 3221225477（`0xC0000005`）退出——**当前崩溃不结论性归因于 AMD/atio6axx**（AMD Radeon driver 31.0.12042.4 仅主机上下文/历史假设）；SolidWorks 已安装且 COM 已注册但当前不可驱动。**owned 早退修复**：probe 并发观察精确 owned 进程早退、abort/await helper child、以稳定 reason `owned-process-exited` 及时返回（安全 `ownedProcessExitCode`、`installedVersion`、真实 owned spawned/closed 事实）；窄范围真实 probe 证据（`22-solidworks-probe-after-early-exit-fix.json`）：`available:false`/`installedVersion` 33.0.0.5050/owned spawned+closed true/exit 3221225477/reason `owned-process-exited`/7044ms，无 Codex/PDF/Run/HIL、无残留 SLDWORKS/codex 进程。**当前工作树全新全量验证（2026-08-15）**：`npm run check` **exit 0**（typecheck、仓库 lint、全部测试与完整 build 全绿——root 10 files/291、desktop 31 files/572、runner **38 files/738 tests**、contracts 13 files/148、domain 14 files/70、ui 6 files/43）；`npm run check:fixtures` **1/1 通过**（13/13 canonical scenarios、0 violations、RESULT PASS）；`npm run test:e2e` **顺序通过 exit 0**（production Electron **20/20**、browser + Electron smoke **51/51**）；canonical package/installer 未刷新。**Exit Gate 保持 NOT PASS：无成功 `.SLDPRT` + 六 Artifact + Model（`PENDING_REVIEW`）、无真实 Clarification 场景、无 ownership-safe 取消 HIL；`productionVerified` 恒 `false`；不 commit/push、不进入 Phase 6**（详见第 8 节）。

---

## 1. 版本与注册

- 合同版本常量由 `packages/contracts/src/phase4/` 导出：IPC Envelope、Invocation Package、Runtime Metadata、Product Events、Clarification、Error、Input Adaptation、Result Manifest 各带独立 contract version；Schema 注册表 `PHASE4_SCHEMAS`（`PHASE4_REGISTRY_VERSION = 1`）登记 draft-07 JSON Schema 文档（schema id 形如 `swpanel://contracts/<name>/1`）。
- 严格验证器无运行时依赖，拒绝未知字段、错误版本与非法枚举（抛 `Phase4ContractError`）；验证器是运行时权威，注册表是文档/审计面。
- Raw Agent Records 协议版本 `RAW_AGENT_RECORDS_VERSION = 1`；Prompt Template 版本 `PROMPT_TEMPLATE_VERSION = "2026.08-p4"`（冻结进每次 Run 的 Input Snapshot，`DEFAULT_RUN_PROFILE` 提供生产默认）。

## 2. Prompt Template（受控、版本化、普通用户不可见）

模板文本是产品代码内的固定版本化常量（`apps/runner/src/adaptation/prompt-template.ts`），普通用户不可编辑，无 UI 编辑入口。每次 attempt 由 `renderPrompt` 从冻结输入确定性渲染（相同输入 → 相同文本）：

- Run 身份：runId / drawingId / revisionId / 冻结的 `promptTemplateVersion` / agentConfigId；
- Drawing Input：原始文件引用、adapter id/version、派生图像（workspace-relative path + sha256）、`productionVerified`、显式 page selection（存在时）；
- Revision Facts 与 Modeling Feedback（来自冻结 Snapshot，绝不来自客户端）；
- Workspace：attempt `{input,working,output,logs}` 绝对路径；
- Output Contract：成功执行必须产出机器可读 Artifact 集（.SLDPRT、Preview、Dimension Ledger、Feature Plan、Validation Log；Builder Source 为当前 adapter 必需项），最终响应机器可读且可独立验证；
- Execution Rules：execution visibility（默认 background）、recordMp4（默认 false）、不修改原始图纸、只写 attempt workspace、未解决的工程事实必须以结构化 Clarification 呈现。

Prompt 不包含任何"猜测尺寸""静默选页"类指令；工程歧义只能走 Clarification（见第 5 节）。

## 3. Invocation Package

由 Runner 在 PREPARING 从冻结 `RunInputSnapshot` + Input Adapter provenance + attempt workspace 构建（`buildInvocationPackage`），经过共享验证器严格校验后写入 attempt workspace；Agent 永远看不到客户端提供的 Snapshot。形状（架构 §9.3）：

```json
{
  "contractVersion": 1,
  "runId": "...",
  "skill": { "name": "solidworks-autobuild", "sha256": "..." },
  "input": { "originalArtifactId": "...", "imagePath": "...", "imageSha256": "..." },
  "memory": { "revisionFacts": [], "modelingFeedback": [] },
  "workspace": { "root": "...", "output": "..." },
  "execution": { "visibility": "background", "recordMp4": false }
}
```

## 4. Raw Agent Records 与 Product Events 边界

### 4.1 Raw Agent Records（技术输入，不进入 UI）

真实/假 Agent 运行时的原始输出被规范化为版本化 raw record 流（`RAW_AGENT_RECORD_TYPES`，10 种）：`session_started`、`stage_changed`、`activity_updated`、`progress_updated`、`clarification_requested`、`turn_completed`、`metadata_updated`、`result_manifest`、`runtime_log`、`runtime_error`。每条 record 带 `recordVersion`、`type`、`occurredAt`、`threadId`。raw records 只写 attempt workspace 的 `logs/` / `runtime/` 技术目录，**永不直接进入 UI event 流**；原始推理内容绝不暴露给 Renderer。

### 4.2 Product Event Translator（唯一转换边界）

`apps/runner/src/agent/product-event-translator.ts` 是 raw → product event 的**唯一**桥：

- 只接受版本化 record；`session_started` / `runtime_log` / `runtime_error` 是技术记录，不派生任何产品事件；
- 允许的映射：`stage_changed` → StageChanged；`activity_updated` → ActivityUpdated；`progress_updated` → ProgressUpdated；`clarification_requested` → ClarificationRequired；`turn_completed` → AgentTurnCompleted；`metadata_updated` → RuntimeMetadataUpdated；`result_manifest` → ResultManifestReceived（必须在 `turn_completed` 之后，否则 OUT_OF_ORDER）；
- **绝不派生 `Completed` / `Failed`**：终态事件由 orchestrator 依据独立校验结果发出；
- 非法版本 / 未知类型 / 畸形 payload / 越序流 → 稳定结构化失败，Run 级失败码 `AGENT_PROTOCOL_INCOMPATIBLE`；
- 每个构造的 payload 都通过共享 `validateProductEventPayload`（12 种 `RUN_EVENT_TYPES` 的 payload 全覆盖，不只校验 envelope）。

### 4.3 产品事件信封

每个事件带 `contractVersion / runId / attemptId / sequence / occurredAt`（`runtimeThreadId` 可用时携带）。UI 只消费结构化事件，不解析自然语言状态。

## 5. Clarification Contract

- Clarification 是**结构化问题集合**（当前为 dimension / choice 两种 question type，带 hint/unit/options），不是让前端解析自然语言。
- Fake Agent Adapter 在澄清场景通过结构化 schema 提供 question set；阻塞澄清必须在 SolidWorks 启动前发出。
- 用户提交回答后（单轮批量回答，校验 answer 与 question type/options）：
  1. Clarification 标记 `ANSWERED` 并保存 answers；
  2. 答案转换为该 Revision 的 Revision Facts（`source: "CLARIFICATION"`，记录 `sourceRunId`）；
  3. 原 Run 保持终态（`CLARIFICATION_REQUIRED`），**不自动续跑**；用户手动创建新 Run（新的 `run.create` 铸造新 intent，产生新 Run）。
- 原子性：任一步失败时 clarification / answers / facts 均不部分提交；重复提交 / 幂等不产生重复 facts。

## 6. Input Adapter 与 Provenance 真实性

产品输入（PDF / DWG / DXF）经版本化 Input Adapter 转成 Skill 接受的 JPG / PNG；**原始图纸不可变**，adapter 只在 attempt workspace 内写派生图像 + provenance，绝不覆盖源文件。每个成功转换的 provenance 记录：adapter id/version、源文件 SHA-256、页/布局选择、输出 path/hash/dimensions/DPI、warnings、unsupported entities、preview、`productionVerified`、`createdAt`。

**真实性约束（Phase 4 契约）**：

- **不静默选页**：多页 PDF 没有显式页选择即失败（`PAGE_SELECTION_REQUIRED`）；单页路径在无显式选择时 provenance 不记录任何 page/layout 断言（带 warning）；fake 从不检查源文件，因此只回显请求显式给出的选择；
- **合成 ≠ 生产验证**：本阶段所有成功转换均 `productionVerified: false` + 人工可读 warning；DWG/DXF 是 synthetic test-only 路径（adapter id 显式 `-test-only`），未经获批生产图纸验证不得声称生产可用；
- 失败码：`UNSUPPORTED_SOURCE_FORMAT`（→ Run 级 `INPUT_UNSUPPORTED`）、`SOURCE_MISSING_OR_CORRUPT` / `PAGE_SELECTION_REQUIRED` / `CONVERSION_FAILED` / `OUTPUT_VALIDATION_FAILED`（→ Run 级 `INPUT_ADAPTER_FAILED`）。

## 7. Result Manifest 与独立 Artifact 校验

### 7.1 Manifest

成功执行的最终响应必须满足版本化 Result Manifest schema（`packages/contracts/src/phase4/result-manifest.ts`），描述最终模型与 Artifacts：`result`、`solidWorksVersion`、`units`、`projectionDecision`、`featureCount`、`bodyCount`、`rebuildStatus`、`unresolvedAssumptions`、`artifacts`（sldprt / preview / dimensionLedger / featurePlan / buildValidationLog / builderSource；`recordMp4=true` 时 processMp4 必需）。

### 7.2 独立校验（Agent 自称完成不具权威性）

`apps/runner/src/artifacts/artifact-validator.ts` 在 Agent 发出 `ResultManifestReceived` 后独立验证（确定性 fail-fast 顺序）：

1. manifest 文档：schema / 版本（共享 `validateResultManifest`）；
2. manifest 路径：安全 workspace-relative（无 traversal / 绝对路径 / symlink / junction）；
3. 必需 artifact 集：全部存在、非零字节、size 与 SHA-256 与实际文件一致、canonical 路径不逃逸 attempt workspace；
4. 声明的最低 validation / rebuild 状态：`rebuildStatus: "PASSED"`。

失败码准确稳定：`ARTIFACT_MANIFEST_INVALID`（malformed/version mismatch）、`ARTIFACT_MISSING`（missing/zero-byte/hash mismatch）、`ARTIFACT_OUTSIDE_WORKSPACE`（path escape）、`VALIDATION_REJECTED`（最低验证要求未满足）。先追加 `ArtifactValidationFailed` 事件，再以准确 failure code 终止；**只有独立校验通过，orchestrator 才允许 `completeAttempt`**（Phase 4 不发布 Model，`Completed` 事件不带 `modelId`）。

## 8. 与 Phase 5 的边界

- 本协议由 deterministic Fake Adapter / Fake Agent Adapter 完整端到端验证（无 SolidWorks）；真实 Codex App Server Adapter（Phase 5）必须把其运行时输出规范化为同一 raw record 协议，并继续满足本规范的全部契约与真实性约束。
- **Phase 5 仓库侧契约实施状态（2026-08-14，Exit Gate NOT PASS，不越报）**：
  - **P5-1 九项 preflight 能力门恒生效（报告契约 v2）**：`PREFLIGHT_CAPABILITIES`（`packages/domain/src/runs/preflight.ts`，规范顺序：`agent_runtime_available` / `agent_runtime_version_supported` / `agent_model_supports_image` / `modeling_skill_discovered` / `modeling_skill_hash_allowed` / `structured_runtime_protocol_available` / `workspace_write_scope_supported` / `solidworks_available` / `input_adapter_succeeded`）+ `apps/runner/src/preflight/preflight.ts` 探针边界。**SolidWorks 为 version-agnostic**：门只要求任何可驱动的安装（`solidworks_available`），实际版本由 probe/builder 记录、绝不发明；**`mechanical_execution_dependency_resolved` 不再是门项**——`$solidworks-build-mechanical-models` 引用保留为 Skill prose、非阻塞、绝不伪装为已解析。默认产品路径走**显式 synthetic/unverified fixture**（`DEFAULT_PREFLIGHT_SCENARIO = "all-pass"`、`FAKE_PREFLIGHT_SKILL_SHA256`），持久化报告恒为 **`synthetic: true`**，探针抛错即该项 fail-closed；`input_adapter_succeeded` 仅在适配成功后由 executor 标记。真实 probe（`real-preflight-probe.ts` + `skill-directory-hash.ts`：真实 `codex --version` 探针（精确 pin `0.147.0`）、真实 skill 目录发现 + 规范目录 SHA-256、真实 workspace 可写探针、注入式 SolidWorks seam、`synthetic: false`）已实现并**最终验证**（Electron Main host await 异步 live probes 后注入固定 seam——probe 内永无内联 live COM 调用）。
  - **P5-2 Model 发布原子且产品默认**：成功路径在**单事务**内原子发布 `PENDING_REVIEW` Model（Model 行 + artifact 元数据行 + 带 Model id 的 `Completed` 事件 + FINISHED attempt；Runner 产品默认 `publishModel: true`）；manifest 的 `productionVerified` wire boolean 由契约解析（缺省即 `false`）；独立 ArtifactValidator 将任何 `productionVerified: true` 声明以 `ARTIFACT_MANIFEST_INVALID` 拒绝——不存在产品侧 HIL 验证记录、声明绝不 authoritative，仅 `false`/缺省可发布；synthetic 结果如实持久化 `productionVerified: false`。
  - **P5-3 Codex App Server 契约钉定 + live stdio transport**：严格 NDJSON JSON-RPC client + adapter（`apps/runner/src/agent/codex/`）钉定 **`codex-cli 0.147.0` / protocol v2**（schema 文档在 `.scratch/codex-app-server-schema-0.147.0/v2/`）；**shell-free live stdio child transport + lifecycle 已实现并最终验证**（`codex-child-transport.ts`：`app-server --stdio`、`shell: false`、`windowsHide`、有界 SIGTERM→SIGKILL close、有界 stderr tail、exactly-once 退出传播；裸名 `.cmd` shim 由稳定 `resolveCodexAppServerCommand` 拒绝）；真实 `initialize` + `skills/list` **native smoke 通过**（**skill 目录→`SKILL.md` 精确路径校验通过**——skills/list 报告的 `<directory>\SKILL.md` 与配置目录做规范 Windows 安全段比较，兄弟目录/`.codex` 副本/嵌套 manifest/异名文件均 fail-closed），发现两个精确外部 skill copies（`C:\Users\Eric Chan\.agents\skills\solidworks-build-part-from-drawing` 与 `.codex` 对应目录，规范目录 digest `3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`，两副本逐字节一致）；**live Runner 已接线 owned Codex adapter + 真实 PDF adapter**（`apps/desktop/src/main/runner-host/live-codex-wiring.ts`：每 Runner 恰一个持久 child transport、`ownsAgent: true` 关闭时有界回收、`RealPdfInputAdapter` 显式 helper 路径解析到 asar）；**完整 live 建模 turn 链从未 HIL 验证**。
  - **P5-4 ownership-safe Cancel 与低 Stage 钉定恢复 + async ownership-safe SolidWorks live probe**：SolidWorks 取消走显式 per-attempt 身份证明的 ownership guard（`closeOnlyOwned`，绝不 kill-all，无法证明 → `CANCEL_CLEANUP_PENDING`）；线程恢复仅对 `null`/PREPARING/ANALYZING/PLANNING 可证明续跑（MODELING/VALIDATING/PACKAGING 硬性无 checkpoint）；**二者仅契约测试，从未 HIL 验证**。live probe（`solidworks-live-probe.ts`）：READ-ONLY attach 既有 COM 实例（绝不关闭、绝不触碰文档），仅干净 `ok:true, attached:false` 才进入 owned-spawn 路径（**attach 抛错/超时/`ok:false`/foreign/畸形绝不 spawn**），spawn 后以精确 pid 证明 COM ownership、只关闭 owned 进程；**本机实测 `available:false`、`installedVersion` 33.0.0.5050、owned 进程已关闭、无残留进程**（AMD 启动崩溃使 COM 无法注册，崩溃绝不被报告为可用）。
- Phase 5 之前的真实性限制保持（真实 DWG/DXF 生产转换未验证——`productionVerified: false`；真实 PDF adapter 已实现并最终验证，一份获批 PDF 真实栅格化：300 DPI / pypdfium2 4.30.0 / 4963×3509 / 源哈希 `e321dc34c80b943b8af9ca9ea4ebbf9f42003627707503bf25512a479cda72a0` / 输出哈希 `30614c32a5dba38374642bf76e0e7e763674e15b78455c2cb4ff18d316ae7d96` / `productionVerified: false` / 产物留在 temp、仓库之外；**无获批图纸真实 E2E**）。**本机 SolidWorks 2025（33.0.0.5050）已安装但 availability 门当前 FAILS**（COM 激活与直接启动均在 AMD `atio6axx.dll` 31.0.12042.4 以 `0xc0000005` 崩溃；本地 CXPD dump 证据），获批图纸建模 **未启动**；SolidWorks live probe 本机实测 `available:false`/`installedVersion` 33.0.0.5050/owned 进程已关闭/无残留进程/attach 错误不再 spawn；真实 skill hash 校验：外部 `.agents`/`.codex` 副本已同步为 digest `3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`，真实 probe 已实现并最终验证（synthetic 门仍只接受 fake fixture digest）。Phase 5 Exit Gate 未 PASS；`productionVerified: true` 无独立证据支持、将 fail-closed。

**2026-08-15 现场 HIL 尝试与修复事实（更新；上方 2026-08-14 条目保持历史、不作改写）**：

- **三次获批链 HIL 尝试，均未完成**：(1) `.scratch/hil-20260815-142334-52f26231`（14:23）——真实 Runner Run 如实 FAILED `AGENT_PROTOCOL_INCOMPATIBLE`；九项 preflight 全过（`synthetic:false`）、真实 PDF adapter 通过、SolidWorks probe `available:true`/`33.0.0`/`owned-process-proven`；根因：原生 Codex 0.147.0 在 `experimentalApi:false` 下拒绝实验性 `thread/start.runtimeWorkspaceRoots`——已移除 gated 字段，稳定 thread start = `cwd` + `sandbox:"workspace-write"`、attempt-root 包含在 `turn/start.sandboxPolicy`，live preflight 现含无害真实 `thread/start`；(2) `.scratch/hil-20260815-144823-3836c9fc`（14:48）——真实 Runner Run 如实 FAILED `AGENT_RUNTIME_UNAVAILABLE`；九项 preflight 与真实 PDF adapter 全过、真实 `thread/start` + `turn/start` + failed turn 已发生、SolidWorks probe 再次 `available:true`/`33.0.0`/`owned-process-proven`、无 CAD/artifacts；adapter 丢弃原生 `turn.error.message` → 精确 Skill/image Turn 错误丢失；(3) `.scratch/hil-20260815-214252-393c22d8`（21:42）——在 `Runner.open`/Run 创建前停止（Codex 0.147.0 probe 与精确 Skill 路径/digest 通过、SolidWorks probe fail-closed）——harness/preflight 停止，非 Run 终态失败。
- **失败回合诊断保留（已实现）**：Codex `turn.error.message` 确定性脱敏（URL、含空格绝对路径、credentials/env secret keys、JWT；控制符/空白归一；≤512 字符）仅写入技术 `runtime/agent-session.json` note；产品可见 `AGENT_RUNTIME_UNAVAILABLE` 保持通用；失败路径不写原始 agent 日志；harness 1.0.2 仅允许复制白名单 status/adapter/protocol 字段 + 有界脱敏 note 为 `14-agent-session-diagnostic.json`（绝不复制完整 session/thread/turn/attempt ID、时间戳或原始日志）；`skill.resolvedPath` 绝对路径校验。
- **SolidWorks COM probe 重设计**：PowerShell `GetActiveObject` 在 Python/pywin32 可用的主机上是假阴性源（`TYPE_E_ELEMENTNOTFOUND`）；COM attach/poll 现仅用有界 Python/pywin32 `GetActiveObject`（PowerShell 仅 registry/文件版本发现）；既有实例只读；owned spawn 用精确 Node child handle/PID + 精确 `GetProcessID()` 相等，无 Dispatch/CreateObject、无 kill-all、无 ExitApp/Quit。
- **主机状态动态（当前事实）**：前两次 probe 成功（`available:true`/`33.0.0`/`owned-process-proven`）；21:42 owned SolidWorks 启动在 COM 注册前退出；`21-solidworks-startup-diagnostic.json`：default、`/ForceSoftwareOGL /SWDisableExitApp`、`/SWSafeMode /SWDisableExitApp` 均 ~3–4 s 以 unsigned 3221225477（`0xC0000005`）退出；**当前崩溃不结论性归因于 AMD/atio6axx**（AMD Radeon driver 31.0.12042.4 仅主机上下文/历史假设；两个 Rx session-safe 模式均失败意味着硬件 OpenGL 与普通 Tools/Options 状态未被单独隔离为唯一原因）；SolidWorks 已安装且 COM 已注册但当前不可驱动。
- **owned 早退修复**：probe 并发观察精确 owned 进程早退、abort/await helper child、以稳定 reason `owned-process-exited` 及时返回（安全 `ownedProcessExitCode`、`installedVersion`、真实 owned spawned/closed 事实）；窄范围真实 probe 证据（`22-solidworks-probe-after-early-exit-fix.json`）：`available:false`/`installedVersion` 33.0.0.5050/owned spawned+closed true/exit 3221225477/reason `owned-process-exited`/7044ms；无 Codex/PDF/Run/HIL；无残留 SLDWORKS/codex 进程。
- **验证范围（2026-08-15，更新）**：当前工作树全新全量验证通过——`npm run check` **exit 0**（typecheck、仓库 lint、全部测试与完整 build 全绿：root 10 files/291、desktop 31 files/572、runner **38 files/738 tests**、contracts 13 files/148、domain 14 files/70、ui 6 files/43）；`npm run check:fixtures` **1/1 通过**（13/13 canonical scenarios、0 violations、RESULT PASS）；`npm run test:e2e` **顺序通过 exit 0**（production Electron **20/20**、browser + Electron smoke **51/51**）；canonical package/installer 未刷新。此验证范围更新仅取代上方"修复后仅聚焦验证重跑、未在最新改动后重跑"的陈述，HIL 事实与 Exit Gate NOT PASS 不变。
- **Exit Gate 保持 NOT PASS（2026-08-15）**：无成功 `.SLDPRT` + 六 Artifact + Model（`PENDING_REVIEW`）、无真实 Clarification 场景、无 ownership-safe 取消 HIL；`productionVerified` 恒 `false`；不进入 Phase 6；未 commit/push——当前工作树仍无法由 Git revision 复现。

**2026-08-16 Agent 终态、超时与 HIL 更新（append-only）**：

- Prompt Template 当前版本为 **`2026.08-p5.1`**。真实 Agent 最终响应不再只允许 Manifest，而是严格的 Agent Turn Output v1：`completed` 分支携带 Result Manifest v1，`clarification_required` 分支携带非空、严格验证的结构化问题集；澄清路径不写 Result Manifest、不执行 ArtifactValidator、不发布 Model，由 orchestrator 原子创建 Clarification Request 与 `ClarificationRequired` 产品事件。阻塞工程事实未解决时必须在启动 SolidWorks 前返回该分支。
- 产品 canonical JSON Schema 保持严格互斥 `oneOf`。由于原生 Codex 0.147.0 拒绝该 provider output schema，Codex adapter 使用完全展开、所有 object closed、所有字段 required、可选语义由 `null` sentinel 表达的 provider wire schema，再投影回 canonical validator。最小 native probe 已证明 provider 接受该 wire schema并可投影 `clarification_required`；该 probe 没有业务图纸或真实工程 blocker，因此**不构成真实工程 Clarification HIL**。
- 终态抽取在有界 delta 集合上执行 string-aware balanced JSON 扫描，并要求整回合恰有一个有效 provider-wire 文档。零个、多个或畸形文档全部 fail-closed；技术 session 只持久化 `no-agent-message-items`、`no-balanced-json-object`、`no-parseable-json-object`、`no-valid-provider-wire-document`、`multiple-valid-provider-wire-documents` 等内容无关类别，不保存 Agent 输出值、raw JSON、路径或 raw response。
- Codex client 与 adapter 共享固定 **15 分钟** turn-wait 上限。真实 TIMEOUT 仅区分当前 turn 是否观察到 Agent message item；foreign-turn item 不计入。child exit 等非 timeout wait failure 即使此前观察到当前 turn item，也保持通用 `Codex turn wait failed` note。同步 request write 失败和 turn-wait timeout 均不会污染共享客户端；对应迟到 response 被安全忽略。
- 获批 PDF 真实链 `.scratch/hil-20260816-140950-b6482492` 在旧 600 秒上限处如实结束 `FAILED / AGENT_TIMEOUT`；真实 preflight、Runner 与 PDF adaptation 已通过，但无 ownership registry、`.SLDPRT`、Result Manifest、Clarification、Artifact 或 Model。重建后的下一次尝试 `.scratch/hil-20260816-143105-4e1a0596` 在 `Runner.open` 前被 SolidWorks probe fail-closed：exact harness-owned process 以 `3221225477`（`0xC0000005`）早退，`available:false`、owned process 已关闭、隔离 temp root 已清理。未修改驱动、注册表、SolidWorks 安装或其他系统配置；在 ownership 无法证明时未执行 cancel HIL。
- 最终当前树验证通过：`npm run check` exit 0（root 10/291、desktop 31/576、runner 42/855、contracts 14/162、domain 14/70、UI 6/43，共 117 files / **1,997 tests**；typecheck、lint、完整 build 全绿）；fixtures 1/1、13/13 scenarios、0 violations；production Electron 20/20、browser + Electron smoke 51/51。**Phase 5 仍为 NOT PASS**：无成功真实 CAD + 六 Artifact + 原子 `Model(PENDING_REVIEW)`，无真实工程 Clarification HIL，无 ownership-safe Cancel HIL；`productionVerified` 保持 `false`，不进入 Phase 6，未 commit/push。
