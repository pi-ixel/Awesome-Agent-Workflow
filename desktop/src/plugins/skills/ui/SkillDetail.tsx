import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  NativeSkill,
  NativeSkillLibrary,
  SkillCatalog,
  SkillFileRequest,
  SkillFileResponse,
  SkillQuery,
} from "../../host/types.ts";
import { pathName } from "../../../shared/panelPaths.ts";
import { ActionButton } from "../../../shared/ui/controls.tsx";
import { CopyButton } from "../../../shared/ui/CopyButton.tsx";
import { DocumentPreview } from "../../../shared/ui/DocumentPreview.tsx";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { NavigationRow } from "../../../shared/ui/NavigationRow.tsx";
import { FileEntryLabel } from "../../../shared/ui/file-icons/FileEntryLabel.tsx";
import {
  ArrowUpIcon,
  ChevronRightIcon,
  SkillIcon,
  XIcon,
} from "../../../shared/ui/icons.tsx";
import { ActionsRow, type Actions } from "./SkillCards.tsx";
import { formatSize } from "./skillGroups.ts";

const defaultFile = "SKILL.md";

type FileRead = NativeSkillLibrary["files"];
type FileState =
  | { request: SkillFileRequest; result: SkillFileResponse }
  | { request: SkillFileRequest; error: string };

