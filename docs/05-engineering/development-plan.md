---
title: Development Plan
status: evolving
owner: JANGHI
last_updated: 2026-08-10
---

# SWPanel 开发计划

本文档定义 SWPanel 从 TRAE Design 高保真原型进入正式开发后的工程路线图、阶段验收门与实施边界。

它不是逐条固定任务清单。主开发 Agent 可以根据实际代码状态、技术验证结果和依赖关系重新拆分任务、调整阶段内部顺序并调用 Subagent，但不得绕过本文档定义的业务约束和阶段验收条件。

---

## 1. 开发目标

SWPanel 第一阶段最终形成一个运行于企业本地 Windows 环境的内部工程工作台，完成以下核心闭环：

```text
Drawing / Drawing Revision
        ↓
用户主动发起 Modeling Run
        ↓
Agent + SolidWorks Skill 自动建模
        ↓
Model + Artifacts
        ↓
人工工程审核
        ↓
Current Approved Model
        ↓
内部成本测算报告
```

第一阶段不以“功能数量最多”为目标，而以以下能力真正可靠为目标：

1. 图纸和版本可长期管理；
2. Modeling Run 可追踪、可取消、可恢复；
3. Agent 与 SolidWorks 执行边界清晰；
4. 自动建模交付物可验证；
5. 人工审核是强制业务闸门；
6. 成本数字来自确定性计算；
7. UI 忠实于已确认的 TRAE Design；
8. 所有关键业务记录可追溯。

---

## 2. Source of Truth 优先级

开发过程中如果不同来源发生冲突，按以下优先级处理：

### 2.1 产品行为与业务规则

优先级从高到低：

```text
已确认 Decision / Product Scope
        ↓
Domain Model / Lifecycle
        ↓
Workflow 文档
        ↓
Information Architecture
        ↓
实现代码
```

Coding Agent 不得因为当前代码更容易实现而反向修改业务规则。

### 2.2 UI 与视觉实现

TRAE Design 已确认原型作为视觉 Source of Truth。

原则：

- 产品文档决定“页面为什么存在、展示什么、动作意味着什么”；
- TRAE Design 决定“页面如何布局、视觉层级、组件外观与交互呈现”；
- 若 Design Prototype 与产品文档在业务行为上冲突，以产品文档为准，并记录冲突；
- 不得借“工程化重构”重新设计已经确认的视觉语言。

---

## 3. 总体工程原则

### 3.1 Local Windows First

第一阶段以本地 Windows 为正式运行环境，因为 SolidWorks 是真实执行器。

不得为了追求通用云架构而弱化本地 SolidWorks 集成能力。

### 3.2 先建立边界，再接真实能力

系统至少应逻辑分离：

```text
UI / Presentation
Application / Use Cases
Domain
Persistence
Local File Storage
Run Orchestrator
Agent Runner / Adapter
Input Adapter
SolidWorks Adapter / Skill Runtime
Deterministic Cost Calculator
```

具体进程划分、语言、桌面壳和框架由 Architecture Spike 决定。

### 3.3 单机串行建模

MVP 不实现分布式 Worker 或多机器并行建模。

SolidWorks Modeling Run 采用单机串行队列；系统可以存在多个 `QUEUED` Run，但同一时刻最多一个进入真实 SolidWorks 自动建模执行。

### 3.4 Agent 不拥有业务事实决定权

Agent 可以：

- 理解图纸；
- 规划建模；
- 驱动 Skill；
- 自主修复技术执行错误；
- 推荐毛坯形式；
- 生成简洁说明。

Agent 不可以：

- 猜测缺失工程尺寸；
- 用像素比例制造尺寸；
- 擅自决定材料；
- 绕过人工 Model Review；
- 直接计算最终成本数字；
- 生成最终客户报价。

### 3.5 真实数据不得进入公开仓库

当前仓库为公开仓库。

禁止提交：

- 真实客户工程图；
- `.SLDPRT` 业务文件；
- 企业真实采购价格和成本；
- API Key；
- Agent Runtime Memory；
- Run Workspace；
- 其他商业敏感数据。

测试使用仓库中的 Fixtures 或专门脱敏数据。

---

# 4. Phase 0 — Architecture Spike 与工程初始化

## 目标

