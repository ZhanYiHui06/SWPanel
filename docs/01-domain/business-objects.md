---
title: Core Business Objects
status: evolving
owner: JANGHI
last_updated: 2026-08-09
---

# 核心业务对象定义

本文档定义 SWPanel 第一阶段的核心业务对象、对象之间的归属关系以及必须保持的业务约束。

本阶段只定义产品领域模型，不提前绑定数据库表结构或具体前端实现。

## 1. 总体领域关系

```text
Drawing
├── current_revision_id
│
├── Drawing Revision V1
│   ├── Revision Memory
│   │   ├── Revision Facts
│   │   └── Modeling Feedback
│   │
│   ├── Modeling Run R01
│   │   └── Clarification Request
│   │       ├── Question 1
│   │       └── Question 2
│   │
│   ├── Modeling Run R02
│   │   └── Model M01
│   │       └── Model Review
│   │
│   ├── Modeling Run R03
│   │   └── Model M02
│   │       └── Model Review
│   │
│   ├── current_approved_model_id
│   └── Quote Report Q01 / Q02 / ...
│
└── Drawing Revision V2
    ├── 独立 Revision Memory
    ├── 独立 Modeling Run / Model / Review 历史
    └── 独立报价报告历史
```

核心原则：

- `Drawing` 是长期存在的根业务对象。
- `Drawing Revision` 是实际参与建模的确定版本。
- `Drawing` 使用 `current_revision_id` 指向当前业务版本，而不是给 Revision 设计 ACTIVE / ARCHIVED 状态。
- 每个 Drawing Revision 拥有自己独立、长期维护的 `Revision Memory`。
- `Modeling Run` 永远绑定一个确定的 Drawing Revision，运行过程中不得切换版本。
- 一次 Run 可以失败、被取消、要求补充信息，也可以成功产生一个候选 Model。
- 一个 Drawing Revision 可以拥有多个历史上通过审核的 Model，但同时只能有一个当前正式模型。
- 当前正式模型由 `current_approved_model_id` 表达。
- 只有当前 Drawing Revision 的当前正式模型可以生成新的内部报价报告。
- 自动报价报告属于内部参考材料，采用轻量编号和重生成方式，不引入复杂 Quote Revision 状态机。

---

## 2. Drawing

`Drawing` 表示业务意义上的一份工程图纸实体，通常由图号或企业内部唯一标识识别。Drawing 不等同于某一次上传的文件；同一图号后续发生内容变化时，在原 Drawing 下增加新的 Drawing Revision。

主要职责：

- 作为所有图纸版本的根节点；
- 汇总该图纸全部建模、模型、审核和报价历史；
- 记录当前使用的图纸版本 `current_revision_id`；
- 提供长期检索和管理入口。

关键规则：

- 一个 Drawing 可以拥有多个 Revision；
- 新 Revision 创建后自动成为 `current_revision`；
- 旧 Revision 保留完整历史，除非用户主动删除；
- Drawing 不设置归档状态机；
- 用户可以显式删除 Drawing，底层恢复策略留待 Engineering Spec 定义。

---

## 3. Drawing Revision

`Drawing Revision` 表示某一 Drawing 在一个确定时间点的具体工程图版本。

```text
Drawing: PDJF480.01.17C-4
├── V1
├── V2
└── V3
```

主要职责：

- 保存该版本对应的原始工程图文件；
- 作为 Modeling Run 的固定输入版本；
- 拥有该版本独立的 Revision Memory；
- 保存该版本下的 Modeling Run、Model、Review 和报价报告历史；
- 记录该版本的 `current_approved_model_id`。

关键规则：

- 每个 Modeling Run 必须且只能绑定一个 Drawing Revision；
- Run 启动后不得中途更换 Revision；
- 新 Revision 默认创建新的独立 Memory，不自动继承旧 Revision 的 Memory；
- 当一个新 Revision 成为 current Revision 后，旧 Revision 的模型与报价仍作为历史保存，但不得继续用于生成新的当前报价报告；
- 用户可以显式删除某个 Revision。

