import { describe, expect, it, vi } from "vitest";
import { createDocumentFileHost } from "../../../src/plugins/host/filesystem/documentFiles.ts";
import { createRemoteDocumentFileProvider } from "../../../src/plugins/remoteProject/fs/remoteFileProvider.ts";
import { formatRemoteProjectPath } from "../../../src/shared/panelPaths.ts";
import type { RemoteProjectRecord } from "../../../src/plugins/remoteProject/types.ts";

describe("createDocumentFileHost + remoteFileProvider routing", () => {
  it("本地路径走本地 panelService，远程路径按 projectId 路由到对应 SSH 连接且互不串扰", async () => {
    const records = new Map<string, RemoteProjectRecord>([
      [
        "rp_alice",
        {
          projectId: "rp_alice",
          connectionId: "conn-alice",
          remoteRoot: "/srv/app",
          workspacePath: formatRemoteProjectPath("rp_alice", "/srv/app"),
          agentCwd: "remote-projects/rp_alice",
          name: "app",
          createdAt: "2026-01-01T00:00:00Z",
          lastOpenedAt: "2026-01-01T00:00:00Z",
        },
      ],
      [
        "rp_bob",
        {
          projectId: "rp_bob",
          connectionId: "conn-bob",
          remoteRoot: "/srv/app",
          workspacePath: formatRemoteProjectPath("rp_bob", "/srv/app"),
          agentCwd: "remote-projects/rp_bob",
          name: "app",
          createdAt: "2026-01-01T00:00:00Z",
          lastOpenedAt: "2026-01-01T00:00:00Z",
        },
      ],
    ]);

    const remoteProvider = createRemoteDocumentFileProvider({
      getById: (id) => records.get(id) ?? null,
      listDirectory: (_connectionId, remotePath) =>
        Promise.resolve({
          path: remotePath,
          parentPath: "/",
          truncated: false,
          entries: [
            {
              path: `${remotePath}/owner.txt`,
              name: "owner.txt",
              directory: false,
              symlink: false,
              size: 16,
              mtime: 1,
            },
          ],
        }),
      stat: (_connectionId, remotePath) =>
        Promise.resolve({
          path: remotePath,
          name: "owner.txt",
          directory: false,
          symlink: false,
          size: 16,
          mtime: 1,
        }),
      preview: (connectionId) =>
        Promise.resolve({
          kind: "text",
          content: connectionId === "conn-alice" ? "alice-data" : "bob-data",
          mime: "text/plain",
          bytes: 10,
        }),
      listWorkspaceFiles: (connectionId) =>
        Promise.resolve([
          connectionId === "conn-alice" ? "alice.ts" : "bob.ts",
        ]),
    });

    const localPanel = {
      stat: vi.fn(),
      directory: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
      preview: vi.fn(),
      saveMarkdown: vi.fn(),
      gitStatus: vi.fn(),
      gitDiff: vi.fn(),
      watch: vi.fn().mockResolvedValue(() => {}),
    };

    const files = createDocumentFileHost(
      () => false,
      localPanel,
      vi.fn(),
      () => remoteProvider,
    );

    // 1. 本地目录走本地 panel
    await files.directory("D:/dev/local-project");
    expect(localPanel.directory).toHaveBeenCalledWith("D:/dev/local-project");

    // 2. 两个远程项目同名目录分别读取各自内容，且返回的 entry.path 携带各自 projectId
    const dirA = await files.directory(formatRemoteProjectPath("rp_alice", "/srv/app"));
    const dirB = await files.directory(formatRemoteProjectPath("rp_bob", "/srv/app"));
    expect(dirA.entries[0]?.path).toBe(formatRemoteProjectPath("rp_alice", "/srv/app/owner.txt"));
    expect(dirB.entries[0]?.path).toBe(formatRemoteProjectPath("rp_bob", "/srv/app/owner.txt"));

    const previewA = await files.preview(dirA.entries[0]!.path);
    const previewB = await files.preview(dirB.entries[0]!.path);
    expect(previewA.content).toBe("alice-data");
    expect(previewB.content).toBe("bob-data");

    // 3. 远端只读语义：watch 返回空释放器，saveMarkdown 与 openInFileManager 拒绝
    const unwatch = await files.watch(
      [{ path: formatRemoteProjectPath("rp_alice", "/srv/app"), recursive: false }],
      vi.fn(),
      vi.fn(),
    );
    expect(typeof unwatch).toBe("function");
    expect(localPanel.watch).not.toHaveBeenCalled();

    await expect(
      files.saveMarkdown(dirA.entries[0]!.path, "", "new", false),
    ).rejects.toThrow("写入服务尚未就绪");
    await expect(
      files.openInFileManager(dirA.entries[0]!.path, "reveal"),
    ).rejects.toThrow("暂不支持");
  });
});
