/**
 * Agent 适配注册表（src/agents）：「协议」与「具体 agent」的解耦点。
 *
 * 一个 `AgentAdapter` 回答四件事：这是谁（id / displayName）、怎么启动
 * （buildLaunch 产出 argv 与环境）、会话建立时的初始化参数、有什么方言
 * （createDialect 注入私有通知翻译与私有反向请求处理）。启动描述交给
 * transport 工厂执行（Node 子进程 / Tauri IPC），本层不 spawn 进程、
 * 不依赖 UI 与 store。
 *
 * 扩展约束（docs/architecture.md「扩展第二种 agent」）：接入新 agent =
 * 在 `agentAdapters` 加一个注册项；`src/acp` 协议层与 `src/ui` 一行不改。
 * 讲标准 ACP 的 agent 到此即完成；带私有扩展的 agent 在注册项里提供
 * `createDialect`（协议层的 `AcpDialect` 挂接点），私有消息的解析留在
 * 本层，同样不动协议层。
 */

import type { AcpDialect, AcpSessionEvent } from "../acp/session.ts";
import type { HostRuntime } from "../core/host.ts";
import { readChrysArchive } from "./chrysArchive.ts";

import type { ChrysRequestInputResult } from "../acp/types.ts";
import { createChrysDialect, type QuestionResponder } from "./chrysDialect.ts";

/** 一次 agent 启动的完整描述（transport 工厂的入参形状）。 */
export interface AgentLaunch {
  /** 完整 argv，如 ["C:/path/icode.exe", "acp"]。 */
  readonly command: readonly string[];
  /** 工作目录；null 表示继承宿主。 */
  readonly cwd: string | null;
  /** 追加的环境变量（与宿主环境合并）。 */
  readonly extraEnv: Readonly<Record<string, string>>;
}

/** buildLaunch 的入参。 */
export interface AgentLaunchContext {
  /** 会话工作区目录（chrys 经 session/new 的 cwd 参数使用，启动目录可选）。 */
  readonly workspacePath: string | null;
  /** agent 可执行文件路径；缺省回退 PATH 查找（command 名语义）。 */
  readonly executablePath?: string;
}

/** 组装层传给 createDialect 的运行时回调（UI 挂起 → 用户决策 → 回传）。 */
export interface AgentDialectHooks {
  /** 结构化提问回调（chrys 的 _chrys/request_input）。 */
  readonly onQuestion?: QuestionResponder;
}

export interface AgentAdapter {
  /** 稳定标识（日志与设置引用）。 */
  readonly id: string;
  /** 展示名（界面与日志）。 */
  readonly displayName: string;
  /** 产出启动描述。 */
  buildLaunch(context: AgentLaunchContext): AgentLaunch;
  /** initialize 握手的客户端标识（AcpSession clientInfo）。 */
  readonly clientInfo: { readonly name: string; readonly version?: string };
  /**
   * 创建方言挂接（私有通知翻译 + 私有反向请求处理，注入 AcpSession）。
   * 纯标准 ACP agent 可省略——协议层对未知消息已有兜底透传。
   */
  readonly createDialect?: (hooks: AgentDialectHooks) => AcpDialect;
  /** 可选的 agent 专属压缩历史读取器。 */
  readonly readArchive?: (
    host: HostRuntime,
    sessionId: string,
    cwd: string,
  ) => Promise<AcpSessionEvent[]>;
  /** 方言注记（扩展通知 / 反向请求名等，供诊断与人读）。 */
  readonly notes: readonly string[];
}

/**
 * chrys 适配项。权威定义：D:/dev/workspace-ai/chrys/src/chrys/app/acp/
 * （server.py 的 initialize 能力声明与扩展清单、_request_permission 与
 * _chrys/request_input 结构化提问、session_manager.py、content.py）。
 *
 * 命名事实（iCode 0.30 起）：产品与命令叫 iCode（`icode acp`），但包名、
 * 配置目录（%APPDATA%/chrys）、线上的扩展前缀（chrys/*）保持 chrys——
 * 适配项沿用同一分工：id/dialect 留 chrys（内部代号与线上前缀），displayName
 * 与启动命令用 iCode（用户所见）。旧安装（只有 chrys 命令）由设置页的
 * 路径探测兜住（probeChrysPath 先找 icode 再找 chrys）。
 */
export const chrysAgentAdapter: AgentAdapter = {
  id: "chrys",
  displayName: "iCode",
  buildLaunch(context) {
    const program = context.executablePath?.trim() || "icode";
    return {
      command: [program, "acp"],
      cwd: context.workspacePath,
      extraEnv: {},
    };
  },
  clientInfo: { name: "aaw-desktop", version: "0.1.0" },
  createDialect(hooks) {
    return createChrysDialect({ onQuestion: hooks.onQuestion });
  },
  readArchive: readChrysArchive,
  notes: [
    "扩展通知：_chrys/runtime_update、_chrys/usage_update、_chrys/error、_chrys/warning（其余 _chrys/* 透传；0.30 起 initialize 的 field_meta 声明全部扩展方法/通知，apiVersion=1）",
    "反向请求：session/request_permission（allow_once / reject_once）、_chrys/request_input（结构化提问）",
    "能力（server.py）：loadSession、promptCapabilities.embeddedContext、sessionCapabilities.{close,list,additionalDirectories}",
  ],
};

/** 注册表：接入第二种 agent = 在此追加一项。 */
export const agentAdapters: readonly AgentAdapter[] = [chrysAgentAdapter];

/**
 * 当前默认 agent 的 id。界面文案里需要指代「这一侧」时用它取名，不要写
 * 死字面量——接入第二个 agent 时，散落的硬编码就得逐个找出来。
 */
