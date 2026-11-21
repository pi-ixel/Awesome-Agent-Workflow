/**
 * 工具红线检查。
 *
 * 每条规则对应 AI 开发手册（`skills/tool-dev/SKILL.md`）里的一个编号，两边的
 * 编号集合必须一致——手册写了但代码不查，手册三个月后就是谎话；代码查了但手册
 * 没写，AI 就会一头雾水地反复踩同一个坑。`rules.test.ts` 会断言这一点。
 *
 * 分级只有两种：`block` 装不上（结构性问题，装上去也跑不起来）、`warn` 只提醒
 * （能跑，但有代价）。产品决定是"尽量不约束"，所以能 warn 的绝不 block。
 */
import type { ToolPackage, ToolViolation } from "../types.ts";

export const ruleIds = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11"] as const;
export type RuleId = (typeof ruleIds)[number];

/**
 * 平台框架与契约文件的保留名（R9）。
 *
 * 这些文件支撑工具运行，但由**每台机器上的宿主**提供，不属于工具包：
 * `tools-runtime/` 里的协议/CSP/能力注入与启动器、Tauri 侧 `tools_runtime.rs`、
 * 平台生成的 `AGENTS.md`。把它们复制进 `sourceFiles` 既不会被加载，又会让这个
 * ZIP 绑死某一版宿主——换个环境就装不上或跑不对，工具也就没法在平台上传播。
 *
 * 手册正文（`guide.ts`）直接读这份清单生成"不可改动的文件"表，保证"文档写的"
 * 和"校验器查的"永远是同一组名字，不各维护一份。
 */
export const platformFrameworkFiles: readonly string[] = [
  "AGENTS.md", "runtime.mjs", "tool-preload.cjs", "preload.cjs", "package-contract.mjs",
  "tool-storage.mjs", "main.mjs", "catalog.mjs", "cli.mjs", "launcher-registry.mjs",
  "desktop-bridge.mjs", "tauri.conf.json", "capabilities.json", "tools_runtime.rs", "Cargo.toml",
];

/**
 * 红线的一句话版本。手册文本（`guide.ts` 生成的 AGENTS.md）、提示文案与测试
 * 都从这里取，避免"文档写一套、代码查另一套"。
 */
export const ruleGuidance: Readonly<Record<RuleId, {
  readonly level: "block" | "warn";
  readonly rule: string;
  readonly fix: string;
}>> = {
  R1: { level: "block", rule: "id 创建后不可改", fix: "继续原工具就保持原 id；确实另起一个就在回复里说明这是新工具" },
  R2: { level: "block", rule: "不得引用远程 script/style（相对路径可以）", fix: "把依赖源码内联进同一个 <script>/<style>，或把文件放进工具目录用相对路径引用" },
  R3: { level: "block", rule: "清单声明的动作必须都有实现", fix: "在 <script> 末尾写 window.aawActions = { … }，与界面按钮共用同一函数" },
  R4: { level: "warn", rule: "设置只能经 settingsSchema 声明", fix: "设置写进清单，代码读只读的 window.aawSettings" },
  R5: { level: "warn", rule: "不得把密钥/口令写进 html", fix: "改成设置项由用户填，或运行时让用户输入" },
  R6: { level: "warn", rule: "需要留存的数据走 window.aawStore", fix: "await aawStore.set(k, v) / get(k)；localStorage 重启即清空" },
  R7: { level: "warn", rule: "不得写死 ≥800px 的宽度", fix: "用 width:100% + max-width，避免窄窗口横向溢出" },
  R8: { level: "warn", rule: "联网的工具应该声明 permissions.network", fix: "不声明也能跑（默认允许），但用户看不到「这个工具会联网」；补上 \"permissions\": { \"network\": true }，或写 hosts 限定域名" },
  R9: { level: "block", rule: "不得改动或夹带平台框架与关键契约文件", fix: "工具包只保留 manifest.json、index.html、构建产物 app.js 或 bin/ 里的运行时，以及你自己写的源码；AGENTS.md / README.md / runtime 框架这些平台文件不该出现在包里，出现就删" },
  R10: {
    level: "warn",
    rule: "声明了 build 却没带 src/，别人拿到只有产物没法读",
    fix: "想让人读懂就把 src/ 一起带上；不想公开实现就不带——这只是提醒，平台不拦。运行只认 build.out",
  },
  R11: {
    level: "block",
    rule: "AI 许愿生成的工具不得声明进程载体（runtime.kind = process）",
    fix: "许愿链路只产出 L1/L2；确实需要进程、原生模块或非 HTTP 协议时找人工接手，由人写 manifest 与 bin/、人审可执行文件",
  },
};

