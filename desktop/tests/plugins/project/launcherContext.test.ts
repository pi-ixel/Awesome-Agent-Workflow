import { it, expect, vi } from "vitest";
import { prepareProjectLauncher } from "../../../src/plugins/project/service.ts";
import type { ProjectService } from "../../../src/plugins/project/service.ts";
import type { WorkbenchService } from "../../../src/plugins/workbench/service.ts";
import type { HostService } from "../../../src/plugins/host/service.ts";

function fixture() {
  let path: string | null = null;
  let visible = false;
  const startNewSession = vi.fn((next: string) => { path = next; visible = true; return Promise.resolve({ ok: false, reason: "agent offline" }); });
  const pickDirectory = vi.fn().mockResolvedValue(null);
  const project = {
    isActive: () => true,
    projects: { workspace: { getState: () => ({ selectedPath: null, activePath: null, recentWorkspaces: [{ path: "E:/demo" }] }) },
      selectWorkspace: vi.fn(), registerProject: vi.fn(), pickDirectory },
    sessions: { startNewSession, isConversationVisible: () => visible, showConversation: vi.fn() },
    conversation: { foreground: { session: { getState: () => ({ activeSessionId: null }) } } },
  } as unknown as ProjectService;
  const workbench = {
    navigation: { getState: () => ({ contextPath: path, openView: (_id: string, next: string) => { path = next; } }) },
    navigationGuard: { pending: () => false }, showToast: vi.fn(),
  } as unknown as WorkbenchService;
  const pathExists = vi.fn().mockResolvedValue(true);
  const host = { window: { showAndFocus: vi.fn() }, commands: { pathExists } } as unknown as HostService;
  return { project, workbench, host, startNewSession, pathExists, pickDirectory };
}

it("creates a draft for the latest project, opens despite offline agent, and reuses the draft", async () => {
  const f = fixture();
  expect(await prepareProjectLauncher(f.project, f.workbench, f.host, true)).toBe("E:/demo");
  expect(f.startNewSession).toHaveBeenCalledOnce();
  expect(await prepareProjectLauncher(f.project, f.workbench, f.host, true)).toBe("E:/demo");
  expect(f.startNewSession).toHaveBeenCalledOnce();
});

it("opens a project for management without creating a session and respects project picker cancellation", async () => {
  const f = fixture();
  await prepareProjectLauncher(f.project, f.workbench, f.host, false);
  expect(f.startNewSession).not.toHaveBeenCalled();
  f.pathExists.mockResolvedValue(false);
  expect(await prepareProjectLauncher(f.project, f.workbench, f.host, true)).toBeNull();
  expect(f.pickDirectory).toHaveBeenCalledOnce();
  expect(f.startNewSession).not.toHaveBeenCalled();
});
