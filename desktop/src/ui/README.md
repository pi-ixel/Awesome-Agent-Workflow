# src/ui — 界面层

React 组件与页面。只消费 `src/stores` 的状态和 action、`src/core` 的
类型与只读设施，不直接触碰协议与领域逻辑。

## 职责

- 主界面（App.tsx 组装）：顶栏（全应用唯一顶栏，48px：视图上下文 +
  动作排——帮助 / 终端 / 分栏 / 窗控）+ 项目树（置顶带 / 最近打开 →
  项目 → 会话子节点，可整列收起，收起后开关移入顶栏左端）+ 内容区
  （随树选中项切换）；设置 / 诊断入口在侧栏底部 footer；权限与提问
  对话框（对应 ACP 的 `request_permission` 与 `chrys/request_input`）
  挂在模态层；
- 项目总览（`workbench/ProjectOverview`）：项目状态行（健康摘要 chip +
  唯一主动作「新建会话」，已连接也一样——会话入口在树上，总览只管
  管理 + 发起）
  - 可折叠的健康检查明细 + 工作流状态（`AawStatusPanel`）；
- 设置页（`SettingsPage`，侧边 Tab 形态）：通用（语言 / 主题 / 关于）、
  Agent（会话 Agent 配置与连接测试）、工具路径（uv / aaw 脚本、skills
  源目录与 `SkillsInstallerSection` 安装器）、会话与审批（审批默认模式
  警示）；设置行（左标题+说明 / 右控件，发丝线分行）是全页的排版语法；
- 诊断页（`DiagnosticsPage` = `LogView` + `AcpTrafficView`）：读取
  `stores/logStore`（镜像自 core 环形缓冲）展示日志与 ACP wire 流量；
- Markdown 渲染：`react-markdown` + `rehype-highlight`
  （highlight.js `github-dark` 主题，样式入口在 `src/index.css`）。

## 已实现

- `StartupGate.tsx`：仅应用启动时，有已知项目则显示品牌动效。固定启动批次的列表
  全部结束（成功、失败或不支持）即进入工作区，最多等 8 秒；无项目直接进入。
  预加载和窗口关闭守卫保持挂载，后续请求不重新遮挡。纯 CSS 动效支持深浅主题
  及系统减少动态效果设置，不引入动画库或额外 Agent 请求。

- `workbench/`：主界面骨架。
  - `SidebarFooter.tsx`：侧栏底部 footer（身份位 + 统一设置菜单入口 +
    设置齿轮；设置 / 诊断入口在此，ZCode WorkspaceSidebarFooter 同位）；
  - `SidebarToggle.tsx`：侧栏开关钮（树列顶部拖拽带常驻，侧栏收起后
    移入顶栏左端）；
  - `NewTaskButtonGroup.tsx`：顶部新建会话行（ZCode 同名同形；全局新建
    会话的唯一入口）；
  - `TerminalPanel.tsx`：底部终端面板（execute 工具输出的只读回放，
    固定高 + 拖拽手柄；顶栏终端钮开合）；
  - `ProjectTree.tsx`：左栏项目树（项目 / 会话双视角、段头【+】面板、
    置顶带 / 最近打开分组、健康徽标、会话子节点，未连接项目
    点会话先自动连接再切换；会话视角空态给「去项目列表」出口）。
    **任何项目都可展开**：子区域里
    常驻「＋ 新会话」，空项目在树上不是死路。选中是「内容区正在显示谁」，
    全树只有一个：会话视图高亮会话行（项目行只是展开的父节点），总览
    高亮项目行；行选中态统一取 `controls.tsx` 的 `rowSelectedClass`
    （accent 淡底 + 左缘 2px 竖条），与中性色悬停态分属两套颜色语言；
  - `sessionStart.ts`：`startNewSession` ——在指定项目里**新建**一条会话
    （`forceNew` 跳过历史恢复，落一条空对话；选中项目 → 未连接先连接 →
    内容区切到会话视图）。与 `sessionEntry.ts` 的「打开历史会话」是两个
    动词，结果不同，不得合并；连接失败落在总览（那里有失败横幅与去设置
    工具路径的出口）；
  - 列表发现统一由 `realRuntime.ts` 管理：启动、添加项目、切换 Agent 时查询
    ACP `session/list`，完整读取分页，状态存入 `sessionCatalogStore`。
    `standbyConnections.ts` 按 Agent 配置与项目去重，最多并行准备两个连接；
    每个项目保留一个待用连接，点击会话时接管，再后台补充。工作会话连接
    独立保留，后台列表获取不占用打开会话的串行队列。移除项目、关闭项目或
    切换 Agent 时清理对应待用连接，过期结果不回填。失败显示原因与重试，
    不支持查询与真正空列表分开显示。不再旁路读取 Chrys 索引来填侧栏。
  - `ContextBar.tsx`：全应用唯一顶栏（48px，内容区顶部，ZCode
    WorkspaceHeader 形态）：左侧是随视图切换的标题区（Folder 钮 / 会话
    标题（双击改名）+ 更多菜单 / 项目名 + 路径 / 关闭项目 / 返回按钮），
    右侧是动作排（帮助 → 终端 → 分栏 → 窗控，gap-0.5 无分隔线）；空态下
    左段留空（侧栏收起时只有开关）；
  - `ContentArea.tsx`：内容区视图容器（项目总览 / 会话 / 设置 / 诊断，
    状态在 `stores/workbenchUiStore`）；
  - `ProjectOverview.tsx`：项目总览（健康检查不随进页自动发起——首次
    检查发生在添加项目那一刻，之后靠页内手动「重新检查」；组件层从设置
    store 组装工具路径成 pathsOverride，不阻塞 UI；健康摘要 chip 可开合
    明细，有警告 / 失败时自动展开；主行动按钮
    不点名具体 agent——始终是「新建会话」（会话入口在树上，总览不放
    「进入会话」）；项目没有 .sdd/ 时工作流面板收成一行说明）；
  - `ColumnResizer.tsx` / `columnWidths.ts`：左栏拖宽与持久化；
  - `ModalShell.tsx`：模态外壳（问答表单等复用）。
