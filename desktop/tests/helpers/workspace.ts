import { useStore, type StoreApi } from "zustand";
import { vi } from "vitest";
import type { ProjectService } from "../../src/plugins/project/service.ts";
import type { WorkspaceSnapshot, WorkspaceView } from "../../src/plugins/project/types.ts";
import type { WorkspaceStoreState } from "../../src/plugins/project/workspace/types.ts";
import { createHostProcessRunner } from "../../src/plugins/host/process/processRunner.ts";
import { webviewStorage } from "../../src/plugins/host/storage/storage.ts";
import { createWorkspaceStore, workspaceCommands } from "../../src/plugins/project/workspace/workspaceStore.ts";
import type { WorkspaceHealthCheck } from "../../src/plugins/project/types.ts";
import { readTestLayout } from "./layout.ts";

const workspaceOwners = vi.hoisted(
  () => new WeakMap<WorkspaceView, StoreApi<WorkspaceStoreState>>(),
);
vi.mock(import("../../src/plugins/project/workspace/workspaceStore.ts"), async (original) => {
  const module = await original();
  return {
    ...module,
    createWorkspaceStore(...args: Parameters<typeof module.createWorkspaceStore>) {
      const owner = module.createWorkspaceStore(...args);
      workspaceOwners.set(owner.view, owner.store);
      return owner;
    },
  };
});

export function createTestWorkspace() {
  const workspace = createWorkspaceStore(
    webviewStorage,
    createHostProcessRunner(),
    (resume, path) => readTestLayout().navigationGuard.guard(resume, path),
  );
  workspace.registerHealthCheck(probeHealthCheck);
  return workspace.store;
}

/**
 * 测试用的健康检查：经注入的 runner 执行一次 `<probeCommand> --version`，
 * 按结果给三项。只用于验证项目侧的检查生命周期（排队、作废、回填）。
 */
export const probeHealthCheck: WorkspaceHealthCheck = async ({ runner, toolPaths, workspacePath }) => {
  const result = await runner.run({ command: [toolPaths.probeCommand ?? "probe", "--version"], cwd: workspacePath, timeoutMs: 1000 });
  const status = result.ok ? "pass" as const : "fail" as const;
  return ["probe-run", "probe-output", "probe-exit"].map((id) => ({
    id,
    label: id,
    status,
    summary: result.stdout.trim(),
    fixHint: result.ok ? "" : "probe 失败",
    durationMs: result.durationMs,
  }));
};

export function mutableWorkspace(project: Pick<ProjectService, "projects">) {
  const store = workspaceOwners.get(project.projects.workspace);
  if (!store) throw new Error("Missing Project workspace test owner");
  return store;
}

/** Explicit workspace port for UI unit tests that mount a component in isolation. */
export function workspaceViewFixture(
  read: () => StoreApi<WorkspaceStoreState>,
) {
  return {
    useWorkspaceService: read,
    useWorkspaceCommands: () => workspaceCommands(read()),
    useWorkspaceValue<T>(select: (state: WorkspaceSnapshot) => T): T {
      return useStore(read(), select);
    },
  };
}
