/**
 * 工作流库的引擎返回 → 界面类型（宽容解析，坏数据不炸面板）。
 * 引擎侧见 workflow-engine-rs/src/package.rs 与 workflow_service.rs 的
 * `workflows` / `workflow` 请求。
 */
import type {
  WorkflowCatalog,
  WorkflowDetail,
  WorkflowDiagnostic,
  WorkflowEntry,
  WorkflowEntryInput,
  WorkflowMeta,
  WorkflowSummary,
} from "../types.ts";
import { parseCatalog } from "./snapshot.ts";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

function parseInput(value: unknown): WorkflowEntryInput | null {
  const item = record(value);
  const name = text(item?.name);
  if (item === null || name === "") return null;
  return {
    name,
    label: text(item.label) || name,
    kind: item.kind === "files" ? "files" : "text",
    required: item.required === true,
    placeholder: text(item.placeholder),
  };
}

function parseEntry(value: unknown): WorkflowEntry | null {
  const item = record(value);
  const id = text(item?.id);
  if (item === null || id === "") return null;
  return {
    id,
    label: text(item.label) || id,
    description: text(item.description),
    inputs: list(item.inputs).flatMap((input) => parseInput(input) ?? []),
  };
}

function parseMeta(value: unknown): WorkflowMeta | null {
  const item = record(value);
  const id = text(item?.id);
  if (item === null || id === "") return null;
  return {
    id,
    name: text(item.name) || id,
    version: text(item.version),
    description: text(item.description),
    entries: list(item.entries).flatMap((entry) => parseEntry(entry) ?? []),
    revision: text(item.revision),
  };
}

function parseDiagnostic(value: unknown): WorkflowDiagnostic | null {
  const item = record(value);
  if (item === null) return null;
  return {
    severity: item.severity === "warning" ? "warning" : "error",
    file: text(item.file),
    line: typeof item.line === "number" ? item.line : null,
    path: text(item.path),
    message: text(item.message),
  };
}

export function parseWorkflowSummary(value: unknown): WorkflowSummary | null {
  const item = record(value);
  const id = text(item?.id);
  if (item === null || id === "") return null;
  return {
    id,
    origin: item.origin === "user" ? "user" : "preset",
    meta: parseMeta(item.meta),
    diagnostics: list(item.diagnostics).flatMap((d) => parseDiagnostic(d) ?? []),
  };
}

export function parseWorkflowDetail(value: unknown): WorkflowDetail | null {
  const summary = parseWorkflowSummary(value);
  const item = record(value);
  if (summary === null || item === null) return null;
  const catalogs: Record<string, WorkflowCatalog> = {};
  for (const [entry, raw] of Object.entries(record(item.catalogs) ?? {})) {
    const catalog = parseCatalog(raw);
    if (catalog !== null) catalogs[entry] = catalog;
  }
  return {
    ...summary,
    catalogs,
    files: list(item.files).flatMap((file) => {
      const f = record(file);
      const path = text(f?.path);
      return path === "" ? [] : [{ path, text: text(f?.text) }];
    }),
  };
}

/** 诊断的一行文字：「文件:行（位置）：原因」。 */
export function describeDiagnostic(diagnostic: WorkflowDiagnostic): string {
  const at = diagnostic.line === null ? diagnostic.file : `${diagnostic.file}:${diagnostic.line}`;
  const where = diagnostic.path === "" ? "" : `（${diagnostic.path}）`;
  return `${at}${where}：${diagnostic.message}`;
}
