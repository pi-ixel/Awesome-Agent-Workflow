/**
 * src/ui/DiagnosticsPage 测试：运行日志过滤、诊断页签与清空。
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import DiagnosticsPage, {
  resetDiagnosticsTabForTests,
} from "../../src/ui/DiagnosticsPage";
import { useLogStore } from "../../src/stores/logStore";
import { appLogSink } from "../../src/core/logger";
import { selectFromListbox } from "../helpers/listbox";

function seedDiagnostics(): void {
  // 先把全局级别调到 debug（该操作本身会写一条切换日志），再清空，
  // 最后经真实写入口（ring）注入三条样本日志——计数断言才稳定
  useLogStore.getState().setLevel("debug");
  useLogStore.getState().clear();
  appLogSink.log("info", "acp", "连接已建立");
  appLogSink.log("error", "aaw", "CLI 调用失败");
  appLogSink.log("debug", "store", "调试细节", { turn: 2 });
}

describe("DiagnosticsPage", () => {
  beforeEach(() => {
    resetDiagnosticsTabForTests();
    seedDiagnostics();
  });

  it("默认展示运行日志并按级别过滤", async () => {
    render(<DiagnosticsPage />);
    expect(screen.getByText("连接已建立")).toBeInTheDocument();
    expect(screen.getByText("CLI 调用失败")).toBeInTheDocument();

    await selectFromListbox(userEvent.setup(), "日志级别过滤", "error 及以上");
    expect(screen.queryByText("连接已建立")).not.toBeInTheDocument();
    expect(screen.getByText("CLI 调用失败")).toBeInTheDocument();
    expect(screen.getByText(/显示 1 \/ 3 条/)).toBeInTheDocument();
  });

  it("通道关键字过滤", async () => {
    render(<DiagnosticsPage />);
    await userEvent.type(screen.getByLabelText("日志通道过滤"), "acp");
    expect(screen.getByText("连接已建立")).toBeInTheDocument();
    expect(screen.queryByText("CLI 调用失败")).not.toBeInTheDocument();
  });

  it("仅保留运行日志、性能与运行时页签", () => {
    render(<DiagnosticsPage />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(
      screen.queryByRole("tab", { name: /ACP 流量/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "性能" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "运行时" })).toBeInTheDocument();
  });

  it("清空运行日志缓冲", async () => {
    render(<DiagnosticsPage />);
    await userEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(screen.getByText(/显示 0 \/ 0 条/)).toBeInTheDocument();
    expect(useLogStore.getState().entries).toEqual([]);
  });

  it("全局日志级别调整同步到 logStore", async () => {
    render(<DiagnosticsPage />);
    await selectFromListbox(userEvent.setup(), "全局日志级别", "warn");
    expect(useLogStore.getState().level).toBe("warn");
    // 复位也要在 act 内：级别切换会写一条日志并镜像进 store，
    // 组件仍挂载，act 外更新会触发 RTL 警告
    act(() => {
      useLogStore.getState().setLevel("info");
    });
  });

  it("协议自检已移入设置页「Agent」分片：诊断页只剩三枚 tab", () => {
    render(<DiagnosticsPage />);
    expect(
      screen.queryByRole("tab", { name: "协议自检" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /运行日志/ })).toBeInTheDocument();
  });
});
