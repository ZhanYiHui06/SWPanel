---
title: Information Architecture
status: evolving
owner: JANGHI
last_updated: 2026-08-10
---

# SWPanel 信息架构

本文档面向产品设计、原型设计与 Coding Agent，定义 SWPanel 第一阶段的顶级导航、页面层级、页面职责和禁止扩张的边界。

设计目标：

> 让用户打开 SWPanel 后，能够快速知道系统正在执行什么、哪里需要人工处理，以及应该从哪一张图纸继续工作。

SWPanel 不是传统 ERP、CRM 或 KPI Dashboard。信息架构应围绕 `Drawing` 展开，`Modeling Run` 表达执行过程，`Model` 与成本测算报告作为 Drawing Revision 的业务产物存在。

---

## 1. 顶级导航

MVP 顶级导航固定为：

```text
SWPanel
├── 工作台
├── 图纸库
├── 建模任务
├── 成本数据
└── 设置
```

未来独立扩展：

```text
报价单
└── Customer Quotation
```

第一阶段不提前加入“报价单”顶级入口，直到 Customer Quotation 模块正式进入产品范围。

---

## 2. 核心信息架构

```text
SWPanel
│
├── 工作台
│
├── 图纸库
│   └── Drawing Workspace
│       ├── Drawing 基本信息
│       └── Drawing Revision
│           ├── 概览
│           ├── 建模记录
│           ├── 模型
│           ├── 成本测算
│           └── 版本记忆
│
├── 建模任务
│   ├── 当前任务
│   ├── 等待队列
│   └── Run Detail
│
├── 成本数据
│   ├── 材料数据
│   ├── 加工余量
│   └── 固定成本
│
└── 设置
    ├── SolidWorks
    ├── 文件存储
    ├── Agent / API
    └── 高级设置
```

---

## 3. 工作台

### 页面目标

工作台不是统计大屏，而是任务导向型首页。

用户进入系统后应首先看到：

1. 当前 Agent / SolidWorks 正在执行什么；
2. 是否存在等待用户处理的事项；
3. 最近处理过哪些图纸。

### 核心区域

#### 当前任务

优先展示当前 RUNNING Modeling Run：

- Drawing / Revision；
- Run 编号；
- 当前 6 级 Stage；
- 当前简短活动描述；
- 进度；
- 查看任务入口。

若没有正在执行的任务，则展示简洁空状态，并提供“上传图纸”和“打开图纸库”入口。

#### 等待队列

展示当前 QUEUED Run 数量及前几项任务。

#### 需要处理

集中展示需要人工动作的事项，例如：

- Model 等待审核；
- Run 需要补充 Clarification；
- 其他后续明确的阻塞事项。

#### 最近图纸

展示最近访问或更新的 Drawing，帮助用户快速回到业务上下文。

### 明确不做

首页不以以下内容为主：

- 总图纸数量；
- 本月建模数量；
- KPI 图表；
- 成功率大盘；
- 彩色统计卡片矩阵；
- 销售漏斗；
- 企业经营 Dashboard。

---

## 4. 图纸库

### 页面目标

图纸库是 SWPanel 的核心业务入口，用于查找和进入长期 Drawing 对象。

### 列表核心字段

建议仅保留：

- 图号；
- 名称；
- 当前 Revision；
- 当前模型 / 当前工作状态；
- 最近更新时间；
- 查看 / 更多操作。

### 搜索与筛选

支持：

- 搜索图号 / 名称；
- 全部；
- 待处理；
- 有正式模型；
- 尚未建模。

不应演变为复杂的企业文档管理系统。

---

## 5. Drawing Workspace

Drawing Workspace 是 SWPanel 最核心的页面集合，承担主要日常操作。

### 固定布局

采用：

> 左侧 Drawing Revision 列表 + 右侧当前 Revision Workspace

概念布局：

```text
Drawing Header
图号 / 名称 / 新增版本 / 开始自动建模 / 更多

┌───────────────┬────────────────────────────────────┐
│ Revision List │ Current Revision Workspace         │
│               │                                    │
│ V3 当前       │ 概览 / 建模记录 / 模型             │
│ V2            │ 成本测算 / 版本记忆                 │
│ V1            │                                    │
│               │                                    │
│ + 新增版本    │                                    │
└───────────────┴────────────────────────────────────┘
```

### Revision 入口

同一 Drawing 的不同 Revision 始终在 Drawing Workspace 内切换，不作为顶级页面散落到系统其他区域。

---

## 6. Drawing Workspace — 概览

### 页面目标

回答：

> 当前 Revision 走到哪里了？

### 核心内容

- 原始图纸 Preview；
- 当前正式模型 Preview；
- 若没有正式模型，则展示最近候选模型状态；
- 最近 Modeling Run；
- Model Review 状态；
- 成本测算可用性 / 历史报告数量；
- “在 SolidWorks 中打开”等关键入口。

概览页不承载完整历史列表。

---

## 7. Drawing Workspace — 建模记录

### 页面目标

查看该 Revision 的 Modeling Run 历史。

推荐使用 Timeline / Card List，而不是高密度管理表格。

每个 Run 至少展示：

- Run 编号；
- 时间；
- 状态；
- 简短结果；
- 关联 Model / Clarification；
- 查看详情入口。

---

## 8. Drawing Workspace — 模型

### 页面目标

查看该 Revision 所有历史 Model，并明确区分：

- `PENDING_REVIEW`；
- `APPROVED`；
- `REJECTED`；
- 当前正式模型；
- 历史 Approved Model。

必须体现：

> `APPROVED` 是历史审核事实，`current approved model` 是当前业务身份。

模型主要通过 Preview Card / List 展示，不建立独立全局 Model Library。

---