---

## 4. Revision Memory

`Revision Memory` 是绑定到单个 Drawing Revision 的长期上下文。不同 Drawing Revision 的 Memory 必须相互隔离。

为了避免工程事实和 Agent 错误经验混淆，Memory 在逻辑上拆分为两部分。

### 4.1 Revision Facts

保存可以作为后续建模权威输入的版本级事实，例如：

- 用户补充的缺失尺寸；
- 用户对歧义结构的明确解释；
- 已确认的材料、工艺或参数；
- Clarification 中用户明确回答的信息；
- 其他经过用户确认、可安全作为建模依据的事实。

Revision Facts 的权威等级高于 Modeling Feedback。

### 4.2 Modeling Feedback

保存人工审核针对 Agent 建模错误给出的反馈，例如：

- 尺寸识别错误；
- 遗漏特征；
- 不合理的建模策略；
- 不符合工程习惯的 Feature Tree；
- 其他用于避免后续 Run 重复犯错的经验。

当 Model Review 为 Rejected 时，审核意见自动进入该 Revision 的 Modeling Feedback。

如果真实产品信息发生变化，应创建新的 Drawing Revision，而不是通过 Modeling Feedback 修改旧版本的产品事实。

### 生命周期

```text
首次创建 Drawing Revision
        ↓
创建独立 Revision Memory
        ↓
Run 读取最新 Memory
        ↓
Clarification / Review 产生新信息
        ↓
更新 Revision Facts 或 Modeling Feedback
        ↓
后续新 Run 继续读取最新 Memory
```

关键规则：

- 每个 Drawing Revision 必须拥有独立 Memory；
- Memory 从 Revision 创建开始长期保存；
- 用户回答 Clarification 后，先更新 Revision Facts；
- 原 Run 不允许恢复运行；
- 下一次建模必须创建新的 Run；
- 新 Revision 不自动继承旧 Revision Memory。

---

## 5. Modeling Run

`Modeling Run` 表示 Agent 针对一个确定 Drawing Revision 发起的一次完整自动建模尝试。Run 是执行记录，不是模型本身。

输入至少包括：

- 固定的 Drawing Revision；
- 该 Revision 当前最新的 Revision Memory 快照；
- 系统预设的自动建模指令；
- SolidWorks 自动建模 Skill 及相关运行环境。

可能结果：

```text
Run
├── COMPLETED → 产生 Model
├── CLARIFICATION_REQUIRED → 终止并等待用户回答
├── FAILED → 保存失败记录
└── CANCELLED → 用户主动取消
```

关键规则：

- 同一 Drawing Revision 可以创建多个 Run；
- 新 Run 不得自动覆盖旧 Run；
- Run 创建后永远绑定创建时确定的 Drawing Revision；
- 用户补充信息后必须创建新的 Run，从头重新执行；
- SolidWorks / API / 执行层错误优先由 Agent 自主诊断和修复；
- 只有无法从权威信息确定的工程事实，才向用户提出 Clarification；
- 用户允许主动取消 QUEUED 或 RUNNING 的任务；
- 用户可以显式删除 Run。

Run 使用明确序号区分，例如 `R01 / R02 / R03`。

---

## 6. Clarification Request

`Clarification Request` 表示某次 Modeling Run 在完成尽可能多的分析后，因一个或多个工程信息缺失、矛盾或多义而向用户发起的一组结构化补充请求。

它不是普通聊天消息，而是需要长期保存并与 Run 关联的业务记录。

Agent 不采用“遇到一个问题就立即停一次”的方式，而应该继续完成所有能够继续的分析，并在无法继续建模时一次性汇总本轮所有阻塞问题：

```text
Clarification Request
├── Question 1
├── Question 2
├── Question 3
└── ...
```

