import type { ChrysRuntime } from "./types.ts";
import { skillNamesFromSources } from "./skillCatalog.ts";
import type {
  RuntimeSnapshot,
  McpServerEntry,
} from "../../acp/runtimeSnapshot.ts";

// ------------------------------------------------- runtimeDetails 严格收窄

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

/** dict[string, list[string]] → 计数条目（键排序，坏值丢弃）。 */
function countEntries(
  value: unknown,
): readonly { name: string; count: number }[] | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const entries: { name: string; count: number }[] = [];
  for (const [key, tools] of Object.entries(record)) {
    const name = asString(key);
    if (name === null) {
      continue;
    }
    const list = asStringList(tools);
    entries.push({ name, count: list === null ? 0 : list.length });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
}

/** 从 runtimeDetails 提取 model / mcp / skill 来源信息（坏形状按缺失处理）。 */
function parseRuntimeDetails(details: unknown): {
  modelName: string | null;
  modelProvider: string | null;
  mcpServers: readonly McpServerEntry[];
  mcpFailures: readonly { name: string; error: string }[];
  skillSources: readonly { source: string; count: number }[];
} {
  const record = asRecord(details);
  if (record === null) {
    return {
      modelName: null,
      modelProvider: null,
      mcpServers: [],
      mcpFailures: [],
      skillSources: [],
    };
  }
  const model = asRecord(record["model"]);
  const mcpTools = countEntries(record["mcp_tools"]);
  const failuresRecord = asRecord(record["mcp_failures"]);
  const mcpFailures: { name: string; error: string }[] = [];
  if (failuresRecord !== null) {
    for (const [key, error] of Object.entries(failuresRecord)) {
      const name = asString(key);
      const text = asString(error);
      if (name !== null && text !== null) {
        mcpFailures.push({ name, error: text });
      }
    }
    mcpFailures.sort((left, right) => left.name.localeCompare(right.name));
  }
  const skillSources = countEntries(record["skill_sources"]);
  return {
    modelName: model === null ? null : asString(model["name"]),
    modelProvider: model === null ? null : asString(model["provider"]),
    mcpServers:
      mcpTools === null
        ? []
        : mcpTools.map((entry) => ({
            name: entry.name,
            toolCount: entry.count,
          })),
    mcpFailures,
    skillSources:
      skillSources === null
        ? []
        : skillSources.map((entry) => ({
            source: entry.name,
            count: entry.count,
          })),
  };
}

/**
 * 合并一次 runtime 更新（partial 语义：字段存在才覆盖；undefined 不清旧值）。
 */
export function normalizeChrysRuntime(
  incoming: ChrysRuntime,
): Partial<RuntimeSnapshot> {
  const next: {
    -readonly [K in keyof RuntimeSnapshot]?: RuntimeSnapshot[K];
  } = {};
  if (typeof incoming.agentProfile === "string") {
    next.agentProfile = incoming.agentProfile;
  }
  if (typeof incoming.displayName === "string") {
    next.displayName = incoming.displayName;
  }
  if (incoming.modelProfileId !== undefined) {
    next.modelProfileId = incoming.modelProfileId;
  }
  if (incoming.maxContextTokens !== undefined) {
    next.maxContextTokens = incoming.maxContextTokens;
  }
  const toolNames = asStringList(incoming.toolNames);
  if (toolNames !== null) {
    next.toolNames = toolNames;
  }
  const skillNames = asStringList(incoming.skillNames);
  if (skillNames !== null) {
    next.skillNames = skillNames;
  }
  if (incoming.runtimeDetails !== undefined) {
    const details = parseRuntimeDetails(incoming.runtimeDetails);
    next.modelName = details.modelName;
    next.modelProvider = details.modelProvider;
    next.mcpServers = details.mcpServers;
    next.mcpFailures = details.mcpFailures;
    next.skillSources = details.skillSources;
    if (skillNames !== null && skillNames.length === 0) {
      next.skillNames = skillNamesFromSources(details.skillSources);
    }
  }
  if (next.skillNames)
    next.skillInvocations = Object.fromEntries(
      next.skillNames.map((name) => [
        name,
        `请使用 skill「${name}」来处理这次任务`,
      ]),
    );
  return next;
}