/** 手册里每条红线的一句话摘要，供提示文案与测试共用。 */
export const ruleTitles: Readonly<Record<RuleId, string>> = Object.fromEntries(
  ruleIds.map((id) => [id, ruleGuidance[id].rule]),
) as Record<RuleId, string>;

/** 远程地址：`https:`、`http:` 或协议相对 `//host`。相对路径不算。 */
const isRemote = (url: string) => /^(?:https?:)?\/\//i.test(url.trim());

const cssImport = /@import\s+(?:url\()?["']?https?:/i;
const dynamicImport = /\bimport\s*\(\s*["'`]\s*(?:https?:|\/\/)/i;

/**
 * HTML 里有没有**加载不到**的外部资源。
 *
 * 只拦远程地址：以前连 `<script src="./app.js">` 也一律 block，那是因为当时
 * 工具只能是"一个自包含 html"。现在工具可以带目录（ZIP 里的 js/css/图片随包
 * 落盘），相对引用是能正常加载的——再按旧规则拦就是一个装不进任何多文件工具
 * 的假限制。真正加载不到的只有远程资源：它们要么被 CSP 挡掉，要么对方机器
 * 根本连不上。
 */
function hasRemoteAsset(html: string): boolean {
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']*)["']/gi)) {
    if (isRemote(match[1]!)) return true;
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    if (isRemote(href)) return true;
  }
  return cssImport.test(html) || dynamicImport.test(html);
}

const remoteFetch = /\b(?:fetch|XMLHttpRequest|EventSource|WebSocket)\b/;
const localStore = /\b(?:localStorage|sessionStorage)\b/;
const legacySettingWrite = /(?:localStorage|sessionStorage)\s*\.\s*setItem\s*\(\s*["'`](?:setting|aaw-settings)/i;
const fixedWidth = /(?<![-\w])width\s*:\s*(\d{3,4})px/gi;
/**
 * R9 的静态信号，只查两类确凿的东西，避免误伤正常工具：
 * 1) sourceFiles 里出现平台框架/契约文件名——等于把宿主实现打进了工具包；
 * 2) html 的属性里直接引用本机绝对路径——等于绑死作者这台机器。
 * 至于"该用哪五个入口、哪些字段是契约"，那是手册正文讲的规范，不是正则能查的。
 */
const machinePath = /(?:src|href|action)\s*=\s*["'](?:file:\/\/|[A-Za-z]:[\\/]|\/Users\/|\/home\/)/i;
const frameworkNames = new Set(platformFrameworkFiles.map((name) => name.toLowerCase()));
const secretPatterns: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\bsk-[A-Za-z0-9]{16,}/, label: "OpenAI 风格密钥" },
  { pattern: /\bAK(?:IA|ID)[A-Za-z0-9]{12,}/, label: "云厂商 AccessKey" },
  { pattern: /\b(?:password|passwd|secret|token|api[-_]?key)\s*[:=]\s*["'][^"']{8,}["']/i, label: "硬编码口令/令牌" },
];

function violation(
  ruleId: RuleId,
  level: ToolViolation["level"],
  message: string,
  hint: string,
  where?: string,
): ToolViolation {
  return { ruleId, level, ...(where === undefined ? {} : { where }), message, hint };
}

export interface ToolRuleOptions {
  /** 升级前该工具项目里记录的 id；与当前 id 不同即视为改名。 */
  readonly previousId?: string;
  /**
   * 这个包是谁产出的。`"ai"` 时 R11 生效——许愿链路只能产出 L1/L2。
   *
   * 为什么默认是 `"manual"`：人在「开发工具」里自己写 manifest 是正当入口，
   * 默认拦下来会让所有老项目突然变红。AI 路径由 `workshop.ts` 显式传 `"ai"`，
   * 责任边界才清楚。
   */
  readonly generatedBy?: "ai" | "manual";
}

/**
 * 跑一遍全部红线。`block` 会让"安装/更新"拒绝执行，`warn` 只展示。
 *
 * 检查对象是"将要安装的那一份"：清单 + html 文本。不做运行时探测——这里要的是
 * 快（用户点安装时同步返回），代价是宁可漏报也不误报太多。
 */
export function runToolRules(tool: ToolPackage, options: ToolRuleOptions = {}): readonly ToolViolation[] {
  const problems: ToolViolation[] = [];
  const html = tool.html;

  // R1 · 改 id = 新工具。改名会让用户的设置与存储数据失联，必须显式二选一。
  if (options.previousId !== undefined && options.previousId !== tool.id)
    problems.push(violation("R1", "block",
      `插件 id 从 ${options.previousId} 改成了 ${tool.id}。改 id 等于新建一个工具，旧工具的设置与数据会留在原 id 下。`,
      `二选一：想继续演进原工具就把 id 改回 "${options.previousId}"；确实要另起一个就把 id 保留为新值，并在回复里说明这是新工具。`,
      "manifest.id"));

  // R2 · 远程资源在沙箱里加载不到，用户看到的是"样式没生效/按钮点不动"的白屏。
  if (hasRemoteAsset(html))
    problems.push(violation("R2", "block",
      "HTML 里引用了远程脚本或样式。这些资源要么被 CSP 挡掉，要么对方机器根本连不上。",
      "把依赖内联进同一个 <script>/<style>，或把文件放进工具目录并用相对路径引用（\"./app.js\"），或改成自己手写的最简实现。",
      "index.html"));

  // R3 · 清单声明了动作却没挂实现，AI 一调用就报"工具未实现动作"。
  //
  // L3 是例外：进程工具的动作在 `initialize` 的返回里声明，不在 html 里。
  // 拿"html 里有没有 aawActions"去判它，等于要求一个没有界面的后台进程写网页。
  const isProcessTool = tool.runtime?.kind === "process";
  const declaresAction = (tool.actions?.length ?? 0) > 0;
  const implementsAction = /\baawActions\b/.test(html);
  if (declaresAction && !implementsAction && !isProcessTool)
    problems.push(violation("R3", "block",
      `清单声明了 ${tool.actions?.length} 个动作，但 html 里没有给 window.aawActions 赋值。`,
      "在 <script> 末尾写 window.aawActions = { <动作id>: async (input) => ... }，并让界面按钮调用同一个函数。",
      "index.html"));
  if (!declaresAction && implementsAction)
    problems.push(violation("R3", "warn",
      "html 里实现了 aawActions，但清单没有声明 actions，AI 无法调用这个工具。",
      "把每个动作补进清单的 actions：{ id, description, inputSchema }。"));
  if (!declaresAction && !implementsAction && !isProcessTool)
    problems.push(violation("R3", "warn",
      "这个工具没有声明任何动作，只能人工点击使用，AI 用不了它。",
      "至少暴露一个动作，让界面按钮与 AI 走同一个函数。"));

  // R4 · 自己造设置项，用户既找不到也保存不了。
  if (legacySettingWrite.test(html))
    problems.push(violation("R4", "warn",
      "代码里在往 localStorage 写设置项，这类设置不会出现在管理页，用户改不了。",
      "把设置项写进清单的 settingsSchema，代码里用只读的 window.aawSettings 读取。",
      "index.html"));

  // R5 · 工具会被分享，写进 html 的密钥等于公开发布。只提醒，不阻止。
  for (const { pattern, label } of secretPatterns) {
    const match = pattern.exec(html);
    if (!match) continue;
    problems.push(violation("R5", "warn",
      `html 里疑似写了${label}（${match[0].slice(0, 12)}…）。工具包是可以被分享的，密钥会被一起发出去。`,
      "把密钥挪到设置项让用户自己填，或改成请求时让用户输入；不要写死在 html 里。",
      "index.html"));
    break;
  }

  // R6 · 工具窗口跑在内存分区里，localStorage 在 AAW 重启后会被清空。
  // 写设置项的用法归 R4 管，这里只看"拿它当业务存储"的情况，避免同一个毛病报两遍。
  const businessStore = localStore.exec(html.replace(new RegExp(legacySettingWrite.source, "gi"), ""));
  if (businessStore)
    problems.push(violation("R6", "warn",
      `代码里用了 ${businessStore[0]}。工具窗口是内存分区，AAW 重启后这里的数据会被清空。`,
      "需要跨重开保留的数据改用 window.aawStore（await aawStore.set(k, v) / get(k)）；只在本次运行内用的临时状态可以继续用内存变量。",
      "index.html"));

  // R7 · 写死宽度在小窗（最小 360px）里会横向溢出。
  let widest = 0;
  for (const match of html.matchAll(fixedWidth)) widest = Math.max(widest, Number(match[1]));
  if (widest >= 800)
    problems.push(violation("R7", "warn",
      `样式里写死了 ${widest}px 宽度。用户可能把工具窗口缩到 360px，会横向溢出。`,
      "改用 max-width、百分比或 clamp()，例如 width: 100%; max-width: 62rem;",
      "index.html"));

  // R8 · 联网要能被用户在安装前看到。
  const triesNetwork = remoteFetch.test(html) && /(?:https?:|\/\/)/.test(html);
  if (triesNetwork && tool.permissions?.network !== true)
    problems.push(violation("R8", "warn",
      "html 里会发起网络请求，但清单没有声明 permissions.network。别的机器上仍然能跑（未声明默认允许），但用户看不到「这个工具会联网」。",
      "在清单里补 \"permissions\": { \"network\": true }；只想连内网就写 { \"network\": { \"hosts\": [\"*.corp.example.com\"] } }；确实不该联网就写 false。",
      "manifest.permissions"));

  // R9 · 通用性：工具包只能带工具自己，不能把平台框架/契约文件一起打包。
  // 这些文件由每台机器上的宿主提供，塞进 sourceFiles 既不会被加载，又会让
  // 这个 ZIP 绑死当前这版宿主，别人装了也用不上——正是"没法在平台上传播"。
  const smuggled = Object.keys(tool.sourceFiles ?? {}).filter((path) =>
    frameworkNames.has(path.split(/[\\/]/).pop()!.toLowerCase()));
  if (smuggled.length)
    problems.push(violation("R9", "block",
      `附加源码里夹带了平台框架/契约文件：${smuggled.join("、")}。这些文件由宿主统一提供，不属于工具包。`,
      "删掉这些文件：工具包只要 manifest.json、index.html 和你自己写的源码；运行框架由每台机器上的 AAW 提供。",
      "sourceFiles"));

  // 绑死本机路径属于"能跑但只能在这台机器上跑"，warn 而不拦安装。
  if (machinePath.test(html))
    problems.push(violation("R9", "warn",
      "html 里引用了本机绝对路径或 file:// 地址。工具包是要分享出去的，换台机器这些地址就不存在了。",
      "改用相对/内联资源，或通过 aawFiles.open 让用户当场选文件，不要写死 C:\\Users\\… 之类的路径。",
      "index.html"));

  // R10 · 声明了 build 却没带 src/：只是提醒，不拦。
  //
  // 这一条从 block 降成 warn 是设计第二版最重要的一处修改。写成 block 等于
  // "不交源码就不能发布"——平台越权，且会把企业里"能用但不公开"的适配器、
  // 临时脚本、带公司逻辑的胶水整批挡在门外。运行只认 build.out，src/ 只是
  // 一个普通的可选目录，和 app.css、icon.png 同级。
  if (tool.build && !Object.keys(tool.sourceFiles ?? {}).some((path) => path.startsWith("src/")))
    problems.push(violation("R10", "warn",
      "这个工具声明了 build，但包里没有 src/。别人拿到只有 app.js 产物，没法读、没法改。",
      "想让人读懂就把源码放在 src/ 一起分发；不想公开实现就不带——这条只是提醒，不影响安装与运行。",
      "build"));

  // R11 · AI 许愿链路不得产出进程工具。
  //
  // 许愿链路看不到用户机器上的可执行文件，也无法判断"这个 exe 到底做什么"。
  // 一旦它开始生成 runtime，用户点一次「开始做」就可能得到一个能读全盘的进程。
  // 所以不是"提醒作者小心"，是**这条链路根本不给这个出口**。
  if (options.generatedBy === "ai" && tool.runtime !== undefined)
    problems.push(violation("R11", "block",
      "AI 许愿生成的工具不能声明进程载体（runtime.kind = process）。",
      "改用 L1 单页或 L2 打包页（build）。确实需要进程、原生模块或非 HTTP 协议时，找人工接手：由人写 manifest 与 bin/，并人工审阅包里的可执行文件。",
      "manifest.runtime"));

  return problems;
}

/** 只有 block 会让安装失败；warn 收集起来展示。 */
export function splitViolations(problems: readonly ToolViolation[]): {
  readonly blocking: readonly ToolViolation[];
  readonly warnings: readonly ToolViolation[];
} {
  return {
    blocking: problems.filter((problem) => problem.level === "block"),
    warnings: problems.filter((problem) => problem.level === "warn"),
  };
}

/** 把问题列表压成一段能喂回会话的中文文本（AI 要能直接照着改）。 */
export function describeViolations(problems: readonly ToolViolation[]): string {
  return problems.map((problem) => {
    const level = problem.level === "block" ? "必须修" : "建议";
    const where = problem.where ? `（${problem.where}）` : "";
    return `- [${problem.ruleId} · ${level}]${where} ${problem.message}\n  改法：${problem.hint}`;
  }).join("\n");
}