用户在 Run 详情页通过专门的补充信息表单统一回答。提交后系统：

1. 把有效回答写入当前 Revision 的 Revision Facts；
2. 将 Clarification Request 标记为已回答；
3. 原 Run 永久保持 `CLARIFICATION_REQUIRED`；
4. 不自动重新执行；
5. 由用户自行决定何时再次点击“开始自动建模”创建新 Run。

Drawing Revision 页面同时提供“版本记忆 / 补充信息”入口，用于长期查看和维护 Revision Facts。

---

## 7. Model

`Model` 是一次成功 Modeling Run 产生的三维建模成果。生成 Model 不意味着该模型已经成为正式生产或报价依据。

Review Status：

```text
PENDING_REVIEW
├── APPROVED
└── REJECTED
```

一个 Drawing Revision 可以存在多个历史上 `APPROVED` 的 Model，但只有被该 Revision 的 `current_approved_model_id` 指向的模型才是当前正式模型。

同一 Revision 下新的 Model 被 Approved 时：

- 自动成为新的当前正式模型；
- 旧 Model 继续保留 `APPROVED` 的历史事实；
- 旧 Model 不再具有“当前正式模型”身份；
- 不额外弹出“是否设为当前模型”的二次确认。

一旦 Model 被 Rejected：

- 此 Model 的业务路线永久结束；
- 不允许修改该 Model 后重新变为 Approved；
- 审核意见写入 Modeling Feedback；
- 用户自行决定何时创建新的 Modeling Run。

主要交付物包括：

- `.SLDPRT`；
- 预览图；
- 建模报告；
- Dimension Ledger；
- Feature Plan；
- Validation Log；
- Builder Source；
- 其他技术交付文件。

普通产品界面优先展示预览图、SolidWorks 模型和建模报告；其他技术文件收纳在技术详情中。

用户可以显式删除 Model。

---

## 8. Model Review

`Model Review` 是对某个 PENDING_REVIEW Model 进行人工工程审核的一次正式记录。Review 本身不需要 PENDING 状态机；创建时直接记录 `APPROVED` 或 `REJECTED`。

Approved Review：

- 对应 Model 变为 APPROVED；
- 自动成为该 Drawing Revision 当前正式模型；
- 允许后续生成内部报价报告。

Rejected Review：

- 对应 Model 变为 REJECTED；
- 保存审核意见；
- 审核意见自动进入该 Revision 的 Modeling Feedback；
- 不自动创建新的 Run；
- 用户自行决定何时重新建模。

---

## 9. Quote Report

`Quote Report` 是基于当前 Drawing Revision 的当前 Approved Model，以及企业当前有效成本数据生成的内部参考报价报告。

它不是直接发送给客户的正式商业报价文件。

只有：

```text
current Drawing Revision
+
current Approved Model
```

才允许生成新的 Quote Report。

当前 MVP 的主要输入包括：

- 零件材料；
- 成品真实体积；
- 加工所需原料体积；
- 材料密度（如成本计算需要）；
- 当日企业维护的材料价格；
- 全局固定成本；
- 后续确定的其他报价规则。

主要输出至少包括：

- 图纸 / 零件基本信息；
- 零件预览图；
- 材料；
- 主要零件参数；
- 成品体积；
- 原料体积；
- 材料成本；
- 固定成本及其他成本明细；
- 总体成本；
- 系统参考报价；
- 本次报告使用的数据时间与价格依据。

同一个正式模型可以多次生成 Quote Report，使用简单序号或时间戳区分，例如 `Q01 / Q02 / Q03`。

不引入复杂的 `DRAFT / FINALIZED / APPROVED` 状态，也不需要 Quote Revision 业务对象。

如果用户认为报告不合适，可以删除后重新生成。每一份 Quote Report 都保存生成时使用的价格和成本数据快照；后续全局 Cost Data 更新不得自动改写历史报告。

---

## 10. Cost Data（支撑对象）

