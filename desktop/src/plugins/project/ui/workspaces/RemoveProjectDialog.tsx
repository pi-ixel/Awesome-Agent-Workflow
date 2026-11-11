import { ConfirmationDialog } from "../../../../shared/ui/ConfirmationDialog.tsx";

export function RemoveProjectDialog({
  path,
  onCancel,
  onConfirm,
}: {
  readonly path: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <ConfirmationDialog
      label="确认移除项目"
      title="从列表移除项目？"
      confirmLabel="确认移除"
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <p className="break-all">{path}</p>
      <p className="text-warn-ink">
        将关闭该项目的会话和终端，释放文档资源。正在执行的任务会中断，已保存的文件和会话历史会保留。
      </p>
    </ConfirmationDialog>
  );
}
