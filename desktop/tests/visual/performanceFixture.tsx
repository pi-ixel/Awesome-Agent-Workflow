import { createProjectForeground } from "../../src/plugins/project/conversation/foreground.ts";
import { InputStatusRight } from "../../src/plugins/project/conversation/ui/InputStatusBar.tsx";
import {
  ProjectViewContext,
  type ProjectViewBinding,
} from "../../src/plugins/project/ui/bindings/projectView.tsx";
import {
  collectPerformance,
  beginPerformance,
} from "../../src/plugins/project/conversation/sessionPerformance.ts";

const foreground = createProjectForeground();
const totals = collectPerformance([], false, 0);
foreground.view.session.setState({
  performanceTotals: {
    ...totals,
    rounds: 5,
    toolCalls: 49,
    modelMs: 727000,
    toolMs: 5800,
    measured: 5,
    responseMs: 52500,
    responses: 5,
    output: 69065,
    outputMs: 727000,
  },
  modelLabel: "hw-deepseek-v4.1-flash",
  items: [
    {
      kind: "user",
      id: "sample",
      text: "sample",
      createdAt: "",
      performance: { ...beginPerformance(0), endedAt: 1000 },
    },
  ],
});
const binding = {
  project: { projects: {}, conversation: { foreground: foreground.snapshot } },
  isActive: () => true,
} as unknown as ProjectViewBinding;

export function PerformanceFixture() {
  return (
    <ProjectViewContext.Provider value={binding}>
      <div className="flex h-full items-end justify-center pb-8">
        <div className="@container/composer w-full max-w-5xl rounded-2xl border border-line bg-surface p-3">
          <div className="h-14 text-ink-mute">
            输入消息，Enter 发送，Shift+Enter 换行
          </div>
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-warn">自动放行</span>
            <span className="flex-1" />
            <InputStatusRight />
            <button
              className="size-7 shrink-0 rounded-lg bg-raised"
              aria-label="发送"
            >
              ↑
            </button>
          </div>
        </div>
      </div>
    </ProjectViewContext.Provider>
  );
}