- `right-panel/`：项目共享的右栏，首次收起，窄窗覆盖、宽窗并排。`RightPanel` 持有稳定布局和内容标签；`FileTree` 逐层列目录，`FilePreview` 有界只读预览，`GitPanel` 展示项目范围的状态和统一差异。目录/Git 合并文件监听、窗口焦点和 agent 完成事件；文件预览不自动刷新。
  - `AawPanel` 复用进度和入口向导；总览选择执行会话，`aawTarget` 在连接前后校验项目与会话，遵循已有暂停队列语义。
  - 规则和验收见 `desktop/docs/right-panel-v1.md`。旧 `SessionAawPanel` / `wizardSubmit` 保留兼容测试，工作台不再使用。
- `EntryWizard.tsx`：AAW 入口启动向导（三入口选择 → 按入口收集变量 →
  首条中文 prompt 预览 → 交给会话发送；领域逻辑在 `src/aaw/entryWizard.ts`）。
  出现在项目右栏 AAW 面板的「启动」分段，是「从 AAW 入口启动」的显式动作，
  不是新建会话的必经步骤。
- `AawStatusPanel.tsx`：工作流状态面板，`aaw status / next --peek --json`
  的只读渲染（当前 SR、阶段步骤条、门禁徽标、工作单摘要、待放行提示）。
  它回答人的三个问题（在哪一步 / 要产出什么 / 卡在哪），因此 **agent 侧的
  执行细节默认不露**：done 命令行收在可展开的「执行详情」里——那是 skill
  派给 agent 的动作，不是用户的活。自身不写状态，唯一交互是刷新、自动
  刷新开关与（注入 `onRunCommand` 时）「放行进入下一步」这一个动作，发给
  会话的是自然语言请求而非 argv。项目总览与会话内 AAW 面板共用的展示件。
- `ApprovalModal.tsx`：权限审批模态弹窗（工具名 / 标题 / rawInput 摘要 /
  按 kind 排序的选项按钮，Esc 取消）。
- `QuestionForm.tsx`：结构化问答卡片表单（单选 / 多选，全答完才能提交）。
- `PendingInbox.tsx`：待办面板（顶栏「待办」按钮的下拉形态，挂起的
  审批/提问列表与焦点切换）。
- `session/`：会话视图（中央聊天流）。
  - `SessionView.tsx`：组合容器（上下文条 + 消息流 + 悬浮输入区）——
    消息流**窗口化**（只挂最近 150 条，贴顶按块补载且锚定不顶飞）+
    **跟随状态机**（贴底自动滚入；上翻解除并浮出「回到底部」带未读
    计数）；空会话给推荐入口 chips（预填不代发）；时间线 / 消息流 /
    AAW 面板各挂局部错误边界（单块崩不殃及全局，根级边界兜底整树）；
  - `ChatInput.tsx`：悬浮输入卡（圆角植面 + 投影）：多行输入 Enter 发送 /
    Shift+Enter 换行，IME 组词不误发；↑/↓ 翻输入历史（promptHistory）；
    `@` 弹文件候选面板（Rust `list_workspace_files` 跳过依赖目录、前端
    30s 缓存），↑/↓ 选择 Enter 插入 `@相对路径`；预填事件总线
    （composerPrefill）承接「再次发送」与空态推荐入口；下行模型短格式 +
    审批模式徽标，右侧圆形发送 / 停止钮（session/cancel）；
  - `AssistantMessage.tsx` / `UserMessage.tsx` / `SystemNotice.tsx` /
    `ThoughtBlock.tsx`：四类条目的视觉区分（Markdown + 复制 / 右侧气泡 +
    hover 操作行「再次发送·复制」/ 居中弱化提示 / 折叠思考）；
  - `ToolCallCard.tsx`：工具调用卡片（折叠一行摘要，展开完整 JSON
    输入输出，运行中 / 完成 / 失败状态；运行中展开盯进度的卡完成时
    自动收起，失败保持展开）；
- `MarkdownView.tsx` / `CopyButton.tsx`：Markdown + 代码块高亮与复制
  的共用渲染件。
- `workspaces/`：项目总览的组成件与项目侧组装工具。
  - `WorkspaceHealthPanel.tsx`：健康检查明细（uv / aaw CLI /
    `.sdd/` 三项的 通过/警告/失败 + 中文修复指引）；摘要 chip 与「重新
    检查」在项目状态行，路径修改入口在设置页；
  - `pickDirectory.ts`：系统目录选择对话框的薄封装（「添加项目…」入口）；
  - `settingsLinks.ts`：工具路径的组装桥（`settingsPathsOverride` 供执行
    入参 + `useToolPathSettings` 供设置页三路径读写）；
  - 「打开项目」把路径写入 workspace store 的 `activePath`（ACP
    session 的 cwd 绑定点）。

## 规则

- 样式用 Tailwind 工具类直写 JSX（规范见 `docs/conventions.md`）；
- 组件文件 PascalCase（`DiagnosticsPanel.tsx`），一个文件一个导出组件；
- 组件不做数据变换：领域数据进来前已在 store/领域层定型；
- 文案一律中文。
