import { CopyButton } from "../../../shared/ui/CopyButton.tsx";
import { UiIcon } from "../../../shared/ui/UiIcon.tsx";

/**
 * 目录只以文本呈现：看得见、能选中、能复制，但不打开系统文件管理器。
 *
 * 之前这里是个按钮，点一下要调用 Tauri opener 的 openPath；为了一个「顺路看
 * 一眼源码在哪」的低频动作去扩张桌面端权限不划算。路径本质是**信息**而不是
 * 操作，所以改成一行等宽文本：完整值放在 data-hint（跟随主题）里，窄栏省略，
 * 旁边给一个纯前端的复制按钮（浏览器剪贴板 API，不碰权限层）。
 */
export function ToolPath({ path, label, compact = false }: {
  readonly path: string;
  readonly label?: string;
  readonly compact?: boolean;
}) {
  return <span className={`tool-path${compact ? " is-compact" : ""}`}>
    <span className="tool-path-icon" aria-hidden="true">
      <UiIcon viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round">
        <path d="M1.75 4.5A1.25 1.25 0 0 1 3 3.25h3.1l1.5 1.75H13A1.25 1.25 0 0 1 14.25 6v6A1.25 1.25 0 0 1 13 13.25H3A1.25 1.25 0 0 1 1.75 12z" />
      </UiIcon>
    </span>
    {label && <span className="tool-path-label">{label}</span>}
    <code className="tool-path-value" data-hint={path}>{path}</code>
    <CopyButton getText={() => path} label="复制路径" iconOnly size="sm" tone="muted" />
  </span>;
}
