/** 空态/加载/错误统一提示块（对齐 ZCode WorkspaceFileTreeNotice.tsx）。 */
import type { ReactNode } from "react";

export function FileTreeNotice({
  icon,
  title,
  description,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description?: string;
}) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-ink-subtle">
      <div className="text-ink-subtlest">{icon}</div>
      <div className="font-medium text-ink-subtle">{title}</div>
      {description ? (
        <div className="max-w-full break-words text-ink-subtlest">
          {description}
        </div>
      ) : null}
    </div>
  );
}
