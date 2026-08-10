---
title: Local Design Source
status: stable
owner: JANGHI
last_updated: 2026-08-10
---

# TRAE Design 本地原型来源

SWPanel 已确认的高保真 UI 原型由 TRAE Design 生成，并位于正式开发工作目录下：

```text
./design
```

该目录是 **UI / 视觉实现的 Source of Truth**，与 GitHub 仓库中的产品文档共同构成开发输入。

## 1. 职责边界

GitHub 文档决定：

- 产品范围；
- 业务对象；
- 生命周期与状态；
- Workflow；
- 页面职责和信息架构；
- 已确认产品决策。

本地 `./design` 决定：

- 已确认页面布局；
- 视觉层级；
- Typography；
- Spacing；
- Border / Surface；
- 组件外观；
- 页面级 UI 呈现。

如果 `./design` 与产品文档在业务行为上冲突，以产品文档为准，并记录冲突；不得静默修改业务规则。

## 2. 开发前必须审计

主开发 Agent 在 Phase 0 中必须实际读取 `./design`，而不是只根据截图或文件名猜测原型结构。

至少检查：

```text
./design/index.html
./design/pages/
./design/css/
./design/assets/
./design/project.json
```

以及 `./design` 中实际存在的其他文件。

审计内容至少包括：

- 页面数量与页面关系；
- HTML 结构；
- CSS 组织方式；
- Design Token / CSS Variable；
- 共用视觉模式；
- 可抽取组件；
- 重复 markup / style；
- Assets 与字体 / 图标使用；
- 页面间不一致之处；
- 与 `docs/03-product/` 信息架构的映射关系。

## 3. 工程化原则

`./design` 是高保真原型，不默认视为 Production Frontend 代码。

正式开发应：

1. 尽可能忠实保留其视觉结果；
2. 提取并复用共享组件；
3. 建立真实 Router、Domain Type、State / Application Layer 与数据接口；
4. 避免直接复制大量静态 HTML / CSS 形成不可维护页面；
5. 不以“工程化”为理由重新设计已经确认的 UI；
6. 不把 Runtime Data、真实客户文件、Secret 写入 `./design` 或公开仓库。

## 4. 路径约定

除非用户后续明确改变工作目录结构，所有开发 Agent 均应将：

```text
./design
```

解释为 **当前项目根工作目录下的 TRAE Design 高保真原型目录**。

若本地不存在该目录，应报告缺失，不得自行在其他路径搜索并把相似页面误认为已确认原型。
