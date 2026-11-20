/**
 * 让 AI 新建或修改工作流的第一步（ADR 036）：工作流面板内的弹窗，只模糊面板本身，
 * 不越出插件。提交后才建草稿、开编辑会话并进入草稿页；关闭（✕、Esc、点背景）什么也不留下。
 * 输入框沿用会话输入框的形态：Enter 发送、Shift+Enter 换行、输入法组词时 Enter 不发送。
 */
import { useLayoutEffect, useRef, useState } from "react";
import { observeAppearance } from "../../../shared/ui/observeAppearance.ts";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { Callout } from "../../../shared/ui/Callout.tsx";
import { Spinner } from "../../../shared/ui/controls.tsx";
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { embeddedFieldClass } from "../../../shared/ui/inputStyles.ts";
import {
  ArrowUpIcon,
  SparklesIcon,
  XIcon,
} from "../../../shared/ui/icons.tsx";

export function AiComposeDialog({
  title,
  placeholder,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  title: string;
  placeholder: string;
  busy: boolean;
  error: string;
  onSubmit: (request: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const ready = text.trim() !== "" && !busy;
  const submit = () => {
    if (ready) onSubmit(text.trim());
  };
  const close = () => {
    if (!busy) onCancel();
  };

  // 文本和字号改变时重算输入区高度，内容超过上限后在输入区滚动。
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    const resize = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
    };
    resize();
    let frame = 0;
    const scheduleResize = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        resize();
      });
    };
    let width: number | undefined;
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(([entry]) => {
            if (!entry || entry.contentRect.width === width) return;
            width = entry.contentRect.width;
            scheduleResize();
          });
    observer?.observe(el);
    const unwatchAppearance = observeAppearance(el.ownerDocument.documentElement, ({ fontChanged }) => {
      if (fontChanged) scheduleResize();
    });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      unwatchAppearance();
    };
  }, [text]);

  return (
    <ModalShell
      placement="container"
      size="composer"
      label={title}
      onDismiss={close}
      dismissOnBackdrop={!busy && text.trim() === ""}
    >
      <header className="workflow-compose-head">
        <span className="workflow-compose-mark" aria-hidden="true">
          <SparklesIcon className="ui-icon-16" />
        </span>
        <h2 className="workflow-compose-title">{title}</h2>
        <IconButton
          iconSize="compact"
          className="workflow-compose-close"
          aria-label="关闭"
          disabled={busy}
          onClick={close}
        >
          <XIcon className="ui-icon-14" />
        </IconButton>
      </header>
      <textarea
        className={`${embeddedFieldClass} workflow-compose-input`}
        ref={input}
        autoFocus
        aria-label={title}
        rows={4}
        value={text}
        readOnly={busy}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {error !== "" && (
        <Callout
          tone="danger"
          className="workflow-compose-error"
          title={error}
        />
      )}
      <div className="workflow-compose-bar">
        <IconButton
          iconSize="dialog"
          className="workflow-compose-send"
          aria-label="发送"
          data-hint="发送（Enter）"
          aria-busy={busy}
          aria-disabled={busy || undefined}
          disabled={text.trim() === ""}
          onClick={submit}
        >
          {busy ? (
            <Spinner className="ui-icon-16" />
          ) : (
            <ArrowUpIcon className="ui-icon-16" />
          )}
        </IconButton>
      </div>
    </ModalShell>
  );
}
