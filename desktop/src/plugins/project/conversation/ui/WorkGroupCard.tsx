import type { SessionItem } from "../types.ts";
import { memo, type ReactNode } from "react";
import { ChevronRightIcon } from "../../../../shared/ui/icons.tsx";
import type { TurnUnit } from "./turnGrouping.ts";

/** memo：unit 与 renderItem 引用稳定（turn 缓存 + 模块级回调），流式
 * chunk 间历史工作组跳过重渲染。 */
export const WorkGroupCard = memo(function WorkGroupCard({
  unit,
  expanded,
  onToggle,
  shimmer,
  renderItem,
}: {
  readonly unit: Extract<TurnUnit, { kind: "work" }>;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly shimmer: boolean;
  readonly renderItem: (item: SessionItem) => ReactNode;
}) {
  return (
    <div className="pl-3" data-work-group="">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left text-ui-base text-ink-mute"
      >
        <ChevronRightIcon
          className={`size-4 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span className={shimmer ? "turn-status-shimmer" : undefined}>
          Agent 处理了一些内容
        </span>
      </button>
      {expanded ? (
        /* 左导线 + 缩进：组内容与平级行区分开（与思考行展开区同一视觉语言） */
        <div className="py-2">
          <div className="ml-2 border-line border-l pl-3.5">
            <div className="space-y-4">
              {unit.items.map((item) => (
                <div key={item.id}>{renderItem(item)}</div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});
