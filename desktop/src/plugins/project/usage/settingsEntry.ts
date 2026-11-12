import { createElement } from "react";
import { createStore } from "zustand/vanilla";
import { BarChart3Icon } from "../../../shared/ui/icons.tsx";
import type { WorkbenchContributions } from "../../workbench/types.ts";
import { UsageAgentFilter, UsageSettings } from "./UsageSettings.tsx";

export function createUsageSettingsEntry(
  agents: readonly { id: string; displayName: string }[],
): WorkbenchContributions["settings"] {
  const filter = createStore(() => ({ agent: "" }));
  return {
    id: "usage-statistics",
    label: "使用统计",
    order: 25,
    Icon: BarChart3Icon,
    HeaderAction: () => createElement(UsageAgentFilter, { agents, filter }),
    View: () => createElement(UsageSettings, { filter }),
  };
}
