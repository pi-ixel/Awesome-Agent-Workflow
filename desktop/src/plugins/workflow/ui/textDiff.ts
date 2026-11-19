/** 源码逐行差异（ADR 036）：草稿保存前给用户看改了什么。 */

export interface DiffLine {
  readonly kind: "same" | "add" | "remove";
  readonly text: string;
}

/** 行数太多时不算最长公共子序列，直接整体替换显示，避免卡住界面。 */
const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  // 去掉相同的开头与结尾，只对中间部分做比较。
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head = a.slice(0, start).map((text): DiffLine => ({ kind: "same", text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ kind: "same", text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_CELLS) {
    return [...head, ...midA.map((text): DiffLine => ({ kind: "remove", text })), ...midB.map((text): DiffLine => ({ kind: "add", text })), ...tail];
  }
  // 最长公共子序列表（从后往前）。
  const width = midB.length + 1;
  const table = new Uint32Array((midA.length + 1) * width);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      table[i * width + j] = midA[i] === midB[j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) { middle.push({ kind: "same", text: midA[i]! }); i++; j++; }
    else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) { middle.push({ kind: "remove", text: midA[i]! }); i++; }
    else { middle.push({ kind: "add", text: midB[j]! }); j++; }
  }
  while (i < midA.length) middle.push({ kind: "remove", text: midA[i++]! });
  while (j < midB.length) middle.push({ kind: "add", text: midB[j++]! });
  return [...head, ...middle, ...tail];
}

/** 只保留改动及其前后几行上下文；省略的部分用 null 表示。 */
export function withContext(lines: readonly DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((line, index) => {
    if (keep[index]) out.push(line);
    else if (out.at(-1) !== null) out.push(null);
  });
  return out;
}
