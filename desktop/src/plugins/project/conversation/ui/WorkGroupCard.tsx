import type { SessionItem } from "../types.ts";
/**
 * 轮内已完成工作组（紧凑头）：一行「N 个步骤 · 耗时」，默认收起（降噪是
 * 目的），点开看组内的思考块与工具卡（原样渲染，由 SessionView 注入
 * renderItem）。失败的工具卡不进组（排障现场要一直可见），因此组内永远
 * 只有安静的历史。ZCode v4 无回合级工作组容器——头行样式对齐其紧凑行
 * 语言（无边框壳、无 hover 变色、chevron hover 浮现），结构本身保留。
 */
import { memo, type ReactNode } from "react";
import { ChevronRightIcon } from "../../../../shared/ui/icons.tsx";
import { formatDuration } from "./clock.ts";
import type { TurnUnit } from "./turnGrouping.ts";

/** memo：unit 与 renderItem 引用稳定（turn 缓存 + 模块级回调），流式
 * chunk 间历史工作组跳过重渲染。 */
export const WorkGroupCard = memo(function WorkGroupCard({
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
        className="group/work flex w-full items-center gap-2 text-left text-ui-base text-ink-mute transition-colors"
      >
        <span>
          {count} 个步骤
          {unit.elapsedMs !== null ? ` · ${formatDuration(unit.elapsedMs)}` : ""}
        </span>
        <span
          className={`shrink-0 text-ink-mute transition-all group-hover/work:opacity-100 group-focus-visible/work:opacity-100 [@media(hover:none)]:opacity-100 ${expanded ? "rotate-90 opacity-100" : "opacity-0"}`}
        >
          <ChevronRightIcon className="size-4" />
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
