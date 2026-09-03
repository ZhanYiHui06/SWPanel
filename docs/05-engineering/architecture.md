---
title: Architecture
status: evolving
owner: JANGHI
last_updated: 2026-08-16
---

# SWPanel MVP Architecture

本文档定义 SWPanel MVP 的工程结构和边界。产品规则仍以 Product Scope、Domain、Workflow 与已接受 Decision 为准；本文档不扩大 MVP 范围。

## 1. Architecture Decision Summary

MVP 采用以下基线：

| 层 | 选择 |
|---|---|
| Windows Desktop Shell | Electron |
| Frontend | React + TypeScript + Vite |
| Styling | 从 `./.design` 提取的 CSS Tokens、组件样式与本地字体 |
| Business Runtime | 独立的 Node.js Agent Runner 进程 |
| Local IPC | Windows Named Pipe，版本化 JSON 消息 |
| Structured Persistence | SQLite WAL，由 Agent Runner 独占写入 |
| Large Files | NTFS 文件系统中的不可变 Drawing / Run / Model Artifact |
| Agent Runtime | Codex App Server Adapter；CLI `exec --json` 作为降级与测试入口 |
| Modeling Skill | 仅 `solidworks-build-part-from-drawing` |
| Secret Storage | Windows Credential Manager；通过维护中的原生 keyring binding 访问 |
| Packaging | Electron Forge / Packager + Windows installer；x64，本地签名 |

关键原则：

1. Renderer 不直接访问 Node、文件系统、SQLite、Agent、Secret 或 SolidWorks。
2. Electron Main 只负责窗口、Preload、系统文件选择与受控 OS 集成，不拥有业务真相。
3. Agent Runner 独立于 Electron 生命周期，负责队列、状态、数据库、Workspace、Agent Session、恢复与 Artifact 验证。
4. SWPanel 不复制建模 Skill 的图纸理解和建模算法。
5. Agent 自然语言不是业务状态；UI 只消费 SWPanel 定义的结构化事件与持久化 Snapshot。
6. Agent 或 Skill 声称完成不等于 Run `COMPLETED`。

---

## 2. System Context

```text
Internal Engineer
      │
      ▼
SWPanel Desktop UI
      │
      ├── manages Drawing / Revision / Memory / Run / Review / Cost
      │
      ▼
SWPanel Agent Runner
      │
      ├── invokes Codex runtime with an explicit skill input
      ▼
solidworks-build-part-from-drawing
      │
      └── retains its mechanical-modeling dependency reference as non-blocking prose
              │
              ▼
        Detected supported SolidWorks
```

External or machine dependencies:

- Windows interactive user session;
- a drivable supported SolidWorks installation; the preflight gate is availability-only, records the actual version, and never applies a hard year-version match;
- a Codex runtime version whose App Server protocol and skill discovery have passed compatibility checks;
- the exact `solidworks-build-part-from-drawing` skill version/hash;
- the retained `$solidworks-build-mechanical-models` Skill prose reference, which is non-blocking and unverified rather than faked as resolved;
- an Agent/model configuration that supports image input.

Cloud model traffic is optional infrastructure, not product truth. Original customer drawings may leave the machine only when the configured Agent provider and enterprise privacy policy explicitly permit it.

---

## 3. Runtime Components and Process Boundaries

```text
┌─────────────────────────────────────────────────────────────┐
│ Electron Renderer                                           │
│ React pages · Router · View Models · Forms                  │
│ No Node integration · no arbitrary path access              │
└───────────────────────┬─────────────────────────────────────┘
                        │ typed contextBridge API
┌───────────────────────▼─────────────────────────────────────┐
│ Electron Main                                               │
│ Window lifecycle · app protocol · file dialogs · notifications│
│ No queue · no SQLite · no Agent/SolidWorks calls            │
└───────────────────────┬─────────────────────────────────────┘
                        │ Windows Named Pipe
┌───────────────────────▼─────────────────────────────────────┐
│ SWPanel Agent Runner                                        │
│ Application use cases · Domain · SQLite · filesystem ledger │
│ Queue · Run Orchestrator · Agent Adapter · Recovery         │
└──────────────┬──────────────────────────┬───────────────────┘
               │                          │
               │ Codex App Server         │ SQLite / NTFS
               ▼                          ▼
┌────────────────────────────┐   ┌────────────────────────────┐
│ Codex Runtime              │   │ Local Data Library         │
│ thread/turn/skill protocol │   │ DB, Drawing, Workspaces    │
└──────────────┬─────────────┘   └────────────────────────────┘
               │ explicit skill input
               ▼
┌────────────────────────────┐
│ Drawing Modeling Skill     │
│ + supported SolidWorks     │
└────────────────────────────┘
```

### 3.1 Electron Renderer

Renderer responsibilities:

- render the confirmed `.design` visual language;
- route between product pages;
- hold only transient UI state and form drafts;
- send typed business commands;
- render query snapshots and event updates.

Renderer loading and prohibitions:

- the production Renderer is served over the restricted standard+secure `app://swpanel` protocol, never over `file://` (a `file://` origin is opaque/null, so a CSP `'self'` would match any file on disk); every resource request is resolved to a canonical path inside the renderer output directory;
- `nodeIntegration`;
- arbitrary `ipcRenderer.send` channels;
- `fs`, `child_process`, shell or COM access;
- direct SQLite access;
- direct Secret retrieval;
- loading any external `http(s)` target, `file://` path or non-canonical `app://` authority (the development Vite renderer is the only non-packaged origin, and only via the dedicated CLI flag on an unpackaged launch);
- parsing raw Agent text into Run status.

Required BrowserWindow baseline:

```text
nodeIntegration: false
contextIsolation: true
sandbox: true
webSecurity: true
```

### 3.2 Electron Main

Electron Main is a narrow desktop adapter:

- creates windows;
- installs the typed Preload API;
- owns the restricted `app://swpanel` protocol (registered `standard` + `secure`, no `bypassCSP`, no `corsEnabled`) that serves the bundled Renderer and approved previews, with a canonical-authority and path-containment gate;
- presents native file/folder dialogs;
- sends non-blocking Windows/application notifications;
- starts or reconnects to Agent Runner;
- exposes an allowlisted “open file in SolidWorks” operation after path ownership checks.

It must not become an application service or DB owner.

### 3.3 Agent Runner

Agent Runner is a per-user singleton Node.js process. As of Phase 2 (Exit Gate PASS 2026-08-13) it owns and actually implements:

- Drawing workflow application use cases (`apps/runner/src/service/drawing-workflow-service.ts`);
- the SQLite WAL store with migrations and explicit transactions (`apps/runner/src/db/`; Runner is the only DB writer);
- the immutable NTFS drawing file ledger (`apps/runner/src/ledger/`);
- the Windows Named Pipe IPC server with the verified current-user+SYSTEM DACL (`apps/runner/src/ipc/`);
- domain transition enforcement through `@swpanel/domain`.

Phase 3 (Exit Gate PASS 2026-08-13) added the Run orchestrator: atomic claim + lease/heartbeat serial queue, Run Workspace allocation, structured Run event journal, cancellation coordination, recovery classification and the deterministic Fake Executor (`apps/runner/src/orchestration/`, `apps/runner/src/execution/`).

Phase 4 (Exit Gate PASS 2026-08-13) added the contract and adaptation layer: the versioned JSON Schema registry + dependency-free strict validators (`packages/contracts/src/phase4/`), the deterministic Input Adapter boundary (`apps/runner/src/adaptation/`), the controlled Prompt Template `2026.08-p4` + validated Invocation Package, the raw→product event translator with the deterministic Fake Agent Adapter (`apps/runner/src/agent/`), and the independent Result Manifest / Artifact validator (`apps/runner/src/artifacts/`). The formal protocol is documented in `docs/05-engineering/agent-spec.md`.

Phase 5 (in progress, Exit Gate NOT PASS, 2026-08-14) added the repository-side contract implementation P5-1..P5-4: the **nine-item preflight capability gate always active at PREPARING with report contract v2** (`packages/domain/src/runs/preflight.ts` `PREFLIGHT_CAPABILITIES` + `apps/runner/src/preflight/preflight.ts` probe boundary — the default product path runs the explicitly synthetic fixture whose report is `synthetic: true`, a thrown probe fails that capability closed; v1 reports from older attempts remain historical and are never rewritten); the **atomic `PENDING_REVIEW` Model publication** as the Runner product default (Model row + artifact metadata + `Completed` with Model id + FINISHED attempt in ONE transaction; the contracts parse the manifest `productionVerified` wire boolean — absent defaults to `false` — while the independent ArtifactValidator rejects any `productionVerified: true` claim as `ARTIFACT_MANIFEST_INVALID` (no product-side HIL verification record exists), so only `false`/default can publish and synthetic results persist `false`); the **Codex App Server client + adapter pinned to `codex-cli 0.147.0` / protocol v2** (`apps/runner/src/agent/codex/`, schema documents under `.scratch/codex-app-server-schema-0.147.0/v2/`) — the **shell-free live stdio child transport + lifecycle is implemented and final-verified** (`codex-child-transport.ts`: `app-server --stdio`, `shell: false`, `windowsHide`, bounded SIGTERM→SIGKILL close, bounded stderr tail, exactly-once exit propagation; a bare-name `.cmd` shim is refused by the stable `resolveCodexAppServerCommand`), a **live `initialize` + `skills/list` smoke against the real 0.147.0 runtime passes** — including the **skill directory → `SKILL.md` exact-path verification** — discovering both exact external skill copies (see below), and the **actual live Runner now wires the owned Codex App Server adapter and the real PDF adapter** (`apps/desktop/src/main/runner-host/live-codex-wiring.ts`, consumed only by the `liveCodex` branch of `main.ts`: EXACTLY ONE persistent Codex child transport per Runner + strict NDJSON client + async turn adapter + `RealPdfInputAdapter` over the bundled pypdfium2 rasterizer, `ownsAgent: true` so the executor closes the adapter and the child on shutdown, bounded, never orphaned); and the **ownership-safe SolidWorks cancellation boundary** (`apps/runner/src/execution/ownership/solidworks-ownership-guard.ts`, explicit per-attempt identity proof, `closeOnlyOwned`, never kill-all) plus the **protocol-pinned low-stage thread-session recovery** (`apps/runner/src/execution/recovery/`, resume provable only for `null`/PREPARING/ANALYZING/PLANNING, MODELING+ hard no-checkpoint) — both **contract-tested only, never HIL-verified**. The **async ownership-safe SolidWorks live probe** (`apps/runner/src/preflight/solidworks-live-probe.ts`) is implemented and final-verified: READ-ONLY attach to a pre-existing COM instance (never closed), owned spawn only after a clean no-instance attach (**attach errors never spawn**), COM ownership proven by exact pid, only the owned process closed — current host result `available: false` / `installedVersion` 33.0.0.5050 / owned process closed with no residual SLDWORKS.exe; the **probe SolidWorks version is placed in the rendered prompt** (`expectedSolidWorksVersion`, `apps/runner/src/adaptation/prompt-template.ts`) and **exact-validated at the ArtifactValidator** (`apps/runner/src/artifacts/artifact-validator.ts`). The default product path remains the deterministic synthetic Fake Preflight / Fake Agent (`codex-app-server` 0.1.0, protocol v1) with `synthetic: true` reports and Models `productionVerified: false`. **Phase 5 Exit Gate is NOT PASS — approved-drawing modeling was not started and no HIL is claimed; the repository-side implementation (live stdio transport, real preflight probe, real PDF adapter, live wiring, async SolidWorks live probe) is implemented and final-verified on the current tree (final `npm run check` / `check:fixtures` / `test:e2e` all passed 2026-08-14; per-workspace counts pinned).**

