import { btnDanger, btnPrimary, btnSecondary } from "../controls.tsx";
import { ModalShell } from "./ModalShell.tsx";
/**
 * 关闭确认弹窗（统一形态）：点关闭一律先询问，忙闲只影响文案变体——
 *
 * - 忙（busy=true）：中断警示——agent 运行中/有挂起审批，确认即丢弃
 *   本轮进度，按钮用危险色；
 * - 闲（busy=false）：普通退出提示——收口 agent 进程与终端会话，进度
 *   已落盘 .sdd/，按钮用主色（非破坏操作不上红色）。
 *
 * busy 由弹出瞬间的快照决定（workbenchUiStore.closeGuardBusy），弹窗
 * 开着期间运行状态再变化也不翻转内容。确认走统一的退出路径（先隐藏
 * 窗口、后台收口进程树、再销毁），取消仅关弹窗。
 */
export function CloseConfirmModal(props: {
  readonly busy: boolean;
  readonly pendingCount: number;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { busy, pendingCount, onCancel, onConfirm } = props;
  return (
    <ModalShell label="关闭确认" onDismiss={onCancel}>
      <div className="flex flex-col gap-4 p-5">
        {busy ? (
          <>
            <div className="text-sm text-ink">agent 仍在工作</div>
            <p className="text-sm leading-relaxed text-ink-soft">
              关闭将中断所有会话中正在执行的任务
              {pendingCount > 0
                ? `与 ${String(pendingCount)} 项挂起的审批/提问`
                : ""}
              ；已完成的进度已保存在项目 .sdd/ 中。
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                className={`${btnSecondary} px-3 py-1.5 text-sm`}
              >
                继续运行
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className={`${btnDanger} px-3 py-1.5 text-sm`}
              >
                中断并关闭
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-sm text-ink">确定退出 AAW？</div>
            <p className="text-sm leading-relaxed text-ink-soft">
              退出会收口所有 agent 进程与终端会话；已完成的进度已保存在项目
              .sdd/ 中。
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                className={`${btnSecondary} px-3 py-1.5 text-sm`}
              >
                取消
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className={`${btnPrimary} px-3 py-1.5 text-sm`}
              >
                退出
              </button>
            </div>
          </>
        )}
      </div>
    </ModalShell>
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
