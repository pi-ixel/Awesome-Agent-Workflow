/**
 * 节点检视器的内容解读（纯函数，不依赖 React）。
 *
 * 结果解读按字段规律，不为某个节点写专用代码——自定义流程只要沿用同样的
 * 字段习惯就能读得懂：
 * - `decision` / `status` → 一句结论；
 * - 形如路径的字符串（含 `files` 对象、路径数组）→ 可打开的文件；
 * - `issues` → 结论下方的问题列表；
 * - 其余短值 → 键值行，长文本 → 段落，对象数组 → 每项一行。
 * 工作流定义里写了 `labels`（ADR 035）时，字段名和固定取值按作者写的文字显示；
 * 没写的才按上面的规律推断，认不出的字段照原样显示键名，不猜含义。
 */
import type { HierarchyStructure } from "../types.ts";

export type Tone = "ok" | "warn" | "danger" | "neutral";

export interface ResultView {
  readonly conclusion?: { readonly text: string; readonly tone: Tone };
  readonly issues: readonly string[];
  readonly files: readonly { readonly label: string; readonly path: string }[];
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  readonly texts: readonly { readonly label: string; readonly text: string }[];
  readonly lists: readonly { readonly label: string; readonly items: readonly string[] }[];
}

const CONCLUSION: Readonly<Record<string, { text: string; tone: Tone }>> = {
  ready: { text: "已就绪", tone: "ok" },
  pass: { text: "通过", tone: "ok" },
  passed: { text: "通过", tone: "ok" },
  completed: { text: "已完成", tone: "ok" },
  revise: { text: "需修正", tone: "warn" },
  findings: { text: "报告了发现", tone: "warn" },
  blocked: { text: "已阻塞", tone: "danger" },
  failed: { text: "失败", tone: "danger" },
};

/** 常见字段的显示名；不在表里的字段直接显示键名。 */
const LABEL: Readonly<Record<string, string>> = {
  reference: "参考文档",
  report: "报告",
  plan: "计划",
  design: "设计",
  tests: "测试",
  evidence: "依据",
  issues: "问题",
  files: "文件",
  tasks: "任务",
  summary: "摘要",
  safe: "可安全修正",
  method: "检查方式",
  done: "全部完成",
  nextTaskId: "下一个任务",
};

type Labels = Readonly<Record<string, string>> | undefined;
const SHORT_TEXT = 60;

/** 不含空白、以扩展名或分隔符结尾、或带目录分隔符的字符串当作路径。 */
export function looksLikePath(value: string): boolean {
  if (value.length === 0 || value.length > 400 || /\s/.test(value) || /^[a-z]+:\/\//i.test(value)) return false;
  if (/^\d+(\.\d+)?$/.test(value)) return false;
  return /[\\/]/.test(value) || /^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(value);
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** 问题文本按行拆开，去掉常见的列表符号。 */
function issueLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, "").trim()).filter(Boolean);
}

