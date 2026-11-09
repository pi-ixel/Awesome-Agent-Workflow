import type { Context } from "cordis";
import { expect, it, vi } from "vitest";
import type { createWorkflow } from "../../src/plugins/workflow/service.ts";
import type { WorkflowService } from "../../src/contracts/workflow.ts";
import type { CliRunResult } from "../../src/contracts/processRunner.ts";
import * as workflowPlugin from "../../src/plugins/workflow/plugin.ts";
import { installDesktopWorkbench } from "../../src/bootstrap/installDesktopWorkbench.ts";
import { createTestDesktopRuntime } from "../helpers/desktopRuntime.ts";
import { session } from "../helpers/sessionRuntime.ts";

function mutableStatus(workflow: WorkflowService) {
  return workflow.status as ReturnType<typeof createWorkflow>["status"];
}

it("revokes and restores its Workbench registration and health check on the same Project instance", async () => {
  let root: Context | undefined;
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
  const runner = { run, exists: () => Promise.resolve(true) };
  try {
    const { project, workbench, workflow } = await runtime.ready;
    const [fiber] = root?.registry.get(workflowPlugin)?.fibers ?? [];
    if (!root || !fiber) throw new Error("Workflow fiber is missing");
    const { workspace } = project;
    expect(workbench.getSnapshot().workflow[0]?.service).toBe(workflow);
    const state = workspace.getState();
    expect(state.healthCheckAvailable).toBe(true);
    const oldPanel = workbench
      .getSnapshot()
      .panels.find(({ id }) => id === "aaw");
    expect(oldPanel?.launcher?.label).toBe("AAW 工作流");
    root.skills.source.set("");
    state.setToolPaths({ ...state.toolPaths, aawScriptPath: "" });
    workbench.navigation.getState().openProjectOverview("D:/workflow-health");
    expect(workflow.status.getState().workspacePath).toBe("D:/workflow-health");
    state.selectWorkspace("D:/workflow-health");
    const check = state.runHealthChecks(runner, {
      aawScriptPath: "D:/tool.py",
    });
    expect(workspace.getState().isCheckingHealth).toBe(true);
    let finishList!: (value: unknown) => void;
    const listing = new Promise<unknown>((resolve) => {
      finishList = resolve;
    });
    const loader = {
      listSrs: () => listing,
      readStatus: vi.fn(),
      readNext: vi.fn(),
      readPlan: vi.fn(),
    };
    const previous = mutableStatus(workflow).getState();
    previous.bindLoader(loader, "D:/workflow-health");
    const refresh = previous.refresh();

    await fiber.dispose();
    expect(root.project).toBe(project);
    expect(workbench.getSnapshot().workflow).toEqual([]);
    expect(workbench.getSnapshot().panels).not.toContain(oldPanel);
    expect(workspace.getState()).toMatchObject({
      healthCheckAvailable: false,
      isCheckingHealth: false,
    });
    finish(result);
    await check;
    finishList({ srs: ["SR-001"] });
    await refresh;
    expect(loader.readStatus).not.toHaveBeenCalled();
    previous.bindLoader(loader, "D:/stale-workflow");
    expect(workflow.status.getState()).toMatchObject({
      hasSource: false,
      workspacePath: null,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(workspace.getState().health).toBeNull();

    await root.plugin(workflowPlugin);
    expect(workbench.getSnapshot().workflow[0]?.service).toBe(root.workflow);
    expect(root.workflow).not.toBe(workflow);
    const reinstalledPanel = workbench
      .getSnapshot()
      .panels.find(({ id }) => id === "aaw");
    expect(reinstalledPanel?.launcher?.label).toBe("AAW 工作流");
    expect(reinstalledPanel).not.toBe(oldPanel);
    expect(root.workflow.status.getState().workspacePath).toBe("D:/workflow-health");
    expect(workspace.getState().healthCheckAvailable).toBe(true);
    await state.runHealthChecks(runner, { aawScriptPath: "D:/tool.py" });
    expect(workspace.getState().health?.path).toBe("D:/workflow-health");
    expect(run).toHaveBeenCalledTimes(3);
  } finally {
    finish(result);
    await runtime.shutdown();
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
      .spyOn(project, "subscribeSessionActivity")
      .mockReturnValue(release);
    await root.plugin(workflowPlugin);
    const workflow = root.workflow;
    const publishSessionActivity = subscribe.mock.calls[0]?.[0];
    if (!publishSessionActivity) throw new Error("Workflow did not subscribe");
    expect(workbench.getSnapshot().panels.map(({ id }) => id)).toContain("aaw");
    expect(workbench.getSnapshot().chrome.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "workflow-overview",
        "workflow-timeline",
      ]),
    );
    expect(workflow.submit(owner, "first")).toBe(true);
    expect(workflow.submit(owner, "queued", true)).toBe(true);
    expect(findSession.mock.calls).toEqual([[owner], [owner]]);
    expect(sendPrompt).toHaveBeenCalledExactlyOnceWith("first", undefined);
    expect(enqueuePrompt).toHaveBeenCalledExactlyOnceWith("queued", undefined);

    const listSrs = vi.fn(() => new Promise<unknown>(() => {}));
    mutableStatus(workflow).getState().bindLoader(
      {
        listSrs,
        readStatus: vi.fn(),
        readNext: vi.fn(),
        readPlan: vi.fn(),
      },
      owner.workspacePath,
    );
    mutableStatus(workflow).setState({ currentSr: "SR-1" });
    const event = {
      type: "agent_message_chunk" as const,
      sessionId: "session",
      text: "run",
    };
    publishSessionActivity("D:/other", event);
    expect(listSrs).not.toHaveBeenCalled();
    publishSessionActivity("d:\\WORKFLOW", event);
    expect(listSrs).toHaveBeenCalledOnce();
    await runtime.shutdown();
    expect(release).toHaveBeenCalledOnce();
    publishSessionActivity(owner.workspacePath, event);
    expect(listSrs).toHaveBeenCalledOnce();
    expect(workflow.status.getState().hasSource).toBe(false);
    expect(() => workflow.submit(owner, "late")).toThrow("disposed");
  } finally {
    await runtime.shutdown();
  }
});
