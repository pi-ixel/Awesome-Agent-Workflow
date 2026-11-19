import { type ReactNode } from "react";
import type { NativeSkill, SkillCatalog } from "../../host/types.ts";
import { pathName } from "../../../shared/panelPaths.ts";
import { DangerButton } from "../../../shared/ui/controls.tsx";
import { ContextMenu } from "../../../shared/ui/ContextMenu.tsx";
import { useHeaderMenu } from "../../../shared/ui/useHeaderMenu.ts";
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
  XIcon,
} from "../../../shared/ui/icons.tsx";
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { DocumentPreview } from "../../../shared/ui/DocumentPreview.tsx";

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
          className="min-w-0 truncate font-mono text-xs text-ink-mute"
          data-hint={project ?? sources.join("\n")}
        >
          {project ??
            (sources.length === 1 ? sources[0] : `${sources.length} 个来源`)}
        </span>
        <span
          aria-hidden="true"
          className="min-w-4 flex-1 border-t border-line"
        />
        <span className="shrink-0 text-xs tabular-nums text-ink-mute">
          {entries.length} 项
        </span>
      </h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(21.5rem,100%),1fr))] gap-3">
        {children}
      </div>
    </section>
  );
}
interface Actions {
  open: (skill: NativeSkill) => void;
  remove: (skill: NativeSkill) => void;
  busy: boolean;
}
function ActionsRow({
  skill,
  actions,
  onDetail,
}: {
  skill: NativeSkill;
  actions: Actions;
  onDetail?: (button: HTMLButtonElement) => void;
}) {
  const { menu, open, dismiss } = useHeaderMenu();
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
    const iconButton =
      "flex min-w-7 items-center justify-center rounded-md py-1.5 focus-visible:outline-offset-[-3px] disabled:opacity-50";
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
            const rect = anchor.getBoundingClientRect();
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
              {
                x: rect.right,
                y: rect.bottom + 4,
                side: "bottom",
                align: "end",
              },
            );
          }}
        >
          <EllipsisIcon className={glyphSize} />
        </IconButton>
        {menu && (
          <ContextMenu
            entries={menu.entries}
            placement={menu.placement}
            label={menu.label}
            closing={menu.closing}
            onDismiss={dismiss}
          />
        )}
      </div>
    );
  }
  const button =
    "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus-ring";
  return (
    <div className="mt-auto flex shrink-0 flex-wrap gap-1 border-t border-line pt-2 text-xs sm:flex-col">
      <button className={button} onClick={() => void copyPath()}>
        {copyIcon}复制路径
      </button>
      <button className={button} onClick={() => actions.open(skill)}>
        {openIcon}
        {openLabel}
      </button>
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
    <button
      type="button"
      aria-label={`选择 ${name}`}
      aria-pressed={selected}
      data-hint={description?.trim() || undefined}
      onClick={onToggle}
      className="flex min-h-[50px] min-w-0 items-center gap-2 overflow-hidden rounded-2xl border border-line bg-surface px-3.5 text-left transition-colors hover:border-line-strong focus-visible:outline-offset-2 aria-pressed:border-ink aria-pressed:bg-selected aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-ink"
    >
      <SkillCardIcon />
      <span className="min-w-0 flex-1 truncate text-ui-base font-semibold">
        {name}
      </span>
    </button>
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
      className="flex h-[50px] min-w-0 items-stretch overflow-hidden rounded-xl border border-line bg-surface transition-colors hover:border-line-strong focus-within:border-line-strong"
    >
      <div className="flex min-w-0 flex-1 items-stretch">
        <button
          className="flex min-w-0 flex-1 items-center gap-2 px-3.5 text-left hover:bg-hover focus-visible:outline-offset-[-3px]"
          aria-label={`查看 ${skill.name} 详情`}
          onClick={(event) => onDetail(event.currentTarget)}
        >
          <SkillCardIcon />
          <span className="line-clamp-2 min-w-0 flex-1 break-words text-ui-base font-semibold">
            {skill.name}
          </span>
          {needsReview && (
            <span
              className="max-w-[45%] shrink-0 truncate text-xs text-danger-ink"
              data-hint={reviewLabel ? skill.status : undefined}
            >
              {reviewLabel ?? "待检查"}
            </span>
          )}
        </button>
      </div>
      <ActionsRow skill={skill} actions={actions} onDetail={onDetail} />
    </article>
  );
}
export function SkillDetail({
  skill,
  catalog,
  actions,
  onClose,
  message,
}: {
  skill: NativeSkill;
  catalog: SkillCatalog;
  actions: Actions;
  onClose: () => void;
  message: string;
}) {
  const source = catalog.sources.find((s) => s.path === skill.source);
  const shared =
    skill.kind !== "inline" &&
    catalog.entries.some(
      (other) => other.path !== skill.path && other.realPath === skill.realPath,
    );
  const isInline = skill.kind === "inline";
  const project = source?.project ? pathName(source.project) : "全局技能";
  const kind = isInline
    ? "配置定义"
    : skill.kind === "package"
      ? "插件包"
      : skill.isLink
        ? "符号链接"
        : "目录技能";
  const documentName = isInline ? "配置定义" : "SKILL.md";
  return (
    <ModalShell size="preview" label="技能详情" onDismiss={onClose}>
      <header className="flex shrink-0 items-center justify-between border-b border-line px-5 py-2.5">
        <h2 className="flex min-w-0 items-center gap-2 text-xs text-ink-mute">
          <SkillIcon className="ui-icon-16" />
          <span className="truncate">{project}</span>
          <span aria-hidden="true">/</span>
          <span className="shrink-0">技能详情</span>
        </h2>
        <IconButton aria-label="关闭技能详情" onClick={onClose}>
          <XIcon className="ui-icon-16" />
        </IconButton>
      </header>
      <div className="shrink-0 px-5 py-4 sm:px-7 sm:py-5">
        <h3
          data-hint={skill.name}
          className="truncate text-ui-settings-title-lg font-semibold tracking-tight"
        >
          {skill.name}
        </h3>
        {skill.description && (
          <p
            data-hint={skill.description}
            className="mt-1.5 line-clamp-2 max-w-[90ch] whitespace-pre-line break-words text-sm text-ink-soft"
          >
            {skill.description}
          </p>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col-reverse border-t border-line sm:grid sm:grid-cols-[minmax(0,1fr)_clamp(13rem,23%,18rem)]">
        <DocumentPreview
          name={documentName}
          text={skill.preview}
          rawOnly={isInline}
          emptyBody={<p className="text-xs text-ink-mute">此文件仅包含技能元数据，可切换到原文查看。</p>}
        />
        <aside
          aria-label="技能信息"
          className="flex min-h-0 min-w-0 flex-col gap-2 border-b border-line bg-base px-4 py-3 sm:gap-3 sm:border-b-0 sm:border-l sm:px-5 sm:py-4"
        >
          <h4 className="hidden text-sm font-semibold sm:block">技能信息</h4>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs [&_dt]:text-ink-mute sm:block sm:[&_dd]:mt-0.5 sm:[&_dt:not(:first-child)]:mt-2.5 [@media(max-height:760px)]:sm:grid [@media(max-height:760px)]:sm:[&_dt:not(:first-child)]:mt-0 [@media(max-height:760px)]:sm:[&_dd]:mt-0">
            <dt>所属项目</dt>
            <dd className="truncate" data-hint={source?.project ?? undefined}>
              {project}
            </dd>
            <dt>来源</dt>
            <dd className="break-words">
              {source?.label} · {kind}
            </dd>
            <dt>使用次数</dt>
            <dd>{skill.usageCount ?? "未知"}</dd>
            <dt>技能位置</dt>
            <dd
              className="line-clamp-2 break-all font-mono"
              data-hint={skill.path}
            >
              {skill.path}
            </dd>
            {skill.isLink && (
              <>
                <dt>链接目标</dt>
                <dd
                  className="line-clamp-2 break-all font-mono"
                  data-hint={skill.realPath}
                >
                  {skill.realPath}
                </dd>
              </>
            )}
            {!["正常", "配置内定义"].includes(skill.status) && (
              <>
                <dt>状态</dt>
                <dd
                  className="line-clamp-2 text-danger-ink"
                  data-hint={skill.status}
                >
                  {skill.status}
                </dd>
              </>
            )}
          </dl>
          {shared && (
            <p className="text-xs text-ink-mute">其他来源也引用这个目录。</p>
          )}
          {message && (
            <p
              role="status"
              className="line-clamp-2 break-all text-xs"
              data-hint={message}
            >
              {message}
            </p>
          )}
          <ActionsRow skill={skill} actions={actions} />
        </aside>
      </div>
    </ModalShell>
  );
}
