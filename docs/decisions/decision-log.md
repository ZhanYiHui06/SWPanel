---
title: Decision Log
status: evolving
owner: JANGHI
last_updated: 2026-08-16
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

### Decision: 新 Drawing Revision 成为当前版本后，旧版本不再用于新成本测算

Status: Accepted

Reason:

产品信息已通过新图纸版本发生变化时，旧版本虽然保留历史模型和报告，但不能继续作为当前业务依据。

新 Revision 尚未产生 Approved Model 时，应等待新模型审核通过，而不是继续使用旧 Revision 的 Approved Model 生成新的成本测算报告。

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

Review 只是自动建模与成本测算之间的一道人工作业闸门，不需要演变成独立审批系统。

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

### Decision: 模型审核通过后才允许成本测算

Status: Accepted

Reason:

自动生成模型不能直接作为成本依据，需要人工工程审核。

成本测算必须建立在当前 Drawing Revision 的当前 Approved Model 基础上。

---

### Decision: 同一正式模型允许多次报价，并使用版本管理

Status: Superseded

Superseded by: 内部成本测算报告采用轻量版本管理

Reason:

早期方案计划使用完整 Quote / Quote Revision 生命周期。后续讨论确认系统自动产物本质上是内部成本测算材料，不需要复杂报价状态机，因此改为更轻量的报告序号与重生成方式。

---

### Decision: 内部成本测算报告采用轻量版本管理

Status: Accepted

Reason:

内部成本测算报告主要供企业参考，不直接作为对客正式报价文件。

同一 Approved Model 可以多次生成报告，使用简单序号或时间戳区分即可；不引入 DRAFT / FINALIZED 等复杂状态。结果不合适时用户可以删除并重新生成。

每份报告仍保存生成时使用的输入、材料价格和成本数据快照。

---

### Decision: 成本测算使用创建当日有效价格并保存快照

Status: Accepted

Reason:

每次成本测算报告创建时读取当天有效的企业价格数据，并把参与本次计算的数据保存为报告快照。

后续全局价格更新不得自动修改已经生成的历史报告。

---

### Decision: 第一阶段成本数据由企业人工维护

Status: Accepted

Reason:

企业真实成本数据优先于外部市场数据。

自动获取材料行情属于未来扩展能力。

---

### Decision: 成本配置采用可扩展字段与可配置单位

Status: Accepted

Reason:

江海冶金实际使用的数据字段和计价单位不应被产品完全写死。

用户可以增加成本 / 材料配置项并选择或配置单位；系统必须区分可参与确定性计算的结构化字段与仅用于记录展示的自定义字段。未知单位和未知计算语义不得由系统猜测换算关系。

---

### Decision: 毛坯由系统辅助推荐但必须由用户确认

Status: Accepted

Reason:

原料体积不能简单等于成品体积，而毛坯形式、规格和加工余量会直接影响材料成本。

系统 / Agent 可以依据 Approved Model 辅助推荐毛坯类型与尺寸，但最终参与成本计算的毛坯参数必须由用户在生成报告前确认或修改。

---

### Decision: 加工余量使用企业全局默认配置

Status: Accepted

Reason:

第一阶段允许企业维护毛坯加工余量的全局默认值，成本测算时自动带入并展示。

真实默认数值由江海冶金业务人员配置，产品不预设生产参数。

---

### Decision: 每次成本测算必须包含数量

Status: Accepted

Reason:

成本报告需要同时表达单件与本次数量对应的总体成本，因此每次成本测算包含 quantity，默认值为 1，用户可以修改。

不同成本项按件、按批次或其他方式计入的规则由成本项配置定义。

---

### Decision: 全局固定成本默认参与每一次成本测算

Status: Accepted

Reason:

第一阶段保持流程简单，企业维护的全局固定成本默认全部参与每次成本计算，不在每份报告中要求用户逐项选择是否启用。

未来若真实业务需要，可再扩展按报告启用 / 禁用指定成本项。

---

### Decision: 成本数字由确定性程序计算，Agent 不拥有最终计算权

Status: Accepted

Reason:

体积、单位换算、质量、材料成本、数量和成本汇总必须可追溯、可复现。

Agent 可以辅助理解零件、建议毛坯和生成成本说明，但最终数值计算由 Rules / Calculator 执行。

---

### Decision: 内部成本测算不包含利润和最终客户报价

Status: Accepted

Reason:

自动成本报告的职责是提供企业成本参考，而不是替企业做最终商业报价决策。

利润、加价、最终销售价格、税费、运费和商务条款不进入成本测算结果。

报告最终区域使用“单件估算成本 / 批次估算成本 / 总估算成本”等成本语义，而不是“最终报价”。

---

### Decision: Customer Quotation 作为独立后续模块

Status: Accepted

Reason:

最终面向客户的报价需要结合内部成本、企业利润、客户沟通和商务条件，由用户人工确定。

后续独立建设 `Customer Quotation` 模块，用于引用内部成本测算报告、确定最终销售价格、填写税费 / 运费 / 付款方式 / 交期 / 有效期 / 客户信息 / 商务条款，并输出正式客户报价 PDF。

Customer Quotation 不得反向修改历史内部成本测算报告。

---

### Decision: 核心业务对象提供显式删除能力

Status: Accepted

Reason:

用户需要主动清理错误上传、无效版本、无意义 Run、模型与内部成本报告。

新版本或新 Run 不得自动删除旧记录，但 Drawing、Drawing Revision、Run、Model、成本测算报告等主要对象应提供删除入口。删除不作为归档状态；删除恢复策略后续在 Engineering Spec 中确定。

---

### Decision: Drawing 与 Drawing Revision 不设计归档状态机

Status: Accepted

Reason:

Drawing 是长期根对象，Revision 通过 `current_revision` 指针区分当前业务版本即可，不需要额外 ACTIVE / ARCHIVED 状态。

旧版本保留历史，除非用户显式删除。

---

## 2026-08-12

### Decision: Authenticode 签名与 clean-Windows 离线安装 smoke 属于 Phase 8，不属于 Phase 1 Exit Gate

Status: Accepted

Context:

此前将 Authenticode 代码签名与 clean-Windows 离线安装/启动/重启/卸载 smoke 视为 Phase 1 Exit Gate 前置项，导致 Phase 1 长期停留在 FAIL / externally blocked。`development-plan.md` 中 Phase 1 的正式 Exit Gate 只要求：核心页面可通过真实路由进入、页面视觉与 TRAE Design 保持高一致性、相同组件只维护一份、状态文案与领域状态一致、Mock 数据修改可跨关联页面正确反映、不存在真实后端依赖。签名与 clean-Windows 离线 smoke 均不在其中；`architecture.md` 也把它们列为打包（Phase 8）阶段的外部交付事项。

Decision:

以 `development-plan.md` §5 的正式 Phase 1 Exit Gate 为准。Phase 1 Frontend Foundation **PASS（2026-08-12，Owner scope decision）**，并正式启动 Phase 2（Persistence and Drawing Workflow）。Authenticode 签名与 clean-Windows 离线 install/start/restart/uninstall smoke 重分类为 **Phase 8 外部交付待办**。

Reason:

Phase 1 是纯 Mock 数据前端阶段（无真实数据库、不启动 Agent、不调用 SolidWorks），其验收条件已全部由仓库侧证据满足。签名与 clean-Windows 离线安装验收属于企业分发的真实机器/证书能力，与 Phase 1 前端基础验收无关，放在 Phase 8（Recovery / Hardening / Packaging）更符合计划定义。

Consequences:

- 二者当前均**未执行、未通过**，文档如实保留事实（`signtool` absent、`Cert:\CurrentUser\My` code-signing cert 0；本机非 clean-Windows），**不得声称已通过**，不生成临时自签名证书冒充交付签名。
- Phase 1 历史 FAIL / externally blocked 判定保留为历史记录，不作改写。
- Phase 2 于 2026-08-12 启动，按 WP0→WP7 顺序推进。

---

## 2026-08-13

### Decision: Phase 2 Exit Gate 判定 PASS；Named Pipe 双账户拒绝测试为人工安全跟进项

Status: Accepted

Context:

Phase 2（Persistence and Drawing Workflow）的 WP0-WP7 已全部实现并有 2026-08-13 当日证据（`npm run check` exit 0：root 289 / desktop 432 / runner 91 / contracts 36 / domain 35 / ui 43；fixtures 13/13 零 violations；browser + Electron smoke 35/35；production Electron 14/14；`package:audit` ok:true）。`development-plan.md` §6 的正式 Exit Gate 只要求：用户在没有 Agent 的情况下可以完整执行图纸管理流程；关闭并重启应用后数据仍存在。WP4 的 Named Pipe 安全边界以真实 DACL 证据交付：live pipe 的 DACL 被 `SetSecurityInfo(SE_KERNEL_OBJECT, DACL|PROTECTED_DACL)` 设为恰 {current user SID, SYSTEM} 并读回严格校验（无 Everyone/ANONYMOUS 等 broad SID）；Electron 侧 RunnerHost 对无法证明 DACL 的情况 fail-closed。但本机是单账户 Windows 主机，无法执行真实的第二 Windows 账户 pipe 拒绝访问测试。

Decision:

以 `development-plan.md` §6 的正式 Phase 2 Exit Gate 为准。Phase 2 **PASS（2026-08-13）**；Phase 3 为下一阶段、未开始（不启动）。**真实的第二 Windows 账户 pipe 拒绝访问测试未执行**，保持为**人工安全跟进项**：DACL 读回证据证明 ACE 集恰为 current user + SYSTEM，安全边界不依赖 pipe 名难猜，但双账户拒绝行为在被真实测试前**不得虚报为已通过**。

Reason:

Phase 2 的验收条件（无 Agent 完成图纸管理流程 + 重启后数据仍在）已由 2026-08-13 证据全部覆盖。DACL 读回（恰 current user + SYSTEM、无 broad SID）是可以在单账户主机上客观证明的 ACL 事实，也是安全边界的实质内容；第二账户拒绝测试只是该边界的黑盒确认，其缺失不应阻塞一个已由正式 Exit Gate 定义之外的 Gate 判定，但必须如实保留为人工安全跟进项，与 Phase 1 时签名/clean-Windows smoke 的重分类原则一致（不虚报、不伪造证据）。

Consequences:

- Phase 2 Exit Gate = **PASS（2026-08-13）**；Phase 3 未开始、不启动。
- **人工安全跟进项（未通过，不虚报）**：真实第二 Windows 账户 pipe 拒绝访问测试；在双账户环境以账户 A 运行 SWPanel、以账户 B 尝试连接必须被拒，并记录 DACL 证据。
- **Phase 8 外部交付待办保持未通过**：Authenticode 签名（signtool absent、code-signing cert 0）与 clean-Windows 离线 install/start/restart/uninstall smoke 均未执行、未通过，不声称已通过。
- **canonical package/installer 新鲜度**：当前 canonical package（2026-08-12T18:11:09Z 发布，audit ok:true）可能滞后于最新 WP6/WP7 源码（08-13 收口后未重跑 `package:win`），其哈希不得当作最新源码证据；需要最新可分发产物时基于当前工作树重跑 `npm run package:win`（可选 `make:win`）。
- 同步 `lead-agent-handoff.md`、`implementation-status.md`、`architecture.md` 与本日志；Phase 1/Phase 2 历史判定记录不作改写。

---

## 2026-08-13

### Decision: Phase 3 Exit Gate 判定 PASS；模型无关 COMPLETED、测试专用执行器配置与 Runner 生产默认快照配置

Status: Accepted

Context:

Phase 3（Modeling Run Orchestrator Skeleton）的 P3-0..P3-6 已全部实现并有 2026-08-13 当日证据（`npm run check` exit 0：root 10/289、desktop 29/557、runner 12/235、contracts 4/47、domain 12/51、ui 6/43；`npm run check:fixtures` 13/13 零 violations；`npm run test:e2e` exit 0：production Electron 18/18、browser+smoke 49/49）。`development-plan.md` §7 的正式 Exit Gate 要求：通过 Mock/Fake Executor 可靠演示所有 Run 状态、6 Stage、队列、取消和恢复 UI。批次执行中产生四个需要记录的行为/契约决定：

1. **模型无关 COMPLETED（已批准契约决定）**：Phase 3 的 `Completed` 事件允许不带 `modelId`，Fake Executor 完成时不创建 `models` 记录（plan 已确认）；Phase 5 真实发布 Model 时再收紧发布路径。
2. **测试专用 Fake Executor 配置仅通过进程/环境（unpackaged 才生效）**：`SWPANEL_TEST_FAKE_EXECUTOR_SCENARIO`、`SWPANEL_TEST_FAKE_EXECUTOR_STEP_DELAY_MS`、`SWPANEL_TEST_RUN_LEASE_MS` 三个环境变量只读一次于 Main 进程；packaged 启动携带任一变量即拒绝启动（fail-closed，与 `--swpanel-test-runtime-root` 契约一致）；Renderer/IPC payload 永不携带 scenario/delay/lease。
3. **Runner 生产默认 run profile（DEFAULT_RUN_PROFILE）**：Input Snapshot 的 prompt template version、Skill identity+hash、agent/config id 由 Runner 配置提供；未注入时使用生产默认（`2026.08-p3`、`solidworks-build-part-from-drawing` + 占位 hash、`codex-app-server`）。占位 hash 是 Phase 3 无 preflight 的版本钉，Phase 5 解析并校验真实 skill hash 前不作任何验证。
4. **启动恢复的队列唤醒**：Runner `open()` 在检测到上一个进程遗留的 ACTIVE attempt（lease 未过期，即"快速重启在租约内"）时自动启动串行队列循环，使中断 Run 在 lease 到期时被恢复，无需等待新的 `run.create`；仅 QUEUED 的恢复仍保持手动 claim 语义（现有确定性测试依赖），`run.create` 仍唤醒循环（re-entrant）。

Decision:

以 `development-plan.md` §7 的正式 Phase 3 Exit Gate 为准。Phase 3 **PASS（2026-08-13）**；Phase 4 为下一阶段、未开始（不启动）。上述四项决定按本条目记录为 Accepted；本阶段不实施或宣称 Phase 4/真实 SolidWorks 能力。

Reason:

Phase 3 的验收条件（Fake Executor 可靠演示所有 Run 状态、6 Stage、串行队列、取消清理、中断/恢复、UI 重连）已由 2026-08-13 证据全部覆盖：browser E2E 14/14（显式 fake bridge 黑盒 UI）+ production Electron 4/4（真实 Runner + Fake Executor + 临时 runtime root + 测试专用 env 配置，无 dev server 依赖）。测试专用配置走进程/环境而非 Renderer payload，保证生产契约不被污染；Runner 默认 profile 让生产产品开箱即可创建 Run（快照版本值由 Runner 侧提供，Renderer 只提交 identity pair）。

Consequences:

- Phase 3 Exit Gate = **PASS（2026-08-13）**；Phase 4 未开始、不启动。
- **已知限制（如实记录，未修复）**：`run.create` 按 (drawingId, revisionId) 对做幂等（P3-4 决定），30 分钟 TTL 内对同一 Revision 的"刻意第二次创建"（如澄清后"重新自动建模"）会命中幂等缓存返回旧 Run；本批次 production E2E 用"第二 Revision"构造串行队列测试以尊重该设计。若产品要求同 Revision 快速重建新 Run，需要在 Phase 4/后续批次引入 Renderer-minted client intent id（沿用 fact/feedback 模式）或调整幂等语义——该项未在本批次擅自修改契约，作为待决策风险记录。
- **人工安全跟进项（未通过，不虚报）**：真实第二 Windows 账户 pipe 拒绝访问测试未执行（单账户主机）。
- **Phase 8 外部交付待办保持未通过**：Authenticode 签名与 clean-Windows 离线 smoke 均未执行、未通过。
- **canonical package/installer 新鲜度**：现有 canonical 包仍滞后于最新源码（本批次未重跑 `package:win`），其哈希不得当作最新源码证据。
- 同步 `lead-agent-handoff.md`、`implementation-status.md` 与本日志；Phase 1/2 历史判定记录不作改写。

---

## 2026-08-13

### Decision: 审计收口 F1-F3 — run.create 幂等键改为 Main 按调用铸造唯一 intent id（关闭待决策风险）；Runner.open 启动并排空队列；终态读模型清空执行字段

Status: Accepted

Context:

Phase 3 Exit Gate 判定后的最终审计发现三项需要收口的问题：

1. **F1（原待决策风险关闭）**：`run.create` 原来按 (drawingId, revisionId) 语义对做幂等键（P3-4 设计），30 分钟 TTL 内对同一 Revision 的"刻意第二次创建"会命中幂等缓存返回旧 Run，与产品"澄清后重新自动建模 = 创建新 Run"行为冲突。审计决定：改为 **Main 进程按用户调用铸造唯一 intent id 幂等键**（`run-create:<uuid>`）——每次显式用户创建都是独立意图（同一 Revision 两次创建得到 R01/R02），同一调用的单次 Runner command dispatch 及其传输级重试仍复用同一键（相同 envelope 重复派发由 Runner 幂等缓存应答，不重复执行）；intent id 是 Main 内部传输元数据，**不进入 Renderer payload**（bridge 仍只接受 drawingId/revisionId）也**不出现在 Runner wire command**。E2E 串行队列测试改为同一 Revision 两次创建（回归 R01/R02）。
2. **F2**：`Runner.open()` 原来只在存在 live-lease ACTIVE attempt 时启动串行队列循环；审计决定：**存在 QUEUED Run 时也应启动并排空队列**（重启后的队列无需新的 `run.create` 即自动执行），循环在排空后自终止。新增确定性 reopen 测试（手动 scheduler：reopen 后立即 RUNNING、flush 后 COMPLETED，无需手动 `runQueue()`）。
3. **F3**：终态读模型原来只清空 `stage`；审计决定：**终态（COMPLETED/CLARIFICATION_REQUIRED/FAILED/CANCELLED）清空全部实时执行字段 stage/activity/progressPercent**（执行已结束，走过的历史在事件日志里），浏览器 fake bridge 的终态投影与生产 E2E 断言同步对齐；`DEFAULT_RUN_PROFILE` 的占位 skill hash 保持文档化（Phase 5 前不验证）。

Decision:

按上述 F1/F2/F3 收口；`run.create` 幂等键语义从"语义对"改为"Main 按调用铸造的唯一 intent id"，原"待决策风险"**关闭（已解决）**。Phase 3 Exit Gate 判定维持 **PASS（2026-08-13）**。

