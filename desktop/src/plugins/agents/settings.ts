import { createStore } from "zustand";
import { joinPath } from "../../shared/panelPaths.ts";
import type { HostAgentCommands, HostCommands } from "../../contracts/host.ts";
import type { AgentConfigurationContext } from "../../contracts/agentAdapter.ts";
import type {
  ConfigurationRecord,
  ConfigurationScope,
} from "../../contracts/configuration.ts";
import { createLogger } from "../../shared/diagnosticEvents/logger.ts";
import type {
  AgentConfigurationState,
  AgentPreferences,
  CustomAgentEntry,
  DiscoveredAgent,
  AgentSettingsData,
  AgentSettingsMap,
} from "../../contracts/agentConfiguration.ts";
import {
  DEFAULT_AGENT_ID,
  agentAdapters,
  findAgentAdapter,
  customAgentIdOf,
  nativeAcpCandidates,
  parseCommandArgv,
} from "./registry.ts";

const logger = createLogger("agents");

function defaultAgentSettings(): AgentSettingsMap {
  return Object.fromEntries(
    agentAdapters.flatMap((adapter) =>
      adapter.settingsDefaults
        ? [[adapter.id, { ...adapter.settingsDefaults }]]
        : [],
    ),
  );
}
function loadAgentSettings(
  record: Readonly<Record<string, unknown>>,
): AgentSettingsMap {
  const stored = record.agentSettings;
  const result: Record<string, AgentSettingsData> = {};
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [id, value] of Object.entries(stored)) {
      if (value && typeof value === "object" && !Array.isArray(value))
        Object.defineProperty(result, id, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
  }
  for (const adapter of agentAdapters) {
    if (adapter.migrateSettings)
      result[adapter.id] = adapter.migrateSettings(result[adapter.id], record);
    else if (adapter.settingsDefaults)
      result[adapter.id] = {
        ...adapter.settingsDefaults,
        ...result[adapter.id],
      };
  }
  return result;
}

/** 自定义 agent 条目的逐项守卫（坏条目单独丢弃，不整体回落）。 */
function asCustomAgents(raw: unknown): readonly CustomAgentEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomAgentEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Readonly<Record<string, unknown>>;
    const id = record["id"];
    const name = record["name"];
    const command = record["command"];
    if (
      typeof id !== "string" ||
      typeof name !== "string" ||
      !Array.isArray(command) ||
      command.length === 0 ||
      !command.every((part) => typeof part === "string" && part.length > 0)
    ) {
      continue;
    }
    out.push({ id, name, command });
  }
  return out;
}

/** activeAgentId 守卫：必须能被解析（内置 / native 候选 / 仍在的自定义项）。 */
function isValidAgentId(
  value: unknown,
  agents: readonly CustomAgentEntry[],
): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (typeof value === "string" && findAgentAdapter(value) !== null)
    return true;
  if (nativeAcpCandidates.some((item) => item.id === value)) return true;
  return agents.some((item) => item.id === value);
}

// ------------------------------------------------------------- 路径自动探测

/** 路径的目录部分（兼容 / 与 \）。 */
function dirOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * 解析原生 CLI 的「可直接 spawn 的真 exe」：Windows 上 npm 全局安装的
 * PATH 命中是无扩展名 sh shim / .cmd（CreateProcess 与 Node spawn 都拉
 * 不起），真 exe 在 `<where 目录>/node_modules/<pkg>/bin/` 下。优先取
 * where 输出里现成的 .exe 行，其次按 npm 布局探测。解析不到返回空对象
 * （调用方回落命令名，类 Unix 环境本就能直接 spawn）。
 */
async function resolveNativeExe(
  host: HostCommands,
  candidate: { readonly program: string; readonly npmPackage?: string },
  whereLines: readonly string[],
  signal?: AbortSignal,
): Promise<{ readonly exePath?: string }> {
  const exeLine = whereLines.find((line) =>
    line.toLowerCase().endsWith(".exe"),
  );
  if (exeLine !== undefined) return { exePath: exeLine };
  if (candidate.npmPackage === undefined) return {};
  const dirs = new Set(
    whereLines.map((line) => dirOf(line)).filter((dir) => dir.length > 0),
  );
  for (const dir of dirs) {
    if (signal?.aborted) return {};
    const candidatePath = joinPath(
      dir,
      "node_modules",
      candidate.npmPackage,
      "bin",
      `${candidate.program}.exe`,
    );
    try {
      if (await host.pathExists(candidatePath)) {
        return { exePath: candidatePath };
      }
    } catch {
      // pathExists 失败按未命中处理
    }
  }
  return {};
}

