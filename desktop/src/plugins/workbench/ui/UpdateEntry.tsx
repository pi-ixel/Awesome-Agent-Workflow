import { useWorkbenchEntries } from "../react.ts";

export function UpdateEntry({
  compact = false,
}: {
  readonly compact?: boolean;
}) {
  const id = compact ? "updates-button-compact" : "updates-button";
  const View = useWorkbenchEntries("chrome").find(
    (entry) => entry.id === id,
  )?.View;
  return View ? <View /> : null;
}
