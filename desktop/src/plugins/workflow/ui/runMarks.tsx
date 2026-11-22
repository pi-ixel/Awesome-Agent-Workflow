/** 运行状态的图标分法：列表行、图标说明和状态筛选共用。 */
import type { ReactNode } from "react";
import type { RunSummary } from "../types.ts";
import { CheckIcon, HandIcon, SquareIcon, TriangleAlertIcon, XIcon } from "../../../shared/ui/icons.tsx";
import { Spinner } from "../../../shared/ui/controls.tsx";

export type RunMarkKind = "running" | "waiting" | "blocked" | "failed" | "completed" | "stopped";

/** 状态 → 图标；说明按这个顺序列出。运行中的转动只加在列表行上（见 CSS），说明里的是静止示例。 */
export const RUN_MARKS: readonly { readonly kind: RunMarkKind; readonly label: string; readonly icon: ReactNode }[] = [
  { kind: "running", label: "运行中", icon: <Spinner className="ui-icon-12" /> },
  { kind: "waiting", label: "等你确认", icon: <HandIcon className="ui-icon-12" /> },
  { kind: "blocked", label: "已阻塞", icon: <TriangleAlertIcon className="ui-icon-12" /> },
  { kind: "failed", label: "失败", icon: <XIcon className="ui-icon-12" /> },
  { kind: "completed", label: "已完成", icon: <CheckIcon className="ui-icon-12" /> },
  { kind: "stopped", label: "已停止", icon: <SquareIcon className="ui-icon-10" fill="currentColor" /> },
];

/** 运行归到哪一种状态图标：列表行、底部说明和状态筛选用同一套分法。 */
export const runMarkKind = (run: RunSummary): RunMarkKind =>
  run.status === "running" || run.status === "waiting" || run.status === "blocked" || run.status === "completed" || run.status === "failed" ? run.status : "stopped";

/** 状态筛选的选项：和图标说明同一顺序、同一图标。 */
export const RUN_MARK_OPTIONS = RUN_MARKS.map((item) => ({
  value: item.kind,
  label: item.label,
  icon: <span className={`workflow-run-mark tone-${item.kind}`} aria-hidden="true">{item.icon}</span>,
}));
