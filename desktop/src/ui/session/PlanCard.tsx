/**
 * 步骤清单卡（流内条目，ZCode 同款呈现）：agent 经 todo_write 推送的
 * 任务清单是会话记录的一部分——随消息滚动、快照可恢复，不占停靠坞。
 * - 头部一行：任务步骤 done/total + 当前步（收起态也能看到进展）；
 * - 默认展开完整清单（完成勾选划线、进行中动点、待办空环）；
 *   全部完成后默认收起为一行历史记录（点开仍可回看）；
 * - 空清单不会成卡（store 层已过滤）。
 */
import { useState, memo } from "react";
import type { PlanItem } from "../../stores/sessionStore.ts";
import type { PlanEntry } from "../../acp/types.ts";
import { ChevronRightIcon } from "../icons.tsx";

function EntryStatusIcon({ status }: { readonly status: PlanEntry["status"] }) {
  if (status === "completed") {
    return (
      <span
        aria-hidden={true}
        className="shrink-0 text-xs leading-4 text-ok-ink"
      >
        ✓
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span
        role="status"
        aria-label="进行中"
        className="shrink-0 leading-4 text-info"
      >
        <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" />
      </span>
    );
  }
  return (
    <span
      aria-hidden={true}
      className="shrink-0 text-xs leading-4 text-ink-ghost"
    >
      ○
    </span>
  );
}

/** 收起行展示的「当前」条目：进行中优先，否则第一个待办。 */
function currentEntryOf(
  entries: readonly PlanEntry[],
): { readonly text: string } | null {
  const inProgress = entries.find((entry) => entry.status === "in_progress");
  if (inProgress !== undefined) {
    return { text: inProgress.content };
  }
  const pending = entries.find((entry) => entry.status === "pending");
  return pending !== undefined ? { text: pending.content } : null;
}

function PlanCardBase({ item }: { readonly item: PlanItem }) {
  // 有活干默认展开；全部完成的历史卡默认收起（用户可随时点开回看）
  const [isOpen, setIsOpen] = useState(
    () => !item.entries.every((entry) => entry.status === "completed"),
  );
  const done = item.entries.filter(
    (entry) => entry.status === "completed",
  ).length;
  const allDone = done === item.entries.length;
  const current = currentEntryOf(item.entries);
  return (
    <div
      className="w-full overflow-hidden rounded-lg border border-line bg-surface/40"
      data-item-kind="plan" data-item-id={item.id}
    >
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen((current) => !current);
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-surface"
      >
        <span
          className={`shrink-0 text-ink-ghost transition-transform ${isOpen ? "rotate-90" : ""}`}
        >
          <ChevronRightIcon className="h-3 w-3" />
        </span>
        <span className={`shrink-0 ${allDone ? "text-ok-ink" : "text-ink-mute"}`}>
          任务步骤 {done}/{item.entries.length}
        </span>
        {allDone ? (
          <span className="shrink-0 text-2xs text-ok-ink">已完成</span>
        ) : current !== null ? (
          <span
            className="min-w-0 flex-1 truncate text-ink-soft"
            title={current.text}
          >
            当前：{current.text}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
      </button>
      {isOpen ? (
        <ol className="list-none space-y-1 border-t border-line px-3 py-2">
          {item.entries.map((entry, index) => (
            <li
              key={`${index}-${entry.content}`}
              className="flex items-start gap-2 text-xs leading-5"
            >
              <EntryStatusIcon status={entry.status} />
              <span
                className={`min-w-0 flex-1 break-words ${
                  entry.status === "completed"
                    ? "text-ink-faint line-through"
                    : entry.status === "in_progress"
                      ? "text-ink"
                      : "text-ink-mute"
                }`}
              >
                {entry.content}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** memo：item 引用不变则整树跳过（流式分片只改最后一条的引用）。 */
export const PlanCard = memo(PlanCardBase);
