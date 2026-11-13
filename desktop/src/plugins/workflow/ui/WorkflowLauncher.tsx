/**
 * 启动器（ADR 024 §5 ④：需求输入 → start-dev）。
 *
 * 旧启动器（src/ui/session/WorkflowLauncher.tsx）在主会话区投递并联动
 * linkedRuntime 聚焦会话；批次一以「面板内启动」承载同一动作：选择入口
 * （dev/sr/ar）、输入本次需求，经注入的 WorkflowService 启动并选中新运行。
 * 启动失败保留需求原文（不丢用户输入），错误以 alert 呈现。
 */
import { useState } from "react";
import type { WorkflowService } from "../types.ts";

const ENTRIES = [
  { value: "dev", label: "开发（dev）" },
  { value: "sr", label: "单需求（sr）" },
  { value: "ar", label: "AR 范围（ar）" },
] as const;

export function WorkflowLauncher({ service, onStarted }: {
  service: WorkflowService;
  /** 启动成功后的面板联动（选中新运行）。 */
  onStarted?: (runId: string) => void;
}) {
  const [requirement, setRequirement] = useState("");
  const [entry, setEntry] = useState<(typeof ENTRIES)[number]["value"]>("dev");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const start = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const { runId } = await service.startDev(requirement, entry);
      setRequirement("");
      onStarted?.(runId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <section className="workflow-start" aria-label="启动工作流">
    {error !== "" && <div role="alert" className="workflow-error">{error}<button onClick={() => setError("")} aria-label="关闭提示">×</button></div>}
    <label>工作流入口
      <select value={entry} onChange={(e) => setEntry(e.target.value as (typeof ENTRIES)[number]["value"])}>
        {ENTRIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
    </label>
    <label>本次需求
      <textarea
        value={requirement}
        onChange={(e) => setRequirement(e.target.value)}
        placeholder="用一段话描述这次要完成的事情"
      />
    </label>
    <div>
      <button disabled={busy || requirement.trim() === ""} onClick={() => void start()}>启动工作流</button>
    </div>
  </section>;
}
