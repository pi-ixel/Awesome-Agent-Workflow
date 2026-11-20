import { Spinner } from "../../../shared/ui/controls.tsx";
import { hintTooltipProps } from "../../../shared/ui/controls/HintTooltip.tsx";

export function SessionRunningIndicator({
  surface = "sidebar",
}: {
  readonly surface?: "sidebar" | "conversation";
}) {
  const inConversation = surface === "conversation";
  return (
    <span
      role={inConversation ? "status" : "img"}
      aria-label={inConversation ? "工作中" : "运行中"}
      {...(inConversation ? {} : hintTooltipProps("运行中"))}
      className="flex ui-icon-16 shrink-0 items-center justify-center"
    >
      <Spinner className="ui-icon-16 shrink-0 text-ink-mute" />
    </span>
  );
}
