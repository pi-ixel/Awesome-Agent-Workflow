/**
 * 真机回归（2026-11-12）：节点一完成、节点二已启动，左侧/中央会话都正常，
 * 但右侧面板停在「需求确认 运行中 / 设计 未触发」。根因：侧栏点开会话触发
 * 导航变化 → 工作区解绑再重绑 → 旧实现清空快照流 → 面板持有的流此后不再
 * 随引擎事件刷新。本用例用真实 createWorkflowService + 真实 WorkflowPanel
 * 走一遍同样的序列。
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkflowEvent } from "../../../src/plugins/workflow/engine/protocol.ts";
import { NativeBridgeHub } from "../../../src/plugins/workflow/sessionHost/nativeBridge.ts";
import { WorkflowSessionMap } from "../../../src/plugins/workflow/sessionHost/sessionMap.ts";
import { createWorkflowService } from "../../../src/plugins/workflow/status/workflowService.ts";
import { WorkflowPanel } from "../../../src/plugins/workflow/ui/WorkflowPanel.tsx";
import { runSummary } from "./helpers.ts";

afterEach(() => cleanup());

const catalog = {
  id: "aaw-dev", name: "AAW dev", revision: "r1", entry: "requirement",
  nodes: [
    { id: "ask#1", label: "需求确认", kind: "agent", steps: [] },
    { id: "ask#2", label: "设计", kind: "agent", steps: [] },
  ],
  structure: { rootFlow: "main", flows: { main: { id: "main", label: "dev", entry: "requirement", phases: [
    { id: "requirement", run: ["ask#1"], routes: [{ next: "design", conditional: false }] },
    { id: "design", run: ["ask#2"], routes: [{ next: "$complete", conditional: false }] },
  ] } } },
};
const run = runSummary({ runId: "run-1", name: "AAW dev", status: "running", args: { workflowId: "aaw-dev", workflowRevision: "r1" } });
const node = (siteId: string, phaseId: string, status: string) => ({
  siteId, ordinal: 1, kind: "ask", status, scope: {}, callPath: [], phaseId,
  actorSiteId: siteId, actorOrdinal: 1, result: null, candidates: [],
});
const snapshot = (phase: string, nodes: unknown[]) => ({
  run, catalog, execution: { phase, stack: [], calls: [] }, active: true, hasLease: true, retries: [], nodes, actors: [],
});

it("面板在导航重绑后仍随引擎事件刷新到节点二", async () => {
  let current: unknown = snapshot("requirement", [node("ask#1", "requirement", "running")]);
  const pump: Array<(event: WorkflowEvent) => void> = [];
  const client = {
    request: (method: string) =>
      Promise.resolve(method === "list" ? [run] : method === "snapshot" ? current : null),
    subscribe: (listener: (event: WorkflowEvent) => void) => {
      pump.push(listener);
      return () => {};
    },
    hasActiveRuns: () => true,
    hasActiveRunsFromHost: () => Promise.resolve(true),
  };
  const { service, dispose } = createWorkflowService({
    client: client as never,
    bridge: new NativeBridgeHub(),
    sessions: new WorkflowSessionMap(),
    logger: { debug: vi.fn(), warn: vi.fn() },
    agentLaunch: () => ({ command: ["agent", "acp"], mcpServers: [] }),
  });
  let unbind = service.bindWorkspace("D:/project");
  render(<WorkflowPanel service={service} />);
  const phase = (name: string) => screen.getAllByLabelText(name, { exact: true })[0]!.textContent ?? "";
  await vi.waitFor(() => expect(phase("需求确认")).toContain("运行中"));
  expect(phase("设计")).toContain("未触发");

  // 侧栏点开第二个会话：导航变化 → 解绑再重绑同一工作区。
  unbind();
  unbind = service.bindWorkspace("D:/project");

  current = snapshot("design", [node("ask#1", "requirement", "completed"), node("ask#2", "design", "running")]);
  act(() => {
    for (const listener of pump) {
      listener({ type: "engine-event", runId: "run-1", event: { type: "action-changed", siteId: "ask#1", ordinal: 1, status: "completed" } });
    }
  });
  await vi.waitFor(() => expect(phase("设计")).toContain("运行中"));
  expect(phase("需求确认")).toContain("已完成");
  unbind();
  dispose();
});
