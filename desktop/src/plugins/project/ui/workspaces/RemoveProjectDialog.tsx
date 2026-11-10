import { createPortal } from "react-dom";
import { ModalShell } from "../../../../shared/ui/ModalShell.tsx";
import { btnDanger, btnSecondary } from "../../../../shared/ui/controls.tsx";

export function RemoveProjectDialog({
  path,
  onCancel,
  onConfirm,
}: {
  readonly path: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return createPortal(
    <ModalShell label="确认移除项目" onDismiss={onCancel}>
      <div className="space-y-4 p-5">
        <h2 className="text-lg font-semibold text-ink">从列表移除项目？</h2>
        <p className="break-all text-sm text-ink-soft">{path}</p>
        <p className="rounded-lg border border-danger-line bg-danger-bg p-3 text-sm leading-relaxed text-danger-ink">
          将关闭该项目的会话和终端，释放文档资源。正在执行的任务会中断，已保存的文件和会话历史会保留。
        </p>
        <div className="flex justify-end gap-2">
          <button autoFocus type="button" className={`${btnSecondary} h-9 px-4 text-sm`} onClick={onCancel}>
            取消
          </button>
          <button type="button" className={`${btnDanger} h-9 px-4 text-sm`} onClick={onConfirm}>
            确认移除
          </button>
        </div>
      </div>
    </ModalShell>,
    document.body,
  );
}
