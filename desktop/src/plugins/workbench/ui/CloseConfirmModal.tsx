import { ConfirmationDialog } from "../../../shared/ui/ConfirmationDialog.tsx";
import type { ReactNode } from "react";
/**
 * 关闭确认弹窗（统一形态）：点关闭一律先询问，忙闲只影响文案变体——
 *
 * 忙时显示中断警示和参与插件提供的详情，空闲时显示普通退出提示。
 *
 * busy 由 Workbench 弹出瞬间的快照决定，弹窗
 * 开着期间运行状态再变化也不翻转内容。确认走统一的退出路径（先隐藏
 * 窗口、后台收口进程树、再销毁），取消仅关弹窗。
 */
export function CloseConfirmModal(props: {
  readonly busy: boolean;
  readonly busyDetails?: ReactNode;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { busy, busyDetails, onCancel, onConfirm } = props;
  return (
    <ConfirmationDialog
      label="关闭确认"
      title={busy ? "仍有操作正在运行" : "确定退出 AAW？"}
      cancelLabel={busy ? "继续运行" : "取消"}
      confirmLabel={busy ? "中断并关闭" : "退出"}
      tone={busy ? "danger" : "neutral"}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {busy ? (
        <p>关闭窗口将中断正在运行的操作{busyDetails}。</p>
      ) : (
        <p>退出后将关闭窗口，并释放当前占用的资源。</p>
      )}
    </ConfirmationDialog>
  );
}

/**
 * 退出收口遮罩（确认关闭后的退出感知载体）：确认后半透明变暗当前界面
 * 并悬浮一颗「正在退出」胶囊，呈现至少 2s 再隐藏窗口——给用户明确的
 * 退出感知（界面还在视野里、但已不可交互），不搞整页白屏。随后窗口
 * 隐藏、后台收口继续（完成或 10s 预算后销毁）；hide 失效时遮罩一直
 * 显示到销毁，同样是明确的退出信号。
 */
export function ExitOverlay() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45"
    >
      <div className="flex items-center gap-2.5 rounded-full border border-line bg-surface/95 py-2 pl-3.5 pr-4 shadow-2xl backdrop-blur-sm">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin text-ink-subtle"
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        <span className="text-sm text-ink-soft">正在退出…</span>
      </div>
    </div>
  );
}
