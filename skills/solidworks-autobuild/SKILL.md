---
name: solidworks-autobuild
description: SolidWorks 智能自动化建模综合技能。支持从 JPG/PNG/PDF 机械工程图通过尺寸账本与特征规划高精度还原可编辑 .SLDPRT 零件；支持自然语言参数化设计（VibeCAD）、CNC机加工件多圆角倒角、标准螺纹孔/攻牙、装配体机械配合、运动算例及工程图出图导出。禁止估算像素，严格基于工程事实建模。
---

# SolidWorks 智能自动化建模 (solidworks-autobuild)

统一 SolidWorks CAD 建模与自动化中枢。针对不同输入形式（图纸/参数需求/二次开发）进行确定性分流，遵循“图纸推理在先、尺寸账本冻结、一次性构建、独立自检”的标准闭环。

---

## 快速导航与任务分流 (Mode Routing)

根据用户输入形式与目标，直接选用对应工作流：

| 任务类型 | 输入形式 | 核心执行路径 | 关键参考 / 子技能 |
|---|---|---|---|
| **工程图看图建模** | 2D 图纸 (PDF/JPG/PNG) | 遵循下方 **【看图建模四阶段闭环 (Phase A~D)】** | `references/drawing-interpretation.md`<br>`references/feature-planning.md`<br>`references/validation.md` |
| **螺纹孔 / 攻牙孔** | 标准孔规格 (M3~M16) | 读取专用模板与参数规范 | `subskills/solidworks-threaded-holes/SKILL.md`<br>`scripts/sw_hole_features.py` |
| **CNC 多圆角 / 倒角件** | 阶梯轴、支架、机加工件 | 遵循轮廓先行与孔口倒角顺序 | `subskills/solidworks-fillet-chamfer-cnc/SKILL.md` |
| **自然语言参数化设计** | 自然语言简述 / Brief | 生成参数化设计方案 (VibeCAD) | `subskills/solidworks-vibecad/SKILL.md` |
| **AutoCAD 绘图 / 改图** | DWG / DXF / 线稿 | AutoCAD 二维出图与矢量化改图 | `subskills/autocad-automation/SKILL.md` |
| **装配体配合 / 运动算例** | 多零件装配、铰链、齿轮 | 真实机械配合与 Motion Study | `references/assembly.md`<br>`references/motion-study.md`<br>`scripts/sw_assembly.py` |
| **无 CAD 开放格式导出** | STEP / IGES / BREP / STL | 无头无 CAD 几何写入服务 | `scripts/headless_cad_writer.py` |

---

## 核心工作流：看图建模四阶段闭环 (From Drawing to Part)

### 权威制图底线
1. 每一处模型尺寸必须来自图纸标注、注释、表格或可证明的算术推导，**绝对严禁根据像素缩放或目测估算**。
2. 遇到标注缺失、冲突或无法确定的关键工程事实，**必须在启动 SolidWorks 之前发起结构化澄清**，不得随意假定。
3. 保持原图不可变，所有中间裁图与建模脚本均保存在独立的工作目录中。

---

### Phase A: 纯图纸推理与尺寸冻结 (无需启动 SolidWorks)

1. **高分辨率审图**：
   - 裁切并检查视图、剖视图、局部放大图、基准面、形位公差及技术要求。
   - 详读 `references/drawing-interpretation.md`。
2. **构建尺寸账本 (Dimension Ledger)**：
   - 在进入 CAD 前建立完整的尺寸台账，保存为 `dimension-ledger.json`：
     ```json
     [
       {
         "id": "D1",
         "feature": "Base Cylinder Diameter",
         "value": 480.0,
         "unit": "mm",
         "tolerance": "+0.05/-0.05",
         "location": "Main Section A-A",
         "authority": "explicit_dimension",
         "status": "verified"
       }
     ]
     ```
3. **特征规划 (Feature Planning)**：
   - 确定建模原点、基准面分配、旋转/拉伸主轴、特征生成次序与预计体数量。
   - 详读 `references/feature-planning.md`，保存 `feature-plan.json`。

---

### Phase B: 确定执行环境与可见性

1. **可见性声明**：
   - 无人值守/批处理任务默认使用后台无头模式 (`background`)；用户明确要求演示建模时选择可见 (`visible live`)。
