import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { ACP_CONNECTION_POOL_SIZE } from "../../acpConnection/service.ts";
import type { WorkbenchLayout } from "../../workbench/types.ts";
import { useRegisteredSnapshot } from "../../../shared/state/useRegisteredSnapshot.ts";
import { ConfirmationDialog } from "../../../shared/ui/ConfirmationDialog.tsx";
import { CopyButton } from "../../../shared/ui/CopyButton.tsx";
import {
  btnGhost,
  btnSecondary,
  Spinner,
} from "../../../shared/ui/controls.tsx";
import {
  stageNames,
  type AgentSwitchProgressController,
  type SwitchProgress,
} from "./agentSwitchProgress.ts";

const elapsed = (from: number, to: number) =>
  `${Math.max(0, (to - from) / 1000).toFixed(1)} 秒`;

// Error text can contain launch arguments or URLs; avoid copying common credential forms.
function redact(text: string): string {
  return text
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[已隐藏]@")
    .replace(
      /((?:api[_-]?key|access[_-]?token|token|password|secret|authorization)["']?\s*[=:]\s*["']?)(?:bearer\s+)?[^\s,;&"']+/gi,
      "$1[已隐藏]",
    )
    .replace(
      /(--(?:api[_-]?key|access[_-]?token|token|password|secret)\s+)[^\s]+/gi,
      "$1[已隐藏]",
    )
    .replace(/(bearer\s+)[a-z0-9._~+\x2f-]+/gi, "$1[已隐藏]");
}

function diagnosticText(progress: SwitchProgress): string {
  const end = progress.endedAt ?? Date.now();
  return redact(
    [
      `目标 Agent：${progress.targetName} (${progress.targetId})`,
      `结果：${progress.status === "failed" ? "失败" : progress.status}，总耗时 ${elapsed(progress.startedAt, end)}`,
      ...progress.steps.map(
        (step) =>
          `${step.failed ? "失败" : step.endedAt ? "完成" : "进行中"}：${stageNames[step.stage]}，${elapsed(step.startedAt, step.endedAt ?? end)}`,
      ),
      `连接：发起启动 ${progress.startedConnections}，开始握手 ${progress.handshakes}，就绪 ${progress.readyConnections}/${ACP_CONNECTION_POOL_SIZE}，失败 ${progress.failedConnections}`,
      ...(progress.failedStage
        ? [`失败步骤：${stageNames[progress.failedStage]}`]
        : []),
      ...(progress.error ? [`错误：${progress.error}`] : []),
      ...(progress.cleanupError ? [`清理错误：${progress.cleanupError}`] : []),
      ...(progress.connectionError
        ? [`连接错误：${progress.connectionError}`]
        : []),
      ...(progress.selectedAgent
        ? [`当前选择：${progress.selectedAgent}`]
        : []),
      ...(progress.stopRequested !== undefined
        ? [
            `已向 ${progress.stopRequested} 个会话发出停止请求，实际停止状态待确认`,
          ]
        : []),
    ].join("\n"),
  );
}

function statusOf(progress: SwitchProgress): string {
  return progress.status === "success"
    ? "切换成功"
    : progress.status === "failed"
      ? "切换失败"
      : progress.failedConnections > 0 &&
          progress.steps.at(-1)?.stage === "target"
        ? "连接失败，等待预热结束"
        : progress.steps.at(-1)
          ? stageNames[progress.steps.at(-1)!.stage]
          : "准备切换";
}

function SwitchStatusButton({
  progress,
  controller,
  end,
  floating = false,
}: {
  readonly progress: SwitchProgress;
  readonly controller: AgentSwitchProgressController;
  readonly end: number;
  readonly floating?: boolean;
}) {
  const statusText = statusOf(progress);
  return (
    <button
      type="button"
      aria-label={`Agent 切换状态：${statusText}`}
      aria-expanded={progress.expanded}
      onClick={() => controller.expand(!progress.expanded)}
      className={`flex items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-left transition-colors hover:bg-raised ${floating ? "w-[min(320px,calc(100vw-24px))] shadow-lg" : "w-full"}`}
    >
      {progress.status === "running" ? (
        <Spinner className="size-3 shrink-0" />
      ) : (
        <span
          aria-hidden="true"
          className={
            progress.status === "failed" ? "text-danger-ink" : "text-ok-ink"
          }
        >
          {progress.status === "failed" ? "×" : "✓"}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs text-ink">{progress.targetName}</span>
        <span className="truncate text-2xs text-ink-soft">
          {statusText}
          {progress.status === "running" &&
            progress.steps.at(-1) &&
            end - progress.steps.at(-1)!.startedAt >= 10_000 &&
            " · 耗时较长"}
        </span>
      </span>
      <span className="shrink-0 text-2xs text-ink-soft">
        {elapsed(progress.startedAt, end)}
      </span>
    </button>
  );
}

/** Placed in the sidebar's normal flow, so it never covers the project list. */
export function AgentSwitchSidebarStatus({
  controller,
}: {
  readonly controller: AgentSwitchProgressController;
}) {
  const progress = useStore(controller.store, (state) => state.current);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (progress?.status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [progress?.id, progress?.status]);
  if (!progress) return null;
  return (
    <div className="shrink-0 px-3 pb-1">
      <SwitchStatusButton
        controller={controller}
        progress={progress}
        end={progress.endedAt ?? Math.max(now, progress.startedAt)}
      />
    </div>
  );
}

export function AgentSwitchPanel({
  controller,
  navigation,
}: {
  readonly controller: AgentSwitchProgressController;
  readonly navigation?: WorkbenchLayout["navigation"];
}) {
  const progress = useStore(controller.store, (state) => state.current);
  const hideSidebar = useRegisteredSnapshot(navigation, (state) =>
    state ? state.sidebarCollapsed || state.overlay !== null : false,
  );
  const [now, setNow] = useState(Date.now);
  const [retryId, setRetryId] = useState<number | null>(null);

  useEffect(() => {
    if (progress?.status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [progress?.id, progress?.status]);

  useEffect(() => {
    if (progress?.status !== "success") return;
    const id = progress.id;
    const timer = window.setTimeout(() => controller.dismiss(id), 3500);
    return () => window.clearTimeout(timer);
  }, [controller, progress?.id, progress?.status]);

  if (!progress) return null;
  const end = progress.endedAt ?? Math.max(now, progress.startedAt);
  const currentStep = progress.steps.at(-1);
  const waitingLong =
    progress.status === "running" &&
    currentStep !== undefined &&
    end - currentStep.startedAt >= 10_000;
  const statusText = statusOf(progress);

  return (
    <div
      className={`fixed left-3 z-40 flex max-w-[calc(100vw-24px)] flex-col items-start gap-2 ${hideSidebar ? "bottom-4" : "bottom-28"}`}
      aria-label="Agent 切换状态"
    >
      {progress.expanded && (
        <section
          aria-label="Agent 切换进度详情"
          className="flex max-h-[min(65vh,560px)] w-[360px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-xl"
        >
          <div className="flex items-start gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-medium text-ink">
                切换到 {progress.targetName}
              </h2>
              <p className="mt-1 text-xs text-ink-soft">
                {statusText} · 总耗时 {elapsed(progress.startedAt, end)}
              </p>
            </div>
            <button
              type="button"
              className={`${btnGhost} px-2 py-1 text-xs text-ink-soft`}
              onClick={() => controller.expand(false)}
            >
              最小化
            </button>
          </div>
          <div className="min-h-0 space-y-3 overflow-y-auto px-4 py-3 text-xs">
            {progress.replacedPrevious && (
              <p className="text-ink-mute">
                先前选择已被新请求替代；如前一次切换正在提交，将先等待其完成。
              </p>
            )}
            <ol className="space-y-2" aria-label="切换步骤">
              {progress.steps.map((step, index) => (
                <li
                  key={`${step.stage}-${index}`}
                  className="flex items-start gap-2"
                >
                  <span
                    aria-hidden="true"
                    className={
                      step.failed
                        ? "text-danger-ink"
                        : step.endedAt
                          ? "text-ok-ink"
                          : "text-ink-faint"
                    }
                  >
                    {step.failed ? "×" : step.endedAt ? "✓" : "●"}
                  </span>
                  <span className="min-w-0 flex-1 text-ink-soft">
                    {stageNames[step.stage]}
                  </span>
                  <span className="shrink-0 text-ink-soft">
                    {elapsed(step.startedAt, step.endedAt ?? end)}
                  </span>
                </li>
              ))}
            </ol>
            {progress.startedConnections > 0 && (
              <div className="rounded-lg bg-raised/50 px-3 py-2 text-ink-soft">
                发起启动 {progress.startedConnections}/
                {ACP_CONNECTION_POOL_SIZE} · 开始握手 {progress.handshakes}/
                {ACP_CONNECTION_POOL_SIZE} · 握手完成{" "}
                {progress.readyConnections}/{ACP_CONNECTION_POOL_SIZE}
                {progress.failedConnections > 0 && (
                  <p className="mt-1 text-danger-ink">
                    连接失败 {progress.failedConnections}
                    {progress.status === "running" &&
                      `：${progress.connectionError ?? "原因待确认"}`}
                  </p>
                )}
              </div>
            )}
            {waitingLong && (
              <p className="text-warn-ink" role="status">
                当前步骤耗时较长，仍在等待。
              </p>
            )}
            {progress.error && (
              <div
                role="alert"
                className="break-words rounded-lg bg-danger-bg px-3 py-2 text-danger-ink"
              >
                {progress.failedStage && (
                  <p>失败步骤：{stageNames[progress.failedStage]}</p>
                )}
                <p>{progress.error}</p>
                {progress.cleanupError && (
                  <p>清理错误：{progress.cleanupError}</p>
                )}
              </div>
            )}
            {progress.status === "failed" && (
              <div className="space-y-1 text-ink-soft">
                <p>
                  当前选择：{progress.selectedAgent ?? "待确认"}
                  ；连接状态需核验。
                </p>
                {progress.stopRequested !== undefined && (
                  <p>
                    已向 {progress.stopRequested}{" "}
                    个会话发出停止请求，实际停止状态待确认。
                  </p>
                )}
              </div>
            )}
          </div>
          {progress.status === "failed" && (
            <div className="flex items-center gap-2 border-t border-line px-4 py-3">
              <CopyButton
                label="复制诊断信息"
                tone="soft"
                getText={() => diagnosticText(progress)}
              />
              <button
                type="button"
                className={`${btnSecondary} ml-auto px-3 py-1.5 text-xs`}
                onClick={() => setRetryId(progress.id)}
              >
                重试
              </button>
              <button
                type="button"
                className={`${btnGhost} px-2 py-1.5 text-xs text-ink-soft`}
                onClick={() => controller.dismiss(progress.id)}
              >
                关闭
              </button>
            </div>
          )}
        </section>
      )}
      {hideSidebar && (
        <SwitchStatusButton
          progress={progress}
          controller={controller}
          end={end}
          floating
        />
      )}
      {retryId === progress.id && progress.status === "failed" && (
        <ConfirmationDialog
          label="重试切换 Agent 确认"
          title={`重新切换到 ${progress.targetName}？`}
          confirmLabel="确认重试"
          onCancel={() => setRetryId(null)}
          onConfirm={() => {
            setRetryId(null);
            void controller.retry().catch(() => {});
          }}
        >
          <p>
            当前任务将停止，消息队列将暂停。已保存的历史会话会保留，未完成消息不会自动重发。
          </p>
        </ConfirmationDialog>
      )}
    </div>
  );
}
