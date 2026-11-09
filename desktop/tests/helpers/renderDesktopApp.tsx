import { render } from "@testing-library/react";
import App from "../../src/bootstrap/App.tsx";
import type { WorkbenchService } from "../../src/contracts/workbench.ts";
import { WorkbenchContext } from "../../src/plugins/workbench/react.ts";

export function renderDesktopApp(workbench: WorkbenchService) {
  const tree = () => (
    <WorkbenchContext.Provider value={workbench}>
      <App />
    </WorkbenchContext.Provider>
  );
  const result = render(tree());
  return { ...result, rerender: () => result.rerender(tree()) };
}