Reason:

Main 铸造唯一 intent id 同时满足：(a) 同一 Revision 的显式第二次创建产生新 Run（用户意图）；(b) 同一调用的传输级重试仍幂等（Runner 缓存按键应答）；(c) Renderer payload 与 Runner wire command 不携带任何 intent/scenario（保持冻结契约与安全面）。启动队列对 QUEUED Run 生效使"重启后队列自动继续"成立且可确定性测试。终态清空执行字段使读模型一致（UI 对终态运行不展示进度字段，历史由事件承载）。

Consequences:

- **F1 关闭**：`apps/desktop/src/main/ipc/main-ipc.ts` `run.create` handler 使用 `run-create:<randomUUID()>` 作为每次调用的幂等键；主进程单测新增"同一对两次调用产生不同键"断言；`main-ipc.integration.test.ts` B2 测试改为同一 Revision 两次创建并断言 R01/R02；production E2E 串行队列测试同一 Revision 两次创建（R01/R02）。传输级"相同 envelope 重复派发幂等"由 Runner 服务端 idempotencyKey 缓存测试继续覆盖（`request-handler.test.ts` "keeps run.create idempotent under a repeated idempotencyKey"）。澄清后"重新自动建模"在生产产品中现在真实创建新 Run。
- **F2 生效**：`apps/runner/src/runner.ts` `open()` 条件扩为 `nextActiveLeaseDeadline() !== null || hasQueuedRuns()`；新增确定性 reopen 测试（`fake-executor.test.ts` "reopen auto-starts the queue and drains a QUEUED Run without a manual runQueue()"）；"wires claim"与"reopen auto-recovery un-wedges"两个 orchestration 测试更新为自动 claim 语义。
- **F3 生效**：`apps/runner/src/db/run-repository.ts` `finishExecution` 清空 stage/activity/progressPercent；run-repository COMPLETED 投影测试断言三者为空；`e2e/phase3.browser.spec.ts` fake 终态投影与终态 seed 同步对齐；production E2E 终态断言更新（activity/progressPercent 为空）。
- **文档同步**：`implementation-status.md`、`lead-agent-handoff.md` 的待决策风险条目改为已解决；`DEFAULT_RUN_PROFILE` 占位 hash 说明保留。
- 未 commit/push（规则不变）；Phase 4 未开始、不启动。

---

## 2026-08-13

### Decision: Phase 4 Exit Gate 判定 PASS；合成适配器真实性、不静默选页、raw→product 边界、Clarification Facts、独立 Manifest 校验与 per-claim 队列错误边界

Status: Accepted

Context:

Phase 4（Input Adapter and Agent Contract）的 P4-0..P4-6 已全部实现并有 2026-08-13 当日证据（`npm run check` exit 0：root 10/289、desktop 29/557、runner 18/309、contracts 13/141、domain 13/59、ui 6/43；`npm run check:fixtures` 13/13 零 violations；`npm run test:e2e` exit 0：production Electron 20/20、browser+smoke 51/51）。`development-plan.md` §8 的正式 Exit Gate 要求：在不调用真实 SolidWorks 的测试 Executor 下，Prompt、事件、Clarification、Manifest 协议可以完整端到端工作。批次执行与独立审查中产生六个需要记录的行为/契约决定：

1. **合成适配器真实性（M1 审查修复）**：所有 synthetic 转换成功一律 `productionVerified: false` + 人工可读 warning；DWG/DXF 是显式 `-test-only` 路径（adapter id 含 `-test-only` 标记）；任何合成结果声明 `productionVerified: true` 都触发 `RunnerInvariantError` 失败关闭（domain 不变量 + 契约校验 + 单测三方锁定）——未验证真实生产图纸前绝不声称转换已生产验证。
2. **不静默选页**：PDF 多页输入没有显式页选择即失败（`PAGE_SELECTION_REQUIRED`）；单页路径在无显式选择时 provenance 不记录任何 page/layout 断言（带 warning）；fake adapter 从不检查源文件，只回显请求显式给出的选择。
3. **raw→product 边界**：raw Agent records（v1 协议）只写 attempt 技术目录，`session_started`/`runtime_log`/`runtime_error` 不派生产品事件；product-event translator 是唯一转换桥，**绝不派生 `Completed`/`Failed`**（终态事件归 orchestrator）；非法版本/未知类型/畸形/越序 → 稳定结构化失败（`AGENT_PROTOCOL_INCOMPATIBLE`），原始推理不暴露给 Renderer。
4. **Clarification 回答写入 Revision Facts**：回答校验后标记 `ANSWERED` 并转换为 Revision Facts（`source: "CLARIFICATION"` + `sourceRunId`）；旧 Run 保持终态 `CLARIFICATION_REQUIRED` 不自动续跑，用户手动创建新 Run；重复提交/幂等不产生重复 facts；clarification/answers/facts 原子提交。
5. **独立 Manifest 校验（Agent 自称完成不具权威性）**：`ArtifactValidator` 独立验证 manifest schema/版本 → 安全 workspace-relative 路径 → 必需 artifact 存在/非零字节/size+SHA-256 匹配/canonical 不逃逸 → `rebuildStatus: "PASSED"` 最低要求；只有独立校验通过才 `completeAttempt`；失败先 `ArtifactValidationFailed` 再以准确 failure code 终止；Phase 4 用 event + workspace manifest 完成 gate，不新增 schema v4 数据表。
6. **per-claim 队列错误边界（M2 审查修复）**：单个 claim 内抛出的 workspace/adapter/prompt/agent IO 异常不得击穿串行队列——PREPARING 内的适配错误已转准确结构化终态失败（`INPUT_ADAPTER_FAILED`/`PREFLIGHT_FAILED`）；其它 claim 错误由 lease 到期恢复如实分类（FAILED/INTERRUPTED，绝不 CANCELLED），队列继续处理下一 Run；RESUMED claim 再失败立即 `RECOVERY_FAILED` 且仅当 attempt 仍 ACTIVE 且归本 orchestrator（并发取消永不产生第二终态事件）。
7. **Prompt Template 版本 2026.08-p4**：`DEFAULT_RUN_PROFILE` 的 `promptTemplateVersion` 从 `2026.08-p3` 更新为 `2026.08-p4` 并在创建 Run 时冻结；模板是产品代码内固定版本化常量（无 UI 编辑入口）。

Decision:

以 `development-plan.md` §8 的正式 Phase 4 Exit Gate 为准。Phase 4 **PASS（2026-08-13）**；Phase 5 为下一阶段、未开始（不启动；外部硬阻塞不变）。上述决定按本条目记录为 Accepted；本阶段不实施或宣称 Phase 5 真实能力。

Reason:

Phase 4 的验收条件（不调用真实 SolidWorks 的测试 Executor 下，Prompt、事件、Clarification、Manifest 协议完整端到端工作）已由 2026-08-13 证据全部覆盖：browser E2E 2/2（显式 fake bridge 黑盒 UI）+ production Electron 2/2 新增（真实 Runner + Fake Adapter/Fake Executor + 临时 runtime root：完整协议链与 Clarification 回答成 Facts、artifact-validation fail-closed）+ runner/contracts/domain 的 P4-0..P4-5 套件。真实性约束（`productionVerified: false`、不静默选页、raw→product 边界）与 Phase 1 签名重分类、Phase 3 测试专用配置的原则一致：不虚报、不伪造证据。

Consequences:

- Phase 4 Exit Gate = **PASS（2026-08-13）**；Phase 5 未开始、不启动。
- **不声称真实能力**：真实 PDF/DWG/DXF 生产转换未验证（全部 synthetic `productionVerified: false`、DWG/DXF `-test-only`，需获批图纸验证）；真实 SolidWorks/Codex 集成未做（Phase 5，外部硬阻塞不变：SolidWorks 2022 不可用、`$solidworks-build-mechanical-models` 未解析、无获批测试图纸、Codex 兼容未 pin）。
- **正式协议文档**：新增 `docs/05-engineering/agent-spec.md`（Prompt、raw records、Clarification、Manifest 与 Input Adapter provenance 的正式协议）；`.zcode/plans/plan-phase4-execution-record.md` 记录批次执行与 Exit Gate。
- **人工安全跟进项（未通过，不虚报）**：真实第二 Windows 账户 pipe 拒绝访问测试未执行（单账户主机）。
- **Phase 8 外部交付待办保持未通过**：Authenticode 签名与 clean-Windows 离线 smoke 均未执行、未通过。
- **canonical package/installer 新鲜度**：现有 canonical 包仍滞后于最新源码（本批次未重跑 `package:win`），其哈希不得当作最新源码证据。
- 同步 `lead-agent-handoff.md`、`implementation-status.md`、`architecture.md` 与本日志；Phase 1-3 历史判定记录不作改写。未 commit/push。

---

## 2026-08-14

### Decision: Phase 5 仓库侧 P5-1..P5-4 契约实现状态（substantially complete / in progress）与 Exit Gate 未 PASS 判定；十项 preflight 恒生效 + synthetic 默认、PENDING_REVIEW 原子发布默认、Codex App Server 0.147.0 / protocol v2 契约钉定、ownership-safe Cancel 与低 Stage 钉定恢复

Status: Accepted

Context:

