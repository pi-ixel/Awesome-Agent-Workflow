/**
 * 会话附加工具（ADR 037）：会话新建、打开或重连时，应用问一下各登记方这个
 * 会话要额外装哪些 MCP 工具，追加在会话的工具清单里。
 *
 * 用途举例：工作流的节点会话在运行没结束时要带着交结果工具。无论这个会话
 * 是工作流打开的、用户在侧栏里打开的，还是断线后自动重连的，都经同一处
 * 问到，所以行为一致。登记方按会话 id 判断要不要给；新建会话时 id 为 null。
 */
import type {
  McpServer,
  RequestPermissionOutcome,
} from "../../../contracts/acp/protocol.ts";
import type {
  AcpSessionPort,
  PermissionOption,
} from "../../acpRuntime/types.ts";
import type { Logger } from "../../../shared/logging/logger.ts";

export interface SessionToolContext {
  readonly workspacePath: string;
  readonly cwd?: string;
  readonly agentKey: string;
  readonly agentId: string;
  /** 新建会话时为 null。 */
  readonly sessionId: string | null;
  readonly relatedProjects?: readonly string[];
  readonly onRemoteScopeBound?: () => void;
  /** Agent 握手时声明的信息与能力（按它选择工具的连接方式）。 */
  readonly agent: AcpSessionPort["agentInfo"];
  readonly requestExtension?: AcpSessionPort["requestAgentExtension"];
  /** 仅在这一代 ACP 会话建立后通知，使用 Agent 返回或恢复的会话标识。 */
  readonly onEstablished?: (listener: (sessionId: string) => void) => void;
  readonly onDispose?: (listener: (strict?: boolean) => Promise<void>) => void;
  /** 让会话附加工具复用发起会话的审批。会话建立后可用。 */
  readonly requestPermission?: (
    toolCall: Readonly<Record<string, unknown>>,
    options: readonly PermissionOption[],
  ) => Promise<RequestPermissionOutcome>;
}

export type SessionToolProvider = ((
  context: SessionToolContext,
) => readonly McpServer[] | Promise<readonly McpServer[]>) & {
  readonly connectionForProject?: (path: string) => string | undefined;
};

export interface SessionToolsResolution {
  readonly servers: readonly McpServer[];
  readonly additionalDirectories?: readonly string[];
  readonly establish: (sessionId: string) => void | Promise<void>;
  readonly dispose?: () => Promise<void>;
}

export function createSessionTools(logger: Logger) {
  const providers = new Set<SessionToolProvider>();
  return {
    connectionForProject(path: string) {
      for (const provider of providers) {
        const connection = provider.connectionForProject?.(path);
        if (connection) return connection;
      }
    },
    /** 登记一个提供方；返回的函数撤销登记。 */
    register(provider: SessionToolProvider): () => void {
      providers.add(provider);
      return () => {
        providers.delete(provider);
      };
    },
    /** 汇总各提供方给这个会话的工具；某一方出错只记日志，不影响会话打开。 */
    async resolve(
      context: SessionToolContext,
    ): Promise<SessionToolsResolution> {
      const tools: McpServer[] = [];
      const observers: ((sessionId: string) => void)[] = [];
      const disposals: (() => Promise<void>)[] = [];
      const dispose = async (strict = false) => {
        observers.length = 0;
        const releasing = disposals.splice(0);
        const outcomes = await Promise.allSettled(
          releasing.map((release) => release()),
        );
        if (strict) {
          const failed = outcomes.flatMap((outcome, index) => {
            if (outcome.status === "fulfilled") return [];
            disposals.push(releasing[index]!);
            return [outcome.reason as unknown];
          });
          if (failed.length)
            throw new AggregateError(failed, "无法释放旧项目的工具绑定");
        }
      };
      for (const provider of [...providers]) {
        const releases: typeof disposals = [];
        try {
          const pending: typeof observers = [];
          tools.push(
            ...(await provider({
              ...context,
              onEstablished: (listener) => {
                pending.push(listener);
              },
              onDispose: (release) => releases.push(release),
            })),
          );
          observers.push(...pending);
          disposals.push(...releases);
        } catch (error) {
          await Promise.allSettled(releases.map((release) => release()));
          logger.warn("会话附加工具获取失败", {
            sessionId: context.sessionId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (disposals.length) context.onDispose?.(dispose);
      return {
        servers: tools,
        dispose,
        establish(sessionId) {
          for (const notify of observers.splice(0)) {
            try {
              notify(sessionId);
            } catch {
              logger.warn("会话附加工具状态发布失败", { sessionId });
            }
          }
        },
      };
    },
  };
}
