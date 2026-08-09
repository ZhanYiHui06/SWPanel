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
└── Drawing Revision V1
    ├── Revision Memory
    ├── Modeling Run R01
    │   └── Clarification
    ├── Modeling Run R02
    │   └── Generated Model M01
    │       └── Model Review
    └── Approved Model
        └── Quote
            ├── Quote Revision QV1
            │   └── Quote Report
            └── Quote Revision QV2
                └── Quote Report

└── Drawing Revision V2
    ├── 独立 Revision Memory
    └── 独立的后续建模、审核与报价历史
```

核心原则：

- `Drawing` 是长期存在的根业务对象。
- `Drawing Revision` 是实际参与建模的确定版本。
- `Modeling Run` 永远绑定一个确定的 Drawing Revision，运行过程中不得切换版本。
- 每个 Drawing Revision 拥有自己独立、长期维护的 `Revision Memory`。
- 一次 Modeling Run 可以失败，也可以生成一个候选 Model。
- 一个 Drawing Revision 可以拥有多个生成模型，但同时只能有一个当前正式模型（Approved Model）。
- 只有正式模型可以进入报价流程。
- 同一正式模型可以进行多次报价，每次报价均版本化并保存当次价格快照。

---

## 2. Drawing

### 定义

`Drawing` 表示业务意义上的一份工程图纸实体，通常由图号或企业内部唯一标识识别。

Drawing 不等同于某一次上传的文件。

同一图号后续发生内容变化时，不创建新的 Drawing，而是在该 Drawing 下增加新的 Drawing Revision。

### 主要职责

- 作为所有图纸版本的根节点。
- 汇总该图纸全部建模、模型、审核和报价历史。
- 提供长期检索和归档入口。

### 关键规则

- 一个 Drawing 可以有多个 Revision。
- 不同 Revision 的历史互相独立。
- Drawing 本身不直接参与建模，真正参与建模的是具体 Revision。

---

## 3. Drawing Revision

### 定义

`Drawing Revision` 表示某一 Drawing 在某个确定时间点的具体工程图版本。

例如：

```text
Drawing: PDJF480.01.17C-4
├── V1
├── V2
└── V3
```

### 主要职责

- 保存该版本对应的原始图纸文件。
- 作为 Modeling Run 的固定输入版本。
- 拥有自己的长期 Revision Memory。
- 保存该版本下的全部建模与报价历史。

### 关键规则

- 每个 Modeling Run 必须且只能绑定一个 Drawing Revision。
- Run 启动后不得中途更换 Revision。
- 新 Revision 不自动继承旧 Revision 的 Memory。
- 每个 Revision 的 Memory 相互隔离。

---

## 4. Revision Memory

### 定义

`Revision Memory` 是绑定到单个 Drawing Revision 的长期业务记忆文件。

它用于保存仅靠原始图纸不能完整表达、但已经由用户明确补充或确认的工程信息，并在该版本未来所有 Modeling Run 中作为输入上下文持续使用。

### 主要内容

可包括：

- 用户补充的缺失尺寸。
- 用户对歧义结构的明确解释。
- 已确认的材料、工艺或图纸说明。
- 某次失败后经人工确认的纠正信息。
- 其他经过用户明确确认、可安全用于后续 Run 的版本级事实。

### 生命周期

```text
首次上传 Drawing Revision
        ↓
创建空 Revision Memory
        ↓
Run 发现信息缺失
        ↓
用户补充 / 确认
        ↓
更新 Revision Memory
        ↓
后续所有 Run 读取最新 Memory
```

### 关键规则

- 每个 Drawing Revision 必须拥有独立 Memory。
- Memory 从该 Revision 第一次创建开始长期保存。
- 用户补充信息后，应先更新 Memory，再创建新的 Modeling Run。
- 原 Run 不允许在补充信息后继续运行。
- 新的 Drawing Revision 默认创建新的独立 Memory，不自动继承旧版本信息。

---

## 5. Modeling Run

### 定义

`Modeling Run` 表示 Agent 针对一个确定 Drawing Revision 发起的一次完整自动建模尝试。

Run 是“执行记录”，不是模型本身。

### 输入

至少包括：

- 固定的 Drawing Revision。
- 该 Revision 当前最新的 Revision Memory。
- 系统预设的自动建模指令。
- SolidWorks 自动建模 skill 及相关运行环境。

### 可能结果

```text
Run
├── Completed → Generated Model
├── Clarification Required → 停止
└── Failed → 保存失败记录
```

### 关键规则

- 同一 Drawing Revision 可以创建多个 Run。
- Run 历史不得覆盖。
- 用户补充信息后必须新建 Run，从头重新执行。
- SolidWorks/API/执行层错误优先由 Agent 自主诊断和修复。
- 只有无法从权威信息确定的工程事实，才应要求用户补充。

### 命名

Run 需要具备明确的序号，例如：

```text
R01
R02
R03
```

具体展示格式由后续产品设计决定。

---

## 6. Clarification

### 定义

`Clarification` 表示某次 Modeling Run 因图纸信息缺失、矛盾或存在多个合理解释，而向用户提出的结构化补充请求。

它不是普通聊天消息，而是需要长期保存的业务记录。

### 示例

```text
问题：中心孔深度未明确标注
影响：无法确定 Central_Bore
状态：Waiting for Answer
用户回答：85 mm
```

### 处理规则

```text
Run R01
    ↓
Clarification Required
    ↓
R01 停止
    ↓
用户回答
    ↓
更新 Revision Memory
    ↓
创建 Run R02
    ↓
