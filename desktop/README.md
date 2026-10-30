# AAW 桌面客户端

通过 ACP（Agent Client Protocol，JSON-RPC over stdio）连接本机 iCode
（原 chrys，命令 `icode acp`；iCode 0.30 起命令由 chrys 改名 icode，配置目录
仍为 %APPDATA%/chrys），承载 AAW 工作流（AAW skills + aaw CLI，流程状态在项目
`.sdd/` 下）开发交互的桌面应用。

技术栈：Tauri 2 + React + TypeScript（strict）+ Vite；状态管理 zustand；
测试 vitest。

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
├── docs/            # 架构与工程约定（architecture.md / conventions.md / HANDBOOK.md）
├── src/
│   ├── acp/         # ACP 协议层：JSON-RPC over stdio、超时、通知流解析
│   ├── agents/      # agent 适配注册层：chrys 适配项；接新 agent 只加这里
│   ├── aaw/         # AAW 集成层：aaw CLI、skills 发现、.sdd/ 流程状态
│   ├── core/        # 核心设施：结构化日志、ACP 流量环形缓冲（logger.ts）
│   ├── stores/      # zustand 状态层（session / approval / aaw 状态 / 工作区 / 设置 / 日志 / 界面态）
│   ├── ui/          # 界面层（图标窄栏 + 项目树侧边栏 + 内容区 + 会话视图）
│   ├── App.tsx      # 装配：图标窄栏 · 侧边栏树 · 内容区（含唯一顶栏）· 关闭守卫 · 模态层
│   └── main.tsx
├── tests/           # Vitest 测试（目录镜像 src 分层）
└── src-tauri/       # Rust 壳（Tauri 2；含 ACP 长连接 stdio 命令集 + 关闭守卫）

## 主界面结构

单页三区：**图标窄栏**（48px：侧边栏开关 · ＋新建会话 · 设置/诊断入口，
侧边栏收起的唯一入口）｜**项目树侧边栏**（项目为父节点挂会话子节点，
项目/会话双视角，可收起，【+】面板承载新建会话与添加项目）｜**内容区**
（顶部**唯一顶栏**：左侧随视图切换上下文——返回 / 项目名 / 连接徽标 /
动作，右侧全局区——agent 标识 + 待办下拉；其下是会话视图 / 项目总览，
设置与诊断是全屏覆盖层）。**核心流程是「指定项目 → 创建会话 → 通过
ACP 与 Agent 交互」**：新建会话直接落一条空对话（`forceNew`，不落进
上次那个对话），AAW 入口向导不是必经步骤，而是会话内 AAW 面板「启动」
分段里的可选动作；AAW 的状态显示同理——上下文条的 AAW 开关（有工作流
数据时标签即 `SR-xxx · 步骤 n`）拉出右侧面板就地看进度，`done` 命令行
默认不露（那是 skill 派给 agent 的动作），只留「放行进入下一步」一个按
人话说的动作。会话子节点有**两个数据来源**：已连接项目以 ACP
`session/list` 为权威，未连接项目从 agent 的会话索引补——所以**冷启动
就能看到历史**，不必先连上。项目总览里健康检查与工作流状态各一处：前者
是「项目状态」行内的摘要 chip + 可折叠明细，后者是只读的工作流状态面板
（项目没有 `.sdd/` 时收成一行）；主行动按钮是「新建会话」，已连接时并列
「进入会话」。三条工具路径在设置页配置。点会话子节点自动重连进入；点了
历史会话即恢复上次对话。主题支持暗夜 / 暖白（设置 → 外观）。

各层职责与边界详见对应目录的 `README.md`；编码规范（命名、zustand 模式、
样式）见 `docs/conventions.md`；分层图与数据流见 `docs/architecture.md`；
演进决策、已知问题与待办见 `docs/HANDBOOK.md`。

## 协议参考

- 已跑通的 Python ACP 客户端：
  `../skill-eval/src/aaw_skill_eval/services/providers/protocols/acp/`
  （`session.py` / `wire.py`）；
- chrys 服务端权威定义：`D:/dev/workspace-ai/chrys/src/chrys/app/acp/`。

## IDE

- [VS Code](https://code.visualstudio.com/) +
  [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
  - [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
```

## Windows CI/CD

GitHub Actions 自动检查并构建 Windows x64 安装包和便携 ZIP；推送 `desktop-vX.Y.Z` 标签后自动发布正式 GitHub Release。版本规则、下载与发布步骤见 [CI/CD 手册](docs/CI-CD.md)。
