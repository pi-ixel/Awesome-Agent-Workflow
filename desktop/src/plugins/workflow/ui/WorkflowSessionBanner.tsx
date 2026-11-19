/**
 * 节点会话顶部的回指条：这个会话属于哪次运行、正在做哪个节点，一键回到
 * AAW 面板里的那次运行。不是工作流节点会话时不渲染。
 */
import { useEffect, useState } from "react";
import type { RunSessionLinks, WorkflowService } from "../types.ts";
import { AWAITING_INPUT_CHIP } from "./sessionGroups.ts";
import { ghostButton } from "./buttons.ts";

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
  const ended = ({ completed: "运行已完成", failed: "运行失败", stopped: "运行已停止", waiting: "等你确认" } as Record<string, string>)[run.status] ?? "运行已停止";
  return (
    <div
      role="note"
      aria-label="工作流节点会话"
      className="flex min-w-0 items-center gap-2 border-b border-line bg-surface px-4 py-1.5 text-ui-sm text-ink-soft"
    >
      <span className="shrink-0 text-ink-faint">工作流</span>
      {latest && (
        <span className="shrink-0 font-medium text-ink">
          {latest.label}{latest.ordinal > 1 ? ` · 第 ${latest.ordinal} 轮` : ""}
        </span>
      )}
      <span className="min-w-0 truncate text-ink-faint" data-hint={run.title}>{run.title}</span>
      {waiting ? (
        <span className="shrink-0 rounded-full border border-warn-line px-2 text-xs text-warn-ink">{AWAITING_INPUT_CHIP}</span>
      ) : working ? (
        <span className="shrink-0 text-xs text-info">进行中</span>
      ) : (
        <span className="shrink-0 text-xs text-ink-faint">{run.active ? "这一步已完成" : ended}</span>
      )}
      <button
        type="button"
        onClick={() => onOpenRun(run.runId)}
        className={`${ghostButton} ml-auto`}
      >
        查看运行
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
