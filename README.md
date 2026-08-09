# SWPanel

江海冶金内部图纸自动建模与成本测算工作台的产品与工程知识库。

本仓库用于持续沉淀产品定义、业务对象、工作流、Agent 边界、工程 Spec 与验收标准。聊天讨论用于探索，仓库文档用于记录已经确认或正在演进的事实。

## 文档原则

- `stable`：已确认，可作为后续设计与实现的事实来源。
- `evolving`：方向已明确，但仍可能继续调整。
- `draft`：尚在讨论，不应直接作为实现依据。
- `deprecated`：已废弃，仅保留历史参考。

Coding Agent 在实现前应优先阅读 `stable` 文档；若实现需求与 `stable` 文档冲突，应停止并报告冲突，而不是自行选择。

## 当前文档

### 产品定义

- [`docs/00-product/product-brief.md`](docs/00-product/product-brief.md) — 产品目标、用户、核心闭环与 MVP 定义
- [`docs/00-product/product-scope.md`](docs/00-product/product-scope.md) — 第一阶段功能边界与明确不做的事项

### 领域模型

- [`docs/01-domain/business-objects.md`](docs/01-domain/business-objects.md) — Drawing、Revision、Memory、Modeling Run、Model、Review、Quote Report 等核心业务对象与不变量
- [`docs/01-domain/lifecycle-and-status.md`](docs/01-domain/lifecycle-and-status.md) — Run、Clarification、Model、Review 与内部报告的生命周期、状态与执行阶段

### 工作流

- [`docs/02-workflows/modeling-workflow.md`](docs/02-workflows/modeling-workflow.md) — 从用户发起 Run 到生成 `PENDING_REVIEW` Model 的完整自动建模工作流
- [`docs/02-workflows/review-workflow.md`](docs/02-workflows/review-workflow.md) — 从 `PENDING_REVIEW` 到 `APPROVED / REJECTED` 的轻量人工模型审核流程
- [`docs/02-workflows/quotation-workflow.md`](docs/02-workflows/quotation-workflow.md) — 从当前 Approved Model 到内部成本测算报告的参数确认、确定性计算与报告生成流程

### 产品设计上下文

- [`docs/03-product/information-architecture.md`](docs/03-product/information-architecture.md) — 顶级导航、Drawing Workspace、页面层级、页面职责与明确不建立的模块
- [`docs/03-product/screen-priority.md`](docs/03-product/screen-priority.md) — Design Mode 页面优先级、第一批 / 第二批设计顺序与共享组件建议
- [`docs/03-product/ui-content-fixtures.md`](docs/03-product/ui-content-fixtures.md) — 统一的图纸、Run、Model、Clarification、成本和设置示例数据，供原型与前端占位使用

### 决策记录

- [`docs/decisions/decision-log.md`](docs/decisions/decision-log.md) — 重要产品决策及其原因

## 后续逐步建立

随着讨论推进，将继续补充：

- `docs/02-workflows/drawing-workflow.md`
- `docs/04-agent/`
- `docs/05-engineering/`
- `docs/06-evaluation/`

后续还将独立设计 `Customer Quotation` 模块，用于从内部成本测算结果出发形成人工确认的最终对客报价与 PDF。

> 注意：当前仓库为公开仓库。真实客户图纸、企业采购价格、成本数据、API 密钥及其他商业敏感信息不得提交到公开仓库。
