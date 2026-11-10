import { render } from "@testing-library/react";
import type { WorkbenchService } from "../../src/plugins/workbench/service.ts";

export function renderDesktopApp(workbench: WorkbenchService) {
  const tree = () => <workbench.Window />;
  const result = render(tree());
  return { ...result, rerender: () => result.rerender(tree()) };
}
