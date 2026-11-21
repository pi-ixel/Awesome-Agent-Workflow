/**
 * 写给 AI 的手册（运行时版本）。
 *
 * 落点是工具项目里的 `AGENTS.md`——ACP agent 每个会话都会读它，所以它比"在
 * 聊天里贴一段提示词"可靠：用户关掉窗口、换台机器、下周再来，契约还在。
 *
 * 完整版在仓库 `skills/tool-dev/SKILL.md`（给人看、给技能安装器用）；这里是
 * 精简版，红线表由 `rules.ts` 生成，保证两边编号永远一致。
 */
import { platformFrameworkFiles, ruleGuidance, ruleIds, type RuleId } from "./rules.ts";
import { toolContractVersion } from "./contract.ts";
import type { ToolViolation } from "../types.ts";

export interface ToolGuideContext {
  readonly id: string;
  readonly name: string;
}

function ruleTable(): string {
  return [
    "| 编号 | 级别 | 规定 | 怎么改 |",
    "|---|---|---|---|",
    ...ruleIds.map((id: RuleId) => {
      const entry = ruleGuidance[id];
      return `| ${id} | ${entry.level} | ${entry.rule} | ${entry.fix} |`;
    }),
  ].join("\n");
}

/**
 * 「平台框架」保留文件名清单，直接读校验器 R9 用的同一份常量。
 * 手册与代码共用一份数据，就不会出现"手册说不能改、校验器却不认"的漂移。
 */
function frameworkFileList(): string {
  return platformFrameworkFiles.map((name) => `\`${name}\``).join("、");
}

/**
 * 工具项目的 AGENTS.md 正文。
 *
 * 只写"这个项目里必须遵守什么"，不写产品背景——AI 不需要知道 AAW 是什么，
 * 它需要知道往哪写文件、能用什么 API、什么会让安装失败。
 */
export function toolGuide(context: ToolGuideContext): string {
  return `# ${context.name} · AAW 工具项目

${guideBody(context)}
`;
}

/**
 * 人读版：工具中心里那份「开发指导」窗口的正文。
 *
 * 与 `toolGuide()` 共用 `guideBody()`，所以窗口里看到的内容和写进项目
 * `AGENTS.md`、AI 技能目录的文字永远一致——两处各写一份，迟早会互相矛盾。
 */
export function toolGuideMarkdown(): string {
  return `# 工具开发指导

这份文档既是给人看的手册，也是平台写进工具项目 \`AGENTS.md\` 和 AI 技能目录的同一份规范。你看到的和 AI 读到的是同一段文字。

## 从这里开始

- **做一个新工具**：工具中心 →「开发工具」→ 写下需求 → 开始做。
- **改一个已有的**：同一个标签页里点项目的「继续开发」。
- **做完了**：面板会自动校验，通过后点「确认安装」。
- **不想让 AI 做**：项目目录里的 \`manifest.json\` 与 \`index.html\` 就是全部源码，直接改，改完点「我改完了，重新校验」。

## 在项目里工作时

${guideBody({ id: "<工具 id>", name: "<工具名>" })}
`;
}

