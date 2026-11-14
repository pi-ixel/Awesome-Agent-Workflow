# 工作流界面修改指导

这份文档写给接手工作流界面（AAW 工作流面板、节点会话、侧栏里的运行）修改的人：遇到界面问题时**怎么想、怎么查、怎么改、怎么验**。它总结了 2026-11 两轮界面整理（PR #338 及之后）的做法和踩过的坑。通用的颜色、字号、控件选择规则见[前端风格约束](../engineering/frontend-style.md)，本文不重复，只写工作流界面上的具体落法。

---

## 1. 先想清楚：从用户在做的事出发

不要从「这个页面哪里不好看」出发，要从「用户这时候想干什么」出发。改任何界面前，先说清楚它属于哪段流程、用户这时在看什么、要做什么决定、做完去哪。

### 1.1 用户的主要流程

| 流程 | 用户想做的事 | 关键界面 |
|---|---|---|
| 发起 | 选一个工作流，写需求，开始跑 | 工作流库 → 工作流详情 → 发起表单 |
| 跟进 | 看跑到哪了、谁在干什么、用了多久 | 运行页头、流程图、侧栏运行分组、节点会话 |
| 等你处理 | Agent 在问问题、关卡等确认、出错停下 | 运行页提示条、侧栏提醒胶囊、节点详情、处置页 |
| 出问题 | 重跑一步、跳过改道、从头重做 | 「去处理」→ 处置页 |
| 跑完 | 交付了什么、改了哪些文件、花了多久 | 完成提示条、总结页 |
| 管工作流 | 看流程图和源码、复制、导出、删除 | 工作流详情、全部运行 |
| AI 编辑 | 让 AI 新建或修改工作流，看改动再保存 | 「用 AI 新建 / 修改」→ 编辑会话 + 草稿页 |
| 多项目 | 在几个项目的运行间切换 | 侧栏各项目的运行分组、全部运行的「全部项目」 |

一次改动只要碰到其中某段，就沿着这段完整走一遍，而不是只看改的那个组件。

### 1.2 判断显眼程度：用户此刻的注意力在哪

- **要用户处理的事，一眼能看到。** 等回复、等确认、出错停下：运行页顶部提示条 + 侧栏提醒胶囊 + 分组置顶。用户不该需要去翻流程图找。
- **要用户确认什么，就把那个东西递到眼前。** 确认关卡提示条带「查看」，打开要确认的那一步；停到关卡时画布自动定位到它（在子流程里也回到它那一层），它所在的阶段不折叠。
- **用户能自己决定的事，直接让他做，不弹拦截。** 打开别的项目的会话就直接切过去；运行跑完提示一下，但不自动跳页打断他。
- **一屏只有一个主操作（蓝色）。** 其余是常规按钮、文字链接或收进「⋯」菜单。运行页头只放「当前最该点的那一个」：继续运行 / 去处理 / 停止。
- **不常用的收起来。** 再次运行、刷新、复制、导出、删除进「⋯」；需求原文、原始结果、错误码、给 Agent 的说明都折叠。
- **鼠标悬停才出现的操作很难被发现。** 主要操作不能只靠悬停（侧栏分组改成「点标题打开运行、点箭头展开」就是这个原因）。

### 1.3 说人话

界面上的每个字都要是用户认得的说法。走查时最常见的问题都在这里：

| 不要 | 要 |
|---|---|
| `workflow-artifact://d62e…`、`SHA-256 f773…` | 原文件名，可点开；哈希只留在「原始结果」里 |
| `design_doc_uri`、`write_file`、`max_visits` 等字段名、节点 id | 作者写的 `labels`，或按意思起的中文名 |
| 「结果待核验」「作废 1 条节点记录」「保留成果返工」 | 「已中断」「这些步骤会重做，之前的结果还留着」「在原结果上修改」 |
| 「Reviewer A」「dev 工作流」等内部名 | 「评审员 A」、工作流本身的名字 |
| 「已就绪」 | 「已完成」 |
| 「已运行 1 天 2 小时」（把停着的时间算进去） | 只算真正在跑的时间 |

