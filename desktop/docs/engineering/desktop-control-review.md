# Desktop 控件分类与合并审阅表

**首批四项、会话行、整数设置输入、带标签复选框、Markdown 工具栏、复制图标、设置行及空状态归并已完成，盘点基线为 `46060ce0`。** [逐项源码索引](desktop-control-inventory.md)用于查找合并前的调用位置。[主题方案](desktop-theme.md)记录首批结果和后续迁移范围。

## 分类依据

| 用途 | 外观规格 | 交互及状态 | 典型实现 |
|---|---|---|---|
| 执行命令 | 主、次、弱、危险；带文字或仅图标；紧凑、工具栏、弹窗点击区 | 点击、键盘激活、禁用；复制和刷新还有等待与结果反馈 | DangerButton、IconButton、CopyButton、RefreshButton |
| 编辑输入 | 单行、多行、数值、搜索；标签、单位、错误提示 | 草稿、清空、Enter、失焦提交、异步保存失败 | FontSizeInput、ArchiveDaysInput、ThresholdInput、FindBar |
| 选择 | 开关、方框、单选点、分段、弹出列表 | 即时切换、单选、多选；键盘移动、选中和提交 | ToggleSwitch、CheckSquare、RadioDot、Listbox、SegmentedControl |
| 导航与集合 | 树行、单行或双行列表、标签页、面包屑 | 打开、展开、选择、重命名、右键及键盘菜单 | SessionNode、PinnedSessionRow、RecentSessionRow、FileTreeRow、Breadcrumb |
| 提示与确认 | 行内确认、提示条、菜单、抽屉、模态框 | 是否阻断操作、Esc、外部点击、焦点进入及归还 | InlineConfirm、Callout、ContextMenu、EdgeDrawer、ConfirmationDialog |
| 状态与统计 | 徽标、状态点、空态、进度条、用量计 | 纯装饰、具名状态、加载、错误、重试或详情 | Badge、StatusDot、EmptyState、Spinner、UsageMeter |
| 布局与操纵 | 设置行、标题、分栏、可折叠区域 | 响应式排列、拖拽调整、折叠后焦点和内容生命周期 | SettingRow、PageHeader、ColumnResizer、TreeBranch |
| 内容与专用绘制 | Markdown、图表、文件预览、Diff、终端、工作流画布 | 长内容、搜索定位、滚动同步、选择、缩放、主题重绘 | MarkdownView、GitReviewDiff、EditDiffView、FlowStages、TerminalSessionView |
| 图标与内容标识 | 操作图形（复制、归档）、方向（箭头、折叠）、资源（文件、文件夹）、状态（加载、勾选）、品牌与技能 | 图形由宿主提供语义和点击区；旋转、填充、展开态与文字对比度需核对 | UiIcon、FolderGlyph、LoaderCircleIcon、SkillIcon、SkillReferenceToken |

## 合并决定草案

分三档审查。A 表示调用方可以直接改用同一实现；B 表示共用呈现或交互骨架，领域状态与提交策略仍由原调用方负责；C 表示维持已有行为边界，按需要共享基础控件和主题变量。每一行的回归项都是拟实施时的验收条件。

