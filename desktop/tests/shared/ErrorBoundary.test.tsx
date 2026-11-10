/**
 * 两级错误边界：局部边界的面板 fallback + 重试恢复 + resetKey 自动重置；
 * 根级边界的整页 fallback。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { LoggerContext } from "../../src/shared/logging/react.ts";
import { LogSink } from "../../src/plugins/diagnostics/capture/logSink.ts";

import {
  AppErrorBoundary,
  ScopedErrorBoundary,
} from "../../src/shared/ui/ErrorBoundary.tsx";

/** 点一次正常渲染，再点爆炸（驱动边界进入错误态）。 */
function Boom({ shouldThrow }: { readonly shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error("数据变形了");
  }
  return <p>正常内容</p>;
}

describe("ScopedErrorBoundary", () => {
  it("子树抛错落到面板 fallback：scope + 摘要 + 重试恢复", async () => {
    // 抛错条件由 React 状态驱动：重试前先「修好」——父组件重渲染产生
    // 新的 children 元素，边界清错误态后才会用新 props 重渲染子树
    //（children 元素在父不重渲染时是冻结的，stale prop 会再抛一次）
    function Harness() {
      const [broken, setBroken] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setBroken(false)}>
            修好它
          </button>
          <ScopedErrorBoundary scope="消息流">
            <Boom shouldThrow={broken} />
          </ScopedErrorBoundary>
        </div>
      );
    }
    render(<Harness />);
    expect(screen.getByText("消息流")).toBeInTheDocument();
    expect(screen.getByText(/数据变形了/)).toBeInTheDocument();
    expect(screen.queryByText("正常内容")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "修好它" }));
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByText("正常内容")).toBeInTheDocument();
  });

  it("resetKey 变化自动重置错误态", async () => {
    let key = "a";
    let throwing = true;
    function Harness() {
      const [k, setK] = useState(key);
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              throwing = false;
              key = k === "a" ? "b" : "a";
              setK(key);
            }}
          >
            switch
          </button>
          <ScopedErrorBoundary scope="流程时间线" resetKey={k}>
            <Boom shouldThrow={throwing} />
          </ScopedErrorBoundary>
        </div>
      );
    }
    render(<Harness />);
    expect(screen.getByText(/数据变形了/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "switch" }));
    expect(screen.getByText("正常内容")).toBeInTheDocument();
  });

  it("不抛错时零占位（children 直通）", () => {
    render(
      <ScopedErrorBoundary scope="AAW 面板">
        <p>面板内容</p>
      </ScopedErrorBoundary>,
    );
    expect(screen.getByText("面板内容")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("AppErrorBoundary", () => {
  it("整树抛错落到自救页（摘要 + 刷新 + 堆栈折叠）", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = new LogSink();
    render(
      <LoggerContext.Provider value={logs.createLogger}>
        <AppErrorBoundary>
          <Boom shouldThrow={true} />
        </AppErrorBoundary>
      </LoggerContext.Provider>,
    );
    expect(screen.getByText("界面出现异常")).toBeInTheDocument();
    expect(screen.getByText("数据变形了")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "刷新页面" }),
    ).toBeInTheDocument();
    expect(logs.snapshot()).toEqual([
      expect.objectContaining({
        channel: "ui",
        level: "error",
        message: "渲染异常被边界捕获",
        context: expect.objectContaining({ message: "数据变形了" }) as unknown,
      }),
    ]);
    spy.mockRestore();
  });
});
