/**
 * 轮内已完成工作组（折叠卡）：一行「▸ 已工作 2m13s · 6 个步骤」，
 * 默认收起（降噪是目的），点开看组内的思考块与工具卡（原样渲染，
 * 由 SessionView 注入 renderItem）。失败的工具卡不进组（排障现场
 * 要一直可见），因此组内永远只有安静的历史。
 */
import type { ReactNode } from "react";
import type { SessionItem } from "../../stores/sessionStore.ts";
import { ChevronRightIcon } from "../icons.tsx";
import { formatDuration } from "./clock.ts";
import type { TurnUnit } from "./turnGrouping.ts";

export function WorkGroupCard({
  unit,
  expanded,
  onToggle,
  renderItem,
}: {
  readonly unit: Extract<TurnUnit, { kind: "work" }>;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly renderItem: (item: SessionItem) => ReactNode;
}) {
  const count = unit.items.length;
  return (
    <div className="w-full" data-work-group="">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="group/work flex w-full items-center gap-2 border-b border-line/50 pb-2 text-left text-ui-base text-ink-mute transition-colors hover:text-ink-soft"
      >
        <span>
          {unit.elapsedMs !== null ? (
            <>步骤耗时 {formatDuration(unit.elapsedMs)} · </>
          ) : null}
          {count} 个步骤
        </span>
        <span
          className={`shrink-0 text-ink-ghost transition-all group-hover/work:opacity-100 group-focus-visible/work:opacity-100 [@media(hover:none)]:opacity-100 ${expanded ? "rotate-90 opacity-100" : "opacity-0"}`}
        >
          <ChevronRightIcon className="h-4 w-4" />
        </span>
      </button>
      {expanded ? (
        <div className="space-y-3 py-3">
          {unit.items.map((item) => (
            <div key={item.id}>{renderItem(item)}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
