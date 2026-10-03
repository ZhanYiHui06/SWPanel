# SWPanel

江海冶金内部图纸自动建模与成本测算工作台，包含应用源码、共享包、视觉原型、测试及产品与工程文档。

## 当前方向（2026-10-01）

**后续仅建设通用 Web 平台，不再开发独立 Electron 客户端；开发环境迁移到 macOS。**

已提供独立 Runner HTTP/SSE 服务和前端 HTTP adapters，并在 macOS 验证 dev 服务启动。现有 Windows/Electron 实现保留作迁移参考，不再代表目标产品形态。旧文档的桌面架构、打包路线及 Phase 验收记录均按历史上下文阅读。

**接手入口：[`docs/05-engineering/lead-agent-handoff.md`](docs/05-engineering/lead-agent-handoff.md)**。先读顶部「2026-10-01 当前交接」，其中包含启动方式、实际验证结果及当前限制。

### 项目结构

| 路径 | 用途与当前定位 |
|---|---|
| `apps/desktop/src/renderer/` | React + Vite 前端，可独立运行浏览器开发预览；暂不改目录名 |
| `apps/desktop/src/main/`、`src/preload/` | 旧 Electron 宿主、IPC 和系统能力，后续需替换而非继续扩展桌面客户端 |
| `apps/runner/` | 独立 HTTP/SSE 服务、业务服务、SQLite、任务编排、Agent/CAD 集成 |
| `packages/domain/` | 领域模型、不变量与确定性成本计算 |
| `packages/contracts/` | 命令、查询、事件及 Agent 契约 |
| `packages/ui/` | 共享 UI、设计 token 和字体 |
| `.design/` | 已确认视觉原型，非生产应用 |
| `skills/solidworks-autobuild/` | CAD 技能资产，包含 Windows/SolidWorks 依赖 |
| `e2e/`、`scripts/`、`docs/` | 测试、工程脚本及产品/工程记录 |

### macOS 浏览器开发快速开始

使用 Node.js **24.x**、npm **11.x**，在仓库根目录执行：

```bash
# 重新安装本机依赖，不复制 Windows node_modules。
# 本轮只开发浏览器，不下载 Electron 二进制；依赖声明仍然保留。
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build:packages

# 终端一：启动后端，使用仓库内已忽略的本地数据库目录。
SWPANEL_DATA_ROOT="$PWD/.local-data/web" npm run dev:server

# 终端二：启动前端。
npm run dev
```

打开 `http://127.0.0.1:5173/` 使用 mock 预览；打开 `http://127.0.0.1:5173/?mode=http` 连接真实 HTTP API 与 SQLite。Vite 将 `/api` 请求代理到 `127.0.0.1:3001`。上述 dev 服务与查询链已在 macOS 验证；完整业务链、真实 CAD 与生产部署仍需后续验收。

当前 Mac/default Web 服务未配置真实建模 worker，健康检查的 `modeling` 为 `UNCONFIGURED`；新建任务会记录 `AGENT_RUNTIME_UNAVAILABLE`。原图/模型文件查看下载、测量体积报价、企业成本维护、图纸/模型删除及 Web 密钥设置均已实现并通过临时数据库测试。没有真实 CAD 测量证据时不能生成报告；详细进度与未完成的实机验收见 handoff 顶部。

真实执行需在 Windows + 可用 SolidWorks 服务主机上运行后台：在设置页保存 API Key 后重启服务，并用服务器环境变量 `SWPANEL_LIVE_CODEX_SKILL_PATH` 配置技能绝对目录，`SWPANEL_LIVE_CODEX_EXECUTABLE` 配置兼容现有协议的原生 Codex 可执行文件，`SWPANEL_LIVE_CODEX_MODEL_IMAGE_SUPPORT=true` 明确图像能力；可选 `SWPANEL_AGENT_MODEL` 指定模型、`OPENAI_BASE_URL` 指定兼容 API 地址。后台通过真实探测后才启用执行器；当前适配器仍钉定历史 Codex 0.147.0 / protocol v2，未声称新版 CLI 已兼容。未运行真实建模或付费模型调用。

API Key 仅保存在数据目录的私有 `secrets.env`（JSON 明文，POSIX 0600；Windows 需私有目录 ACL），页面仅接收掩码。连接测试只在点击时请求模型列表，不代表 CAD 建模成功。默认服务仅监听回环；生产托管、跨机器连接与多用户鉴权需另行部署和验收。

`npm run test:renderer` 验证前端，`npm run build:web` 构建 Web 资源。修改后端源码后需重新构建 Runner 并重启服务。历史 Electron 开发入口为 `npm run dev:electron`；根 `npm run test:e2e`、`npm run build` 和 `npm run check` 仍包含桌面链路。

本仓库继续沉淀产品定义、业务对象、工作流、Agent 边界、工程 Spec 与验收标准。聊天讨论用于探索，仓库文档用于记录已经确认或正在演进的事实。