Phase 5, 2026-08-15 (in progress, Exit Gate NOT PASS): three approved-chain HIL attempts were executed on this host — **none completed**. Attempt 1 (`.scratch/hil-20260815-142334-52f26231`): the real Runner Run FAILED `AGENT_PROTOCOL_INCOMPATIBLE` after all nine preflight checks passed (`synthetic: false`), the real PDF adapter passed, and the SolidWorks probe returned `available: true` / version `33.0.0` / `owned-process-proven`; the root cause was native Codex 0.147.0 rejecting the experimental `thread/start.runtimeWorkspaceRoots` field while `experimentalApi: false` — fixed by removing the gated field, so the stable thread start is `cwd` + `sandbox: "workspace-write"` with attempt-root containment in `turn/start.sandboxPolicy`, and the live preflight now includes a harmless real `thread/start`. Attempt 2 (`.scratch/hil-20260815-144823-3836c9fc`): the real Runner Run FAILED `AGENT_RUNTIME_UNAVAILABLE` — all nine preflight checks and the real PDF adapter passed, a real `thread/start` + `turn/start` + failed turn occurred, the SolidWorks probe again `available: true` / `33.0.0` / `owned-process-proven`, no CAD/artifacts; the adapter discarded the native `turn.error.message`, so the exact Skill/image Turn error was lost. Failed-turn diagnostic preservation is now implemented: `turn.error.message` is sanitized deterministically (URLs, absolute paths incl. spaces, credentials/env secret keys, JWTs; controls/whitespace normalized; max 512 chars) into the technical `runtime/agent-session.json` note only; the product-visible `AGENT_RUNTIME_UNAVAILABLE` remains generic; the failed path writes no raw agent log; harness 1.0.2 may copy only the strict allowlisted status/adapter/protocol fields + the bounded sanitized note as `14-agent-session-diagnostic.json`, never full session/thread/turn/attempt IDs, timestamps or raw log; `skill.resolvedPath` is absolute-validated. Attempt 3 (`.scratch/hil-20260815-214252-393c22d8`) stopped before `Runner.open` / Run creation — the Codex 0.147.0 probe and the exact Skill path/digest passed but the SolidWorks probe failed closed (a harness/preflight stop, not a Run terminal failure). The SolidWorks COM probe was redesigned: PowerShell `GetActiveObject` was a false-negative source (`TYPE_E_ELEMENTNOTFOUND`) on hosts where Python/pywin32 works, so COM attach/poll is now bounded Python/pywin32 `GetActiveObject` only, with PowerShell used for registry/file-version discovery only; an existing instance is read-only; owned spawn uses the exact Node child handle/PID and exact `GetProcessID()` equality, with no Dispatch/CreateObject, no kill-all, no ExitApp/Quit. Host state was dynamic: the first two probes succeeded; at 21:42 the owned SolidWorks launch exited before COM registration, and the exact-handle diagnostics (`21-solidworks-startup-diagnostic.json`) show default, `/ForceSoftwareOGL /SWDisableExitApp`, and `/SWSafeMode /SWDisableExitApp` all exiting in ~3–4 s with unsigned 3221225477 (`0xC0000005`) — the current crash is NOT conclusively attributed to AMD/`atio6axx` (AMD Radeon driver `31.0.12042.4` is recorded only as host context / historical hypothesis; both Rx session-safe modes failing means hardware OpenGL and ordinary Tools/Options state were not isolated as sole causes); SolidWorks is installed and COM-registered but currently not drivable. The product probe early-exit defect was then fixed: the probe concurrently observes the exact owned-process early exit, aborts/awaits the helper child, and returns promptly with the stable reason `owned-process-exited`, a safe `ownedProcessExitCode`, `installedVersion` and truthful owned spawned/closed facts (narrow real probe evidence: `22-solidworks-probe-after-early-exit-fix.json` — `available: false`, `installedVersion` 33.0.0.5050, owned spawned/closed true, exit code 3221225477, reason `owned-process-exited`, duration 7044 ms; no Codex/PDF/Run/HIL; no residual SLDWORKS/codex process). Fresh verification on the current working tree passed (2026-08-15): `npm run check` exit 0 — typecheck, repository lint, all tests and full build — root 10 files / 291 tests, `@swpanel/desktop` 31 files / 572 tests, `@swpanel/runner` 38 files / 738 tests, `@swpanel/contracts` 13 files / 148 tests, `@swpanel/domain` 14 files / 70 tests, `@swpanel/ui` 6 files / 43 tests; `npm run check:fixtures` 1/1 — 13/13 canonical scenarios OK, 0 violations, RESULT PASS; `npm run test:e2e` passed sequentially — production Electron 20/20 plus browser + Electron smoke 51/51. The canonical package/installer was not refreshed. **Phase 5 Exit Gate remains NOT PASS (2026-08-15)**: no successful `.SLDPRT` + six artifacts + Model (`PENDING_REVIEW`), no real Clarification scenario, no ownership-safe cancellation HIL; `productionVerified` stays `false`; no Phase 6; nothing committed/pushed — the current working tree remains unreproducible by Git revision.

Phase 5, 2026-08-16（当前更新，Exit Gate 仍为 NOT PASS）：真实 Agent 终态已改为严格的 `completed | clarification_required` 二选一合同。产品侧 canonical schema 保持互斥 `oneOf` 与最终严格验证；发送给 Codex 0.147.0 的 provider wire schema 为完全展开、closed-object、required+nullable-sentinel 形状，再严格投影回 canonical contract。最小 native probe `.scratch/codex-output-schema-probe-20260816054054327-c8cfe1c6.json` 证明 provider 接受该 schema 并返回一个可投影的 `clarification_required`，但它没有业务图纸/工程 blocker，**不算真实工程 Clarification HIL**。终态 JSON 提取现使用 string-aware balanced-object 扫描并要求全 turn 恰一个有效文档；失败仅持久化固定、无内容类别（无 item、无 balanced JSON、无 parseable JSON、无有效 wire 文档、多有效文档），不保存 Agent 文本。Codex turn wait 的 client/adapter 共享固定 **15 分钟**上限；真实 TIMEOUT 只记录 `no-agent-message-items | agent-message-items-observed` 二值类别，非 timeout wait failure 仍为通用类别；公开错误面保持 `AgentTurnError`。

2026-08-16 真实证据均如实失败：`.scratch/hil-20260816-125909-c6eccb74` 记录原 canonical `oneOf` 被 provider 拒绝的真实技术失败；provider bridge 后的获批图纸尝试 `.scratch/hil-20260816-134520-94a62f06` 与 `.scratch/hil-20260816-135250-21c892a7` 均未产生合法终态、ownership registry、`.SLDPRT`、Manifest、Clarification 或 Model；后者只证明 Agent 曾在 attempt workspace 做图像分析。`.scratch/hil-20260816-140950-b6482492` 在旧 600 秒 turn 上限处如实 `FAILED / AGENT_TIMEOUT`，探针、Runner、真实 PDF adaptation 均通过，但仍无 CAD ownership/Artifacts/Model/Clarification；这促成上述固定 15 分钟预算与内容无关 timeout 分类。重建后的下一次重试 `.scratch/hil-20260816-143105-4e1a0596` 在 `Runner.open` 前被 SolidWorks probe fail-closed：owned process 在约 8 秒内以 `3221225477`（`0xC0000005`）退出，`available:false`、`ownedProcessClosed:true`、隔离 temp root 已删除。按停止条件未修改驱动、注册表、安装或其他系统配置，也未在无法证明 ownership 时执行 cancel HIL。

2026-08-16 当前树最终验证全部通过：`npm run check` exit 0（root 10/291、desktop 31/576、runner 42/855、contracts 14/162、domain 14/70、ui 6/43，共 117 files / 1,997 tests；typecheck、lint、完整 build 全绿）；`npm run check:fixtures` 1/1、13/13 scenarios、0 violations；`npm run test:e2e` 顺序通过 production Electron 20/20 与 browser + Electron smoke 51/51。最后一轮 timeout-hardening 审查补充验证了：同步 request write 失败后的迟到响应不会误伤共享连接；一次 turn-wait timeout 后客户端仍可等待后续 turn；foreign-turn item 不参与当前 turn 的 timeout 分类；已观察当前 turn item 时发生 child exit 等非 timeout failure 仍只写通用、无内容 note。**这些仓库证据不等于 Phase 5 PASS**：仍缺真实成功 `.SLDPRT` + 六 Artifact + 原子 `Model(PENDING_REVIEW)`、真实工程 Clarification、ownership-safe Cancel HIL；`productionVerified` 保持 `false`，Phase 6 未开始，未 commit/push。Electron 窗口关闭后 Runner 独立继续执行仍受当前 Electron Main 托管架构限制，未作为 HIL 成功声明。

Still owned by later phases or external reality (not implemented / not verified):

- **HIL verification of the live Codex App Server process and production transport** — the contract surface exists (`0.147.0` / protocol v2 pinned), the shell-free live stdio transport + lifecycle is implemented and final-verified, a live `initialize` + `skills/list` smoke passes (including the skill directory → `SKILL.md` exact-path verification) discovering both exact external skill copies, and the live Runner wires the owned Codex adapter + real PDF adapter; but the full live modeling turn chain is **never HIL-verified** and nothing here is product verification;
- real PDF/DWG/DXF production conversion — the real PDF adapter + pypdfium2 4.30.0 rasterizer is implemented and final-verified and one approved PDF was truthfully rasterized at 300 DPI (4963×3509, source hash `e321dc34…` / output hash `30614c32…`, `productionVerified: false`, output kept in temp / outside git); DWG/DXF remain synthetic fakes (`-test-only`, all `productionVerified: false`), and no approved-drawing real E2E/HIL has completed (three approved-chain attempts were made on 2026-08-15; none completed);
- Secret references and provider setup.

**Phase 7 (2026-08-18) implemented the deterministic Cost Calculator (see §15)** — pure-function `calculateCostEstimate` in `packages/domain/src/cost/calculator.ts`, synthetic (never real-enterprise) cost-data defaults, `SCHEMA_VERSION = 7` migration, immutable cost-report snapshots and the `window.swpanel.cost` bridge; known accuracy limitation is that the Product UI still feeds `finishedVolume` from the canonical fixture constant rather than persisted Model geometry (does not affect determinism; left as a Phase 8 accuracy item).

The Runner is launched independently of a particular renderer window. Closing the window or fully exiting Electron does not request Run cancellation.

### 3.4 Why not a Windows Service

SolidWorks automation belongs to the logged-in interactive desktop session. A Session 0 Windows Service is not the MVP execution boundary because it conflicts with visible SolidWorks, modal-dialog handling and user inspection. The Runner is a per-user process and may later be registered to start at user sign-in.

---

## 4. Frontend Architecture and Design Fidelity

### 4.1 Visual Source

The confirmed visual source is `./.design`, per the owner decision recorded on 2026-08-10 and `design-source.md`.

The prototype contains 14 product pages plus one internal component specification page. Production routes must parameterize Drawing, Revision, Run, Model and Cost Report IDs rather than copy the hard-coded HTML stories.

### 4.2 Route Shape

```text
/
├── /drawings
│   └── /drawings/:drawingId/revisions/:revisionId
│       ├── /overview
│       ├── /runs
│       ├── /models
│       │   └── /models/:modelId
│       ├── /costs
│       │   ├── /new
│       │   └── /:reportId
│       └── /memory
├── /runs
│   └── /runs/:runId
├── /cost-data
└── /settings
```

`component-spec` is a development-only route or Storybook-style fixture and is not a product top-level entry.

### 4.3 Frontend Modules

```text
apps/desktop/
├── renderer/
│   ├── app/
│   ├── routes/
│   ├── features/
│   ├── components/
│   ├── fixtures/
│   └── styles/
├── main/
└── preload/

packages/
├── contracts/
├── domain/
└── ui/
```

High-value shared components:

- `AppShell`, `AppSidebar`, `AppTopbar`, `PageHeader`;
- `DrawingWorkspaceLayout`, `RevisionNav`, route-aware tabs;
- `StatusBadge`, `Button`, `IconButton`, `Card`, `DataTable`;
- `RunSummaryCard`, `RunStageIndicator`, `RunTimeline`;
- `ModelCard`, `ModelPreview`, `ValidationList`, `ArtifactList`;
- `ClarificationForm`, `RevisionFactsList`, `ModelingFeedbackList`;
- `CostParameterForm`, `CostReportDocument`;
- `ConfirmDialog`, `SideDrawer`, `Toast`, `EmptyState`.