2. **所有权登记 (Ownership Registration)**：
   - 在启动 SolidWorks 建立零件之前，在运行目录下写入 `runtime/solidworks-ownership.json`，登记本 Run 计划创建的单个 `.SLDPRT` 相对路径。
   - 严禁枚举系统进程或执行全局 Kill 操作。

---

### Phase C: 确定性一次建模 (Build Once)

直接调用或复用 `scripts/` 与 `subskills/` 下已经验证的 Python / COM 脚本库：

1. **环境与连接管理**：
   - 优先使用 `scripts/sw_session.py` 或 `from scripts.sw_connect import connect_solidworks, mm, deg`。
   - 遇到 SolidWorks 状态未知时，运行自检探针 `python scripts/sw_preflight.py`。
2. **草图与主体特征**：
   - 回转体零件优先使用旋转凸台 (`extrude_revolve`)；棱柱零件使用拉伸凸台 (`extrude_boss`)。
   - 推荐使用 `with sketch(model, "Front Plane"):` 上下文管理器进行草图绘制，确保命名与实体选择稳定（参见 `scripts/sw_part.py`）。
3. **专家特征调用**：
   - **螺纹孔/攻牙**：直接参考 `subskills/solidworks-threaded-holes/scripts/create_threaded_hole_template.py` 提供的底孔+倒角+螺纹修饰模式。
   - **圆角倒角**：遵循“主体轮廓 → 外圆角/倒角 → 孔槽切除 → 孔口倒角”的稳健顺序（参见 `subskills/solidworks-fillet-chamfer-cnc/`）。
   - **沉孔/盲孔/键槽**：调用 `scripts/sw_hole_features.py`。
4. **模型保存**：
   - 建模完成后执行 `model.ForceRebuild3(False)` 并保存为预定 `.SLDPRT`。

---

### Phase D: 独立自检与验收 (Validation & Review)

详读 `references/validation.md`，执行独立闭环复核：

1. **几何与特征树检查**：
   - 验证无失败特征（Failed）、无悬空尺寸（Dangling）、无未解草图；
   - 确认单一实体（Solid Body），测量外形包络尺寸与理论账本一致。
2. **多视图自审查输出**：
   - 调用 `scripts/sw_review.py` 中的 `run_review()` 导出等轴测 (isometric)、主视 (front)、俯视 (top)、左/右视 (right) 预览图及 `*_review_report.json`。
3. **生成交付 Manifest**：
   - 确认输出 `.SLDPRT`、Preview PNG、Dimension Ledger、Feature Plan、Validation Log 全部就绪。
   - 在 Result Manifest 中如实记录实际 SolidWorks 版本与 `productionVerified` 状态。

---

## 常用脚本与库速查

| 模块 | 核心函数 / 脚本 | 用途说明 |
|---|---|---|
| `scripts/sw_connect.py` | `connect_solidworks()`, `mm()`, `deg()` | 连接 SolidWorks 实例，单位米/毫米转换 |
| `scripts/sw_preflight.py` | CLI 运行入口 | 快速诊断本机 COM 与 SolidWorks 运行环境 |
| `scripts/sw_part.py` | `sketch()`, `extrude_boss()`, `extrude_cut()` | 草图绘制、实体拉伸与旋转特征 |
| `scripts/sw_hole_features.py` | `create_counterbore_hole()`, `create_slot()` | 沉孔、半圆槽与复杂机械孔加工 |
| `scripts/sw_assembly.py` | `add_component()`, `add_concentric_mate_by_cylinders()` | 装配体装配、同心与机械配合 |
| `scripts/sw_review.py` | `run_review()`, `save_preview()` | 生成多角度预览截图与几何测量审查报告 |
| `scripts/sw_export.py` | `export_step()`, `export_dxf_flat()` | 导出工业标准格式与工程图转换 |

---

## 依赖要求与注意事项

- **操作系统**：Windows 10/11 x64。
- **CAD 环境**：SolidWorks 2021 ~ 2026（COM 注册正常）。
- **Python 依赖**：`pip install -r requirements.txt`（包含 `pywin32`, `comtypes`, `pydantic` 等核心依赖）。
- **单位系统**：SolidWorks COM API 内部恒为**米 (meters)**与**弧度 (radians)**，必须始终通过 `mm()` / `deg()` 进行转换。
