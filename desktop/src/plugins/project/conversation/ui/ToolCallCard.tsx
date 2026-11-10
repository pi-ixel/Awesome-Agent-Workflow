import type { ToolCallItem } from "../types.ts";
import { memo, useMemo } from "react";
import { subagentTool } from "../subagentPresentation.ts";
import { SubagentToolRow } from "./SubagentToolRow.tsx";
import { OrdinaryToolCallCard } from "./OrdinaryToolCallCard.tsx";
export { formatPayload } from "./OrdinaryToolCallCard.tsx";

function ToolCallCardBase({ item }: { readonly item: ToolCallItem }) {
  const agent = useMemo(() => subagentTool(item), [item]);
  return agent ? (
    <SubagentToolRow item={item} agent={agent} />
  ) : (
    <OrdinaryToolCallCard item={item} />
  );
}

/** memo：item 引用不变则整树跳过（流式分片只改最后一条的引用）。 */
export const ToolCallCard = memo(ToolCallCardBase);
