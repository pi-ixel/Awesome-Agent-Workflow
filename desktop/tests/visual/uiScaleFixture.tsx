import { createRoot } from "react-dom/client";
import { Disclosure } from "../../src/shared/ui/Disclosure.tsx";
import { BrandLoading } from "../../src/shared/ui/BrandLoading.tsx";
import { useEffect, useState, useSyncExternalStore } from "react";
import { MarkdownAppearance } from "../../src/shared/ui/markdown/theme.ts";
import { observeAppearance } from "../../src/shared/ui/observeAppearance.ts";
import { FileDisplayIcon } from "../../src/shared/ui/file-icons/fileDisplay.tsx";
import { ICON_VARIANTS } from "../../src/shared/ui/file-icons/fileDisplayHelpers.ts";
import { embeddedFieldClass, fieldSurfaceClass, settingsInputClass, settingsNumberInputClass, settingsTextareaClass } from "../../src/shared/ui/inputStyles.ts";
import { SelectionFixture } from "./selectionFixture.tsx";
import { FileTreeRow } from "../../src/plugins/documents/ui/file-tree/FileTreeRow.tsx";
import {
  bindWorkbenchAppearance,
  createWorkbenchAppearance,
} from "../../src/plugins/workbench/appearance/appearance.ts";
import {
  bindSecondaryWindowAppearance,
  publishWorkbenchAppearance,
} from "../../src/plugins/workbench/appearance/windowAppearance.ts";
import type { WorkbenchService } from "../../src/plugins/workbench/service.ts";
import { WorkbenchContext } from "../../src/plugins/workbench/ui/bindings/react.ts";
import { workbenchSettings } from "../../src/plugins/workbench/ui/settingsContributions.tsx";
import { EmptyState } from "../../src/shared/ui/EmptyState.tsx";
import { ActionButton, Checkbox, rowSelectedClass } from "../../src/shared/ui/controls.tsx";
import { CopyButton } from "../../src/shared/ui/CopyButton.tsx";
import { IconButton } from "../../src/shared/ui/IconButton.tsx";
import { NavigationRow } from "../../src/shared/ui/NavigationRow.tsx";
import { RefreshButton } from "../../src/shared/ui/controls/RefreshButton.tsx";
import { SettingsIcon } from "../../src/shared/ui/icons.tsx";
import { SettingRow } from "../../src/shared/ui/SettingsPageParts.tsx";
import "../../src/shared/styles/index.css";

const appearance = createWorkbenchAppearance({
  read: () => null,
  update: () => {},
  subscribe: () => () => {},
  dispose: () => {},
});
const secondary = new URLSearchParams(location.search).has("secondary");
if (secondary) {
  bindSecondaryWindowAppearance(document.documentElement);
} else {
  bindWorkbenchAppearance(document.documentElement, appearance);
  publishWorkbenchAppearance(appearance);
}

const snapshot = {
  about: new URLSearchParams(location.search).has("setting-rows")
    ? [{ id: "sample-version", label: "构建版本", Value: () => <span>{"0123456789abcdef".repeat(5)}</span> }]
    : [],
};
const workbench = {
  appearance,
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
} as unknown as WorkbenchService;
const { View: GeneralSettings } = workbenchSettings.find(
  (entry) => entry.id === "general",
)!;
const terminalParams = new URLSearchParams(location.search);
const terminalFixtures = terminalParams.has("terminal") || terminalParams.has("terminal-dock")
  ? await import("./terminalAppearanceFixture.tsx")
  : null;
const TerminalFixture = terminalParams.has("terminal-dock")
  ? terminalFixtures?.TerminalDockFixture
  : terminalFixtures?.TerminalAppearanceFixture;
const BrowserFixture = terminalParams.has("browser-appearance")
  ? (await import("./browserAppearanceFixture.tsx")).BrowserAppearanceFixture
  : null;
const UpdateButtonFixture = terminalParams.has("update-button")
  ? (await import("./updateButtonFixture.tsx")).UpdateButtonFixture
  : null;
const AnnotationSummaryFixture = terminalParams.has("annotation-summary")
  ? (await import("./annotationSummaryFixture.tsx")).AnnotationSummaryFixture
  : null;
const FeedbackFixture = terminalParams.has("feedback-controls")
  ? (await import("./feedbackFixture.tsx")).FeedbackFixture
  : null;
const StatusFixture = terminalParams.has("status-controls")
  ? (await import("./statusFixture.tsx")).StatusFixture
  : null;
const linkSample = new URLSearchParams(location.search).has("links");
const isUnifiedDiff = terminalParams.has("git-unified");
const GitNavigationFixture = terminalParams.has("git-navigation") || isUnifiedDiff
  ? (await import("./gitNavigationFixture.tsx")).GitNavigationFixture
  : null;
