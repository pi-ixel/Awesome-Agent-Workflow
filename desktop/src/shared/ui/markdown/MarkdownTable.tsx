/**
 * Markdown 表格(移植自 ZCode components/ai-elements/markdown-table.tsx
 * 的核心体验:圆角容器 + 横向溢出 + 边缘渐隐阴影 + 复制 Markdown /
 * 下载 CSV 带 BOM 与公式注入防护 + 全屏预览;ZCode 的自绘虚拟滚动条
 * 未移植,用原生 overflow 承接)。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { hintTooltipProps } from "../controls/HintTooltip.tsx";
import { useFeedback } from "../feedback.ts";
import {
  ArrowDownToLineIcon,
  CopyIcon,
  Maximize2Icon,
  XIcon,
} from "../icons.tsx";

/** 单元格文本归一化:连续空白(含换行)折叠成单空格(ZCode 同款)。 */
function normalizeTableCellText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 单元格转 Markdown 源:先反斜杠、竖线转义,换行转 <br>(ZCode 同款)。 */
function escapeMarkdownTableCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

/**
 * CSV 公式注入防护:以 = + - @ 开头的单元格前置单引号降级纯文本——
 * Excel/Numbers/LibreOffice 解析 CSV 不看引号,只包双引号挡不住公式执行;
 * 覆盖前导空白与前导 \t\r\n 两种形态(ZCode 同款)。
 */
