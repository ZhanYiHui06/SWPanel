# SolidWorks 智能自动化建模技能 (solidworks-autobuild)

本技能是自包含的 SolidWorks CAD 自动化与智能建模解决方案。它将工程图纸视觉解析、机械尺寸账本推理与底层 SolidWorks COM / 开放格式无头建模完整结合。整个目录可整体复制到任意遵循 Anthropic skill 格式的 harness 技能目录中使用，无外部项目依赖。

---

## 核心特性

1. **2D 图纸到 3D 原生模型闭环**：
   - 严格基于尺寸账本（Dimension Ledger）与特征规划（Feature Plan），严禁像素估算；
   - 自动生成符合 SolidWorks 规范的原生可编辑 `.SLDPRT`。
2. **渐进式专家子技能库**：
   - **螺纹孔与攻牙（`subskills/solidworks-threaded-holes`）**：标准螺纹底孔、孔口倒角与修饰螺纹；
   - **CNC 机加工多圆角倒角（`subskills/solidworks-fillet-chamfer-cnc`）**：阶梯轴与复杂机加工外形；
   - **参数化设计与需求规划（`subskills/solidworks-vibecad`）**：自然语言转参数化 CAD 方案；
   - **AutoCAD 绘图与改图（`subskills/autocad-automation`）**：DWG/DXF 矢量化处理。
3. **独立自检与验证**：
   - 自动回读模型特征树、包络尺寸并输出多角度自检报告与预览图。

---

## 快速自检

在技能根目录（含 `SKILL.md` 的目录）下，于 Windows 终端中运行：

```bash
python scripts/sw_preflight.py
```

---

## 目录结构

```text
skills/solidworks-autobuild/
├── SKILL.md                 # 统一总控入口（Agent 读取）
├── README.md                # 技能说明文档
├── capabilities.yaml        # 能力矩阵
├── requirements.txt         # 核心 Python 依赖
├── agents/                  # 触发器配置 (openai.yaml)
├── references/              # 制图规范与参考手册（含看图 Phase A~D 核心文档）
├── scripts/                 # SolidWorks COM 与无头执行脚本库
└── subskills/               # 专项专家子技能（螺纹孔、圆角、VibeCAD、AutoCAD）
```
