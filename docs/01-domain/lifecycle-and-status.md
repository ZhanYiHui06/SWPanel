---
title: Lifecycle and Status
status: evolving
owner: JANGHI
last_updated: 2026-08-09
---

# 生命周期与状态机

本文档定义 SWPanel 第一阶段各核心业务对象的生命周期、状态、执行阶段与状态流转规则。

设计原则：

1. **业务状态（Status）与执行阶段（Stage）分离。**
2. 状态尽量少，只表达是否能继续流转、是否需要人工介入、是否已经终止。
3. Agent 内部细粒度日志不直接等价为产品状态。
4. 历史记录不得因重新执行而自动覆盖，但用户可以显式删除业务对象；删除规则在后续 Product / Engineering Spec 中继续定义。

---

## 1. Drawing 与 Drawing Revision

### Drawing

MVP 不设计复杂状态机。

Drawing 是长期存在的根业务对象，不设置“归档”状态。

用户可以显式删除 Drawing。

删除 Drawing 时，应在 UI 中明确提示其关联的 Revision、Modeling Run、Model、Review、Quote Report 等历史数据也会受到影响；具体采用硬删除、软删除或回收站机制留待工程设计阶段确定。

### Drawing Revision

Drawing Revision 同样不设置 `ACTIVE / ARCHIVED` 状态。

由 Drawing 保存一个当前版本指针：

```text
current_revision_id
```

旧 Revision 永久保留，除非用户主动删除。

当用户创建新的 Drawing Revision 后：

- 新 Revision 成为 `current_revision`。
- 旧 Revision 仍保留全部历史。
- 旧 Revision 下已经 Approved 的 Model 仍保留其“曾经审核通过”的历史事实。
- 新业务应以 current Revision 为准。
- current Revision 尚未产生 Approved Model 时，不应使用旧 Revision 的模型继续生成新的报价报告。

用户可以显式删除某个 Drawing Revision。

---

## 2. Modeling Run

### 2.1 Run Status

Modeling Run 的业务状态采用以下状态：

```text
QUEUED
  ↓
RUNNING
  ├──→ COMPLETED
  ├──→ CLARIFICATION_REQUIRED
  ├──→ FAILED
  └──→ CANCELLED
```

### QUEUED

任务已经创建，但尚未开始执行。

SWPanel 当前采用单机串行 SolidWorks 执行模式，因此同一时间最多只有一个 Run 处于 RUNNING，其余任务可以处于 QUEUED。

### RUNNING

Agent 正在执行完整建模工作流。

Run 一旦进入 RUNNING：

- 永远绑定创建时确定的 Drawing Revision。
- 使用该 Revision 当前最新的版本级 Memory 作为上下文快照。
- 不允许在运行中替换图纸版本。
- 不允许在用户补充工程信息后恢复原 Run。

### COMPLETED

该 Run 正常完成，并成功产生一个 Generated Model。

`COMPLETED` 只表示自动建模执行成功，不表示模型已经通过人工审核，也不表示可以报价。

### CLARIFICATION_REQUIRED

该 Run 已完成尽可能多的图纸分析，但仍存在一个或多个无法由权威信息确定的阻塞问题。

此状态是 **Run 的终态**。

用户回答问题后：

1. 更新对应 Drawing Revision 的版本级工程事实记忆；
2. 原 Run 保持 `CLARIFICATION_REQUIRED`；
3. 用户手动创建新的 Modeling Run；
4. 新 Run 从头执行。

禁止：

```text
CLARIFICATION_REQUIRED → RUNNING
```

### FAILED

Agent / SolidWorks / 运行环境在内部自我修复后仍无法完成任务。

`FAILED` 用于执行失败，不用于表达工程信息缺失。

典型情况包括：

- SolidWorks 无法启动或不可用；
- 自动纠错后仍无法完成 rebuild；
- Skill / Agent 执行异常且无法恢复；
- 本地运行环境出现不可恢复错误。

### CANCELLED

用户主动取消一个处于 QUEUED 或 RUNNING 的 Run。

取消后的 Run 保留历史，除非用户随后主动删除。

若用户希望再次建模，应创建新的 Run。

---

## 3. Run Stage

Status 只表达生命周期；用户可见进度使用独立 `stage`。

MVP 用户界面只展示 6 个阶段：

```text
PREPARING
ANALYZING
PLANNING
MODELING
VALIDATING
PACKAGING
```

推荐用户文案：

| Stage | 用户可见文案 |
|---|---|
| PREPARING | 准备任务 |
| ANALYZING | 分析图纸 |
| PLANNING | 规划模型 |
| MODELING | SolidWorks 建模 |
| VALIDATING | 检查模型 |
| PACKAGING | 生成结果 |

