/**
 * 启动表单：选起点 → 填起点声明的输入 → 可选附件与标题 → 启动。
 *
 * 只有一个「开始运行」：点了先做环境检查，通过就直接启动；有提醒时列出来，
 * 再点一次「仍然开始」；有不通过的项不能启动。
 * 起点与输入都来自工作流源码（entries.inputs），不在界面里写死。启动失败
 * 保留已填内容，错误就地显示。附件是文件路径（相对项目目录或绝对路径），
 * 原样交给节点读取。
 */
import { errorLine } from "../status/errorText.ts";
import { useState } from "react";
import type { WorkflowMeta, WorkflowPreflightReport, WorkflowService, WorkflowStartRequest } from "../types.ts";
import { ghostButton, iconButton, primaryButton, secondaryButton } from "./buttons.ts";
import { CheckSquare, RadioDot } from "../../../shared/ui/controls.tsx";
import { settingsInputClass } from "../../../shared/ui/SettingsPageParts.tsx";
import { XIcon } from "../../../shared/ui/icons.tsx";
import { Callout } from "../../../shared/ui/Callout.tsx";
import { settingsTextareaClass } from "../../../shared/ui/SettingsPageParts.tsx";
import { Disclosure } from "../../../shared/ui/Disclosure.tsx";

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

  // 先检查环境；全部通过直接启动，有提醒时先给人看，再点一次才启动。
  const start = async (): Promise<void> => {
    if (!entry || missing.length > 0) return;
    setBusy(true);
    setError("");
    try {
      const current = report ?? await service.preflight(request);
      if (!report) setChecked({ key: requestKey, report: current });
      const blocked = current.items.some((item) => item.status === "fail");
      const accepted = current.items.filter((item) => item.status === "warn").map((item) => item.id);
      if (blocked || (!report && accepted.length > 0)) return;
      const { runId } = await service.start(request, { ...(current.revision ? { revision: current.revision } : {}), ...(current.configuration ? { configuration: current.configuration } : {}), acceptedWarnings: accepted });
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
      <b>运行「{meta.name}」</b>
    </header>
    {error !== "" && <Callout tone="danger" className="workflow-callout" title={error} onDismiss={() => setError("")} />}
    {meta.entries.length > 1 && <fieldset className="workflow-entry-choice">
      <legend>从哪里开始</legend>
      {meta.entries.map((item) => <label key={item.id} className={item.id === entryId ? "selected" : undefined}>
        <input type="radio" className="peer sr-only" name="workflow-entry" value={item.id} checked={item.id === entryId} onChange={() => setEntryId(item.id)} />
        <RadioDot checked={item.id === entryId} appearance="neutral" />
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
          className={settingsTextareaClass}
          value={values[input.name] ?? ""}
          onChange={(e) => setValues({ ...values, [input.name]: e.target.value })}
          placeholder={input.placeholder || undefined}
        />
      </label>)}
    <Disclosure summary="附件与标题（可选）" className="workflow-start-more">
      <FileList
        label="附件"
        hint="节点会读取这些文件；可写相对项目目录的路径"
        paths={attachments}
        onChange={setAttachments}
        onPick={pickFiles ? () => void addFiles((paths) => setAttachments([...attachments, ...paths])) : undefined}
        manual={{ value: manualPath, onChange: setManualPath }}
      />
      <label>运行标题
        <input className={settingsInputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="不填则取需求的第一行" />
      </label>
      <label className="workflow-check">
        <input type="checkbox" className="peer sr-only" checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} />
        <CheckSquare checked={autoConfirm} />
        <span>可选的确认直接放行（例如交付前的确认）；必须确认的仍会停下等你</span>
      </label>
    </Disclosure>
    {report && <section className="workflow-preflight" aria-label="启动前检查" aria-live="polite">
      {issues.length === 0
        ? <span className="workflow-preflight-ok">环境检查通过</span>
        : <ul>{issues.map((item) => <li key={item.id} className={`state-${item.status}`}>
          <span>{item.label}：{describeStartError(item.message)}</span>{item.hint && <small>{item.hint}</small>}
        </li>)}</ul>}
    </section>}
    <div className="workflow-start-actions">
      {missing.length > 0 && <span className="workflow-muted">还需填写：{missing.map((input) => input.label).join("、")}</span>}
      {onCancel && <button type="button" className={ghostButton} onClick={onCancel}>取消</button>}
      {failed
        ? <button type="button" className={primaryButton} disabled={busy} onClick={() => void check()}>{busy ? "正在检查…" : "重新检查"}</button>
        : <button type="button" className={primaryButton} disabled={busy || !entry || missing.length > 0} onClick={() => void start()}>{busy ? "正在启动…" : report && warnings.length > 0 ? "仍然开始" : "开始运行"}</button>}
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
      <button type="button" className={iconButton} aria-label={`移除 ${path}`} onClick={() => onChange(paths.filter((_, i) => i !== index))}><XIcon className="size-3.5" /></button>
    </li>)}</ul>}
    <div className="workflow-file-add">
      <input
        className={settingsInputClass}
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
      {onPick && <button type="button" className={secondaryButton} onClick={onPick}>选择文件…</button>}
    </div>
  </div>;
}

/** 启动失败的人话说明（ADR 035：说明集中在 errorText.ts）。 */
export function describeStartError(cause: unknown): string {
  return errorLine(cause);
}
