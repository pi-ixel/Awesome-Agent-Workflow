import type { Context } from "cordis";
import { useStore } from "zustand";
import { GlobeIcon } from "../../../shared/ui/icons.tsx";
import { BrowserPanel } from "./BrowserPanel.tsx";
import { BrowserAgentControlSettings } from "./settings.tsx";
import { BrowserToolRecovery } from "./BrowserToolRecovery.tsx";
import { encodeBrowserElementMessage } from "../../../shared/browser/elementReferenceMessage.ts";

export const name = "browser-workbench";
export const inject = ["host", "workbench", "project"];

export function apply(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.workbench.register("settings", {
        id: "browser",
        group: "agent",
        order: 45,
        label: "浏览器",
        Icon: GlobeIcon,
        View: () => <BrowserAgentControlSettings host={ctx.host.browser} />,
      }),
    "browser:settings",
  );
  ctx.effect(
    () =>
      ctx.workbench.register("panels", {
        id: "browser",
        keepMounted: true,
        launcher: {
          label: "浏览器",
          description: "在项目会话中打开内嵌浏览器",
          searchHint: "browser web page",
          Icon: GlobeIcon,
          order: -20,
        },
        View: ({ project, visible }) => {
          const activeSessionId = useStore(
            ctx.project.conversation.foreground.session,
            (state) => state.activeSessionId,
          );
          const agentKey = useStore(
            ctx.project.conversation.foreground.session,
            (state) => state.agentKey,
          );
          const lastSessionId = useStore(
            ctx.project.conversation.foreground.runtime,
            (state) => state.lastSessionId,
          );
          const browserError = useStore(
            ctx.project.conversation.foreground.runtime,
            (state) => state.browserError,
          );
          const toolNames = useStore(
            ctx.project.conversation.foreground.runtime,
            (state) => state.runtime.toolNames,
          );
          const toolInventoryKnown = useStore(
            ctx.project.conversation.foreground.runtime,
            (state) => state.runtime.toolInventoryKnown,
          );
          const mcpFailures = useStore(
            ctx.project.conversation.foreground.runtime,
            (state) =>
              state.runtime.mcpFailuresKnown
                ? state.runtime.mcpFailures
                : undefined,
          );
          const sessionId = activeSessionId ?? `manual:${project}`;
          return (
            <div className="flex h-full min-h-0 flex-col">
              {activeSessionId && agentKey && (
                <BrowserToolRecovery
                  host={ctx.host.browser}
                  project={ctx.project}
                  workspacePath={project}
                  agentKey={agentKey}
                  sessionId={activeSessionId}
                  browserError={browserError}
                  runtime={{
                    lastSessionId,
                    toolNames,
                    toolInventoryKnown,
                    mcpFailures,
                  }}
                />
              )}
              <div className="min-h-0 flex-1">
                <BrowserPanel
                  host={ctx.host.browser}
                  sessionId={sessionId}
                  workspaceId={project}
                  agentKey={agentKey ?? undefined}
                  visible={visible}
                />
              </div>
            </div>
          );
        },
      }),
    "browser:workbench-panel",
  );
  ctx.effect(() => {
    let active = true;
    let unsubscribe = () => {};
    void ctx.host.browser
      .onVisibility(({ sessionId, visible }) => {
        if (!active) return;
        const current = ctx.workbench.navigation.getState();
        const project = current.contextPath;
        if (!project) return;
        const activeSession =
          ctx.project.conversation.foreground.session.getState()
            .activeSessionId;
        if (sessionId !== activeSession && sessionId !== `manual:${project}`)
          return;
        if (visible) {
          ctx.workbench.panels
            .getState()
            .openTab(project, { id: "browser", kind: "browser" });
        } else {
          ctx.workbench.panels.getState().collapse(project);
        }
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, "browser:workbench-visibility");
  ctx.effect(() => {
    let active = true;
    let unsubscribe = () => {};
    void ctx.host.browser
      .onUserTakeover(({ sessionId }) => {
        if (!active) return;
        const project = ctx.workbench.navigation.getState().contextPath;
        if (!project) return;
        const session = ctx.project.conversation.foreground.session.getState();
        if (
          sessionId !== session.activeSessionId ||
          !session.isAgentRunning ||
          session.turnState !== "running" ||
          !session.agentKey
        )
          return;
        ctx.project.conversation.cancel({
          workspacePath: project,
          agentKey: session.agentKey,
          sessionId,
        });
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, "browser:workbench-user-takeover");
  ctx.effect(() => {
    let active = true;
    let unsubscribe = () => {};
    void ctx.host.browser
      .onElement((element) => {
        if (!active) return;
        const project = ctx.workbench.navigation.getState().contextPath;
        if (!project) return;
        const activeSessionId =
          ctx.project.conversation.foreground.session.getState()
            .activeSessionId;
        if (
          element.sessionId !== activeSessionId &&
          element.sessionId !== `manual:${project}`
        )
          return;
        ctx.project.drafts.composer.prefill(
          encodeBrowserElementMessage("", [element]),
        );
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, "browser:workbench-element-reference");
}
