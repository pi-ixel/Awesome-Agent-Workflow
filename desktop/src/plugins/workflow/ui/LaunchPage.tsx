/**
 * 右侧 AAW 标签页里的发起页（ADR 038）：只从会话进来——「/」菜单里的工作流
 * 起点、运行页的「再次运行」。项目取自会话所在项目。读出工作流的起点与输入，
 * 显示启动表单。
 *
 * 工作流还不能运行（源码有错、脚本没确认信任）时，指回功能区里的模板去处理。
 */
import { useEffect, useState } from "react";
import { errorLine } from "../status/errorText.ts";
import { Callout } from "../../../shared/ui/Callout.tsx";
import { TextLink } from "../../../shared/ui/TextLink.tsx";
import { WorkflowLauncher } from "./WorkflowLauncher.tsx";
import type { WorkflowDetail, WorkflowService } from "../types.ts";

export function LaunchPage({ service, id, entry, pickFiles, onStarted, onCancel, onOpenWorkflow }: {
  service: WorkflowService;
  id: string;
  entry?: string;
  pickFiles?: () => Promise<readonly string[]>;
  onStarted: (runId: string) => void;
  onCancel: () => void;
  /** 到功能区里看这个工作流（处理源码错误、确认脚本信任）。 */
  onOpenWorkflow?: (id: string) => void;
}) {
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    service.workflow(id)
      .then((loaded) => { if (live) setDetail(loaded); })
      .catch((cause: unknown) => { if (live) setError(errorLine(cause)); });
    return () => { live = false; };
  }, [service, id]);

  if (error !== "") return <Callout tone="danger" className="workflow-callout" title={<>读取工作流失败：{error}</>} />;
  if (detail === null) return <div className="workflow-empty">正在读取工作流…</div>;
  const name = detail.meta?.name ?? detail.id;
  const errors = detail.diagnostics.filter((d) => d.severity === "error").length;
  const untrusted = detail.scripts.filter((script) => !script.trusted).length;
  const blocked = detail.meta === null || errors > 0 ? `「${name}」的源码有错误，暂时不能运行`
    : untrusted > 0 ? `「${name}」里有 ${untrusted} 个脚本还没确认信任，确认前不能运行` : "";
  if (blocked !== "" || detail.meta === null) {
    return <Callout tone="warn" className="workflow-callout" title={blocked}
      actions={onOpenWorkflow && <TextLink onClick={() => onOpenWorkflow(detail.id)}>查看工作流</TextLink>} />;
  }
  return <div className="workflow-launch-sheet">
    <WorkflowLauncher
      key={`${detail.id}:${entry ?? ""}`}
      service={service}
      meta={detail.meta}
      initialEntry={entry}
      pickFiles={pickFiles}
      onStarted={onStarted}
      onCancel={onCancel}
    />
  </div>;
}
