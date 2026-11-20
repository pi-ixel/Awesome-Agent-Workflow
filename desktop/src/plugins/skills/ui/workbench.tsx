import type { Context } from "cordis";
import { SkillLibrary } from "./SkillLibrary.tsx";
import { createStore, useStore } from "zustand";
import { PuzzleIcon, SkillIcon, TrashIcon } from "../../../shared/ui/icons.tsx";
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
    Installer: () => <SkillsInstallerSection skills={skills} />,
  };
  ctx.provide("skillsUi", view);
  ctx.inject(["project", "agents", "host"], (ctx) => {
    const { project, agents, host } = ctx;
    const navigation = createStore(() => ({ trash: false }));
    function Sidebar() {
      const { trash } = useStore(navigation);
      return (
        <nav aria-label="插件管理" className="space-y-1 p-3">
          {[
            { label: "技能", Icon: SkillIcon, recycle: false },
            { label: "回收站", Icon: TrashIcon, recycle: true },
          ].map(({ label, Icon, recycle }) => (
            <NavigationRow
              key={label}
              aria-current={trash === recycle ? "page" : undefined}
              onClick={() => navigation.setState({ trash: recycle })}
              className={trash === recycle ? "font-semibold text-ink" : "text-ink-mute hover:text-ink"}
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
          const { trash } = useStore(navigation);
          const configuration = useStore(agents.configuration);
          const adapter = agents.resolve(configuration.activeAgentId);
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
              trash={trash}
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
