import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import type {} from "../../../src/plugins/scheduledTasks/service.ts";

it.each([
  { saved: null, enabled: true },
  { saved: "false", enabled: false },
])("uses the saved close-to-tray choice and defaults to enabled ($saved)", async ({ saved, enabled }) => {
  const key = "aaw-desktop/close-to-tray.v1";
  const setCloseToTray = vi.fn(() => Promise.resolve());
  const save = vi.fn();
  let restoreStorage = () => {};
  const runtime = createTestDesktopRuntime({ attachPreloading: () => () => {}, close: async () => {} }, undefined, (ctx) => {
    const read = ctx.host.storage.getItem.bind(ctx.host.storage);
    const readStorage = vi.spyOn(ctx.host.storage, "getItem").mockImplementation((name) => name === key ? saved : read(name));
    const writeStorage = vi.spyOn(ctx.host.storage, "setItem").mockImplementation(save);
    restoreStorage = () => { readStorage.mockRestore(); writeStorage.mockRestore(); };
    ctx.host.window.setCloseToTray = setCloseToTray;
  });
  try {
    const { workbench } = await runtime.ready;
    const settings = workbench.getSnapshot().settings.find(({ id }) => id === "scheduled-tasks");
    expect(settings).toBeDefined();
    const view = render(createElement(settings!.View, { active: true }));
    try {
      const toggle = screen.getByRole("switch", { name: "关闭窗口时留在托盘", checked: enabled });
      if (enabled) expect(setCloseToTray).toHaveBeenCalledWith(true);
      await userEvent.click(toggle);
      await waitFor(() => expect(screen.getByRole("switch", { checked: !enabled })).toBeEnabled());
      expect(setCloseToTray).toHaveBeenLastCalledWith(!enabled);
      expect(save).toHaveBeenCalledWith(key, String(!enabled));
    } finally {
      view.unmount();
    }
  } finally {
    await runtime.shutdown();
    restoreStorage();
  }
});

it.each([
  { result: false, message: "定时任务已由另一个 AAW Desktop 窗口管理" },
  { result: new Error("Command claim_scheduled_tasks not found"), message: "无法初始化定时任务" },
])("distinguishes scheduler ownership from IPC failure: $message", async ({ result, message }) => {
  let state: (() => { error: string }) | undefined;
  const runtime = createTestDesktopRuntime({ attachPreloading: () => () => {}, close: async () => {} }, undefined, (ctx) => {
    ctx.host.window.claimScheduledTasks = () => {
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    };
    state = () => ctx.scheduledTasks.store.getState();
  });
  try {
    await runtime.ready;
    expect(state!().error).toContain(message);
    expect(state!().error).not.toContain("Error: Error:");
    if (result instanceof Error) expect(state!().error).not.toContain("另一个");
  } finally { await runtime.shutdown(); }
});

it("restores task session ownership from persisted history, including deleted tasks", async () => {
  const session = { workspacePath: "D:/p", agentKey: "chrys", sessionId: "old-task-chat" };
  const exclude = vi.fn();
  const runtime = createTestDesktopRuntime({ attachPreloading: () => () => {}, close: async () => {} }, undefined, (ctx) => {
    const read = ctx.host.storage.getItem.bind(ctx.host.storage);
    vi.spyOn(ctx.host.storage, "getItem").mockImplementation((key) => key === "aaw-desktop/scheduled-tasks.v1"
      ? JSON.stringify({ tasks: [], runs: [{ id: "old", taskId: "deleted", at: 1, status: "success", session }] }) : read(key));
    vi.spyOn(ctx.project.sessions, "excludeSessionsFromCatalog").mockImplementation(exclude);
  });
  try {
    await runtime.ready;
    expect(exclude).toHaveBeenCalledWith([session]);
  } finally { await runtime.shutdown(); }
});