export const DEFAULT_AGENT_ID = "chrys";

/** 默认 agent 的展示名（注册表缺失时回落 id，绝不返回空串）。 */
export function defaultAgentLabel(): string {
  return findAgentAdapter(DEFAULT_AGENT_ID)?.displayName ?? DEFAULT_AGENT_ID;
}

/** 按 id 查适配项；未知 id 返回 null（调用方如实报错，不静默替换）。 */
export function findAgentAdapter(id: string): AgentAdapter | null {
  return agentAdapters.find((adapter) => adapter.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// 多 agent 管理（设置页 Agent 卡片 + 诊断页协议自检共用）
// ---------------------------------------------------------------------------

/** 自定义 agent 的持久化条目（settingsStore 落盘；id 前缀 custom-）。 */
export interface CustomAgentEntry {
  readonly id: string;
  readonly name: string;
  /** 完整 argv（含程序与子命令，如 ["opencode", "acp"]）。 */
  readonly command: readonly string[];
}

/** 本机可发现的原生 ACP CLI 候选（扫描 PATH 命中即列为可用 agent）。 */
export interface NativeAcpAgent {
  readonly id: string;
  readonly name: string;
  readonly program: string;
  readonly args: readonly string[];
  /**
   * npm 包名（可空）：npm 全局安装的原生二进制把真 .exe 放在
   * `<prefix>/node_modules/<pkg>/bin/` 下，PATH 上只有 sh/.cmd shim——
   * Windows 的 spawn 不认 shim，需要解析到真 exe 才能拉起。
   */
  readonly npmPackage?: string;
}

/** 扫描结果交给解析层的最小形状（settingsStore 的 DiscoveredAgent 满足它）。 */
export interface DiscoveredAgentRef {
  readonly id: string;
  /** 解析出的可直接 spawn 的可执行路径（.exe）；未解析到为 undefined。 */
  readonly exePath?: string;
}

/**
 * 原生 ACP CLI 候选清单：只收录「子命令直接说标准 ACP」的实现——
 * 需要外挂适配器的（codex / claude 经 Zed 适配器）与只有自家协议的
 * （ZCode app-server）不入列，扫描命中也不能直接用。
 */
export const nativeAcpCandidates: readonly NativeAcpAgent[] = [
  {
    id: "native-opencode",
    name: "OpenCode",
    program: "opencode",
    args: ["acp"],
    npmPackage: "opencode-ai",
  },
];

/** 命令行字符串 → argv：双引号成组（带空格的路径），空段丢弃。 */
export function parseCommandArgv(text: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (current !== "") {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current !== "") argv.push(current);
  return argv;
}

/** agent 来源：内置适配项 / 本机发现的原生 ACP CLI / 用户自定义命令。 */
export type AgentSource = "builtin" | "native" | "custom";

/** 统一的 agent 解析结果：来源 + AgentAdapter 形状的适配面。 */
export interface ResolvedAgent {
  readonly source: AgentSource;
  readonly adapter: AgentAdapter;
}

/** 合成适配项：非内置 agent 的 AgentAdapter 形状（无方言，协议层未知消息兜底透传）。 */
function synthAdapter(
  id: string,
  displayName: string,
  command: readonly string[],
): AgentAdapter {
  return {
    id,
    displayName,
    buildLaunch(context) {
      const argv = [...command];
      // 与内置项同语义：解析出的可执行路径覆盖首段（命令名），其余保留
      if (context.executablePath?.trim())
        argv[0] = context.executablePath.trim();
      return {
        command: argv,
        cwd: context.workspacePath,
        extraEnv: {},
      };
    },
    clientInfo: { name: "aaw-desktop", version: "0.1.0" },
    notes: [],
  };
}

/**
 * 按 id 解析 agent：内置注册表 → 原生 ACP 候选 → 自定义条目。
 * 未知 id 返回 null（调用方如实报错，不静默替换）。原生候选不依赖持久化
 * ——命令行固定（program + args）；discovered 提供扫描期解析出的真
 * exe 路径（Windows 上 PATH 命中的常是无扩展名 shim，spawn 不了），
 * 有则作为默认可执行路径，调用方的 executablePath 覆盖仍优先。
 */
export function resolveAgentAdapter(
  agentId: string,
  customAgents: readonly CustomAgentEntry[],
  discovered: readonly DiscoveredAgentRef[] = [],
): ResolvedAgent | null {
  const builtin = findAgentAdapter(agentId);
  if (builtin !== null) return { source: "builtin", adapter: builtin };
  const native = nativeAcpCandidates.find((item) => item.id === agentId);
  if (native !== undefined) {
    const exePath = discovered.find((item) => item.id === native.id)?.exePath;
    // 有解析出的真 exe 则直接作为程序段（免得调用方忘传覆盖路径时落回
    // PATH shim）；调用方的 executablePath 覆盖仍优先（synth 的语义）
    return {
      source: "native",
      adapter: synthAdapter(native.id, native.name, [
        exePath ?? native.program,
        ...native.args,
      ]),
    };
  }
  const custom = customAgents.find((item) => item.id === agentId);
  if (custom !== undefined) {
    return {
      source: "custom",
      adapter: synthAdapter(custom.id, custom.name, custom.command),
    };
  }
  return null;
}

/** 由名称生成自定义 agent 的 id（ASCII slug；中文等非 ASCII 归并为分隔符，
 *  归并后为空则用 agent；唯一性由调用方兜底追加序号）。 */
export function customAgentIdOf(name: string): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "agent";
  return `custom-${slug}`;
}

/** 类型再导出：组装层构造 dialect 回调时引用（避免深入 import 链）。 */
export type { QuestionResponder, ChrysRequestInputResult };
