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

### Decision: 同一图纸允许多次 Agent 执行

Status: Accepted

Reason:

自动建模存在迭代过程，需要保留失败记录、补充信息记录和不同版本结果。

历史 Run 不允许覆盖。

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

缺失信息时任务进入补充状态，用户提供信息后重新执行建模。

---

### Decision: 模型审核通过后才允许报价

Status: Accepted

Reason:

自动生成模型不能直接作为生产依据，需要人工工程审核。

报价必须建立在确认后的模型基础上。

---

### Decision: 第一阶段报价数据由企业人工维护

Status: Accepted

Reason:

企业真实成本数据优先于外部市场数据。

自动获取材料行情属于未来扩展能力。
