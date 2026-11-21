import type { Context } from "cordis";
import type { ComponentType } from "react";
import { SkillLibrary } from "./SkillLibrary.tsx";
import { createStore, useStore } from "zustand";
import { GlobeIcon, PuzzleIcon, SkillIcon } from "../../../shared/ui/icons.tsx";
import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
import { knownWorkspacePaths } from "../../project/service.ts";
import type { SkillsSettingsView } from "../types.ts";
import SkillsInstallerSection from "./SkillsInstallerSection.tsx";
import { SkillsSourceSettings } from "./SkillsSourceSettings.tsx";

export const name = "skills-workbench";
export const inject = ["skills", "workbench"];

export function apply(ctx: Context): void {
  const { skills, workbench } = ctx;
  ctx.effect(() =>
    workbench.register("settingsReset", {
      id: "skills",
      label: "Skills 源目录",
      reset: () => skills.setSourceDirectory(""),
    }),
  );
  const view: SkillsSettingsView = {
    Source: () => (
      <SkillsSourceSettings
        source={skills.source}
        onChange={(directory) => skills.setSourceDirectory(directory)}
      />
    ),
    Installer: ({ active }) => (
      <SkillsInstallerSection skills={skills} active={active} />
    ),
  };
  ctx.provide("skillsUi", view);
  ctx.inject(["project", "agents", "host"], (ctx) => {
    const { project, agents, host } = ctx;
    const navigation = createStore<{
      page: "skills" | "mcp";
      McpPage: ComponentType | null;
    }>(() => ({ page: "skills", McpPage: null }));
    ctx.inject(["mcp"], (ctx) => {
      const { mcp } = ctx;
      ctx.effect(() => {
        navigation.setState({ McpPage: mcp.View });
        return () =>
          navigation.setState(({ page }) => ({
            page: page === "mcp" ? "skills" : page,
            McpPage: null,
          }));
      }, "skills:mcp-page");
    });
    function Sidebar() {
      const { page, McpPage } = useStore(navigation);
      return (
        <nav aria-label="插件管理" className="space-y-1 p-3">
          {(
            [
              { label: "技能", Icon: SkillIcon, id: "skills" },
              { label: "MCP", Icon: GlobeIcon, id: "mcp" },
            ] as const
          )
            .filter(({ id }) => id !== "mcp" || McpPage)
            .map(({ label, Icon, id }) => (
              <NavigationRow
                key={label}
                aria-current={page === id ? "page" : undefined}
                onClick={() => navigation.setState({ page: id })}
                className={
                  page === id
                    ? "font-semibold text-ink"
                    : "text-ink-mute hover:text-ink"
                }
              >
                <Icon className="ui-icon-16" />
                {label}
              </NavigationRow>
            ))}
        </nav>
      );
    }
    const knownProjects = () =>
      knownWorkspacePaths(project.projects.workspace.getState());
    ctx.effect(() =>
      workbench.register("sidebar", {
        id: "plugin-management",
        label: "插件管理",
        order: 30,
        Icon: PuzzleIcon,
        View: Sidebar,
        WorkArea: function SkillsWorkArea() {
          const { page, McpPage } = useStore(navigation);
          const configuration = useStore(agents.configuration);
          const adapter = agents.resolve(configuration.activeAgentId);
          if (page === "mcp" && McpPage) return <McpPage />;
          if (!adapter?.skillLibrary) {
            return (
              <section
                aria-label="技能管理"
                className="p-6 text-ui-base text-ink-mute"
              >
                {adapter?.displayName ?? configuration.activeAgentId}{" "}
                暂未提供技能管理。
              </section>
            );
          }
          return (
            <SkillLibrary
              library={host.skills.library}
              key={configuration.activeAgentId}
              provider={adapter.skillLibrary}
              knownProjects={knownProjects}
              packages={adapter.skillPackages?.(
                host.commands,
                agents.buildLaunch(
                  adapter,
                  project.projects.workspace.getState().toolPaths,
                  null,
                ).command[0] ?? adapter.id,
              )}
              storage={host.storage}
              pick={host.dialogs.pickDirectory}
              reveal={(p, action) => host.files.openInFileManager(p, action)}
            />
          );
        },
      }),
    );
  });
}
