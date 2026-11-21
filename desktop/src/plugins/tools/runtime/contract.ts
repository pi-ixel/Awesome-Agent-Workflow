/**
 * 工具运行契约的单一真源。
 *
 * 这个文件是内核的"身份证"：
 * - `toolContractVersion` 只在**破坏性变更**时 +1（删能力、改签名、收窄 CSP）；
 * - `toolCapabilities` 是能力表的唯一出处，校验器、手册、导出器、快照测试都读它。
 *
 * 为什么要有它：工具的依赖对象从来不是"桌面端版本号"，而是这套契约。桌面端
 * 为了 GUI / 文档批注 / 工作流把 0.1.38 提到 0.1.39 时，契约一个字没变，工具
 * 不该被拦；反过来某天删掉一个 `aaw*` 能力，只用应用版本判断就会漏杀。
 *
 * 变更纪律（改这个文件前必须读）：
 * - 只**新增**能力 → 不动 `toolContractVersion`；
 * - 删除能力、改方法签名、收窄 CSP、改注入形态 → **必须 +1**；
 * - 改完同步 `tests/plugins/tools/contract.test.ts` 的快照。
 */

/**
 * 契约代际。破坏性变更时 +1，其余改动不动它。
 *
 * ## 2（当代）删掉了什么
 *
 * **`manifest.preload` 与它背后的 Node 侧桥接层。** 这不是"换个注入方式"，
 * 而是删掉了一整条能力路径：作者不能再靠 `preload.js` 拿 `require`。按
 * `contract.ts` 的纪律，删能力必须 +1，于是代际从 1 升到 2。
 *
 * 三条影响写在 `compat.ts` 与 `04 §8` 的存量护栏里：
 * - 声明 `requires.contract: 1` 且用了 `preload` 的老包，装不进 v2 宿主；
 * - 已装的老包走 `explainIncompatibility()` → 说明页，而不是白屏；
 * - 列表不删条目，占位包保住 id，标 `broken`。
 *
 * 替代路径不是"再给一个 Node"，而是：纯 JS/WASM 依赖打包成 `app.js`（L2），
 * 真的需要进程时由作者自带 `bin/` 运行时（L3）。两条都是**平台 0 字节**。
 */
export const toolContractVersion = 2;

/** 能力在哪些载体里可用。页面载体 = L1/L2，进程载体 = L3。 */
export type ToolCarrier = "page" | "process" | "both";

export interface ToolCapability {
  /** 能力名，与 `window.aaw*` 的对应关系见 `entry`。 */
  readonly name: string;
  /** 从哪一代契约开始提供。 */
  readonly since: number;
  /**
   * 数据方向。这一栏不是装饰：
   * - `down`：宿主注入给工具（页面载体注入 `window`），工具依赖宿主；
   * - `up`：工具赋值给宿主（`aawActions`），宿主反向读取执行；
   * - `none`：纯声明式授权（如联网），没有 window 入口。
   */
  readonly direction: "down" | "up" | "none";
  /** 挂在 `window` 上的入口名；纯声明性能力留空。 */
  readonly entry: string;
  /**
   * 载体。这一栏回答"这个能力在进程工具里有没有"：
   * - `page`：只有页面载体（今天的 12 项都至少是 page）；
   * - `process`：只有进程载体；
   * - `both`：两种载体都有，语义一致（20 秒超时、512 KB 返回、幂等）。
   *
   * 它存在的理由很实际：作者从页面载体迁到进程载体时，要能一眼看出哪几项
   * 必须改成 `aaw.call(...)`（store / secrets / settings 三项强制走宿主）。
   */
  readonly carrier: ToolCarrier;
  /** 给作者看的一句话。 */
  readonly summary: string;
}

/**
 * 能力表。顺序即手册里的展示顺序。
 *
 * `entry` 为空表示它不是 `window` 上的对象，而是一种"声明式授权"（例如网络）。
 */
export const toolCapabilities: readonly ToolCapability[] = [
  { name: "settings", entry: "aawSettings", direction: "down", since: 1, carrier: "both", summary: "读取用户在工具中心里填的设置（只读）" },
  { name: "store", entry: "aawStore", direction: "down", since: 1, carrier: "both", summary: "按工具隔离的键值存储，5 MB" },
  { name: "sharedStore", entry: "aawStore.scope", direction: "down", since: 1, carrier: "both", summary: "用户级共享存储，供多个工具串起来用" },
  { name: "files", entry: "aawFiles", direction: "down", since: 1, carrier: "both", summary: "用户亲手选中的文件：文本 / 二进制 / 多选 / 目录 / 拖放" },
  { name: "clipboard", entry: "aawClipboard", direction: "down", since: 1, carrier: "both", summary: "剪切板文本与图片" },
  { name: "actions", entry: "aawActions", direction: "up", since: 1, carrier: "both", summary: "向上暴露动作给 AI 调用（工具赋值、宿主读取）" },
  { name: "system", entry: "aawSystem", direction: "down", since: 1, carrier: "both", summary: "只读系统信息：平台、CPU、内存、磁盘" },
  { name: "secrets", entry: "aawSecrets", direction: "down", since: 1, carrier: "both", summary: "系统加密存储的密钥，不落明文" },
  { name: "lifecycle", entry: "aawLifecycle", direction: "down", since: 1, carrier: "both", summary: "系统通知、常驻与定时（需在清单声明）" },
  { name: "context", entry: "aawContext", direction: "down", since: 1, carrier: "both", summary: "唤起上下文：来源与可用文本" },
  { name: "bus", entry: "aawBus", direction: "down", since: 1, carrier: "both", summary: "工具间在线事件广播" },
  { name: "network", entry: "", direction: "none", since: 1, carrier: "both", summary: "联网（在清单 permissions 里声明，可限定域名）" },
];

/**
 * 进程载体里**必须**走宿主的能力。
 *
 * 判据只有一条：**数据的所有权在平台，就不能让工具自己管。** 进程工具当然
 * 能自己写文件，但自己写的 store 卸载时清不掉（`04 §5` 的清理约定当场破产），
 * 自己存的密钥没有系统加密，自己读的设置和用户在工具中心改的那份不是一份。
 */
export const hostOwnedCapabilities: readonly string[] = ["store", "sharedStore", "secrets", "settings"];

/** 某个能力在指定载体里有没有。进程工具的校验器用它提示"改走 aaw.call"。 */
export function capabilityAvailableIn(name: string, carrier: "page" | "process"): boolean {
  const capability = byName.get(name);
  if (!capability) return false;
  return capability.carrier === "both" || capability.carrier === carrier;
}

const byName = new Map(toolCapabilities.map((item) => [item.name, item]));

export function readCapability(name: string): ToolCapability | undefined {
  return byName.get(name);
}

/** 某个契约代际下可用的能力名——用于安装时校验 `requires.capabilities`。 */
export function capabilitiesAt(version: number): readonly string[] {
  return toolCapabilities.filter((item) => item.since <= version).map((item) => item.name);
}

/** 手册里"能用哪些 window 接口"那段用的清单（只列宿主注入给工具的那些）。 */
export function capabilityEntries(): readonly { entry: string; summary: string }[] {
  return toolCapabilities
    .filter((item) => item.direction === "down" && item.entry)
    .map((item) => ({ entry: item.entry, summary: item.summary }));
}
