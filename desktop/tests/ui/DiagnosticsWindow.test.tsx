import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  DiagnosticsWindow,
  type DiagnosticRecord,
} from "../../src/ui/DiagnosticsWindow.tsx";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
const row: DiagnosticRecord = {
  id: 100,
  at: 12345,
  runId: "boot-1",
  source: "main",
  level: "error",
  channel: "acp",
  message: "连接超时",
  context: { operationId: "op-1", error: "request timeout", durationMs: 90 },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockImplementation(async (command) => {
    await Promise.resolve();
    if (command === "diagnostics_status")
      return {
        now: 1000,
        debugUntil: 0,
        droppedBatches: 0,
        error: null,
        observing: true,
        latestId: 100,
      };
    if (command === "diagnostics_query") return [row];
    if (command === "diagnostics_snapshot")
      return {
        at: Date.now(),
        data: {
          theme: "warm",
          memorySamplingSupported: true,
          memory: [{ at: 1, bytes: 1048576 }],
          runtime: [{ sessionId: "main-session" }],
        },
      };
    if (command === "diagnostics_export") return 1;
    return undefined;
  });
});
afterEach(() => vi.useRealTimers());

it("读取主窗口快照，不在诊断窗口启动 Agent", async () => {
  render(<DiagnosticsWindow />);
  await screen.findByText("连接超时 · 90ms");
  fireEvent.click(screen.getByRole("button", { name: "运行时" }));
  expect(await screen.findByText("main-session")).toBeVisible();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.every(([name]) => name.startsWith("diagnostics_")),
  ).toBe(true);
});
it("独立窗口保留性能图与存储视图，读数来自主窗口", async () => {
  render(<DiagnosticsWindow />);
  await screen.findByText("连接超时 · 90ms");
  fireEvent.click(screen.getByRole("button", { name: "性能" }));
  expect(screen.getByRole("heading", { name: "内存" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "对话存储" })).toBeVisible();
});

it("详情按操作关联标识查询，导出沿用当前筛选", async () => {
  render(<DiagnosticsWindow />);
  fireEvent.click(await screen.findByText("连接超时 · 90ms"));
  expect(screen.getByLabelText("日志详情")).toHaveTextContent(
    "request timeout",
  );
  fireEvent.click(screen.getByRole("button", { name: "查看关联操作" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("diagnostics_query", {
      query: expect.objectContaining({ operation: "op-1" }) as Record<
        string,
        unknown
      >,
    }),
  );
  vi.mocked(save).mockResolvedValue("D:/logs/export.jsonl");
  fireEvent.click(screen.getByRole("button", { name: "导出匹配日志" }));
  expect(await screen.findByRole("status")).toHaveTextContent("已导出 1 条");
  expect(invoke).toHaveBeenCalledWith("diagnostics_export", {
    path: "D:/logs/export.jsonl",
    query: expect.objectContaining({ operation: "op-1" }) as Record<
      string,
      unknown
    >,
  });
});

it("暂停只冻结显示，仍刷新状态且可查询更早记录", async () => {
  vi.useFakeTimers();
  render(<DiagnosticsWindow />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(screen.getByText("连接超时 · 90ms")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "暂停跟随" }));
  const before = vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === "diagnostics_query").length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "diagnostics_query"),
  ).toHaveLength(before);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "diagnostics_snapshot").length,
  ).toBeGreaterThan(1);
  fireEvent.click(screen.getByRole("button", { name: /加载更早记录/ }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(invoke).toHaveBeenCalledWith("diagnostics_query", {
    query: expect.objectContaining({ before: 100 }) as Record<string, unknown>,
  });
});

it("详细日志由原生服务限时控制，导出失败明确反馈", async () => {
  render(<DiagnosticsWindow />);
  await screen.findByText("连接超时 · 90ms");
  fireEvent.click(screen.getByRole("button", { name: "详细日志 · 30 分钟" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("diagnostics_debug", { enabled: true }),
  );
  vi.mocked(save).mockRejectedValue(new Error("permission denied"));
  fireEvent.click(screen.getByRole("button", { name: "导出匹配日志" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "permission denied",
  );
});