同一件事全应用只用一个叫法（状态词集中在 `status/snapshot.ts` 的 `STATE_LABEL` 和 `statusLabel`，报错说明集中在 `status/errorText.ts`）。

### 1.4 信息不够时，改数据源，不要在界面上猜

界面要显示的东西如果引擎没给，就让引擎给：

- 产出文件只有快照地址 → 引擎快照里加 `artifacts`（地址 → 原文件），界面换成文件名；
- 侧栏节点会话顺序乱 → 引擎 `session-links` 按执行顺序输出；
- 出错停下的运行要置顶 → `session-links` 加 `failed`；
- 总结里缺代码文件 → 预置工作流里改代码的步骤在结果里声明 `files?: array`（标签「改动的文件」）。

引擎在 `desktop/workflow-engine-rs/`：服务端方法在 `src/bin/workflow_service.rs`，预置工作流在 `workflows/`，格式说明在 `docs/workflow-format.md`。

---

## 2. 怎么查：按流程在真机上走一遍

单元测试和截图都不能代替在真实应用里走一遍。

### 2.1 启动可被脚本操作的开发版

```bash
cd desktop
npm run workflow:build:debug            # 改过引擎时必须重新构建
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm run tauri dev
```

工作流引擎（`workflow_service`）是独立进程，前端热更新不会重启它。**改了引擎就要关掉应用和 `workflow_service` 进程再重开。**

开着调试端口后，可以用 Chrome DevTools 协议截图和操作页面。最小的截图脚本：

```js
// shot.mjs：node shot.mjs out.png
import { writeFileSync } from "node:fs";
const list = await (await fetch("http://127.0.0.1:9333/json")).json();
const ws = new WebSocket(list.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png" } }));
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id === 1) { writeFileSync(process.argv[2], Buffer.from(m.result.data, "base64")); process.exit(0); }
});
```

同样的方式用 `Runtime.evaluate` 可以点按钮、读文字、量元素尺寸。截图前先读一下 `innerWidth`/`innerHeight`：用户可能改过窗口大小，固定尺寸的截图会裁掉一部分，看起来像布局坏了。

### 2.2 走查要覆盖的状态

很多界面只在特定状态出现，必须真的跑出来看：

- 运行中（跟随、当前节点、子流程里的节点）；
- 等你回复（Agent 提问）；
- 等你确认（确认关卡，包括在子流程里结束、关卡在上层的情况）；
- 出错停下 → 去处理 → 重跑 / 从头重做 / 跳过；
- 跑完 → 完成提示 → 总结 → 产出文件；
- 用 AI 新建、修改、保存、再运行；
- 侧栏：新建几个会话后运行还在不在眼前；切项目；
- 窄右栏 / 完整视图；暗夜 / 暖白；默认字号和大字号。

真跑可以用预置的「AAW 轻量开发」（完整，约 20 分钟），或用 AI 新建一个两步的小工作流（约 1 分钟）专门制造某个状态。跑完核对测试项目里约定目录之外的文件没有被改动。

### 2.3 记录问题

每个问题记：在哪一步、看到什么、属于哪类（找不到 / 看不懂 / 步骤多 / 状态不清 / 不一致 / 布局挤）、多严重。然后分两类：

- **直接改**：明显的问题、和规范不一致、写错的状态。
- **找负责人定**：交互取舍、显眼程度、入口放哪、要动应用外壳或别的插件的。把每项的现状截图和两三个方案做成一个对比页（HTML），标出建议，让负责人选，不要替他决定。

---

## 3. 怎么改

### 3.1 一律用公共组件，插件里不自己画

工作流插件里不再自己写按钮、徽标、输入框、提示条的样式。对照表：