const MarkdownView = (linkSample || new URLSearchParams(location.search).has("markdown"))
  ? (await import("../../src/shared/ui/MarkdownView.tsx")).MarkdownView
  : null;

function reportSampleFile(path: string) {
  document.documentElement.dataset.openedFile = path;
}
function reportSampleLink(url: string) {
  document.documentElement.dataset.openedUrl = url;
  return Promise.resolve();
}

async function refreshSample() {
  const response = await fetch("/tests/visual/uiScaleFixture.html?sample-refresh");
  if (!response.ok) throw new Error("读取失败，请重试");
}
function readSecondaryMarkdownAppearance() {
  const root = document.documentElement;
  return {
    theme: root.classList.contains("theme-warm") ? ("warm" as const) : ("dark" as const),
    uiFontSize: Number.parseFloat(root.style.getPropertyValue("--ui-font-size")) || 14,
  };
}

function MarkdownSample() {
  const preferences = useSyncExternalStore(listener => appearance.subscribe(listener), appearance.getSnapshot);
  const [mirrored, setMirrored] = useState(readSecondaryMarkdownAppearance);
  useEffect(() => {
    if (!secondary) return;
    const sync = () => setMirrored(readSecondaryMarkdownAppearance());
    sync();
    return observeAppearance(document.documentElement, sync);
  }, []);
  return MarkdownView && (
    <MarkdownAppearance value={secondary ? mirrored : preferences}>
      {linkSample ? (
        <MarkdownView fileRoot="/project" onOpenFile={reportSampleFile} onOpenExternal={reportSampleLink}
          replyFiles={{
            root: "/project",
            verify: (_root, path) => Promise.resolve(path === "/project/README.md" ? { path, kind: "file" } : null),
            open: reportSampleFile,
          }}
          text={"[项目说明](./README.md) 与 [外部文档](https://example.org/guide)，或打开 `D:\\outside\\sample.html`。"} />
      ) : <MarkdownView text={"~~~mermaid\nflowchart LR\n Draft[草稿] --> Done[完成]\n~~~"} />}
    </MarkdownAppearance>
  );
}

