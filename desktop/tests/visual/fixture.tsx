import { createRoot } from "react-dom/client";
import { PerformanceFixture } from "./performanceFixture.tsx";
import { HintTooltip } from "../../src/shared/ui/controls/HintTooltip.tsx";
import { HintMotionFixture } from "./hintMotionFixture.tsx";
import { ImageAttachments } from "../../src/plugins/project/conversation/ui/ImageAttachments.tsx";
import { MessageAttachments } from "../../src/plugins/project/conversation/ui/MessageAttachments.tsx";
import "../../src/shared/styles/index.css";
import SettingsPage from "../../src/plugins/workbench/ui/SettingsPage.tsx";
import { WorkbenchContext } from "../../src/plugins/workbench/ui/bindings/react.ts";
import type { WorkbenchService } from "../../src/plugins/workbench/service.ts";
import { createUsageSettingsEntry } from "../../src/plugins/project/usage/settingsEntry.ts";
import { bindProjectStorage } from "../../src/plugins/project/lifecycle/persistence.ts";
import type { HostManagedStorage } from "../../src/plugins/host/types.ts";
import { StorageView } from "../../src/plugins/diagnostics/ui/StorageView.tsx";
import { createStorageSettings } from "../../src/plugins/diagnostics/ui/StorageSettings.tsx";
import type { StorageRow } from "../../src/plugins/diagnostics/capture/storageRegistry.ts";
import { ResourceReport } from "../../src/plugins/diagnostics/ui/ResourceReport.tsx";
import { MarkdownAppearance } from "../../src/shared/ui/markdown/theme.ts";
import {
  MarkdownImage,
  MarkdownImageParagraph,
} from "../../src/shared/ui/markdown/MarkdownImage.tsx";
import { initializeUsage } from "../../src/plugins/project/usage/service.ts";
import {
  ProtocolFixtureActions,
  usageFixtureRequest,
} from "./protocolFixture.tsx";

const params = new URLSearchParams(location.search);
const DiagnosticsWindowFixture = params.has("diagnostics-window")
  ? (await import("./diagnosticsWindowFixture.tsx")).DiagnosticsWindowFixture
  : undefined;
if (DiagnosticsWindowFixture || params.has("appearance")) {
  const { bindSecondaryWindowAppearance } = await import("../../src/plugins/workbench/appearance/windowAppearance.ts");
  bindSecondaryWindowAppearance(document.documentElement);
}
const sessionSettings = params.has("session-settings")
  ? await (async () => {
      const { bindSecondaryWindowAppearance } = await import("../../src/plugins/workbench/appearance/windowAppearance.ts");
      const { createProjectSettings } = await import("../../src/plugins/project/ui/settings.tsx");
      const { projectPreferencesWrapper, createTestProjectPreferences } = await import("../helpers/projectPreferences.tsx");
      bindSecondaryWindowAppearance(document.documentElement);
      const entry = createProjectSettings().find((item) => item.id === "session")!;
      const Wrapper = projectPreferencesWrapper(createTestProjectPreferences());
      return {
        ...entry,
        View: ({ active }: { active: boolean }) => (
          <Wrapper><entry.View active={active} /></Wrapper>
        ),
      };
    })()
  : undefined;
if (params.get("theme") === "dark")
  document.documentElement.classList.remove("theme-warm");
const longModel =
  "very-long-model-name-for-the-narrow-window-abcdefghijklmnopqrstuvwxyz-0123456789";
const sampleTokens = params.has("scale") ? "12000000" : "15832";
const snapshot = {
  today: "2026-11-12",
  zone: "Asia/Shanghai",
  enabledAt: 0,
  workspaces: [],
  days: [["2026-11-12", sampleTokens, 0, params.has("scale") ? 100_000 : 4]],
  models: [["2026-11-12", "4c3f3678ed0e", sampleTokens, 4, longModel]],
};
bindProjectStorage({
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  managed: {
    available: () => true,
    request: (command: string, args?: Record<string, unknown>) =>
      params.has("protocol")
        ? usageFixtureRequest(command, args, {
            ...snapshot,
            days: [],
            models: [],
          })
        : Promise.resolve(snapshot),
  } as unknown as HostManagedStorage,
});

