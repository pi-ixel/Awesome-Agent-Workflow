import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DiagnosticsWindow } from "../../../src/plugins/diagnostics/ui/DiagnosticsWindow.tsx";
import type { DiagnosticRecord } from "../../../src/plugins/diagnostics/types.ts";
import type { HostDialogs } from "../../../src/plugins/host/types.ts";
import { diagnosticsHost } from "../../../src/plugins/host/adapters/diagnostics.ts";
import { createDiagnosticsReader } from "../../../src/plugins/diagnostics/reader/nativeReader.ts";

const save = vi.fn<HostDialogs["saveFile"]>();
const reader = createDiagnosticsReader(diagnosticsHost, save, () => true);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
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

it("保留向上翻阅的位置，滚回底部后继续跟随新日志", async () => {
  vi.useFakeTimers();
  const query = vi.fn().mockResolvedValueOnce([row]).mockResolvedValue([]);
  render(<DiagnosticsWindow reader={{ ...reader, query }} />);
  const viewport = screen.getByLabelText("日志列表");
  let height = 500;
  Object.defineProperties(viewport, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 100 },
  });
  await act(() => vi.advanceTimersByTimeAsync(250));

  viewport.scrollTop = 120;
  fireEvent.scroll(viewport);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(viewport.scrollTop).toBe(120);

  height = 550;
  query.mockResolvedValueOnce([{ ...row, id: 101, message: "新增日志" }]);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(screen.getByText("新增日志 · 90ms")).toBeVisible();
  expect(viewport.scrollTop).toBe(120);

  viewport.scrollTop = 450;
  fireEvent.scroll(viewport);
  height = 600;
  query.mockResolvedValueOnce([{ ...row, id: 102 }]);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(viewport.scrollTop).toBe(600);
});

it("取消选择或导出期间卸载时，不发出写文件请求", async () => {
  save.mockResolvedValueOnce(null);
  await expect(reader.export({})).resolves.toBeNull();
  let finish!: (path: string) => void;
  save.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  let active = true;
  const scopedReader = createDiagnosticsReader(
    diagnosticsHost,
    save,
    () => active,
  );
  const exportTask = scopedReader.export({ level: "error" });
  active = false;
  finish("D:/logs/export.jsonl");
  await expect(exportTask).resolves.toBeNull();
  const options = save.mock.calls[0]?.[0];
  expect(options?.defaultPath).toMatch(/^aaw-diagnostics-\d+\.jsonl$/);
  expect(options?.filters).toEqual([
    { name: "JSON Lines", extensions: ["jsonl"] },
  ]);
  expect(invoke).not.toHaveBeenCalled();
});

it("读取主窗口快照，不在诊断窗口启动 Agent", async () => {
  render(<DiagnosticsWindow reader={reader} />);
  await screen.findByText("连接超时 · 90ms");
  fireEvent.click(screen.getByRole("button", { name: "资源与连接" }));
  expect(await screen.findByText("main-session")).toBeVisible();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.every(([name]) => name.startsWith("diagnostics_")),
  ).toBe(true);
});
it("资源页移除独立 JS 内存图与性能标签", async () => {
  render(<DiagnosticsWindow reader={reader} />);
  await screen.findByText("连接超时 · 90ms");
  expect(screen.queryByRole("button", { name: "性能" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "资源与连接" }));
  expect(screen.queryByRole("heading", { name: "前端 JS 内存" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "对话存储" })).not.toBeInTheDocument();
});

it("显示连接负载并通过主窗口请求测速", async () => {
  let resultAt = Date.now() - 60_000;
  vi.mocked(invoke).mockImplementation(async (command) => {
    await Promise.resolve();
    if (command === "diagnostics_status")
      return { now: Date.now(), observing: true, latestId: 0 };
    if (command === "diagnostics_query") return [];
    if (command === "diagnostics_snapshot")
      return {
        at: Date.now(),
        data: {
          theme: "dark",
          runtime: [],
          memory: [],
          memorySamplingSupported: false,
          connections: [
            {
              id: "connection-one",
              state: "ready",
              probe: {
                at: resultAt,
                status: "success",
                durationMs: resultAt > Date.now() - 30_000 ? 23 : 92,
              },
              sessions: [
                {
                  id: "s1",
                  state: "ready",
                  running: true,
                  project: { id: "p", path: "C:/Project" },
                },
                {
                  id: "s2",
                  state: "ready",
                  running: false,
                  project: { id: "p", path: "C:/Project" },
                },
              ],
            },
          ],
        },
      };
    return undefined;
  });
  render(<DiagnosticsWindow reader={reader} />);
  fireEvent.click(screen.getByRole("button", { name: "资源与连接" }));
  expect(await screen.findByLabelText("connection-one 负载")).toHaveTextContent(
    "项目1session2执行中1",
  );
  fireEvent.click(screen.getByRole("button", { name: "测试" }));
  expect(screen.getByRole("button", { name: "测试中…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "测试中 · 1 条" })).toBeDisabled();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("diagnostics_probe_request", {
      id: "connection-one",
    }),
  );
  expect(await screen.findByText("等待测速结果…")).toBeVisible();
  expect(screen.queryByText("92 ms")).not.toBeInTheDocument();
  resultAt = Date.now();
  expect(await screen.findByText("23 ms", {}, { timeout: 3000 })).toBeVisible();
  expect(screen.getByRole("button", { name: "测试" })).toBeEnabled();
});

