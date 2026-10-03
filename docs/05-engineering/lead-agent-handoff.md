---
title: Lead Agent Handoff
status: evolving
owner: JANGHI
last_updated: 2026-10-03
---

# SWPanel 跨 Session 主 Agent 交接文档

本文档是**唯一**的跨主 Agent session 持续工作进度/计划交接文档。

文档以中文书写，事实导向，服务于下一主 Agent 直接接手执行。它不替代也不包含以下文档，而是指向它们：

- `development-plan.md` — Phase 0-8 与 Exit Gate 定义；
- `implementation-status.md` — 阶段级实施状态；
- `architecture.md` + `docs/decisions/adr-*.md` — 架构与已接受决策；
- 当前 `.zcode/plans/` 下的 plan 文件 — 批次执行细节。

---

## 2026-10-03 当前交接：UI / 操作 / 代码实现优化批次（未跑测试）

主 Agent 为 Claude Opus，审计与修复由 Sonnet 子代理分批完成（4 个只读审计 + 6 个修复批次）。改动 127 个文件（约 +4000 / −1500 行），已写回工作区；**没有提交 Git**。

**验证状态（务必先读）**：云端沙箱没有 Linux 版 rollup/esbuild 原生包，vitest 与 vite 无法运行。已通过的只有：全仓 `npm run typecheck`、全仓 `npm run lint`、四个共享包 `tsc` 构建，以及用重建后的 Runner 在临时数据目录上做的 HTTP 冒烟（上传→导入→重复图号→事实→创建 Run→工作台/列表状态→Host/Origin 拒绝→隐藏文件名拒绝→畸形 URL）。**Renderer / Runner / Contracts / Domain / UI 的单元测试、`build:web` 和浏览器实际界面均未运行**，新增与修改的测试断言都是静态编写的，预计会有需要修正的失败用例。下一步第一件事：

```bash
cd ~/Coding/SWPanel
npm run build:packages && npm run typecheck && npm test 2>&1 | tee .local-data/claude-transfer/test.log
npm run build:web
```

改动前的完整源码备份：`.local-data/claude-transfer/backup-before-optimization-2026-10-03.tgz`（不含 node_modules/.git）。本批次改动文件包：同目录 `swpanel-optimized-changes.tgz`。

### 后端（apps/runner、packages/domain、packages/contracts）

- Web 路径允许的 query/command 收敛为 `web-server.ts` 中的显式清单；`storage.updateSettings`、`secrets.*`、`model.openInSolidWorks` 经 HTTP 返回 403 `OPERATION_NOT_AVAILABLE`。
- 业务错误返回稳定 code + 固定中文文案（新增 `server/public-errors.ts`）；HTTP 状态码与信封结构未变。图号重复由 `ENTITY_CONFLICT` 细分为 `DRAWING_NUMBER_DUPLICATE`。
- 新增 Host 头校验（421 `HOST_NOT_ALLOWED`，环境变量 `SWPANEL_ALLOWED_HOSTS` / `SWPANEL_ALLOWED_ORIGINS`）；非回环 HOST 启动时打印无鉴权警告。
- SSE 连接上限（全局 64 / 每 Run 16）与写入背压；上传并发与暂存总量上限；畸形 URL 返回 400；文件名拒绝控制字符、RTL 覆盖符和以点开头的名称。
- `secrets.env` 写入改为临时文件 + fsync + rename；数据目录 0700；同一数据目录单实例锁（`server.lock`，仅入口层）。
- 图纸列表/工作台不再每次请求哈希全部原文件；列表真实返回 `runStatus`、`hasOpenClarification`、`currentApprovedModelId`、新增可选 `hasPendingReview`；工作台返回完整的 `pendingClarifications`。
- 事实/反馈 `createdAt`、审核 `reviewedAt`、澄清 `answeredAt` 一律以服务端时钟为准。
- 契约校验增加长度/数量/数值上限、成本项去重、单位白名单。
- 毛坯规格统一为领域层 `parseStockSpec`（修复 `820mm` 这类紧贴单位被当作 mm 导致体积错 1e9 倍）；`roundCny` 改为十进制半入；数量上限 1,000,000；模型几何测量增加范围校验。
- `deleteRevision` 文件清理失败不再向客户端报错，进入持久化清理队列。

### 前端数据层（renderer/features）

- 新增 `repository-mode.ts`：统一 bridge / http / mock / unavailable 选择（`vite build --mode web` 的产物默认 http），四个 provider 共用。
- 跨 provider 缓存失效（审核、Run、成本报告、删除之后相关页面自动刷新）；窗口重新聚焦时节流重取；修复请求序号复位与 `useCostQuery` 卡 loading。
- SSE 重连指数退避、恢复成功后复位计数，重连期间保留已显示数据；`ClarificationRequired` 事件更新 Run 状态。
- 非安全上下文（内网 http）下 `crypto.subtle` / `randomUUID` 的回退实现（`sha256.ts`、`random-id.ts`）。
- 新增 `error-messages.ts` 的 `describeError`，按错误码给出中文说明。

### 界面与交互（packages/ui、renderer/routes、components）

- 新增共享 `Dialog`（Esc、焦点约束与归还、提交中不可关闭、超高滚动），所有手写对话框与通知抽屉已替换/补齐；新增 `Button variant="danger"`。
- 修复：对话框样式只在部分懒加载页面生效、Toast 语气色不生效、概览“查看详情”在 HashRouter 下跳错、图纸库相对时间使用 fixture 日期、模型详情 Hook 调用顺序。
- 发起建模防重复提交并在窗口内显示失败；取消运行中的 Run 需二次确认；清除 API Key 需确认。
- 图纸库状态与筛选使用真实数据（新增“排队中”“待审核”）；工作台展示全部待补充任务与待审核模型。
- 待审核模型也显示验证结果；失败原因以中文摘要为主、原始 code/message 作为技术详情保留；不再把 UUID 当编号展示。
- 成本：金额统一两位小数、缺失密度显示“未提供”、总成本按原型高亮、多条固定成本全部展示、参数页逐字段校验、企业成本数据未保存提示。
- 设置页按运行模式门控，Web 下 Workspace 路径只读；顶栏显示数据来源（已连接服务 / 演示数据 / 服务不可用）；未知路径显示“页面不存在”。
- 窄窗口：`body` 不再强制 1180px，<1180 / <1100 / <900 三档降级（≥1180 的规则未变）。断点为实现自定，原型未定义，需人工确认观感。

### 未做 / 待决策

- 需要真机确认：PDF 页内预览在 Chrome/Edge 下是否被 `CSP: sandbox` 阻止；900/1100/1280 宽度下的布局；e2e 截图基线（≥1180 应无差异）。
- 需要产品决策：鉴权与多用户（审核人/回答人仍由前端提供，不可信）；成本“单价先舍入再乘数量”导致明细不闭合；材料费按成品质量还是毛坯质量计价；面包屑英文标题（Run Detail / Model Detail）；界面中英术语统一；“建模完成/需要补充”通知。
- 工程遗留：Run 终态后服务端不主动关 SSE（前端会把关闭当作断线）；`RunListItemView` 缺图号等字段，任务历史仍逐行取详情（已加分页）；上传仍为 JSON+Base64；HEAD 文件请求仍整文件读取；前端 `DrawingRepository` 没有 `getDashboard()`，工作台待审核项由图纸列表派生；成本参数页的余量编辑不影响服务端计算；Electron 主进程 bridge 未同步本批次契约变化（已不再是目标形态）。
- 完整审计清单与各批次报告未放入仓库；条目编号（U-xx / UX-xx / FE-xx / BE-xx）仅存在于会话记录中。


## 2026-10-01 上一交接：Web 剩余业务功能落地

### 上传故障修复

- 修复 `/api/upload` 用重复分组正则校验 Base64 时，大文件触发 V8 调用栈溢出并返回 HTTP 500 的问题。改为长度检查与解码后 canonical round trip，继续拒绝非法字符、padding 和非零 pad bits。
- 新增 20 MiB 上限文件上传、导入、下载及 SHA-256 一致性回归，以及非法编码覆盖；Web API 41 项测试通过，Runner 构建与修改文件 ESLint 通过。
- 本地 API 已加载修复；浏览器实际选择 4 MiB PDF 已进入图号/名称填写步骤，取消测试导入，未创建业务图纸。

按用户“继续实现剩余部分”推进；三个 subagent 均使用 GPT-6.1 Sol / medium。本批次取代下方上一批次的缺口表；旧桌面与旧 Web 记录保留为历史。

