import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { DiagnosticsReader } from "../../../src/plugins/diagnostics/types.ts";
import { createStorageSettings } from "../../../src/plugins/diagnostics/ui/StorageSettings.tsx";
import { desktopManagedStorage } from "../../../src/plugins/host/service.ts";

it("shows a non-modal storage reminder and opens management only on request", async () => {
  const openSettings = vi.fn();
  const reader = {
    storage: vi.fn(() => Promise.resolve([
      {
        id: "diagnostics.logs",
        label: "诊断日志",
        bytes: 101 * 1024 ** 2,
        count: 1,
        protected: 0,
        cleanable: true,
      },
    ])),
  } as unknown as DiagnosticsReader;
  const { Monitor } = createStorageSettings(reader, openSettings);
  const work = vi.fn();
  const firstRun = render(
    <>
      <button onClick={work}>继续工作</button>
      <Monitor />
    </>,
  );

  await screen.findByText("存储超阈值");
  expect(screen.getByText("101.0/100 MiB")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(openSettings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "继续工作" }));
  expect(work).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "管理" }));
  expect(openSettings).toHaveBeenCalledOnce();
  expect(screen.queryByText("存储超阈值")).toBeNull();
  firstRun.unmount();

  const reminderKey = "aaw-desktop/storage-reminders.v1";
  localStorage.setItem(reminderKey, JSON.stringify(["logs"]));
  try {
    const restarted = createStorageSettings(reader, openSettings);
    render(<restarted.Monitor />);
    await screen.findByText("存储超阈值");
  } finally {
    localStorage.removeItem(reminderKey);
  }
});

it("groups settings, edits one conversation threshold, and keeps separate cleanup controls", async () => {
  const storage = vi.fn(() => Promise.resolve([
    {
      id: "project.session-cache",
      label: "会话快照",
      bytes: 2,
      count: 1,
      protected: 0,
      cleanable: true,
    },
    {
      id: "diagnostics.logs",
      label: "诊断日志",
      bytes: 3,
      count: 1,
      protected: 0,
      cleanable: true,
    },
    {
      id: "project.prompt-history",
      label: "提示词历史",
      bytes: 4,
      count: 1,
      protected: 0,
      cleanable: true,
    },
    {
      id: "project.message-images",
      label: "已发送图片",
      bytes: 5,
      count: 1,
      protected: 0,
      cleanable: true,
    },
    {
      id: "configuration.native",
      label: "应用设置与会话管理",
      bytes: 6,
      count: 1,
      protected: 0,
      cleanable: false,
    },
    {
      id: "updates.settings",
      label: "更新设置",
      bytes: 7,
      count: 1,
      protected: 0,
      cleanable: false,
    },
  ]));
  const reader = { storage } as unknown as DiagnosticsReader;
  const { Settings } = createStorageSettings(reader, vi.fn());
  render(<Settings />);

  await screen.findByText("会话快照");
  expect(screen.getByText("诊断日志")).toBeTruthy();
  expect(screen.getByText("提醒阈值")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "管理存储" })).toBeNull();
  expect(screen.queryByRole("button", { name: "返回存储概览" })).toBeNull();
  expect(storage).toHaveBeenCalledWith({ action: "list" });
  const settings = within(screen.getByRole("region", { name: "设置" }));
  expect(settings.queryByRole("heading", { name: "设置" })).toBeNull();
  const settingsHelp = settings.getByRole("button", {
    name: "应用设置与会话管理说明",
  });
  fireEvent.focus(settingsHelp);
  expect(screen.getByRole("tooltip").textContent).toContain(
    "会话标题、置顶与归档",
  );
  fireEvent.keyDown(settingsHelp, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(
    settings.getByRole<HTMLInputElement>("spinbutton", {
      name: "应用设置与会话管理提醒阈值（MiB）",
    }).value,
  ).toBe("100");
  expect(
    settings.getByRole<HTMLInputElement>("spinbutton", {
      name: "更新设置提醒阈值（MiB）",
    }).value,
  ).toBe("10");
  fireEvent.click(settings.getByRole("button", { name: "展开更新设置" }));
  expect(settings.getByRole("checkbox", { name: /应用数据/ })).toBeTruthy();
  expect(settings.queryByText("全局")).toBeNull();

  const conversation = within(
    screen.getByRole("region", { name: "会话输入与附件" }),
  );
  const threshold = conversation.getByRole<HTMLInputElement>("spinbutton", {
    name: "会话输入与附件提醒阈值（MiB）",
  });
  expect(
    conversation.queryByRole("button", { name: "展开提示词历史" }),
  ).toBeNull();
  fireEvent.click(
    conversation.getByRole("button", { name: "展开会话输入与附件" }),
  );
  const imagesHelp = conversation.getByRole("button", {
    name: "已发送图片说明",
  });
  fireEvent.focus(imagesHelp);
  expect(screen.getByRole("tooltip").textContent).toBe(
    "用于在聊天回放中恢复的已发送图片。",
  );
  fireEvent.blur(imagesHelp);
  expect(conversation.getAllByRole("spinbutton")).toEqual([threshold]);
  fireEvent.click(conversation.getByRole("button", { name: "展开提示词历史" }));
  fireEvent.click(conversation.getByRole("button", { name: "展开已发送图片" }));
  const [history, images] =
    conversation.getAllByRole<HTMLInputElement>("checkbox");
  fireEvent.click(images!);
  expect(images?.checked).toBe(true);
  expect(history?.checked).toBe(false);

  await waitFor(() => expect(threshold.disabled).toBe(false));
  expect(threshold.value).toBe("500");
  fireEvent.change(threshold, { target: { value: "650" } });
  fireEvent.blur(threshold);
  await waitFor(() => expect(threshold.disabled).toBe(false));
  expect(
    JSON.parse(
      localStorage.getItem("aaw-desktop/storage-thresholds.v1") ?? "{}",
    ),
  ).toEqual({ conversation: 650 });
  localStorage.removeItem("aaw-desktop/storage-thresholds.v1");
});

it("shows the current storage path and schedules a folder picked by the user", async () => {
  const currentPath = "C:\\Users\\User\\AppData\\Local\\com.aaw.desktop";
  const pendingPath = "D:\\Storage\\com.aaw.desktop";
  const available = vi
    .spyOn(desktopManagedStorage, "available")
    .mockReturnValue(true);
  const request = vi
    .spyOn(desktopManagedStorage, "request")
    .mockImplementation((command) => {
      if (command === "storage_thresholds_read") return Promise.resolve({});
      return Promise.resolve({
        currentPath,
        pendingPath:
          command === "storage_location_schedule" ? pendingPath : null,
        migrationError: null,
      });
    });
  const pick = vi.fn(() => Promise.resolve("D:\\Storage"));
  try {
    const { Settings } = createStorageSettings(
      { storage: () => Promise.resolve([]) } as unknown as DiagnosticsReader,
      vi.fn(),
      pick,
    );
    render(<Settings />);
    const path = screen.getByLabelText<HTMLInputElement>("数据存储路径");
    await waitFor(() => expect(path.value).toBe(currentPath));
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    await waitFor(() => expect(path.value).toBe("D:\\Storage"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("重启后迁移到 " + pendingPath);
    expect(path.value).toBe(currentPath);
    expect(request).toHaveBeenCalledWith("storage_location_schedule", {
      parent: "D:\\Storage",
    });
  } finally {
    request.mockRestore();
    available.mockRestore();
  }
});