`Cost Data` 是企业维护的报价基础数据，不属于某一张具体图纸。第一阶段完全由用户人工维护。

当前已确认规则：

- 材料价格由用户手动维护；
- 固定成本为企业级全局配置；
- 暂不接入外部材料行情自动更新；
- 每次生成 Quote Report 时读取当天有效的数据并保存快照。

具体成本分类和计算公式需要在后续 `quotation-workflow.md` 中根据江海冶金实际报价方法继续定义。

---

## 11. Customer Quotation（待定扩展对象）

内部自动报价报告与最终面向客户的商业报价不是同一个业务对象。

未来可增加独立的 `Customer Quotation`：

```text
Quote Report
    ↓ 预填参考数据
Customer Quotation
    ↓ 用户人工调整商务信息
Customer-facing PDF
```

它可允许用户编辑最终报价、税费、运费、付款方式、报价有效期、交货周期、客户信息、商务备注及其他条款。

Customer Quotation 不允许反向修改内部 Quote Report。

该对象当前仅作为后续扩展方向记录，是否纳入首版 MVP 尚未最终确认。

---

## 12. Artifact（技术支撑概念）

`Artifact` 用于统一理解系统产生和保存的文件类交付物，例如：

- 原始工程图文件；
- SLDPRT；
- Preview PNG；
- Dimension Ledger；
- Feature Plan；
- Validation Log；
- Builder Source；
- Quote Report 文件；
- 未来可能存在的 Customer Quotation PDF。

Artifact 当前仅作为领域层支撑概念，具体文件系统和数据库建模方式留到 Engineering Spec 阶段决定。

---

## 13. 删除能力

以下主要业务对象在产品层应提供显式删除入口：

- Drawing；
- Drawing Revision；
- Modeling Run；
- Model；
- Quote Report。

原则：

- 新版本、新 Run、新模型不会自动删除历史对象；
- 删除是用户主动行为；
- 删除不设计为业务归档状态；
- 删除父对象时，UI 必须明确提示受影响的关联对象；
- 底层采用硬删除、软删除还是回收站机制，由 Engineering Spec 决定。

---

## 14. 当前核心不变量

1. Drawing 是根对象，Drawing Revision 才是实际建模输入。
2. Drawing 使用 `current_revision_id` 指向当前业务版本，不使用 ACTIVE / ARCHIVED Revision 状态机。
3. Run 永远绑定一个确定的 Drawing Revision。
4. Run 开始后不能切换图纸版本，也不能在用户补充信息后继续原 Run。
5. 每个 Revision 有独立、长期的 Memory。
6. Revision Memory 逻辑上区分 Revision Facts 与 Modeling Feedback。
7. Clarification 应在单次 Run 中尽量批量收集所有阻塞问题。
8. 用户回答 Clarification 后先更新 Revision Facts，再由用户手动创建新 Run。
9. 一个 Revision 可以有多个历史 APPROVED Model，但同时只能有一个 current Approved Model。
10. 新 Model 被 Approved 后自动成为 current Approved Model。
11. Rejected Model 永久停止流转，不在原 Model 上修正后重新 Approved。
12. 审核失败后不自动启动新 Run；用户手动决定何时重新建模。
13. Review Feedback 自动进入该 Revision 的 Modeling Feedback。
14. 新 Drawing Revision 成为 current 后，旧 Revision 不得继续用于生成新的报价报告。
15. 只有当前 Revision 的当前 Approved Model 可以生成新的 Quote Report。
16. Quote Report 是内部参考材料，不引入复杂审批 / Finalized 状态机。
17. 每份 Quote Report 保存生成当日使用的价格和成本数据快照。
18. 固定成本第一阶段采用全局配置。
19. Drawing、Revision、Run、Model、Quote Report 等主要对象提供显式删除能力。
20. Customer Quotation 是潜在独立扩展对象，不与内部 Quote Report 混为一体。
