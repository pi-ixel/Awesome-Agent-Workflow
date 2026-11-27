import { useState } from "react";
import { createGitWorkbench } from "../helpers/gitWorkbench.tsx";
import { ToastHost } from "../../src/plugins/workbench/ui/ToastHost.tsx";
import { EmptyState } from "../../src/shared/ui/EmptyState.tsx";
import { MetricStrip } from "../../src/shared/ui/MetricStrip.tsx";
import {
  ActionButton,
  Badge,
  BadgeDot,
  ProgressBar,
  Spinner,
  StatusDot,
} from "../../src/shared/ui/controls.tsx";
import { UsageMeter } from "../../src/shared/ui/controls/UsageMeter.tsx";
import { MemoryChart } from "../../src/plugins/diagnostics/ui/perf/MemoryChart.tsx";
import { PlanCard } from "../../src/plugins/project/conversation/ui/PlanCard.tsx";
import { StatusTaskProgress } from "../../src/plugins/project/conversation/ui/StatusTaskProgress.tsx";
import { taskProgressSummary } from "../../src/plugins/project/conversation/sessionStatusModel.ts";
import type { PlanItem } from "../../src/plugins/project/conversation/types.ts";

const { Wrapper, workbench } = createGitWorkbench();
const badges = [
  { tone: "neutral", label: "待执行" },
  { tone: "info", label: "运行中" },
  { tone: "ok", label: "已完成" },
  { tone: "warn", label: "等待权限确认" },
  { tone: "danger", label: "读取失败" },
] as const;
const samplePlan: PlanItem = {
  kind: "plan",
  id: "release-plan",
  entries: [
    { content: "整理发布记录", priority: "medium", status: "completed" },
    { content: "验证回滚方案", priority: "high", status: "in_progress" },
    { content: "发起上线审批", priority: "medium", status: "pending" },
  ],
};
const taskProgress = taskProgressSummary(samplePlan.entries)!;

export function StatusFixture() {
  const [completed, setCompleted] = useState(false);
  return (
    <Wrapper>
      <section
        aria-label="状态与统计"
        className="grid min-w-0 gap-3 rounded-lg bg-base p-2"
      >
        <div className="flex flex-wrap items-center gap-2">
          {badges.map(({ tone, label }) => (
            <Badge key={tone} tone={tone} compact={tone !== "neutral"}>
              <BadgeDot pulse={tone === "info"} />
              {label}
            </Badge>
          ))}
          <Badge tone="warn">
            等待 release-approval-and-rollback-verification-20261120
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <StatusDot tone="danger" label="同步失败" />
          <StatusDot tone="info" label="同步中" pulse />
          <span
            role="status"
            aria-label="读取目录"
            className="inline-flex items-center gap-2 text-ink"
          >
            <Spinner className="ui-icon-16" />
            加载目录
          </span>
        </div>
        <ProgressBar label="技能安装进度" value={completed ? 6 : 2} max={6} />
        <div className="flex flex-wrap gap-2">
          <ActionButton
            tone="secondary"
            size="compact"
            onClick={() => setCompleted((value) => !value)}
          >
            {completed ? "重置安装进度" : "完成安装"}
          </ActionButton>
          <ActionButton
            tone="secondary"
            size="compact"
            onClick={() =>
              workbench.showToast({
                message: "发布记录已复制到剪贴板，原始报告可在运行管理查看。",
                variant: "ok",
                durationMs: 5_000,
              })
            }
          >
            显示通知
          </ActionButton>
          <ActionButton
            tone="secondary"
            size="compact"
            onClick={() =>
              workbench.showToast({
                message: "已复制到剪贴板",
                variant: "ok",
                durationMs: 5_000,
              })
            }
          >
            显示短通知
          </ActionButton>
        </div>
        <UsageMeter label="已用 Credit" percent={42} />
        <UsageMeter label="已用存储" percent={86.5} tone="warn" />
        <UsageMeter label="已用会话额度" percent={128.4} tone="danger" />
        <MetricStrip
          label="本月统计"
          metrics={[
            { label: "处理 Token 总量", value: "128,400,000,000" },
            { label: "发起运行", value: "126" },
            { label: "工作区存储", value: "86.5 GB" },
          ]}
        />
        <MemoryChart
          samples={[
            { at: 0, bytes: 120 * 1024 * 1024 },
            { at: 30_000, bytes: 156 * 1024 * 1024 },
            { at: 60_000, bytes: 144 * 1024 * 1024 },
          ]}
        />
        <EmptyState
          density="compact"
          title="暂无统计记录"
          description="运行完成后会在这里显示报告。"
        />
        <section aria-label="消息流清单">
          <PlanCard item={samplePlan} />
        </section>
        <section aria-label="状态卡清单">
          <StatusTaskProgress model={taskProgress} />
        </section>
      </section>
      <ToastHost />
    </Wrapper>
  );
}
