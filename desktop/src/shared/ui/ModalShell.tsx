/**
 * 模态外壳：遮罩 + 居中卡片 + Esc 关闭。
 *
 * 供模态层（审批弹窗、结构化问答）复用；审批弹窗（ApprovalModal）自带
 * 遮罩实现保持不动，本外壳服务于问答表单等新弹窗。
 */
import { useEffect, type ReactNode } from "react";

interface ModalShellProps {
  /** 无障碍名称（role=dialog 的 aria-label）。 */
  readonly label: string;
  /** Esc / 点击遮罩时的回调（通常为取消动作）。 */
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}

export function ModalShell({ label, onDismiss, children }: ModalShellProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        // preventDefault 标记 Esc 已被模态消费（SessionView 的全局停止让位）
        event.preventDefault();
        onDismiss();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDismiss]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onDismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="modal-in max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-line-strong bg-surface shadow-elev-3"
        onClick={(event) => {
          // 卡片内交互不冒泡成关闭
          event.stopPropagation();
        }}
      >
        {children}
      </div>
    </div>
  );
}
