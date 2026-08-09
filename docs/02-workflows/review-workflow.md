---
title: Review Workflow
status: evolving
owner: JANGHI
last_updated: 2026-08-09
---

# 模型审核工作流

本文档定义 SWPanel 中从 `PENDING_REVIEW` Model 到 `APPROVED` 或 `REJECTED` 的人工审核流程。

Review Workflow 只承担自动建模与报价之间的人工作业闸门，不设计复杂审批系统，也不在 Web 端重复实现 CAD 审核能力。

## 1. 工作流目标

```text
Model = PENDING_REVIEW
        ↓
用户进入模型详情
        ↓
查看 Preview / 建模报告 / Validation
        ↓
可选择“在 SolidWorks 中打开”进行工程检查
        ↓
┌──────────────┬──────────────┐
│              │
审核通过        审核不通过
│              │
↓              ↓
APPROVED       REJECTED
│              │
↓              ↓
成为当前        必填退回原因
正式模型        ↓
│          写入 Modeling Feedback
↓              ↓
允许生成报价    当前 Model 流程永久结束
               ↓
          用户需要时手动重新建模
```

---

## 2. 审核入口

Review 不单独设计为独立页面。

模型审核能力直接放在 Model 详情页中。

页面优先展示：

- Model Preview；
- Drawing / Drawing Revision 基本信息；
- 产生该 Model 的 Modeling Run；
- 建模报告；
- Validation 结果；
- SolidWorks 文件；
- “在 SolidWorks 中打开”操作；
- 当前审核状态与审核操作。

普通用户不需要在审核页看到 Agent Raw Log、Prompt 或其他调试信息；这类内容放在技术详情中。

---

## 3. 在 SolidWorks 中审核

真正的工程检查仍然由用户在 SolidWorks 中完成。

SWPanel 不在 MVP 中实现：

- Web 3D CAD 编辑器；
- Web Feature Tree 编辑；
- Web 尺寸修改；
- 在线 CAD 审核工具。

Model 详情页提供“在 SolidWorks 中打开”，用于方便用户进入真实工程环境检查模型。

但系统不强制要求用户必须先点击过该按钮才能执行审核通过，因为用户可能已经通过其他方式打开并完成检查。

---

## 4. 审核通过

用户点击“审核通过”后：

1. 创建一条 `Model Review` 记录，结果为 `APPROVED`；
2. 当前 Model 的 `review_status` 变为 `APPROVED`；
3. 当前 Drawing Revision 的 `current_approved_model_id` 自动指向该 Model；
4. 若此前已有其他 Approved Model，其审核历史仍保留，但失去“当前正式模型”身份；
5. 不再额外询问“是否设置为当前正式模型”；
6. 如果该 Drawing Revision 同时也是 Drawing 的 `current_revision`，则该 Model 可以进入报价流程。

审核通过不需要填写说明。

---

## 5. 审核不通过

用户点击“退回模型”时必须填写审核意见。

交互保持简单，例如：

```text
退回原因
[请输入模型存在的问题……]

[取消] [确认退回]
```

审核意见主要用于记录 Agent 的建模错误，例如：

- 尺寸识别错误；
- 遗漏特征；
- Feature Tree 不符合机械工程建模逻辑；
- 错误使用 Extrude / Revolve 等特征；
- 几何结果与图纸不一致；
- 其他需要下一次 Modeling Run 避免的问题。

用户确认退回后：

1. 创建一条 `Model Review` 记录，结果为 `REJECTED`；
2. 保存必填审核意见；
3. Model 的 `review_status` 变为 `REJECTED`；
4. 审核意见自动写入当前 Drawing Revision 的 `Modeling Feedback`；
5. 当前 Model 不允许进入报价流程；
6. 不自动启动新的 Modeling Run。

---

## 6. Rejected Model 的终止规则

一旦 Model 被 Rejected，该 Model 的业务流转永久结束。

禁止：

```text
REJECTED
  ↓
修改同一个 Model
  ↓
重新 APPROVED
```

如果需要再次建模：

```text
用户查看审核意见
        ↓
Modeling Feedback 已更新
        ↓
用户手动点击“开始自动建模”
        ↓
创建新的 Modeling Run
        ↓
生成新的 Model
```

因此旧 Model、旧 Review 和旧 Run 始终保持可追溯。

---

## 7. Model Review 数据职责

Model Review 是一次已经发生的审核记录，不需要独立的复杂状态机。

每条 Review 直接记录最终结果：

```text
APPROVED
```

或：

```text
REJECTED
```

至少应保存：

- Review ID；
- Model ID；
- 审核结果；
- 审核时间；
- 审核人；
- 审核意见（Rejected 时必填）。

具体数据库字段在 Engineering Spec 阶段定义。

---

## 8. UI 原则

Review Workflow 在产品层保持极简。

Model 详情页核心操作：

```text
[在 SolidWorks 中打开]

[退回模型]    [审核通过]
```

审核完成后只展示结果和记录，不引入：

- 审核中；
- 待复审；
- 二级审核；
- 多级审批；
- 暂存审核；
- 复杂审批流。

SWPanel 当前只需要确认一个事实：

> 该自动生成模型是否经过人工工程检查，可以作为当前正式模型继续进入报价流程。

---

## 9. 与其他 Workflow 的衔接

### 上游

```text
modeling-workflow.md
        ↓
Model = PENDING_REVIEW
```

### Approved 分支

```text
Model = APPROVED
        ↓
成为 current approved model
        ↓
quotation-workflow.md
```

### Rejected 分支

```text
Model = REJECTED
        ↓
审核意见写入 Modeling Feedback
        ↓
流程停止
        ↓
用户后续手动重新进入 modeling-workflow.md
```
