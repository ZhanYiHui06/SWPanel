---
title: UI Content Fixtures
status: evolving
owner: JANGHI
last_updated: 2026-08-10
---

# SWPanel UI 示例数据

本文档为 Design Mode、原型设计和前端开发提供统一的示例业务数据。

目标：

> 让所有页面使用同一套可信的 SWPanel 业务内容，避免设计工具自行生成 `Project Alpha`、`John Doe`、`Revenue` 等与产品无关的通用 SaaS 占位数据。

本文件中的数据仅用于公开设计稿和开发占位，不代表真实客户、真实采购价格或真实企业成本数据。

---

## 1. 产品与企业

```text
产品名称：SWPanel
企业：江海冶金
英文品牌：JANGHI
```

产品定位文案：

```text
江海冶金内部图纸自动建模与成本测算工作台
```

---

## 2. 主示例 Drawing

```text
Drawing ID：PDJF480.01.17C-4
名称：轧辊（二）
当前 Revision：V3
最近更新：今天 22:44
```

版本列表：

```text
V3  当前版本
V2  历史版本
V1  历史版本
```

V3 原始文件：

```text
PDJF480.01.17C-4.pdf
```

---

## 3. 次级示例 Drawings

用于图纸库、最近图纸和等待队列。

### Drawing A

```text
图号：PDJF273.02.08
名称：定径辊
当前版本：V2
当前状态：正式模型
最近更新：昨天
```

### Drawing B

```text
图号：PDJG159.01.03
名称：阶梯轴
当前版本：V1
当前状态：尚未建模
最近更新：08-07
```

### Drawing C

```text
图号：PDJF508.03.12
名称：连轧辊
当前版本：V2
当前状态：建模中
最近更新：今天 21:18
```

### Drawing D

```text
图号：PDJF325.04.06
名称：矫直辊
当前版本：V1
当前状态：需要补充信息
最近更新：今天 19:32
```

---

## 4. 当前 Modeling Run

工作台和建模任务中心的主任务使用：

```text
Drawing：PDJF480.01.17C-4
Revision：V3
Run：R05
Status：RUNNING
Stage：MODELING
用户可见阶段：SolidWorks 建模
进度：63%
当前提示：正在创建主要旋转特征
创建时间：今天 22:31
```

6 个阶段：

```text
1. 准备任务
2. 分析图纸
3. 规划模型
4. SolidWorks 建模
5. 检查模型
6. 生成结果
```

当前第 4 阶段。

---

## 5. 等待队列

```text
队列 1
Drawing：PDJF273.02.08
Revision：V2
Run：R03
状态：等待执行

队列 2
Drawing：PDJG159.01.03
Revision：V1
Run：R01
状态：等待执行
```

---

## 6. 工作台待处理事项

```text
1 个模型待审核
1 个任务待补充信息
```

可关联：

```text
待审核模型：PDJF480.01.17C-4 · V3 · M03
待补充任务：PDJF325.04.06 · V1 · R02
```

---

## 7. Modeling Run 历史

主 Drawing `PDJF480.01.17C-4 · V3` 使用：

### R05

```text
Run：R05
时间：今天 22:31
状态：已完成 / 或当前设计场景中为运行中
结果：生成模型 M03
```

### R04

```text
Run：R04
时间：今天 20:18
状态：需要补充信息
结果：3 个问题待确认
```

### R03

```text
Run：R03
时间：今天 18:42
状态：已取消
结果：用户主动取消
```

### R02

```text
Run：R02
时间：昨天 21:16
状态：执行失败
失败原因：SolidWorks 自动重建失败
```

### R01

```text
Run：R01
时间：昨天 18:03
状态：已完成
结果：生成模型 M01
```

---

## 8. Clarification 示例

用于 `Run Detail - Clarification`。

标题：

```text
需要补充 3 项信息
```

说明：

```text
以下信息无法从图纸中确定，请补充后保存到当前版本记忆。当前 Run 不会继续执行，保存后可重新发起新的建模任务。
```

问题 1：

```text
问题：中心孔深度是多少？
类型：数值
示例回答：85
单位：mm
```

问题 2：

```text
问题：R5 圆角对应哪一侧？
类型：文本
示例回答：右侧轴肩外缘
```

