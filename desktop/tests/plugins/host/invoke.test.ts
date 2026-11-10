import { beforeEach, expect, it, vi } from "vitest";
import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { createInvoke } from "../../../src/plugins/host/adapters/invoke.ts";
import { LogSink } from "../../../src/plugins/diagnostics/capture/logSink.ts";
import type { ExitDiagnostics } from "../../../src/plugins/host/types.ts";
import { DesktopHost } from "../../../src/plugins/host/lifecycle/runtime.ts";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const logs = new LogSink();
const invoke = createInvoke(logs.createLogger("host"));
beforeEach(() => {
  vi.clearAllMocks();
  logs.setLevel("info");
  logs.clear();
});
it("原生调用保持参数和返回值，日志只包含定位元信息", async () => {
  const args = {
    path: "D:/project/file.md",
    content: "private file body",
    token: "private credential",
  };
  vi.mocked(nativeInvoke).mockResolvedValue({ content: "private response" });
  expect(await invoke("panel_preview", args)).toEqual({
    content: "private response",
  });
  expect(nativeInvoke).toHaveBeenCalledWith("panel_preview", args);
  const entries = logs.snapshot();
  expect(entries).toHaveLength(2);
  expect(entries[0]?.context.operationId).toBe(entries[1]?.context.operationId);
  expect(entries[0]?.context.path).toBe(args.path);
  expect(JSON.stringify(entries)).not.toMatch(
    /private file body|private credential|private response/,
  );
});
it("非零退出码记录失败，异常继续传播", async () => {
  vi.mocked(nativeInvoke).mockResolvedValue({
    code: 1,
    stderr: "not recorded",
  });
  await invoke("run_command", { program: "tool", args: ["secret"] });
  expect(logs.snapshot().at(-1)?.level).toBe("warn");
  vi.mocked(nativeInvoke).mockRejectedValue(new Error("missing file"));
  await expect(invoke("panel_preview", { path: "missing" })).rejects.toThrow(
    "missing file",
  );
  expect(logs.snapshot().at(-1)?.context.error).toContain("missing file");
});

it.each(["force_close", "update_install"] as const)(
  "%s 等待诊断落盘后再执行原生命令",
  async (command) => {
    let complete!: () => void;
    const flush = vi.fn<ExitDiagnostics>().mockImplementation(() => new Promise<void>((resolve) => {
      complete = resolve;
    }));
    const sink = new LogSink(1, "info");
    const unsubscribe = sink.subscribeEntry(() => sink.clear());
    const host = new DesktopHost({ createLogger: sink.createLogger });
    host.registerExitDiagnostics(flush);
    vi.mocked(nativeInvoke).mockResolvedValueOnce(undefined);
    const call = command === "force_close" ? host.window.forceClose() : host.updates.install();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(expect.objectContaining({
      channel: "host",
      context: expect.objectContaining({ command, stage: "start" }) as unknown,
    }));
    expect(sink.snapshot()).toEqual([]);
    expect(nativeInvoke).not.toHaveBeenCalled();
    complete();
    await call;
    expect(nativeInvoke).toHaveBeenCalledWith(command);
    unsubscribe();
    await host.dispose();
  },
);
