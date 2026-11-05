import type { ToolCallItem } from "../../stores/sessionStore.ts";
import {
  subagentColor,
  type SubagentToolPresentation,
} from "../../core/subagentTool.ts";
import { BotIcon } from "../icons.tsx";

const colors: Readonly<Record<string, string>> = {
  yellow: "text-subagent-yellow",
  red: "text-subagent-red",
  orange: "text-subagent-orange",
  green: "text-subagent-green",
  cyan: "text-subagent-cyan",
  blue: "text-subagent-blue",
  purple: "text-subagent-purple",
  pink: "text-subagent-pink",
};

/** No readable child-session source is exposed by the current Desktop adapter.
 * Match ZCode's static summary instead of inventing a child from toolCallId. */
export function SubagentToolRow({
  item,
  agent,
}: {
  readonly item: ToolCallItem;
  readonly agent: SubagentToolPresentation;
}) {
  const running =
    item.status === "in_progress" ||
    item.status === "pending" ||
    item.status === null;
  const status =
    item.status === "failed"
      ? "执行失败"
      : item.status === "completed"
        ? "已完成"
        : item.status === "pending"
          ? "等待中"
          : running
            ? "运行中"
            : "等待中";
  const number = new Intl.NumberFormat("zh-CN");
  const hint = [
    agent.name ? `子智能体 ${agent.name}` : "子智能体",
    agent.task,
    status,
  ];
  if (agent.stats)
    hint.push(
      `工具调用：${number.format(agent.stats.toolCalls)} 次`,
      `上下文 tokens：${number.format(agent.stats.contextTokens)}`,
      `总 tokens：${number.format(agent.stats.totalTokens)}`,
    );
  return (
    <div
      className="w-full min-w-0"
      data-item-kind="tool"
      data-item-id={item.id}
      data-subagent-tool=""
    >
      <div
        className="flex min-w-0 w-full cursor-default items-center gap-2 text-left text-ui-base text-ink-mute"
        title={hint.join("\n")}
      >
        <BotIcon className="size-4 shrink-0 text-ink-mute" />
        <span
          className={`shrink-0 whitespace-nowrap font-medium ${running ? "turn-status-shimmer" : ""}`}
        >
          子智能体
        </span>
        {agent.name && (
          // ZCode SummaryLeadingContent protects kindDetail independently from
          // the long, shrinkable task content. Otherwise Explore shrinks to E.
          <span className="min-w-0 shrink-0">
            <span
              className={`inline-flex max-w-36 items-center truncate font-mono text-ui-base font-medium leading-[1.5] ${colors[subagentColor(agent.name)]}`}
            >
              {agent.name}
            </span>
          </span>
        )}
        <div className="flex min-w-0 max-w-full items-center gap-2">
          <span aria-hidden="true" className="shrink-0">
            ·
          </span>
          <span className="min-w-0 truncate">{agent.task}</span>
          {item.status === "failed" && (
            <span
              className="shrink-0 cursor-help whitespace-nowrap underline decoration-dotted underline-offset-2"
              title={item.resultSummary || "子代理执行失败"}
            >
              执行失败
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
