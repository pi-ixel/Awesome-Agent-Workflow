import type { ToolCallItem } from "../types.ts";
import { SubagentDetails } from "./SubagentDetails.tsx";
import { subagentColor } from "../subagentPresentation.ts";
import type { SubagentToolPresentation } from "../../../acpRuntime/types.ts";
import { BotIcon, ChevronRightIcon } from "../../../../shared/ui/icons.tsx";
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
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const progress = agent.progress;
  const hasDetails = Boolean(
    agent.stats ||
    agent.messages?.length ||
    agent.tools?.length ||
    agent.compactions?.length ||
    progress?.unreportedAttempts ||
    progress?.toolCalls !== undefined ||
    progress?.contextTokens !== undefined ||
    progress?.totalTokens !== undefined,
  );
  const Header = hasDetails ? "button" : "div";
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
  const identityColor = agent.name
    ? colors[subagentColor(agent.name)]
    : "text-ink-mute";
  const hint = [
    agent.name ? `子智能体 ${agent.name}` : "子智能体",
    agent.task,
    status,
    ...(agent.detail ? [agent.detail] : []),
  ];
  return (
    <div
      className="w-full min-w-0"
      data-item-kind="tool"
      data-item-id={item.id}
      data-subagent-tool=""
    >
      <Header
        className={`flex w-full min-w-0 items-center gap-2 text-left text-ui-base text-ink-mute ${hasDetails ? "cursor-pointer hover:text-ink-soft" : "cursor-default"}`}
        {...(hasDetails
          ? {
              type: "button" as const,
              "aria-expanded": expanded,
              "aria-controls": detailsId,
              onClick: () => setExpanded((current) => !current),
            }
          : {})}
        title={hint.join("\n")}
      >
        <span
          className={`inline-flex min-w-0 max-w-[45%] items-center gap-2 ${identityColor}`}
        >
          <BotIcon className="size-4 shrink-0" />
          {agent.name && (
            <span className="min-w-0 truncate font-mono text-ui-base font-medium leading-[1.5]">
              {agent.name}
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
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
              data-hint={item.resultSummary || "子代理执行失败"}
            >
              执行失败
            </span>
          )}
          {active && phaseLabel && (
            <span className="shrink-0 whitespace-nowrap" data-hint={agent.detail}>
              {phaseLabel}
            </span>
          )}
        </span>
        {hasDetails && (
          <ChevronRightIcon
            aria-hidden="true"
            className={`size-4 shrink-0 transition-transform duration-200 ease-out ${expanded ? "rotate-90" : ""}`}
          />
        )}
      </Header>
      {hasDetails && (
        <div
          id={detailsId}
          hidden={!expanded}
          className="mt-2 ml-2 min-w-0 space-y-3 border-l border-line py-1 pl-3.5"
        >
          {expanded && (
            <>
              <SubagentProgressView agent={agent} active={active} />
              <SubagentDetails item={item} agent={agent} active={active} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
import { useId, useState } from "react";
