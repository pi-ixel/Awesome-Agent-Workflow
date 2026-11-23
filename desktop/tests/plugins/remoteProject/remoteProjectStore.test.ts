import { describe, expect, it } from "vitest";
import { createRemoteProjectStore } from "../../../src/plugins/remoteProject/store/remoteProjectStore.ts";
import { createLogger } from "../../../src/shared/logging/logger.ts";
import {
  formatRemoteProjectPath,
  insidePath,
  isAbsolutePath,
  isRemoteProjectPath,
  parseRemoteProjectPath,
  pathKey,
} from "../../../src/shared/panelPaths.ts";
import { documentTab, readDocumentTab } from "../../../src/plugins/documents/ui/documentTabs.tsx";
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

describe("remoteProjectStore & remote path isolation", () => {
  it("同主机不同 SSH 账号添加同名目录时，projectId、路径键与文档页签完全隔离", () => {
    const storage = createMemoryStorage();
    const store = createRemoteProjectStore(storage, createLogger("test"));

    const alice = store.addProject("conn-alice", "/home/shared/app");
    const bob = store.addProject("conn-bob", "/home/shared/app");

    expect(alice.projectId).not.toBe(bob.projectId);
    expect(alice.workspacePath).not.toBe(bob.workspacePath);
    expect(isRemoteProjectPath(alice.workspacePath)).toBe(true);
    expect(isAbsolutePath(alice.workspacePath)).toBe(true);
    expect(pathKey(alice.workspacePath)).not.toBe(pathKey(bob.workspacePath));

    // 文件路径不能跨项目归属
    const aliceFile = formatRemoteProjectPath(alice.projectId, "/home/shared/app/src/Main.ts");
    const bobFile = formatRemoteProjectPath(bob.projectId, "/home/shared/app/src/Main.ts");
    expect(insidePath(alice.workspacePath, aliceFile)).toBe(true);
    expect(insidePath(alice.workspacePath, bobFile)).toBe(false);

    // Linux 大小写敏感路径保留区分
    const lowerFile = formatRemoteProjectPath(alice.projectId, "/home/shared/app/src/main.ts");
    expect(pathKey(aliceFile)).not.toBe(pathKey(lowerFile));

    // 文档页签按 projectId 隔离且通过 readDocumentTab 校验
    const tabA = documentTab(aliceFile, false, 12);
    const tabB = documentTab(bobFile, false, 12);
    expect(tabA.id).not.toBe(tabB.id);
    expect(readDocumentTab(tabA, "file")?.path).toBe(aliceFile);
    expect(parseRemoteProjectPath(aliceFile)).toEqual({
      projectId: alice.projectId,
      remotePath: "/home/shared/app/src/Main.ts",
    });

    store.dispose();
  });

  it("重启后可完整恢复远程项目记录与各连接最近目录，并支持按路径移除", () => {
    const storage = createMemoryStorage();
    const first = createRemoteProjectStore(storage, createLogger("test"));
    const created = first.addProject("conn-1", "/srv/work/repo", "repo");
    first.recordRecentDir("conn-1", "/srv/work/other");
    first.dispose();

    // 模拟重启后重新挂载 store
    const restored = createRemoteProjectStore(storage, createLogger("test"));
    expect(restored.getById(created.projectId)).toMatchObject({
      projectId: created.projectId,
      connectionId: "conn-1",
      remoteRoot: "/srv/work/repo",
      workspacePath: created.workspacePath,
    });
    expect(restored.getByPath(created.workspacePath)?.projectId).toBe(created.projectId);
    expect(restored.snapshot.getState().recentDirsByConnection["conn-1"]).toEqual([
      "/srv/work/other",
      "/srv/work/repo",
    ]);

    restored.removeProjectByPath(created.workspacePath);
    expect(restored.getById(created.projectId)).toBeNull();
    restored.dispose();
  });
});