export function defaultAgentPreferences(): AgentPreferences {
  return {
    agentSettings: defaultAgentSettings(),
    agents: [],
    activeAgentId: DEFAULT_AGENT_ID,
  };
}

export function loadAgentPreferences(
  record: Readonly<Record<string, unknown>>,
): AgentPreferences {
  const agents = asCustomAgents(record.agents);
  return {
    agentSettings: loadAgentSettings(record),
    agents,
    activeAgentId: isValidAgentId(record.activeAgentId, agents)
      ? record.activeAgentId
      : DEFAULT_AGENT_ID,
  };
}

async function initializeSelectedAgent(
  state: AgentConfigurationState,
  context: AgentConfigurationContext,
): Promise<void> {
  if (context.signal.aborted) return;
  try {
    await findAgentAdapter(state.activeAgentId)?.initializeConfiguration?.(
      state,
      context,
    );
  } catch (error) {
    if (!context.signal.aborted)
      logger.warn("Agent 路径初始化失败", {
        agentId: state.activeAgentId,
        error: String(error),
      });
  }
}

interface AgentStoreState extends AgentConfigurationState {
  scanNativeAgents: (
    host?: HostCommands,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export const agentPreferenceFields = [
  "agentSettings",
  "agents",
  "activeAgentId",
] as const;

export function createAgentConfiguration(
  scope: ConfigurationScope,
  readLegacy: () => ConfigurationRecord | null,
  commands: HostAgentCommands,
  lifecycle: AbortSignal,
) {
  let persisted = defaultAgentPreferences();
  try {
    const record = readLegacy();
    if (record) persisted = loadAgentPreferences(record);
  } catch (error) {
    logger.warn("读取 Agent 设置失败，使用默认值", { error: String(error) });
  }
  const temporary = {
    agentSettingsState: {},
    discoveredAgents: [],
    isScanningAgents: false,
  };
  const context = { commands, signal: lifecycle };
  const store = createStore<AgentStoreState>()((set, get) => {
    const write = (patch: Partial<AgentStoreState>) => {
      if (!lifecycle.aborted) set(patch);
    };
    const apply = (patch: Partial<AgentPreferences>) => {
      if (lifecycle.aborted) return;
      const next = { ...get(), ...patch };
      try {
        scope.update({
          agentSettings: next.agentSettings,
          agents: next.agents,
          activeAgentId: next.activeAgentId,
        });
      } catch (error) {
        logger.warn("写入 Agent 设置失败", { error: String(error) });
      }
      set(patch);
    };
    return {
      ...persisted,
      ...temporary,
      ...createAgentSettingsActions(get, write, apply, context),
      resetToDefaults: () => {
        apply(defaultAgentPreferences());
        write({ agentSettingsState: {} });
      },
    };
  });
  return {
    store,
    initialize: () => initializeSelectedAgent(store.getState(), context),
    clear: () => store.setState({ ...defaultAgentPreferences(), ...temporary }),
  };
}

function createAgentSettingsActions(
  get: () => AgentStoreState,
  set: (patch: Partial<AgentStoreState>) => void,
  applySettings: (patch: Partial<AgentPreferences>) => void,
  context: AgentConfigurationContext,
): Pick<
  AgentStoreState,
  | "getAgentSettings"
  | "setAgentSettings"
  | "getAgentSettingsState"
  | "setAgentSettingsState"
  | "setActiveAgentId"
  | "addCustomAgent"
  | "updateCustomAgent"
  | "removeCustomAgent"
  | "scanNativeAgents"
> {
  const { commands, signal: lifecycle } = context;
  return {
    getAgentSettings: (id) => get().agentSettings[id] ?? {},
    setAgentSettings: (id, patch) => {
      applySettings({
        agentSettings: {
          ...get().agentSettings,
          [id]: { ...get().agentSettings[id], ...patch },
        },
      });
    },
    getAgentSettingsState: (id) => get().agentSettingsState[id] ?? {},
    setAgentSettingsState: (id, patch) => {
      set({
        agentSettingsState: {
          ...get().agentSettingsState,
          [id]: { ...get().agentSettingsState[id], ...patch },
        },
      });
    },
    setActiveAgentId: (agentId) => {
      if (lifecycle.aborted) return;
      if (!isValidAgentId(agentId, get().agents)) {
        logger.warn("忽略非法的 agent 选择", { agentId });
        return;
      }
      if (agentId === get().activeAgentId) return;
      applySettings({ activeAgentId: agentId });
      void initializeSelectedAgent(get(), context);
      logger.info("新会话将使用的 agent 已切换", { agentId });
    },
    addCustomAgent: (name, commandText) => {
      if (lifecycle.aborted) return "Agent 服务已关闭";
      const trimmedName = name.trim();
      if (trimmedName === "") return "名称不能为空";
      const argv = parseCommandArgv(commandText);
      if (argv.length === 0) return "启动命令不能为空";
      const agents = get().agents;
      if (agents.some((item) => item.name === trimmedName)) {
        return "已存在同名 agent";
      }
      // id 唯一化：slug 冲突时追加序号
      const base = customAgentIdOf(trimmedName);
      let id = base;
      for (let i = 2; agents.some((item) => item.id === id); i += 1) {
        id = `${base}-${i}`;
      }
      applySettings({
        agents: [...agents, { id, name: trimmedName, command: argv }],
      });
      logger.info("已添加自定义 agent", { id, command: argv.join(" ") });
      return null;
    },
    updateCustomAgent: (id, name, commandText) => {
      if (lifecycle.aborted) return "Agent 服务已关闭";
      const trimmedName = name.trim();
      if (!trimmedName) return "名称不能为空";
      const command = parseCommandArgv(commandText);
      if (command.length === 0) return "启动命令不能为空";
      const agents = get().agents;
      if (!agents.some((item) => item.id === id)) return "Agent 不存在";
      if (agents.some((item) => item.id !== id && item.name === trimmedName))
        return "已存在同名 agent";
      applySettings({
        agents: agents.map((item) =>
          item.id === id ? { ...item, name: trimmedName, command } : item,
        ),
      });
      return null;
    },
    removeCustomAgent: (agentId) => {
      if (lifecycle.aborted) return;
      const agents = get().agents;
      if (!agents.some((item) => item.id === agentId)) return;
      // 被删的是当前选中项：回落默认 agent，不悬空
      const wasActive = get().activeAgentId === agentId;
      applySettings({
        agents: agents.filter((item) => item.id !== agentId),
        ...(wasActive ? { activeAgentId: DEFAULT_AGENT_ID } : {}),
      });
      logger.info("已移除自定义 agent", { agentId });
    },
    scanNativeAgents: async (host = commands, signal = lifecycle) => {
      const stopped = () => lifecycle.aborted || signal.aborted;
      if (stopped() || get().isScanningAgents) return;
      set({ isScanningAgents: true });
      try {
        const found: DiscoveredAgent[] = [];
        for (const candidate of nativeAcpCandidates) {
          for (const lookup of ["where", "which"]) {
            try {
              if (stopped()) return;
              const result = await host.runCommand(lookup, [candidate.program]);
              if (stopped()) return;
              if (result.code !== 0) continue;
              const lines = result.stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
              const first = lines[0];
              if (first === undefined) continue;
              found.push({
                id: candidate.id,
                name: candidate.name,
                path: first,
                ...(await resolveNativeExe(host, candidate, lines, signal)),
              });
              break;
            } catch {
              // 该查找命令不存在 / 宿主不支持：继续
            }
          }
        }
        if (stopped()) return;
        set({ discoveredAgents: found });
        logger.info("本机原生 ACP CLI 扫描完成", {
          found: found.map(
            (item) =>
              `${item.id}${item.exePath === undefined ? "" : "（已解析 exe）"}`,
          ),
        });
      } finally {
        set({ isScanningAgents: false });
      }
    },
  };
}
