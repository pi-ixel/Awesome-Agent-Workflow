# 讲解图插件（visual）

Agent 在回答里写一个 ```visual 代码块（HTML 片段），会话中直接渲染成统一风格的讲解图：结构示意、数据流、对比、分步过程、可调参数的小演示。

## 1. 目标

- **Agent 写得最少**：不调工具、不写样式和坐标。高层标签负责表达语义，基础样式、配色、深浅主题、窄屏换行都由应用负责。
- **渲染得最省**：默认走无 iframe 的内联路径；只有 Agent 写了脚本才进沙箱，而且按视口按需挂载。
- **风格统一**：所有颜色都来自应用语义 token，Agent 只能选语义 `tone`，或使用 `--v-*` 变量。

## 2. 装配

````text
Agent 回答 ──```visual──▶ MarkdownView(pre 映射)
                              │  按语言查 MarkdownCodeRenderers 上下文
                              ▼
                     VisualBlock（本插件）
              ┌───────────────┴────────────────┐
     无脚本：内联路径                    有脚本：沙箱路径
     Shadow DOM + 构造样式表             iframe sandbox="allow-scripts"
     套件元素注册在主窗口                srcdoc 内联套件 + 桥接脚本
````

- 契约：`src/shared/ui/markdown/codeRenderers.ts` 定义 `MarkdownCodeRenderer`（语言列表 + View）。工作台提供 `markdownCodeRenderers` 注册位，根组件 `WorkbenchWindow` 通过上下文把它下发给 `MarkdownView`。只有打开 `canUseCodeRenderers` 的 `MarkdownView` 才使用渲染器：会话里的 Agent 回答、嵌入的子会话、文件预览（Agent 写进 .md 的讲解图，含带脚本的沙箱图）。更新说明、工作流提示词等照常显示代码块。文件预览里的源码可能来自第三方仓库，安全边界与会话相同：内联图不执行脚本、拦截一切链接激活；沙箱图拿不到宿主与网络，打开链接只放行 http(s) 且限频。shared 层不依赖任何插件。
- 插件：`index.ts` 提供 `visual` 服务（接管的语言）并持有解析 / 高度缓存的生命周期；`ui/workbench.tsx`（`visual-workbench`）注入 `workbench` 与 `visual`，从服务读取语言并登记渲染器。`visual` 卸载时界面插件随之卸载、撤销登记，缓存同时清空。
- Agent 指导：仓库 `skills/visual-explain/SKILL.md`，随「AAW skills 安装器」装到 Agent。平时只有 description 常驻上下文，正文在用到时才加载。

## 3. 渲染

### 3.1 分流（`render/plan.ts`）

源码用 `<template>` 惰性解析，不加载资源、不执行脚本。按以下规则分流：

| 条件                                                                                                 | 路径                                                                                         |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 没有元素，或只有 br / b / i / code / span 等行内格式元素（Agent 自创的文本记法、写错围栏的 Mermaid） | 文本：按源码原样显示，只保留复制按钮                                                         |
| 含 `<script>`、`<form>`、任意 `on*` 属性、`javascript:` 链接（含 template 内部）                     | 沙箱                                                                                         |
| 其余                                                                                                 | 内联；丢弃 iframe / object / embed / base / meta / link / title 等会改动宿主或导航宿主的元素 |

解析结果以源码本身为键缓存（LRU 64），不会因哈希碰撞拿到别的图。用 SVG `<set>` / `<animate>` 改写链接地址（`attributeName` 含 href）也走沙箱。

### 3.2 内联路径

- 片段克隆进宿主 `div` 的 open Shadow DOM，外包一层 `.v-root`。
- 套件样式是一张共享的构造样式表（`adoptedStyleSheets`），所有讲解图共用。`:host` 把 `--v-*` 映射到应用 token，换肤时随 CSS 继承自动生效。
- v-* 自定义元素在首次渲染时注册到主窗口（只注册一次，之后随窗口存续，无法撤销注册）。
- 拦截一切链接激活：HTML / SVG 链接、图片热区 `<area>`、中键（`auxclick`）。主窗口永不导航，只有属性原文是 http(s) 绝对地址的才交给工作台用外部浏览器打开（SVG 的 `a.href` 是对象，统一读属性原文）；打开失败记日志。
- `content-visibility: auto` 让离屏的图跳过布局和绘制。