Agent 内部可以保留更细的日志，如尺寸台账、Feature Plan、Rebuild、Artifact 生成等，但不直接扩充业务状态机。

当 Agent 在建模过程中自行修复错误时，Run 仍保持 `RUNNING`，只更新阶段内的短提示，例如：

```text
正在调整建模方案
正在重新检查模型
```

---

## 4. Clarification Request

### 4.1 批量澄清原则

根据当前 SolidWorks Skill 的实际工作方式，Run 应尽可能完成全部可继续进行的分析，再一次性汇总本轮所有阻塞问题。

不采用“遇到一个问题立即停一次”的交互。

结构建议：

```text
Clarification Request
├── Question 1
├── Question 2
├── Question 3
└── ...
```

### 4.2 状态

Clarification Request 只需要：

```text
OPEN
  ↓
ANSWERED
```

### OPEN

等待用户统一补充本轮全部问题。

### ANSWERED

用户已经提交补充信息。

提交后系统应：

1. 把有效回答写入当前 Drawing Revision 的工程事实记忆；
2. 保留本次 Clarification Request 与原 Run 的关联；
3. 不自动恢复原 Run；
4. 由用户手动启动下一次建模任务。

### 4.3 推荐交互方式

用户不应该为了回答本轮问题，先离开任务详情页再进入“图纸管理”手工编辑 Memory。

推荐在 `CLARIFICATION_REQUIRED` 的 Run 详情中直接提供一个专门的补充信息表单：

```text
需要补充 3 项信息

1. 中心孔深度无法确定
   [ 85 ] [mm]

2. R5 圆角适用于哪一侧？
   [ 自由文本 / 选项 ]

3. 图纸中材料标注无法确认
   [ 42CrMo ]

[提交补充信息]
```

提交动作同时完成两件事：

- 回答当前 Clarification Request；
- 更新该 Revision 的工程事实 Memory。

此外，Drawing Revision 页面应提供一个独立的“版本记忆 / 补充信息”区域，供用户后续查看、维护已经确认的信息。

因此：

> Clarification 表单是交互入口，Revision Memory 是长期事实源；二者不是两套数据。

---

## 5. Memory 的职责拆分

为了避免把“工程事实”和“Agent 犯错经验”混在同一个文件中，MVP 推荐把每个 Drawing Revision 的长期 Memory 分成两个逻辑部分。

### 5.1 Revision Facts

保存对该版本图纸具有权威意义的补充工程事实，例如：

- 用户补充的缺失尺寸；
- 对歧义结构的明确解释；
- 用户确认的材料、工艺、参数；
- 其他可以作为下一次 Run 数值或结构依据的信息。

Revision Facts 是建模时的高优先级事实源。

### 5.2 Modeling Feedback

保存人工审核对 Agent 建模错误的反馈，例如：

- Agent 将某尺寸识别错误；
- 某特征建模策略不合理；
- 某结构虽然几何结果接近，但建模历史不符合工程习惯；
- 其他用于避免下一次 Run 重复犯错的经验。

审核 Rejected 时，审核意见自动进入该 Revision 的 Modeling Feedback。

Modeling Feedback 是“建模经验”，不自动覆盖图纸和 Revision Facts 中的权威工程事实。

若真实产品信息发生变化，应创建新的 Drawing Revision，而不是通过 Review Feedback 修改旧版本的工程事实。

未来若需要跨图纸学习，可再建立 Company-level Modeling Knowledge；当前 MVP 不自动把单张图纸的反馈推广为全局规则。

---

## 6. Model

### 6.1 Review Status

Model 只需要三个审核状态：

```text
PENDING_REVIEW
      ↓
  ┌───────────┐
APPROVED   REJECTED
```

### PENDING_REVIEW

Modeling Run 已成功产生 Model，但人工工程审核尚未完成。

### APPROVED

用户确认该 Model 正确，可以成为该 Drawing Revision 的正式模型。

### REJECTED

用户确认该 Model 不可接受。

一旦 Rejected：

- 此 Model 的业务路线永久停止；
- 不允许修改同一个 Model 后重新变为 Approved；
- 若需要重新建模，由用户手动创建新的 Modeling Run；
- 审核意见进入该 Revision 的 Modeling Feedback。

---

## 7. 当前正式模型

“审核结果”和“当前正式模型身份”分开表达。

Model 保留自己的历史审核事实：

```text
review_status = APPROVED
```

Drawing Revision 保存：

```text
current_approved_model_id
```

