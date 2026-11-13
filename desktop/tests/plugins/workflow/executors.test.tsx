import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRunExecutors, readWorkflowExecutors, rolesOf, writeRunExecutors, writeWorkflowExecutors } from "../../../src/plugins/workflow/status/executors.ts";
import { ExecutorSettings } from "../../../src/plugins/workflow/ui/ExecutorSettings.tsx";
import type { WorkflowCatalog, WorkflowExecutors } from "../../../src/plugins/workflow/types.ts";

afterEach(cleanup);

function memory() {
  const values = new Map<string, string>();
  return { values, getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
}

const catalog: WorkflowCatalog = {
  id: "w", name: "W", revision: "r", entry: "a",
  nodes: [
    { id: "design", label: "设计", kind: "agent", steps: [], role: "设计者" },
    { id: "repair", label: "设计修正", kind: "agent", steps: [], role: "设计者" },
    { id: "review", label: "评审", kind: "agent", steps: [], role: "评审者" },
    { id: "check", label: "检查", kind: "python", steps: [] },
  ],
};

describe("执行者设置", () => {
  it("按角色列出节点，设置只存本机，清空即删除", () => {
    expect(rolesOf({ a: catalog, b: catalog })).toEqual([
      { role: "设计者", nodes: ["设计", "设计修正"] },
      { role: "评审者", nodes: ["评审"] },
    ]);
    const storage = memory();
    writeWorkflowExecutors(storage, "w", { 设计者: { agentId: "b", model: " fast " }, 评审者: {} });
    expect(readWorkflowExecutors(storage, "w")).toEqual({ 设计者: { agentId: "b", model: "fast" } });
    writeRunExecutors(storage, "run-1", readWorkflowExecutors(storage, "w"));
    writeWorkflowExecutors(storage, "w", {});
    expect(readWorkflowExecutors(storage, "w")).toEqual({});
    expect(readRunExecutors(storage, "run-1")).toEqual({ 设计者: { agentId: "b", model: "fast" } });
    storage.setItem("aaw-workflow/executors/bad", "not json");
    expect(readWorkflowExecutors(storage, "bad")).toEqual({});
  });

  it("在执行者页按角色选 Agent 和模型", () => {
    const saved: unknown[] = [];
    const executors: WorkflowExecutors = {
      agents: () => [{ id: "a", name: "Agent A" }, { id: "b", name: "Agent B" }],
      defaultName: () => "Agent A",
      read: () => ({ 评审者: { agentId: "gone" } }),
      write: vi.fn((_id: string, plan: unknown) => { saved.push(plan); }),
    };
    render(<ExecutorSettings workflowId="w" catalogs={{ a: catalog }} executors={executors} />);
    expect(screen.getByText("设计、设计修正")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "gone（不可用）" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "设计者使用的 Agent" }), { target: { value: "b" } });
    fireEvent.change(screen.getByRole("textbox", { name: "设计者使用的模型" }), { target: { value: "fast" } });
    expect(saved.at(-1)).toEqual({ 评审者: { agentId: "gone" }, 设计者: { agentId: "b", model: "fast" } });
    fireEvent.change(screen.getByRole("combobox", { name: "评审者使用的 Agent" }), { target: { value: "" } });
    expect(saved.at(-1)).toEqual({ 设计者: { agentId: "b", model: "fast" } });
  });
});