### 3.3 沙箱路径

- `sandbox="allow-scripts"`，不给 same-origin。页内 CSP 为 `default-src 'none'`，只放行内联脚本和样式，图片允许 data / blob / https。脚本拿不到宿主 DOM、Tauri 接口和网络。
- srcdoc 的结构依次为：`<head>` 中的主题变量（从宿主元素读取的具体值）、套件样式、桥接脚本（先于 Agent 脚本挂好错误监听）；正文为 Agent 片段；正文之后是 `fitVisualSvgs` 和 `installVisualKit`，两者都通过 `toString()` 与内联路径共用同一份代码。
- 桥接消息带 `__aawVisual` 标记。全窗口只挂一个 `message` 监听（`render/frameBridge.ts`），按来源窗口分发。消息只有三种：
  - `height`：ResizeObserver 上报的内容高度；
  - `error`：脚本异常，图右上角显示警示图标，悬停可看错误信息；
  - `open`：链接交给外部浏览器打开。脚本也能自己发这条消息，所以宿主只放行 http(s)，并且同一张图两次打开至少间隔 1 秒。
- 换肤 / 字号：通过 postMessage 推送新的变量值，不重载，脚本状态保留。宿主的 `color-scheme` 同步进 iframe，避免浏览器给 iframe 画不透明底。推送时机以根元素 class / style 的实际变化为准（全窗口一个 MutationObserver，同帧合并）：应用换肤走 View Transition，主题类在过渡回调里异步切换，跟随 React 状态采样会读到旧颜色。
- 生命周期：进入视口上下 600px 范围才创建 iframe；离开该范围 8 秒后卸载。高度按源码哈希缓存（LRU 300），卸载后用缓存高度占位，滚回时版面不跳。
- 高度上限 2400px，超出时 iframe 内部滚动。`100vh` 这类依赖视口的内容会与 iframe 高度互相推高，上限切断这个循环。

### 3.4 流式输出

围栏闭合前只显示骨架占位，不逐 chunk 渲染半截 HTML。传给渲染器的源码会去掉末尾换行，保证流式结束前后哈希一致。

流式结束时 `MarkdownView` 会从流式分块渲染切到静态渲染，整条消息的组件树重建（这是 MarkdownView 有意的收敛，规避 React #185）。因此契约多给一个 `isStreaming`：

- 沙箱图在消息流式期间只显示占位，消息结束后才创建 iframe。脚本只执行一次，用户刚开始的交互不会在结束那一刻被复位；
- 内联图照常边流边显示，结束时重挂只是一次 Shadow DOM 克隆。

## 4. 设计套件（`kit/`）

| 标签                 | 说明                                                                                                                                                                          | 属性                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `v-row` / `v-col`    | 横排 / 竖排。`v-row` 会按子元素构成估算横排所需的最小宽度（含条目的方框 170px、其他方框 140px、带标签的箭头 104px、无标签 64px、间距 12px），放不下就自动改竖排，箭头随之转向 | —                                                    |
| `v-grid`             | 网格，窄屏最多 3 列                                                                                                                                                           | `cols`，`repeat`（复制首个子元素）                   |
| `v-box`              | 区域卡片，标题居中                                                                                                                                                            | `title` `sub` `tone`                                 |
| `v-item`             | 条目行                                                                                                                                                                        | `icon` `title` `sub` `tone` `center`，或直接写子内容 |
| `v-arrow`            | 箭头，`v-row` 里横向（最小等宽 8em，结构相同的多行按列对齐），其他位置竖向；竖向箭头固定在中线，标签在左侧，多个箭头纵向对齐。字形按方向预定义为一条路径，箭杆端点与箭尖共点  | `label`，`dir`/`to` = down/up/left/both              |
| `v-icon`             | 线性图标（46 个，另有别名）                                                                                                                                                   | `name` `size` `tone`                                 |
| `v-tag`              | 胶囊标签                                                                                                                                                                      | `tone`                                               |
| `v-text` / `v-note`  | 说明文字 / 结论句                                                                                                                                                             | `left` / `tone`                                      |
| `v-tabs` > `v-tab`   | 视角切换                                                                                                                                                                      | `label` `active`                                     |
| `v-steps` > `v-step` | 分步讲解（上一步 / 下一步 / 进度点）                                                                                                                                          | `label`                                              |

