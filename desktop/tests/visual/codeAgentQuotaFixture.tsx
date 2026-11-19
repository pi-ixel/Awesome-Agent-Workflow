import type { Context } from "cordis";
import { createRoot } from "react-dom/client";
import { createStore, useStore } from "zustand";
import { apply } from "../../src/plugins/agents/enhancements/codeagent/credit/index.tsx";
import type {
  CodeAgentCreditResult,
  CodeAgentTokenResult,
} from "../../src/plugins/host/types.ts";
import SettingsPage from "../../src/plugins/workbench/ui/SettingsPage.tsx";
import { WorkbenchContext } from "../../src/plugins/workbench/ui/bindings/react.ts";
import type { WorkbenchService } from "../../src/plugins/workbench/service.ts";
import { createUsageSettingsEntry } from "../../src/plugins/project/usage/settingsEntry.ts";
import { ActivityRail } from "../../src/plugins/workbench/ui/ActivityRail.tsx";
import type { WorkbenchContributions } from "../../src/plugins/workbench/types.ts";
import { MessageCircleIcon } from "../../src/shared/ui/icons.tsx";
import "../../src/shared/styles/index.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle(
  "theme-warm",
  params.get("theme") !== "dark",
);
const configuration = createStore(() => ({ activeAgentId: "codeagent" }));
const views = createStore(() => ({
  rail: null as WorkbenchContributions["activityRailActions"] | null,
  settings: null as WorkbenchContributions["settings"] | null,
  isSettingsOpen: false,
}));
const navigation = createStore(() => ({ settingsInitialTab: "general" }));
const calls = {
  credit: 0,
  token: [] as (string | undefined)[],
  isTokenStale: false,
};
declare global {
  interface Window {
    quotaFixture: typeof calls;
  }
}
window.quotaFixture = calls;
const models = [
  { value: "GLM-5.3-CodeAgent", label: "GLM-5.3-CodeAgent" },
  { value: "deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash" },
];
apply({
  agents: { configuration },
  host: {
    readCodeAgentCredit: (): Promise<CodeAgentCreditResult> => {
      calls.credit++;
      return Promise.resolve({
        status: "ready",
        snapshot: {
          fetchedAt: Date.now(),
          rows: [
            {
              kind: "CPM",
              used: Number(params.get("used") ?? 42) * 4000,
              total: 400000,
              resetAt: null,
              message: null,
            },
            {
              kind: "CPD_Peak",
              used: 157.45,
              total: 20000,
              resetAt: null,
              message: null,
            },
            {
              kind: "CPD_Valley",
              used: 75.78,
              total: 20000,
              resetAt: null,
              message: null,
            },
          ],
        },
      });
    },
    readCodeAgentTokenQuota: (
      selected?: string,
    ): Promise<CodeAgentTokenResult> => {
      calls.token.push(selected);
      const modelId = selected ?? models[0]!.value;
      return Promise.resolve({
        status: calls.isTokenStale ? "stale" : "ready",
        snapshot: {
          fetchedAt: Date.now(),
          models,
          modelId,
          rows: [
            {
              kind: "TPM",
              used: 236571,
              total: modelId === models[0]!.value ? 1200000 : 2000000,
              resetAt: null,
              message: null,
            },
            {
              kind: "TPH",
              used: 453761,
              total: 200000000,
              resetAt: null,
              message: null,
            },
            {
              kind: "TPD",
              used: 3630932,
              total: modelId === models[0]!.value ? 400000000 : 600000000,
              resetAt: null,
              message: null,
            },
          ],
        },
      });
    },
  },
  workbench: {
    register: (
      slot: string,
      entry:
        | WorkbenchContributions["settings"]
        | WorkbenchContributions["activityRailActions"],
    ) => {
      if (slot === "settings" && "label" in entry)
        views.setState({ settings: entry });
      if (slot === "activityRailActions" && !("label" in entry))
        views.setState({ rail: entry });
      return () => {};
    },
    navigation: {
      getState: () => ({
        openSettingsTab: (tab: string) => {
          navigation.setState({ settingsInitialTab: tab });
          views.setState({ isSettingsOpen: true });
        },
      }),
    },
  },
  effect: (effect: () => () => void) => {
    effect();
  },
} as unknown as Context);

const snapshot = {
  settings: [createUsageSettingsEntry([]), views.getState().settings!],
};
const settingsWorkbench = {
  navigation,
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
} as unknown as WorkbenchService;

export function Fixture() {
  const rail = useStore(views, (state) => state.rail);
  const isSettingsOpen = useStore(views, (state) => state.isSettingsOpen);
  const Rail = rail?.View;
  return (
    <main className="grid h-dvh grid-cols-[48px_1fr] bg-base text-ink">
      <ActivityRail
        entries={[
          {
            id: "sessions",
            label: "会话",
            Icon: MessageCircleIcon,
            View: () => null,
          },
        ]}
        expanded={false}
        actions={Rail && <Rail />}
        account={
          <span className="grid size-6 place-items-center rounded-full bg-hover text-ui-caption text-ink-mute">
            YS
          </span>
        }
      />
      <section className="min-w-0 p-6">
        {isSettingsOpen ? (
          <WorkbenchContext.Provider value={settingsWorkbench}>
            <SettingsPage />
          </WorkbenchContext.Provider>
        ) : (
          <>
            <h1 className="text-ui-lg font-semibold">会话</h1>
            <p className="mt-2 text-ui-sm text-ink-mute">CodeAgent</p>
          </>
        )}
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
