import { Context } from "cordis";
import { expect, it, vi } from "vitest";
import { desktopSettingsKey } from "../../src/contracts/configuration.ts";
import { installDesktopFoundation } from "../../src/bootstrap/foundation.ts";
import * as workbenchPlugin from "../../src/plugins/workbench/plugin.ts";
import * as agentsPlugin from "../../src/plugins/agents/plugin.ts";
import * as acpConnectionPlugin from "../../src/plugins/acpConnection/plugin.ts";

it("设置经 Cordis 写回原存储键，独立诊断可读取主题，卸载后释放注册", async () => {
  const context = new Context();
  const diagnosticWindow = new Context();
  try {
    window.localStorage.setItem(
      desktopSettingsKey,
      JSON.stringify({
        theme: "warm",
        language: "en-US",
        foreignField: { kept: true },
      }),
    );
    const { configuration } = await installDesktopFoundation(context);
    const { diagnostics } = await installDesktopFoundation(diagnosticWindow);
    await context.plugin(acpConnectionPlugin);
    vi.spyOn(context.acpConnection, "createTransport").mockImplementation(() => {
      throw new Error("Unexpected Agent launch");
    });
    await context.plugin(agentsPlugin);
    await context.plugin(workbenchPlugin);
    const { appearance } = context.workbench;
    expect(appearance.getSnapshot().language).toBe("zh-CN");
    expect(diagnostics.startupTheme()).toBe("warm");
    expect(diagnosticWindow.acpRuntime).toBeUndefined();
    expect(diagnosticWindow.workbench).toBeUndefined();
    expect(diagnosticWindow.documents).toBeUndefined();
    expect(diagnosticWindow.git).toBeUndefined();
    expect(diagnosticWindow.terminal).toBeUndefined();
    expect(diagnosticWindow.workflow).toBeUndefined();
    expect(diagnosticWindow.skills).toBeUndefined();
    expect(diagnosticWindow.account).toBeUndefined();
    expect(diagnosticWindow.updates).toBeUndefined();
    expect(() => configuration.register(desktopSettingsKey)).toThrow(
      "无法注册",
    );

    context.agents.configuration.getState().setAgentSettings("custom-test", { executablePath: "D:/agent.exe" });
    appearance.setTheme("dark");
    expect(diagnostics.startupTheme()).toBe("dark");
    expect(configuration.read(desktopSettingsKey)).toMatchObject({
      theme: "dark",
      language: "en-US",
      agentSettings: { "custom-test": { executablePath: "D:/agent.exe" } },
      foreignField: { kept: true },
    });

    const scope = configuration.register("test.preferences");
    const observed = vi.fn();
    const unsubscribe = scope.subscribe(observed);
    scope.update({ visible: true });
    expect(observed).toHaveBeenCalledWith({ visible: true });
    unsubscribe();
    scope.update({ visible: false });
    expect(observed).toHaveBeenCalledTimes(1);
    await context.fiber.dispose();
    expect(() => scope.update({ visible: true })).toThrow("已释放");
    expect(window.localStorage.getItem("test.preferences")).toBe(
      '{"visible":false}',
    );
  } finally {
    await context.fiber.dispose();
    await diagnosticWindow.fiber.dispose();
    window.localStorage.clear();
  }
});

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
