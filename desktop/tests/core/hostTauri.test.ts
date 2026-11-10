/**
 * host.ts 的 Tauri 实现回归测试（直接构造 createTauriHost）：`runCommand` 必须调用 Rust 侧真实注册的
 * `run_command` 命令（参数 program/args/cwd/timeoutMs）并按其 wire 形状
 * （ok/code/stdout/stderr/failure/durationMs）解析——此前并行开发期它
 * 调用的是不存在的 `run_cli`（期望 exitCode 字段），Tauri 环境下必失败。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { createTauriHost } from "../../src/plugins/host/adapters/host.ts";

// 本组直接测 Tauri 后端的 wire 契约。
const host = createTauriHost();

const invokeCalls: { command: string; args: Record<string, unknown> }[] = [];

beforeEach(() => {
  invokeCalls.length = 0;
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
    const record = (args ?? {}) as Record<string, unknown>;
    invokeCalls.push({ command, args: record });
    if (command === "run_command") {
      return Promise.resolve({
        ok: true,
        code: 0,
        stdout: "chrys 0.22.1\n",
        stderr: "",
        failure: null,
        durationMs: 88,
      });
    }
    return Promise.resolve(null);
  });
});

describe("runCommand（Tauri 实现的 wire 契约）", () => {
  it("调用 run_command 并正确解析 wire 形状", async () => {
    const result = await host.runCommand("chrys.exe", ["--version"]);
    expect(result).toEqual({
      code: 0,
      stdout: "chrys 0.22.1\n",
      stderr: "",
    });
    const call = invokeCalls.find((entry) => entry.command === "run_command");
    expect(call).toBeDefined();
    expect(call?.args).toMatchObject({
      program: "chrys.exe",
      args: ["--version"],
    });
    // 不再调用并行开发期臆造的 run_cli
    expect(invokeCalls.some((entry) => entry.command === "run_cli")).toBe(
      false,
    );
  });

  it("wire 形状不合法时回落失败而不抛出", async () => {
    vi.mocked(invoke).mockResolvedValue("not-an-object");
    const result = await host.runCommand("chrys", ["acp"]);
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain("形状不合法");
  });

  it("invoke 抛错（非 Tauri 环境 / IPC 断连）时按执行失败处理", async () => {
    vi.mocked(invoke).mockRejectedValue(
      new Error("__TAURI_INTERNALS__ 未定义"),
    );
    const result = await host.runCommand("chrys", ["acp"]);
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain("__TAURI_INTERNALS__");
  });
});
