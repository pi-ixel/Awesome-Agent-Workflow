/**
 * 启动表单：选起点 → 填起点声明的输入 → 可选附件与标题 → 启动。
 *
 * 起点与输入都来自工作流源码（entries.inputs），不在界面里写死。启动失败
 * 保留已填内容，错误就地显示。附件是文件路径（相对项目目录或绝对路径），
 * 原样交给节点读取。
 */
import { errorLine } from "../status/errorText.ts";
import { useState } from "react";
import type { WorkflowMeta, WorkflowPreflightReport, WorkflowService, WorkflowStartRequest } from "../types.ts";

export function WorkflowLauncher({ service, meta, initialEntry, pickFiles, onStarted, onCancel }: {
  service: WorkflowService;
  meta: WorkflowMeta;
  initialEntry?: string;
  /** 宿主文件选择器；缺省时只能手写路径。 */
  pickFiles?: () => Promise<readonly string[]>;
  onStarted?: (runId: string) => void;
  onCancel?: () => void;
}) {
  const [entryId, setEntryId] = useState(() =>
    meta.entries.some((entry) => entry.id === initialEntry) ? initialEntry! : meta.entries[0]?.id ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, readonly string[]>>({});
  const [attachments, setAttachments] = useState<readonly string[]>([]);
  const [manualPath, setManualPath] = useState("");
  const [title, setTitle] = useState("");
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState<{ key: string; report: WorkflowPreflightReport } | null>(null);
  const entry = meta.entries.find((item) => item.id === entryId);

  const missing = entry?.inputs.filter((input) => input.required && (
    input.kind === "files" ? (files[input.name] ?? []).length === 0 : (values[input.name] ?? "").trim() === ""
  )) ?? [];

  const inputs: Record<string, unknown> = {};
  for (const input of entry?.inputs ?? []) {
    if (input.kind === "files") {
      const list = files[input.name] ?? [];
      if (list.length > 0) inputs[input.name] = list;
    } else {
      const text = (values[input.name] ?? "").trim();
      if (text !== "") inputs[input.name] = text;
    }
  }
  if (attachments.length > 0) inputs.attachments = attachments;
  const request: WorkflowStartRequest = { workflowId: meta.id, entry: entry?.id ?? "", inputs, title, autoConfirm };
  // 环境检查针对工作流和起点，需求内容变化不影响检查结果。
  const requestKey = JSON.stringify([meta.id, entry?.id]);
  const report = checked?.key === requestKey ? checked.report : null;
  const failed = report?.items.some((item) => item.status === "fail") ?? false;
  const warnings = report?.items.filter((item) => item.status === "warn").map((item) => item.id) ?? [];
  const issues = report?.items.filter((item) => item.status !== "pass") ?? [];

  const check = async (): Promise<void> => {
    if (!entry) return;
    setBusy(true);
    setError("");
    try {
      setChecked({ key: requestKey, report: await service.preflight(request) });
    } catch (cause) {
      setError(describeStartError(cause));
    } finally {
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    if (!entry || !report || failed || missing.length > 0) return;
    setBusy(true);
    setError("");
    try {
      const { runId } = await service.start(request, { ...(report.revision ? { revision: report.revision } : {}), ...(report.configuration ? { configuration: report.configuration } : {}), acceptedWarnings: warnings });
      onStarted?.(runId);
    } catch (cause) {
      setError(describeStartError(cause));
      setChecked(null);
    } finally {
      setBusy(false);
    }
  };

  const addFiles = async (apply: (paths: readonly string[]) => void): Promise<void> => {
    const picked = await pickFiles?.();
    if (picked && picked.length > 0) apply(picked);
  };

  return <section className="workflow-start" aria-label={`启动 ${meta.name}`}>
    <header className="workflow-start-head">
      <b>启动「{meta.name}」</b>
      {onCancel && <button type="button" onClick={onCancel} aria-label="关闭启动表单">×</button>}
    </header>
    {error !== "" && <div role="alert" className="workflow-error">{error}<button onClick={() => setError("")} aria-label="关闭提示">×</button></div>}
    {meta.entries.length > 1 && <fieldset className="workflow-entry-choice">
      <legend>从哪里开始</legend>
      {meta.entries.map((item) => <label key={item.id} className={item.id === entryId ? "selected" : undefined}>
        <input type="radio" name="workflow-entry" value={item.id} checked={item.id === entryId} onChange={() => setEntryId(item.id)} />
        <span><b>{item.label}</b>{item.description && <small>{item.description}</small>}</span>
      </label>)}
    </fieldset>}
    {meta.entries.length === 1 && entry?.description && <p className="workflow-muted">{entry.description}</p>}
    {entry?.inputs.map((input) => input.kind === "files"
      ? <FileList
        key={input.name}
        label={`${input.label}${input.required ? "" : "（可选）"}`}
        paths={files[input.name] ?? []}
        onChange={(paths) => setFiles({ ...files, [input.name]: paths })}
        onPick={pickFiles ? () => void addFiles((paths) => setFiles({ ...files, [input.name]: [...(files[input.name] ?? []), ...paths] })) : undefined}
      />
      : <label key={input.name}>{input.label}{input.required ? "" : "（可选）"}
        <textarea
          value={values[input.name] ?? ""}
          onChange={(e) => setValues({ ...values, [input.name]: e.target.value })}
          placeholder={input.placeholder || undefined}
        />
      </label>)}
    <details className="workflow-start-more">
      <summary>附件与标题（可选）</summary>
      <FileList
        label="附件"
        hint="节点会读取这些文件；可写相对项目目录的路径"
        paths={attachments}
        onChange={setAttachments}
        onPick={pickFiles ? () => void addFiles((paths) => setAttachments([...attachments, ...paths])) : undefined}
        manual={{ value: manualPath, onChange: setManualPath }}
      />
      <label>运行标题
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="不填则取需求的第一行" />
      </label>
      <label className="workflow-check">
        <input type="checkbox" checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} />
        <span>可选的确认直接放行（例如交付前的确认）；必须确认的仍会停下等你</span>
      </label>
    </details>
    {report && <section className="workflow-preflight" aria-label="启动前检查" aria-live="polite">
      {issues.length === 0
        ? <span className="workflow-preflight-ok">环境检查通过</span>
        : <ul>{issues.map((item) => <li key={item.id} className={`state-${item.status}`}>
          <span>{item.label}：{describeStartError(item.message)}</span>{item.hint && <small>{item.hint}</small>}
        </li>)}</ul>}
    </section>}
    <div className="workflow-start-actions">
      {missing.length > 0 && <span className="workflow-muted">还需填写：{missing.map((input) => input.label).join("、")}</span>}
      {report && <button disabled={busy} onClick={() => void check()}>重新检查</button>}
      <button className="primary" disabled={busy || !entry || (report !== null && (missing.length > 0 || failed))} onClick={() => void (report ? start() : check())}>{busy ? "正在处理…" : !report ? "检查环境" : warnings.length ? "知情启动" : "启动"}</button>
    </div>
  </section>;
}

function FileList({ label, hint, paths, onChange, onPick, manual }: {
  label: string;
  hint?: string;
  paths: readonly string[];
  onChange: (paths: readonly string[]) => void;
  onPick?: () => void;
  manual?: { value: string; onChange: (value: string) => void };
}) {
  const [own, setOwn] = useState("");
  const typed = manual ?? { value: own, onChange: setOwn };
  const addTyped = () => {
    const path = typed.value.trim();
    if (path === "") return;
    onChange([...paths, path]);
    typed.onChange("");
  };
  return <div className="workflow-file-list" role="group" aria-label={label}>
    <span className="workflow-file-list-label">{label}{hint && <small>{hint}</small>}</span>
    {paths.length > 0 && <ul>{paths.map((path, index) => <li key={`${path}-${index}`}>
      <code data-hint={path}>{path}</code>
      <button type="button" aria-label={`移除 ${path}`} onClick={() => onChange(paths.filter((_, i) => i !== index))}>×</button>
    </li>)}</ul>}
    <div className="workflow-file-add">
      <input
        value={typed.value}
        onChange={(e) => typed.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addTyped();
          }
        }}
        placeholder="输入文件路径后回车"
        aria-label={`${label}路径`}
      />
      {onPick && <button type="button" onClick={onPick}>选择文件…</button>}
    </div>
  </div>;
}

/** 启动失败的人话说明（ADR 035：说明集中在 errorText.ts）。 */
export function describeStartError(cause: unknown): string {
  return errorLine(cause);
}