R02 从头执行
```

### 关键规则

- Clarification 必须绑定产生它的 Modeling Run。
- 用户答案同时形成该 Revision 的长期 Memory。
- 原 Run 不恢复运行。

---

## 7. Model

### 定义

`Model` 是一次成功 Modeling Run 产生的三维建模成果。

生成 Model 不意味着该 Model 已经成为正式生产或报价依据。

### 两类业务身份

#### Generated Model

Agent 成功输出，但尚未完成人工审核的候选模型。

#### Approved Model

经过人工审核通过、被指定为该 Drawing Revision 当前正式模型的 Model。

### 关键规则

- 一个 Drawing Revision 可以存在多个 Generated Model。
- 同一时刻只能有一个当前 Approved Model。
- 新 Model 生成后不会自动替换现有 Approved Model。
- 新 Model 必须审核通过后才能成为新的正式模型。
- 只有 Approved Model 可以进入报价流程。

### 交付物

Model 关联的主要交付物包括：

- `.SLDPRT`
- 预览图
- 建模报告
- Dimension Ledger
- Feature Plan
- Validation Log
- Builder Source
- 其他技术交付文件

普通产品界面优先展示预览图、SolidWorks 模型和建模报告；其他技术文件可收纳在技术详情中。

---

## 8. Model Review

### 定义

`Model Review` 是对某个 Generated Model 进行人工工程审核的一次正式记录。

审核不是 Model 上的简单状态字段，而应保留独立历史。

### 结果

```text
Approved
Rejected
```

### Approved

- 当前 Model 可以成为该 Drawing Revision 的正式模型。
- 若此前已有正式模型，则新的 Approved Model 取代其“当前正式模型”身份，但旧模型仍保留历史记录。
- 允许进入报价流程。

### Rejected

- 当前 Model 不得用于报价。
- 用户记录审核问题或退回原因。
- 系统创建新的 Modeling Run，由 Agent 从头重新建模。
- 不在原 Model 上进行增量修改作为 MVP 主流程。

---

## 9. Quote

### 定义

`Quote` 表示一个 Approved Model 对应的报价业务实体。

同一个 Approved Model 可以被多次重新报价，因此 Quote 下需要管理多个 Quote Revision。

### 关系

```text
Approved Model
    ↓
Quote
├── QV1
├── QV2
└── QV3
```

### 关键规则

- 只有 Approved Model 才能创建 Quote。
- 同一个模型允许多次报价。
- 多次报价不得覆盖历史结果。

---

## 10. Quote Revision

### 定义

`Quote Revision` 表示某次实际报价计算的不可变业务快照。

每次重新询价 / 重新计算报价，都产生新的 Quote Revision。

### 报价输入

当前 MVP 主要包括：

- Approved Model 的零件参数。
- 零件材料。
- 成品真实体积。
- 加工所需原料体积。
- 材料密度（如成本计算需要）。
- 当日企业维护的材料价格。
- 全局固定成本。
- 后续确定的其他报价规则。

### 价格快照原则

Quote Revision 创建时读取“当天有效”的企业价格数据，并把本次参与计算的价格保存为该 Revision 的快照。

之后即使全局价格表发生变化，历史 Quote Revision 的计算结果也不得被自动改写。

例如：

```text
QV1 创建日：材料价 4.80 元/kg
QV2 创建日：材料价 5.10 元/kg
```

QV1 永远保留 4.80 元/kg 的历史计算依据。

---

## 11. Quote Report

### 定义

`Quote Report` 是基于某一个 Quote Revision 生成的内部可阅读报价报告。

它是报价数据的呈现成果，不是报价计算本身。

### 第一阶段主要内容

- 图纸 / 零件基本信息。
- 零件预览图。
- 材料。
- 主要零件参数。
- 成品体积。
- 原料体积。
- 材料成本。
- 固定成本及其他成本明细。
- 总成本。
- 最终报价。
- 本次报价使用的数据时间与价格依据。

### 使用边界

第一阶段 Quote Report 仅供江海冶金内部用户查看与审核，不直接发送给客户。

---

## 12. Cost Data（支撑对象）

### 定义

`Cost Data` 是企业维护的报价基础数据，不属于某一张具体图纸。

第一阶段完全由用户人工维护。

### 当前已确认规则

- 材料价格由用户手动维护。
- 固定成本为全局性成本配置。
- 暂不接入外部材料行情自动更新。
- 每次 Quote Revision 使用创建当日有效的数据并生成快照。

具体成本分类和计算公式需要在后续 `quotation-workflow.md` 中根据江海冶金实际报价方法继续定义。

---

## 13. Artifact（技术支撑概念）

`Artifact` 用于统一理解系统产生和保存的文件类交付物，例如：

- 原始工程图文件。
- SLDPRT。
- Preview PNG。
- Dimension Ledger。
- Feature Plan。
- Validation Log。
- Builder Source。
- Quote Report。

Artifact 当前仅作为领域层支撑概念，具体文件系统和数据库建模方式留到 Engineering Spec 阶段决定。

---

## 14. 当前核心不变量

以下规则在后续产品、数据库和 Agent 设计中必须保持：

1. Drawing 是根对象，Revision 才是实际建模输入。
2. Run 永远绑定一个确定 Revision。
3. Run 开始后不能切换图纸版本，也不能在用户补充信息后继续原 Run。
4. 每个 Revision 有独立、长期的 Memory。
5. 用户补充信息先进入 Revision Memory，再创建新 Run。
6. 一个 Revision 可以有多个 Generated Model，但同时只能有一个当前 Approved Model。
7. 只有 Approved Model 可以报价。
8. 审核失败后创建新 Run，不覆盖旧 Model。
9. 同一 Approved Model 可以多次报价。
10. 每次报价必须版本化并保存当次价格快照。
11. 历史 Run、Model、Review、Quote Revision 均不得被后续结果覆盖。
