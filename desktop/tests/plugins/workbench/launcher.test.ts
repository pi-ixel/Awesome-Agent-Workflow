import { it, expect } from "vitest";
import type { Context } from "cordis";
import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import { openLauncherPanel } from "../../../src/plugins/workbench/navigation/launcher.ts";
import { pathKey } from "../../../src/shared/panelPaths.ts";

it("prepares context through contributions, opens once and handles absent context without an error", async () => {
  let ctx: Context | undefined;
  const runtime = createTestDesktopRuntime({ attachPreloading: () => () => {}, close: async () => {} }, undefined, (value) => { ctx = value; });
  try {
    await runtime.ready;
    const workbench = ctx!.workbench;
    let ready = false;
    workbench.register("panels", { id: "tools", View: () => null, launcher: {
      label: "Tools", description: "", Icon: () => null,
      prepareGlobalOpen: () => {
        if (!ready) return Promise.resolve(null);
        workbench.navigation.getState().openView("project", "E:/launcher-project");
        return Promise.resolve("E:/launcher-project");
      },
    } });
    await expect(openLauncherPanel(workbench, "not-registered")).rejects.toThrow("不可用");
    await expect(openLauncherPanel(workbench, "tools")).resolves.toBeUndefined();
    ready = true;
    await openLauncherPanel(workbench, "tools");
    const panel = workbench.panels.getState().projects[pathKey("E:/launcher-project")];
    expect(panel?.active).toBe("tools");
    await openLauncherPanel(workbench, "tools");
    expect(workbench.panels.getState().projects[pathKey("E:/launcher-project")]?.tabs.filter((tab) => tab.id === "tools")).toHaveLength(1);
  } finally { await runtime.shutdown(); }
});
