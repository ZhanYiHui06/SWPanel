---
title: Screen Priority
status: evolving
owner: JANGHI
last_updated: 2026-08-10
---

# SWPanel 页面优先级

本文档用于指导 Design Mode、原型设计和后续前端实现时的页面建设顺序。

目标不是一次性把所有页面铺满，而是先通过少量关键页面确认统一设计语言，再逐步扩展。

---

## 1. 设计阶段原则

1. 先建立统一 App Shell，再做业务页面。
2. 第一批只设计少量最高优先级页面，用于确认 Sidebar、Topbar、Typography、Spacing、Status、Card、Tabs、List、Form 等基础设计规则。
3. 第一批视觉语言未确认前，不批量生成全部页面。
4. 后续页面必须优先复用已有 Design Library / Component，而不是每页重新设计。
5. 页面优先级依据日常使用频率、产品核心价值和对整体设计语言的代表性确定。

---

## 2. P0 — 第一阶段必须完成

### P0-1 全局 App Shell

包含：

- 左侧主导航；
- 顶部标题 / 页面 Header；
- 通知入口；
- 主内容容器；
- 全局响应宽度与间距规则；
- Light Mode 基础设计系统。

这是所有页面的共同基础，必须最先确认。

### P0-2 工作台

目的：

- 建立 SWPanel 第一印象；
- 确认任务导向而非 KPI Dashboard 的首页结构；
- 确认 Run Progress、待处理卡片、最近图纸等核心组件。

视觉优先级：最高。

### P0-3 图纸库

目的：

- 确认 Drawing 列表和状态展示方式；
- 确认搜索、筛选、列表 / 表格组件；
- 建立进入 Drawing Workspace 的主入口。

视觉优先级：最高。

### P0-4 Drawing Workspace — 概览

目的：

- 确认整个产品最核心的“左侧 Revision + 右侧 Workspace”布局；
- 确认图纸 Preview、当前模型、状态摘要和版本导航；
- 作为后续所有 Drawing Workspace Tabs 的基础。

视觉优先级：最高。

### P0-5 Drawing Workspace — 建模记录

目的：

- 确认 Run Timeline / Card 组件；
- 表达同一 Revision 下多次 Modeling Run 的历史。

### P0-6 Drawing Workspace — 模型

目的：

- 确认 Model Card / Preview 组件；
- 明确区分 PENDING_REVIEW、APPROVED、REJECTED 和当前正式模型。

### P0-7 Model Detail

目的：

- 展示单个 Model 的核心工程信息；
- 确认 Validation、技术 Artifact、SolidWorks 打开入口；
- 在同一页面承担 Approved / Rejected 审核动作。

视觉优先级：最高。

### P0-8 建模任务

目的：

- 建立全局 Run 监控中心；
- 确认当前任务、等待队列、历史任务布局；
- 复用 Run Progress 与 Status 组件。

视觉优先级：最高。

### P0-9 Run Detail — Clarification

目的：

- 确认结构化 Clarification Form；
- 验证“不是 Chat UI”的交互方向；
- 建立 Question / Input / Unit 等组件。

### P0-10 Drawing Workspace — 版本记忆

目的：

- 展示 Revision Facts；
- 展示 Modeling Feedback；
- 验证长期工程上下文的可读性。

### P0-11 Drawing Workspace — 成本测算

目的：

- 确认历史成本测算报告列表；
- 建立“生成成本测算报告”的入口；
- 明确成本报告与最终客户报价的语义边界。

### P0-12 成本测算参数确认

目的：

- 确认系统推荐 + 用户确认的参数流程；
- 展示数量、材料、毛坯、余量等表单组件；
- 建议优先探索 Side Drawer 形式。

### P0-13 成本测算报告详情

目的：

- 确认成本报告的信息层级；
- 展示模型 / 毛坯 / 成本依据 / 成本明细 / 最终估算成本；
- 验证大数值结果、表格和说明区域的视觉表达。

视觉优先级：最高。

### P0-14 成本数据

目的：

- 确认企业级配置页；
- 建立材料数据、加工余量、固定成本 Tabs；
- 验证可扩展字段与单位配置的产品呈现。

