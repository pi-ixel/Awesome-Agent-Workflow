import { describe, expect, it, vi } from "vitest";
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
import {
  documentTab,
  readDocumentTab,
} from "../../../src/plugins/documents/ui/documentTabs.tsx";
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
  it("按原 ID 修复整个目录组，校验或确认写盘失败时不发布部分记录", async () => {
    const disk = createMemoryStorage();
    const confirm = vi.fn((key: string, value: string) => Promise.resolve(disk.setItem(key, value)));
    const storage = { ...disk, setConfigurationItem: confirm };
    const store = createRemoteProjectStore(storage, createLogger("test"));
    const primary = formatRemoteProjectPath("rp_main", "/srv/app");
    const child = formatRemoteProjectPath("rp_library", "/srv/library");
    const check = vi.fn((root: string) => root === "/srv/library"
      ? Promise.reject(new Error("关联目录不可访问")) : Promise.resolve());
    await expect(store.repairProjectGroup(primary, "ssh", [child], check)).rejects.toThrow("关联目录不可访问");
    expect(confirm).not.toHaveBeenCalled();
    expect(store.snapshot.getState().records).toEqual([]);
    const accessible = () => Promise.resolve();
    confirm.mockRejectedValueOnce(new Error("写盘失败"));
    await expect(store.repairProjectGroup(primary, "ssh", [child], accessible)).rejects.toThrow("写盘失败");
    expect(store.snapshot.getState().records).toEqual([]);
    await store.repairProjectGroup(primary, "ssh", [child], accessible);
    store.dispose();

    const reopened = createRemoteProjectStore(storage, createLogger("test"));
    const mainRecord = reopened.getByPath(primary);
    expect(mainRecord).toMatchObject({ projectId: "rp_main", agentCwd: "remote-projects/rp_main" });
    expect(reopened.getByPath(child)).toMatchObject({ projectId: "rp_library", connectionId: "ssh", associationOnly: true });
    await reopened.removeProjectByPath(child);
    await expect(reopened.repairProjectGroup(primary, "another-ssh", [child], accessible)).rejects.toThrow("已绑定的 SSH 连接");
    await reopened.repairProjectGroup(primary, "ssh", [child], accessible);
    expect(reopened.getByPath(primary)).toBe(mainRecord);
    expect(reopened.getByPath(child)?.workspacePath).toBe(child);
    reopened.dispose();
  });

  it("同主机不同 SSH 账号添加同名目录时，projectId、路径键与文档页签完全隔离", async () => {
    const storage = createMemoryStorage();
    const store = createRemoteProjectStore(storage, createLogger("test"));

    const [alice, bob] = await Promise.all([
      store.addProject("conn-alice", "/home/shared/app"),
      store.addProject("conn-bob", "/home/shared/app"),
    ]);

    expect(alice.projectId).not.toBe(bob.projectId);
    expect(alice.workspacePath).not.toBe(bob.workspacePath);
    expect(isRemoteProjectPath(alice.workspacePath)).toBe(true);
    expect(isAbsolutePath(alice.workspacePath)).toBe(true);
    expect(pathKey(alice.workspacePath)).not.toBe(pathKey(bob.workspacePath));

    // 文件路径不能跨项目归属
    const aliceFile = formatRemoteProjectPath(
      alice.projectId,
      "/home/shared/app/src/Main.ts",
    );
    const bobFile = formatRemoteProjectPath(
      bob.projectId,
      "/home/shared/app/src/Main.ts",
    );
    expect(insidePath(alice.workspacePath, aliceFile)).toBe(true);
    expect(insidePath(alice.workspacePath, bobFile)).toBe(false);

    // Linux 大小写敏感路径保留区分
    const lowerFile = formatRemoteProjectPath(
      alice.projectId,
      "/home/shared/app/src/main.ts",
    );
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

  it("同组远端目录一次确认持久化，失败时不发布半个项目", async () => {
    const storage = createMemoryStorage();
    const confirmed = vi.fn((key: string, value: string) =>
      Promise.resolve(storage.setItem(key, value)),
    );
    confirmed.mockRejectedValueOnce(new Error("写盘失败"));
    const first = createRemoteProjectStore(
      { ...storage, setConfigurationItem: confirmed },
      createLogger("test"),
    );
    const save = () =>
      first.saveProjectGroup("conn-1", "/srv/project", "项目", [
        "/srv/library",
        "/srv/library/",
      ]);
    await expect(save()).rejects.toThrow("写盘失败");
    expect(first.snapshot.getState().records).toEqual([]);
    const saved = await save();
    expect(confirmed).toHaveBeenCalledTimes(2);
    expect(saved.relatedPaths).toHaveLength(1);
    first.dispose();

    const restored = createRemoteProjectStore(storage, createLogger("test"));
    expect(restored.listProjectsForConnection("conn-1")).toEqual([
      saved.record,
    ]);
    const childPath = saved.relatedPaths[0]!;
    expect(restored.getByPath(childPath)?.associationOnly).toBe(true);
    expect(
      (await restored.addProject("conn-1", "/srv/library")).workspacePath,
    ).toBe(childPath);
    await restored.removeProjectByPath(childPath, true);
    expect(restored.getByPath(childPath)?.associationOnly).toBe(true);
    await restored.removeConnectionMetadata("conn-1");
    expect(restored.getByPath(childPath)).toBeNull();
    expect(restored.getByPath(saved.record.workspacePath)).toEqual(
      saved.record,
    );
    restored.dispose();
  });

  it("重启后可完整恢复远程项目记录与各连接最近目录，并支持按路径移除", async () => {
    const storage = createMemoryStorage();
    const first = createRemoteProjectStore(storage, createLogger("test"));
    const created = await first.addProject("conn-1", "/srv/work/repo", "repo");
    await first.recordRecentDir("conn-1", "/srv/work/other");
    first.dispose();

    // 模拟重启后重新挂载 store
    const restored = createRemoteProjectStore(storage, createLogger("test"));
    expect(restored.getById(created.projectId)).toMatchObject({
      projectId: created.projectId,
      connectionId: "conn-1",
      remoteRoot: "/srv/work/repo",
      workspacePath: created.workspacePath,
    });
    expect(restored.getByPath(created.workspacePath)?.projectId).toBe(
      created.projectId,
    );
    expect(
      restored.snapshot.getState().recentDirsByConnection["conn-1"],
    ).toEqual(["/srv/work/other", "/srv/work/repo"]);

    await restored.removeProjectByPath(created.workspacePath);
    expect(restored.getById(created.projectId)).toBeNull();
    restored.dispose();
  });

  it("绑定落盘失败时不发布项目，下次写入也不会带上失败记录", async () => {
    const disk = createMemoryStorage();
    const storage = {
      ...disk,
      setConfigurationItem: vi
        .fn<(key: string, value: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("写入失败"))
        .mockImplementation((key, value) => {
          disk.setItem(key, value);
          return Promise.resolve();
        }),
    };
    const store = createRemoteProjectStore(storage, createLogger("test"));
    const rejected = store.addProject("conn-1", "/failed");
    const added = store.addProject("conn-1", "/saved");
    await expect(rejected).rejects.toThrow("写入失败");
    const saved = await added;
    const reopened = createRemoteProjectStore(storage, createLogger("test"));
    expect(reopened.snapshot.getState().records).toEqual([saved]);
    expect(store.snapshot.getState().records).toEqual([saved]);
  });

  it("修复保留工作区和 ACP 工作目录 ID，并且重启后可用", async () => {
    const storage = createMemoryStorage();
    const path = formatRemoteProjectPath("rp_original", "/srv/repo");
    const store = createRemoteProjectStore(storage, createLogger("test"));
    await expect(
      store.addProject("conn-1", "/other", undefined, path),
    ).rejects.toThrow("无效");
    const restored = await store.addProject(
      "conn-1",
      "/srv/repo",
      undefined,
      path,
    );
    expect(restored).toMatchObject({
      projectId: "rp_original",
      workspacePath: path,
      agentCwd: "remote-projects/rp_original",
    });
    await expect(
      store.addProject("conn-other", "/srv/repo", undefined, path),
    ).rejects.toThrow("已恢复");
    const reopened = createRemoteProjectStore(storage, createLogger("test"));
    expect(reopened.getByPath(path)).toEqual(restored);
  });
});
