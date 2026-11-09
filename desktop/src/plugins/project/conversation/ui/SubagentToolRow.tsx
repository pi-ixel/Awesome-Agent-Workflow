import type { ToolCallItem } from "../../../../contracts/conversation.ts";
import { SubagentDetails } from "./SubagentDetails.tsx";
import {
  subagentColor,
  type SubagentToolPresentation,
} from "../../../../contracts/subagentTool.ts";
import { BotIcon } from "../../../../shared/ui/icons.tsx";
import { SubagentProgressView } from "./SubagentProgressView.tsx";

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

/** Render normalized child-tool evidence without assuming an agent protocol. */
export function SubagentToolRow({
  item,
  agent,
}: {
  readonly item: ToolCallItem;
  readonly agent: SubagentToolPresentation;
}) {
  const active =
    item.status === "in_progress" ||
    item.status === "pending" ||
    item.status === null;
  const running = active && (!agent.phase || agent.phase === "running");
  const phaseLabel =
    agent.phase === "paused"
      ? "已暂停"
      : agent.phase === "retrying"
        ? "重试中"
        : agent.phase === "aborted"
          ? "已中止"
          : null;
  const status =
    item.status === "failed"
      ? "执行失败"
      : item.status === "completed"
        ? "已完成"
        : active && agent.phase === "running"
          ? "运行中"
          : item.status === "pending"
            ? "等待中"
            : active && phaseLabel
              ? phaseLabel
              : running
                ? "运行中"
                : "等待中";
  const number = new Intl.NumberFormat("zh-CN");
  const identityColor = agent.name
    ? colors[subagentColor(agent.name)]
    : "text-ink-mute";
  const hint = [
    agent.name ? `子智能体 ${agent.name}` : "子智能体",
    agent.task,
    status,
    ...(agent.detail ? [agent.detail] : []),
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
        className="flex min-w-0 w-full flex-wrap cursor-default items-center gap-x-2 gap-y-1 text-left text-ui-base text-ink-mute"
        title={hint.join("\n")}
      >
        {/* Intrinsic identity width, with remaining space given to the task.
            Unusually long names can wrap instead of imposing a fixed ratio. */}
        <span
          className={`inline-flex min-w-0 max-w-full shrink-0 items-center gap-2 ${identityColor}`}
        >
          <BotIcon className="size-4 shrink-0" />
          {agent.name && (
            <span className="min-w-0 break-all font-mono text-ui-base font-medium leading-[1.5]">
              {agent.name}
            </span>
          )}
        </span>
        <div className="flex min-w-[min(10ch,100%)] max-w-full flex-1 basis-0 items-center gap-2">
          {agent.name && (
            <span aria-hidden="true" className="shrink-0">
              ·
            </span>
          )}
          <span
            className={`min-w-0 truncate ${running ? "turn-status-shimmer" : ""}`}
          >
            {agent.task || (active ? status : "未提供任务描述")}
          </span>
          {item.status === "failed" && (
            <span
              className="shrink-0 cursor-help whitespace-nowrap underline decoration-dotted underline-offset-2"
              title={item.resultSummary || "子代理执行失败"}
            >
              执行失败
            </span>
          )}
          {active && phaseLabel && (
            <span className="shrink-0 whitespace-nowrap" title={agent.detail}>
              {phaseLabel}
            </span>
          )}
        </div>
      </div>
      <SubagentProgressView agent={agent} active={active} />
      <SubagentDetails item={item} agent={agent} active={active} />
    </div>
  );
}
