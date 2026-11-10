import type { ToolCallItem } from "../types.ts";
import type { SubagentToolPresentation } from "../../../acpRuntime/types.ts";
import { toolInputSummary } from "../sessionStore.ts";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { ThoughtBlock } from "./ThoughtBlock.tsx";
import { ChevronRightIcon } from "../../../../shared/ui/icons.tsx";
import {
  OrdinaryToolCallCard,
  formatPayload,
} from "./OrdinaryToolCallCard.tsx";

/** Reuse conversation renderers; child identities are scoped by the parent card. */
export function SubagentDetails({
  item,
  agent,
  active,
}: {
  readonly item: ToolCallItem;
  readonly agent: SubagentToolPresentation;
  readonly active: boolean;
}) {
  return (
    <>
      {!!agent.messages?.length && (
        <section aria-label="子代理消息" className="min-w-0 space-y-2">
          <div className="text-ui-sm text-ink-mute">
            子代理消息（{agent.messages.length}）
          </div>
          <div className="min-w-0 space-y-3">
            {agent.messages.map((message) => {
              const id = `${item.id}:message:${message.id}`;
              // Historical messages have no per-message timing/streaming evidence.
              return message.kind === "thought" ? (
                <ThoughtBlock
                  key={id}
                  item={{
                    kind: "thought",
                    id,
                    text: message.text,
                    isStreaming: false,
                    startedAt: null,
                    endedAt: null,
                  }}
                />
              ) : (
                <AssistantMessage
                  key={id}
                  item={{
                    kind: "assistant",
                    id,
                    text: message.text,
                    isStreaming: false,
                    createdAt: "",
                  }}
                />
              );
            })}
          </div>
        </section>
      )}
      {!!agent.tools?.length && (
        <section aria-label="工具记录" className="min-w-0 space-y-2">
          <div className="text-ui-sm text-ink-mute">
            工具记录（{agent.tools.length}）
          </div>
          <div className="min-w-0 space-y-3">
            {agent.tools.map((tool) => {
              const id = `${item.id}:tool:${tool.id}`;
              const child: ToolCallItem = {
                kind: "tool",
                id,
                toolCallId: tool.id,
                title: tool.title ?? tool.name,
                toolName: tool.name,
                toolKind: tool.kind ?? null,
                status: tool.failed
                  ? "failed"
                  : tool.state === "returned"
                    ? "completed"
                    : active && (!agent.phase || agent.phase === "running")
                      ? "in_progress"
                      : "pending",
                rawInput: tool.input,
                inputFallback: tool.inputFallback,
                rawOutput: tool.output,
                content: tool.content,
                locations: tool.locations,
                inputSummary: toolInputSummary(
                  tool.input,
                  tool.title ?? tool.name,
                ),
                resultSummary: "",
                startedAt: null,
                endedAt: null,
              };
              return (
                <div key={id} className="min-w-0">
                  <OrdinaryToolCallCard item={child} />
                  {!tool.failed && (
                    <div className="mt-1 text-ui-caption text-ink-mute">
                      {tool.failed
                        ? "执行失败"
                        : tool.state === "returned"
                          ? "已返回"
                          : active && agent.phase !== "aborted"
                            ? "执行中"
                            : "未收到结果"}
                      {tool.durationMs !== undefined
                        ? ` · ${tool.durationMs} ms`
                        : ""}
                    </div>
                  )}
                  {tool.metadata !== undefined && (
                    <details className="group/metadata mt-2 text-ui-sm text-ink-mute">
                      <summary className="flex cursor-pointer list-none items-center gap-2 hover:text-ink-soft [&::-webkit-details-marker]:hidden">
                        附加信息
                        <ChevronRightIcon
                          aria-hidden="true"
                          className="size-4 shrink-0 transition-transform duration-200 group-open/metadata:rotate-90"
                        />
                      </summary>
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words">
                        {formatPayload(tool.metadata)}
                      </pre>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}
