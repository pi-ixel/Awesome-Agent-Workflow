/**
 * 让 AI 新建或修改工作流的第一步（ADR 036）：先说要什么，提交后才建草稿、开编辑会话。
 * 之后的对话都在中间的会话里进行；取消则什么也不留下。
 */
import { useState } from "react";

export function AiEditSheet({ title, intro, placeholder, busy, error, onSubmit, onCancel }: {
  title: string;
  intro: string;
  placeholder: string;
  busy: boolean;
  error: string;
  onSubmit: (request: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  return <section className="workflow-ai-sheet" role="dialog" aria-label={title}>
    <b>{title}</b>
    <p className="workflow-muted">{intro}</p>
    <textarea
      aria-label="你的要求"
      rows={4}
      autoFocus
      value={text}
      placeholder={placeholder}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && text.trim() !== "" && !busy) onSubmit(text);
      }}
    />
    {error !== "" && <div role="alert" className="workflow-error">{error}</div>}
    <div className="workflow-ai-sheet-actions">
      <button className="primary" disabled={busy || text.trim() === ""} onClick={() => onSubmit(text)}>{busy ? "正在准备…" : "开始"}</button>
      <button disabled={busy} onClick={onCancel}>取消</button>
      <small className="workflow-muted">Ctrl+Enter 提交</small>
    </div>
  </section>;
}