### P0-15 设置

目的：

- 配置 SolidWorks；
- 配置文件存储；
- 配置 Agent / API；
- 收纳高级设置。

---

## 3. 第一批 Design Mode 页面

第一批只设计以下内容：

```text
1. App Shell
2. 工作台
3. 图纸库
4. Drawing Workspace — 概览
```

第一批完成后停止继续扩展，先确认：

- Sidebar 宽度与导航层级；
- Topbar / Page Header；
- 页面最大宽度；
- 字体层级；
- 主 / 次按钮；
- Border / Surface / Card 规则；
- Status Badge；
- Tabs；
- List / Table；
- Empty State；
- Progress；
- 统一 spacing。

只有这套设计语言确认后再进入第二批页面。

---

## 4. 第二批 Design Mode 页面

建议按以下顺序扩展：

```text
5. Drawing Workspace — 建模记录
6. Drawing Workspace — 模型
7. Model Detail
8. 建模任务
9. Run Detail — Clarification
10. Drawing Workspace — 版本记忆
11. Drawing Workspace — 成本测算
12. 成本测算参数确认
13. 成本测算报告详情
14. 成本数据
15. 设置
```

扩展原则：

> 优先复用第一批已经形成的 Design Library Components，不重新创造另一套页面风格。

---

## 5. 视觉优先级最高的页面

以下页面最能代表 SWPanel 的产品气质，设计评审时优先关注：

### 1. 工作台

原因：

- 决定产品第一印象；
- 决定 SWPanel 是 Agent 工作台还是普通后台。

### 2. Drawing Workspace — 概览

原因：

- 决定 Drawing-centric 信息架构是否成立；
- 后续多个业务页面依赖此结构。

### 3. Model Detail

原因：

- 连接 Agent 结果、SolidWorks、人工审核；
- 是产品最具工程专业感的页面之一。

### 4. 建模任务

原因：

- 最能体现 Agent Workflow 与自动化过程；
- 需要在“技术感”和“普通用户可理解”之间取得平衡。

### 5. 成本测算报告详情

原因：

- 决定产品是否具有真实业务价值感；
- 需要清晰表达复杂成本信息，而不变成传统 ERP 报表。

---

## 6. 页面组件优先抽取

第一批页面完成后，应优先形成以下共享组件：

```text
AppSidebar
PageHeader
Breadcrumb
Tabs
StatusBadge
Button
IconButton
SearchInput
FilterTabs
EmptyState
Toast
InlineNotice

DrawingRow
RevisionItem
RunCard
RunProgress
RunStageIndicator
ModelCard

PropertyList
ValidationList
FileList
DataTable

FormField
NumberInput
TextInput
Select
Textarea
UnitSelect

ConfirmDialog
SideDrawer
```

如果页面中出现重复结构，应优先抽成组件，而不是复制独立样式。

---

## 7. P1 — 核心 MVP 之后再处理

未来 Customer Quotation 模块进入产品范围后，再新增：

- 报价单列表；
- Customer Quotation 编辑页；
- 客户报价 PDF Preview；
- 客户 / 商务字段维护入口。

这些页面当前不应影响 MVP 的信息架构和 Design Library。

---

## 8. 明确不作为设计优先项

以下内容不需要为了“页面完整”而提前设计：

- KPI Dashboard；
- 全局 Model Library；
- 全局 Cost Report Library；
- 独立 Review Center；
- Agent Chat 页面；
- CRM / ERP 页面；
- 用户 / 团队 / 组织管理；
- 多租户切换；
- Worker / Executor 管理；
- Web CAD 编辑器；
- 营销 Landing Page。

---

## 9. 设计完成判断标准

一个页面不是“有 UI 就完成”，而应满足：

1. 用户任务明确；
2. 使用统一 App Shell；
3. 使用统一 Design Library；
4. 使用真实 SWPanel 业务内容；
5. 不引入未定义业务对象；
6. 状态文案与产品文档一致；
7. 页面之间导航关系正确；
8. 不通过装饰性 Dashboard 元素制造“完整感”；
9. 页面视觉属于同一个产品；
10. 能自然进入后续 Code Mode 实现。