Phase 5（Agent Runner + SolidWorks Skill Integration，`development-plan.md` §9）的仓库侧契约批次 P5-1..P5-4 已 substantially complete / in progress（2026-08-14），但**正式 Exit Gate 未 PASS**。实现事实：

1. **十项 preflight 能力门恒生效于 PREPARING（P5-1）**：`PREFLIGHT_CAPABILITIES`（`packages/domain/src/runs/preflight.ts`，规范顺序含 `input_adapter_succeeded`）+ `apps/runner/src/preflight/preflight.ts` 确定性探针边界（fail-fast 评估、失败码映射、探针抛错 fail-closed）。**默认产品路径运行显式 synthetic/unverified fixture**（`DEFAULT_PREFLIGHT_SCENARIO = "all-pass"`、`FAKE_PREFLIGHT_SKILL_SHA256`），持久化报告恒 **`synthetic: true`**——绝不假装真实环境探针通过；`input_adapter_succeeded` 仅由 executor 在适配成功后标记。
2. **Model 发布原子且产品默认（P5-2）**：成功路径**单事务原子发布 `PENDING_REVIEW` Model**（Model 行 + artifact 元数据行 + 带 Model id 的 `Completed` 事件 + FINISHED attempt；Runner 产品默认 `publishModel: true`）；manifest 的 `productionVerified` 由契约解析 wire boolean（缺省 `false`）；独立 ArtifactValidator 以 `ARTIFACT_MANIFEST_INVALID` 拒绝 `productionVerified: true`（无产品侧 HIL 验证记录、声明绝不 authoritative）——仅 `false`/缺省可发布，synthetic 结果如实持久化 `productionVerified: false`。
3. **Codex App Server 契约钉定（P5-3）**：严格 NDJSON JSON-RPC client + adapter（`apps/runner/src/agent/codex/`）钉定 **`codex-cli 0.147.0` / protocol v2**（schema 文档 `.scratch/codex-app-server-schema-0.147.0/v2/`）；**live 进程 spawn 与生产 transport 缺失，仅契约测试**。
4. **ownership-safe Cancel 与低 Stage 钉定恢复（P5-4）**：SolidWorks 取消走显式 per-attempt 身份证明的 ownership guard（`apps/runner/src/execution/ownership/solidworks-ownership-guard.ts`：`closeOnlyOwned`、绝不 kill-all、unproven → `CANCEL_CLEANUP_PENDING`）；线程恢复仅 `null`/PREPARING/ANALYZING/PLANNING 可证明续跑（`apps/runner/src/execution/recovery/`，MODELING+ 硬性 no-checkpoint）；**二者仅契约测试，从未 HIL 验证**。
5. **2026-08-14 验证快照（14:12–14:50）**：`npm run check` exit 0（`.scratch/check-p4.log`）；`npm run check:fixtures` 并发首跑因 check build 写 workspace dist 解析 `@swpanel/domain` 失败（build-clean interference）→ 干净顺序重跑 **1/1 通过**（13/13 零 violations，`.scratch/check-fixtures-p4b.log`）；`npm run test:e2e` exit 0 **顺序通过**（production Electron **20/20**、browser+smoke **51/51**，`.scratch/test-e2e-p4.log`）；**model-detail 1366/1920 baseline 于 18:15 有意刷新**（新"合成预览 · 未生产验证"provenance badge，旧截图预期为 stale baseline 而非产品回归）。**时间线如实记录**：P5 源码/测试 16:34–18:16 写入，晚于该快照，P5 套件不在 14:48 计数内；**顺序重跑已全绿**（`check:fixtures` 1/1、`test:e2e` 20/20 + 51/51），单测计数不在此钉定。

Decision:

以 `development-plan.md` §9 的正式 Phase 5 Exit Gate 为准。**Phase 5 Exit Gate = NOT PASS（2026-08-14，不越报）**：仓库侧 P5-1..P5-4 契约实现记录为 substantially complete / in progress；**不声称** live Codex 进程 spawn、生产 transport、HIL 或 Phase 5 PASS。默认产品路径保持确定性 synthetic Fake Preflight / Fake Agent（`codex-app-server` 0.1.0 / protocol v1），报告 `synthetic: true`、Models `productionVerified: false`。上述四项按本条目记录为 Accepted 契约。

Reason:

十项 preflight 门恒生效与 synthetic 默认并行成立：门的**边界与评估顺序是产品契约**（任何 Run 不能带着失败能力离开 PREPARING），而默认产品路径的环境事实（SolidWorks 2025 非 2022、依赖未解析、无获批图纸）使真实探针必须 fail——因此默认 fixture 显式 `synthetic: true`，与 Phase 4 `productionVerified: false`、测试专用配置 unpackaged-only 的原则一致（不虚报、不伪造证据）。`PENDING_REVIEW` 原子发布是 Phase 4 契约"Phase 5 收紧发布路径"的落地（单事务、productionVerified 仅 `false`/缺省可发布——`true` 由独立 ArtifactValidator 以 `ARTIFACT_MANIFEST_INVALID` 拒绝、无部分提交）。Codex 钉定只到契约层：0.147.0 / protocol v2 的 schema 与字段名可被仓库侧严格测试，但 live spawn 需要真实运行时与授权，缺失即如实标注 contract-tested only。ownership/恢复同理：身份证明与 Stage 钉定是可以在无 SolidWorks 时客观实现的契约，真实 HIL（不杀无关 SolidWorks 工作、MODELING+ 无 checkpoint）仍需获批机器验证。2026-08-14 验证快照的异常（build-clean 干扰、stale screenshot）如实记录为验证异常并确认干净顺序重跑通过。

Consequences:

- **Phase 5 Exit Gate = NOT PASS（2026-08-14）**；Phase 6 未开始、不启动；**不 commit/push**。
- **不越报**：无 live Codex 进程 spawn、无生产 transport、无 HIL；单测计数不钉定（顺序重跑已全绿——`check:fixtures` 1/1、`test:e2e` 20/20 + 51/51）；**`productionVerified: true` 无独立证据支持、将 fail-closed（独立 ArtifactValidator 以 `ARTIFACT_MANIFEST_INVALID` 拒绝，仅 `false`/缺省可发布）**。
- **外部硬阻塞不变**：SolidWorks 2022 环境不可用（本机 2025）；`$solidworks-build-mechanical-models` 未解析；无获批图纸真实 E2E；真实 PDF/DWG/DXF 生产转换未验证（全部 synthetic `productionVerified: false`、DWG/DXF `-test-only`）；真实 skill hash 未校验（synthetic 门只接受 `FAKE_PREFLIGHT_SKILL_SHA256`）。
- **契约记录**：P5-1..P5-4 四项 Accepted 决定如上；默认产品路径的 preflight 报告恒 `synthetic: true`，Models 恒 `productionVerified: false`；`publishModel: false` 仅用于 Phase 3/4 model-less 兼容场景。
- **人工安全跟进项（未通过，不虚报）**：真实第二 Windows 账户 pipe 拒绝访问测试未执行（单账户主机）。
- **Phase 8 外部交付待办保持未通过**：Authenticode 签名与 clean-Windows 离线 smoke 均未执行、未通过。
- **canonical package/installer 新鲜度**：现有 canonical 包仍滞后于最新源码（未重跑 `package:win`），其哈希不得当作最新源码证据。
- 同步 `lead-agent-handoff.md`、`implementation-status.md`、`architecture.md`、`agent-spec.md` 与本日志；Phase 1-4 历史判定记录不作改写。未 commit/push。

---

## 2026-08-14

### Decision: Phase 5 进展更新 — SolidWorks 版本硬门移除、preflight 报告 v2 九项、live Codex smoke、真实 preflight/PDF adapter 状态与 SolidWorks 2025 崩溃事实（Exit Gate 保持 NOT PASS）

Status: Accepted

Context:

2026-08-14 当日稍早条目记录的 P5-1..P5-4 状态中"十项 preflight 能力门（含 `solidworks_2022_available` 与 `mechanical_execution_dependency_resolved`）"已被本条目更新（原条目保持历史记录、不作改写）。当日稍晚的进展事实：

