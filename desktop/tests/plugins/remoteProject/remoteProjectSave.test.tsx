import type { Context } from "cordis";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createWorkspaceStore } from "../../../src/plugins/project/workspace/workspaceStore.ts";
import type { RemoteProjectUi } from "../../../src/plugins/remoteProject/types.ts";
import {
  createRemoteProjectStore,
  remoteProjectsKey,
} from "../../../src/plugins/remoteProject/store/remoteProjectStore.ts";
import { apply as installRemoteWorkbench } from "../../../src/plugins/remoteProject/ui/workbench.tsx";
import { DesktopWorkbench } from "../../../src/plugins/workbench/composition/workbench.ts";
import { createLogger } from "../../../src/shared/logging/logger.ts";

const workspaceKey = "aaw-desktop/workspace/v1";

it("远程创建和编辑确认落盘失败时保留表单，可按原输入重试", async () => {
  const disk = new Map<string, string>();
  function saveChanges(changes: Readonly<Record<string, string>>) {
    for (const [key, value] of Object.entries(changes)) disk.set(key, value);
    return Promise.resolve();
  }
  const commit = vi.fn(saveChanges);
  const storage = {
    getItem: (key: string) => disk.get(key) ?? null,
    setItem: (key: string, value: string) => {
      disk.set(key, value);
    },
    setConfigurationItems: commit,
  };
  const workspace = createWorkspaceStore(storage, () => true);
  const remote = createRemoteProjectStore(storage, createLogger("test"));
  const workbench = new DesktopWorkbench({} as never, {} as never, storage, {
    Window: () => null,
    exitGate: {} as never,
  });
  const preload = vi.fn(() => Promise.resolve());
  const dispose: Array<() => void> = [];
  const empty = () => () => {};
  let ui!: RemoteProjectUi;
  installRemoteWorkbench({
    remoteProject: {
      projects: remote.snapshot,
      getByPath: remote.getByPath,
      saveProjectGroup: remote.saveProjectGroup,
      listConnections: () =>
        Promise.resolve([
          {
            id: "ssh",
            name: "测试主机",
            host: "127.0.0.1",
            port: 2222,
            user: "fixture",
            hasPassword: false,
            revision: 1,
          },
        ]),
      listDirectory: (_id: string, path: string) =>
        Promise.resolve({
          path: path || "/srv",
          parentPath: "/srv",
          entries: [],
          truncated: false,
        }),
      recordRecentDir: () => Promise.resolve(),
    },
    workbench: workbench.service,
    project: {
      isActive: () => true,
      projects: {
        ...workspace.commands,
        workspace: workspace.view,
        registerProjectClose: empty,
      },
      sessions: { registerSessionTools: empty, preloadSessionList: preload },
    },
    host: { commands: {}, registerRemoteTerminalResolver: empty },
    provide(_name: string, value: RemoteProjectUi) {
      ui = value;
    },
    effect(activate: () => () => void) {
      dispose.push(activate());
    },
  } as unknown as Context);
  async function addFolder(path: string) {
    fireEvent.click(screen.getByRole("button", { name: "添加文件夹" }));
    const go = screen.getByRole("button", { name: "前往" });
    await waitFor(() => expect(go).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: "远端目录路径" }), {
      target: { value: path },
    });
    fireEvent.click(go);
    const select = screen.getByRole("button", { name: "选择此文件夹" });
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.click(select);
    await screen.findByText(path);
  }
  let unmount = () => {};
  try {
    const closed = vi.fn();
    const Create = () => ui.renderAddProjectForm?.(closed);
    ({ unmount } = render(<Create />));
    fireEvent.click(screen.getByRole("button", { name: /切换设备/ }));
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: /测试主机/ }),
    );
    await addFolder("/srv/app");
    await addFolder("/srv/library");
    commit.mockRejectedValueOnce(new Error("模拟写盘失败"));
    const create = screen.getByRole("button", { name: "创建项目" });
    fireEvent.click(create);
    await screen.findByText("模拟写盘失败");
    expect(Object.keys(commit.mock.calls[0]![0]).sort()).toEqual(
      [remoteProjectsKey, workspaceKey].sort(),
    );
    expect(disk.size).toBe(0);
    expect(workspace.view.getState().recentWorkspaces).toEqual([]);
    expect(remote.snapshot.getState().records).toEqual([]);
    expect(preload).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByText("/srv/library")).toBeInTheDocument();
    let completeSave!: () => void;
    const gate = new Promise<void>((resolve) => {
      completeSave = resolve;
    });
    commit.mockImplementationOnce((changes) =>
      gate.then(() => saveChanges(changes)),
    );
    fireEvent.click(create);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    workspace.commands.togglePinned("D:/favorite");
    expect(disk.size).toBe(0);
    completeSave();
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    const target = workspace.view.getState().selectedPath!;
    const beforeEdit = new Map(disk);
    const previousBinding = remote.snapshot.getState().records;
    expect(beforeEdit.size).toBe(2);
    expect(beforeEdit.get(workspaceKey)).toContain("D:/favorite");
    expect(preload).toHaveBeenCalledWith(target);

    const editClosed = vi.fn();
    const Edit = () => ui.renderEditProjectForm?.(target, editClosed);
    unmount();
    ({ unmount } = render(<Edit />));
    const save = screen.getByRole("button", { name: "保存" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: "项目名称" }), {
      target: { value: "新名称" },
    });
    fireEvent.click(screen.getByRole("button", { name: "移除 library" }));
    await addFolder("/srv/docs");
    commit.mockRejectedValueOnce(new Error("编辑写盘失败"));
    fireEvent.click(save);
    await screen.findByText("编辑写盘失败");
    expect(disk).toEqual(beforeEdit);
    expect(remote.snapshot.getState().records).toBe(previousBinding);
    expect(workspace.view.getState().projectFolders?.[target]?.name).toBe(
      "app",
    );
    expect(editClosed).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "项目名称" })).toHaveValue(
      "新名称",
    );
    fireEvent.click(save);
    await waitFor(() => expect(editClosed).toHaveBeenCalledOnce());
    const reopened = createWorkspaceStore(storage, () => true);
    try {
      expect(reopened.view.getState().projectFolders?.[target]).toMatchObject({
        name: "新名称",
        relatedPaths: [expect.stringContaining("/srv/docs")],
      });
    } finally {
      reopened.dispose();
    }
    expect(
      remote.snapshot.getState().records.map(({ remoteRoot }) => remoteRoot),
    ).toContain("/srv/docs");
    const config = workspace.view.getState().projectFolders?.[target];
    const folders = config?.relatedPaths ?? [];
    await remote.removeProjectByPath(target, true);
    await workspace.store.getState().removeFromRecent(target);
    expect(remote.getByPath(target)?.associationOnly).toBe(true);
    const saveRestore = (_group: unknown, configuration: Readonly<Record<string, string>>, publishBinding: () => void) =>
      workspace.commands.restoreRemovedProject(target, { configuration, publishBinding });
    await expect(remote.restoreProjectGroup(target, folders, "missing-connection", saveRestore))
      .resolves.toBe(false);
    commit.mockRejectedValueOnce(new Error("恢复写盘失败"));
    await expect(remote.restoreProjectGroup(target, folders, "ssh", saveRestore))
      .rejects.toThrow("恢复写盘失败");
    expect(workspace.view.getState().removedProjects.map((entry) => entry.path)).toEqual([target]);
    expect(remote.getByPath(target)?.associationOnly).toBe(true);
    await expect(remote.restoreProjectGroup(target, folders, "ssh", saveRestore)).resolves.toBe(true);
    expect(workspace.view.getState()).toMatchObject({
      removedProjects: [], recentWorkspaces: [{ path: target }],
      projectFolders: { [target]: config },
    });
    expect(remote.getByPath(target)?.associationOnly).toBeUndefined();
  } finally {
    unmount();
    dispose.reverse().forEach((release) => release());
    workbench.dispose();
    workspace.dispose();
    remote.dispose();
  }
});
