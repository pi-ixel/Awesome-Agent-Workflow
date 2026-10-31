/**
 * 工具调用行：对齐 ZCode ToolSummaryRow 两变体（ToolLayout + renderers）。
 *
 * - 开关行触发表 = inline-flex max-w-full（随内容收缩，chevron 紧随摘要文本），
 *   摘要行（read/search/fetch）= flex w-full；
 * - 折叠态一行 = 图标 + kind 词 + 主文本（单行截断）+（edit）+N/-N diffstat
 *   +（失败）状态词（点线下划线，报错挂 hover 提示）；
 *   运行态 kind 词走 turn-status-shimmer 扫光（全应用唯一流光实现），无脉动点；
 * - 主文本结构对齐 ZCode renderers：execute 出原始命令（getExecuteSecondaryText，
 *   不出键值对）、read 出文件 chip（图标 + 文件名）+ 次级目录路径、
 *   search/fetch 出「查找 {query}」句式，其余走 结果摘要 → 标题 → 输入摘要 兜底；
 * - read / search / fetch 为摘要行（canToggle=false，ZCode 同规则）：
 *   不可展开，原始输出经 FileTree / 代码查看器兜底；
 * - execute / edit / other 为开关行：hover 浮现 chevron，展开区沿左导线给出
 *   完整输入 / 输出（edit 类输入段替换为 diff/新内容预览；execute 类输出段
 *   替换为终端视图），输入 / 输出段各带复制按钮；
 * - 展开状态由用户控制，工具完成时不覆盖用户选择。
 */
import { useMemo, memo, type ComponentType } from "react";
import type { ToolCallItem } from "../../stores/sessionStore.ts";
import {
  ChevronRightIcon,
  FileIcon,
  GlobeIcon,
  PencilIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
  type IconProps,
} from "../icons.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { extractEditPayload, buildDiffRows } from "./editDiff.ts";
import { EditDiffView } from "./EditDiffView.tsx";
import { TerminalOutput } from "./TerminalOutput.tsx";
import { useExpansionState } from "./useExpansionState.ts";

/** kind 词表（对齐 ZCode zh-CN chat.toolCall.kind，去「工具」字样）。
 *  未收录 kind 不进词表，行内回落首字母大写的 kind 词（fallback.tsx 同款）。 */
const kindLabels: Readonly<Record<string, string>> = {
  read: "读取",
  edit: "编辑",
  execute: "终端",
  search: "搜索",
  fetch: "网页抓取",
};

/** 运行态 kind 词（运行中扫光位）；未知 kind 无运行态词。 */
const runningLabels: Readonly<Record<string, string>> = {
  read: "正在读取",
  edit: "正在编辑",
  execute: "正在执行",
  search: "正在搜索",
  fetch: "正在抓取",
};

/** kind 图标（ZCode renderers 同款 lucide 几何；未知 kind 落 fallback 扳手）。 */
const kindIcons: Readonly<Record<string, ComponentType<IconProps>>> = {
  read: SearchIcon,
  edit: PencilIcon,
  execute: SquareTerminalIcon,
  search: SearchIcon,
  fetch: GlobeIcon,
  other: WrenchIcon,
};

/** 摘要行（不可展开）的 kind：对齐 ZCode canToggle=false 的 renderers。 */
const summaryOnlyKinds: ReadonlySet<string> = new Set(["read", "search", "fetch"]);

/** 完整载荷的呈现文本：字符串按原文，其余安全 JSON 美化。
 *  导出供底部终端面板复用（纯函数，无状态）。 */
export function formatPayload(value: unknown): string {
  if (value === undefined || value === null) {
    return "（无）";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    const text = JSON.stringify(value, null, 2);
    if (typeof text === "string") {
      return text;
    }
  } catch {
    // 循环引用等：落入类型名兜底
  }
  return typeof value;
}

/**
 * 折叠摘要是否与标题重复：chrys 的 title 常由工具名 + 关键参数生成
 * （如 `read_file .sdd/SR-004/state.json`），此时摘要 `path=…` 只是复述。
 * 规则：摘要按 ` · ` 拆段、取各段 `=` 后的值，若值全部出现在标题里
 * 则视为重复，不再展示。
 */
function isSummaryRedundant(title: string, summary: string): boolean {
  if (summary.length === 0) {
    return true;
  }
  const values = summary.split(" · ").map((part) => {
    const eq = part.indexOf("=");
    return eq === -1 ? part : part.slice(eq + 1);
  });
  return values.every((value) => value.length > 0 && title.includes(value));
}

/** execute 的原始命令文本（ZCode getExecuteSecondaryText 核心路径：字符串
 *  直取；对象取 command/cmd/script 首个非空字段）。 */