const rows = [
  {
    id: "diagnostics.logs",
    label: "诊断日志",
    bytes: 2048,
    count: 1,
    protected: 0,
    cleanable: true,
    exact: true,
  },
  {
    id: "usage.statistics",
    label: "使用统计",
    bytes: 4096,
    count: 1,
    protected: 0,
    cleanable: false,
    exact: true,
  },
];
const storageRows: StorageRow[] = params.has("storage-scroll")
  ? [
      ...rows,
      ...Array.from({ length: 24 }, (_, index) => ({
        ...rows[0]!,
        project: `D:/projects/project-${index + 1}`,
      })),
      {
        id: "storage.legacy",
        label: "迁移遗留数据",
        bytes: 232_653,
        count: 4,
        protected: 0,
        cleanable: true,
        exact: false,
      },
    ]
  : rows;
const storageRequest = () => Promise.resolve(storageRows);
const { Settings: StorageSettings } = createStorageSettings(
  { storage: storageRequest },
  () => {},
);
const usageEntry = createUsageSettingsEntry([
  { id: "chrys", displayName: "iCode" },
  { id: "codeagent", displayName: "CodeAgent" },
]);
const fixture = {
  settings: [
    ...(sessionSettings ? [sessionSettings] : []),
    ...(params.has("settings-keyboard") ? [{
      id: "general",
      label: "外观",
      Icon: () => null,
      View: () => <p>编辑外观偏好</p>,
      group: "basic",
    }] : []),
    {
      ...usageEntry,
      View: ({ active }: { active: boolean }) => (
        <>
          {params.has("protocol") && <ProtocolFixtureActions />}
          <usageEntry.View active={active} />
        </>
      ),
    },
    {
      id: "storage",
      label: "存储",
      Icon: () => null,
      View: params.has("storage-scroll")
        ? StorageSettings
        : () => <StorageView request={storageRequest} />,
    },
  ],
};
const workbench = {
  getSnapshot: () => fixture,
  subscribe: () => () => {},
} as unknown as WorkbenchService;
performance.mark("usage-fixture-mount");
if (params.has("protocol")) void initializeUsage();

function renderAttachmentFixture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 900;
  const block = {
    type: "image" as const,
    mimeType: "image/png",
    data: canvas.toDataURL("image/png").split(",")[1]!,
  };
  const mode = params.get("image-attachments");
  if (mode === "gallery") {
    canvas.width = 960;
    return (
      <MarkdownImageParagraph>
        <MarkdownImage
          alt="图一"
          src={`data:image/png;base64,${block.data}`}
          node={{ tagName: "img" }}
        />
        <MarkdownImage
          alt="图二"
          src={canvas.toDataURL("image/png")}
          node={{ tagName: "img" }}
        />
      </MarkdownImageParagraph>
    );
  }
  if (mode === "user" || mode === "agent") {
    return <MessageAttachments blocks={[block]} compact={mode === "user"} />;
  }
  return (
    <ImageAttachments
      images={[{ name: "screenshot.png", block }]}
      onRemove={() => {}}
    />
  );
}

const MarkdownPreview = params.has("markdown-toolbar")
  ? (await import("../../src/shared/ui/MarkdownView.tsx")).MarkdownView
  : null;
createRoot(document.querySelector("#root")!).render(
  <div className="h-screen bg-base p-3 text-ink">
    <HintTooltip />
    {DiagnosticsWindowFixture ? (
      <DiagnosticsWindowFixture />
    ) : params.has("image-attachments") ? (
      renderAttachmentFixture()
    ) : MarkdownPreview ? (
      <MarkdownAppearance.Provider
        value={{ theme: params.get("theme") === "dark" ? "dark" : "warm", uiFontSize: 14 }}
      >
        <MarkdownPreview
          text={
            "| 项目 | 数量 |\n| --- | --- |\n| 已完成 | 2 |\n" +
            (params.has("long-table")
              ? Array.from({ length: 50 }, (_, index) => `| 发布步骤 ${index + 1} | ${index + 1} |\n`).join("")
              : "") +
            "\n~~~mermaid\nflowchart LR\n A[草稿] --> B[完成]\n~~~"
          }
        />
      </MarkdownAppearance.Provider>
    ) : params.has("hint-motion") ? (
      <HintMotionFixture />
    ) : params.has("performance") ? (
      <PerformanceFixture />
    ) : params.has("diagnostics") ? (
      <ResourceReport resources={null} connections={[]} />
    ) : (
      <WorkbenchContext.Provider value={workbench}>
        <SettingsPage />
      </WorkbenchContext.Provider>
    )}
  </div>,
);
