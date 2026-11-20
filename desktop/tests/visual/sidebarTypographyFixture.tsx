import { createRoot } from "react-dom/client";
import { createStore } from "zustand";
import type { AgentsService } from "../../src/plugins/agents/service.ts";
import type { ProjectService } from "../../src/plugins/project/service.ts";
import { emptyWorkspace } from "../../src/plugins/project/workspace/types.ts";
import { bindSecondaryWindowAppearance } from "../../src/plugins/workbench/appearance/windowAppearance.ts";
import {
  TaskSidebar,
  TaskWorkspace,
} from "../../src/plugins/scheduledTasks/ui/TaskViews.tsx";
import { createScheduler } from "../../src/plugins/scheduledTasks/scheduler/state.ts";
import { SidebarItemTitle } from "../../src/shared/ui/SidebarItemTitle.tsx";
import "../../src/shared/styles/index.css";

const params = new URLSearchParams(location.search);
const collections = params.has("collections");
const taskEditor = params.has("task-editor");
if (collections || taskEditor)
  bindSecondaryWindowAppearance(document.documentElement);

const scheduler = createScheduler({
  read: () => ({
    tasks: [
      {
        id: "task",
        name: "说你好 AAW",
        prompt: "说你好",
        project: "D:/test",
        agent: "chrys",
        enabled: true,
        deleted: false,
        cursor: Date.now(),
        notifications: "off",
        schedule: { kind: "daily", time: "09:00", timeZone: "local" },
      },
      ...(collections || taskEditor
        ? [
            {
              id: "release",
              name: "校验发布产物和回滚预案",
              prompt: "核对发布产物并记录回滚预案",
              project: "D:/release",
              agent: "chrys",
              enabled: false,
              deleted: false,
              cursor: Date.now(),
              notifications: "off" as const,
              schedule: {
                kind: "weekly" as const,
                time: "09:00",
                timeZone: "local",
                weekdays: [1],
              },
            },
          ]
        : []),
    ],
    runs: [],
  }),
  write: () => Promise.resolve(),
  eligible: () => false,
  run: () => Promise.resolve(),
  notify: () => {},
});

const root = createRoot(document.getElementById("root")!);
if (taskEditor) {
  scheduler.store.setState({ selected: "release", editing: "release" });
  const project = {
    projects: {
      workspace: createStore(() => ({
        ...emptyWorkspace,
        activePath: "D:/release",
      })),
    },
    sessions: {
      backgroundPromptOptions: () =>
        Promise.resolve({ models: [], efforts: [] }),
    },
  } as unknown as ProjectService;
  const agents = {
    selectedId: "chrys",
    resolve: () => undefined,
  } as unknown as AgentsService;
  root.render(
    <main className="min-h-screen bg-surface text-ink">
      <TaskWorkspace
        scheduler={scheduler}
        project={project}
        agents={agents}
        openRun={() => Promise.resolve()}
      />
    </main>,
  );
} else if (collections) {
  const { createSkillsCollection } =
    await import("./skillsCollectionFixture.tsx");
  const SkillsCollection = await createSkillsCollection();
  root.render(
    <main className="min-h-screen min-w-0 bg-sidebar text-ink">
      <TaskSidebar scheduler={scheduler} />
      <SkillsCollection />
    </main>,
  );
} else
  root.render(
    <main className="flex bg-sidebar text-ink">
      <section aria-label="会话标题" className="w-64">
        <button
          type="button"
          className="flex min-h-8 w-full items-center py-1 pl-2.5 text-left"
        >
          <SidebarItemTitle>说你好 AAW</SidebarItemTitle>
        </button>
      </section>
      <div className="w-64">
        <TaskSidebar scheduler={scheduler} />
      </div>
    </main>,
  );