function useSkillFiles(
  readFiles: FileRead,
  query: SkillQuery,
  skill: NativeSkill,
  type: "directory" | "read",
  path: string,
): FileState | undefined {
  const [state, setState] = useState<FileState>();
  const request = useMemo<SkillFileRequest>(
    () => ({ type, path }),
    [type, path],
  );
  useEffect(() => {
    if (!readFiles || skill.kind === "inline") return;
    let active = true;
    void readFiles(query, skill, request).then(
      (result) => {
        if (active) setState({ request, result });
      },
      (error: unknown) => {
        if (active) setState({ request, error: String(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [readFiles, query, skill, request]);
  return state?.request === request ? state : undefined;
}

const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function SkillDetail({
  skill,
  catalog,
  actions,
  onClose,
  message,
  query,
  readFiles,
}: {
  readonly skill: NativeSkill;
  readonly catalog: SkillCatalog;
  readonly actions: Actions;
  readonly onClose: () => void;
  readonly message: string;
  readonly query: SkillQuery;
  readonly readFiles: FileRead;
}) {
  const source = catalog.sources.find((item) => item.path === skill.source);
  const shared =
    skill.kind !== "inline" &&
    catalog.entries.some(
      (other) => other.path !== skill.path && other.realPath === skill.realPath,
    );
  const isInline = skill.kind === "inline";
  const projectPath = source?.project ?? skill.disabledProject;
  const project = projectPath ? pathName(projectPath) : "全局技能";
  const kind = isInline
    ? "配置定义"
    : skill.kind === "package"
      ? "插件包"
      : skill.isLink
        ? "符号链接"
        : "目录技能";
  const sourceLabel = [source?.label, kind].filter(Boolean).join(" · ");
  const [folder, setFolder] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState(defaultFile);
  const [isInspectorOpen, setInspectorOpen] = useState(false);
  const inspectorId = useId();
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const folderPath = folder.join("/");
  const directory = useSkillFiles(
    readFiles,
    query,
    skill,
    "directory",
    folderPath,
  );
  const entryDocument = useSkillFiles(
    readFiles,
    query,
    skill,
    "read",
    defaultFile,
  );
  const extraDocument = useSkillFiles(
    selectedFile === defaultFile ? undefined : readFiles,
    query,
    skill,
    "read",
    selectedFile,
  );
  const document = selectedFile === defaultFile ? entryDocument : extraDocument;
  const file =
    document && "result" in document && document.result.type === "text"
      ? document.result
      : undefined;
  const listing =
    directory && "result" in directory && directory.result.type === "directory"
      ? directory.result
      : undefined;
  const hasFiles = !isInline && !!readFiles;
  const text = isInline || !readFiles ? skill.preview : (file?.text ?? "");
  const isComplete = isInline || file !== undefined;
  const name = isInline ? "配置定义" : selectedFile;
  const isSkillMarkdown = !isInline && selectedFile === defaultFile;
  const updatedAt =
    entryDocument &&
    "result" in entryDocument &&
    entryDocument.result.type === "text"
      ? entryDocument.result.modifiedAt
      : undefined;
  const error = document && "error" in document ? document.error : undefined;

  return (
    <ModalShell size="preview" label="技能详情" onDismiss={onClose}>
      <div className="@container flex min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2 @min-[540px]:px-6">
          <nav
            aria-label="技能位置"
            className="flex min-w-0 items-center gap-2 text-ui-caption text-ink-mute"
          >
            <SkillIcon className="ui-icon-16 shrink-0" />
            <span
              className="min-w-0 truncate"
              data-hint={projectPath ?? project}
            >
              {project}
            </span>
            <ChevronRightIcon
              aria-hidden="true"
              className="ui-icon-12 shrink-0"
            />
            <span className="hidden shrink-0 @min-[460px]:inline">
              技能详情
            </span>
            <ChevronRightIcon
              aria-hidden="true"
              className="ui-icon-12 hidden shrink-0 @min-[460px]:inline"
            />
            <span
              aria-current="page"
              className="min-w-0 truncate font-mono font-semibold text-ink"
              data-hint={skill.name}
            >
              {skill.name}
            </span>
          </nav>
          <div className="flex shrink-0 items-center gap-1">
            {isComplete && text && (
              <CopyButton
                key={name}
                getText={() => text}
                label={isSkillMarkdown ? "复制 SKILL.md" : "复制原文"}
                copiedLabel={isSkillMarkdown ? "已复制 SKILL.md" : "已复制"}
                appearance="outlined"
              />
            )}
            <IconButton aria-label="关闭技能详情" onClick={onClose}>
              <XIcon className="ui-icon-16" />
            </IconButton>
          </div>
        </header>

        <div className="flex shrink-0 justify-end border-b border-line px-3 py-1 @min-[760px]:hidden">
          <ActionButton
            ref={inspectorToggle}
            tone="ghost"
            aria-controls={inspectorId}
            aria-expanded={isInspectorOpen}
            onClick={() => setInspectorOpen(!isInspectorOpen)}
          >
            {isInspectorOpen ? "返回正文" : "技能信息与文件"}
          </ActionButton>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] @min-[760px]:grid-cols-[minmax(0,1fr)_clamp(14rem,25%,19rem)]">
          <div
            className={`min-h-0 min-w-0 overflow-y-auto overscroll-contain px-4 pb-6 @min-[540px]:px-7 ${isInspectorOpen ? "hidden @min-[760px]:block" : ""}`}
          >
            <section
              className="space-y-2 py-5 @min-[540px]:py-7"
              aria-label="技能概览"
            >
              <p className="text-ui-caption text-ink-mute">{sourceLabel}</p>
              <h3 className="break-words font-mono text-ui-settings-title-lg font-semibold tracking-tight">
                {skill.name}
              </h3>
              {skill.description && (
                <p className="max-w-[72ch] whitespace-pre-line break-words text-ui-base leading-relaxed text-ink-soft">
                  {skill.description}
                </p>
              )}
            </section>
            {error ? (
              <p
                role="alert"
                className="border-t border-line py-4 text-ui-sm text-danger-ink"
              >
                {error}
              </p>
            ) : hasFiles && !document ? (
              <p
                role="status"
                className="border-t border-line py-4 text-ui-sm text-ink-mute"
              >
                正在读取文件…
              </p>
            ) : (
              <DocumentPreview
                key={name}
                name={name}
                text={text}
                rawOnly={isInline || !/\.(md|markdown)$/i.test(selectedFile)}
                presentation="workbench"
                isComplete={isComplete}
                emptyBody={
                  <p className="text-ui-sm text-ink-mute">
                    此文件仅包含技能元数据，可切换到原文查看。
                  </p>
                }
              />
            )}
          </div>

          <aside
            id={inspectorId}
            aria-label="技能信息"
            className={`min-h-0 min-w-0 flex-col gap-5 overflow-y-auto overscroll-contain px-4 py-5 @min-[760px]:flex @min-[760px]:border-l @min-[760px]:border-line @min-[900px]:px-6 ${isInspectorOpen ? "flex" : "hidden"}`}
          >
            <section className="space-y-3">
              <h4 className="text-ui-sm font-semibold">技能信息</h4>
              <dl className="divide-y divide-line border-y border-line text-ui-sm [&>div]:grid [&>div]:grid-cols-[auto_minmax(0,1fr)] [&>div]:gap-x-4 [&>div]:py-2 [&_dd]:break-words [&_dd]:text-right [&_dt]:text-ink-mute">
                <div>
                  <dt>所属项目</dt>
                  <dd data-hint={projectPath ?? undefined}>{project}</dd>
                </div>
                <div>
                  <dt>来源</dt>
                  <dd>{sourceLabel}</dd>
                </div>
                <div>
                  <dt>使用次数</dt>
                  <dd>{skill.usageCount ?? "未知"}</dd>
                </div>
                {updatedAt != null && (
                  <div>
                    <dt>最近更新</dt>
                    <dd>{dateFormat.format(updatedAt)}</dd>
                  </div>
                )}
                {!["正常", "配置内定义"].includes(skill.status) && (
                  <div>
                    <dt>状态</dt>
                    <dd className={skill.disabledId ? "text-ink-mute" : "text-danger-ink"} data-hint={skill.status}>
                      {skill.statusLabel ?? skill.status}
                    </dd>
                  </div>
                )}
              </dl>
              {skill.unavailable && (
                <p className="text-ui-caption text-warn-ink">{skill.unavailable}</p>
              )}
              {shared && !skill.disabledId && (
                <p className="text-ui-caption text-ink-mute">
                  其他来源也引用这个目录。
                </p>
              )}
            </section>

            <section className="space-y-2">
              <h4 className="text-ui-caption text-ink-mute">技能位置</h4>
              <p className="select-text break-all rounded-lg border border-line bg-base px-3 py-2 font-mono text-ui-caption leading-relaxed text-ink-soft">
                {skill.path}
              </p>
              {skill.isLink && !skill.disabledId && (
                <p className="break-all font-mono text-ui-caption text-ink-mute">
                  链接目标 {skill.realPath}
                </p>
              )}
            </section>

            {hasFiles && (
              <section className="space-y-2">
                <h4 className="text-ui-caption text-ink-mute">目录文件</h4>
                {folder.length > 0 && (
                  <NavigationRow
                    layout="tree"
                    onClick={() => setFolder(folder.slice(0, -1))}
                    aria-label="上一级目录"
                  >
                    <ArrowUpIcon className="ui-icon-14 shrink-0" />
                    <span
                      className="min-w-0 truncate font-mono"
                      data-hint={folderPath}
                    >
                      {folderPath}
                    </span>
                  </NavigationRow>
                )}
                {directory && "error" in directory ? (
                  <p
                    role="alert"
                    className="break-words text-ui-caption text-danger-ink"
                  >
                    {directory.error}
                  </p>
                ) : listing ? (
                  <div
                    role="group"
                    aria-label="技能目录文件"
                    className="space-y-0.5 rounded-lg border border-line p-1"
                  >
                    {listing.entries.map((entry) => {
                      const relative = [...folder, entry.name].join("/");
                      return (
                        <NavigationRow
                          key={entry.name}
                          layout="tree"
                          aria-current={
                            selectedFile === relative ? "true" : undefined
                          }
                          disabled={entry.kind === "unavailable"}
                          data-hint={
                            entry.kind === "unavailable"
                              ? "链接或特殊文件，请打开目录查看"
                              : entry.name
                          }
                          onClick={() => {
                            if (entry.kind === "directory") {
                              setFolder([...folder, entry.name]);
                            } else {
                              setSelectedFile(relative);
                              setInspectorOpen(false);
                              if (isInspectorOpen)
                                inspectorToggle.current?.focus();
                            }
                          }}
                        >
                          <FileEntryLabel
                            name={entry.name}
                            folder={
                              entry.kind === "directory" ? "closed" : undefined
                            }
                            nameClassName="font-mono"
                          />
                          {entry.kind === "unavailable" && (
                            <span className="shrink-0 text-ui-caption text-ink-mute">
                              不可预览
                            </span>
                          )}
                          {entry.bytes != null && (
                            <span className="shrink-0 text-ui-caption tabular-nums text-ink-mute">
                              {formatSize(entry.bytes)}
                            </span>
                          )}
                        </NavigationRow>
                      );
                    })}
                    {!listing.entries.length && (
                      <p className="px-2 py-1 text-ui-caption text-ink-mute">
                        此目录为空
                      </p>
                    )}
                    {listing.truncated && (
                      <p className="px-2 py-1 text-ui-caption text-ink-mute">
                        仅显示前 500 项，可打开目录查看更多。
                      </p>
                    )}
                  </div>
                ) : (
                  <p role="status" className="text-ui-caption text-ink-mute">
                    正在读取目录…
                  </p>
                )}
              </section>
            )}

            {message && (
              <p
                role="status"
                className="break-words text-ui-caption text-ink-soft"
              >
                {message}
              </p>
            )}
            <ActionsRow skill={skill} actions={actions} />
          </aside>
        </div>
      </div>
    </ModalShell>
  );
}