问题 3：

```text
问题：图纸中的材料无法确认
类型：文本 / 选择
示例回答：42CrMo
```

提交成功文案：

```text
补充信息已保存至 V3 版本记忆
```

辅助说明：

```text
本次 Run 已结束。重新建模将创建新的 Run。
```

---

## 9. Revision Facts 示例

用于“版本记忆 — 工程事实”。

### Fact 1

```text
字段：中心孔深度
值：85 mm
来源：用户补充
来源 Run：R04
```

### Fact 2

```text
字段：材料
值：42CrMo
来源：图纸确认
```

### Fact 3

```text
字段：R5 圆角位置
值：右侧轴肩外缘
来源：用户补充
来源 Run：R04
```

---

## 10. Modeling Feedback 示例

用于“版本记忆 — 建模反馈”。

### Feedback 1

```text
时间：今天 18:12
来源 Model：M02
来源：模型审核退回
内容：Agent 将右侧轴肩直径识别为 Ø102，实际应为 Ø120。
```

### Feedback 2

```text
时间：昨天 19:06
来源 Model：M01
来源：模型审核退回
内容：遗漏图纸右端 R5 圆角，下一次建模需要完整检查局部圆角标注。
```

---

## 11. Model 示例

### M03

```text
Model：M03
Drawing：PDJF480.01.17C-4
Revision：V3
来源 Run：R05
状态：APPROVED
业务身份：当前正式模型
生成时间：今天 22:44
文件格式：SLDPRT
```

Validation：

```text
Rebuild：通过
Body Count：通过
Dimension Check：通过
```

### M02

```text
Model：M02
来源 Run：R04 之前的示例成功 Run，可在设计时按需要调整来源
状态：REJECTED
业务身份：已退回
```

退回原因：

```text
右侧台阶直径错误，应为 Ø120；同时遗漏图纸中的 R5 圆角。
```

### M01

```text
Model：M01
来源 Run：R01
状态：APPROVED
业务身份：历史正式模型
```

注意：

`M01` 保持 APPROVED 历史事实，但不再显示为当前正式模型。

---

## 12. Model Detail 示例内容

建模报告摘要：

```text
模型基于当前 V3 图纸与版本记忆生成。主要结构采用旋转特征完成，已建立中心孔、轴肩和局部圆角。模型完成强制 Rebuild，当前未发现阻塞性验证错误。
```

技术文件：

```text
Dimension Ledger
Feature Plan
Validation Log
Builder Source
```

审核按钮：

```text
退回模型
审核通过
```

退回原因 Placeholder：

```text
请输入模型存在的问题……
```

---

## 13. 材料示例

所有价格仅为公开原型占位数据，不代表真实采购数据。

### 42CrMo

```text
材料：42CrMo
采购价格：5200
价格单位：元/吨
密度：7.85 g/cm³
最后更新时间：今天
```

### 45#钢

```text
材料：45#钢
采购价格：4800
价格单位：元/吨
密度：7.85 g/cm³
最后更新时间：昨天
```

### 40Cr

```text
材料：40Cr
采购价格：5000
价格单位：元/吨
密度：7.85 g/cm³
最后更新时间：08-08
```

---

## 14. 加工余量示例

仅用于原型展示，不代表真实生产参数。

### 圆柱毛坯

```text
类型：圆柱毛坯
直径方向默认余量：+20 mm
长度方向默认余量：+20 mm
```

### 矩形毛坯

```text
类型：矩形毛坯
长度方向默认余量：+20 mm
宽度方向默认余量：+20 mm
高度方向默认余量：+20 mm
```

---

## 15. 固定成本示例

仅用于原型展示，不代表真实企业成本。

```text
基础加工成本：¥500 / 件
检测成本：¥100 / 件
包装成本：¥80 / 批次
```

MVP 表达规则：

> 全局固定成本默认参与每次成本测算。

---

## 16. 成本测算参数示例

用于“生成成本测算报告”参数确认页。

```text
Drawing：PDJF480.01.17C-4
Revision：V3
Model：M03
材料：42CrMo
数量：10
成品真实体积：0.031 m³
毛坯类型：圆柱料
毛坯规格：Ø320 × 820 mm
直径方向余量：+20 mm
长度方向余量：+20 mm
材料价格：5200 元/吨
固定成本：已自动应用
```

