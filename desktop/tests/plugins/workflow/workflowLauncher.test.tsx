import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowLauncher } from "../../../src/plugins/workflow/ui/WorkflowLauncher.tsx";
import { fakeWorkflowService } from "./helpers.ts";

/**
 * 移植自 commit 24877d9 的 tests/ui/workflowLauncher.test.tsx：启动器本期
 * 承载在面板内（ADR 024 §5 ④ WorkflowLauncher），以 WorkflowService 测试
 * 替身驱动。旧用例的会话聚焦联动（linkedRuntime/workflowFocus）随旧会话
 * 投影删除——启动成功后由面板选中新运行（onStarted）。
 */
afterEach(() => {
  vi.restoreAllMocks();
});

it("starts a workflow from the requirement input and hands the run to the panel", async () => {
  const fake = fakeWorkflowService();
  const onStarted = vi.fn();
  render(<WorkflowLauncher service={fake.service} onStarted={onStarted} />);
  fireEvent.change(screen.getByLabelText("本次需求"), { target: { value: "一个小需求" } });
  fireEvent.click(screen.getByRole("button", { name: "启动工作流" }));
  await vi.waitFor(() => {
    const call = fake.calls.find((item) => item.method === "startDev");
    expect(call?.args).toEqual({ requirement: "一个小需求", entry: "dev" });
    expect(onStarted).toHaveBeenCalledWith("run-1");
  });
  // 启动成功清空需求（不残留上次输入）
  expect(screen.getByLabelText("本次需求")).toHaveValue("");
});

it("keeps the requirement available when startup fails", async () => {
  const fake = fakeWorkflowService();
  fake.service.startDev = () => Promise.reject(new Error("服务启动失败"));
  render(<WorkflowLauncher service={fake.service} />);
  fireEvent.change(screen.getByLabelText("本次需求"), { target: { value: "需要保留的需求" } });
  fireEvent.click(screen.getByRole("button", { name: "启动工作流" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("服务启动失败");
  expect(screen.getByLabelText("本次需求")).toHaveValue("需要保留的需求");
});

it("launches the shared AR entry with the typed requirement", async () => {
  const fake = fakeWorkflowService();
  render(<WorkflowLauncher service={fake.service} />);
  fireEvent.change(screen.getByLabelText("工作流入口"), { target: { value: "ar" } });
  fireEvent.change(screen.getByLabelText("本次需求"), { target: { value: "AR 范围" } });
  fireEvent.click(screen.getByRole("button", { name: "启动工作流" }));
  await vi.waitFor(() => {
    const call = fake.calls.find((item) => item.method === "startDev");
    expect(call?.args).toEqual({ requirement: "AR 范围", entry: "ar" });
  });
});