在大规模编码前确定可验证的工程结构，而不是直接把静态原型改成一个无法继续扩展的项目。

## 必须完成

1. 审查 TRAE Design 导出物：
   - 页面数量；
   - HTML / CSS 结构；
   - Assets；
   - 重复组件；
   - 页面间视觉规则。
2. 完整阅读产品、领域、Workflow、Design Context 和 Decision Log。
3. 选择并论证：
   - 前端技术方案；
   - Windows 桌面应用承载方式；
   - Application / local service 边界；
   - 本地结构化存储方案；
   - 文件系统 Artifact 管理方式；
   - Agent Runner 进程与生命周期方式；
   - SolidWorks 调用边界。
4. 设计基础模块目录。
5. 设计 Domain Type / Entity 映射。
6. 建立开发、测试、构建基本命令。
7. 建立必要的 `.gitignore`，防止 Runtime 数据和敏感文件进入 Git。

## 技术选择原则

不要仅因为某个框架“流行”而选择。

技术方案至少需要评估：

- Windows 本地能力；
- SolidWorks 集成可行性；
- 长任务与后台进程管理；
- Agent session / process 恢复；
- 本地文件访问；
- UI 对 TRAE Design 的还原能力；
- 打包与更新复杂度；
- 开发维护成本。

## 交付物

至少形成：

```text
docs/05-engineering/architecture.md
```

必要时增加 ADR。

## Exit Gate

只有当以下问题都有明确答案后才能进入 Phase 1：

- UI 如何运行？
- 业务代码在哪里？
- 本地数据如何持久化？
- 大文件和 Artifacts 放哪里？
- Agent Runner 如何与 UI 解耦？
- SolidWorks 自动化从哪里调用？
- Windows / App 中断后如何识别未结束 Run？

---

# 5. Phase 1 — Frontend Foundation

## 目标

把 TRAE Design 静态原型工程化为可维护的 SWPanel 前端，同时仍使用 Mock Data。

此阶段不接真实数据库、不启动 Agent、不调用 SolidWorks。

## 必须完成

### 5.1 App Shell

统一实现：

- Sidebar；
- Page Header；
- Breadcrumb；
- Content Layout；
- Notification / Toast。

### 5.2 路由

覆盖当前 P0 页面，并建立稳定路由关系。

至少包括：

- 工作台；
- 图纸库；
- Drawing Workspace；
- Modeling Run Detail；
- Model Detail；
- Cost Estimate Report；
- 成本数据；
- 设置。

### 5.3 Componentization

从 Design Prototype 中提取共享组件，避免复制静态 HTML。

至少考虑：

- AppSidebar
- PageHeader
- Breadcrumb
- Tabs
- StatusBadge
- DrawingRow
- RevisionItem
- RunCard
- RunProgress
- ModelCard
- ModelPreview
- ValidationList
- PropertyList
- FileList
- EmptyState
- InlineNotice
- Toast
- FormField
- ConfirmDialog
- SideDrawer

### 5.4 Frontend Domain Types

建立与业务文档一致的类型：

```text
Drawing
DrawingRevision
RevisionFacts
ModelingFeedback
ModelingRun
ClarificationRequest
Model
ModelReview
CostEstimateReport
CostData
```

### 5.5 Unified Mock Data

所有页面使用统一 Mock Repository / Fixtures。

禁止每个页面分别硬编码一套互相冲突的数据。

## Exit Gate

- 所有核心页面可通过真实路由进入；
- 页面视觉与 TRAE Design 保持高一致性；
- 相同组件只维护一份；
- 状态文案与领域状态一致；
- Mock 数据修改可以跨关联页面正确反映；
- 不存在真实后端依赖。

---

# 6. Phase 2 — Persistence 与 Drawing Workflow

## 目标

让 SWPanel 从“交互式 Mock Prototype”成为真正可以长期管理图纸的本地应用。

## 必须完成

### 6.1 Persistence

实现本地结构化业务数据存储。

数据库 / Persistence 至少支持：

- Drawing；
- Drawing Revision；
- Revision Facts；
- Modeling Feedback；
- Run metadata；
- Model metadata；
- Review；
- Cost Estimate Report metadata；
- Cost Data。

### 6.2 Local File Storage