### 4.4 Styling Rules

- Copy token values before changing structure: 240 px Sidebar, 56 px Topbar, 4 px base spacing, 32 px page padding and the current semantic colors.
- Keep CSS close to the exported design; do not replace it with a generic SaaS theme or a broad Tailwind rewrite.
- Bundle Inter and JetBrains Mono locally; add an approved Chinese fallback such as Microsoft YaHei UI. Production must not load Google Fonts.
- Use one icon source with the prototype’s effective 16 px / thin-stroke appearance; do not blindly substitute the unused 24 px SVG inventory.
- First visual acceptance targets desktop widths and 100%, 125%, 150% Windows DPI. The prototype has no mobile contract.

### 4.5 Fixture Rules

The current prototype mixes mutually exclusive stories. Frontend fixtures must be scenario-based. The Phase 1 Mock Repository exposes the following canonical scenario selectors (`MOCK_SCENARIOS` in `apps/desktop/src/renderer/fixtures/scenarios.ts`):

```text
run-running
run-queued
run-completed
run-cancelled
clarification-open
clarification-answered
model-pending-review
model-approved
model-rejected
no-current-approved-model
cost-report-generated
run-failed
empty-drawing-library
```

Each selector builds one coherent deterministic world; the featured Run R05 variants (`run-running` / `run-queued` / `run-completed` / `run-cancelled` / `run-failed`) share the model-outcome semantics with the named scenarios, and the fixture builder enforces the single-RUNNING invariant (at most one Run RUNNING per world).

Do not use the prototype cost values as Cost Calculator golden data; they are explicitly visual-only and are not arithmetically self-consistent. Phase 1 cost reports are deterministic synthetic records generated by the Mock Repository (`computeSyntheticCostResult`), not the prototype arithmetic.

---

## 5. Application and Domain Layers

### 5.1 Module Boundaries

```text
packages/domain/
├── drawings
├── revisions
├── memory
├── runs
├── clarifications
├── models
├── reviews
├── cost
└── artifacts

apps/runner/src/                  (Phase 2 implemented)
├── db/            SQLite WAL store, migrations, repository
├── ledger/        immutable drawing file ledger
├── service/       drawing workflow application use cases
├── ipc/           Windows Named Pipe server, framing, DACL, idempotency
├── boundary.ts / errors.ts / ids.ts / runner.ts / index.ts

apps/runner/src/                  (target layout for later phases)
├── application/
├── orchestration/
├── agent/
├── input-adapters/
├── security/
└── (persistence/storage folded into db/ + ledger/ above)
```

Domain contains no Electron, Codex, SQLite or filesystem imports.

### 5.2 Core Invariants

- Drawing is the root object; Drawing Revision is the exact work version.
- Run creation freezes Drawing Revision, stable input reference, Revision Facts, Modeling Feedback, Prompt Template version, Skill identity/hash and Agent/model configuration.
- Run Status and Stage are separate.
- `CLARIFICATION_REQUIRED` is terminal; answers update Revision Facts and a new Run starts from the beginning.
- Model transitions only from `PENDING_REVIEW` to `APPROVED` or `REJECTED`.
- `REJECTED` is irreversible.
- New Approved Model changes `current_approved_model_id`; older Approved Models remain historical facts.
- Only the current Drawing Revision’s current Approved Model can create a new Cost Estimate Report.
- Agent does not decide final cost numbers.

### 5.3 Domain Type Set

```text
Drawing
DrawingRevision
RevisionFact
ModelingFeedback
ModelingRun
RunInputSnapshot
RunEvent
ClarificationRequest
ClarificationQuestion
ClarificationAnswer
Model
ModelReview
Artifact
CostDataDefinition
CostDataValue
CostEstimateReport
CostEstimateSnapshot
```

The historical code term `QuoteReport` should be migrated toward `CostEstimateReport` at user-facing and new contract boundaries while preserving compatibility in migrations if needed.

---

## 6. Persistence

### 6.1 SQLite Ownership

SQLite is the local structured store. Only Agent Runner opens the write connection. Electron Main and Renderer query through Runner IPC.

Baseline:

- WAL journal mode;
- foreign keys enabled;
- migration version table;
- explicit transactions for state transitions;
- `busy_timeout`;
- periodic backup through a controlled maintenance use case;
- active DB must reside on a local fixed disk, not SMB/NAS synchronization storage.

Implementation status (Phase 2, 2026-08-13): `apps/runner/src/db/database.ts` opens the single write connection with Node 24's built-in `node:sqlite` — `PRAGMA journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout` (default 5000 ms), `foreign_keys = ON`, a `schema_migrations` version table driven by `apps/runner/src/db/schema.ts`, and an explicit transaction wrapper (raw BEGIN/COMMIT is never exposed). The Runner repository adapter (`apps/runner/src/db/repository.ts`) is the only DB writer; Main and Renderer reach it exclusively through Runner IPC. Periodic backup is a later maintenance use case.

### 6.2 Logical Tables

```text
schema_migrations
settings

drawings
drawing_revisions
revision_files
revision_facts
modeling_feedback

runs
run_input_snapshots
run_attempts
run_events
clarification_requests
clarification_questions
clarification_answers

models
model_reviews
artifacts

cost_data_definitions
cost_data_values
cost_reports
```

`run_events` uses a monotonically increasing sequence per Run. The UI reconnect sequence is:

1. read current snapshot;
2. subscribe after the last known event sequence;
3. apply only valid, ordered events.

### 6.3 Publication Transactions

A Model is published only in one transaction after:

```text
Completion payload valid
+ Required Artifact manifest valid
+ Required files exist and are nonempty
+ All paths are inside assigned output root
+ Hashes recorded
+ Validation gate passes
```

The transaction creates the Model as `PENDING_REVIEW`, associates immutable Artifact records and moves the Run to `COMPLETED`.

---

## 7. Local File Storage and Run Workspace

### 7.1 Default Data Root

```text
%LOCALAPPDATA%\JANGHI\SWPanel\
├── state\swpanel.db
├── logs\
├── cache\
└── library\drawings\
```

The active data root containing `state\swpanel.db` is restricted to a writable local fixed NTFS volume and cannot be overridden to SMB, NAS, removable or synchronized storage. Approved network locations may be configured only as separate export or backup targets and never contain the active SQLite database. The data root must also remain outside the application installation directory and public Git workspace.

### 7.2 Drawing and Revision Layout

```text
library/drawings/{drawingId}/
└── revisions/{revisionId}/
    ├── source/
    │   └── original.{ext}
    └── runs/{runId}/
        └── attempt-001/
            ├── input/
            ├── memory/
            ├── working/
            ├── output/
            ├── logs/
            └── runtime/
```

Rules:

- preserve the original Drawing file byte-for-byte;
- use generated IDs for directories, not raw Drawing numbers;
- preserve original display filename in metadata;
- never overwrite an older Revision or Run output;
- save `.SLDPRT` directly to the final isolated Run output directory because SolidWorks may keep it locked;
- record size, SHA-256, MIME/declared type and relative path for every published Artifact;
- reject symlink/junction escapes and paths outside the canonical Workspace root.

Implementation status (Phase 2, 2026-08-13): the drawing-file ledger (`apps/runner/src/ledger/drawing-file-ledger.ts`) implements these rules for Drawing/Revision source files — copy-then-verify SHA-256 and size, generated-ID directories, relative paths in the DB, an allowlist of PDF/DWG/DXF with magic/media-type checks, canonical path containment with rejection of absolute-path/junction/symlink escapes, Unicode path support, structured errors for missing/hash-mismatch/size-mismatch files (never silent), and conservative allowlist deletion (explicit call, current-revision pointer protection, transactional metadata updates, only files the ledger recorded; an already-missing file is treated as "already gone").

### 7.3 Cancellation Deletion

Cancel cleanup is allowlist-based. The Runner may delete only files recorded as created by the target Run and canonicalized under that Run Workspace. It never constructs a recursive delete path from user-provided text.

If a file is locked:

1. keep Run `CANCELLED` as the business fact;
2. mark cleanup pending in internal runtime metadata;
3. retry safe deletion;
4. never delete files outside the Workspace to “fix” cleanup.

---

## 8. Input Adapter

### 8.1 Product Inputs and Skill Inputs

Product target formats remain PDF, DWG and DXF. The modeling Skill accepts a dimensioned JPG or PNG single-part mechanical drawing.

The adapter boundary is:

```text
Original PDF / DWG / DXF
      │ immutable
      ▼
Versioned Input Adapter
      │
      ├── selected page/view and conversion metadata
      ├── deterministic image output
      ├── original-to-derived traceability
      └── conversion validation
      ▼
High-quality JPG / PNG Skill Input
```

The adapter must not alter the Skill.

### 8.2 Phase 4 Contract Requirements

Each conversion produces:

- adapter ID/version;
- source Artifact hash;
- page/layout selection;
- output image path/hash/dimensions/DPI;
- warnings and unsupported entities;
- a human-reviewable preview;
- explicit failure when the output cannot preserve authoritative information.

PDF conversion must not silently choose an arbitrary page. DWG/DXF conversion strategy remains a Phase 4 engineering spike and must be verified with allowed drawings before production acceptance.

Implementation status (Phase 4, Exit Gate PASS 2026-08-13): the boundary is implemented as a deterministic injectable Input Adapter (`apps/runner/src/adaptation/input-adapter.ts` + the pure model in `packages/domain/src/input/`) with the fake scenario matrix `png-jpg-passthrough` / `single-page-pdf` / `multi-page-pdf-selected-page` / `multi-page-pdf-no-page-selected` / `dwg-dxf-synthetic-test-only` / `unsupported-source` / `missing-corrupt-source` / `adapter-failure`. Truthfulness contracts:

- **multi-page PDF without an explicit page selection fails closed with `PAGE_SELECTION_REQUIRED`** — an adapter never silently picks a page; the default single-page path records NO page/layout assertion unless the request explicitly supplied one (the fake never inspects the source, so it only echoes explicit selections);
- **every synthetic conversion is `productionVerified: false`** with a human-readable warning — no conversion path is verified against approved production drawings; the DWG/DXF path uses the explicit `swpanel-fake-dwg-dxf-adapter-test-only` identity and a synthetic result claiming `productionVerified: true` is an invariant violation (fails closed);
- derived image + preview + strictly validated `adapter-result.json` are written into the attempt `input/` workspace via the workspace ledger; the original drawing is never modified.

Real PDF/DWG/DXF production conversion is NOT verified and NOT claimed (Phase 5+/external with approved drawings).

---

## 9. Agent Runner and Agent Contract

### 9.1 Runtime Choice

The primary adapter targets the Codex App Server protocol because the installed runtime exposes:

- versioned JSON schemas and TypeScript bindings;
- `skills/list` and `skills/extraRoots/set`;
- explicit `skill` and `localImage` turn inputs;
- `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`;
- structured notifications for turns, items, processes and errors;
- per-turn output JSON Schema;
- workspace-write sandbox policy with explicit writable roots.

This is a runtime capability, not the Modeling Skill’s own API. SWPanel owns the translation to product events.

`codex exec --json` is useful for contract tests and a degraded one-shot adapter, but it is not the preferred durable background integration.

### 9.2 Preflight Capability Gate

A Run cannot leave `PREPARING` unless all required capabilities are true. The gate is **version-agnostic for SolidWorks** (a hard version match is NOT a gate item — availability/automation only, and the actual installed version is recorded by the probe/builder) and the `$solidworks-build-mechanical-models` reference is **retained as non-blocking Skill prose** (deliberately NOT a gate item; it is never faked as resolved). The preflight report is contract **v2 with nine items**:

