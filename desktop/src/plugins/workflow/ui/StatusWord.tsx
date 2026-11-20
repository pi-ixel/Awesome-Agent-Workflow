import { Badge, BadgeDot } from "../../../shared/ui/controls.tsx";
import { STATE_LABEL, type NodeState } from "../status/snapshot.ts";
import { STATE_TONE } from "./nodeText.ts";

/** 状态文字：公共 Badge 加圆点；等你回复时用提醒色。label 缺省用状态词。 */
export function StatusWord({ state, waiting, label }: { state: NodeState; waiting?: boolean; label?: string }) {
  return <span className={`workflow-status contents state-${state}${waiting ? " waiting" : ""}`}>
    <Badge tone={waiting ? "warn" : STATE_TONE[state]} compact>
      <BadgeDot pulse={state === "running" && !waiting} />
      {label ?? STATE_LABEL[state]}
    </Badge>
  </span>;
}