## 9. Model Detail

### 页面目标

查看单个模型的工程产物并完成轻量人工审核。

### 核心区域

- Model Preview；
- 模型基础信息；
- Validation 结果；
- 建模报告；
- 技术 Artifact；
- 在 SolidWorks 中打开；
- `PENDING_REVIEW` 时的 Approved / Rejected 操作。

Review 不建立独立复杂审核页面。

Rejected 时在当前页面填写退回原因。

---

## 10. Drawing Workspace — 成本测算

### 页面目标

管理当前 Revision / 当前正式模型产生的内部成本测算报告。

### 核心内容

- 当前正式模型；
- “生成成本测算报告”入口；
- 历史报告列表；
- 数量；
- 单件估算成本；
- 总估算成本；
- 查看 / 删除入口。

成本报告属于 Drawing Revision，不建立独立全局“成本报告库”。

---

## 11. 成本测算参数确认

### 页面形式

推荐：

- 大尺寸 Side Drawer；或
- 独立参数确认页。

### 页面目标

在确定性成本计算前确认关键业务参数。

至少展示：

- Drawing / Revision / Model；
- Model Preview；
- 成品体积；
- 数量；
- 材料；
- 毛坯类型；
- 毛坯规格；
- 加工余量；
- 当前成本数据摘要。

系统推荐值必须允许用户检查与修改。

---

## 12. 成本测算报告详情

### 页面目标

以技术 / 成本视角展示内部测算结果，而不是客户报价。

建议结构：

```text
01 零件与模型信息
02 毛坯与原料参数
03 成本计算依据
04 成本明细
05 成本测算结果
```

最终数字使用：

- 单件估算成本；
- 批次估算成本；
- 总估算成本。

禁止使用：

- 最终报价；
- 客户报价；
- 建议售价；
- 销售价。

---

## 13. Drawing Workspace — 版本记忆

### 页面目标

以用户可理解的方式管理该 Revision 的长期 Memory。

页面名称统一使用：

> 版本记忆

分为两部分：

### 工程事实

对应 `Revision Facts`：

- 字段 / 内容；
- 值；
- 来源；
- 必要时编辑 / 新增。

### 建模反馈

对应 `Modeling Feedback`：

- 来源 Model；
- 时间；
- Review Feedback；
- 反馈内容。

UI 不使用“Prompt Memory”“LLM Memory”等技术术语。

---

## 14. Run Detail

### 页面目标

查看单次 Modeling Run 的执行状态、阶段和结果。

### 普通 RUNNING / COMPLETED / FAILED / CANCELLED

展示：

- Drawing / Revision；
- Run 编号；
- Status；
- 6 级 Stage；
- 当前简短活动；
- 时间；
- 结果 / Failure Reason；
- 必要操作。

### CLARIFICATION_REQUIRED

直接在 Run Detail 内提供结构化补充信息表单，不建立 Agent Chat 页面。

提交后：

- 回答写入 Revision Facts；
- 原 Run 仍结束；
- 用户可重新发起新的 Modeling Run。

---

## 15. 建模任务

### 页面目标

这是全局 Agent / SolidWorks 运行监控中心，与 Drawing Workspace 中的单图纸历史视角互补。

页面结构：

1. 当前执行任务；
2. 等待队列；
3. 历史任务。

历史筛选可以包括：

- 全部；
- 已完成；
- 需补充；
- 失败；
- 已取消。

不要向普通用户暴露 Worker Pool、Executor、Agent Node 等运行时基础设施概念。

---

## 16. 成本数据

### 页面目标

维护企业级成本数据，不属于任何单张 Drawing。

顶部 Tabs：

```text
材料数据
加工余量
固定成本
```

### 材料数据

支持：

- 材料名称；
- 采购价格；
- 单位；
- 密度；
- 其他可扩展字段；
- 新增 / 编辑。

### 加工余量

维护不同毛坯类型对应的全局默认余量。

### 固定成本

维护默认参与每次成本测算的全局固定成本项。

整体设计应像现代产品配置页，而不是传统 ERP 主数据维护界面。

---

## 17. 设置

### 普通设置

- SolidWorks 路径 / 版本 / 连接状态；
- 文件存储路径；
- Agent / API Base URL；
- API Key；
- Model；
- 连接检测。

### 高级设置

默认收起：

- Prompt Template；
- Agent Runtime；
- Skill；
- 日志；
- 调试工具。

普通用户不应被高级 Agent 配置持续干扰。

---

## 18. 全局通知

支持：

- 顶部通知入口；
- 页面右下角非阻塞 Toast。

典型通知：

- 自动建模完成，等待审核；
- Run 需要补充信息；
- Run 执行失败。

禁止使用阻塞式 Modal 强制用户处理普通完成通知。

---

## 19. 明确不建立的页面 / 模块

MVP 不建立：

- 全局 Model Library；
- 全局 Cost Report Library；
- 独立 Review Center；
- Agent Chat 主页；
- KPI Dashboard；
- CRM；
- ERP；
- 客户门户；
- 项目管理中心；
- 团队 / 多租户管理；
- 销售 Pipeline；
- 多机器 Worker 管理页面；
- Web CAD 编辑器。

---

## 20. 设计核心原则

1. Drawing 是业务中心。
2. Drawing Revision 是用户实际工作的版本单位。
3. Run 是执行过程，不是长期业务根对象。
4. Model 与成本测算报告属于 Revision 的产物。
5. 首页解决“现在发生什么”，图纸库解决“我要处理哪张图”。
6. 建模任务解决“系统正在执行什么”。
7. 不因常见 SaaS 模板习惯增加未定义模块。
8. 优先减少页面跳转，让用户尽量在 Drawing Workspace 内完成连续工作。
