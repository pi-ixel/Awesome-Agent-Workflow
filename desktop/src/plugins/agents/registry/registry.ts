/** Agent registration and resolution. Vendor behavior lives in its enhancement. */
import type { CustomAgentEntry } from "../configuration/types.ts";
import type { AgentAdapter } from "./adapterTypes.ts";
import { builtinAgentAdapters } from "./builtins.ts";
import type { LoggerFactory } from "../../../shared/logging/logger.ts";
export type { AgentAdapter, AgentLaunch, AgentLaunchContext } from "./adapterTypes.ts";
export type { AgentDialectHooks, QuestionResponder } from "../../acpRuntime/types.ts";

/** 注册表：接入第二种 agent = 在此追加一项。 */
export const agentAdapters: readonly AgentAdapter[] = builtinAgentAdapters;

export function bindAgentAdapters(loggerFactory: LoggerFactory): readonly AgentAdapter[] {
  return builtinAgentAdapters.map((adapter) => adapter.bindLogger?.(loggerFactory) ?? adapter);
}

/**
 * 当前默认 agent 的 id。界面文案里需要指代「这一侧」时用它取名，不要写
 * 死字面量——接入第二个 agent 时，散落的硬编码就得逐个找出来。
 */
export const DEFAULT_AGENT_ID = agentAdapters[0]?.id ?? "native-opencode";

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
  adapters = agentAdapters,
): ResolvedAgent | null {
  const builtin = adapters.find((adapter) => adapter.id === agentId);
  if (builtin) return { source: "builtin", adapter: builtin };
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
export type { AgentQuestionResult } from "../../acpRuntime/types.ts";