原始图纸和后续 Artifact 使用本地文件系统保存，不把大文件塞入结构化数据库。

必须建立：

- 稳定文件 ID / 路径映射；
- 数据目录配置；
- 文件不存在时的错误处理；
- 删除关联策略；
- 开发 Fixtures 与真实 Runtime Data 隔离。

### 6.3 Drawing Workflow

完成：

```text
上传图纸
↓
创建 Drawing
↓
创建 Revision
↓
设置 current_revision
↓
查看 / 新增 Revision
↓
维护 Revision Facts
↓
查看历史
```

上传图纸不得自动触发 Modeling Run。

## Exit Gate

用户在没有 Agent 的情况下，也可以完整执行图纸管理流程；关闭并重启应用后数据仍存在。

---

# 7. Phase 3 — Modeling Run Orchestrator Skeleton

## 目标

先实现可靠任务系统，再接真实 Agent / SolidWorks。

## 必须完成

### 7.1 Run Creation

点击“开始自动建模”后：

```text
轻量确认
↓
创建 Run
↓
冻结 Input Snapshot
↓
QUEUED
```

Input Snapshot 至少包括：

- Drawing Revision；
- 原始输入稳定引用；
- Revision Facts；
- Modeling Feedback；
- Prompt Template Version；
- Skill Version；
- Agent / Model Config 标识。

### 7.2 Queue

实现单机串行队列。

### 7.3 Stage Event Model

实现 6 个用户可见 Stage：

```text
PREPARING
ANALYZING
PLANNING
MODELING
VALIDATING
PACKAGING
```

Stage 和 Status 必须分离。

### 7.4 Run Workspace

每个 Run 创建隔离 Workspace。

### 7.5 Mock Executor

先使用 Fake / Mock Executor 模拟：

- 正常完成；
- Clarification；
- Failed；
- Cancelled；
- App 中断后重新连接 / 恢复。

不要在任务系统尚未稳定前就用真实 SolidWorks 调试状态机。

### 7.6 Cancel Semantics

用户主动取消 Run 时：

- 停止执行；
- 删除该 Run 产生的生成文件；
- 不创建 Model；
- 保留最小 `CANCELLED` 历史记录。

## Exit Gate

通过 Mock Executor 可以可靠演示所有 Run 状态、6 Stage、队列、取消和恢复 UI。

---

# 8. Phase 4 — Input Adapter 与 Agent Contract

## 目标

建立 SWPanel 产品层和外部建模 Skill 之间的稳定协议。

当前 SolidWorks Skill 保持不修改。

## 8.1 Input Adapter

SWPanel 负责把产品支持的输入转成 Skill 可接受的形式。

目标业务格式：

- PDF；
- DWG；
- DXF。

当前 Skill 文档化输入主要为 JPG / PNG，因此适配逻辑放在 SWPanel 外围。

不得覆盖原始图纸。

## 8.2 Prompt Template

建立版本化、受控、普通用户不可见的 Prompt Template。

模板根据 Run Snapshot 自动填充：

- Drawing input；
- Revision Facts；
- Modeling Feedback；
- Workspace；
- Output Contract；
- Execution Rules。

## 8.3 Structured Event Contract

Agent 原始输出与产品事件分开：

```text
Raw Agent Log → 技术日志
Structured Event → UI
```

至少定义：

- StageChanged；
- Progress / Activity；
- ClarificationRequired；
- Completed；
- Failed；
- Runtime / Resume metadata。

## 8.4 Clarification Contract

Clarification 必须是结构化问题集合，而不是让前端解析自然语言。

用户提交回答后：

- 更新 Revision Facts；
- 原 Run 保持终态；
- 用户手动创建新 Run。

## 8.5 Result Manifest

成功执行必须产生机器可读 Manifest，描述最终模型和 Artifacts。

## Exit Gate

在不调用真实 SolidWorks 的测试 Executor 下，Prompt、事件、Clarification、Manifest 协议可以完整端到端工作。

---

# 9. Phase 5 — Agent Runner + SolidWorks Skill Integration

## 目标

接入真实 Agent Runtime 和既有 SolidWorks 自动建模 Skill，形成第一个真实 2D → 3D 闭环。

## 必须完成

### 9.1 Preflight

真实执行前检查：

