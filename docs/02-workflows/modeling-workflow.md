---
title: Modeling Workflow
status: evolving
owner: JANGHI
last_updated: 2026-08-09
---

# 自动建模工作流

本文档定义 SWPanel 从用户发起一次自动建模，到生成 `PENDING_REVIEW` Model 为止的完整业务与执行工作流。

本文档关注产品层与 Agent 执行层之间的契约，不提前锁定具体前端框架、Agent SDK、进程管理方式或文件转换技术实现。

## 1. 工作流目标

Modeling Workflow 的目标是：

> 将一个确定的 Drawing Revision 及其版本级 Memory 固化为一次可追溯的 Modeling Run，经过输入准备、运行前检查、Agent + SolidWorks Skill 自动建模、结构化结果回传与交付检查后，产生一个等待人工审核的 Model；若工程信息不足，则一次性向用户汇总 Clarification；若用户取消，则终止并清理本次 Run 的生成文件。

核心链路：

```text
Drawing Revision
      ↓
用户点击“开始自动建模”
      ↓
任务确认窗口
      ↓
创建 Run + 冻结输入快照
      ↓
QUEUED
      ↓
Preflight + Input Preparation
      ↓
Agent Runner / Adapter
      ↓
SolidWorks Build Skill
      ↓
Analyze → Plan → Model → Validate
      ↓
┌──────────────┬──────────────┐
│              │              │
Clarification  Success        Failure
│              │              │
↓              ↓              ↓
结构化问题     Result Manifest FAILED
↓              ↓
CLARIFICATION  Artifact Check
_REQUIRED      ↓
               Create Model
               ↓
               PENDING_REVIEW
               ↓
               Run COMPLETED
```

---

## 2. 用户发起建模

### 2.1 入口

用户从某个确定的 Drawing Revision 发起自动建模。

普通用户不直接填写 Prompt，不选择 Skill，也不需要配置模型参数。

### 2.2 任务确认窗口

点击“开始自动建模”后，显示一个轻量确认窗口，至少展示：

```text
准备自动建模

图纸：PDJF480.01.17C-4
版本：V3
将使用：当前版本图纸 + 最新版本记忆

[取消] [开始建模]
```

确认窗口只用于防止误操作，不演变为 Agent 配置页面。

用户点击“开始建模”后才正式创建 Modeling Run。

---

## 3. Run 创建与输入冻结

Run 创建的一瞬间，系统冻结本次执行输入。

至少包括：

- `drawing_id`
- `drawing_revision_id`
- Drawing Revision 对应原始图纸文件的快照或稳定引用
- 本次 Run 创建时最新的 `Revision Facts` 快照
- 本次 Run 创建时最新的 `Modeling Feedback` 快照
- 系统 Prompt Template 版本
- SolidWorks Skill 版本 / 标识
- Agent Runtime / Model 配置标识
- Run 创建时间

原则：

> Run 读取的是“创建时最新 Memory”，而不是“真正开始运行时最新 Memory”。

例如 R03 创建后处于排队状态，此时用户更新 Revision Memory，该变化只影响后续创建的 R04，不修改已经存在的 R03。

Run 的输入快照一旦创建不得被修改。

---

## 4. Run Workspace

每个 Modeling Run 必须拥有完全独立的 Workspace。

概念结构：

```text
workspace/
└── <Drawing>/
    └── <Revision>/
        └── <Run>/
            ├── input/
            ├── memory/
            ├── working/
            ├── output/
            ├── logs/
            └── runtime/
```

具体目录名称和文件布局由 Engineering Spec 决定。

原则：

- 不同 Run 不共享可被覆盖的工作文件。
- Agent 只允许在当前 Run 的 Workspace 内产生本次执行文件。
- Run Workspace 用于支持执行隔离、调试、追溯和意外中断恢复。

---

## 5. Preflight

当队列轮到某个 Run 后，在真正调用 Agent 进行图纸理解和建模前执行运行前检查。

用户界面仍只显示：

```text
准备任务
```

Preflight 至少检查：

- Drawing Revision 输入文件可读取；
- Run Input Snapshot 完整；
- Workspace 可创建、可写；
- Agent Runtime 可用；
- 模型 API / 服务配置可用；
- SolidWorks 运行环境可用；
- 自动建模 Skill 可用；
- 关键本地依赖满足执行条件。

Preflight 失败时，不继续消耗完整建模任务资源，Run 进入 `FAILED` 并记录可理解的失败原因。

---

## 6. 输入格式适配

SWPanel 对外可以接受产品定义中支持的工程图格式，但当前 SolidWorks 建模 Skill 保持不修改。

因此：

> 输入格式适配属于 SWPanel 产品层职责，不假设 Skill 原生支持所有产品输入格式。

概念流程：

```text
Original Drawing
      ↓
SWPanel Input Adapter
      ↓
Skill-compatible Input
      ↓
SolidWorks Skill
```

例如 PDF 可以在 SWPanel 中预处理为适合 Skill 使用的高质量图像表达。