UI 可以把被该指针指向的 Model 标记为：

```text
当前正式模型
```

### 自动替换规则

同一个 Drawing Revision 下，新的 Model 被 Approved 时：

1. 新 Model 自动成为 `current_approved_model`；
2. 旧 Model 仍保持 `APPROVED` 历史事实；
3. 旧 Model 失去“当前正式模型”身份；
4. 不额外弹出“是否设为正式模型”的确认。

### 跨 Drawing Revision

Drawing 另外保存：

```text
current_revision_id
```

只有 current Revision 的 current Approved Model 才能进入新的报价流程。

新 Revision 创建后，如果尚无 Approved Model，则应等待新版本模型审核通过，而不是继续以旧 Revision 的 Approved Model 生成新的报价报告。

---

## 8. Model Review

Model Review 是一次已经发生的审核记录，不需要单独的 PENDING 状态机。

每次 Review 创建时直接记录结果：

```text
APPROVED
```

或：

```text
REJECTED
```

Rejected Review 应记录审核意见。

MVP 推荐流程：

```text
Model PENDING_REVIEW
        ↓
用户审核
        ↓
Rejected + 审核意见
        ↓
Model REJECTED
        ↓
用户自行决定何时重新点击“开始自动建模”
        ↓
创建新的 Modeling Run
```

审核失败本身 **不自动启动** 新 Run。

---

## 9. 自动报价报告

报价部分采用轻量设计，不再为 MVP 引入复杂 `DRAFT → FINALIZED` 状态机。

### 9.1 定位

自动报价报告是给江海冶金内部用户参考的成本与报价分析材料，不是直接发送给客户的正式商业报价文件。

因此：

- 不需要“报价审批”状态机；
- 不需要复杂的 Finalized 锁定流程；
- 用户认为结果不合适时，可以删除并重新生成；
- 每次生成仍应保存当时使用的价格与成本数据快照，以便报告内容自洽。

### 9.2 轻量版本管理

若同一 Approved Model 多次生成报价报告，可使用简单序号 / 时间戳区分，例如：

```text
Q01
Q02
Q03
```

无需额外引入 Quote Revision 的复杂状态。

报告可以被用户主动删除。

### 9.3 生成前置条件

只有：

```text
current Drawing Revision
+
current Approved Model
```

才允许创建新的自动报价报告。

---

## 10. 对客报价 PDF（待定扩展）

自动报价报告与最终面向客户的商业报价应视为两个不同产品概念。

推荐未来单独增加：

```text
Customer Quotation
```

它可以从某一份内部自动报价报告预填数据，但允许用户根据实际沟通结果手动调整：

- 最终报价；
- 税费；
- 运费；
- 付款方式；
- 报价有效期；
- 交期；
- 商务备注；
- 客户信息；
- 其他商业条款。

最终输出面向客户的 PDF。

该能力不应反向修改内部自动报价报告。

当前是否纳入 MVP 尚未最终确认，建议作为独立功能模块评估。

---

## 11. 删除能力

用户要求 Drawing、Drawing Revision、Run、Model、报价报告及其他主要历史对象提供删除能力。

产品层先确认以下原则：

- 删除必须由用户显式触发；
- 系统不得因新版本、新 Run、新 Model 自动删除旧记录；
- 删除父对象时必须明确提示关联数据影响；
- 删除不作为生命周期状态，不引入 `ARCHIVED`；
- 删除后的恢复策略（硬删除 / 软删除 / 回收站）留待 Engineering Spec 确定。

---

## 12. 当前状态机总览

### Modeling Run

```text
QUEUED
  ↓
RUNNING
  ├──→ COMPLETED
  ├──→ CLARIFICATION_REQUIRED
  ├──→ FAILED
  └──→ CANCELLED
```

### Run Stage

```text
PREPARING
→ ANALYZING
→ PLANNING
→ MODELING
→ VALIDATING
→ PACKAGING
```

### Clarification Request

```text
OPEN
→ ANSWERED
```

### Model

```text
PENDING_REVIEW
→ APPROVED

PENDING_REVIEW
→ REJECTED
```

### Quote Report

不设置复杂状态机；生成后即作为内部参考报告存在，可显式删除并重新生成。

---

## 13. 待后续确认

1. 删除采用硬删除、软删除还是回收站机制。
2. `Customer Quotation` 对客报价 PDF 是否进入首版 MVP，还是放入 MVP 后的下一阶段。
3. 报价报告简单序号的命名规则。
4. Clarification 表单是否需要支持图纸局部截图 / 标注式回答；MVP 默认先以结构化文本输入为主。
