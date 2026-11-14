/**
 * 结果通道的传输选择（ADR 024 §9-3）。
 *
 * 引擎在需求单 `result_channel` 里给出结果通道的全部可达方式（stdio 桥与
 * HTTP 端点）；宿主是唯一看得到 Agent `initialize` 能力声明的一方，在这里
 * 选定一种并追加到会话的 MCP 清单。
 *
 * 规则只有一条，与引擎 `ResultChannelOffer::mcp_server`（result_channel.rs）
 * 逐字一致，由共享 fixture `workflow-engine-rs/tests/fixtures/
 * result_channel_offer.json` 双边钉住：Agent 声明 `mcpCapabilities.http` →
 * HTTP；否则 → stdio（ACP 规范要求所有 Agent 支持）。这里不出现任何具体
 * Agent 的名字。
 */
import type {
  McpNameValue,
  McpServer,
  McpServerHttp,
  McpServerStdio,
} from "../../../contracts/acp/protocol.ts";
import type { ResultChannelOfferWire } from "../engine/protocol.ts";

/** Agent 是否在 initialize 中声明了 HTTP MCP 能力（缺省/非 true 一律否）。 */
export function agentSupportsHttpMcp(initialize: unknown): boolean {
  const capabilities = asRecord(asRecord(initialize)?.agentCapabilities);
  return asRecord(capabilities?.mcpCapabilities)?.http === true;
}

/** 按唯一规则选出结果通道的标准 ACP McpServer 元素。 */
export function resultChannelServer(
  offer: ResultChannelOfferWire,
  agentSupportsHttp: boolean,
): McpServer {
  if (agentSupportsHttp) {
    const http: McpServerHttp = {
      type: "http",
      name: offer.name,
      url: offer.http.url,
      headers: offer.http.headers,
    };
    return http;
  }
  const stdio: McpServerStdio = {
    name: offer.name,
    command: offer.stdio.command,
    args: offer.stdio.args,
    env: offer.stdio.env,
  };
  return stdio;
}

/**
 * 需求单的结果通道提供（宽容收窄：形状不全归 null，由调用方决定是否报错）。
 */
export function asResultChannelOffer(raw: unknown): ResultChannelOfferWire | null {
  const record = asRecord(raw);
  const stdio = asRecord(record?.stdio);
  const http = asRecord(record?.http);
  if (
    record === null ||
    typeof record.name !== "string" ||
    stdio === null ||
    typeof stdio.command !== "string" ||
    !isStringList(stdio.args) ||
    !isNameValueList(stdio.env) ||
    http === null ||
    typeof http.url !== "string" ||
    !isNameValueList(http.headers)
  ) {
    return null;
  }
  return {
    name: record.name,
    stdio: { command: stdio.command, args: stdio.args, env: stdio.env },
    http: { url: http.url, headers: http.headers },
  };
}

/**
 * 调用方配置的 MCP 清单（需求单 `mcp_servers`）→ 标准 ACP 元素。只保留
 * 形状完整的标准元素（http 带 type 判别；stdio 无 type、args/env 必填），
 * 其余丢弃——信封数据不作猜测性修补。
 */
export function standardMcpServers(raw: unknown): readonly McpServer[] {
  if (!Array.isArray(raw)) return [];
  const servers: McpServer[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (record === null || typeof record.name !== "string") continue;
    if (
      record.type === "http" &&
      typeof record.url === "string" &&
      isNameValueList(record.headers)
    ) {
      servers.push({ type: "http", name: record.name, url: record.url, headers: record.headers });
      continue;
    }
    if (
      record.type === undefined &&
      typeof record.command === "string" &&
      isStringList(record.args) &&
      isNameValueList(record.env)
    ) {
      servers.push({ name: record.name, command: record.command, args: record.args, env: record.env });
    }
  }
  return servers;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNameValueList(value: unknown): value is readonly McpNameValue[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      const record = asRecord(item);
      return typeof record?.name === "string" && typeof record.value === "string";
    })
  );
}
