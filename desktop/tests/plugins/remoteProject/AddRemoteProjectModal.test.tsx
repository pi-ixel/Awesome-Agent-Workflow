import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore } from "zustand";
import { createSnapshotView } from "../../../src/shared/state/readonlySnapshot.ts";
import { AddRemoteProjectModal } from "../../../src/plugins/remoteProject/ui/AddRemoteProjectModal.tsx";
import type {
  RemoteConnectionDTO,
  RemoteFSListResult,
  RemoteProjectRecord,
  RemoteProjectService,
  RemoteProjectStoreSnapshot,
} from "../../../src/plugins/remoteProject/service.ts";
import { formatRemoteProjectPath } from "../../../src/shared/panelPaths.ts";

function createMockService(overrides: Partial<RemoteProjectService> = {}): RemoteProjectService {
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
      hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestAlice",
      hostKeyFingerprint: "SHA256:alicefp",
      revision: 0,
    },
    {
      id: "conn-bob",
      name: "Dev Bob",
      host: "10.0.0.1",
      port: 22,
      user: "bob",
      hasPassword: true,
      hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestBob",
      hostKeyFingerprint: "SHA256:bobfp",
      revision: 0,
    },
  ];

  return {
    projects: view.snapshot,
    getByPath: () => null,
    getById: () => null,
    listProjectsForConnection: () => [],
    addProject: (connectionId, remoteRoot): RemoteProjectRecord => ({
      projectId: `rp_${connectionId}`,
      connectionId,
      remoteRoot,
      workspacePath: formatRemoteProjectPath(`rp_${connectionId}`, remoteRoot),
      agentCwd: `remote-projects/rp_${connectionId}`,
      name: remoteRoot.split("/").filter(Boolean).at(-1) ?? "/",
      createdAt: "2026-01-01T00:00:00Z",
      lastOpenedAt: "2026-01-01T00:00:00Z",
    }),
    removeProjectByPath: vi.fn(),
    recordRecentDir: vi.fn(),
    listConnections: vi.fn().mockResolvedValue(connections),
    createConnection: vi.fn(),
    updateConnection: vi.fn(),
    deleteConnection: vi.fn(),
    testConnection: vi.fn(),
    listDirectory: vi.fn().mockImplementation((connectionId: string, path: string): Promise<RemoteFSListResult> => {
      const resolved = path || (connectionId === "conn-alice" ? "/home/alice" : "/home/bob");
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
    }),
    stat: vi.fn(),
    preview: vi.fn(),
    listWorkspaceFiles: vi.fn().mockResolvedValue([]),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("AddRemoteProjectModal", () => {
  it("支持首次连接主机指纹确认（TOFU）并保存连接", async () => {
    const testConnection = vi
      .fn()
      .mockResolvedValueOnce({
        status: "host_key_untrusted",
        host: "10.0.0.9",
        port: 22,
        hop: 0,
        keyType: "ssh-ed25519",
        fingerprint: "SHA256:newHostFingerprint",
        hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINewHostKey",
      })
      .mockResolvedValueOnce({
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
      hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINewHostKey",
      revision: 0,
    });
    const service = createMockService({ testConnection, createConnection });

    render(
      <AddRemoteProjectModal
        service={service}
        onClose={vi.fn()}
        onAdded={vi.fn()}
      />,
    );

    await screen.findByText("Dev Alice");
    fireEvent.click(screen.getByRole("button", { name: "新建连接" }));

    fireEvent.change(screen.getByPlaceholderText("例如：测试机-Alice"), {
      target: { value: "New Box" },
    });
    fireEvent.change(screen.getByPlaceholderText("10.0.0.1"), {
      target: { value: "10.0.0.9" },
    });
    fireEvent.change(screen.getByPlaceholderText("dev"), {
      target: { value: "dev" },
    });

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await screen.findByText(/SHA256:newHostFingerprint/);

    fireEvent.click(screen.getByRole("button", { name: "信任此指纹并继续测试" }));
    await screen.findByText(/连接成功，远端家目录：\/home\/dev/);

    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await waitFor(() => {
      expect(createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "10.0.0.9",
          user: "dev",
          hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINewHostKey",
        }),
      );
    });
  });

  it("连接仍被项目引用时阻止删除并展示引用项目，且浏览后可添加远程项目", async () => {
    const deleteConnection = vi.fn();
    const onAdded = vi.fn();
    const onClose = vi.fn();
    const service = createMockService({
      deleteConnection,
      listProjectsForConnection: (id) =>
        id === "conn-alice"
          ? [
              {
                projectId: "rp_1",
                connectionId: "conn-alice",
                remoteRoot: "/home/alice/existing",
                workspacePath: formatRemoteProjectPath("rp_1", "/home/alice/existing"),
                agentCwd: "remote-projects/rp_1",
                name: "existing",
                createdAt: "2026-01-01T00:00:00Z",
                lastOpenedAt: "2026-01-01T00:00:00Z",
              },
            ]
          : [],
    });

    render(
      <AddRemoteProjectModal
        service={service}
        onClose={onClose}
        onAdded={onAdded}
      />,
    );

    await screen.findByText("Dev Alice");
    const deleteButtons = screen.getAllByRole("button", { name: "删除" });
    fireEvent.click(deleteButtons[0]!);
    await screen.findByText(/该连接仍被以下远程项目引用/);
    expect(deleteConnection).not.toHaveBeenCalled();

    // 进入子目录 repo 并点击添加项目
    const repoBtn = await screen.findByRole("button", { name: "repo" });
    fireEvent.click(repoBtn);
    await waitFor(() => {
      expect(screen.getByDisplayValue("/home/alice/repo")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "添加项目" }));
    expect(onAdded).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-alice",
        remoteRoot: "/home/alice/repo",
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
