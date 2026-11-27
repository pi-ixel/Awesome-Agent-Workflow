/**
 * 节点会话输入框顶上的工作流条（ADR 039）：你在这里说的话交给哪次运行的哪一步。
 *
 * 工位只说自己：这一步叫什么、第几轮、它自己的状态；整个运行走到哪、停没停，
 * 在工作流面板里看（「查看运行」）。整条按这一步的状态染成步骤卡的颜色；第一次
 * 出现时由一颗胶囊长成这一条（画布展开阶段的同一个变形动画），换步骤、换状态时
 * 文字轻轻换上。说法与会话本身一致（ADR 040）：读的就是这个会话的实时状态。
 * 不是工作流节点会话时不渲染。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RunSessionLink, RunSessionLinks, WorkflowService } from "../types.ts";
import { WorkflowIcon } from "../../../shared/ui/icons.tsx";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import { grow, motionOff } from "./flowMotion.ts";
import { STOPPING_CHIP, linkActivity } from "./sessionGroups.ts";
import { ACTIVITY_WORD, needsYou } from "../status/nodeActivity.ts";
import { useSessionLookup } from "./useSessionLookup.ts";
import "./flowStages.css";

type Tone = "done" | "running" | "wait" | "alert";

/** 这一条已经长出来过的会话：切回来时直接显示，只在第一次出现时变形。 */
const grown = new Set<string>();

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
  const found = links.workspace !== null && links.workspace === project ? findSession(links.runs, sessionId) : null;
  if (found === null) return null;
  return <Strip key={`${found.run.runId}:${sessionId}`} service={service} sessionId={sessionId} found={found} onOpenRun={onOpenRun} />;
}

function Strip({ service, sessionId, found: { run, link }, onOpenRun }: {
  service: WorkflowService;
  sessionId: string;
  found: NonNullable<ReturnType<typeof findSession>>;
  onOpenRun: (runId: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const session = useSessionLookup(service);
  const latest = link.nodes[link.nodes.length - 1];
  const stopping = run.active && run.stopping === true;
  const activity = stopping ? null : linkActivity(link, run.active, session);
  const waiting = needsYou(activity);
  const working = activity === "working";
  const own = activity ? null : ownState(latest, run.active);
  const word = stopping ? STOPPING_CHIP : activity ? ACTIVITY_WORD[activity] : own!.word;
  const tone: Tone = stopping || activity === "interrupted" ? "wait" : waiting ? "alert" : working ? "running" : own?.tone ?? "wait";

  // 第一次出现：一颗胶囊长成这一条（同画布展开阶段的变形）；之后的变化走 CSS 过渡。
  const key = `${run.runId}:${sessionId}`;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || grown.has(key)) return;
    grown.add(key);
    if (motionOff()) return;
    const box = element.getBoundingClientRect();
    const color = getComputedStyle(element).getPropertyValue(`--wf-${/tone-(\w+)/.exec(element.className)?.[1] ?? "running"}`).trim() || "currentColor";
    void grow(element, { left: box.left + 12, top: box.top + box.height / 2 - 3, width: 28, height: 6 }, color, 0);
  }, [key]);

  return (
    <div ref={ref} role="note" aria-label="工作流节点会话" className={`wf-strip tone-${tone}`}>
      <WorkflowIcon className="ui-icon-14 wf-strip-mark" aria-hidden="true" />
      {latest && <span key={`${latest.siteId}@${latest.ordinal}`} className="wf-strip-step wf-strip-swap">
        <b>{latest.label}</b>{latest.ordinal > 1 ? <small>第 {latest.ordinal} 轮</small> : null}
      </span>}
      <span className="wf-strip-title" data-hint={run.title}>{run.title}</span>
      <span key={word} className={`wf-word tone-${tone} wf-strip-swap`}>{word}</span>
      <ActionButton leadingIcon={<WorkflowIcon className="ui-icon-14" aria-hidden="true" />} tone="ghost" className="wf-strip-open" onClick={() => onOpenRun(run.runId)} aria-label="查看运行" data-hint="在 AAW 工作流面板里查看这次运行">
        查看运行
      </ActionButton>
    </div>
  );
}

/** 这一步此刻没有会话里的活动时，它自己的状态（不替整个运行说话）。 */
function ownState(latest: RunSessionLink["nodes"][number] | undefined, active: boolean): { word: string; tone: Tone } {
  if (!latest) return { word: "未开始", tone: "wait" };
  if (latest.status === "running") return active ? { word: "运行中", tone: "running" } : { word: "已中断", tone: "wait" };
  if (latest.status === "failed") return { word: "失败", tone: "alert" };
  if (latest.status === "skipped") return { word: "已跳过", tone: "done" };
  return { word: "已完成", tone: "done" };
}

function findSession(runs: readonly RunSessionLinks[], sessionId: string) {
  for (const run of runs) {
    const link = run.links.find((item) => item.sessionId === sessionId);
    if (link) return { run, link };
  }
  return null;
}
