import { type ReactNode } from "react";
import type { NativeSkill } from "../../host/types.ts";
import { pathName } from "../../../shared/panelPaths.ts";
import { ActionButton, ToggleSwitch } from "../../../shared/ui/controls.tsx";
import {
  CapabilityCard,
  capabilityGridClass,
} from "../../../shared/ui/CapabilityCard.tsx";
import { ContextMenu } from "../../../shared/ui/ContextMenu.tsx";
import { useMenuController } from "../../../shared/ui/useMenuController.ts";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { useFeedback } from "../../../shared/ui/feedback.ts";
import {
  CopyIcon,
  FileIcon,
  EllipsisIcon,
  FolderGlyph,
  GlobeIcon,
  SkillIcon,
  TrashIcon,
} from "../../../shared/ui/icons.tsx";

export function SkillGroup({
  project,
  entries,
  children,
}: {
  project: string | null;
  entries: NativeSkill[];
  children: ReactNode;
}) {
  const sources = [...new Set(entries.map((entry) => entry.source))];
  return (
    <section aria-label={project ?? "全局技能"} className="space-y-3">
      <h2 className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-control bg-selected">
          {project ? (
            <FolderGlyph isExpanded={false} />
          ) : (
            <GlobeIcon className="ui-icon-16" />
          )}
        </span>
        <span
          className="truncate text-ui-lg font-semibold"
          data-hint={project ?? undefined}
        >
          {project ? pathName(project) : "全局技能"}
        </span>
        <span
          className="min-w-0 truncate font-mono text-ui-caption text-ink-mute"
          data-hint={project ?? sources.join("\n")}
        >
          {project ??
            (sources.length === 1 ? sources[0] : `${sources.length} 个来源`)}
        </span>
        <span
          aria-hidden="true"
          className="min-w-4 flex-1 border-t border-line"
        />
        <span className="shrink-0 text-ui-caption tabular-nums text-ink-mute">
          {entries.length} 项
        </span>
      </h2>
      <div className={capabilityGridClass}>{children}</div>
    </section>
  );
}
export interface Actions {
  open: (skill: NativeSkill) => void;
  remove: (skill: NativeSkill, opener: HTMLButtonElement) => void;
  toggle: (skill: NativeSkill) => void;
  busy: boolean;
}

export function ActionsRow({
  skill,
  actions,
}: {
  skill: NativeSkill;
  actions: Actions;
}) {
  const notify = useFeedback();
  async function copyPath() {
    try {
      await navigator.clipboard.writeText(skill.path);
      notify?.({
        message: "已复制",
        variant: "ok",
        dedupeKey: "skill-path-copy",
      });
    } catch {
      notify?.({
        message: "复制路径失败",
        variant: "danger",
        dedupeKey: "skill-path-copy",
      });
    }
  }
  const button = "flex items-center gap-2.5 px-2 py-1.5 text-left";
  return (
    <div className="flex shrink-0 flex-wrap gap-1 border-t border-line pt-2 text-ui-sm sm:flex-col">
      <ActionButton
        tone="ghost"
        className={button}
        onClick={() => void copyPath()}
      >
        <CopyIcon className="ui-icon-16" />
        复制路径
      </ActionButton>
      {!skill.disabledId && (
        <ActionButton
          tone="ghost"
          className={button}
          onClick={() => actions.open(skill)}
        >
          <FolderGlyph className="ui-icon-16" isExpanded={false} />
          {skill.kind === "inline" ? "定位配置" : "打开目录"}
        </ActionButton>
      )}
    </div>
  );
}

export function SkillCard({
  skill,
  actions,
  onDetail,
  metadata,
  status,
  isToggling = false,
}: {
  skill: NativeSkill;
  actions: Actions;
  onDetail: (button: HTMLButtonElement) => void;
  metadata: string;
  status?: string;
  isToggling?: boolean;
}) {
  const { menu, open, dismiss } = useMenuController();
  return (
    <CapabilityCard
      name={skill.name}
      description={skill.description}
      metadata={metadata}
      status={status}
      icon={<SkillIcon className="ui-icon-16" />}
      onDetail={onDetail}
      toggle={
        <ToggleSwitch
          label={skill.name + " 启用"}
          checked={!skill.disabledId}
          disabled={(actions.busy && !isToggling) || !!skill.unavailable}
          pending={isToggling}
          onChange={() => actions.toggle(skill)}
        />
      }
      actions={
        <>
          <IconButton
            iconSize="compact"
            aria-label={skill.name + " 删除"}
            data-hint="删除"
            disabled={actions.busy || !!skill.unavailable}
            onClick={(event) => actions.remove(skill, event.currentTarget)}
          >
            <TrashIcon className="ui-icon-14" />
          </IconButton>
          <IconButton
            iconSize="compact"
            aria-label={skill.name + " 更多操作"}
            data-hint="更多操作"
            aria-haspopup="menu"
            aria-expanded={!!menu && !menu.closing}
            className="rounded-control text-ink-mute hover:bg-hover hover:text-ink"
            disabled={actions.busy}
            onClick={(event) => {
              const anchor = event.currentTarget;
              if (menu && !menu.closing) {
                dismiss();
                return;
              }
              open(
                "actions",
                skill.name + " 的操作",
                [
                  {
                    id: "detail",
                    label: "查看详情",
                    icon: <FileIcon className="ui-icon-16" />,
                    onSelect: () => onDetail(anchor),
                  },
                ],
                { trigger: anchor },
              );
            }}
          >
            <EllipsisIcon className="ui-icon-14" />
          </IconButton>
          {menu && (
            <ContextMenu
              entries={menu.entries}
              placement={menu.placement}
              trigger={menu.trigger}
              label={menu.label}
              closing={menu.closing}
              onDismiss={dismiss}
            />
          )}
        </>
      }
    />
  );
}