```text
agent_runtime_available
agent_runtime_version_supported
agent_model_supports_image
modeling_skill_discovered
modeling_skill_hash_allowed
structured_runtime_protocol_available
workspace_write_scope_supported
solidworks_available
input_adapter_succeeded
```

Implementation status (Phase 5, in progress, 2026-08-14): the nine-item gate above is implemented and **always active at PREPARING** — `PREFLIGHT_CAPABILITIES` (canonical order, report contract version 2) in `packages/domain/src/runs/preflight.ts`, the deterministic injectable probe boundary + fail-fast gate evaluation + failure-code mapping in `apps/runner/src/preflight/preflight.ts`. Because the real environment is externally blocked, the default product path runs the **explicitly synthetic/unverified probe fixture** (`DEFAULT_PREFLIGHT_SCENARIO = "all-pass"`, `FAKE_PREFLIGHT_SKILL_SHA256`): every persisted report is marked **`synthetic: true`** and never pretends the real probes pass; a probe that throws fails that capability closed (redacted) instead of crashing the serial queue; `input_adapter_succeeded` is the only item the probes do not evaluate — the executor marks it after input adaptation succeeds (fail-closed). The **real preflight probe** (`apps/runner/src/preflight/real-preflight-probe.ts` + `skill-directory-hash.ts`) is implemented and **final-verified** — real bounded `codex --version` probe (exact pin `0.147.0`), real skill-directory discovery + canonical directory SHA-256 hash at the exact configured path, real workspace writability probe, injected SolidWorks seam, `synthetic: false` — with the Electron Main host awaiting the async live probes (`codex-live-probe.ts` / `solidworks-live-probe.ts`) and injecting fixed seams (never an inline live COM call inside the probe). It is injected at Runner construction / test-harness configuration only; the product default keeps the synthetic all-pass fixture.

Current environment facts (2026-08-14; Phase 5 Exit Gate NOT PASS):