| 需要 | 用这个 | 位置 |
|---|---|---|
| 按钮（主 / 常规 / 弱 / 危险） | `primaryButton` `secondaryButton` `ghostButton` `iconButton`、`DangerButton` + `dangerSize` | `plugins/workflow/ui/buttons.ts`（只叠加尺寸，样式取自 `shared/ui/controls.tsx`） |
| 状态（已完成、运行中、已中断…） | `StatusWord`（内部是 `Badge` + `BadgeDot`） | `ui/WorkflowHierarchy.tsx`；语气映射 `STATE_TONE`、`runTone` 在 `ui/nodeText.ts` |
| 其他徽标（预置 / 我的、子流程、编译通过） | `Badge` | `shared/ui/controls.tsx` |
| 下拉选择 | `Listbox` | 同上 |
| 二选一 / 标签页 | `SegmentedControl` | `shared/ui/controls/SegmentedControl.tsx` |
| 勾选框、单选 | 视觉隐藏的原生 input + `CheckSquare` / `RadioDot` | `shared/ui/controls.tsx` |
| 单行 / 多行输入 | `settingsInputClass` / `settingsTextareaClass` | `shared/ui/SettingsPageParts.tsx` |
| 提示条（错误、警告、等你处理、完成） | `Callout` | `shared/ui/Callout.tsx` |
| 看起来是文字、点了会做事 | `TextLink`（文件路径加 `mono`） | `shared/ui/TextLink.tsx` |
| 展开 / 收起 | `Disclosure` | `shared/ui/Disclosure.tsx` |
| 删除、放弃、停止前的二次确认 | `InlineConfirm` | `shared/ui/InlineConfirm.tsx` |
| 面包屑 | `Breadcrumb`（长路径用 `scroll`） | `shared/ui/Breadcrumb.tsx` |
| 还没有内容 | `EmptyState` | `shared/ui/EmptyState.tsx` |
| 「⋯」更多菜单 | `MoreMenu` | `plugins/workflow/ui/MoreMenu.tsx`（基于 `shared/ui/ContextMenu.tsx`） |
| 复制 | `CopyButton` | `shared/ui/CopyButton.tsx` |
| 图标 | `shared/ui/icons.tsx` | 不要用 `×` `›` `↗` 这类字符当图标 |

**公共组件里没有的需求，不要在插件里先造一个。** 先找负责人确认，确认后在 `shared/ui` 新建，再把用法换过去，并补测试（参考 `tests/shared/feedbackControls.test.tsx`）。

### 3.2 样式表只管布局

`plugins/workflow/ui/workflowPanel.css`：

- 整个文件包在 `@layer components { … }` 里。Tailwind 的工具类在 `utilities` 层，层级更高，公共组件的样式才不会被插件样式盖掉。**不要把规则写到这个块外面。**
- 字号只用应用的字号档：`var(--text-ui-base)` `var(--text-ui-caption)` `var(--text-ui-sm)` `var(--text-2xs)`，它们跟随用户的字号设置。不写像素字号。
- 颜色只用语义 token（`--color-ink`、`--color-line`、`--color-warn-ink`…），暗夜和暖白两套主题自动成立。
- 写选择器时小心误伤：例如 `.workflow-run-list button` 会把行内二次确认的按钮也撑满整行，要写成 `li>button:not(.workflow-more)` 这样的具体选择器。
- 改完检查有没有规则已经没有组件在用，删掉。

### 3.3 已经定下来的布局约定

