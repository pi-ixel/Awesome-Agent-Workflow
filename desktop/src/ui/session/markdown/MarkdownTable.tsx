/**
 * Markdown 表格(移植自 ZCode components/ai-elements/markdown-table.tsx
 * 的核心体验:圆角容器 + 横向溢出 + 复制 Markdown / 下载 CSV 带 BOM 与
 * 公式注入防护;ZCode 的自绘虚拟滚动条未移植,用原生 overflow 承接)。
 */
import { type ComponentProps, type ReactNode, useState } from "react";

/** CSV 公式注入防护:以 = + - @ 开头的单元格前置单引号。 */
function escapeCsvCell(value: string): string {
  const needsQuoting = /[",\n]/.test(value) || /^[=+\-@]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuoting ? `"${escaped}"` : escaped;
}

/** 从表格 DOM 序列化 CSV(带 UTF-8 BOM,Excel 直开不乱码)。 */
function serializeTableCsv(table: HTMLTableElement): string {
  const rows: string[] = [];
  for (const tr of table.querySelectorAll("tr")) {
    const cells: string[] = [];
    for (const cell of tr.querySelectorAll("th,td")) {
      cells.push(escapeCsvCell((cell.textContent ?? "").trim()));
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
      cells.push((cell.textContent ?? "").trim().replace(/\|/g, "\\|"));
    }
    rows.push(cells);
  }
  if (rows.length === 0) {
    return "";
  }
  const width = Math.max(...rows.map((row) => row.length));
  const lines = rows.map((row) => `| ${row.concat([""]).slice(0, width).map((cell) => cell === "" ? " " : cell).join(" | ").replace(/\| \|/g, "| |")} |`);
  lines.splice(1, 0, `| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
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
  anchor.click();
  URL.revokeObjectURL(url);
}

function TableToolbarButton({ children, onClick }: {
  readonly children: ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-line px-2 py-0.5 text-2xs text-ink-mute transition-colors hover:border-ink-faint hover:text-ink"
    >
      {children}
    </button>
  );
}

export type MarkdownTableProps = ComponentProps<"table">;

export function MarkdownTable({ children, ...props }: MarkdownTableProps) {
  const [tableElement, setTableElement] = useState<HTMLTableElement | null>(null);
  const [copied, setCopied] = useState<"md" | "csv" | null>(null);
  return (
    <div className="group/table my-3 flex w-full flex-col gap-2">
      <div className="flex items-center justify-end gap-1">
        <TableToolbarButton
          onClick={() => {
            if (tableElement === null) {
              return;
            }
            void copyText(serializeTableMarkdown(tableElement)).then((ok) => {
              if (ok) {
                setCopied("md");
                window.setTimeout(() => setCopied(null), 2000);
              }
            });
          }}
        >
          {copied === "md" ? "已复制" : "复制 Markdown"}
        </TableToolbarButton>
        <TableToolbarButton
          onClick={() => {
            if (tableElement === null) {
              return;
            }
            downloadText("table.csv", serializeTableCsv(tableElement));
          }}
        >
          下载 CSV
        </TableToolbarButton>
      </div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table
          ref={setTableElement}
          className="w-full border-collapse text-sm"
          {...props}
        >
          {children}
        </table>
      </div>
    </div>
  );
}
