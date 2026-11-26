import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { ACP_CONNECTION_POOL_SIZE } from "../../acpConnection/service.ts";
import { ConfirmationDialog } from "../../../shared/ui/ConfirmationDialog.tsx";
import { CopyButton } from "../../../shared/ui/CopyButton.tsx";
import { ActionButton, Spinner } from "../../../shared/ui/controls.tsx";
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
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
      `连接：发起启动 ${progress.startedConnections}，开始握手 ${progress.handshakes}，就绪 ${progress.readyConnections}，失败 ${progress.failedConnections}；会话连接额度 ${ACP_CONNECTION_POOL_SIZE}`,
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

export function AgentSwitchPanel({
  controller,
}: {
  readonly controller: AgentSwitchProgressController;
}) {
  const progress = useStore(controller.store, (state) => state.current);
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
    const timer = window.setTimeout(() => controller.dismiss(id), 1000);
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
    <ModalShell
      label="Agent 切换进度"
      layer="foreground"
      dismissOnBackdrop={false}
      onDismiss={() => {}}
    >
      <div className="flex max-h-[85vh] flex-col">
        <div className="shrink-0 border-b border-line px-4 py-3">
          <h2 className="text-ui-base font-medium text-ink">
            切换到 {progress.targetName}
          </h2>
          <p className="mt-1 flex items-center gap-2 text-ui-sm text-ink-soft">
            {progress.status === "running" && (
              <Spinner className="ui-icon-12 shrink-0" />
            )}
            <span role="status">{statusText}</span>
            <span>· 总耗时 {elapsed(progress.startedAt, end)}</span>
          </p>
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
            <div className="rounded-control bg-raised/50 px-3 py-2 text-ink-soft">
              发起启动 {progress.startedConnections} · 开始握手{" "}
              {progress.handshakes} · 握手完成 {progress.readyConnections} ·
              会话连接额度 {ACP_CONNECTION_POOL_SIZE}
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
              className="break-words rounded-control bg-danger-bg px-3 py-2 text-danger-ink"
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
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-4 py-3">
            <CopyButton
              label="复制诊断信息"
              tone="soft"
              getText={() => diagnosticText(progress)}
            />
            <ActionButton
              tone="secondary"
              type="button"
              className="ml-auto px-3 py-1.5 text-xs"
              onClick={() => setRetryId(progress.id)}
            >
              重试
            </ActionButton>
            <ActionButton
              tone="ghost"
              type="button"
              className="px-2 py-1.5 text-xs text-ink-soft"
              onClick={() => controller.dismiss(progress.id)}
            >
              退出
            </ActionButton>
          </div>
        )}
      </div>
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
    </ModalShell>
  );
}
