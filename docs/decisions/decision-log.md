---
title: Decision Log
status: evolving
owner: JANGHI
last_updated: 2026-08-09
---

# 产品决策记录

## 2026-08-09

### Decision: 图纸上传不会自动触发建模

Status: Accepted

Reason:

图纸本身是长期保存的业务对象，自动建模只是图纸上的一次执行行为。用户需要先管理图纸，再主动选择是否启动 Agent。

---

### Decision: Drawing 以图纸实体为根，并使用 Revision 管理版本

Status: Accepted

Reason:

同一图号后续更新时，不创建完全独立的新 Drawing，而是在原 Drawing 下新增 Drawing Revision。这样可以保持长期业务关系并清晰追踪版本历史。

---

### Decision: Modeling Run 永远绑定一个确定的 Drawing Revision

Status: Accepted

Reason:

一次 Agent 执行必须有不可变的输入版本。Run 启动后不得中途切换图纸版本，也不得在用户补充信息后恢复原 Run。

若需要补充信息，应结束当前 Run，更新该 Revision 的 Memory，然后创建新的 Run 从头执行。

---

### Decision: 同一图纸版本允许多次 Agent 执行

Status: Accepted

Reason:

自动建模存在迭代过程，需要保留失败记录、补充信息记录和不同结果。

历史 Run 不允许覆盖，并通过明确序号进行区分。

---

### Decision: 每个 Drawing Revision 拥有独立长期 Memory

Status: Accepted

Reason:

用户补充的尺寸、歧义解释和其他经确认的工程事实需要在同一图纸版本的后续 Run 中持续使用。

每个 Revision 单独维护 Memory；新 Revision 默认创建新的 Memory，不自动继承其他版本的记忆。

---

### Decision: 普通用户不直接输入 Prompt

Status: Accepted

Reason:

建模能力由固定 skill 驱动，普通用户关注业务结果，而不是 Agent 调试过程。

高级调试能力未来可以隐藏提供。

---

### Decision: 图纸歧义必须人工确认

Status: Accepted

Reason:

工程尺寸和结构不能由 Agent 自由猜测。

缺失、矛盾或多义信息出现时，当前 Run 停止并请求用户补充。用户回答后同步更新 Revision Memory，再创建新的 Run 从头执行。

---

### Decision: 生成模型与正式模型必须分离

Status: Accepted

Reason:

Agent 成功生成模型不等于模型已经具备正式业务效力。

同一个 Drawing Revision 可以存在多个 Generated Model，但同时只能存在一个当前 Approved Model。只有人工审核通过的模型可以成为正式模型。

---

### Decision: 模型审核失败后重新运行 Agent

Status: Accepted

Reason:

MVP 不在被退回的原模型上进行增量自动修改。审核失败后保留原模型和审核记录，并创建新的 Modeling Run，从头生成新的候选模型。

---

### Decision: 模型审核通过后才允许报价

Status: Accepted

Reason:

自动生成模型不能直接作为报价依据，需要人工工程审核。

报价必须建立在当前 Approved Model 基础上。

---

### Decision: 同一正式模型允许多次报价，并使用版本管理

Status: Accepted

Reason:

材料价格或其他成本数据可能随时间变化，同一个 Approved Model 可能需要多次重新询价。

历史报价不得覆盖，每次重新报价产生新的 Quote Revision。

---

### Decision: 报价使用创建当日有效价格并保存快照

Status: Accepted

Reason:

每次 Quote Revision 创建时读取当天有效的企业价格数据，并把参与本次计算的数据保存为不可变快照。

后续全局价格更新不得自动修改历史报价结果。

---

### Decision: 第一阶段报价数据由企业人工维护

Status: Accepted

Reason:

企业真实成本数据优先于外部市场数据。

自动获取材料行情属于未来扩展能力。

---

### Decision: 固定成本采用全局配置

Status: Accepted

Reason:

第一阶段固定成本不按不同产品类型拆分规则，而作为企业级全局报价配置参与计算。具体成本项和计算方法在报价工作流阶段继续定义。