createRoot(document.querySelector("#root")!).render(
  <WorkbenchContext.Provider value={workbench}>
    <main className="@container/settings grid max-w-2xl gap-2 p-4">
      {!secondary && <GeneralSettings active />}
      {terminalParams.has("brand-mark") && <BrandLoading hint="正在打开工作区" />}
      {new URLSearchParams(location.search).has("actions") && (
        <section aria-label="命令按钮" className="grid grid-cols-2 gap-2 bg-surface p-4">
          {(["primary", "secondary", "ghost", "danger", "danger-solid", "media"] as const).map(tone => (
            <div key={tone} data-testid={tone + "-surface"}
              className={`flex flex-wrap gap-2 p-1 ${tone === "media" ? "bg-overlay-shade" : "bg-surface"}`}>
              <ActionButton tone={tone} size="compact">{tone}</ActionButton>
              <ActionButton tone={tone} size="compact" disabled>{tone} 禁用</ActionButton>
            </div>
          ))}
        </section>
      )}
      {terminalParams.has("command-feedback") && (
        <section aria-label="命令状态" className="grid min-w-0 gap-3 bg-surface p-3 text-ink">
          {(["default", "toolbar"] as const).map(appearance => (
            <div key={appearance} role="group" aria-label={appearance} className="flex flex-wrap items-center gap-2 py-1">
              {(["compact", "standard", "dialog", "rail", "large", "floating"] as const).map(size => (
                <IconButton key={size} aria-label={size} iconSize={size} appearance={appearance}>
                  <SettingsIcon />
                </IconButton>
              ))}
              <IconButton aria-label="禁用" appearance={appearance} disabled><SettingsIcon /></IconButton>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <RefreshButton label="刷新列表" onRefresh={refreshSample} showLabel />
            <CopyButton label="复制发布说明" getText={() => "发布前检查通过"} />
            <CopyButton label="复制版本" getText={() => "0.1.52"} iconOnly />
          </div>
        </section>
      )}
      {TerminalFixture && <TerminalFixture />}
      {BrowserFixture && <BrowserFixture />}
      {UpdateButtonFixture && <UpdateButtonFixture />}
      {AnnotationSummaryFixture && <AnnotationSummaryFixture />}
      {FeedbackFixture && <FeedbackFixture />}
      {StatusFixture && <StatusFixture />}
      {MarkdownView && <MarkdownSample />}
      {GitNavigationFixture && <GitNavigationFixture unified={isUnifiedDiff} />}
      {new URLSearchParams(location.search).has("navigation-rows") && (
        <section aria-label="共享导航行" className="grid gap-2 bg-surface p-2 text-ink">
          {(["list", "tree", "choice", "compound", "launcher"] as const).map((layout) => (
            <div key={layout} data-testid={layout} className="grid min-w-0">
              {(["默认", "选中", "禁用"] as const).map((state) => {
                const isSelected = state === "选中";
                const row = (
                  <NavigationRow
                    key={state}
                    layout={layout}
                    aria-current={isSelected ? "location" : undefined}
                    disabled={state === "禁用"}
                    className={layout === "compound" ? "min-h-8 items-center gap-2 px-2 text-ui-sm" : ""}
                  >
                    <SettingsIcon className="ui-icon-16 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate">{state}</span>
                  </NavigationRow>
                );
                return layout === "compound" ? (
                  <div key={state} className={`flex rounded-md ${isSelected ? rowSelectedClass : "has-[:enabled:hover]:bg-surface-hover"}`}>
                    {row}
                  </div>
                ) : row;
              })}
            </div>
          ))}
        </section>
      )}
      {new URLSearchParams(location.search).has("syntax") && (
        <pre aria-label="代码高亮" className="overflow-auto rounded-md bg-surface p-3 text-ui-base">
          <code className="hljs"><span className="hljs-comment">// 读取工作区配置</span>{"\n"}
            <span className="hljs-keyword">const</span>{" "}
            <span className="hljs-title">settings</span>{" = "}
            <span className="hljs-built_in">load</span>{"("}<span className="hljs-string">"desktop"</span>{");"}
          </code>
        </pre>
      )}
      {new URLSearchParams(location.search).has("disclosure") && (
        <Disclosure layout="row" summary="更新记录">
          <Disclosure summary="版本详情">已安装版本的更新说明</Disclosure>
        </Disclosure>
      )}
      {new URLSearchParams(location.search).has("file-icons") && (
        <section aria-label="文件图标" className="grid grid-cols-4 gap-1 bg-surface p-3">
          {Object.keys(ICON_VARIANTS).map(name => (
            <div key={name} className="flex items-center gap-1 text-ui-sm">
              <FileDisplayIcon name={name} className="ui-icon-16" />{name}
            </div>
          ))}
        </section>
      )}
      {new URLSearchParams(location.search).has("fields") && (
        <section aria-label="编辑输入" className="grid gap-2 bg-surface p-3">
          <input aria-label="普通文本" className={settingsInputClass} defaultValue="草稿" />
          <input aria-label="数值" type="number" className={settingsNumberInputClass} defaultValue="12" />
          <textarea aria-label="多行文本" className={settingsTextareaClass} defaultValue="第一行" />
          <input aria-label="内嵌查找" className={embeddedFieldClass} defaultValue="词条" />
          <input aria-label="行内标题" className={`${fieldSurfaceClass} text-ui-base`} defaultValue="标题" />
          <input aria-label="只读值" className={settingsInputClass} value="可复制" readOnly />
          <input aria-label="禁用值" className={settingsInputClass} disabled />
          <input aria-label="禁用阈值" type="number" className={settingsNumberInputClass} disabled />
          <input aria-label="正在保存标题" className={`${fieldSurfaceClass} text-ui-base`} value="保留标题" readOnly />
          <input aria-label="重命名错误" className={`${fieldSurfaceClass} text-ui-base`} aria-invalid="true" />
        </section>
      )}
      {new URLSearchParams(location.search).has("selection") && (
        <SelectionFixture showLongList={new URLSearchParams(location.search).has("long-options")} />
      )}
      {snapshot.about.length > 0 && (
        <SettingRow density="compact" htmlFor="sample-date" label="日期">
          <input id="sample-date" type="date" className="max-w-full" />
        </SettingRow>
      )}
      <div className="flex justify-start">
        <RefreshButton
          className="inline-flex min-h-5 min-w-5 items-center justify-center"
          iconClassName="ui-icon-16"
          label="刷新文件"
          onRefresh={async () => {}}
        />
      </div>
      <FileTreeRow
        layout="static"
        row={{
          type: "file",
          path: "/root/sample.ts",
          key: "/root/sample.ts",
          name: "sample.ts",
          depth: 0,
          expanded: false,
          loaded: true,
          loading: false,
          error: null,
        }}
        selected={false}
        gitStatus={null}
        directoryGitStatuses={[]}
        root="/root"
        relativePath="sample.ts"
        handlers={{
          onSelect: () => {},
          onToggleDirectory: () => {},
          onOpenFile: () => {},
          onOpenContextMenu: () => {},
        }}
      />
      <EmptyState icon={<SettingsIcon />} title="暂无文件" />
      <div data-testid="checkbox" className="flex">
        <Checkbox label="测试复选框" checked onChange={() => {}} />
      </div>
    </main>
  </WorkbenchContext.Provider>,
);
