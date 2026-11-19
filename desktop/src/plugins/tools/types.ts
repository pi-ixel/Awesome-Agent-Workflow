export interface ToolAction {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * 一条校验结果。
 *
 * 两档：`block` 装不上，`warn` 只提醒作者（例如把密钥写进 html）。分级的意义是
 * 让"尽量不约束"落在 warn 上——提醒但不阻止，用户自己决定。
 */
export interface ToolViolation {
  /** `FIELD` 表示清单字段问题；`R1`…`R9` 对应手册里的红线编号。 */
  readonly ruleId: string;
  readonly level: "block" | "warn";
  /** 位置，例如 `manifest.id`、`index.html`。 */
  readonly where?: string;
  /** 给人看的说明。 */
  readonly message: string;
  /** 给 AI 看的修复建议——它要能照着改，而不是再猜一次。 */
  readonly hint: string;
}

/**
 * 联网声明。
 *
 * `true` 等价于"不限域名的 http(s)"，是历史写法，继续支持；写成对象可以限定
 * 域名（会转成 CSP 的 `connect-src` 白名单），`insecure` 才放行自签证书。
 */
export interface ToolNetworkPermission {
  /** 允许访问的域名，支持 `*.corp.example.com` 这种通配；省略表示不限。 */
  readonly hosts?: readonly string[];
  /** 放行自签证书。安装时会明确警告。 */
  readonly insecure?: boolean;
}

/** 工具在运行时申请的能力；安装时会展示给用户。 */
export interface ToolPermissions {
  /** 联网：`true` 不限域名，对象可限定域名或放行自签证书；省略表示不联网。 */
  readonly network?: boolean | ToolNetworkPermission;
}

/** 归一化后的联网声明，供校验器、运行时与手册共用。 */
export interface NetworkRule {
  /** 清单里是否真的写了 `network`。false 表示"没表态"。 */
  readonly declared: boolean;
  readonly enabled: boolean;
  readonly hosts: readonly string[];
  readonly insecure: boolean;
}

/**
 * 归一化联网声明。
 *
 * **没写 `network` 时按"允许"处理**，而不是按"禁止"。这是刻意的取舍：早期工具
 * 都没写这个字段，一律断网会让存量工具当场静默失效——那正是本轮要消灭的现象。
 * 想真正收紧的作者可以显式写 `network: false`；校验器会对"看起来在联网却没表态"
 * 的包给 warn，把声明这件事推给作者，而不是靠运行时突然翻脸。
 */
export function readNetworkRule(permissions: ToolPermissions | undefined): NetworkRule {
  const value = permissions?.network;
  if (value === undefined) return { declared: false, enabled: true, hosts: [], insecure: false };
  if (value === false) return { declared: true, enabled: false, hosts: [], insecure: false };
  if (value === true) return { declared: true, enabled: true, hosts: [], insecure: false };
  return {
    declared: true,
    enabled: true,
    hosts: Array.isArray(value.hosts) ? value.hosts : [],
    insecure: value.insecure === true,
  };
}

/** 工具包对宿主契约的要求。省略表示"只要清单格式兼容就能跑"。 */
export interface ToolRequires {
  /** 最低契约代际。宿主 `toolContractVersion` 低于它就装不上。 */
  readonly contract?: number;
  /** 需要的能力名；缺失时按"当前宿主没有这个能力"处理。 */
  readonly capabilities?: readonly string[];
}

/**
 * 后台意图声明。
 *
 * 常驻与定时都必须显式声明：用户关掉窗口之后工具还在跑，这件事不能靠作者
 * 偷偷决定。安装时会用一句人话把这个意图展示出来。
 */
export interface ToolBackground {
  /** 为什么要常驻，写给人看（例如「剪切板历史」）。 */
  readonly reason?: string;
  /** 是否需要定时唤醒。最小间隔 1 分钟，实际频率由宿主兜底。 */
  readonly schedule?: boolean;
}

export interface ToolPackage {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /**
   * 卡片与小窗上显示的 1–2 个字符（emoji 或字母）。缺省取名称首字。
   *
   * 加它是因为所有个人工具此前共用同一个图标，只能靠 4 色循环区分；这是
   * 可选字段，旧清单不受影响。
   */
  readonly icon?: string;
  readonly html: string;
  readonly actions?: readonly ToolAction[];
  readonly settingsSchema?: readonly ToolSetting[];
  readonly permissions?: ToolPermissions;
  /** 作者 / 团队名，导入别人给的包时用于判断可信度。 */
  readonly author?: string;
  /** 来源说明（仓库地址、内部文档链接等）。 */
  readonly source?: string;
  /** 对宿主契约的要求。省略即宽松放行。 */
  readonly requires?: ToolRequires;
  /** 需要在唤起时带上可用文本（选中内容或剪切板）。声明后才会注入 `aawContext.selection`。 */
  readonly needsSelection?: boolean;
  /** 后台意图：常驻理由、是否需要定时。声明后才允许窗口关闭后继续运行。 */
  readonly background?: ToolBackground;
  /**
   * 工具自带的 Node 侧桥接脚本（相对工具目录的路径，`preload.js`）。
   *
   * 声明之后，运行时会先注入宿主的 `aaw*` 能力，再执行这个脚本。它跑在
   * **有完整 Node 的 preload 上下文**里，所以可以直接 `require` 工具目录下
   * 的 `node_modules`。界面层仍然拿不到 Node（`nodeIntegration: false`），
   * 只能拿到作者通过 `contextBridge` 主动暴露的那几个接口。
   *
   * 省略即"纯页面工具"，和以前完全一样。
   */
  readonly preload?: string;
  /**
   * 作者附加的 UTF-8 文本文件。
   *
   * 注意：这个字段只承载**文本**。二进制资源、`node_modules` 这类东西不进
   * 清单，它们躺在工具目录里（安装时落盘），运行时直接从目录加载。
   */
  readonly sourceFiles?: Readonly<Record<string, string>>;
}

/** 工具被判定为不可用时的记录。保留条目本身，只标记原因——绝不静默丢弃。 */
export interface ToolBrokenState {
  /** 给用户看的一句话。 */
  readonly reason: string;
  /** 怎么恢复：升级桌面端 / 重新导入 / 卸载。 */
  readonly hint: string;
  /** 判定时间（毫秒）。 */
  readonly at: number;
}

export type ToolSettingValue = string | number | boolean;
export type ToolSettings = Readonly<Record<string, ToolSettingValue>>;
export type ToolSetting = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
} & (
  | { readonly type: "text"; readonly default: string }
  | { readonly type: "number"; readonly default: number; readonly min?: number; readonly max?: number }
  | { readonly type: "boolean"; readonly default: boolean }
  | { readonly type: "select"; readonly default: string; readonly options: readonly { readonly label: string; readonly value: string }[] }
);