/** 两个入口共用的正文：项目落点、清单结构、运行时能力、红线、交付流程。 */
function guideBody(context: ToolGuideContext): string {
  return `你在一个 AAW 个人工具项目里工作。工具 id 是 \`${context.id}\`，目录就是当前工作区。
技术细节（存储、布局、清单字段怎么写）按下面这份契约定，不要拿去问用户；但**需求本身**要先和用户对齐——见下一节。

## 动手前：先对齐需求，再写代码

用户的需求往往只有一句话，直接开写十有八九做出来不是他要的。按这个顺序来：

1. **先复述再动手**：用自己的话讲清"这个工具给谁用、输入是什么、输出是什么、用户最高频的那一步是什么"，请用户确认后再写代码。需求已经写得足够具体时，可以在一条回复里完成复述与实现，把你的假设列出来供用户核对。
2. **有歧义一次问完**：把问题凑齐一次问，不要挤牙膏式逐条确认。
3. **先做最小版本**：核心流程能跑通就先交付验收，再按反馈扩展；不要一上来堆用户没要的功能，也不要为了让工具"显得完整"加装饰性模块。
4. **改已有工具时同理**：先弄清用户要改的是哪个行为、期望的新行为是什么，再动代码。

## 一个工具是什么

一个**随叫随到、独立完成一件事**的小程序：有自己的窗口界面，能从工具中心或启动器一键打开，也能被 AI 通过命令调用。它不是一个网页，也不是一个需要部署的服务——更接近 uTools 里的插件：打开就用，用完就走，中间的状态能留到下次。

工具能做的事远比「格式化一段文本」多，常见的几类：

| 场景 | 例子 |
|---|---|
| 文本与数据处理 | JSON / YAML 格式化与互转、正则测试、批量改名、编码解码、Markdown 转表格 |
| 剪切板与输入增强 | 剪切板历史、复制后自动去格式或转大写、常用短语速查、颜色值转换 |
| 计算与查阅 | 时间戳换算、进制与单位换算、哈希与二维码、内网接口状态速查 |
| 文件与小批处理 | 打开一个文本、清洗内容、再存成新文件；把一批文本合并导出 |
| 个人留存 | 待办清单、随手记、常用配置、最近用过的输入（走 \`aawStore\`） |

它能读写系统剪切板、读写用户亲手选的文件、把数据留到下次打开、按声明联网访问 http/https，在你声明之后还能常驻后台与弹提醒。需要第三方库时，把纯 JS 依赖打进一个 \`app.js\`（见下面「带依赖的工具」）。**不能**读任意本地路径、不能调用摄像头或录屏——平台把这些挡在沙箱外面，是为了让一个 ZIP 能在别人机器上直接装、直接跑。

技术上的边界：默认形态是自包含的 \`index.html\`（HTML/CSS/JS 都在里面），\`manifest.json\` 描述身份、动作、设置与能力。**要带纯 JS 依赖时多一个 \`app.js\` 构建产物**（源码放 \`src/\`，带不带随你）；**确实需要进程、原生模块或非 HTTP 协议时**才用 \`bin/\` 自带运行时，那条路会放弃沙箱。不是多页面站点。**必须至少声明并实现一个动作**（红线 R3）：界面上的按钮和 \`aawActions\` 里的函数是同一件事，人和 AI 走同一条路。

## 项目结构

- \`manifest.json\`：身份、动作、设置、能力声明（**你主要编辑它**；\`html\` 字段留空）
- \`index.html\`：界面入口，运行时**以它为准**（**你主要编辑它**；界面只写这一处，不要同时写进清单的 html 字段）
- \`app.js\`：可选，L2 的构建产物。清单里写 \`"build": { "out": "app.js" }\`
- \`src/\`：可选，你的源码。平台不读它、不校验它，带不带由你决定
- \`bin/\`：可选，L3 的运行时（可执行文件 + 它自己的依赖）。清单里写 \`"runtime": { "kind": "process", … }\`
- \`NOTES.md\`：可选，写设计取舍
- \`AGENTS.md\`：本文件，平台生成；你没有它也不许自己新建（见下节 R9）

## 带依赖的工具

### 先用 L2：把纯 JS 依赖打进 app.js（推荐）

需要 npm 上的纯 JS 库（\`exceljs\`、\`marked\`、\`sql.js\` 这类）时：

1. 在工具目录里 \`npm install exceljs\`。
2. 源码写在 \`src/main.js\`，然后打一次包：

\`\`\`bash
npx esbuild src/main.js --bundle --format=esm --minify --outfile=app.js
\`\`\`

3. \`manifest.json\` 里写：

\`\`\`json
"build": { "entry": "src/main.js", "out": "app.js", "command": "npm run bundle" }
\`\`\`

4. \`index.html\` 里用 \`<script type="module" src="./app.js"></script>\` 引进去。

**三个键的地位不一样，别记混**：\`out\` 是运行时的唯一依据（它必须存在，否则装不上）；\`entry\` / \`command\` 只是"我是怎么构建的"的作者备注，平台不读取、不执行、也不检查对应文件在不在。

\`\`\`js
// src/main.js
import ExcelJS from "exceljs";

export async function buildSheet(rows) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("导出");
  sheet.addRows(rows);
  return book.xlsx.writeBuffer();
}
\`\`\`

**L2 能覆盖什么**：Excel / CSV、Markdown 渲染、加密与签名（\`crypto.subtle\`）、
SQLite（\`sql.js\` 的 WASM 版）、图像处理（canvas + WASM）、重计算（Web Worker）、
HTTP 请求（\`fetch\`）。**代价**：作者要会跑一条命令。脚手架可以预置
\`npm run bundle\`；AI 生成时也会把这条命令写好。

\`src/\` 带不带是你的自由：愿意公开就把源码放在里面，不愿意就只发 \`app.js\`——
红 R10 只会给一条提醒，不影响安装与运行。

### 真的需要进程时：L3（\`bin/\`）

只有下面四条满足其一才允许用：

1. 要用**原生模块**（\`.node\` 文件）；
2. 要**非 HTTP 协议**：TCP / UDP / SSH / 数据库直连；
3. 要**不受对话框约束的文件系统**：遍历、监听、批量改写；
4. 要**真正无窗口的常驻进程**（普通工具的 \`keepAlive\` 只是"窗口隐藏"）。

\`\`\`
<工具目录>/
├── manifest.json
├── index.html          ← 可选。纯后台工具可以没有
└── bin/
    ├── run.exe         ← 你自带的运行时 + 依赖，平台不认识它是什么
    └── ...
\`\`\`

\`\`\`json
"runtime": { "kind": "process", "entry": "bin/run.exe", "protocol": 1 }
\`\`\`

进程用 **NDJSON over stdio** 与宿主通信（一行一条 JSON，和 MCP / LSP 同一个形态，
\`echo '{...}' | ./bin/run\` 就能手工调试）：

| 方向 | 方法 | 参数 | 返回 |
|---|---|---|---|
| 宿主→工具 | \`initialize\` | \`{ protocol, capabilities }\` | \`{ protocol, actions: [...] }\` |
| 宿主→工具 | \`invoke\` | \`{ action, input }\` | \`{ ok: true, value }\` 或 \`{ ok: false, error }\` |
| 宿主→工具 | \`event\` | \`{ topic, payload }\` | 无（通知） |
| 宿主→工具 | \`shutdown\` | — | 进程自行退出 |
| 工具→宿主 | \`aaw.call\` | \`{ cap, fn, args }\` | \`{ ok, value }\` |
| 工具→宿主 | \`aaw.emit\` | \`{ topic, payload }\` | 无 |

**动作语义与页面载体完全一致**：20 秒超时、返回 ≤ 512 KB、同一输入重复调用结果相同。
所以工具中心、启动器、AI 调用、导出校验对你用哪种载体一无所知。

**三条硬限制，缺一条它就变成纯负资产**：

- **显式声明**：\`runtime.kind === "process"\`，导入时单独一屏告诉用户"这个工具会启动独立进程，拥有你账户下的文件与网络权限"，并点名包里所有可执行文件。
- **体积单列**：\`bin/\` 不计入 4 MB 源码限额，但导入时会把真实体积显示出来。
- **AI 不许生成 L3**（红线 R11）：许愿链路只产出 L1/L2；进程入口必须人工写、人工审。

L3 里 \`store\` / \`sharedStore\` / \`secrets\` / \`settings\` 这四项**必须走宿主**
（\`aaw.call("store", …)\`）——数据的所有权在平台，自己写等于卸载时清不掉。

## 什么是内核、哪些不许改（R9）

工具由两部分组成：**你写的工具自己**，和平台提供的**内核**。内核指工具运行依赖、但不属于工具包的一切，具体是：

- 工具窗口的 \`aaw-tool://\` 协议、CSP 沙箱、独立 origin；
- 下面「运行时能力」一节列出的全部 \`window.aaw*\` 注入入口；
- 平台生成的契约文件：项目里的 \`AGENTS.md\`、导出 ZIP 里的 \`README.md\`；
- \`manifest.json\` 的字段名、\`schemaVersion\`、\`id\` 规则，以及「界面以 \`index.html\` 文件为准」这些约定。

内核由每台机器上的宿主在运行时提供（桌面端的 Rust 工具载体），**严禁修改、伪造或绕过**：

- 不要覆盖或伪造任何 \`window.aaw*\` 注入；
- 不要把内核文件复制、改写进工具包，也不要另造同名文件（保留名清单：${frameworkFileList()}）；
- 不要在 html 里写死本机绝对路径或 \`file://\` 地址来替代内核入口——要访问外部资源走 \`aawFiles.open\` 让用户当场选；
- 不要在代码里判断宿主版本或写"为未来版本兼容"的分支，内核怎么演进是平台的事。

改了内核的工具等于绑死一台机器、一个宿主版本，别人导入后要么装不上要么行为不一致（校验器 R9 会拦下夹带内核文件与写死本机路径的包）。

**你能改的**：\`manifest.json\` 里的字段值、\`index.html\` 的全部内容、自己写的附加源码与 \`NOTES.md\`。仅此而已——其余都是内核的事。

## manifest.json

\`\`\`json
{
  "schemaVersion": 1,
  "id": "${context.id}",
  "name": "${context.name}",
  "version": "1.0.0",
  "icon": "表",
  "html": "",
  "actions": [
    { "id": "run", "description": "一句话说明", "inputSchema": { "type": "object", "properties": {} } }
  ],
  "settingsSchema": [
    { "id": "indent", "label": "缩进空格数", "type": "number", "default": 2, "min": 0, "max": 8 }
  ],
  "permissions": { "network": false }
}
\`\`\`

- **必填**：\`schemaVersion\`（固定 1）、\`id\`、\`name\`（不超过 60 字）、\`version\`，以及界面本身（写在 \`index.html\`）。其余字段全部可选。
- \`id\`：项目里已经定好，**不要改**（R1）。命名规则：小写字母或数字开头，只能含小写字母、数字、点和短横，最长 64（如 \`json-formatter\`）。新建工具时按此规则自拟。
- \`html\`：**项目里留空即可**——运行时以 \`index.html\` 文件为准，界面只写 index.html 一处，避免两份不同步。只有在没有项目目录、直接交付一个 JSON 包时，才把整页 HTML 转义进这个字符串（引号、换行、反斜杠都要转义，手写极易错，建议用脚本生成）。
- \`icon\`：可选，1–2 个字符（一个 emoji 或字母/汉字），缺省取名称首字。
- \`settingsSchema\`：可选。\`type\` 只能是 text / number / boolean / select；select 的 \`options\` 是 \`{ "label": "显示名", "value": "值" }\` 数组。
- \`background\`：可选。声明常驻/定时才写：\`{ "reason": "剪切板历史", "schedule": true }\`（\`schedule\` 省略表示只常驻不定时）。
- \`build\`：可选，L2 的构建声明：\`{ "entry": "src/main.js", "out": "app.js", "command": "npm run bundle" }\`。**运行只认 \`out\`**；\`entry\` / \`command\` 是给人看的备注，平台不读、不执行、不检查文件是否存在。
- \`runtime\`：可选，L3 的进程声明：\`{ "kind": "process", "entry": "bin/run.exe", "protocol": 1 }\`。\`entry\` 必须在 \`bin/\` 内。**AI 生成时出现它就装不上（R11）。**
- \`author\` / \`source\`：可选，作者名与来源链接，分享别人的包时用于判断可信度。

**没有 \`preload\` 这个字段了。** 第 2 代契约删掉了 Node 侧桥接层：出现 \`preload\` 会直接装不上。纯 JS 依赖走 \`build\`，需要进程走 \`runtime\`。

## 运行时能力

下面每一项在两种载体里都有，只是调用方式不同：页面载体（L1/L2）注入到 \`window\`；
进程载体（L3）走 \`aaw.call(能力名, 方法, 参数)\`。**动作语义完全一致**——20 秒超时、
返回 ≤ 512 KB、同一输入结果相同。

**下行**（宿主 → 工具，注入到 \`window\` 上）：

1. \`window.aawSettings\` — 只读设置对象，键是 settingsSchema 的 id。**L3 必须走宿主**（\`aaw.call("settings", "read")\`）：设置存在工具中心的库里，自己读那一份用户改不了。
2. \`window.aawStore\` — \`await set(k,v) / get(k) / delete(k) / keys()\`，按工具+用户隔离、**跨重启保留**；单值 ≤ 256 KB、整个工具 ≤ 5 MB，超限 \`set\` 会抛错（先清理再写）。\`aawStore.scope("shared")\` 是用户级共享区：多个工具能看到同一份数据，适合"A 工具产出、B 工具消费"。**L3 必须走宿主**：自己写文件卸载时清不掉。
3. \`window.aawFiles\` — \`await open({ accept, multiple, directory, binary })\`：
   - 默认返回 \`{ name, path, size, text }\`，取消返回 \`null\`；
   - \`multiple: true\` 返回数组（最多 32 个）；
   - \`directory: true\` 返回 \`{ name, path, isDirectory: true, entries: [{ name, isDirectory }] }\`，只列顶层、最多 200 条；
   - \`binary: true\` 返回 \`bytes\`（ArrayBuffer，上限 32 MB）而不是 \`text\`；
   - \`await save(name, data)\`：\`data\` 可以是字符串或 ArrayBuffer，上限 8 MB；
   - \`onDrop(list => …)\`：用户把文件拖进窗口时触发，每项带 \`token\`，用 \`await aawFiles.read(token)\` 取内容。
4. \`window.aawClipboard\` — \`readText()\` / \`writeText(text)\`（上限 1 MB）；\`readImage()\` 返回 \`{ png: ArrayBuffer } | null\`；\`writeImage(bytes)\` 写图片。写入不需要用户手势，读取仍要遵守下面的时机规则。
5. \`window.aawSystem\` — \`info()\` 给 \`{ platform, arch, osVersion, cpus, totalMemory, freeMemory, homedir, tmpdir }\`；\`disk()\` 给 \`{ total, free }\`。**只读白名单**，没有进程列表、没有环境变量全集。
6. \`window.aawSecrets\` — \`set(k,v) / get(k) / delete(k)\`，走系统加密存储（Windows DPAPI / macOS 钥匙串），**不落明文**。API Key、Token 放这里，不要写进 html 或 \`aawStore\`。**L3 必须走宿主**：系统加密只有宿主有。
7. \`window.aawLifecycle\` — \`notify(title, body)\` 弹系统通知；\`keepAlive({ reason })\` 声明常驻——**声明后**用户关窗只是隐藏、进程继续，可从托盘或工具中心「⋯ → 停止后台运行」彻底停掉；**不声明 keepAlive 的工具，关窗就是退出**。\`schedule(seconds)\` 定时唤醒（至少 60 秒，更小会失败）配 \`onSchedule(cb)\` 收回调。常驻与定时必须在清单 \`background\` 里声明（格式见 manifest 一节），否则视为未申请——\`reason\` 写清楚为什么需要常驻，别把常驻当成用户看不见的事。
8. \`window.aawContext\` — \`selection\`（唤起时可用的文本，没有就是空串）、\`origin\`（\`hotkey\` / \`launcher\` / \`action\`）、\`probe()\` 主动再取一次。需要它就在清单写 \`"needsSelection": true\`。
9. \`window.aawBus\` — \`emit(topic, payload)\` / \`on(topic, cb)\`，工具之间在线广播，**不保留历史**（对方不在线就收不到）。

**上行**（工具 → 宿主）：

10. \`window.aawActions\` — \`{ [actionId]: async (input) => 结果 }\`，界面上按钮必须调用同一个函数；20 秒内返回、结果 < 512 KB、幂等（同一输入重复调用结果相同，平台在用户重试时会再次调用）。进程载体的动作在 \`initialize\` 的返回里声明，收到 \`invoke\` 时回 \`{ ok, value }\`。

补充规则：

- **联网默认可用**。\`permissions.network\` 是声明给用户看的：写 \`true\`（会联网）、\`false\`（承诺不联网）、\`{ "hosts": ["*.corp.example.com"] }\`（限定域名）；访问自签证书的内网接口再加 \`"insecure": true\`（安装时会提示用户）。会联网的工具请声明，让用户知情。**进程载体不受 CSP 约束**——这是 L3 的真实代价，导入时会明说。
- \`requires\`：\`{ "contract": ${toolContractVersion}, "capabilities": [...] }\` 说明最低要求，不写就宽松放行；写了之后，满足不了的宿主会显示说明页而不是白屏。**能力名只能是这十二个**：settings、store、sharedStore、files、clipboard、actions、system、secrets、lifecycle、context、bus、network（前十个与 \`window.aaw*\` 名一一对应；\`network\` 是声明式授权，没有 window 入口）。**当前契约代际是 ${toolContractVersion}。**
- 分清两种「记住」：\`settingsSchema\` 是用户在工具中心能改的配置（代码里经 \`aawSettings\` 只读）；\`aawStore\` 是工具自己记的状态，用户看不见，不要拿来当设置项（R4）。
- 密钥的推荐路径：运行时让用户输入一次 → \`aawSecrets.set\` 存下 → 以后 \`aawSecrets.get\`。不要写进 html、清单或 \`aawStore\`（R5）。
- \`navigator.clipboard\` 也能用，但它要求用户手势、在 AI 执行的动作里拿不到；优先用 \`aawClipboard\`。
- \`localStorage\` 也能用，但它活在内存分区，AAW 重启会清空——要留存就走 \`aawStore\`（R6）。
- 读剪切板只在用户点击或动作被显式调用时做，不要在页面一加载就静默读取。
- 布局不要给容器写死固定像素宽度：用 \`width:100%\` + \`max-width\`。红线 R7 查的是 ≥800px 的写死宽度，但任何写死宽度在窄窗口（最小约 360px）都会坏；宽内容（表格、代码行）放进自身 \`overflow-x: auto\` 的容器里滚动，不要撑破页面。

## 红线

${ruleTable()}

## 交付流程

1. 界面写 \`index.html\`，其余声明写 \`manifest.json\`（\`html\` 留空）。
2. 用户在工具中心面板看校验结果：保存文件后回到面板即可，必要时点「我改完了，重新校验」。
3. 校验回给你的条目分两级：\`必须修\`（= 红线表里的 block）就按"怎么改"修掉，\`建议\`（warn）按情况采纳。
4. 校验通过后平台生成预览，用户点验收才真正安装。
5. 不要为了让校验通过而删掉功能；宁可改实现方式。

## 自检（提交前逐条过）

- [ ] 交付的功能范围就是用户确认过的，没有私自加减
- [ ] 没有覆盖或伪造任何 \`window.aaw*\` 注入，也没有把内核框架文件带进工具包
- [ ] 清单里没有 \`preload\` 字段；带依赖时 \`build.out\` 指向的产物确实在目录里
- [ ] 没有自己造 \`bin/\` 进程（那是人工接手的路径，R11）
- [ ] 没有任何远程引用（http / https / 协议相对地址）；用相对路径引用自己目录里的文件可以
- [ ] 界面只写在 \`index.html\`，清单的 \`html\` 字段留空
- [ ] 每个 action 在 \`aawActions\` 里都有同名函数，界面按钮复用同一函数
- [ ] 需要留存的数据走 \`aawStore\`；要跨工具共享才用 \`aawStore.scope("shared")\`
- [ ] 用到剪切板时是用户主动触发的，不是打开就偷偷读
- [ ] API Key / Token 走 \`aawSecrets\`，没有硬编码在 html 或 manifest 里
- [ ] 用到的能力名写进了 \`requires.capabilities\`，名字来自上面那份十二个的名单
- [ ] 需要常驻或定时的话，在 \`background\` 里声明了，理由写得让人看得懂
- [ ] 会联网就声明了 \`permissions.network\`（会联网 true / 不联网 false / 限域名写 hosts）
- [ ] 空输入 / 超长输入 / 非法输入都有提示，不会白屏（代码里每个分支都有返回）
- [ ] 容器没有写死像素宽度，宽内容在 \`overflow-x: auto\` 的容器里滚动（渲染效果让用户在预览里确认）
`;
}