- 输入可读取；
- Snapshot 完整；
- Workspace 可写；
- Agent Runtime 可用；
- Model API 可用；
- SolidWorks 可用；
- Skill 可用；
- 关键依赖满足。

### 9.2 Agent Runner

Agent Runner 负责：

- 创建 / 恢复 Agent Session；
- 注入 Prompt Template；
- 绑定 Run Workspace；
- 捕获原始日志；
- 转换结构化事件；
- 维护运行元数据；
- 管理退出与异常。

### 9.3 SolidWorks Skill

保持外部 Skill 原始职责和代码边界。

SWPanel 编排 Skill，不复制 Skill 的建模算法。

### 9.4 Required Artifacts

当前 Model 成功硬性要求至少包括：

1. `.SLDPRT`；
2. Preview；
3. Dimension Ledger；
4. Feature Plan；
5. Validation Log。

Builder Source 可以保留为技术 Artifact，但是否作为硬性成功条件由实际 Skill 集成测试确认后记录。

### 9.5 Artifact Check

Agent 声称完成不等于 Run `COMPLETED`。

只有：

```text
Agent Completed
↓
Manifest Valid
↓
Required Artifacts Exist
↓
Validation Acceptable
↓
Create Model(PENDING_REVIEW)
↓
Run COMPLETED
```

### 9.6 Technical Self-Recovery

普通技术错误应优先在同一个 `RUNNING` Run 内自主修复，不立即打断用户。

工程事实不明确才进入 Clarification。

## Exit Gate

至少使用经过允许的测试图纸完成真实：

```text
Drawing Revision
→ Run
→ Agent
→ SolidWorks
→ SLDPRT + Artifacts
→ Model(PENDING_REVIEW)
```

并能够处理一次 Clarification 场景和一次技术失败场景。

---

# 10. Phase 6 — Model Review 闭环

## 目标

把真实模型接入人工审核闸门。

## 必须完成

### Approved

```text
PENDING_REVIEW
→ APPROVED
→ Revision.current_approved_model_id = Model
```

新的 Approved Model 自动成为当前正式模型；旧 Approved Model 保留历史审核事实。

### Rejected

退回原因必填。

```text
PENDING_REVIEW
→ REJECTED
→ Review Comment
→ Modeling Feedback
```

Rejected Model 永不恢复为 Approved。

Review 不自动创建新 Run。

## Exit Gate

Approved / Rejected 两条路径及 current approved model 切换都经过真实持久化测试。

---

# 11. Phase 7 — Cost Data 与 Deterministic Cost Engine

## 目标

基于当前 Approved Model 生成企业内部成本测算报告。

## 必须完成

### 11.1 Cost Data

支持企业人工维护：

- 材料；
- 可计算字段；
- 单位；
- 全局加工余量；
- 全局固定成本；
- 可扩展自定义字段。

未知语义字段可以保存展示，但不得擅自参与公式。

### 11.2 Parameter Confirmation

生成报告前用户确认：

- quantity；
- 材料；
- 毛坯类型；
- 毛坯尺寸；
- 加工余量；
- 当前成本数据摘要。

Agent 可以推荐毛坯，但用户最终确认。

### 11.3 Deterministic Calculator

所有数字由确定性程序计算，包括：

- 单位换算；
- 原料体积；
- 质量 / 计价量；
- 材料成本；
- 数量；
- 固定成本；
- 总成本。

LLM 不负责最终数值运算。

### 11.4 Snapshot

报告保存完整输入与成本数据快照。

后续全局价格变化不得改写历史报告。

## Exit Gate

相同 Snapshot 必须得到可重复的相同成本结果，并具有单元测试覆盖。

---

# 12. Phase 8 — Recovery、Hardening、Packaging

## 目标

把“能跑 Demo”提升到“可以长期在本地使用”。

## 12.1 Interrupted Run Recovery

用户主动 Cancel 与意外中断严格区分。

意外中断目标：

```text
App / Runtime 意外退出
↓
重新启动
↓
发现未结束 RUNNING Run
↓
读取 Runtime Metadata / Workspace
↓
尝试恢复原 Agent Session 或安全 Checkpoint
↓
继续
```

如果底层 Runtime 无法恢复，才转为明确 `FAILED`，不能永久假装 `RUNNING`。

