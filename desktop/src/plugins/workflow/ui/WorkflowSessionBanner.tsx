/**
 * 节点会话顶部的回指条：这个会话属于哪次运行、正在做哪个节点，一键回到
 * AAW 面板里的那次运行。不是工作流节点会话时不渲染。
 */
import { useEffect, useState } from "react";
import type { RunSessionLinks, WorkflowService } from "../types.ts";
import { AWAITING_INPUT_CHIP } from "./sessionGroups.ts";

export function WorkflowSessionBanner({ service, project, sessionId, onOpenRun }: {
  service: WorkflowService;
  project: string;
  sessionId: string;
  onOpenRun: (runId: string) => void;
}) {
  const [links, setLinks] = useState(() => service.sessionLinks());
  useEffect(() => {
    return service.subscribe((event) => {
      if (event.type === "runs-changed") setLinks(service.sessionLinks());
    });
  }, [service]);
  if (links.workspace === null || links.workspace !== project) return null;
  const found = findSession(links.runs, sessionId);
  if (found === null) return null;
  const { run, link } = found;
  const latest = link.nodes[link.nodes.length - 1];
  const waiting = run.active && link.nodes.some((node) => node.status === "running" && node.awaitingInput);
  const working = run.active && link.nodes.some((node) => node.status === "running");
  return (
    <div
      role="note"
      aria-label="工作流节点会话"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-surface px-4 py-2 text-ui-sm text-ink-soft"
    >
      <span className="text-ink-faint">工作流节点</span>
      <span className="max-w-[24rem] truncate font-medium text-ink" data-hint={run.title}>{run.title}</span>
      {latest && (
        <span className="truncate">
          · {latest.label}{latest.ordinal > 1 ? ` 第 ${latest.ordinal} 轮` : ""}
        </span>
      )}
      {waiting ? (
        <span className="rounded-full border border-warn-line px-2 text-xs text-warn-ink">{AWAITING_INPUT_CHIP}</span>
      ) : working ? (
        <span className="text-xs text-info">进行中</span>
      ) : (
        <span className="text-xs text-ink-faint">{run.active ? "这个角色的节点已完成" : "运行已结束"}</span>
      )}
      <button
        type="button"
        onClick={() => onOpenRun(run.runId)}
        className="ml-auto rounded px-2 py-0.5 text-xs text-ink-soft hover:bg-raised hover:text-ink"
      >
        在 AAW 面板中查看 ↗
      </button>
    </div>
  );
}

function findSession(runs: readonly RunSessionLinks[], sessionId: string) {
  for (const run of runs) {
    const link = run.links.find((item) => item.sessionId === sessionId);
    if (link) return { run, link };
  }
  return null;
}
