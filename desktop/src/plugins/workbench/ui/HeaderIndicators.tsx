import { useWorkbenchEntries } from "./bindings/react.ts";

export function HeaderIndicators({
  compact = false,
}: {
  readonly compact?: boolean;
}) {
  return useWorkbenchEntries("headerIndicators").map(({ id, View }) => (
    <View key={id} compact={compact} />
  ));
}