it("详情直接单行展示，悬浮可读原始字段，关联搜索及导出共用关键词", async () => {
  render(<DiagnosticsWindow reader={reader} />);
  await screen.findByText("连接超时 · 90ms");
  expect(screen.queryByRole("button", { name: "ACP 事件" })).toBeNull();
  expect(screen.getByRole("button", { name: "日志" })).toBeVisible();
  expect(screen.queryByLabelText("操作关联标识")).toBeNull();
  const detail = screen.getByLabelText("详情：连接超时");
  expect(detail).toHaveClass("truncate", "whitespace-nowrap");
  expect(detail).toHaveTextContent("request timeout");
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.mouseEnter(detail);
  expect(
    screen.getByRole("dialog", { name: "原始日志详情" }),
  ).toHaveTextContent("request timeout");
  fireEvent.click(screen.getByRole("button", { name: "关联操作" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("diagnostics_query", {
      query: expect.objectContaining({ text: "op-1", channel: "" }) as Record<
        string,
        unknown
      >,
    }),
  );
  expect(screen.getByLabelText("关键词")).toHaveValue("op-1");
  vi.mocked(save).mockResolvedValue("D:/logs/export.jsonl");
  fireEvent.click(screen.getByRole("button", { name: "导出匹配日志" }));
  expect(screen.getByRole("button", { name: "正在导出…" })).toBeDisabled();
  expect(await screen.findByRole("status")).toHaveTextContent("已导出 1 条");
  expect(screen.getByRole("button", { name: "导出匹配日志" })).toBeEnabled();
  expect(invoke).toHaveBeenCalledWith("diagnostics_export", {
    path: "D:/logs/export.jsonl",
    query: expect.objectContaining({ text: "op-1" }) as Record<string, unknown>,
  });
});

it("从详情单元格移入浮窗仍可操作，Esc关闭", async () => {
  vi.useFakeTimers();
  render(<DiagnosticsWindow reader={reader} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  const cell = screen.getByLabelText("详情：连接超时");
  fireEvent.focus(cell);
  fireEvent.mouseLeave(cell);
  fireEvent.mouseEnter(screen.getByRole("dialog"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(screen.getByRole("button", { name: "复制" })).toBeVisible();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("可以直接加载更早记录，并继续刷新新日志", async () => {
  vi.useFakeTimers();
  const query = vi
    .fn<typeof reader.query>()
    .mockImplementation((filters) =>
      Promise.resolve(
        filters.before === 100
          ? [{ ...row, id: 99, message: "更早的日志" }]
          : filters.after === undefined
            ? [row]
            : [],
      ),
    );
  render(<DiagnosticsWindow reader={{ ...reader, query }} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(screen.getByText("连接超时 · 90ms")).toBeVisible();
  expect(screen.queryByRole("button", { name: "暂停跟随" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "加载更早记录" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(query).toHaveBeenCalledWith(expect.objectContaining({ before: 100 }));
  expect(screen.getByText("更早的日志 · 90ms")).toBeVisible();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(query).toHaveBeenCalledWith(expect.objectContaining({ after: 100 }));
  expect(screen.getByText("更早的日志 · 90ms")).toBeVisible();
});

it("不再提供临时详细开关，导出失败明确反馈", async () => {
  render(<DiagnosticsWindow reader={reader} />);
  await screen.findByText("连接超时 · 90ms");
  expect(screen.queryByRole("button", { name: /详细日志/ })).toBeNull();
  vi.mocked(save).mockRejectedValue(new Error("permission denied"));
  fireEvent.click(screen.getByRole("button", { name: "导出匹配日志" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "permission denied",
  );
});

it("loads ACP original text on demand without putting payloads in list queries", async () => {
  const original =
    ' { "id": 1, "result": { "content": "' + "x".repeat(40000) + '" } } ';
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(
      command === "diagnostics_query"
        ? [{ ...row, hasRaw: true }]
        : command === "diagnostics_raw"
          ? original
          : command === "diagnostics_status"
            ? { now: Date.now(), latestId: 100 }
            : null,
    ),
  );
  render(<DiagnosticsWindow reader={reader} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看原文" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("diagnostics_raw", { id: 100 }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("dialog", { name: "ACP 原始报文" }).querySelector("pre")
        ?.textContent,
    ).toBe(original),
  );
  fireEvent.click(screen.getByRole("button", { name: "关闭原文" }));
  expect(screen.queryByRole("dialog", { name: "ACP 原始报文" })).toBeNull();
});

it("shows expired ACP originals as an error instead of displaying empty success", async () => {
  vi.mocked(invoke).mockImplementation((command) =>
    command === "diagnostics_raw"
      ? Promise.reject(new Error("原文已清理"))
      : Promise.resolve(
          command === "diagnostics_query"
            ? [{ ...row, hasRaw: true }]
            : command === "diagnostics_status"
              ? { now: Date.now(), latestId: 100 }
              : null,
        ),
  );
  render(<DiagnosticsWindow reader={reader} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看原文" }));
  expect(await screen.findByText(/原文已清理/)).toBeVisible();
  expect(screen.getByRole("button", { name: "复制原文" })).toBeDisabled();
});