DWG / DXF 的具体预处理和转换方式留待 Engineering Spec 确定。

原始工程图必须始终保留，转换文件只是本次 Run 的输入 Artifact。

---

## 7. 系统 Prompt 与 Agent Task Package

普通用户不直接看到 Prompt。

SWPanel 为每个 Run 自动生成严格受控的系统任务包。

其概念输入至少包括：

```text
Drawing Input
Revision Facts Snapshot
Modeling Feedback Snapshot
SolidWorks Skill
Run Workspace
Output Contract
Execution Rules
```

系统 Prompt 采用模板化设计，模板中的部分变量根据 Drawing Revision、Run、Memory、Workspace 等运行信息自动替换。

Prompt 需要明确约束：

- 使用指定 SolidWorks Skill 完成自动建模；
- 不从像素比例、视觉感觉或缺失信息中猜测工程尺寸；
- 优先使用图纸和 Revision Facts 中的权威事实；
- Modeling Feedback 用于避免重复建模错误，但不得覆盖权威工程事实；
- 遇到工程信息阻塞时继续完成所有仍可进行的分析，并在最后一次性汇总 Clarification；
- 输出文件必须进入当前 Run Workspace；
- 输出结构化 Stage Event、Clarification Result 或 Completion Manifest；
- 对 SolidWorks / 执行层错误优先自主诊断和修复。

具体 Prompt 内容在后续 `agent-spec.md` 中定义。

---

## 8. Agent Runner / Workflow Adapter

为了避免 UI 直接依赖 Agent 的自然语言输出，SWPanel 在 Agent 外增加一层 `Agent Runner / Workflow Adapter`。

职责：

- 启动并管理本次 Agent Session；
- 传递 Run Task Package；
- 保存原始 Agent Log；
- 将执行过程映射为结构化 Stage Event；
- 接收结构化 Clarification；
- 接收结构化 Completion Manifest；
- 保存 Agent Session / Resume 信息；
- 处理取消与意外中断恢复。

产品 UI 不通过匹配 Agent 文本中的关键词判断业务状态。

---

## 9. 用户可见 Stage

Run 处于 `RUNNING` 时，对用户只展示 6 级 Stage：

```text
PREPARING  → 准备任务
ANALYZING  → 分析图纸
PLANNING   → 规划模型
MODELING   → SolidWorks 建模
VALIDATING → 检查模型
PACKAGING  → 生成结果
```

Agent Runner 可以在某个 Stage 内提供短 Activity 文案，例如：

```text
正在整理图纸信息
正在调整建模方案
正在重新检查模型
```

Agent 的完整原始输出和技术日志保存用于调试，但不作为普通用户主界面内容。

---

## 10. Clarification Workflow

若图纸信息存在缺失、矛盾或多义，Agent 不应遇到第一个问题就立即停止。

应继续完成所有仍可进行的图纸分析，直到无法继续推进建模，再一次性汇总本轮全部阻塞问题。

Agent Runner 接收结构化 Clarification Result，概念格式：

```json
{
  "result": "clarification_required",
  "questions": [
    {
      "id": "C01",
      "question": "中心孔深度无法确定",
      "type": "dimension",
      "unit": "mm"
    },
    {
      "id": "C02",
      "question": "R5 圆角适用于哪一侧？",
      "type": "text"
    }
  ]
}
```

此时：

- Run → `CLARIFICATION_REQUIRED`；
- 当前 Run 终止，不再继续；
- 用户在 Run 详情页统一回答问题；
- 回答进入该 Drawing Revision 的 `Revision Facts`；
- 用户之后手动创建新的 Run；
- 新 Run 使用更新后的 Revision Memory Snapshot 从头执行。

---

## 11. SolidWorks 建模与 Agent 自主纠错

当图纸信息足够时，Agent 通过现有 SolidWorks Skill 执行建模。

Skill 当前保持不修改。

Agent 应优先自主处理：

- SolidWorks 操作错误；
- Feature 创建失败；
- Rebuild 问题；
- 可通过调整建模执行方案解决的技术错误。

这些内部修复不产生新的业务状态。

Run 保持：

```text
RUNNING
```

并通过 Stage / Activity 告诉用户当前大致进展。

只有工程事实无法确定时才进入 Clarification。

---

## 12. Completion Manifest

Agent 不以“自然语言说建模完成”作为 SWPanel 的成功依据。

成功执行必须输出机器可读的 Completion Manifest。

概念内容：

```text
result: completed

model:
  sldprt: <path>
  preview: <path>

technical:
  dimension_ledger: <path>
  feature_plan: <path>
  validation_log: <path>
  builder_source: <path optional>

validation:
  rebuild: passed
  body_count: ...
  unresolved_assumptions: ...
```

具体协议格式由 Agent Spec 确定。

---

## 13. Artifact Check

收到 Completion Manifest 后，SWPanel 必须进行独立的交付检查。

以下 Artifact 作为 MVP 建模成功的硬性条件：