1. **SolidWorks 版本硬门移除**：preflight 门改为 **version-agnostic**——只要求任何可驱动的安装（`solidworks_available`），实际安装版本由 probe/builder 记录、绝不发明；`solidworks_2022_available` 硬版本匹配项移除。**preflight 报告契约 v2、九项**（`PREFLIGHT_CAPABILITIES`：agent_runtime_available / agent_runtime_version_supported / agent_model_supports_image / modeling_skill_discovered / modeling_skill_hash_allowed / structured_runtime_protocol_available / workspace_write_scope_supported / solidworks_available / input_adapter_succeeded）。**`mechanical_execution_dependency_resolved` 不再是门项**：`$solidworks-build-mechanical-models` 引用保留为 Skill prose、非阻塞、绝不伪装为已解析（未验证）。v1 报告从旧 attempt 保持历史、不重写。
2. **外部 skill copies 同步**：`C:\Users\Eric Chan\.agents\skills\solidworks-build-part-from-drawing` 与 `C:\Users\Eric Chan\.codex\skills\solidworks-build-part-from-drawing` 规范目录 digest 均为 **`3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`**（仓库 `hashSkillDirectory` 复验，两副本逐字节一致）。
3. **Codex 0.147.0 live smoke 成功**：真实 `initialize` + `skills/list` 对 0.147.0 App Server 运行时成功，发现两个精确外部 skill copies；**shell-free live stdio transport/lifecycle 已实现**（`codex-child-transport.ts`：`app-server --stdio`、`shell: false`、`windowsHide`、`.cmd` shim 拒绝、有界 close、有界 stderr tail、exactly-once 退出传播）。
4. **真实 preflight/PDF adapter 已实现（处于最终验证中）**：`real-preflight-probe.ts` + `skill-directory-hash.ts`（真实 `codex --version` 探针（精确 pin 0.147.0）、真实 skill 目录发现 + 规范目录 SHA-256、真实 workspace 可写探针、注入式 SolidWorks seam、`synthetic: false`）；`real-pdf-input-adapter.ts` + `PythonPdfiumRasterizer`（pypdfium2 4.30.0 + Pillow 11.3.0、`spawnSync` `shell: false`、默认 300 DPI、per-operation temp 目录在仓库外）。**一份获批 PDF 以 300 DPI 真实栅格化为 4963×3509**——源哈希 `e321dc34c80b943b8af9ca9ea4ebbf9f42003627707503bf25512a479cda72a0`、输出哈希 `30614c32a5dba38374642bf76e0e7e763674e15b78455c2cb4ff18d316ae7d96`、`productionVerified: false`、产物留在 temp/仓库外。
5. **SolidWorks availability 门当前 FAILS**：本机安装 **SolidWorks 2025 产品版本 33.0.0.5050**，但 COM 激活与直接启动均在 AMD 驱动 `atio6axx.dll` 31.0.12042.4 以访问违例 `0xc0000005` 崩溃（本地 CXPD dump 证据，如 `C:\Users\Eric Chan\AppData\Local\SolidWorks\CXPD\20260814222204_33.0.0.5050\SLDWORKS.exe.*.dmp`）；**获批图纸 HIL 未启动**。
6. **测试真实性**：最后一次全量 `npm run check`（14:48）早于 P5 批次落地（16:34–18:16）且早于最新并发 preflight/PDF 集成（21:55–22:48 写入）；**全量 check 在集成前通过、最终重跑待办、不声称当前全绿**；此前顺序重跑已全绿（`check:fixtures` 1/1、`test:e2e` 20/20 + 51/51）；单测计数不钉定。

Decision:

以 `development-plan.md` §9 的正式 Phase 5 Exit Gate 为准。**Phase 5 Exit Gate 保持 NOT PASS（2026-08-14，不越报）**：SolidWorks 版本硬门移除（availability/automation 门 + 实际版本记录）、preflight 报告 v2 九项、`$solidworks-build-mechanical-models` 非阻塞 prose、外部 skill copies 同步（digest `3d4bfbc9…`）、Codex 0.147.0 `initialize`+`skills/list` live smoke 成功、shell-free live stdio transport/lifecycle 与真实 preflight/PDF adapter 已实现——上述全部**已实现但处于最终验证中**；**无 HIL（获批图纸 HIL 未启动）**；SolidWorks availability 门当前 FAILS。**不声称** live 全链路验证、HIL 或 Phase 5 PASS；**不 commit/push、不进入 Phase 6**。

Reason:

版本硬门移除与 availability/automation 门并行成立：SolidWorks 门的目标是"是否有可驱动的安装"，版本是记录事实而非硬匹配（任何版本都不被静默冒充 2022 交付物）；机械依赖引用保留为 Skill prose、非阻塞——SWPanel 无法验证其解析就不假装解析（与 `productionVerified: false`、synthetic 原则一致：不虚报、不伪造证据）。live smoke 证明运行时与 skill 发现真实可用，但 live turn 全链路（真实 preflight → live spawn → adapter → 真实 PDF input）仍需最终验证与 HIL；获批 PDF 单份栅格化是真实转换证据（哈希记录、`productionVerified: false`、产物在仓库外），但仍在最终验证中。SolidWorks 2025 33.0.0.5050 的崩溃（AMD `atio6axx.dll` 0xc0000005）是环境事实而非产品缺陷，availability 门如实 FAILS，HIL 无法进行——如实记录，不虚报。

Consequences:

- **Phase 5 Exit Gate = NOT PASS（2026-08-14）**；Phase 6 未开始、不启动；**不 commit/push**。
- **preflight 契约更新**：报告 v2 九项（`solidworks_available` version-agnostic、`mechanical_execution_dependency_resolved` 非阻塞 prose、v1 历史保留）；默认产品路径报告恒 `synthetic: true`、Models 恒 `productionVerified: false`；`productionVerified: true` 无独立证据支持、将 fail-closed。
- **已实现但处于最终验证中**：shell-free live stdio transport/lifecycle、真实 preflight probe（`synthetic: false`）、真实 PDF adapter + pypdfium2 4.30.0 栅格化（300 DPI；获批 PDF 4963×3509，源哈希 `e321dc34…`、输出哈希 `30614c32…`）；外部 skill copies digest `3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`；Codex 0.147.0 `initialize`+`skills/list` live smoke 成功。**全量 check 在最新并发 preflight/PDF 集成前通过、最终重跑待办、不声称当前全绿**。
- **环境事实（如实记录）**：SolidWorks 2025 33.0.0.5050 availability 门当前 FAILS（AMD `atio6axx.dll` 31.0.12042.4 `0xc0000005`、CXPD dump 证据）；获批图纸 HIL 未启动；真实 PDF/DWG/DXF 生产转换未完全验证（DWG/DXF 仍 synthetic `-test-only`）；无获批图纸真实 E2E。
- **人工安全跟进项（未通过，不虚报）**：真实第二 Windows 账户 pipe 拒绝访问测试未执行（单账户主机）。
- **Phase 8 外部交付待办保持未通过**：Authenticode 签名与 clean-Windows 离线 smoke 均未执行、未通过。
- **canonical package/installer 新鲜度**：现有 canonical 包仍滞后于最新源码（未重跑 `package:win`），其哈希不得当作最新源码证据。
- 同步 `lead-agent-handoff.md`（批次 N/第 17 节）、`implementation-status.md`、`architecture.md`、`agent-spec.md`、`docs/decisions/adr-003-drawing-modeling-agent-contract.md`（2026-08-14 Amendment）与本日志；Phase 1-4 及当日稍早条目历史记录不作改写。未 commit/push。

---

## 2026-08-14

### Decision: Phase 5 最终验证与 live 接线收口事实记录 — live Codex SKILL.md 校验、live Runner 接线 owned Codex adapter + 真实 PDF adapter、async ownership-safe SolidWorks live probe、probe 版本 prompt/validator 校验、当前树最终全量重跑全绿（Exit Gate 保持 NOT PASS）

Status: Accepted

Context:

2026-08-14 当日稍早条目（批次 M/N）记录的状态已被本条目更新（原条目保持历史记录、不作改写）。当日最终复核后的进展事实：

