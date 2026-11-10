import type { Context } from "cordis";
import { expect, it, vi } from "vitest";
import type { CliRunResult } from "../../../src/plugins/host/types.ts";
import * as workflowPlugin from "../../../src/plugins/workflow/index.ts";
import { timelineCollapsedStorageKey } from "../../../src/plugins/workflow/config.ts";
import * as skillsPlugin from "../../../src/plugins/skills/index.ts";
import { installDesktopWorkbench } from "../../../src/bootstrap/installDesktopWorkbench.ts";
import { createTestDesktopRuntime } from "../../helpers/desktopRuntime.ts";
import { session } from "../../helpers/sessionRuntime.ts";

const cliResult = (stdout: string): CliRunResult => ({
  ok: true, code: 0, stdout, stderr: "", durationMs: 1,
});

it("revokes and restores its Workbench registration and health check on the same Project instance", async () => {
  let root: Context | undefined;
  const savedPreference = localStorage.getItem(timelineCollapsedStorageKey);
  localStorage.setItem(timelineCollapsedStorageKey, "0");
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
      return installDesktopWorkbench(context);
    },
  );
  const result: CliRunResult = {
    ok: true,
    code: 0,
    stdout: "uv 1.0",
    stderr: "",
    durationMs: 1,
  };
  let finish!: (result: CliRunResult) => void;
  const pending = new Promise<CliRunResult>((resolve) => {
    finish = resolve;
  });
  const run = vi.fn(() => pending);
  try {
    const { project, workbench, workflow } = await runtime.ready;
    const [fiber] = root?.registry.get(workflowPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Workflow fiber is missing");
    const { projects } = project;
    const { workspace } = projects;
    expect(root.workflowUi.status).toBe(workflow.status);
    const oldTimeline = root.workflowUi.timeline;
    expect(oldTimeline.isExpanded()).toBe(true);
    const state = workspace.getState();
    expect(state.healthCheckAvailable).toBe(true);
    const oldPanel = workbench
      .getSnapshot()
      .panels.find(({ id }) => id === "aaw");
    expect(oldPanel?.launcher?.label).toBe("AAW 工作流");
    root.skills.setSourceDirectory("");
    projects.patchToolPaths({ aawScriptPath: "" });
    workbench.navigation.getState().openView("project-overview", "D:/workflow-health");
    expect(workflow.status.getState().workspacePath).toBe("D:/workflow-health");
    let finishList!: (value: CliRunResult) => void;
    const listing = new Promise<CliRunResult>((resolve) => {
      finishList = resolve;
    });
    const query = vi.fn(() => listing);
    vi.spyOn(root.host.process, "run").mockImplementation(({ command }) =>
      command.includes("status") ? query() : run(),
    );
    vi.spyOn(root.host.process, "exists").mockResolvedValue(true);
    projects.selectWorkspace("D:/workflow-health");
    const check = projects.runHealthChecks({ aawScriptPath: "D:/tool.py" });
    expect(workspace.getState().isCheckingHealth).toBe(true);
    workflow.bindWorkspace({ workspacePath: "D:/workflow-health", uvCommand: "uv", aawScriptPath: "D:/tool.py" });
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    expect(workflow.status).not.toHaveProperty("setState");
    expect(workflow.status.getState()).not.toHaveProperty("loader");
    const observer = vi.fn();
    workflow.status.subscribe(observer);

    await fiber.dispose();
    expect(root.project).toBe(project);
    expect(root.get("workflowUi")).toBeUndefined();
    expect(oldTimeline.isExpanded()).toBe(false);
    expect(workbench.getSnapshot().panels).not.toContain(oldPanel);
    expect(workspace.getState()).toMatchObject({
      healthCheckAvailable: false,
      isCheckingHealth: false,
    });
    finish(result);
    await check;
    finishList(cliResult('{"srs":["SR-001"]}'));
    await listing;
    await workflow.refresh();
    expect(query).toHaveBeenCalledOnce();
    expect(observer).not.toHaveBeenCalled();
    workflow.bindWorkspace({ workspacePath: "D:/stale-workflow", uvCommand: "uv", aawScriptPath: "D:/tool.py" });
    expect(workflow.status.getState()).toMatchObject({
      hasSource: false,
      workspacePath: null,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(workspace.getState().health).toBeNull();

    await root.plugin(workflowPlugin);
    expect(root.workflowUi.status).toBe(root.workflow.status);
    expect(root.workflowUi.timeline).not.toBe(oldTimeline);
    expect(root.workflowUi.timeline.isExpanded()).toBe(true);
    expect(root.workflow).not.toBe(workflow);
    const reinstalledPanel = workbench
      .getSnapshot()
      .panels.find(({ id }) => id === "aaw");
    expect(reinstalledPanel?.launcher?.label).toBe("AAW 工作流");
    expect(reinstalledPanel).not.toBe(oldPanel);
    expect(root.workflow.status.getState().workspacePath).toBe("D:/workflow-health");
    expect(workspace.getState().healthCheckAvailable).toBe(true);
    await projects.runHealthChecks({ aawScriptPath: "D:/tool.py" });
    expect(workspace.getState().health?.path).toBe("D:/workflow-health");
    expect(run).toHaveBeenCalledTimes(3);
  } finally {
    finish(result);
    await runtime.shutdown();
    if (savedPreference === null) localStorage.removeItem(timelineCollapsedStorageKey);
    else localStorage.setItem(timelineCollapsedStorageKey, savedPreference);
  }
});

it("registers workflow contributions, routes explicit targets and scopes activity refresh", async () => {
  const owner = {
    workspacePath: "D:/workflow",
    agentKey: "agent",
    sessionId: "session",
  };
  const resource = session(owner.workspacePath, owner.agentKey);
  const sendPrompt = vi.fn(() => true);
  const enqueuePrompt = vi.fn(() => true);
  resource.store.setState({ sendPrompt, enqueuePrompt });
  const findSession = vi.fn(() => resource);
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    {
      attachPreloading: () => () => {},
      close: () => Promise.resolve(),
      findSession,
    },
    undefined,
    (context) => {
      root = context;
      return installDesktopWorkbench(context);
    },
  );
  try {
    const { project, workbench } = await runtime.ready;
    const [fiber] = root?.registry.get(workflowPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Workflow fiber is missing");
    await fiber.dispose();
    const release = vi.fn();
    const subscribe = vi
      .spyOn(project.sessions, "subscribeSessionActivity")
      .mockReturnValue(release);
    await root.plugin(workflowPlugin);
    const workflow = root.workflow;
    const publishSessionActivity = subscribe.mock.calls[0]?.[0];
    if (!publishSessionActivity) throw new Error("Workflow did not subscribe");
    expect(workbench.getSnapshot().panels.map(({ id }) => id)).toContain("aaw");
    expect(root.workflowUi.Overview).toBeTypeOf("function");
    expect(root.workflowUi.timeline.View).toBeTypeOf("function");
    expect(workflow.submit(owner, "first")).toBe(true);
    expect(workflow.submit(owner, "queued", true)).toBe(true);
    expect(findSession.mock.calls).toEqual([[owner], [owner]]);
    expect(sendPrompt).toHaveBeenCalledExactlyOnceWith("first", undefined);
    expect(enqueuePrompt).toHaveBeenCalledExactlyOnceWith("queued", undefined);

    const query = vi.spyOn(root.host.process, "run").mockImplementation(({ command }) =>
      Promise.resolve(cliResult(command.includes("--sr") ? "{}" : '{"ok":true,"srs":["SR-1"]}')),
    );
    vi.spyOn(root.host.process, "exists").mockResolvedValue(true);
    workflow.bindWorkspace({ workspacePath: owner.workspacePath, uvCommand: "uv", aawScriptPath: "D:/tool.py" });
    await vi.waitFor(() => expect(workflow.status.getState()).toMatchObject({ currentSr: "SR-1", isLoading: false }));
    query.mockClear().mockReturnValue(new Promise(() => {}));
    const event = {
      type: "agent_message_chunk" as const,
      sessionId: "session",
      text: "run",
    };
    publishSessionActivity("D:/other", event);
    expect(query).not.toHaveBeenCalled();
    publishSessionActivity("d:\\WORKFLOW", event);
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    await runtime.shutdown();
    expect(release).toHaveBeenCalledOnce();
    publishSessionActivity(owner.workspacePath, event);
    expect(query).toHaveBeenCalledOnce();
    expect(workflow.status.getState().hasSource).toBe(false);
    expect(() => workflow.submit(owner, "late")).toThrow("disposed");
  } finally {
    await runtime.shutdown();
  }
});

it("rebinds the optional Skills source without replacing the Workflow panel", async () => {
  let root: Context | undefined;
  const runtime = createTestDesktopRuntime(
    { attachPreloading: () => () => {}, close: () => Promise.resolve() },
    undefined,
    (context) => {
      root = context;
      return installDesktopWorkbench(context);
    },
  );
  try {
    const { project, workbench, skills, workflow } = await runtime.ready;
    const [fiber] = root?.registry.get(skillsPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Skills fiber is missing");
    const run = vi.spyOn(root.host.process, "run").mockResolvedValue(cliResult('{"ok":true,"srs":[]}'));
    vi.spyOn(root.host.process, "exists").mockResolvedValue(true);
    project.projects.patchToolPaths({ aawScriptPath: "" });
    skills.setSourceDirectory("D:/workflow-fixture/skills");
    const panel = workbench.getSnapshot().panels.find(({ id }) => id === "aaw");
    workbench.navigation.getState().openView("project-overview", "D:/workflow-fixture");
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({
      command: [expect.any(String), "run", "D:/workflow-fixture/skills/aaw-workflow/scripts/aaw.py", "status", "--json"],
    }));

    await fiber.dispose();
    await vi.waitFor(() => expect(workflow.status.getState().lastError).toContain("尚未配置 aaw 脚本路径"));
    expect(run).toHaveBeenCalledOnce();
    expect(root.workflow).toBe(workflow);
    expect(workbench.getSnapshot().panels.find(({ id }) => id === "aaw")).toBe(panel);

    await root.plugin(skillsPlugin);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(workbench.getSnapshot().panels.find(({ id }) => id === "aaw")).toBe(panel);
    expect(workflow.status.getState().lastError).toBeNull();
  } finally {
    await runtime.shutdown();
  }
});
