import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore } from "zustand";
import { createSnapshotView } from "../../../src/shared/state/readonlySnapshot.ts";
import {
  AddRemoteProjectModal,
  type AddRemoteProjectModalProps,
} from "../../../src/plugins/remoteProject/ui/AddRemoteProjectModal.tsx";
import { RemoteHostsSettings } from "../../../src/plugins/remoteProject/ui/RemoteHostsSettings.tsx";
import type {
  RemoteConnectionDTO,
  RemoteFSListResult,
  RemoteProjectRecord,
  RemoteProjectService,
  RemoteProjectStoreSnapshot,
} from "../../../src/plugins/remoteProject/service.ts";
import { formatRemoteProjectPath } from "../../../src/shared/panelPaths.ts";

function createMockService(
  overrides: Partial<RemoteProjectService> = {},
): RemoteProjectService {
  const store = createStore<RemoteProjectStoreSnapshot>(() => ({
    records: [],
    recentDirsByConnection: {},
  }));
  const view = createSnapshotView(store, (s) => s);
  const connections: RemoteConnectionDTO[] = [
    {
      id: "conn-alice",
      name: "Dev Alice",
      host: "10.0.0.1",
      port: 22,
      user: "alice",
      hasPassword: true,
      revision: 0,
    },
    {
      id: "conn-bob",
      name: "Dev Bob",
      host: "10.0.0.2",
      port: 22,
      user: "bob",
      hasPassword: true,
      revision: 0,
    },
  ];

  return {
    projects: view.snapshot,
    getByPath: () => null,
    getById: () => null,
    listProjectsForConnection: () => [],
    addProject: (
      connectionId,
      remoteRoot,
      name,
    ): Promise<RemoteProjectRecord> =>
      Promise.resolve({
        projectId: `rp_${connectionId}`,
        connectionId,
        remoteRoot,
        workspacePath: formatRemoteProjectPath(
          `rp_${connectionId}`,
          remoteRoot,
        ),
        agentCwd: `remote-projects/rp_${connectionId}`,
        name: name ?? remoteRoot.split("/").filter(Boolean).at(-1) ?? "/",
        createdAt: "2026-01-01T00:00:00Z",
        lastOpenedAt: "2026-01-01T00:00:00Z",
      }),
    saveProjectGroup: vi.fn(),
    repairProject: vi.fn(),
    restoreProjectGroup: vi.fn(() => Promise.resolve(false)),
    removeProjectByPath: vi.fn(),
    recordRecentDir: vi.fn(),
    listConnections: vi.fn().mockResolvedValue(connections),
    createConnection: vi.fn(),
    updateConnection: vi.fn(),
    deleteConnection: vi.fn(),
    testConnection: vi.fn(),
    listDirectory: vi
      .fn()
      .mockImplementation(
        (connectionId: string, path: string): Promise<RemoteFSListResult> => {
          const resolved =
            path ||
            (connectionId === "conn-alice"
              ? "/home/alice"
              : connectionId === "conn-new"
                ? "/home/dev"
                : "/home/bob");
          return Promise.resolve({
            path: resolved,
            parentPath: "/",
            truncated: false,
            entries: [
              {
                path: `${resolved}/repo`,
                name: "repo",
                directory: true,
                symlink: false,
                size: 0,
                mtime: 1,
              },
            ],
          });
        },
      ),
    stat: vi.fn(),
    preview: vi.fn(),
    listWorkspaceFiles: vi.fn().mockResolvedValue([]),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    execCommand: vi.fn(),
    cancelCommand: vi.fn(),
    gitStatus: vi.fn(),
    gitDiff: vi.fn(),
    bindSessionMcp: vi.fn(),
    unbindSessionMcp: vi.fn(),
    replyApproval: vi.fn(),
    onApprovalRequest: () => () => {},
    prepareTerminal: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("AddRemoteProjectModal", () => {
  it("热更新沿用旧入口的回调时禁止保存并提供重新加载入口", async () => {
    const onLocalAdded = vi.fn();
    const staleProps = {
      service: createMockService(),
      onClose: vi.fn(),
      onPickLocalDirectory: vi.fn().mockResolvedValue("D:/work/demo-app"),
      onAdded: vi.fn(),
      onLocalAdded,
    } as unknown as AddRemoteProjectModalProps;
    render(<AddRemoteProjectModal {...staleProps} />);
    fireEvent.click(screen.getByRole("button", { name: "添加文件夹" }));
    await screen.findByText("D:/work/demo-app");
    const create = screen.getByRole("button", { name: "创建项目" });
    expect(create).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "重新加载" }),
    ).toBeInTheDocument();
    fireEvent.click(create);
    expect(onLocalAdded).not.toHaveBeenCalled();
    expect(screen.queryByText(/onSave is not a function/)).toBeNull();
  });

  it("修复时显式选择主机，保存失败保留原路径，成功后关闭", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error("写入失败"))
      .mockResolvedValueOnce(true);
    const onClose = vi.fn();
    render(
      <AddRemoteProjectModal
        service={createMockService()}
        onClose={onClose}
        onSave={onSave}
        repairPath={formatRemoteProjectPath("rp_original", "/srv/repo")}
        repairRelatedPaths={[formatRemoteProjectPath("rp_library", "/srv/library")]}
        onPickLocalDirectory={vi.fn()}
      />,
    );
    const repair = screen.getByRole("button", { name: "修复连接" });
    expect(repair).toBeDisabled();
    expect(screen.queryByRole("button", { name: "添加文件夹" })).toBeNull();
    expect(screen.getByText("/srv/library")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移除 library" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /切换设备/ }));
    expect(screen.queryByRole("menuitemradio", { name: "此电脑" })).toBeNull();
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: /Dev Alice/ }),
    );
    fireEvent.click(repair);
    expect(onSave).toHaveBeenCalledWith("conn-alice", "repo", "/srv/repo", ["/srv/library"]);
    expect(await screen.findByText("写入失败")).toBeInTheDocument();
    expect(screen.getByText("/srv/repo")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(repair);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("选择多个本地目录后可以设定主目录再一次创建项目", async () => {
    const service = createMockService();
    const onPickLocalDirectory = vi
      .fn()
      .mockResolvedValueOnce("D:/work/demo-app")
      .mockResolvedValueOnce("D:/work/library")
      .mockResolvedValueOnce("d:/WORK/LIBRARY/");
    const onSave = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();

    render(
      <AddRemoteProjectModal
        service={service}
        onClose={onClose}
        onSave={onSave}
        onPickLocalDirectory={onPickLocalDirectory}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加文件夹" }));
    await screen.findByText("D:/work/demo-app");

    fireEvent.click(screen.getByRole("button", { name: "添加文件夹" }));
    await screen.findByText("D:/work/library");
    fireEvent.click(screen.getByRole("button", { name: "添加文件夹" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "添加文件夹" })).toBeEnabled(),
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", { name: "设 library 为主要目录" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    expect(onSave).toHaveBeenCalledWith("local", "library", "D:/work/library", [
      "D:/work/demo-app",
    ]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("可通过设备胶囊菜单添加远程主机并自动切换至该主机", async () => {
    const testConnection = vi.fn().mockResolvedValueOnce({
      status: "ok",
      homeDir: "/home/dev",
      host: "10.0.0.9",
      port: 22,
      user: "dev",
    });
    const createConnection = vi.fn().mockResolvedValue({
      id: "conn-new",
      name: "New Box",
      host: "10.0.0.9",
      port: 22,
      user: "dev",
      hasPassword: true,
      revision: 0,
    });
    const service = createMockService({ testConnection, createConnection });

    render(
      <AddRemoteProjectModal
        service={service}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onPickLocalDirectory={vi.fn().mockResolvedValue(null)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /切换设备/ }));
    await screen.findByText("Dev Alice");
    fireEvent.click(screen.getByRole("menuitem", { name: "添加远程主机" }));

    fireEvent.change(screen.getByLabelText("连接名称"), {
      target: { value: "New Box" },
    });
    fireEvent.change(screen.getByLabelText("主机地址"), {
      target: { value: "10.0.0.9" },
    });
    fireEvent.change(screen.getByLabelText("用户名"), {
      target: { value: "dev" },
    });

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await screen.findByText(/连接成功，远端家目录：\/home\/dev/);

    fireEvent.click(screen.getByRole("button", { name: "保存主机" }));
    await waitFor(() => {
      expect(createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "New Box",
          host: "10.0.0.9",
          user: "dev",
        }),
      );
    });

    // 保存后回到创建项目弹窗并自动选中 New Box
    await screen.findByRole("button", { name: /切换设备，当前：New Box/ });
  });

  it("切换远程主机后点击「添加」打开专用远端目录选择器，选定目录后可创建远程项目", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    const service = createMockService();

    render(
      <AddRemoteProjectModal
        service={service}
        onClose={onClose}
        onSave={onSave}
        onPickLocalDirectory={vi.fn().mockResolvedValue(null)}
      />,
    );

    // 切换设备为 Dev Alice
    fireEvent.click(screen.getByRole("button", { name: /切换设备/ }));
    const aliceItem = await screen.findByRole("menuitemradio", {
      name: /Dev Alice/,
    });
    fireEvent.click(aliceItem);

    // 点击「添加」打开专用远端目录选择器
    fireEvent.click(screen.getByRole("button", { name: "添加文件夹" }));
    const repoBtn = await screen.findByRole("button", { name: "repo" });
    fireEvent.click(repoBtn);
    await waitFor(() => {
      expect(screen.getByDisplayValue("/home/alice/repo")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "选择此文件夹" }));

    // 回到创建项目弹窗，确认已展示选中目录并可自定义项目名
    await screen.findByText("/home/alice/repo");
    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "My Remote Repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));

    expect(onSave).toHaveBeenCalledWith(
      "conn-alice",
      "My Remote Repo",
      "/home/alice/repo",
      [],
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("编辑项目保留主目录与设备，可移除旧目录或继续添加", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(
      <AddRemoteProjectModal
        service={createMockService()}
        onClose={vi.fn()}
        onSave={onSave}
        onPickLocalDirectory={vi.fn().mockResolvedValue("D:/work/docs")}
        edit={{
          deviceId: "local",
          name: "Demo",
          folders: ["D:/work/demo", "D:/work/library"],
        }}
      />,
    );
    expect(screen.queryByRole("button", { name: "移除 demo" })).toBeNull();
    expect(screen.queryByRole("button", { name: /设.*为主要目录/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /切换设备/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "移除 library" }));
    fireEvent.click(screen.getByRole("button", { name: "添加文件夹" }));
    await screen.findByText("D:/work/docs");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onSave).toHaveBeenCalledWith("local", "Demo", "D:/work/demo", [
      "D:/work/docs",
    ]);
  });
});

describe("RemoteHostsSettings", () => {
  it("连接仍被项目引用时阻止删除并展示引用项目", async () => {
    const deleteConnection = vi.fn();
    const service = createMockService({
      deleteConnection,
      listProjectsForConnection: (id) =>
        id === "conn-alice"
          ? [
              {
                projectId: "rp_1",
                connectionId: "conn-alice",
                remoteRoot: "/home/alice/existing",
                workspacePath: formatRemoteProjectPath(
                  "rp_1",
                  "/home/alice/existing",
                ),
                agentCwd: "remote-projects/rp_1",
                name: "existing",
                createdAt: "2026-01-01T00:00:00Z",
                lastOpenedAt: "2026-01-01T00:00:00Z",
              },
            ]
          : [],
    });

    render(<RemoteHostsSettings service={service} />);

    await screen.findByText("Dev Alice");
    fireEvent.click(screen.getByRole("button", { name: "删除 Dev Alice" }));
    await screen.findByText(/无法删除：以下远程项目仍在使用该主机/);
    expect(deleteConnection).not.toHaveBeenCalled();
  });
});
