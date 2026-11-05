/** Read-only presentation of existing tool evidence, not a child-session API. */
export interface SubagentToolEvidence {
  readonly title: string;
  readonly toolCallId?: string;
  readonly toolKind?: string | null;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly content?: unknown;
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface SubagentToolPresentation {
  readonly name: string;
  readonly task: string;
  readonly stats: {
    readonly toolCalls: number;
    readonly contextTokens: number;
    readonly totalTokens: number;
  } | null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value === "string" && value.length <= 64 * 1024) {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toolName(title: string): string {
  return (
    title
      .match(
        /^(explore_agent|general_agent|plan_agent|explore agent|general agent|plan agent|spawn_agent|agent|task)(?=$|[\s:(])/i,
      )?.[1]
      ?.toLowerCase()
      .replaceAll(" ", "_") ?? ""
  );
}

function typeName(value: string): string {
  const aliases: Readonly<Record<string, string>> = {
    explore_agent: "Explore",
    general_agent: "General",
    plan_agent: "Plan",
  };
  return (
    aliases[value.toLowerCase().replaceAll(" ", "_")] ?? value.slice(0, 80)
  );
}

/** Only inspect ACP/MCP text containers, never arbitrary JSON fields or prompts. */
function outputText(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (typeof value === "string") {
    if (
      value.length <= 64 * 1024 &&
      ["[", "{"].includes(value.trimStart()[0] ?? "")
    ) {
      try {
        return outputText(JSON.parse(value) as unknown, depth + 1);
      } catch {
        /* Plain output may start with a bracket. */
      }
    }
    return value.slice(0, 12_000).trim();
  }
  if (Array.isArray(value))
    return value
      .slice(0, 16)
      .map((part) => outputText(part, depth + 1))
      .join("\n")
      .slice(0, 12_000);
  const data = record(value);
  if (!data) return "";
  for (const key of ["text", "content", "result", "items"]) {
    if (data[key] !== undefined) return outputText(data[key], depth + 1);
  }
  return "";
}

const SUMMARY =
  /^Sub-agent ([^\r\n:]{1,80}): (\d+(?:,\d{3})*) tool call\(s\), (\d+(?:,\d{3})*) context token\(s\), (\d+(?:,\d{3})*) total token\(s\)\.\s*$/;

export function subagentTool(
  item: SubagentToolEvidence,
): SubagentToolPresentation | null {
  const meta = record(item._meta);
  const chrys = record(meta?.chrys);
  const explicitName =
    text(chrys?.tool_name) || text(meta?.tool_name) || text(meta?.toolName);
  const implementationName = toolName(explicitName || item.title.trim());
  // A prompt is not proof of delegation. Text fallback is restricted to generic
  // tool identities; a read/execute tool printing this text stays a normal tool.
  const genericTitle =
    /^(?:other|tool|工具)?$/i.test(item.title.trim()) ||
    item.title === item.toolCallId;
  const canInfer =
    !explicitName &&
    genericTitle &&
    (item.toolKind === null ||
      item.toolKind === undefined ||
      item.toolKind === "other");
  if (!implementationName && !canInfer) return null;
  const summary =
    outputText(item.rawOutput).match(SUMMARY) ??
    outputText(item.content).match(SUMMARY);
  if (!implementationName && !summary) return null;
  const input = record(item.rawInput);

  const explicitType =
    text(chrys?.subagent_type) ||
    text(meta?.subagent_type) ||
    text(input?.subagent_type) ||
    text(input?.agent_type);
  const defaultType = ["agent", "task", "spawn_agent"].includes(
    implementationName,
  )
    ? ""
    : implementationName;
  const name = typeName(explicitType || defaultType || summary?.[1] || "");
  const title =
    !toolName(item.title.trim()) && !genericTitle ? item.title.trim() : "";
  const task = (
    title ||
    text(input?.description) ||
    text(input?.prompt) ||
    name ||
    "子代理任务"
  )
    .replace(/\s+/g, " ")
    .slice(0, 500);
  const counts = summary
    ?.slice(2)
    .map((value) => Number(value.replaceAll(",", "")));
  const stats =
    counts?.length === 3 &&
    counts.every((value) => Number.isSafeInteger(value) && value >= 0)
      ? {
          toolCalls: counts[0]!,
          contextTokens: counts[1]!,
          totalTokens: counts[2]!,
        }
      : null;
  return { name, task, stats };
}

/** Same deterministic type-name hash and eight colors as ZCode. */
export function subagentColor(name: string): string {
  const colors = [
    "yellow",
    "red",
    "orange",
    "green",
    "cyan",
    "blue",
    "purple",
    "pink",
  ];
  let hash = 0;
  for (let index = 0; index < name.length; index++)
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  return colors[hash % colors.length]!;
}
