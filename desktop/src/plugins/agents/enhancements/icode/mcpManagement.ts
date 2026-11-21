import type {
  AgentExtensionClient,
  AgentMcpManagement,
  NativeMcpManagement,
} from "../../../../contracts/mcp/management.ts";
import { mcpFailureMessage } from "../../../../shared/logging/logPrivacy.ts";
import { asRecord } from "../../../../shared/valueGuards.ts";

function methods(client: AgentExtensionClient): readonly unknown[] {
  const chrys = asRecord(asRecord(client.capabilities._meta)?.chrys);
  return Array.isArray(chrys?.methods) ? chrys.methods : [];
}

async function request(
  client: AgentExtensionClient,
  method: string,
  params?: Readonly<Record<string, unknown>>,
) {
  if (!methods(client).includes(method))
    throw new Error("当前 iCode 版本未声明此 MCP 管理能力");
  return asRecord(await client.request(`_${method}`, params));
}

const native: NativeMcpManagement = {
  defaultProfile: "Code",
  nativeHost: (host) => host.native("chrys"),
};

async function readProfile(client: AgentExtensionClient, selector: string) {
  const result = await request(client, "profiles/agents/read", {
    name: selector,
  });
  const profile = asRecord(result?.profile);
  if (typeof profile?.id !== "string" || typeof profile.name !== "string")
    throw new Error("iCode 未返回目标 Profile");
  const servers = asRecord(profile.tools)?.mcp;
  const serverNames = Array.isArray(servers)
    ? servers.flatMap((server: unknown): string[] => {
        const name = asRecord(server)?.name;
        return typeof name === "string" ? [name] : [];
      })
    : [];
  return { target: { id: profile.id, name: profile.name }, serverNames };
}

export const icodeMcpManagement: AgentMcpManagement = {
  native,
  injection: {
    supportsHttp: (capabilities) =>
      asRecord(capabilities.mcpCapabilities)?.http === true,
    async nativeNames({ host, client, sessionId }) {
      if (!client) throw new Error("无法读取 iCode 会话档案");
      const source = native.nativeHost(host);
      const selector =
        sessionId === null
          ? native.defaultProfile
          : await source.sessionProfile(sessionId);
      if (!selector) throw new Error("无法识别 iCode 会话 Profile");
      const profile = await readProfile(client, selector);
      const disk = await source.read(profile.target);
      // Agent 可能仍使用旧的进程内 Profile，恢复也可能重新读取磁盘。
      return [
        ...new Set([
          ...profile.serverNames,
          ...(disk?.entries.map((entry) => entry.name) ?? []),
        ]),
      ];
    },
  },
  async testHttp(client, server) {
    const result = await request(client, "mcp/test", {
      server: {
        ...server.options,
        name: server.name,
        transport: "http",
        url: server.url,
        headers: server.headers,
        load_prompts: false,
      },
    });
    return result?.ok === true
      ? { ok: true, message: "连接成功" }
      : { ok: false, message: mcpFailureMessage(result?.message) };
  },
};
