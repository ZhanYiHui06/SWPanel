---
title: Product Scope
status: evolving
owner: JANGHI
last_updated: 2026-08-09
---

# 产品范围定义

## MVP 包含范围

## 1. 图纸管理

支持：

- 上传工程图；
- 长期保存 Drawing；
- 同一 Drawing 通过 Revision 管理不同图纸版本；
- 使用 `current_revision` 表达当前业务版本；
- 查看历史 Revision；
- 查看关联建模任务、模型、审核结果和成本测算报告；
- 删除 Drawing 或指定 Drawing Revision。

Drawing 是系统中的长期根业务对象，真正参与建模的是确定的 Drawing Revision。

## 2. Revision Memory

每个 Drawing Revision 拥有独立长期 Memory。

支持：

- 保存用户补充的工程事实；
- 保存 Clarification 回答；
- 保存模型审核中的 Agent 错误反馈；
- 在该 Revision 的后续 Modeling Run 中持续使用最新 Memory。

Memory 逻辑上区分：

- `Revision Facts`：尺寸、材料、结构解释等可作为建模依据的权威事实；
- `Modeling Feedback`：审核指出的 Agent 识别和建模错误。

新 Drawing Revision 默认创建独立 Memory，不自动继承旧版本信息。

## 3. 自动建模任务

支持：

- 用户主动选择当前 Drawing Revision 启动建模；
- 创建独立 Modeling Run；
- 单机串行任务队列；
- 查看用户可见的 6 级执行 Stage：准备任务、分析图纸、规划模型、SolidWorks 建模、检查模型、生成结果；
- 查看任务业务状态；
- 用户主动取消排队中或运行中的 Run；
- 保存历史执行记录；
- 对同一 Revision 多次重复执行 Agent；
- 删除指定 Modeling Run。

每个 Run 永远绑定创建时确定的 Drawing Revision；新 Run 不自动覆盖旧 Run。

## 4. Clarification 补充信息

当 Agent 无法依据权威信息确定一个或多个工程事实时：

- Agent 继续完成仍可进行的分析；
- 尽可能一次性汇总本轮所有阻塞问题；
- 当前 Run 终止为 `CLARIFICATION_REQUIRED`；
- 用户在 Run 详情页通过结构化表单统一补充信息；
- 回答同步写入该 Revision 的 Revision Facts；
- 原 Run 不恢复；
- 用户手动决定何时重新启动新的 Modeling Run。

Drawing Revision 页面同时提供长期的“版本记忆 / 补充信息”查看与维护入口。

## 5. Agent 建模管理

系统产品层负责：

- 输入与版本管理；
- Run 创建与任务编排；
- 状态和 Stage 展示；
- Clarification 交互；
- 异常管理；
- 结果与 Artifact 归档。

SolidWorks 自动建模能力由既有 Skill 作为核心执行引擎提供。

普通用户不直接接触 Prompt；Agent 对话和细粒度日志仅作为调试或高级信息存在。

## 6. 模型与人工审核

支持：

- 查看模型预览图；
- 查看建模报告；
- 查看验证结果；
- 下载 / 打开 SolidWorks 模型；
- 在 SolidWorks 中进行真实工程审核；
- 在 SWPanel 中执行 Approved 或 Rejected；
- 保存独立 Model Review 记录；
- Rejected 时保存审核意见并写入 Modeling Feedback；
- 删除指定 Model。

一个 Drawing Revision 可以拥有多个历史 Approved Model，但同时只有一个 `current_approved_model`。

新的 Model 被 Approved 后自动成为该 Revision 的当前正式模型。

Rejected Model 永久停止业务流转，不在原 Model 上修改后重新 Approved。

审核失败后系统不自动启动新的 Run，由用户手动决定何时重新建模。

## 7. 内部成本测算报告

只有当前 Drawing Revision 的当前 Approved Model 才允许生成新的内部成本测算报告。

支持：

- 读取正式模型的零件参数；
- 获取成品真实体积；
- 录入 / 确认本次数量；
- 从图纸 / Revision Facts 自动带入已明确材料；
- 材料未明确时由用户选择或补充；
- 系统 / Agent 辅助推荐毛坯形式与规格；
- 用户在生成前确认或修改毛坯参数；
- 使用企业全局默认加工余量；
- 计算加工所需原料体积；
- 根据企业成本配置和所选单位确定材料成本；
- 默认加入全部企业全局固定成本；
- 使用确定性计算程序汇总单件 / 批次 / 总成本；
- 生成内部成本测算报告；
- 保存报告生成时使用的参数、价格和成本数据快照；
- 同一模型多次生成报告，以简单编号或时间戳区分；
- 删除成本测算报告并重新生成。

成本测算报告仅用于企业内部成本判断，不等于最终对客报价。

第一阶段不在该报告中计算或决定企业利润、最终销售价、税费、运费和商务条款。

## 8. 企业成本数据

第一阶段支持：

- 用户手动维护材料与成本数据；
- 配置可扩展的数据项，而不是完全写死字段；
- 为结构化数值项选择 / 配置单位；
- 用户维护与材料成本计算相关的基础数据；
- 维护全局默认加工余量；
- 维护全局固定成本配置；
- 成本测算报告生成时读取当日有效数据。

系统必须区分“可参与确定性计算的结构化字段”和“仅用于记录 / 展示的自定义字段”。

未知单位或未知计算语义不得由系统自动猜测换算关系或公式。

暂不自动获取外部材料行情。

## 9. 删除能力

MVP 的主要业务对象提供显式删除入口，包括：

- Drawing；
- Drawing Revision；
- Modeling Run；
- Model；
- 成本测算报告。

删除父对象时必须向用户说明关联数据影响范围。

删除是用户主动行为，不额外设计“归档”状态。底层采用软删除、回收站或硬删除由 Engineering Spec 决定。

# 后续独立模块

## Customer Quotation

后续建设面向客户的正式报价单模块。

该模块与内部成本测算报告明确分离，并负责：

- 引用内部成本测算报告作为成本依据；
- 用户结合利润和商务判断确定最终销售价格；
- 填写税费、运费、付款方式、交期、报价有效期、客户信息和商务条款；
- 输出正式客户报价 PDF。

Customer Quotation 不得反向修改历史内部成本测算报告。

该模块属于后续产品范围，不作为当前自动成本测算工作流的一部分。

# 明确不做

第一阶段核心闭环不包含：

- 外部客户账号；
- 客户门户；
- CRM；
- ERP；
- 生产排程；
- CAM / CNC 自动生成；
- Web 端 CAD 编辑器；
- 多租户 SaaS；
- 多机器并行建模；
- 手绘图纸识别；
- 材料市场价格自动同步；
- 复杂企业权限体系；
- 将 Agent 聊天作为核心产品 UI；
- 将旧 Drawing Revision 继续用于当前版本的新成本测算；
- 由 Agent 直接决定最终成本数字；
- 在内部成本测算报告中自动决定最终客户报价。

## 部署边界

第一阶段运行于企业本地 Windows 电脑环境，由本地 SolidWorks 执行自动建模。

不依赖云端部署作为核心能力；模型 API 可使用具有明确隐私保护条款的云服务商。
