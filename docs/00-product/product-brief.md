---
title: Product Brief
status: evolving
owner: JANGHI
last_updated: 2026-08-09
---

# SWPanel 产品简介

## 1. 产品定位

SWPanel 是江海冶金内部使用的图纸自动建模与报价工作台。

产品目标不是替代机械工程师，而是利用 Agent 能力减少二维工程图转三维模型过程中的重复人工工作，并将审核通过后的模型进一步连接到企业内部报价参考流程。

核心定位：

> 从二维工程图到三维模型，再到内部报价报告的 AI 辅助工程工作台。

## 2. 用户范围

第一阶段仅服务江海冶金内部用户。

用户角色：

- 企业管理者；
- 实际参与生产和技术审核的工程人员。

用户具备：

- 熟练或精通 SolidWorks 操作能力；
- 能够进行最终工程审核。

## 3. 核心问题

机械加工领域存在大量二维工程图转三维模型的重复建模工作。

该过程：

- 消耗工程师时间；
- 重复劳动比例高；
- 影响后续报价效率。

SWPanel 希望通过 Agent 自动化完成标准化建模工作，并保留人工审核环节，最终基于确认后的模型形成企业内部报价参考材料。

## 4. MVP 核心闭环

```text
上传工程图
    ↓
图纸库长期保存
    ↓
同一图纸通过 Drawing Revision 管理版本
    ↓
用户主动发起自动建模
    ↓
Agent 读取当前 Revision + Revision Memory
    ↓
如存在阻塞问题：批量提出 Clarification
    ↓
用户补充信息并更新 Revision Facts
    ↓
用户手动重新发起新的 Modeling Run
    ↓
Agent 调用 SolidWorks 建模能力
    ↓
生成模型、预览与建模报告
    ↓
人工审核模型
    ↓
Approved Model 成为当前正式模型
    ↓
根据模型参数 + 企业成本数据生成内部报价报告
    ↓
报告查看、参考与归档
```

## 5. 产品原则

### 5.1 图纸是长期业务对象

上传图纸不会自动开始建模。

用户先管理图纸，再决定是否创建建模任务。

同一业务图纸通过 Drawing Revision 管理不同版本。

### 5.2 建模任务独立存在

同一 Drawing Revision 可以拥有多次 Modeling Run。

每个 Run 永远绑定创建时确定的 Revision；历史 Run 不会被新的 Run 自动覆盖。

### 5.3 每个图纸版本拥有独立 Memory

每个 Drawing Revision 均维护自己的长期 Revision Memory，不自动继承其他版本。

Revision Memory 逻辑上区分：

- Revision Facts：用户确认的工程事实；
- Modeling Feedback：人工审核指出的 Agent 建模错误和改进经验。

### 5.4 Agent 不允许工程猜测

当图纸信息不足、存在歧义或无法确定工程参数时，Agent 必须尽可能完成其余分析，然后一次性汇总当前全部阻塞问题。

用户回答后更新 Revision Facts；原 Run 不恢复，由用户手动创建新的 Run 从头执行。

### 5.5 人工审核是必要环节

Agent 输出不直接视为正式模型。

只有人工审核通过的 Model 才能成为当前正式模型，并进入报价流程。

Rejected Model 不再恢复流转，如需修正必须通过新的 Modeling Run 生成新的 Model。

### 5.6 报价报告是内部参考材料

自动报价报告不是直接发送给客户的正式商业报价单。

它依据当前正式模型、当日企业材料价格和全局固定成本生成，主要用于内部成本和报价判断。

报告不设计复杂审批状态；结果不合适时可以删除并重新生成，但每份报告应保存生成时使用的成本数据快照。

未来可单独增加 Customer Quotation，用于人工形成最终面向客户的报价 PDF，但该能力是否进入首版 MVP 尚未确定。

### 5.7 本地优先

第一阶段运行于企业本地 Windows 电脑，由本地 SolidWorks 作为后台执行器。

不设计云端 SaaS、多租户或多机器并行建模能力。

### 5.8 强调可追溯但允许用户显式删除

新版本、新 Run、新模型不会自动覆盖或自动删除历史记录。

同时，Drawing、Drawing Revision、Modeling Run、Model 和 Quote Report 等主要对象应提供用户可见的删除入口。具体删除恢复机制留待 Engineering Spec 定义。