---

## 17. 成本测算报告示例

报告编号：

```text
Q03
```

生成时间：

```text
今天 23:21
```

业务标签：

```text
内部参考
```

零件与模型：

```text
Drawing：PDJF480.01.17C-4
Revision：V3
Model：M03
数量：10
材料：42CrMo
```

毛坯：

```text
类型：圆柱料
规格：Ø320 × 820 mm
```

示例成本结果：

```text
单件估算成本：¥3,280
总估算成本：¥32,800
```

如页面需要更完整的成本拆分，可使用：

```text
材料成本：¥2,600 / 件
基础加工成本：¥500 / 件
检测成本：¥100 / 件
包装成本：¥80 / 批次
```

这些数字仅用于视觉原型，不作为真实成本公式或真实业务数据来源。

报告底部声明：

```text
本报告基于当前模型及企业成本配置自动生成，仅供江海冶金内部成本测算与报价决策参考，不构成最终对客报价。
```

---

## 18. 历史成本报告列表

### Q03

```text
报告：Q03
时间：今天 23:21
数量：10
单件估算成本：¥3,280
总估算成本：¥32,800
```

### Q02

```text
报告：Q02
时间：08-07 16:18
数量：1
单件估算成本：¥3,400
总估算成本：¥3,400
```

### Q01

```text
报告：Q01
时间：08-06 10:42
数量：5
单件估算成本：¥3,350
总估算成本：¥16,750
```

---

## 19. 设置页示例

### SolidWorks

```text
程序版本：SolidWorks 2022
连接状态：已连接
程序路径：C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\SLDWORKS.exe
```

### 文件存储

```text
数据目录：C:\SWPanel\Data
```

### Agent / API

```text
Base URL：https://api.example.com/v1
API Key：••••••••••••••••
Model：Configured Model
连接状态：已连接
```

注意：

设计稿禁止放置真实 API Key、真实私有 Base URL 或其他敏感连接信息。

---

## 20. 状态中文文案

### Modeling Run Status

```text
QUEUED                  → 等待执行
RUNNING                 → 执行中
COMPLETED               → 已完成
CLARIFICATION_REQUIRED  → 需要补充信息
FAILED                  → 执行失败
CANCELLED               → 已取消
```

### Model Status

```text
PENDING_REVIEW → 等待审核
APPROVED       → 审核通过
REJECTED       → 已退回
```

### Current Model Identity

```text
当前正式模型
历史正式模型
```

不要创造 `SUPERSEDED` 等未定义 Model 状态。

---

## 21. 通知文案

建模完成：

```text
PDJF480.01.17C-4 · V3 自动建模完成
等待人工审核
```

需要补充：

```text
PDJF325.04.06 · V1 需要补充 3 项信息
```

执行失败：

```text
PDJF273.02.08 · V2 建模任务执行失败
查看失败原因
```

---

## 22. 空状态文案

### 工作台无当前任务

```text
当前没有正在执行的建模任务
```

操作：

```text
上传图纸
打开图纸库
```

### Revision 无正式模型

```text
当前版本暂无正式模型
```

辅助：

```text
完成自动建模并通过人工审核后，可生成内部成本测算报告。
```

### Revision 无 Modeling Run

```text
当前版本还没有建模记录
```

### 无成本报告

```text
当前版本还没有成本测算报告
```

---

## 23. 禁止使用的通用占位内容

设计工具不得自行引入：

```text
Project Alpha
Acme Inc.
John Doe
Revenue
MRR
ARR
Conversion
Sales Pipeline
Marketing Campaign
Team Members
Workspace Plan
Subscription
Billing Usage
```

除非未来产品文档明确引入对应业务能力。

---

## 24. 使用原则

1. 优先复用本文档中的 Drawing、Run、Model、Cost 数据。
2. 同一页面体系保持业务对象编号一致。
3. 示例成本数字仅用于视觉设计，不应被解释为真实成本规则。
4. 不把真实客户图纸、真实企业采购价、真实成本配置放入公开设计稿。
5. 如果某个页面需要额外占位数据，应沿用本文档的命名体系扩展，而不是切换到通用 SaaS 示例数据。