- `tone`：`accent` / `good` / `warn` / `bad` / `muted`。文字色取应用的 info / ok / warn / danger 文字色；底色与描边在亮色下直接用应用的淡彩，暗色下以应用的暗色底为基础混入 16% 文字色提亮（`light-dark()` 按 `color-scheme` 取值）。应用的暗色状态底是为最底层设计的，直接放在卡片上会比卡片还暗、像凹陷，warn 与 bad 也难以区分。色调方框里的普通条目用同色调的极淡底。
- 变量：`--v-ink` `--v-ink-soft` `--v-mute` `--v-faint` `--v-line` `--v-surface` `--v-raised` `--v-base` `--v-accent(-bg/-line)` `--v-good(-bg/-line)` `--v-warn(-bg/-line)` `--v-bad(-bg/-line)`，系列色 `--v-c1` 到 `--v-c6`（即用量图表的系列色）。
- 普通元素（h1–h4、p、列表、table、code、button、input、select、a、hr）都有基础样式，所以 Agent 写的自由 HTML 也和应用风格一致。
- 自绘 SVG：最外层 `<svg>` 如果没写宽度或写了百分比，会按 viewBox 宽度作为实际宽度，窄屏等比缩小、不放大，避免文字被放大。`<text>` 没写 `fill` 时用正文色，写了就按它的值（CSS 不覆盖 Agent 指定的颜色）。

`v-row` 的判断只依赖自身宽度，改成竖排后宽度不变，所以不会来回切换。切换动作放在下一帧执行，避免 ResizeObserver 循环告警；离屏的内联图不做布局，滚进视口后才判断。

## 5. 实测

测试命令：`npx vitest run tests/plugins/visual tests/integration/visualExplain.integration.test.tsx`（单元与生产装配）与 `npx playwright test tests/visual/visualExplain.pw.ts`（Edge 真实渲染）。夹具 `tests/visual/visualExplainFixture.html` 的参数：`?theme=dark`、`?width=360`、`?only=<样例>`、`?perf=80`、`?perf=80&plain`（基线：同样内容按普通代码块渲染）、`?md=<地址>`（渲染外部 Markdown）。

性能（Edge，80 条消息，60 张内联图 + 20 张沙箱图，900×900 视口）：

| 指标                     | 讲解图        | 基线（普通代码块） |
| ------------------------ | ------------- | ------------------ |
| 首屏挂载                 | ≈ 195 ms      | ≈ 205 ms           |
| 逐条滚过全程的长任务     | 0             | 0                  |
| 主文档 JS 堆             | 27 MB         | 27 MB              |
| 滚完全程时存活的 iframe  | 20            | —                  |
| 离屏 8 秒后存活的 iframe | 2（视口附近） | —                  |
| 卸载后滚回的高度变化     | 0 px          | —                  |

所有沙箱 iframe 共用 1 个额外的渲染进程（站点隔离），只有会话里出现带脚本的图时才会产生。内联路径没有这项开销，这也是默认走内联路径的原因。

真实 Agent（Claude Code 无头模式，只附加 `visual-explain` skill，不给工具，2026-11-25）：

