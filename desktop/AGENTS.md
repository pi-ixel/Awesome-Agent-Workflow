# AGENTS.md

AI 编码代理在本项目工作的指南。本文件只承载项目模型、目录地图与验证门禁；细节一律以被链接的权威文档为准，避免两处漂移。

## 1. 项目概览

AAW Desktop 是 AI Agent Workspace：通过 ACP（Agent Client Protocol）承载多种 CodeAgent 会话，采用 Cordis 插件化架构，提供文件 / Git / 终端 / 文档等面板生态，内置通用工作流引擎，持续接入新能力。

**给 Desktop 加功能 = 写插件**：业务能力以 Cordis 插件形式装配进 `src/plugins/`，不写散装代码、不绕过插件依赖规则。

**复用优先**：界面、基础能力与业务功能都先查既有实现——UI 层查共享控件与语义 token，基础能力查 `src/shared/`、host 服务与 `src-tauri/` 既有命令，业务功能查既有插件；已覆盖就复用或组合，未覆盖才新建，不为迁就复用改变功能边界。

## 2. 目录地图

| 目录                  | 是什么                                                           | 技术栈              |
| --------------------- | ---------------------------------------------------------------- | ------------------- |
| `src/plugins/`        | Cordis 插件（17 个），全部业务能力所在                           | TypeScript          |
| `src/contracts/`      | 协议契约与报文校验（含标准 ACP 协议 `acp/`）                     | TypeScript          |
| `src/shared/`         | 跨插件共享代码与主题样式（token 源在 `styles/index.css`）        | TypeScript + CSS    |
| `src/bootstrap/`      | 启动装配层                                                       | TypeScript          |
| `src-tauri/`          | Rust 桌面壳：Agent 子进程、自动更新、通知、面板原生运行时        | Rust                |
| `workflow-engine-rs/` | 通用工作流引擎服务（独立进程）                                   | Rust                |
| `tests/`              | 分层测试：`architecture/`、`plugins/`、`integration/`、`visual/` | Vitest + Playwright |
| `scripts/`            | 开发与构建脚本（dev-web、build-workflow-service 等）             | Node                |
| `docs/`               | 文档：architecture / engineering / features / workflow / history | —                   |

Rust 测试分别位于 `src-tauri/` 与 `workflow-engine-rs/` 各自 crate 内。

## 3. 架构：两个承重概念

### Cordis 插件

前端能力全部以插件组织在 `src/plugins/`（17 个）：account、acpConnection、acpRuntime、agents、browser、configuration、diagnostics、documents、git、host、project、scheduledTasks、skills、terminal、updates、workbench、workflow。每个插件声明服务、依赖与资源所有权；`workbench` 提供根界面、布局与导航，`host` 承载进程、文件等原生能力入口。

装配主链：`project → acpRuntime → acpConnection → host`。依赖图以 `docs/architecture/cordis-plugin-dependencies.mmd` 为源，`tests/architecture/cordisArchitecture.test.ts` 核对图源、文档表格与实际装配三者一致——改插件依赖必须同步 `.mmd` 与依赖文档，否则测试失败。

新增能力路径：确认既有插件与 `src-tauri/` 命令未覆盖需求后，创建插件并登记装配 → 更新依赖图 `.mmd` 与依赖文档 → 通过架构测试。详见 [Cordis 插件架构](docs/architecture/cordis-plugin-architecture.md)。

### ACP 与 Agent 方言

所有 Agent 通过同一套标准 ACP（JSON-RPC over stdio）与 Desktop 对话；方言是可选翻译器，只给选中的 Agent 增加专有消息支持。内置宿主为 iCode（适配器 ID 为 `chrys`，配置目录 `%APPDATA%/chrys`），ACP 启动命令为 `icode acp`。Rust 侧 `src-tauri/src/acp_process.rs` 管理 Agent 子进程，Windows 用 Job Object 管理进程树。

接入新 Agent 三步：先跑标准连接 → 有专有能力时在 `src/plugins/agents/enhancements/<厂商>/` 写方言（`translateNotification` / `serverRequestHandlers` / `enhanceEvent`）→ 注册适配器并做对照验证。详见 [ACP 架构与方言扩展](docs/architecture/acp-architecture.md)。

语言边界：前端 TypeScript 在 `src/plugins/`；桌面壳与原生能力 Rust 在 `src-tauri/`；工作流引擎是独立 Rust 服务，在 `workflow-engine-rs/`，与 Desktop 经 NDJSON over stdio 通信（`src-tauri/src/workflow_service.rs`）。

## 4. 验证与门禁

| 命令                     | 作用                                                    |
| ------------------------ | ------------------------------------------------------- |
| `npm run typecheck`      | TypeScript 类型检查（主项目 + node 配置）               |
| `npm run lint`           | ESLint（含禁 `any` 的类型感知规则）                     |
| `npm run format:check`   | Prettier 校验                                           |
| `npm run test`           | Vitest 全量（含架构测试）                               |
| `npm run test:visual`    | Playwright 视觉测试（`tests/visual/`）                  |
| `npm run workflow:build` | 构建工作流引擎服务二进制                                |
| `cargo test`             | Rust 测试（`src-tauri/`、`workflow-engine-rs/` 内执行） |

改什么必须跑什么：

- 改前端代码 → `typecheck` + `lint` + `format:check` + `test`
- 改插件装配或依赖 → 同步 `.mmd` 与依赖文档，跑架构测试
- 改 `src-tauri/` → `cargo test`
- 改 `workflow-engine-rs/` → `cargo test` + `npm run workflow:build`
- 改界面观感 → `npm run test:visual`

CI（`.github/workflows/desktop.yml`）对涉及 `desktop/**` 的 PR 依次执行 TypeScript、ESLint、Vitest、前端生产构建、Rust 测试与 NSIS 打包，见 [CI/CD](docs/engineering/CI-CD.md)。

编码硬约束（依据[工程约定](docs/engineering/conventions.md)与[前端风格约束](docs/engineering/frontend-style.md)）：TypeScript strict、禁 `any`；界面文案与代码注释一律中文，标识符用英文；布尔命名 `is/has/can` 前缀；zustand 一域一 store（`use<域>Store`）；界面复用语义 token 与既有控件（`ToggleSwitch`、`SegmentedControl`、`Listbox`），新增颜色先检查两套主题下同用途 token；提交信息格式 `type(scope): 中文描述`。

## 5. 文档阅读优先级

| 主题           | 权威文档                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------- |
| 插件架构与依赖 | `docs/architecture/cordis-plugin-architecture.md`、`cordis-plugin-dependencies.md`              |
| ACP 与方言     | `docs/architecture/acp-architecture.md`                                                         |
| 工程与风格     | `docs/engineering/conventions.md`、`frontend-style.md`、`development.md`（开发入口与 ACP 宿主） |
| Desktop 主题与控件准入 | [主题与组件治理方案](docs/engineering/desktop-theme.md) |
| 工作流引擎     | `workflow-engine-rs/README.md`、`workflow-engine-rs/docs/workflow-format.md`                    |
| 功能现状       | `docs/features/`                                                                                |
| 发布           | `docs/engineering/CI-CD.md`                                                                     |

`docs/history/` 与 `docs/` 下的阶段性设计、验收记录是过程记录，查找现状以上表为准。

## 6. 维护

- 新增插件、Agent 方言或关键文档时，同步更新本文对应条目与被引用的架构文档。
- 本文件只写稳定事实；命令参数、实现细节留在被链接的文档里。