1. 有效 SolidWorks `.SLDPRT` 文件；
2. 零件 Preview 图；
3. Dimension Ledger；
4. Feature Plan；
5. Validation Log。

`Builder Source` 等其他技术文件可以保存，但暂不作为业务成功的强制条件。

Artifact Check 至少验证：

- 必需文件存在；
- 文件非空；
- Manifest 引用路径有效；
- Validation 结果满足创建候选 Model 的最低条件。

若 Agent 声称成功但交付检查失败：

```text
Run → FAILED
```

不得创建正常 Model。

若交付检查通过：

```text
Create Model
↓
Model.review_status = PENDING_REVIEW
↓
Run = COMPLETED
```

---

## 14. 用户主动取消

用户可以取消 `QUEUED` 或 `RUNNING` Run。

取消动作：

1. 请求 Agent Runner 停止当前 Session / Process；
2. 停止后续 SolidWorks 自动化操作；
3. Run → `CANCELLED`；
4. 删除该 Run 执行过程中产生的所有临时文件、部分模型和输出 Artifact；
5. 不创建 Model；
6. 保留最小 Run 历史元数据，例如 Run ID、绑定 Revision、创建时间、取消时间、状态。

用户主动取消与意外中断必须严格区分。

---

## 15. 意外中断与恢复

APP 意外退出、Agent Runner 崩溃、Windows 重启等情况，不应被产品直接视为用户取消。

为了支持恢复执行，Run Workspace 与运行时信息需要持久化。

至少应保存：

- Run Input Snapshot；
- Agent Session / Conversation ID（若运行时支持）；
- Run Workspace；
- 已产生的安全中间文件；
- 最新 Stage；
- 最近结构化 Event；
- 可恢复检查点或必要的执行上下文。

产品目标：

```text
意外中断
   ↓
重新打开 SWPanel
   ↓
发现存在未正常结束的 RUNNING Run
   ↓
尝试恢复 Agent Session / Workspace
   ↓
恢复成功 → 继续同一 Run
恢复失败 → Run FAILED，并说明恢复失败原因
```

Run 的业务状态不因短暂中断额外增加复杂状态；执行层可以使用内部 `RECOVERING` runtime state，并向用户显示“正在恢复任务”。

注意：

> Windows 重启后能否真正从同一 Agent 推理会话继续，取决于所选 Agent Runtime 是否支持持久化 Session / Resume。SWPanel 将“可恢复执行”定义为产品要求，但具体恢复粒度需要在 Engineering Spec 中结合实际 Agent 能力验证。

若运行时不能恢复完全相同的 Session，应优先从持久化 Workspace 与最近安全检查点恢复，而不是静默创建一个新的业务 Run。

---

## 16. 通知

建模任务不使用阻塞式完成弹窗。

SWPanel 在系统 / 应用右下角显示轻量通知。

典型通知：

```text
✓ PDJF480.01.17C-4 V3 自动建模完成
等待人工审核
```

或：

```text
! PDJF480.01.17C-4 需要补充 3 项信息
```

通知用于提醒，不改变 Run 状态，也不阻塞用户当前操作。

---

## 17. Workflow 不变量

后续产品与工程实现必须保持：

1. 用户确认后才创建 Run。
2. Run 创建时冻结 Drawing Revision 与 Memory 输入快照。
3. 每个 Run 拥有隔离 Workspace。
4. Preflight 在正式 Agent 建模前执行。
5. 输入格式转换由 SWPanel 负责，现有 SolidWorks Skill 暂不修改。
6. 普通用户不直接接触 Prompt；Run 使用严格的系统 Prompt Template。
7. 产品 UI 只消费结构化 Stage / Result，而不是解析 Agent 自然语言判断状态。
8. Clarification 一轮集中汇总所有当前阻塞问题。
9. Agent 成功声明必须经过 Artifact Check。
10. 必需 Artifact 为 SLDPRT、Preview、Dimension Ledger、Feature Plan、Validation Log。
11. 用户主动取消时删除本次 Run 产生的执行文件，不创建 Model。
12. 意外中断与用户取消不同；意外中断优先尝试恢复同一个 Run。
13. Model 只有在交付检查通过后创建，并直接进入 `PENDING_REVIEW`。
14. Run 完成后只做轻量通知，不弹阻塞窗口。

---

## 18. 后续待进入 Engineering Spec 的问题

以下问题已确认方向，但不在本 Workflow 文档中提前定技术实现：

- PDF / DWG / DXF 的具体格式适配方案；
- Agent Runner 使用何种进程 / Session 管理机制；
- Agent Runtime 的 Resume 能力和恢复粒度；
- Prompt Template 的具体格式和版本管理；
- Stage Event / Clarification / Manifest 的正式 JSON Schema；
- Workspace 目录规范；
- Artifact Check 的详细验证规则；
- SolidWorks 进程恢复、COM 状态与重启策略；
- 取消时文件清理失败的补偿机制；
- 通知采用应用内 Toast 还是 Windows 系统通知。
