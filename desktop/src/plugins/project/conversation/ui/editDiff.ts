/**
 * edit 类工具入参的宽容提取与行级 diff（工具卡「改动」段的数据层）。
 *
 * 输入使用通用 EditPayload；专属工具入参由对应 Agent 增强模块解析。
 *
 * diff 为行级 LCS：先裁掉公共前后缀，再对中段做 DP（规模护栏见
 * MAX_LCS_DIM，超限整段按替换呈现，绝不卡 UI）；最终把连续未变行折叠为
 * 「首 ±context 行 + ⋯ + 尾 ±context 行」的 hunk 序列。
 */

/** 一次可展示的编辑载荷（edit = 有旧文本可比；write = 新内容预览）。 */
export type { EditPayload } from "../../../acpRuntime/types.ts";
/** diff 呈现行：context=未变，del=删，add=增，gap=被折叠的未变区间。 */
export interface DiffRow {
  readonly type: "context" | "del" | "add" | "gap";
  /** 旧文件行号（context/del 行有值）。 */
  readonly oldNo: number | null;
  /** 新文件行号（context/add 行有值）。 */
  readonly newNo: number | null;
  readonly text: string;
}

export interface DiffResult {
  readonly rows: readonly DiffRow[];
  readonly added: number;
  readonly removed: number;
}

/** LCS 中段规模护栏（单边行数）：超限不做 DP，整段按替换呈现。 */
const MAX_LCS_DIM = 1200;

/** 宽容提取：形状不认识返回 null（调用方回落现有输入 JSON 展示）。 */

/** 按换行切分（末尾换行不产生空行；空文本为空数组）。 */
function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

type Op = "keep" | "del" | "add";

/** 中段 LCS（公共前后缀已裁）：回溯产出全量操作序列。 */
function lcsOps(a: readonly string[], b: readonly string[]): Op[] {
  const m = a.length;
  const n = b.length;
  if (m === 0 && n === 0) {
    return [];
  }
  if (m === 0) {
    return b.map(() => "add" as const);
  }
  if (n === 0) {
    return a.map(() => "del" as const);
  }
  if (m > MAX_LCS_DIM || n > MAX_LCS_DIM) {
    // 规模护栏：整段替换呈现（行数仍准确，只是无最小化合并）
    return [...a.map(() => "del" as const), ...b.map(() => "add" as const)];
  }
  // DP 表 (m+1)×(n+1)，行主序（noUncheckedIndexedAccess 下取值都带 ?? 兜底）
  const width = n + 1;
  const table = new Int32Array((m + 1) * width);
  const cell = (index: number): number => table[index] ?? 0;
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? cell((i + 1) * width + (j + 1)) + 1
          : Math.max(cell((i + 1) * width + j), cell(i * width + (j + 1)));
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push("keep");
      i += 1;
      j += 1;
    } else if (cell((i + 1) * width + j) >= cell(i * width + (j + 1))) {
      ops.push("del");
      i += 1;
    } else {
      ops.push("add");
      j += 1;
    }
  }
  while (i < m) {
    ops.push("del");
    i += 1;
  }
  while (j < n) {
    ops.push("add");
    j += 1;
  }
  return ops;
}

/** 连续未变行折叠：长度 ≤ 2*context+2 原样保留；否则首尾各留 context 行，
 *  中间换成一个 gap 行。 */
function collapseContextRuns(
  rows: readonly DiffRow[],
  context: number,
): DiffRow[] {
  const out: DiffRow[] = [];
  let run: DiffRow[] = [];
  const flushRun = (): void => {
    if (run.length === 0) {
      return;
    }
    if (run.length <= 2 * context + 2) {
      out.push(...run);
    } else {
      out.push(...run.slice(0, context));
      out.push({ type: "gap", oldNo: null, newNo: null, text: "⋯" });
      out.push(...run.slice(run.length - context));
    }
    run = [];
  };
  for (const row of rows) {
    if (row.type === "context") {
      run.push(row);
    } else {
      flushRun();
      out.push(row);
    }
  }
  flushRun();
  return out;
}

/** 行级 diff 主入口：公共前后缀裁剪 + 中段 LCS + ±context hunk 折叠。 */
export function buildDiffRows(
  oldText: string,
  newText: string,
  context = 1,
): DiffResult {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // 公共前后缀裁剪：只把有差异的中段送进 LCS
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const ops = lcsOps(a.slice(start, endA), b.slice(start, endB));
  const allRows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let oldNo = 0;
  let newNo = 0;
  const pushContext = (text: string): void => {
    oldNo += 1;
    newNo += 1;
    allRows.push({ type: "context", oldNo, newNo, text });
  };
  for (let k = 0; k < start; k += 1) {
    pushContext(a[k] ?? "");
  }
  for (const op of ops) {
    if (op === "keep") {
      oldNo += 1;
      newNo += 1;
      allRows.push({
        type: "context",
        oldNo,
        newNo,
        text: a[oldNo - 1] ?? "",
      });
    } else if (op === "del") {
      oldNo += 1;
      removed += 1;
      allRows.push({
        type: "del",
        oldNo,
        newNo: null,
        text: a[oldNo - 1] ?? "",
      });
    } else {
      newNo += 1;
      added += 1;
      allRows.push({
        type: "add",
        oldNo: null,
        newNo,
        text: b[newNo - 1] ?? "",
      });
    }
  }
  for (let k = endA; k < a.length; k += 1) {
    pushContext(a[k] ?? "");
  }
  return {
    rows: collapseContextRuns(allRows, Math.max(0, context)),
    added,
    removed,
  };
}

/** write_file 预览的行数上限（超出截断并给出共 N 行提示）。 */
export const WRITE_PREVIEW_LINE_LIMIT = 60;

/** 截断预览：返回行数组与是否截断。 */
export function previewLines(
  content: string,
  limit = WRITE_PREVIEW_LINE_LIMIT,
): { readonly lines: readonly string[]; readonly truncated: boolean } {
  const lines = splitLines(content);
  return {
    lines: lines.slice(0, limit),
    truncated: lines.length > limit,
  };
}