具体恢复粒度必须以最终 Agent Runtime 的真实能力为准，不得伪造“断点续跑”。

## 12.2 Notifications

完成、Clarification、失败等使用非阻塞通知 / Toast。

不使用强制弹窗打断普通工作。

## 12.3 Deletion

落实主要业务对象删除规则与父子依赖保护。

危险级联删除必须显式说明影响范围。

## 12.4 Security

至少完成：

- Secret 不写入日志和 Git；
- API Key 安全保存；
- Run Workspace 路径隔离；
- 防止路径穿越和任意文件删除；
- Agent / subprocess 权限边界；
- 外部输入文件基本安全处理。

## 12.5 Tests

建立：

- Domain tests；
- Persistence tests；
- Workflow tests；
- Cost calculator unit tests；
- Agent contract tests；
- Run recovery tests；
- 关键 UI / E2E flows。

## 12.6 Packaging

产出可在目标 Windows 环境安装 / 启动的 SWPanel 构建物，并验证 SolidWorks 集成路径。

## Exit Gate

完成一个可重复执行的本地验收流程，并能在全新测试环境按文档启动。

---

# 13. 暂不进入本开发计划的能力

除非产品文档后续明确变更，否则主 Agent 不得提前实现：

- Customer Quotation / 最终客户报价 PDF；
- 客户门户；
- CRM；
- ERP；
- 生产排程；
- CAM / CNC；
- 多租户；
- 云端 SaaS；
- 多机器并行建模；
- Web CAD；
- 材料市场行情自动同步；
- Agent Chat 作为核心 UI；
- 通用 KPI Dashboard。

---

# 14. 主 Agent 的项目管理方式

主 Agent 可以自主规划实施节奏，但应遵守以下方法。

## 14.1 每个阶段开始前

主 Agent应：

1. 阅读该阶段依赖文档；
2. 检查当前代码状态；
3. 列出本阶段任务图和依赖关系；
4. 明确哪些任务适合交给 Subagent；
5. 明确验收方式；
6. 再开始修改代码。

## 14.2 Subagent 使用原则

适合并行委派：

- 仓库 / 原型审计；
- 独立模块实现；
- 测试补充；
- Debug 根因分析；
- 代码 Review；
- 文档一致性检查；
- 安全审计。

不适合无协调并行：

- 多个 Agent 同时修改同一核心文件；
- 同时改变同一个 Domain Contract；
- 未确定接口前分别实现上下游；
- 让 Subagent 自行改变产品规则。

主 Agent 对最终集成和产品一致性负责。

## 14.3 每个阶段结束时

必须进行：

```text
Implementation
↓
Tests
↓
Review
↓
Docs Update
↓
Exit Gate Check
```

未满足 Exit Gate 不应宣布阶段完成。

---

# 15. 进度记录建议

正式开发开始后，建议主 Agent 创建并持续维护：

```text
docs/05-engineering/implementation-status.md
```

仅记录：

- 当前 Phase；
- 已完成项；
- 正在进行；
- 阻塞项；
- 已确认技术决策；
- 下一步；
- 最近验证结果。

不要把它写成庞大的开发日志。

详细代码历史由 Git 负责，产品事实由已有 docs 负责。

---

# 16. Definition of Done — MVP

SWPanel MVP 只有在以下整条链路真实可运行时才视为完成：

```text
上传测试 Drawing
↓
创建 / 切换 Revision
↓
维护 Revision Facts
↓
创建 Modeling Run
↓
冻结 Snapshot
↓
Queue + Preflight
↓
Agent + SolidWorks Skill
↓
结构化 Stage Progress
↓
成功生成并验证 Required Artifacts
↓
Model PENDING_REVIEW
↓
人工 Approved / Rejected
↓
Approved Model 成为 current approved model
↓
维护 Cost Data
↓
确认毛坯 / 数量 / 参数
↓
确定性成本计算
↓
生成并保存内部成本测算报告 Snapshot
↓
关闭并重启应用
↓
历史 Drawing / Run / Model / Review / Cost Report 仍正确存在
```

任何单一高保真页面、Mock Demo、Agent 文本输出或单次 SolidWorks 成功都不等于 MVP 完成。
