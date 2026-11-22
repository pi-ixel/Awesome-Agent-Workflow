import type {
  ManagedMcpDefinition,
  McpCredentialReference,
} from "../../../contracts/mcp/management.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function headers(value: unknown): McpCredentialReference[] | undefined {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    const result: McpCredentialReference[] = [];
    for (const item of value as unknown[]) {
      const entry = record(item);
      if (
        !entry ||
        typeof entry.name !== "string" ||
        typeof entry.reference !== "string" ||
        typeof entry.prefix !== "string" ||
        (entry.source !== "environment" && entry.source !== "system")
      )
        return undefined;
      result.push({
        name: entry.name,
        reference: entry.reference,
        prefix: entry.prefix,
        source: entry.source,
      });
    }
    return result;
  }
  const values = record(value);
  if (!values) return undefined;
  const result: McpCredentialReference[] = [];
  for (const [name, reference] of Object.entries(values)) {
    if (typeof reference !== "string") return undefined;
    const match =
      /^(Bearer |Basic )?(?:\$\{([A-Za-z_]\w*)\}|\{\{\s*([A-Za-z_]\w*)\s*\}\})$/.exec(
        reference,
      );
    const variable = match?.[2] ?? match?.[3];
    if (!variable) return undefined;
    result.push({
      name,
      source: "environment",
      reference: variable,
      prefix: match?.[1] ?? "",
    });
  }
  return result;
}

export function parseMcpImport(input: string) {
  if (input.length > 256 * 1024) throw new Error("JSON 配置超过大小上限");
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    throw new Error("请输入有效的 JSON 配置");
  }
  const root = record(decoded);
  if (!root) throw new Error("请输入单条服务或 mcpServers 配置");
  const named =
    typeof root.name === "string" &&
    (typeof root.url === "string" || typeof root.command === "string");
  const servers = named
    ? { [String(root.name)]: root }
    : (record(root.mcpServers) ?? root);
  const rows = Object.entries(servers);
  if (rows.length > 512) throw new Error("一次最多导入 512 个服务");
  const definitions: ManagedMcpDefinition[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const [name, value] of rows) {
    const entry = record(value);
    const kind =
      entry?.transport ?? entry?.type ?? (entry?.command ? "stdio" : "http");
    const refs = headers(entry?.headers);
    const url = typeof entry?.url === "string" ? URL.parse(entry.url) : null;
    const invalid =
      !name ||
      name.trim() !== name ||
      new TextEncoder().encode(name).length > 128 ||
      [...name].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      });
    const unsupported = !["http", "streamable-http", "streamable"].includes(
      typeof kind === "string" ? kind : "",
    );
    if (
      invalid ||
      !entry ||
      unsupported ||
      !url ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      !refs
    ) {
      skipped.push({
        name,
        reason: unsupported
          ? "当前 Agent 的 Desktop 注入不支持此传输方式"
          : !refs
            ? "请求头请用环境变量引用"
            : "服务名称或地址无效",
      });
      continue;
    }
    definitions.push({
      name,
      url: url.href,
      transport: "http",
      headers: refs,
      ...(typeof entry.description === "string"
        ? { description: entry.description }
        : {}),
    });
  }
  return { definitions, skipped };
}

// 供应方文档分别位于 context7.com/docs/resources/all-clients 和 docs.devin.ai/work-with-devin/deepwiki-mcp。
export const mcpTemplates: readonly ManagedMcpDefinition[] = [
  {
    name: "Context7",
    description: "查询库文档与使用示例",
    transport: "http",
    url: "https://mcp.context7.com/mcp",
    headers: [
      {
        name: "Authorization",
        source: "environment",
        reference: "CONTEXT7_API_KEY",
        prefix: "Bearer ",
      },
    ],
  },
  {
    name: "DeepWiki",
    description: "查询公开代码仓库的文档和结构",
    transport: "http",
    url: "https://mcp.deepwiki.com/mcp",
    headers: [],
  },
];
