/**
 * src/ui/DiagnosticsPage 测试：运行日志过滤、诊断页签与清空。
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import DiagnosticsPage from "../../../src/plugins/diagnostics/ui/DiagnosticsPage.tsx";
import { createTestDiagnostics } from "../../helpers/diagnostics.ts";
import { selectFromListbox } from "../../helpers/listbox";

let fixture: ReturnType<typeof createTestDiagnostics>;

function seedDiagnostics(): void {
  // 先把当前诊断实例的级别调到 debug（该操作本身会写一条切换日志），再清空，
  // 最后经真实写入口（ring）注入三条样本日志——计数断言才稳定
  fixture.diagnostics.setLogLevel("debug");
  fixture.diagnostics.clearLogs();
  fixture.diagnostics.createLogger("acp").info( "连接已建立");
  fixture.diagnostics.createLogger("aaw").error( "CLI 调用失败");
  fixture.diagnostics.createLogger("store").debug( "调试细节", { turn: 2 });
}

describe("DiagnosticsPage", () => {
  beforeEach(() => {
    fixture = createTestDiagnostics();
    seedDiagnostics();
  });

  afterEach(() => fixture.dispose());

  it("默认展示运行日志并按级别过滤", async () => {
    render(<DiagnosticsPage diagnostics={fixture.diagnostics} />);
    expect(screen.getByText("连接已建立")).toBeInTheDocument();
    expect(screen.getByText("CLI 调用失败")).toBeInTheDocument();

    await selectFromListbox(userEvent.setup(), "日志级别过滤", "error 及以上");
    expect(screen.queryByText("连接已建立")).not.toBeInTheDocument();
    expect(screen.getByText("CLI 调用失败")).toBeInTheDocument();
    expect(screen.getByText(/显示 1 \/ 3 条/)).toBeInTheDocument();
  });

  it("通道关键字过滤", async () => {
    render(<DiagnosticsPage diagnostics={fixture.diagnostics} />);
    await userEvent.type(screen.getByLabelText("日志通道过滤"), "acp");
    expect(screen.getByText("连接已建立")).toBeInTheDocument();
    expect(screen.queryByText("CLI 调用失败")).not.toBeInTheDocument();
  });

  it("仅保留运行日志、性能与运行时页签", () => {
    render(<DiagnosticsPage diagnostics={fixture.diagnostics} />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(
      screen.queryByRole("tab", { name: /ACP 流量/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "性能" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "运行时" })).toBeInTheDocument();
  });

  it("清空运行日志缓冲", async () => {
    render(<DiagnosticsPage diagnostics={fixture.diagnostics} />);
    await userEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(screen.getByText(/显示 0 \/ 0 条/)).toBeInTheDocument();
    expect(fixture.diagnostics.logs.getState().entries).toEqual([]);
  });

  it("全局日志级别调整同步到 logStore", async () => {
    render(<DiagnosticsPage diagnostics={fixture.diagnostics} />);
    await selectFromListbox(userEvent.setup(), "全局日志级别", "warn");
    expect(fixture.diagnostics.logs.getState().level).toBe("warn");
    // 复位也要在 act 内：级别切换会写一条日志并镜像进 store，
    // 组件仍挂载，act 外更新会触发 RTL 警告
    act(() => {
      fixture.diagnostics.setLogLevel("info");
    });
  });

  it("协议自检已移入设置页「Agent」分片：诊断页只剩三枚 tab", () => {
    render(<DiagnosticsPage diagnostics={fixture.diagnostics} />);
    expect(
      screen.queryByRole("tab", { name: "协议自检" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /运行日志/ })).toBeInTheDocument();
  });
});