| 批次／档 | 当前实现与位置 | 合并目标及需保留的差异 | 回归用例 |
|---|---|---|---|
| 首批 A | [ChatInput 的 ArrowUpIcon](../../src/plugins/project/conversation/ui/ChatInput.tsx) 与 [共享 ArrowUpIcon](../../src/shared/ui/icons.tsx) | 两段路径及线宽相同。发送按钮直接传入共享图标并保留 `ui-icon-16` | 两个字号下检查箭头尺寸、按钮点击区及发送可用态 |
| 首批 A | [ProjectTree 的 FolderIcon](../../src/plugins/project/ui/ProjectTree.tsx) 与共享 FolderGlyph | 开闭路径相同。调用处传入原有 16 档和文字色，覆盖共享默认 14 档 | 文件夹展开、收起，检查图形、尺寸与颜色 |
| 首批 A | [通用图标 Svg](../../src/shared/ui/icons.tsx) 与[文件图标 Svg](../../src/shared/ui/file-icons/icons.tsx) | 共享同一 SVG 基底，保留现有默认线宽 1.8 和 2，以及调用处显式覆盖 | 各取一道线形图标验证 viewBox、描边、字号缩放和装饰属性 |
| 首批 B | [SessionArchiveAction、GroupArchiveAction](../../src/plugins/project/ui/ProjectTree.tsx) | 合并归档触发器、二次确认、Esc、外部点击与事件传播处理。调用处提供动作、提示、禁用条件。单会话提交前重查运行状态 | 鼠标和键盘进入确认、点外和 Esc 取消、确认期间变忙、分组回调仅一次、避免同时打开会话 |
| 已完成 B | 同文件内的 SessionNode、PinnedSessionRow、RecentSessionRow | 复用已存在的 SessionRowBody 和标题部件，再收口右键与键盘菜单、重命名和尾部动作。保留置顶标识、最近项副行、分组自定义打开目标 | 三种入口均覆盖重命名、菜单、选中、归档；最近项保留路径与分组信息 |
| 已完成 B | [FontSizeInput](../../src/plugins/workbench/ui/settingsContributions.tsx)、[ArchiveDaysInput](../../src/plugins/project/ui/settings.tsx)、[ThresholdInput](../../src/plugins/diagnostics/ui/StorageSettings.tsx) | 前两者共用整数输入，分别保留空值处理、四舍五入或向下取整、Enter 后焦点行为。阈值先共用外观，业务层负责安全整数、单位和异步保存 | 清空、小数、越界、Enter、失焦；阈值保存失败后草稿可重试 |
| 已完成 B | [SkillLibrary 的 Check](../../src/plugins/skills/ui/SkillLibrary.tsx) 以及工作流 DisposePanel、RunManager、WorkflowLauncher 中的 input + CheckSquare | 收口原生复选框、视觉方框、标签点击区和焦点反馈。确认处理、筛选和启动选项各自管理勾选值 | 点标签、空格切换、Tab 焦点、选中与禁用、回调一次 |
| 已完成 B | [PreviewButton](../../src/shared/ui/markdown/DiagramPreviewDialog.tsx) 和 [TableToolbarButton](../../src/shared/ui/markdown/MarkdownTable.tsx) | 两者已用 IconButton；共用标签、提示及样式规格，区分普通与紧凑点击区。表格复制和下载沿用各自的处理逻辑 | 键盘聚焦显示提示、辅助名称、两档点击区和图标缩放 |
| 已完成 B | [CopyButton 私有 CopyIcon、CheckIcon](../../src/shared/ui/CopyButton.tsx) 与共享同名图标 | 用途相同，14 单位与 24 单位的绘制路径不同；在两主题的 12 px 界面字号下对照后采用共享图形 | 默认、复制成功和失败、反馈复位；小尺寸辨识度 |
| 已完成 B | [TaskSettingRow](../../src/plugins/scheduledTasks/ui/TaskViews.tsx)、[AboutRow](../../src/plugins/workbench/ui/settingsContributions.tsx) 与 [SettingRow](../../src/shared/ui/SettingsPageParts.tsx) | 共享标签和值的排布；任务编辑需要紧凑规格，普通设置保留窄屏换行、标签关联和 footer | 窄窗、最大字号、长值、键盘定位表单 |
| 已完成 B | [文件树反馈](../../src/plugins/documents/ui/file-tree/FileTreeList.tsx)、[项目引导空态](../../src/plugins/project/ui/ProjectOverview.tsx) 与 [EmptyState](../../src/shared/ui/EmptyState.tsx) | 共用图标、标题、说明与操作布局。文件树区分读取中、失败与空目录；项目页保留添加项目、取消与重试 | 文件树三态，取消选目录后重试，读屏状态反馈 |
| 保留 C | [ConfirmationDialog](../../src/shared/ui/ConfirmationDialog.tsx)、[InlineConfirm](../../src/shared/ui/InlineConfirm.tsx)、两个项目树归档入口 | 弹窗阻断与行内确认具有不同焦点行为。移除项目、退出、重置已复用同一弹窗，场景文案可以就近维护 | Esc、焦点归还、危险操作的确认对象 |
| 保留 C | ToggleSwitch、CheckSquare、RadioDot、Listbox、SegmentedControl | 分别承担开关、复选图元、单选图元、列表选择和分段选择；统一选中、禁用、焦点的视觉状态 | 按各控件适用的角色、键盘操作与状态断言 |
| 保留 C | [GitReviewDiff](../../src/plugins/git/ui/GitReviewDiff.tsx) 与 [EditDiffView](../../src/plugins/project/conversation/ui/EditDiffView.tsx) | Git 双栏有滚动同步与分页定位；会话渲染编辑片段或写入预览。共用增删颜色和行号样式 | Git 双栏同步及定位；会话修改与写入两种预览 |
| 保留 C | [SkillReferenceToken 和 SkillReferenceTokens](../../src/plugins/project/conversation/ui/SkillReferenceTokens.tsx) | 单个技能标识已被输入区和消息复用，外层负责输入区排布和水平滚动。保留技能图形和具名文字 | 长技能名称、多个标识、消息回显、双主题与高对比模式 |