## 文档原则

- `stable`：已确认，可作为后续设计与实现的事实来源。
- `evolving`：方向已明确，但仍可能继续调整。
- `draft`：尚在讨论，不应直接作为实现依据。
- `deprecated`：已废弃，仅保留历史参考。

Coding Agent 在实现前先读 handoff 顶部的最新方向，再阅读相关 `stable` 文档。2026-09-18 的 Web-only 决策取代旧文档中的独立桌面客户端交付方向，但不自动废弃领域规则、业务流程和安全边界；其他冲突应报告，不自行选择。

## 当前文档

### 产品定义

- [`docs/00-product/product-brief.md`](docs/00-product/product-brief.md) — 产品目标、用户、核心闭环与 MVP 定义
- [`docs/00-product/product-scope.md`](docs/00-product/product-scope.md) — 第一阶段功能边界与明确不做的事项

### 领域模型

- [`docs/01-domain/business-objects.md`](docs/01-domain/business-objects.md) — Drawing、Revision、Memory、Modeling Run、Model、Review、Quote Report 等核心业务对象与不变量
- [`docs/01-domain/lifecycle-and-status.md`](docs/01-domain/lifecycle-and-status.md) — Run、Clarification、Model、Review 与内部报告的生命周期、状态与执行阶段

### 工作流

- [`docs/02-workflows/modeling-workflow.md`](docs/02-workflows/modeling-workflow.md) — 从用户发起 Run 到生成 `PENDING_REVIEW` Model 的完整自动建模工作流
- [`docs/02-workflows/review-workflow.md`](docs/02-workflows/review-workflow.md) — 从 `PENDING_REVIEW` 到 `APPROVED / REJECTED` 的轻量人工模型审核流程
- [`docs/02-workflows/quotation-workflow.md`](docs/02-workflows/quotation-workflow.md) — 从当前 Approved Model 到内部成本测算报告的参数确认、确定性计算与报告生成流程

### 产品设计上下文

- [`docs/03-product/information-architecture.md`](docs/03-product/information-architecture.md) — 顶级导航、Drawing Workspace、页面层级、页面职责与明确不建立的模块
- [`docs/03-product/screen-priority.md`](docs/03-product/screen-priority.md) — Design Mode 页面优先级、第一批 / 第二批设计顺序与共享组件建议
- [`docs/03-product/ui-content-fixtures.md`](docs/03-product/ui-content-fixtures.md) — 统一的图纸、Run、Model、Clarification、成本和设置示例数据，供原型与前端占位使用

### 工程计划

- [`docs/05-engineering/lead-agent-handoff.md`](docs/05-engineering/lead-agent-handoff.md) — **当前接手入口：Web-only 方向、macOS 开发步骤与迁移待办**

以下计划、架构和状态文档主要记录历史 Windows/Electron 路线，不能当作 Web 迁移已完成的证据。

- [`docs/05-engineering/design-source.md`](docs/05-engineering/design-source.md) — 本地 `.design` 高保真原型的视觉 Source of Truth 与工程化规则
- [`docs/05-engineering/development-plan.md`](docs/05-engineering/development-plan.md) — 从 TRAE Design 原型到本地 Windows MVP 的阶段开发路线图、工程边界、Exit Gate 与 Definition of Done
- [`docs/05-engineering/architecture.md`](docs/05-engineering/architecture.md) — Windows Desktop、Agent Runner、Persistence、Artifact、Security、Recovery 与测试架构
- [`docs/05-engineering/implementation-status.md`](docs/05-engineering/implementation-status.md) — 当前 Phase、验证结果、Blocker 与下一步

### 决策记录

- [`docs/decisions/decision-log.md`](docs/decisions/decision-log.md) — 重要产品决策及其原因
- [`docs/decisions/adr-001-desktop-runtime-and-process-boundaries.md`](docs/decisions/adr-001-desktop-runtime-and-process-boundaries.md) — Electron 与独立 Agent Runner 进程边界
- [`docs/decisions/adr-002-local-persistence-files-and-secrets.md`](docs/decisions/adr-002-local-persistence-files-and-secrets.md) — SQLite、NTFS Artifact 与 Windows Credential Manager
- [`docs/decisions/adr-003-drawing-modeling-agent-contract.md`](docs/decisions/adr-003-drawing-modeling-agent-contract.md) — 图纸建模 Skill 与 Agent Contract 边界

## 后续逐步建立

随着讨论推进，将继续补充：

- `docs/02-workflows/drawing-workflow.md`
- `docs/04-agent/`
- `docs/06-evaluation/`

后续还将独立设计 `Customer Quotation` 模块，用于从内部成本测算结果出发形成人工确认的最终对客报价与 PDF。

> 注意：当前仓库为公开仓库。真实客户图纸、企业采购价格、成本数据、API 密钥及其他商业敏感信息不得提交到公开仓库。