- 原图与模型 Artifact 已通过身份绑定的 GET/HEAD 接口提供查看、下载。每次读取检查所属对象、账本路径、符号链接、大小和 SHA-256；不能提交任意服务器路径。Web 模型列表/详情/概览读取真实预览图，缺失时提示；原始 PDF 可页内预览，DWG/DXF 和 SLDPRT 下载后用本机工具打开。Web build 使用独立 `--mode web` CSP，允许同源 PDF object；桌面构建策略保留。
- 成本页移除产品模式中的 fixture 体积和默认毛坯规格。可信体积来自已登记 BUILD_VALIDATION_LOG 的明确 SolidWorks mass-properties 测量，版本和重建结果须与模型摘要一致；无证据则禁止报价。`productionVerified=false` 表示未完成生产验收，与“存在测量数据”分开。Prompt Template 更新为 `2026.10-web.1`，要求在最终重建后的日志记录版本、重建和真实测量；没有测量时不得猜测。
- 后台报价替换浏览器提交的体积、价格快照、余量和公式版本；成本捕获时间与报告创建时间保持一致。使用服务端测量与企业当前成本配置，冻结生成时快照。校验单位、密度、数量、毛坯规格及体积，拒绝溢出；自定义字段仍只记录与展示。
- 企业成本页支持材料、固定成本和自定义字段新增/编辑/确认删除，以及按原方向编辑毫米余量；阻止无效数值、重复名称/标识和双击提交。
- 图纸库及模型列表提供显式删除：先读取关联数量和正式模型影响，再提交确认 token。事务内重新核对，新增依赖使旧确认失效；活动/待澄清任务阻塞。Drawing 硬删除关联版本/Run/Model/Review/报告/记忆/文件；Model 删除保留原图、版本、Run 与建模经验，但清正式模型指针、审核、报告、产物和悬空身份引用。文件清理意图持久化，故障后启动/定时重试且不把已提交删除变成失败。Run 删除同时清关联报价及反馈链接，确认文案明确级联影响。
- Web 设置已提供运行状态、服务端 API Key 保存/掩码/清除、用户点击后的真实 `/models` 连接测试，以及启动恢复通知。`secrets.env` 是服务端私有 JSON 明文文件，POSIX 权限 0600；Windows 数据目录须配置私有 ACL。已启动的 worker 更新密钥后需重启，不假报已连接；没有在本机发起模型调用。
- Windows 服务端配置复用现有真实 Codex/PDFium/SolidWorks/安全取消流程：仅真实能力探测通过才注入 worker。API provider 的地址、密钥环境和可选模型实际传入同一探测/执行子进程；密钥不进命令行。配置依据 [官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。Mac 和缺少密钥/技能/有效探测时保持 UNCONFIGURED。

当前验证：全仓 typecheck、lint、`build:web` 通过；Renderer **29 文件 / 375 测试**；Runner **51 文件通过、1 平台跳过 / 923 测试通过、6 平台跳过**；Contracts **14 文件 / 214 测试**。HTTP/SQLite/产物/删除/成本测试均使用临时数据库，测量日志是明确测试 fixture；没有写用户开发库，没有真实 CAD 验收。重启后的 5173 代理 health/settings 正常，浏览器设置显示 Mac 不支持及真实服务器路径。

**实际剩余**：Windows + SolidWorks 的真实图纸建模、真实澄清、安全取消/恢复和测量报价的端到端验收；DWG/DXF 真实转换；生产部署/多用户认证及权限策略。当前 Web API 默认仅监听回环，是本地开发形态；不是已验收的公网服务。不能将本批次测试日志或 `SERVER_CONFIGURED` 当作真实生产验收。Skill 资产未改，原生 Electron 文件访问仍不使用 Web endpoint。

dev 服务继续运行于 `127.0.0.1:5173` 和 `127.0.0.1:3001`，数据根 `.local-data/web`；后端改动需构建并重启。Git 源码仍未跟踪，无提交、推送或部署。

## 2026-10-01 上一批次：需求核对与 HTTP 业务契约修复

本轮按 `product-scope.md` 的九项 MVP 范围、领域规则及建模/审核/成本工作流逐项核对代码。旧桌面 Phase PASS 不视为 Web 验收；启动成功也不视为真实 CAD 已接通。两个 subagent 按用户要求使用 GPT-6.1 Sol / medium，分别负责需求审计和前端 HTTP adapters，主 Agent 完成服务端与集成复验。

### 本轮落地

- 修正四个 HTTP adapters：图纸凭证来自 `input.file.token`，补齐图纸路由解析；变更返回真实领域对象；Run/Clarification 方法、审核 `reviewerId`、成本方法与冻结输入均对齐现有契约。共享 `HttpTransport` 将命令鉴别字段写入 `payload.command`，保留结构化业务错误。
- Web API 复用严格 `validateIpcRequestEnvelope` 校验命令/查询/字段；上传只能使用服务端生成的凭证，客户端不得直接提交文件路径或伪造源文件元数据。
- 上传允许 PDF/DWG/DXF，拒绝路径文件名、无效 Base64、超限请求；默认文件上限 20 MiB，普通 JSON 请求上限 1 MiB。独立私有临时目录、五分钟凭证过期、成功单次消费及过期/停机清理均已实现。业务失败允许修正后重试，清理故障不改变已提交成功结果。
- 导入/新增版本的重试幂等键绑定上传凭证与语义内容；事实/反馈的幂等键绑定表单 intent。服务端在同一进程内合并并发请求、缓存成功结果并拒绝同键不同命令；缓存不跨进程重启持久化。
- SSE 支持 `fromSequence` 与 `Last-Event-ID`，逐事件 ID、真实服务实例 UUID、实时提交、心跳与清理；前端验证事件、过滤重复并在缺口/断线时交给现有 provider 重新读取与订阅。`fromSequence=0` 对应从序号 1 开始的完整历史。
- 默认 Web 服务建模 worker 明确为 `UNCONFIGURED`；创建的 Run 在 PREPARING 以 `AGENT_RUNTIME_UNAVAILABLE` 失败并保存历史，避免原默认 Fake Executor 将上传图纸生成合成模型。只有测试专用的服务端配置显式注入 synthetic executor；没有开启真实 CAD 或引入浏览器场景选择。
- 修复成本报告删除后重新生成的编号碰撞：从仍存在报告的最大编号递增，报告身份由 UUID 独立生成，旧报告链接不会指向重新创建的报告。
- 模型事件校验从 `@swpanel/contracts/product-events` 浏览器安全入口导入，避免 contracts 根导出中的 Node `stream` 进入前端 bundle。
- 后端处理端口占用为异步启动失败，并在 SIGINT/SIGTERM 时关闭 SSE、停止 Runner、清理上传；HTTP 连接关闭有两秒收尾期限。CORS 只允许明确开发来源及服务自身来源。

### 需求与代码核对

| MVP 范围 | 当前可复用/已接通部分 | 尚未完成的 Web 能力 |
|---|---|---|
| 1. 图纸管理 | HTTP 上传、持久化、版本新增/查询、当前版本切换；原始文件复制到不可变账本 | Drawing 整体删除、原始文件浏览器预览/下载 |
| 2. Revision Memory | 事实/反馈写入与查询、表单重试幂等、新版本独立记忆 | 完整长期维护体验仍需持续验收 |
| 3. 自动建模任务 | 创建时冻结输入、串行队列、取消/删除/查询与 SSE 契约可复用 | 真实 Agent/CAD worker；当前默认只记录未配置失败 |
| 4. Clarification | HTTP 结构化回答写入 Facts；旧终止 Run 不恢复、不自动新建 Run | 真实 Agent 产生问题的外部链 |
| 5. Agent 建模管理 | Runner 的 preflight、编排、Artifact 检查与归档逻辑已有 | Web 服务端运行配置、真实 worker 与 macOS/Windows 执行策略 |
| 6. 模型审核 | HTTP Approved/Rejected、拒绝反馈、当前正式模型指针已集成测试 | 真实产物预览/下载、Web 打开模型方案、Model 删除 |
| 7. 内部成本报告 | HTTP 冻结输入、确定性计算、审核资格校验、历史快照、删除及重建 | `CostParamsPage.tsx` 仍引用 fixture 的成品体积/毛坯规格；需从真实模型取参数，不能宣称真实几何测算完成 |
| 8. 企业成本数据 | HTTP 获取/保存成本快照、编辑既有材料/余量/固定成本 | UI 新增材料/固定成本仍禁用；可扩展字段维护未完整落地 |
| 9. 删除能力 | 非当前且无依赖 Revision、终止 Run、成本报告的现有保护逻辑可复用 | Drawing、Model 整体删除与关联影响提示未完整实现 |

跨模块未完成项：Web API 密钥与 Agent 设置、启动恢复通知的 Web 接入、登录/部署边界；Electron 设置不能当作这些功能已经迁移。下一开发批次优先处理真实模型参数与产物读取，再落实 worker 和 Web 设置方案。

### 本轮验证

- 全仓 `npm run typecheck`、`npm run lint` 与 `npm run build:web` 通过。
- Renderer：26 文件 / 362 测试通过，包括 18 个 HTTP transport/adapter 用例和 4 个真实 HTTP + SQLite adapter 集成用例。
- Runner 全量：42 个测试文件通过、1 个文件按平台跳过；896 个测试通过、6 个按平台跳过（共 902 个）。
- WebServer：29 个用例通过，覆盖上传→导入→重启持久化、版本/记忆、凭证与重试、校验错误、SSE backlog/live、未配置执行失败、测试模型审核与确定性成本报告。
- 真实模型审核/澄清/成本测试使用临时数据库与显式合成执行器，`productionVerified=false`；未作为真实 SolidWorks 验收。测试没有写入当前用户开发数据库。
- 浏览器复核真实 HTTP 图纸库与企业成本数据页面，未见控制台 error；重启后的 5173 代理健康与 dashboard 查询成功。dev 服务继续运行于 5173/3001，数据目录仍为 `.local-data/web`。
- Git 项目源码仍为未跟踪文件；没有提交、推送或部署。

## 2026-10-01 前一批次：Web dev 服务启动验证

已接手上一位 Agent 的源码修改；以下为本轮在 macOS 上实际复验的结果，覆盖下方旧记录中关于开发入口和 HTTP 服务缺失的描述。

- 环境：Node 24.21.0 / npm 11.19.0；`npm run build:packages` 构建四个共享/服务包通过。
- `npm run dev` 启动 Vite，监听 `127.0.0.1:5173`；`npm run dev:server` 启动独立 Runner HTTP 服务，默认监听 `127.0.0.1:3001`。后端运行的是 `dist`，修改后端源码后需重新构建并重启。
- 本轮补齐 Vite 的 `/api` 开发代理（目标 `http://127.0.0.1:3001`），使使用前端同源地址的 HTTP adapters 可访问真实后端，包括 SSE 路径。
- 本轮后端启动命令：`SWPANEL_DATA_ROOT="$PWD/.local-data/web" npm run dev:server`。数据位于仓库已忽略的 `.local-data/web`；未迁移其他目录的旧业务数据。不指定该变量时，入口默认使用 `~/.swpanel-data`。
- 浏览器 `http://127.0.0.1:5173/` 使用 mock；`http://127.0.0.1:5173/?mode=http` 使用 HTTP adapters。已验证真实模式的工作台和图纸库正常显示空数据库状态。
- 3001 直连及 5173 代理的 `/api/health`、`workspace.getDashboard` 查询均返回 HTTP 200 与成功 JSON。
- 补齐根 `npm run test:renderer`：24 个测试文件、340 个测试通过；Runner `web-server.test.ts`：1 个文件、3 个测试通过；`npm run build:renderer --workspace @swpanel/desktop` 通过。
- 本轮未复验全部 Runner 测试、上传到创建图纸的完整业务链、SSE 重连、真实 CAD 或生产部署；以上启动验证不能视为完整 Web 平台验收。
- 当前 Git 工作树中项目源码均显示为未跟踪文件；本轮没有提交或推送。

## 2026-09-18 历史交接：macOS 开发 / Web-only

**下一位开发者或 Agent 必须先读本节，再查阅下方历史记录。** 本节覆盖旧记录中的桌面产品方向、默认下一步和开发入口；其他业务不变量与安全要求仍保留。后续更新继续维护本文件，不另建并行进度 handoff。

### A. 用户决策与本轮边界

- 后续仅做通用 Web 平台，不做独立 Electron 客户端；迁移到 macOS 继续开发。
- 本轮仅做项目梳理、README 导航与本交接文档，**未进行 Web 架构迁移**。
- 不移动/重命名源码目录，不删除 Electron、Windows 脚本、测试或 Skill，不修改依赖、lockfile 和业务行为。
- 未提交或推送 Git，未安装依赖，未运行应用、测试、构建、真实 CAD 或发布流程。
- 梳理基线：分支 `main`，HEAD `d563cf6`（`chore: commit full SWPanel source tree`）；开始时工作树干净。本节不是该提交的新验收报告。

### B. 现在有什么，尚缺什么

| 区域 | 当前事实 | 后续接手方式 |
|---|---|---|
| `apps/desktop/src/renderer` | React/Vite 前端、路由、repository adapters、fixtures | 保留并优先复用；目录名不代表必须用 Electron 启动 |
| `apps/desktop/src/main`、`src/preload` | Electron 宿主、`window.swpanel`、文件选择、密钥、Runner 生命周期与 IPC | 作为旧实现参考；浏览器或服务端能力要另行替换 |
| `apps/runner` | SQLite、文件账本、业务服务、任务编排、Agent/CAD 探针及 Named Pipe | 复用业务逻辑；没有现成的独立 HTTP 服务启动入口 |
| `packages/domain`、`packages/contracts`、`packages/ui` | 领域计算、业务契约、共享视觉组件 | 优先保留，避免重写已实现业务语义 |
| `.design` | 已确认高保真 HTML/CSS 原型 | 仍是视觉依据，非生产应用 |
| `skills/solidworks-autobuild` | CAD 工具与技能，包含 Windows COM 和 Python 依赖 | 保留，不作为 Mac 浏览器开发前置 |
| `scripts`、`src`、`e2e` | 工程脚本及其测试、浏览器和 Electron E2E | 区分 Web 验证与旧桌面验证，不一并删除 |

**重要限制：浏览器能打开，不等于 Web 平台完成。**

- `drawing-repository-provider.tsx` 当前按运行环境选择 adapter：有 `window.swpanel` 使用 bridge；开发模式无 bridge 使用 mock；生产模式无 bridge 使用 unavailable adapter。位置：`apps/desktop/src/renderer/features/bridge-repository/`。
- `apps/desktop/vite.config.ts` 提供 `127.0.0.1:5173` 开发入口，但仍引用 Electron 安全模块中的 CSP。前端尚未完全解耦。
- RunnerHost 当前在 Electron Main 进程内管理 Runner，见 `apps/desktop/src/main/runner-host/runner-host.ts`。旧 ADR 所述“独立 Runner”不能直接当作当前部署事实。
- 没有已接通的通用 Web API、Web 登录/权限与部署闭环。静态托管 renderer 构建产物并不能补齐这些能力。
- 成本计算器可以复用，但 `CostParamsPage.tsx` 的成品体积仍是 fixture 输入，不是已打通的真实几何结果。

### C. macOS 迁移清单

**迁移源码，不搬运 Windows 运行环境。** 优先使用 Git clone；如尚未提交本轮文档，需要自行携带这些改动，普通 clone 不会带走未提交文件。提交/推送需用户授权，不由本轮自动执行。

保留：源码、`package-lock.json`、配置、文档、`.design`、合法测试 fixtures 和截图基线。不要复制 Windows `node_modules`、`dist`、`out`、安装器、测试输出、`.scratch`、运行数据库、客户图纸或密钥。真实业务数据迁移不是本轮范围；有需要时另行规划备份、导出和安全迁移。

在 Mac 安装 Node.js 24.x 与 npm 11.x（仓库 engines 下限分别为 24/11），进入实际仓库目录，例如：

```bash
cd "$HOME/coding/SWPanel"
git status --short
git log -1 --oneline
node --version
npm --version

ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build --workspace @swpanel/domain
npm run build --workspace @swpanel/contracts
npm run dev:renderer --workspace @swpanel/desktop
```

打开 `http://127.0.0.1:5173/`。先构建 domain/contracts，因为共享包的运行时导出依赖 `dist`。`ELECTRON_SKIP_BINARY_DOWNLOAD=1` 仅跳过 Electron 二进制下载，不会移除 Electron 依赖，也不代表已去 Electron 化。当前浏览器 mock 开发无需配置真实 API key、Codex 或 SolidWorks。

**以上为基于源码整理的步骤，未在 macOS 实机验证。** 若 `npm ci` 失败，先保留错误信息并检查 Node/npm 版本、网络和平台依赖，不要为了安装成功直接重写锁文件。

### D. 验证顺序与命令边界

在完成上面的共享包构建后，可逐步执行并分别记录结果：

```bash
# 现有 typecheck 是全仓检查，仍覆盖遗留 Electron 类型。
npm run typecheck
npm run lint
npm run test --workspace @swpanel/domain
npm run test --workspace @swpanel/contracts
npm run test --workspace @swpanel/ui
npm run build:renderer --workspace @swpanel/desktop
npm run check:fixtures

# 进一步检查遗留业务/适配器；失败或平台跳过需单独记录。
npm run test --workspace @swpanel/runner
npm run test --workspace @swpanel/desktop

# 仅运行浏览器行为测试，不执行 Electron 项目，暂不验收截图。
npx playwright install chromium
npx playwright test --config=playwright.config.ts --project=chromium --grep-invert 'screenshot'
```

- Playwright 配置会启动 renderer 开发服务。浏览器 E2E 验证的是开发模式行为，不能证明真实 Web backend 已工作。
- 现有 `phase1.browser.spec.ts-snapshots` 为 Windows 基线；Mac 字体栅格化等可能不同。视觉确认后再建立 Mac 基线，不批量覆盖旧基线来“修绿”。上述过滤会跳过标题包含 `screenshot` 的测试，**不算完成视觉验收**。
- Runner live-pipe 测试在非 Windows 会跳过；跳过不代表跨平台 IPC 验证通过。
- 根 `npm run dev` 启动 Electron；根 `npm run build`/`npm run check` 包含桌面构建；根 `npm run test:e2e` 先运行 production Electron E2E。它们不是纯 Web 验收入口。
- `package:win`、`make:win`、Windows 签名/安装验收已不是新方向的默认任务。不运行 SolidWorks HIL，不把整份 Python requirements 作为 Mac 初始化步骤。

### E. 平台限制与待确认问题

1. **Windows IPC 与 CAD**：`apps/runner/src/ipc/` 使用 Windows Named Pipe；`apps/runner/src/preflight/solidworks-live-probe.ts` 非 Windows 返回 unsupported-platform，并依赖 PowerShell/Python COM。不能在 Mac 照搬旧全链路。
2. **Python 依赖**：`skills/solidworks-autobuild/requirements.txt` 含 pywin32/comtypes；PDF rasterizer 默认使用 `python`，Mac 常见命令是 `python3`。未来接真实输入转换时再单独梳理依赖与可执行路径。
3. **Skill 历史不一致**：旧记录要求 `solidworks-build-part-from-drawing`，当前 `live-codex-config.ts` 默认是 `solidworks-autobuild`。旧 digest/HIL 记录不能证明新 Skill 已通过验证；不得自动恢复旧路径或宣称当前 Skill 已获同样验收。
4. **成本 mock 待复验**：`features/cost-repository/cost-repository-provider.tsx` 使用 `process` 判断开发模式，不同于其他 provider 的 `import.meta.env.DEV`；普通浏览器可能进入 unavailable 分支。这是静态检查发现，尚未运行确认或修复。
5. **密钥安全文档偏差**：旧状态文档声称 production fallback refuse，但 `main.ts` 创建 SecretStore 未传 fallbackMode，`secrets/secret-store.ts` 默认值为 `obfuscate`。本轮未修复；Web 平台需另行设计服务端密钥管理，不能照搬或声称现有实现已满足 Web 安全要求。
6. **仓库卫生**：Git 已跟踪 18 个 `.pyc`，位于 Runner adaptation 与 CAD Skill 的 `__pycache__`。它们不是 Mac 必要资产。本轮不删除既有文件；后续确认后再移除跟踪并补 Python cache/venv 忽略规则，仅加 ignore 不能移除已跟踪文件。
7. **不要搬密钥与私有数据**：旧 `secrets.enc` 位于 Electron userData，不能当作跨平台可迁移凭据。仓库已有 env、数据库、artifact 等忽略规则，但忽略规则不替代安全检查。本轮未完成 secret 审计。
8. **历史外部文件不可假设存在**：旧 Windows 用户目录、外部 Skill 路径、`.scratch` 日志和 `.zcode/plans/` 不属于可靠的 clone 交接材料。以当前仓库文件为准，不按历史绝对路径操作。

### F. 下一阶段建议（本轮未实施）

先在 Mac 复现浏览器预览并记录实际验证结果，再制定 Web 迁移方案供用户确认。推荐拆分顺序：

1. 清点每个 repository adapter 的 bridge 调用，以及上传/下载、预览、事件订阅、设置、密钥与任务生命周期的宿主依赖。
2. 明确 Web frontend、API 服务和任务 worker 的边界；是否继续 SQLite、如何部署及是否多用户需另行决策，不在文档整理时指定框架或云平台。
3. 用最小真实业务链（如图纸列表与上传）接通 Web transport，再扩展 Run 事件、模型审核和成本报告；保留 domain/contracts 的业务规则。
4. 明确 CAD 执行策略。**Web-only 不等于 CAD 必须在 macOS 原生运行**；若保留 SolidWorks，可评估隔离的 Windows worker，但尚未决定或实现。不重新引入独立 Electron 客户端作为必需入口。
5. Web 替代能力和测试到位后，再移除 Electron 依赖、旧宿主和打包链，必要时重命名 `apps/desktop`；不可先删后补。
6. 建立独立 Web dev/build/test 脚本、macOS/CI 验证与部署说明，并同步更新 architecture、development-plan 和相关 ADR。

继续保留的规则：`.design` 视觉语言、结构化产品事件、确定性成本计算、真实能力与 mock 明确分开；公开仓库不提交商业敏感数据，不擅自更改 Skill、发布或提交/推送。

### G. 本轮验证与历史证据

本轮执行了只读源码/配置/文档梳理；文档变更完成后仅检查 diff 与文档引用，不运行应用或业务测试。**macOS 实机、Web 后端、真实 CAD、本轮构建与测试均未验证。**

下方 2026-08-18 的 2,230 单元/集成测试、20 production Electron E2E、59 browser + Electron smoke 及 Phase PASS 是历史文档记录，不是本轮复测结果。历史 Phase 5 真实 CAD HIL 未闭环；旧 Windows 打包记录不能证明通用 Web 平台可交付。

**本轮变更记录（2026-09-18）**：README 增加项目导航、Web-only 定位与 Mac 快速入口；本文件增加当前交接，保留全部历史进度。没有删除或迁移源码，没有新增第二份长期 handoff。

---

## 以下为历史交接记录（截至 2026-08-18）

历史章节中的“当前”“下一步”“不进入 Phase”等表述只适用于其记录时点；桌面交付方向与当前计划以顶部 2026-09-18 交接为准。

## 1. 文档用途、更新与维护规则

**用途**：主 Agent 每次结束 session 前，把“下一 session 必须知道的工作状态”收拢到本文件，避免新 session 只能靠代码考古恢复上下文。

**上次更新时间**：2026-08-18。

**维护规则（主 Agent 负责）**：

- 每次 **Phase Gate 判定变化** 后立即更新（尤其是 Phase 1 Exit Gate 从 pending → PASS/FAIL）。
- 每次 **架构决策 / ADR 变更** 后更新。
- 每次 **关键 blocker 解决或新增** 后更新。
- 每次 **命令/验证结果变化**（如 `npm test`、`npm run test:e2e`、`npm run build`、`npm run package:win`、Playwright 结果）后更新“最近一次验证快照”与 Change Log。
- 追加式维护：**只新增** Change Log 条目，不重写历史；过期结论用新的快照条目覆盖，不删旧记录。
- 严禁写入敏感数据、客户数据、Agent runtime memory 路径（见第 10 节 Source of Truth 边界）。

---

## 2. 主 Agent 角色与执行规则

主 Agent（Lead Agent）对本文件的规则和全部 phase gate 负有最终责任。工作方式：

1. **只协调 / 拆解 / 验收 / 文档同步**。
   - 主 Agent 拆解任务、派发 Subagent、验收结果、同步本文件与 `implementation-status.md`、`architecture.md`、ADR。
   - **代码由 Subagent 完成**；主 Agent 不直接写实现代码（少量脚本/配置修复例外，仍应避免）。
2. **不提交 / 不 push Git**，除非用户明确要求。当前仓库为公开仓库，禁止把 Runtime Data、客户图纸、真实企业价格、Secret、`.SLDPRT` 等推入版本库。
3. **不改 Skill**：除非必要性已证明且单独授权，不得修改建模 Skill（`solidworks-build-part-from-drawing`），不引入 `solidworks-automation-skill-main` 作为产品能力替代。
4. **UI 以 `.design` 为视觉 Source of Truth**：不得以工程化名义重做已确认视觉语言；产品业务行为冲突时以产品文档为准并记录冲突。
5. **唯一 modeling skill**：SWPanel 产品侧唯一建模能力是 `solidworks-build-part-from-drawing`，唯一调用链是 `Agent Runner → Codex Runtime Adapter → solidworks-build-part-from-drawing → 保留为非阻塞 prose 的 mechanical execution dependency → 检测到且受支持的 SolidWorks`；Gate 不硬匹配年份版本，必须记录实际版本。
6. **结构化事件**：Agent 原始输出与产品事件分离；UI 只消费 SWPanel 定义的结构化事件，不解析自然语言状态。
7. **LLM 不算最终成本**：成本数字由确定性程序计算，LLM 不负责最终数值运算（Phase 7 原则）。
8. **不越 Gate**：Phase 1 Exit Gate 未 PASS 前，不进入 Phase 2。每个 Phase 只有通过 Exit Gate 才宣布完成。
9. **不得伪造证据**：真实能力没有验证就写“未验证/未完成”，已修复则记录修复日期与验证命令；禁止用旧测试结果冒充新证据。

---

## 3. 当前总体状态

| 项 | 状态 |
|---|---|
| Phase 0 — Architecture Spike | **已 PASS**（2026-08-10 验证基线） |
| Phase 1 — Frontend Foundation | **已 PASS**（2026-08-12 正式 Exit Gate 判定，见第 5 节） |
| Phase 2 — Persistence and Drawing Workflow | **已 PASS**（2026-08-13 正式 Exit Gate 判定，见第 8 节） |
| Phase 3 — Modeling Run Orchestrator Skeleton | **已 PASS**（2026-08-13 正式 Exit Gate 判定，见第 15 节） |
| Phase 4 — Input Adapter and Agent Contract | **已 PASS**（2026-08-13 正式 Exit Gate 判定，见第 16 节） |
| Phase 5 — Agent Runner + SolidWorks Skill | **仓库侧进行中**（2026-08-14 起 P5-1..P5-4 契约实现完成并**在 2026-08-14 树上最终验证通过**——九项 preflight 门 v2、live Codex smoke 通过（含 skill 目录→`SKILL.md` 精确路径校验）、live Runner 已接线 owned Codex adapter + 真实 PDF adapter、async ownership-safe SolidWorks live probe 已实现（COM attach/poll 为有界 Python/pywin32 `GetActiveObject`，PowerShell 仅 registry/文件版本发现；2026-08-14 本机结果 `available:false`、installedVersion 33.0.0.5050、owned 进程已关闭、无残留进程、attach 错误不再 spawn——历史记录）、probe 版本写入 prompt 并在 ArtifactValidator 精确校验；ownership-safe Cancel 与低 Stage 钉定恢复仅契约测试；**Exit Gate 未 PASS**——2026-08-15 三次获批链 HIL 尝试均未完成（两次真实 Runner turn 如实失败、第三次在 `Runner.open` 前停止）、SolidWorks 2025 33.0.0.5050 已安装且 COM 已注册但当前不可驱动（availability 门 FAILS），见第 17 节） |
| Phase 6 — Model Review 闭环 | **已 PASS**（2026-08-18 正式 Exit Gate 判定，见第 20 节） |
| Phase 7 — Cost Data 与 Deterministic Cost Engine | **已 PASS**（2026-08-18 正式 Exit Gate 判定，见第 21 节） |
| Phase 8 — Recovery / Hardening / Packaging | **已 PASS**（2026-08-18 正式 Exit Gate 判定，见第 22 节；Authenticode 签名与 clean-Windows 离线 smoke 保持为需授权的**外部交付待办**，未执行、未通过） |

**2026-08-12 正式判定：Phase 1 Exit Gate = PASS**。判定依据是 `development-plan.md` §5 定义的正式 Phase 1 Exit Gate 六项验收条件（核心页面可通过真实路由进入、页面视觉与 TRAE Design 保持高一致性、相同组件只维护一份、状态文案与领域状态一致、Mock 数据修改可跨关联页面正确反映、不存在真实后端依赖）——全部满足。**Authenticode 签名与 clean-Windows 离线安装/启动/重启/卸载 smoke 不属于 Phase 1 Exit Gate 验收条件**，已重分类为 **Phase 8 外部交付待办**（见第 5 节与第 9 节 P8 行）：二者均未执行、未通过，**不得声称已通过**，不阻塞 Phase 2。历史 FAIL / externally blocked 判定保留在第 5 节与 Change Log 历史条目中，不作重写。

**2026-08-13 正式判定：Phase 2 Exit Gate = PASS**。判定依据是 `development-plan.md` §6 定义的正式 Phase 2 Exit Gate（用户在没有 Agent 的情况下可以完整执行图纸管理流程；关闭并重启应用后数据仍存在）。WP0-WP7 全部落地并有 2026-08-13 当日验证证据（`npm run check` exit 0、fixtures 13/13 零 violations、browser + Electron smoke 35/35、production Electron 14/14、package audit ok:true，见第 8 节与第 13 节）。Phase 3 为下一阶段，**不启动**。两个保持真实性的限制：**(1)** 真实的第二 Windows 账户 pipe 拒绝访问测试**未执行**（本机为单账户主机；DACL 读回证据证明 ACE 集恰为 current user + SYSTEM，此项是**人工安全跟进项**，不得虚报为已通过）；**(2)** 签名与 clean-Windows 离线 smoke 仍为 **Phase 8 外部交付待办**（未执行、未通过）。canonical package/installer 可能滞后于最新 WP6/WP7 源码（见第 8 节与第 13 节），旧包哈希不得当作最新源码证据。

**2026-08-13 正式判定：Phase 3 Exit Gate = PASS**。判定依据是 `development-plan.md` §7 定义的正式 Phase 3 Exit Gate（通过 Fake Executor 可靠演示所有 Run 状态、6 Stage、队列、取消和恢复 UI）。P3-0..P3-6 全部落地并有 2026-08-13 当日验证证据（`npm run check` exit 0：root 10/289、desktop 29/557、runner 12/236、contracts 4/47、domain 12/51、ui 6/43；fixtures 13/13 零 violations；`npm run test:e2e` exit 0：production Electron 18/18、browser+smoke 49/49，见第 15 节与第 13 节）。Phase 4 为下一阶段，**不启动**。保持真实性的限制不变：第二 Windows 账户 pipe 拒绝测试（人工安全跟进）、签名与 clean-Windows 离线 smoke（Phase 8 外部待办）、canonical package/installer 滞后于最新 Phase 3 源码（旧包哈希不得当作最新源码证据）。**2026-08-13 审计收口 F1-F3（见第 15 节与 `docs/decisions/decision-log.md`）**：F1 关闭原"`run.create` 同 Revision 幂等"待决策风险——`run.create` 改为 **Main 按调用铸造唯一 intent id 幂等键**（`run-create:<uuid>`），同 Revision 显式第二次创建真实产生新 Run（R01/R02），同一 envelope 重复派发仍幂等（Runner 键缓存），intent id 不进入 Renderer payload / Runner wire command；F2 `Runner.open()` 在存在 QUEUED Run 时也启动并排空串行队列（确定性 reopen 测试）；F3 终态读模型（Runner + 浏览器 fake）清空 stage/activity/progressPercent。

**2026-08-13 正式判定：Phase 4 Exit Gate = PASS**。判定依据是 `development-plan.md` §8 定义的正式 Phase 4 Exit Gate（在不调用真实 SolidWorks 的测试 Executor 下，Prompt、事件、Clarification、Manifest 协议完整端到端工作）。P4-0..P4-6 全部落地并有 2026-08-13 当日验证证据（`npm run check` exit 0：root 10/289、desktop 29/557、runner 18/309、contracts 13/141、domain 13/59、ui 6/43；fixtures 13/13 零 violations；`npm run test:e2e` exit 0：production Electron 20/20、browser+smoke 51/51，见第 16 节与第 13 节）。**Phase 5 为下一阶段，未开始（不启动）**，且保持外部硬阻塞（SolidWorks 2022 不可用、`$solidworks-build-mechanical-models` 未解析、无获批测试图纸、Codex App Server 兼容未 pin）。**本阶段不声称真实能力**：所有 Input Adapter 转换均为 synthetic fake（`productionVerified: false`，DWG/DXF 显式 `-test-only`），未验证真实 PDF/DWG/DXF 生产转换，也未接入真实 SolidWorks/Codex。保持真实性的限制不变：第二 Windows 账户 pipe 拒绝测试（人工安全跟进）、签名与 clean-Windows 离线 smoke（Phase 8 外部待办）、canonical package/installer 滞后于最新 Phase 4 源码（旧包哈希不得当作最新源码证据）。审查修复 M1/M2（合成适配器不得声称 `productionVerified`；per-claim 队列错误边界）已落地并复验（见第 16 节）。

**2026-08-14 Phase 5 状态：仓库侧 P5-1..P5-4 契约实现 + live 接线完成并在当前树上最终验证通过，Exit Gate 未 PASS（不越报）**。仓库侧已落地：**(P5-1)** **九项** preflight 能力门（报告契约 **v2**）恒生效于 PREPARING（`PREFLIGHT_CAPABILITIES` 于 `packages/domain/src/runs/preflight.ts` + `apps/runner/src/preflight/preflight.ts` 探针边界）——**SolidWorks 为 version-agnostic**：只要求任何可驱动的安装（`solidworks_available`），实际版本由 probe/builder 记录，`solidworks_2022_available` 硬版本匹配已移除；**`mechanical_execution_dependency_resolved` 故意不再是门项**——`$solidworks-build-mechanical-models` 保留为 Skill prose、非阻塞、绝不伪装为已解析；v1 报告保持历史、不重写；默认产品路径运行**显式 synthetic/unverified fixture**（`DEFAULT_PREFLIGHT_SCENARIO = "all-pass"`、`FAKE_PREFLIGHT_SKILL_SHA256`），持久化报告恒为 **`synthetic: true`**，探针抛错即该项 fail-closed，`input_adapter_succeeded` 仅适配成功后标记；真实 probe（`real-preflight-probe.ts` + `skill-directory-hash.ts`，`synthetic: false`）已实现并**最终验证**（Electron Main host await 异步 live probes 后注入固定 seam 到 `RealPreflightProbe`——probe 内永无内联 live COM 调用）；**(P5-2)** 成功路径**单事务原子发布 `PENDING_REVIEW` Model**（Model 行 + artifact 元数据行 + 带 Model id 的 `Completed` + FINISHED attempt；Runner 产品默认 `publishModel: true`），manifest 的 `productionVerified` 由契约解析 wire boolean（缺省 `false`），独立 ArtifactValidator 以 `ARTIFACT_MANIFEST_INVALID` 拒绝 `productionVerified: true`（无产品侧 HIL 验证记录、声明绝不 authoritative）——仅 `false`/缺省可发布，synthetic 结果如实持久化 `false`；**(P5-3)** Codex App Server client + adapter 钉定 **`codex-cli 0.147.0` / protocol v2**（`apps/runner/src/agent/codex/`，schema 文档 `.scratch/codex-app-server-schema-0.147.0/v2/`）——**shell-free live stdio child transport + lifecycle 已实现并最终验证**（`codex-child-transport.ts`：`app-server --stdio`、`shell: false`、`windowsHide`、有界 SIGTERM→SIGKILL close、有界 stderr tail、exactly-once 退出传播；裸名 `.cmd` shim 由稳定 `resolveCodexAppServerCommand` 拒绝），真实 **`initialize` + `skills/list` native smoke 通过并发现两个精确外部 skill copies**（`C:\Users\Eric Chan\.agents\skills\solidworks-build-part-from-drawing` 与 `C:\Users\Eric Chan\.codex\skills\solidworks-build-part-from-drawing`，规范目录 digest **`3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`**，两副本逐字节一致）——**skill 目录→`SKILL.md` 精确路径校验通过**（skills/list 报告的 `<directory>\SKILL.md` 与配置目录做规范 Windows 安全段比较，兄弟目录/`.codex` 副本/嵌套 manifest/异名文件均 fail-closed）；**实际 live Runner 已接线 owned Codex adapter 与真实 PDF adapter**（`apps/desktop/src/main/runner-host/live-codex-wiring.ts`，仅 `main.ts` 的 liveCodex 分支消费：每 Runner 恰一个持久 Codex child transport + 严格 NDJSON client + async turn adapter + `RealPdfInputAdapter`（bundled pypdfium2，显式 helper 路径解析到 asar），`ownsAgent: true` 使 executor 在 Runner 关闭时有界关闭 adapter 与子进程、绝不孤儿化；默认 synthetic 路径不动）——**无 HIL-verified live Codex 建模会话**；**(P5-4)** ownership-safe SolidWorks 取消边界（`apps/runner/src/execution/ownership/solidworks-ownership-guard.ts`，显式 per-attempt 身份证明、`closeOnlyOwned`、绝不 kill-all、无法证明 → `CANCEL_CLEANUP_PENDING`）与协议钉定低 Stage 线程恢复（`apps/runner/src/execution/recovery/`，仅 `null`/PREPARING/ANALYZING/PLANNING 可证明续跑，MODELING+ 硬性无 checkpoint）——**二者仅契约测试，从未 HIL 验证**；**async ownership-safe SolidWorks live probe 已实现并最终验证**（`apps/runner/src/preflight/solidworks-live-probe.ts`：先对既有 `SldWorks.Application` COM 实例做 READ-ONLY attach（绝不关闭、绝不触碰文档），仅当无实例时才从 Node 直接 spawn `SLDWORKS.exe`（`shell: false`、`windowsHide: true`），经有界 PowerShell helper 以精确 pid 证明 COM ownership，随后只关闭 owned 进程（owned handle kill + await exit——绝不 taskkill-by-name、绝不 kill-all）；**attach 错误不再 spawn**——抛错/超时/`ok:false`/foreign/畸形 attach 结果绝不落入 owned-spawn 路径，只有干净 `ok:true, attached:false` 才可 spawn）。默认产品路径仍为确定性 synthetic Fake Preflight / Fake Agent（`codex-app-server` 0.1.0 / protocol v1），报告 `synthetic: true`、Models `productionVerified: false`。**真实 PDF adapter 已实现并最终验证**（`real-pdf-input-adapter.ts` + `PythonPdfiumRasterizer`：pypdfium2 4.30.0 + Pillow 11.3.0、`shell: false`、默认 300 DPI、temp 目录在仓库外），一份获批 PDF 已**真实栅格化为 4963×3509**——源哈希 `e321dc34c80b943b8af9ca9ea4ebbf9f42003627707503bf25512a479cda72a0`、输出哈希 `30614c32a5dba38374642bf76e0e7e763674e15b78455c2cb4ff18d316ae7d96`、`productionVerified: false`、产物留在 temp/仓库外。**probe 版本写入 prompt 并在 ArtifactValidator 精确校验**：`prompt-template.ts` 将 `expectedSolidWorksVersion` 渲染进 prompt（缺省保持 version-agnostic 字节一致），`artifact-validator.ts` 在 Runner 认定非空期望版本时要求 manifest `solidWorksVersion` 与之**完全相等**，否则 fail-closed（validator 权威、Agent 文本不权威）。**环境事实（2026-08-14）**：本机安装 **SolidWorks 2025 产品版本 33.0.0.5050**，但 availability 门**当前 FAILS**——COM 激活与直接启动均在 AMD 驱动 `atio6axx.dll` 31.0.12042.4 以访问违例 `0xc0000005` 崩溃（本地 CXPD dump 证据，如 `C:\Users\Eric Chan\AppData\Local\SolidWorks\CXPD\20260814222204_33.0.0.5050\SLDWORKS.exe.*.dmp`），获批图纸建模（HIL）**未启动**；SolidWorks live probe 本机实测结果：**`available: false`、`installedVersion` 33.0.0.5050、`ownedProcessSpawned: true`、`ownedProcessClosed: true`**（reason `ownership-not-proven`——AMD 启动崩溃使 COM 无法注册，崩溃绝不被报告为可用；probe 后**无残留 SLDWORKS.exe 进程**）；`$solidworks-build-mechanical-models` 保持非阻塞 prose（未验证）；真实 PDF/DWG/DXF 生产转换未完全验证（DWG/DXF 仍 synthetic `-test-only`）。**最终验证（2026-08-14，当前树）**：`npm run check` **exit 0**（root 10 files/291、desktop **31 files/572 tests**、runner **37 files/691 tests**、contracts 13 files/**148 tests**、domain 14 files/**70 tests**、ui 6 files/43；日志 `.scratch/check-p5-final.log`——计数含全部 P5 套件：preflight / preflight-execution / model-publication / agent/codex/* / ownership / recovery / real-preflight-probe / skill-directory-hash / real-pdf-input-adapter / python-pdfium-rasterizer / codex-child-transport / solidworks-live-probe / live-codex-config / live-codex-wiring）；`npm run check:fixtures` **1/1 通过**（13/13 零 violations RESULT PASS，`.scratch/check-fixtures-p5-final.log`，无 build-clean 干扰）；`npm run test:e2e` **exit 0 顺序通过**（production Electron **20/20**、browser+smoke **51/51**；`.scratch/test-e2e-p5-final.log`）。早前的"14:12–14:50 快照早于 P5 批次落地、全量 check 在最新并发 preflight/PDF 集成前通过、最终重跑待办、不声称当前全绿"时间线说明已被**取代**——最终重跑覆盖当前树（含 live Codex/真实 PDF 接线与 async SolidWorks live probe），**当前全绿、单测计数已钉定**。**Phase 5 Exit Gate 未 PASS：三次获批链 HIL 尝试均未完成（无成功 CAD、无 HIL 证据）、availability 门当前 FAILS（SolidWorks 已安装且 COM 已注册但当前不可驱动）；不 commit/push、不进入 Phase 6。**

**2026-08-15 Phase 5 状态更新（三次获批链 HIL 尝试均未完成；Exit Gate 保持 NOT PASS，不越报）**。2026-08-15 执行了三次获批图纸链 HIL 尝试，**均未完成**（证据目录 `.scratch/hil-20260815-142334-52f26231`、`.scratch/hil-20260815-144823-3836c9fc`、`.scratch/hil-20260815-214252-393c22d8`）：(1) 第一次真实 Runner Run 如实 FAILED **`AGENT_PROTOCOL_INCOMPATIBLE`**——九项 preflight 全过（`synthetic:false`）、真实 PDF adapter 通过、SolidWorks probe `available:true`/version `33.0.0`/`owned-process-proven`；根因是原生 Codex 0.147.0 在 `experimentalApi:false` 下拒绝实验性 `thread/start.runtimeWorkspaceRoots`，已移除该 gated 字段——稳定 thread start = `cwd` + `sandbox:"workspace-write"`、attempt-root 包含在 `turn/start.sandboxPolicy`，live preflight 现含无害真实 `thread/start`；(2) 第二次真实 Runner Run 如实 FAILED **`AGENT_RUNTIME_UNAVAILABLE`**——九项 preflight 与真实 PDF adapter 全过、真实 `thread/start` + `turn/start` + failed turn 已发生、SolidWorks probe 再次 `available:true`/`33.0.0`/`owned-process-proven`、无 CAD/artifacts；adapter 曾丢弃原生 `turn.error.message`（精确 Skill/image Turn 错误丢失）——**失败回合诊断保留已实现**：Codex `turn.error.message` 确定性脱敏（URL、含空格绝对路径、credentials/env secret keys、JWT；控制符/空白归一；≤512 字符）仅写入技术 `runtime/agent-session.json` note，产品可见 `AGENT_RUNTIME_UNAVAILABLE` 保持通用、失败路径不写原始 agent 日志，harness 1.0.2 仅允许复制白名单 status/adapter/protocol 字段 + 有界脱敏 note 为 `14-agent-session-diagnostic.json`（绝不复制完整 session/thread/turn/attempt ID/时间戳/原始日志），`skill.resolvedPath` 亦做绝对路径校验；(3) 第三次在 `Runner.open`/Run 创建前停止（Codex 0.147.0 probe 与精确 Skill 路径/digest 通过、SolidWorks probe fail-closed）——harness/preflight 停止，非 Run 终态失败。**SolidWorks COM probe 已重设计**：PowerShell `GetActiveObject` 在 Python/pywin32 可用的主机上是假阴性源（`TYPE_E_ELEMENTNOTFOUND`），COM attach/poll 现仅用有界 Python/pywin32 `GetActiveObject`（PowerShell 仅 registry/文件版本发现）；既有实例只读；owned spawn 用精确 Node child handle/PID + 精确 `GetProcessID()` 相等，无 Dispatch/CreateObject、无 kill-all、无 ExitApp/Quit。**主机状态动态**：前两次 probe 成功，21:42 owned SolidWorks 启动在 COM 注册前退出；`21-solidworks-startup-diagnostic.json` 显示 default、`/ForceSoftwareOGL /SWDisableExitApp`、`/SWSafeMode /SWDisableExitApp` 均 ~3–4 s 以 unsigned 3221225477（`0xC0000005`）退出——**当前崩溃不结论性归因于 AMD/atio6axx**（AMD Radeon driver 31.0.12042.4 仅主机上下文/历史假设；两个 Rx session-safe 模式均失败意味着硬件 OpenGL 与普通 Tools/Options 状态未被单独隔离为唯一原因）；SolidWorks 已安装且 COM 已注册但当前不可驱动。**owned 早退修复**：probe 并发观察精确 owned 进程早退、abort/await helper child、以稳定 reason `owned-process-exited` 及时返回（安全 `ownedProcessExitCode`、`installedVersion`、真实 owned spawned/closed 事实）；窄范围真实 probe 证据（`22-solidworks-probe-after-early-exit-fix.json`）：`available:false`/`installedVersion` 33.0.0.5050/owned spawned+closed true/exit 3221225477/reason `owned-process-exited`/7044ms，无 Codex/PDF/Run/HIL、无残留 SLDWORKS/codex 进程。**当前工作树全新全量验证（2026-08-15）**：`npm run check` **exit 0**（typecheck、仓库 lint、全部测试与完整 build 全绿——root 10 files/291、desktop 31 files/572、runner **38 files/738 tests**、contracts 13 files/148、domain 14 files/70、ui 6 files/43）；`npm run check:fixtures` **1/1 通过**（13/13 canonical scenarios、0 violations、RESULT PASS）；`npm run test:e2e` **顺序通过 exit 0**（production Electron **20/20**、browser + Electron smoke **51/51**）；canonical package/installer 未刷新（见第 13 节 A9；历史 A8-E8 保持记录）。**Exit Gate 保持 NOT PASS：无成功 `.SLDPRT` + 六 Artifact + Model（`PENDING_REVIEW`）、无真实 Clarification 场景、无 ownership-safe 取消 HIL；`productionVerified` 恒 `false`；不 commit/push、不进入 Phase 6**（详见第 13 节 A9 与第 17 节）。

**2026-08-18 正式判定：Phase 8 Exit Gate = PASS**。判定依据是 `development-plan.md` §12（12.1-12.6）的正式 Exit Gate——**完成一个可重复执行的本地验收流程，并能在全新测试环境按文档启动**：12.1 中断恢复（capability-based 恢复契约保留，Electron `system.getRecoveryStatus` 桥接启动恢复扫描）、12.2 通知（非阻塞 Toast + NotificationDrawer）、12.3 删除（`canDeleteRevision`/`canDeleteRun`/`canDeleteCostReport` 级联保护 + `runs.delete`/`cost.deleteReport`）、12.4 安全（SafeStorage/DPAPI 密钥库 + 掩码 IPC 表面 + fail-closed 回退）、12.5 测试（下述全量套件）、12.6 打包（`npm run package:win` 从当前 Phase 8 树重新发布 canonical 包 + fresh ASAR closure/forbidden 审计 ok:true + 独立 packaged-app smoke PASS）。**2026-08-18 验证证据**：`npm run check` exit 0——root 10 files/291、desktop **38 files/660**、runner **44 files/905**、contracts **14 files/214**、domain **16 files/110**、ui **7 files/50**（**129 files / 2,230 tests**），typecheck、仓库 lint **0 错误**、完整 build 全绿；`npm run check:fixtures` **1/1**（13/13 零 violations RESULT PASS）；`npm run test:e2e` 顺序通过——production Electron **20/20**、browser + Electron smoke **59/59**（phase1 24 + phase2 10 + phase3 14 + phase4 2 + phase6 2 + phase7 3 + phase8 3 + smoke 1）；**canonical `out/SWPanel-win32-x64/resources/app.asar` 重新发布**（SHA-256 `743bbf723343e7c4dfcb00793c5b54b8c2df61baf9f79ebeb0d5cbc23c1a7b7a`、size 4,763,426 B、totalEntries 382、closure 160、forbidden/missing/empty 0；`.scratch/asar-audit-report.json` final report generated 2026-08-18T14:01:57Z / published-fingerprint 2026-08-18T14:15:40Z (standalone `package:audit` re-run + re-finalize on the same published artifact) ok:true + 独立 packaged-app smoke PASS）。**打包验证发现并已修复**：根 `tsconfig.build.tsbuildinfo`（`npm run build` 刷新的 build-cache 文件）曾随 ASAR 发布并使 fresh audit 以 `cache` 类别失败——`forge.config.mjs` 已补 `*.tsbuildinfo` basename 忽略规则（与 audit 交叉校验 `forge-ignore-policy` 对齐；root 套件仍 10/291 全绿）；另新增可选 env `SWPANEL_ELECTRON_ZIP_DIR`（仅设置时生效），使打包在 Electron 发布主机不可达/抖动时离线确定性复用本地 `electron-v43.3.0-win32-x64.zip`（`@electron/get` 每轮运行都会从 GitHub 拉取 `SHASUMS256.txt` 校验缓存 zip）。**历史事实保留（不虚报）**：Authenticode 签名与 clean-Windows 离线 install/start/restart/uninstall smoke **未执行、未通过、未声称通过**，仍为 **Phase 8 外部交付待办（需授权，不属于研发侧 Exit Gate 验收条件）**；Phase 7 已于同日早前判定 PASS（见第 21 节）；Phase 5 仍进行中（外部 HIL 未闭环，见第 17/18/19 节）；执行细节与证据见第 22 节。

---

## 4. Phase 1 已完成能力的精确摘要

以下“源码已实现”指代码已写入工作树并经单测/组件测试覆盖；“Gate 已验证”指对应能力在正式 Phase 1 Exit Gate 中通过验证。Phase 1 Exit Gate 已于 **2026-08-12 判定 PASS**（见第 5 节）；4.7 表中“签名（Authenticode）”与“clean-Windows 离线安装 smoke”两行属于 **Phase 8 外部交付待办**，不属于 Phase 1 验收条件，未声称已通过。本节数字为 Phase 1 时代证据（历史记录）；同一测试文件在 Phase 2（2026-08-13）增长后的最新数字见第 13 节快照（production Electron E2E 现为 **14/14**、browser+smoke 现为 **35/35**）。

### 4.1 工程结构与 workspaces（源码已实现，Gate 已通过构建验证）

- 根项目为 npm workspaces：`apps/desktop`、`apps/runner`、`packages/contracts`、`packages/domain`、`packages/ui`；`package-lock.json` 已提交。
- Electron 43.3.0 + React 19 + TypeScript 6 + Vite 7；`node >=24.0.0`、`npm >=11.0.0`（本机 Node v24.19.0 / npm 11.17.0）。
- `apps/runner` 是预留进程边界 shell（仅编译 domain/contracts），无真实 persistence/queue/Agent/SolidWorks。

### 4.2 领域与契约（源码已实现，单测通过）

- `packages/domain`：Drawing、DrawingRevision、RevisionFact、ModelingFeedback、ModelingRun、RunInputSnapshot、RunEvent、ClarificationRequest/Question/Answer、Model、ModelReview、Artifact、CostDataDefinition/Value、CostEstimateReport/Snapshot；生命周期不变量函数（`canAnswerClarification`、`canCancelRun`、`canReviewModel`、`canCreateCostEstimateReport`、`transitionRunStatus`、`transitionModelStatus`、rejection 必填原因、current approved model 资格、cost-result coherence）。
- `packages/contracts`：reader aggregate views + writer primitives + 规范化 domain-transition commands + IPC 合约。

### 4.3 Mock Repository 与 Fixtures（源码已实现，单测通过）

- `apps/desktop/src/renderer/features/mock-repository/mock-repository.ts`：类型化、确定性、可订阅的 in-memory Mock Repository，实现 `@swpanel/contracts` 的 MockRepository 合约 + `subscribe`/`dispatch`。
- 命令：`createRun`、`cancelRun`、`submitClarification`（原子批量回答）、`reviewModel`（APPROVED/REJECTED）、`updateCostData`、`createCostReport`。
- 13 个 canonical scenario worlds（`MOCK_SCENARIOS`）：run-running / run-queued / run-completed / run-cancelled / clarification-open / clarification-answered / model-pending-review / model-approved / model-rejected / no-current-approved-model / cost-report-generated / run-failed / empty-drawing-library。
- 单 RUNNING 不变量在 fixture builder 中跨场景强制（R05 RUNNING 时，secondary drawing C 的 cR02 保持 QUEUED）。

### 4.4 UI 与路由（源码已实现，browser 24/24 已重跑并通过）

- 14 个产品页面全部映射到参数化深链路由（`apps/desktop/src/renderer/app/route-manifest.ts` 的 `PRODUCT_ROUTES`）；`component-spec` 仅开发路由，被生产路由与打包排除。
- 共享组件在 `packages/ui`；设计 token、CSS、本地图标集；Inter / JetBrains Mono 本地打包，生产不加载 Google Fonts。
- 全部 14 路由 + 交互（search/filter、run-start、clarification、model review、cost-data、settings）均由 `e2e/phase1.browser.spec.ts` 覆盖；Axe 全量 a11y 扫描 8/8 路由零 violations；19 张精确尺寸截图 baseline 已于 2026-08-11 16:19 UTC+8（Playwright 1.62.1 / Chromium 151.0.7922.34）重新生成，16:21 干净重跑 24/24 + Axe 验证通过（见第 5 节，blocker 4 已关闭）。

### 4.5 Electron 安全壳（源码已实现；production app://swpanel 与 temp ASAR E2E 已验证）

- `apps/desktop/src/main/security.ts` + `main.ts` + `preload.cts`：`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webSecurity:true`，限制性 CSP，同应用导航白名单，拒绝 window-open/webview，permission handler 默认拒绝。
- **production Renderer 通过受限的 `app://swpanel` 标准+安全协议加载（不再使用 `file://`/`loadFile`）**：`app` scheme 注册为 `standard` + `secure`（不带 `bypassCSP`/`corsEnabled`），CSP `'self'` 因此钉在唯一真实 origin `app://swpanel`；所有资源请求经 `createRendererProtocolHandler` 只映射 renderer 输出目录内的 canonical 路径（path traversal/UNC/盘符逃逸被拒）。
- **dev 仅通过唯一 CLI flag**：`scripts/dev.mjs` 与 dev smoke 只传 `--swpanel-development-renderer=http://127.0.0.1:5173/`，且仅在 unpackaged 启动生效；`SWPANEL_RENDERER_URL` / `SWPANEL_DEVELOPMENT_RENDERER`（任意大小写）完全不被读取，注入的 env/恶意 CLI 都无法指向外部目标。
- Preload 仅暴露不可变 `swpanel.metadata` bridge。
- `e2e/electron.production.spec.ts`（11/11 通过，含 packaged 姿势、全路由、协议 containment、真实 temp `app.asar` 加载、恶意 dev-server/CLI 矩阵）+ `e2e/electron.smoke.spec.ts`（dev 形态 1/1 通过：Renderer 无 Node globals、dev CSP 仅允许 pinned React refresh preamble hash、全部生产路由 + component-spec 排除）。

### 4.6 版本与打包历史（源码已实现；canonical package 与 installer 链仓库侧全部完成）

- Electron 43.3.0（自 38.8.6 升级），`node_modules/electron/dist` 与 `path.txt` 存在。
- `forge.config.mjs`：Squirrel maker + asar + ignore 白名单（排除 `.design`、docs、e2e、src、test output、maps/declarations、db/solidworks 业务文件等）。
- **原子 package 流程仓库侧完成**：`scripts/package-all.mjs` → `scripts/packaging.mjs` = lock → legacy `.package-copy` guard → quarantine 旧 canonical `out` → build → Forge package 到 per-run 临时目录（`.scratch/package-runs/<uuid>/out`）→ fresh ASAR closure/forbidden 审计 → packaged-app smoke → 全部通过后才原子 publish 到 canonical `out`。旧包永不复用；publish 遇到 Windows transient lock（EPERM/EBUSY/ENOTEMPTY）以有界退避重试。
- **canonical fresh package 已发布（2026-08-12）**：`out/SWPanel-win32-x64/resources/app.asar` 已原子 publish，**SHA-256 `f4c1bc7b59f3f7e6e148829a158ad43e133b0e27c1de730dee59eb4562d5f4b4`、size 2374410 bytes、totalEntries 204、closure 80 files、forbidden/missing/empty 0**；`npm run package:audit`（`.scratch/asar-audit-report.json`）**2026-08-12T11:29:16Z ok:true**，并已做独立 packaged-app smoke（PASS）。旧 12.8 MB 03:34 历史旧包只作历史记录，不作新证据。
- **新增并加固原子 `npm run make:win` installer 链（`scripts/make-win.mjs` → `scripts/installer.mjs`）**：
  - 与 package:win 共享同一跨进程 packaging lock（package:win 与 make:win 不能并发动 canonical `out`/`installers`）；
  - 持锁后立即 quarantine 旧 canonical `installers/`（`installers-invalid-*`），stale installer 永不当证据；
  - **prepare** 对当前 canonical `out/.../app.asar` 做 fresh ASAR audit + packaged-app smoke（不重新打包、不动 canonical `out`）；
  - **staging**：把 canonical package 复制到 `.scratch/installer-runs/<uuid>/out`（junction/symlink/reparse-point 递归 containment 校验，staged asar 与 prepared fingerprint 字节级校验）；
  - **make**：Forge `make --skip-package --platform=win32 --arch=x64 --targets squirrel` 在 per-run staging out 上运行；
  - **audit**：Squirrel `Setup.exe`（PE/MZ/“PE\0\0”/COFF machine i386 0x14c bootstrapper）、`RELEASES`（每行恰 `SHA1 FILENAME SIZE`，full.nupkg SHA-1/size 与磁盘一致）、`full.nupkg`（唯一 `lib/net45/resources/app.asar`，CRC-32/SHA-256/size 与 canonical 指纹匹配）、payload `lib/net45/SWPanel.exe`（x64 COFF machine 0x8664，PE/CRC 校验）；
  - **原子 publish + canonical re-audit/report**：audit 全过后才把 per-run squirrel 输出 rename 到 canonical root `installers/`，随后对 published canonical `installers/` 再做同一完整 audit；re-audit 或最终 report 失败则 rollback 回 per-run，report 写 ok:false（失败永不留下 stale success 或部分 installers）。
- **真实 `npm run make:win` PASS（2026-08-12T11:27-11:28Z）**：installer audit report（`.scratch/installer-audit-report.json`）**ok:true**（generatedAt 11:27:58Z、publishedAt 11:28:00Z），canonical `installers/` 含 `RELEASES`、`SWPanel-0.1.0 Setup.exe`（141,370,368 B）、`swpanel-0.1.0-full.nupkg`（140,618,144 B）；nupkg 内 `lib/net45/resources/app.asar` SHA-256 = `f4c1bc…`（与 canonical 一致，size 2374410）；payload `lib/net45/SWPanel.exe` machine 0x8664（x64）。随后 `npm run check` **exit 0**（root 现为 **10 files / 288 tests**，见第 13 节）。
- **canonical package blocker 与 installer creation/audit 仓库侧 blocker 均已关闭**。Phase 1 Exit Gate 已于 2026-08-12 判定 **PASS**（见第 5 节）；签名（signtool absent、code-signing cert 0）与 clean-Windows 离线 smoke 重分类为 **Phase 8 外部交付待办**（未执行、未通过），见第 5 节。

### 4.7 已验证与未验证划分小结

| 能力 | 源码已实现 | 单测/组件覆盖 | 最终 Gate 已验证 |
|---|---|---|---|
| workspaces / 构建 | ✅ | ✅ | ✅（`npm run check` exit 0，见第 13 节） |
| domain 不变量 | ✅ | ✅（32 tests） | ✅（随 `npm run check`） |
| contracts | ✅ | ✅（6 tests） | ✅ |
| Mock Repository / fixtures | ✅ | ✅（desktop 266 tests） | ✅（随 `npm run check`） |
| fixture timeline 因果性 | ✅ | ✅（13 scenarios 0 violations） | ✅（`npm run check:fixtures` + blocker 2 独立 PASS） |
| 14 路由 + browser 交互 | ✅ | ✅（browser 24/24） | ✅（2026-08-11 重跑通过） |
| a11y / 截图 | ✅ | ✅（8/8 routes、19 baselines） | ✅（16:19 重新生成，16:21 干净验证 24/24 + Axe） |
| Electron 安全壳（production app://swpanel + temp ASAR） | ✅ | ✅（production E2E 11/11） | ✅（dev smoke 1/1） |
| 原子 package 流程（仓库侧） | ✅ | ✅（packaging 单测 + scratch 真实 Forge/audit/smoke） | ✅（blocker 5 关闭） |
| **canonical fresh package** | ✅ | ✅（clean/package-win 单测） | ✅（2026-08-12 已原子发布：SHA `f4c1bc…`、size 2374410、closure 80、findings 0；`package:audit` 11:29:16Z ok:true + 独立 smoke PASS） |
| **installer 创建/审计（make:win 链）** | ✅ | ✅（installer 单测覆盖各失败阶段） | ✅（2026-08-12 真实 make:win PASS，canonical `installers/` report ok:true，post-publish canonical re-audit 通过） |
| **签名（Authenticode）** | ❌ 未接 | ❌ | **Phase 8 外部交付待办**（signtool absent；CurrentUser code-signing cert 0；不属于 Phase 1 验收条件，见第 5 节） |
| **clean-Windows 离线安装 smoke** | ❌ 未执行 | ❌ | **Phase 8 外部交付待办**（本机非 clean-Windows；未做 install/start/restart/uninstall 离线 smoke；不属于 Phase 1 验收条件，见第 5 节） |

---

## 5. Phase 1 Exit Gate 判定与历史 blocker 记录

### 5.1 当前判定（2026-08-12）：PASS

**Phase 1 Exit Gate = PASS（2026-08-12 正式判定）**，依据 `development-plan.md` §5 定义的正式验收条件逐项核对：

- 所有核心页面可通过真实路由进入 — ✅（browser 24/24，14 产品页参数化深链路由，`e2e/phase1.browser.spec.ts`）；
- 页面视觉与 TRAE Design 保持高一致性 — ✅（`.design` 视觉 Source of Truth；19 张精确尺寸 baseline 于 2026-08-11 16:19 UTC+8 重生成、16:21 干净验证 24/24 + Axe 0 violations）；
- 相同组件只维护一份 — ✅（`packages/ui` 共享组件，无复制静态 HTML）；
- 状态文案与领域状态一致 — ✅（status wording 集中化，由 `@swpanel/domain` 状态机统一驱动）；
- Mock 数据修改可以跨关联页面正确反映 — ✅（Mock Repository + 13 canonical scenario fixtures，单 RUNNING 等不变量在 fixture builder 强制）；
- 不存在真实后端依赖 — ✅（Phase 1 纯 Mock Repository，无真实 DB / Agent / SolidWorks）。

**Authenticode 签名与 clean-Windows 离线安装/启动/重启/卸载 smoke 不属于 Phase 1 Exit Gate 验收条件**，已重分类为 **Phase 8 外部交付待办**（见第 9 节 P8 行与第 12 节 todo）。二者均**未执行、未通过**，不得声称已通过；在 Phase 8 开始前补齐即可，不阻塞 Phase 2（Phase 2 已于 2026-08-12 启动）。

### 5.2 历史记录（2026-08-11/12，保留记录，不作重开）

以下内容为历史记录，不再代表当前状态。此前 Phase 1 Exit Gate 曾被判定为 **FAIL / externally blocked**——当时把签名与 clean-Windows 离线 smoke 等外部分发证据误视为 Phase 1 gate 前置项。2026-08-12 依据正式 Exit Gate 定义重新判定为 **PASS**（见 5.1），下列旧判定与旧 blocker 列表仅作历史记录：

Phase 1 Exit Gate 当前判定 **FAIL / externally blocked**。仓库侧证据（构建/单测/fixture/浏览器/生产 Electron/canonical fresh package/installer 创建与审计）已全部关闭，仅剩以下外部交付项阻止 PASS：

1. **canonical fresh package（已关闭）**：
   - 原子 package 流程仓库侧已完成（第 4.6 节）。**2026-08-12 已原子发布 canonical `out/SWPanel-win32-x64/resources/app.asar`**，SHA-256 `f4c1bc7b59f3f7e6e148829a158ad43e133b0e27c1de730dee59eb4562d5f4b4`、size 2374410、closure 80、forbidden/missing/empty 0；`npm run package:audit` 2026-08-12T11:29:16Z **ok:true**，并已做独立 packaged-app smoke（PASS）。**此 blocker 已关闭**。
2. **installer creation / audit（仓库侧，已关闭）**：
   - `npm run make:win` 原子链（共享锁、fresh canonical audit/smoke、staging skip-package、junction containment、Squirrel Setup/RELEASES/nupkg CRC/SHA/size、nupkg asar 匹配、payload SWPanel.exe x64、原子 publish + canonical re-audit/report）已实现并由单测覆盖。**2026-08-12 真实 make:win PASS**，canonical `installers/` report **ok:true**（11:27:58Z generated / 11:28:00Z published），post-publish canonical re-audit 通过。**此 blocker 已关闭**。
3. **外部交付 blocker（仍阻止 PASS）**：
   - **代码签名（Authenticode）未完成**：`signtool` 不存在于 PATH；`Cert:\CurrentUser\My` 中 **code-signing cert 数量为 0**（证书存储总条目 11，代码签名证书 0）。无授权签名证书与签名工具，因此不生成临时自签名证书冒充交付签名。
   - **clean-Windows 离线安装/启动/重启/卸载 smoke 未执行**：本机不是 clean Windows 环境，也未执行离线 install → start → restart → uninstall 全链路 smoke；安装/卸载属于机器状态变更，未获得授权执行。
   - SolidWorks 2022 环境不可用（本机 SolidWorks 2025）；`$solidworks-build-mechanical-models` 依赖未解析。这些属于真实外部交付/能力 blocker（Phase 5+）。

以下历史 blocker 均已关闭（保留记录，不作重开）：

- **clean build test workspace dist dependency（已关闭）**：`scripts/clean.mjs` 只清 workspace dist 不再清 Forge `out/`；`src/build-clean.test.ts`、`src/package-win.test.ts` 覆盖；`npm run build` 在 root out/app.asar 被锁时仍通过，`npm run check` 全绿（exit 0）。
- **full fixture timeline causality（已关闭）**：`npm run check:fixtures`（`fixtures/fixture-audit.report.test.ts` + `validate-timeline.ts`）13 个 canonical scenario 0 violations；blocker 2 独立 PASS。
- **production Electron E2E gap（已关闭）**：production Renderer 从 `file://`/`loadFile` 改为受限标准安全 `app://swpanel` 协议；`e2e/electron.production.spec.ts` 11/11 通过（含真实 temp ASAR 加载、恶意 dev-server/CLI 矩阵）；dev smoke 1/1。
- **screenshot baseline stale（已关闭）**：19 baselines 于 2026-08-11 16:19 UTC+8 用 Playwright 1.62.1 / Chromium 151.0.7922.34 重新生成，16:21 干净验证 24/24 + Axe 通过。
- **`.package-copy` 回流 / old locked out（已关闭）**：`scripts/packaging.mjs` 移除旧工作副本流程并加 `assertNoLegacyPackageCopy` guard（遗留目录存在即中止，永不自动删除/复用）；`.package-copy/` 已加入 `.gitignore`；当前工作树已无该目录。
- **production CSP 通配 + 未校验 env（已关闭）**：production CSP 仅 `connect-src 'self'`（无 `ws://127.0.0.1:*` 通配）；dev 仅唯一 CLI flag `--swpanel-development-renderer=http://127.0.0.1:5173/` 且 unpackaged 才生效，`SWPANEL_RENDERER_URL`/`SWPANEL_DEVELOPMENT_RENDERER`（任意大小写）完全不被读取；`security.ts` 对 CLI 参数做严格 allowlist（host/port/path 单一）。
- **canonical fresh package 未产出（已关闭）**：2026-08-12 已原子发布 canonical app.asar（SHA `f4c1bc…`、size 2374410、closure 80、findings 0），`package:audit` 11:29:16Z ok:true + 独立 smoke PASS；旧 root `out/app.asar` 锁不再阻止（新包已发布，旧包仅历史记录）。
- **installer creation / audit（已关闭）**：`npm run make:win` 原子链实现 + 单测覆盖，2026-08-12 真实 run PASS，canonical `installers/` report ok:true + post-publish canonical re-audit 通过。
- **dev toolchain audit findings（降级为非 Gate 项）**：`npm audit` 在 dev toolchain（`@electron-forge/*` 及传递依赖）仍有 findings（1 critical / 18 high / 3 low，历史 `.scratch/phase1-full-audit.json`），`fixAvailable` 不可用；production audit 0 findings。属于 dev-toolchain 备注，不作为 Phase 1 Exit Gate blocker。

**准确区分**：仓库侧 PASS（check exit 0、fixture 0 violations、production E2E 11/11、browser 24/24、canonical fresh package、installer 创建/审计）为真；签名与 clean-Windows 离线 smoke 未执行、未通过亦为真，但**二者不属于 Phase 1 Exit Gate 验收条件**，已重分类为 Phase 8 外部交付待办——因此 Phase 1 Exit Gate 判定为 **PASS（2026-08-12）**，Phase 2 已启动。不得声称签名 / clean-Windows 离线 smoke 已通过（见第 9 节 P8 行）。注意：不要把“实现代码未 commit/untracked”列为新的 Gate blocker（主 Agent 规则：不 commit 除非用户明确要求）；但它意味着 **Git revision 目前不可复现**，恢复清单已提醒（第 11 节）。

---

## 6. 已完成修复（当前工作树）

> 前 3 项为最初的三项修复；后续批次 A-E 追加的工作列在 4-9 项，批次 H（2026-08-12）追加的工作列在第 10-11 项（详见第 7 节与 Change Log）。

1. **dev-only pinned React refresh CSP**：
   - `security.ts`：`DEVELOPMENT_CONTENT_SECURITY_POLICY` 的 `script-src 'self' 'sha256-...'` 仅 pin 一个 React refresh preamble hash，dev CSP 允许该 hash、拒绝 `'unsafe-eval'`；生产 CSP 为 `'self'`。Electron smoke 断言此行为。
2. **production default M03/Q03 and sole RUNNING**：
   - `fixtures/scenarios.ts`：`PRODUCTION_DEFAULT_SCENARIO = "cost-report-generated"`——production 默认世界包含 M03 APPROVED + 成本报告 Q01/Q02/Q03，且唯一 RUNNING Run 为 secondary drawing C 的 cR02（main R05 仅为 COMPLETED），满足单 RUNNING 不变量。`repository-provider.tsx` 在 production 强制使用该默认 scenario。
3. **packaging ignore maps/declarations/cache**：
   - `forge.config.mjs` `PACKAGE_IGNORE_PATTERNS` 新增 `.map` / `.d.ts` / `.d.ts.map`、`.vite*` / `.eslintcache` / `.tsbuildinfo`、`.db*` / solidworks/CAD 业务文件等规则；`src/packaging.test.ts` 覆盖正反例。
   - **同时** reviewer 发现新 staging 回流问题（见第 5 节已关闭项：`.package-copy` 旧快照与 root 新配置不一致、旧 out 锁文件回流）。

后续批次（A-E）在批次执行中追加完成的新工作（见第 7 节与 Change Log）：

4. **production Renderer 改为受限 `app://swpanel` 协议**：production 不再用 `file://`/`loadFile`；`app` scheme 注册为 `standard` + `secure`，协议处理器做 canonical 路径 containment；production CSP 仅 `connect-src 'self'`。
5. **dev 仅唯一 CLI flag**：`--swpanel-development-renderer=http://127.0.0.1:5173/`（unpackaged 且严格 allowlist）；`SWPANEL_RENDERER_URL` / `SWPANEL_DEVELOPMENT_RENDERER`（任意大小写）完全被忽略。
6. **production Electron E2E + dev smoke**：`e2e/electron.production.spec.ts` 11/11（含真实 temp ASAR 加载与恶意 dev-server/CLI 矩阵）、`e2e/electron.smoke.spec.ts` 1/1。
7. **fixture timeline validator**：`fixtures/validate-timeline.ts` + `fixture-audit.report.test.ts`，`npm run check:fixtures` 13 scenarios 0 violations。
8. **原子 package 流程**：`scripts/package-all.mjs` / `packaging.mjs`（lock → legacy `.package-copy` guard → quarantine old out → build → per-run Forge package → fresh ASAR audit → smoke → 原子 publish）；Windows transient publish retry 有界退避；旧包永不复用。**2026-08-12 已产出 canonical fresh package**（SHA `f4c1bc…`、size 2374410、closure 80、findings 0，`package:audit` 11:29:16Z ok:true + 独立 smoke PASS）。
9. **screenshot baseline 重新生成**：19 baselines 于 2026-08-11 16:19 UTC+8（Playwright 1.62.1 / Chromium 151.0.7922.34）重新生成，16:21 干净验证 24/24 + Axe。
10. **原子 `npm run make:win` installer 链**：`scripts/make-win.mjs` / `installer.mjs`（与 package:win 共享 packaging lock → quarantine 旧 `installers/` → 对当前 canonical app.asar 做 fresh audit + smoke → staging 到 `.scratch/installer-runs/<uuid>/out`（junction containment、staged asar 指纹校验）→ Forge `make --skip-package` → Squirrel Setup/RELEASES/full.nupkg 审计（CRC/SHA/size、nupkg asar 匹配、payload SWPanel.exe x64）→ 原子 publish 到 canonical `installers/` → post-publish canonical re-audit → ok:true report；任一失败 rollback + ok:false）。**2026-08-12 真实 make:win PASS**（canonical `installers/` report ok:true，11:27:58Z generated / 11:28:00Z published）。
11. **canonical package + installer 仓库侧验收**：canonical app.asar fresh audit + 独立 packaged-app smoke PASS；`npm run check` 随后重跑 **exit 0**（root 现为 **10 files / 288 tests**，见第 13 节）。签名（signtool absent、code-signing cert 0）与 clean-Windows 离线 smoke 未执行，见第 5 节。

---

## 7. 批次状态与下一执行计划

原批次 A-G 中 A-E 已完成（详见 Change Log），F（独立 full gate）已给出 **FAIL/blocked** 判定，G（docs finalization）已完成。2026-08-12 新增批次 H（canonical package 固化 + installer 链 + 仓库侧验收），其中仓库侧项全部完成。**2026-08-12 批次 I：Phase 1 Exit Gate 正式判定 PASS（Owner scope decision，依据 `development-plan.md` §5 正式 Exit Gate），签名与 clean-Windows 离线 smoke 重分类为 Phase 8 外部交付待办；Phase 2 启动。** **2026-08-13 批次 J：Phase 2 WP0-WP7 全部执行完毕 + Phase 2 Exit Gate 正式判定 PASS（依据 `development-plan.md` §6 正式 Exit Gate）**。**2026-08-13 批次 K：Phase 3 P3-0..P3-6 全部执行完毕 + Phase 3 Exit Gate 正式判定 PASS（依据 `development-plan.md` §7 正式 Exit Gate）**。**2026-08-13 批次 L：Phase 4 P4-0..P4-6 全部执行完毕 + Phase 4 Exit Gate 正式判定 PASS（依据 `development-plan.md` §8 正式 Exit Gate，见第 16 节）**；Phase 5 为下一阶段、未开始（不启动）。**2026-08-14 批次 M：Phase 5 仓库侧 P5-1..P5-4 契约实现 substantially complete / in progress（十项 preflight 恒生效 + synthetic 默认、`PENDING_REVIEW` 原子发布默认、Codex App Server `0.147.0` / protocol v2 契约钉定、ownership-safe Cancel 与低 Stage 钉定恢复），**Exit Gate 未 PASS（不越报）**，见第 17 节。** **2026-08-14 批次 N：SolidWorks 版本硬门移除（availability/automation 门 + 实际版本记录）、preflight 报告 v2 九项、`$solidworks-build-mechanical-models` 保留为非阻塞 prose；外部 `.agents`/`.codex` skill copies 同步（digest `3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`）；Codex 0.147.0 `initialize`+`skills/list` live smoke 成功并发现两个精确副本；shell-free live stdio transport/lifecycle 与真实 preflight/PDF adapter 已实现但处于最终验证中（全量 check 在最新并发 preflight/PDF 集成前通过，最终重跑待办，不声称当前全绿）；获批 PDF 以 300 DPI / pypdfium2 4.30.0 真实栅格化 4963×3509（源/输出哈希、`productionVerified: false`、产物留在 temp/仓库外）；本机 SolidWorks 2025 33.0.0.5050 安装但 availability 门当前 FAILS（COM 与直接启动均在 AMD `atio6axx.dll` 31.0.12042.4 `0xc0000005` 崩溃，本地 CXPD dump 证据），获批图纸 HIL 未启动；**Exit Gate 保持 NOT PASS**，见第 17 节。** **2026-08-14 批次 O：最终复核与 live 接线收口——live Codex skill 目录→`SKILL.md` 校验通过、live Runner 接线 owned Codex adapter + 真实 PDF adapter（`live-codex-wiring.ts`，`ownsAgent: true`）、async ownership-safe SolidWorks live probe 实现并实测（本机 `available:false` / `installedVersion` 33.0.0.5050 / owned 进程已关闭 / 无残留进程 / attach 错误不再 spawn）、probe 版本写入 prompt 并在 ArtifactValidator 精确校验；**最终全量重跑在当前树通过**（`npm run check` exit 0：root 10/291、desktop 31/572、runner 37/691、contracts 13/148、domain 14/70、ui 6/43；`check:fixtures` 1/1 零 violations；`test:e2e` 20/20 + 51/51，日志 `.scratch/check-p5-final.log` / `check-fixtures-p5-final.log` / `test-e2e-p5-final.log`），"最终重跑待办"语言已移除、计数已钉定；native Codex smoke 通过；**Exit Gate 保持 NOT PASS**（获批图纸建模未启动、availability 门 FAILS、`productionVerified` 恒 false），见第 17 节。** **2026-08-15 批次 P：三次获批链 HIL 尝试均未完成——第一次真实 Runner Run 如实 FAILED `AGENT_PROTOCOL_INCOMPATIBLE`（根因：原生 Codex 0.147.0 拒绝实验性 `thread/start.runtimeWorkspaceRoots`，已移除 gated 字段，稳定 thread start = `cwd` + `sandbox:"workspace-write"` + `turn/start.sandboxPolicy` attempt-root 包含，live preflight 含无害真实 `thread/start`），第二次真实 Runner Run 如实 FAILED `AGENT_RUNTIME_UNAVAILABLE`（adapter 曾丢弃原生 `turn.error.message`——失败回合诊断保留已修复：确定性脱敏 ≤512 字符仅入技术 `runtime/agent-session.json` note、产品码保持通用、harness 1.0.2 仅白名单 status/adapter/protocol + 有界 note 复制为 `14-agent-session-diagnostic.json`、`skill.resolvedPath` 绝对路径校验），第三次在 `Runner.open` 前停止（SolidWorks probe fail-closed）；SolidWorks COM probe 重设计为有界 Python/pywin32 `GetActiveObject`（PowerShell 仅 registry/文件版本发现，PowerShell `GetActiveObject` 曾是 `TYPE_E_ELEMENTNOTFOUND` 假阴性源）；主机状态动态（前两次 `available:true`/`33.0.0`/`owned-process-proven`，21:42 owned 启动 COM 注册前退出——`21-solidworks-startup-diagnostic.json`：default 与两个 Rx session-safe 模式均 ~3–4 s `0xC0000005`，不结论性归因 AMD/atio6axx）；owned 早退修复（稳定 reason `owned-process-exited`、`22-solidworks-probe-after-early-exit-fix.json` 窄证据）；修复后仅聚焦验证重跑（probe 41/41、Runner 38 files/738、typecheck/lint/build 通过），2026-08-14 全仓库 check/fixtures/E2E 保持历史未重跑；**Exit Gate 保持 NOT PASS**，见第 17 节。** **2026-08-15 批次 Q：当前工作树全新全量验证（2026-08-15）**——`npm run check` **exit 0**（typecheck、仓库 lint、全部测试与完整 build 全绿：root 10/291、desktop 31/572、runner **38 files/738 tests**、contracts 13/148、domain 14/70、ui 6/43）；`npm run check:fixtures` **1/1 通过**（13/13 canonical scenarios、0 violations、RESULT PASS）；`npm run test:e2e` **顺序通过 exit 0**（production Electron **20/20**、browser + Electron smoke **51/51**）。**本批次仅取代批次 P 中"fresh full rerun pending / 未在最新改动后重跑"的验证范围陈述**，不改变 HIL 事实、SolidWorks 主机事实与 Phase 5 Exit Gate NOT PASS 结论；canonical package/installer 未刷新；**Exit Gate 保持 NOT PASS**，见第 17 节与第 13 节 A9。 **2026-08-18 批次 R：Phase 8 — Recovery / Hardening / Packaging 实施 + 正式 Exit Gate 判定 PASS**（12.1 中断恢复 / 12.2 通知 / 12.3 删除 / 12.4 安全 / 12.5 测试 / 12.6 打包）：`npm run check` exit 0（root 10/291、desktop 38/660、runner 44/905、contracts 14/214、domain 16/110、ui 7/50，129 files / 2,230 tests）、`check:fixtures` 1/1 零 violations、`test:e2e` 顺序通过（production Electron 20/20、browser+smoke 59/59，含 `phase8.browser.spec.ts` 3/3）、`npm run package:win` 从当前树重新发布 canonical 包（SHA-256 `743bbf…`、4,763,426 B、totalEntries 382、closure 160、forbidden/missing/empty 0；fresh ASAR audit ok:true + 独立 packaged-app smoke PASS）；打包验证发现并修复 `forge.config.mjs` 未忽略 `*.tsbuildinfo` basename（根 `tsconfig.build.tsbuildinfo` 曾随包发布并致 fresh audit 失败）、并新增可选 env `SWPANEL_ELECTRON_ZIP_DIR`（仅设置时生效）使打包在 Electron 发布主机不可达/抖动时离线确定性复用本地 zip；**Phase 8 Exit Gate = PASS（2026-08-18，见第 22 节）**；Authenticode 签名与 clean-Windows 离线 smoke 保持**需授权外部交付待办**（未执行、未通过、未虚报）。

| 批次 | 任务 | 状态 | 退出条件 |
|---|---|---|---|
| **A** | clean-check test resolution | ✅ 完成 | `npm run check` 全绿 exit 0，统计见第 13 节 |
| **B** | fixture validator / timeline | ✅ 完成 | `npm run check:fixtures` 13/13 scenarios 0 violations，blocker 2 关闭 |
| **C** | production `app://swpanel` Electron E2E + CSP/url 硬化 | ✅ 完成 | production E2E 11/11 + dev smoke 1/1，blocker 3、6 关闭 |
| **D** | package allowlist / `.package-copy` 移除 + 原子 package 链 | ✅ 完成 | legacy guard 生效、原子 package 链全绿；blocker 5 关闭 |
| **E** | screenshot baseline 重新生成 | ✅ 完成 | 19 baselines 16:19 UTC+8 重新生成，16:21 干净验证 24/24 + Axe；blocker 4 关闭 |
| **F** | independent full gate | ✅ 完成（**FAIL/blocked**） | Phase 1 Exit Gate 正式判定：**FAIL**（当时仅剩 canonical fresh package + 外部分发证据） |
| **G** | docs finalization | ✅ 完成 | 三份文档一致，Change Log 追加 |
| **H** | canonical fresh package + `make:win` installer 链 + 仓库侧验收 | ✅ 完成（仓库侧） | canonical app.asar 已发布（SHA `f4c1bc…`、size 2374410、closure 80、findings 0，`package:audit` 11:29:16Z ok:true + 独立 smoke PASS）；真实 make:win PASS，canonical `installers/` report ok:true + post-publish canonical re-audit 通过；`npm run check` 随后 exit 0（root 10 files/288 tests）。canonical package blocker 与 installer creation/audit 仓库侧 blocker 关闭 |
| **I** | Phase 1 Exit Gate 正式判定 + Phase 2 启动（2026-08-12，Owner scope decision） | ✅ 完成 | 依据 `development-plan.md` §5 正式 Exit Gate 六项条件全部满足，判定 **PASS**；签名与 clean-Windows 离线 smoke 重分类为 **Phase 8 外部交付待办**（未执行、未通过，不虚报）；Phase 2 启动 |
| **J** | Phase 2 WP0-WP7 执行 + Phase 2 Exit Gate 正式判定（2026-08-13） | ✅ 完成 | WP0-WP7 全部实现并由 2026-08-13 当日证据验证：`npm run check` exit 0（root 10 files/289、desktop 24 files/444、runner 8 files/91、contracts 4 files/36、domain 10 files/35、ui 6 files/43）、fixtures 13/13 零 violations、browser + Electron smoke 35/35、production Electron 14/14、`package:audit` ok:true。依据 `development-plan.md` §6 正式 Exit Gate（无 Agent 完成图纸管理全流程；关闭并重启后数据仍在）判定 **PASS**。真实第二账户 pipe 拒绝测试未执行（单账户主机，DACL 读回证据 + 人工安全跟进），签名/clean-Windows smoke 仍为 Phase 8 外部待办 |
| **K** | Phase 3 P3-0..P3-6 执行 + Phase 3 Exit Gate 正式判定（2026-08-13） | ✅ 完成 | P3-0..P3-6 全部实现并由 2026-08-13 当日证据验证：`npm run check` exit 0（root 10 files/289、desktop 29 files/557、runner 12 files/235、contracts 4 files/47、domain 12 files/51、ui 6 files/43）、fixtures 13/13 零 violations、`npm run test:e2e` exit 0（production Electron 18/18、browser + smoke 49/49，含新增 `phase3.browser.spec.ts` 14/14）。依据 `development-plan.md` §7 正式 Exit Gate（Fake Executor 可靠演示所有 Run 状态、6 Stage、队列、取消和恢复 UI）判定 **PASS**。真实第二账户 pipe 拒绝测试未执行（人工安全跟进）、签名/clean-Windows smoke 仍为 Phase 8 外部待办；`run.create` 同 Revision 幂等（30 分钟 TTL 返回旧 Run）作为待决策风险记录，未在本批次擅自修改契约 |
| **L** | Phase 4 P4-0..P4-6 执行 + Phase 4 Exit Gate 正式判定（2026-08-13） | ✅ 完成 | P4-0..P4-6 全部实现并由 2026-08-13 当日证据验证：`npm run check` exit 0（root 10 files/289、desktop 29 files/557、runner 18 files/309、contracts 13 files/141、domain 13 files/59、ui 6 files/43）、fixtures 13/13 零 violations、`npm run test:e2e` exit 0（production Electron **20/20**、browser + smoke **51/51** = phase1 24 + phase2 10 + phase3 14 + phase4 2 + smoke 1，含新增 `phase4.browser.spec.ts` 2/2）。依据 `development-plan.md` §8 正式 Exit Gate（不调用真实 SolidWorks 的测试 Executor 下 Prompt、事件、Clarification、Manifest 协议完整端到端工作）判定 **PASS**。**不声称**真实 PDF/DWG/DXF 生产转换（全部 synthetic `productionVerified: false`、DWG/DXF `-test-only`）与真实 SolidWorks/Codex 集成；审查修复 M1/M2 落地并复验。Phase 5 为下一阶段、未开始（外部硬阻塞不变） |
| **M** | Phase 5 仓库侧 P5-1..P5-4 契约实现（2026-08-14） | ✅ 完成（见批次 O 最终验证） | P5-1 preflight 门恒生效（后由批次 N 更新为九项 v2）+ synthetic `synthetic: true` 默认；P5-2 `PENDING_REVIEW` Model 原子发布（产品默认）；P5-3 Codex App Server `0.147.0` / protocol v2 契约钉定（后由批次 N 更新：live stdio transport 已实现 + live smoke 成功）；P5-4 ownership-safe Cancel + 低 Stage 钉定恢复（仅契约测试）。**Exit Gate 未 PASS**：2026-08-14 验证快照（14:12–14:50：check exit 0、fixtures 干扰后顺序重跑 1/1 全绿、e2e 顺序通过 20/20 + 51/51 全绿、model-detail baselines 有意刷新）早于 P5 批次落地（16:34–18:16）且早于最新并发 preflight/PDF 集成（21:55–22:48）；单测计数不钉定（见第 13/17 节） |
| **N** | Phase 5 进展批次：SolidWorks 版本硬门移除 + preflight v2 九项 + live Codex smoke + 真实 preflight/PDF adapter（2026-08-14） | ✅ 完成（见批次 O 最终验证） | SolidWorks availability/automation 门（版本记录不硬匹配）；preflight 报告 v2 九项；`$solidworks-build-mechanical-models` 非阻塞 prose；`.agents`/`.codex` skill copies 同步（digest `3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`）；Codex 0.147.0 `initialize`+`skills/list` live smoke 成功（发现两个精确副本）；shell-free live stdio transport/lifecycle 与真实 preflight/PDF adapter 已实现但**处于最终验证中**（全量 check 在集成前通过、最终重跑待办、不声称当前全绿）；获批 PDF 300 DPI 栅格化 4963×3509（`productionVerified: false`、temp/仓库外）；SolidWorks 2025 33.0.0.5050 availability 门当前 FAILS（AMD `atio6axx.dll` 31.0.12042.4 `0xc0000005`、CXPD dump 证据）；获批图纸 HIL 未启动。**Exit Gate 保持 NOT PASS** |
| **O** | Phase 5 最终复核 + live 接线收口（2026-08-14）：live Codex skill 目录→`SKILL.md` 校验通过；live Runner 接线 owned Codex adapter + 真实 PDF adapter；async ownership-safe SolidWorks live probe 实现并实测；probe 版本写入 prompt + ArtifactValidator 精确校验；当前树最终全量重跑全绿 | ✅ 完成 | live Codex native smoke 通过（`initialize`+`skills/list`，`available:true`/version `0.147.0`/protocol `2`/`skillPathVerified:true`/childClosed）；live Runner 接线（`live-codex-wiring.ts`：每 Runner 恰一个持久 child transport、`ownsAgent:true` 关闭时回收）；SolidWorks live probe 本机实测 `available:false`/`installedVersion` 33.0.0.5050/owned 进程已关闭/无残留进程/attach 错误不再 spawn；`npm run check` exit 0（root 10/291、desktop 31/572、runner 37/691、contracts 13/148、domain 14/70、ui 6/43）、`check:fixtures` 1/1 零 violations、`test:e2e` 20/20 + 51/51（`.scratch/check-p5-final.log` 等）；**Exit Gate 保持 NOT PASS**（获批图纸建模未启动、availability 门 FAILS），见第 17 节 |
| **P** | Phase 5 现场 HIL 批次（2026-08-15）：三次获批链尝试均未完成 + 失败回合诊断保留 + SolidWorks COM probe 重设计 + owned 早退修复 | ✅ 完成（尝试均未通过） | 三次获批链尝试如实记录（`.scratch/hil-20260815-142334-52f26231` 真实 Runner Run FAILED `AGENT_PROTOCOL_INCOMPATIBLE`——原生 Codex 0.147.0 拒绝实验性 `thread/start.runtimeWorkspaceRoots`，已移除；`.scratch/hil-20260815-144823-3836c9fc` 真实 Runner Run FAILED `AGENT_RUNTIME_UNAVAILABLE`——失败回合诊断保留已修复；`.scratch/hil-20260815-214252-393c22d8` 在 `Runner.open` 前停止）；SolidWorks COM probe 重设计（Python/pywin32 `GetActiveObject`，PowerShell 仅 registry/文件版本发现）；主机动态 + `21-solidworks-startup-diagnostic.json`（default 与两个 Rx session-safe 模式均 ~3–4 s `0xC0000005`，不结论性归因 AMD/atio6axx）；owned 早退修复（`owned-process-exited` 稳定 reason、`22-solidworks-probe-after-early-exit-fix.json` 窄证据）；修复后聚焦验证（probe 41/41、Runner 38 files/738、typecheck/lint/build 通过），2026-08-14 全仓 check/fixtures/E2E 保持历史未重跑；**Exit Gate 保持 NOT PASS**（无成功 `.SLDPRT` + 六 Artifact + Model、无真实 Clarification 场景、无 ownership-safe 取消 HIL）；不 commit/push、不进入 Phase 6，见第 17 节 |
| **Q** | 当前工作树全新全量验证快照（2026-08-15） | ✅ 完成 | `npm run check` exit 0（root 10/291、desktop 31/572、runner 38/738、contracts 13/148、domain 14/70、ui 6/43；typecheck/仓库 lint/全部测试/完整 build 全绿）、`check:fixtures` 1/1 零 violations RESULT PASS、`test:e2e` 顺序通过（production Electron 20/20、browser+smoke 51/51）；**仅取代批次 P 的"未重跑"验证范围陈述**，HIL 事实与 Exit Gate NOT PASS 不变；canonical package/installer 未刷新（见第 13 节 A9） |
| **R** | Phase 8 — Recovery / Hardening / Packaging 实施 + Phase 8 Exit Gate 正式判定（2026-08-18） | ✅ 完成 | 依据 `development-plan.md` §12（12.1-12.6）研发侧正式 Exit Gate（完成可重复执行的本地验收流程、全新测试环境可按文档启动）判定 **PASS**。验证：`npm run check` exit 0（root 10/291、desktop 38/660、runner 44/905、contracts 14/214、domain 16/110、ui 7/50，129 files / 2,230 tests）、`check:fixtures` 1/1 零 violations、`test:e2e` 顺序通过（production Electron 20/20、browser+smoke 59/59 含 `phase8.browser.spec.ts` 3/3；Phase 8 改动 drawing-costs/cost-report/run-detail/settings 四张 1920×1080 baseline 有意刷新并干净复验）、`package:win` 重新发布 canonical 包（SHA-256 `743bbf…`、4,763,426 B、382 entries、closure 160、findings 0；audit ok:true + 独立 smoke PASS；修复 `tsconfig.build.tsbuildinfo` 随包发布缺口 + 新增可选 `SWPANEL_ELECTRON_ZIP_DIR` 离线打包）。Authenticode 签名与 clean-Windows 离线 smoke 保持**需授权外部交付待办**（未执行、未通过、未虚报）；详见第 22 节 |

**Phase 3 执行状态（2026-08-13 收口）**：P3-0→P3-6 已全部执行完毕（实现摘要与证据见第 15 节），Phase 3 Exit Gate 已于 **2026-08-13 正式判定 PASS**。**Phase 4 执行状态（2026-08-13 收口）**：P4-0→P4-6 已全部执行完毕（实现摘要与证据见第 16 节），Phase 4 Exit Gate 已于 **2026-08-13 正式判定 PASS**。**Phase 5（Agent Runner + SolidWorks Skill）是唯一未 PASS 的阶段，正在进行中（Exit Gate 保持 NOT PASS；Phase 6/7/8 研发侧均已 PASS，见第 20/21/22 节）**——三次 2026-08-15 获批链尝试均未完成且之后无新 HIL；不要越报 Phase 5，除已获授权的 SolidWorks 版本措辞同步外不要扩大外部 Skill 修改范围。**Phase 8 已于 2026-08-18 正式判定 PASS（见第 22 节）**，`development-plan.md` 的 Phase 0-8 研发侧实施全部完成；剩余外部项为 Phase 5 HIL（需可驱动 SolidWorks/获批图纸）与 Phase 8 外部交付待办（Authenticode 签名、clean-Windows 离线 smoke——需授权，未执行、未通过、未虚报）。

**下一 session 待办（代替旧批次）**：

1. **Phase 5（当前阶段，进行中）**：`development-plan.md` §9 的 Agent Runner + SolidWorks Skill Integration。**仓库侧 P5-1..P5-4 契约实现完成并最终验证**：九项 preflight 门（报告 v2）恒生效——SolidWorks version-agnostic（availability/automation 门 + 实际版本记录）、`$solidworks-build-mechanical-models` 非阻塞 prose——默认 synthetic fixture（`synthetic: true`）；`PENDING_REVIEW` Model 原子发布（产品默认）；Codex App Server `0.147.0` / protocol v2 契约钉定 + shell-free live stdio transport 已实现并最终验证 + native `initialize`/`skills/list` smoke 通过（**skill 目录→`SKILL.md` 精确路径校验通过**，两个精确外部 skill copies，digest `3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`）；**live Runner 已接线 owned Codex adapter + 真实 PDF adapter**（`live-codex-wiring.ts`，`ownsAgent: true`）；**async ownership-safe SolidWorks live probe 已实现并实测**（本机 `available:false` / `installedVersion` 33.0.0.5050 / owned 进程已关闭 / 无残留进程 / attach 错误不再 spawn）；**probe 版本写入 prompt 并在 ArtifactValidator 精确校验**；ownership-safe Cancel 与低 Stage 钉定恢复（仅契约测试，从未 HIL 验证）。**最终全量重跑已于当前树完成并全绿**（`npm run check` exit 0：root 10/291、desktop 31/572、runner 37/691、contracts 13/148、domain 14/70、ui 6/43；`check:fixtures` 1/1 零 violations；`test:e2e` 20/20 + 51/51；日志 `.scratch/check-p5-final.log` / `check-fixtures-p5-final.log` / `test-e2e-p5-final.log`）——"最终重跑待办、不声称当前全绿"语言已移除、单测计数已钉定（2026-08-14 全量重跑为历史记录）。**2026-08-15 当前工作树全新全量验证已通过**（`npm run check` exit 0：root 10/291、desktop 31/572、runner **38 files/738 tests**、contracts 13/148、domain 14/70、ui 6/43；`check:fixtures` 1/1 零 violations RESULT PASS；`test:e2e` 顺序通过：production Electron 20/20 + browser/Electron smoke 51/51；见第 13 节 A9——仅取代此前"未在最新改动后重跑"的验证范围陈述，HIL 事实与 Exit Gate NOT PASS 不变；canonical package/installer 未刷新）。**Exit Gate 判 PASS 前仍需外部项**：**可驱动的 SolidWorks 环境**（2025 33.0.0.5050 已安装且 COM 已注册但当前不可驱动——`21-solidworks-startup-diagnostic.json`：default 与 `/ForceSoftwareOGL /SWDisableExitApp`、`/SWSafeMode /SWDisableExitApp` 均 ~3–4 s `0xC0000005` 退出；不结论性归因 AMD/atio6axx；availability 门当前 FAILS）；真实 skill hash 校验（外部副本已同步为 digest `3d4bfbc9…`）；live Codex 全链路验证（非 HIL）；**HIL**（成功 `.SLDPRT` + 六 Artifact + Model（`PENDING_REVIEW`）、真实 Clarification 场景、ownership-safe Cancel、低 Stage 恢复、blocker 图纸证明未在澄清前启动 SolidWorks——三次 2026-08-15 获批链尝试均未完成）。按主 Agent 拆分派发，每批保持可编译、可测试；不越 Gate 进入 Phase 6。**Exit Gate 未 PASS，不越报。**
2. **真实转换验证（Phase 5+/外部，未通过不虚报）**：PDF/DWG/DXF adapter 需获批生产图纸验证后才能声称生产可用；在此之前一切转换保持 synthetic（`productionVerified: false`）。
3. **Named Pipe 人工安全跟进（WP4 遗留）**：真实第二 Windows 账户 pipe 拒绝访问测试**未执行**（本机为单账户主机）。跟进方式：以账户 A 运行 SWPanel，以账户 B 尝试连接/读取 Runner pipe，确认被拒绝；证据必须显示 DACL 恰为 {A 的 SID, SYSTEM}。DACL 读回证据已证明 ACE 集（见第 8 节），但**该项不得虚报为已通过**，保持为人工安全跟进项。
4. **代码签名（Phase 8 外部交付待办）**：获取/授权 Authenticode 签名证书与工具（当前 `signtool` absent、`Cert:\CurrentUser\My` code-signing cert 0）后，接入 Forge/签名配置，验证 EXE/installer 的 Authenticode 状态并记录证据；若无授权签名条件，保留为外部待办，不生成临时自签名证书冒充交付签名。**此项未执行、未通过，未声称已通过。**
5. **clean-Windows 离线安装/启动/重启/卸载 smoke（Phase 8 外部交付待办）**：在干净 Windows 测试机执行离线 install → start → 核心路由 → restart → uninstall 全链路 smoke，记录 OS、安装器哈希与结果，并确认 uninstall 不误删业务数据目录；本机当前非 clean-Windows，该项未执行。**此项未执行、未通过，未声称已通过。**
6. **（已完成，可选剩余项）canonical package/installer 刷新**：`npm run package:win` 已于 2026-08-18 从当前 Phase 8 树重新发布 canonical `out/.../app.asar`（**最新源码证据，SHA-256 `743bbf…`、size 4,763,426 B、audit ok:true**，见第 22 节）；canonical `installers/` 仍为 2026-08-12 make:win 产物（非最新源码证据）——**如需**最新可分发安装器，基于当前工作树重跑 `npm run make:win` 并记录新哈希；在此之前不得把 2026-08-12 的安装器哈希当作最新源码证据。

**恢复提醒**：本工作树全部实现代码未 commit（`git status` 全为未跟踪/已修改文件，见第 11 节）。这按规则不列为 Gate blocker，但意味着当前 Git revision **不可复现**——不要假定任何 revision 能重建出上面的 canonical 产物。

---

## 8. Phase 2 已设计 Backlog 摘要与完成状态

Phase 2 — Persistence and Drawing Workflow（**2026-08-12 启动，2026-08-13 全部 WP 完成并 Exit Gate PASS**；正式 Exit Gate 定义见 `development-plan.md` §6：无 Agent 完整执行图纸管理流程，关闭并重启后数据仍存在）。以下工作包全部**已实现**并有 2026-08-13 当日验证证据（统计见第 13 节快照）：

- **WP0** Domain / contracts（✅ 完成）：为持久化补齐 Drawing/Revision/Facts/Feedback 的 repository 边界与命令/查询合约；上传图纸不得自动创建 Modeling Run 的不变量保留在合约与测试中。
- **WP1** SQLite WAL（✅ 完成）：Runner 内 `node:sqlite`（Node 24 内置）实现 WAL journal mode、`synchronous=NORMAL`、`busy_timeout`、foreign keys、迁移版本表、显式事务封装；Runner 是唯一 DB 写入者（`apps/runner/src/db/`）。
- **WP2** NTFS ledger（✅ 完成）：不可变 Drawing/Revision/Artifact 文件账本（`apps/runner/src/ledger/drawing-file-ledger.ts`）：原文件字节保留、generated-ID 目录、复制后 SHA-256/size 校验、相对路径入库、PDF/DWG/DXF allowlist、canonical path containment、绝对路径/junction/symlink 逃逸拒绝、Unicode 路径、缺失文件结构化错误（不静默忽略）、保守 allowlist 删除（显式调用、current pointer 保护、事务化元数据、已缺失文件按"already gone"处理）。
- **WP3** use cases（✅ 完成）：Drawing 工作流应用服务（`apps/runner/src/service/drawing-workflow-service.ts`）：创建 Drawing + 首 Revision、新增 Revision、current revision 原子切换、Revision Facts / Modeling Feedback、历史查询、重开数据库数据仍在；文件写入与 DB 失败时补偿清理；全程不创建 Run。
- **WP4** named pipe（✅ 完成）：Windows Named Pipe IPC（`apps/runner/src/ipc/`）：协议版本 v1 握手、server 实例身份、request ID + idempotency key、schema 校验、最大消息尺寸、严格 allowlist query/command、无通用命令端点；pipe 名只含用户隔离标识 + 随机实例标识，不含业务数据。
- **WP5** Electron bridge（✅ 完成）：Main 侧 typed Preload API（`apps/desktop/src/preload/preload.cts` + `apps/desktop/src/main/bridge/bridge-contract.ts`）：冻结的 `window.swpanel`（metadata/health/files/drawings/storage），仅 16 个 allowlisted channel（`MAIN_CHANNELS`），绝不暴露 `readFile(path)` / `spawn(command)` / 任意 IPC channel；文件选择只返回一次性 token + 元数据，Renderer 拿不到绝对源路径。
- **WP6** async renderer（✅ 完成）：Renderer 从 Mock Repository 切换为经 bridge 订阅 Runner 快照的异步 repository（`apps/desktop/src/renderer/features/bridge-repository/`，loading/error/data 状态）；Drawing Library / Overview / Revision / Memory / Settings 页面接真实数据；结构化错误（缺失文件、重复图号、非法格式、持久化失败）与可恢复 UI；Mock Repository 保留为测试/开发 fixture adapter。
- **WP7** integration gate（✅ 完成）：`e2e/phase2.browser.spec.ts`（10 tests，显式 fake bridge）+ `e2e/electron.production.spec.ts` 扩展（14/14）覆盖：上传 fixture 图纸 → 创建 Drawing/首 Revision → 新增 Revision → 切换 current revision → 新增 Fact/Feedback → 查看历史；上传不产生 Modeling Run；退出并重启 Electron/Runner 后数据与文件仍在；模拟源文件缺失并验证显式错误；测试数据根与正式 runtime 数据严格隔离。

**Named Pipe ACL 证据（WP4）——已提供**：`architecture.md` §12.1 的 "current-user-only ACL" 声明现已由实现与测试证据支撑：

- `apps/runner/src/ipc/pipe-acl-windows.ts`：Node 无公开 API 给 named pipe 设置 DACL（Node 24 已移除公开 `dlopen`），本机 `icacls \\.\pipe\...` 报 error 87 无法寻址 named pipe（如实记录，不声称 icacls 可用）。实现采用最小 Windows 专用 helper：PowerShell `-EncodedCommand`（UTF-16LE base64，不写临时文件、asar 内可用）P/Invoke `SetSecurityInfo(SE_KERNEL_OBJECT, DACL|PROTECTED_DACL)` 把 live pipe DACL 替换为恰 {current user SID, SYSTEM (S-1-5-18)} 两个 `FILE_ALL_ACCESS` ACE（PROTECTED 去除继承），然后 `GetSecurityInfo` 读回校验；支持只读证据模式（`READ_CONTROL`）捕获当前 DACL 写原始证据文件。
- 严格校验（`apps/runner/src/ipc/acl.ts`）：读回 ACE 必须恰为 current user + SYSTEM、无任何其它 ACE（Everyone / ANONYMOUS LOGON / Authenticated Users / BUILTIN\Users / BUILTIN\Administrators 及任何多余 SID 均拒绝），否则报告 `WINDOWS_ACL_FAILED`，Runner 绝不声称一个无法证明的 ACL。
- 失败关闭（`apps/desktop/src/main/runner-host/runner-host.ts`）：win32 上声称真实 Windows pipe 的 server 必须报告 `WINDOWS_ACL_APPLIED`，缺失/null/失败一律 `PIPE_ACL_FAILED` 拒绝启动、拆除半启动栈、健康状态 FAILED，**无静默回退到 Mock Repository**；测试替身必须显式声明 `claimsWindowsPipe: false` 才豁免。
- live 证据测试（`apps/runner/src/ipc/live-pipe.test.ts`）：真实 pipe 启动 → 严格 DACL 校验（恰 2 个 ACE：owner SID + S-1-5-18）→ 只读模式原始证据写盘且与已应用 DACL 逐字节一致 → 裸 `net.Socket` 真实线上握手 + 查询 → ACL 探测连接（只开 pipe 不写）作为 no-op 被容忍、不拆服务器。
- **真实性限制（人工安全跟进项）**：本机是**单账户主机**，**真实的第二 Windows 账户 pipe 拒绝访问测试未执行**。可证明的是 DACL 读回证据（ACE 集恰为 current user + SYSTEM，无 Everyone/ANONYMOUS），安全边界不依赖 pipe 名难猜。双账户拒绝测试是**人工安全跟进项**（账户 A 运行、账户 B 尝试连接必须被拒），**不得虚报为已通过**（见第 7 节待办 2 与第 13 节快照）。

**canonical package/installer 新鲜度（2026-08-13，勿混用证据）**：2026-08-12T18:11:09Z（本机 08-13 02:11 UTC+8）原子发布过一版 canonical `out/SWPanel-win32-x64/resources/app.asar`（SHA-256 `cf1719…`、size 2,696,001 B、totalEntries 229），`npm run package:audit`（`.scratch/asar-audit-report.json`）**2026-08-12T19:35:31Z ok:true**（closure 100 files、forbidden/missing/empty 0，含 runner dist），其后 2026-08-13 收口批仍对 WP6/WP7 源码做了最后硬化并重跑 `npm run check`（见第 13 节），**未再重新 `package:win`**；canonical `installers/` 仍是 2026-08-12 的 make:win 产物。因此该包**可能滞后于最新 WP6/WP7 源码**，其哈希**不得当作最新源码证据**；需要最新可分发产物时基于当前工作树重跑 `npm run package:win`（可选 `make:win`）。

---

## 9. Phase 3-8 简明计划与真实外部硬阻塞

| Phase | 计划要点 | 真实外部硬阻塞（Phase 5+） |
|---|---|---|
| **P3** Modeling Run Orchestrator | **✅ 已完成（2026-08-13 Exit Gate PASS，见第 15 节）**：不可变 Run Snapshot、6 Stage/Status 分离、单机串行队列 + 原子 claim + lease/heartbeat + 事件单调序列 + UI 重连；Fake Executor 全场景矩阵；cancel 只清 allowlist 文件；不创建 Model（model-less COMPLETED）；中断/恢复（RECOVERY_UNSUPPORTED/RECOVERY_FAILED/RESUME）；测试专用执行器配置（unpackaged-only）。 | — |
| **P4** Input Adapter + Agent Contract | **✅ 已完成（2026-08-13 Exit Gate PASS，见第 16 节）**：版本化 JSON Schema（IPC envelope、Invocation Package、Runtime Metadata、Product Events、Clarification、Error、Result Manifest + Input Adaptation，`PHASE4_SCHEMAS` 注册表 + 无依赖严格验证器）；Input Adapter 接口 + deterministic fake adapters（8 场景）；**PDF 不静默选页**（多页无显式选择即 `PAGE_SELECTION_REQUIRED` 失败关闭，单页路径不发明页断言）；**DWG/DXF 显式 `-test-only`、全部合成成功 `productionVerified: false`，未验证不得假称生产可用**；受控 Prompt Template `2026.08-p4` + 校验过的 Invocation Package；raw→product event 翻译边界（终态事件归 orchestrator）；Clarification 回答写入 Revision Facts（`source: CLARIFICATION` + `sourceRunId`）；Result Manifest 独立 Artifact 校验（Agent 自称完成不具权威性）。 | PDF/DWG/DXF adapter 需真实转换验证 + 获批图纸（**未验证，不虚报**） |
| **P5** Agent Runner + SolidWorks | 唯一调用链 Runner → Codex Runtime Adapter → `solidworks-build-part-from-drawing` → retained dependency prose（非阻塞）→ 检测到且受支持的 SolidWorks（门为 availability-only 并记录实际版本，不硬匹配年份版本）；Capability Gate（**九项 preflight，报告 v2**，含 `input_adapter_succeeded`）恒生效于 PREPARING，任一不满足则 Run 停 `PREPARING`；schema + 必需 Artifact + 路径 + hash + rebuild + native feature/body/geometry 验证通过后才**原子发布 `PENDING_REVIEW` Model**。**仓库侧进度（2026-08-14，Exit Gate 未 PASS）**：P5-1 九项门恒生效（SolidWorks version-agnostic + 版本记录、`$solidworks-build-mechanical-models` 非阻塞 prose；默认 synthetic fixture，`synthetic: true`；真实 probe 已实现并最终验证）；P5-2 原子发布默认；P5-3 Codex App Server `0.147.0` / protocol v2 契约钉定 + shell-free live stdio transport 已实现并最终验证 + `initialize`/`skills/list` native smoke 通过（skill 目录→`SKILL.md` 精确路径校验通过，两个精确外部 skill copies，digest `3d4bfbc9…`；**live Runner 已接线 owned Codex adapter + 真实 PDF adapter**）；P5-4 ownership-safe Cancel + 低 Stage 钉定恢复（仅契约测试）+ async ownership-safe SolidWorks live probe 已实现并实测（本机 `available:false`/`installedVersion` 33.0.0.5050/owned 进程已关闭/无残留进程/attach 错误不再 spawn）；probe 版本写入 prompt 并在 ArtifactValidator 精确校验。 | **SolidWorks availability 门当前 FAILS**（2025 33.0.0.5050 已安装且 COM 已注册但当前不可驱动——主机状态动态（前两次 probe 成功），当前 default 与两个 Rx session-safe 模式均 ~3–4 s `0xC0000005` 早退；**不结论性归因 AMD/atio6axx**——AMD Radeon driver 31.0.12042.4 与 2026-08-14 CXPD dump 仅主机上下文/历史假设）；`$solidworks-build-mechanical-models` 非阻塞未验证；**无获批图纸真实 E2E/HIL 已完成**（三次 2026-08-15 获批链尝试均未完成）；live stdio transport/真实 preflight/PDF adapter **已实现并最终验证**（2026-08-15 当前工作树全新全量验证全绿，见第 13 节 A9）；cancel ownership 与恢复**仅契约测试、从未 HIL 验证**（不得杀无关 SolidWorks 工作）；**无获批图纸真实 E2E/HIL 已完成** |
| **P6** Model Review | 事务化 Approve/Reject；Reject 必填原因、创建 Feedback、不自动建 Run、不可逆；Approve 更新 `currentApprovedModelId`，旧 Approved 保留为历史；reviewer 用可信 Windows 用户身份快照。 | — |
| **P7** Cost Data + Deterministic Engine | 版本化 Cost Data Definition/Value + effective date + 不可变 CostEstimateSnapshot；纯确定性计算器；只有 current Approved Model 能建新报告；finished volume 来自确定性模型属性；unknown unit/custom field 仅展示；数量默认 1、CNY 两位小数 half-up；不含利润/税/运费/销售价格。 | 真实企业材料/余量/固定成本不写入仓库，只用合成 fixture |
| **P8** Recovery / Hardening / Packaging | capability-based recovery（Codex thread resume ≠ SolidWorks feature resume；无安全 checkpoint 显式失败）；通知/错误码/日志脱敏/Credential Manager reference/输入校验/路径与删除防护/missing-orphan reconciliation；win-x64 Electron UI + 独立 Runner 打包；安装/升级/重启/卸载保留业务数据；clean-machine acceptance。 | **Authenticode 签名**与 **clean-Windows 离线 install/start/restart/uninstall smoke**（2026-08-12 由 Phase 1 gate 范围裁定重分类为本 Phase 的**外部交付待办**；均未执行、未通过，不虚报）；**企业测试机**未提供；可驱动且受支持的 SolidWorks HIL 环境未提供（缺失时列为外部待办，不虚报完整交付） |

---

## 10. Source of Truth 文件索引与关键路径

**优先级**（冲突时）：已确认 Decision/Product Scope → Domain Model/Lifecycle → Workflow → Information Architecture → 实现代码。UI 视觉以 `.design` 为 Source of Truth。

| 类别 | 路径 |
|---|---|
| 本交接文档 | `docs/05-engineering/lead-agent-handoff.md` |
| 开发计划（Phases + Exit Gates） | `docs/05-engineering/development-plan.md` |
| 实施状态 | `docs/05-engineering/implementation-status.md` |
| 架构 | `docs/05-engineering/architecture.md` |
| Agent 正式协议（Prompt/records/Clarification/Manifest） | `docs/05-engineering/agent-spec.md`（Phase 4 新增） |
| ADR | `docs/decisions/adr-001-desktop-runtime-and-process-boundaries.md`、`adr-002-local-persistence-files-and-secrets.md`、`adr-003-drawing-modeling-agent-contract.md` |
| 产品/领域/工作流/IA/决策 | `docs/00-product/`、`docs/01-domain/`、`docs/02-workflows/`、`docs/03-product/`、`docs/decisions/decision-log.md` |
| 视觉 Source of Truth | `./.design/`（14 产品页 + component-spec 开发页）、`SWPanel-UI-Design-Brief.md` |
| 根 scripts / 配置 | `package.json`、`forge.config.mjs`、`scripts/clean.mjs`、`scripts/dev.mjs`、`scripts/package-all.mjs`、`scripts/packaging.mjs`、`scripts/package-lock.mjs`、`scripts/package-smoke.mjs`、`scripts/audit-asar.mjs`、`scripts/make-win.mjs`、`scripts/installer.mjs`、`playwright.config.ts`、`playwright.electron.production.config.ts`、`vitest.config.js`、`eslint.config.js`、`tsconfig*.json` |
| Electron 安全 | `apps/desktop/src/main/main.ts`、`security.ts`、`bridge/bridge-contract.ts`、`runner-host/runner-host.ts`、`ipc-client/*`、`apps/desktop/src/preload/preload.cts` |
| 路由 | `apps/desktop/src/renderer/app/route-manifest.ts`、`routes.tsx` |
| Mock Repository / Fixtures / 真实数据源 | `apps/desktop/src/renderer/features/mock-repository/mock-repository.ts`（测试/开发 fixture adapter）、`apps/desktop/src/renderer/features/bridge-repository/*`（生产运行时的异步 bridge repository）、`apps/desktop/src/renderer/fixtures/*`（含 `timeline.ts`、`scenarios.ts`、`validate-timeline.ts`） |
| domain / contracts / ui | `packages/domain/src/`（含 `input/` Phase 4 Input Adapter 纯数据模型）、`packages/contracts/src/`（含 `phase4/` 版本化 JSON Schema + 严格验证器 + `PHASE4_SCHEMAS` 注册表）、`packages/ui/src/` |
| runner（Phase 2 起为真实后端） | `apps/runner/src/`：`db/`（SQLite WAL + 迁移 + repository）、`ledger/`（不可变文件账本 + `run-workspace-ledger.ts` attempt workspace）、`service/`（Drawing 工作流用例）、`ipc/`（Named Pipe server + DACL + idempotency）、`orchestration/`（串行队列 claim/lease/恢复）、`execution/`（Fake Executor + Phase 4 per-claim 错误边界 + PREPARING 集成）、`adaptation/`（Phase 4 Input Adapter + Prompt Template `2026.08-p4` + Invocation Package）、`agent/`（Phase 4 raw records + product-event translator + Fake Agent Adapter）、`artifacts/`（Phase 4 synthetic artifact set + 独立 ArtifactValidator）、`runner.ts`、`boundary.ts`、`errors.ts`、`ids.ts` |
| E2E | `e2e/phase1.browser.spec.ts`、`e2e/phase2.browser.spec.ts`、`e2e/phase3.browser.spec.ts`、`e2e/phase4.browser.spec.ts`（Phase 4 产品事件 + Clarification UI，显式 fake bridge）、`e2e/electron.production.spec.ts`（20/20，含 Phase 4 真实 Runner 协议链与 artifact-validation fail-closed）、`e2e/electron.smoke.spec.ts`、`e2e/phase1.browser.spec.ts-snapshots/` |
| 单测 | 根 `src/*.test.ts`（phase-zero/build-clean/package-win/packaging/package-staging/package-chain/package-lock/audit-asar/process-identity/installer）+ 各 workspace `*.test.ts(x)`（含 `apps/runner/src/ipc/live-pipe.test.ts` live DACL 证据、`apps/runner/src/adaptation/input-adapter.test.ts`、`apps/runner/src/agent/product-event-translator.test.ts`、`apps/runner/src/artifacts/artifact-validator.test.ts`、`apps/runner/src/execution/fake-executor.test.ts` 的 M2 per-claim 边界与 Phase 4 结果阶段套件） |
| 当前 plan | `.zcode/plans/plan-phase4-execution-record.md`（Phase 4 执行记录，2026-08-13）；`plan-sess_a7403c88-…`（Phase 4 开发计划）；`plan-sess_41f60154-…`（Phase 1 翻转 + Phase 2 WP0-WP7）；历史 plan 见 `.zcode/plans/` |
| 临时验证产物（勿当证据） | `.scratch/`（含 `check-p4.log`、`check-fixtures-p4b.log`、`test-e2e-p4.log`（Phase 4 当日证据）、`phase1-production-audit.json`、`phase1-full-audit.json`、asar 列表、`check.log`、`check-20260812.log`、`check-wp5.log`、`check-wp6.log`、`check-20260813-final.log`、`check-p3.log`、`build2.log`、`build3.log`、`final-test.log`、`package-win-direct.log`、`package-win-run.log`、`asar-audit-report.json`、`installer-audit-report.json`、`package-runs/`、`installer-runs/`） |
| **禁止进入版本库** | 真实客户图纸、`.SLDPRT` 业务文件、真实企业采购价格/成本、API Key、Agent runtime memory、Run Workspace、`runtime/`、`workspaces/`、`artifacts/`、`*.db*`、`out/`、`installers/`、`installers-invalid-*/`、`dist/`、`node_modules/`、`test-results/`、`playwright-report/`、`playwright-report-production/`、`coverage/` |

**注意**：`.package-copy/`、`.scratch/`、`installers/`、`installers-invalid-*/` 现已被 `.gitignore` 覆盖；`.package-copy/` 旧快照目录已在批次 D 移除（当前工作树不存在），遗留目录会触发 `packaging.mjs` 的 `assertNoLegacyPackageCopy` guard 使 `package:win` 中止，永不自动删除/复用。

---

## 11. 新 Session 恢复清单

接手新主 Agent session 时按此顺序恢复上下文：

1. 读本文件（`docs/05-engineering/lead-agent-handoff.md`）。
2. 读 `development-plan.md`（尤其 Exit Gate 定义）、`implementation-status.md`、`architecture.md`、`docs/decisions/adr-*.md`。
3. 查看当前 todo（/todo；本 session 已建建议 Todo，见第 12 节）。
4. 检查是否存在活动 Subagent（主 Agent 可直接查看）；若无法确认，重新派发任务包。
5. 运行 `git status`（仓库当前是 git 仓库，`origin/main`，但**不要假定任何提交**；实现代码全部未提交/未跟踪）。`.scratch/`、`installers/`、`installers-invalid-*/` 与 `.zcode/` 已 gitignore；`.package-copy/` 已移除且不再被任何打包代码创建。
6. **不得复用旧测试证据**：browser 24/24、ASAR 0 findings、scratch package 结果都只是历史/scratch 记录。**当前仓库侧证据（2026-08-18，Phase 8 当前树全新全量验证，见第 13 节 A10）**：`npm run check` **exit 0**——root 10 files/291、desktop **38 files/660 tests**、runner **44 files/905 tests**、contracts 14 files/**214 tests**、domain 16 files/**110 tests**、ui 7 files/50（129 files / 2,230 tests）；`npm run check:fixtures` **1/1 通过**（13/13 零 violations RESULT PASS）；`npm run test:e2e` exit 0 **顺序通过**（production Electron **20/20**、browser + smoke **59/59** = phase1 24 + phase2 10 + phase3 14 + phase4 2 + phase6 2 + phase7 3 + phase8 3 + smoke 1；production config 无 dev server 依赖）；`npm run package:win` 已于 2026-08-18 **重新发布 canonical 包**（SHA-256 `743bbf…`、4,763,426 B、382 entries、closure 160、findings 0，`.scratch/asar-audit-report.json` ok:true + 独立 smoke PASS）。**Phase 8 里程碑内修复**：`forge.config.mjs` 补 `*.tsbuildinfo` basename 忽略（根 `tsconfig.build.tsbuildinfo` 不再随包发布）；可选 env `SWPANEL_ELECTRON_ZIP_DIR` 使打包在 Electron 发布主机不可达/抖动时离线确定性复用本地 zip（仅设置时生效）。2026-08-14/15 最终验证快照保持历史记录。（`.scratch/check-p5-final.log`——root 10 files/291、desktop 31 files/572、runner **37 files/691 tests**、contracts 13 files/148、domain 14 files/70、ui 6 files/43，计数含全部 P5 套件；`.scratch/check-fixtures-p5-final.log` 1/1、无 build-clean 干扰；`.scratch/test-e2e-p5-final.log` 20/20 + 51/51；**model-detail 1366/1920 baseline 于 18:15 有意刷新**，旧截图预期为 stale baseline 而非产品回归）。**最终验证的现场证据（2026-08-14）**：Codex 0.147.0 `initialize` + `skills/list` **native smoke 通过**——`available:true`/version `0.147.0`/protocol `2`/`skillPathVerified:true`（**skill 目录→`SKILL.md` 精确路径校验通过**；两个精确外部 skill copies `.agents`/`.codex`，digest `3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`）；**live Runner 已接线 owned Codex adapter + 真实 PDF adapter**（`apps/desktop/src/main/runner-host/live-codex-wiring.ts`，`ownsAgent: true`，关闭时有界回收 child）；获批 PDF 以 300 DPI / pypdfium2 4.30.0 **真实栅格化 4963×3509**（源哈希 `e321dc34c80b943b8af9ca9ea4ebbf9f42003627707503bf25512a479cda72a0`、输出哈希 `30614c32a5dba38374642bf76e0e7e763674e15b78455c2cb4ff18d316ae7d96`、`productionVerified: false`、产物留在 temp/仓库外）；**async ownership-safe SolidWorks live probe 实测**：`available:false`、`installedVersion` 33.0.0.5050、`ownedProcessSpawned:true`、`ownedProcessClosed:true`（reason `ownership-not-proven`——AMD 启动崩溃使 COM 无法注册，崩溃绝不被报告为可用）、probe 后**无残留 SLDWORKS.exe**、**attach 错误不再 spawn**（2026-08-15 起 COM attach/poll 为有界 Python/pywin32 `GetActiveObject`，PowerShell 仅 registry/文件版本发现；owned 早退修复后窄证据 reason `owned-process-exited`/exit 3221225477/7044ms，`22-solidworks-probe-after-early-exit-fix.json`）；**probe 版本写入 prompt（`expectedSolidWorksVersion`）并在 ArtifactValidator 精确校验**（manifest `solidWorksVersion` 必须与 Runner 认定的非空期望版本完全相等，否则 fail-closed）。SolidWorks 2025 33.0.0.5050 已安装且 COM 已注册但 **availability 门当前 FAILS**（主机状态动态：前两次 2026-08-15 HIL probe 成功 `available:true`/`33.0.0`/`owned-process-proven`，21:42 owned 启动在 COM 注册前退出——`21-solidworks-startup-diagnostic.json`：default 与两个 Rx session-safe 模式均 ~3–4 s `0xC0000005`；**当前崩溃不结论性归因** AMD/`atio6axx`——AMD Radeon driver 31.0.12042.4 与 2026-08-14 CXPD dump 证据（如 `C:\Users\Eric Chan\AppData\Local\SolidWorks\CXPD\20260814222204_33.0.0.5050\SLDWORKS.exe.*.dmp`）仅主机上下文/历史假设）；三次获批链 HIL 尝试（2026-08-15）**均未完成**（两次真实 Runner turn 如实失败、第三次在 `Runner.open` 前停止），无成功 CAD。`package:audit` ok:true（`.scratch/asar-audit-report.json`，2026-08-12T19:35:31Z）针对的是 2026-08-12T18:11:09Z 发布的 canonical 包（SHA `cf1719…`、size 2,696,001、totalEntries 229、closure 100、findings 0），**该包可能滞后于最新 Phase 5 源码，其哈希不得当作最新源码证据**；canonical `installers/` 仍是 2026-08-12 的 make:win 产物。
7. **未 commit 的可复现性提醒**：实现代码全部未 commit；**不要假定任何 Git revision 可重建上述 canonical package/installer 产物**。如需复现请基于当前工作树重跑 `npm run package:win` / `npm run make:win`，并按规则只有用户明确要求时才 commit/push。
8. **Phase 1 Exit Gate 已于 2026-08-12 判定 PASS（见第 5 节）；Phase 2 Exit Gate 已于 2026-08-13 判定 PASS（见第 3 节与第 8 节）；Phase 3 Exit Gate 已于 2026-08-13 判定 PASS（见第 3 节与第 15 节）；Phase 4 Exit Gate 已于 2026-08-13 判定 PASS（见第 3 节与第 16 节）；Phase 6 已于 2026-08-18 判定 PASS（见第 20 节）；Phase 7 已于 2026-08-18 判定 PASS（见第 21 节）；Phase 8 已于 2026-08-18 判定 PASS（见第 22 节）；Phase 5 为唯一未 PASS 阶段、仓库侧 P5-1..P5-4 契约实现 + live 接线完成并最终验证、**Exit Gate 未 PASS**（见第 3/17 节；不越报：preflight 门为九项 v2、live stdio transport 与真实 preflight/PDF adapter 已实现并最终验证、live Runner 接线 owned Codex adapter + 真实 PDF adapter、async ownership-safe SolidWorks live probe 实测 `available:false`/33.0.0.5050/owned 已关闭/无残留、probe 版本写入 prompt + ArtifactValidator 精确校验、**无获批图纸真实 E2E/HIL 已完成——三次获批链尝试均未完成**（两次真实 Runner turn 如实失败、第三次在 `Runner.open` 前停止））**。**F1 已解决（2026-08-13）**：`run.create` 使用 Main 按调用铸造的唯一 intent id 幂等键，同 Revision 显式第二次创建产生新 Run（R01/R02），同一 envelope 重复派发仍幂等（见第 15 节）。**Phase 4/5 不声称真实能力**：所有 Input Adapter 转换均为 synthetic（`productionVerified: false`，DWG/DXF `-test-only`；真实 PDF adapter 单份栅格化已最终验证但 `productionVerified: false`），真实 PDF/DWG/DXF 生产转换与真实 SolidWorks/Codex 全链路集成未验证（见第 16/17 节与 `agent-spec.md`）；Phase 5 的 preflight 报告恒 `synthetic: true`、Models 恒 `productionVerified: false`，**`productionVerified: true` 无独立证据支持、将 fail-closed**；**SolidWorks 2025 33.0.0.5050 availability 门当前 FAILS**（已安装且 COM 已注册但当前不可驱动——`21-solidworks-startup-diagnostic.json` 三种启动模式均 `0xC0000005` 早退；不结论性归因 AMD/atio6axx）；**当前工作树全新全量验证已通过（2026-08-18，Phase 8，见第 13 节 A10）**：`npm run check` exit 0（root 10/291、desktop **38/660**、runner **44/905**、contracts **14/214**、domain **16/110**、ui **7/50**，129 files / 2,230 tests）、`check:fixtures` 1/1 零 violations、`test:e2e` 顺序通过 **20/20 + 59/59**、`package:win` 重新发布 canonical 包（SHA-256 `743bbf…`、audit ok:true + 独立 smoke PASS）；A9（2026-08-15）与更早 A7/B7/C7/A8 保持历史记录。**Phase 8 外部交付待办（Phase 8 研发侧 Exit Gate 已 PASS，见第 22 节）**：签名（`signtool` absent、`Cert:\CurrentUser\My` code-signing cert 0，需授权证书/工具）与 clean-Windows 离线 install/start/restart/uninstall smoke（本机非 clean-Windows，未执行）——二者未执行、未通过，不得声称已通过，保持为**需授权外部交付待办**。**WP4 人工安全跟进**：真实第二 Windows 账户 pipe 拒绝测试未执行（单账户主机），DACL 读回证据证明 ACE 集恰为 current user + SYSTEM，此项不得虚报为已通过。
9. 准确报告：任何数字都要标注“何时、以什么命令验证”；未验证就写未验证。

---

## 12. 当前建议 Todo 表

| # | 任务 | 状态 | 优先级 | 退出条件 |
|---|---|---|---|---|
| 1 | canonical fresh package（`npm run package:win` 原子发布 + fresh ASAR audit + 独立 packaged-app smoke） | ✅ 完成 | high | canonical root `out/.../app.asar` 已发布（SHA `f4c1bc…`、size 2374410、closure 80、findings 0），`package:audit` 11:29:16Z ok:true + smoke PASS；blocker 关闭 |
| 2 | installer creation / audit（`npm run make:win` 原子链 + 真实 run + canonical re-audit） | ✅ 完成 | high | 真实 make:win PASS，canonical `installers/` report ok:true；blocker 关闭 |
| 3 | **Phase 1 Exit Gate 判定 PASS**（2026-08-12，Owner scope decision） | ✅ 完成 | high | 依据 `development-plan.md` §5 正式 Exit Gate 六项条件全部满足，判定 PASS；签名与 clean-Windows smoke 重分类为 Phase 8 外部交付待办 |
| 4 | **Phase 2 启动与执行 + Exit Gate 判定 PASS**（2026-08-13） | ✅ 完成 | high | WP0→WP7 全部实现，2026-08-13 证据全绿（check exit 0、fixtures 13/13、browser+smoke 35/35、production Electron 14/14、package:audit ok:true）；依据 `development-plan.md` §6 正式 Exit Gate 判定 PASS；Phase 3 不启动 |
| 5 | **Phase 3（Modeling Run Orchestrator Skeleton）执行 + Exit Gate 判定 PASS**（2026-08-13） | ✅ 完成 | high | P3-0..P3-6 全部实现，2026-08-13 证据全绿（check exit 0：root 10/289、desktop 29/557、runner 12/236、contracts 4/47、domain 12/51、ui 6/43；fixtures 13/13；test:e2e：production 18/18、browser+smoke 49/49）；依据 `development-plan.md` §7 正式 Exit Gate 判定 PASS；Phase 4 不启动 |
| 6 | **Phase 4（Input Adapter and Agent Contract）执行 + Exit Gate 判定 PASS**（2026-08-13） | ✅ 完成 | high | P4-0..P4-6 全部实现，2026-08-13 证据全绿（check exit 0：root 10/289、desktop 29/557、runner 18/309、contracts 13/141、domain 13/59、ui 6/43；fixtures 13/13；test:e2e：production 20/20、browser+smoke 51/51）；依据 `development-plan.md` §8 正式 Exit Gate 判定 PASS；**不声称**真实 PDF/DWG/DXF 生产转换与真实 SolidWorks/Codex 集成 |
| 7 | **Phase 5（Agent Runner + SolidWorks Skill Integration）**：仓库侧 P5-1..P5-4 + live 接线（九项 preflight 门 v2——SolidWorks version-agnostic + 版本记录、`$solidworks-build-mechanical-models` 非阻塞 prose——+ synthetic 默认、`PENDING_REVIEW` 原子发布默认、Codex App Server `0.147.0` / protocol v2 钉定 + shell-free live stdio transport + native smoke 通过（skill 目录→`SKILL.md` 精确路径校验）、live Runner 接线 owned Codex adapter + 真实 PDF adapter、async ownership-safe SolidWorks live probe（本机 `available:false`/33.0.0.5050/owned 已关闭/无残留/attach 错误不再 spawn）、probe 版本写入 prompt + ArtifactValidator 精确校验、ownership-safe Cancel + 低 Stage 钉定恢复仅契约测试） | 🔄 进行中 | high | 按 `development-plan.md` §9 执行；每批可编译可测试；**Exit Gate 未 PASS**：**当前工作树全新全量验证已通过（2026-08-15，见第 13 节 A9）**（`npm run check` exit 0：root 10/291、desktop 31/572、runner **38 files/738**、contracts 13/148、domain 14/70、ui 6/43；`check:fixtures` 1/1 零 violations RESULT PASS；`test:e2e` 顺序通过 20/20 + 51/51；历史：2026-08-14 全量重跑 runner 37/691 与 2026-08-15 聚焦验证 A8 保持记录）；再需外部项（**可驱动 SolidWorks 环境**——2025 33.0.0.5050 已安装且 COM 已注册但当前不可驱动（default 与两个 Rx session-safe 模式均 `0xC0000005` 早退，`21-solidworks-startup-diagnostic.json`，不结论性归因 AMD/atio6axx）、真实 skill hash（外部副本 digest `3d4bfbc9…`）、live Codex 全链路验证（非 HIL）、**HIL**（成功 `.SLDPRT` + 六 Artifact + Model（`PENDING_REVIEW`）、真实 Clarification 场景、ownership-safe Cancel、低 Stage 恢复——三次 2026-08-15 获批链尝试均未完成））后才可判 PASS；不越 Gate 进入 Phase 6 |
| 8 | **真实转换验证（Phase 5+/外部）**：PDF/DWG/DXF adapter 用获批生产图纸验证后再声称生产可用 | pending | high | 验证通过并记录证据；在此之前一切转换保持 synthetic（`productionVerified: false`）；**未通过，不虚报** |
| 9 | **Named Pipe 人工安全跟进（WP4 遗留）**：真实第二 Windows 账户 pipe 拒绝访问测试 | pending | high | 在双账户环境以账户 A 运行、账户 B 尝试连接必须被拒；记录 DACL 证据（恰 {A 的 SID, SYSTEM}）。本机单账户未执行；**未通过，不虚报** |
| 10 | （已完成）canonical package 刷新（2026-08-18 Phase 8：`npm run package:win` 已重新发布 canonical `out/.../app.asar`）| ✅ 完成 | canonical 包 SHA-256 `743bbf…`、4,763,426 B、audit ok:true + 独立 smoke PASS（见第 22 节）；可选剩余项：如需要最新安装器，从当前树重跑 `npm run make:win`（canonical `installers/` 仍为 2026-08-12 产物、非最新源码证据） |
| 11 | 代码签名（Authenticode，**Phase 8 外部交付待办**）：需授权签名证书/工具后接入并验证 EXE/installer 签名状态 | pending | medium | signtool/cert 就绪后 Authenticode 验证通过并记录证据；无授权条件则保留为外部待办；**未通过，不虚报** |
| 12 | clean-Windows 离线 install/start/restart/uninstall smoke（**Phase 8 外部交付待办**） | pending | medium | 干净 Windows 机离线全链路 smoke 通过并记录；本机未执行；**未通过，不虚报** |
| 13 | （提醒，非 Gate blocker）实现代码未 commit，Git revision 不可复现 | 待用户授权后 commit | medium | 用户明确要求时才 commit/push |

---

## 13. 最近一次验证快照

> 快照性质：本 section 以 **2026-08-18（最新，Phase 8 已 PASS）** 为准——**A10 为最新验证条目**（2026-08-18 Phase 8 当前树全新全量验证：`npm run check` exit 0——root 10/291、desktop 38/660、runner 44/905、contracts 14/214、domain 16/110、ui 7/50（129 files / 2,230 tests）；`check:fixtures` 1/1 零 violations；`test:e2e` 顺序通过 20/20 + 59/59；`package:win` 重新发布 canonical 包 + fresh ASAR audit ok:true + 独立 smoke PASS）；**A9**（2026-08-15）与更早 A8/A7/B7/C7/D7 等全部保持历史记录。

- **A10 Phase 8 当前树全新全量验证（2026-08-18，最新条目）**：`npm run check` **exit 0**——typecheck、仓库 lint **0 错误**、全部测试与完整 build 全绿：root **10 files / 291 tests**、`@swpanel/desktop` **38 files / 660 tests**、`@swpanel/runner` **44 files / 905 tests**、`@swpanel/contracts` **14 files / 214 tests**、`@swpanel/domain` **16 files / 110 tests**、`@swpanel/ui` **7 files / 50 tests**（**129 files / 2,230 tests**，含 Phase 8 专属套件：domain `deletion` 10、`@swpanel/ui` `Toast` 7、desktop `NotificationDrawer`/`notification-context`/`secret-store`）；`npm run check:fixtures` **1/1 通过**——13/13 canonical scenarios OK、total violations 0、RESULT PASS；`npm run test:e2e` **顺序通过（exit 0）**——production Electron **20/20**、browser + Electron smoke **59/59**（phase1 24 + phase2 10 + phase3 14 + phase4 2 + phase6 2 + phase7 3 + **phase8 3** + smoke 1；`phase8.browser.spec.ts` 3/3）；`npm run package:win` **重新发布 canonical 包**（`out/.../app.asar` SHA-256 `743bbf723343e7c4dfcb00793c5b54b8c2df61baf9f79ebeb0d5cbc23c1a7b7a`、4,763,426 B、totalEntries 382、closure 160、forbidden/missing/empty 0；`.scratch/asar-audit-report.json` generated 2026-08-18T14:01:57Z / published-fingerprint 2026-08-18T14:15:40Z **ok:true** + 独立 packaged-app smoke PASS）。**本条目取代先前"canonical 包滞后于最新源码"的验证范围陈述**（Phase 8 里程碑内修复 `tsconfig.build.tsbuildinfo` 随包发布缺口并新增可选 `SWPANEL_ELECTRON_ZIP_DIR` 离线打包，见第 22.3 节）；不改变 Phase 5 HIL 事实与 Phase 5 Exit Gate NOT PASS 结论（见第 17/18/19 节）；canonical `installers/` 仍为 2026-08-12 make:win 产物（非最新源码证据）。

- **A9 当前工作树全新全量验证（2026-08-15，历史条目）**：`npm run check` **exit 0**——typecheck、仓库 lint、全部测试与完整 build 全绿：root **10 files / 291 tests**、`@swpanel/desktop` **31 files / 572 tests**、`@swpanel/runner` **38 files / 738 tests**、`@swpanel/contracts` **13 files / 148 tests**、`@swpanel/domain` **14 files / 70 tests**、`@swpanel/ui` **6 files / 43 tests**；`npm run check:fixtures` **1/1 通过**——13/13 canonical scenarios OK、total violations 0、RESULT PASS；`npm run test:e2e` **顺序通过（exit 0）**——production Electron **20/20**、browser + Electron smoke **51/51**。**本条目仅取代 A8（与批次 P）中"修复后仅聚焦验证重跑、2026-08-14 全仓库结果未在最新改动后重跑、不得称整个当前仓库经全新全量 check/E2E 完全验证"的验证范围陈述**；不改变 HIL 事实（B8/C8/D8）、SolidWorks 主机事实（D8）与 Phase 5 Exit Gate NOT PASS 结论（E8）；canonical package/installer **未刷新**（未重跑 `package:win`/`make:win`）。
- **A8 修复后聚焦验证（2026-08-15，历史条目；被上方 A9 取代验证范围）**：聚焦 SolidWorks probe 套件 **41/41**；完整 Runner **38 files / 738 tests**；Runner typecheck 通过；仓库 lint 通过；Runner build 通过（证据 `.scratch/hil-20260815-214252-393c22d8/22-solidworks-probe-after-early-exit-fix.json`）。**2026-08-14 的全仓库 `npm run check`/`check:fixtures`/`test:e2e`（A7/B7/C7/D7）保持历史、未在最新改动后重跑**——不得称整个当前仓库经全新全量 check/E2E 完全验证。
- **B8 第一次获批链 HIL 尝试（2026-08-15 14:23，`.scratch/hil-20260815-142334-52f26231`）**：真实 Runner Run 如实 FAILED `AGENT_PROTOCOL_INCOMPATIBLE`；九项 preflight 全过（`synthetic:false`）、真实 PDF adapter 通过、SolidWorks probe `available:true`/version `33.0.0`/`owned-process-proven`。根因：原生 Codex 0.147.0 在 `experimentalApi:false` 下拒绝实验性 `thread/start.runtimeWorkspaceRoots`；修复为移除 gated 字段——稳定 thread start = `cwd` + `sandbox:"workspace-write"`、attempt-root 包含在 `turn/start.sandboxPolicy`，live preflight 现含无害真实 `thread/start`。
- **C8 第二次获批链 HIL 尝试（2026-08-15 14:48，`.scratch/hil-20260815-144823-3836c9fc`）**：真实 Runner Run 如实 FAILED `AGENT_RUNTIME_UNAVAILABLE`；九项 preflight 与真实 PDF adapter 全过；真实 `thread/start` + `turn/start` + failed turn 已发生；SolidWorks probe 再次 `available:true`/`33.0.0`/`owned-process-proven`；无 CAD/artifacts。adapter 丢弃原生 `turn.error.message` → 精确 Skill/image Turn 错误丢失；**失败回合诊断保留已修复**（Codex `turn.error.message` 确定性脱敏为技术 `runtime/agent-session.json` note——URL、含空格绝对路径、credentials/env secret keys、JWT；控制符/空白归一；≤512 字符；产品可见 `AGENT_RUNTIME_UNAVAILABLE` 保持通用；失败路径不写原始 agent 日志；harness 1.0.2 仅白名单 status/adapter/protocol + 有界 note 复制为 `14-agent-session-diagnostic.json`；`skill.resolvedPath` 绝对路径校验）。
- **D8 第三次获批链尝试与主机诊断（2026-08-15 21:42，`.scratch/hil-20260815-214252-393c22d8`）**：在 `Runner.open`/Run 创建前停止（Codex probe 与 Skill 路径/digest 通过，SolidWorks probe fail-closed）——harness/preflight 停止，非 Run 终态失败。SolidWorks COM probe 重设计：COM attach/poll 仅用有界 Python/pywin32 `GetActiveObject`（PowerShell `GetActiveObject` 曾是 `TYPE_E_ELEMENTNOTFOUND` 假阴性源，PowerShell 现仅 registry/文件版本发现）；既有实例只读；owned spawn 用精确 Node child handle/PID + 精确 `GetProcessID()` 相等，无 Dispatch/CreateObject、无 kill-all、无 ExitApp/Quit。主机状态动态：前两次 probe 成功，21:42 owned 启动在 COM 注册前退出；`21-solidworks-startup-diagnostic.json`：default、`/ForceSoftwareOGL /SWDisableExitApp`、`/SWSafeMode /SWDisableExitApp` 均 ~3–4 s 以 unsigned 3221225477（`0xC0000005`）退出；**当前崩溃不结论性归因于 AMD/atio6axx**（AMD Radeon driver 31.0.12042.4 仅主机上下文/历史假设）；两个 Rx session-safe 模式均失败 → 硬件 OpenGL 与普通 Tools/Options 状态未被单独隔离为唯一原因；SolidWorks 已安装且 COM 已注册但当前不可驱动。早退修复后窄范围真实 probe（`22-solidworks-probe-after-early-exit-fix.json`）：`available:false`/`installedVersion` 33.0.0.5050/owned spawned+closed true/exit 3221225477/reason `owned-process-exited`/7044ms；无 Codex/PDF/Run/HIL；无残留 SLDWORKS/codex 进程。
- **E8 Phase 5 Exit Gate 结论维持 NOT PASS（2026-08-15，不越报）**——三次获批链尝试均未完成（B8/C8 两次真实 Runner turn 如实失败、D8 第三次在 `Runner.open` 前停止）；**无成功 `.SLDPRT` + 六 Artifact + Model（`PENDING_REVIEW`）、无真实 Clarification 场景、无 ownership-safe 取消 HIL**；`productionVerified` 恒 `false`；SolidWorks availability 门当前 FAILS（已安装且 COM 已注册但不可驱动）；未 commit/push、不进入 Phase 6；当前工作树仍无法由 Git revision 复现。签名与 clean-Windows 离线 smoke 仍为 **Phase 8 外部交付待办**（未通过）。早前"14:12–14:50 快照早于 P5 批次落地、全量 check 在最新并发 preflight/PDF 集成前通过、最终重跑待办、不声称当前全绿"的时间线说明**已被 A7/B7/C7 取代**（历史条目 A5/A6/B5/C5/E5/F5/D6/E6 保留记录，不作改写）。2026-08-13 的 Phase 4 时代快照（A4-F4）、Phase 3 时代快照（A3-F3）、Phase 2 时代快照（A2-F2）与 2026-08-11/12 旧快照（A-I）保留在下方作历史记录。签名与 clean-Windows 离线 smoke 为 **Phase 8 外部交付待办**（未通过）。

- **A7 `npm run check`（= typecheck+lint+test+build）当前树最终整链 exit 0（2026-08-14，日志 `.scratch/check-p5-final.log`）**：root **10 files / 291 tests**、`@swpanel/desktop` **31 files / 572 tests**、`@swpanel/runner` **37 files / 691 tests**、`@swpanel/contracts` 13 files / **148 tests**、`@swpanel/domain` 14 files / **70 tests**、`@swpanel/ui` 6 files / **43 tests**；typecheck/lint/build 全绿。**计数含全部 P5 套件**（preflight / preflight-execution / model-publication / agent/codex/* / ownership / recovery / real-preflight-probe / skill-directory-hash / codex-live-probe / solidworks-live-probe / real-pdf-input-adapter / python-pdfium-rasterizer / codex-child-transport / live-codex-config / live-codex-wiring）——早前"P5 套件不在 14:48 计数内、计数不钉定"的时间线说明已被取代。
- **B7 fixture check（`npm run check:fixtures`，2026-08-14 当前树最终重跑）**：**1/1 通过**——13 canonical scenarios 全部 OK、total violations 0、RESULT: PASS（日志 `.scratch/check-fixtures-p5-final.log`；本次为干净顺序运行，无 build-clean 干扰）。
- **C7 `npm run test:e2e`（2026-08-14 当前树最终重跑，exit 0，**顺序通过**，日志 `.scratch/test-e2e-p5-final.log`）**：**production Electron 20/20**（`electron.production.spec.ts`：Phase 3 时代 18/18 + Phase 4 两测试——真实 Runner 协议链与 artifact-validation fail-closed）；**browser + Electron smoke 51/51**（`phase1.browser.spec.ts` 24 + `phase2.browser.spec.ts` 10 + `phase3.browser.spec.ts` 14 + `phase4.browser.spec.ts` 2 + `electron.smoke.spec.ts` 1）。production config 无 webServer（无 dev server 依赖）。
- **D7 最终现场证据（2026-08-14，当前树最终验证）**：Codex 0.147.0 `initialize`+`skills/list` **native smoke 通过**（`available:true`/version `0.147.0`/protocol `2`/`skillPathVerified:true`——**skill 目录→`SKILL.md` 精确路径校验通过**，两个精确外部 skill copies `.agents`/`.codex`，digest `3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`）；**live Runner 已接线 owned Codex adapter + 真实 PDF adapter**（`apps/desktop/src/main/runner-host/live-codex-wiring.ts`，`ownsAgent: true`，关闭时有界回收）；获批 PDF 300 DPI / pypdfium2 4.30.0 真实栅格化 4963×3509（源哈希 `e321dc34c80b943b8af9ca9ea4ebbf9f42003627707503bf25512a479cda72a0`、输出哈希 `30614c32a5dba38374642bf76e0e7e763674e15b78455c2cb4ff18d316ae7d96`、`productionVerified: false`、产物 temp/仓库外）；**async ownership-safe SolidWorks live probe 实测**：`available:false`、`installedVersion` 33.0.0.5050、`ownedProcessSpawned:true`、`ownedProcessClosed:true`（reason `ownership-not-proven`）、probe 后**无残留 SLDWORKS.exe**、**attach 错误不再 spawn**；**probe 版本写入 prompt（`expectedSolidWorksVersion`）并在 ArtifactValidator 精确校验**（非空期望版本必须与 manifest `solidWorksVersion` 完全相等，否则 fail-closed）。
- **E7 Phase 5 Exit Gate 结论维持 NOT PASS（2026-08-14 最终验证后，不越报）**——仓库侧 P5-1..P5-4 契约实现 + live 接线完成并最终验证全绿（A7/B7/C7 钉定），但**获批图纸建模未启动（无 HIL）**、SolidWorks availability 门当前 FAILS（AMD `atio6axx.dll` 31.0.12042.4 `0xc0000005`、CXPD dump 证据）；默认产品路径 preflight 报告恒 `synthetic: true`、Models 恒 `productionVerified: false`（`productionVerified: true` 无独立证据、将 fail-closed）；ownership-safe Cancel 与低 Stage 钉定恢复仅契约测试。签名与 clean-Windows 离线 smoke 仍为 **Phase 8 外部交付待办**（未通过）。历史判定保留在第 5/15/16/17 节与 Change Log，不作重写。
- **A5 `npm run check`（= typecheck+lint+test+build）最新整链 exit 0（2026-08-14 14:48，日志 `.scratch/check-p4.log`）**：root **10 files / 289 tests**、`@swpanel/desktop` **29 files / 557 tests**、`@swpanel/runner` **18 files / 309 tests**、`@swpanel/contracts` **13 files / 141 tests**、`@swpanel/domain` **13 files / 59 tests**、`@swpanel/ui` 6 files / **43 tests**；typecheck/lint/build 全绿。**Timing caveat（truthful）**：计数与 Phase 4 收口相同，因 P5 批次（16:34–18:16 写入）晚于本次运行（14:48）；P5 套件（preflight/execution/preflight-execution/model-publication/agent/codex/*/ownership/recovery）不在其中。
- **B5 fixture check（`npm run check:fixtures`，2026-08-14 14:48，**构建干扰后顺序重跑 1/1 通过**）**：并发首跑（`.scratch/check-fixtures-p4.log`，14:48:18）因 `npm run check` 的 build 正在写 workspace dist 而解析 `@swpanel/domain` 失败（**build-clean interference**，与 2026-08-13 Phase 4 同类别）；干净顺序重跑（`.scratch/check-fixtures-p4b.log`，14:48:40）**1/1 通过**——13 canonical scenarios 全部 OK、total violations 0、RESULT: PASS，以重跑日志为准。
- **C5 `npm run test:e2e`（2026-08-14 14:50，exit 0，**顺序通过**，日志 `.scratch/test-e2e-p4.log`）**：**production Electron 20/20**（`electron.production.spec.ts`：Phase 3 时代 18/18 + Phase 4 两测试——真实 Runner 协议链（import → run.create → 协议链 → CLARIFICATION_REQUIRED → 回答成 Facts → 旧 Run 终态 → 新 Run QUEUED）与 artifact-validation fail-closed）；**browser + Electron smoke 51/51**（`phase1.browser.spec.ts` 24 + `phase2.browser.spec.ts` 10 + `phase3.browser.spec.ts` 14 + `phase4.browser.spec.ts` 2 + `electron.smoke.spec.ts` 1）。production config 无 webServer（无 dev server 依赖）。
- **D5 截图 baseline（2026-08-14 18:15，有意刷新）**：**model-detail 1366×768 与 1920×1080 baseline 因新增 synthetic provenance badge（"合成预览 · 未生产验证"）被有意刷新**；此前 expected-screenshot 失败为 stale baseline（旧截图预期过期），非产品回归；其余 baseline 保持 2026-08-11/13 版本。
- **E5 Phase 5 仓库侧契约套件（2026-08-14，当前工作树内，**不在 A5 计数中**；精确计数不钉定）**：`preflight/preflight.test.ts`（synthetic fixture、抛错 fail-closed、门评估顺序）、`execution/preflight-execution.test.ts`（PREPARING 集成）、`orchestration/model-publication.test.ts`（原子 `PENDING_REVIEW` 发布、`productionVerified` 仅 false/缺省可发布）、`agent/codex/*`（jsonrpc-codec / client / adapter / agent-session / builders——0.147.0 / protocol v2 契约 fixture）、`execution/ownership/solidworks-ownership-guard.test.ts`（ownership-proof cancel、unproven → `CANCEL_CLEANUP_PENDING`）、`execution/recovery/thread-session-recovery*.test.ts`（低 Stage 钉定续跑、MODELING+ 硬 no-checkpoint）。
- **F5 Phase 5 Exit Gate 结论：NOT PASS（2026-08-14，不越报）**——P5-1..P5-4 仓库侧契约实现 substantially complete / in progress，但**无 live Codex 进程 spawn、无生产 transport、无 HIL**；默认产品路径 preflight 报告恒 `synthetic: true`、Models 恒 `productionVerified: false`（`productionVerified: true` 无独立证据、将 fail-closed）；单测计数不钉定（**顺序重跑已全绿**：fixtures 1/1、e2e 20/20 + 51/51）。外部硬阻塞不变（SolidWorks 2022 不可用（本机 2025）、`$solidworks-build-mechanical-models` 未解析、无获批图纸真实 E2E、真实 PDF/DWG/DXF 未验证）。签名与 clean-Windows 离线 smoke 仍为 **Phase 8 外部交付待办**（未通过）。历史判定保留在第 5/15/16 节与 Change Log，不作重写。
- **A6 全量 check 时序（2026-08-14 晚些，truthful）**：最后一次全量 `npm run check`（14:48，`.scratch/check-p4.log`）早于 P5 批次（16:34–18:16）**且早于最新并发 preflight/PDF 集成**（真实 preflight probe + skill-directory hash、真实 PDF adapter + pypdfium2 rasterizer、shell-free live stdio Codex transport——文件 21:55–22:48）；**全量 check 在集成前通过、最终重跑待办、不声称当前全绿**；单测计数不在此钉定。
- **B6 Codex 0.147.0 live smoke（2026-08-14 晚些，非 HIL）**：真实 `initialize` + `skills/list` 对 0.147.0 App Server 运行时 **live smoke 成功**，发现两个精确外部 skill copies（`C:\Users\Eric Chan\.agents\skills\solidworks-build-part-from-drawing` 与 `C:\Users\Eric Chan\.codex\skills\solidworks-build-part-from-drawing`，规范目录 digest **`3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`**，两副本逐字节一致，用仓库 `hashSkillDirectory` 复验）。
- **C6 获批 PDF 真实栅格化（2026-08-14 晚些）**：真实 PDF adapter + pypdfium2 4.30.0 以 **300 DPI** 将一份获批 PDF 真实转换为 **4963×3509** PNG——源哈希 `e321dc34c80b943b8af9ca9ea4ebbf9f42003627707503bf25512a479cda72a0`、输出哈希 `30614c32a5dba38374642bf76e0e7e763674e15b78455c2cb4ff18d316ae7d96`、`productionVerified: false`、产物留在 temp/仓库外。**处于最终验证中**。
- **D6 SolidWorks availability 门当前 FAILS（2026-08-14 晚些）**：本机安装 **SolidWorks 2025 产品版本 33.0.0.5050**，但 COM 激活与直接启动均在 AMD 驱动 `atio6axx.dll` 31.0.12042.4 以访问违例 `0xc0000005` 崩溃——本地 CXPD dump 证据（`C:\Users\Eric Chan\AppData\Local\SolidWorks\CXPD\20260814222204_33.0.0.5050\SLDWORKS.exe.*.dmp` 等）；**获批图纸 HIL 未启动**。
- **E6 Phase 5 Exit Gate 结论维持 NOT PASS（2026-08-14 晚些更新，不越报）**——版本硬门移除后 preflight 门为**九项（报告 v2）**、SolidWorks version-agnostic（版本记录不硬匹配）、`$solidworks-build-mechanical-models` 非阻塞 prose；live stdio transport 已实现且 live smoke 成功，真实 preflight/PDF adapter 已实现但**处于最终验证中**；SolidWorks availability 门当前 FAILS → HIL 无法进行、未启动；**全量 check 最终重跑待办**。签名与 clean-Windows 离线 smoke 仍为 **Phase 8 外部交付待办**（未通过）。历史判定保留，不作重写。
- Node v24.19.0 / npm 11.17.0；Electron 43.3.0 binary 存在。

- **A4 `npm run check`（= typecheck+lint+test+build）整链 exit 0（2026-08-13 Phase 4 收口重跑，历史记录，被上方 A5 覆盖，日志 `.scratch/check-p4.log`）**：root **10 files / 289 tests**、`@swpanel/desktop` **29 files / 557 tests**、`@swpanel/runner` **18 files / 309 tests**、`@swpanel/contracts` **13 files / 141 tests**、`@swpanel/domain` **13 files / 59 tests**、`@swpanel/ui` 6 files / **43 tests**；typecheck/lint/build 全绿。（对比 2026-08-13 Phase 3 快照 A3：runner 12/236、contracts 4/47、domain 12/51 —— desktop 持平，增长为 P4-0..P4-5 的 runner `adaptation/`（Input Adapter + Prompt + Invocation）、`agent/`（raw records + translator + fake adapter）、`artifacts/`（synthetic set + 独立 validator）、`execution/`（Phase 4 结果阶段 + M2 边界）与 contracts `phase4/`、domain `input/` 套件。）
- **B4 fixture check（`npm run check:fixtures`，2026-08-13 Phase 4 收口重跑）**：13 canonical scenarios 全部 OK、**total violations 0、RESULT: PASS**（日志 `.scratch/check-fixtures-p4b.log`；同日首次运行曾因 `npm run check` 的 build 正在写 workspace dist 触发一次瞬时包解析失败，立即干净重跑通过，以重跑日志为准）。
- **C4 `npm run test:e2e`（2026-08-13 Phase 4 收口，exit 0）**：**production Electron 20/20**（`electron.production.spec.ts`：Phase 3 时代的 18/18 + 新增 Phase 4 两测试 —— "Phase 4 real Runner protocol chain publishes product events and clarification answers become Revision Facts"（真实 Runner + Fake Adapter + 临时 runtime root：import → run.create → 完整协议链 → CLARIFICATION_REQUIRED 结构化事件顺序 → 回答成为 Revision Facts（`source: CLARIFICATION` + `sourceRunId`）→ 旧 Run 终态 → 新 Run QUEUED）与 "a real Runner artifact-validation scenario fails closed after the Agent manifest claim"（缺陷 workspace：准确 failure code 终止、不发布 Model））；**browser + Electron smoke 51/51**（`phase1.browser.spec.ts` 24 + `phase2.browser.spec.ts` 10 + `phase3.browser.spec.ts` 14 + `phase4.browser.spec.ts` 2 + `electron.smoke.spec.ts` 1）。production config 无 webServer（无 dev server 依赖）。
- **D4 Phase 4 browser E2E（2026-08-13，`phase4.browser.spec.ts` 2/2，显式 fake bridge）**：Run Detail 结构化事件流渲染 RuntimeMetadataUpdated / AgentTurnCompleted / ResultManifestReceived / Completed（COMPLETED Run）；Clarification 表单提交 dimension + choice 回答 → 保存至版本记忆 → 重新自动建模创建新 Run；产品 UI 无 fake scenario 控件、无 prompt 编辑器、无 `scenario=` URL（黑盒断言）。
- **E4 Phase 4 单测/集成套件（2026-08-13）**：contracts `phase4/`（schema registry/product events/invocation package/runtime metadata/clarification/error/input adaptation/result manifest，141 tests/13 files）；runner `adaptation/input-adapter.test.ts`（14 tests：8 场景矩阵、页选择真实性、`productionVerified: false` 不变量）、`agent/product-event-translator.test.ts`（11 tests：支持/不支持版本、未知类型、畸形 payload、越序流、技术记录不派生事件、终态事件归 orchestrator）、`agent/fake-agent-adapter.test.ts`（4 tests）、`artifacts/artifact-validator.test.ts`（16 tests：fail-fast 确定性顺序、manifest 路径安全、missing/zero-byte/hash mismatch/path escape、rebuild 最低要求）+ `result-artifact-set.test.ts`（8 tests）、`execution/` Phase 4 结果阶段 gate + MP4 必需校验 + **M2 per-claim 错误边界回归**（注入抛异常的 adapter/workspace：第一 Run FAILED `INPUT_ADAPTER_FAILED` 恰一个终态事件、attempt INTERRUPTED 非 CANCELLED，第二 Run 同一队列循环 COMPLETED）、`db/run-repository.test.ts`（CLARIFICATION facts 带 `sourceRunId` 持久化、原子无部分提交）、`execution/input-adapter-execution.test.ts`（PREPARING 集成，6 tests）。
- **F4 Phase 4 Exit Gate 结论：PASS（2026-08-13 正式判定）**——依据 `development-plan.md` §8 正式 Exit Gate（不调用真实 SolidWorks 的测试 Executor 下，Prompt、事件、Clarification、Manifest 协议完整端到端工作），P4-0..P4-6 实现 + A4/B4/C4/D4/E4 证据覆盖。**Phase 5 为下一阶段、未开始（不启动；外部硬阻塞不变）**。**不声称**：真实 PDF/DWG/DXF 生产转换（全部 synthetic `productionVerified: false`、DWG/DXF `-test-only`）、真实 SolidWorks/Codex 集成。审查修复 M1/M2 已落地并复验。签名与 clean-Windows 离线 smoke 仍为 **Phase 8 外部交付待办**（未通过）。历史判定保留在第 5 节与 Change Log 历史条目，不作重写。
- Node v24.19.0 / npm 11.17.0；Electron 43.3.0 binary 存在。

- **A3 `npm run check`（= typecheck+lint+test+build）最新整链 exit 0（2026-08-13 Phase 3 收口重跑，日志 `.scratch/check-p3.log`）**：root **10 files / 289 tests**、`@swpanel/desktop` **29 files / 557 tests**、`@swpanel/runner` 12 files / **236 tests**、`@swpanel/contracts` 4 files / **47 tests**、`@swpanel/domain` 12 files / **51 tests**、`@swpanel/ui` 6 files / **43 tests**；typecheck/lint/build 全绿。（对比 2026-08-13 Phase 2 快照 A2：desktop 24/444、runner 8/91、contracts 4/36、domain 10/35 —— Phase 3 新增 P3-1..P3-3 runner 套件与 P3-5 渲染器 Run 页/provider 测试、P3-6 测试专用执行器配置测试。）
- **B3 fixture check（`npm run check:fixtures`，2026-08-13 Phase 3 收口重跑）**：13 canonical scenarios 全部 OK、**total violations 0、RESULT: PASS**。
- **C3 `npm run test:e2e`（2026-08-13 Phase 3 收口，exit 0）**：**production Electron 18/18**（`electron.production.spec.ts`：WP2-7 图纸工作流 14/14 + Phase 3 Run 编排 4/4 —— 真实 Runner + Fake Executor + 临时 runtime root：六 Stage model-less 完成与冻结 Snapshot/workspace artifact、串行队列第二 Run QUEUED + queued-cancel 清理、关闭/重启持久化且中断恢复为 FAILED/RECOVERY_UNSUPPORTED 永不 CANCELLED、recovery-supported 快速重启后恢复走完六 Stage）；**browser + Electron smoke 49/49**（`phase1.browser.spec.ts` 24 + `phase2.browser.spec.ts` 10 + `phase3.browser.spec.ts` 14 + `electron.smoke.spec.ts` 1）。production config 无 webServer（无 dev server 依赖）。
- **D3 Phase 3 browser E2E（2026-08-13，`phase3.browser.spec.ts` 14/14，显式 fake bridge）**：确认/创建仅 identity pair（无 snapshot 走私）、QUEUED 与 queue/current 实时迁移、六 Stage 全走、model-less COMPLETED、CLARIFICATION_REQUIRED 提交 + 新 Run 指引（旧 Run 保持终态）、FAILED/artifact-validation UI、queued+running 取消结果含 CANCEL_CLEANUP_PENDING 与 CANCEL_PENDING、live events + 重复忽略、流丢失 refetch + 从最后 sequence 重订阅、unmount 退订 + 重挂载重订阅、产品 UI 无 fake scenario 控件。
- **E3 测试专用执行器配置单测（2026-08-13，`apps/desktop/src/main/runner-host/test-executor-config.test.ts` 15 tests）**：scenario/delay/lease env 解析、有界值、packaged 启动 fail-closed、非法值拒绝；E2E 确定性由 `SWPANEL_TEST_FAKE_EXECUTOR_SCENARIO` / `SWPANEL_TEST_FAKE_EXECUTOR_STEP_DELAY_MS` / `SWPANEL_TEST_RUN_LEASE_MS`（unpackaged-only）驱动，Renderer/IPC 永不携带。
- **F3 Phase 3 Exit Gate 结论：PASS（2026-08-13 正式判定，审计收口后维持）**——依据 `development-plan.md` §7 正式 Exit Gate（Fake Executor 可靠演示所有 Run 状态、6 Stage、队列、取消和恢复 UI），P3-0..P3-6 实现 + A3/B3/C3/D3 证据覆盖，F1-F3 审计收口后复验全绿（runner 12/236）。**Phase 4 为下一阶段、未开始（不启动）**。**F1 已解决**：`run.create` 使用 Main 按调用铸造的唯一 intent id 幂等键，同 Revision 显式第二次创建产生新 Run（R01/R02）。签名与 clean-Windows 离线 smoke 仍为 **Phase 8 外部交付待办**（未通过）。历史判定保留在第 5 节与 Change Log 历史条目，不作重写。
- Node v24.19.0 / npm 11.17.0；Electron 43.3.0 binary 存在。

---

以下为 **2026-08-13 Phase 2 时代快照（A2-F2，历史记录；被上方 A3-F3 覆盖）**：
- **D2 canonical package audit（`npm run package:audit`，`.scratch/asar-audit-report.json`）**：**2026-08-12T19:35:31Z ok:true**。被审计 canonical `out/SWPanel-win32-x64/resources/app.asar` 发布于 2026-08-12T18:11:09Z（本机 08-13 02:11 UTC+8）：SHA-256 `cf171900934bd24f423982340f30215536e6dcb3ee26061e7f6ff0eddcb5d870`、size 2,696,001 B、totalEntries 229、closure 100 files（含 runner dist：db/ipc/ledger/service）、forbidden/missing/empty 0。**新鲜度提醒**：该包发布于 08-13 最终 WP6/WP7 硬化与最终 `npm run check` 之前，之后**未再重跑 `package:win`**；canonical `installers/` 仍为 2026-08-12 make:win 产物。**此包哈希不得当作最新源码证据**；如需最新可分发产物请重跑 `npm run package:win`（可选 `make:win`）。
- **E2 Named Pipe DACL 证据（WP4，2026-08-13）**：`live-pipe.test.ts` 在真实 Windows pipe 上通过：DACL 应用后读回 ACE 恰为 **{current user SID, SYSTEM (S-1-5-18)}** 两个 `FILE_ALL_ACCESS` ACE、无 Everyone/ANONYMOUS/其它 SID；只读模式原始证据文件与已应用 DACL 逐字节一致；裸 `net.Socket` 线上握手 + 查询成功；ACL 探测连接被容忍为 no-op。RunnerHost **fail-closed**：无 `WINDOWS_ACL_APPLIED` 即 `PIPE_ACL_FAILED` 拒绝启动、无 Mock 静默回退。**真实第二 Windows 账户 pipe 拒绝访问测试未执行（本机单账户主机）**——人工安全跟进项，**不虚报为已通过**。
- **F2 Phase 2 Exit Gate 结论：PASS（2026-08-13 正式判定）**——依据 `development-plan.md` §6 正式 Exit Gate（无 Agent 完整执行图纸管理流程；关闭并重启后数据仍在），WP0-WP7 实现 + A2/C2 证据覆盖。**Phase 3 为下一阶段、未开始（不启动）**。签名与 clean-Windows 离线 smoke 仍为 **Phase 8 外部交付待办**（未通过，见下方旧快照 G/H，事实未变）。历史 Phase 1 FAIL / externally blocked 判定保留在第 5 节与 Change Log 历史条目，不作重写。
- Node v24.19.0 / npm 11.17.0；Electron 43.3.0 binary 存在。

---

以下为 **2026-08-11/12 历史快照**（保留记录；被上方 2026-08-13 快照覆盖）：

- **A `npm run check`（= typecheck+lint+test+build）最新整链 exit 0（2026-08-12 重跑）**：root **10 files / 288 tests**、`@swpanel/desktop` 12 files / **266 tests**、`@swpanel/contracts` 2 files / **6 tests**、`@swpanel/domain` 9 files / **32 tests**、`@swpanel/ui` 6 files / **43 tests**。typecheck/lint/build 全绿（日志 `.scratch/check-20260812.log`）。此前 2026-08-11 快照为 root 8 files / 180 tests。
- **B fixture check（`npm run check:fixtures`）**：13 scenarios **0 violations**；blocker 2 独立 PASS（timeline causality、occurredAt 单调、单 RUNNING、report 依赖 approved model）。
- **C 生产 Electron E2E 11/11**（`e2e/electron.production.spec.ts`：production `app://swpanel` 加载、全路由、协议 containment、真实 temp ASAR、恶意 dev-server/CLI 矩阵）+ **dev smoke 1/1**（`e2e/electron.smoke.spec.ts`）。blocker 3、6 关闭。
- **D canonical fresh package（2026-08-12）**：`out/SWPanel-win32-x64/resources/app.asar` 已原子发布，**SHA-256 `f4c1bc7b59f3f7e6e148829a158ad43e133b0e27c1de730dee59eb4562d5f4b4`、size 2374410、totalEntries 204、closure 80 files、forbidden/missing/empty 0**；`npm run package:audit`（`.scratch/asar-audit-report.json`）**2026-08-12T11:29:16Z ok:true**，并已做独立 packaged-app smoke（PASS）。旧 root `out/app.asar` 锁不再阻止（新包已发布，旧包仅历史记录）。
- **E installer 链（2026-08-12）**：真实 `npm run make:win` **PASS**；`.scratch/installer-audit-report.json` **ok:true**（generatedAt 11:27:58Z、publishedAt 11:28:00Z）；canonical `installers/` = `RELEASES` + `SWPanel-0.1.0 Setup.exe`（141,370,368 B）+ `swpanel-0.1.0-full.nupkg`（140,618,144 B）；nupkg 内 `lib/net45/resources/app.asar` SHA-256 = `f4c1bc…`（与 canonical 字节一致）；payload `lib/net45/SWPanel.exe` COFF machine 0x8664（x64）；post-publish canonical re-audit 通过。`.scratch/installer-runs/b2cf1624-…` 为 2026-08-12 run（createdAt 11:27:04Z）。
- **F browser 24/24**；19 baselines 于 **2026-08-11 16:19 UTC+8** 用 **Playwright 1.62.1 / Chromium 151.0.7922.34** 重新生成，**16:21 干净验证 24/24 + Axe**（零 violations）。
- **G 签名检查（2026-08-12）**：`signtool` **absent**（PATH 中未找到）；`Cert:\CurrentUser\My` 证书存储总条目 **11**，其中 **code-signing cert 0**。无签名证据。**Phase 8 外部交付待办（未通过）**。
- **H clean-Windows 离线 smoke**：**未执行**（本机非 clean-Windows；install/start/restart/uninstall 离线全链路无记录）。**Phase 8 外部交付待办（未通过）**。
- **I Phase 1 Exit Gate 结论：PASS（2026-08-12 正式判定）**——依据 `development-plan.md` §5 正式 Exit Gate 六项验收条件（真实路由、视觉一致性、组件单份、状态文案一致、Mock 数据跨页反映、无真实后端依赖）全部满足；仓库侧证据已全绿（含 canonical fresh package 与 installer 创建/审计）。签名与 clean-Windows 离线 smoke 重分类为 **Phase 8 外部交付待办**（未通过，见 G/H），不阻塞 Phase 2；**Phase 2 已于 2026-08-12 启动**。历史 FAIL / externally blocked 判定保留在第 5 节与 Change Log 历史条目。不要用 scratch 包或历史旧包结果当 canonical Gate 证据（canonical 证据以 2026-08-12 为准）。
- Node v24.19.0 / npm 11.17.0；Electron 43.3.0 binary 存在。

---

## 14. 追加式 Change Log

每条按时间追加，不修改历史条目。

- **2026-08-11（本次）**：建立本交接文档。明确 Phase 0 PASS、Phase 1 源码实现但 Exit Gate 未 PASS（blockers 见第 5 节），Phase 2-8 未开始；记录 build-clean 隔离修复（`clean.mjs`/`package-win.mjs`/tests）已验证，package 仍因 root out/app.asar 锁无法产出新包；记录 dev-only pinned React refresh CSP、production default M03/Q03 + sole RUNNING、packaging ignore maps/declarations/cache 三项修复及 `.package-copy` staging 回流问题；定义批次 A-G 与顺序；记录最近验证快照与恢复清单。
- **2026-08-11（批次 A-E 完成）**：
  - A：`npm run check` 最新整链 exit 0，统计更新为 root 8 files/180 tests、desktop 266、contracts 6、domain 32、ui 43。
  - B：`npm run check:fixtures` 13 scenarios 0 violations；blocker 2 关闭（独立 PASS）。
  - C：production Renderer 改为受限标准安全 `app://swpanel` 协议（不再 `file://`/`loadFile`），dev 仅唯一 CLI flag `--swpanel-development-renderer`（unpackaged + 严格 allowlist，`SWPANEL_RENDERER_URL`/`SWPANEL_DEVELOPMENT_RENDERER` 完全忽略）；`e2e/electron.production.spec.ts` 11/11、dev smoke 1/1；blocker 3、6 关闭。
  - D：原子 package 流程（`package-all.mjs`/`packaging.mjs`：lock → legacy guard → quarantine old out → build → per-run Forge package → fresh ASAR audit → smoke → 原子 publish）仓库侧完成；`.package-copy` 移除并 gitignore；scratch 真实 Forge/audit（closure 80、forbidden/missing/empty 0）/smoke 通过；Windows transient publish retry 实现且真实 smoke 立即 publish 通过；blocker 5 关闭。canonical `npm run package:win` 仍被 ZCode 锁住的旧 root `out/app.asar` 在 setup EPERM 准确中止（旧包未复用），fresh canonical package 退出条件未满足。
  - E：19 baselines 于 2026-08-11 16:19 UTC+8 用 Playwright 1.62.1 / Chromium 151.0.7922.34 重新生成，16:21 干净验证 24/24 + Axe；blocker 4 关闭。
- **2026-08-11（批次 F 判定 + G 同步）**：独立 full gate 判定 **Phase 1 Exit Gate = FAIL / blocked**——仅因 canonical fresh package 与 installer/signing/clean Windows 外部分发证据缺失，不能进入 Phase 2；仓库侧证据已全绿。本次同步 `architecture.md`（production `app://swpanel` 协议 + dev 唯一 CLI flag）、`implementation-status.md`（去除过期 review pending 文案与旧统计）、本文件（blockers/批次状态/验证快照/新 session 清单）。不提交/push。
- **2026-08-12（批次 H：canonical fresh package + 原子 make:win installer 链 + 仓库侧验收）**：
  - **canonical fresh package 已发布并验收**：`out/SWPanel-win32-x64/resources/app.asar` 已原子 publish，SHA-256 `f4c1bc7b59f3f7e6e148829a158ad43e133b0e27c1de730dee59eb4562d5f4b4`、size 2374410、totalEntries 204、**closure 80 files、forbidden/missing/empty 0**；`npm run package:audit`（`.scratch/asar-audit-report.json`）**2026-08-12T11:29:16Z ok:true**，并已做独立 packaged-app smoke（PASS）。旧 root `out/app.asar` 文件锁 blocker 关闭（旧 12.8 MB 03:34 包仅历史记录）。
  - **新增并加固原子 `npm run make:win` installer 链**（`scripts/make-win.mjs` → `scripts/installer.mjs`）：与 package:win 共享同一 packaging lock；持锁即 quarantine 旧 canonical `installers/`；prepare 对当前 canonical app.asar 做 fresh audit + smoke（不重新打包）；staging 复制到 per-run 目录（junction/symlink containment + staged asar 指纹校验）；Forge `make --skip-package`（squirrel/win32/x64）；Squirrel `Setup.exe`/`RELEASES`/`full.nupkg` 审计（PE/MZ/COFF、RELEASES 每行 `SHA1 FILENAME SIZE` 且与磁盘 SHA-1/size 一致、nupkg 内唯一 app.asar 的 CRC-32/SHA-256/size 与 canonical 匹配、payload `lib/net45/SWPanel.exe` 为 x64 0x8664）；原子 publish 到 canonical `installers/` 后对 published 目录再跑同一完整 re-audit；任一失败 rollback + report ok:false，永不留下 stale success/部分 installers。
  - **真实 `npm run make:win` PASS（2026-08-12T11:27-11:28Z）**：`.scratch/installer-audit-report.json` **ok:true**（generatedAt 11:27:58Z、publishedAt 11:28:00Z）；canonical `installers/` 含 `RELEASES`、`SWPanel-0.1.0 Setup.exe`（141,370,368 B）、`swpanel-0.1.0-full.nupkg`（140,618,144 B）；nupkg asar SHA-256 与 canonical 一致（size 2374410）；payload SWPanel.exe machine 0x8664（x64）；post-publish canonical re-audit 通过。
  - **`npm run check` 重跑 exit 0**：root 现为 **10 files / 288 tests**（新增 `src/installer.test.ts`、`src/package-chain.test.ts` 等），desktop 266 / contracts 6 / domain 32 / ui 43，typecheck/lint/build 全绿（日志 `.scratch/check-20260812.log`）。workspace 统计（266/6/32/43）与 2026-08-11 相比未变，保持已有记录。
  - **签名检查结果**：`signtool` **absent**；`Cert:\CurrentUser\My` code-signing cert **0**（证书存储总条目 11）。无授权签名条件，不生成临时自签名证书冒充交付签名。
  - **clean-Windows 离线 install/start/restart/uninstall smoke 未执行**（本机非 clean-Windows；未获得机器状态变更授权）。
  - **Gate 结论更新**：canonical package blocker 与 installer creation/audit 仓库侧 blocker **关闭**；Phase 1 Exit Gate 保持 **FAIL / externally blocked**（仅剩签名 + clean-Windows 离线 smoke 外部项），不进入 Phase 2。同步本文件（总体状态/blockers/批次/待办/验证快照/todo/恢复清单）、`implementation-status.md`、`architecture.md`（§17 packaging 加入 make 链）。
  - **未 commit 提醒**：实现代码仍全部未提交/未跟踪；Git revision **不可复现**当前 canonical package/installer 产物。不列作 Gate blocker（主 Agent 规则不 commit 除非用户要求），但需在恢复清单中明确。不提交/push。
- **2026-08-12（批次 I：Phase 1 Exit Gate 正式判定 PASS + Phase 2 启动，Owner scope decision）**：
  - **判定依据**：以 `development-plan.md` §5 的正式 Phase 1 Exit Gate 为准——其验收条件为：核心页面可通过真实路由进入、页面视觉与 TRAE Design 保持高一致性、相同组件只维护一份、状态文案与领域状态一致、Mock 数据修改可跨关联页面正确反映、不存在真实后端依赖。现有仓库证据（browser 24/24、Axe 0 violations、19 baselines、`npm run check` exit 0、production E2E 11/11、canonical fresh package、make:win installer 链）已覆盖全部六项。
  - **重分类**：**Authenticode 签名与 clean-Windows 离线 install/start/restart/uninstall smoke 不属于 Phase 1 Exit Gate 验收条件**，明确重分类为 **Phase 8 外部交付待办**（`architecture.md` §17 亦将 clean-machine 离线安装路径与签名列为打包阶段事项）。二者当前均**未执行、未通过**，本文件如实保留快照（signtool absent、code-signing cert 0；本机非 clean-Windows），**不虚报通过**，不生成临时自签名证书冒充交付签名。
  - **Phase 1 Exit Gate = PASS（2026-08-12）**；旧 FAIL / externally blocked 判定保留为第 5 节历史记录，不作重写。
  - **Phase 2（Persistence and Drawing Workflow）正式启动**：按 `plan-sess_41f60154-…` 的 WP0→WP7 顺序推进（WP0 domain/contracts、WP1 SQLite WAL、WP2 NTFS ledger、WP3 Drawing 工作流用例、WP4 Named Pipe IPC、WP5 Electron bridge、WP6 异步 renderer、WP7 集成 Gate），每批保持可编译可测试；不越 Gate 进入 Phase 3。
  - **同步范围**：本文件（总体状态/5 节判定/批次 I/待办/todo/恢复清单/验证快照/Change Log）、`implementation-status.md`（Current Phase 改 Phase 2、Phase 1 移入 Completed/PASS、外部分发项移入 Phase 8 blockers/pending、新增 Phase 2 工作包）、`architecture.md`（更新 §17 旧 FAIL 结论，保留 packaging 事实）、`docs/decisions/decision-log.md`（新增 Accepted decision：签名与 clean-machine distribution smoke 属于 Phase 8，不属于 Phase 1 Frontend Foundation Gate）。
  - **未 commit 提醒**：实现代码仍全部未提交/未跟踪；Git revision **不可复现**当前 canonical package/installer 产物。不提交/push。
- **2026-08-13（批次 J：Phase 2 WP0-WP7 执行完毕 + Phase 2 Exit Gate 正式判定 PASS）**：
  - **WP0 完成**：`packages/contracts` 补齐 Drawing/Revision/Facts/Feedback repository 边界与显式命令/查询合约（协议 v1 query/command envelope、idempotency key、schema 校验），"上传图纸不得自动创建 Modeling Run" 不变量保留在合约与测试中。
  - **WP1 完成**：`apps/runner/src/db/`（Node 24 内置 `node:sqlite`）——WAL、`synchronous=NORMAL`、`busy_timeout`、foreign keys、迁移版本表、显式事务封装；Runner 是唯一 DB 写入者。
  - **WP2 完成**：`apps/runner/src/ledger/drawing-file-ledger.ts` 不可变文件账本——原文件字节保留、generated-ID 目录、复制后 SHA-256/size 校验、相对路径、PDF/DWG/DXF allowlist、canonical containment、绝对路径/junction/symlink 逃逸拒绝、Unicode、缺失文件结构化错误、保守 allowlist 删除（current pointer 保护、事务化、"already gone" 语义）。
  - **WP3 完成**：`apps/runner/src/service/drawing-workflow-service.ts` 全流程用例（创建 Drawing/首 Revision、新增 Revision、current revision 原子切换、Facts/Feedback、历史、重开持久），文件/DB 失败补偿清理，全程不创建 Run。
  - **WP4 完成**：`apps/runner/src/ipc/` Windows Named Pipe（协议 v1 握手、server 实例身份、request ID + idempotency key、schema 校验、严格 allowlist、无通用命令端点）。**DACL 真实证据**：PowerShell P/Invoke `SetSecurityInfo(SE_KERNEL_OBJECT, DACL|PROTECTED_DACL)` 把 live pipe DACL 设为恰 {current user SID, SYSTEM}，读回严格校验（broad SID 全拒），`WINDOWS_ACL_FAILED` 否则；只读模式写原始证据文件；`live-pipe.test.ts` 验证 DACL 读回 + 裸 socket 线上交换。**如实记录**：本机 `icacls` 无法寻址 named pipe（error 87），Node 无公开 API 设置 pipe DACL，故采用最小 Windows 专用 helper；**真实第二 Windows 账户 pipe 拒绝测试未执行（单账户主机）**——DACL 读回证据证明 ACE 集，双账户拒绝保持为**人工安全跟进项**，不虚报。
  - **WP5 完成**：`apps/desktop/src/main/runner-host/runner-host.ts` **fail-closed**（无 `WINDOWS_ACL_APPLIED` 即 `PIPE_ACL_FAILED` 拒绝启动、拆除半启动栈、健康状态 FAILED、无 Mock 静默回退；测试替身须显式 `claimsWindowsPipe:false`）+ `preload.cts`/`bridge-contract.ts` 冻结 typed bridge（仅 16 个 allowlisted `MAIN_CHANNELS`，一次性文件 token，结构化 path-redacted 错误，无任意 channel/`readFile`/`spawn`）。
  - **WP6 完成**：Renderer 切换为异步 bridge repository（loading/error/data），Drawing Library/Overview/Revision/Memory/Settings 接真实 Runner 数据，结构化错误与可恢复 UI；Mock Repository 保留为测试/开发 fixture adapter。
  - **WP7 完成**：`e2e/phase2.browser.spec.ts`（10 tests，显式 fake bridge）+ `electron.production.spec.ts` 扩展（14/14）覆盖上传→首 Revision→新增 Revision→切换 current→Facts/Feedback→历史、上传不建 Run、关闭重启数据仍在、缺失源文件显式错误、runtime 数据隔离。
  - **2026-08-13 当日验证证据（本 session 重跑确认）**：`npm run check` **exit 0**（root 10 files/289、desktop 23 files/432、runner 8 files/91、contracts 4 files/36、domain 10 files/35、ui 6 files/43；日志 `.scratch/check-20260813-final.log`）；`npm run check:fixtures` **13/13 零 violations、RESULT PASS**；Playwright **browser + Electron smoke 35/35**（24+10+1）、**production Electron 14/14**（报告 2026-08-13 04:17-04:18 UTC+8）；`package:audit` **ok:true**（`.scratch/asar-audit-report.json` 2026-08-12T19:35:31Z；canonical app.asar 发布于 2026-08-12T18:11:09Z，SHA `cf1719…`、size 2,696,001、totalEntries 229、closure 100、findings 0）。
  - **Gate 判定**：依据 `development-plan.md` §6 正式 Exit Gate（无 Agent 完成图纸管理全流程；关闭并重启后数据仍在）判定 **Phase 2 Exit Gate = PASS（2026-08-13）**。Phase 3 为下一阶段、**未开始（不启动）**。
  - **真实性限制（不虚报）**：真实第二 Windows 账户 pipe 拒绝测试未执行（单账户主机）→ 人工安全跟进；签名（signtool absent、code-signing cert 0）与 clean-Windows 离线 smoke 仍为 **Phase 8 外部交付待办（未执行、未通过）**；canonical package/installer 可能滞后于最新 WP6/WP7 源码（08-13 收口后未重跑 `package:win`），旧包哈希不得当作最新源码证据。
  - **同步范围**：本文件（总体状态/批次 J/第 8 节完成状态与 ACL 证据/待办/todo/恢复清单/验证快照/Change Log）、`implementation-status.md`、`architecture.md`、`docs/decisions/decision-log.md`（新增 Accepted decision：Phase 2 Exit Gate PASS 的范围与 Named Pipe 双账户拒绝测试为人工安全跟进项的判定）。不提交/push。
- **2026-08-13（最终收口硬化：stable 语义意图幂等修复 + 最终全绿复验）**：
  - **修复 1——时间戳无关的语义意图键**：`apps/desktop/src/main/ipc/main-ipc.ts` 的 `intentIdempotencyKey` 改为只对**语义意图字段**做 SHA-256（`drawing.create`/`drawing.createRevision` 以源文件 sha256 为意图载体、`setCurrentRevision`/`deleteRevision` 以 id 对、fact/feedback 以内容字段、`storage.updateSettings` 以配置字段），**刻意排除 transport 生成的 `createdAt`/`updatedAt`**：带全新 requestId 且时间戳被重新生成的重试仍映射到同一键，由 Runner 幂等缓存应答，不再重复执行 mutation。
  - **修复 2——fact/feedback 的重试 vs 刻意重复提交**：Renderer 每次表单提交 mint 恰一个 `clientIntentId`（`swint_` + 32 位小写 hex，`apps/desktop/src/renderer/features/bridge-repository/client-intent-id.ts`），仅在同一提交的重试中复用；Main 按 `CLIENT_INTENT_ID_PATTERN`（`apps/desktop/src/main/bridge/bridge-contract.ts`）严格校验 token 形状并纳入 fact/feedback 语义键——同一 id 的重试被去重，相同内容的**刻意第二次提交**（新 id）仍是独立意图；该 id 不出现在 Runner wire command 中。
  - **缓存 TTL 保持有界、非 gate**：Runner `IdempotencyCache`（`apps/runner/src/ipc/idempotency-cache.ts`）仍为 LRU 容量 1024 + 30 分钟 TTL 的有界缓存；本次修复不改变其有界与非 gate 性质。
  - **最终验证（2026-08-13 当日复验，全部绿）**：`npm run check` **exit 0**（root 10 files/289、**desktop 24 files/444**、runner 8 files/91、contracts 4 files/36、domain 10 files/35、ui 6 files/43）；`npm run check:fixtures` **13/13 零 violations**；Playwright **browser + Electron smoke 35/35**、**production Electron 14/14**。
  - **Gate 结论不变**：Phase 2 Exit Gate 保持 **PASS（2026-08-13）**；本条为同日 Gate 判定后的最终硬化与复验记录，本文件第 7/11/13 节与 `implementation-status.md` 的当前证据计数已按最终复验更新，历史条目（含上文批次 J Change Log 条目）不作重写。签名与 clean-Windows 离线 smoke 仍为 Phase 8 外部交付待办（未执行、未通过）。

- **2026-08-13（批次 K：Phase 3 P3-0..P3-6 执行完毕 + Phase 3 Exit Gate 正式判定 PASS）**：
  - **P3-0 完成**：`Completed` 事件允许 model-less（无 `modelId`，不产生 synthetic 悬空引用；Phase 5 收紧发布路径）；Run attempt/claim/lease/heartbeat/recovery-decision 领域类型；Status 与 Stage 保持分离；`run.create` 只接受 drawing/revision identity pair，Runner 在事务内从持久化 Revision/Facts/Feedback 冻结 Input Snapshot（prompt template version、Skill identity+hash、agent config id 由 Runner 配置提供——未注入时使用新增生产默认 `DEFAULT_RUN_PROFILE`：`2026.08-p3` / `solidworks-build-part-from-drawing`（占位 hash，Phase 5 前不验证）/ `codex-app-server`）；SQLite 迁移扩展 `runs`（stage/activity/progress/时间戳/failure/clarification/cancel 读模型字段）与 `run_attempts`（owner/claim/lease/heartbeat/recovery 字段与唯一约束），保留 `run_events(run_id, sequence)` 唯一约束；IPC validation 严格覆盖 Run query/command/envelope。
  - **P3-1 完成**：Runner Run repository 原子创建 + 不可变 Input Snapshot + QUEUED；detail/list/dashboard 查询（含 events 与 `lastEventSequence`）；同一事务追加事件并投影 stage/activity/progress/status/timestamps/failure/clarification；每 Run 序列由事务分配、严格单调无重复；隔离 Workspace ledger `workspaces/runs/{runId}/attempt-{NNN}/{input,memory,working,output,logs,runtime}`（canonical containment、symlink/junction 拒绝、allowlist 删除只删当前 Run/attempt 自有文件）。
  - **P3-2 完成**：`apps/runner/src/orchestration/run-orchestrator.ts` 串行队列——条件 SQLite update 原子 claim 最早 QUEUED Run（同一 Runner 同时至多一个 active attempt，多个 QUEUED 允许）；owner token + lease deadline + heartbeat（续租必须校验 owner/attempt）；过期 lease 与启动恢复：QUEUED 可安全重新 claim，PREPARING/ANALYZING/PLANNING 仅当 executor 声明安全可恢复才继续（否则 `RECOVERY_UNSUPPORTED`），MODELING/VALIDATING/PACKAGING 无安全 checkpoint 即失败为中断（`RECOVERY_FAILED`），绝不写 CANCELLED、绝不发布 Model；队列循环 lease-deadline-aware（idle wake、非 busy loop）；**Runner `open()` 在存在上个进程遗留的 live-lease ACTIVE attempt 时自动启动队列循环**（快速重启在租约内无需新 `run.create` 即可在 lease 到期时恢复；仅 QUEUED 的恢复保持手动 claim 语义）。
  - **P3-3 完成**：第一等 Fake Executor（`apps/runner/src/execution/fake-executor.ts`）——success（6 Stage 顺序 + COMPLETED 无 Model）/clarification（MODELING 前终止）/failure/cooperative-cancel/hang/crash/recovery-supported/recovery-unsupported/artifact-validation-failure；场景选择只经 Runner 构造/测试 harness 注入，**不向生产 Renderer 暴露任意场景接口**；生产默认 `success`。取消语义：QUEUED 原子取消（不 claim、无 workspace、无 Model）；RUNNING 先持久化 `CancellationRequested`（并发/重试恰好一次）→ 信号协作中止 → 有界等待 → 只删 allowlist 当前 Run/attempt 文件 → 原子 `CancellationConfirmed` + CANCELLED；清理失败返回显式 FAILED `CANCEL_CLEANUP_PENDING`（绝不虚报取消）；foreign live lease 返回 `CANCEL_PENDING`（不抢租约）；意外中断永不写 CANCELLED；终态重复取消稳定。
  - **P3-4 完成**：Runner request handler 接通 `run.create`（并唤醒串行队列）/`run.cancel`/`run.getDetail`/Run list/dashboard/clarification get/submit（回答持久化在旧终态 Run 的 request 上，永不恢复）；named-pipe Run 事件订阅：服务端按 connection/runId 注册订阅、先补发 `fromSequence` 之后的持久化 backlog（注册先于读 backlog，dedupe 吸收间隙提交）、再推送按 runId 过滤的 live batch；消费端只接受合法 contractVersion/runId/严格递增 sequence，重复幂等忽略、缺口触发 snapshot/refetch，断线清理订阅；冻结 bridge 增加严格受限的 `runs`（list/getDetail/create/cancel/subscribe）与 `clarifications`（get/submit）surface，原"桥上不存在 run.create"断言更新为"新增 surface 仍严格受限"。
  - **P3-5 完成**：Renderer 异步 RunRepository（bridge/mock/unavailable 适配器）+ snapshot-then-subscribe、严格有序应用、gap/重复处理、有界恢复、unmount/runId 变更清理；Drawing Overview 开始自动建模轻量确认 → create（仅 identity pair）→ Run label + 查看任务链接；Workbench/建模任务 queue+current；Run Detail 六 Stage 进度/activity/progress/终态/failure/澄清表单（提交 + 前往版本记忆更新 Facts + 重新自动建模指引，旧 Run 保持终态）/取消任务（结构化取消结果）；UI 重开从持久化 snapshot + sequence 恢复。
  - **P3-6 完成**：`e2e/phase3.browser.spec.ts` **14/14**（显式 fake bridge、黑盒产品 UI：确认/创建仅 identity pair、QUEUED 与 queue/current 实时迁移、六 Stage 全走、model-less COMPLETED、CLARIFICATION_REQUIRED 提交 + 新 Run 指引、FAILED/artifact-validation UI、queued+running 取消结果含 CANCEL_CLEANUP_PENDING 与 CANCEL_PENDING、live events + 重复忽略、流丢失 refetch + 从最后 sequence 重新订阅、unmount 退订 + 重挂载重订阅、产品 UI 无 fake scenario 控件）并纳入 `playwright.config.ts` `testMatch`；production Electron E2E 扩展至 **18/18**（真实 Runner + Fake Executor + 临时 runtime root：bridge 创建 Run + 冻结 Snapshot、串行队列第二个 Run 保持 QUEUED 且 queued-cancel 清理、关闭/重启持久化且中断恢复为 FAILED/RECOVERY_UNSUPPORTED 永不 CANCELLED、recovery-supported 快速重启后从持久 stage 恢复走完六 Stage）。确定性通过**测试专用执行器配置**（进程/环境、unpackaged 才生效、packaged 携带即拒绝启动、Renderer/IPC 永不携带）：`SWPANEL_TEST_FAKE_EXECUTOR_SCENARIO` / `SWPANEL_TEST_FAKE_EXECUTOR_STEP_DELAY_MS` / `SWPANEL_TEST_RUN_LEASE_MS`（`apps/desktop/src/main/runner-host/test-executor-config.ts`，15 单测）+ FakeExecutor `stepDelayMs`/RunnerConfig `fakeExecutorStepDelayMs` 透传；production config 无 webServer（无 dev server 依赖）。**新增待决策风险（未修复）**：`run.create` 按 (drawingId, revisionId) 幂等（P3-4 设计，30 分钟 TTL），同 Revision 刻意第二次创建会命中缓存返回旧 Run；Phase 3 E2E 用"第二 Revision"构造串行队列，未擅自修改契约——需后续决定是否引入 client intent id（fact/feedback 模式）或调整幂等语义。
  - **2026-08-13 当日验证证据（本 session 重跑确认）**：`npm run check` **exit 0**（root 10 files/289、desktop 29 files/557、runner 12 files/235、contracts 4 files/47、domain 12 files/51、ui 6 files/43；日志 `.scratch/check-p3.log`）；`npm run check:fixtures` **13/13 零 violations、RESULT PASS**；`npm run test:e2e` **exit 0**（production Electron **18/18**、browser + smoke **49/49** = phase1 24 + phase2 10 + phase3 14 + smoke 1）。
  - **Gate 判定**：依据 `development-plan.md` §7 正式 Exit Gate（Fake Executor 可靠演示所有 Run 状态、6 Stage、队列、取消和恢复 UI）判定 **Phase 3 Exit Gate = PASS（2026-08-13）**。Phase 4 为下一阶段、**未开始（不启动）**。
  - **真实性限制（不虚报）**：真实第二 Windows 账户 pipe 拒绝测试未执行（单账户主机）→ 人工安全跟进；签名（signtool absent、code-signing cert 0）与 clean-Windows 离线 smoke 仍为 **Phase 8 外部交付待办（未执行、未通过）**；canonical package/installer 可能滞后于最新 Phase 3 源码（本批次未重跑 `package:win`），旧包哈希不得当作最新源码证据；`run.create` 同 Revision 幂等 TTL 行为作为**待决策风险**记录（未修复、未虚报）。
  - **同步范围**：本文件（总体状态/批次 K/第 15 节/待办/todo/恢复清单/验证快照/Change Log）、`implementation-status.md`、`docs/decisions/decision-log.md`（新增 Accepted decision：Phase 3 Exit Gate PASS 范围、model-less COMPLETED、测试专用执行器配置、DEFAULT_RUN_PROFILE、启动恢复队列唤醒、`run.create` 幂等风险待决策）。不提交/push。

- **2026-08-13（审计收口 F1-F3，Phase 3 Exit Gate 判定维持 PASS）**：
  - **F1 关闭（原待决策风险）**：`run.create` 幂等键从"(drawingId, revisionId) 语义对"改为 **Main 按用户调用铸造的唯一 intent id**（`run-create:<randomUUID()>`，`apps/desktop/src/main/ipc/main-ipc.ts`）：同 Revision 显式第二次创建真实产生新 Run（R01/R02），同一 envelope 重复派发（同键）仍由 Runner 幂等缓存应答；intent id 是 Main 内部传输元数据，不进入 Renderer payload（bridge 仍只接受 drawingId/revisionId）也不出现在 Runner wire command。回归：`main-ipc.test.ts`（同一对两次调用产生不同键 + 无 snapshot 走私）、`main-ipc.integration.test.ts` B2（同一 Revision 两次创建断言 R01/R02）、production E2E 串行队列测试（同一 Revision 两次创建）。"重复相同 envelope 幂等"由 `request-handler.test.ts` 服务端键缓存测试继续覆盖。澄清后"重新自动建模"在生产产品中真实创建新 Run。
  - **F2 生效**：`apps/runner/src/runner.ts` `open()` 启动串行队列循环的条件扩为 `nextActiveLeaseDeadline() !== null || hasQueuedRuns()`——重启后遗留 QUEUED Run 也会自动执行（排空后循环自终止）。新增确定性 reopen 测试（`fake-executor.test.ts` "reopen auto-starts the queue and drains a QUEUED Run without a manual runQueue()"，手动 scheduler：reopen 后立即 RUNNING、flush 后 COMPLETED）；"wires claim"与"reopen auto-recovery un-wedges"两个 orchestration 测试更新为自动 claim 语义（runner 套件 12 files / 236 tests）。
  - **F3 生效**：`apps/runner/src/db/run-repository.ts` `finishExecution` 清空 stage/activity/progressPercent（终态读模型与 UI 语义一致，历史在事件日志）；`run-repository.test.ts` COMPLETED 投影测试断言三者为空；`e2e/phase3.browser.spec.ts` fake 终态投影与终态 seed 同步对齐；production E2E 终态断言更新。`DEFAULT_RUN_PROFILE` 占位 skill hash 说明保持文档化（Phase 5 前不验证）。
  - **复验（2026-08-13）**：`npm run check` exit 0（root 10/289、desktop 29/557、runner 12/236、contracts 4/47、domain 12/51、ui 6/43）、fixtures 13/13、`npm run test:e2e` exit 0（production 18/18、browser+smoke 49/49）；Phase 3 Exit Gate 判定维持 **PASS（2026-08-13）**，Phase 4 未开始、不启动。未 commit/push。

- **2026-08-13（批次 L：Phase 4 P4-0..P4-6 执行完毕 + Phase 4 Exit Gate 正式判定 PASS）**：
  - **P4-0 完成**：`packages/contracts/src/phase4/` 版本化合同 + JSON Schema——IPC Envelope、Invocation Package、Runtime Metadata、Product Events（12 种 `RUN_EVENT_TYPES` 的 payload 全覆盖）、Clarification、Error、Input Adaptation、Result Manifest；`PHASE4_SCHEMAS` 注册表（`PHASE4_REGISTRY_VERSION = 1`，draft-07，id `swpanel://contracts/<name>/1`）+ 无依赖严格验证器（拒绝未知字段/错误版本/非法枚举，`Phase4ContractError`）；复用 domain 类型不建第二套语义；Runner 私有事件 payload 校验收敛到共享验证器（contracts 套件 13 files / 141 tests）。
  - **P4-1 完成**：`packages/domain/src/input/` 纯数据 Input Adapter 模型 + `apps/runner/src/adaptation/input-adapter.ts` `FakeInputAdapter` 8 场景矩阵（png-jpg-passthrough / single-page-pdf / multi-page-pdf-selected-page / multi-page-pdf-no-page-selected / dwg-dxf-synthetic-test-only / unsupported-source / missing-corrupt-source / adapter-failure）；**不静默选页**：多页无显式选择/越界即 `PAGE_SELECTION_REQUIRED` 失败关闭，单页路径只接受显式"第 1 页（共 1 页）"，无显式选择时 provenance 不记录任何 page/layout 断言（带 warning）；**合成真实性（M1）**：所有合成成功 `productionVerified: false` + warning，DWG/DXF 强制 `-test-only` adapter id，`productionVerified: true` 即 `RunnerInvariantError` 失败关闭（domain 不变量 + 契约校验 + 单测）；派生图像/preview/校验过的 `adapter-result.json` 经 workspace ledger 写入 attempt `input/`，不改写原始 drawing；场景注入仅经 Runner 构造/测试 harness（unpackaged-only fail-closed），Renderer/IPC 永不携带。
  - **P4-2 完成**：受控 Prompt Template `2026.08-p4`（`prompt-template.ts`，固定版本化常量，普通用户不可编辑，确定性渲染自冻结 Snapshot + provenance + workspace + Invocation Package）+ 严格校验的 Invocation Package（`invocation-package.ts`，从冻结 Snapshot 构建——Agent 永不见客户端快照）；`DEFAULT_RUN_PROFILE` 的 `promptTemplateVersion` 更新为 `2026.08-p4` 并继续在创建 Run 时冻结。
  - **P4-3 完成**：`raw-agent-records.ts` 版本化 raw record 协议（v1，10 类型）+ `product-event-translator.ts` 唯一 raw→product 边界——`session_started`/`runtime_log`/`runtime_error` 技术记录不派生产品事件，**绝不派生 `Completed`/`Failed`**（终态事件归 orchestrator），非法版本/未知类型/畸形/越序 → 稳定结构化失败（Run 级 `AGENT_PROTOCOL_INCOMPATIBLE`），原始推理不暴露给 Renderer；`fake-agent-adapter.ts` 确定性 Fake Agent Adapter（`codex-app-server` 0.1.0 / 协议 v1）；raw log 只写 attempt `logs/`/`runtime/`。
  - **P4-4 完成**：结构化 Clarification 闭环（dimension/choice 类型）——回答校验 → `ANSWERED` → 答案转 Revision Facts（`source: "CLARIFICATION"` + `sourceRunId`）→ 旧 Run 终态不续跑 → 用户手动新 Run；重复提交/幂等不产生重复 facts；clarification/answers/facts 原子提交（任一步失败全部回滚）。
  - **P4-5 完成**：`result-artifact-set.ts` 确定性 synthetic artifact 集（.SLDPRT/Preview/Dimension Ledger/Feature Plan/Validation Log/Builder Source；`recordMp4=true` 时 processMp4 必需）+ 版本化 Result Manifest；`artifact-validator.ts` **独立验证器**——manifest schema/版本 → 安全 workspace-relative 路径 → 必需 artifact 存在/非零字节/size+SHA-256 匹配/canonical 不逃逸 → `rebuildStatus: "PASSED"` 最低要求；Agent 自称完成不具权威性，只有独立校验通过才 `completeAttempt`；失败先 `ArtifactValidationFailed` 再准确 failure code 终止（`ARTIFACT_MANIFEST_INVALID`/`ARTIFACT_MISSING`/`ARTIFACT_OUTSIDE_WORKSPACE`/`VALIDATION_REJECTED`）；按计划用 event + workspace manifest 完成 gate，**未新增 schema v4 数据表**。
  - **P4-6 完成**：`e2e/phase4.browser.spec.ts` **2/2**（显式 fake bridge，纳入 `testMatch`：产品 UI 消费 RuntimeMetadataUpdated/AgentTurnCompleted/ResultManifestReceived/Completed 事件流 + Clarification 表单闭环 + 重新自动建模新 Run；无 fake scenario 控件/prompt 编辑器/`scenario=` URL）；production Electron E2E 扩展至 **20/20**（新增 "Phase 4 real Runner protocol chain…"——真实 Runner + Fake Adapter：import → run.create → 协议链 → CLARIFICATION_REQUIRED 事件顺序 → 回答成 Facts（`source: CLARIFICATION` + `sourceRunId`）→ 旧 Run 终态 → 新 Run QUEUED；新增 "artifact-validation scenario fails closed after the Agent manifest claim"——缺陷 workspace 以准确 failure code 终止、不发布 Model）；**审查修复 M1/M2 落地**（M1 见 P4-1；M2 per-claim 队列错误边界：单个 claim 抛出的 workspace/adapter/prompt/agent IO 异常不击穿串行队列——PREPARING 内适配错误已转准确结构化终态失败；其它 claim 错误由 lease 恢复如实分类（FAILED/INTERRUPTED 非 CANCELLED）；RESUMED claim 再失败立即 `RECOVERY_FAILED` 且仅当仍 ACTIVE/owned，并发取消永不产生第二终态事件；回归测试注入抛异常 adapter/workspace）。
  - **2026-08-13 当日验证证据（本 session 重跑确认）**：`npm run check` **exit 0**（root 10 files/289、desktop 29 files/557、runner **18 files/309**、contracts **13 files/141**、domain **13 files/59**、ui 6 files/43；日志 `.scratch/check-p4.log`）；`npm run check:fixtures` **13/13 零 violations、RESULT PASS**（`.scratch/check-fixtures-p4b.log`；首次运行遇瞬时包解析失败——`npm run check` 的 build 正在写 workspace dist——立即干净重跑通过）；`npm run test:e2e` **exit 0**（production Electron **20/20**、browser + smoke **51/51** = phase1 24 + phase2 10 + phase3 14 + phase4 2 + smoke 1；`.scratch/test-e2e-p4.log`）。
  - **Gate 判定**：依据 `development-plan.md` §8 正式 Exit Gate（不调用真实 SolidWorks 的测试 Executor 下，Prompt、事件、Clarification、Manifest 协议完整端到端工作）判定 **Phase 4 Exit Gate = PASS（2026-08-13）**。Phase 5 为下一阶段、**未开始（不启动；外部硬阻塞不变）**。
  - **真实性限制（不虚报）**：**不声称**真实 PDF/DWG/DXF 生产转换（全部 synthetic `productionVerified: false`、DWG/DXF `-test-only`，需获批图纸验证）与真实 SolidWorks/Codex 集成（Phase 5）；真实第二 Windows 账户 pipe 拒绝测试未执行（单账户主机）→ 人工安全跟进；签名（signtool absent、code-signing cert 0）与 clean-Windows 离线 smoke 仍为 **Phase 8 外部交付待办（未执行、未通过）**；canonical package/installer 可能滞后于最新 Phase 4 源码（本批次未重跑 `package:win`），旧包哈希不得当作最新源码证据。
  - **同步范围**：本文件（总体状态/批次 L/第 16 节/待办/todo/恢复清单/验证快照/Change Log）、`implementation-status.md`、`architecture.md`、`docs/decisions/decision-log.md`（新增 Accepted decision：Phase 4 Exit Gate PASS 范围与合成适配器真实性/不静默选页/独立验证契约）、新增 `docs/05-engineering/agent-spec.md`（正式协议文档）、新增 `.zcode/plans/plan-phase4-execution-record.md`。不提交/push。

- **2026-08-14（批次 M：Phase 5 仓库侧 P5-1..P5-4 契约实现 + 当日验证快照；Exit Gate 未 PASS）**：
  - **P5-1 完成（仓库侧）**：十项 preflight 能力门恒生效于 PREPARING——`packages/domain/src/runs/preflight.ts` `PREFLIGHT_CAPABILITIES`（规范顺序：agent_runtime_available / agent_runtime_version_supported / agent_model_supports_image / modeling_skill_discovered / modeling_skill_hash_allowed / mechanical_execution_dependency_resolved / structured_runtime_protocol_available / workspace_write_scope_supported / solidworks_2022_available / input_adapter_succeeded）+ `apps/runner/src/preflight/preflight.ts` 确定性探针边界（fail-fast 门评估、失败码映射、探针抛错 fail-closed）。**默认产品路径运行显式 synthetic/unverified fixture**（`DEFAULT_PREFLIGHT_SCENARIO = "all-pass"`、`FAKE_PREFLIGHT_SKILL_SHA256`），持久化报告恒 **`synthetic: true`**，绝不假装真实环境探针通过；`input_adapter_succeeded` 仅由 executor 在适配成功后标记。
  - **P5-2 完成（仓库侧）**：成功路径**单事务原子发布 `PENDING_REVIEW` Model**（Model 行 + artifact 元数据行 + 带 Model id 的 `Completed` 事件 + FINISHED attempt；`apps/runner/src/orchestration/run-orchestrator.ts`；Runner 产品默认 `publishModel: true`，`false` 仅用于 Phase 3/4 model-less 兼容场景）；manifest 的 `productionVerified` 由契约解析 wire boolean（缺省 `false`），独立 ArtifactValidator 以 `ARTIFACT_MANIFEST_INVALID` 拒绝 `productionVerified: true`（无产品侧 HIL 验证记录、声明绝不 authoritative）——仅 `false`/缺省可发布，synthetic 结果如实持久化 `productionVerified: false`。
  - **P5-3 完成（仓库侧，仅契约测试）**：严格 NDJSON JSON-RPC Codex App Server client + adapter（`apps/runner/src/agent/codex/`：jsonrpc-codec / codex-app-server-client / codex-app-server-adapter / agent-session / builders），钉定 **`codex-cli 0.147.0` / protocol v2**（0.147.0 schema 文档捕获于 `.scratch/codex-app-server-schema-0.147.0/v2/`，builder 只发射真实 0.147.0 字段名）；**live 进程 spawn 与生产 transport 缺失**（`index.ts` 头部如实注明 "contract-tested only — the live spawn remains disabled"）。
  - **P5-4 完成（仓库侧，仅契约测试）**：ownership-safe SolidWorks 取消边界（`apps/runner/src/execution/ownership/solidworks-ownership-guard.ts`：不可变 `OwnershipRecord` 绑定 (runId, attemptId)、只含 attempt 自记录的 OS pid + 文档身份、`closeOnlyOwned`、绝不枚举进程/绝不 kill-all、unproven/partial/failed 保守映射 `CANCEL_CLEANUP_PENDING`）+ 协议钉定低 Stage 线程恢复（`apps/runner/src/execution/recovery/`：仅 `null`/PREPARING/ANALYZING/PLANNING 可证明续跑，MODELING/VALIDATING/PACKAGING 硬性 no-checkpoint（任何注入谓词不可放宽），畸形 session 永不信；钉定谓词默认 `codex-app-server` / protocol v2——session 协议字段，与 codex-cli `0.147.0` 发行版为两个独立钉定，恢复决策只键控 session 协议字段；adapter 写入的 session（protocol `codex-app-server` + protocolVersion v2）与恢复钉定一致）。**从未 HIL 验证。**
  - **UI/渲染**：Model Detail 页新增 synthetic provenance badge（"合成预览 · 未生产验证"）；**model-detail 1366/1920 screenshot baseline 于 18:15 有意刷新**（旧截图预期为 stale baseline，非产品回归）。
  - **2026-08-14 当日验证快照（14:12–14:50，重跑确认）**：`npm run check` **exit 0**（`.scratch/check-p4.log`）；`npm run check:fixtures` **构建干扰后顺序重跑 1/1 通过**（首跑 `.scratch/check-fixtures-p4.log` 14:48:18 因 check build 写 workspace dist 解析 `@swpanel/domain` 失败 → 干净重跑 `.scratch/check-fixtures-p4b.log` 14:48:40 13/13 零 violations RESULT PASS）；`npm run test:e2e` **顺序通过** exit 0（production Electron **20/20**、browser+smoke **51/51**；`.scratch/test-e2e-p4.log` 14:50）。**时间线如实记录**：P5 源码/测试文件 16:34–18:16 写入，晚于上述快照，其套件不在 14:48 计数内；**顺序重跑已全绿**（`check:fixtures` 1/1、`test:e2e` 20/20 + 51/51），单测计数不在此钉定。
  - **Gate 判定**：**Phase 5 Exit Gate = NOT PASS（2026-08-14，不越报）**——无 live Codex 进程 spawn、无生产 transport、无 HIL；外部硬阻塞不变（SolidWorks 2022 不可用（本机 2025）、`$solidworks-build-mechanical-models` 未解析、无获批图纸真实 E2E、真实 PDF/DWG/DXF 未验证）；**不声称 Phase 5 PASS**。
  - **真实性限制（不虚报）**：preflight 报告恒 `synthetic: true`、Models 恒 `productionVerified: false`；`productionVerified: true` 无独立证据支持、将 fail-closed；真实第二 Windows 账户 pipe 拒绝测试未执行（单账户主机）→ 人工安全跟进；签名（signtool absent、code-signing cert 0）与 clean-Windows 离线 smoke 仍为 **Phase 8 外部交付待办（未执行、未通过）**；canonical package/installer 仍滞后于最新源码（未重跑 `package:win`），旧包哈希不得当作最新源码证据。
  - **同步范围**：本文件（总体状态/批次 M/第 9 节 P5 行/第 17 节新增/待办/todo/恢复清单/验证快照/Change Log）、`implementation-status.md`、`architecture.md`、`agent-spec.md`、`docs/decisions/decision-log.md`（新增 2026-08-14 Accepted decision：Phase 5 仓库侧 P5-1..P5-4 契约实施状态与 Exit Gate 未 PASS 判定）。**未 commit/push。**

- **2026-08-14（批次 N：SolidWorks 版本硬门移除 + preflight v2 九项 + live Codex smoke + 真实 preflight/PDF adapter；Exit Gate 保持 NOT PASS）**：
  - **SolidWorks 版本硬门移除**：preflight 门改为 **version-agnostic**——只要求任何可驱动的安装（`solidworks_available`），实际版本由 probe/builder 记录、绝不发明；`solidworks_2022_available` 硬版本匹配移除；**preflight 报告契约 v2、九项**（`PREFLIGHT_CAPABILITIES`：agent_runtime_available / agent_runtime_version_supported / agent_model_supports_image / modeling_skill_discovered / modeling_skill_hash_allowed / structured_runtime_protocol_available / workspace_write_scope_supported / solidworks_available / input_adapter_succeeded）；**`mechanical_execution_dependency_resolved` 不再是门项**——`$solidworks-build-mechanical-models` 保留为 Skill prose、非阻塞、绝不伪装为已解析；v1 报告历史保留不重写。
  - **外部 skill copies 同步**：`C:\Users\Eric Chan\.agents\skills\solidworks-build-part-from-drawing` 与 `C:\Users\Eric Chan\.codex\skills\solidworks-build-part-from-drawing` 规范目录 digest 均为 **`3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`**（仓库 `hashSkillDirectory` 复验，两副本逐字节一致；Downloads master 原始目录 digest 不同，不作同步证据）。
  - **Codex 0.147.0 live smoke 成功（2026-08-14）**：真实 `initialize` + `skills/list` 对 0.147.0 App Server 运行时成功，发现两个精确外部 skill copies；**shell-free live stdio transport/lifecycle 已实现**（`codex-child-transport.ts`：`app-server --stdio`、`shell: false`、`windowsHide`、`.cmd` shim 拒绝、有界 close、有界 stderr tail、exactly-once 退出传播）——**完整 live turn 链已实现但处于最终验证中**。
  - **真实 preflight/PDF adapter 已实现（处于最终验证中）**：`real-preflight-probe.ts` + `skill-directory-hash.ts`（真实 `codex --version` 探针（pin 0.147.0）、真实 skill 目录发现 + 规范 SHA-256、真实 workspace 可写探针、注入式 SolidWorks seam、`synthetic: false`）；`real-pdf-input-adapter.ts` + `PythonPdfiumRasterizer`（pypdfium2 4.30.0 + Pillow 11.3.0、`shell: false`、默认 300 DPI、temp 在仓库外）。**获批 PDF 以 300 DPI 真实栅格化为 4963×3509**——源哈希 `e321dc34c80b943b8af9ca9ea4ebbf9f42003627707503bf25512a479cda72a0`、输出哈希 `30614c32a5dba38374642bf76e0e7e763674e15b78455c2cb4ff18d316ae7d96`、`productionVerified: false`、产物留在 temp/仓库外。
  - **SolidWorks 2025 33.0.0.5050 availability 门当前 FAILS（2026-08-14）**：COM 激活与直接启动均在 AMD 驱动 `atio6axx.dll` 31.0.12042.4 以访问违例 `0xc0000005` 崩溃——本地 CXPD dump 证据（`C:\Users\Eric Chan\AppData\Local\SolidWorks\CXPD\20260814222204_33.0.0.5050\SLDWORKS.exe.*.dmp` 等）；**获批图纸 HIL 未启动**。
  - **测试真实性（不声称当前全绿）**：最后一次全量 `npm run check`（14:48）早于 P5 批次（16:34–18:16）且早于最新并发 preflight/PDF 集成（21:55–22:48 写入）；**全量 check 在集成前通过、最终重跑待办**；此前顺序重跑已全绿（`check:fixtures` 1/1、`test:e2e` 20/20 + 51/51）；单测计数不钉定。
  - **Gate 判定**：**Phase 5 Exit Gate 保持 NOT PASS（2026-08-14，不越报）**——无 HIL（获批图纸 HIL 未启动）、live 链处于最终验证中；**不声称 Phase 5 PASS**；**不 commit/push、不进入 Phase 6**。
  - **同步范围**：本文件（总体状态/批次 N/第 9 节 P5 行/第 17 节更新/待办/todo/恢复清单/验证快照/Change Log）、`implementation-status.md`、`architecture.md`、`agent-spec.md`、`docs/decisions/adr-003-drawing-modeling-agent-contract.md`、`docs/decisions/decision-log.md`（新增 2026-08-14 Accepted decision：版本硬门移除与 Phase 5 进展事实记录）。

- **2026-08-14（批次 O：Phase 5 最终复核 + live 接线收口；Exit Gate 保持 NOT PASS）**：
  - **live Codex skill 目录→`SKILL.md` 校验通过**：Codex 0.147.0 native `initialize` + `skills/list` smoke 通过——`available:true`/version `0.147.0`/protocol `2`/`skillPathVerified:true`（skills/list 报告的 `<directory>\SKILL.md` 与配置目录做规范 Windows 安全段比较，兄弟目录/`.codex` 副本/嵌套 manifest/异名文件 fail-closed；两个精确外部 skill copies `.agents`/`.codex`，digest `3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`，逐字节一致）。
  - **live Runner 接线 owned Codex adapter + 真实 PDF adapter**：`apps/desktop/src/main/runner-host/live-codex-wiring.ts`（仅 `main.ts` liveCodex 分支消费）——每 Runner 恰一个持久 Codex child transport + 严格 NDJSON client + async turn adapter + `RealPdfInputAdapter`（bundled pypdfium2，显式 helper 路径解析到 dev dist/打包 asar），`ownsAgent: true` 使 executor 关闭时有界回收 adapter 与 child（绝不孤儿化）；默认 synthetic 路径不动。
  - **async ownership-safe SolidWorks live probe 实现并实测**：`apps/runner/src/preflight/solidworks-live-probe.ts`——READ-ONLY attach 既有 COM 实例（绝不关闭、绝不触碰文档）；仅干净 `ok:true, attached:false` 才进入 owned-spawn 路径（**attach 抛错/超时/`ok:false`/foreign/畸形绝不 spawn**）；spawn 后经有界 PowerShell helper 以精确 pid 证明 COM ownership，只关闭 owned 进程（owned handle kill + await exit）。**本机实测**：`available:false`、`installedVersion` 33.0.0.5050、`ownedProcessSpawned:true`、`ownedProcessClosed:true`（reason `ownership-not-proven`——AMD 启动崩溃使 COM 无法注册，崩溃绝不被报告为可用），probe 后**无残留 SLDWORKS.exe**。
  - **probe 版本写入 prompt 并在 ArtifactValidator 精确校验**：`prompt-template.ts` 渲染 `expectedSolidWorksVersion` 段（缺省保持 version-agnostic 字节一致）；`artifact-validator.ts` 在 Runner 认定非空期望版本时要求 manifest `solidWorksVersion` 完全相等，否则 fail-closed（validator 权威、Agent 文本不权威）。
  - **当前树最终全量重跑全绿（2026-08-14）**：`npm run check` **exit 0**（root 10 files/291、desktop **31 files/572 tests**、runner **37 files/691 tests**、contracts 13 files/**148 tests**、domain 14 files/**70 tests**、ui 6 files/43；日志 `.scratch/check-p5-final.log`——**计数含全部 P5 套件**，早前"P5 套件不在 14:48 计数内、最终重跑待办、不声称当前全绿"时间线说明被取代）；`npm run check:fixtures` **1/1**（13/13 零 violations RESULT PASS，`.scratch/check-fixtures-p5-final.log`）；`npm run test:e2e` **exit 0 顺序通过**（production Electron **20/20**、browser+smoke **51/51**，`.scratch/test-e2e-p5-final.log`）。
  - **Gate 判定**：**Phase 5 Exit Gate 保持 NOT PASS（2026-08-14，不越报）**——获批图纸建模未启动（无 HIL）、SolidWorks availability 门当前 FAILS（AMD `atio6axx.dll` 31.0.12042.4 `0xc0000005`、CXPD dump 证据）；默认产品路径 preflight 报告恒 `synthetic: true`、Models 恒 `productionVerified: false`；ownership-safe Cancel 与低 Stage 钉定恢复仅契约测试。**不声称** live 建模全链路、HIL 或 Phase 5 PASS；**不 commit/push、不进入 Phase 6**。
  - **同步范围**：本文件（总体状态/批次 O/第 9 节 P5 行/第 17 节更新/待办/todo/恢复清单/验证快照/Change Log）、`implementation-status.md`、`architecture.md`、`agent-spec.md`、`docs/decisions/adr-003-drawing-modeling-agent-contract.md`（2026-08-14 Amendment 更新）、`docs/decisions/decision-log.md`（新增 2026-08-14 Accepted decision：Phase 5 最终验证与 live 接线事实记录）。**未 commit/push。**

- **2026-08-15（批次 P：三次获批链 HIL 尝试均未完成 + 失败回合诊断保留 + SolidWorks COM probe 重设计 + owned 早退修复；Exit Gate 保持 NOT PASS）**：
  - **尝试 1（14:23，`.scratch/hil-20260815-142334-52f26231`）**：真实 Runner Run 如实 FAILED `AGENT_PROTOCOL_INCOMPATIBLE`；九项 preflight 全过（`synthetic:false`）、真实 PDF adapter 通过、SolidWorks probe `available:true`/`33.0.0`/`owned-process-proven`。根因：原生 Codex 0.147.0 在 `experimentalApi:false` 下拒绝实验性 `thread/start.runtimeWorkspaceRoots`；修复：移除 gated 字段，稳定 thread start = `cwd` + `sandbox:"workspace-write"`、attempt-root 包含在 `turn/start.sandboxPolicy`，live preflight 现含无害真实 `thread/start`。
  - **尝试 2（14:48，`.scratch/hil-20260815-144823-3836c9fc`）**：真实 Runner Run 如实 FAILED `AGENT_RUNTIME_UNAVAILABLE`；九项 preflight 与真实 PDF adapter 全过；真实 `thread/start` + `turn/start` + failed turn 已发生；SolidWorks probe 再次 `available:true`/`33.0.0`/`owned-process-proven`；无 CAD/artifacts。adapter 丢弃原生 `turn.error.message` → 精确 Skill/image Turn 错误丢失。
  - **失败回合诊断保留（修复）**：Codex `turn.error.message` 确定性脱敏（URL、含空格绝对路径、credentials/env secret keys、JWT；控制符/空白归一；≤512 字符）仅写入技术 `runtime/agent-session.json` note；产品可见 `AGENT_RUNTIME_UNAVAILABLE` 保持通用；失败路径不写原始 agent 日志；harness 1.0.2 仅允许复制白名单 status/adapter/protocol 字段 + 有界脱敏 note 为 `14-agent-session-diagnostic.json`（绝不复制完整 session/thread/turn/attempt ID/时间戳/原始日志）；`skill.resolvedPath` 绝对路径校验。
  - **SolidWorks COM probe 重设计**：PowerShell `GetActiveObject` 是假阴性源（`TYPE_E_ELEMENTNOTFOUND`）；COM attach/poll 仅用有界 Python/pywin32 `GetActiveObject`，PowerShell 仅 registry/文件版本发现；既有实例只读；owned spawn 用精确 Node child handle/PID + 精确 `GetProcessID()` 相等，无 Dispatch/CreateObject、无 kill-all、无 ExitApp/Quit。
  - **尝试 3（21:42，`.scratch/hil-20260815-214252-393c22d8`）**：`Runner.open`/Run 创建前停止（Codex probe 与 Skill 路径/digest 通过，SolidWorks probe fail-closed）——harness/preflight 停止，非 Run 终态失败。主机状态动态：前两次 probe 成功，21:42 owned 启动在 COM 注册前退出；`21-solidworks-startup-diagnostic.json`：default、`/ForceSoftwareOGL /SWDisableExitApp`、`/SWSafeMode /SWDisableExitApp` 均 ~3–4 s 以 unsigned 3221225477（`0xC0000005`）退出；**当前崩溃不结论性归因于 AMD/atio6axx**（AMD Radeon driver 31.0.12042.4 仅主机上下文/历史假设）；SolidWorks 已安装且 COM 已注册但当前不可驱动。
  - **owned 早退修复**：probe 并发观察精确 owned 进程早退、abort/await helper child、以稳定 reason `owned-process-exited` 及时返回（安全 `ownedProcessExitCode`、`installedVersion`、真实 owned spawned/closed 事实）；窄范围真实 probe 证据 `22-solidworks-probe-after-early-exit-fix.json`：`available:false`/`installedVersion` 33.0.0.5050/owned spawned+closed true/exit 3221225477/reason `owned-process-exited`/7044ms；无 Codex/PDF/Run/HIL；无残留 SLDWORKS/codex 进程。
  - **全部代码修复后验证（2026-08-15）**：聚焦 SolidWorks probe **41/41**；完整 Runner **38 files / 738 tests**；Runner typecheck 通过；仓库 lint 通过；Runner build 通过。**2026-08-14 全仓库 `npm run check`/fixtures/E2E 保持历史、未在最新改动后重跑**——不得称整个当前仓库经全新全量 check/E2E 完全验证。
  - **Gate 判定**：**Phase 5 Exit Gate 保持 NOT PASS（2026-08-15，不越报）**——无成功 `.SLDPRT` + 六 Artifact + Model（`PENDING_REVIEW`）、无真实 Clarification 场景、无 ownership-safe 取消 HIL；`productionVerified` 恒 `false`；不进入 Phase 6；未 commit/push（当前工作树仍无法由 Git revision 复现）。
  - **同步范围**：本文件（总体状态/批次 P/第 17 节/验证快照 A8-E8/Change Log）、`implementation-status.md`、`architecture.md`、`agent-spec.md`、`docs/decisions/adr-003-drawing-modeling-agent-contract.md`（2026-08-15 Amendment）、`docs/decisions/decision-log.md`（新增 2026-08-15 Accepted decision）。未 commit/push。

- **2026-08-15（批次 Q：当前工作树全新全量验证；Exit Gate 保持 NOT PASS）**：
  - **当前工作树全新全量验证通过（2026-08-15）**：`npm run check` **exit 0**——typecheck、仓库 lint、全部测试与完整 build 全绿（root 10 files/291、desktop 31 files/572、runner **38 files/738 tests**、contracts 13 files/148、domain 14 files/70、ui 6 files/43）；`npm run check:fixtures` **1/1 通过**（13/13 canonical scenarios、0 violations、RESULT PASS）；`npm run test:e2e` **顺序通过 exit 0**（production Electron **20/20**、browser + Electron smoke **51/51**）。
  - **仅取代验证范围陈述**：本条目（与第 13 节 A9）只取代批次 P/第 13 节 A8 中"修复后仅聚焦验证重跑、2026-08-14 全仓库结果未在最新改动后重跑、不得称整个当前仓库经全新全量 check/E2E 完全验证"的验证范围陈述；**不改变更早的 HIL 事实、SolidWorks 主机事实与 Phase 5 Exit Gate NOT PASS 结论**。
  - **HIL 事实不变（2026-08-15）**：三次获批链尝试均未完成——两次真实 Runner Run 如实 FAILED `AGENT_PROTOCOL_INCOMPATIBLE`、`AGENT_RUNTIME_UNAVAILABLE`；第三次在 `Runner.open` 前停止；**无获批图纸真实 E2E/HIL 已完成**，无成功 CAD/`.SLDPRT`/六 Artifact 集/原子 `Model(PENDING_REVIEW)`。
  - **SolidWorks 主机事实不变（2026-08-15）**：主机状态动态（前两次 probe 成功）；当前 default 与两个 Rx session-safe 模式均 ~3–4 s `0xC0000005` 早退；**不结论性归因 AMD/atio6axx**（AMD Radeon driver 31.0.12042.4 与 2026-08-14 CXPD dump 仅主机上下文/历史假设）；SolidWorks 2025 33.0.0.5050 已安装且 COM 已注册但当前不可驱动。
  - **canonical package/installer 未刷新**（未重跑 `package:win`/`make:win`），旧包哈希不得当作最新源码证据。
  - **Gate 判定**：**Phase 5 Exit Gate 保持 NOT PASS（2026-08-15，不越报）**——仍缺成功 `.SLDPRT` + 六 Artifact + `Model(PENDING_REVIEW)`、真实 Clarification 场景与 ownership-safe 取消 HIL；低 Stage 钉定恢复保持待 HIL 验证（当前仅契约测试）；`productionVerified` 恒 `false`；Phase 6 未开始、不启动；未 commit/push（当前工作树仍无法由 Git revision 复现）。
  - **同步范围**：本文件（总体状态/批次 Q/第 13 节 A9/Change Log）、`implementation-status.md`、`architecture.md`、`agent-spec.md`、`docs/decisions/adr-003-drawing-modeling-agent-contract.md`（2026-08-15 验证更新）、`docs/decisions/decision-log.md`（新增 2026-08-15 Accepted decision）。未 commit/push。

- **2026-08-18（Phase 7 — Cost Data 与 Deterministic Cost Engine 实施 + Exit Gate 正式判定 PASS）**：
  - **实施范围**：见第 21 节——`@swpanel/domain` 纯确定性计算器 `calculateCostEstimate`（圆柱 `Ø320 × 820 mm` 与矩形 `L×W×H` 毛坯规格解析、`mm/cm/m` 单位、余量加成、密度折算质量（默认 7.85 g/cm³）、按价格单位（元/吨/元/kg/元/件）折算材料成本、`PER_PIECE`/`PER_BATCH` 固定成本分摊、CNY half-up 2 位舍入 `roundCny`）；`@swpanel/contracts` 严格 `ipc-validation.ts`（`costData.get` 空载荷查询、`costData.update`、`costReport.create/getDetail/listByRevision`——拒绝缺失/未知字段、非法时间戳、非有限或负值、非法数量/毛坯类型与伪造/未知 `result`，`CostReportDetailView` 携带不可变 `snapshot`）；`@swpanel/runner` `SCHEMA_VERSION = 7` migration `phase7-cost-engine`（`idx_cost_reports_revision_id`/`idx_cost_reports_model_id`）、合成默认成本基准（42CrMo/45#钢/40Cr + 默认余量 + 基础加工/检测/包装固定成本 + `DISPLAY_ONLY` 备注——**绝不真实企业数据**）、`CostWorkflowService.createCostReport` 资格闸门（当前版本当前 Approved Model `canCreateCostEstimateReport`）+ 冻结完整输入与有效成本数据快照 + 确定性结果（**Runner 计算、Renderer 绝不提交权威 result**）+ `Q01/Q02/…` 序号 + 不可变持久化（后续全局改价绝不重写历史报告）；`apps/desktop` `window.swpanel.cost` bridge（`getEffectiveCostData`/`updateCostData`/`getReportDetail`/`createReport`）+ Renderer `features/cost-repository/` 异步 bridge/mock/unavailable 适配器 + `CostDataPage`/`CostParamsPage`/`CostReportPage`/`DrawingCostsPage` 四页 bridge 模式解锁。
  - **验证证据（2026-08-18）**：`npm run check` exit 0——typecheck、仓库 lint **0 错误**、全部测试与完整 build：root 10 files/291、`@swpanel/desktop` 33 files/593、`@swpanel/runner` 44 files/888、`@swpanel/contracts` 14 files/200、`@swpanel/domain` 15 files/100、`@swpanel/ui` 6 files/43，共 **2,115 项单测/集成测试**；`npm run check:fixtures` 1/1（13/13 canonical 场景、含 `cost-report-generated`、violations 0、RESULT PASS）；`npm run test:e2e` 顺序通过——production Electron **20/20**、browser + Electron smoke **56/56**（phase1 24 + phase2 10 + phase3 14 + phase4 2 + phase6 2 + phase7 3 + smoke 1）。浏览器 fake-bridge `e2e/phase7.browser.spec.ts` 3/3（成本数据编辑保存、图纸成本报告列表 + 当前正式模型、参数确认 → Q01 报告 → 详情跳转）；真实 Electron + 真实 Runner E2E 覆盖发布 → 审核 APPROVED → 生成 Q01 → 全局改价 → Q01 不可变复读（总额不变）→ Q02 总额更高 → 版本成本报告列表 Q01+Q02。
  - **成本页截图基线更新（2026-08-18）**：Phase 7 解锁的 `cost-data`/`cost-params`/`cost-report` 三张 1920×1080 基线按新真实页面重新生成并干净复验（其余 16 张哈希未变）。
  - **Gate 判定**：**Phase 7 Exit Gate = PASS**（同一不可变快照恒产同一确定性结果，且该确定性以单测覆盖）。已知限制如实记录于第 21 节与 `implementation-status.md`：UI 的 `finishedVolume` 仍取自规范常量 `CANONICAL_FINISHED_VOLUME` 而非持久化模型几何——引擎冻结给定快照故确定性不受影响，从模型几何换算精加工体积列为 **Phase 8 精度项**；利润/税/运费/售价与商务报价词条按设计不在范围内。
  - **同步范围**：本文件（总体状态/第 21 节/Change Log）、`implementation-status.md`（Current Phase 改 Phase 7 PASS、Phase 6 里程碑降为历史）、`architecture.md`（成本引擎一节）、`docs/decisions/decision-log.md`（新增 2026-08-18 Accepted decision）。**未 commit/push。**

- **2026-08-18（Phase 8 — Recovery / Hardening / Packaging 实施 + Exit Gate 正式判定 PASS）**：
  - **实施范围**：见第 22 节——12.1 中断恢复（capability-based 恢复契约保留 + Electron `system.getRecoveryStatus` 桥接启动恢复扫描并在通知 feed/toast 汇报 failed/resumed Runs）；12.2 通知（`@swpanel/ui` `Toast`/`ToastContainer` + Renderer `NotificationDrawer`/`notification-context`，非阻塞、feed 上限 100）；12.3 删除（`packages/domain/src/deletion/` `canDeleteRevision`/`canDeleteRun`/`canDeleteCostReport` 级联保护 + bridge `runs.delete`/`cost.deleteReport` + 产品 UI 确认）；12.4 安全（SafeStorage/DPAPI `secret-store.ts`，明文密钥绝不跨 bridge、masked 预览、dev XOR 混淆或生产 `fallbackMode:"refuse"` fail-closed）；12.5 测试（下述全量）；12.6 打包（`package:win` 从当前树原子链重新发布 canonical 包 + fresh ASAR audit + 独立 smoke）。
  - **验证证据（2026-08-18）**：`npm run check` exit 0——typecheck、仓库 lint **0 错误**、全部测试与完整 build：root 10/291、`@swpanel/desktop` 38 files/660、`@swpanel/runner` 44 files/905、`@swpanel/contracts` 14 files/214、`@swpanel/domain` 16 files/110、`@swpanel/ui` 7 files/50，共 **129 files / 2,230 项单测/集成测试**；`npm run check:fixtures` 1/1（13/13、0 violations、RESULT PASS）；`npm run test:e2e` 顺序通过——production Electron **20/20**、browser + Electron smoke **59/59**（phase1 24 + phase2 10 + phase3 14 + phase4 2 + phase6 2 + phase7 3 + phase8 3 + smoke 1；`phase8.browser.spec.ts` 3/3）。`npm run package:win` 从当前树**重新发布 canonical 包**：`out/.../app.asar` SHA-256 `743bbf723343e7c4dfcb00793c5b54b8c2df61baf9f79ebeb0d5cbc23c1a7b7a`、4,763,426 B、totalEntries 382、closure 160、forbidden/missing/empty 0、`.scratch/asar-audit-report.json` generated 2026-08-18T14:01:57Z / published-fingerprint 2026-08-18T14:15:40Z **ok:true** + 独立 packaged-app smoke PASS。
  - **打包验证发现与修复**：(1) 根 `tsconfig.build.tsbuildinfo` 曾未被 `forge.config.mjs` 忽略而进入 ASAR、致 fresh audit 以 `cache` 失败——已补 `/\.tsbuildinfo$/i`（与 audit 交叉校验对齐；root 套件 10/291 复验全绿）；(2) `@electron/get` 每轮运行时从 Electron 发布主机拉取 `SHASUMS256.txt` 校验缓存 zip，本主机连接抖动/不可达致 3 次 `package:win` 在 package 阶段失败（链正确 fail-closed、未发布）——新增可选 env `SWPANEL_ELECTRON_ZIP_DIR`（仅设置时生效，走 packager `electronZipDir` 复用本地 `electron-v43.3.0-win32-x64.zip`，零网络离线确定性打包；未设置主机保持默认下载）。
  - **截图基线更新（2026-08-18，有意刷新）**：Phase 8 改动页面 `drawing-costs`/`cost-report`/`run-detail`/`settings` 四张 1920×1080 基线重新生成并干净复验（其余 15 张哈希未变）。
  - **Gate 判定**：**Phase 8 Exit Gate = PASS（2026-08-18）**——研发侧正式 Exit Gate（可重复本地验收流程 + 全新测试环境按文档可启动 canonical 包）满足。**外部交付待办保持（历史事实保留，未执行、未通过、未虚报）**：Authenticode 代码签名（`signtool` absent、code-signing cert 0，需授权）与 clean-Windows 离线 install/start/restart/uninstall smoke（本机非 clean-Windows、未获授权）；两者不属于研发侧 Exit Gate 验收条件。
  - **同步范围**：本文件（总体状态/第 22 节/批次 R/待办/todo/恢复清单/Change Log）、`implementation-status.md`（Current Phase 改 Phase 8 PASS、Phase 7 里程碑降为历史、新增 Phase 8 里程碑、Blockers/Pending Work/Next 更新）、`docs/decisions/decision-log.md`（2026-08-18 Phase 8 判定事实由主 Agent 记录）。**未 commit/push。**

---

## 15. Phase 3 已完成能力摘要与 Exit Gate 证据（2026-08-13 PASS）

Phase 3 — Modeling Run Orchestrator Skeleton（**P3-0 起执行，2026-08-13 全部批次完成并 Exit Gate PASS**；正式 Exit Gate 定义见 `development-plan.md` §7：通过 Fake Executor 可靠演示所有 Run 状态、6 Stage、队列、取消和恢复 UI）。以下为 P3-6 收口后的实现与证据摘要（详细批次记录见第 14 节 Change Log 批次 K）：

- **Run 创建与冻结 Snapshot**：点击"开始自动建模"→ 轻量确认 → `run.create`（Renderer 只提交 drawingId/revisionId）→ Runner 在事务内读取 Revision/稳定原文件引用/Facts/Feedback 并冻结 Input Snapshot（prompt template version、Skill identity+hash、agent config id 来自 Runner 配置，生产默认 `DEFAULT_RUN_PROFILE`）→ QUEUED。浏览器 E2E 断言 payload 只含 identity pair；production E2E 断言 snapshot 版本值由 Runner 侧提供。
- **串行队列 + claim + lease**：条件 SQLite update 原子 claim（同一 Runner 同时至多一个 active attempt，多个 QUEUED 允许）；owner token + lease deadline + heartbeat 续租（校验 owner/attempt）；production E2E 实测"第二个 Run 在第一个执行时保持 QUEUED，queued-cancel 不触碰 RUNNING 的 Run、不产生 workspace、无 Model"。
- **6 Stage 事件模型**：PREPARING/ANALYZING/PLANNING/MODELING/VALIDATING/PACKAGING；Status 与 Stage 分离；每 Run 严格递增 sequence；production E2E 实测完整六 Stage 顺序 + model-less COMPLETED（Phase 3 契约决定，`Completed` 不带 `modelId`，不创建 `models` 记录）。
- **Fake Executor 全场景矩阵**：success/clarification/failure/cooperative-cancel/hang/crash/recovery-supported/recovery-unsupported/artifact-validation-failure；场景选择只经 Runner 构造/测试 harness 配置，生产默认 success，产品 UI 无 fake scenario 控件（browser E2E 显式断言）。
- **取消语义**：QUEUED 原子取消；RUNNING 先持久化 CancellationRequested（恰好一次）→ 协作中止 → 有界等待 → allowlist 清理 → 原子确认；清理失败显式 `CANCEL_CLEANUP_PENDING`（FAILED，绝不虚报取消）；foreign live lease `CANCEL_PENDING`（不抢租约）；意外中断永不写 CANCELLED；终态重复取消稳定。browser E2E 覆盖 queued/running 取消与两种结构化失败结果。
- **中断/恢复**：过期 lease 与启动恢复（QUEUED 可重 claim；PREPARING/ANALYZING/PLANNING 仅 `recovery-supported` 声明可恢复，否则 RECOVERY_UNSUPPORTED；MODELING/VALIDATING/PACKAGING 无 checkpoint 即 RECOVERY_FAILED）；Runner `open()` 在 live-lease ACTIVE attempt 时自动启动队列循环。production E2E 实测：(a) success 场景快速重启后 Run 恢复为 FAILED/RECOVERY_UNSUPPORTED 且**不是 CANCELLED**，snapshot 事件可读；(b) `recovery-supported` 场景快速重启后从持久 stage 恢复走完六 Stage 至 COMPLETED，事件序列无重复无缺口。
- **UI 重连**：snap
shot-then-subscribe（从 `lastEventSequence + 1`）、严格有序应用、重复幂等忽略、缺口/流失败 refetch + resubscribe、unmount 退订 + 重挂载从最后 sequence 重订阅（browser E2E 全部覆盖）；named-pipe 订阅服务端先补发 backlog 再推 live batch（按 runId 过滤）。
- **测试专用执行器配置（本批次新增，契约决定）**：`SWPANEL_TEST_FAKE_EXECUTOR_SCENARIO` / `SWPANEL_TEST_FAKE_EXECUTOR_STEP_DELAY_MS` / `SWPANEL_TEST_RUN_LEASE_MS` 只在 unpackaged 启动时被读取（packaged 携带任一变量即拒绝启动，与 `--swpanel-test-runtime-root` 一致）；Renderer/IPC payload 永不携带；production config 无 dev server 依赖。
- **Exit Gate 证据（2026-08-13）**：`npm run check` exit 0（root 10/289、desktop 29/557、runner 12/236、contracts 4/47、domain 12/51、ui 6/43）；`npm run check:fixtures` 13/13 零 violations；`npm run test:e2e` exit 0（production Electron 18/18、browser + smoke 49/49）。**Phase 3 = PASS（2026-08-13）**；Phase 4 未开始、不启动。
- **F1 已解决（2026-08-13 审计）**：`run.create` 使用 Main 按调用铸造的唯一 intent id 幂等键（`run-create:<uuid>`）——同 Revision 显式第二次创建真实产生新 Run（R01/R02，主进程单测 + 集成测试 B2 + production E2E 串行队列测试回归），同一 envelope 重复派发仍幂等（Runner 键缓存测试覆盖）；intent id 不进入 Renderer payload / Runner wire command；澄清后"重新自动建模"在生产产品中真实创建新 Run。原"待决策风险"条目关闭。
- **F2 已解决（2026-08-13 审计）**：`Runner.open()` 在存在 QUEUED Run 时也启动并排空串行队列（不再要求 live lease 或新的 `run.create`）；确定性 reopen 测试覆盖（手动 scheduler：reopen 后立即 RUNNING、flush 后 COMPLETED）。
- **F3 已解决（2026-08-13 审计）**：终态读模型（Runner + 浏览器 fake）清空 stage/activity/progressPercent（执行已结束，历史在事件日志）；`DEFAULT_RUN_PROFILE` 占位 skill hash 说明保持文档化（Phase 5 前不验证）。
- **未变的外部待办（保持真实）**：真实第二 Windows 账户 pipe 拒绝测试（人工安全跟进，未执行）；Authenticode 签名与 clean-Windows 离线 smoke（Phase 8 外部交付待办，未执行、未通过）；canonical package/installer 滞后于最新 Phase 3 源码（旧包哈希不得当作最新源码证据）；本工作树全部实现未 commit（Git revision 不可复现 canonical 产物）。

---

## 16. Phase 4 已完成能力摘要与 Exit Gate 证据（2026-08-13 PASS）

Phase 4 — Input Adapter and Agent Contract（**P4-0 起执行，2026-08-13 全部批次完成并 Exit Gate PASS**；正式 Exit Gate 定义见 `development-plan.md` §8：在不调用真实 SolidWorks 的测试 Executor 下，Prompt、事件、Clarification、Manifest 协议完整端到端工作）。以下为 P4-6 收口后的实现与证据摘要（详细批次记录见第 14 节 Change Log 批次 L；正式协议见 `docs/05-engineering/agent-spec.md`）：

- **版本化合同 + JSON Schema（P4-0）**：`packages/contracts/src/phase4/` 八类合同（IPC Envelope / Invocation Package / Runtime Metadata / Product Events / Clarification / Error / Input Adaptation / Result Manifest），每类带固定 contract version、TypeScript DTO、draft-07 JSON Schema（`PHASE4_SCHEMAS` 注册表）与无依赖严格验证器（`Phase4ContractError`）；12 种 `RUN_EVENT_TYPES` 的 payload 全覆盖；contracts 套件 13 files / 141 tests。
- **Input Adapter 边界 + deterministic fakes（P4-1）**：domain 纯数据模型（8 scenarios、page selection、provenance、`productionVerified`、`isTestOnlyScenario`）+ Runner `FakeInputAdapter` 场景矩阵；**不静默选页**（多页无显式选择/越界 → `PAGE_SELECTION_REQUIRED` 失败关闭；单页路径无显式选择时 provenance 不记录 page/layout 断言）；**合成真实性（M1）**——所有合成成功 `productionVerified: false` + warning、DWG/DXF 强制 `-test-only`、`productionVerified: true` 即 `RunnerInvariantError` 失败关闭；派生图像/preview/`adapter-result.json` 经 workspace ledger 写入 attempt `input/`（containment/hash），不改写原始 drawing；场景注入仅 Runner 构造/测试 harness（unpackaged-only fail-closed），Renderer/IPC 永不携带。
- **受控 Prompt Template + Invocation Package（P4-2）**：`PROMPT_TEMPLATE_VERSION = "2026.08-p4"`（产品代码内固定版本化常量，无 UI 编辑入口），从冻结 `RunInputSnapshot` + provenance + workspace + Invocation Package 确定性渲染；Invocation Package 由 Runner 从冻结 Snapshot 构建并严格校验（Agent 永不见客户端快照）；`DEFAULT_RUN_PROFILE` 冻结 `2026.08-p4`。
- **raw→product 边界（P4-3）**：版本化 raw record 协议（v1，10 类型）只写 attempt 技术目录；`product-event-translator` 是唯一转换桥——技术记录（session_started/runtime_log/runtime_error）不派生产品事件，**绝不派生 `Completed`/`Failed`**（终态事件归 orchestrator），非法版本/未知类型/畸形/越序 → `AGENT_PROTOCOL_INCOMPATIBLE` 稳定失败，原始推理不暴露给 Renderer；确定性 Fake Agent Adapter（`codex-app-server` 0.1.0 / 协议 v1）。
- **Clarification 合同闭环（P4-4）**：结构化 question set（dimension/choice）；回答校验 → `ANSWERED` → 答案转 Revision Facts（`source: "CLARIFICATION"` + `sourceRunId`）；旧 Run 终态不续跑，用户手动创建新 Run；幂等不产生重复 facts；clarification/answers/facts 原子提交。
- **Result Manifest + 独立 Artifact 校验（P4-5）**：确定性 synthetic artifact 集（.SLDPRT/Preview/Dimension Ledger/Feature Plan/Validation Log/Builder Source；`recordMp4=true` 时 processMp4 必需）+ 版本化 Manifest；`ArtifactValidator` 独立验证（manifest schema/版本 → 安全 workspace-relative 路径 → 必需 artifact 存在/非零字节/size+SHA-256 匹配/canonical 不逃逸 → `rebuildStatus: "PASSED"` 最低要求）——**Agent 自称完成不具权威性**，只有独立校验通过才 `completeAttempt`；失败先 `ArtifactValidationFailed` 再准确 failure code 终止；未新增 schema v4 数据表（按计划用 event + workspace manifest 完成 gate）。
- **per-claim 队列错误边界（M2 审查修复）**：单个 claim 抛出的 workspace/adapter/prompt/agent IO 异常不击穿串行队列——PREPARING 内适配错误已转准确结构化终态失败（`INPUT_ADAPTER_FAILED`/`PREFLIGHT_FAILED`）；其它 claim 错误由 lease 到期恢复如实分类（FAILED/INTERRUPTED，绝不 CANCELLED）；RESUMED claim 再失败立即 `RECOVERY_FAILED` 且仅当仍 ACTIVE/owned（并发取消永不产生第二终态事件）；回归测试注入抛异常 adapter/workspace（第一 Run FAILED 恰一个终态事件、第二 Run 同一队列循环 COMPLETED）。
- **Exit Gate 证据（2026-08-13，本 session 重跑）**：`npm run check` exit 0（root 10/289、desktop 29/557、runner 18/309、contracts 13/141、domain 13/59、ui 6/43；`.scratch/check-p4.log`）；`npm run check:fixtures` 13/13 零 violations RESULT PASS（`.scratch/check-fixtures-p4b.log`）；`npm run test:e2e` exit 0——production Electron **20/20**、browser + smoke **51/51**（phase4.browser.spec.ts 2/2 新增；`.scratch/test-e2e-p4.log`）。**Phase 4 = PASS（2026-08-13）**；Phase 5 未开始、不启动。

---

## 17. Phase 5 仓库侧契约实现状态（2026-08-14 进行中；Exit Gate 未 PASS）

Phase 5 — Agent Runner + SolidWorks Skill Integration（正式 Exit Gate 定义见 `development-plan.md` §9）。**当前判定：Exit Gate 未 PASS（2026-08-15，不越报）**——仓库侧 P5-1..P5-4 契约实现 + live 接线在 2026-08-14 树上最终验证通过（历史记录，见第 13 节 A7/B7/C7/D7）；**2026-08-15 当前工作树全新全量验证通过**（`npm run check` exit 0——root 10/291、desktop 31/572、runner **38 files/738**、contracts 13/148、domain 14/70、ui 6/43；`check:fixtures` 1/1；`test:e2e` 顺序通过 20/20 + 51/51，见第 13 节 A9；历史 A8 保持记录）；**三次获批链 HIL 尝试（2026-08-15）均未完成**（两次真实 Runner turn 如实失败——`AGENT_PROTOCOL_INCOMPATIBLE`、`AGENT_RUNTIME_UNAVAILABLE`——第三次在 `Runner.open` 前停止）；SolidWorks 2025 33.0.0.5050 已安装且 COM 已注册但当前不可驱动（availability 门 FAILS）——详见下方 2026-08-15 现场证据小节。默认产品路径保持**确定性 synthetic Fake Preflight / Fake Agent**（`codex-app-server` 0.1.0 / protocol v1）：preflight 报告恒 **`synthetic: true`**，Models 恒 **`productionVerified: false`**。

### P5-1 九项 preflight 能力门（报告 v2，恒生效，synthetic 默认）

- `packages/domain/src/runs/preflight.ts` `PREFLIGHT_CAPABILITIES`（**九项**规范顺序，报告契约 **v2**；v1 报告历史保留不重写）+ `apps/runner/src/preflight/preflight.ts` 探针边界：门恒在 PREPARING 评估，首败即终止（准确失败码），探针抛错该项 fail-closed（redacted），`input_adapter_succeeded` 仅适配成功后由 executor 标记。
- **SolidWorks 为 version-agnostic**：门只要求任何可驱动的安装（`solidworks_available`），实际版本由 probe/builder 记录、绝不发明；`solidworks_2022_available` 硬版本匹配已移除。**`mechanical_execution_dependency_resolved` 不再是门项**：`$solidworks-build-mechanical-models` 引用保留为 Skill prose、非阻塞、绝不伪装为已解析。
- **默认产品路径 = 显式 synthetic/unverified fixture**（`DEFAULT_PREFLIGHT_SCENARIO = "all-pass"`、`FAKE_PREFLIGHT_SKILL_SHA256`），持久化报告恒 `synthetic: true`，绝不假装真实环境探针通过；场景注入仅 Runner 构造/测试 harness（unpackaged-only fail-closed），Renderer/IPC 永不携带。
- **真实 probe 已实现并最终验证**：`apps/runner/src/preflight/real-preflight-probe.ts` + `skill-directory-hash.ts`——真实有界 `codex --version` 探针（精确 pin `0.147.0`）、真实 skill 目录发现 + 规范目录 SHA-256（与冻结 snapshot digest 精确相等）、真实 workspace 可写探针、注入式 SolidWorks seam、`synthetic: false`；注入仅限 Runner 构造/测试 harness，产品默认仍是 synthetic all-pass。
- **外部 skill copies 已同步（2026-08-14）**：`C:\Users\Eric Chan\.agents\skills\solidworks-build-part-from-drawing` 与 `C:\Users\Eric Chan\.codex\skills\solidworks-build-part-from-drawing` 两副本规范目录 digest 均为 **`3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`**（仓库 `hashSkillDirectory` 复验，逐字节一致）；`DEFAULT_RUN_PROFILE` 仍 pin synthetic fixture digest（`FAKE_PREFLIGHT_SKILL_SHA256`）——那不是外部 digest 的生产验证。

### P5-2 Model 发布（原子，产品默认）

- 成功路径**单事务原子发布 `PENDING_REVIEW` Model**（Model 行 + artifact 元数据行 + 带 Model id 的 `Completed` 事件 + FINISHED attempt；`apps/runner/src/orchestration/run-orchestrator.ts`）；Runner 产品默认 `publishModel: true`（`false` 仅 Phase 3/4 model-less 兼容）。
- manifest 的 `productionVerified` 由契约解析 wire boolean（缺省 `false`）；独立 ArtifactValidator 以 `ARTIFACT_MANIFEST_INVALID` 拒绝 `productionVerified: true`（无产品侧 HIL 验证记录、声明绝不 authoritative）——仅 `false`/缺省可发布，synthetic 结果如实持久化 `productionVerified: false`。

### P5-3 Codex App Server（契约钉定；live stdio transport 已实现，live smoke 成功）

- `apps/runner/src/agent/codex/`：严格 NDJSON JSON-RPC client + adapter + agent-session + builders，钉定 **`codex-cli 0.147.0` / protocol v2**（0.147.0 schema 文档在 `.scratch/codex-app-server-schema-0.147.0/v2/`；builder 只发射真实 0.147.0 字段名）。
- **shell-free live stdio child transport + lifecycle 已实现**（`codex-child-transport.ts`：`app-server --stdio`、`shell: false`、`windowsHide`、Windows 可执行解析真实（`.cmd` shim 拒绝）、有界 SIGTERM→SIGKILL close、有界 stderr tail、exactly-once 退出传播；hermetic 测试用脚本化 Node 子进程）。
- **live smoke（2026-08-14，最终验证）**：真实 `initialize` + `skills/list` 对 0.147.0 App Server 运行时**通过**（native smoke），发现两个精确外部 skill copies（`.agents`/`.codex`，digest `3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`），**skill 目录→`SKILL.md` 精确路径校验通过**；**live Runner 已接线 owned Codex adapter + 真实 PDF adapter**（`apps/desktop/src/main/runner-host/live-codex-wiring.ts`：每 Runner 恰一个持久 child transport、严格 NDJSON client、async turn adapter、`RealPdfInputAdapter`（bundled pypdfium2、显式 helper 路径解析到 asar）、`ownsAgent: true` 关闭时有界回收）；**完整 live 建模 turn 链未做 HIL 验证**；无任何 HIL-verified live Codex session 声称。

### P5-4 ownership-safe Cancel + 低 Stage 钉定恢复（仅契约测试）

- 取消：`apps/runner/src/execution/ownership/solidworks-ownership-guard.ts`——不可变 `OwnershipRecord` 绑定 (runId, attemptId)，只含 attempt 自记录的 OS pid + 文档身份；`closeOnlyOwned` 只关证明成立的身份；unproven/partial/failed 保守映射 `CANCEL_CLEANUP_PENDING`（取消绝不确认于可能仍有 SolidWorks 身份存活时）；绝不枚举进程 / 绝不 kill-all。
- 恢复：`apps/runner/src/execution/recovery/`——仅 `null`/PREPARING/ANALYZING/PLANNING 可证明续跑（`THREAD_SESSION_RESUME_STAGES`），MODELING/VALIDATING/PACKAGING 硬性 no-checkpoint（`THREAD_SESSION_NO_CHECKPOINT_STAGES`，任何注入谓词不可放宽）；畸形 session 永不信；钉定谓词默认 `codex-app-server` / protocol v2（session 协议字段；与 codex-cli `0.147.0` 发行版为两个独立钉定，恢复只键控 session 协议字段；adapter 写入的 session 即此协议字段、与恢复钉定一致；协议变更不会静默恢复当前协议无法证明的线程）。
- **二者从未 HIL 验证**；HIL（获批 Windows + 可驱动 SolidWorks 机器）仍为 Exit Gate 要求。
- **async ownership-safe SolidWorks live probe（P5-4 现场侧，已实现并最终验证）**：`apps/runner/src/preflight/solidworks-live-probe.ts`——先对既有 `SldWorks.Application` COM 实例 READ-ONLY attach（绝不关闭、绝不触碰文档；抛错/超时/`ok:false`/foreign/畸形 attach 结果**绝不落入 owned-spawn 路径**——attach 错误不再 spawn，只有干净 `ok:true, attached:false` 才可 spawn）；仅无实例时从 Node 直接 spawn `SLDWORKS.exe`（`shell:false`、`windowsHide:true`），COM ownership 以精确 pid 证明（2026-08-15 起：有界 Python/pywin32 `GetActiveObject` 为准，PowerShell 仅 registry/文件版本发现——PowerShell `GetActiveObject` 曾是 `TYPE_E_ELEMENTNOTFOUND` 假阴性源；owned spawn 用精确 Node child handle/PID + 精确 `GetProcessID()` 相等，无 Dispatch/CreateObject、无 kill-all、无 ExitApp/Quit），随后只关闭 owned 进程（owned handle kill + await exit；绝不 taskkill-by-name、绝不 kill-all）。**本机实测（2026-08-14，历史）**：`available:false`、`installedVersion` 33.0.0.5050、`ownedProcessSpawned:true`、`ownedProcessClosed:true`（reason `ownership-not-proven`），probe 后**无残留 SLDWORKS.exe 进程**。**2026-08-15 更新**：早退缺陷已修复——probe 并发观察精确 owned 进程早退、abort/await helper child、以稳定 reason `owned-process-exited` 及时返回（安全 `ownedProcessExitCode`、`installedVersion`、真实的 owned spawned/closed 事实）；窄范围真实 probe 证据见 `.scratch/hil-20260815-214252-393c22d8/22-solidworks-probe-after-early-exit-fix.json`（`available:false`/`installedVersion` 33.0.0.5050/owned spawned+closed true/exit 3221225477/reason `owned-process-exited`/7044ms，无残留 SLDWORKS/codex 进程）。Electron Main host await 该 probe 并注入固定 seam 到 `RealPreflightProbe`。

### 2026-08-14 验证快照（当前树最终验证；时间线如实记录）

- `npm run check` exit 0（`.scratch/check-p5-final.log`）——**当前树最终整链重跑**：root 10/291、desktop 31/572、runner 37/691、contracts 13/148、domain 14/70、ui 6/43，**计数含全部 P5 套件**（preflight / preflight-execution / model-publication / agent/codex/* / ownership / recovery / real-preflight-probe / skill-directory-hash / codex-live-probe / solidworks-live-probe / real-pdf-input-adapter / python-pdfium-rasterizer / codex-child-transport / live-codex-config / live-codex-wiring）。早前"14:48 运行早于 P5 批次落地、全量 check 在最新并发 preflight/PDF 集成前通过、最终重跑待办、不声称当前全绿"的时间线说明**已被取代**——最终重跑覆盖当前树，**当前全绿、计数已钉定**。
- `npm run check:fixtures`：**1/1 通过**（13/13 零 violations RESULT PASS，`.scratch/check-fixtures-p5-final.log`；干净顺序运行，无 build-clean 干扰）。
- `npm run test:e2e` exit 0 **顺序通过**（`.scratch/test-e2e-p5-final.log`）：production Electron **20/20**、browser+smoke **51/51**。
- **model-detail 1366/1920 baseline 于 18:15 有意刷新**（新 synthetic provenance badge"合成预览 · 未生产验证"；旧截图预期为 stale baseline，非产品回归）。
- **最终现场证据（2026-08-14）**：Codex 0.147.0 `initialize`+`skills/list` native smoke 通过（`skillPathVerified:true`——**skill 目录→`SKILL.md` 精确路径校验通过**）；live Runner 接线 owned Codex adapter + 真实 PDF adapter；获批 PDF 300 DPI / pypdfium2 4.30.0 真实栅格化 4963×3509（源哈希 `e321dc34c80b943b8af9ca9ea4ebbf9f42003627707503bf25512a479cda72a0`、输出哈希 `30614c32a5dba38374642bf76e0e7e763674e15b78455c2cb4ff18d316ae7d96`、`productionVerified: false`、产物在 temp/仓库外）；async ownership-safe SolidWorks live probe 实测 `available:false`/`installedVersion` 33.0.0.5050/owned 进程已关闭/无残留进程/attach 错误不再 spawn；probe 版本写入 prompt 并在 ArtifactValidator 精确校验。

### 2026-08-15 现场 HIL 尝试与修复证据（三次尝试，均未完成；Exit Gate 保持 NOT PASS）

- **尝试 1（14:23，`.scratch/hil-20260815-142334-52f26231`）**：真实 Runner Run 如实 FAILED `AGENT_PROTOCOL_INCOMPATIBLE`；九项 preflight 全过（`synthetic:false`）、真实 PDF adapter 通过、SolidWorks probe `available:true`/version `33.0.0`/`owned-process-proven`。根因：原生 Codex 0.147.0 在 `experimentalApi:false` 下拒绝实验性 `thread/start.runtimeWorkspaceRoots`；修复为移除该 gated 字段——稳定 thread start = `cwd` + `sandbox:"workspace-write"`、attempt-root 包含在 `turn/start.sandboxPolicy`，live preflight 现含无害真实 `thread/start`。
- **尝试 2（14:48，`.scratch/hil-20260815-144823-3836c9fc`）**：真实 Runner Run 如实 FAILED `AGENT_RUNTIME_UNAVAILABLE`；九项 preflight 与真实 PDF adapter 全过；真实 `thread/start` + `turn/start` + failed turn 已发生；SolidWorks probe 再次 `available:true`/`33.0.0`/`owned-process-proven`；无 CAD/artifacts。adapter 丢弃了原生 `turn.error.message`，精确的 Skill/image Turn 错误因此丢失——已由失败回合诊断保留修复。
- **尝试 3（21:42，`.scratch/hil-20260815-214252-393c22d8`）**：在 `Runner.open`/Run 创建前停止（Codex 0.147.0 probe 与精确 Skill 路径/digest 通过、SolidWorks probe fail-closed）——harness/preflight 停止，不是 Run 终态失败。
- **失败回合诊断保留（已实现）**：Codex `turn.error.message` 确定性脱敏（URL、含空格绝对路径、credentials/env secret keys、JWT；控制符/空白归一；上限 512 字符）仅写入技术 `runtime/agent-session.json` note；产品可见 `AGENT_RUNTIME_UNAVAILABLE` 保持通用；失败路径不写原始 agent 日志。Harness 1.0.2 只允许复制严格的 status/adapter/protocol 白名单字段 + 有界脱敏 note 为 `14-agent-session-diagnostic.json`——绝不复制完整 session/thread/turn/attempt ID、时间戳或原始日志。`skill.resolvedPath` 亦做绝对路径校验。
- **SolidWorks COM probe 重设计**：PowerShell `GetActiveObject` 在 Python/pywin32 可用的主机上是假阴性源（`TYPE_E_ELEMENTNOTFOUND`）。COM attach/poll 现仅用有界 Python/pywin32 `GetActiveObject`；PowerShell 仅做 registry/文件版本发现。既有实例只读。owned spawn 用精确 Node child handle/PID、精确 `GetProcessID()` 相等，无 Dispatch/CreateObject、无 kill-all、无 ExitApp/Quit。
- **主机状态动态**：前两次 HIL probe 成功（`available:true`/`33.0.0`/`owned-process-proven`）；21:42 第三次 owned SolidWorks 启动在 COM 注册前退出。`21-solidworks-startup-diagnostic.json` 精确 handle 诊断显示 default、`/ForceSoftwareOGL /SWDisableExitApp`、`/SWSafeMode /SWDisableExitApp` 均在 ~3–4 s 以 unsigned 3221225477（`0xC0000005`）退出。**当前崩溃不结论性归因于 AMD/atio6axx**；AMD Radeon driver 31.0.12042.4 仅作主机上下文/历史假设记录。两个 Rx session-safe 模式均失败意味着硬件 OpenGL 与普通 Tools/Options 状态未被单独隔离为唯一原因。SolidWorks 已安装且 COM 已注册，但当前不可驱动。
- **产品 probe 早退修复（该证据之后）**：probe 并发观察精确 owned 进程早退、abort/await helper child、以稳定 reason `owned-process-exited` 及时返回（安全 `ownedProcessExitCode`、`installedVersion`、真实的 owned spawned/closed 事实）。窄范围真实 probe 证据（`22-solidworks-probe-after-early-exit-fix.json`）：`available:false`、`installedVersion` 33.0.0.5050、`ownedProcessSpawned`/`ownedProcessClosed` true、exit code 3221225477、reason `owned-process-exited`、duration 7044ms；无 Codex/PDF/Run/HIL；无残留 SLDWORKS/codex 进程。
- **全部代码修复后的聚焦验证（2026-08-15，历史范围；已由第 13 节 A9 / 批次 Q 取代）**：当时聚焦 SolidWorks probe **41/41**、完整 Runner **38 files / 738 tests**、Runner typecheck、仓库 lint 与 Runner build 通过；当时尚未重跑全仓库 check/fixtures/E2E。随后 A9/批次 Q 已在当前工作树完成全新全量验证并全部通过，因此不得再把本条的“未重跑”状态当作当前事实。
- **Exit Gate 保持 NOT PASS（2026-08-15）**：无成功 `.SLDPRT` + 六 Artifact + Model（`PENDING_REVIEW`）；无真实 Clarification 场景；无 ownership-safe 取消 HIL。`productionVerified` 恒 `false`；不进入 Phase 6；未 commit/push——当前工作树仍无法由 Git revision 复现。

### 外部硬阻塞（2026-08-14 更新；下方 2026-08-15 事实取代当前措辞）与 Exit Gate 前置

- **2026-08-15 更新（当前事实）**：主机状态动态——前两次 HIL probe 成功（`available:true`/`33.0.0`/`owned-process-proven`），21:42 第三次 owned SolidWorks 启动在 COM 注册前退出；`21-solidworks-startup-diagnostic.json` 显示 default、`/ForceSoftwareOGL /SWDisableExitApp`、`/SWSafeMode /SWDisableExitApp` 均 ~3–4 s 以 `0xC0000005` 退出；**当前崩溃不结论性归因于 AMD/`atio6axx`**（AMD Radeon driver 31.0.12042.4 与 2026-08-14 CXPD dump 仅为主机上下文/历史假设）；SolidWorks 已安装且 COM 已注册但当前不可驱动。三次获批链尝试均未完成（两次真实 Runner turn 如实失败、第三次在 `Runner.open` 前停止）——**无成功 `.SLDPRT` + 六 Artifact + Model（`PENDING_REVIEW`）、无真实 Clarification 场景、无 ownership-safe 取消 HIL**；`productionVerified` 恒 `false`；不进入 Phase 6；未 commit/push。
- **SolidWorks availability 门当前 FAILS**：本机安装 **SolidWorks 2025 产品版本 33.0.0.5050**，但 COM 激活与直接启动均在 AMD 驱动 `atio6axx.dll` 31.0.12042.4 以访问违例 `0xc0000005` 崩溃（本地 CXPD dump 证据，如 `C:\Users\Eric Chan\AppData\Local\SolidWorks\CXPD\20260814222204_33.0.0.5050\SLDWORKS.exe.*.dmp`）；SolidWorks live probe 本机实测 `available:false`/`installedVersion` 33.0.0.5050/owned 进程已关闭/无残留进程；`$solidworks-build-mechanical-models` 保持非阻塞 prose（未验证）；**无获批图纸真实 E2E**；真实 PDF/DWG/DXF 生产转换未完全验证（真实 PDF adapter 已实现并最终验证；DWG/DXF 仍 synthetic）；真实 skill hash 校验：外部副本已同步（digest `3d4bfbc9…`）、真实 probe 已实现（synthetic 门只接受 `FAKE_PREFLIGHT_SKILL_SHA256`；`DEFAULT_RUN_PROFILE` fixture digest 不是外部 digest 的生产验证）。
- Exit Gate 判 PASS 前仍需（2026-08-15 当前工作树全新全量验证已通过并全绿：`npm run check` exit 0——root 10/291、desktop 31/572、runner 38/738、contracts 13/148、domain 14/70、ui 6/43；`check:fixtures` 1/1 零 violations；`test:e2e` 顺序通过 20/20 + 51/51，见第 13 节 A9；历史 A7/B7/C7 与 A8 保持记录）：**可驱动的 SolidWorks 环境**（2025 33.0.0.5050 已安装且 COM 已注册但当前不可驱动——default 与两个 Rx session-safe 模式均 `0xC0000005` 早退）；真实 skill hash（外部副本 digest `3d4bfbc9…`）；live Codex 全链路验证（非 HIL）；**HIL**（成功 `.SLDPRT` + 六 Artifact + Model（`PENDING_REVIEW`）、真实 Clarification 场景、ownership-safe Cancel、低 Stage 恢复、blocker 图纸证明澄清前未启动 SolidWorks——**三次 2026-08-15 获批链尝试均未完成**）。
- 未变的外部待办：第二 Windows 账户 pipe 拒绝测试（人工安全跟进）；签名与 clean-Windows 离线 smoke（Phase 8 外部交付待办，未通过）；canonical package/installer 滞后（旧包哈希不得当最新源码证据）；实现代码未 commit（Git revision 不可复现）。**不 commit/push、不进入 Phase 6。**
- **不声称（保持真实）**：真实 PDF/DWG/DXF 生产转换（DWG/DXF 仍 synthetic `productionVerified: false`、`-test-only`；真实 PDF 单份栅格化是最终验证的真实转换证据但 `productionVerified: false`，需获批图纸进一步验证）；真实 SolidWorks/Codex 全链路集成（native smoke 非 HIL；availability 门当前 FAILS）；真实第二 Windows 账户 pipe 拒绝测试（人工安全跟进，未执行）；Authenticode 签名与 clean-Windows 离线 smoke（Phase 8 外部交付待办，未执行、未通过）；canonical package/installer 滞后于最新 Phase 5 源码（旧包哈希不得当作最新源码证据）；本工作树全部实现未 commit（Git revision 不可复现 canonical 产物）。

---

## 18. 2026-08-16 Phase 5 继续开发交接（当前权威状态）

### 已完成的仓库侧闭环

- Agent Turn Output v1 已成为严格 `completed | clarification_required` 终态合同。canonical schema 保留互斥 `oneOf`；Codex 0.147.0 使用 flattened/closed/required+nullable-sentinel provider wire schema，并由 Runner 严格投影回 canonical validator。`PROMPT_TEMPLATE_VERSION = "2026.08-p5.1"`。
- `completed` 继续走 Result Manifest → 独立 ArtifactValidator → 单事务 `Model(PENDING_REVIEW)`；`clarification_required` 原子写 Clarification Request/产品事件并终止旧 Run，不写 Manifest、不校验 Artifact、不发布 Model、不自动重跑。
- 终态抽取为有界 delta + string-aware balanced-object scanner，整回合只允许一个有效 terminal document。所有抽取/timeout notes 均为内容无关类别，不持久化 Agent 文本、raw JSON、业务路径或 raw response。
- Codex turn wait 固定 15 分钟，client/adapter 共用同一常量。当前 turn item 才能影响 timeout 分类；foreign-turn item 不计。同步 write failure 与 turn-wait timeout 之后共享 client 仍可复用，迟到 response 不会被误判为未知 id 协议故障。
- Live cancellation 已接 attempt-scoped SolidWorks ownership registry、exact document identity、document-only closer 与 transactional cleanup ownership fence；无证明即 `CANCEL_CLEANUP_PENDING`，禁止 process-name termination、kill-all、`ExitApp` 或 `Quit`。

### 2026-08-16 实证边界

- Provider schema probe `.scratch/codex-output-schema-probe-20260816054054327-c8cfe1c6.json` 通过，但仅证明 schema acceptance/projection；没有获批业务图纸或真实工程 blocker，**不能计作工程 Clarification HIL**。
- `.scratch/hil-20260816-125909-c6eccb74` 是 canonical `oneOf` 被 native provider 拒绝的真实技术失败证据。
- `.scratch/hil-20260816-140950-b6482492` 使用获批 PDF，真实 preflight、Runner、PDF adaptation 通过，但在旧 600 秒 turn 上限如实 `FAILED / AGENT_TIMEOUT`；无 ownership registry、`.SLDPRT`、Manifest、Clarification、Artifact 或 Model。
- `.scratch/hil-20260816-143105-4e1a0596` 在 `Runner.open` 前由 SolidWorks probe fail-closed：exact harness-owned process 以 `3221225477`（`0xC0000005`）早退，`available:false`、owned process 已关闭、isolated temp root 已删除。未改驱动、注册表、安装或系统配置；因环境不可驱动，未继续 real Clarification/cancel HIL。

### 最新验证与下一执行条件

- 最终树全绿：`npm run check` exit 0——root 10/291、desktop 31/576、runner 42/855、contracts 14/162、domain 14/70、UI 6/43，共 **117 files / 1,997 tests**；typecheck、lint、完整 build 通过。`check:fixtures` 1/1、13/13、0 violations。`test:e2e`：production Electron 20/20，browser + Electron smoke 51/51。
- **Phase 5 = NOT PASS**。仍缺三类关键 HIL：成功真实 `.SLDPRT` + 六 Artifact + 原子 Model；真实工程 Clarification；ownership-safe Cancel。`productionVerified` 必须保持 `false`，Phase 6 不得开始。
- 当前主机 SolidWorks 未恢复可驱动前，不再重试真实 CAD HIL。环境若经单独授权的外部动作恢复，下一步顺序是 bounded preflight → approved-PDF main HIL → genuine blocker Clarification HIL → ownership-safe Cancel HIL；任一 ownership、schema、skill digest、artifact 或 version 校验失败都立即 fail-closed。
- 不 commit/push；获批 PDF、`.SLDPRT`、preview、业务 artifact bytes、raw Agent logs、完整 session 与 secrets 不得写入版本库或 HIL 证据包。Electron 窗口关闭后 Runner 独立继续仍不受当前 Main-hosted 架构支持，不能声明通过。

---

## 19. 2026-08-17 Phase 5 进展与现场闭环证据（当前权威状态）

### 现场事实与已完成的修复闭环

1. **SolidWorks 本机环境已确认恢复可用**：真实探针 `probeSolidWorksRuntime()` 实测通过（`available: true`, `version: "33.0.0"`, `installedVersion: "33.0.0.5050"`, `ownedProcessProven: true`，测试进程正常回收无残留）。
2. **外部 Skill 幽灵依赖修复**：两处外部副本（`.agents` 与 `.codex`）将不存在的 `$solidworks-build-mechanical-models` 同步改为已安装的 `$solidworks-automation`，两副本逐字节一致，新规范 digest 重新计算并冻结为 `26f77b00cd4b9e0e253951d876e75ec04c29b49f890d9458f4242e87657b5dcd`；live smoke 验证通过。
3. **后台无人值守审批策略显式固定**：`thread/start` 与 `thread/resume` 固定输出 `approvalPolicy: "never"`，避免依赖交互审批。
4. **超时的精确中断与客户端保护**：`waitForTurnCompleted` 超时后自动向对应 `threadId/turnId` 发送 `turn/interrupt` 并在有界 grace 内确认；中断失败或超时则毒化并关闭客户端，防止后台 Agent 在 Run 失败后残留写操作。
5. **语义完全相同的重复终态文档自动去重**：`extractAgentTurnOutput` 对 canonical 深度等价的合法 terminal documents 进行折叠，解决模型回显重复 JSON 导致的误拒；冲突文档仍严格拒绝。
6. **内容无关的活动诊断**：wait-failure session note 补充安全的活动类别统计（`agent-message`, `command-execution`, `file-change`, `tool-or-other`, `approval-request`），不泄露任何路径或原始消息。

### 实证与全量验证记录

- **确定性 Harness 验证**：`node .scratch/hil-deterministic.mjs` 6/6 全通过（覆盖 clarification、cancel-proven-close、cancel-cleanup-pending、recovery-unsupported、recovery-hard-no-checkpoint、recovery-pinned-resume）。
- **全量门禁通过**：
  - `npm run check` exit 0（root 10/291、desktop 31/576、runner 42/875、contracts 14/162、domain 14/70、ui 6/43，共 117 files / 2,017 tests）；
  - `npm run check:fixtures` 1/1 通过（13/13 场景 0 违规，RESULT: PASS）；
  - `npm run test:e2e` 顺序通过：生产 Electron 20/20，浏览器 + Electron smoke 51/51。
- **当前 Exit Gate 状态**：保持 **NOT PASS**。真实 HIL 证明了 preflight 全过、PDF 适配成功、Agent 成功生成 ledger/plan/builder 与 ownership registry，但在 15 分钟上限内尚未取得完整 `.SLDPRT` 及六项 Artifact；Clarification 与 Cancel HIL 亦待在具备明确 blocker 的图纸与 CAD 运行时下最终闭环。所有结果如实保持 `productionVerified: false`。

---

## 20. 2026-08-18 Phase 6 — Model Review 闭环实施与正式 PASS 判定

### 20.1 实施范围与核心交付

依据 `development-plan.md` §10，Phase 6 将发布出的 Model 完整接入人工工程审核闭环（Approved / Rejected 两条路径及 `currentApprovedModelId` 切换真实持久化）：

1. **Contracts 严格校验** (`@swpanel/contracts`)：
   - `packages/contracts/src/ipc-validation.ts`：在 `assertCommandPayload` 中增加 `model.review` 的严格参数校验（`modelId`、`reviewerId`、`reviewedAt` 规范 ISO 校验、`result` 必须为 `"APPROVED" | "REJECTED"`、`REJECTED` 强制要求非空 `comment`、拒绝未知多余字段）。
2. **Runner 数据库迁移与仓储层** (`@swpanel/runner`)：
   - `schema.ts` 升级为 `SCHEMA_VERSION = 6`，新增 migration 6（`phase6-model-reviews`）添加 `CREATE UNIQUE INDEX idx_model_reviews_model_id ON model_reviews(model_id);`，防止并发或重复审核同一模型。
   - `repository.ts` 新增底层原子指针更新方法 `updateCurrentApprovedModelPointer(revisionId, modelId, updatedAt)`。
   - `run-repository.ts` 实现单事务原子 `reviewModel`（校验 `canReviewModel`，流转状态，插入 `model_reviews`，更新 `models.review_status`，APPROVED 时 repoint `drawing_revisions.current_approved_model_id`，REJECTED 时插入 `MODEL_REVIEW_REJECTED` 的 `modeling_feedback`），并实现 `getModelDetail`、`listModelsByRevision` 和 `listPendingReviewItems`。
3. **Runner 服务层与 IPC** (`@swpanel/runner`)：
   - 新增 `ModelWorkflowService` 并挂载至 `Runner` facade。
   - `getRevisionDetail` 真实填充 `models` 列表；`getWorkspaceDashboard` 真实填充 `pendingReviews` 列表。
   - `request-handler.ts` 完整连通 `model.getDetail` 查询与 `model.review` 命令。
4. **Desktop Main / Preload Bridge** (`apps/desktop`)：
   - `bridge-contract.ts` 新增 `MAIN_CHANNELS.modelDetail` (`"swpanel:models:detail"`) 与 `MAIN_CHANNELS.modelReview` (`"swpanel:models:review"`)，及类型与校验器。
   - `main-ipc.ts` 注册处理通道，通过意图幂等键派发 `model.review` 至 Runner。
   - `preload.cts` 在 `window.swpanel` 下暴露 `models` 模块 (`getDetail`, `review`)。
5. **Renderer 异步 Model Repository 与页面解锁** (`apps/desktop/src/renderer`)：
   - 实现 `features/model-repository/`（异步 `ModelRepository` 接口、`BridgeModelRepository`、`MockModelRepository`、`UnavailableModelRepository`、Provider 与 Hook）。
   - `ModelDetailPage.tsx` 与 `DrawingModelsPage.tsx` 移除 `mode !== "mock"` 的 `LaterPhaseState` 拦截，完整解锁真实模型详情展示、卡片网格以及 `ModelReviewPanel` 审核动作。
   - `DrawingOverviewPage.tsx`、`WorkbenchPage.tsx`、`RunDetailPage.tsx` 同步支持模型徽章与待审核链接。

### 20.2 验证证据

- **全量门禁检查 (`npm run check`) — Exit 0**：
  - typecheck（root + 5 个 workspaces 全绿）；
  - eslint 检查 0 错误 0 警告；
  - 单元/组件测试全量通过：root 10 files / 291 tests、`@swpanel/desktop` 33 files / 593 tests、`@swpanel/runner` 43 files / 886 tests、`@swpanel/contracts` 14 files / 171 tests、`@swpanel/domain` 14 files / 70 tests、`@swpanel/ui` 6 files / 43 tests，共 **120 files / 2,054 tests 全部 PASS**；
  - 完整构建（Renderer + Electron main + preload + packages）顺利完成。
- **Fixture 时间线审计 (`npm run check:fixtures`) — Exit 0**：
  - 13/13 个 canonical scenarios 全部 OK，violations: 0，RESULT: PASS。
- **E2E 全量套件 (`npm run test:e2e`) — Exit 0**：
  - Production Electron E2E (`playwright.electron.production.config.ts`)：**20/20 全部 PASS**（含新增真实 Electron + 真实 Runner 下模型发布 -> bridge 审核 APPROVED -> revision 指针原子切换 -> 审核 REJECTED 产生 feedback 真实持久化测试）；
  - Browser + Electron Smoke (`playwright.config.ts`)：**53/53 全部 PASS**（含新增 `phase6.browser.spec.ts` 2/2，覆盖 Drawing Models 列表展示与 Model Approve 页面流转）。

### 20.3 正式判定

**Phase 6 Exit Gate = PASS**（2026-08-18 正式判定）。Approved 与 Rejected 路径以及 `currentApprovedModelId` 切换均已在单元测试、Fake Bridge E2E 和真实 Electron + Runner 端到端测试中得到完整验证。下一阶段为 **Phase 7 — Cost Data 与 Deterministic Cost Engine**（未开始，不越 Gate）。

## 21. 2026-08-18 Phase 7 — Cost Data 与 Deterministic Cost Engine 实施与正式 PASS 判定（当前权威状态）

### 21.1 实施范围与核心交付

依据 `development-plan.md` §11，Phase 7 在 Phase 6 Approved Model 闭环之上建立企业成本数据维护、参数确认、纯确定性计算与不可变成本测算报告的完整持久化闭环。核心原则（与 handoff §2 第 7 条一致）：**LLM 不算最终成本——所有体积/质量/单件成本/批次固定成本/总成本均由 `@swpanel/domain` 内纯数学函数确定性计算，CNY half-up 两位小数舍入**；**报告生成时冻结输入参数与生效成本数据快照，后续全局改价绝不改写历史报告**；**未知语义（`DISPLAY_ONLY`）自定义字段仅存储展示、绝不进入公式**；**只有当前图纸版本的当前 Approved Model 具生成资格**。

1. **Domain 确定性计算器** (`packages/domain/src/cost/calculator.ts`)：纯函数 `calculateCostEstimate(input: CostEstimateInputSnapshot): CostEstimateResult`，28 项专项单测（`calculator.test.ts`）：
   - 毛坯体积：`CYLINDER`（`ØD × L`，直径/长度方向按余量加成）与 `RECTANGULAR_BAR`（`L×W×H` 三向余量）；单位支持 `mm`/`cm`/`m`；
   - 质量：`finishedVolume` 与密度（默认 `7.85 g/cm³`）换算；材料成本按价格单位（`元/吨`/`元/kg`/`元/件`）折算单件材料费；
   - 固定成本：`PER_PIECE` 直接计入单件；`PER_BATCH` 按 `quantity` 分摊；
   - `perPieceCost = materialCostPerPiece + ΣfixedPerPiece + ΣfixedPerBatch / quantity`；`totalCost = roundCny(perPieceCost × quantity)`；`roundCny` = `Math.round((v + Number.EPSILON) * 100) / 100`。
2. **Contracts 与严格校验** (`@swpanel/contracts`)：`costData.get`（空载荷查询）、`costData.update`、`costReport.create`、`costReport.getDetail`、`costReport.listByRevision`；`ipc-validation.ts` 拒绝缺失/未知字段、非法时间戳、非有限或负值、非法数量/毛坯类型与伪造/未知 `result`；`CostReportDetailView` 携带不可变 `snapshot`（`input` + 有效 `costData` + 确定性 `result`）。
3. **Runner 存储与服务** (`@swpanel/runner`)：`SCHEMA_VERSION = 7` migration `phase7-cost-engine`（`idx_cost_reports_revision_id`、`idx_cost_reports_model_id`）；首次读入时播种**合成**默认成本基准（42CrMo/45#钢/40Cr、默认余量、基础加工/检测/包装固定成本、`DISPLAY_ONLY` 备注——**绝不真实企业价格**）；`CostWorkflowService`：`getEffectiveCostData`/`updateCostData`（事务内全量替换定义与值）/`getCostReportDetail`/`listCostReportsByRevision`/`createCostReport`——create 在单流中校验资格闸门 `canCreateCostEstimateReport`、冻结完整输入与有效成本数据快照、调用确定性计算器（**Runner 为权威计算方**）、分配 `Q01/Q02/…`（`costReportLabel`）、不可变持久化；`getRevisionDetail.costReports` 真实填充列表。
4. **Desktop Main / Bridge / Preload / Renderer** (`apps/desktop`)：`bridge-contract.ts` 新增四个 cost 通道（`swpanel:costData:get`/`swpanel:costData:update`/`swpanel:costReports:detail`/`swpanel:costReports:create`）与 `window.swpanel.cost`（`getEffectiveCostData`/`updateCostData`/`getReportDetail`/`createReport`），Main 以意图幂等键派发至 Runner；Renderer `features/cost-repository/` 异步 bridge/mock/unavailable 三适配器 + `CostRepositoryProvider` hooks；`CostDataPage`（材料/固定成本编辑保存）、`CostParamsPage`（从当前版本 Approved Model 收集数量/材料/毛坯/余量并提交 `CostEstimateInputSnapshot`）、`CostReportPage`（渲染不可变快照 5 章节）、`DrawingCostsPage`（当前正式模型 + 历史报告列表）四页在 bridge 与 mock 模式下全部解锁，无后续阶段 placeholder。
5. **测试环境搭建的副作用**：本会话为通过全量门禁还修复了仓库全树 Lint **163 项存量错误**（新建的测试与页面代码引入的 `any`/未用导入/多余断言等，均改为类型化或删除）、`PropertyList` 缺失 `key` 的 React 警告、浏览器 fake-bridge 查询的 Promise 类型、`electron.smoke.spec.ts` 的 `cost` 方法集断言与本地 `swpanel` 类型、`electron.production.spec.ts` Phase 7 段的 `any` 视图类型，以及 `cost-params` 在真实空 Runner 下重定向（改在路由内渲染 not-found 壳，与其它绘图相关路由一致）。

### 21.2 验证证据（2026-08-18）

- **全量门禁 (`npm run check`) — Exit 0**：typecheck（root + 5 workspaces 全绿）、仓库 lint **0 错误（163 项存量错误已清零）**、全部单测/组件测试与完整构建（Renderer + Electron main + preload + packages）通过：root 10 files/291、`@swpanel/desktop` 33 files/593、`@swpanel/runner` 44 files/888、`@swpanel/contracts` 14 files/200、`@swpanel/domain` 15 files/100、`@swpanel/ui` 6 files/43，共 **120 files / 2,115 tests 全部 PASS**。
- **Fixture 时间线审计 (`npm run check:fixtures`) — Exit 0**：13/13 canonical scenarios 全部 OK（含 `cost-report-generated`），violations 0，RESULT PASS。
- **E2E 全量 (`npm run test:e2e`) — Exit 0**：
  - Production Electron E2E（`playwright.electron.production.config.ts`）：**20/20** 含新增真实 Electron + 真实 Runner 成本闭环（发布 → 审核 APPROVED → 生成 Q01 → 全局材料改价 → Q01 复读总额不变（不可变快照）→ 生成 Q02 总额更高 → 版本成本报告列表 Q01+Q02）；
  - Browser + Electron Smoke（`playwright.config.ts`）：**56/56**，含 `e2e/phase7.browser.spec.ts` 3/3（成本数据编辑保存、图纸成本报告列表 + 当前正式模型、参数确认 → Q01 报告详情跳转）。
- **截图基线（2026-08-18）**：Phase 7 解锁的 `cost-data`/`cost-params`/`cost-report` 三张 1920×1080 按新真实页面重新生成并干净复验（其余 16 张哈希未变）。

### 21.3 正式判定与已知限制

**Phase 7 Exit Gate = PASS**（2026-08-18 正式判定）。判定依据：`development-plan.md` §11 Exit Gate——**同一不可变快照恒产同一确定性结果**（纯函数计算器 + 冻结 snapshot 持久化 + 专项单测）+ **该确定性结果已被单元测试覆盖**（28 项 calculator 单测 + Runner/Domain/Contracts/Desktop/E2E 全链）。

已知限制（如实记录、不阻塞本 Gate）：
- **`finishedVolume` 来源**：现阶段 UI 仍以规范常量 `CANONICAL_FINISHED_VOLUME` 作为精加工体积输入，而非从持久化确定性模型几何读取——引擎冻结「给定」快照因此确定性不受影响；从模型几何换算精加工体积列为 **Phase 8 精度项**。
- 利润、税、运费、售价与商务报价词条按设计**不在范围内**；本报告为内部成本估算参考，绝非最终客户报价。
- 全局改价**不会**改写任何历史报告（不可变语义，已验证）；未知 `DISPLAY_ONLY` 自定义字段仅记录展示、不参与计算。



---

## 22. 2026-08-18 Phase 8 — Recovery / Hardening / Packaging 实施与正式 PASS 判定（当前权威状态）

### 22.1 实施范围与核心交付

依据 `development-plan.md` §12（12.1-12.6），Phase 8 把"能跑 Demo"提升到"可以长期在本地使用"：

1. **12.1 Interrupted Run Recovery**（中断恢复）：
   - capability-based 恢复契约保持（**Codex thread resume ≠ SolidWorks feature resume**；仅 `null`/PREPARING/ANALYZING/PLANNING 可证明续跑，MODELING/VALIDATING/PACKAGING 是硬性 no-checkpoint，底层 Runtime 无法恢复时转为明确 FAILED——绝不伪装"断点续跑"）；ownership-safe Cancel 与低 Stage 钉定恢复仅契约测试、从未 HIL 验证（P5-4，见第 17 节）。
   - Electron Main 新增 `system.getRecoveryStatus`（`MAIN_CHANNELS.recoveryStatus`）转发 Runner 的 `system.getRecoveryStatus` **read 命令**；Renderer `notification-context` 启动时查询该状态，启动恢复扫描若报告 failed/resumed Modeling Runs 即发出系统恢复 Toast 并写入通知 feed。
2. **12.2 Notifications**（非阻塞通知）：`@swpanel/ui` 新增 `Toast`/`ToastContainer`（右下角、自动消失默认 4000 ms）+ Renderer `features/notifications/` `NotificationDrawer`（右上角抽屉：未读数、标已读、清空、可选 action 深链、feed 持久化上限 `MAX_NOTIFICATIONS = 100`）；完成/Clarification/失败等使用非阻塞通知/Toast，**不用强制弹窗打断普通工作**。
3. **12.3 Deletion**（删除 + 级联保护，显式说明影响范围）：`packages/domain/src/deletion/`——`canDeleteRevision`（是当前 Revision 或仍有 RUNS/MODELS/COST_REPORTS 依赖则阻止，规范顺序 `REVISION_DELETION_BLOCKERS`，用户确认后仅经显式 `force` 强制删除）、`canDeleteRun`（仅终态 `COMPLETED`/`FAILED`/`CANCELLED`；活动 Run → `RUN_NOT_TERMINAL`，`CLARIFICATION_REQUIRED` → `RUN_HAS_PENDING_CLARIFICATION`）、`canDeleteCostReport`（无草稿态，可删）；Bridge 新增 `runs.delete` 与 `cost.deleteReport`；产品 UI 表面阻断依赖并在确认后执行终态删除。
4. **12.4 Security**（安全加固）：`apps/desktop/src/main/secrets/secret-store.ts` —— SafeStorage 加密（Windows DPAPI）per-user API-key 存储于 Electron user-data 目录；**明文密钥绝不跨 bridge**（IPC 只暴露 `getApiKeyStatus` has + masked 预览；`getApiKey` 仅 Main 内部）；`isEncryptionAvailable() === false` 时默认以明确标注的非安全 XOR 混淆持久化（开发/测试可用）或 `fallbackMode: "refuse"` 生产 fail-closed；Secret 不写入日志/Git。其余先期安全项保持（Run Workspace 路径隔离、路径穿越与任意文件删除拒绝、allowlist 删除、IPC 严格校验、Agent/subprocess 权限边界、外部输入文件基本安全处理）。
5. **12.5 Tests**（测试）：套件增至 root 10/291、desktop 38/660、runner 44/905、contracts 14/214、domain 16/110、ui 7/50（**129 files / 2,230 tests**），含专属套件：domain `deletion/`（10）、`@swpanel/ui` `Toast`（7）、desktop `NotificationDrawer`/`notification-context`/`secret-store`；覆盖 Domain / Persistence / Workflow / Cost calculator / Agent contract / Run recovery 全部既有项 + E2E。
6. **12.6 Packaging**（打包）：`npm run package:win` 从当前树原子链重新发布 canonical 包（lock → quarantine 旧 `out` → build → per-run Forge package → fresh ASAR closure/forbidden 审计 → 独立 packaged-app smoke → 原子 publish → report finalize）；`npm run package:audit` ok:true；Squirrel `make:win` 安装器链保持自 Phase 2（Phase 8 未重跑，无安装器变更）。

### 22.2 验证证据（2026-08-18）

- **全量门禁 (`npm run check`) — Exit 0**：typecheck（root + 5 workspaces 全绿）、仓库 lint **0 错误**、全部单测/组件测试与完整 build 通过：root 10 files/291、`@swpanel/desktop` 38 files/660、`@swpanel/runner` 44 files/905、`@swpanel/contracts` 14 files/214、`@swpanel/domain` 16 files/110、`@swpanel/ui` 7 files/50，共 **129 files / 2,230 tests 全部 PASS**。
- **Fixture 时间线审计 (`npm run check:fixtures`) — Exit 0**：13/13 canonical scenarios 全部 OK，violations 0，RESULT PASS。
- **E2E 全量 (`npm run test:e2e`) — Exit 0 顺序通过**：
  - Production Electron E2E（`playwright.electron.production.config.ts`）：**20/20**；
  - Browser + Electron Smoke（`playwright.config.ts`）：**59/59**（phase1 24 + phase2 10 + phase3 14 + phase4 2 + phase6 2 + phase7 3 + **phase8 3** + smoke 1），含 `e2e/phase8.browser.spec.ts` **3/3**（通知抽屉打开 + toast 关闭、API Key 掩码保存/清除、级联删除阻断 + 终态删除确认）。
- **打包验证 (`npm run package:win` / `npm run package:audit`) — 2026-08-18 重新发布 canonical 包**：`out/SWPanel-win32-x64/resources/app.asar` **SHA-256 `743bbf723343e7c4dfcb00793c5b54b8c2df61baf9f79ebeb0d5cbc23c1a7b7a`、size 4,763,426 B、totalEntries 382、closure 160、forbidden/missing/empty 0**；`.scratch/asar-audit-report.json` **ok:true**（final report generated 2026-08-18T14:01:57Z / published-fingerprint 2026-08-18T14:15:40Z (standalone `package:audit` re-run + re-finalize on the same published artifact)）+ 链内独立 packaged-app smoke PASS。
- **截图基线（2026-08-18，有意刷新）**：Phase 8 改动页面 `drawing-costs` / `cost-report` / `run-detail` / `settings` 四张 1920×1080 baseline 重新生成并干净复验（其余 15 张哈希未变）；E2E 复跑 browser+smoke 59/59。

### 22.3 打包验证发现与修复（Phase 8 里程碑内）

- **发现 1 —— `tsconfig.build.tsbuildinfo` 随包发布**：根 `tsconfig.build.tsbuildinfo`（`npm run build` 刷新的 build-cache 文件）未被 `forge.config.mjs` 忽略而进入 ASAR，fresh ASAR audit 以 `cache` 类别失败（`missingRuntime`/`emptyRuntime`/其它 forbidden 均为 0）。**修复**：`forge.config.mjs` `PACKAGE_IGNORE_PATTERNS` 增加 `/\.tsbuildinfo$/i`（任意 `*.tsbuildinfo` basename，与 audit `cache` 规则及 `forge-ignore-policy` 交叉校验对齐）；root 套件复验 10/291 全绿。打包链正确 fail-closed（未发布失败产物，canonical `out` 只在全步骤通过后 publish）。
- **发现 2 —— `@electron/get` 每轮校验拉取 `SHASUMS256.txt`**：packager 的 Electron zip 命中本地缓存后仍从 Electron 发布主机拉取 `SHASUMS256.txt` 校验哈希；本主机到该主机连接抖动/不可达导致 3 次 `package:win` 在 package 阶段 `ECONNRESET`/`ETIMEDOUT` 失败（链正确未发布）。**修复（可选、仅设置时生效）**：`forge.config.mjs` 新增 `SWPANEL_ELECTRON_ZIP_DIR` env——设置时 packager 走 `electronZipDir` 直接读取本地 `electron-v43.3.0-win32-x64.zip`（本机 `%LOCALAPPDATA%\electron\Cache\85f2b742…\`），零网络、完全离线确定性打包；未设置的主机保持默认下载行为。使用 `package:win` 成功发布 canonical 包。

### 22.4 正式判定与外部交付待办

**Phase 8 Exit Gate = PASS（2026-08-18 正式判定）**。判定依据：`development-plan.md` §12 Exit Gate——**完成一个可重复执行的本地验收流程，并能在全新测试环境按文档启动**——被满足：可重复验收流程（`npm run check` + `check:fixtures` + `test:e2e` + `package:win`/`package:audit`）文档化且可重跑，canonical 包可在全新测试环境按 `architecture.md`/本文档启动。

**外部交付待办（历史事实保留，不属于研发侧 Exit Gate 验收条件；未执行、未通过、未声称通过）**：
- **Authenticode 代码签名**：`signtool` absent、`Cert:\CurrentUser\My` code-signing cert 0；需授权签名证书/工具后接入 Forge/signing 并记录 EXE/installer 验证证据；无授权条件则保持外部待办、不生成临时自签名证书冒充交付签名。
- **clean-Windows 离线 install/start/restart/uninstall smoke**：需在获批干净 Windows 机器执行离线全链路并记录 OS、安装器哈希与结果（含卸载不误删业务数据目录）；本机非 clean-Windows、未获得机器状态变更授权，未执行。

**保持的真实性与状态**：Phase 7 已于同日早前判定 PASS（第 21 节）；Phase 6 已于 2026-08-18 判定 PASS（第 20 节）；Phase 5 仍为唯一 NOT PASS（外部 HIL 未闭环——需可驱动 SolidWorks + 获批图纸，见第 17/18/19 节）；`productionVerified` 恒 `false`；实现代码未 commit（Git revision 不可复现 canonical 产物——按主 Agent 规则，用户明确要求才 commit/push）。
