# AAW 桌面客户端

通过 ACP（Agent Client Protocol，JSON-RPC over stdio）连接本机 iCode
（原 chrys，命令 `icode acp`；iCode 0.30 起命令由 chrys 改名 icode，配置目录
仍为 %APPDATA%/chrys），承载 AAW 工作流（AAW skills + aaw CLI，流程状态在项目
`.sdd/` 下）开发交互的桌面应用。

技术栈：Tauri 2 + React + TypeScript（strict）+ Vite；状态管理 zustand；
测试 vitest。

开发指南见 [Desktop 文档](docs/README.md)，包括 Cordis 插件架构、Agent 方言扩展与前端风格约束。

文档批注的操作与恢复说明见 [文档批注](docs/features/document-annotations.md)。

## 常用命令

| 命令                              | 作用                                      |
| --------------------------------- | ----------------------------------------- |
| `npm run dev`                     | 启动 Vite 前端开发服务（端口 1420）       |
| `npm run tauri dev`               | 启动完整桌面应用（Rust 壳 + 前端）        |
| `npm run typecheck`               | TypeScript 类型检查（主项目 + node 配置） |
| `npm run lint`                    | ESLint 检查（含禁止 any 的类型感知规则）  |
| `npm run format` / `format:check` | Prettier 格式化 / 校验                    |
| `npm run test`                    | Vitest 全量测试（`vitest run`，非 watch） |
| `npm run build`                   | 类型检查 + 生产构建（输出 `dist/`）       |
| `npm run tauri build`             | 打包桌面安装产物                          |

## 目录结构

```
desktop/
├── docs/            # 架构、开发维护、功能说明和历史记录
├── src/
│   ├── bootstrap/   # 创建 Cordis 上下文并装配插件
│   ├── contracts/   # 标准 ACP 线协议契约
│   ├── plugins/     # 各功能的服务、生命周期与界面
│   └── shared/      # 通用基础工具和展示组件
├── tests/           # 按插件归属、集成场景和架构规则组织的 Vitest 用例
└── src-tauri/       # Rust 壳（Tauri 2；含 ACP 长连接 stdio 命令集 + 关闭守卫）
```

## 主界面结构

工作台按项目组织会话，并提供文档、Git、终端、工作流和设置入口。界面职责和功能入口见[界面功能参考](docs/features/ui-reference.md)。工作流引擎是 Rust sidecar（`workflow-engine-rs/`），以 Cordis 插件 `plugins/workflow` 接入，详见 [workflow-engine-rs/README.md](workflow-engine-rs/README.md) 与 ADR 024。

插件职责和依赖关系见 [Cordis 插件架构](docs/architecture/cordis-plugin-architecture.md)和[依赖图](docs/architecture/cordis-plugin-dependencies.md)。历史架构与迁移记录收录在[文档索引](docs/README.md)。

工作流的架构决策见 [docs/workflow/adr.md](docs/workflow/adr.md)；早期 SkillSplice 协议设想与原型验证记录归档在 [docs/history/skillsplice](docs/history/skillsplice/000-overview.md)。

## 协议参考

ACP 连接、运行时和 Agent 方言扩展见 [ACP 架构说明](docs/architecture/acp-architecture.md)。

## IDE

- [VS Code](https://code.visualstudio.com/) +
  [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
  - [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Windows CI/CD

GitHub Actions 自动检查并构建 Windows x64 安装包和便携 ZIP；推送 `desktop-vX.Y.Z` 标签后自动发布正式 GitHub Release。版本规则、下载与发布步骤见 [CI/CD 手册](docs/engineering/CI-CD.md)。
