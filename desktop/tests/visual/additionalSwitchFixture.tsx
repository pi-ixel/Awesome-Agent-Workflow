import { createStore } from "zustand";
import { AgentsSettingsSection } from "../../src/plugins/agents/ui/AgentsSettings.tsx";
import type { AgentsService } from "../../src/plugins/agents/service.ts";
import { createProjectSettings } from "../../src/plugins/project/ui/settings.tsx";
import { emptyWorkspace } from "../../src/plugins/project/workspace/types.ts";
import { ToolManagement } from "../../src/plugins/tools/ui/ToolManagement.tsx";
import "../../src/plugins/tools/ui/tools.css";
import { sampleTool } from "../fixtures/sampleTool.ts";
import { createTestProjectPreferences, projectPreferencesWrapper } from "../helpers/projectPreferences.tsx";

const preferences = createTestProjectPreferences();
preferences.setMessageStreamShowTodos(true);
preferences.setAutoAnswerQuestions(true);
preferences.setSessionAutoArchive(true);
const Preferences = projectPreferencesWrapper(preferences);
const settings = createProjectSettings(() => null);
const Session = settings.find(entry => entry.id === "session")!.View;
const Archive = settings.find(entry => entry.id === "archive")!.View;
const agents = {
  configuration: createStore(() => ({
    activeAgentId: null,
    discoveredAgents: [],
    agents: [],
    isScanningAgents: false,
  })),
  probeState: createStore(() => ({ phase: "idle", result: null, resultsByAgent: {} })),
  listBuiltins: () => [],
  scan: () => {},
} as unknown as AgentsService;
const workspace = createStore(() => emptyWorkspace);
const tool = {
  package: {
    ...sampleTool,
    settingsSchema: [{ id: "sort", type: "boolean", label: "排序键名", default: true }] as const,
  },
};
const noop = () => {};

export function AdditionalSwitchFixture() {
  return <>
    <Preferences>
      <Session active={false} />
      <Archive active />
    </Preferences>
    <AgentsSettingsSection agents={agents} workspace={workspace} switchAgent={() => Promise.resolve()} />
    <ToolManagement entry={tool} onBack={noop} onOpen={noop} onExport={noop}
      onUpdate={noop} onSave={() => true} onRemove={noop} busy={false} />
  </>;
}
