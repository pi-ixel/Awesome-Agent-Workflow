import { Context } from "cordis";
import { expect, it } from "vitest";
import { desktopSettingsKey } from "../../../src/plugins/configuration/config.ts";
import { installDesktopFoundation } from "../../../src/bootstrap/foundation.ts";
import * as workbenchPlugin from "../../../src/plugins/workbench/index.ts";

it("Workbench 同根重装恢复外观并归还根元素和配置字段", async () => {
  const context = new Context();
  const root = document.createElement("div");
  root.style.setProperty("--ui-font-size", "13px", "important");
  window.localStorage.setItem(
    desktopSettingsKey,
    JSON.stringify({
      theme: "warm",
      uiFontSize: 17,
      approvalMode: "ask",
      unknownField: true,
    }),
  );
  try {
    const { configuration } = await installDesktopFoundation(context);
    const projectFields = configuration.register(desktopSettingsKey, [
      "approvalMode",
    ]);
    const fiber = await context.plugin(workbenchPlugin, {
      appearanceRoot: root,
    });
    const { appearance } = context.workbench;
    expect(projectFields.read()).toEqual({ approvalMode: "ask" });
    expect(() => projectFields.update({ theme: "dark" })).toThrow("超出作用域");
    expect(() => configuration.register(desktopSettingsKey, ["theme"])).toThrow(
      "无法注册",
    );
    expect(root.classList.contains("theme-warm")).toBe(true);
    expect(root.style.getPropertyValue("--ui-font-size")).toBe("17px");

    projectFields.update({ approvalMode: "auto-allow" });
    appearance.setUiFontSize(19);
    await fiber.dispose();
    expect(appearance.getSnapshot().uiFontSize).toBe(14);
    expect(root.classList.contains("theme-warm")).toBe(false);
    expect(root.style.getPropertyValue("--ui-font-size")).toBe("13px");
    expect(root.style.getPropertyPriority("--ui-font-size")).toBe("important");
    appearance.setUiFontSize(12);
    expect(configuration.read(desktopSettingsKey)).toEqual({
      theme: "warm",
      uiFontSize: 19,
      approvalMode: "auto-allow",
      unknownField: true,
    });

    await context.plugin(workbenchPlugin, { appearanceRoot: root });
    expect(context.workbench.appearance).not.toBe(appearance);
    expect(root.style.getPropertyValue("--ui-font-size")).toBe("19px");
    expect(root.classList.contains("theme-warm")).toBe(true);
  } finally {
    await context.fiber.dispose();
    window.localStorage.removeItem(desktopSettingsKey);
  }
});
