import { describe, expect, it, vi } from "vitest";
import { createDocumentFileHost } from "../../../src/plugins/host/filesystem/documentFiles.ts";
import { createGitHost } from "../../../src/plugins/host/filesystem/git.ts";
import { createRemoteDocumentFileProvider } from "../../../src/plugins/remoteProject/fs/remoteFileProvider.ts";
import { createRemoteGitProvider } from "../../../src/plugins/remoteProject/git/remoteGitProvider.ts";
import { createRemoteSessionToolProvider } from "../../../src/plugins/remoteProject/session/sessionBridge.ts";
import { formatRemoteProjectPath } from "../../../src/shared/panelPaths.ts";
import type {
  RemoteApprovalRequestEvent,
  RemoteProjectRecord,
} from "../../../src/plugins/remoteProject/types.ts";

const remoteRecord: RemoteProjectRecord = {
  projectId: "rp_iter2",
  connectionId: "conn-1",
  remoteRoot: "/srv/repo",
  workspacePath: formatRemoteProjectPath("rp_iter2", "/srv/repo"),
  agentCwd: "remote-projects/rp_iter2",
  name: "repo",
  createdAt: "2026-01-01T00:00:00Z",
  lastOpenedAt: "2026-01-01T00:00:00Z",
};

describe("Iteration 2: remote saveMarkdown, remote Git, and session MCP approval bridge", () => {
  it("远程文件保存透传 expectedContent 与 force，冲突时透出错误", async () => {
    const writeFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("远端文件已被外部修改，请重新加载后重试"))
      .mockResolvedValueOnce({ path: "/srv/repo/README.md", version: "v2", bytes: 12 });

    const remoteProvider = createRemoteDocumentFileProvider({
      getById: (id) => (id === remoteRecord.projectId ? remoteRecord : null),
      listDirectory: vi.fn(),
      stat: vi.fn(),
      preview: vi.fn(),
      listWorkspaceFiles: vi.fn(),
      writeFile,
    });
    const files = createDocumentFileHost(
      () => false,
      {
        stat: vi.fn(),
        directory: vi.fn(),
        preview: vi.fn(),
        saveMarkdown: vi.fn(),
        gitStatus: vi.fn(),
        gitDiff: vi.fn(),
        watch: vi.fn(),
      },
      vi.fn(),
      () => remoteProvider,
    );

    const filePath = formatRemoteProjectPath("rp_iter2", "/srv/repo/README.md");
    await expect(
      files.saveMarkdown(filePath, "old-text", "new-text", false),
    ).rejects.toThrow("已被外部修改");

    await files.saveMarkdown(filePath, "old-text", "new-text", true);
    expect(writeFile).toHaveBeenLastCalledWith({
      connectionId: "conn-1",
      path: "/srv/repo/README.md",
      content: "new-text",
      expectedContent: "old-text",
      force: true,
    });
  });

  it("Git 宿主按路径路由本地与远程项目，并将远程 repoRoot 映射回虚拟项目路径", async () => {
    const localPanel = {
      stat: vi.fn(),
      directory: vi.fn(),
      preview: vi.fn(),
      saveMarkdown: vi.fn(),
      gitStatus: vi.fn().mockResolvedValue({
        repoRoot: "D:/dev/local",
        branch: "main",
        changes: [],
        watchPaths: [],
      }),
      gitDiff: vi.fn(),
      watch: vi.fn().mockResolvedValue(() => {}),
    };
    const remoteGit = createRemoteGitProvider({
      getById: (id) => (id === remoteRecord.projectId ? remoteRecord : null),
      gitStatus: () =>
        Promise.resolve({
          repoRoot: "/srv/repo",
          branch: "feat/remote",
          changes: [
            {
              path: "src/app.ts",
              oldPath: null,
              source: "unstaged",
              status: "modified",
            },
          ],
          watchPaths: [],
        }),
      gitDiff: () =>
        Promise.resolve({
          patch: "--- a/src/app.ts\n+++ b/src/app.ts\n",
          notice: null,
          beforeContent: "a",
          afterContent: "b",
        }),
    });

    const git = createGitHost(() => false, localPanel, () => remoteGit);

    const localStatus = await git.status("D:/dev/local");
    expect(localStatus.repoRoot).toBe("D:/dev/local");
    expect(localPanel.gitStatus).toHaveBeenCalledWith("D:/dev/local");

    const remoteStatus = await git.status(remoteRecord.workspacePath);
    expect(remoteStatus.repoRoot).toBe(remoteRecord.workspacePath);
    expect(remoteStatus.branch).toBe("feat/remote");
    expect(remoteStatus.changes[0]?.path).toBe("src/app.ts");

    const diff = await git.diff(remoteRecord.workspacePath, remoteStatus.changes[0]!);
    expect(diff.patch).toContain("src/app.ts");

    const stopWatch = await git.watch(
      [{ path: remoteRecord.workspacePath, recursive: true }],
      vi.fn(),
      vi.fn(),
    );
    expect(typeof stopWatch).toBe("function");
    expect(localPanel.watch).not.toHaveBeenCalled();
  });

  it("远程会话自动挂载 /project-mcp，审批事件复用会话 requestPermission 并在销毁时解绑", async () => {
    let approvalListener: ((event: RemoteApprovalRequestEvent) => void) | null = null;
    const unbindSessionMcp = vi.fn().mockResolvedValue(undefined);
    const replyApproval = vi.fn().mockResolvedValue(undefined);
    const provider = createRemoteSessionToolProvider({
      getByPath: (p) => (p === remoteRecord.workspacePath ? remoteRecord : null),
      bindSessionMcp: vi.fn().mockResolvedValue({
        token: "ptok-session-1",
        url: "http://127.0.0.1:45678/project-mcp",
        revision: 0,
      }),
      unbindSessionMcp,
      replyApproval,
      onApprovalRequest: (handler) => {
        approvalListener = handler;
        return () => {
          if (approvalListener === handler) approvalListener = null;
        };
      },
    });

    // 本地项目不挂载远程工具
    const localServers = await provider({
      workspacePath: "D:/dev/local",
      agentKey: "opencode",
      agentId: "opencode",
      sessionId: null,
      agent: null,
    });
    expect(localServers).toEqual([]);

    // 远程项目挂载 HTTP MCP 并转发审批
    const disposers: (() => Promise<void>)[] = [];
    const requestPermission = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "selected", optionId: "allow-once" })
      .mockResolvedValueOnce({ outcome: "selected", optionId: "reject-once" });

    const remoteServers = await provider({
      workspacePath: remoteRecord.workspacePath,
      agentKey: "opencode",
      agentId: "opencode",
      sessionId: "sess-123",
      agent: null,
      requestPermission,
      onDispose: (fn) => disposers.push(fn),
    });

    expect(remoteServers).toEqual([
      {
        type: "http",
        name: "aaw-remote-project",
        url: "http://127.0.0.1:45678/project-mcp",
        headers: [{ name: "Authorization", value: "Bearer ptok-session-1" }],
      },
    ]);

    // 触发一次批准的 edit_file 审批
    approvalListener!({
      requestId: "pap-1",
      token: "ptok-session-1",
      projectId: "rp_iter2",
      connectionId: "conn-1",
      sessionHint: "sess-123",
      tool: "edit_file",
      summary: "修改远端文件 notes.md",
      input: { path: "notes.md", old_text: "2", new_text: "3" },
    });
    await vi.waitFor(() => {
      expect(replyApproval).toHaveBeenCalledWith("pap-1", true, "");
    });
    expect(requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "edit",
        content: [
          expect.objectContaining({
            type: "diff",
            path: "notes.md",
            oldText: "2",
            newText: "3",
          }),
        ],
      }),
      expect.any(Array),
    );

    // 触发一次拒绝的 run_command 审批
    approvalListener!({
      requestId: "pap-2",
      token: "ptok-session-1",
      projectId: "rp_iter2",
      connectionId: "conn-1",
      sessionHint: "sess-123",
      tool: "run_command",
      summary: "运行远端命令: rm -rf tmp",
      input: { command: "rm -rf tmp" },
    });
    await vi.waitFor(() => {
      expect(replyApproval).toHaveBeenCalledWith(
        "pap-2",
        false,
        "用户在会话中拒绝了该远端项目操作",
      );
    });

    // 会话销毁时解绑 MCP token
    for (const dispose of disposers) {
      await dispose();
    }
    expect(unbindSessionMcp).toHaveBeenCalledWith("ptok-session-1");
    expect(approvalListener).toBeNull();
  });
});
