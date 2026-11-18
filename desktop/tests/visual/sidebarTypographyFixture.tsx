import { createRoot } from "react-dom/client";
import { TaskSidebar } from "../../src/plugins/scheduledTasks/ui/TaskViews.tsx";
import { createScheduler } from "../../src/plugins/scheduledTasks/scheduler/state.ts";
import { SidebarItemTitle } from "../../src/shared/ui/SidebarItemTitle.tsx";
import "../../src/shared/styles/index.css";

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
    ],
    runs: [],
  }),
  write: () => Promise.resolve(),
  eligible: () => false,
  run: () => Promise.resolve(),
  notify: () => {},
});

createRoot(document.getElementById("root")!).render(
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
