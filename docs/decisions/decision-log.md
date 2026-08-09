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

历史 Run 不允许被新的 Run 自动覆盖，并通过明确序号进行区分。

---

### Decision: 每个 Drawing Revision 拥有独立长期 Memory

Status: Accepted

Reason:

用户补充的尺寸、歧义解释和其他经确认的工程事实需要在同一图纸版本的后续 Run 中持续使用。

每个 Revision 单独维护 Memory；新 Revision 默认创建新的 Memory，不自动继承其他版本的记忆。

---

### Decision: Revision Memory 区分工程事实与建模反馈

Status: Accepted

Reason:

用户补充的权威工程事实与人工审核指出的 Agent 建模错误具有不同语义，不能混为同一种信息。

每个 Drawing Revision 的长期记忆至少逻辑区分：

- Revision Facts：补充尺寸、结构解释、材料等可作为后续建模依据的版本级事实；
- Modeling Feedback：审核中发现的 Agent 识别或建模错误，用于避免后续 Run 重复犯错。

审核被退回时，审核意见进入 Modeling Feedback；真实产品信息发生变化时应创建新的 Drawing Revision。

---

### Decision: 普通用户不直接输入 Prompt

Status: Accepted

Reason:

建模能力由固定 skill 驱动，普通用户关注业务结果，而不是 Agent 调试过程。

高级调试能力未来可以隐藏提供。

---

### Decision: Run 的业务状态与用户可见 Stage 分离

Status: Accepted

Reason:

Agent 内部执行步骤可能持续变化，不应导致产品状态机不断膨胀。

Run 使用少量业务状态表达生命周期，用户进度只展示 6 个 Stage：准备任务、分析图纸、规划模型、SolidWorks 建模、检查模型、生成结果。

---

### Decision: 用户可以主动取消 Run

Status: Accepted

Reason:

用户可能发现上传错误、任务不再需要或希望停止耗时执行。

取消后的 Run 保留为历史记录，重新建模必须创建新的 Run。

---

### Decision: Clarification 采用单轮批量提问

Status: Accepted

Reason:

Skill 会在完成尽可能多的分析后，一次性汇总当前所有阻塞问题，而不是每遇到一个问题就中断一次。

Clarification Request 可以包含多个问题；用户统一回答后更新 Revision Facts，原 Run 不继续，由用户手动创建新的 Run。

---

### Decision: 图纸歧义必须人工确认

Status: Accepted

Reason:

工程尺寸和结构不能由 Agent 自由猜测。

缺失、矛盾或多义信息出现时，当前 Run 终止为 Clarification Required。用户回答后同步更新 Revision Facts，再由用户主动创建新的 Run 从头执行。

---

### Decision: 生成模型与正式模型必须分离

Status: Accepted

Reason:

Agent 成功生成模型不等于模型已经具备正式业务效力。

同一个 Drawing Revision 可以存在多个 Generated Model，但同时只能存在一个当前 Approved Model。只有人工审核通过的模型可以成为正式模型。

---

### Decision: 新 Approved Model 自动成为当前正式模型

Status: Accepted

Reason:

同一 Drawing Revision 下，新模型被人工 Approved 后，应自动替代旧模型的“当前正式模型”身份，不再额外询问。

旧模型继续保留 `APPROVED` 的历史事实，但不再是 current approved model。

---

### Decision: 新 Drawing Revision 成为当前版本后，旧版本不再用于新报价

Status: Accepted

Reason:

产品信息已通过新图纸版本发生变化时，旧版本虽然保留历史模型和报价，但不能继续作为当前业务依据。

新 Revision 尚未产生 Approved Model 时，应等待新模型审核通过，而不是继续使用旧 Revision 的 Approved Model 生成新的报价报告。

---

### Decision: 被 Rejected 的 Model 不再恢复流转

Status: Accepted

Reason:

一个模型被人工拒绝后，该模型的业务路线永久结束。