function compact(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** 对象数组的一行：有编号先写编号，再取第一个像标题的字段。 */
function itemLine(item: unknown): string {
  const record = asRecord(item);
  if (!record) return compact(item);
  const id = typeof record.id === "string" || typeof record.id === "number" ? String(record.id) : "";
  const title = ["title", "goal", "name", "message", "summary", "rule", "description"]
    .map((key) => record[key])
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  if (title) return id ? `${id} · ${title}` : title;
  return compact(record);
}

const ARTIFACT = "workflow-artifact://";

/**
 * 结果里的文件：固定过的产物（workflow-artifact://）换成原始文件路径，界面才能打开；
 * 找不到来源的不当文件。同一个文件只列一次，优先用作者写的中文名。
 */
function settleFiles(files: { label: string; path: string }[], facts: { label: string; value: string }[], artifacts?: Readonly<Record<string, string>>): { label: string; path: string }[] {
  const byPath = new Map<string, { label: string; path: string }>();
  for (const file of files) {
    // Windows 长路径前缀（\\?\）不给人看。
    const path = (file.path.startsWith(ARTIFACT) ? artifacts?.[file.path] : file.path)?.replace(/^\\\\\?\\/, "");
    if (path === undefined || !looksLikePath(path)) {
      if (!file.path.startsWith(ARTIFACT)) facts.push({ label: file.label, value: file.path });
      continue;
    }
    const previous = byPath.get(path);
    const human = (label: string) => [...label].some((char) => char.charCodeAt(0) > 127);
    if (!previous || (!human(previous.label) && human(file.label))) byPath.set(path, { label: file.label, path });
  }
  return [...byPath.values()];
}

export function describeResult(result: unknown, labels?: Labels, artifacts?: Readonly<Record<string, string>>): ResultView | null {
  const view = describeRaw(result, labels);
  return view && { ...view, files: settleFiles([...view.files], view.facts as { label: string; value: string }[], artifacts) };
}

function describeRaw(result: unknown, labels?: Labels): ResultView | null {
  if (result === undefined || result === null) return null;
  const labelOf = (key: string) => labels?.[key] ?? LABEL[key] ?? key;
  const issues: string[] = [];
  const files: { label: string; path: string }[] = [];
  const facts: { label: string; value: string }[] = [];
  const texts: { label: string; text: string }[] = [];
  const lists: { label: string; items: string[] }[] = [];
  if (typeof result === "string") {
    if (looksLikePath(result)) files.push({ label: "结果", path: result });
    else texts.push({ label: "", text: result });
    return { issues, files, facts, texts, lists };
  }
  const record = asRecord(result);
  if (!record) {
    facts.push({ label: "结果", value: compact(result) });
    return { issues, files, facts, texts, lists };
  }
  const verdictKey = (["decision", "status"] as const).find((key) => typeof record[key] === "string" && record[key] !== "");
  const verdict = verdictKey === undefined ? undefined : record[verdictKey] as string;
  const authored = verdictKey && verdict ? labels?.[`${verdictKey}.${verdict}`] : undefined;
  const known = verdict === undefined ? undefined : CONCLUSION[verdict];
  const conclusion = verdict === undefined ? undefined
    : authored ? { text: authored, tone: known?.tone ?? "neutral" as const }
    : known ?? { text: verdict, tone: "neutral" as const };

  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined || value === "") continue;
    if ((key === "decision" || key === "status") && value === verdict) continue;
    const label = labelOf(key);
    if (typeof value === "string") {
      if (key === "issues") issues.push(...issueLines(value));
      else if (looksLikePath(value)) files.push({ label, path: value });
      else if (value.length <= SHORT_TEXT && !value.includes("\n")) facts.push({ label, value });
      else texts.push({ label, text: value });
    } else if (typeof value === "boolean") {
      facts.push({ label, value: value ? "是" : "否" });
    } else if (typeof value === "number") {
      facts.push({ label, value: String(value) });
    } else if (Array.isArray(value)) {
      if (value.length === 0) continue;
      if (value.every((item) => typeof item === "string" && looksLikePath(item))) {
        for (const path of value as string[]) files.push({ label, path });
      } else if (key === "issues") {
        issues.push(...value.map(itemLine));
      } else {
        lists.push({ label, items: value.map(itemLine) });
      }
    } else {
      const nested = asRecord(value);
      if (!nested) continue;
      const entries = Object.entries(nested);
      let matched = false;
      for (const [name, inner] of entries) {
        if (typeof inner === "string" && looksLikePath(inner)) {
          files.push({ label: name, path: inner });
          matched = true;
        } else if (looksLikePath(name)) {
          files.push({ label: typeof inner === "string" && inner !== "" ? inner : label, path: name });
          matched = true;
        }
      }
      if (!matched && entries.length > 0) facts.push({ label, value: compact(nested) });
    }
  }
  return { conclusion, issues, files, facts, texts, lists };
}

/**
 * 节点「什么时候执行」：取指向其所在环节的路由与连线上的作者标签。
 * 只陈述结构，不推测运行时会不会走到。
 */
export function entryConditions(
  structure: HierarchyStructure,
  site: string,
  phaseId: string | undefined,
  labelOf: (site: string) => string,
): string[] {
  const conditions: string[] = [];
  const flows = Object.values(structure.flows);
  const phaseOf = (id: string) => flows.flatMap((flow) => flow.phases).find((phase) => phase.id === id);
  const owner = phaseId ?? flows.flatMap((flow) => flow.phases).find((phase) => phase.run.includes(site))?.id;
  if (!owner) return conditions;
  const phase = phaseOf(owner);
  const source = (id: string) => {
    const from = phaseOf(id);
    if (!from) return id;
    if (from.run.length > 0) return from.run.map(labelOf).join("、");
    return from.call ? structure.flows[from.call]?.label ?? from.call : from.id;
  };
  // 同一环节内的先后连线：在前一个动作之后执行。
  for (const edge of phase?.edges ?? []) {
    if (edge.to !== site) continue;
    conditions.push(`「${labelOf(edge.from)}」之后${edge.label ? ` · ${edge.label}` : ""}`);
  }
  if (conditions.length === 0) {
    for (const flow of flows) {
      if (flow.entry === owner) {
        conditions.push(flow.id === structure.rootFlow ? "流程开始时执行" : `子流程「${flow.label}」开始时执行`);
      }
      for (const from of flow.phases) {
        for (const route of from.routes) {
          if (route.next !== owner) continue;
          conditions.push(`「${source(from.id)}」之后${route.label ? ` · ${route.label}` : ""}`);
        }
      }
    }
  }
  return [...new Set(conditions)];
}
