import type { Context } from "cordis";
import { createRoot } from "react-dom/client";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { createProjectForeground } from "../../src/plugins/project/conversation/foreground.ts";
import { createProjectSessionIndexes } from "../../src/plugins/project/sessions/sessionIndexes.ts";
import { sessionListEntries } from "../../src/plugins/project/sessions/catalog.ts";
import type { ProjectService } from "../../src/plugins/project/service.ts";
import { ProjectTree } from "../../src/plugins/project/ui/ProjectTree.tsx";
import { ProjectViewContext } from "../../src/plugins/project/ui/bindings/projectView.tsx";
import { createProjectViewNavigation } from "../../src/plugins/project/ui/bindings/workbenchNavigation.ts";
import { createProjectSidebarState } from "../../src/plugins/project/ui/sidebarState.ts";
import { createWorkspaceStore } from "../../src/plugins/project/workspace/workspaceStore.ts";
import { projectConversationPageId } from "../../src/plugins/project/workspace/pageIds.ts";
import { createWorkflowService } from "../../src/plugins/workflow/status/workflowService.ts";
import { apply as applyWorkflow } from "../../src/plugins/workflow/ui/workbench.tsx";
import { pathKey } from "../../src/shared/panelPaths.ts";
import { createGitWorkbench } from "../helpers/gitWorkbench.tsx";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function prepareWorkspaceSwitch(projectCount: number) {
  const paths = Array.from({ length: projectCount }, (_, index) => `D:/bench/project-${index}`);
  const read = new Map<string, string>();
  const storage = {
    getItem: (key: string) => read.get(key) ?? null,
    setItem: (key: string, value: string) => { read.set(key, value); },
  };
  const fixture = createGitWorkbench();
  const { Wrapper, workbench } = fixture;
  const foreground = createProjectForeground();
  foreground.view.session.setState({ agentKey: "fixture" });
  const sidebar = createProjectSidebarState(storage);
  const { store: workspace, view } = createWorkspaceStore(storage, () => true);
  const indexes = createProjectSessionIndexes(storage);
  const content = createStore(() => "");
  const requests: Record<string, number> = {};
  const history = (path: string) => {
    const index = paths.indexOf(path);
    return Array.from({ length: 14 }, (_, number) => ({
      sessionId: `${index}-${number}`,
      title: number < 2 ? `打开会话 ${index}-${number}` : `节点会话 ${index}-${number}`,
      cwd: path,
      updatedAt: "2026-11-25T08:00:00Z",
    }));
  };
  const payload = paths.map((project, i) => ({
    project,
    runs: Array.from({ length: 4 }, (_, run) => ({
      runId: `${i}-run-${run}`,
      workflowName: `流程 ${i}-${run}`,
      status: "completed",
      links: [2, 3, 4].map((member) => ({
        sessionId: `${i}-${member + run * 3}`,
        actorName: `角色 ${i}-${member + run * 3}`,
        nodes: [],
      })),
    })),
  }));
  const native = createWorkflowService({
    logger: { debug() {}, warn() {} },
    agentLaunch: () => ({ command: [], mcpServers: [] }),
    client: {
      async request<T>(method: string, params: Record<string, unknown> = {}) {
        requests[method] = (requests[method] ?? 0) + 1;
        await delay(14);
        const value = method === "session-links-others"
          ? payload.filter(({ project }) => project !== params.exclude)
          : method === "session-links"
            ? payload.find(({ project }) => project === params.cwd)?.runs ?? []
            : [];
        return value as T;
      },
      subscribe: () => () => {},
      hasActiveRuns: () => false,
      hasActiveRunsFromHost: () => Promise.resolve(false),
    },
  });

  indexes.catalog.selectCatalog("fixture", () => {});
  workspace.setState({
    pinnedPaths: paths.slice(0, 2),
    recentWorkspaces: paths.map((path, index) => ({ path, lastOpenedAt: new Date(1700000000000 - index).toISOString() })),
  });
  const refresh = (path: string, id: string | null) => {
    const owner = { workspacePath: path, agentKey: "fixture" };
    const catalog = indexes.catalog.store.getState();
    indexes.catalog.updateCatalog(
      "fixture", owner,
      sessionListEntries({ items: [], sessionsByPath: catalog.sessionsByPath }, history(path), id, owner, [], catalog),
    );
  };
  paths.forEach((path) => refresh(path, null));
  const project = {
    isActive: () => true,
    projects: { workspace: view },
    sessions: {
      catalog: indexes.catalogView,
      groups: indexes.groups.snapshot,
      registerSessionGroups: () => indexes.groups.register(),
      registerSessionTools: () => () => {},
      async openSessionFromEntry(path: string, id: string) {
        foreground.view.session.setState({ activeSessionId: id });
        workbench.navigation.getState().restoreContextView({ contextPath: path, viewId: projectConversationPageId });
        workspace.getState().openWorkspace(path);
        await delay(24);
        refresh(path, id);
        content.setState(id, true);
      },
    },
    conversation: { foreground: foreground.snapshot },
  } as unknown as ProjectService;
  const navigation = createProjectViewNavigation(workbench, project, {
    isCurrent: () => true,
    openFileTree() {},
    openInFileManager: () => Promise.resolve(),
  });
  workbench.navigation.getState().restoreContextView({ contextPath: paths[0]!, viewId: projectConversationPageId });
  const releases: (() => void)[] = [];
  applyWorkflow({
    workflow: native.service, workbench, project, host: { storage },
    effect(register: () => (() => void) | undefined) {
      const release = register();
      if (release) releases.push(release);
    },
    provide() {},
  } as unknown as Context);
  const root = document.createElement("div");
  document.getElementById("root")?.setAttribute("hidden", "");
  document.body.append(root);
  const rendered = createRoot(root);
  function Contents() {
    const current = useStore(content);
    return <article data-bench-content={current}>{current}</article>;
  }
  rendered.render(
    <Wrapper>
      <ProjectViewContext.Provider value={{ project, navigation: navigation.commands, sidebar: sidebar.snapshot, isActive: () => true }}>
        <div data-bench-tree=""><ProjectTree /></div>
        <Contents />
      </ProjectViewContext.Provider>
    </Wrapper>,
  );
  for (let i = 0; i < 50 && Object.keys(indexes.groups.snapshot.getState().byPath).length !== paths.length; i++) await delay(10);
  if (Object.keys(indexes.groups.snapshot.getState().byPath).length !== paths.length) throw new Error("工作流分组没有完成初始化");

  const tree = root.querySelector("[data-bench-tree]")!;
  const initial = tree.textContent;
  let groupDrops = 0;
  let domChanges = 0;
  const unlisten = native.service.subscribe((event) => {
    if (event.type === "runs-changed" && paths.some((path) => indexes.groups.snapshot.getState().byPath[pathKey(path)]?.length !== 4)) groupDrops++;
  });
  const observer = new MutationObserver(() => {
    if (tree.textContent !== initial) domChanges++;
  });
  observer.observe(tree, { subtree: true, childList: true, characterData: true });
  const selected: number[] = [];
  const loaded: number[] = [];
  const initialRequests = { ...requests };
  return {
    async run(offset: number, count: number) {
      for (let i = offset; i < offset + count; i++) {
        const id = `${(i + 1) % projectCount}-${i % 2}`;
        const button = Array.from(tree.querySelectorAll("button")).find((button) => button.textContent?.trim() === `打开会话 ${id}`);
        if (!button) throw new Error(`会话行不存在 ${id}`);
        await new Promise<void>((resolve, reject) => {
          const start = performance.now();
          let selectedAt: number | undefined;
          const timeout = setTimeout(() => {
            watcher.disconnect();
            reject(new Error(`切换超时 ${id}`));
          }, 3000);
          const watcher = new MutationObserver(() => {
            if (selectedAt === undefined && button.getAttribute("aria-current") === "true") selectedAt = performance.now() - start;
            if (root.querySelector(`[data-bench-content="${id}"]`)) {
              selected.push(selectedAt ?? performance.now() - start);
              loaded.push(performance.now() - start);
              clearTimeout(timeout);
              watcher.disconnect();
              resolve();
            }
          });
          watcher.observe(root, { subtree: true, attributes: true, childList: true, characterData: true });
          button.click();
        });
        await delay(48);
      }
    },
    report() {
      return {
        initialRequests,
        requests: Object.fromEntries(Object.entries(requests).map(([method, count]) => [method, count - (initialRequests[method] ?? 0)])),
        selected,
        loaded,
        groupDrops,
        domChanges,
      };
    },
    dispose() {
      observer.disconnect();
      unlisten();
      for (const release of releases.reverse()) release();
      rendered.unmount();
      root.remove();
      native.dispose();
      indexes.dispose();
      sidebar.dispose();
      navigation.dispose();
      fixture.dispose();
    },
  };
}