| 问题                         | 讲解图 | 写法                                   | 渲染路径 | 整个回答的输出 token |
| ---------------------------- | ------ | -------------------------------------- | -------- | -------------------- |
| HTTPS 证书在哪一步校验       | 1      | `v-steps` 4 步，每步为方框、条目和箭头 | 内联     | 3044                 |
| merge 与 rebase 对历史的影响 | 1      | `v-tabs` 3 页，内含自绘提交图 SVG      | 内联     | 2794                 |
| TCP 慢启动与拥塞避免         | 1      | 滑块和单选联动，脚本绘制 cwnd 折线     | 沙箱     | 4965                 |
| setState 到页面更新          | 1      | `v-steps` 5 步                         | 内联     | 2305                 |
| ACP / MCP 数据流转           | 1      | `v-steps` 5 步，三栏结构               | 内联     | 2615                 |
| Python 列表反转              | 0      | 只给代码                               | —        | 412                  |

- 6 个问题中，5 个画了 1 张图，不该画的问题没有画。没有出现不认识的标签，也没有写死色值。
- 发现的问题都已在套件里修复，不需要 Agent 改变写法：
  - 三栏加长箭头标签的横排把内容挤成逐字换行 → `v-row` 自动改竖排，箭头标签允许换行；
  - 自绘 SVG 写 `width="100%"` 导致文字被放大 → 按 viewBox 宽度显示；
  - 胶囊标签在方框里被拉伸成整行 → 居中显示。

真实应用（`npm run tauri dev`，Agent 为 OpenCode + deepseek-v4.1-flash，2026-11-25）：

| 问题                       | 结果                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| 容器与虚拟机的分层差别     | 两栏 `v-box` 对比，430px 窄栏下排版正常                                 |
| K8s 外部请求到 Pod         | 1 张图：分阶段 `v-box` 配不同 tone，入口层内嵌 `v-tabs`；标签切换可用   |
| merge 与 rebase 的历史变化 | 3 张自绘提交图 SVG（内联）                                              |
| 复利：本金 / 利率 / 年限   | 沙箱：3 个滑块 + 结果卡 + 复利 / 单利曲线；拖动实时重算，换肤后状态保留 |
| Python 列表反转            | 不画，只给代码                                                          |

打开会话时讲解图相关脚本合计约 2.4 ms（CPU 采样）；含 1 张大套件图的会话，切换时的长任务与无图会话相当（开发构建下 100–140 ms，主要是 React 开发运行时与 Markdown 解析）。

实测发现并修复：

- 应用换肤走 View Transition，沙箱图读到旧主题、停在旧配色 → 改为观察根元素实际变化后推送（夹具的切换按钮也改为异步切主题类，覆盖这条回归）；
- `<text fill="var(--v-accent)">` 被套件 CSS 覆盖成正文色 → 只给没写 `fill` 的文字设默认色；
- 顶层或标签页里的 `v-arrow` 默认横向且靠左 → 不在 `v-row` 里就竖向，并居中；
- skill 没加载上时，模型自创 `flow LR …` / `steps …` 这类文本记法写进 ```visual，被挤成一段 → 分流出“文本”路径，按源码原样显示。

触发与分发（需要另行决定，未在本插件内处理）：

- 只靠 skill 描述，弱模型在普通问答里不会主动调用 skill 工具，照旧用 ASCII 画图；在项目指令（AGENTS.md）里加一句“需要示意图时先加载 visual-explain”后稳定触发。渲染器在应用侧，由应用向会话注入这句能力提示是更可靠的做法，但目前各 Agent 没有统一的注入通道。
- 内置的 OpenCode 不读 AAW 技能安装器的目标目录（`%APPDATA%/chrys/skills`，iCode 用），mermaid-diagram 等 AAW skill 在 OpenCode 下同样找不到；OpenCode 的技能表在进程启动时缓存，技能目录中途变更要重启 Agent 进程。

## 6. 已知取舍

- 内联图在消息流式结束时会重挂一次，期间切过的标签页 / 步骤会回到初始页。

- 沙箱 iframe 卸载后，脚本状态（例如滑块位置）会丢失，滚回来时恢复初始状态。
- 自定义元素注册后无法撤销；插件卸载只撤销渲染器登记，已经注册的 v-* 元素随窗口存续，且不再被使用。
- 内联路径允许加载 https 图片，与 Markdown 图片的行为一致。
