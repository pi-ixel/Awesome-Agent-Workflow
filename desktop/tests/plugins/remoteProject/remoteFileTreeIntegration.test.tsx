import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDocumentFileHost } from "../../../src/plugins/host/filesystem/documentFiles.ts";
import { createDocuments } from "../../../src/plugins/documents/files/documents.ts";
import { createRemoteDocumentFileProvider } from "../../../src/plugins/remoteProject/fs/remoteFileProvider.ts";
import { createRemoteProjectStore } from "../../../src/plugins/remoteProject/store/remoteProjectStore.ts";
import { FileTree } from "../../../src/plugins/documents/ui/FileTree.tsx";
import { createLogger } from "../../../src/shared/logging/logger.ts";
import type { HostStorage } from "../../../src/plugins/host/types.ts";

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
  it("远程项目接入 FileTree 与 FilePreview 后可浏览目录、预览文本，且同主机双账号同名目录内容互不串扰", async () => {
    const storage = createMemoryStorage();
    const store = createRemoteProjectStore(storage, createLogger("test"));
    const alice = store.addProject("conn-alice", "/srv/shared-app", "shared-app");
    const bob = store.addProject("conn-bob", "/srv/shared-app", "shared-app");

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
              name: connectionId === "conn-alice" ? "alice-only.ts" : "bob-only.ts",
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
    expect(screen.queryByRole("menuitem", { name: /资源管理器|访达|文件管理器/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "复制绝对路径" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("/srv/shared-app/alice-only.ts");
    });

    // 文件树顶栏更多菜单：远程项目隐藏「在资源管理器中打开」，复制路径输出真实远端根目录
    const moreButtons = screen.getAllByRole("button", { name: "更多" });
    fireEvent.click(moreButtons[moreButtons.length - 1]!);
    expect(screen.queryByRole("menuitem", { name: /资源管理器|访达|文件管理器/ })).toBeNull();
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
