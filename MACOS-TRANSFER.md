# macOS 源码迁移包

- 源提交：d563cf61b997e1be5860edac1eb32e0c99ea030c
- 包含 632 个当前工作区源码/文档/配置文件，含未提交的 README 与 handoff 更新。
- 不包含 .git 历史、依赖、构建产物、运行数据及 Python 缓存；不是业务数据备份。
- 排除了 18 个已跟踪的缓存/产物文件，原仓库未改动。
- Electron 历史源码保留供 Web 迁移参考，不代表继续开发独立客户端。
- 先阅读 README.md，再阅读 docs/05-engineering/lead-agent-handoff.md 顶部当前交接。
- Mac 使用 Node.js 24.x / npm 11.x，在本目录执行：

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build --workspace @swpanel/domain
npm run build --workspace @swpanel/contracts
npm run dev:renderer --workspace @swpanel/desktop
```

浏览器打开 http://127.0.0.1:5173/ ，目前主要为 mock 开发预览。上述步骤尚未在 Mac 实机验证。

若需要完整 Git 历史，应从原仓库另行同步；此包未执行提交、推送或发布。