/**
 * 装进 agent 技能目录的 `SKILL.md`。
 *
 * 项目里的 `AGENTS.md` 只在那个工具项目内生效；用户在**普通会话**里让 AI
 * 顺手做个工具时，AI 看不到规范，产出的包往往装不上。把同一份正文加个
 * frontmatter 写进 `chrys/skills/tool-dev/SKILL.md`，全局会话才认得这套契约。
 */
export function toolGuideSkill(): string {
  return `---
name: tool-dev
version: "1.0.0"
description: 在 AAW 平台上开发个人工具的完整规范。当用户说"我想要一个能……的工具"、需要新建或修改工具项目、或工具校验失败需要修复时使用。包含动手前先与需求方对齐的方法论、工具能做什么（文本处理、剪切板、文件、留存、联网等场景）、项目结构、清单字段、能力入口与联网声明、什么是内核与严禁修改的约束（R9）、红线与交付前自检。
---

${toolGuide({ id: "<工具 id>", name: "<工具名>" })}

## 在普通会话里被要求做工具时

1. 先问一句"要不要在工具中心新建一个项目"——建项目会自带本规范与预览、安装链路，id 也由平台分配。
2. 如果用户只是要一段代码，就把 \`manifest.json\` 与 \`index.html\` 一起给出，并在结尾附上红线自检结果。此时 id 没人分配，按 manifest 一节的命名规则自拟，并明确告诉用户把这两个文件放进哪个目录。
3. 默认不要引入构建步骤：单文件 \`index.html\` 就够了。确实需要第三方库时走 L2：\`npx esbuild src/main.js --bundle --format=esm --minify --outfile=app.js\`，然后在清单里写 \`build.out\`。不要让用户去装 Node 生态、也不要写 \`preload.js\`（那个字段已经删了）。需要进程/原生模块时停下来问人，不要自己造 \`bin/\`。
`;
}

/** 用户描述需求后发给会话的第一条消息：用户原话 + 落点指引，不夹带技术细节。 */
export function briefMessage(brief: string, context: ToolGuideContext): string {
  return `我想做一个工具：${brief}

项目已经建好了（id: \`${context.id}\`），请先读项目里的 AGENTS.md，然后在当前目录里写 \`manifest.json\` 和 \`index.html\`。
先说明你打算怎么做，再动手。`;
}

/** 校验失败时回灌给会话的消息：只带必须修与建议，AI 照着改。 */
export function repairMessage(problems: readonly ToolViolation[]): string {
  const lines = problems.map((problem) => {
    const where = problem.where ? `（${problem.where}）` : "";
    return `- [${problem.ruleId}][${problem.level === "block" ? "必须修" : "建议"}]${where} ${problem.message}\n  改法：${problem.hint}`;
  });
  return `平台校验没通过，请按下面逐条修改后继续（不要删功能，改实现方式即可）：\n\n${lines.join("\n")}`;
}

/** 校验通过的收尾消息。 */
export function acceptedMessage(tool: { readonly name: string; readonly version: string }): string {
  return `校验通过：${tool.name} v${tool.version} 已生成预览，等用户验收。`;
}