1. **live Codex skill 目录→`SKILL.md` 校验通过**：Codex 0.147.0 native `initialize` + `skills/list` smoke 通过——`available:true`、version `0.147.0`、protocol `2`、`skillPathVerified:true`（skills/list 报告的 `<directory>\SKILL.md` 与配置目录做规范 Windows 安全段比较，兄弟目录/`.codex` 副本/嵌套 manifest/异名文件均 fail-closed）；两个精确外部 skill copies（`.agents`/`.codex`，digest `3d4bfbc97093c46292a4c0e4572c6f94685bdbda00b84949dd0b65322a556a22`，逐字节一致）。
2. **live Runner 接线 owned Codex adapter + 真实 PDF adapter**：`apps/desktop/src/main/runner-host/live-codex-wiring.ts`（仅 `main.ts` liveCodex 分支消费）——每 Runner 恰一个持久 Codex child transport + 严格 NDJSON client + async turn adapter + `RealPdfInputAdapter`（bundled pypdfium2，显式 helper 路径解析到 dev dist/打包 asar），`ownsAgent: true` 使 executor 关闭时有界回收 adapter 与 child（绝不孤儿化）；默认 synthetic 路径不动。
3. **async ownership-safe SolidWorks live probe 实现并实测**：`apps/runner/src/preflight/solidworks-live-probe.ts`——READ-ONLY attach 既有 COM 实例（绝不关闭、绝不触碰文档）；仅干净 `ok:true, attached:false` 才进入 owned-spawn 路径（**attach 抛错/超时/`ok:false`/foreign/畸形绝不 spawn**）；spawn 后经有界 PowerShell helper 以精确 pid 证明 COM ownership，只关闭 owned 进程（owned handle kill + await exit）。**本机实测**：`available:false`、`installedVersion` 33.0.0.5050、`ownedProcessSpawned:true`、`ownedProcessClosed:true`（reason `ownership-not-proven`——AMD 启动崩溃使 COM 无法注册，崩溃绝不被报告为可用）、probe 后**无残留 SLDWORKS.exe**。
4. **probe 版本写入 prompt 并在 ArtifactValidator 精确校验**：`prompt-template.ts` 渲染 `expectedSolidWorksVersion` 段（缺省保持 version-agnostic 字节一致）；`artifact-validator.ts` 在 Runner 认定非空期望版本时要求 manifest `solidWorksVersion` 完全相等，否则 fail-closed（validator 权威、Agent 文本不权威）。
5. **当前树最终全量重跑全绿（2026-08-14）**：`npm run check` **exit 0**（root 10 files/291、desktop **31 files/572 tests**、runner **37 files/691 tests**、contracts 13 files/**148 tests**、domain 14 files/**70 tests**、ui 6 files/43；日志 `.scratch/check-p5-final.log`——计数含全部 P5 套件：preflight / preflight-execution / model-publication / agent/codex/* / ownership / recovery / real-preflight-probe / skill-directory-hash / codex-live-probe / solidworks-live-probe / real-pdf-input-adapter / python-pdfium-rasterizer / codex-child-transport / live-codex-config / live-codex-wiring）；`npm run check:fixtures` **1/1**（13/13 零 violations RESULT PASS，`.scratch/check-fixtures-p5-final.log`）；`npm run test:e2e` **exit 0 顺序通过**（production Electron **20/20**、browser+smoke **51/51**，`.scratch/test-e2e-p5-final.log`）。早前"全量 check 在最新并发 preflight/PDF 集成前通过、最终重跑待办、不声称当前全绿"的时间线说明**已被取代**——当前全绿、单测计数已钉定。

Decision:

以 `development-plan.md` §9 的正式 Phase 5 Exit Gate 为准。**Phase 5 Exit Gate 保持 NOT PASS（2026-08-14，不越报）**：仓库侧 P5-1..P5-4 契约实现 + live 接线完成并最终验证（上述 1-5），但**获批图纸建模未启动（无 HIL）**、SolidWorks availability 门当前 FAILS（AMD `atio6axx.dll` 31.0.12042.4 `0xc0000005`、CXPD dump 证据）；默认产品路径 preflight 报告恒 `synthetic: true`、Models 恒 `productionVerified: false`；ownership-safe Cancel 与低 Stage 钉定恢复仅契约测试。**不声称** live 建模全链路、HIL 或 Phase 5 PASS；**不 commit/push、不进入 Phase 6**。

Reason:

live smoke 证明运行时、skill 发现与 `SKILL.md` 路径校验真实可用（仓库侧最终验证全绿），但 live 建模 turn 全链路仍需真实可驱动 SolidWorks 环境与 HIL——availability 门如实 FAILS，HIL 无法进行；SolidWorks live probe 的 `available:false`/33.0.0.5050/owned 进程已关闭/无残留进程/attach 错误不再 spawn 是真实环境事实（AMD `atio6axx.dll` 0xc0000005 崩溃使 COM 无法注册），与"崩溃绝不被报告为可用"的 fail-closed 原则一致；probe 版本写入 prompt 并在 validator 精确校验保证版本声明绝不发明（与 `productionVerified: false`、synthetic 原则一致：不虚报、不伪造证据）。

Consequences:

- **Phase 5 Exit Gate = NOT PASS（2026-08-14）**；Phase 6 未开始、不启动；**不 commit/push**。
- **最终验证事实**：live Codex skill 目录→`SKILL.md` 校验通过；live Runner 接线 owned Codex adapter + 真实 PDF adapter；async ownership-safe SolidWorks live probe 实测（`available:false`/33.0.0.5050/owned 已关闭/无残留/attach 错误不再 spawn）；probe 版本写入 prompt + ArtifactValidator 精确校验；当前树最终全量重跑全绿（desktop 31/572、runner 37/691、contracts 13/148、domain 14/70、ui 6/43；fixtures 1/1；e2e 20/20 + 51/51），"最终重跑待办"语言已移除、计数已钉定。
- **环境事实（如实记录）**：SolidWorks 2025 33.0.0.5050 availability 门当前 FAILS（AMD `atio6axx.dll` 31.0.12042.4 `0xc0000005`、CXPD dump 证据）；获批图纸建模未启动（无 HIL）；真实 PDF/DWG/DXF 生产转换未完全验证（DWG/DXF 仍 synthetic `-test-only`；真实 PDF 单份栅格化已最终验证但 `productionVerified: false`）；无获批图纸真实 E2E；`$solidworks-build-mechanical-models` 非阻塞 prose 未验证。
- **人工安全跟进项（未通过，不虚报）**：真实第二 Windows 账户 pipe 拒绝访问测试未执行（单账户主机）。
- **Phase 8 外部交付待办保持未通过**：Authenticode 签名与 clean-Windows 离线 smoke 均未执行、未通过。
- **canonical package/installer 新鲜度**：现有 canonical 包仍滞后于最新源码（未重跑 `package:win`），其哈希不得当作最新源码证据。
- 同步 `lead-agent-handoff.md`（批次 O/第 9 节 P5 行/第 17 节/验证快照 A7-B7-C7-D7-E7/Change Log）、`implementation-status.md`、`architecture.md`、`agent-spec.md`、`docs/decisions/adr-003-drawing-modeling-agent-contract.md`（2026-08-14 Amendment 更新）与本日志；Phase 1-4 及当日稍早条目历史记录不作改写。未 commit/push。

---

## 2026-08-15

### Decision: Phase 5 真实 Runner HIL 尝试、Codex 协议与失败诊断修复、SolidWorks 精确早退证据（Exit Gate 保持 NOT PASS）

Status: Accepted

Context:

2026-08-14 的条目是当时状态的历史记录，不作改写。本日获得的新事实如下：

1. **第一次获批链路尝试**（`.scratch/hil-20260815-142334-52f26231`）创建了真实 Runner Run；九项 `synthetic:false` preflight 与真实 PDF adapter 均通过，SolidWorks probe 为 `available:true`、live version `33.0.0`、`owned-process-proven`。Run 随后以 `AGENT_PROTOCOL_INCOMPATIBLE` 失败：Codex 0.147.0 在客户端声明 `experimentalApi:false` 时拒绝实验字段 `thread/start.runtimeWorkspaceRoots`。
2. **第二次获批链路尝试**（`.scratch/hil-20260815-144823-3836c9fc`）再次通过九项 preflight、真实 PDF adapter 与 SolidWorks ownership probe，真实 `thread/start`、`turn/start` 和 failed Turn 均已发生，Run 以 `AGENT_RUNTIME_UNAVAILABLE` 结束；未启动 CAD、未产生 `.SLDPRT` 或六类必需产物。Adapter 当时丢弃了 native `turn.error.message`，因此真正的 Skill/image Turn 原因未被保留。
3. **第三次获批尝试**（`.scratch/hil-20260815-214252-393c22d8`）在 `Runner.open`、Drawing 导入和 Run 创建之前停止：Codex 0.147.0、exact Skill path/digest 均通过，但 SolidWorks probe fail-closed。这是 harness/preflight stop，不是 Run 终态失败。
4. **宿主 SolidWorks 状态在本日发生变化**。前两次 probe 均成功；第三次时 owned `SLDWORKS.exe` 在 COM 注册前退出。`21-solidworks-startup-diagnostic.json` 记录默认启动、Rx Software OpenGL（`/ForceSoftwareOGL /SWDisableExitApp`）与 Rx Tools/Options bypass（`/SWSafeMode /SWDisableExitApp`）均在约 3–4 秒后以 unsigned `3221225477`（`0xC0000005`）退出。AMD Radeon driver `31.0.12042.4` 仅作为主机上下文与历史假设，不再被断言为已证明的唯一原因；两个会话级 Rx safe mode 同样失败，说明 hardware OpenGL 和普通 Tools/Options state 均未被隔离为唯一原因。

Decision:

1. **Codex stable protocol only**：不再发送 gated `runtimeWorkspaceRoots`。`thread/start` / `thread/resume` 只发送 `cwd` + `sandbox:"workspace-write"`；写边界继续由 attempt-root `turn/start.sandboxPolicy.writableRoots` 约束。Live preflight 增加 harmless real `thread/start` compatibility check，避免同类不匹配再次越过 preflight。
2. **Failed Turn 诊断只进入有界技术记录**：仅将 `turn.error.message` 经确定性 sanitizer 后写入 `runtime/agent-session.json` note。URLs、absolute paths（含空格）、credential/env-secret assignments 与 JWT-like tokens 被遮蔽；control/whitespace 规范化；最大 512 字符。产品错误保持通用 `AGENT_RUNTIME_UNAVAILABLE`，failed path 不写 raw agent log。Harness 1.0.2 仅可输出严格 allowlist 的 `14-agent-session-diagnostic.json`，不得复制完整 session、thread/turn/attempt ids、timestamps 或 raw log。`skill.resolvedPath` 必须为 absolute path。
3. **SolidWorks COM attach/poll 使用 Python/pywin32；PowerShell 只做 discovery**：PowerShell `GetActiveObject` 曾在 pywin32 可成功的同一主机返回 `TYPE_E_ELEMENTNOTFOUND`。既有 instance 只读；owned startup 仍由 Node 精确 child handle/PID 唯一创建，COM `GetProcessID()` 必须精确相等；helper 只允许 `GetActiveObject`，禁止 `Dispatch`/`CreateObject`；禁止 kill-all、process-name cleanup、`ExitApp`/`Quit`。
4. **Owned-process early exit 成为独立 fail-closed 原因**：probe 并发观察精确 owned child；若其先于 COM ownership proof 退出，则 abort/await 仅本次 helper child，返回 `owned-process-exited`、规范化 `ownedProcessExitCode`、installed version 与真实 spawned/closed facts。窄 live probe 证据 `.scratch/hil-20260815-214252-393c22d8/22-solidworks-probe-after-early-exit-fix.json` 在 7044 ms 返回 `available:false`、installed `33.0.0.5050`、spawned/closed true、exit `3221225477`，且无残留 `SLDWORKS.exe` 或 Codex process；该 probe 未运行 Codex、PDF、Drawing、Run 或建模。
5. **Phase 5 Gate 不因技术进展自动通过**：两次真实 Runner turn 均 truthfully FAILED，第三次在 Runner 前停止；不把这些证据伪装成成功 HIL。只有成功 `.SLDPRT` + 六 artifacts + 原子 `Model(PENDING_REVIEW)`、真实 Clarification scenario 与 ownership-safe cancellation HIL 齐备，才能重新评估 Exit Gate。

Reason:

真实 HIL 的目的不是得到一个看似成功的结果，而是暴露真实协议、诊断和宿主边界。第一次尝试证明实验字段与 stable capability 声明不兼容；第二次证明真实 Turn 已运行但 failure detail 被技术层丢失；第三次与精确子进程诊断证明当前宿主 SolidWorks 无法到达 COM-ready state。每项修复都保持 fail-closed、最小持久化和精确进程 ownership，不通过重试隐藏失败，不把 raw Agent 内容或业务 artifacts 写入证据/版本库。

Consequences:

- **Phase 5 Exit Gate = NOT PASS（2026-08-15）**；Phase 6 未开始、不启动。
- 当前宿主 SolidWorks 2025 已安装且 COM-registered，但暂时不可驱动；三种本次会话启动方式均 `0xC0000005`。任何 driver、registry、repair-install 或其他系统变更均需单独授权，本条目不执行这些操作。
- `productionVerified` 保持 `false`；真实 PDF/DWG/DXF 未获得完整生产验证，不声明成功 CAD 能力。
- 最新聚焦验证：SolidWorks probe tests 41/41；Runner 38 files / 738 tests；Runner typecheck、repository lint、Runner build 均通过。2026-08-14 的 full `npm run check`、fixtures 和 E2E 结果仅是历史证据，最新代码后未重跑，不声称当前整个仓库已由新的 full check/E2E 验证。
- 尚缺：成功建模与六 artifacts、`Model(PENDING_REVIEW)`、真实 Clarification、ownership-safe cancellation HIL，以及最终 full repository check/fixtures/E2E。
- 无 commit/push；当前 working tree 仍不能由 Git revision 重现。

---

## 2026-08-15

### Decision: 当前工作树全新全量验证通过 — 取代"修复后仅聚焦验证、全量未重跑"的验证范围陈述（HIL 事实与 Exit Gate NOT PASS 结论不变）

Status: Accepted

Context:

上方 2026-08-15 条目是当时状态的历史记录，不作改写。本日对当前工作树执行了全新全量验证并全部通过：

1. **`npm run check` exit 0**：typecheck、仓库 lint、全部测试与完整 build 全绿——root 10 files / 291 tests、`@swpanel/desktop` 31 files / 572 tests、`@swpanel/runner` 38 files / 738 tests、`@swpanel/contracts` 13 files / 148 tests、`@swpanel/domain` 14 files / 70 tests、`@swpanel/ui` 6 files / 43 tests。
2. **`npm run check:fixtures` 1/1 通过**：13/13 canonical scenarios 全部 OK、0 violations、RESULT PASS。
3. **`npm run test:e2e` 顺序通过（exit 0）**：production Electron **20/20**、browser + Electron smoke **51/51**。
4. canonical package/installer **未刷新**（未重跑 `package:win`/`make:win`），旧包哈希不得当作最新源码证据。

Decision:

记录当前工作树（2026-08-15）全新全量验证通过。**本条目仅取代上方 2026-08-15 条目（以及批次 P、验证快照）中"修复后仅聚焦验证重跑、2026-08-14 全仓库 check/fixtures/E2E 未在最新改动后重跑、不得称整个当前仓库经全新全量 check/E2E 完全验证"的验证范围陈述**；**不取代**更早的 HIL 事实、SolidWorks 主机事实与 Phase 5 Exit Gate NOT PASS 结论。

Reason:

验证事实随当前工作树更新：全部代码修复后，全仓库 `npm run check`/`check:fixtures`/`test:e2e` 已在当前树上全新重跑并通过（单元测试计数以本条目为准：runner 38 files / 738 tests），"聚焦验证 + 历史全量"的验证范围措辞不再适用。验证范围变化不改变任何 HIL 与 Exit Gate 事实，按追加式原则记录。

Consequences:

- **HIL 事实不变（2026-08-15）**：三次获批链尝试均未完成——第一次与第二次为真实 Runner Run，分别如实 FAILED `AGENT_PROTOCOL_INCOMPATIBLE` 与 `AGENT_RUNTIME_UNAVAILABLE`；第三次在 `Runner.open`/Run 创建前停止。**无获批图纸真实 E2E/HIL 已完成**；无成功 CAD、`.SLDPRT`、六 Artifact 集或原子 `Model(PENDING_REVIEW)`。
- **SolidWorks 主机事实不变（2026-08-15）**：主机状态动态（前两次 probe 成功）；当前 default 与两个 Rx session-safe 模式（`/ForceSoftwareOGL /SWDisableExitApp`、`/SWSafeMode /SWDisableExitApp`）的 owned 启动均在 ~3–4 s 以 `0xC0000005` 于 COM 注册前退出；当前崩溃**不结论性归因**于 AMD/`atio6axx`——AMD Radeon driver 31.0.12042.4 与 2026-08-14 CXPD dump 证据仅为主机上下文/历史假设；SolidWorks 2025 33.0.0.5050 已安装且 COM 已注册但当前不可驱动，availability 门当前 FAILS。
- **Phase 5 Exit Gate 保持 NOT PASS（2026-08-15）**：仍缺成功 `.SLDPRT` + 六 Artifact + `Model(PENDING_REVIEW)`、真实 Clarification 场景与 ownership-safe 取消 HIL；低 Stage 钉定恢复保持待 HIL 验证（当前仅契约测试）；`productionVerified` 恒 `false`；Phase 6 未开始、不启动；未 commit/push——当前 Git revision 无法复现未提交的工作树。
- 同步 `implementation-status.md`、`lead-agent-handoff.md`（批次 Q、第 13 节 A9）、`architecture.md`、`agent-spec.md`、`docs/decisions/adr-003-drawing-modeling-agent-contract.md`（2026-08-15 验证更新）与本日志；上方 2026-08-14/2026-08-15 历史条目不作改写。未 commit/push。

---

## 2026-08-16

### Decision: Agent 终态采用 canonical union + provider wire bridge；Turn 等待固定 15 分钟；Phase 5 在真实失败与环境阻塞下保持 NOT PASS

Status: Accepted

Context:

1. 产品需要真实 Agent 同时支持完成与结构化澄清，但 Codex 0.147.0 原生拒绝了 canonical 顶层 `oneOf` output schema。最小 native probe 证明完全展开、closed-object、required+nullable-sentinel 的 provider schema 可被接受并可严格投影回 canonical `completed | clarification_required`。
2. 获批 PDF 真实链在旧 600 秒 turn wait 上限处结束 `FAILED / AGENT_TIMEOUT`。该 Run 的真实 preflight、Runner 和 PDF adaptation 通过，但没有 CAD ownership registry、`.SLDPRT`、Manifest、Clarification、Artifact 或 Model。
3. 重建后的下一次尝试在 `Runner.open` 前被 SolidWorks probe fail-closed：精确 harness-owned process 以 `0xC0000005` 早退。按批准的停止条件，没有修改驱动、注册表、SolidWorks 安装或其他系统配置，也没有在无法证明 CAD ownership 时继续 cancellation HIL。
4. 独立代码审查无高/中严重度问题；低风险 follow-up 要求统一 timeout 默认、当前/foreign turn 分类、非 timeout generic note、timeout 后连接复用，以及同步 write failure 的 late-response 行为。全部已实现并回归验证。

Decision:

1. canonical Agent Turn Output v1 继续使用严格互斥 `oneOf` 作为产品权威；Codex provider 只接收兼容 wire schema，Runner 必须严格投影并再次 canonical validate。Provider probe 只证明 schema acceptance，不得作为真实工程 Clarification HIL。
2. 整个 turn 只接受一个有效 terminal document；有界收集、string-aware balanced scanning 与内容无关 diagnostic 是固定安全边界。零个、多个或畸形终态全部 fail-closed。
3. Codex client 与 adapter 共用固定 900,000 ms（15 分钟）turn-wait 上限。真实 TIMEOUT 只记录当前 turn 是否观察到 Agent-message item；foreign-turn item 不计；child exit 等非 timeout failure 始终保持通用 note。同步 write failure 与 timeout 的迟到 response 被有界记忆并忽略，不能把健康共享连接误判为协议失败。
4. Phase 5 Exit Gate 继续 **NOT PASS**。成功 CAD + 六 Artifact + 原子 `Model(PENDING_REVIEW)`、真实工程 Clarification、ownership-safe cancellation 三类 HIL 缺一不可。`productionVerified` 保持 `false`；不进入 Phase 6；不 commit/push。

Reason:

Provider schema 兼容、真实技术失败和仓库测试只能证明协议与 fail-closed 行为，不能替代业务图纸上的成功建模、真实工程阻塞澄清或精确 ownership cleanup。固定 15 分钟在 20 分钟 harness 总预算内保持有界，同时为真实 CAD turn 提供比旧 600 秒更合理的运行窗口；内容无关分类避免把 Agent 输出或业务路径带入技术证据。

Consequences:

- 最终工作树验证通过：`npm run check` exit 0——root 10/291、desktop 31/576、runner 42/855、contracts 14/162、domain 14/70、UI 6/43，共 **117 test files / 1,997 tests**；typecheck、lint、完整 build 全绿。Fixtures 1/1、13/13 scenarios、0 violations；production Electron 20/20；browser + Electron smoke 51/51。
- 真实证据：provider schema rejection `.scratch/hil-20260816-125909-c6eccb74`；旧 600 秒获批链 timeout `.scratch/hil-20260816-140950-b6482492`；SolidWorks `0xC0000005` pre-Runner stop `.scratch/hil-20260816-143105-4e1a0596`。它们均不是成功 Phase 5 HIL。
- 当前主机 SolidWorks 未恢复可驱动前，不继续真实 CAD/Clarification/Cancel HIL。任何系统级修复必须获得单独授权。
- HIL 证据继续禁止复制 source PDF、`.SLDPRT`、preview/business artifact bytes、raw Agent logs、完整 session 或 secrets。未 commit/push，当前 Git revision 不能复现未提交工作树。

---

## 2026-08-17

### Decision: 修复外部 Skill 依赖与后台审批策略；引入超时中断安全回收、重复终态去重与内容无关活动诊断；Phase 5 Exit Gate 保持 NOT PASS

Status: Accepted

Context:

1. 本机 SolidWorks 2025（33.0.0.5050）经用户排查已恢复正常，`probeSolidWorksRuntime()` 实测通过（`available: true`, `version: "33.0.0"`, owned process 成功证明与回收）。
2. 在获批 PDF 图纸驱动的真实 Codex 0.147.0 闭环测试中，定位并消除了 4 个阻碍长回合正常推进的技术断点：
   - 外部 Skill `solidworks-build-part-from-drawing` 的 `$solidworks-build-mechanical-models` 幽灵引用导致 Agent 分析停滞，已同步改为已安装的 `$solidworks-automation`，两副本重新计算 digest 为 `26f77b00cd4b9e0e253951d876e75ec04c29b49f890d9458f4242e87657b5dcd`；
   - `thread/start` 与 `thread/resume` 显式固定 `approvalPolicy: "never"`，避免后台无应答权限等待；
   - 针对模型回显重复 JSON 现象，`extractAgentTurnOutput` 增加了对 canonical 深度等价重复文档的折叠支持，冲突文档继续 fail-closed；
   - `waitForTurnCompleted` 超时增加了有界的 `turn/interrupt` 确认与 client 毒化隔离，防止超时后 Agent 继续向工作区写文件；
   - 增加内容无关的活动类别统计诊断（`agent-message`, `command-execution`, `file-change`, `tool-or-other`, `approval-request`）。

Decision:

1. 保持严格安全边界：不泄露任何原始 Agent 消息、路径或 JSON；`approvalPolicy: "never"` 与 `workspace-write` 沙箱作为无人值守 Runner 默认；任何未证明的所有权在取消时必须保留 `CANCEL_CLEANUP_PENDING`。
2. 确定性测试 harness（`hil-deterministic.mjs`）覆盖全部 6 种异常/恢复场景并作为基准门禁。
3. Phase 5 Exit Gate 继续保持 **NOT PASS**。当前实证已证明 preflight、PDF 适配、Ledger、Plan、Builder 及 Ownership Registry 的生成，但完整三维模型（`.SLDPRT` + 6 Artifacts + Published Model）尚未在时限内取得最终通过；`productionVerified` 恒保持 `false`。不进入 Phase 6，未 commit/push。

Consequences:

- 确定性 Harness 验证：`node .scratch/hil-deterministic.mjs` 6/6 全绿。
- 全量门禁验证：`npm run check` exit 0（root 10/291、desktop 31/576、runner 42/875、contracts 14/162、domain 14/70、ui 6/43，共 **117 files / 2,017 tests**）；`check:fixtures` 1/1 通过（13/13 场景，0 违规）；`test:e2e` 顺序通过（生产 Electron 20/20，浏览器 + smoke 51/51）。
- 下一步工作重点：在长超时预算下完成获批 PDF 的真实 `.SLDPRT` 产出及 Model 发布，取得真实工程 Clarification 和 ownership-safe Cancel 现场证据。

### Decision: 全面整合并采用统一技能 `solidworks-autobuild` 作为标准建模技能

Status: Accepted

Context:

1. 原架构将看图建模（`solidworks-build-part-from-drawing`）与通用 CAD 执行机制（`solidworks-automation` 及其 subskills）作为两个独立外部技能维护，在大模型调用中容易产生跨技能寻路开销或失效引用。
2. 将两者整合为自包含、分层渐进式披露的单一技能 `solidworks-autobuild`，放置于项目 `skills/solidworks-autobuild/`，整合 Phase A~D 看图推理、底层 COM 驱动与螺纹孔、CNC 倒角、VibeCAD、AutoCAD 等专家子技能。

Decision:

1. 项目生产默认与契约（ADR-003、Agent Spec、Architecture、Runner Profile、Live Codex Config、Phase Zero Baseline）统一绑定为 `solidworks-autobuild`。
2. 内部子技能采用文件级渐进式披露（Progressive Disclosure），消除模型全局工具探索开销。


## 2026-08-18

### Decision: Phase 6 — Model Review 闭环正式 Exit Gate 判定 PASS（2026-08-18 记录）

Status: Accepted

Context:

- 本会话承接交接文档时，Phase 6（Model Review 闭环）已在 2026-08-18 依 `development-plan.md` §10 判定 PASS（Approved/Rejected 双路径与 `currentApprovedModelId` 原子切换，单测、Fake Bridge E2E 与真实 Electron + Runner E2E 全覆盖）；本日志当时未补记。

Decision:

1. 记录 Phase 6 Exit Gate = PASS（2026-08-18），依据 `lead-agent-handoff.md` 第 20 节与 `implementation-status.md`。
2. 不越 Gate 进入 Phase 7 之前需先正式完成 Phase 7 验收。

### Decision: Phase 7 — Cost Data 与 Deterministic Cost Engine 实施与正式 Exit Gate 判定 PASS（2026-08-18）

Status: Accepted

Context:

1. 依 `development-plan.md` §11 实施 Phase 7：企业成本数据维护、参数确认、纯确定性计算与不可变成本测算报告。
2. 核心原则沿用交接规则：**LLM 不算最终成本**（所有最终数值由 `@swpanel/domain` 纯函数确定性计算并经单测验证）；报告创建时**冻结**输入参数与有效成本数据快照，后续全局改价绝不改写历史报告；未知语义（`DISPLAY_ONLY`）自定义字段仅存储展示、绝不进入公式；只有当前图纸版本的当前 Approved Model 具生成资格；只使用**合成**成本基准（42CrMo/45#钢/40Cr、默认余量、基础加工/检测/包装固定成本），绝不把真实企业价格或成本写入仓库。

Decision:

1. 采纳确定性计算引擎架构：`packages/domain/src/cost/calculator.ts` 纯函数 `calculateCostEstimate` + `roundCny`（CNY half-up 两位）；Runner `CostWorkflowService.createCostReport` 为**唯一权威**计算方，Renderer 绝不提交计算结果。
2. 采纳不可变快照持久化：`cost_reports.snapshot_json` 冻结 `input` + 有效 `costData` + 确定性 `result`；标签 `Q01/Q02/…` 按版本顺序分配。
3. 采纳 `SCHEMA_VERSION = 7` migration（`idx_cost_reports_revision_id`、`idx_cost_reports_model_id`）与首读播种合成默认成本基准。
4. 采纳 `window.swpanel.cost` bridge 面（`getEffectiveCostData`/`updateCostData`/`getReportDetail`/`createReport`）与 Renderer `features/cost-repository/` 异步适配器；`CostDataPage`/`CostParamsPage`/`CostReportPage`/`DrawingCostsPage` 四页解锁。
5. **Phase 7 Exit Gate = PASS（2026-08-18 正式判定）**：同一不可变快照恒产同一确定性结果，且该确定性由单元测试覆盖（28 项 calculator 单测 + 全链 2,115 项）。
6. 如实记录已知限制：UI 的 `finishedVolume` 现阶段取自规范常量而非持久化模型几何（确定性不受影响，列为 Phase 8 精度项）；利润/税/运费/售价与商务报价词条按设计不在范围内。

Consequences:

- **门禁证据（2026-08-18）**：`npm run check` exit 0——typecheck、仓库 lint **0 错误**、全部单测与完整 build（root 10/291、desktop 33/593、runner 44/888、contracts 14/200、domain 15/100、ui 6/43，共 **2,115** 项）；`npm run check:fixtures` 1/1（13/13 场景含 `cost-report-generated`，0 违规）；`npm run test:e2e` 顺序通过——production Electron **20/20**、browser + Electron smoke **56/56**（`e2e/phase7.browser.spec.ts` 3/3）。
- 成本页截图基线更新：`cost-data`/`cost-params`/`cost-report` 三张 1920×1080 按新页面重新生成（其余 16 张未变）。
- 同步 `implementation-status.md`、`lead-agent-handoff.md`（第 21 节 + Change Log）、`architecture.md`（§15 Cost Calculator 已实施）。**未 commit/push。**

