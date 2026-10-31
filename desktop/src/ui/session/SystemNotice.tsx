import { memo } from "react";
/**
 * 系统 / 错误提示：居中一行弱化文案，按级别着色。
 */
import type { SystemNoticeItem } from "../../stores/sessionStore.ts";

const levelClasses: Readonly<Record<SystemNoticeItem["level"], string>> = {
  info: "text-ink-faint",
  warn: "text-warn-ink",
  error: "text-danger-ink",
};

const levelLabels: Readonly<Record<SystemNoticeItem["level"], string>> = {
  info: "系统",
  warn: "警告",
  error: "错误",
};

function SystemNoticeBase({ item }: { readonly item: SystemNoticeItem }) {
  return (
    <div
      className="flex items-center justify-center gap-2 text-xs"
      data-item-kind="system" data-item-id={item.id}
      role="note"
    >
      <span className="h-px w-6 bg-line" />
      <span className={levelClasses[item.level]}>
        {levelLabels[item.level]} · {item.text}
      </span>
      <span className="h-px w-6 bg-line" />
    </div>
  );
}

/** memo：item 引用不变则整树跳过（流式分片只改最后一条的引用）。 */
export const SystemNotice = memo(SystemNoticeBase);