## 首批实施结果

生产代码净减三个组件定义：移除聊天发送箭头和项目树文件夹两份私有图形，两份 Svg 合为一份。文件图标的九个公共实现继续使用 2 单位线宽。普通、置顶和最近会话行仍调用 SessionArchiveAction 执行业务校验；它和分组行共用 ArchiveAction 的触发、确认与取消。归档交互主体由两份降为一份，计数保留会话业务组件。后续 B 类按本表逐项评估。

## 会话行合并结果

普通、置顶和最近会话入口共用 ProjectTree 中的 SessionRow，三个行定义收敛为一个。标题和操作沿用原有部件。最近列表订阅分组变更，把成员及分组名传给行；点击和键盘菜单都使用成员指定的打开目标。置顶行仍使用钉子图形，最近行保留项目与分组副行。本轮净减两个生产组件定义，连同首批累计净减五个。

## 整数设置输入的合并结果

界面字号与归档天数复用 IntegerSettingInput，以参数提供边界、取整和清空后的值。诊断阈值使用同一份数字输入样式，单位、安全整数校验和异步保存仍由 ThresholdInput 负责。本轮两个定义合成一个，累计净减六个生产组件定义。

## 复选框的合并结果

原先的 CheckSquare 只画方框，技能库另有一层 Check。现在由 Checkbox 同时提供原生输入、可点击文字、勾选图形、禁用与键盘焦点。在技能库两个用点以及工作流运行筛选、启动选项、处置确认三个用点共用这一个实现。每个调用方仍持有各自的选择状态。本批净减一个生产组件定义，累计净减七个。

## Markdown 工具栏的合并结果

表格的复制、下载和预览使用 24 px 点击区，图表预览的缩小、放大和关闭使用 28 px 点击区。六处直接使用共享 IconButton 的 toolbar 外观，由辅助名称生成提示，统一悬停色和键盘焦点环。本批移除两个私有按钮定义，累计净减九个生产组件定义。[双主题浏览器用例](../../tests/visual/markdownToolbar.pw.ts)覆盖两档点击区与键盘操作。

## 复制按钮图标的合并结果

消息和代码块的复制按钮复用共享 CopyIcon 和 CheckIcon。在 12 px 界面字号下，双页轮廓与成功对勾在暖白和暗夜均可辨识，按钮保留原点击区。写入失败显示失败提示并允许重试；成功反馈在两秒后恢复。本批移除两个私有图标，累计净减十一个生产组件定义。[双主题复制用例](../../tests/visual/markdownToolbar.pw.ts)

## 设置行的合并结果

外观页的版本、仓库和插件贡献值使用标准 SettingRow，跟随普通设置的双列和窄栏堆叠布局。定时任务编辑器的八种字段使用同一组件的紧凑规格，日期标签可以聚焦输入框。按各行容器的可用宽度换行。本批移除两个私有行组件，累计净减十三个生产组件定义。[架构门禁](../../tests/architecture/settingRows.test.ts)与[最大字号下的窄栏用例](../../tests/visual/uiScale.pw.ts)覆盖这两种规格。

## 空状态的合并结果

文件树的加载、空目录、筛选无结果和读取失败共用紧凑 EmptyState。前三者提供状态提示，失败时报告错误原因。项目总览采用标准空态，保留选择目录、取消和重试的业务处理。本批移除 FileTreeNotice，项目引导保留业务组件，累计净减十四个生产组件定义。本表十一项 A/B 合并决定已实施，四项 C 决定保留交互边界。[文件树状态测试](../../tests/plugins/documents/fileTreeList.test.tsx) · [取消后重试测试](../../tests/integration/workbench.test.tsx)

## 布局控件的合并结果

