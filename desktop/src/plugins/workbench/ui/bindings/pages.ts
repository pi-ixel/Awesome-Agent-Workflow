import { useWorkbenchUiValue } from "./layoutView.ts";
import { useWorkbenchEntries } from "./react.ts";

export function useWorkbenchBasePage() {
  const viewId = useWorkbenchUiValue((state) => state.viewId);
  const pages = useWorkbenchEntries("pages");
  return viewId === null
    ? pages.find((page) => page.default)
    : pages.find((page) => page.id === viewId);
}