- **运行页头两行**：第一行标题 +「总结」+ 当前唯一的运行动作 +「⋯」；第二行状态、阶段进度、当前 / 停在哪一步、工作流名、用时、「需求」链接。
- **提示条**在页头下面，同一时刻只有一条（`RunView.tsx` 的 `bannerOf`），顺序：运行失败 > 等你回复 > 等你确认 > 阻塞。跑完且没有别的提示时显示绿色「已完成」+ 交付说明 +「查看总结」，可关闭，不自动跳转。
- **画布工具**（跟随、缩放、1:1、适应）浮在画布右下角；小地图在右上角；「回到当前节点」浮在画布可见区域底部居中（`GraphCanvas` 的 `tools` / `floating`）。
- **节点详情**：右栏宽时放在画布右边；窄时盖住整个画布，顶上有「返回流程图」。
- **卡片**：普通 Agent 节点不挂类型标签，只标出子流程、脚本这类特殊节点；预览图（还没运行）不写状态。卡片高度常量 `CARD_H` / `CARD_NOTE_H`（`WorkflowHierarchy.tsx`）要和卡片实际内容高度一致，改了卡片里的元素要重新核对，否则附注会被截掉。
- **阶段收起**：走完的阶段自动收起，但当前节点、选中节点、等确认的步骤所在的阶段不收。
- **侧栏运行分组**：组内会话按执行顺序、和画布同名；做完的收进「已完成」；进行中和带提醒胶囊（等你回复 / 等你确认 / 出错停下）的分组固定在项目最上面；点标题打开运行页并展开，点箭头只展开收起。
- **会话里工作流给 Agent 的说明**：用 `shared/workflowInstruction.ts` 的标记包起来，会话界面收成一行「工作流给 Agent 的说明」；标记之前的文字（如用户自己的要求）照常显示。新的说明要发给 Agent 时也照这个做。
- **用时**：只算真正在跑的时间（`status/timing.ts` 的 `runActiveMs`），停着的时间、被打断又作废的那一轮都不算；运行停下后，没结束的节点用时停在停下那一刻。

### 3.4 写给 Agent 的说明也是界面的一部分

Agent 在会话里回给用户的话，用户会直接读到。让 AI 编辑工作流时，规则里要求它「按步骤说这个工作流现在会怎么做，用用户能懂的话，不出现文件名、字段名和节点 id」（`plugins/workflow/editing/draftSessions.ts`）。改预置工作流时，结果字段都写 `labels`，节点名用中文。

---

## 4. 怎么验

### 4.1 必跑的检查

```bash
cd desktop
npm run typecheck
npm run lint                                    # CI 要求 0 个错误
npx vitest run tests/plugins/workflow tests/shared
cargo test --manifest-path workflow-engine-rs/Cargo.toml -- --skip real_icode   # 改了引擎或预置工作流时
```

改动碰到侧栏或会话时，再加上 `tests/plugins/project`、`tests/plugins/acpRuntime`。提交前跑一次完整的 `npx vitest run`；`tests/architecture` 会检查目录约定（例如 `src/contracts` 下只能有 `acp`）。

本机机器负载高时个别测试会超时，加 `--testTimeout=30000` 单独重跑确认；CI 用默认的 5 秒。

### 4.2 测试怎么改

- 界面变了，就按新的界面改断言（按钮名、提示文字、哪些是按钮哪些是文字），不要为了让旧测试通过而保留旧写法。
- 新行为补测试：用户能看到的结果（显示什么、点了发生什么），而不是内部实现。
- 测试里查找元素优先用角色和可读名称（`getByRole("button", { name: "开始运行" })`），这也顺带检查了可访问性。

### 4.3 真机核对

改完按 2.2 的相关状态在真机上再走一遍，对比改前改后的截图，暗夜 / 暖白、窄栏 / 完整视图都看一眼。最后让负责人在真机上验收。

### 4.4 提交

从 `main` 开 `codex/` 开头的分支，按主题提交，提 PR，等 CI 全部通过后合入。仓库是公开的：提交内容里不能有本机路径、用户名、调试产物和本机构建配置。

---

## 5. 踩过的坑

