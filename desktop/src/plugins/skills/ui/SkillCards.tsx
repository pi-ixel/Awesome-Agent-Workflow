import { type ReactNode } from "react";
import type { NativeSkill } from "../../host/types.ts";
import { pathName } from "../../../shared/panelPaths.ts";
import { ActionButton, DangerButton, focusVisibleRing } from "../../../shared/ui/controls.tsx";
import { ContextMenu } from "../../../shared/ui/ContextMenu.tsx";
import { useMenuController } from "../../../shared/ui/useMenuController.ts";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
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
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-selected">
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
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(21.5rem,100%),1fr))] gap-3">
        {children}
      </div>
    </section>
  );
}
export interface Actions {
  open: (skill: NativeSkill) => void;
  remove: (skill: NativeSkill) => void;
  busy: boolean;
}
export function ActionsRow({
  skill,
  actions,
  onDetail,
}: {
  skill: NativeSkill;
  actions: Actions;
  onDetail?: (button: HTMLButtonElement) => void;
}) {
  const { menu, open, dismiss } = useMenuController();
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
  const openLabel = skill.kind === "inline" ? "定位配置" : "打开目录";
  const glyphSize = "ui-icon-16";
  const openIcon = <FolderGlyph className={glyphSize} isExpanded={false} />;
  const copyIcon = <CopyIcon className={glyphSize} />;
  const removeIcon = <TrashIcon className={glyphSize} />;
  if (onDetail) {
    const iconButton = `flex min-w-7 items-center justify-center rounded-md py-1.5 focus-visible:ring-inset disabled:opacity-50 ${focusVisibleRing}`;
    return (
      <div className="flex shrink-0 items-center gap-0.5 pr-2 text-ink-mute">
        <IconButton
          aria-label="移入回收站"
          data-hint="移入回收站"
          className={iconButton + " hover:bg-danger-bg hover:text-danger-ink"}
          disabled={actions.busy}
          onClick={() => actions.remove(skill)}
        >
          {removeIcon}
        </IconButton>
        <IconButton
          aria-label="更多"
          data-hint="更多"
          aria-haspopup="menu"
          aria-expanded={!!menu && !menu.closing}
          className={iconButton + " hover:bg-hover hover:text-ink"}
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
                  label: "详情",
                  icon: <FileIcon className={glyphSize} />,
                  onSelect: () => onDetail(anchor),
                },
                {
                  id: "open",
                  label: "打开目录",
                  icon: openIcon,
                  onSelect: () => actions.open(skill),
                },
                {
                  id: "copy",
                  label: "复制路径",
                  icon: copyIcon,
                  onSelect: () => void copyPath(),
                },
              ],
              { trigger: anchor },
            );
          }}
        >
          <EllipsisIcon className={glyphSize} />
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
      </div>
    );
  }
  const button =
    "flex items-center gap-2.5 px-2 py-1.5 text-left";
  return (
    <div className="flex shrink-0 flex-wrap gap-1 border-t border-line pt-2 text-ui-sm sm:flex-col">
      <ActionButton tone="ghost" className={button} onClick={() => void copyPath()}>
        {copyIcon}复制路径
      </ActionButton>
      <ActionButton tone="ghost" className={button} onClick={() => actions.open(skill)}>
        {openIcon}
        {openLabel}
      </ActionButton>
      <DangerButton
        className={button}
        disabled={actions.busy}
        onClick={() => actions.remove(skill)}
      >
        {removeIcon}
        移入回收站
      </DangerButton>
    </div>
  );
}
function SkillCardIcon() {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line text-ink-mute">
      <SkillIcon className="ui-icon-16" />
    </span>
  );
}

export function SelectableSkillCard({
  name,
  description,
  selected,
  onToggle,
}: {
  name: string;
  description: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <NavigationRow
      layout="compound"
      type="button"
      aria-label={`选择 ${name}`}
      aria-pressed={selected}
      data-hint={description?.trim() || undefined}
      onClick={onToggle}
      className="flex min-h-[50px] min-w-0 items-center gap-2 overflow-hidden rounded-2xl border border-line bg-surface px-3.5 text-left transition-colors hover:border-line-strong aria-pressed:border-ink aria-pressed:bg-selected aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-ink focus-visible:ring-focus-ring!"
    >
      <SkillCardIcon />
      <span className="min-w-0 flex-1 truncate text-ui-base font-semibold">
        {name}
      </span>
    </NavigationRow>
  );
}
export function SkillCard({
  skill,
  actions,
  onDetail,
  reviewLabel,
}: {
  skill: NativeSkill;
  actions: Actions;
  onDetail: (button: HTMLButtonElement) => void;
  reviewLabel?: string;
}) {
  const needsReview = !["正常", "配置内定义"].includes(skill.status);
  return (
    <article
      aria-label={skill.name}
      data-hint={skill.description || undefined}
      className="flex min-h-[50px] min-w-0 items-stretch overflow-hidden rounded-xl border border-line bg-surface transition-colors hover:border-line-strong focus-within:border-line-strong"
    >
      <div className="flex min-w-0 flex-1 items-stretch">
        <NavigationRow
          layout="compound"
          className="items-center gap-2 px-3.5 py-1.5 leading-tight hover:bg-surface-hover"
          aria-label={`查看 ${skill.name} 详情`}
          onClick={(event) => onDetail(event.currentTarget)}
        >
          <SkillCardIcon />
          <span className="line-clamp-2 min-w-0 flex-1 break-words text-ui-base font-semibold">
            {skill.name}
          </span>
          {needsReview && (
            <span
              className="max-w-[45%] shrink-0 truncate text-ui-xs text-danger-ink"
              data-hint={reviewLabel ? skill.status : undefined}
            >
              {reviewLabel ?? "待检查"}
            </span>
          )}
        </NavigationRow>
      </div>
      <ActionsRow skill={skill} actions={actions} onDetail={onDetail} />
    </article>
  );
}
