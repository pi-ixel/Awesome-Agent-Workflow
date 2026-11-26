import { describe, expect, it, vi } from "vitest";
import type { Context } from "cordis";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDocumentFileHost } from "../../../src/plugins/host/filesystem/documentFiles.ts";
import { createDocuments } from "../../../src/plugins/documents/files/documents.ts";
import { createRemoteDocumentFileProvider } from "../../../src/plugins/remoteProject/fs/remoteFileProvider.ts";
import { createRemoteProjectStore } from "../../../src/plugins/remoteProject/store/remoteProjectStore.ts";
import { FileTree } from "../../../src/plugins/documents/ui/FileTree.tsx";
import { createLogger } from "../../../src/shared/logging/logger.ts";
import type { HostStorage } from "../../../src/plugins/host/types.ts";
import type { RemoteProjectService } from "../../../src/plugins/remoteProject/service.ts";
import type { RemoteDocumentFileProvider } from "../../../src/plugins/host/filesystem/types.ts";
import { apply as installRemoteProject } from "../../../src/plugins/remoteProject/index.ts";
import { formatRemoteProjectPath } from "../../../src/shared/panelPaths.ts";
import { createWorkspaceStore } from "../../../src/plugins/project/workspace/workspaceStore.ts";
import { DesktopWorkbench } from "../../../src/plugins/workbench/composition/workbench.ts";
import { registerDocumentPaths } from "../../../src/plugins/documents/ui/workbench.tsx";
import { apply as installRemoteWorkbench } from "../../../src/plugins/remoteProject/ui/workbench.tsx";

