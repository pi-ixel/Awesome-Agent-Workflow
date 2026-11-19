import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowLauncher } from "../../../src/plugins/workflow/ui/WorkflowLauncher.tsx";
import type { WorkflowMeta } from "../../../src/plugins/workflow/types.ts";
import { fakeWorkflowService, workflowSummary } from "./helpers.ts";

/** 启动表单：起点与输入都来自工作流源码，界面不写死入口代号。 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const dev = workflowSummary().meta!;
const enterprise: WorkflowMeta = {
  id: "aaw-enterprise", name: "AAW 完整开发", version: "1.0.0", description: "", revision: "r2",
  entries: [
    { id: "sr", label: "从 SR 需求开始", description: "从原始需求出发", inputs: [{ name: "requirement", label: "原始需求", kind: "text", required: true, placeholder: "" }] },
    { id: "ar", label: "从单个 AR 开始", description: "已有 SR 设计", inputs: [{ name: "requirement", label: "AR 内容", kind: "text", required: true, placeholder: "" }] },
  ],
};

/** 只有一个按钮：点了先检查环境，通过就直接启动。 */
async function checkAndStart(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  await Promise.resolve();
}

it("starts the chosen workflow with the declared inputs and hands the run back", async () => {
  const fake = fakeWorkflowService();
  const onStarted = vi.fn();
  render(<WorkflowLauncher service={fake.service} meta={dev} onStarted={onStarted} />);
  const start = screen.getByRole("button", { name: "开始运行" });
  expect(start).toBeDisabled();
  expect(screen.getByText("还需填写：本次需求")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("本次需求"), { target: { value: "一个小需求" } });
  await checkAndStart();
  await vi.waitFor(() => {
    const call = fake.calls.find((item) => item.method === "start");
    expect(call?.args).toEqual({ workflowId: "aaw-dev", entry: "dev", inputs: { requirement: "一个小需求" }, title: "", autoConfirm: false });
    expect(onStarted).toHaveBeenCalledWith("run-1");
  });
});

it("offers each entry with its description and sends the chosen one", async () => {
  const fake = fakeWorkflowService();
  render(<WorkflowLauncher service={fake.service} meta={enterprise} initialEntry="ar" />);
  expect(screen.getByRole("radio", { name: /从单个 AR 开始/ })).toBeChecked();
  expect(screen.getByText("已有 SR 设计")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("AR 内容"), { target: { value: "AR-12 登录改造" } });
  await checkAndStart();
  await vi.waitFor(() => {
    expect(fake.calls.find((item) => item.method === "start")?.args).toMatchObject({ workflowId: "aaw-enterprise", entry: "ar" });
  });
});

it("sends attachments and a title when given", async () => {
  const fake = fakeWorkflowService();
  render(<WorkflowLauncher service={fake.service} meta={dev} pickFiles={() => Promise.resolve(["docs/spec.md"])} />);
  fireEvent.change(screen.getByLabelText("本次需求"), { target: { value: "按规格实现" } });
  fireEvent.click(screen.getByText("附件与标题（可选）"));
  fireEvent.click(screen.getByRole("button", { name: "选择文件…" }));
  expect(await screen.findByText("docs/spec.md")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("附件路径"), { target: { value: "README.md" } });
  fireEvent.keyDown(screen.getByLabelText("附件路径"), { key: "Enter" });
  fireEvent.change(screen.getByLabelText("运行标题"), { target: { value: "规格实现" } });
  await checkAndStart();
  await vi.waitFor(() => {
    expect(fake.calls.find((item) => item.method === "start")?.args).toEqual({
      workflowId: "aaw-dev", entry: "dev", title: "规格实现", autoConfirm: false,
      inputs: { requirement: "按规格实现", attachments: ["docs/spec.md", "README.md"] },
    });
  });
});

it("keeps what was typed and explains engine errors when starting fails", async () => {
  const fake = fakeWorkflowService();
  fake.service.start = () => Promise.reject(new Error("WORKSPACE_NOT_BOUND"));
  render(<WorkflowLauncher service={fake.service} meta={dev} />);
  fireEvent.change(screen.getByLabelText("本次需求"), { target: { value: "需要保留的需求" } });
  await checkAndStart();
  expect(await screen.findByRole("alert")).toHaveTextContent("请先打开一个项目");
  expect(screen.getByLabelText("本次需求")).toHaveValue("需要保留的需求");
});

it("blocks failed checks and retains the form for rechecking", async () => {
  const fake = fakeWorkflowService();
  fake.service.preflight = () => Promise.resolve({ items: [{ id: "agent", label: "节点 Agent", status: "fail", message: "找不到 Agent", hint: "检查 Agent 设置" }] });
  render(<WorkflowLauncher service={fake.service} meta={dev} />);
  fireEvent.change(screen.getByLabelText("本次需求"), { target: { value: "保留内容" } });
  fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  expect(await screen.findByText(/找不到 Agent/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "开始运行" })).toBeNull();
  expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled();
  expect(fake.calls.some((item) => item.method === "start")).toBe(false);
  expect(screen.getByLabelText("本次需求")).toHaveValue("保留内容");
});

it("shows warnings first, then starts on a second click and keeps the check when the requirement changes", async () => {
  const fake = fakeWorkflowService();
  const start = vi.spyOn(fake.service, "start");
  fake.service.preflight = () => Promise.resolve({ revision: "rev", items: [{ id: "python_conditional", label: "Python", status: "warn", message: "后续可能需要", hint: "请检查" }] });
  render(<WorkflowLauncher service={fake.service} meta={dev} />);
  const requirement = screen.getByLabelText("本次需求");
  fireEvent.change(requirement, { target: { value: "需求一" } });
  fireEvent.click(screen.getByRole("button", { name: "开始运行" }));
  expect(await screen.findByText(/后续可能需要/)).toBeInTheDocument();
  expect(start).not.toHaveBeenCalled();
  fireEvent.change(requirement, { target: { value: "需求二" } });
  fireEvent.click(screen.getByRole("button", { name: "仍然开始" }));
  await vi.waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ inputs: { requirement: "需求二" } }), { revision: "rev", acceptedWarnings: ["python_conditional"] }));
});
