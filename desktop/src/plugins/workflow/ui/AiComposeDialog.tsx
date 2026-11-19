/**
 * 让 AI 新建或修改工作流的第一步（ADR 036）：工作流面板内的弹窗，只模糊面板本身，
 * 不越出插件。提交后才建草稿、开编辑会话并进入草稿页；关闭（✕、Esc、点背景）什么也不留下。
 * 输入框沿用会话输入框的形态：Enter 发送、Shift+Enter 换行、输入法组词时 Enter 不发送。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { Callout } from "../../../shared/ui/Callout.tsx";
import { ArrowUpIcon, LoaderIcon, SparklesIcon, XIcon } from "../../../shared/ui/icons.tsx";

export function AiComposeDialog({ title, placeholder, busy, error, onSubmit, onCancel }: {
  title: string;
  placeholder: string;
  busy: boolean;
  error: string;
  onSubmit: (request: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const card = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const ready = text.trim() !== "" && !busy;
  const submit = () => {
    if (ready) onSubmit(text.trim());
  };
  const close = () => {
    if (!busy) onCancel();
  };

  // 打开时聚焦输入框，关闭后焦点回到打开它的按钮。
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // 随内容长高，到上限后滚动。
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  // Esc 关闭；Tab 只在弹窗里轮转。
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      const items = [...(card.current?.querySelectorAll<HTMLElement>("button:not(:disabled), textarea:not(:disabled)") ?? [])];
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  return <div className="workflow-compose-layer modal-in" onMouseDown={(event) => {
    // 点背景关闭；已经写了内容时不因误点丢掉。
    if (event.target === event.currentTarget && text.trim() === "") close();
  }}>
    <div ref={card} className="workflow-compose" role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown}>
      <header className="workflow-compose-head">
        <span className="workflow-compose-mark" aria-hidden="true"><SparklesIcon className="ui-icon-16" /></span>
        <h2 className="workflow-compose-title">{title}</h2>
        <IconButton iconSize="compact" className="workflow-compose-close" aria-label="关闭" disabled={busy} onClick={close}>
          <XIcon className="ui-icon-14" />
        </IconButton>
      </header>
      <textarea
        ref={input}
        aria-label={title}
        rows={4}
        value={text}
        disabled={busy}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {error !== "" && <Callout tone="danger" className="workflow-compose-error" title={error} />}
      <div className="workflow-compose-bar">
        <IconButton className="workflow-compose-send" aria-label="发送" data-hint="发送（Enter）" disabled={!ready} onClick={submit}>
          {busy ? <LoaderIcon className="ui-icon-16 animate-spin" /> : <ArrowUpIcon className="ui-icon-16" />}
        </IconButton>
      </div>
    </div>
  </div>;
}
