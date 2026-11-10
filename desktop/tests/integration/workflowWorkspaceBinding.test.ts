/** 设置变更经真实 loader/CLI/store 通路更新查询；宿主进程用替身。 */
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runner = vi.hoisted(() => ({ run: vi.fn(), exists: vi.fn() }));
vi.mock("../../src/plugins/host/process/processRunner.ts", () => ({
  createHostProcessRunner: () => runner,
}));
import { bindWorkflowWorkspace } from "../../src/plugins/workflow/status/workspaceBinding.ts";
import { createWorkflow } from "../../src/plugins/workflow/status/workflow.ts";
import {
  createTestSkills,
  skillsWorkbenchFixture,
} from "../helpers/skills.tsx";
import { createTestWorkspace } from "../helpers/workspace.ts";
const workspace = createTestWorkspace();
let skills: ReturnType<typeof createTestSkills>;
let workflow: ReturnType<typeof createWorkflow>;
let fixture: ReturnType<typeof skillsWorkbenchFixture>;
let unbind: (() => void) | undefined;
let detachSkillSource: (() => void) | undefined;

function bind() {
  const { navigation, navigationGuard } = fixture.workbench;
  const binding = bindWorkflowWorkspace(workflow, workspace, {
    getPath: () => navigation.getState().contextPath,
    subscribe: navigation.subscribe,
    isActive: () => navigationGuard.isActive(),
  });
  detachSkillSource = binding.attachSkillSource(skills.source);
  unbind = () => binding.dispose();
}

function openProject(path: string) {
  fixture.workbench.navigation.getState().openView("project-overview", path);
}

beforeEach(() => {
  runner.run.mockReset().mockImplementation(() =>
    Promise.resolve({
      ok: true,
      code: 0,
      stdout: '{"ok":true,"srs":[]}',
      stderr: "",
      durationMs: 1,
    }),
  );
  runner.exists.mockReset().mockResolvedValue(true);
  skills = createTestSkills();
  fixture = skillsWorkbenchFixture(skills);
  workflow = createWorkflow(runner, () => false);
  workspace.getState().setToolPaths({
    chrysCommand: "icode",
    uvCommand: "uv",
    aawScriptPath: "D:/tools/aaw.py",
  });
  skills.setSourceDirectory("D:/source/skills");
  openProject("D:/projects/one");
});
afterEach(async () => {
  unbind?.();
  unbind = undefined;
  detachSkillSource = undefined;
  workflow.dispose();
  fixture.dispose();
  await skills.dispose();
});

describe("工作流数据源配置", () => {
  it("复用已选工具，修改工具或项目立即查询，无需重启", async () => {
    bind();
    await waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
    expect(runner.run).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cwd: "D:/projects/one",
        command: ["uv", "run", "D:/tools/aaw.py", "status", "--json"],
      }),
    );
    workspace.getState().setToolPaths({
      chrysCommand: "icode",
      uvCommand: "D:/bin/uv.exe",
      aawScriptPath: "D:/other/aaw.py",
    });
    await waitFor(() => expect(runner.run).toHaveBeenCalledTimes(2));
    expect(runner.run).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cwd: "D:/projects/one",
        command: [
          "D:/bin/uv.exe",
          "run",
          "D:/other/aaw.py",
          "status",
          "--json",
        ],
      }),
    );
    openProject("D:/projects/two");
    await waitFor(() => expect(runner.run).toHaveBeenCalledTimes(3));
    expect(runner.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: "D:/projects/two" }),
    );
  });

  it("显式脚本优先；未选脚本时只从用户配置的 skills 目录推导", async () => {
    bind();
    await waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
    skills.setSourceDirectory("D:/new/skills");
    expect(runner.run).toHaveBeenCalledTimes(1);
    workspace.getState().setToolPaths({
      chrysCommand: "icode",
      uvCommand: "uv",
      aawScriptPath: "",
    });
    await waitFor(() => expect(runner.run).toHaveBeenCalledTimes(2));
    expect(runner.run).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: [
          "uv",
          "run",
          "D:/new/skills/aaw-workflow/scripts/aaw.py",
          "status",
          "--json",
        ],
      }),
    );
    skills.setSourceDirectory("D:/third/skills");
    await waitFor(() => expect(runner.run).toHaveBeenCalledTimes(3));
    expect(runner.exists).toHaveBeenLastCalledWith(
      "D:/third/skills/aaw-workflow/scripts/aaw.py",
    );
    detachSkillSource?.();
    await waitFor(() =>
      expect(workflow.status.getState().lastError).toContain(
        "尚未配置 aaw 脚本路径",
      ),
    );
    expect(runner.run).toHaveBeenCalledTimes(3);
  });

  it("未配置与工具不存在分别提示，修好配置后立即恢复", async () => {
    workspace.getState().setToolPaths({
      chrysCommand: "icode",
      uvCommand: "uv",
      aawScriptPath: "",
    });
    skills.setSourceDirectory("");
    expect(skills.source.getSnapshot()).toBe("");
    bind();
    await waitFor(() =>
      expect(workflow.status.getState().lastError).toContain(
        "尚未配置 aaw 脚本路径",
      ),
    );
    expect(runner.run).not.toHaveBeenCalled();
    runner.exists.mockResolvedValue(false);
    workspace.getState().setToolPaths({
      chrysCommand: "icode",
      uvCommand: "uv",
      aawScriptPath: "D:/missing/aaw.py",
    });
    await waitFor(() =>
      expect(workflow.status.getState().lastError).toContain(
        "D:/missing/aaw.py",
      ),
    );
    expect(runner.run).not.toHaveBeenCalled();
    runner.exists.mockResolvedValue(true);
    workspace.getState().setToolPaths({
      chrysCommand: "icode",
      uvCommand: "uv",
      aawScriptPath: "D:/valid/aaw.py",
    });
    await waitFor(() =>
      expect(workflow.status.getState().lastRefreshedAt).not.toBeNull(),
    );
    expect(workflow.status.getState().lastError).toBeNull();
  });

  it("释放查询和订阅，重新绑定时读取最新项目和工具配置", async () => {
    const result = {
      ok: true,
      code: 0,
      stdout: '{"ok":true,"srs":[]}',
      stderr: "",
      durationMs: 1,
    };
    let finish!: (value: typeof result) => void;
    runner.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    bind();
    await waitFor(() => expect(runner.run).toHaveBeenCalledOnce());

    unbind?.();
    unbind = undefined;
    finish(result);
    openProject("D:/projects/two");
    skills.setSourceDirectory("D:/new/skills");
    workspace.getState().setToolPaths({
      ...workspace.getState().toolPaths,
      aawScriptPath: "",
    });
    await Promise.resolve();
    expect(runner.run).toHaveBeenCalledOnce();
    expect(workflow.status.getState()).toMatchObject({
      hasSource: false,
      workspacePath: null,
      lastRefreshedAt: null,
    });

    bind();
    await waitFor(() => expect(runner.run).toHaveBeenCalledTimes(2));
    expect(runner.run).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cwd: "D:/projects/two",
        command: [
          "uv",
          "run",
          "D:/new/skills/aaw-workflow/scripts/aaw.py",
          "status",
          "--json",
        ],
      }),
    );
  });
});
