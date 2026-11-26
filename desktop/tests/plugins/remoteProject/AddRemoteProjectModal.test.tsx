import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore } from "zustand";
import { createSnapshotView } from "../../../src/shared/state/readonlySnapshot.ts";
import { AddRemoteProjectModal } from "../../../src/plugins/remoteProject/ui/AddRemoteProjectModal.tsx";
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
    repairProject: vi.fn(),
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
  it("修复时要求显式选择主机，失败保留原目录，成功后才关闭", async () => {
    const path = formatRemoteProjectPath("rp_original", "/srv/repo");
    const onAdded = vi.fn();
    const onClose = vi.fn();
    const repairProject = vi
      .fn<RemoteProjectService["repairProject"]>()
      .mockRejectedValueOnce(new Error("配置未写入"))
      .mockResolvedValueOnce({
        projectId: "rp_original",
        connectionId: "conn-bob",
        remoteRoot: "/srv/repo",
        workspacePath: path,
        agentCwd: "remote-projects/rp_original",
        name: "repo",
        createdAt: "",
        lastOpenedAt: "",
      });
    render(
      <AddRemoteProjectModal
        service={createMockService({ repairProject })}
        onClose={onClose}
        onAdded={onAdded}
        repairPath={path}
      />,
    );
    expect(screen.getByText("/srv/repo")).toBeVisible();
    const confirm = screen.getByRole("button", { name: "修复连接" });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /切换设备/ }));
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: /Dev Bob/ }),
    );
    fireEvent.click(confirm);
    expect(await screen.findByRole("alert")).toHaveTextContent("配置未写入");
    expect(repairProject).toHaveBeenCalledWith(path, "conn-bob");
    expect(onAdded).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("/srv/repo")).toBeVisible();
    fireEvent.click(confirm);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onAdded).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: path,
        projectId: "rp_original",
      }),
    );
  });

  it("支持默认在此电脑选择本地目录并创建本地项目", async () => {
    const service = createMockService();
    const onPickLocalDirectory = vi.fn().mockResolvedValue("D:/work/demo-app");
    const onLocalAdded = vi.fn();
    const onClose = vi.fn();

    render(
      <AddRemoteProjectModal
        service={service}
        onClose={onClose}
        onAdded={vi.fn()}
        onPickLocalDirectory={onPickLocalDirectory}
        onLocalAdded={onLocalAdded}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await screen.findByText("D:/work/demo-app");

    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    expect(onLocalAdded).toHaveBeenCalledWith("D:/work/demo-app");
    expect(onClose).toHaveBeenCalled();
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
        onAdded={vi.fn()}
        onPickLocalDirectory={vi.fn().mockResolvedValue(null)}
        onLocalAdded={vi.fn()}
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
    const onAdded = vi.fn();
    const onClose = vi.fn();
    const service = createMockService();

    render(
      <AddRemoteProjectModal
        service={service}
        onClose={onClose}
        onAdded={onAdded}
        onPickLocalDirectory={vi.fn().mockResolvedValue(null)}
        onLocalAdded={vi.fn()}
      />,
    );

    // 切换设备为 Dev Alice
    fireEvent.click(screen.getByRole("button", { name: /切换设备/ }));
    const aliceItem = await screen.findByRole("menuitemradio", {
      name: /Dev Alice/,
    });
    fireEvent.click(aliceItem);

    // 点击「添加」打开专用远端目录选择器
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
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

    await waitFor(() =>
      expect(onAdded).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: "conn-alice",
          remoteRoot: "/home/alice/repo",
          name: "My Remote Repo",
        }),
      ),
    );
    expect(onClose).toHaveBeenCalled();
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