export interface PersonalTool {
  readonly package: ToolPackage;
  readonly lastOpened?: number;
  /** 首次安装时间（毫秒）。升级不改写，用来回答"这工具什么时候装上的"。 */
  readonly installedAt?: number;
  /** 最近一次覆盖安装的时间（毫秒）。 */
  readonly updatedAt?: number;
  /** 被这次覆盖掉的版本号，安装后提示「v1.0 → v2.0」用。 */
  readonly previousVersion?: string;
  /**
   * 这一版是从哪个项目目录装进来的。
   *
   * 记它是为了回答一个此前没人能回答的问题："我改了项目里的 index.html，
   * 工具中心里那个还是新的吗？"——有了目录就能读回来比对，不一致时提示
   * 用户重新安装，而不是让他打开一个旧版本还以为是刚改的。
   */
  readonly dir?: string;
  readonly settings?: ToolSettings;
  /**
   * 安装时宿主提供的契约代际。
   *
   * 存量保护靠它：读取已装工具时，用"它自己安装时的规则"判断，而不是用现行
   * 规则判死。否则宿主每收紧一条校验，存量工具就会集体消失。
   */
  readonly installedContractVersion?: number;
  /**
   * 判定为不可用时的原因。
   *
   * 有它就说明条目还在、只是跑不了——界面要显示一张说明卡（可看原因、可卸载、
   * 可重新导入），而不是把它从列表里抹掉。这是"工具神秘消失"的正面解法。
   */
  readonly broken?: ToolBrokenState;
}
