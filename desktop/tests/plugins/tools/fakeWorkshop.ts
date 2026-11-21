import { createStore } from "zustand";
import type { WorkshopService, WorkshopSnapshot } from "../../../src/plugins/tools/ui/workshop.ts";

/**
 * 面板测试用的工坊替身：面板只读快照、只调动作，不需要真实项目服务。
 * 默认是"什么都没在做"的状态，需要的话用 `overrides` 摆出正在校验/可安装。
 */
export function fakeWorkshop(overrides: Partial<WorkshopSnapshot> = {}): WorkshopService {
  const store = createStore<WorkshopSnapshot>(() => ({
    brief: "",
    project: null,
    check: null,
    note: null,
    busy: false,
    installed: false,
    drift: false,
    stalled: false,
    repairs: 0,
    running: false,
    missing: false,
    projects: [],
    projectsLoading: false,
    projectsRoot: "E:/AAW/tools/projects",
    customRoot: null,
    ...overrides,
  }));
  const idle = async () => {};
  return {
    state: store,
    setBrief: (value) => store.setState({ brief: value }),
    dismiss: () => store.setState({ project: null, check: null }),
    clearNote: () => store.setState({ note: null }),
    create: idle,
    verify: () => Promise.resolve(null),
    install: () => Promise.resolve(false),
    installArchive: (tool) => Promise.resolve({ version: tool.version, updated: false, versionChanged: false }),
    rollback: () => Promise.resolve({ text: "没有可回退的版本。" }),
    rename: () => Promise.resolve({ text: "已改名。" }),
    resume: idle,
    select: idle,
    refreshProjects: idle,
    migrateLegacy: () => Promise.resolve({ created: [], skipped: [] }),
    resolveOpenDir: (id) => Promise.resolve(id ? `E:/AAW/tools/installed/${id}` : undefined),
    purge: () => Promise.resolve({ text: "已清理。" }),
    chooseProjectsRoot: idle,
    resetProjectsRoot: () => {},
    importFromFolder: () => Promise.resolve({ text: "已导入。" }),
    dispose: () => {},
  };
}
