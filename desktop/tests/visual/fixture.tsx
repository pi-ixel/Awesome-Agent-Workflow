import { createRoot } from "react-dom/client";
import { HintTooltip } from "../../src/shared/ui/controls/HintTooltip.tsx";
import "../../src/shared/styles/index.css";
import SettingsPage from "../../src/plugins/workbench/ui/SettingsPage.tsx";
import { WorkbenchContext } from "../../src/plugins/workbench/ui/bindings/react.ts";
import type { WorkbenchService } from "../../src/plugins/workbench/service.ts";
import { createUsageSettingsEntry } from "../../src/plugins/project/usage/settingsEntry.ts";
import { bindProjectStorage } from "../../src/plugins/project/lifecycle/persistence.ts";
import type { HostManagedStorage } from "../../src/plugins/host/types.ts";
import { StorageView } from "../../src/plugins/diagnostics/ui/StorageView.tsx";
import { ResourceReport } from "../../src/plugins/diagnostics/ui/ResourceReport.tsx";
import { initializeUsage } from "../../src/plugins/project/usage/service.ts";
import {
  ProtocolFixtureActions,
  usageFixtureRequest,
} from "./protocolFixture.tsx";

const params = new URLSearchParams(location.search);
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
const fixture = {
  settings: [
    createUsageSettingsEntry([
      { id: "chrys", displayName: "iCode" },
      { id: "codeagent", displayName: "CodeAgent" },
    ]),
    {
      id: "storage",
      label: "存储",
      Icon: () => null,
      View: () => <StorageView request={() => Promise.resolve(rows)} />,
    },
  ],
};
const workbench = {
  getSnapshot: () => fixture,
  subscribe: () => () => {},
} as unknown as WorkbenchService;
performance.mark("usage-fixture-mount");
if (params.has("protocol")) void initializeUsage();
createRoot(document.querySelector("#root")!).render(
  <div className="h-screen bg-base p-3 text-ink">
    <HintTooltip />
    {params.has("protocol") && <ProtocolFixtureActions />}
    {params.has("diagnostics") ? (
      <ResourceReport resources={null} connections={[]} />
    ) : (
      <WorkbenchContext.Provider value={workbench}>
        <SettingsPage />
      </WorkbenchContext.Provider>
    )}
  </div>,
);
