/**
 * agent transport 工厂（ui 层组装模块）：按形态选择承载——
 *
 * 自定义/内置/发现的所有 agent 都是 **stdio 形态**：Tauri webview 走 IPC
 * transport；dev 浏览器（npm run dev:web）走 dev bridge（vite 内嵌插件
 * 代为拉起）；其余环境（vitest 等）返回 null，如实报告不可用，不伪造
 * 连接。生产构建把 DEV 折叠为 false，bridge 分支成为死代码。
 *
 * 从 realRuntime 提取为独立工厂：协议自检（agentProbe）与真实会话
 * （realRuntime）共用同一套判定，防止两处漂移。
 */
import { isTauriEnv } from "../core/host.ts";
import { createTauriStdioTransport } from "../acp/transport/tauriStdioTransport.ts";
import { createBridgeAcpTransport } from "../dev/bridgeClient.ts";
import type { AcpTransport } from "../acp/transport/acpTransport.ts";
import type { AgentLaunch } from "../agents/registry.ts";

/** 按运行时创建 agent transport；环境不支持返回 null。 */
export async function createAgentTransport(
  launch: AgentLaunch,
  options: { isolated?: boolean } = {},
): Promise<AcpTransport | null> {
  let transport: AcpTransport | null = null;
  if (isTauriEnv()) {
    transport = await createTauriStdioTransport({
      command: launch.command,
      cwd: launch.cwd ?? undefined,
      extraEnv: launch.extraEnv,
      isolated: options.isolated,
    });
  } else if (import.meta.env.DEV && !import.meta.env.VITEST) {
    transport = await createBridgeAcpTransport({
      command: launch.command,
      cwd: launch.cwd ?? undefined,
      extraEnv: launch.extraEnv,
    });
  }
  return transport;
}