function executeCommandText(rawInput: unknown): string {
  if (typeof rawInput === "string") {
    return rawInput.trim();
  }
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
    return "";
  }
  const record = rawInput as Readonly<Record<string, unknown>>;
  for (const key of ["command", "cmd", "script"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "";
}

/** read 的文件路径（ZCode readReadMetadataFromValue 键序：filePath/file_path/
 *  path/filename 首个非空字符串字段）。 */
function readPathText(rawInput: unknown): string {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
    return "";
  }
  const record = rawInput as Readonly<Record<string, unknown>>;
  for (const key of ["filePath", "file_path", "path", "filename"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "";
}

/** search/fetch 的查询词（ZCode getSearchPrimaryText 键序；fetch 的 url 同列
 *  ——WebFetch 摘要与 search 共用「查找 {query}」句式）。 */
function searchQueryText(rawInput: unknown): string {
  if (typeof rawInput === "string") {
    return rawInput.trim();
  }
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
    return "";
  }
  const record = rawInput as Readonly<Record<string, unknown>>;
  for (const key of [
    "search_query",
    "searchQuery",
    "query",
    "pattern",
    "path",
    "url",
    "prompt",
    "target",
    "name",
  ] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "";
}

/** 路径拆分（ZCode getPathLeaf/buildFilePath 语义）：叶为文件名，目录含
 *  结尾斜杠；无目录段（根下单名）返回 null。 */
function splitFilePath(path: string): { leaf: string; dir: string | null } {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const leafIndex = normalized.lastIndexOf("/");
  if (leafIndex === -1) {
    return { leaf: normalized, dir: null };
  }
  return {
    leaf: normalized.slice(leafIndex + 1),
    dir: normalized.slice(0, leafIndex + 1),
  };
}

function ToolCallCardBase({ item }: { readonly item: ToolCallItem }) {
  const [isOpen, setIsOpen] = useExpansionState(`tool:${item.id}`);
  const isRunning = item.status === "in_progress" || item.status === null;
  // 主文本按 ZCode renderers 结构分派（提取失败或非对应 kind 走兜底链）：
  // - execute：原始命令（结果/报错不上行，经展开区与状态词提示）；
  // - read：文件 chip + 次级目录路径；
  // - search/fetch：「查找 {query}」句式；
  // - 兜底链：结果摘要 → 标题（摘要与标题重复/缺失时）→ 输入摘要，
  //   标题转为 hover 提示（ZCode SummaryContent 单行语义）。
  const executeCommand =
    item.toolKind === "execute" ? executeCommandText(item.rawInput) : "";
  const readPath = item.toolKind === "read" ? readPathText(item.rawInput) : "";
  const searchQuery =
    item.toolKind === "search" || item.toolKind === "fetch"
      ? searchQueryText(item.rawInput)
      : "";
  const hasResult =
    item.status === "completed" || item.status === "failed"
      ? item.resultSummary.length > 0
      : false;
  const summaryRedundant = hasResult
    ? false
    : isSummaryRedundant(item.title, item.inputSummary);
  const fallbackText = hasResult
    ? item.resultSummary || item.title
    : summaryRedundant
      ? item.title
      : item.inputSummary;
  const readChip = readPath.length > 0 ? splitFilePath(readPath) : null;
  const summaryOnly = item.toolKind !== null && summaryOnlyKinds.has(item.toolKind);
  // ZCode prioritizePrimaryText（read/edit 传入）：主文本区 flex-1 顶满；
  // 其余 kind 的触发行随内容收缩（ToolSummaryRow inline-flex max-w-full）。
  const prioritize = item.toolKind === "read" || item.toolKind === "edit";
  const staticKindLabel =
    item.toolKind === null
      ? null
      : (kindLabels[item.toolKind] ??
        item.toolKind.charAt(0).toUpperCase() + item.toolKind.slice(1));
  const runningLabel =
    item.toolKind === null ? null : (runningLabels[item.toolKind] ?? null);
  const rowKindLabel =
    isRunning && runningLabel !== null ? runningLabel : staticKindLabel;
  const KindIcon =
    item.toolKind === null ? WrenchIcon : (kindIcons[item.toolKind] ?? WrenchIcon);
  // edit 类的改动载荷：展开区输入段让位给 diff 视图，否则回落 JSON
  const editPayload = useMemo(
    () => (item.toolKind === "edit" ? extractEditPayload(item.rawInput) : null),
    [item.toolKind, item.rawInput],
  );
  // 折叠行 diffstat（ZCode renderDiffCount）：行级 LCS 计数，memo 保证每个
  // item 只算一次（MAX_LCS_DIM 护栏在 editDiff 内）
  const editDiffStat = useMemo(() => {
    if (editPayload === null || editPayload.kind !== "edit") {
      return null;
    }
    const { added, removed } = buildDiffRows(
      editPayload.oldString,
      editPayload.newString,
      1,
    );
    return { added, removed };
  }, [editPayload]);
  const summary = (
    <>
      <span className="shrink-0 text-ink-mute">
        <KindIcon className="size-4 shrink-0" />
      </span>
      {rowKindLabel !== null ? (
        <span
          className={`font-medium whitespace-nowrap shrink-0 ${isRunning ? "turn-status-shimmer" : ""}`}
        >
          {rowKindLabel}
        </span>
      ) : null}
      {readChip !== null ? (
        // read 主文本：文件 chip（图标 + 文件名，hover 出全路径）+ 次级目录路径
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className="inline-flex min-w-0 items-center gap-1.5 text-ink-soft"
            title={readPath}
          >
            <FileIcon className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{readChip.leaf}</span>
          </span>
          {readChip.dir !== null ? (
            <span className="min-w-0 truncate">{readChip.dir}</span>
          ) : null}
        </span>
      ) : executeCommand.length > 0 ? (
        // execute 主文本：原始命令原文（ZCode getExecuteSecondaryText）
        <span className="min-w-0 truncate" title={item.title}>
          {executeCommand}
        </span>
      ) : searchQuery.length > 0 ? (
        // search/fetch 主文本：「查找 {query}」整句摘要（getSearchPrimaryText）
        <span className="min-w-0 truncate" title={item.title}>
          {`查找 ${searchQuery}`}
        </span>
      ) : fallbackText.length > 0 ? (
        <span
          className={`min-w-0 truncate ${prioritize ? "flex-1" : ""} ${summaryOnly && item.toolKind === "read" ? "text-ink-soft" : ""}`}
          title={item.title}
        >
          {fallbackText}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {editDiffStat !== null && (editDiffStat.added > 0 || editDiffStat.removed > 0) ? (
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-mono leading-none tabular-nums">
          {editDiffStat.added > 0 ? (
            <span className="text-diff-added">+{editDiffStat.added}</span>
          ) : null}
          {editDiffStat.removed > 0 ? (
            <span className="text-diff-removed">-{editDiffStat.removed}</span>
          ) : null}
        </span>
      ) : null}
      {item.status === "failed" ? (
        // 失败态词继承摘要容器单色（ZCode ToolLayout 无颜色类），
        // 点线下划线提示可 hover；报错原因挂原生 title 提示
        <span
          className="shrink-0 cursor-help whitespace-nowrap underline decoration-dotted underline-offset-2"
          title={item.resultSummary || "失败"}
        >
          执行失败
        </span>
      ) : null}
    </>
  );
  return (
    <div className="w-full min-w-0" data-item-kind="tool" data-item-id={item.id}>
      {summaryOnly ? (
        // 摘要行（read/search/fetch）：不可展开，无 chevron（ZCode canToggle=false）；
        // hover title = 工具标题（ToolSummaryRow 同款，非开始时刻时钟）
        <div
          className="group/tool flex w-full cursor-default items-center gap-2 text-left text-ui-base text-ink-mute transition-colors"
          title={item.title}
        >
          {summary}
        </div>
      ) : (
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((current) => !current)}
          title={item.title}
          className="group/tool inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base text-ink-mute transition-colors"
        >
          {summary}
          {/* chevron hover 浮现（对齐 ToolSummaryRow）；触屏设备常显兜底 */}
          <ChevronRightIcon
            className={`size-4 shrink-0 text-ink-mute opacity-0 transition-transform transition-opacity duration-200 ease-out will-change-transform group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100 [@media(hover:none)]:opacity-100 ${isOpen ? "rotate-90 opacity-100" : "rotate-0"}`}
          />
        </button>
      )}
      {isOpen ? (
        <div className="mt-2 ml-2 space-y-3 border-line border-l py-1 pl-3.5">
          {editPayload !== null ? (
            // edit 类：输入段由 diff/新内容预览替代（批准前一眼看到改成什么）
            <section aria-label="工具改动" className="group">
              <div className="mb-1 flex items-center justify-between text-xs text-ink-faint">
                <p>改动</p>
                <CopyButton
                  getText={() => formatPayload(item.rawInput)}
                  label="复制输入"
                  iconOnly={true}
                  revealOnHover={true}
                />
              </div>
              <EditDiffView payload={editPayload} />
            </section>
          ) : (
            <section aria-label="工具输入" className="group">
              <div className="mb-1 flex items-center justify-between text-xs text-ink-faint">
                <p>输入</p>
                <CopyButton
                  getText={() => formatPayload(item.rawInput)}
                  label="复制输入"
                  iconOnly={true}
                  revealOnHover={true}
                />
              </div>
              <pre className="max-h-72 overflow-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-ink-soft">
                {formatPayload(item.rawInput)}
              </pre>
            </section>
          )}
          <section aria-label="工具输出" className="group">
            <div className="mb-1 flex items-center justify-between text-xs text-ink-faint">
              <p>输出</p>
              <CopyButton
                getText={() => formatPayload(item.rawOutput)}
                label="复制输出"
                iconOnly={true}
                revealOnHover={true}
              />
            </div>
            {item.toolKind === "execute" ? (
              // execute 类：终端输出视图（5 行窗口 + 吸底跟随 + 上滚冻结）
              <TerminalOutput
                text={formatPayload(item.rawOutput)}
                failed={item.status === "failed"}
              />
            ) : (
              <pre
                className={`max-h-72 overflow-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words ${item.status === "failed" ? "text-danger-ink" : "text-ink-soft"}`}
              >
                {formatPayload(item.rawOutput)}
              </pre>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

/** memo：item 引用不变则整树跳过（流式分片只改最后一条的引用）。 */
export const ToolCallCard = memo(ToolCallCardBase);