如需修正，应创建新的 Modeling Run 并生成新的 Model，而不是修改旧 Model 后重新 Approved。

---

### Decision: 模型审核失败后由用户手动重新启动 Agent

Status: Accepted

Reason:

审核失败本身只代表当前模型不可用，不应自动消耗 Agent 与 SolidWorks 资源。

系统保存审核意见并更新 Modeling Feedback，用户自行决定何时重新点击自动建模并创建新的 Run。

---

### Decision: Review 不单独设计复杂审核页面

Status: Accepted

Reason:

Review 只是自动建模与报价之间的一道人工作业闸门，不需要演变成独立审批系统。

审核操作直接放在 Model 详情页，不引入审核中、待复审、二级审核、多级审批等额外状态。

---

### Decision: Rejected 时审核意见必填并自动进入 Modeling Feedback

Status: Accepted

Reason:

退回模型的核心价值是明确指出 Agent 建模错误，并让下一次 Modeling Run 获得可复用的纠错上下文。

用户退回 Model 时必须填写原因；提交后该意见自动写入当前 Drawing Revision 的 Modeling Feedback。

---

### Decision: 审核通过前不强制检测是否点击过“在 SolidWorks 中打开”

Status: Accepted

Reason:

用户可能已经通过其他方式在 SolidWorks 中完成检查，因此 SWPanel 不采用形式化限制。

“在 SolidWorks 中打开”是推荐审核入口，而不是 Approved 的强制技术前置条件。

---

### Decision: 模型审核通过后才允许报价

Status: Accepted

Reason:

自动生成模型不能直接作为报价依据，需要人工工程审核。

报价必须建立在当前 Drawing Revision 的当前 Approved Model 基础上。

---

### Decision: 同一正式模型允许多次报价，并使用版本管理

Status: Superseded

Superseded by: 自动报价报告采用轻量版本管理

Reason:

早期方案计划使用完整 Quote / Quote Revision 生命周期。后续讨论确认自动报价报告仅作为内部参考材料，不需要复杂报价状态机，因此改为更轻量的报告序号与重生成方式。

---

### Decision: 自动报价报告采用轻量版本管理

Status: Accepted

Reason:

自动报价报告主要供内部参考，不直接作为对客正式报价文件。

同一 Approved Model 可以多次生成报告，使用简单序号或时间戳区分即可；不引入 DRAFT / FINALIZED 等复杂状态。结果不合适时用户可以删除并重新生成。

每份报告仍保存生成时使用的材料价格和成本数据快照。

---

### Decision: 报价使用创建当日有效价格并保存快照

Status: Accepted

Reason:

每次自动报价报告创建时读取当天有效的企业价格数据，并把参与本次计算的数据保存为报告快照。

后续全局价格更新不得自动修改已经生成的历史报告。

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

---

### Decision: 核心业务对象提供显式删除能力

Status: Accepted

Reason:

用户需要主动清理错误上传、无效版本、无意义 Run、模型与报价报告。

新版本或新 Run 不得自动删除旧记录，但 Drawing、Drawing Revision、Run、Model、报价报告等主要对象应提供删除入口。删除不作为归档状态；删除恢复策略后续在 Engineering Spec 中确定。

---

### Decision: Drawing 与 Drawing Revision 不设计归档状态机

Status: Accepted

Reason:

Drawing 是长期根对象，Revision 通过 `current_revision` 指针区分当前业务版本即可，不需要额外 ACTIVE / ARCHIVED 状态。

旧版本保留历史，除非用户显式删除。

---

### Open Decision: 是否加入独立对客报价 PDF 模块

Status: Open

Context:

自动报价报告只用于内部成本与报价参考。后续可以增加独立 `Customer Quotation` 页面，从内部报告预填数据，允许用户根据商务沟通修改最终价格、税费、运费、付款方式、有效期等信息并导出面向客户的 PDF。

该能力是否进入首版 MVP 尚未最终确认。
