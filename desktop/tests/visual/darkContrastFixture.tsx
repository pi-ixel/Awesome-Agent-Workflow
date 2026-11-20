import { createRoot } from "react-dom/client";
import {
  btnPrimary,
  btnSecondary,
  Listbox,
} from "../../src/shared/ui/controls.tsx";
import {
  settingsInputClass,
  SettingCard,
  SettingRow,
} from "../../src/shared/ui/SettingsPageParts.tsx";
import { NewTaskButtonGroup } from "../../src/plugins/project/ui/NewTaskButtonGroup.tsx";
import { MemoryChart } from "../../src/plugins/diagnostics/ui/perf/MemoryChart.tsx";
import { GitReviewDiff } from "../../src/plugins/git/ui/GitReviewDiff.tsx";
import "../../src/shared/styles/index.css";
if (new URLSearchParams(location.search).has("warm"))
  document.documentElement.classList.add("theme-warm");
const model = {
  rows: [
    { kind: "del" as const, text: "-old", old: 1, next: null },
    { kind: "add" as const, text: "+target", old: null, next: 1 },
  ],
  full: false,
};
createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-base p-4 text-ink">
    <div className="bg-surface p-4" data-testid="surface">
      <div
        className="border border-line bg-surface"
        data-testid="control-border-reference"
      >
        控件边框
      </div>
      <NewTaskButtonGroup />
      <SettingCard label="设置">
        <SettingRow label="描述" desc="次要说明">
          <input
            aria-label="输入"
            className={settingsInputClass}
            placeholder="输入内容"
          />
        </SettingRow>
      </SettingCard>
      <button className={btnPrimary}>主按钮</button>
      <button className="bg-danger-solid text-danger-solid-ink hover:bg-danger-solid-hover">
        危险操作
      </button>
      <button className={btnSecondary}>普通按钮</button>
      <button disabled className={btnSecondary}>
        不可用按钮
      </button>
      <button className="rounded border border-line bg-surface text-ink">
        本地边框按钮
      </button>
      <Listbox
        label="选项"
        value="one"
        options={[{ value: "one", label: "选项一" }]}
        onChange={() => {}}
      />
      <span className="text-ink-mute" data-testid="muted">
        次要内容
      </span>
      <span className="text-ink-faint" data-testid="faint">
        辅助内容
      </span>
      <span className="text-danger-ink bg-danger-bg" data-testid="danger">
        危险
      </span>
      <span className="text-ok-ink bg-ok-bg" data-testid="success">
        成功
      </span>
      <span className="text-info-ink bg-info-bg" data-testid="info">
        信息
      </span>
      <span className="text-warn-ink bg-warn-bg" data-testid="warning">
        警告内容
      </span>
      <MemoryChart
        samples={[
          { at: 0, bytes: 1024 },
          { at: 60000, bytes: 2048 },
        ]}
      />
      <GitReviewDiff
        model={model}
        query="target"
        match={{ key: "x", row: 1, start: 0, length: 6, side: "next" }}
      />
      <pre>
        <code className="hljs">
          <span className="hljs-section">标题</span>
          <span className="hljs-comment">注释</span>
        </code>
      </pre>
    </div>
  </main>,
);
