export const fieldSurfaceClass =
  "min-w-0 rounded-md border border-line-strong bg-base text-ink placeholder:text-ink-ghost focus:border-ink-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring aria-invalid:border-danger-ink disabled:opacity-50";

export const settingsInputClass = `${fieldSurfaceClass} min-h-8 w-full px-2.5 text-ui-base`;

export const settingsNumberInputClass = `${settingsInputClass} max-w-20 text-center tabular-nums`;

export const settingsTextareaClass = `${fieldSurfaceClass} block min-h-16 w-full resize-y px-2.5 py-1.5 text-ui-base leading-relaxed`;

/** 信息流输入与消息编辑区共用表面，键盘输入由插入光标指示。 */
export const composerFieldClass =
  "min-w-0 border-0 bg-transparent text-ui-base text-ink placeholder:text-ink-ghost outline-none";

export const embeddedFieldClass = `${composerFieldClass} focus-visible:ring-1 focus-visible:ring-focus-ring`;