| 现象 | 原因 | 做法 |
|---|---|---|
| 换成公共按钮后样式没变 | 插件样式表在 Tailwind 层外面，优先级更高 | 样式表整体放进 `@layer components` |
| 小地图突然空白 | 小地图按卡片里的 `.workflow-status` 类给卡片上色，换组件时类名没了 | `StatusWord` 外层保留 `workflow-status state-*` 标记类；改卡片结构时检查 `ui/overview.ts` |
| 卡片附注被截掉一半 | 卡片内容变高，`CARD_H` 没跟着改 | 改卡片内容后重算高度常量 |
| 用时显示「1 天 2 小时」 | 把运行停着的时间、被作废那一轮的时间算进去了 | 用 `runActiveMs` |
| 处置后详情还停在被作废的那一轮 | 选中的轮次没有重置 | 处置完成后回到最新一轮 |
| 新建几个会话后运行从侧栏「消失」 | 运行分组和会话一起按时间排，被挤到「加载更多」后面 | 进行中和要你处理的分组置顶（`project/ui/sessionGroupLayout.ts`） |
| 返工那一轮会话里看不到说明，计时从上一轮算起 | 工作流发给 Agent 的说明没有进会话 | 工作流调用 `prompt(text, { echo: "workflow" })`，说明作为一条消息进会话并另起一轮 |
| 截图看起来布局坏了 | 窗口被调大了，截图还按旧尺寸裁 | 截图前先读窗口尺寸 |
| 改了引擎但界面上没变化 | 引擎进程没重启 | 重新构建并重启应用和 `workflow_service` |
| 用 shell 脚本写正则或路径后内容不对 | 部分 shell 会吞掉反斜杠 | 含反斜杠的编辑用编辑器或单独的脚本文件，不要内联在命令里 |

---

## 6. 代码地图

| 区域 | 文件 |
|---|---|
| 面板外壳、面包屑、路由 | `desktop/src/plugins/workflow/ui/WorkflowPanel.tsx` |
| 运行页（页头、提示条、画布、节点详情） | `ui/RunView.tsx` |
| 流程图（阶段、卡片、连线、子流程路径） | `ui/WorkflowHierarchy.tsx`、`ui/GraphCanvas.tsx`、`ui/Minimap.tsx`、`ui/overview.ts` |
| 节点详情与结果解读 | `ui/NodeDetail.tsx`、`ui/nodeDetail.ts`（`describeResult`、`tidyText`） |
| 处置页 | `ui/DisposePanel.tsx`、`ui/dispose.ts` |
| 总结 | `ui/RunSummaryPage.tsx`、`ui/runSummary.ts` |
| 工作流库、详情、发起、全部运行 | `ui/WorkflowLibrary.tsx`、`ui/WorkflowDetailView.tsx`、`ui/WorkflowLauncher.tsx`、`ui/RunManager.tsx` |
| AI 编辑 | `ui/AiEditSheet.tsx`、`ui/DraftPage.tsx`、`editing/draftSessions.ts` |
| 侧栏分组、节点会话回指条 | `ui/sessionGroups.ts`、`ui/WorkflowSessionBanner.tsx`；渲染在 `plugins/project/ui/ProjectTree.tsx`、`sessionGroupLayout.ts` |
| 状态词、报错说明、用时 | `status/snapshot.ts`、`status/errorText.ts`、`status/timing.ts` |
| 节点会话宿主（给 Agent 发说明） | `sessionHost/nativeSessionHost.ts` |
| 样式 | `ui/workflowPanel.css` |
| 引擎服务端、预置工作流 | `desktop/workflow-engine-rs/src/bin/workflow_service.rs`、`workflow-engine-rs/workflows/` |

## 7. 还没做的

- 首屏：没打开项目时看不到工作流，已有项目也只显示「添加项目」（应用外壳，暂缓）。
- 侧栏里大量「New session - 时间戳」的空会话（应用外壳）。
- 产出文件依赖节点声明；自己写的工作流如果不声明，总结里仍会缺文件。
- 等你回复（Agent 在会话里提问）这一状态的提示还没在真机上专门走查过。

更多缺口和计划见 [gaps.md](gaps.md) 与 [plan.md](plan.md)。