| 档 | 合并位置 | 保留用途和行为 | 回归 |
|---|---|---|---|
| B | [右栏](../../src/plugins/workbench/ui/right-panel/RightPanel.tsx)、[文件树](../../src/plugins/documents/ui/FileTree.tsx)、[大纲](../../src/plugins/documents/ui/FileDocumentTools.tsx)、[终端](../../src/plugins/terminal/ui/TerminalPanel.tsx) 接入 [ColumnResizer](../../src/shared/ui/controls/ColumnResizer.tsx) | 同一套指针、键盘、焦点和范围实现。分别保存项目比例、目录比例、像素宽度或面板高度。 | 拖动、拖动取消、方向键与边界、双击恢复、换肤保留焦点、减少动态效果和终端输出。 |
| B | [独立诊断](../../src/plugins/diagnostics/ui/DiagnosticsWindow.tsx)、[定时任务](../../src/plugins/scheduledTasks/ui/TaskViews.tsx)、[技能库](../../src/plugins/skills/ui/SkillLibrary.tsx) 接入 [PageHeader](../../src/shared/ui/PageHeader.tsx) | 统一页面和分节字号、间距及操作区换行。保留诊断标志、任务操作和技能数量。 | 窄窗长名称、两套主题三档字号、操作区和独立诊断焦点。 |
| C | [会话标题](../../src/plugins/project/ui/projectHeaders.tsx)、[登录](../../src/plugins/account/ui/LoginScreen.tsx)、[设置](../../src/plugins/workbench/ui/SettingsPage.tsx) 与 [Markdown](../../src/shared/ui/MarkdownView.tsx) | 会话标题参与行内改名，登录和任务空态使用居中布局，设置标题提供读屏导航，Markdown 标题属于文档结构。 | 架构门禁逐项核对原生标题归属。 |

## 内容与专用绘制的合并结果

| 档 | 合并位置 | 保留用途和行为 | 回归 |
|---|---|---|---|
| B | [Git 统一差异](../../src/plugins/git/ui/GitDiffView.tsx)、[左右差异](../../src/plugins/git/ui/GitReviewDiff.tsx)、[会话差异](../../src/plugins/project/conversation/ui/EditDiffView.tsx) 共用[差异样式](../../src/shared/ui/diffStyles.ts) | 增删行底、行首标记、行号与统计共用主题颜色。Git 保留常规字号、横向滚动或分屏同步，会话保留紧凑字号与长行换行。 | 两种主题三档字号、查找命中、阅读位置和行号对比度。 |
| B | [xterm](../../src/plugins/terminal/ui/TerminalSessionView.tsx)、[用量趋势](../../src/plugins/project/usage/UsageSettings.tsx)、[流程小地图](../../src/plugins/workflow/ui/FlowStages.tsx) 接入[外观监听](../../src/shared/ui/observeAppearance.ts) | 主题与字号变化通知主动绘制的视图。终端按需换色或重新计算列数，用量趋势重绘当前数据，小地图换肤只重绘。 | 收起终端再打开保留输出，趋势和小地图使用当前主题的实际像素，步骤焦点保持。 |
| C | [普通预览](../../src/plugins/documents/ui/FilePreview.tsx)、[Markdown 编辑](../../src/plugins/documents/ui/MarkdownSourceEditor.tsx)、[表格](../../src/shared/ui/markdown/MarkdownTable.tsx) 与 [Mermaid](../../src/shared/ui/markdown/MermaidBlock.tsx) | 各渲染器保留文档、选区、缩放、查找或表头滚动语义。主题变量和字号由外观设置同步。 | 源码选区、文件查找、长表滚动及打开的图表缩放与焦点。 |

## 图标与内容标识的合并结果

| 档 | 合并位置 | 保留用途和行为 | 回归 |
|---|---|---|---|
| A | 项目树、预览空态、文件页签、文件管理入口和技能操作复用 [FolderGlyph](../../src/shared/ui/icons.tsx) | 支持开合两种图形，入口默认使用打开形态。 | 展开和收起、动态入口、窄栏三档字号。 |
| A | [图片预览](../../src/shared/ui/markdown/MarkdownImage.tsx)、[代码块](../../src/shared/ui/markdown/CodeBlock.tsx)、文件预览与窗口控制复用共享加减、箭头、最大化和换行图形 | 操作和按钮规格由调用方提供。 | 预览缩放、焦点、快捷键及禁用。 |
| B | 活动栏、诊断、登录、更新及启动用 [BrandMark](../../src/shared/ui/BrandMark.tsx) | 品牌图片和字号统一，启动页保留动效，更新保留辅助名称。 | 主题往返、字号与窄窗几何；减弱动效。 |
