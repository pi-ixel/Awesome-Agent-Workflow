import { useWorkspaceValue } from "../../ui/bindings/workspaceView.ts";
import { useProjectView } from "../../ui/bindings/projectView.tsx";
import { useRegisteredSnapshot } from "../../../../shared/state/useRegisteredSnapshot.ts";
/**
 * edit 类工具的「改动」视图（工具卡展开区输入段的替身）：
 * - edit_file：±1 行上下文的行级 diff（增行绿/删行红，双列行号，连续
 *   未变区间折叠为 ⋯），头部给 `路径 +N -M` 统计；
 * - write_file：新内容预览（超过 WRITE_PREVIEW_LINE_LIMIT 行截断提示）。
 * 数据全部来自 editDiff 纯函数，本组件只做渲染。
 */
import { useMemo, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "../../../../shared/ui/icons.tsx";
import type { DiffResult, EditPayload } from "./editDiff.ts";
import { buildDiffRows, previewLines } from "./editDiff.ts";
import { FilePathButton } from "../../ui/FilePathButton.tsx";

/** diff 行的底色：ZCode lightweight-diff-preview 公式——14% 行底 + 3px
    内嵌状态条（token 落 index.css --color-diff-*-row，双主题同源）。 */
const rowClasses: Readonly<Record<string, string>> = {
  context: "",
  add: "bg-diff-added-row shadow-[inset_3px_0_0_var(--color-diff-added)]",
  del: "bg-diff-removed-row shadow-[inset_3px_0_0_var(--color-diff-removed)]",
  gap: "",
};

/** This card describes one tool payload, never the whole turn or worktree. */
function FileChangeCard({
  path,
  label,
  stats,
  children,
  defaultExpanded = false,
}: {
  readonly path: string;
  readonly label: string;
  readonly stats?: ReactNode;
  readonly children: ReactNode;
  readonly defaultExpanded?: boolean;
}) {
  const openGitReview = useRegisteredSnapshot(useProjectView()?.gitReview, (review) => review?.open);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const project = useWorkspaceValue((state) => state.activePath);
  return (
    <div className="overflow-hidden bg-surface">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex h-10 w-full items-center gap-2 px-3 text-left text-ui-base hover:bg-hover"
      >
        <ChevronRightIcon
          className={`size-3.5 shrink-0 text-ink-mute transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span className="shrink-0 font-medium">{label}</span>
        <span className="min-w-0 flex-1 truncate text-ink-soft">{path}</span>
        <span className="shrink-0 tabular-nums">{stats}</span>
      </button>
      {expanded && (
        <div className="border-t border-line">
          <div className="flex min-w-0 items-center gap-2 px-3 py-2 text-ui-base">
            <FilePathButton path={path} />
            {!defaultExpanded && project && openGitReview && (
              <button
                type="button"
                className="ml-auto shrink-0 rounded border border-line px-2 py-1 text-ui-sm hover:bg-hover"
                onClick={() => openGitReview(project, "changes")}
              >
                查看工作区变更
              </button>
            )}
          </div>
          {children}
        </div>
      )}
    </div>
  );
}

function DiffRowsView({ diff }: { readonly diff: DiffResult }) {
  if (diff.rows.length === 0) {
    return <p className="px-3 py-1.5 text-ui-sm text-ink-mute">（无差异行）</p>;
  }
  return (
    <div
      className="max-h-60 overflow-auto bg-base font-mono text-xs leading-relaxed text-ink"
      aria-label="行级差异"
    >
      {diff.rows.map((row, index) => (
        <div
          key={index}
          className={`flex gap-2 px-3 whitespace-pre-wrap break-words ${
            rowClasses[row.type] ?? ""
          }`}
        >
          <span
            className={`w-12 shrink-0 select-none px-2 text-right tabular-nums ${
              row.type === "add"
                ? "bg-diff-added-gutter text-diff-added"
                : row.type === "del"
                  ? "bg-diff-removed-gutter text-diff-removed"
                  : "text-ink-subtlest"
            }`}
          >
            {row.type === "gap" ? "" : (row.oldNo ?? "")}
          </span>
          <span
            className={`w-10 shrink-0 select-none border-r border-line px-2 text-right tabular-nums ${
              row.type === "add"
                ? "bg-diff-added-gutter text-diff-added"
                : row.type === "del"
                  ? "bg-diff-removed-gutter text-diff-removed"
                  : "text-ink-subtlest"
            }`}
          >
            {row.type === "gap" ? "" : (row.newNo ?? "")}
          </span>
          <span
            aria-hidden={true}
            className="w-3 shrink-0 select-none text-center"
          >
            {row.type === "add" ? (
              <span className="text-diff-added">+</span>
            ) : row.type === "del" ? (
              <span className="text-diff-removed">−</span>
            ) : row.type === "gap" ? (
              <span className="text-ink-mute">⋯</span>
            ) : null}
          </span>
          <span
            className={`min-w-0 flex-1 ${
              row.type === "gap" ? "select-none text-ink-mute" : "text-ink"
            }`}
          >
            {row.text}
          </span>
        </div>
      ))}
    </div>
  );
}

/** write_file：新内容预览（截断提示兜底，完整内容仍可看输入 JSON）。 */
function WritePreview({ content }: { readonly content: string }) {
  const preview = useMemo(() => previewLines(content), [content]);
  return (
    <div
      className="max-h-60 overflow-auto bg-base p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-ink"
      aria-label="新文件内容预览"
    >
      {preview.lines.length === 0
        ? "（空文件）"
        : preview.lines.map((line, index) => (
            <div key={index}>{line.length === 0 ? " " : line}</div>
          ))}
      {preview.truncated ? (
        <div className="select-none pt-1 text-ink-mute">
          ⋯ 已截断预览，完整内容见「输入」JSON
        </div>
      ) : null}
    </div>
  );
}

function EditCard({
  path,
  oldString,
  newString,
  defaultExpanded,
}: {
  readonly path: string;
  readonly oldString: string;
  readonly newString: string;
  readonly defaultExpanded: boolean;
}) {
  const diff = useMemo(
    () => buildDiffRows(oldString, newString, 1),
    [oldString, newString],
  );
  return (
    <FileChangeCard
      path={path}
      defaultExpanded={defaultExpanded}
      label="修改片段"
      stats={
        <span>
          <span className="text-diff-added">+{diff.added}</span>{" "}
          <span className="text-diff-removed">−{diff.removed}</span>
        </span>
      }
    >
      <DiffRowsView diff={diff} />
    </FileChangeCard>
  );
}

function WriteCard({
  path,
  content,
  defaultExpanded,
}: {
  readonly path: string;
  readonly content: string;
  readonly defaultExpanded: boolean;
}) {
  return (
    <FileChangeCard
      path={path}
      label="写入内容"
      defaultExpanded={defaultExpanded}
    >
      <WritePreview content={content} />
    </FileChangeCard>
  );
}

export function EditDiffView({
  payload,
  defaultExpanded = false,
}: {
  readonly payload: EditPayload;
  readonly defaultExpanded?: boolean;
}) {
  if (payload.kind === "write") {
    return (
      <WriteCard
        path={payload.path}
        content={payload.content}
        defaultExpanded={defaultExpanded}
      />
    );
  }
  return (
    <EditCard
      path={payload.path}
      defaultExpanded={defaultExpanded}
      oldString={payload.oldString}
      newString={payload.newString}
    />
  );
}