function createMemoryStorage(): HostStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe("Remote project FileTree + FilePreview end-to-end self-test", () => {
  it("工作台能打开同连接关联目录的文件，只缺关联绑定时提示修复", async () => {
    const storage = createMemoryStorage();
    const records = createRemoteProjectStore(storage, createLogger("test"));
    const group = await records.saveProjectGroup("ssh", "/srv/app", "项目组", ["/srv/library"]);
    const child = group.relatedPaths[0]!;
    const other = await records.addProject("other-ssh", "/srv/library");
    const unrelated = await records.addProject("ssh", "/srv/unrelated");
    const workspace = createWorkspaceStore(storage, () => true);
    const owner = workspace.store.getState().registerProject(group.record.workspacePath, {
      name: "项目组", relatedPaths: [child, other.workspacePath],
    });
    const workbench = new DesktopWorkbench({} as never, {} as never, storage, {
      Window: () => null, exitGate: {} as never,
    });
    const stat = vi.fn((path: string) => Promise.resolve({
      path, name: path.split("/").at(-1)!, directory: path === child, symlink: false,
    }));
    const disposers = [registerDocumentPaths(workbench, { stat })];
    const empty = () => () => {};
    installRemoteWorkbench({
      remoteProject: { projects: records.snapshot, getByPath: records.getByPath },
      workbench: workbench.service,
      project: {
        projects: { workspace: workspace.view, registerProjectClose: empty },
        sessions: { registerSessionTools: empty },
      },
      host: { commands: {}, registerRemoteTerminalResolver: empty },
      provide() {},
      effect(activate: () => () => void) { disposers.push(activate()); },
    } as unknown as Context);
    let unmount = () => {};
    try {
      workbench.navigation.getState().openView("project-overview", owner);
      const childFile = `${child}/readme.txt`;
      const present = vi.fn(() => true);
      await expect(workbench.openPath(owner, childFile, undefined, undefined, { present })).resolves.toBe(true);
      expect(stat.mock.calls).toEqual([[child], [childFile]]);
      expect(present).toHaveBeenCalledOnce();
      await expect(workbench.openPath(owner, `${other.workspacePath}/readme.txt`)).rejects.toThrow("当前远程主机");
      await expect(workbench.openPath(owner, `${unrelated.workspacePath}/readme.txt`)).rejects.toThrow("当前远程主机");
      expect(stat).toHaveBeenCalledTimes(2);

      const Recovery = workbench.getSnapshot().overlays.find(({ id }) => id === "remote-project-recovery")!.View;
      ({ unmount } = render(<Recovery />));
      expect(screen.queryByRole("button", { name: "修复连接" })).toBeNull();
      await records.removeProjectByPath(child);
      expect(await screen.findByRole("button", { name: "修复连接" })).toBeInTheDocument();
    } finally {
      unmount();
      disposers.reverse().forEach((dispose) => dispose());
      workbench.dispose();
      workspace.dispose();
      records.dispose();
    }
  });

  it("原项目失联后可校验主机、修复绑定，重启后同一个文件树能打开且浏览不写配置", async () => {
    const disk = createMemoryStorage();
    const save = vi.fn((key: string, value: string) => disk.setItem(key, value));
    const storage = { ...disk, setItem: save };
    const path = formatRemoteProjectPath("rp_original", "/srv/app");
    const oldWorkspace = JSON.stringify({
      recent: [{ path }],
      pinnedSessions: ["session-old"],
    });
    disk.setItem("aaw-desktop/workspace/v1", oldWorkspace);
    const file = {
      path: "/srv/app/kept.txt",
      name: "kept.txt",
      directory: false,
      symlink: false,
      size: 42,
      mtime: 1,
    };
    const request = vi.fn((method: string, connectionId: string) => {
      if (method === "project/fs-stat")
        return { ...file, directory: connectionId === "ssh-good" };
      return {
        path: "/srv/app",
        parentPath: "/srv",
        entries: [file],
        truncated: false,
      };
    });
    function start() {
      let service!: RemoteProjectService;
      let provider!: RemoteDocumentFileProvider;
      let reply!: (event: { payload: unknown }) => void;
      let dispose!: () => void;
      installRemoteProject({
        host: {
          storage,
          opsSidecar: {
            listen(event: string, handler: typeof reply) {
              if (event === "aaw://ops-service") reply = handler;
              return Promise.resolve(() => {});
            },
            invoke(
              command: string,
              args?: {
                message: {
                  id: string;
                  method: string;
                  params: { connectionId: string };
                };
              },
            ) {
              if (command === "ops_service_start")
                return Promise.resolve({ generation: 1, pid: 1 });
              if (command === "ops_service_write" && args) {
                const { id, method, params } = args.message;
                reply({
                  payload: {
                    generation: 1,
                    message: {
                      id,
                      ok: true,
                      data: request(method, params.connectionId),
                    },
                  },
                });
              }
              return Promise.resolve();
            },
          },
          registerRemoteDocumentFiles(files: RemoteDocumentFileProvider) {
            provider = files;
            return () => {};
          },
          registerRemoteGit: () => () => {},
        },
        diagnostics: { createLogger },
        provide(_name: string, value: RemoteProjectService) {
          service = value;
        },
        effect(activate: () => () => void) {
          dispose = activate();
        },
      } as unknown as Context);
      return { service, provider, dispose };
    }

    const first = start();
    await expect(first.provider.directory(path)).rejects.toThrow(
      "未找到远程项目记录",
    );
    expect(request).not.toHaveBeenCalled();
    await expect(
      first.service.repairProject(path, "ssh-wrong"),
    ).rejects.toThrow("不是目录");
    expect(save).not.toHaveBeenCalled();
    await expect(
      first.service.repairProject(path, "ssh-good"),
    ).resolves.toMatchObject({
      workspacePath: path,
      projectId: "rp_original",
      agentCwd: "remote-projects/rp_original",
    });
    first.dispose();

    const reopened = start();
    const documents = createDocuments(
      createDocumentFileHost(
        () => false,
        undefined,
        undefined,
        () => reopened.provider,
      ),
    );
    const { unmount } = render(<FileTree documents={documents} root={path} />);
    try {
      await screen.findByText("kept.txt");
      expect(request).toHaveBeenLastCalledWith("project/fs-list", "ssh-good");
      expect(save).toHaveBeenCalledOnce();
      expect(disk.getItem("aaw-desktop/workspace/v1")).toBe(oldWorkspace);
    } finally {
      unmount();
      documents.dispose();
      reopened.dispose();
    }
  });

  it("远程项目接入 FileTree 与 FilePreview 后可浏览目录、预览文本，且同主机双账号同名目录内容互不串扰", async () => {
    const storage = createMemoryStorage();
    const store = createRemoteProjectStore(storage, createLogger("test"));
    const alice = await store.addProject(
      "conn-alice",
      "/srv/shared-app",
      "shared-app",
    );
    const bob = await store.addProject(
      "conn-bob",
      "/srv/shared-app",
      "shared-app",
    );

    const remoteProvider = createRemoteDocumentFileProvider({
      getById: store.getById,
      listDirectory: (connectionId, remotePath) =>
        Promise.resolve({
          path: remotePath,
          parentPath: "/srv",
          truncated: false,
          entries: [
            {
              path: `${remotePath}/README.txt`,
              name: "README.txt",
              directory: false,
              symlink: false,
              size: 32,
              mtime: 1,
            },
            {
              path: `${remotePath}/${connectionId === "conn-alice" ? "alice-only.ts" : "bob-only.ts"}`,
              name:
                connectionId === "conn-alice" ? "alice-only.ts" : "bob-only.ts",
              directory: false,
              symlink: false,
              size: 18,
              mtime: 1,
            },
          ],
        }),
      stat: (_connectionId, remotePath) =>
        Promise.resolve({
          path: remotePath,
          name: remotePath.split("/").at(-1) ?? "file",
          directory: false,
          symlink: false,
          size: 32,
          mtime: 1,
        }),
      preview: (connectionId) =>
        Promise.resolve({
          kind: "text",
          content:
            connectionId === "conn-alice"
              ? "HELLO FROM ALICE REMOTE"
              : "HELLO FROM BOB REMOTE",
          mime: "text/plain",
          bytes: 23,
        }),
      listWorkspaceFiles: (connectionId) =>
        Promise.resolve([
          "README.txt",
          connectionId === "conn-alice" ? "alice-only.ts" : "bob-only.ts",
        ]),
    });

    const localPanel = {
      stat: vi.fn(),
      directory: vi.fn(),
      preview: vi.fn(),
      saveMarkdown: vi.fn(),
      gitStatus: vi.fn(),
      gitDiff: vi.fn(),
      watch: vi.fn(),
    };

    const files = createDocumentFileHost(
      () => false,
      localPanel,
      vi.fn(),
      () => remoteProvider,
    );
    const documents = createDocuments(files, createLogger("documents-test"));

    // 先渲染 Alice 远程项目的 FileTree
    const { rerender } = render(
      <div style={{ width: 800, height: 600 }}>
        <FileTree documents={documents} root={alice.workspacePath} />
      </div>,
    );

    await screen.findByText("alice-only.ts");
    expect(screen.queryByText("bob-only.ts")).toBeNull();

    // 点击 README.txt 触发远端文本预览
    fireEvent.click(screen.getByText("README.txt"));
    await screen.findByText(/HELLO FROM ALICE REMOTE/);

    // 右键远程文件：不显示本地文件管理器项，且复制绝对路径输出真实远端路径
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    fireEvent.contextMenu(screen.getByText("alice-only.ts"));
    expect(
      screen.queryByRole("menuitem", { name: /资源管理器|访达|文件管理器/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "复制绝对路径" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("/srv/shared-app/alice-only.ts");
    });

    // 文件树顶栏更多菜单：远程项目隐藏「在资源管理器中打开」，复制路径输出真实远端根目录
    const moreButtons = screen.getAllByRole("button", { name: "更多" });
    fireEvent.click(moreButtons[moreButtons.length - 1]!);
    expect(
      screen.queryByRole("menuitem", { name: /资源管理器|访达|文件管理器/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "复制路径" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("/srv/shared-app");
    });

    // 切换到同主机同路径的 Bob 远程项目：树与预览都必须切到 Bob
    rerender(
      <div style={{ width: 800, height: 600 }}>
        <FileTree documents={documents} root={bob.workspacePath} />
      </div>,
    );

    await screen.findByText("bob-only.ts");
    expect(screen.queryByText("alice-only.ts")).toBeNull();

    fireEvent.click(screen.getByText("README.txt"));
    await waitFor(() => {
      expect(screen.getByText(/HELLO FROM BOB REMOTE/)).toBeTruthy();
    });

    // 本地 panelService 从未被误调用
    expect(localPanel.directory).not.toHaveBeenCalled();
    expect(localPanel.preview).not.toHaveBeenCalled();
    expect(localPanel.watch).not.toHaveBeenCalled();

    documents.dispose();
    store.dispose();
  });
});
