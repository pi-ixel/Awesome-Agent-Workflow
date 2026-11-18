/**
 * 会话附加工具（ADR 037）：会话新建、打开或重连时，应用问一下各登记方这个
 * 会话要额外装哪些 MCP 工具，追加在会话的工具清单里。
 *
 * 用途举例：工作流的节点会话在运行没结束时要带着交结果工具。无论这个会话
 * 是工作流打开的、用户在侧栏里打开的，还是断线后自动重连的，都经同一处
 * 问到，所以行为一致。登记方按会话 id 判断要不要给；新建会话时 id 为 null。
 */
import type { McpServer } from "../../../contracts/acp/protocol.ts";
import type { AcpSessionPort } from "../../acpRuntime/types.ts";
import type { Logger } from "../../../shared/logging/logger.ts";

export interface SessionToolContext {
  readonly workspacePath: string;
  readonly agentKey: string;
  /** 新建会话时为 null。 */
  readonly sessionId: string | null;
  /** Agent 握手时声明的信息与能力（按它选择工具的连接方式）。 */
  readonly agent: AcpSessionPort["agentInfo"];
}

export type SessionToolProvider = (
  context: SessionToolContext,
) => readonly McpServer[] | Promise<readonly McpServer[]>;

export function createSessionTools(logger: Logger) {
  const providers = new Set<SessionToolProvider>();
  return {
    /** 登记一个提供方；返回的函数撤销登记。 */
    register(provider: SessionToolProvider): () => void {
      providers.add(provider);
      return () => {
        providers.delete(provider);
      };
    },
    /** 汇总各提供方给这个会话的工具；某一方出错只记日志，不影响会话打开。 */
    async resolve(context: SessionToolContext): Promise<readonly McpServer[]> {
      const tools: McpServer[] = [];
      for (const provider of [...providers]) {
        try {
          tools.push(...(await provider(context)));
        } catch (error) {
          logger.warn("会话附加工具获取失败", {
            sessionId: context.sessionId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return tools;
    },
  };
}