- Codex noninteractive JSONL, output schema, thread resume, cancellation primitive and skill discovery were demonstrated;
- a **live `initialize` + `skills/list` smoke against the real Codex 0.147.0 runtime succeeded and discovered both exact external skill copies** — `C:\Users\Eric Chan\.agents\skills\solidworks-build-part-from-drawing` and `C:\Users\Eric Chan\.codex\skills\solidworks-build-part-from-drawing`, both synchronized at the canonical directory digest `3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22` (computed by the repository's canonical `hashSkillDirectory`; the two copies are byte-identical);
- the shell-free live stdio transport/lifecycle is implemented and final-verified (see §3.3), the live `initialize` + `skills/list` smoke passes with the skill directory → `SKILL.md` exact-path verification, and the live Runner wires the owned Codex adapter + the real PDF adapter — the full live modeling turn chain is **never HIL-verified**;
- SolidWorks **2025 product version 33.0.0.5050** is installed, but the availability gate **currently FAILS**: both COM activation and direct launch crash in the AMD driver `atio6axx.dll` version `31.0.12042.4` with access violation `0xc0000005` (dump evidence under the local CXPD directory, e.g. `C:\Users\Eric Chan\AppData\Local\SolidWorks\CXPD\20260814222204_33.0.0.5050\SLDWORKS.exe.*.dmp`);
- the Skill's referenced `$solidworks-build-mechanical-models` dependency is retained as Skill prose and is **non-blocking / unverified** — it is deliberately not a gate item and is never faked as resolved;
- Codex App Server compatibility is pinned (`0.147.0` / protocol v2) and the live stdio transport is implemented; the approved-drawing HIL was **not started**.

Current environment facts (2026-08-15 update; the 2026-08-14 facts above remain historical; Phase 5 Exit Gate NOT PASS):

- **three approved-chain HIL attempts ran on 2026-08-15 — none completed**: (1) the real Runner Run FAILED `AGENT_PROTOCOL_INCOMPATIBLE` (all nine preflight checks passed, `synthetic: false`, real PDF adapter passed, SolidWorks probe `available: true` / version `33.0.0` / `owned-process-proven`) — native Codex 0.147.0 rejected the experimental `thread/start.runtimeWorkspaceRoots` while `experimentalApi: false`; the gated field was removed, the stable thread start is `cwd` + `sandbox: "workspace-write"` with `turn/start.sandboxPolicy` attempt-root containment, and the live preflight now includes a harmless real `thread/start`; (2) the real Runner Run FAILED `AGENT_RUNTIME_UNAVAILABLE` (all nine preflight checks and the real PDF adapter passed; a real `thread/start` + `turn/start` + failed turn occurred; SolidWorks probe again `available: true` / `33.0.0` / `owned-process-proven`; no CAD/artifacts) — the adapter discarded the native `turn.error.message`, now preserved via the failed-turn diagnostic preservation (deterministic sanitization — URLs, absolute paths incl. spaces, credentials/env secret keys, JWTs; controls/whitespace normalized; max 512 chars — into the technical `runtime/agent-session.json` note only; product-visible `AGENT_RUNTIME_UNAVAILABLE` stays generic; no raw agent log on the failed path; harness 1.0.2 copies only the allowlisted status/adapter/protocol + bounded note as `14-agent-session-diagnostic.json`; `skill.resolvedPath` absolute-validated); (3) the third attempt stopped before `Runner.open` / Run creation (Codex 0.147.0 probe and exact Skill path/digest passed; SolidWorks probe failed closed) — a harness/preflight stop, not a Run terminal failure;
- **host state was dynamic**: the first two SolidWorks probes succeeded (`available: true`, `33.0.0`, `owned-process-proven`); at 21:42 the owned launch exited before COM registration — `21-solidworks-startup-diagnostic.json` shows default, `/ForceSoftwareOGL /SWDisableExitApp` and `/SWSafeMode /SWDisableExitApp` all exiting in ~3–4 s with unsigned 3221225477 (`0xC0000005`). The current crash is NOT conclusively attributed to AMD/`atio6axx` (AMD Radeon driver `31.0.12042.4` is host context / historical hypothesis); SolidWorks is installed and COM-registered but currently not drivable;
- **SolidWorks COM probe (2026-08-15)**: COM attach/poll is bounded Python/pywin32 `GetActiveObject` only (PowerShell `GetActiveObject` was a false-negative source, `TYPE_E_ELEMENTNOTFOUND`; PowerShell is registry/file-version discovery only); an existing instance is read-only; owned spawn uses the exact Node child handle/PID and exact `GetProcessID()` equality (no Dispatch/CreateObject, no kill-all, no ExitApp/Quit);
- **probe early-exit defect fixed (2026-08-15)**: stable `owned-process-exited` reason; narrow real probe evidence `22-solidworks-probe-after-early-exit-fix.json` — `available: false`, `installedVersion` 33.0.0.5050, exit code 3221225477, duration 7044 ms, no residual processes;
- **fresh verification on the current working tree (2026-08-15)**: `npm run check` exit 0 — typecheck, repository lint, all tests and full build — root 10 files / 291 tests, `@swpanel/desktop` 31 files / 572 tests, `@swpanel/runner` 38 files / 738 tests, `@swpanel/contracts` 13 files / 148 tests, `@swpanel/domain` 14 files / 70 tests, `@swpanel/ui` 6 files / 43 tests; `npm run check:fixtures` 1/1 — 13/13 canonical scenarios OK, 0 violations, RESULT PASS; `npm run test:e2e` passed sequentially — production Electron 20/20, browser + Electron smoke 51/51. The canonical package/installer was not refreshed.

Therefore real Modeling integration remains gated: the always-active gate passes only through the synthetic fixture, and no approved-drawing real E2E/HIL has completed (three approved-chain attempts were made on 2026-08-15; none completed — two real Runner turns failed truthfully, `AGENT_PROTOCOL_INCOMPATIBLE` then `AGENT_RUNTIME_UNAVAILABLE`, and a third attempt stopped before `Runner.open`).

### 9.3 Invocation Package

```json
{
  "contractVersion": 1,
  "runId": "...",
  "skill": {
    "name": "solidworks-autobuild",
    "sha256": "..."
  },
  "input": {
    "originalArtifactId": "...",
    "imagePath": "...",
    "imageSha256": "..."
  },
  "memory": {
    "revisionFacts": [],
    "modelingFeedback": []
  },
  "workspace": {
    "root": "...",
    "output": "..."
  },
  "execution": {
    "visibility": "background",
    "recordMp4": false
  }
}
```

MVP defaults to background execution. Visible-live execution is a runtime option for approved diagnostic or review workflows. MP4 is optional and becomes required only when `recordMp4=true`.

### 9.4 Structured Product Events

```text
StageChanged
ActivityUpdated
ProgressUpdated
ClarificationRequired
AgentTurnCompleted
RuntimeMetadataUpdated
ResultManifestReceived
ArtifactValidationFailed
Completed
Failed
CancellationRequested
CancellationConfirmed
```

Every event includes:

```text
contractVersion
runId
attemptId
sequence
occurredAt
runtimeThreadId (when available)
```

The UI never reads raw reasoning or hidden chain-of-thought. Raw runtime events and logs are diagnostic inputs to the Adapter, not direct product events.

### 9.5 Formal Result Manifest

The Skill itself does not define a native JSON manifest. SWPanel therefore requires the Agent turn’s final response to satisfy a versioned output JSON Schema and then independently verifies files.

Required successful result fields:

```text
result = completed
solidWorksVersion = <exact detected version>
units
projectionDecision
featureCount
bodyCount
rebuildStatus
unresolvedAssumptions
artifacts:
  sldprt
  preview
  dimensionLedger
  featurePlan
  buildValidationLog
  builderSource
  processMp4?  # only when requested
```

Although earlier Workflow text treated Builder Source as optional, the actual selected Skill explicitly delivers Builder Source. Architecture therefore treats it as required for this adapter. If a future Skill version changes that contract, an explicit compatibility decision is required.

### 9.6 Skill Phase Mapping

| SWPanel Stage | Skill obligation |
|---|---|
| PREPARING | Validate image input, dependencies, isolated Workspace and runtime contract |
| ANALYZING | Interpret original-resolution drawing and create Dimension Ledger; do not open SolidWorks |
| PLANNING | Resolve all blockers and freeze Feature Plan, origin, datums, expected feature/body counts |
| MODELING | Select background/visible mode and perform one deterministic native-feature build |
| VALIDATING | Forced rebuild, native feature/body/geometry checks and inspected preview |
| PACKAGING | Produce all required Artifacts and schema-constrained result |

Blocking clarification must be emitted before SolidWorks is launched.

Implementation status (Phase 4, Exit Gate PASS 2026-08-13, formal protocol in `docs/05-engineering/agent-spec.md`): the §9.3 Invocation Package shape is implemented (`apps/runner/src/adaptation/invocation-package.ts` builds it from the frozen Runner snapshot + adapter provenance + workspace and strictly validates — the Agent never sees a client-supplied snapshot); the §9.2 capability gate items are enforced in later phases except `input_adapter_succeeded`, which Phase 4 integrates into PREPARING (adapter failure terminates with `INPUT_UNSUPPORTED` / `INPUT_ADAPTER_FAILED`); the §9.4 event family is implemented through the versioned raw record protocol + the product-event translator (`apps/runner/src/agent/`): technical raw records (`session_started` / `runtime_log` / `runtime_error`) never produce product events, the translator is the only raw→product bridge, and `Completed` / `Failed` are never derived from raw records — the orchestrator owns terminal events; unsupported versions/unknown types/malformed/out-of-order streams map to the stable `AGENT_PROTOCOL_INCOMPATIBLE` failure without exposing raw reasoning to the Renderer. The §9.5 formal Result Manifest is implemented with an independent validator (`apps/runner/src/artifacts/artifact-validator.ts`): schema/version, safe workspace-relative manifest path, required artifacts exist non-zero-byte with matching size + SHA-256 inside the attempt workspace, and the declared minimum `rebuildStatus: "PASSED"`; the orchestrator completes the attempt only after this independent validation passes (Agent claims are never authoritative), otherwise it appends `ArtifactValidationFailed` and terminates with `ARTIFACT_MANIFEST_INVALID` / `ARTIFACT_MISSING` / `ARTIFACT_OUTSIDE_WORKSPACE` / `VALIDATION_REJECTED`. The controlled Prompt Template `2026.08-p4` (`apps/runner/src/adaptation/prompt-template.ts`) is a fixed versioned product constant with no user edit surface. Phase 5 repository-side additions (in progress, 2026-08-14): the §9.2 nine-item gate (report contract v2) is always active at PREPARING with the deterministic synthetic probe default (`synthetic: true`, see §9.2); the success path atomically publishes a `PENDING_REVIEW` Model by default (P5-2 — the contracts parse the manifest `productionVerified` wire boolean, absent defaults to `false`; the independent ArtifactValidator rejects `productionVerified: true` as `ARTIFACT_MANIFEST_INVALID` since no product-side HIL verification record exists, so only `false`/default can publish and synthetic results persist `false`); the §9.1 Codex App Server runtime choice is pinned as a strict NDJSON JSON-RPC client + adapter for `codex-cli 0.147.0` / protocol v2 (`apps/runner/src/agent/codex/`) — the shell-free live stdio child transport + lifecycle is implemented and final-verified, a live `initialize` + `skills/list` smoke passes (including the skill directory → `SKILL.md` exact-path verification) discovering both exact external skill copies, the live Runner wires the owned Codex adapter + the real PDF adapter, and the async ownership-safe SolidWorks live probe is implemented and final-verified, but the full live modeling turn chain is **never HIL-verified**; §11.4 cancellation gained the ownership-safe SolidWorks boundary and §11.3 low-stage recovery gained the protocol-pinned thread-session helper (P5-4) — both **contract-tested only, never HIL-verified**. The formal protocol is documented in `docs/05-engineering/agent-spec.md`. **Phase 5 Exit Gate is NOT PASS; three approved-chain attempts ran on 2026-08-15 but none completed, so no successful live HIL is claimed.**

---

## 10. SolidWorks Adapter Boundary

The only valid chain is:

```text
Agent Runner
→ Codex Runtime Adapter
→ solidworks-build-part-from-drawing
→ resolved mechanical execution dependency (non-blocking Skill prose)
→ detected supported SolidWorks (availability-only gate; actual version recorded)
```

Prohibited alternatives:

- Renderer or Electron Main calls COM;
- Runner reimplements drawing interpretation or feature construction;
- SWPanel substitutes `solidworks-automation-skill-main` as the product capability;
- a nonempty `.SLDPRT` alone is accepted as success;
- a model's actual SolidWorks version is omitted, fabricated, or silently relabeled as another version.

Version-gate semantics (2026-08-14): the preflight capability gate does NOT hard-require a SolidWorks year version — it requires **any drivable supported SolidWorks installation** (`solidworks_available`) and the **actual detected version is recorded** by the probe/builder (never invented). The `$solidworks-build-mechanical-models` reference stays retained Skill prose: it is deliberately **not a blocking SWPanel gate item** and is never faked as resolved (non-blocking / unverified). The Skill contract requires an editable, native feature-based part built with the detected supported SolidWorks version, and the deliverable is never silently relabeled as another version.

The Skill contract requires an editable, native feature-based part, not an imported or featureless body.

---

## 11. Run Orchestrator, Lifecycle and Recovery

### 11.1 Queue

- multiple Runs may be `QUEUED`;
- one per-user Runner instance owns the DB write connection;
- a conditional SQLite update atomically claims one Run;
- only one Run can be owned as active SolidWorks work at a time;
- heartbeat and lease metadata detect an interrupted owner.

### 11.2 UI Close Semantics

| Event | Behavior |
|---|---|
| Window closes | Run continues |
| Electron exits | Run continues in Agent Runner |
| UI reopens | Read snapshot and resubscribe from event sequence |
| Windows locks | Intended to continue; verify in Phase 5 HIL |
| Sleep/resume | Health-check runtime and SolidWorks after wake |
| User logs out | Not guaranteed |
| Windows restarts | Detect interrupted Run and apply recovery decision |

### 11.3 Recovery Levels

Recovery is capability-based, not promised generically.

```text
QUEUED
→ safely reclaim

PREPARING / ANALYZING / PLANNING
→ resume Codex thread when compatible and safe
→ otherwise re-evaluate from persisted immutable Snapshot within the same Run only if the adapter can prove idempotence

MODELING / VALIDATING / PACKAGING
→ inspect runtime metadata and Artifact state
→ resume only with an explicit safe checkpoint supported by the actual runtime/skill
→ otherwise fail the Run with an interruption code; never publish a partial Model
```

Codex thread resume proves conversation restoration, not SolidWorks feature-level continuation. The selected Skill has no documented checkpoint/resume contract, so SWPanel must not claim mid-feature resume.

Implementation status (Phase 5, P5-4, 2026-08-14 — contract-tested only, never HIL): the recovery decision is now a protocol-pinned helper (`apps/runner/src/execution/recovery/thread-session-recovery.ts` + `thread-session-recovery-capabilities.ts`): a persisted Codex thread session may prove a resume ONLY while the attempt's last proven stage is `null` (nothing reached), PREPARING, ANALYZING or PLANNING; once the thread entered MODELING / VALIDATING / PACKAGING, `hasSafeCheckpoint` is ALWAYS false — a hard pin that no injected predicate can loosen — and a malformed session is never trusted. The pinned protocol predicate defaults to the session protocol field the adapter writes (`codex-app-server` / protocol v2, the app-server protocol major) — a pin DISTINCT from the codex-cli release (`0.147.0`), which stays pinned separately; a resume decision keys on the session protocol field, never on the CLI release, and adapter-produced sessions (the adapter writes protocol `codex-app-server` + protocolVersion v2) now match the recovery pin, so a protocol change can never silently resume a thread the current protocol cannot prove.

### 11.4 Cancellation

Cancellation is cooperative first:

1. persist cancellation request;
2. call the runtime interrupt primitive;
3. wait for Agent turn/process termination;
4. stop later automation steps;
5. close only SolidWorks instances/documents proven to be owned by the Run;
6. clean allowlisted Run files;
7. set `CANCELLED` and retain minimal history.

Do not kill all `SLDWORKS.exe` processes or a process tree until ownership behavior is verified. A forced process termination is a last-resort adapter policy, not the default.

Implementation status (Phase 5, P5-4, 2026-08-14 — contract-tested only, never HIL): the cancellation path toward SolidWorks is an ownership-safe guard (`apps/runner/src/execution/ownership/solidworks-ownership-guard.ts`): an immutable `OwnershipRecord` bound to (runId, attemptId) carries ONLY identities the attempt itself recorded (spawned process ids and opened document identities); `closeOnlyOwned` closes only identities whose proof holds for that pair — an unattested or mismatched identity makes the whole close `ownership-unproven` and the closer is not invoked; the guard never enumerates processes, never matches by name and exposes no kill-all API. Unproven/partial/failed closes map conservatively to `CANCEL_CLEANUP_PENDING` — a cancellation is never confirmed while a SolidWorks identity of the attempt may still be live. This satisfies step 5 of the cooperative sequence above at the contract level; real HIL verification on an approved machine remains an Exit Gate requirement.

---

## 12. IPC / API Contract

### 12.1 Local Transport

Electron Main and Runner use a per-user Windows Named Pipe. The pipe name contains an installation/channel identifier and a random instance identifier, never business data.

Controls (implemented in Phase 2, `apps/runner/src/ipc/` + `packages/contracts`):

- current-user + SYSTEM-only DACL with real Windows evidence (see below);
- protocol version handshake (IPC protocol v1);
- server instance identity verified by the Main-side client;
- max request and event size;
- request ID and idempotency key (repeated mutation delivery is deduplicated);
- schema validation before dispatch;
- no generic command execution endpoint (allowlisted queries/commands only).

DACL implementation and evidence (2026-08-13): Node exposes no public API to set a DACL on a named pipe (Node 24 removed public `dlopen`), and on this host `icacls \\.\pipe\...` fails with error 87 (invalid parameter) for both reading and granting, so the original "spawn icacls" idea is not claimed to work. The Runner instead uses a minimal Windows-only helper (`apps/runner/src/ipc/pipe-acl-windows.ts`): a first-party PowerShell P/Invoke script delivered via `-EncodedCommand` (UTF-16LE base64; no temp file, works from inside `app.asar`; pipe path and mode passed via dedicated env vars, no shell interpolation) calls `SetSecurityInfo(SE_KERNEL_OBJECT, DACL|PROTECTED_DACL)` to replace the live pipe DACL with exactly two `FILE_ALL_ACCESS` ACEs — the current user SID (from the process token) and SYSTEM (`S-1-5-18`) — and then reads the DACL back via `GetSecurityInfo`. Verification in `apps/runner/src/ipc/acl.ts` is strict: the read-back must contain exactly {current user SID, SYSTEM} and nothing else (Everyone, ANONYMOUS LOGON, Authenticated Users, BUILTIN\Users, BUILTIN\Administrators or any stray SID all fail), otherwise the status is `WINDOWS_ACL_FAILED` and the Runner never claims an ACL it cannot prove. A read-only evidence mode captures the DACL with `READ_CONTROL` without modifying it. The Electron Main host is fail-closed (`apps/desktop/src/main/runner-host/runner-host.ts`): on win32 a server that claims a real Windows pipe must report `WINDOWS_ACL_APPLIED`, or startup is refused with `PIPE_ACL_FAILED`, the partial stack is torn down, the health state is FAILED and there is no silent fallback to the Mock Repository; adapters that never bind a real pipe must explicitly declare `claimsWindowsPipe: false` (test rigs). The live integration test (`apps/runner/src/ipc/live-pipe.test.ts`) starts a real pipe, enforces the DACL, writes raw read-only evidence that matches the applied DACL byte-for-byte, performs a raw `net.Socket` handshake + query, and tolerates an ACL probe connection as a no-op.

Truthful limit (manual security follow-up): this development host has a single interactive Windows account, so a true second-Windows-account deny test has NOT been executed. What is proven is the DACL read-back: the ACE set is exactly the current user plus SYSTEM, with no broad SIDs — pipe-name obscurity is not relied on. The two-account deny check (run SWPanel as account A, attempt to connect as account B and observe refusal) is a documented manual security follow-up; it is not fabricated as passed.

### 12.2 Preload API Shape

Implemented in Phase 2 (WP5, `apps/desktop/src/preload/preload.cts` + `apps/desktop/src/main/bridge/bridge-contract.ts`): a frozen, typed `window.swpanel` with `metadata`, `health`, `files`, `drawings` and `storage` namespaces backed ONLY by the 16 allowlisted `MAIN_CHANNELS` via `ipcRenderer.invoke`:

```text
health.get
files.selectDrawingFile            → one-use opaque token + metadata (no absolute path to Renderer)
drawings.list / getHistory / getDetail
drawings.importDrawing / addRevision / setCurrentRevision / deleteRevision
revisions.getHistory / getDetail
revisions.addRevisionFact / addModelingFeedback
storage.getSettings / updateSettings
```

Every method resolves a typed, serializable `BridgeResult<T>` discriminated union; Main converts Runner/IpcClient failures into structured, path-redacted bridge errors. There is no generic `invoke(channel, ...)`, no Renderer-supplied channel parameter, no `readFile(path)`, no `spawn(command)` and no raw pipe endpoint. Phase 3 added `runs.create/cancel/get/list/subscribe`, Phase 4 `clarifications.submit`, Phase 6 `models.review` and Phase 7 `costData.get/update` + `costReports.create/getDetail` (via the `window.swpanel.cost` namespace) to the same allowlist pattern; the remaining later-phase APIs (`models.openInSolidWorks`, `settings.testConnection`) will be added in their phases.

Never expose generic APIs such as `readFile(path)`, `spawn(command)` or arbitrary IPC channels.

---

## 13. Error Boundaries

Errors are classified independently of user-visible Status:

```text
INPUT_UNSUPPORTED
INPUT_ADAPTER_FAILED
PREFLIGHT_FAILED
AGENT_RUNTIME_UNAVAILABLE
AGENT_PROTOCOL_INCOMPATIBLE
SKILL_NOT_FOUND
SKILL_HASH_MISMATCH
SKILL_DEPENDENCY_UNRESOLVED
SOLIDWORKS_VERSION_UNSUPPORTED
SOLIDWORKS_UNAVAILABLE
CLARIFICATION_REQUIRED
AGENT_INTERRUPTED
AGENT_TIMEOUT
ARTIFACT_MANIFEST_INVALID
ARTIFACT_MISSING
ARTIFACT_OUTSIDE_WORKSPACE
VALIDATION_REJECTED
CANCEL_CLEANUP_PENDING
RECOVERY_UNSUPPORTED
RECOVERY_FAILED
```

Renderer receives safe, localized summaries. Technical logs retain diagnostic details after Secret/path redaction.

---

## 14. Security Boundary

### 14.1 Secrets

API keys are stored in Windows Credential Manager under a service namespace such as:

```text
JANGHI/SWPanel/AgentApi/{profileId}
```

SQLite stores only provider metadata and credential references. Renderer sends a new Secret once and never reads it back in plaintext.

### 14.2 Agent Permissions

- runtime CWD is the assigned Run Workspace;
- writable roots are limited to the Run Workspace;
- network is disabled unless the configured model provider requires it and policy permits it;
- no broad repository or user-profile write permission;
- no arbitrary approval prompt may block an unattended Run; unsupported permission needs fail Preflight or the Run explicitly;
- Builder Source is treated as untrusted text/Artifact and is never executed by Renderer.

### 14.3 External Inputs

- validate extensions, magic bytes and size limits;
- preserve original input;
- never interpolate Drawing filenames into shell commands;
- isolate conversion tools;
- sanitize preview serving and Content-Type;
- record conversion provenance;
- do not commit Runtime Data or real business data to the public repository.

---

## 15. Cost Calculator

**Implemented in Phase 7 (2026-08-18, Exit Gate PASSED).** The Cost Calculator is a pure deterministic module with versioned formulas and explicit unit dimensions (`packages/domain/src/cost/calculator.ts` — `calculateCostEstimate` pure function + `roundCny` CNY half-up 2-decimal rounding, 28 dedicated unit tests). **The Runner (via `CostWorkflowService.createCostReport`) is the only authoritative calculator; the Renderer never submits a computed result.**

Design inputs:

- Approved Model reference (identity frozen; exact geometry extraction is a Phase 8 accuracy item — the Product UI currently feeds `finishedVolume` from the canonical fixture constant);
- user-confirmed quantity, material and raw stock (`CYLINDER` `ØD × L` / `RECTANGULAR_BAR` `L×W×H`, `mm`/`cm`/`m` units);
- versioned allowance and fixed-cost definitions (`PER_PIECE` / `PER_BATCH` basis);
- effective Cost Data snapshot (materials with price unit `元/吨`/`元/kg`/`元/件` and density, allowances, fixed costs, `DISPLAY_ONLY` custom fields).

Design outputs:

- raw stock volume;
- material cost;
- per-piece, per-batch and total fixed costs;
- per-piece cost and total cost (CNY 2-dp);
- complete input/formula/result Snapshot, frozen immutably at report creation (`cost_reports.snapshot_json`) — later global price edits never rewrite a historical report; labels `Q01/Q02/…` sequence per revision.

Unknown custom fields and unknown units remain display-only (never enter a formula). LLM recommendations never enter a formula until a user confirms the structured value. Profit, tax, freight, sales price and commercial quote terms stay out of scope — the report is an internal cost estimate reference, never a final customer quote.

---

## 16. Test Architecture

### 16.1 Domain Tests

- legal/illegal Run transitions;
- Clarification terminal behavior;
- Model approval/rejection invariants;
- current Revision/current Approved Model eligibility;
- deterministic Cost Calculator, unit and rounding rules.

### 16.2 Persistence and Storage Tests

Implemented in Phase 2 (Runner suite, `apps/runner/src/**/*.test.ts`):

- migrations (schema version, idempotent);
- WAL mode, busy timeout and transaction behavior;
- reopen persistence (data survives close/reopen);
- atomic current-revision switch;
- drawing workflow use cases (create Drawing/Revision, Facts/Feedback, history, compensation on failure);
- deletion guardrails (current-pointer protection, allowlist-only, "already gone" semantics);
- missing-source structured errors;
- ledger SHA-256/size verify, path containment, symlink/junction escapes and Unicode Windows paths;
- Named Pipe protocol (handshake, malformed/oversized messages, idempotency, schema validation) plus the live pipe DACL evidence test.

Phase 3 (2026-08-13) added the Run suites: conditional single-Run claim, lease expiry, Run event ordering, cancel cleanup allowlist, recovery decisions, and the Fake Executor scenario matrix. Phase 4 (2026-08-13) added the Input Adapter boundary, Prompt/Invocation, raw record + translator, Clarification-to-Facts, synthetic artifact set and independent Artifact validator suites (the Runner suite is now 18 files / 309 tests; the contracts suite 13 files / 141 tests — see §17.2).

### 16.3 Fake Agent Contract Tests

Cover (Phase 4, 2026-08-13):

- success (adapter → prompt/invocation → raw translation → manifest → independent validation → completed);
- clarification (structured question set → answers become Revision Facts → manual new Run);
- PDF without an explicit page selection (fails closed) and DWG/DXF test-only marking;
- malformed schema output / version mismatch;
- missing Artifact, zero-byte Artifact, output outside Workspace, hash mismatch;
- hanging Agent, interrupt and timeout, runtime crash;
- resume success/failure;
- Agent says completed while validation fails (claims are never authoritative);
- per-claim error boundary: a thrown adapter/workspace error of one claimed Run never kills the serial queue.

### 16.4 Desktop Security and UI Tests

- Renderer has no Node globals;
- only allowlisted Preload methods exist (the frozen bridge exposes exactly the 16 `MAIN_CHANNELS` methods; `preload.contract.test.ts` enforces it);
- CSP and navigation restrictions;
- preview protocol path authorization;
- real route reachability;
- keyboard and focus semantics;
- screenshot baselines at 1366×768 and 1920×1080, DPI 100/125/150%;
- state-specific fixtures rather than contradictory global data;
- Phase 2: RunnerHost fail-closed behavior (`PIPE_ACL_FAILED`, partial-stack teardown, no silent Mock fallback), bridge failure mapping with path redaction, async bridge repository states (loading/error/data/empty/unavailable), and the WP6 browser workflow over an explicit fake bridge (`e2e/phase2.browser.spec.ts`, 10 tests) plus the production Electron WP7 integration flow (14/14).

### 16.5 Hardware-in-the-Loop Tests

On an approved Windows machine with a drivable supported SolidWorks installation:

- JPG and PNG complete drawings;
- blocker drawing produces Clarification and proves SolidWorks was not launched;
- background and visible-live execution;
- MP4 absent by default and validated when requested;
- native editable feature tree;
- clean forced rebuild;
- required Artifact manifest;
- close Electron while Run continues;
- interrupt runtime without publishing a Model;
- ownership-safe Cancel that does not kill a user’s unrelated SolidWorks work.

**Not executed (2026-08-14)**: approved-drawing modeling (HIL) was **not started** — this host installs SolidWorks **2025 product version 33.0.0.5050**, but the availability gate currently FAILS because both COM activation and direct launch crash in the AMD driver `atio6axx.dll` version `31.0.12042.4` with access violation `0xc0000005` (dump evidence under the local CXPD directory, e.g. `C:\Users\Eric Chan\AppData\Local\SolidWorks\CXPD\20260814222204_33.0.0.5050\SLDWORKS.exe.*.dmp`). Phase 5 repository-side contract tests cover the ownership-safe Cancel boundary and the low-stage pinned thread-session recovery helper as pure contract tests (`apps/runner/src/execution/ownership/`, `apps/runner/src/execution/recovery/`) — these are **contract-tested only, never HIL-verified**, and are not claimed as HIL evidence. The **async ownership-safe SolidWorks live probe** (`apps/runner/src/preflight/solidworks-live-probe.ts`) is implemented and final-verified at the repository level and was exercised on this host (result `available: false`, `installedVersion` 33.0.0.5050, owned spawned process closed, no residual SLDWORKS.exe; attach errors never spawn) — that is a live probe smoke, not HIL modeling.

**2026-08-15 HIL attempts (evidence; none completed)** — three approved-chain attempts ran on this host and none completed: (1) `.scratch/hil-20260815-142334-52f26231` — the real Runner Run FAILED `AGENT_PROTOCOL_INCOMPATIBLE` after all nine preflight checks passed (`synthetic: false`) with the real PDF adapter passing and the SolidWorks probe `available: true` / version `33.0.0` / `owned-process-proven`; root cause: native Codex 0.147.0 rejects the experimental `thread/start.runtimeWorkspaceRoots` field while `experimentalApi: false` — the gated field was removed, the stable thread start is `cwd` + `sandbox: "workspace-write"` with attempt-root containment in `turn/start.sandboxPolicy`, and the live preflight now includes a harmless real `thread/start`; (2) `.scratch/hil-20260815-144823-3836c9fc` — the real Runner Run FAILED `AGENT_RUNTIME_UNAVAILABLE`; all nine preflight checks and the real PDF adapter passed, a real `thread/start` + `turn/start` + failed turn occurred, the SolidWorks probe again `available: true` / `33.0.0` / `owned-process-proven`, no CAD/artifacts; the adapter discarded the native `turn.error.message`, which the new failed-turn diagnostic preservation addresses (deterministic sanitization — URLs, absolute paths incl. spaces, credentials/env secret keys, JWTs; controls/whitespace normalized; max 512 chars — into the technical `runtime/agent-session.json` note only; product-visible `AGENT_RUNTIME_UNAVAILABLE` stays generic; no raw agent log on the failed path; harness 1.0.2 copies only allowlisted status/adapter/protocol + the bounded note as `14-agent-session-diagnostic.json`; `skill.resolvedPath` absolute-validated); (3) `.scratch/hil-20260815-214252-393c22d8` — stopped before `Runner.open` / Run creation (Codex 0.147.0 probe and exact Skill path/digest passed; SolidWorks probe failed closed) — a harness/preflight stop, not a Run terminal failure. The SolidWorks COM probe was redesigned: PowerShell `GetActiveObject` was a false-negative source (`TYPE_E_ELEMENTNOTFOUND`) on hosts where Python/pywin32 works — COM attach/poll is now bounded Python/pywin32 `GetActiveObject` only, PowerShell is registry/file-version discovery only, an existing instance is read-only, and owned spawn uses the exact Node child handle/PID with exact `GetProcessID()` equality (no Dispatch/CreateObject, no kill-all, no ExitApp/Quit). Host state was dynamic: the first two probes succeeded; at 21:42 the owned SolidWorks launch exited before COM registration — `21-solidworks-startup-diagnostic.json` shows default, `/ForceSoftwareOGL /SWDisableExitApp`, and `/SWSafeMode /SWDisableExitApp` all exiting in ~3–4 s with unsigned 3221225477 (`0xC0000005`). The current crash is NOT conclusively attributed to AMD/`atio6axx` (AMD Radeon driver `31.0.12042.4` is recorded only as host context / historical hypothesis; both Rx session-safe modes failing means hardware OpenGL and ordinary Tools/Options state were not isolated as sole causes). SolidWorks is installed and COM-registered but currently not drivable. The product probe early-exit defect was fixed (concurrent observation of the exact owned-process early exit, helper child aborted/awaited, prompt return with stable reason `owned-process-exited`, safe `ownedProcessExitCode`, `installedVersion`, truthful owned spawned/closed facts) — narrow real probe evidence `22-solidworks-probe-after-early-exit-fix.json`: `available: false`, `installedVersion` 33.0.0.5050, owned spawned/closed true, exit code 3221225477, reason `owned-process-exited`, duration 7044 ms; no Codex/PDF/Run/HIL; no residual SLDWORKS/codex process. Fresh verification on the current working tree passed (2026-08-15): `npm run check` exit 0 — typecheck, repository lint, all tests and full build — root 10 files / 291 tests, `@swpanel/desktop` 31 files / 572 tests, `@swpanel/runner` 38 files / 738 tests, `@swpanel/contracts` 13 files / 148 tests, `@swpanel/domain` 14 files / 70 tests, `@swpanel/ui` 6 files / 43 tests; `npm run check:fixtures` 1/1 — 13/13 canonical scenarios, 0 violations, RESULT PASS; `npm run test:e2e` passed sequentially — production Electron 20/20, browser + Electron smoke 51/51. The canonical package/installer was not refreshed. **Phase 5 Exit Gate remains NOT PASS (2026-08-15)**: no successful `.SLDPRT` + six artifacts + Model (`PENDING_REVIEW`), no real Clarification scenario, no ownership-safe cancellation HIL; `productionVerified` stays `false`; no Phase 6; nothing committed/pushed.

---

## 17. Build and Packaging

### 17.1 Workspace

```text
apps/
├── desktop/
└── runner/
packages/
├── contracts/
├── domain/
└── ui/
```

Use npm workspaces initially because npm is installed and no package manager is currently pinned. Commit a lockfile. A future change to pnpm requires an explicit tooling decision.

Phase 1 implements `apps/desktop` (secure Electron Main/Preload + React/Vite Renderer), `packages/domain`, `packages/contracts` and `packages/ui`. Phase 2 (Exit Gate PASS 2026-08-13) turned `apps/runner` from a reserved process-boundary shell into the real persistence + IPC backend: `db/` (SQLite WAL store), `ledger/` (immutable drawing file ledger), `service/` (drawing workflow use cases) and `ipc/` (Windows Named Pipe server with the verified current-user+SYSTEM DACL). The remaining target modules in §5.1 (orchestration, agent, input-adapters, security) are filled by later phases.

### 17.2 Commands

Phase 1 replaced the Phase 0 placeholder with the desktop development stack and added the stable verification and packaging commands:

```text
npm ci
npm run dev
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
npm run check
npm run package:win
npm run make:win
```

- `npm run dev` builds the Electron Main (`build:electron`), starts the Vite renderer dev server on `http://127.0.0.1:5173` and launches Electron against it with the single dedicated CLI argument `--swpanel-development-renderer=http://127.0.0.1:5173/`. The development Renderer override is honored ONLY for an explicit unpackaged development launch via that exact argument: `SWPANEL_RENDERER_URL` / `SWPANEL_DEVELOPMENT_RENDERER` (any casing) are never read, and a packaged, temp-ASAR or loose launch always loads the `app://swpanel` Renderer.
- `npm run test:e2e` runs `npm run build` and then Playwright. The production posture is covered by `e2e/electron.production.spec.ts` (launches the built main process without the development CLI flag, so the Renderer is served by `app://swpanel` exactly like a packaged app, including a real temp `app.asar` launch and a hostile dev-server/CLI matrix), and the dev posture by `e2e/electron.smoke.spec.ts` (dev server + `component-spec` exclusion). `e2e/phase1.browser.spec.ts` covers the browser UI, a11y and screenshot baselines.
- `npm run package:win` runs the atomic packaging chain (`scripts/package-all.mjs` → `scripts/packaging.mjs`): lock → legacy `.package-copy` guard → quarantine the previous canonical `out` → build → Electron Forge `package --platform=win32 --arch=x64` into a per-run temp directory (`.scratch/package-runs/<uuid>/out`) → fresh `app.asar` verify → ASAR closure/forbidden-content audit → packaged-app smoke → atomic publish to the canonical `out` only when every step passed. A stale package is never reused: the canonical `out` does not exist during a run, and a Windows transient lock on publish is retried with bounded backoff.
- `npm run make:win` runs the atomic installer chain (`scripts/make-win.mjs` → `scripts/installer.mjs`), sharing the same cross-process packaging lock as `package:win`. It quarantines a previous canonical `installers/` immediately after the lock; prepares the CURRENT canonical `out/SWPanel-win32-x64/resources/app.asar` with a fresh ASAR audit + packaged-app smoke (never re-packages and never quarantines the canonical `out`); stages the package into `.scratch/installer-runs/<uuid>/out` with strict junction/symlink containment and a staged-asar fingerprint check; runs Electron Forge `make --skip-package --platform=win32 --arch=x64 --targets squirrel` against the staging output; audits the Squirrel `Setup.exe` (real MZ/PE/COFF bootstrapper), `RELEASES` (every line exactly `SHA1 FILENAME SIZE`, truthful SHA-1/size for the actual full.nupkg), the full.nupkg (exactly one `lib/net45/resources/app.asar` whose CRC-32/SHA-256/size match the canonical fingerprint) and the payload `lib/net45/SWPanel.exe` (real x64, COFF machine 0x8664); then atomically publishes to the canonical `installers/` only when every check passed, re-audits the published canonical directory, and commits an ok:true report. Any failure up to publish leaves the canonical `installers` absent; a failure of the canonical re-audit or the final report commit rolls the published installers back and writes ok:false. Root installer unit tests (`src/installer.test.ts`) cover every failure stage.

On the 2026-08-13 verification snapshot (Phase 2 Exit Gate, re-run this session), `npm run check` passes (exit 0, log `.scratch/check-20260813-final.log`): typecheck, lint, unit tests and build are all green — root 10 files / 289 tests, `@swpanel/desktop` 23 files / 432 tests, `@swpanel/runner` 8 files / 91 tests, `@swpanel/contracts` 4 files / 36 tests, `@swpanel/domain` 10 files / 35 tests, `@swpanel/ui` 6 files / 43 tests. The fixture audit (`npm run check:fixtures`) passes 13/13 canonical scenarios with 0 violations. Playwright (reports generated 2026-08-13 04:17-04:18 UTC+8) passes the browser + Electron smoke suite 35/35 (`phase1.browser.spec.ts` 24 + `phase2.browser.spec.ts` 10 + `electron.smoke.spec.ts` 1) and the production Electron E2E 14/14 over `app://swpanel` (WP7 integration: upload → Drawing/first Revision → new Revision → switch current → Facts/Feedback → history, no Modeling Run auto-created by upload, data and files survive a close-and-restart, explicit missing-source-file error, strict runtime/test data isolation). The atomic packaging chain published a canonical package on 2026-08-12T18:11:09Z: `out/SWPanel-win32-x64/resources/app.asar` at SHA-256 `cf171900934bd24f423982340f30215536e6dcb3ee26061e7f6ff0eddcb5d870`, 2,696,001 bytes, totalEntries 229, ASAR closure 100 files (including the Runner dist: db/ipc/ledger/service), `npm run package:audit` ok:true at 2026-08-12T19:35:31Z with forbidden/missing/empty 0. **Package freshness caveat:** that package predates the final 2026-08-13 WP6/WP7 hardening pass and no fresh `package:win` was produced afterwards (canonical `installers/` is still the 2026-08-12 `make:win` output), so the package hash is NOT cited as latest-source evidence — a fresh `npm run package:win` is needed to refresh distributable artifacts. **Phase 2 Exit Gate: PASSED on 2026-08-13** — the formal Phase 2 Exit Gate defined in `development-plan.md` §6 (complete the drawing management workflow without an Agent; data persists across close-and-restart) is satisfied. Phase 3 is next and has not started. **Phase 1 Exit Gate: PASSED on 2026-08-12** (formal conditions: real routes, visual fidelity, single component copies, domain-consistent status wording, cross-page Mock data consistency, no real backend dependency). Authenticode code signing (`signtool` absent; zero code-signing certs in `Cert:\CurrentUser\My`) and a clean-Windows offline install/start/restart/uninstall smoke (not executed on this machine) remain **Phase 8 external distribution pending items** — not executed and not passed, not claimed as passed.

On the 2026-08-14 verification snapshot (Phase 5 in-progress, **final verification on the current tree**), `npm run check` passes (exit 0, log `.scratch/check-p5-final.log`): typecheck, lint, unit tests and build are all green — root 10 files / 291 tests, `@swpanel/desktop` 31 files / **572 tests**, `@swpanel/runner` 37 files / **691 tests**, `@swpanel/contracts` 13 files / **148 tests**, `@swpanel/domain` 14 files / **70 tests**, `@swpanel/ui` 6 files / 43 tests — **the counts include the Phase 5 suites** (preflight, preflight-execution, model-publication, agent/codex/*, ownership, recovery, real-preflight-probe, skill-directory-hash, codex-live-probe, solidworks-live-probe, real-pdf-input-adapter, python-pdfium-rasterizer, codex-child-transport, live-codex-config, live-codex-wiring). The fixture audit passes **1/1** — 13/13 scenarios 0 violations RESULT PASS (`.scratch/check-fixtures-p5-final.log`; clean sequential run, no build-clean interference). `npm run test:e2e` passes sequentially and is green (exit 0, log `.scratch/test-e2e-p5-final.log`): production Electron E2E **20/20** and browser + Electron smoke **51/51** (`phase1` 24 + `phase2` 10 + `phase3` 14 + `phase4` 2 + smoke 1; no dev-server dependency in the production config). The model-detail 1366/1920 screenshot baselines were intentionally refreshed (2026-08-14 18:15) for the new synthetic provenance badge — the earlier expected-screenshot failure was the stale baseline. The earlier timing caveat (P5 batches landing after the 14:12–14:50 snapshot, latest concurrent preflight/PDF integration after the last full check, **final rerun pending**) is **superseded**: the final rerun covers the current tree including the live Codex / real-PDF wiring and the async SolidWorks live probe — **currently all green, per-workspace counts pinned in this record**. **Phase 5 Exit Gate is NOT PASS** — the nine-item preflight gate (report v2) is always active with the deterministic synthetic `synthetic: true` default; the Codex App Server `0.147.0` / protocol v2 contract is pinned, a live `initialize` + `skills/list` smoke passes (including the skill directory → `SKILL.md` exact-path verification) discovering both exact external skill copies (digest `3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`), the shell-free live stdio transport / real preflight / real PDF adapter are implemented and final-verified, the live Runner wires the owned Codex adapter + the real PDF adapter, and the async ownership-safe SolidWorks live probe is implemented (current host: `available: false`, `installedVersion` 33.0.0.5050, owned process closed, no residual process, attach errors never spawn); the ownership-safe Cancel / low-stage pinned thread recovery are contract-tested only (no HIL); installed SolidWorks 2025 (33.0.0.5050) crashes on COM activation and direct launch (AMD `atio6axx.dll` 31.0.12042.4, `0xc0000005`, CXPD dump evidence), so the availability gate currently FAILS and approved-drawing modeling was not started. The Phase 4 snapshot below remains historical record.

On the 2026-08-13 verification snapshot (Phase 4 Exit Gate, re-run this session), `npm run check` passes (exit 0, log `.scratch/check-p4.log`): typecheck, lint, unit tests and build are all green — root 10 files / 289 tests, `@swpanel/desktop` 29 files / 557 tests, `@swpanel/runner` 18 files / 309 tests, `@swpanel/contracts` 13 files / 141 tests, `@swpanel/domain` 13 files / 59 tests, `@swpanel/ui` 6 files / 43 tests. The fixture audit passes 13/13 canonical scenarios with 0 violations (log `.scratch/check-fixtures-p4b.log`). `npm run test:e2e` passes (exit 0, log `.scratch/test-e2e-p4.log`): production Electron E2E **20/20** over `app://swpanel` (the Phase 3 posture 18/18 plus the Phase 4 protocol-chain test — import → run.create → structured events → CLARIFICATION_REQUIRED → answers become Revision Facts with `source: CLARIFICATION` + `sourceRunId` → old Run terminal → new QUEUED Run — and the artifact-validation fail-closed test, real Runner + Fake Adapter/Fake Executor on a temp runtime root) and browser + Electron smoke **51/51** (`phase1` 24 + `phase2` 10 + `phase3` 14 + `phase4` 2 + smoke 1; `phase4.browser.spec.ts` renders the new product events and the clarification loop in the product UI with no fake scenario controls and no prompt editor). **Phase 4 Exit Gate: PASSED on 2026-08-13** — the formal Phase 4 Exit Gate defined in `development-plan.md` §8 (through the test Executor without real SolidWorks, the Prompt, event, Clarification and Manifest protocol chain works end to end) is satisfied. **Phase 5 is next and has not started** (externally hard-blocked: SolidWorks 2022 unavailable on this host, `$solidworks-build-mechanical-models` unresolved, no approved test drawings, Codex App Server compatibility unpinned). No real PDF/DWG/DXF production conversion and no real SolidWorks/Codex integration is claimed — all Phase 4 conversions are synthetic with `productionVerified: false`. The Phase 2 snapshot above remains historical record.

### 17.3 Windows Package

- win-x64 only for MVP;
- package Electron UI and Runner together;
- sign installer and executables before enterprise distribution;
- bundle fonts and all visual assets;
- do not bundle customer Runtime Data;
- verify a clean-machine offline installation path;
- installer upgrades must not replace Runner/Agent components while a Run is active;
- uninstall does not silently delete the business data library.

The Electron binary is present in `node_modules` (`dist/` and `path.txt` exist), so `npm run dev`, `npm run test:e2e`, `npm run package:win` and `npm run make:win` have been executed. The packaged app is loaded over the restricted `app://swpanel` protocol (never `file://`), verified by the production Electron E2E (14/14 on 2026-08-13) and the packaged-app smoke inside the atomic packaging chain. The current canonical package was published on 2026-08-12T18:11:09Z and audited ok:true at 2026-08-12T19:35:31Z (SHA-256 `cf1719…`, 2,696,001 bytes, 229 entries, closure 100 files, forbidden/missing/empty 0); it bundles the Runner (db/ipc/ledger/service) alongside the desktop app. **Freshness caveat:** it predates the final 2026-08-13 WP6/WP7 hardening pass, no fresh `package:win` was produced afterwards, and canonical `installers/` is still the 2026-08-12 `make:win` output (`SWPanel-0.1.0 Setup.exe` 141,370,368 bytes, `swpanel-0.1.0-full.nupkg` 140,618,144 bytes, report ok:true) — so the current package hash is not cited as latest-source evidence; re-run `npm run package:win` (and `make:win` for installers) to refresh distributable artifacts. Remaining Forge dev-toolchain npm audit findings (`@electron-forge/*` and transitive dev dependencies; production audit is 0) are a non-gating dev-toolchain note. Authenticode code signing is not done (`signtool` absent from PATH; `Cert:\CurrentUser\My` contains 0 code-signing certs), and a clean-Windows offline install/start/restart/uninstall smoke has not been executed — these are **Phase 8 external distribution pending items** (per the 2026-08-12 Phase 1 scope decision; not executed, not passed, not claimed as passed), and no temporary self-signed certificate is generated to masquerade as a delivery signature. The framework decision stands on architecture fit.

---

## 18. Repository and Runtime Hygiene

The repository is public. Phase 0/Phase 1 must add `.gitignore` entries for:

```text
node_modules/
dist/
out/
coverage/
test-results/
playwright-report/
*.log
.env
.env.*
!.env.example
*.db
*.db-shm
*.db-wal
runtime/
workspaces/
artifacts/
*.SLDPRT
*.SLDASM
*.SLDDRW
```

The confirmed `.design` prototype and `SWPanel-UI-Design-Brief.md` are project inputs, not Runtime Data. Phase 0 reviewed their file types and secret-like content and found only static prototype files and placeholder connection values, so they are intended to be versioned with the project. Any future replacement export must repeat the provenance and confidentiality review before staging.

---

## 19. Architecture Risks and Follow-up Gates

### Phase 0 Exit Gate

The architecture questions for UI, business code, persistence, large files, Runner separation, SolidWorks call chain and interrupted Run detection have explicit answers. The repository now contains a lockfile and passing development-startup, type-check, lint, unit-test and build commands; `npm run check` passed on 2026-08-10. Phase 0 Exit Gate is satisfied, so Phase 1 Frontend Foundation may proceed. Real Agent/SolidWorks capability remains gated separately below.

### Phase 2 Exit Gate

Phase 2 (Persistence and Drawing Workflow) **PASSED its Exit Gate on 2026-08-13** per `development-plan.md` §6: the user can complete the whole drawing management workflow without an Agent (upload → Drawing → Revision → current-revision switch → Revision Facts / Modeling Feedback → history) and the data survives a close-and-restart. Evidence: `npm run check` exit 0 (root 10 files / 289 tests, desktop 23 files / 432, runner 8 files / 91, contracts 4 files / 36, domain 10 files / 35, ui 6 files / 43), fixture audit 13/13 with 0 violations, Playwright browser + Electron smoke 35/35 and production Electron 14/14 (2026-08-13 reports), `package:audit` ok:true (canonical package published 2026-08-12T18:11:09Z — not cited as latest-source evidence because it predates the final WP6/WP7 hardening pass). Two truthful limits remain: the true second-Windows-account named-pipe deny test is a manual security follow-up (not executed on this single-account host; the DACL read-back proves the exact current-user+SYSTEM ACE set), and signing/clean-Windows offline smoke remain Phase 8 external distribution pending items. Phase 3 has not started.

### Phase 4 Exit Gate

Phase 4 (Input Adapter and Agent Contract) **PASSED its Exit Gate on 2026-08-13** per `development-plan.md` §8: through the test Executor without real SolidWorks, the Prompt, event, Clarification and Manifest protocol chain works end to end. Evidence (re-run this session): `npm run check` exit 0 (root 10 files / 289 tests, desktop 29 files / 557, runner 18 files / 309, contracts 13 files / 141, domain 13 files / 59, ui 6 files / 43), fixture audit 13/13 with 0 violations, `npm run test:e2e` exit 0 — production Electron 20/20 and browser + Electron smoke 51/51. Truthful limits: all Phase 4 conversions are synthetic fake adapters with `productionVerified: false` (DWG/DXF explicitly `-test-only`) — no real PDF/DWG/DXF production conversion is verified or claimed, and real SolidWorks/Codex integration is Phase 5 (unchanged external hard blocks). The true second-Windows-account named-pipe deny test remains a manual security follow-up, and signing/clean-Windows offline smoke remain Phase 8 external distribution pending items. Phase 5 has not started.

### Real Modeling remains gated

Phase 5 cannot pass until all are verified. Repository-side status (2026-08-14, Exit Gate NOT PASS):

1. `$solidworks-build-mechanical-models` — retained as **non-blocking Skill prose**: deliberately NOT a gate item and never faked as resolved (**unverified**);
2. a drivable SolidWorks environment exists — **currently FAILS**: this host installs SolidWorks 2025 product version **33.0.0.5050**, but both COM activation and direct launch crash in the AMD driver `atio6axx.dll` `31.0.12042.4` with `0xc0000005` (dump evidence under local CXPD, e.g. `C:\Users\Eric Chan\AppData\Local\SolidWorks\CXPD\20260814222204_33.0.0.5050\SLDWORKS.exe.*.dmp`), so `solidworks_available` is false right now and the approved-drawing HIL was **not started**;
3. Codex App Server compatibility is pinned and integration-tested — **pinned** (`codex-cli 0.147.0` / protocol v2, schema documents under `.scratch/codex-app-server-schema-0.147.0/v2/`); a live `initialize` + `skills/list` smoke **passes** (including the skill directory → `SKILL.md` exact-path verification) and discovered both exact external skill copies (`.agents` + `.codex`, digest `3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`); the shell-free live stdio transport/lifecycle is implemented and final-verified and the live Runner wires the owned Codex adapter + the real PDF adapter — **the full live modeling turn chain is never HIL-verified**;
4. the Agent contract produces the formal schema and required files — **implemented repository-side** (P5-1..P5-4: nine-item preflight report v2 always active with the synthetic `synthetic: true` default, atomic `PENDING_REVIEW` Model publication default, Fake Agent artifacts) but **not verified against a real Agent turn**;
5. cancellation ownership does not damage unrelated SolidWorks work — **contract-tested only** (ownership guard, never HIL);
6. PDF/DWG/DXF adapters are validated — **not validated as production**: the real PDF adapter + pypdfium2 4.30.0 rasterizer is implemented and final-verified and one approved PDF was truthfully rasterized at 300 DPI (4963×3509, source hash `e321dc34c80b943b8af9ca9ea4ebbf9f42003627707503bf25512a479cda72a0`, output hash `30614c32a5dba38374642bf76e0e7e763674e15b78455c2cb4ff18d316ae7d96`, `productionVerified: false`, output kept in temp / outside git); DWG/DXF remain synthetic (`productionVerified: false`); no approved-drawing real E2E/HIL has completed — three approved-chain attempts were made on 2026-08-15, none completed;
7. HIL clarification proves no pre-clarification SolidWorks launch — **not executed successfully** (three approved-chain attempts ran on 2026-08-15, but none was a real Clarification scenario; availability gate currently FAILS);
8. recovery claims are limited to demonstrated runtime/skill checkpoints — **implemented repository-side as the protocol-pinned low-stage helper** (null/PREPARING/ANALYZING/PLANNING only, MODELING+ hard no-checkpoint), **contract-tested only, never HIL**.

### Real Modeling gating facts (2026-08-15 update)

Three approved-chain HIL attempts ran on 2026-08-15 and none completed (evidence in §16.5): two real Runner turns failed truthfully (`AGENT_PROTOCOL_INCOMPATIBLE` — native Codex 0.147.0 rejected the experimental `thread/start.runtimeWorkspaceRoots`, removed; stable thread start is `cwd` + `sandbox: "workspace-write"` with `turn/start.sandboxPolicy` containment, live preflight includes a harmless real `thread/start`; `AGENT_RUNTIME_UNAVAILABLE` — the adapter discarded the native `turn.error.message`, now preserved via the sanitized technical note) and a third attempt stopped before `Runner.open` on the SolidWorks preflight. The SolidWorks availability gate still FAILS, but the host state was dynamic (first two probes `available: true`; the 21:42 owned launch exited before COM registration; default and both Rx session-safe modes exit ~3–4 s with `0xC0000005` per `21-solidworks-startup-diagnostic.json`) — the current crash is not conclusively attributed to AMD/`atio6axx` (AMD Radeon driver `31.0.12042.4` is host context / historical hypothesis only), and SolidWorks is installed and COM-registered but currently not drivable. Fresh verification on the current working tree passed (2026-08-15): `npm run check` exit 0 — typecheck, repository lint, all tests and full build — root 10 files / 291 tests, `@swpanel/desktop` 31 files / 572 tests, `@swpanel/runner` 38 files / 738 tests, `@swpanel/contracts` 13 files / 148 tests, `@swpanel/domain` 14 files / 70 tests, `@swpanel/ui` 6 files / 43 tests; `npm run check:fixtures` 1/1 — 13/13 canonical scenarios OK, 0 violations, RESULT PASS; `npm run test:e2e` passed sequentially — production Electron 20/20, browser + Electron smoke 51/51 (the canonical package/installer was not refreshed). Phase 5 Exit Gate remains NOT PASS: no successful `.SLDPRT` + six artifacts + Model (`PENDING_REVIEW`), no real Clarification scenario, no ownership-safe cancellation HIL; `productionVerified` stays `false`; no Phase 6; nothing committed/pushed.

### Product / design deltas to correct in fixtures

- M02 must not be presented as generated by clarification-terminal R04;
- R05 running, completed, approved and cost-generated views must be split into separate scenarios;
- Component Spec’s five-stage progress must become six stages;
- status wording must be centralized;
- cost numbers remain visual-only and must not seed deterministic calculator tests;
- Model Detail and Run Detail need the full required state coverage during Phase 1.