function escapeCsvCell(value: string): string {
  const safeValue =
    /^[\t\r\n]/u.test(value) || /^[\s]*[=+\-@]/u.test(value)
      ? `'${value}`
      : value;
  if (!/[",\r\n]/u.test(safeValue)) {
    return safeValue;
  }
  return `"${safeValue.replace(/"/g, '""')}"`;
}

/** 从表格 DOM 序列化 CSV(带 UTF-8 BOM,Excel 直开不乱码)。 */
function serializeTableCsv(table: HTMLTableElement): string {
  const rows: string[] = [];
  for (const tr of table.querySelectorAll("tr")) {
    const cells: string[] = [];
    for (const cell of tr.querySelectorAll("th,td")) {
      cells.push(escapeCsvCell(normalizeTableCellText(cell.textContent ?? "")));
    }
    rows.push(cells.join(","));
  }
  return `\uFEFF${rows.join("\r\n")}`;
}

/** 从表格 DOM 反推 Markdown 源(对齐列数,分隔行插在表头后)。 */
function serializeTableMarkdown(table: HTMLTableElement): string {
  const rows: string[][] = [];
  for (const tr of table.querySelectorAll("tr")) {
    const cells: string[] = [];
    for (const cell of tr.querySelectorAll("th,td")) {
      cells.push(
        escapeMarkdownTableCell(normalizeTableCellText(cell.textContent ?? "")),
      );
    }
    rows.push(cells);
  }
  if (rows.length === 0) {
    return "";
  }
  const width = Math.max(...rows.map((row) => row.length));
  const lines = rows.map(
    (row) =>
      `| ${row
        .concat([""])
        .slice(0, width)
        .map((cell) => (cell === "" ? " " : cell))
        .join(" | ")
        .replace(/\| \|/g, "| |")} |`,
  );
  lines.splice(
    1,
    0,
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
  );
  return lines.join("\n");
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 同步 revoke 会在 WebView2 里取消尚未开始的下载（下载 CSV 不生效的
  // 根因）：延迟释放，等下载管理器拿到 Blob 引用
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 表格动作钮:ghost 图标钮 + 悬停释义(CodeBlock 头栏同款控件语言)。 */
function TableToolbarButton({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  const hint = hintTooltipProps(label);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      {...hint}
      className="shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-raised hover:text-ink"
    >
      {children}
    </button>
  );
}

/** 横向溢出边缘渐隐阴影(容器左右 12px 内阴影,随滚动进度出现/消失)。 */
type TableEdgeShadowState = "none" | "left" | "right" | "both";

function TableEdgeShadow({
  side,
  visible,
}: {
  readonly side: "left" | "right";
  readonly visible: boolean;
}) {
  if (!visible) {
    return null;
  }
  return (
    <div
      aria-hidden={true}
      className={
        side === "left"
          ? "pointer-events-none absolute inset-y-0 left-0 z-10 w-6 rounded-l-xl shadow-[inset_12px_0_12px_-12px_color-mix(in_srgb,black_15%,transparent)]"
          : "pointer-events-none absolute inset-y-0 right-0 z-10 w-6 rounded-r-xl shadow-[inset_-12px_0_12px_-12px_color-mix(in_srgb,black_15%,transparent)]"
      }
    />
  );
}

/** 全屏表格预览(sticky 表头 + 独立滚动区,复用同一表格子树)。 */
function TablePreviewDialog({
  onClose,
  tableProps,
  children,
}: {
  readonly onClose: () => void;
  readonly tableProps: ComponentProps<"table">;
  readonly children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "Tab") {
        const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, [tabindex="0"]',
        );
        if (!nodes?.length) return;
        const first = nodes[0]!,
          last = nodes[nodes.length - 1]!;
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialogRef.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            document.activeElement === dialogRef.current)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKey, true);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="表格预览"
        tabIndex={-1}
        className="flex h-[86dvh] w-[92vw] max-w-6xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-xl outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-3 text-ui-base">
          <span className="font-medium text-ink">表格预览</span>
          <button
            type="button"
            aria-label="关闭预览"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded text-ink-mute hover:bg-raised hover:text-ink"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 p-3">
          <div className="h-full overflow-auto rounded-xl border border-line bg-surface">
            <table
              className="w-max min-w-full border-separate border-spacing-0 text-ui-base [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-surface"
              {...tableProps}
            >
              {children}
            </table>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** node 由 react-markdown 注入,显式声明以便解构丢弃、不泄进 DOM。 */
export type MarkdownTableProps = ComponentProps<"table"> & { node?: unknown };

export function MarkdownTable({
  children,
  node: _node,
  ...props
}: MarkdownTableProps) {
  void _node;
  const notify = useFeedback();
  const [tableElement, setTableElement] = useState<HTMLTableElement | null>(
    null,
  );
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const [edgeShadow, setEdgeShadow] = useState<TableEdgeShadowState>("none");
  const [previewOpen, setPreviewOpen] = useState(false);

  /** 按滚动位置切换左右边缘阴影:该侧还有内容未滚入即显示。 */
  const updateEdgeShadow = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (viewport === null) {
      return;
    }
    // Measuring skipped content forces it to lay out again, defeating the file
    // preview's offscreen containment. ResizeObserver runs again on reveal.
    if (
      typeof viewport.checkVisibility === "function" &&
      !viewport.checkVisibility({ contentVisibilityAuto: true })
    )
      return;
    const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
    const showLeft = maxScrollLeft > 2 && viewport.scrollLeft > 1;
    const showRight =
      maxScrollLeft > 2 && viewport.scrollLeft < maxScrollLeft - 1;
    setEdgeShadow(
      showLeft && showRight
        ? "both"
        : showLeft
          ? "left"
          : showRight
            ? "right"
            : "none",
    );
  }, []);

  // 首挂与流式增长(表体逐行出现)都改 scrollWidth/clientWidth,靠
  // ResizeObserver 兜住;滚动进度由 viewport 的 onScroll 直接驱动。
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (viewport === null || typeof ResizeObserver === "undefined") {
      return;
    }
    updateEdgeShadow();
    const observer = new ResizeObserver(updateEdgeShadow);
    observer.observe(viewport);
    if (tableElement !== null) {
      observer.observe(tableElement);
    }
    return () => observer.disconnect();
  }, [tableElement, updateEdgeShadow]);

  const handleCopyMarkdown = useCallback(() => {
    if (tableElement === null) {
      return;
    }
    const clipboard = navigator.clipboard;
    if (clipboard === undefined || typeof clipboard.writeText !== "function") {
      notify?.({
        message: "复制失败:剪贴板不可用",
        variant: "danger",
        dedupeKey: "markdown-table-copy",
      });
      return;
    }
    void copyText(serializeTableMarkdown(tableElement)).then((ok) => {
      notify?.({
        message: ok ? "已复制" : "复制失败",
        variant: ok ? "ok" : "danger",
        dedupeKey: "markdown-table-copy",
      });
    });
  }, [tableElement, notify]);

  const handleDownloadCsv = useCallback(() => {
    if (tableElement === null) {
      return;
    }
    downloadText("table.csv", serializeTableCsv(tableElement));
  }, [tableElement]);

  const closePreview = useCallback(() => setPreviewOpen(false), []);

  return (
    <div className="group/table my-3 flex w-full flex-col gap-2">
      <div className="flex items-center justify-end gap-1">
        <TableToolbarButton label="复制 Markdown" onClick={handleCopyMarkdown}>
          <CopyIcon className="size-3.5" />
        </TableToolbarButton>
        <TableToolbarButton label="下载 CSV" onClick={handleDownloadCsv}>
          <ArrowDownToLineIcon className="size-3.5" />
        </TableToolbarButton>
        <TableToolbarButton
          label="表格预览"
          onClick={() => setPreviewOpen(true)}
        >
          <Maximize2Icon className="size-3.5" />
        </TableToolbarButton>
      </div>
      <div className="relative w-full overflow-hidden rounded-xl border border-line">
        <div
          ref={scrollViewportRef}
          className="w-full overflow-x-auto"
          onScroll={updateEdgeShadow}
        >
          <table
            ref={setTableElement}
            className="w-max min-w-full border-separate border-spacing-0 text-ui-base"
            {...props}
          >
            {children}
          </table>
        </div>
        <TableEdgeShadow
          side="left"
          visible={edgeShadow === "left" || edgeShadow === "both"}
        />
        <TableEdgeShadow
          side="right"
          visible={edgeShadow === "right" || edgeShadow === "both"}
        />
      </div>
      {previewOpen ? (
        <TablePreviewDialog onClose={closePreview} tableProps={props}>
          {children}
        </TablePreviewDialog>
      ) : null}
    </div>
  );
}
