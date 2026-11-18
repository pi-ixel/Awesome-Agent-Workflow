/**
 * 插件替用户发给 Agent 的消息怎么显示（ADR 037）。
 *
 * Agent 收到的是完整正文；会话里只把 `visible` 当作普通气泡显示，正文其余
 * 部分收成一行 `foldLabel`，点开再看全文。显示方式是消息的属性，由应用随
 * 会话记录保存，不写进正文，也不靠正文里的标记识别。
 */
export interface MessageDisplay {
  /** 发出这条消息的插件（如 "workflow"），只用来区分来源。 */
  readonly source: string;
  /** 气泡里显示的文字（通常是用户自己说的话）；可以为空。 */
  readonly visible: string;
  /** 收起部分的标题。 */
  readonly foldLabel: string;
}

/** 组一条插件消息：可见文字在前，收起的部分在后。 */
export function pluginMessage(options: {
  readonly source: string;
  readonly foldLabel: string;
  readonly folded: string;
  readonly visible?: string;
}): { readonly text: string; readonly display: MessageDisplay } {
  const visible = options.visible?.trim() ?? "";
  return {
    text: visible ? `${visible}\n\n${options.folded}` : options.folded,
    display: { source: options.source, visible, foldLabel: options.foldLabel },
  };
}

/** 收起的部分：正文去掉开头的可见文字。 */
export function foldedText(text: string, display: MessageDisplay): string {
  return display.visible && text.startsWith(display.visible)
    ? text.slice(display.visible.length).trimStart()
    : text;
}
